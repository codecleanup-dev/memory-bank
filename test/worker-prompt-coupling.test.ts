import { describe, it, expect } from 'vitest';
import { WORKER_PROMPT_PREFIXES } from '../src/paths.js';
import { EXTRACTION_SYSTEM_PROMPT } from '../src/fact-extractor.js';
import { CONSOLIDATION_SYSTEM_PROMPT } from '../src/consolidator.js';
import { BATCH_CLASSIFY_SYSTEM_PROMPT, DETECT_RELATION_SYSTEM_PROMPT } from '../src/ontology-classifier.js';

// Pollution detection (indexing guard + purge) identifies the plugin's own
// worker sessions by the EXACT leading text of each Haiku system prompt. If a
// prompt is later tuned but WORKER_PROMPT_PREFIXES isn't updated, detection
// silently breaks and pollution accumulates in search. This test binds the two
// together so ANY drift fails loudly at build time, not silently in production.
describe('worker-prompt ↔ WORKER_PROMPT_PREFIXES coupling', () => {
  const actualPrompts = [
    EXTRACTION_SYSTEM_PROMPT,
    BATCH_CLASSIFY_SYSTEM_PROMPT,
    DETECT_RELATION_SYSTEM_PROMPT,
    CONSOLIDATION_SYSTEM_PROMPT,
  ];

  it('every worker system prompt starts with a registered prefix', () => {
    for (const prompt of actualPrompts) {
      const matched = WORKER_PROMPT_PREFIXES.some((p) => prompt.startsWith(p));
      expect(matched, `no WORKER_PROMPT_PREFIXES entry matches prompt lead: "${prompt.slice(0, 60)}..."`).toBe(true);
    }
  });

  it('every registered prefix matches exactly one real worker prompt (no dead prefixes)', () => {
    for (const prefix of WORKER_PROMPT_PREFIXES) {
      const hits = actualPrompts.filter((prompt) => prompt.startsWith(prefix)).length;
      expect(hits, `prefix "${prefix}" matches ${hits} worker prompts (expected exactly 1)`).toBe(1);
    }
  });

  it('the counts line up (one prefix per worker prompt)', () => {
    expect(WORKER_PROMPT_PREFIXES.length).toBe(actualPrompts.length);
  });
});
