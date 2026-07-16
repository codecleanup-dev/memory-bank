import Database from 'better-sqlite3';
/**
 * Knowledge-graph consistency checks.
 *
 * The relation channel stores CONTRADICTS / SUPERSEDES edges but nothing ever
 * acts on them: measured live (2026-07-07, 12,995 active facts) 405/417
 * CONTRADICTS pairs and 437/446 SUPERSEDES pairs had BOTH endpoints still
 * active — the graph "knows" about the conflict yet keeps serving both sides
 * as current truth. These checks turn that stored knowledge into a resolution
 * queue. Deliberately report-first: nothing here deactivates or deletes facts
 * — a human (CLI) or an explicitly gated pipeline decides.
 */
export interface SlimFact {
    id: string;
    fact: string;
    category: string;
    scope_type: string;
    scope_project: string | null;
    consolidated_count: number;
    created_at: string;
}
export type ConflictType = 'CONTRADICTS' | 'SUPERSEDES';
export interface ConflictPair {
    relationId: string;
    relationType: ConflictType;
    reasoning: string | null;
    createdAt: string;
    /** For SUPERSEDES: the superseding (newer) fact. */
    source: SlimFact;
    /** For SUPERSEDES: the superseded fact that should normally retire. */
    target: SlimFact;
}
export interface ConsistencyCounts {
    activeFacts: number;
    /** CONTRADICTS relations whose BOTH endpoints are still active. */
    activeContradictsPairs: number;
    /** SUPERSEDES relations whose superseded side is still active. */
    activeSupersedesPairs: number;
    /** Active facts that appear in no relation at all (graph islands). */
    orphanFacts: number;
    /** orphanFacts / activeFacts (0 when there are no active facts). */
    orphanRate: number;
    totalCategories: number;
    /** Categories holding exactly one active fact (taxonomy sprawl signal). */
    singleFactCategories: number;
}
export declare function getConsistencyCounts(db: Database.Database): ConsistencyCounts;
export declare function hasActiveConflicts(counts: ConsistencyCounts): boolean;
/**
 * Active-active conflict pairs of one type, newest relation first.
 * `limit` bounds the fetch; use getConsistencyCounts() for the true totals.
 */
export declare function listActiveConflicts(db: Database.Database, type: ConflictType, limit?: number): ConflictPair[];
export declare function formatConsistencyReport(counts: ConsistencyCounts, contradicts: ConflictPair[], supersedes: ConflictPair[]): string;
