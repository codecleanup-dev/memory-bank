/**
 * E2: surprise as an injection-ranking signal, OFF by default (0) — telemetry
 * ships first, the weight is raised only after the spec's measurement gates
 * (docs/2026-07-25-e2-surprise-ranking-spec.md, soft-to-hard 절차).
 */
export declare function surpriseWeight(env?: NodeJS.ProcessEnv): number;
/**
 * [fork v0-3, 2026-10-05] Heritage cutoff for session injection.
 *
 * Facts created before this date are the original author's memory documents
 * imported during the 2026-03~04 cc-sync intake (the "Hugh standards" series and
 * session-memory imports), not this user's own decisions. Measured 2026-10-05:
 * 38 of 7,312 injected facts in 30 days were heritage, including "Hugh의 인지
 * 아키텍처와 자기 모델" 3x. They stay fully searchable (search / search_facts /
 * graph tools) — only the automatic UserPromptSubmit injection skips them.
 * Archive of the affected rows: docs/archive/heritage-facts-20261005.md.
 *
 * MEMORY_BANK_INJECT_HERITAGE_CUTOFF: ISO date (YYYY-MM-DD) to move the cutoff,
 * '' or 'off' to disable. Unset → DEFAULT_HERITAGE_CUTOFF. Malformed → default
 * (fail-closed toward the measured behaviour, not toward injecting heritage).
 */
export declare const DEFAULT_HERITAGE_CUTOFF = "2026-05-01";
export declare function heritageCutoff(env?: NodeJS.ProcessEnv): string | null;
/** created_at 날짜 접두(YYYY-MM-DD)가 컷오프보다 앞이면 유산. created_at 이 비어 있으면 유산으로 보지 않는다. */
export declare function isHeritageFact(fact: {
    created_at?: string | null;
}, cutoff: string | null): boolean;
/**
 * 유산을 TOP_K 뒤에서 걸러내면 유산이 검색 슬롯을 차지해, 바로 다음 순위의 유효한 fact 가
 * 후보에 들지 못한다 (적대 리뷰 HIGH, 2026-10-05: 상위 TOP_K 가 전부 유산이면 no-match).
 * 그래서 첫 조회에서 유산이 하나라도 걸러졌고 TOP_K 가 차지 않으면 한도를 넓혀 한 번 더
 * 조회한다. 유산은 활성 fact 의 약 2.5% 라 8배 한도(기본 40)면 실측 분포에서 충분하고,
 * 재조회는 최대 1회로 묶어 지연 상한을 고정한다. 순수 함수 — fetch 를 주입해 시험한다.
 */
export declare const HERITAGE_REFETCH_FACTOR = 8;
export declare function selectInjectCandidates<T extends {
    fact: {
        created_at?: string | null;
    };
}>(fetch: (limit: number) => T[], topK: number, cutoff: string | null): {
    candidates: T[];
    heritageExcluded: number;
    refetched: boolean;
};
/**
 * Compute the UserPromptSubmit context block for a prompt: top-K similar
 * facts gated by the probe baseline, expanded with 1-hop ontology relations,
 * plus repeated-prompt detection. Returns '' when there is nothing to inject.
 *
 * Shared by BOTH execution paths:
 *  - the warm in-process daemon inside the MCP server (embeddings already
 *    loaded → ~150ms), and
 *  - the cold fallback in scripts/inject-context.js (fresh node process,
 *    ~2.3s dominated by model load) used when no MCP server is running.
 *
 * `via` tags the inject log so the two paths stay distinguishable.
 */
/** 계산 결과 + 원장 커밋 클로저.
 * [fork] 원장 기록은 "전달 확인 후"가 계약이다: 계산 완료 시점에 기록하면
 * 클라이언트가 이미 타임아웃/접속해제한 요청의 fact 가 "주입됨"으로 남아
 * 그 세션 내내 억제된다 — 사용자가 본 적 없는 컨텍스트를 dedup 이 지우는
 * 역방향 결함 (적대 리뷰 발견, 2026-07-17). 호출자가 전달(소켓 flush /
 * stdout 기록)을 확인한 뒤 commitLedger() 를 호출한다. */
export interface InjectComputation {
    block: string;
    commitLedger: () => void;
}
export declare function computeInjectContext(userPrompt: string, project: string, via: 'daemon' | 'fallback', sessionId?: string): Promise<string>;
export declare function computeInjectContextDeferred(userPrompt: string, project: string, via: 'daemon' | 'fallback', sessionId?: string): Promise<InjectComputation>;
