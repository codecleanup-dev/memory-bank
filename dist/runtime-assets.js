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
 * Mirroring = reflink clone when the filesystem supports it (APFS: instant, no
 * extra space until either side changes), plain copy otherwise. Never a hard
 * link: the mirror must stay intact when the source is later rewritten in
 * place or truncated. The mirror lives under the conversation-index dir, which
 * no plugin update touches.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
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
 * Mirror one regular file as an independent snapshot (reflink clone where the
 * filesystem supports it, plain copy otherwise). Idempotent: an existing mirror
 * is left alone when it has the same size AND mtime (the mirror keeps the
 * source mtime), so a replaced source of equal length is still re-mirrored.
 * Atomic (temp name + rename, so a concurrent reader never sees a partial
 * file). Returns false when the source is unreadable or the mirror cannot be
 * written; callers keep using the in-tree path in that case.
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
            // Clone (reflink) when the filesystem supports it — instant and free on
            // APFS/Btrfs/XFS — else a plain copy. Never a hard link: a mirror must be
            // an independent snapshot that a later in-place rewrite or truncation of
            // the source cannot reach. copyFile follows symlinks, so a linked source
            // is mirrored as the real file.
            fs.copyFileSync(src, tmp, fs.constants.COPYFILE_FICLONE);
            fs.utimesSync(tmp, st.atime, st.mtime);
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
//
// Layout: <runtime-assets>/models/<fingerprint>/<modelId>/...
//
// Every published <fingerprint> directory is immutable and complete: it is
// mirrored into a staging directory first, and only renamed into place
// (atomic) when every file mirrored AND the source did not change meanwhile
// AND the source looks like a finished model (config + onnx weights). A
// download still in progress (transformers.js writes files one by one) or a
// mirror that failed halfway is therefore never visible to another process,
// and a changed source gets a new fingerprint instead of overwriting files
// under an old one.
export function stableModelCacheRoot() {
    return path.join(runtimeAssetsDir(), 'models');
}
const FINGERPRINT_RE = /^[0-9a-f]{12}$/;
const STAGING_RE = /^([0-9a-f]{12})\.staging-(\d+)$/;
function listModelFiles(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const st = fs.statSync(full); // follows symlinks
        if (st.isDirectory())
            listModelFiles(full, base, out);
        else if (st.isFile()) {
            out.push({ rel: path.relative(base, full).split(path.sep).join('/'), size: st.size, mtime: Math.floor(st.mtimeMs) });
        }
    }
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
function fingerprintOf(files) {
    return createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 12);
}
// What a transformers.js feature-extraction pipeline reads for the models this
// plugin uses (Xenova/* ONNX exports): model config, tokenizer vocabulary and
// settings, and the ONNX weights. A cache missing any of these is incomplete
// no matter what a pipeline built from the in-memory download says.
const REQUIRED_MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];
/** A transformers.js model dir that is safe to publish: every required file present and non-empty. */
function looksCompleteModel(files) {
    const have = (rel) => files.some((f) => f.rel === rel && f.size > 0);
    return (REQUIRED_MODEL_FILES.every(have) &&
        files.some((f) => f.rel.startsWith('onnx/') && f.rel.endsWith('.onnx') && f.size > 0));
}
// transformers.js writes each cached file in one writeFile() after the whole
// download is buffered, so a file that has not been touched for this long is
// neither in flight nor a paused write. The post-mirror fingerprint check
// covers a write that starts during the mirror itself.
export const MODEL_QUIET_MS = 30_000;
function isQuiescent(files, now = Date.now()) {
    return files.every((f) => now - f.mtime >= MODEL_QUIET_MS);
}
// ---- structural integrity of cached model files ------------------------------
//
// A built pipeline proves the files were downloaded, not that they were
// written: transformers.js' FileCache only warns when writeFile fails (disk
// full, killed mid-write) and the pipeline carries on from its in-memory
// buffer, leaving a truncated file in the cache. So before anything is
// published, every mirrored file is checked for structural completeness —
// JSON must parse, and an ONNX file must be a complete protobuf: walking its
// top-level fields has to land exactly on the end of the file, and a `graph`
// field (7) must be present. A truncation anywhere inside the (huge) graph
// field declares a length past EOF and is caught immediately.
function readVarint(fd, pos, size) {
    const buf = Buffer.alloc(10);
    const n = fs.readSync(fd, buf, 0, Math.min(10, size - pos), pos);
    let value = 0n;
    for (let i = 0; i < n; i++) {
        value |= BigInt(buf[i] & 0x7f) << BigInt(7 * i);
        if ((buf[i] & 0x80) === 0)
            return { value, next: pos + i + 1 };
    }
    return null; // ran off the end mid-varint
}
export function onnxLooksComplete(file) {
    let fd = null;
    try {
        const size = fs.statSync(file).size;
        if (size === 0)
            return false;
        fd = fs.openSync(file, 'r');
        let pos = 0;
        let sawGraph = false;
        while (pos < size) {
            const tag = readVarint(fd, pos, size);
            if (!tag)
                return false;
            pos = tag.next;
            const field = Number(tag.value >> 3n);
            const wireType = Number(tag.value & 7n);
            if (wireType === 0) {
                const v = readVarint(fd, pos, size);
                if (!v)
                    return false;
                pos = v.next;
            }
            else if (wireType === 1) {
                pos += 8;
            }
            else if (wireType === 5) {
                pos += 4;
            }
            else if (wireType === 2) {
                const len = readVarint(fd, pos, size);
                if (!len)
                    return false;
                pos = len.next + Number(len.value);
                if (field === 7)
                    sawGraph = true;
            }
            else {
                return false; // groups / unknown wire types do not occur in ModelProto
            }
            if (pos > size)
                return false; // declared length runs past EOF: truncated
        }
        return pos === size && sawGraph;
    }
    catch {
        return false;
    }
    finally {
        if (fd !== null)
            fs.closeSync(fd);
    }
}
function jsonLooksComplete(file) {
    try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
        return true;
    }
    catch {
        return false;
    }
}
/** Every file under a mirrored model dir passes its structural check. */
export function modelFilesIntact(dir) {
    try {
        return listModelFiles(dir).every((f) => {
            const full = path.join(dir, f.rel);
            if (f.rel.endsWith('.onnx'))
                return onnxLooksComplete(full);
            if (f.rel.endsWith('.json'))
                return jsonLooksComplete(full);
            return f.size > 0;
        });
    }
    catch {
        return false;
    }
}
// Written into every published version at publish time: the authoritative
// list of its files (relative path + size). A snapshot is accepted only when
// every manifest entry was linked with the same size — a directory listing
// taken while a pruner deletes files one by one would miss what is already
// gone and look complete.
const MANIFEST = 'manifest.json';
function isPublished(root, fp, modelId) {
    return fs.existsSync(path.join(root, fp, modelId, 'config.json')) && fs.existsSync(path.join(root, fp, MANIFEST));
}
/** Published fingerprint dirs holding `modelId`, newest first. */
function publishedDirs(root, modelId) {
    let names;
    try {
        names = fs.readdirSync(root);
    }
    catch {
        return [];
    }
    return names
        .filter((n) => FINGERPRINT_RE.test(n) && isPublished(root, n, modelId))
        .flatMap((n) => {
        try {
            return [{ dir: path.join(root, n), mtime: fs.statSync(path.join(root, n)).mtimeMs }];
        }
        catch {
            return []; // pruned between the listing and the stat: just not a candidate
        }
    })
        .sort((a, b) => b.mtime - a.mtime)
        .map((x) => x.dir);
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === 'EPERM';
    }
}
// ---- per-process snapshots: nothing a process reads can be deleted ----------
//
// A process never reads a published version in place. It takes a SNAPSHOT:
// hard links of the version's files under <root>/inuse/<pid>/<fingerprint>/
// (same filesystem, so link() is instant and free; a clone/copy is the
// fallback). Published versions are immutable, so a hard link can never
// observe a change, and deleting a published directory only removes names —
// the snapshot's inodes live on. That makes pruning safe without any lock or
// lease: an adopter that lists a version just before it is deleted fails at
// link() with ENOENT, discards its partial snapshot and tries the next
// version. Snapshots of dead pids are removed on tidy; a process removes its
// own on normal exit.
export const PUBLISH_GRACE_MS = 24 * 60 * 60 * 1000;
export function modelInUseDir(root) {
    return path.join(root, 'inuse');
}
/** Snapshots of processes that are gone (a SIGKILL/SIGTERM skips the exit hook). Hard links only: no space, just names. */
function removeDeadSnapshots(root) {
    try {
        for (const n of fs.readdirSync(modelInUseDir(root))) {
            if (/^\d+$/.test(n) && !pidAlive(Number(n))) {
                fs.rmSync(path.join(modelInUseDir(root), n), { recursive: true, force: true });
            }
        }
    }
    catch {
        // no snapshots yet
    }
}
let exitCleanupRegistered = false;
function registerExitCleanup(dir) {
    if (exitCleanupRegistered)
        return;
    exitCleanupRegistered = true;
    process.on('exit', () => {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        catch {
            // best effort; tidy removes it once the pid is gone
        }
    });
}
/**
 * Point transformers.js at this process's private snapshot of a published
 * version, creating it on first use. Returns null when the snapshot cannot be
 * made (the version vanished between look-up and link, or the inuse dir is
 * unwritable), so the caller can try another version or keep the configured
 * cache.
 */
function useVersion(root, fp, modelId) {
    const mine = path.join(modelInUseDir(root), String(process.pid));
    const snapshot = path.join(mine, fp);
    const dst = path.join(snapshot, modelId);
    // A snapshot is reused only when its completion marker (written last) is
    // there; anything else is a leftover of an interrupted link run — possibly
    // under a reused pid, which removeDeadSnapshots cannot tell apart — and is
    // rebuilt from scratch.
    const marker = path.join(snapshot, '.complete');
    if (fs.existsSync(marker)) {
        transformersEnv.cacheDir = snapshot;
        return snapshot;
    }
    fs.rmSync(snapshot, { recursive: true, force: true });
    try {
        removeDeadSnapshots(root); // cheap housekeeping on every new snapshot, not only on publish
        const src = path.join(root, fp, modelId);
        const files = JSON.parse(fs.readFileSync(path.join(root, fp, MANIFEST), 'utf8'));
        if (!looksCompleteModel(files))
            return null;
        for (const f of files) {
            const from = path.join(src, f.rel);
            const to = path.join(dst, f.rel);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            try {
                fs.linkSync(from, to);
            }
            catch (e) {
                const code = e.code;
                if (code === 'EEXIST')
                    continue;
                if (code === 'ENOENT')
                    throw e; // the version is being deleted under us
                // Hard links unsupported here (exFAT, some network filesystems): a
                // copy is the only way, and a large one must not land inside the MCP
                // initialize handshake, so before it the snapshot is simply not taken.
                if (!mirroringAllowed)
                    throw e;
                fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
            }
        }
        // every manifest entry must have made it, byte-for-byte in size (a delete
        // may have raced the loop)
        const whole = files.every((f) => {
            try {
                return fs.statSync(path.join(dst, f.rel)).size === f.size;
            }
            catch {
                return false;
            }
        });
        if (!whole)
            throw new Error('incomplete snapshot');
        fs.writeFileSync(marker, ''); // last: marks the snapshot complete
    }
    catch {
        fs.rmSync(snapshot, { recursive: true, force: true });
        return null;
    }
    registerExitCleanup(mine);
    transformersEnv.cacheDir = snapshot;
    return snapshot;
}
/** Remove leftovers of dead processes and prune old published versions beyond the newest few. */
function tidyModelRoot(root, modelId, keep = 3, now = Date.now()) {
    try {
        for (const n of fs.readdirSync(root)) {
            const m = STAGING_RE.exec(n);
            if (m && !pidAlive(Number(m[2])))
                fs.rmSync(path.join(root, n), { recursive: true, force: true });
        }
        removeDeadSnapshots(root);
        for (const dir of publishedDirs(root, modelId).slice(keep)) {
            if (now - fs.statSync(dir).mtimeMs < PUBLISH_GRACE_MS)
                continue;
            fs.rmSync(dir, { recursive: true, force: true }); // live snapshots keep their inodes
        }
    }
    catch {
        // housekeeping only
    }
}
function currentCacheDir() {
    const c = transformersEnv.cacheDir;
    return typeof c === 'string' ? c : '';
}
/** The transformers.js cache dir currently configured ('' when unset). */
export function currentModelCacheDir() {
    return currentCacheDir();
}
function underStableRoot(dir) {
    try {
        return path.resolve(dir).startsWith(path.resolve(stableModelCacheRoot()) + path.sep);
    }
    catch {
        return false;
    }
}
// ---- proof-based publishing -------------------------------------------------
//
// A source is only known to be complete once transformers.js has actually
// built a pipeline from it (every required file was read). initEmbeddings()
// reports that with notifyModelLoaded(); publishing is then immediate if the
// MCP server has passed its initialize handshake, or deferred until
// allowModelMirroring() is called from the oninitialized warm-up — the mirror
// work is synchronous and must never land inside the handshake.
let mirroringAllowed = false;
let provenSource = null;
/** Called after a pipeline was created successfully from `cacheDir`. */
export function notifyModelLoaded(modelId, cacheDir) {
    if (!cacheDir || underStableRoot(cacheDir))
        return; // already served from a mirror
    provenSource = { modelId, dir: cacheDir };
    if (mirroringAllowed)
        publishProvenModel();
}
/** Called once the MCP initialize handshake is done; publishes a pending proof. */
export function allowModelMirroring() {
    mirroringAllowed = true;
    publishProvenModel();
}
/** Publish the proven source (if any). Returns the cache dir in use, or null when nothing is proven yet. */
export function publishProvenModel() {
    if (!provenSource)
        return null;
    return relocateModelCache(provenSource.modelId, provenSource.dir, true);
}
/** True when `modelId` is currently served from a published mirror that exists on disk. */
export function isModelMirrored(modelId) {
    const dir = currentCacheDir();
    return underStableRoot(dir) && fs.existsSync(path.join(dir, modelId, 'config.json'));
}
/**
 * Use a published (complete, immutable) mirror of `modelId` if one exists —
 * the one matching the configured source when that source can still be
 * fingerprinted, else the newest — and otherwise leave the cache setting
 * untouched. Never mirrors, never copies: cheap and safe on paths that run
 * before the MCP initialize handshake (inject daemon pre-warm, hooks, CLI
 * workers). Returns the cache dir in use.
 */
export function adoptStableModelCache(modelId) {
    const current = currentCacheDir();
    try {
        const root = stableModelCacheRoot();
        if (current && !path.resolve(current).startsWith(path.resolve(root) + path.sep)) {
            const src = path.join(current, modelId);
            if (fs.existsSync(src)) {
                const files = listModelFiles(src);
                const fp = fingerprintOf(files);
                if (isPublished(root, fp, modelId)) {
                    const dir = useVersion(root, fp, modelId);
                    if (dir)
                        return dir;
                }
                // A complete, intact source without a published twin stays in use: an
                // older published version must never shadow a newer (or repaired)
                // source, and the next warm-up publishes this one. An INCOMPLETE or
                // CORRUPT source (partial download, partial delete, truncated write)
                // must not shadow a complete published version either, so it falls
                // through to the candidates. The structural check runs only on this
                // path, i.e. once per machine until the source gets published.
                if (looksCompleteModel(files) && modelFilesIntact(src))
                    return current;
            }
        }
        for (const candidate of publishedDirs(root, modelId)) {
            const dir = useVersion(root, path.basename(candidate), modelId);
            if (dir)
                return dir;
        }
    }
    catch {
        // stable root unavailable — keep whatever is configured
    }
    return current;
}
/**
 * Publish `modelId` from the bundled (in-tree) cache into an immutable
 * fingerprint dir under the stable root and point transformers.js at it.
 * Nothing is published while the source is incomplete (download in progress)
 * or changes during the mirror; the bundled cache then stays in use, exactly
 * as before this feature, and the next warm-up tries again. If the source is
 * gone (swept) the newest published mirror is adopted. If neither exists the
 * cache setting is left untouched so transformers.js downloads where it
 * always did. Returns the cache dir actually in use.
 */
export function relocateModelCache(modelId, fromDir = BUNDLED_MODEL_CACHE_DIR, proven = false) {
    try {
        const root = stableModelCacheRoot();
        const src = fromDir ? path.join(fromDir, modelId) : null;
        if (!src || !fs.existsSync(src) || path.resolve(src).startsWith(path.resolve(root) + path.sep)) {
            return adoptStableModelCache(modelId);
        }
        const before = listModelFiles(src);
        // Every required file must be present regardless of proof: a pipeline can
        // succeed from the in-memory download while a cache write (even a whole
        // directory) failed. Without proof the source must also have been quiet
        // for a while. Otherwise the bundled cache stays in use.
        if (!looksCompleteModel(before) || (!proven && !isQuiescent(before)))
            return currentCacheDir();
        const fp = fingerprintOf(before);
        const final = path.join(root, fp);
        if (!isPublished(root, fp, modelId)) {
            const staging = path.join(root, `${fp}.staging-${process.pid}`);
            fs.rmSync(staging, { recursive: true, force: true });
            const mirrored = mirrorTree(src, path.join(staging, modelId));
            const unchanged = mirrored && fingerprintOf(listModelFiles(src)) === fp;
            // Proof or not, the bytes on disk are checked independently (see above).
            const intact = unchanged && modelFilesIntact(path.join(staging, modelId));
            if (intact) {
                try {
                    fs.writeFileSync(path.join(staging, MANIFEST), JSON.stringify(before));
                    fs.renameSync(staging, final); // atomic publish
                }
                catch {
                    // another process published the same fingerprint first — fine
                }
            }
            fs.rmSync(staging, { recursive: true, force: true });
            if (!isPublished(root, fp, modelId))
                return currentCacheDir(); // keep the bundled cache
            const used = useVersion(root, fp, modelId); // lease first: our own version is never a prune candidate
            tidyModelRoot(root, modelId);
            return used ?? currentCacheDir();
        }
        return useVersion(root, fp, modelId) ?? currentCacheDir();
    }
    catch {
        // stable root unavailable (read-only or sandboxed HOME): leave the cache setting as it was
        return currentCacheDir();
    }
}
/** Test hook: forget the process-cached stable path and the model-mirroring state. */
export function resetRuntimeAssetCacheForTests() {
    stableVecPath = undefined;
    mirroringAllowed = false;
    provenSource = null;
}
