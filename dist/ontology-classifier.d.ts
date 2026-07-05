import Database from 'better-sqlite3';
import type { Fact } from './types.js';
import { generateEmbedding } from './embeddings.js';
export declare const MAX_CLASSIFY_ATTEMPTS = 3;
/**
 * The LLM CALL itself failed (SDK/network/spawn/empty stream) — the fact is
 * not the problem. Callers must NOT burn a classification attempt on these;
 * burning attempts during an outage would park innocent facts in
 * General/Misc after 3 outage windows.
 */
export declare class TransientLlmError extends Error {
    constructor(message: string);
}
/**
 * The fact's own content deterministically breaks a processing step (e.g.
 * its text crashes the local embedder every time). Counts as a CONTENT
 * failure: the attempt ledger burns one, and the fact is eventually parked —
 * unlike transient failures, retrying will never succeed.
 */
export declare class FactContentError extends Error {
    constructor(message: string);
}
/**
 * The category vec index is broken in a way self-heal cannot fix (table
 * unscannable / rejects writes). Neither the fact's fault (no ledger burn —
 * parking innocents in General/Misc under corruption would be wrong) nor
 * transient (retry won't fix it): it must surface LOUDLY — worker logs a
 * batch ERROR and circuit-breaks; manual repair is required.
 */
export declare class IndexRepairError extends Error {
    constructor(message: string);
}
/**
 * Record one failed classification attempt; returns the new attempt count.
 * When the count reaches MAX_CLASSIFY_ATTEMPTS the caller should persist the
 * fallback so the fact permanently leaves the backfill queue.
 */
export declare function recordOntologyAttempt(db: Database.Database, factId: string): number;
/**
 * Park a fact in General/Misc. Unlike the pre-2026-07 behaviour (which built
 * the fallback rows but never wrote the fact's ontology_category_id — leaving
 * it NULL and eternally re-selected), this PERSISTS the assignment. The fact
 * stays fully searchable via vector/FTS; ontology is an overlay.
 *
 * Conditional write: parking only applies while the fact is still
 * unclassified — a concurrent path that classified it successfully must
 * never be overwritten by the fallback.
 */
export declare function persistFallbackClassification(db: Database.Database, factId: string): {
    domainId: string;
    categoryId: string;
};
/**
 * Single-fact classification — a thin wrapper over the batch core so the
 * insert-time path shares the SAME structured-JSON prompt, index validation,
 * and transient/content failure taxonomy (an earlier revision kept a raw
 * prose prompt here, which re-opened the section-spoofing surface the batch
 * path had just closed).
 *
 * Throws TransientLlmError when the call itself failed (caller must not burn
 * an attempt) and a plain Error on content failures (caller ledgers it).
 */
export declare function classifyFactToOntology(db: Database.Database, fact: Fact): Promise<{
    domainId: string;
    categoryId: string;
}>;
/**
 * Classify a batch of facts with ONE LLM call (plus zero-cost deterministic
 * assignments). Each callHaiku() spawns a full headless Claude session
 * (~10-14s + a transcript + auxiliary calls), so per-fact single calls made
 * the backfill drain both slow and noisy on the proxy; batching divides the
 * spawn count by the batch size.
 *
 * Failure taxonomy (mirrors the external-probe 3-way classification):
 * - `failed`    — the LLM RESPONDED but produced no usable item for the fact
 *                 (unparseable array, missing/duplicate/out-of-range index).
 *                 These are content failures: the caller counts an attempt.
 * - `transient` — the CALL itself failed (SDK/network/spawn). The fact is not
 *                 the problem, so NO attempt is burned — burning attempts on
 *                 infrastructure downtime would park innocent facts in
 *                 General/Misc after 3 outage windows.
 * The ledger itself is the caller's job (backfillClassifyBatch) so attempt
 * accounting stays in one place.
 */
export declare function classifyFactsBatch(db: Database.Database, facts: Fact[]): Promise<{
    classified: string[];
    deterministic: string[];
    failed: string[];
    transient: string[];
    /** fact id → persisted assignment, for callers that need the ids (single path). */
    assignments: Map<string, {
        domainId: string;
        categoryId: string;
    }>;
}>;
/**
 * Backfill-facing wrapper: load facts by id, classify them in sub-batches,
 * record attempts for CONTENT failures (transient call failures burn no
 * attempt — see classifyFactsBatch), and park facts that exhausted their
 * attempts in General/Misc. Relations are OFF by default for backfill (each
 * relation probe costs another LLM call; the historic corpus already has
 * ~29K relations — new-fact inserts keep detecting them).
 */
export declare function backfillClassifyBatch(db: Database.Database, factIds: string[], opts?: {
    detectRelationsToo?: boolean;
}): Promise<{
    classified: number;
    deterministic: number;
    fallback: number;
    failed: number;
    transient: number;
}>;
/**
 * Self-healing sweep for ledger orphans: a crash between the MAXth attempt
 * increment and the fallback write leaves a fact with attempts ≥ MAX but a
 * NULL category — excluded from selection yet never parked. Run at worker
 * startup; the conditional write in persistFallbackClassification makes this
 * safe against races with a concurrent successful classification.
 */
export declare function parkExhaustedFacts(db: Database.Database): number;
export declare function detectRelations(db: Database.Database, newFact: Fact, topK?: number): Promise<void>;
export declare function classifyAndLinkFact(db: Database.Database, factId: string, embedding?: number[]): Promise<void>;
export { generateEmbedding };
