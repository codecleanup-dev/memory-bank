import Database from 'better-sqlite3';
import { type ConflictPair, type ConflictType } from './consistency.js';
import type { RelationType } from './types.js';
/**
 * Gated resolution of the consistency queue.
 *
 * `memory-bank consistency` reports active-active CONTRADICTS / SUPERSEDES
 * pairs but, by design, never acts on them. This module is the "explicitly
 * gated pipeline" the design note (docs/2026-07-25-principle-contradicts.md)
 * leaves room for: an LLM committee re-judges each pair and a bounded set of
 * actions is taken ONLY under --apply. Every action is written to the
 * `relation_resolution_log` table in the SAME transaction as the change (so a
 * change can never exist without its record) and mirrored, best-effort, to a
 * JSONL file a person can read without the DB.
 *
 * Why it exists (measured 2026-10-05, 40 random active pairs): the relation
 * extractor labels many UNRELATED fact pairs as CONTRADICTS ("HTML explain
 * boxes for blog posts" vs "Korean JSON for technical answers"), and a
 * single-call haiku judge rubber-stamps those as TRUE_CONFLICT at 0.9
 * confidence. SUPERSEDES edges, by contrast, were mostly genuine duplicates
 * (7/8). Hence two asymmetric policies:
 *
 *   CONTRADICTS — never touches facts. UNRELATED edges are deleted (archived),
 *     related-but-compatible edges are retyped to INFLUENCES, duplicate-shaped
 *     pairs are retyped to SUPERSEDES so the supersedes pass can see them,
 *     and TRUE_CONFLICT pairs stay in the queue for a human.
 *   SUPERSEDES — may retire the redundant fact, but only when the committee
 *     agrees at >= DEACTIVATE_THRESHOLD, both facts share a scope, and the
 *     loser is not better confirmed than the survivor. A revision row and an
 *     archive line record what retired and why.
 *
 * Fact texts are untrusted data; the prompt says so and nothing here executes
 * anything found in them.
 */
export declare const CONTRADICTS_VERDICTS: readonly ["TRUE_CONFLICT", "RELATED_NOT_CONFLICTING", "UNRELATED", "SUPERSEDED_BY_SOURCE", "SUPERSEDED_BY_TARGET", "UNCLEAR"];
export declare const SUPERSEDES_VERDICTS: readonly ["TARGET_REDUNDANT", "SOURCE_REDUNDANT", "BOTH_VALID", "UNRELATED", "UNCLEAR"];
export type ContradictsVerdict = (typeof CONTRADICTS_VERDICTS)[number];
export type SupersedesVerdict = (typeof SUPERSEDES_VERDICTS)[number];
export type Verdict = ContradictsVerdict | SupersedesVerdict;
export interface JudgeVerdict {
    pair_index: number;
    verdict: string;
    confidence: number;
    reasoning?: string;
}
/** Returns verdicts, or null when the output was unparseable (that batch is skipped). */
export type PairJudge = (pairs: ConflictPair[]) => Promise<JudgeVerdict[] | null>;
/** Edge-only actions (retype / delete) need this much committee confidence. */
export declare const EDGE_ACTION_THRESHOLD = 0.8;
/** Retiring a fact needs more: it changes what the graph answers. */
export declare const DEACTIVATE_THRESHOLD = 0.9;
export declare const DEFAULT_BATCH_SIZE = 8;
export declare const DEFAULT_VOTES = 3;
/** Resolution is cheap per pair but the verdict shapes the graph: default to a stronger model than extraction. */
export declare const DEFAULT_RESOLVE_MODEL = "sonnet";
/**
 * Agent SDK aliases → full model ids. The shared LLM wrapper hands MEMORY_BANK_FACT_MODEL
 * to the Agent SDK first (aliases fine) and, when that path fails, to the direct
 * Anthropic API (aliases rejected). Resolving before export keeps both paths valid.
 */
export declare const MODEL_ALIASES: Readonly<Record<string, string>>;
export declare function resolveModelId(name: string): string;
/**
 * The judge sees each fact up to this many characters. A fact longer than this is
 * never RETIRED on the strength of a verdict about a truncated view (planAction keeps
 * it for a human); edge-only actions still apply because they are reversible.
 */
export declare const JUDGE_FACT_TEXT_LIMIT = 2000;
/** Idempotent; called only when a run may write (dry-run leaves the schema alone). */
export declare function ensureResolutionLog(db: Database.Database): void;
/** Integer CLI option: the whole string must be digits and a safe integer >= min; otherwise null. */
export declare function parseIntegerOption(raw: string | undefined, min: number): number | null;
export declare function buildResolvePrompt(pairs: ConflictPair[]): {
    system: string;
    user: string;
};
/** The model may put null, strings, or nested arrays where an object belongs; only plain objects are findings. */
export declare function isFindingObject(value: unknown): value is JudgeVerdict;
/** A usable confidence is a finite number in [0, 1]; anything else is an invalid finding, never clamped. */
export declare function validConfidence(value: unknown): number | null;
/**
 * One voice per pair per vote: a vote that names two different verdicts for the same
 * pair has contradicted itself and is spoiled for that pair (it must not count toward
 * both majorities). Entries with an out-of-range index or confidence are dropped.
 */
export declare function cleanVote(vote: JudgeVerdict[], pairCount: number): JudgeVerdict[];
/** Default judge through the repo's shared LLM wrapper (model from MEMORY_BANK_FACT_MODEL). */
export declare const llmPairJudge: PairJudge;
/**
 * Committee vote over pairs, same contract as principle-check's committeeJudge:
 * majority of `votes` must agree on (pair, verdict); confidence is the median.
 * Votes after the first see a permuted order so order bias becomes variance
 * the majority filter can remove. All-unparseable → null (batch skipped).
 */
export declare function committeePairJudge(base: PairJudge, votes: number, rng?: () => number): PairJudge;
export type PlannedAction = {
    kind: 'keep';
    reason: string;
} | {
    kind: 'retype';
    to: RelationType;
    sourceId: string;
    targetId: string;
    reason: string;
} | {
    kind: 'delete';
    reason: string;
} | {
    kind: 'deactivate';
    loserId: string;
    survivorId: string;
    reason: string;
};
/** Pure policy: verdict + confidence → action. Thresholds and guards live here so tests can pin them. */
export declare function planAction(pair: ConflictPair, verdict: Verdict, confidence: number): PlannedAction;
export interface ResolvedPair {
    relationId: string;
    relationType: ConflictType;
    sourceId: string;
    targetId: string;
    verdict: string;
    confidence: number;
    judgeReasoning: string | null;
    planned: PlannedAction['kind'];
    reason: string;
    /** What actually happened under --apply (absent on dry-run / keep). */
    applied?: 'retyped' | 'deleted' | 'deleted-duplicate-after-retype' | 'deactivated' | 'skipped-changed' | 'skipped-conflicting-edge';
}
export interface ResolveOptions {
    apply: boolean;
    /** 0 = every active pair. */
    limit: number;
    /**
     * Re-judge pairs that an earlier --apply run already judged (kept or acted on). Off by
     * default so a bounded run walks the queue instead of re-paying for the same newest pairs.
     */
    rejudge?: boolean;
    batchSize?: number;
    votes?: number;
    judge?: PairJudge;
    rng?: () => number;
    archivePath?: string;
    onProgress?: (line: string) => void;
}
export interface ResolveSummary {
    type: ConflictType;
    mode: 'dry-run' | 'apply';
    examined: number;
    judged: number;
    unparseableBatches: number;
    planned: Record<PlannedAction['kind'], number>;
    applied: Record<string, number>;
    /** JSONL mirror writes that failed; the DB log row is still there for each. */
    archiveErrors: number;
    /** Pairs the judge answered for but with no usable verdict (self-contradiction, bad confidence, off-vocabulary). */
    spoiledPairs: number;
    /** Active pairs left out because an earlier --apply run already judged them (see `rejudge`). */
    previouslyJudged: number;
    pairs: ResolvedPair[];
    archivePath: string;
}
export declare function defaultArchivePath(): string;
export declare function resolveQueue(db: Database.Database, type: ConflictType, opts: ResolveOptions): Promise<ResolveSummary>;
export declare function formatResolveSummary(summary: ResolveSummary, listLimit?: number): string;
