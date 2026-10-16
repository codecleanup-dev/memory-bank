export declare function runtimeAssetsDir(): string;
/**
 * Mirror one regular file. Idempotent: an existing mirror is left alone when it
 * is the same inode (hard link) or has the same size AND mtime (copy fallback
 * preserves the source mtime), so a replaced source of equal length is still
 * re-mirrored. Atomic (temp name + rename, so a concurrent reader never sees a
 * partial file). Returns false when the source is unreadable or the mirror
 * cannot be written; callers keep using the in-tree path in that case.
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
export declare function stableModelCacheDir(): string;
/**
 * Point transformers.js at the stable cache and seed it with `modelId` from the
 * bundled (in-tree) cache when that still exists. Idempotent and cheap once
 * seeded (per-file inode/mtime check). If the bundled cache has the model but
 * mirroring fails (permissions, disk space), the bundled cache stays in use —
 * a cache known to work is never traded for a re-download. If neither cache has
 * the model, transformers.js downloads into the stable dir exactly as it used
 * to download in-tree. Returns the cache dir actually in use.
 */
export declare function relocateModelCache(modelId: string, fromDir?: string | null): string;
/** Test hook: forget the process-cached stable path. */
export declare function resetRuntimeAssetCacheForTests(): void;
