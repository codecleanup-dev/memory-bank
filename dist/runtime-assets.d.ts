export declare function runtimeAssetsDir(): string;
/**
 * Mirror one regular file as an independent snapshot (reflink clone where the
 * filesystem supports it, plain copy otherwise). Idempotent: an existing mirror
 * is left alone when it has the same size AND mtime (the mirror keeps the
 * source mtime), so a replaced source of equal length is still re-mirrored.
 * Atomic (temp name + rename, so a concurrent reader never sees a partial
 * file). Returns false when the source is unreadable or the mirror cannot be
 * written; callers keep using the in-tree path in that case.
 */
export declare function mirrorFile(src: string, dst: string): boolean;
/**
 * Mirror every file under srcDir into dstDir with the same layout. Symlinks are
 * followed (the target's content is mirrored as a regular file); a broken link
 * or any entry that cannot be mirrored makes the whole tree report failure so
 * callers never switch to an incomplete mirror.
 */
export declare function mirrorTree(srcDir: string, dstDir: string): boolean;
/**
 * Stable path of the sqlite-vec extension, mirrored on first use. Only a
 * successful mirror is cached for the life of the process (so a later sweep
 * cannot change the answer); a failure is retried on the next call so that a
 * transient problem (permissions, disk space) is not pinned until restart.
 * null = mirror unavailable right now (callers use the in-tree path).
 */
export declare function stableSqliteVecPath(): string | null;
/**
 * Load sqlite-vec into a connection from the stable mirror. If the pinned
 * mirror has disappeared since it was made (cache cleanup, concurrent
 * re-mirror), forget it and mirror again before falling back to the in-tree
 * path — that fallback is the swept path this module exists to avoid, so it is
 * the last resort, not the second attempt.
 */
export declare function loadSqliteVec(db: {
    loadExtension(file: string): void;
}): void;
export declare function stableModelCacheRoot(): string;
export declare const MODEL_QUIET_MS = 30000;
export declare function onnxLooksComplete(file: string): boolean;
/** Every file under a mirrored model dir passes its structural check. */
export declare function modelFilesIntact(dir: string): boolean;
export declare const PUBLISH_GRACE_MS: number;
export declare function modelInUseDir(root: string): string;
/** The transformers.js cache dir currently configured ('' when unset). */
export declare function currentModelCacheDir(): string;
/** Called after a pipeline was created successfully from `cacheDir`. */
export declare function notifyModelLoaded(modelId: string, cacheDir: string): void;
/** Called once the MCP initialize handshake is done; publishes a pending proof. */
export declare function allowModelMirroring(): void;
/** Publish the proven source (if any). Returns the cache dir in use, or null when nothing is proven yet. */
export declare function publishProvenModel(): string | null;
/** True when `modelId` is currently served from a published mirror that exists on disk. */
export declare function isModelMirrored(modelId: string): boolean;
/**
 * Use a published (complete, immutable) mirror of `modelId` if one exists —
 * the one matching the configured source when that source can still be
 * fingerprinted, else the newest — and otherwise leave the cache setting
 * untouched. Never mirrors, never copies: cheap and safe on paths that run
 * before the MCP initialize handshake (inject daemon pre-warm, hooks, CLI
 * workers). Returns the cache dir in use.
 */
export declare function adoptStableModelCache(modelId: string): string;
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
export declare function relocateModelCache(modelId: string, fromDir?: string | null, proven?: boolean): string;
/** Test hook: forget the process-cached stable path and the model-mirroring state. */
export declare function resetRuntimeAssetCacheForTests(): void;
