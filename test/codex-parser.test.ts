import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseConversation } from '../src/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'codex-rollout.jsonl');

describe('Codex rollout parsing', () => {
  it('parses a codex rollout into exchanges with coding_agent=codex', async () => {
    const exchanges = await parseConversation(FIXTURE, 'fallback-project', FIXTURE);
    expect(exchanges.length).toBe(1);
    const ex = exchanges[0];
    expect(ex.userMessage).toBe('list the files please');
    expect(ex.assistantMessage).toContain('Here are the files');
    expect(ex.codingAgent).toBe('codex');
    expect(ex.project).toBe('proj');            // derived from cwd basename
    expect(ex.sessionId).toBe('sess-abc');
    expect(ex.gitBranch).toBe('main');
    expect(ex.toolCalls?.length).toBe(1);
    expect(ex.toolCalls?.[0].toolName).toBe('shell');
    expect(ex.toolCalls?.[0].toolResult).toContain('file1.ts');
  });

  it('still routes Claude transcripts to the Claude parser', async () => {
    // A Claude-format line (type:'user'/'assistant' with message) must NOT be
    // treated as codex.
    const claudeFixture = path.join(__dirname, 'fixtures', 'codex-negative.jsonl');
    const { writeFileSync, mkdirSync, rmSync } = await import('fs');
    mkdirSync(path.dirname(claudeFixture), { recursive: true });
    writeFileSync(claudeFixture,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi claude' }, timestamp: '2026-07-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, timestamp: '2026-07-01T00:00:01Z' }) + '\n');
    const exchanges = await parseConversation(claudeFixture, 'p', claudeFixture);
    rmSync(claudeFixture);
    expect(exchanges.length).toBe(1);
    expect(exchanges[0].codingAgent).toBeUndefined();  // claude path leaves it unset
  });
});
