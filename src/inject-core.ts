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
export async function computeInjectContext(
  userPrompt: string,
  project: string,
  via: 'daemon' | 'fallback',
  sessionId?: string,
): Promise<string> {
  const t0 = Date.now();
  if (!userPrompt || userPrompt.length < 20) {
    appendInjectLog({ status: 'skipped', project, prompt_len: userPrompt?.length ?? 0, via });
    return '';
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
      const candidates = searchSimilarFacts(db, embedding, project, TOP_K, 0);
      const results = candidates.filter((r) => {
        const similarity = l2DistanceToSimilarity(r.distance);
        return similarity - baseline >= BASELINE_MARGIN;
      });

      if (results.length === 0) {
        appendInjectLog({
          status: 'no-match', project, prompt_len: userPrompt.length,
          candidates: candidates.length, injected: 0, duration_ms: Date.now() - t0, via,
        });
        return '';
      }

      // Expand with 1-hop relations
      const seenIds = new Set(results.map((r) => r.fact.id));
      const expandedFacts = [...results.map((r) => ({ fact: r.fact, note: '' }))];
      for (const { fact } of results.slice(0, 3)) {
        const related = getRelatedFacts(db, fact.id, 1, 0.6, 0.2, project);
        for (const { fact: relFact, relation } of related) {
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
        });
        return '';
      }

      // Format context block — fact 당 160자 절단 + 블록 1,000자 예산
      // (하위 관련도부터 탈락: fresh 는 관련도순이므로 뒤에서 끊긴다)
      const lines = ['📌 관련 과거 결정:'];
      let blockChars = lines[0].length;
      const injectedIds: string[] = [];
      for (const { fact, note } of fresh) {
        const dateStr = fact.created_at.slice(0, 10);
        const line = `- ${note ? note + ' ' : ''}[${fact.category}] ${truncateFact(fact.fact)} (${dateStr})`;
        if (blockChars + line.length > BLOCK_CHAR_BUDGET && injectedIds.length > 0) break;
        lines.push(line);
        blockChars += line.length + 1;
        injectedIds.push(fact.id);
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

      appendLedger(sessionId, ledger, injectedIds);
      const block = lines.join('\n') + '\n';
      appendInjectLog({
        status: 'injected', project, prompt_len: userPrompt.length,
        candidates: candidates.length, injected: injectedIds.length,
        deduped: dedupedCount, chars: block.length,
        duration_ms: Date.now() - t0, via,
      });
      return block;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendInjectLog({
      status: 'error', project, prompt_len: userPrompt.length,
      duration_ms: Date.now() - t0, error: message.slice(0, 300), via,
    });
    return ''; // non-fatal: never disrupt the user's prompt
  }
}
