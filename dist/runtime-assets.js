/**
 * Runtime assets that are resolved BY PATH at call time, mirrored to a stable
 * location outside the plugin version directory.
 *
 * Claude Code sweeps plugin-cache versions that are no longer referenced after
 * an update, while long-lived sessions keep running the MCP server from the
 * swept path. Two assets are opened by path on every call, not once at import:
 *
 *  - sqlite-vec's loadable extension. SQLite dlopen()s it for EVERY new
 *    connection, and dyld refuses a deleted path even while another
 *    connection in the same process still holds the image (verified
 *    2026-10-16 with a pinned connection: dlopen → "no such file").
 *  - the embedding model cache. transformers.js reads it from env.cacheDir
 *    (default: node_modules/@xenova/transformers/.cache) when the pipeline is
 *    first created, which for most sessions is the first `search` call.
 *
 * Mirroring = hard link when possible (same volume: instant, no extra space,
 * survives deletion of the original directory entry), copy otherwise. The
 * mirror lives under the conversation-index dir, which no plugin update touches.
 */
import fs from 'fs';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';
import * as transformers from '@xenova/transformers';
import { getIndexDir } from './paths.js';
const transformersEnv = transformers.env;
// transformers.js default cache (inside node_modules), captured before anything
// in this process overrides it — it is the seed source for the stable mirror.
const BUNDLED_MODEL_CACHE_DIR = typeof transformersEnv.cacheDir === 'string' ? path.resolve(transformersEnv.cacheDir) : null;
export function runtimeAssetsDir() {
    return path.join(getIndexDir(), 'runtime-assets');
}
/**
 * Mirror one regular file. Idempotent: an existing mirror is left alone when it
 * is the same inode (hard link) or has the same size AND mtime (copy fallback
 * preserves the source mtime), so a replaced source of equal length is still
 * re-mirrored. Atomic (temp name + rename, so a concurrent reader never sees a
 * partial file). Returns false when the source is unreadable or the mirror
 * cannot be written; callers keep using the in-tree path in that case.
 */
export function mirrorFile(src, dst) {
    try {
        const st = fs.statSync(src);
        if (!st.isFile())
            return false;
        try {
            const have = fs.statSync(dst);
            const sameInode = have.dev === st.dev && have.ino === st.ino;
            // utimes() cannot reproduce a sub-millisecond mtime, so a copied mirror
            // counts as current when the stamps agree to the millisecond.
            const sameStamp = Math.abs(have.mtimeMs - st.mtimeMs) < 2;
            if (have.isFile() && have.size === st.size && (sameInode || sameStamp)) {
                return true;
            }
        }
        catch {
            // not mirrored yet
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        const tmp = `${dst}.${process.pid}.tmp`;
        try {
            try {
                // link(2) does not follow symlinks on Linux/Windows: link the target.
                fs.linkSync(fs.realpathSync(src), tmp);
            }
            catch {
                fs.copyFileSync(src, tmp);
                fs.utimesSync(tmp, st.atime, st.mtime);
            }
            fs.renameSync(tmp, dst);
            return true;
        }
        catch {
            // never leave a partial copy or a stray hard link behind
            fs.rmSync(tmp, { force: true });
            return false;
        }
    }
    catch {
        return false;
    }
}
/**
 * Mirror every file under srcDir into dstDir with the same layout. Symlinks are
 * followed (the target's content is mirrored as a regular file); a broken link
 * or any entry that cannot be mirrored makes the whole tree report failure so
 * callers never switch to an incomplete mirror.
 */
export function mirrorTree(srcDir, dstDir) {
    let entries;
    try {
        entries = fs.readdirSync(srcDir, { withFileTypes: true });
    }
    catch {
        return false;
    }
    let ok = true;
    for (const entry of entries) {
        const s = path.join(srcDir, entry.name);
        const d = path.join(dstDir, entry.name);
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
            try {
                const target = fs.statSync(s); // follows the link
                isDir = target.isDirectory();
                isFile = target.isFile();
            }
            catch {
                ok = false; // broken link
                continue;
            }
        }
        if (isDir)
            ok = mirrorTree(s, d) && ok;
        else if (isFile)
            ok = mirrorFile(s, d) && ok;
        else
            ok = false; // sockets, fifos, devices: not a cache we can mirror
    }
    return ok;
}
// ---------------------------------------------------------------------------
// sqlite-vec extension
// ---------------------------------------------------------------------------
let stableVecPath;
function platformPackageVersion(loadablePath) {
    try {
        const pkgPath = path.join(path.dirname(loadablePath), 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.version)
            return pkg.version;
    }
    catch {
        // fall through
    }
    return 'unknown';
}
/**
 * Stable path of the sqlite-vec extension, mirrored on first use. Only a
 * successful mirror is cached for the life of the process (so a later sweep
 * cannot change the answer); a failure is retried on the next call so that a
 * transient problem (permissions, disk space) is not pinned until restart.
 * null = mirror unavailable right now (callers use the in-tree path).
 */
export function stableSqliteVecPath() {
    if (stableVecPath)
        return stableVecPath;
    try {
        const src = sqliteVec.getLoadablePath();
        const dst = path.join(runtimeAssetsDir(), 'sqlite-vec', `${platformPackageVersion(src)}-${process.platform}-${process.arch}`, path.basename(src));
        if (mirrorFile(src, dst)) {
            stableVecPath = dst;
            return dst;
        }
    }
    catch {
        // resolution failed — fall through
    }
    return null;
}
/**
 * Load sqlite-vec into a connection from the stable mirror. If the pinned
 * mirror has disappeared since it was made (cache cleanup, concurrent
 * re-mirror), forget it and mirror again before falling back to the in-tree
 * path — that fallback is the swept path this module exists to avoid, so it is
 * the last resort, not the second attempt.
 */
export function loadSqliteVec(db) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const stable = stableSqliteVecPath();
        if (!stable)
            break;
        try {
            db.loadExtension(stable);
            return;
        }
        catch (error) {
            // Say why before falling back, so a broken mirror is not masked by the
            // in-tree path's own (post-sweep) "no such file" error.
            const message = error instanceof Error ? error.message : String(error);
            console.error(`sqlite-vec: stable mirror failed to load (${message}); re-mirroring`);
            stableVecPath = undefined; // re-mirror on the next attempt
        }
    }
    sqliteVec.load(db);
}
// ---------------------------------------------------------------------------
// embedding model cache
// ---------------------------------------------------------------------------
export function stableModelCacheDir() {
    return path.join(runtimeAssetsDir(), 'models');
}
// Written next to a model only after mirrorTree() reported every file mirrored,
// so a half-finished mirror (failed midway, or being written by another server
// right now) is never adopted as a cache.
const MIRROR_COMPLETE_MARKER = '.memory-bank-mirror-complete';
/**
 * Use the stable mirror if it already holds a COMPLETE copy of `modelId`;
 * otherwise leave the cache setting untouched. Never mirrors, never copies:
 * cheap and safe on paths that run before the MCP initialize handshake (the
 * inject daemon's pre-warm, hooks, CLI workers). Returns the cache dir in use.
 */
export function adoptStableModelCache(modelId) {
    const current = transformersEnv.cacheDir;
    try {
        const stable = stableModelCacheDir();
        const stableModel = path.join(stable, modelId);
        const complete = fs.existsSync(path.join(stableModel, MIRROR_COMPLETE_MARKER));
        // A stable copy that transformers.js downloaded itself has no marker; it is
        // still the better choice when the configured cache has no model at all.
        const currentHasModel = typeof current === 'string' && fs.existsSync(path.join(current, modelId));
        if (complete || (!currentHasModel && fs.existsSync(stableModel))) {
            transformersEnv.cacheDir = stable;
            return stable;
        }
    }
    catch {
        // stable dir unavailable — keep whatever is configured
    }
    return typeof current === 'string' ? current : '';
}
/**
 * Point transformers.js at the stable cache and seed it with `modelId` from the
 * bundled (in-tree) cache when that still exists. Idempotent and cheap once
 * seeded (per-file inode/mtime check). If the bundled cache has the model but
 * mirroring fails (permissions, disk space), the bundled cache stays in use —
 * a cache known to work is never traded for a re-download. If neither cache has
 * the model, transformers.js downloads into the stable dir exactly as it used
 * to download in-tree. Returns the cache dir actually in use.
 */
export function relocateModelCache(modelId, fromDir = BUNDLED_MODEL_CACHE_DIR) {
    try {
        const stable = stableModelCacheDir();
        if (fromDir && path.resolve(fromDir) !== path.resolve(stable)) {
            const src = path.join(fromDir, modelId);
            if (fs.existsSync(src)) {
                const dst = path.join(stable, modelId);
                if (!mirrorTree(src, dst)) {
                    transformersEnv.cacheDir = fromDir;
                    return fromDir;
                }
                fs.writeFileSync(path.join(dst, MIRROR_COMPLETE_MARKER), '');
            }
        }
        transformersEnv.cacheDir = stable;
        return stable;
    }
    catch {
        // The stable dir itself cannot be created (read-only or sandboxed HOME):
        // leave the cache setting exactly as it was.
        const current = transformersEnv.cacheDir;
        return typeof current === 'string' ? current : (fromDir ?? '');
    }
}
/** Test hook: forget the process-cached stable path. */
export function resetRuntimeAssetCacheForTests() {
    stableVecPath = undefined;
}
