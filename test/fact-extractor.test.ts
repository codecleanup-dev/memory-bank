import { describe, it, expect } from 'vitest';
import {
  buildExtractionPrompt,
  isSubstantiveExchange,
  normalizeFactText,
  passesConfidenceGate,
  selectSpreadBatches,
  EXTRACTION_SYSTEM_PROMPT,
} from '../src/fact-extractor.js';

describe('Fact Extractor', () => {
  it('E2 v2: system prompt asks for model-relative novelty, independent of confidence', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('model_surprise');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('GENERIC assistant');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('CORRECTS a default assumption');
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('rate independently of confidence');
  });

  describe('buildExtractionPrompt', () => {
    it('should format exchanges into extraction prompt', () => {
      const exchanges = [
        { user_message: 'What should we use for state management?', assistant_message: 'I recommend Riverpod' },
        { user_message: 'OK let us go with that', assistant_message: 'Setting up Riverpod now' },
      ];
      const prompt = buildExtractionPrompt(exchanges);
      expect(prompt).toContain('What should we use for state management?');
      expect(prompt).toContain('Riverpod');
      expect(prompt).toContain('Exchange 1');
      expect(prompt).toContain('Exchange 2');
    });

    it('should truncate long messages to 1000 chars', () => {
      const longMsg = 'x'.repeat(2000);
      const exchanges = [{ user_message: longMsg, assistant_message: 'short' }];
      const prompt = buildExtractionPrompt(exchanges);
      // Each message truncated to 1000, so total should be much less than 2000
      expect(prompt).not.toContain('x'.repeat(1001));
    });

    it('should handle empty exchanges array', () => {
      const prompt = buildExtractionPrompt([]);
      expect(prompt).toBe('');
    });

    it('should handle single exchange', () => {
      const exchanges = [{ user_message: 'Q', assistant_message: 'A' }];
      const prompt = buildExtractionPrompt(exchanges);
      expect(prompt).toContain('Exchange 1');
      expect(prompt).not.toContain('Exchange 2');
    });

    it('should handle special characters in messages', () => {
      const exchanges = [{ user_message: '<script>alert("xss")</script>', assistant_message: '```json\n{"key": "value"}\n```' }];
      const prompt = buildExtractionPrompt(exchanges);
      expect(prompt).toContain('<script>');
      expect(prompt).toContain('```json');
    });
  });

  describe('confidence filtering logic', () => {
    it('should filter below 0.7 threshold', () => {
      const extracted = [
        { fact: 'High', category: 'decision' as const, scope_type: 'project' as const, confidence: 0.9 },
        { fact: 'Low', category: 'decision' as const, scope_type: 'project' as const, confidence: 0.5 },
        { fact: 'Border', category: 'decision' as const, scope_type: 'project' as const, confidence: 0.7 },
      ];
      const filtered = extracted.filter(f => f.confidence >= 0.7);
      expect(filtered).toHaveLength(2);
      expect(filtered.map(f => f.fact)).toEqual(['High', 'Border']);
    });

    it('should limit to max 20 facts', () => {
      const extracted = Array.from({ length: 25 }, (_, i) => ({
        fact: `Fact ${i}`, category: 'knowledge' as const, scope_type: 'project' as const, confidence: 0.9,
      }));
      const limited = extracted.slice(0, 20);
      expect(limited).toHaveLength(20);
    });
  });

  describe('passesConfidenceGate', () => {
    it('accepts numeric confidence at or above threshold', () => {
      expect(passesConfidenceGate(0.9)).toBe(true);
      expect(passesConfidenceGate(0.7)).toBe(true);
    });

    it('rejects below-threshold confidence', () => {
      expect(passesConfidenceGate(0.5)).toBe(false);
    });

    it('rejects missing, NaN, and non-numeric confidence (malformed LLM output)', () => {
      expect(passesConfidenceGate(undefined)).toBe(false);
      expect(passesConfidenceGate(null)).toBe(false);
      expect(passesConfidenceGate(NaN)).toBe(false);
      expect(passesConfidenceGate('0.9')).toBe(false);
    });
  });

  describe('isSubstantiveExchange', () => {
    it('rejects empty user messages', () => {
      expect(isSubstantiveExchange('', 'long answer here')).toBe(false);
      expect(isSubstantiveExchange('   ', 'long answer here')).toBe(false);
    });

    it('rejects harness artifacts injected as user turns', () => {
      expect(isSubstantiveExchange('<local-command-stdout>output</local-command-stdout>', 'ack')).toBe(false);
      expect(isSubstantiveExchange('<command-name>/clear</command-name>', 'ack')).toBe(false);
      expect(isSubstantiveExchange('<local-command-caveat>Caveat text</local-command-caveat>', 'ack')).toBe(false);
      expect(isSubstantiveExchange('Caveat: the messages below were generated...', 'ack')).toBe(false);
    });

    it('rejects bare slash commands', () => {
      expect(isSubstantiveExchange('/clear', 'Cleared.')).toBe(false);
      expect(isSubstantiveExchange('/model', 'Set model')).toBe(false);
      expect(isSubstantiveExchange('/codex:review', 'Running review')).toBe(false);
    });

    it('rejects trivial acknowledgements with short replies', () => {
      expect(isSubstantiveExchange('ok', 'Done.')).toBe(false);
      expect(isSubstantiveExchange('네', '완료했습니다.')).toBe(false);
      expect(isSubstantiveExchange('고마워', '천만에요.')).toBe(false);
      expect(isSubstantiveExchange('진행해줘', '진행합니다.')).toBe(false);
    });

    it('keeps trivial-looking acknowledgements when the reply is substantive', () => {
      const longAnswer = 'A'.repeat(300);
      expect(isSubstantiveExchange('ok', longAnswer)).toBe(true);
      expect(isSubstantiveExchange('계속', longAnswer)).toBe(true);
    });

    it('keeps short but substantive questions with real answers', () => {
      const longAnswer = 'The reason is that better-sqlite3 requires a native rebuild after install. '.repeat(3);
      expect(isSubstantiveExchange('왜?', longAnswer)).toBe(true);
    });

    it('keeps normal exchanges', () => {
      expect(isSubstantiveExchange(
        'What should we use for state management?',
        'I recommend Riverpod because it fits the existing architecture.',
      )).toBe(true);
    });

    it('slash command with arguments is substantive', () => {
      expect(isSubstantiveExchange('/team build the login feature', 'Starting team orchestration')).toBe(true);
    });
  });

  describe('normalizeFactText', () => {
    it('normalizes case, whitespace, and trailing punctuation', () => {
      expect(normalizeFactText('User uses  Riverpod.')).toBe('user uses riverpod');
      expect(normalizeFactText('USER USES RIVERPOD!!')).toBe('user uses riverpod');
      expect(normalizeFactText('  user\nuses\triverpod  ')).toBe('user uses riverpod');
    });

    it('treats reworded duplicates with identical normalization as equal', () => {
      expect(normalizeFactText('Project uses TypeScript 5.')).toBe(normalizeFactText('project uses typescript 5'));
    });
  });

  describe('selectSpreadBatches', () => {
    it('returns all batches when under the cap', () => {
      const batches = [[1], [2], [3]];
      expect(selectSpreadBatches(batches, 5)).toEqual(batches);
    });

    it('caps to maxBatches while keeping first and last', () => {
      const batches = Array.from({ length: 40 }, (_, i) => [i]);
      const selected = selectSpreadBatches(batches, 12);
      expect(selected).toHaveLength(12);
      expect(selected[0]).toEqual([0]);
      expect(selected[selected.length - 1]).toEqual([39]);
    });

    it('spreads selection across the whole range', () => {
      const batches = Array.from({ length: 100 }, (_, i) => i);
      const selected = selectSpreadBatches(batches, 5);
      expect(selected).toEqual([0, 25, 50, 74, 99]);
    });

    it('handles maxBatches of 1', () => {
      const batches = [1, 2, 3];
      expect(selectSpreadBatches(batches, 1)).toEqual([1]);
    });
  });
});
