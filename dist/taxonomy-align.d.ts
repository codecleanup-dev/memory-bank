import Database from 'better-sqlite3';
/**
 * Taxonomy alignment: detect near-duplicate ontology categories via their
 * vec_categories embeddings and (optionally) merge them.
 *
 * Why: category sprawl is measured, not hypothetical — 2,809 categories for
 * 12,995 active facts with 1,014 single-fact categories (2026-07-07). The
 * classifier's deterministic reuse gate ships disabled with the note "opt in
 * once the taxonomy is consolidated" (ontology-classifier.ts); this module is
 * that consolidation step.
 *
 * Report-first by design:
 * - findMergeCandidates() never writes.
 * - applyMerges() runs only from an explicit CLI --apply, merges only
 *   same-domain pairs, and never touches the General/Misc parking category
 *   (facts are parked there by the attempt ledger, not by topic similarity).
 */
export interface MergeCandidate {
    keepId: string;
    keepName: string;
    keepDomain: string;
    keepFactCount: number;
    dropId: string;
    dropName: string;
    dropDomain: string;
    dropFactCount: number;
    similarity: number;
    sameDomain: boolean;
}
export interface FindResult {
    candidates: MergeCandidate[];
    /** Live categories without a vec_categories row — invisible to detection. */
    unindexedCategories: number;
    totalCategories: number;
}
export interface ApplyResult {
    merged: number;
    factsRemapped: number;
    skippedCrossDomain: number;
    /** Pairs whose sides were already unified (or vanished) by earlier merges. */
    skippedStale: number;
}
export declare const DEFAULT_MERGE_THRESHOLD = 0.9;
export declare function findMergeCandidates(db: Database.Database, opts?: {
    threshold?: number;
}): FindResult;
/**
 * Merge same-domain candidates: remap every fact (active AND inactive — no
 * dangling references) from drop → keep, delete the dropped category and its
 * index row. Chains (a→b, b→c) are resolved through a remap table so later
 * pairs land on the final survivor. facts.updated_at is deliberately NOT
 * bumped — a taxonomy remap is not new evidence and must not goose recency
 * scoring.
 */
export declare function applyMerges(db: Database.Database, candidates: MergeCandidate[]): ApplyResult;
export declare function formatAlignmentReport(find: FindResult, opts: {
    threshold: number;
    show: number;
}, applied?: ApplyResult): string;
