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
export declare const PRINCIPLE_CONFLICT_CONFIDENCE_THRESHOLD = 0.8;
/**
 * Default committee size for the LLM judge (see committeeJudge). 3 balances
 * the measured churn suppression against LLM cost; --votes 1 restores the
 * single-call behavior for cheap exploratory scans.
 */
export declare const DEFAULT_JUDGE_VOTES = 3;
export declare function buildJudgePrompt(facts: FactForCheck[], principles: Principle[]): {
    system: string;
    user: string;
};
/**
 * Error-text detection: the agent SDK surfaces some failures (rate limits,
 * API errors) as a plain-text RESULT instead of throwing. Without this guard
 * such a response parses to null → "unparseable, no-op + cursor advance",
 * silently skipping facts during an outage (observed live 2026-07-25:
 * "API Error: Rate limit reached"). Outages must throw so the run stops
 * WITHOUT advancing — same contract as a thrown judge failure.
 */
export declare function isLlmErrorText(raw: string): boolean;
/** Default judge: Haiku via the repo's shared LLM wrapper. */
export declare const llmJudge: PrincipleJudge;
/**
 * Committee vote: run the judge `votes` times per batch and keep only
 * (fact, principle) pairs that a MAJORITY of votes report, with the median
 * confidence. Measured motivation (2026-07-25, two 200-fact re-judgings):
 * single-vote findings churn run-to-run in the 0.80–0.85 band while
 * keep-worthy findings recur — majority filtering removes the
 * non-reproducible marginals that no prompt wording could pin down.
 * All-vote failure (throw) propagates; a single vote's unparseable output
 * counts as an empty vote, and if EVERY vote is unparseable the committee
 * returns null (no-op + cursor advance, same contract as a single judge).
 */
export declare function committeeJudge(base: PrincipleJudge, votes: number): PrincipleJudge;
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
    /** F1: revised facts re-judged from the recheck queue this run (counted in factsChecked too). */
    recheckedFacts: number;
    /** F1: stale llm-method conflicts system-cleared because the re-judgement did not re-find them. */
    reconciledCleared: number;
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
    /** Per-run confidence cutoff override (0 < t ≤ 1); defaults to PRINCIPLE_CONFLICT_CONFIDENCE_THRESHOLD. */
    confidenceThreshold?: number;
    /** Committee size (1–5, default DEFAULT_JUDGE_VOTES): majority-vote across repeated judge calls. */
    votes?: number;
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
    /** F1: active revised facts awaiting re-judgement (drained before the forward scan). */
    recheckQueued: number;
}
export declare function getPrincipleCheckCoverage(db: Database.Database): PrincipleCheckCoverage;
