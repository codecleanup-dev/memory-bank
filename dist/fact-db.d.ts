import Database from 'better-sqlite3';
import type { Fact, FactRevision } from './types.js';
interface InsertFactParams {
    fact: string;
    category: string;
    scope_type: string;
    scope_project: string | null;
    source_exchange_ids: string[];
    embedding: number[] | null;
    coding_agent?: string;
    fact_kr?: string | null;
    embedding_kr?: number[] | null;
}
interface UpdateFactParams {
    fact?: string;
    embedding?: number[] | null;
    consolidated_count_increment?: boolean;
}
interface InsertRevisionParams {
    fact_id: string;
    previous_fact: string;
    new_fact: string;
    reason: string | null;
    source_exchange_id: string | null;
}
export declare function insertFact(db: Database.Database, params: InsertFactParams): string;
export declare function getActiveFacts(db: Database.Database): Fact[];
export declare function getFactsByProject(db: Database.Database, project: string): Fact[];
export declare function updateFact(db: Database.Database, id: string, params: UpdateFactParams): void;
export declare function deactivateFact(db: Database.Database, id: string): void;
export declare function deleteFact(db: Database.Database, id: string): void;
export declare function insertRevision(db: Database.Database, params: InsertRevisionParams): string;
export declare function getRevisions(db: Database.Database, factId: string): FactRevision[];
export declare function searchSimilarFacts(db: Database.Database, embedding: number[], project: string | null, limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
/**
 * Nearest active facts restricted to EXACTLY one scope — used by consolidation
 * so a project-private fact and a global fact can never be compared/merged
 * across the boundary (which would leak private text into global memory or let
 * one project mutate shared global facts). The scope filter is applied to the
 * FULL overfetched candidate list BEFORE truncation, so a same-scope match is
 * not starved out by closer out-of-scope rows (which the general
 * searchSimilarFacts truncates first).
 *
 * scope: { type:'global' } → global facts only.
 *        { type:'project', project } → that project's own facts only (no global).
 */
export declare function searchSimilarFactsSameScope(db: Database.Database, embedding: number[], scope: {
    type: 'global';
} | {
    type: 'project';
    project: string;
}, limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
/**
 * Get top facts using a relevance score that combines:
 * - Confirmation count (consolidated_count) — how established is this fact
 * - Recency (updated_at) — how recent is this fact
 * - Scope priority — project-specific facts rank higher than global for that project
 *
 * Score = (log2(consolidated_count + 1) * 3) + recency_bonus + scope_bonus
 *   recency_bonus: 5 if updated in last 7 days, 3 if last 30 days, 1 if last 90 days, 0 otherwise
 *   scope_bonus: 2 for project-scoped facts, 0 for global
 *
 * Project facts are guaranteed up to half of the result slots: heavily-confirmed
 * global facts otherwise outscore any newly extracted project fact (count=1)
 * forever, so project context would never surface in injection.
 */
export declare function getTopFacts(db: Database.Database, rawProject: string, limit?: number): Fact[];
/**
 * Legacy: get facts by pure confirmation count (for backward compatibility).
 */
export declare function getTopFactsByCount(db: Database.Database, project: string, limit?: number): Fact[];
export declare function getNewFactsSince(db: Database.Database, project: string, since: string): Fact[];
/**
 * All active facts after a KEYSET cursor `(createdAt, id)`, EVERY scope/project,
 * each row once, ordered by (created_at, id). The composite key is what makes
 * the consolidate cursor strictly monotonic PER FACT: ordering by created_at
 * alone stalls when a whole timestamp group is larger than the per-run budget
 * (the cursor can't advance into a shared timestamp without risking a skip), so
 * `id` is the unique tiebreaker that lets the drain progress one fact at a time.
 *
 * cursor null → from the beginning (all active facts).
 *
 * KNOWN LIMITATION (best-effort dedup): a fact IMPORTED mid-drain with an old
 * `created_at` that sorts before the current cursor is not re-driven by this
 * pass (it's still a similarity CANDIDATE for future facts, so a duplicate is
 * still caught opportunistically). Consolidation is a background convenience,
 * not an exhaustive guarantee, so this is accepted rather than adding a
 * full re-scan on every import.
 */
export declare function getAllNewFactsSince(db: Database.Database, cursor: {
    createdAt: string;
    id: string;
} | null, limit?: number): Fact[];
/**
 * Search facts across ALL projects (no scope filter).
 * Used for cross-project knowledge transfer.
 */
export declare function searchAllFacts(db: Database.Database, embedding: number[], limit?: number, threshold?: number): Array<{
    fact: Fact;
    distance: number;
}>;
export {};
