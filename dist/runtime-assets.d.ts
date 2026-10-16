export declare function runtimeAssetsDir(): string;
/**
 * Mirror one regular file. Idempotent (an existing mirror of the same size is
 * left alone) and atomic (temp name + rename, so a concurrent reader never sees
 * a partial file). Returns false when the source is unreadable or the mirror
 * cannot be written; callers fall back to the in-tree path in that case.
 */
export declare function mirrorFile(src: string, dst: string): boolean;
/** Mirror every regular file under srcDir into dstDir with the same layout. */
export declare function mirrorTree(srcDir: string, dstDir: string): boolean;
/**
 * Stable path of the sqlite-vec extension, mirrored on first use and cached for
 * the life of the process (so a later sweep cannot change the answer).
 * null = mirror unavailable (callers use the in-tree path).
 */
export declare function stableSqliteVecPath(): string | null;
/** Load sqlite-vec into a connection from the stable mirror, else the in-tree path. */
export declare function loadSqliteVec(db: {
    loadExtension(file: string): void;
}): void;
export declare function stableModelCacheDir(): string;
/**
 * Point transformers.js at the stable cache and seed it with `modelId` from the
 * bundled (in-tree) cache when that still exists. Idempotent and cheap once
 * seeded (per-file size check). If neither cache has the model, transformers.js
 * downloads into the stable dir exactly as it used to download in-tree.
 */
export declare function relocateModelCache(modelId: string, fromDir?: string | null): string;
/** Test hook: forget the process-cached stable path. */
export declare function resetRuntimeAssetCacheForTests(): void;
