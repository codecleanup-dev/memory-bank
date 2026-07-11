import { getSearchDb } from './search.js';
import { l2DistanceToSimilarity } from './db.js';
import { searchSimilarFacts } from './fact-db.js';
import { generateEmbedding, initEmbeddings, queryBaseline } from './embeddings.js';
import { getRelatedFacts } from './ontology-db.js';
import { detectRepeat, formatRepeatContext } from './repeat-detector.js';
import { appendInjectLog } from './inject-log.js';
const TOP_K = 5;
// Probe-baseline relevance gate (e5 scores are compressed, so absolute
// thresholds cannot separate relevant from irrelevant). A fact is injected
// only when sim(query, fact) exceeds the query's own background baseline by
// this margin. Measured on KR/EN real-DB pairs: related +0.047~+0.123,
// unrelated -0.028~-0.091; long compound "memory" facts can leak in at
// +0.04~+0.045, so the margin sits just above that noise band.
const BASELINE_MARGIN = 0.045;
const MAX_CONTEXT_FACTS = 8;
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
export async function computeInjectContext(userPrompt, project, via) {
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
            // Format context block
            const lines = ['📌 관련 과거 결정:'];
            for (const { fact, note } of expandedFacts) {
                const dateStr = fact.created_at.slice(0, 10);
                lines.push(`- ${note ? note + ' ' : ''}[${fact.category}] ${fact.fact} (${dateStr})`);
            }
            // Detect repeated prompts (best-effort)
            try {
                const repeats = await detectRepeat(userPrompt, project, 2, 0.85, { embedding, db });
                const repeatCtx = formatRepeatContext(repeats);
                if (repeatCtx) {
                    lines.push('');
                    lines.push(repeatCtx);
                }
            }
            catch { /* best-effort */ }
            appendInjectLog({
                status: 'injected', project, prompt_len: userPrompt.length,
                candidates: candidates.length, injected: expandedFacts.length,
                duration_ms: Date.now() - t0, via,
            });
            return lines.join('\n') + '\n';
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendInjectLog({
            status: 'error', project, prompt_len: userPrompt.length,
            duration_ms: Date.now() - t0, error: message.slice(0, 300), via,
        });
        return ''; // non-fatal: never disrupt the user's prompt
    }
}
