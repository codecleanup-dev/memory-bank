import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as transformers from '@xenova/transformers';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  mirrorFile,
  mirrorTree,
  stableSqliteVecPath,
  loadSqliteVec,
  relocateModelCache,
  stableModelCacheDir,
  resetRuntimeAssetCacheForTests,
} from '../src/runtime-assets.js';

const transformersEnv = (transformers as unknown as { env: { cacheDir?: unknown } }).env;

// The plugin directory can be swept out from under a running server. Anything
// SQLite or transformers.js opens BY PATH at call time must therefore live in a
// stable mirror that survives deletion of the original directory entry.
describe('runtime-assets', () => {
  let tmp: string;
  let savedCfg: string | undefined;
  let savedCacheDir: unknown;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'mb-runtime-assets-'));
    savedCfg = process.env.MEMORY_BANK_CONFIG_DIR;
    process.env.MEMORY_BANK_CONFIG_DIR = path.join(tmp, 'cfg');
    savedCacheDir = transformersEnv.cacheDir;
    resetRuntimeAssetCacheForTests();
  });

  afterEach(() => {
    if (savedCfg === undefined) delete process.env.MEMORY_BANK_CONFIG_DIR;
    else process.env.MEMORY_BANK_CONFIG_DIR = savedCfg;
    transformersEnv.cacheDir = savedCacheDir;
    resetRuntimeAssetCacheForTests();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('mirrorFile', () => {
    it('mirrors once, is a no-op when the mirror already matches, and leaves no temp files', () => {
      const src = path.join(tmp, 'src.bin');
      const dst = path.join(tmp, 'mirror', 'src.bin');
      writeFileSync(src, 'abc');

      expect(mirrorFile(src, dst)).toBe(true);

      expect(readFileSync(dst, 'utf8')).toBe('abc');
      // Same volume → hard link: both names share one inode.
      expect(statSync(dst).ino).toBe(statSync(src).ino);
      expect(mirrorFile(src, dst)).toBe(true);
      expect(readdirSync(path.join(tmp, 'mirror'))).toEqual(['src.bin']);
    });

    it('a mirrored file survives deletion of the original', () => {
      const src = path.join(tmp, 'plugin', 'asset.bin');
      const dst = path.join(tmp, 'stable', 'asset.bin');
      mkdirSync(path.dirname(src), { recursive: true });
      writeFileSync(src, 'payload');
      expect(mirrorFile(src, dst)).toBe(true);

      rmSync(path.join(tmp, 'plugin'), { recursive: true, force: true });

      expect(existsSync(src)).toBe(false);
      expect(readFileSync(dst, 'utf8')).toBe('payload');
    });

    it('returns false for a missing source instead of throwing', () => {
      expect(mirrorFile(path.join(tmp, 'nope'), path.join(tmp, 'mirror', 'nope'))).toBe(false);
      expect(existsSync(path.join(tmp, 'mirror'))).toBe(false);
    });
  });

  describe('mirrorTree', () => {
    it('mirrors nested regular files with the same layout', () => {
      const src = path.join(tmp, 'tree');
      mkdirSync(path.join(src, 'onnx'), { recursive: true });
      writeFileSync(path.join(src, 'config.json'), '{}');
      writeFileSync(path.join(src, 'onnx', 'model_quantized.onnx'), 'weights');

      expect(mirrorTree(src, path.join(tmp, 'out'))).toBe(true);

      expect(readFileSync(path.join(tmp, 'out', 'config.json'), 'utf8')).toBe('{}');
      expect(readFileSync(path.join(tmp, 'out', 'onnx', 'model_quantized.onnx'), 'utf8')).toBe('weights');
    });
  });

  describe('sqlite-vec', () => {
    it('stableSqliteVecPath mirrors the extension under runtime-assets and loadSqliteVec uses it', () => {
      const stable = stableSqliteVecPath();

      expect(stable).not.toBeNull();
      const expectedRoot = path.join(tmp, 'cfg', 'conversation-index', 'runtime-assets', 'sqlite-vec');
      expect(stable!.startsWith(expectedRoot)).toBe(true);
      expect(statSync(stable!).size).toBe(statSync(sqliteVec.getLoadablePath()).size);

      const db = new Database(':memory:');
      loadSqliteVec(db);
      const row = db.prepare('select vec_version() as v').get() as { v: string };
      expect(row.v).toMatch(/^v\d/);
      db.close();
    });

    it('a mirrored extension still dlopen()s after its in-tree path is swept', () => {
      // Private copy of the real extension stands in for the plugin directory.
      const swept = path.join(tmp, 'plugin', 'vec0.dylib');
      const stable = path.join(tmp, 'stable', 'vec0.dylib');
      mkdirSync(path.dirname(swept), { recursive: true });
      copyFileSync(sqliteVec.getLoadablePath(), swept);
      expect(mirrorFile(swept, stable)).toBe(true);

      rmSync(path.join(tmp, 'plugin'), { recursive: true, force: true });

      // Control: the swept path is really unusable for a new connection...
      const control = new Database(':memory:');
      expect(() => control.loadExtension(swept)).toThrow();
      control.close();
      // ...while the mirror keeps working.
      const db = new Database(':memory:');
      expect(() => db.loadExtension(stable)).not.toThrow();
      expect((db.prepare('select vec_version() as v').get() as { v: string }).v).toMatch(/^v\d/);
      db.close();
    });
  });

  describe('relocateModelCache', () => {
    it('points transformers.js at the stable dir, seeds it from the bundled cache, and survives the sweep', () => {
      const bundled = path.join(tmp, 'bundled-cache');
      const model = 'Fake/model';
      mkdirSync(path.join(bundled, model, 'onnx'), { recursive: true });
      writeFileSync(path.join(bundled, model, 'config.json'), '{}');
      writeFileSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'), 'weights');

      const stable = relocateModelCache(model, bundled);

      expect(stable).toBe(stableModelCacheDir());
      expect(path.resolve(String(transformersEnv.cacheDir))).toBe(path.resolve(stable));
      expect(readFileSync(path.join(stable, model, 'onnx', 'model_quantized.onnx'), 'utf8')).toBe('weights');

      rmSync(bundled, { recursive: true, force: true });

      expect(readFileSync(path.join(stable, model, 'config.json'), 'utf8')).toBe('{}');
      // Bundled cache gone (post-sweep): still idempotent, still the stable dir.
      expect(relocateModelCache(model, bundled)).toBe(stable);
      expect(path.resolve(String(transformersEnv.cacheDir))).toBe(path.resolve(stable));
    });

    it('keeps the bundled cache in use when mirroring fails, instead of forcing a re-download', () => {
      const bundled = path.join(tmp, 'bundled-cache');
      const model = 'Fake/model';
      mkdirSync(path.join(bundled, model), { recursive: true });
      writeFileSync(path.join(bundled, model, 'config.json'), '{}');
      // Make the stable models dir unwritable: a regular file where the dir must go.
      mkdirSync(path.dirname(stableModelCacheDir()), { recursive: true });
      writeFileSync(stableModelCacheDir(), 'not a directory');

      const inUse = relocateModelCache(model, bundled);

      expect(inUse).toBe(bundled);
      expect(path.resolve(String(transformersEnv.cacheDir))).toBe(path.resolve(bundled));
    });
  });

  describe('failure handling', () => {
    it('mirrorFile re-mirrors a replaced source of equal length (new inode, new mtime)', () => {
      const src = path.join(tmp, 'config.json');
      const dst = path.join(tmp, 'mirror', 'config.json');
      writeFileSync(src, '{"a":1}');
      expect(mirrorFile(src, dst)).toBe(true);

      // Simulate a package update: same path, same length, different content/inode.
      rmSync(src);
      writeFileSync(src, '{"a":2}');
      const past = new Date(Date.now() - 60_000);
      // utimes gives the replacement a distinct mtime even on coarse filesystems
      utimesSync(src, past, past);
      expect(mirrorFile(src, dst)).toBe(true);

      expect(readFileSync(dst, 'utf8')).toBe('{"a":2}');
    });

    it('stableSqliteVecPath does not pin a transient mirror failure', () => {
      // First call fails: runtime-assets exists as a regular file.
      const assets = path.join(tmp, 'cfg', 'conversation-index', 'runtime-assets');
      mkdirSync(path.dirname(assets), { recursive: true });
      writeFileSync(assets, 'blocker');
      expect(stableSqliteVecPath()).toBeNull();

      // Problem fixed: the next call mirrors and caches the path.
      rmSync(assets);
      const p = stableSqliteVecPath();
      expect(p).not.toBeNull();
      expect(existsSync(p!)).toBe(true);
      expect(stableSqliteVecPath()).toBe(p);
    });
  });
});
