import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import * as transformers from '@xenova/transformers';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { warmNativeBindings, scheduleModelMirrorRetry } from '../src/native-warm.js';
import {
  resetRuntimeAssetCacheForTests,
  stableModelCacheRoot,
  notifyModelLoaded,
  isModelMirrored,
} from '../src/runtime-assets.js';
import { EMBEDDING_MODEL } from '../src/embeddings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = path.join(__dirname, '..', 'src');
// Minimal structurally complete ONNX ModelProto (ir_version + graph).
const ONNX = Buffer.concat([Buffer.from([0x08, 0x07]), Buffer.from([0x3a, 7]), Buffer.from('weights')]);
const transformersEnv = (transformers as unknown as { env: { cacheDir?: unknown } }).env;

// better-sqlite3 loads its native addon lazily inside `new Database()`. If the
// plugin directory is swept while a long-lived MCP server is still running from
// it, the first tool call fails with "Cannot find module 'bindings'". The warm-up
// must therefore open a real database at startup, not merely import the module,
// and mirror the path-resolved assets while the directory still exists.
describe('warmNativeBindings', () => {
  let tmp: string;
  let savedDbPath: string | undefined;
  let savedCfg: string | undefined;
  let savedCacheDir: unknown;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'mb-native-warm-'));
    savedDbPath = process.env.TEST_DB_PATH;
    savedCfg = process.env.MEMORY_BANK_CONFIG_DIR;
    savedCacheDir = transformersEnv.cacheDir;
    process.env.TEST_DB_PATH = path.join(tmp, 'db.sqlite');
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(tmp, 'cfg');
    resetRuntimeAssetCacheForTests();
  });

  afterEach(() => {
    if (savedDbPath === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = savedDbPath;
    if (savedCfg === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR;
    else process.env.MEMORY_BANK_CONFIG_DIR = savedCfg;
    transformersEnv.cacheDir = savedCacheDir;
    resetRuntimeAssetCacheForTests();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('opens and closes the real database so the native addon is mapped', () => {
    const dbPath = process.env.TEST_DB_PATH!;
    expect(existsSync(dbPath)).toBe(false);

    expect(warmNativeBindings()).toBe(true);

    expect(existsSync(dbPath)).toBe(true);
    // The addon is loaded through Node's CJS loader, so it shows up in the
    // require cache once (and only once) a Database has actually been opened.
    const loaded = Object.keys(require.cache).filter((k) => k.endsWith('better_sqlite3.node'));
    expect(loaded.length).toBeGreaterThan(0);
  });

  it('mirrors the sqlite-vec extension under runtime-assets', () => {
    expect(warmNativeBindings()).toBe(true);

    const assets = path.join(tmp, 'cfg', 'conversation-index', 'runtime-assets');
    expect(existsSync(path.join(assets, 'sqlite-vec'))).toBe(true);
  });

  it('publishes a model that was loaded before the handshake (inject daemon pre-warm)', () => {
    const model = 'Fake/model';
    const bundled = path.join(tmp, 'bundled-cache');
    mkdirSync(path.join(bundled, model, 'onnx'), { recursive: true });
    writeFileSync(path.join(bundled, model, 'config.json'), '{}');
    writeFileSync(path.join(bundled, model, 'tokenizer_config.json'), '{"c":1}');
    writeFileSync(path.join(bundled, model, 'tokenizer.json'), '{"tok":1}');
    writeFileSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'), ONNX);
    transformersEnv.cacheDir = bundled;

    // pipeline built → proof, but mirroring is not allowed yet: nothing published
    notifyModelLoaded(model, bundled);
    expect(existsSync(stableModelCacheRoot())).toBe(false);
    expect(isModelMirrored(model)).toBe(false);

    expect(warmNativeBindings(undefined, vi.fn())).toBe(true);

    // the warm-up allowed mirroring and published the pending proof (a
    // version dir holding the fake model exists; the warm-up then also
    // published the plugin's real model, so the fake is not the one in use)
    const published = readdirSync(stableModelCacheRoot()).filter((n) => /^[0-9a-f]{12}$/.test(n));
    const fakeVersion = published.find((n) => existsSync(path.join(stableModelCacheRoot(), n, model, 'tokenizer.json')));
    expect(fakeVersion).toBeDefined();
    expect(readFileSync(path.join(stableModelCacheRoot(), fakeVersion!, model, 'tokenizer.json'), 'utf8')).toBe('{"tok":1}');
  });

  it('publishes a model loaded after the handshake immediately', () => {
    const model = 'Fake/model';
    const bundled = path.join(tmp, 'bundled-cache');
    mkdirSync(path.join(bundled, model, 'onnx'), { recursive: true });
    writeFileSync(path.join(bundled, model, 'config.json'), '{}');
    writeFileSync(path.join(bundled, model, 'tokenizer_config.json'), '{"c":1}');
    writeFileSync(path.join(bundled, model, 'tokenizer.json'), '{"tok":1}');
    writeFileSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'), ONNX);
    transformersEnv.cacheDir = bundled;

    expect(warmNativeBindings(undefined, vi.fn())).toBe(true);
    expect(isModelMirrored(model)).toBe(false); // the fake model was never loaded

    notifyModelLoaded(model, bundled);

    expect(isModelMirrored(model)).toBe(true);
  });

  it('without proof, validates and publishes the bundled model already on disk after the handshake', () => {
    const retry = vi.fn();
    expect(isModelMirrored(EMBEDDING_MODEL)).toBe(false);

    // the plugin's own node_modules cache holds the real model (complete and
    // quiet): the heuristic path publishes it, so no retry is needed
    expect(warmNativeBindings(undefined, retry)).toBe(true);

    expect(isModelMirrored(EMBEDDING_MODEL)).toBe(true);
    expect(retry).not.toHaveBeenCalled();
    const cacheDir = path.resolve(String(transformersEnv.cacheDir));
    expect(cacheDir.startsWith(path.resolve(stableModelCacheRoot()) + path.sep)).toBe(true);
    expect(existsSync(path.join(cacheDir, EMBEDDING_MODEL, 'tokenizer.json'))).toBe(true);
  });

  it('schedules background retries when the bundled model is incomplete and nothing was loaded', () => {
    const retry = vi.fn();
    // make the stable root unwritable so neither path can publish
    mkdirSync(path.dirname(stableModelCacheRoot()), { recursive: true });
    writeFileSync(stableModelCacheRoot(), 'not a directory');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    warmNativeBindings(undefined, retry);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('not mirrored yet');
  });

  it('closes the handle it opened and returns true', () => {
    const close = vi.fn();
    const open = vi.fn(() => ({ close }));

    expect(warmNativeBindings(open, vi.fn())).toBe(true);

    expect(open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('never throws: a failing open is logged and reported as false', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = vi.fn(() => {
      throw new Error("Cannot find module 'bindings'");
    });

    expect(() => warmNativeBindings(open)).not.toThrow();
    expect(warmNativeBindings(open)).toBe(false);

    expect(err).toHaveBeenCalled();
    const joined = err.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toContain("Cannot find module 'bindings'");
  });
});

describe('scheduleModelMirrorRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on the interval until the publish succeeds, then stops', () => {
    vi.useFakeTimers();
    const publish = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);

    scheduleModelMirrorRetry(publish, 1000, 10);

    expect(publish).not.toHaveBeenCalled(); // nothing synchronous
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(publish).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(60_000);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts and tolerates a throwing publish', () => {
    vi.useFakeTimers();
    const publish = vi.fn(() => {
      throw new Error('boom');
    });

    scheduleModelMirrorRetry(publish, 100, 3);
    vi.advanceTimersByTime(10_000);

    expect(publish).toHaveBeenCalledTimes(3);
  });
});

// Wiring contracts: the guarantee above only reaches production if the entry
// point warms after the handshake, every connection goes through the
// stable-mirror loader, and every successful model load reports its proof.
describe('startup wiring', () => {
  const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

  it('mcp-server main() registers warmNativeBindings() on oninitialized before server.connect()', () => {
    const src = read('mcp-server.ts');
    const mainStart = src.indexOf('async function main()');
    expect(mainStart).toBeGreaterThan(-1);
    const body = src.slice(mainStart);
    // The warm-up must run AFTER the initialize handshake (it is synchronous
    // and may be slow), so it is registered as the oninitialized callback, and
    // that registration must precede connect(). Only a statement counts: a
    // mention inside a comment (e.g. a commented-out call) must not satisfy
    // this contract.
    const hook = /^[ \t]*server\.oninitialized = \(\) => \{[ \t]*$/m.exec(body);
    const connect = /^[ \t]*await server\.connect\(/m.exec(body);
    expect(hook, 'server.oninitialized = () => { missing from main()').not.toBeNull();
    expect(connect, 'await server.connect( missing from main()').not.toBeNull();
    expect(hook!.index).toBeLessThan(connect!.index);
    const callback = body.slice(hook!.index, body.indexOf('};', hook!.index));
    expect(callback, 'warmNativeBindings(); statement missing from the oninitialized callback')
      .toMatch(/^[ \t]*warmNativeBindings\(\);[ \t]*$/m);
    // and never synchronously before connect
    expect(body.slice(0, hook!.index)).not.toMatch(/^[ \t]*warmNativeBindings\(\);[ \t]*$/m);
  });

  it('db.ts loads sqlite-vec only through loadSqliteVec()', () => {
    const src = read('db.ts');
    expect(src).not.toMatch(/sqliteVec\.load\(/);
    expect(src.match(/^[ \t]*loadSqliteVec\(db\);[ \t]*$/gm)?.length).toBe(2);
  });

  it('embeddings.ts adopts (never mirrors) before creating the pipeline and reports the proof after', () => {
    const src = read('embeddings.ts');
    const fn = src.indexOf('export async function initEmbeddings()');
    expect(fn).toBeGreaterThan(-1);
    const body = src.slice(fn);
    const adopt = /^[ \t]*adoptStableModelCache\(EMBEDDING_MODEL\);[ \t]*$/m.exec(body);
    const create = /await pipeline\(/.exec(body);
    const notify = /^[ \t]*notifyModelLoaded\(EMBEDDING_MODEL, cacheDirUsed\);[ \t]*$/m.exec(body);
    expect(adopt, 'adoptStableModelCache(EMBEDDING_MODEL); missing from initEmbeddings()').not.toBeNull();
    expect(create).not.toBeNull();
    expect(notify, 'notifyModelLoaded(EMBEDDING_MODEL, cacheDirUsed); missing from initEmbeddings()').not.toBeNull();
    expect(adopt!.index).toBeLessThan(create!.index);
    expect(create!.index).toBeLessThan(notify!.index);
    // initEmbeddings also runs before the MCP handshake (inject daemon
    // pre-warm): a synchronous copy there could eat the client's startup
    // timeout, so the mirroring variant must not be called from this module.
    expect(src).not.toMatch(/relocateModelCache\(/);
  });
});
