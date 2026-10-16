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
  stableModelCacheRoot,
  resetRuntimeAssetCacheForTests,
  MODEL_QUIET_MS,
  notifyModelLoaded,
  allowModelMirroring,
  publishProvenModel,
  isModelMirrored,
  onnxLooksComplete,
  modelFilesIntact, modelInUseDir,
  PUBLISH_GRACE_MS,
} from '../src/runtime-assets.js';

// Minimal but structurally complete ONNX ModelProto: ir_version (field 1,
// varint) followed by graph (field 7, length-delimited) carrying `payload`.
const onnxBytes = (payload: string) =>
  Buffer.concat([Buffer.from([0x08, 0x07]), Buffer.from([0x3a, payload.length]), Buffer.from(payload)]);

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
      // An independent file (clone or copy) that keeps the source mtime.
      expect(statSync(dst).ino).not.toBe(statSync(src).ino);
      expect(Math.abs(statSync(dst).mtimeMs - statSync(src).mtimeMs)).toBeLessThan(2);

      // Second call must not touch the filesystem again (source mtimes carry
      // sub-millisecond fractions utimes() cannot reproduce).
      const copy = vi.spyOn(fs, 'copyFileSync');
      expect(mirrorFile(src, dst)).toBe(true);
      expect(copy).not.toHaveBeenCalled();
      expect(readdirSync(path.join(tmp, 'mirror'))).toEqual(['src.bin']);
    });

    it('a mirror is an independent snapshot: rewriting or truncating the source later does not touch it', () => {
      const src = path.join(tmp, 'model.onnx');
      const dst = path.join(tmp, 'mirror', 'model.onnx');
      writeFileSync(src, 'weights-v1');
      expect(mirrorFile(src, dst)).toBe(true);

      // in-place rewrite (same inode), then truncation — what a failing or
      // racing cache writer does to the source
      writeFileSync(src, 'weights-v2');
      expect(readFileSync(dst, 'utf8')).toBe('weights-v1');
      fs.truncateSync(src, 3);
      expect(readFileSync(dst, 'utf8')).toBe('weights-v1');
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

      // mirrored as real files (the link target's content), never as links
      expect(lstatSync(path.join(tmp, 'out', 'tokenizer.json')).isSymbolicLink()).toBe(false);
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

  describe('relocateModelCache / adoptStableModelCache', () => {
    const model = 'Fake/model';
    let bundled: string;
    // A publishable source must have been quiet for MODEL_QUIET_MS.
    const backdate = (file: string) => {
      const past = new Date(Date.now() - MODEL_QUIET_MS - 60_000);
      utimesSync(file, past, past);
    };
    const seed = (dir: string, weights = 'weights') => {
      mkdirSync(path.join(dir, model, 'onnx'), { recursive: true });
      const files: Array<[string, Buffer | string]> = [
        ['config.json', '{}'],
        ['tokenizer.json', '{"t":1}'],
        ['tokenizer_config.json', '{"c":1}'],
        [path.join('onnx', 'model_quantized.onnx'), onnxBytes(weights)],
      ];
      for (const [rel, content] of files) {
        writeFileSync(path.join(dir, model, rel), content);
        backdate(path.join(dir, model, rel));
      }
    };
    const weightsIn = (dir: string) =>
      readFileSync(path.join(dir, model, 'onnx', 'model_quantized.onnx')).subarray(4).toString();
    const published = () =>
      existsSync(stableModelCacheRoot())
        ? readdirSync(stableModelCacheRoot()).filter((n) => /^[0-9a-f]{12}$/.test(n)).sort()
        : [];
    const staging = () =>
      existsSync(stableModelCacheRoot())
        ? readdirSync(stableModelCacheRoot()).filter((n) => n.includes('.staging-'))
        : [];

    beforeEach(() => {
      bundled = path.join(tmp, 'bundled-cache');
      seed(bundled);
      transformersEnv.cacheDir = bundled;
    });

    it('publishes an immutable fingerprint dir, points transformers.js at it, and survives the sweep', () => {
      const dir = relocateModelCache(model, bundled);

      expect(path.dirname(path.dirname(dir))).toBe(modelInUseDir(stableModelCacheRoot()));
      expect(path.basename(dir)).toMatch(/^[0-9a-f]{12}$/);
      expect(path.resolve(String(transformersEnv.cacheDir))).toBe(path.resolve(dir));
      expect(weightsIn(dir)).toBe('weights');
      expect(staging()).toEqual([]);

      rmSync(bundled, { recursive: true, force: true });

      expect(readFileSync(path.join(dir, model, 'config.json'), 'utf8')).toBe('{}');
      // source gone (swept): the published mirror is what gets used
      expect(relocateModelCache(model, bundled)).toBe(dir);
      transformersEnv.cacheDir = '/nonexistent/bundled';
      expect(adoptStableModelCache(model)).toBe(dir);
    });

    it('is idempotent: an already published fingerprint is reused without touching the filesystem', () => {
      const dir = relocateModelCache(model, bundled);
      const link = vi.spyOn(fs, 'linkSync');
      const copy = vi.spyOn(fs, 'copyFileSync');

      expect(relocateModelCache(model, bundled)).toBe(dir);

      expect(link).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(published()).toEqual([path.basename(dir)]);
    });

    it('a changed source gets a new fingerprint dir and the old one is left intact', () => {
      const first = relocateModelCache(model, bundled);
      rmSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'));
      writeFileSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'), onnxBytes('weights-v2'));
      backdate(path.join(bundled, model, 'onnx', 'model_quantized.onnx'));

      const second = relocateModelCache(model, bundled);

      expect(second).not.toBe(first);
      expect(weightsIn(first)).toBe('weights');
      expect(weightsIn(second)).toBe('weights-v2');
      // adoption prefers the mirror of the configured source over the newest
      transformersEnv.cacheDir = bundled;
      expect(adoptStableModelCache(model)).toBe(second);
    });

    it('does not publish while the download is still in progress (no onnx weights yet)', () => {
      rmSync(path.join(bundled, model, 'onnx'), { recursive: true, force: true });

      expect(relocateModelCache(model, bundled)).toBe(bundled);

      expect(path.resolve(String(transformersEnv.cacheDir))).toBe(path.resolve(bundled));
      expect(published()).toEqual([]);
      expect(adoptStableModelCache(model)).toBe(bundled);
    });

    it('does not publish files written less than MODEL_QUIET_MS ago (write in flight or paused)', () => {
      const weights = path.join(bundled, model, 'onnx', 'model_quantized.onnx');
      const now = new Date();
      utimesSync(weights, now, now);

      expect(relocateModelCache(model, bundled)).toBe(bundled);
      expect(published()).toEqual([]);

      backdate(weights);
      expect(relocateModelCache(model, bundled)).not.toBe(bundled);
    });

    it('adoption keeps a complete but unpublished bundled model over an older published mirror', () => {
      const first = relocateModelCache(model, bundled);
      rmSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'));
      writeFileSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'), onnxBytes('weights-v2'));
      backdate(path.join(bundled, model, 'onnx', 'model_quantized.onnx'));
      transformersEnv.cacheDir = bundled;

      expect(adoptStableModelCache(model)).toBe(bundled);

      expect(path.resolve(String(transformersEnv.cacheDir))).toBe(path.resolve(bundled));
      expect(existsSync(first)).toBe(true); // untouched, just not preferred
    });

    it('does not publish a source that changed while it was being mirrored', () => {
      const weights = path.join(bundled, model, 'onnx', 'model_quantized.onnx');
      const realCopy = fs.copyFileSync;
      vi.spyOn(fs, 'copyFileSync').mockImplementation((src, dst, mode) => {
        // the download replaces the weights while we are mirroring
        rmSync(weights);
        writeFileSync(weights, onnxBytes('weights-complete-now'));
        return realCopy(src, dst, mode);
      });

      expect(relocateModelCache(model, bundled)).toBe(bundled);

      expect(published()).toEqual([]);
      expect(staging()).toEqual([]);
    });

    it('using a published version takes a private hard-link snapshot that outlives the published dir', () => {
      const root = stableModelCacheRoot();
      const v1 = relocateModelCache(model, bundled);

      // v1 = <root>/inuse/<pid>/<fingerprint>
      expect(path.dirname(path.dirname(v1))).toBe(modelInUseDir(root));
      expect(path.basename(path.dirname(v1))).toBe(String(process.pid));
      const fp = path.basename(v1);
      const published = path.join(root, fp, model, 'onnx', 'model_quantized.onnx');
      const snap = path.join(v1, model, 'onnx', 'model_quantized.onnx');
      expect(statSync(snap).ino).toBe(statSync(published).ino); // same volume → hard link

      rmSync(path.join(root, fp), { recursive: true, force: true }); // pruned by some other process

      expect(modelFilesIntact(path.join(v1, model))).toBe(true);
      expect(weightsIn(v1)).toBe('weights');
    });

    it('a version deleted between look-up and snapshot is skipped without leaving a partial snapshot', () => {
      const root = stableModelCacheRoot();
      const v1 = relocateModelCache(model, bundled);
      const fp = path.basename(v1);
      rmSync(v1, { recursive: true, force: true }); // forget our own snapshot
      const realLink = fs.linkSync;
      vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
        rmSync(path.join(root, fp), { recursive: true, force: true }); // pruner wins the race
        return realLink(from, to);
      });
      transformersEnv.cacheDir = '/nonexistent/bundled';

      expect(adoptStableModelCache(model)).toBe('/nonexistent/bundled');

      expect(existsSync(path.join(modelInUseDir(root), String(process.pid), fp))).toBe(false);
    });

    it('pruning removes old versions beyond the newest three; existing snapshots keep working', () => {
      const root = stableModelCacheRoot();
      const old = new Date(Date.now() - PUBLISH_GRACE_MS - 60_000);
      const v1 = relocateModelCache(model, bundled);
      const fp1 = path.basename(v1);
      utimesSync(path.join(root, fp1), old, old);
      const bump = (w: string) => {
        rmSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'));
        writeFileSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'), onnxBytes(w));
        backdate(path.join(bundled, model, 'onnx', 'model_quantized.onnx'));
        return relocateModelCache(model, bundled);
      };
      bump('v2');
      bump('v3');
      expect(existsSync(path.join(root, fp1))).toBe(true); // still within the newest three

      bump('v4');

      expect(existsSync(path.join(root, fp1))).toBe(false); // old and beyond the newest three: pruned
      expect(weightsIn(v1)).toBe('weights'); // our snapshot of it is untouched
      bump('v5');
      // recent versions survive beyond the newest three (grace period)
      expect(readdirSync(root).filter((n) => /^[0-9a-f]{12}$/.test(n))).toHaveLength(4);
    });

    it('a version is not used when its snapshot cannot be written', () => {
      const root = stableModelCacheRoot();
      const v1 = relocateModelCache(model, bundled);
      rmSync(modelInUseDir(root), { recursive: true, force: true });
      writeFileSync(modelInUseDir(root), 'not a directory');
      transformersEnv.cacheDir = '/nonexistent/bundled';

      expect(adoptStableModelCache(model)).toBe('/nonexistent/bundled');

      expect(existsSync(path.join(root, path.basename(v1)))).toBe(true); // untouched, just not used
    });

    it('snapshots of dead processes are removed when a snapshot is made', () => {
      const root = stableModelCacheRoot();
      mkdirSync(path.join(modelInUseDir(root), '999999', 'abcdefabcdef'), { recursive: true });

      relocateModelCache(model, bundled); // publishes and takes a snapshot

      expect(existsSync(path.join(modelInUseDir(root), '999999'))).toBe(false);
      expect(existsSync(path.join(modelInUseDir(root), String(process.pid)))).toBe(true);
    });

    it('a staging dir left by a dead process is never adopted and is cleaned up on the next publish', () => {
      const root = stableModelCacheRoot();
      const stale = path.join(root, 'abcdefabcdef.staging-999999');
      mkdirSync(path.join(stale, model), { recursive: true });
      writeFileSync(path.join(stale, model, 'config.json'), '{}');
      transformersEnv.cacheDir = '/nonexistent/bundled';

      expect(adoptStableModelCache(model)).toBe('/nonexistent/bundled');
      const dir = relocateModelCache(model, bundled);

      expect(existsSync(path.join(root, path.basename(dir)))).toBe(true);
      expect(existsSync(stale)).toBe(false);
    });

    it('adoptStableModelCache never links or copies', () => {
      relocateModelCache(model, bundled);
      const link = vi.spyOn(fs, 'linkSync');
      const copy = vi.spyOn(fs, 'copyFileSync');
      transformersEnv.cacheDir = bundled;

      expect(path.dirname(path.dirname(adoptStableModelCache(model)))).toBe(modelInUseDir(stableModelCacheRoot()));

      expect(link).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
    });

    it('refuses to publish when a required file is missing even with proof (cache write failed under the pipeline)', () => {
      rmSync(path.join(bundled, model, 'onnx'), { recursive: true, force: true }); // onnx dir never got created
      expect(relocateModelCache(model, bundled, true)).toBe(bundled);
      expect(published()).toEqual([]);

      seed(bundled);
      rmSync(path.join(bundled, model, 'tokenizer_config.json'));
      expect(relocateModelCache(model, bundled, true)).toBe(bundled);
      expect(published()).toEqual([]);
    });

    it('a published mirror is unaffected by later in-place corruption of the source', () => {
      const dir = relocateModelCache(model, bundled);
      const srcWeights = path.join(bundled, model, 'onnx', 'model_quantized.onnx');
      fs.truncateSync(srcWeights, 4); // a racing writer damages the source in place
      rmSync(bundled, { recursive: true, force: true });

      expect(modelFilesIntact(path.join(dir, model))).toBe(true);
      expect(weightsIn(dir)).toBe('weights');
    });

    it('refuses to publish a truncated onnx or json even with proof (cache write failed under the pipeline)', () => {
      const weights = path.join(bundled, model, 'onnx', 'model_quantized.onnx');
      const whole = readFileSync(weights);
      writeFileSync(weights, whole.subarray(0, whole.length - 3)); // write died mid-file
      backdate(weights);

      expect(relocateModelCache(model, bundled, true)).toBe(bundled);
      expect(published()).toEqual([]);
      expect(staging()).toEqual([]);

      writeFileSync(weights, whole);
      backdate(weights);
      writeFileSync(path.join(bundled, model, 'config.json'), '{"architectures": ["Bert'); // truncated JSON
      backdate(path.join(bundled, model, 'config.json'));
      expect(relocateModelCache(model, bundled, true)).toBe(bundled);
      expect(published()).toEqual([]);
    });

    it('a proven source (pipeline built from it) is published even when its files are fresh', () => {
      // files just written by the download: the heuristic path refuses them...
      const now = new Date();
      utimesSync(path.join(bundled, model, 'onnx', 'model_quantized.onnx'), now, now);
      expect(relocateModelCache(model, bundled)).toBe(bundled);
      expect(published()).toEqual([]);

      // ...but a built pipeline is the proof that they are complete
      expect(relocateModelCache(model, bundled, true)).not.toBe(bundled);
      expect(published()).toHaveLength(1);
    });

    it('notifyModelLoaded defers publishing until allowModelMirroring() and then publishes once', () => {
      expect(publishProvenModel()).toBeNull(); // nothing proven yet

      notifyModelLoaded(model, bundled);
      expect(published()).toEqual([]); // handshake not done: deferred
      expect(isModelMirrored(model)).toBe(false);

      const copy = vi.spyOn(fs, 'copyFileSync');
      allowModelMirroring();
      expect(published()).toHaveLength(1);
      expect(isModelMirrored(model)).toBe(true);
      expect(copy).toHaveBeenCalled();

      // a later load from the same source is a no-op
      copy.mockClear();
      notifyModelLoaded(model, bundled);
      expect(copy).not.toHaveBeenCalled();
      expect(published()).toHaveLength(1);
    });

    it('notifyModelLoaded ignores a load that was already served from the stable mirror', () => {
      const dir = relocateModelCache(model, bundled);
      resetRuntimeAssetCacheForTests();
      allowModelMirroring();

      notifyModelLoaded(model, dir);

      expect(publishProvenModel()).toBeNull();
      expect(published()).toEqual([path.basename(dir)]);
    });

    it('keeps the bundled cache in use when the stable root cannot be written', () => {
      // a regular file where the models root must go
      mkdirSync(path.dirname(stableModelCacheRoot()), { recursive: true });
      writeFileSync(stableModelCacheRoot(), 'not a directory');

      expect(relocateModelCache(model, bundled)).toBe(bundled);

      expect(path.resolve(String(transformersEnv.cacheDir))).toBe(path.resolve(bundled));
    });
  });

  describe('model file integrity', () => {
    it('onnxLooksComplete walks the top-level protobuf fields to exactly EOF and requires a graph', () => {
      const ok = path.join(tmp, 'ok.onnx');
      writeFileSync(ok, onnxBytes('graph-bytes'));
      expect(onnxLooksComplete(ok)).toBe(true);

      const truncated = path.join(tmp, 'truncated.onnx');
      writeFileSync(truncated, onnxBytes('graph-bytes').subarray(0, 8));
      expect(onnxLooksComplete(truncated)).toBe(false);

      const noGraph = path.join(tmp, 'nograph.onnx');
      writeFileSync(noGraph, Buffer.from([0x08, 0x07])); // ir_version only
      expect(onnxLooksComplete(noGraph)).toBe(false);

      const empty = path.join(tmp, 'empty.onnx');
      writeFileSync(empty, '');
      expect(onnxLooksComplete(empty)).toBe(false);

      const text = path.join(tmp, 'text.onnx');
      writeFileSync(text, 'weights'); // not a protobuf at all
      expect(onnxLooksComplete(text)).toBe(false);
    });

    it('modelFilesIntact checks every file by type', () => {
      const dir = path.join(tmp, 'model');
      mkdirSync(path.join(dir, 'onnx'), { recursive: true });
      writeFileSync(path.join(dir, 'config.json'), '{"a":1}');
      writeFileSync(path.join(dir, 'tokenizer.json'), '{"b":[1,2]}');
      writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), onnxBytes('g'));
      expect(modelFilesIntact(dir)).toBe(true);

      writeFileSync(path.join(dir, 'tokenizer.json'), '{"b":[1,2');
      expect(modelFilesIntact(dir)).toBe(false);
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
