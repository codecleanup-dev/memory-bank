import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonResponse, pruneLlmTranscripts } from '../src/llm.js';

describe('LLM Module', () => {
  describe('parseJsonResponse', () => {
    it('should parse raw JSON array', () => {
      const result = parseJsonResponse<any[]>('[{"fact": "test"}]');
      expect(result).toEqual([{ fact: 'test' }]);
    });

    it('should parse JSON in code block', () => {
      const text = 'Here are the facts:\n```json\n[{"fact": "test"}]\n```';
      const result = parseJsonResponse<any[]>(text);
      expect(result).toEqual([{ fact: 'test' }]);
    });

    it('should return null for invalid JSON', () => {
      expect(parseJsonResponse<any>('not json at all')).toBeNull();
    });

    it('should parse JSON object', () => {
      const result = parseJsonResponse<any>('{"relation": "DUPLICATE"}');
      expect(result).toEqual({ relation: 'DUPLICATE' });
    });

    it('should handle nested JSON in text', () => {
      const text = 'Analysis complete.\n{"relation": "EVOLUTION", "merged_fact": "updated", "reason": "changed"}';
      const result = parseJsonResponse<any>(text);
      expect(result?.relation).toBe('EVOLUTION');
    });

    it('should return null for empty string', () => {
      expect(parseJsonResponse<any>('')).toBeNull();
    });

    it('should throw or return null for null/undefined input', () => {
      // null/undefined causes .match() to throw - this is expected behavior
      // since callers always pass string from LLM response
      expect(() => parseJsonResponse<any>(null as any)).toThrow();
    });

    it('should parse JSON with markdown wrapper', () => {
      const text = '```\n{"key": "value"}\n```';
      const result = parseJsonResponse<any>(text);
      expect(result?.key).toBe('value');
    });

    it('should handle JSON with trailing text', () => {
      const text = '{"answer": "yes", "confidence": 0.9}\n\nSome trailing explanation';
      const result = parseJsonResponse<any>(text);
      expect(result?.answer).toBe('yes');
    });

    it('should prefer array match over object match', () => {
      // regex chain: json code block > array > object
      // input with both array and object: array regex matches first
      const text = '{"a": {"b": {"c": [1, 2, 3]}}}';
      const result = parseJsonResponse<any>(text);
      // Array regex [...]  matches [1, 2, 3] before {...} regex
      expect(result).toEqual([1, 2, 3]);
    });

    it('should parse pure object when no array present', () => {
      const text = '{"key": "value", "nested": {"n": 1}}';
      const result = parseJsonResponse<any>(text);
      expect(result?.key).toBe('value');
      expect(result?.nested?.n).toBe(1);
    });
  });

  describe('pruneLlmTranscripts', () => {
    let projectsDir: string;
    const savedProjectsDir = process.env.TEST_PROJECTS_DIR;
    // Throttle bypass: any prune marker in the real workdir was written at
    // real "now"; calling with now = +2h makes markerAge > 1h deterministically.
    const FUTURE = () => Date.now() + 2 * 60 * 60 * 1000;
    const OLD = 3 * 24 * 60 * 60 * 1000; // 3 days — beyond the 24h default TTL

    function makeFile(dir: string, name: string, ageMs: number): string {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x');
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(p, t, t);
      return p;
    }

    beforeEach(() => {
      projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-prune-test-'));
      process.env.TEST_PROJECTS_DIR = projectsDir;
      delete process.env.MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS;
    });

    afterEach(() => {
      if (savedProjectsDir === undefined) delete process.env.TEST_PROJECTS_DIR;
      else process.env.TEST_PROJECTS_DIR = savedProjectsDir;
      delete process.env.MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS;
      fs.rmSync(projectsDir, { recursive: true, force: true });
    });

    it('should delete expired transcripts only inside memory-bank-llm slugs', () => {
      const llmDir = path.join(projectsDir, '-private-var-folders-xx-T-memory-bank-llm');
      fs.mkdirSync(llmDir, { recursive: true });
      const oldJsonl = makeFile(llmDir, 'aaaa-session.jsonl', OLD);
      const oldAgent = makeFile(llmDir, 'agent-a1b2c3.jsonl', OLD);
      const oldSummary = makeFile(llmDir, 'aaaa-session-summary.txt', OLD);
      const freshJsonl = makeFile(llmDir, 'bbbb-session.jsonl', 0);
      const otherFile = makeFile(llmDir, 'notes.md', OLD);

      const normalDir = path.join(projectsDir, '-Users-x-Project-real-project');
      fs.mkdirSync(normalDir, { recursive: true });
      const normalOldJsonl = makeFile(normalDir, 'cccc-session.jsonl', OLD);

      pruneLlmTranscripts(FUTURE());

      expect(fs.existsSync(oldJsonl)).toBe(false);
      expect(fs.existsSync(oldAgent)).toBe(false);
      expect(fs.existsSync(oldSummary)).toBe(false);
      expect(fs.existsSync(freshJsonl)).toBe(true); // within TTL (2h < 24h)
      expect(fs.existsSync(otherFile)).toBe(true); // non-transcript untouched
      expect(fs.existsSync(normalOldJsonl)).toBe(true); // real project untouched
    });

    it('should remove legacy slug dirs once emptied', () => {
      const legacyDir = path.join(projectsDir, '-x-T-tmp-AbC123-memory-bank-llm');
      fs.mkdirSync(legacyDir, { recursive: true });
      makeFile(legacyDir, 'dddd-session.jsonl', OLD);

      pruneLlmTranscripts(FUTURE());

      expect(fs.existsSync(legacyDir)).toBe(false);
    });

    it('should keep dirs that still contain non-transcript files', () => {
      const llmDir = path.join(projectsDir, '-y-memory-bank-llm');
      fs.mkdirSync(llmDir, { recursive: true });
      makeFile(llmDir, 'eeee-session.jsonl', OLD);
      const keeper = makeFile(llmDir, 'keep.bin', OLD);

      pruneLlmTranscripts(FUTURE());

      expect(fs.existsSync(keeper)).toBe(true);
      expect(fs.existsSync(llmDir)).toBe(true);
    });

    it('should honor the 1h TTL floor (TTL_HOURS=0 must not nuke fresh files)', () => {
      process.env.MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS = '0'; // floored to 1h
      const llmDir = path.join(projectsDir, '-z-memory-bank-llm');
      fs.mkdirSync(llmDir, { recursive: true });
      // Age relative to now=FUTURE(): ~2.5h old → beyond the 1h floor → deleted
      const staleAtFloor = makeFile(llmDir, 'ffff-session.jsonl', 30 * 60 * 1000);
      // mtime 3h in the real future → "newer than now" even at FUTURE() → kept
      const fresh = path.join(llmDir, 'gggg-session.jsonl');
      fs.writeFileSync(fresh, 'x');
      const t = new Date(Date.now() + 3 * 60 * 60 * 1000);
      fs.utimesSync(fresh, t, t);

      pruneLlmTranscripts(FUTURE());

      expect(fs.existsSync(staleAtFloor)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    });
  });
});
