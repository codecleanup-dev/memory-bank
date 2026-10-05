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
export declare const DEFAULT_HERITAGE_CUTOFF = "2026-05-01";
export declare function heritageCutoff(env?: NodeJS.ProcessEnv): string | null;
/**
 * [fork v1, 2026-10-05] 원작자 표준 문서 시리즈(01~10 번호 접두, "NN-slug memory …" 제목)가
 * memory-doc 레인으로 다시 색인된 fact 를 잡는다. 날짜 컷오프는 2026-03~04 원본 수입분(783건)만
 * 잡고, 2026-05-17 처럼 뒤에 다시 색인된 같은 문서(실측 10건)는 놓쳤다. 번호 접두 + memory-doc
 * 출처 두 조건을 함께 요구해, 원작자를 주제로 다룬 사용자 본인의 fact(hugh-corpus 작업 등, 번호
 * 접두 없음)는 건드리지 않는다.
 */
export declare const HERITAGE_DOC_PATTERN: RegExp;
export interface HeritageFactLike {
    created_at?: string | null;
    fact?: string | null;
    source_exchange_ids?: readonly string[] | null;
}
/**
 * 날짜 접두(YYYY-MM-DD)가 컷오프보다 앞이거나, memory-doc 출처의 원작자 번호 문서면 유산.
 * created_at 이 비어 있으면 날짜 규칙은 적용하지 않는다. 컷오프가 null 이면 두 규칙 모두 꺼진다.
 */
export declare function isHeritageFact(fact: HeritageFactLike, cutoff: string | null): boolean;
