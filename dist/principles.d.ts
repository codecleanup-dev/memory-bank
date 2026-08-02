import Database from 'better-sqlite3';
/**
 * Principles registry + fact↔principle conflict store.
 *
 * Principles are the user's curated operating rules — one-line statements
 * mirroring the canonical rules files. They enter this table ONLY through the
 * `principles` CLI (human-gated by design; no auto-scraping — the rules files
 * remain the canon, this table is a reference index for conflict checking).
 *
 * Boundary contract (deliberate, mirrors consistency.ts report-first stance):
 * nothing in this module touches fact recording, truth, or retrieval ranking.
 * Conflicts are display/report state plus a resolution queue — a human (CLI)
 * decides whether the fact is stale, the principle is outdated, or the pair
 * is acceptable.
 */
export type PrincipleLayer = 'identity' | 'principle' | 'policy';
export declare const PRINCIPLE_LAYERS: readonly PrincipleLayer[];
export type ConflictResolution = 'fact_deprecated' | 'acknowledged' | 'false_positive' | 'principle_updated';
export declare const CONFLICT_RESOLUTIONS: readonly ConflictResolution[];
export type ConflictMethod = 'llm' | 'manual' | 'import';
export interface Principle {
    id: string;
    slug: string;
    statement: string;
    source_path: string | null;
    layer: PrincipleLayer;
    is_active: number;
    created_at: string;
    updated_at: string;
}
export interface PrincipleInput {
    slug: string;
    statement: string;
    sourcePath?: string | null;
    layer?: PrincipleLayer;
}
/** Active conflict joined with both endpoints (for reports/CLI). */
export interface ActivePrincipleConflict {
    conflictId: string;
    reasoning: string | null;
    method: string;
    confidence: number | null;
    createdAt: string;
    principle: {
        id: string;
        slug: string;
        statement: string;
        layer: string;
    };
    fact: {
        id: string;
        fact: string;
        category: string;
        scope_type: string;
        scope_project: string | null;
        consolidated_count: number;
        created_at: string;
    };
}
export declare function addPrinciple(db: Database.Database, input: PrincipleInput): Principle;
/** Idempotent upsert for seed-file imports: updates statement/source/layer and reactivates. */
export declare function upsertPrinciple(db: Database.Database, input: PrincipleInput): 'inserted' | 'updated';
export declare function listPrinciples(db: Database.Database, includeInactive?: boolean): Principle[];
export declare function getActivePrinciples(db: Database.Database): Principle[];
export declare function getPrincipleBySlug(db: Database.Database, slug: string): Principle | null;
/** Returns true when the row existed and its active flag actually changed. */
export declare function setPrincipleActive(db: Database.Database, slug: string, active: boolean): boolean;
/**
 * Deterministic digest of the ACTIVE principle set (slug + statement, sorted).
 * The principle-check cursor stores this hash: when the set changes, the whole
 * fact scan restarts — verdicts against an old principle set are stale.
 */
export declare function activePrinciplesHash(db: Database.Database): string;
/**
 * Insert-or-ignore on the (principle, fact) pair. Human resolutions are
 * durable: a pair resolved as false_positive/acknowledged keeps its row
 * (is_active = 0), so re-detection cannot re-open it.
 */
export declare function recordPrincipleConflict(db: Database.Database, params: {
    principleId: string;
    factId: string;
    reasoning?: string | null;
    method: ConflictMethod;
    confidence?: number | null;
}): 'inserted' | 'exists';
/** Conflicts where the conflict row, the fact, AND the principle are all still active. */
export declare function countActivePrincipleConflicts(db: Database.Database): number;
export declare function listActivePrincipleConflicts(db: Database.Database, limit?: number): ActivePrincipleConflict[];
/** Returns true when the conflict existed, was active, and is now resolved. */
export declare function resolvePrincipleConflict(db: Database.Database, conflictId: string, resolution: ConflictResolution): boolean;
/**
 * One IN query for a search-result page: fact id → active principle conflicts.
 * Display-only annotation — callers must not use this to rank or filter.
 */
export declare function annotatePrincipleConflictsForFacts(db: Database.Database, factIds: string[]): Map<string, Array<{
    slug: string;
    statement: string;
    layer: string;
}>>;
/** Coverage summary shape (defined in principle-check.ts; duplicated here to avoid an import cycle). */
export interface PrincipleCoverageInfo {
    state: 'no-principles' | 'unscanned' | 'principles-changed' | 'partial' | 'complete';
    uncheckedFacts: number;
    /** F1: active revised facts awaiting re-judgement (optional for older callers). */
    recheckQueued?: number;
}
/**
 * Markdown section for the consistency report. Empty when there is nothing to
 * show AND nothing unmeasured — an incomplete scan is surfaced even with zero
 * conflicts, so "no conflicts" cannot masquerade as "measured and clean".
 */
export declare function formatPrincipleConflictSection(total: number, conflicts: ActivePrincipleConflict[], coverage?: PrincipleCoverageInfo): string;
