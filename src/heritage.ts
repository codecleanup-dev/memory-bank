/**
 * [fork v0-3, 2026-10-05] Heritage cutoff for session injection.
 *
 * Facts created before this date are the original author's memory documents
 * imported during the 2026-03~04 cc-sync intake (the "Hugh standards" series and
 * session-memory imports), not this user's own decisions. Measured 2026-10-05:
 * 38 of 7,312 injected facts in 30 days were heritage, including "Hugh의 인지
 * 아키텍처와 자기 모델" 3x. They stay fully searchable (search / search_facts /
 * graph tools) — only the automatic UserPromptSubmit injection skips them, and it
 * skips them at the search stage (fact-db searchSimilarFacts minCreatedAt) so a
 * heritage row never occupies a top-K slot that a valid recent fact should get.
 * A markdown copy of the affected rows lives outside the repo
 * (~/.claude/state/backups/heritage-facts-20261005.md); the DB keeps them all.
 *
 * MEMORY_BANK_INJECT_HERITAGE_CUTOFF: ISO date (YYYY-MM-DD) to move the cutoff,
 * '' or 'off' to disable. Unset → DEFAULT_HERITAGE_CUTOFF. Malformed → default
 * (fail-closed toward the measured behaviour, not toward injecting heritage).
 *
 * Lives in its own module so fact-db (search) and inject-core (orchestration)
 * can both import it without a cycle.
 */
export const DEFAULT_HERITAGE_CUTOFF = '2026-05-01';

export function heritageCutoff(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.MEMORY_BANK_INJECT_HERITAGE_CUTOFF;
  if (raw === undefined) return DEFAULT_HERITAGE_CUTOFF;
  const v = raw.trim();
  if (v === '' || v.toLowerCase() === 'off') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_HERITAGE_CUTOFF;
}

/** created_at 날짜 접두(YYYY-MM-DD)가 컷오프보다 앞이면 유산. created_at 이 비어 있으면 유산으로 보지 않는다. */
export function isHeritageFact(fact: { created_at?: string | null }, cutoff: string | null): boolean {
  if (!cutoff) return false;
  const d = (fact.created_at ?? '').slice(0, 10);
  return d.length === 10 && d < cutoff;
}
