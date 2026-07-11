/**
 * Single source of truth for "which sessions still need cross-project fact
 * extraction". BOTH the backfill-extract worker (to pick sessions to process)
 * AND the SessionStart hook (to decide whether to spawn that worker) must use
 * the IDENTICAL predicate — otherwise the spawn condition drifts from the work
 * condition. Observed drift (2026-07-11): the hook counted any session missing
 * from extraction_log (509), while the worker additionally drops
 * memory-bank-llm pollution sessions and sessions below MIN_EXCHANGES and so
 * only processed 4 — leaving 505 phantom "pending" sessions that the worker can
 * never clear, so the hook spawned the worker (model load + LLM setup) on EVERY
 * session start forever, for nothing.
 */
export interface ExtractionConfig {
    minExchanges: number;
    excludeProjects: string[];
}
/** Env-derived config, identical for the worker and the hook. */
export declare function getExtractionConfig(): ExtractionConfig;
/**
 * Core SELECT over pending-extraction sessions, through GROUP BY / HAVING but
 * WITHOUT any ORDER BY / LIMIT — callers wrap it:
 *   worker: `${sql} ORDER BY ts DESC LIMIT ?`   (params + limit)
 *   hook:   `SELECT 1 FROM (${sql}) LIMIT 1`     (params)
 * Columns: sid, ts, n.
 */
export declare function pendingExtractionCoreQuery(cfg: ExtractionConfig): {
    sql: string;
    params: string[];
};
