/**
 * Relation vocabulary. The original four types skew heavily toward SUPPORTS
 * (measured 83% of 8,948 relations, 2026-07-07) because candidates come from
 * embedding-similar pairs. DEPENDS_ON / DERIVED_FROM cover the
 * prerequisite/derivation axis surfaced by the co-extraction channel.
 * Single source of truth — the DB CHECK constraint is generated from this list.
 */
export const RELATION_TYPES = [
    'INFLUENCES',
    'SUPERSEDES',
    'SUPPORTS',
    'CONTRADICTS',
    'DEPENDS_ON',
    'DERIVED_FROM',
];
/**
 * Order-independent relation semantics: A SUPPORTS B carries the same claim
 * as B SUPPORTS A, and CONTRADICTS is inherently mutual — an
 * opposite-direction duplicate of these is pure noise. Every other type is
 * directional: the reverse edge is a DISTINCT claim (dependency cycle,
 * competing canonicality, mutual derivation) that dedup must not swallow.
 */
export const SYMMETRIC_RELATION_TYPES = new Set([
    'SUPPORTS',
    'CONTRADICTS',
]);
