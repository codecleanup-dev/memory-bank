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
function boundedInt(raw, def, cap) {
    if (raw === undefined || !/^\d+$/.test(raw.trim()))
        return def;
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n >= 1 && n <= cap ? n : def;
}
/** Env-derived config, identical for the worker and the hook. */
export function getExtractionConfig() {
    const excludeProjects = (process.env.BACKFILL_EXCLUDE_PROJECTS ||
        '/Users/jung-wankim/Project/Claude/memory-bank')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    // Default 2: 1-exchange sessions are overwhelmingly automated-worker /
    // monitoring noise that yields no durable facts. Interpolated into SQL →
    // boundedInt (not bare parseInt) so garbage can't reach the query text.
    const minExchanges = boundedInt(process.env.BACKFILL_MIN_EXCHANGES, 2, 1000);
    return { minExchanges, excludeProjects };
}
/**
 * Core SELECT over pending-extraction sessions, through GROUP BY / HAVING but
 * WITHOUT any ORDER BY / LIMIT — callers wrap it:
 *   worker: `${sql} ORDER BY ts DESC LIMIT ?`   (params + limit)
 *   hook:   `SELECT 1 FROM (${sql}) LIMIT 1`     (params)
 * Columns: sid, ts, n.
 */
export function pendingExtractionCoreQuery(cfg) {
    const exTerms = cfg.excludeProjects;
    // `x.session_id IS NOT NULL` is load-bearing: one NULL inside NOT IN makes the
    // whole predicate NULL (3-valued logic) → zero pending sessions → silent drain.
    const exClause = `AND e.session_id NOT IN (
      SELECT DISTINCT x.session_id FROM exchanges x
      WHERE x.session_id IS NOT NULL
        AND (x.cwd LIKE '%/memory-bank-llm'
      ${exTerms.length ? 'OR ' + exTerms.map(() => 'x.cwd = ?').join(' OR ') : ''})
    )`;
    const sql = `
    SELECT e.session_id AS sid, MAX(e.timestamp) AS ts, COUNT(*) AS n
    FROM exchanges e
    WHERE e.is_sidechain = 0 AND e.session_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM extraction_log l WHERE l.session_id = e.session_id)
      ${exClause}
    GROUP BY e.session_id
    HAVING COUNT(*) >= ${cfg.minExchanges}`;
    return { sql, params: exTerms };
}
