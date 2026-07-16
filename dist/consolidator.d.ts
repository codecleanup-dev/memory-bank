import Database from 'better-sqlite3';
import type { Fact, ConsolidationResult } from './types.js';
export declare const CONSOLIDATION_SYSTEM_PROMPT = "Compare two facts and determine their relationship.\n\n## Relationship types (choose one)\n- DUPLICATE: same content - merge\n- CONTRADICTION: conflicting - new fact replaces old\n- EVOLUTION: old fact evolved - update\n- INDEPENDENT: separate - keep both\n\n## Output format\n{\n  \"relation\": \"DUPLICATE|CONTRADICTION|EVOLUTION|INDEPENDENT\",\n  \"merged_fact\": \"final sentence for merge/replace\",\n  \"reason\": \"one-line justification\"\n}";
export declare function buildConsolidationPrompt(existingFact: string, newFact: string): string;
export type LlmErrorClass = 'transient' | 'deterministic' | 'unknown';
/**
 * Wraps a rejection from the LLM provider call (callHaiku) so the drain loop can
 * tell a provider error apart from an internal bug (parser/DB/mutation). ONLY a
 * provider error is eligible for classification + bounded skip; an internal
 * error must hold, never advance the cursor.
 */
export declare class LlmCallError extends Error {
    readonly reason: unknown;
    readonly status?: number;
    constructor(reason: unknown);
}
/**
 * Classify a callHaiku rejection into three states so the drain loop can satisfy
 * BOTH "an outage must never silently skip the backlog" AND "one un-processable
 * fact must never wedge the cursor forever" — a binary flag cannot do both under
 * a single monotonic cursor with imperfect error recognition:
 *
 *   - 'transient'     recognized outage/auth (429/5xx/401/403/404, rate-limit,
 *                     timeout, network...). The provider — not the fact — is at
 *                     fault, so the caller HOLDS the cursor and retries; it
 *                     resumes cleanly on recovery, never skipping during an
 *                     outage however long it lasts.
 *   - 'deterministic' recognized per-request rejection (400/413/422, too-long,
 *                     max_tokens, bad request...). Only THIS fact is at fault, so
 *                     the caller burns an attempt and advances after MAX.
 *   - 'unknown'       neither recognized. Treated like 'deterministic' by the
 *                     caller (bounded retry → advance) so an UNRECOGNIZED error
 *                     can never wedge the whole backlog forever. This is safe:
 *                     "skipping" a fact only means it isn't consolidated/deduped
 *                     — the fact stays active and searchable, it is never deleted
 *                     — whereas an unbounded hold halts ALL future consolidation.
 *
 * Numbers are read from the STRUCTURED status, or from a status number that is
 * explicitly LABELLED in the message ("status code 400"). A bare incidental
 * number ("retry after 400 ms") is never read as a status — it falls through to
 * phrase matching or 'unknown'.
 */
export declare function classifyLlmError(err: unknown): LlmErrorClass;
/**
 * Back-compat boolean: true only for a RECOGNIZED transient (outage/auth). An
 * 'unknown' error is NOT a recognized transient, so this returns false for it —
 * the drain loop uses classifyLlmError directly and bounds 'unknown' rather than
 * holding on it.
 */
export declare function isTransientLlmError(err: unknown): boolean;
/**
 * @deprecated Back-compat wrapper for the removed per-project consolidator.
 * Prefer `consolidateAllPending`. Now scope-isolated (via consolidateOne), so
 * it can no longer leak project-private text into global facts. Kept as a
 * public export so existing importers don't crash at module load.
 */
export declare function consolidateFacts(db: Database.Database, project: string, lastConsolidatedAt: string): Promise<{
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
}>;
/**
 * Consolidate the ENTIRE backlog in one pass: every new fact (any scope, any
 * project) processed exactly once, under a single shared Haiku budget. The
 * consolidate worker calls this once while holding the global lock, instead of
 * looping consolidateFacts per project — which reprocessed shared global facts
 * once per project (up to `MAX_HAIKU_CALLS × projectCount` calls) and, for
 * INDEPENDENT/CONTRADICTION verdicts (new fact stays active), kept re-comparing
 * the same global fact every pass.
 *
 * Each fact is compared within its own scope: a project fact against its
 * project + global (via its scope_project), a global fact against the whole
 * store (scope_project is null → no scope filter). Because a fact merged away
 * by an earlier comparison is deactivated, it neither reappears in this list
 * nor as a later candidate.
 */
export declare function consolidateAllPending(db: Database.Database, since: {
    createdAt: string;
    id: string;
} | null): Promise<{
    processed: number;
    merged: number;
    contradictions: number;
    evolutions: number;
    haikuCalls: number;
    cursor: {
        createdAt: string;
        id: string;
    } | null;
}>;
export declare function applyConsolidationResult(db: Database.Database, existingFact: Fact, newFact: Fact, result: ConsolidationResult): void;
