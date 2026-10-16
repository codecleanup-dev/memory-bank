import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
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
  symlinkSync,
  lstatSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  mirrorFile,
  mirrorTree,
  stableSqliteVecPath,
  loadSqliteVec,
  relocateModelCache,
  adoptStableModelCache,
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
    vi.restoreAllMocks();
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

      // Second call must not touch the filesystem again.
      const link = vi.spyOn(fs, 'linkSync');
      const copy = vi.spyOn(fs, 'copyFileSync');
      expect(mirrorFile(src, dst)).toBe(true);
      expect(link).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(readdirSync(path.join(tmp, 'mirror'))).toEqual(['src.bin']);
    });

    it('copy fallback (hard link impossible) preserves mtime and is idempotent too', () => {
      const src = path.join(tmp, 'model.onnx');
      const dst = path.join(tmp, 'mirror', 'model.onnx');
      writeFileSync(src, 'weights');
      vi.spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      });
      const copy = vi.spyOn(fs, 'copyFileSync');

      expect(mirrorFile(src, dst)).toBe(true);

      expect(copy).toHaveBeenCalledTimes(1);
      expect(readFileSync(dst, 'utf8')).toBe('weights');
      expect(statSync(dst).ino).not.toBe(statSync(src).ino);
      expect(Math.abs(statSync(dst).mtimeMs - statSync(src).mtimeMs)).toBeLessThan(2);
      // Source mtimes carry sub-millisecond fractions utimes() cannot reproduce:
      // the second call must still be a no-op.
      expect(mirrorFile(src, dst)).toBe(true);
      expect(copy).toHaveBeenCalledTimes(1);
      expect(readdirSync(path.join(tmp, 'mirror'))).toEqual(['model.onnx']);
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

    it('removes its temp file when the final rename fails', () => {
      const src = path.join(tmp, 'src.bin');
      writeFileSync(src, 'abc');
      // A directory where the mirror file must go makes rename() fail.
      const dst = path.join(tmp, 'mirror', 'src.bin');
      mkdirSync(dst, { recursive: true });

      expect(mirrorFile(src, dst)).toBe(false);

      expect(readdirSync(path.join(tmp, 'mirror'))).toEqual(['src.bin']);
      expect(lstatSync(dst).isDirectory()).toBe(true);
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

    it('follows symlinked files and directories, and reports a broken link as failure', (ctx) => {
      const real = path.join(tmp, 'real');
      mkdirSync(path.join(real, 'onnx'), { recursive: true });
      writeFileSync(path.join(real, 'onnx', 'model.onnx'), 'weights');
      writeFileSync(path.join(real, 'tokenizer.json'), 'tok');
      const src = path.join(tmp, 'tree');
      mkdirSync(src);
      try {
        symlinkSync(path.join(real, 'tokenizer.json'), path.join(src, 'tokenizer.json'));
        symlinkSync(path.join(real, 'onnx'), path.join(src, 'onnx'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip(); // Windows without symlink privilege
        throw e;
      }

      expect(mirrorTree(src, path.join(tmp, 'out'))).toBe(true);

      // mirrored as real files (the link TARGET is linked, so the mirror
      // shares the target's inode and never dangles), not as links
      expect(lstatSync(path.join(tmp, 'out', 'tokenizer.json')).isSymbolicLink()).toBe(false);
      expect(statSync(path.join(tmp, 'out', 'tokenizer.json')).ino).toBe(statSync(path.join(real, 'tokenizer.json')).ino);
      expect(readFileSync(path.join(tmp, 'out', 'tokenizer.json'), 'utf8')).toBe('tok');
      expect(readFileSync(path.join(tmp, 'out', 'onnx', 'model.onnx'), 'utf8')).toBe('weights');

      symlinkSync(path.join(tmp, 'does-not-exist'), path.join(src, 'broken.onnx'));
      expect(mirrorTree(src, path.join(tmp, 'out2'))).toBe(false);
    });
  });

  describe('sqlite-vec', () => {
    it('stableSqliteVecPath mirrors the extension under runtime-assets and loadSqliteVec uses it', () => {
      const stable = stableSqliteVecPath();

      expect(stable).not.toBeNull();
      const expectedRoot = path.join(tmp, 'cfg', 'conversation-index', 'runtime-assets', 'sqlite-vec');
      expect(stable!.startsWith(expectedRoot)).toBe(true);
      expect(statSync(stable!).size).toBe(statSync(sqliteVec.getLoadablePath()).size);

      // Record which path the connection actually loaded: a silent fallback to
      // the in-tree path would also make vec_version() work, so that alone
      // proves nothing.
      const real = new Database(':memory:');
      const loaded: string[] = [];
      loadSqliteVec({ loadExtension: (p: string) => { loaded.push(p); real.loadExtension(p); } });
      expect(loaded).toEqual([stable]);
      const row = real.prepare('select vec_version() as v').get() as { v: string };
      expect(row.v).toMatch(/^v\d/);
      real.close();
    });

    it('a mirrored extension still dlopen()s after its in-tree path is swept', () => {
      // Private copy of the real extension stands in for the plugin directory.
      const swept = path.join(tmp, 'plugin', 'vec0.dylib');
      const stable = path.join(tmp, 'stable', 'vec0.dylib');
      mkdirSync(path.dirname(swept), { recursive: true });
      copyFileSync(sqliteVec.getLoadablePath(), swept);
      expect(mirrorFile(swept, stable)).toBe(true);
      // A connection that already holds the image (as a warmed server would).
      const holder = new Database(':memory:');
      holder.loadExtension(swept);

      rmSync(path.join(tmp, 'plugin'), { recursive: true, force: true });

      // Control: the swept path is unusable for a NEW connection even while the
      // holder keeps the image mapped (dyld stats the path), which is why a
      // mirror is needed at all...
      const control = new Database(':memory:');
      expect(() => control.loadExtension(swept)).toThrow();
      control.close();
      // ...while the mirror keeps working.
      const db = new Database(':memory:');
      expect(() => db.loadExtension(stable)).not.toThrow();
      expect((db.prepare('select vec_version() as v').get() as { v: string }).v).toMatch(/^v\d/);
      db.close();
      holder.close();
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

    it('adoptStableModelCache uses a complete mirror, ignores a partial one, and never copies', () => {
      const bundled = path.join(tmp, 'bundled-cache');
      const model = 'Fake/model';
      mkdirSync(path.join(bundled, model), { recursive: true });
      writeFileSync(path.join(bundled, model, 'config.json'), '{}');
      transformersEnv.cacheDir = bundled;
      const link = vi.spyOn(fs, 'linkSync');
      const copy = vi.spyOn(fs, 'copyFileSync');

      // nothing mirrored yet → stays on the bundled cache
      expect(adoptStableModelCache(model)).toBe(bundled);
      expect(transformersEnv.cacheDir).toBe(bundled);

      // a partial mirror (no completion marker) is not adopted either
      mkdirSync(path.join(stableModelCacheDir(), model), { recursive: true });
      writeFileSync(path.join(stableModelCacheDir(), model, 'config.json'), '{}');
      expect(adoptStableModelCache(model)).toBe(bundled);
      expect(link).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();

      // after a complete mirror (post-initialize warm-up) it is adopted, even
      // once the bundled cache has been swept
      const stable = relocateModelCache(model, bundled);
      rmSync(bundled, { recursive: true, force: true });
      transformersEnv.cacheDir = '/nonexistent/bundled';
      expect(adoptStableModelCache(model)).toBe(stable);
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

    it('loadSqliteVec re-mirrors when the pinned mirror has been removed, rather than using the in-tree path', () => {
      const first = stableSqliteVecPath();
      expect(first).not.toBeNull();
      rmSync(first!); // e.g. a cache cleanup deleted the mirror after it was pinned
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const real = new Database(':memory:');
      const loaded: string[] = [];
      expect(() => loadSqliteVec({ loadExtension: (p: string) => { loaded.push(p); real.loadExtension(p); } })).not.toThrow();
      expect((real.prepare('select vec_version() as v').get() as { v: string }).v).toMatch(/^v\d/);
      real.close();

      // first attempt (missing mirror) → re-mirror → second attempt succeeds;
      // the in-tree path is never used
      expect(loaded).toEqual([first, first]);
      expect(existsSync(first!)).toBe(true); // mirrored again at the same stable path
      expect(stableSqliteVecPath()).toBe(first);
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
