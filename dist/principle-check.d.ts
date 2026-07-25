import Database from 'better-sqlite3';
import { type Principle } from './principles.js';
/**
 * Batch worker: scans active facts and asks a judge whether any fact directly
 * contradicts a registered operating principle. Verdicts land in
 * principle_conflicts (insert-or-ignore) — display/report state only.
 *
 * Cursor policy (mirrors the repo's classifier/consolidation precedents):
 * - unparseable judge output → no-op, cursor STILL advances (a poison batch
 *   must not wedge the scan; the facts stay re-checkable via --recheck)
 * - judge call failure (throw) → run stops, cursor NOT advanced for that
 *   batch (a transient outage retries on the next run)
 * - active principle set changed (hash mismatch) → cursor resets: verdicts
 *   against an old principle set are stale, the whole scan restarts
 */
export interface FactForCheck {
    id: string;
    fact: string;
    category: string;
    scope_type: string;
    scope_project: string | null;
    created_at: string;
}
/** Raw judge finding — validated (index range, known slug, threshold) before storage. */
export interface JudgeFinding {
    fact_index: number;
    principle_slug: string;
    verdict: string;
    confidence: number;
    reasoning?: string;
}
/** Returns findings, or null when the output was unparseable (no-op + advance). */
export type PrincipleJudge = (facts: FactForCheck[], principles: Principle[]) => Promise<JudgeFinding[] | null>;
export declare const PRINCIPLE_CONFLICT_CONFIDENCE_THRESHOLD = 0.7;
export declare function buildJudgePrompt(facts: FactForCheck[], principles: Principle[]): {
    system: string;
    user: string;
};
/** Default judge: Haiku via the repo's shared LLM wrapper. */
export declare const llmJudge: PrincipleJudge;
export interface PrincipleCheckResult {
    activePrinciples: number;
    factsChecked: number;
    batches: number;
    /** Valid `contradicts` findings at/above the confidence threshold. */
    findings: number;
    /** Rows actually inserted (0 on dry-run; `exists` pairs are not re-counted). */
    inserted: number;
    /** True when the scan reached the end of the active facts. */
    done: boolean;
    /** Set when a judge call failed — the run stopped without advancing past that batch. */
    error: string | null;
    dryRunFindings: Array<{
        factId: string;
        principleSlug: string;
        confidence: number;
        reasoning: string | null;
    }>;
}
export interface PrincipleCheckOptions {
    batchSize?: number;
    maxFacts?: number;
    dryRun?: boolean;
    /** Force a full rescan (cursor reset) even when the principle set is unchanged. */
    recheck?: boolean;
    judge?: PrincipleJudge;
}
export declare function runPrincipleCheck(db: Database.Database, opts?: PrincipleCheckOptions): Promise<PrincipleCheckResult>;
/**
 * Scan-coverage state: whether "no conflicts" actually means "measured and
 * clean". A verdict only exists for facts the check has visited under the
 * CURRENT principle set — absence of conflicts for unvisited facts is an
 * unmeasured state, not a verified-consistent one.
 */
export interface PrincipleCheckCoverage {
    state: 'no-principles' | 'unscanned' | 'principles-changed' | 'partial' | 'complete';
    /** Active facts not covered by a scan against the current principle set. */
    uncheckedFacts: number;
}
export declare function getPrincipleCheckCoverage(db: Database.Database): PrincipleCheckCoverage;
