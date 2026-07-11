/**
 * SQL predicate + bound params selecting exchanges the reembed worker must
 * (re)embed. Extracted from scripts/reembed-worker.js so this high-stakes
 * logic — a bug here silently makes tens of thousands of rows invisible to
 * semantic search, as happened before the missing-vector branch existed — is
 * unit-testable.
 *
 * Selects a row when EITHER:
 *   (a) its embedding_version is stale (model upgrade), OR
 *   (b) it has NO vec_exchanges row despite claiming the current version
 *       (stamp-vector mismatch — the version stamp lies; exact set-diff via the
 *       vec0 shadow `_rowids` table).
 * AND it is NOT one of the plugin's own worker-prompt exchanges (ephemeral
 * state that old-code sessions still index under real project slugs; without
 * this the (b) branch would "self-heal" pollution straight into vec_exchanges).
 *
 * The predicate references the exchanges table as alias `e`. Callers embed it
 * as `WHERE ${clause}` and pass `params` FIRST (before any trailing LIMIT etc).
 * `params` = [currentEmbeddingVersion, then (len, prefix) per worker prompt].
 *
 * @param currentEmbeddingVersion the version freshly-embedded rows are stamped with
 * @param prefixes worker-prompt leads to exclude (defaults to the real set;
 *        injectable for tests)
 */
export declare function buildReembedPending(currentEmbeddingVersion: number, prefixes?: readonly string[]): {
    clause: string;
    params: Array<number | string>;
};
