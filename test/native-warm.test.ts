import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import * as transformers from '@xenova/transformers';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { warmNativeBindings } from '../src/native-warm.js';
import { resetRuntimeAssetCacheForTests, stableModelCacheDir } from '../src/runtime-assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = path.join(__dirname, '..', 'src');
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

  it('mirrors the sqlite-vec extension and points the model cache at the stable dir', () => {
    expect(warmNativeBindings()).toBe(true);

    const assets = path.join(tmp, 'cfg', 'conversation-index', 'runtime-assets');
    expect(existsSync(path.join(assets, 'sqlite-vec'))).toBe(true);
    expect(path.resolve(String(transformersEnv.cacheDir))).toBe(path.resolve(stableModelCacheDir()));
    expect(stableModelCacheDir().startsWith(assets)).toBe(true);
  });

  it('closes the handle it opened and returns true', () => {
    const close = vi.fn();
    const open = vi.fn(() => ({ close }));

    expect(warmNativeBindings(open)).toBe(true);

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

// Wiring contracts: the guarantee above only reaches production if the entry
// point warms before the transport connects and every connection / model load
// goes through the stable-mirror helpers.
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

  it('embeddings.ts adopts (never mirrors) the stable model cache before creating the pipeline', () => {
    const src = read('embeddings.ts');
    const fn = src.indexOf('export async function initEmbeddings()');
    expect(fn).toBeGreaterThan(-1);
    const body = src.slice(fn);
    const adopt = /^[ \t]*adoptStableModelCache\(EMBEDDING_MODEL\);[ \t]*$/m.exec(body);
    const create = /await pipeline\(/.exec(body);
    expect(adopt, 'adoptStableModelCache(EMBEDDING_MODEL); missing from initEmbeddings()').not.toBeNull();
    expect(create).not.toBeNull();
    expect(adopt!.index).toBeLessThan(create!.index);
    // initEmbeddings also runs before the MCP handshake (inject daemon
    // pre-warm): a synchronous copy there could eat the client's startup
    // timeout, so the mirroring variant must not be called from this module.
    expect(src).not.toMatch(/relocateModelCache\(/);
  });
});
