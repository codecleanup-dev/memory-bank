import { getSearchDb } from './search.js';
import { l2DistanceToSimilarity } from './db.js';
import { searchSimilarFacts } from './fact-db.js';
import { generateEmbedding, initEmbeddings, queryBaseline } from './embeddings.js';
import { getRelatedFacts } from './ontology-db.js';
import { detectRepeat, formatRepeatContext } from './repeat-detector.js';
import { appendInjectLog } from './inject-log.js';
import { loadLedger, appendLedger } from './inject-ledger.js';

const TOP_K = 5;
// Probe-baseline relevance gate (e5 scores are compressed, so absolute
// thresholds cannot separate relevant from irrelevant). A fact is injected
// only when sim(query, fact) exceeds the query's own background baseline by
// this margin. Measured on KR/EN real-DB pairs: related +0.047~+0.123,
// unrelated -0.028~-0.091; long compound "memory" facts can leak in at
// +0.04~+0.045, so the margin sits just above that noise band.
const BASELINE_MARGIN = 0.045;
const MAX_CONTEXT_FACTS = 8;
// Token budget: fact 평균 140자·p90 207자 실측 — 절단 없이 8건이면 ~470 tok/프롬프트.
// fact 당 160자 + 블록 1,000자 예산으로 상한. 잘린 내용이 필요하면 search_facts 로 조회.
const FACT_CHAR_CAP = 160;
const BLOCK_CHAR_BUDGET = 1000;
// detectRepeat 는 313k exchanges 벡터검색 (p50 21ms / p95 498ms 실측) — tail 이
// 주입 지연 p90 을 끌어올린다. better-sqlite3 는 동기라 시작한 검색을 타이머로
// 선점할 수 없다(Promise.race 는 무효 — Codex 리뷰 지적). 대신 시작 "전" 경과
// 예산을 확인해, 파이프라인이 이미 이만큼 썼으면 반복감지를 통째로 생략한다.
const REPEAT_ELAPSED_BUDGET_MS = 700;

function truncateFact(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > FACT_CHAR_CAP ? t.slice(0, FACT_CHAR_CAP - 1) + '…' : t;
}

/**
 * E2: surprise as an injection-ranking signal, OFF by default (0) — telemetry
 * ships first, the weight is raised only after the spec's measurement gates
 * (docs/2026-07-25-e2-surprise-ranking-spec.md, soft-to-hard 절차).
 */
export function surpriseWeight(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseFloat(env.MEMORY_BANK_INJECT_SURPRISE_WEIGHT ?? '');
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

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

/**
 * 유산을 TOP_K 뒤에서 걸러내면 유산이 검색 슬롯을 차지해, 바로 다음 순위의 유효한 fact 가
 * 후보에 들지 못한다 (적대 리뷰 HIGH, 2026-10-05: 상위 TOP_K 가 전부 유산이면 no-match).
 * 그래서 첫 조회에서 유산이 하나라도 걸러졌고 TOP_K 가 차지 않으면 한도를 넓혀 한 번 더
 * 조회한다. 유산은 활성 fact 의 약 2.5% 라 8배 한도(기본 40)면 실측 분포에서 충분하고,
 * 재조회는 최대 1회로 묶어 지연 상한을 고정한다. 순수 함수 — fetch 를 주입해 시험한다.
 */
export const HERITAGE_REFETCH_FACTOR = 8;

export function selectInjectCandidates<T extends { fact: { created_at?: string | null } }>(
  fetch: (limit: number) => T[],
  topK: number,
  cutoff: string | null,
): { candidates: T[]; heritageExcluded: number; refetched: boolean } {
  const split = (rows: T[]) => {
    const keep: T[] = [];
    let dropped = 0;
    for (const r of rows) {
      if (isHeritageFact(r.fact, cutoff)) dropped += 1;
      else keep.push(r);
    }
    return { keep, dropped };
  };
  const first = split(fetch(topK));
  if (first.dropped === 0 || first.keep.length >= topK) {
    return { candidates: first.keep, heritageExcluded: first.dropped, refetched: false };
  }
  const second = split(fetch(topK * HERITAGE_REFETCH_FACTOR));
  return { candidates: second.keep.slice(0, topK), heritageExcluded: second.dropped, refetched: true };
}

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

const NOOP_COMMIT = () => {};

export async function computeInjectContext(
  userPrompt: string,
  project: string,
  via: 'daemon' | 'fallback',
  sessionId?: string,
): Promise<string> {
  // 하위호환 래퍼: 전달 확인 채널이 없는 호출자는 즉시 커밋 (기존 의미 유지)
  const r = await computeInjectContextDeferred(userPrompt, project, via, sessionId);
  r.commitLedger();
  return r.block;
}

export async function computeInjectContextDeferred(
  userPrompt: string,
  project: string,
  via: 'daemon' | 'fallback',
  sessionId?: string,
): Promise<InjectComputation> {
  const t0 = Date.now();
  if (!userPrompt || userPrompt.length < 20) {
    appendInjectLog({ status: 'skipped', project, prompt_len: userPrompt?.length ?? 0, via });
    return { block: '', commitLedger: NOOP_COMMIT };
  }

  try {
    await initEmbeddings();
    const embedding = await generateEmbedding(userPrompt, 'query');
    const baseline = await queryBaseline(embedding);

    // Cached long-lived handle (file-identity checked) — initDatabase()'s
    // full migration pass per request costs ~38ms and is pure overhead in the
    // warm daemon. NOT closed here: getSearchDb owns its lifecycle.
    const db = getSearchDb();
    {
      // threshold 0: take top-k by distance, then gate by baseline margin below
      // [fork v0-3] 유산 fact(원작자 수입분)는 주입 후보에서 뺀다. 검색 도구에는 그대로 남는다.
      // 걸러낸 뒤 TOP_K 가 차지 않으면 한도를 넓혀 1회 재조회 (selectInjectCandidates 주석).
      const cutoff = heritageCutoff();
      const selected = selectInjectCandidates(
        (limit) => searchSimilarFacts(db, embedding, project, limit, 0), TOP_K, cutoff,
      );
      const candidates = selected.candidates;
      const heritageLog = selected.heritageExcluded > 0
        ? { heritage_excluded: selected.heritageExcluded, ...(selected.refetched ? { heritage_refetch: true } : {}) }
        : {};
      const results = candidates.filter((r) => {
        const similarity = l2DistanceToSimilarity(r.distance);
        return similarity - baseline >= BASELINE_MARGIN;
      });

      if (results.length === 0) {
        appendInjectLog({
          status: 'no-match', project, prompt_len: userPrompt.length,
          candidates: candidates.length, injected: 0, duration_ms: Date.now() - t0, via,
          ...heritageLog,
        });
        return { block: '', commitLedger: NOOP_COMMIT };
      }

      // E2 (flag 뒤, 기본 off): PRIMARY 후보만 similarity + w×surprise 로
      // 재정렬한다. 관계 확장분은 질의 거리(similarity)가 없으므로 관계순
      // 그대로 뒤에 붙는다. w=0(기본)이면 기존 순서와 완전 동일.
      const w = surpriseWeight();
      if (w > 0) {
        results.sort((a, b) => {
          const sa = l2DistanceToSimilarity(a.distance) + w * (a.fact.surprise ?? 0);
          const sb = l2DistanceToSimilarity(b.distance) + w * (b.fact.surprise ?? 0);
          return sb - sa;
        });
      }

      // Expand with 1-hop relations
      const seenIds = new Set(results.map((r) => r.fact.id));
      const expandedFacts = [...results.map((r) => ({ fact: r.fact, note: '' }))];
      for (const { fact } of results.slice(0, 3)) {
        const related = getRelatedFacts(db, fact.id, 1, 0.6, 0.2, project);
        for (const { fact: relFact, relation } of related) {
          if (isHeritageFact(relFact, cutoff)) continue; // [fork v0-3] 관계 확장분도 같은 기준
          if (!seenIds.has(relFact.id) && expandedFacts.length < MAX_CONTEXT_FACTS) {
            seenIds.add(relFact.id);
            expandedFacts.push({ fact: relFact, note: `[${relation.relation_type}]` });
          }
        }
      }

      // 세션 dedup: 이 세션에서 이미 주입한 fact 는 대화 컨텍스트에 이미 있다 —
      // 재주입은 순수 토큰 낭비. 원장에 없는 fact 만 주입한다.
      const ledger = loadLedger(sessionId);
      const fresh = expandedFacts.filter(({ fact }) => !ledger.has(fact.id));
      const dedupedCount = expandedFacts.length - fresh.length;
      if (fresh.length === 0) {
        appendInjectLog({
          status: 'deduped', project, prompt_len: userPrompt.length,
          candidates: candidates.length, injected: 0, deduped: dedupedCount,
          duration_ms: Date.now() - t0, via,
          ...heritageLog,
        });
        return { block: '', commitLedger: NOOP_COMMIT };
      }

      // Format context block — fact 당 160자 절단 + 블록 1,000자 예산
      // (하위 관련도부터 탈락: fresh 는 관련도순이므로 뒤에서 끊긴다)
      const lines = ['📌 관련 과거 결정:'];
      let blockChars = lines[0].length;
      const injectedIds: string[] = [];
      // E2 telemetry: per-injected-fact surprise (2dp, null = unmeasured) —
      // observation for the spec's G3 gate, no behavior change.
      const injectedSurprises: Array<number | null> = [];
      for (const { fact, note } of fresh) {
        const dateStr = fact.created_at.slice(0, 10);
        const line = `- ${note ? note + ' ' : ''}[${fact.category}] ${truncateFact(fact.fact)} (${dateStr})`;
        if (blockChars + line.length > BLOCK_CHAR_BUDGET && injectedIds.length > 0) break;
        lines.push(line);
        blockChars += line.length + 1;
        injectedIds.push(fact.id);
        injectedSurprises.push(fact.surprise != null ? Math.round(fact.surprise * 100) / 100 : null);
      }

      // Detect repeated prompts (best-effort). 동기 sqlite 검색이라 시작 후엔
      // 선점 불가 — 주입이 이미 예산을 소진했으면 시작 자체를 생략 (tail 상한).
      if (Date.now() - t0 < REPEAT_ELAPSED_BUDGET_MS) {
        try {
          const repeats = await detectRepeat(userPrompt, project, 2, 0.85, { embedding, db });
          const repeatCtx = formatRepeatContext(repeats);
          if (repeatCtx) {
            lines.push('');
            lines.push(repeatCtx);
          }
        } catch { /* best-effort */ }
      }

      const block = lines.join('\n') + '\n';
      appendInjectLog({
        status: 'injected', project, prompt_len: userPrompt.length,
        candidates: candidates.length, injected: injectedIds.length,
        deduped: dedupedCount, chars: block.length,
        duration_ms: Date.now() - t0, via,
        surprise: injectedSurprises,
        ...(w > 0 ? { surprise_w: w } : {}),
        ...heritageLog,
      });
      // 원장 커밋은 호출자의 전달 확인 뒤로 미룬다 (위 InjectComputation 주석 참조)
      return {
        block,
        commitLedger: () => appendLedger(sessionId, ledger, injectedIds),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendInjectLog({
      status: 'error', project, prompt_len: userPrompt.length,
      duration_ms: Date.now() - t0, error: message.slice(0, 300), via,
    });
    return { block: '', commitLedger: NOOP_COMMIT }; // non-fatal: never disrupt the user's prompt
  }
}
