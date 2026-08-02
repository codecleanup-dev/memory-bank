/**
 * E2: surprise as an injection-ranking signal, OFF by default (0) — telemetry
 * ships first, the weight is raised only after the spec's measurement gates
 * (docs/2026-07-25-e2-surprise-ranking-spec.md, soft-to-hard 절차).
 */
export declare function surpriseWeight(env?: NodeJS.ProcessEnv): number;
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
