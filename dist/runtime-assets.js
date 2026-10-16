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
            if (have.isFile() && have.size === st.size && (sameInode || have.mtimeMs === st.mtimeMs)) {
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
                fs.linkSync(src, tmp);
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
/** Load sqlite-vec into a connection from the stable mirror, else the in-tree path. */
export function loadSqliteVec(db) {
    const stable = stableSqliteVecPath();
    if (stable) {
        try {
            db.loadExtension(stable);
            return;
        }
        catch {
            // mirror unreadable — try the in-tree path below
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
    const stable = stableModelCacheDir();
    if (fromDir && path.resolve(fromDir) !== path.resolve(stable)) {
        const src = path.join(fromDir, modelId);
        if (fs.existsSync(src) && !mirrorTree(src, path.join(stable, modelId))) {
            transformersEnv.cacheDir = fromDir;
            return fromDir;
        }
    }
    transformersEnv.cacheDir = stable;
    return stable;
}
/** Test hook: forget the process-cached stable path. */
export function resetRuntimeAssetCacheForTests() {
    stableVecPath = undefined;
}
