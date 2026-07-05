#!/usr/bin/env node
/**
 * UserPromptSubmit context injection script.
 *
 * Reads USER_PROMPT from env, searches memory-bank for relevant facts
 * (vector similarity), expands with 1-hop ontology relations,
 * then prints a context block to stdout.
 *
 * Environment:
 *   CWD         - current working directory
 *   USER_PROMPT - the user's message text
 */

import { initDatabase } from '../dist/db.js';
import { searchSimilarFacts } from '../dist/fact-db.js';
import { generateEmbedding, initEmbeddings, queryBaseline } from '../dist/embeddings.js';
import { getRelatedFacts } from '../dist/ontology-db.js';
import { detectRepeat, formatRepeatContext } from '../dist/repeat-detector.js';
import { appendInjectLog } from '../dist/inject-log.js';

const TOP_K = 5;
// Probe-baseline relevance gate (e5 scores are compressed, so absolute
// thresholds cannot separate relevant from irrelevant). A fact is injected
// only when sim(query, fact) exceeds the query's own background baseline by
// this margin. Measured on KR/EN real-DB pairs: related +0.047~+0.123,
// unrelated -0.028~-0.091; long compound "memory" facts can leak in at
// +0.04~+0.045, so the margin sits just above that noise band.
const BASELINE_MARGIN = 0.045;
const MAX_CONTEXT_FACTS = 8;

async function main() {
  const project = process.env.CWD || process.cwd();
  const userPrompt = process.env.USER_PROMPT || '';
  const t0 = Date.now();

  if (!userPrompt || userPrompt.length < 20) {
    appendInjectLog({ status: 'skipped', project, prompt_len: userPrompt.length });
    process.exit(0);
  }

  try {
    await initEmbeddings();
    const embedding = await generateEmbedding(userPrompt, 'query');
    const baseline = await queryBaseline(embedding);

    const db = initDatabase();
    // threshold 0: take top-k by distance, then gate by baseline margin below
    const candidates = searchSimilarFacts(db, embedding, project, TOP_K, 0);
    const results = candidates.filter((r) => {
      const similarity = 1 - (r.distance * r.distance) / 2;
      return similarity - baseline >= BASELINE_MARGIN;
    });

    if (results.length === 0) {
      db.close();
      appendInjectLog({
        status: 'no-match',
        project,
        prompt_len: userPrompt.length,
        candidates: candidates.length,
        injected: 0,
        duration_ms: Date.now() - t0,
      });
      process.exit(0);
    }

    // Expand with 1-hop relations
    const seenIds = new Set(results.map(r => r.fact.id));
    const expandedFacts = [...results.map(r => ({ fact: r.fact, note: '' }))];

    for (const { fact } of results.slice(0, 3)) {
      const related = getRelatedFacts(db, fact.id, 1, 0.6, 0.2, project);
      for (const { fact: relFact, relation } of related) {
        if (!seenIds.has(relFact.id) && expandedFacts.length < MAX_CONTEXT_FACTS) {
          seenIds.add(relFact.id);
          expandedFacts.push({ fact: relFact, note: `[${relation.relation_type}]` });
        }
      }
    }

    db.close();

    if (expandedFacts.length === 0) {
      appendInjectLog({
        status: 'no-match',
        project,
        prompt_len: userPrompt.length,
        candidates: candidates.length,
        injected: 0,
        duration_ms: Date.now() - t0,
      });
      process.exit(0);
    }

    // Format context block
    const lines = ['📌 관련 과거 결정:'];
    for (const { fact, note } of expandedFacts) {
      const dateStr = fact.created_at.slice(0, 10);
      lines.push(`- ${note ? note + ' ' : ''}[${fact.category}] ${fact.fact} (${dateStr})`);
    }

    // Detect repeated prompts
    try {
      const repeats = await detectRepeat(userPrompt, project, 2, 0.85);
      const repeatCtx = formatRepeatContext(repeats);
      if (repeatCtx) {
        lines.push('');
        lines.push(repeatCtx);
      }
    } catch {
      // Repeat detection is best-effort
    }

    process.stdout.write(lines.join('\n') + '\n');
    appendInjectLog({
      status: 'injected',
      project,
      prompt_len: userPrompt.length,
      candidates: candidates.length,
      injected: expandedFacts.length,
      duration_ms: Date.now() - t0,
    });
  } catch (error) {
    // Non-fatal: don't disrupt user workflow
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`inject-context: error: ${message}\n`);
    appendInjectLog({
      status: 'error',
      project,
      prompt_len: userPrompt.length,
      duration_ms: Date.now() - t0,
      error: message.slice(0, 300),
    });
    process.exit(0);
  }
}

main();
