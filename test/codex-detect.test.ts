import { describe, it, expect } from 'vitest';
import { parseConversation } from '../src/parser.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('harness detection robustness', () => {
  it('detects codex even when the first line is not a marker (multi-line scan)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codex-detect-'));
    const f = path.join(dir, 'rollout.jsonl');
    // First non-empty line matches NEITHER shape (drift/preamble); real codex
    // response_items follow. Must still classify as codex, not silently drop.
    writeFileSync(f,
      JSON.stringify({ type: 'unknown_preamble', foo: 1 }) + '\n' +
      JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }) + '\n' +
      JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] } }) + '\n');
    const ex = await parseConversation(f, 'p', f);
    rmSync(dir, { recursive: true, force: true });
    expect(ex.length).toBe(1);
    expect(ex[0].codingAgent).toBe('codex');
    expect(ex[0].userMessage).toBe('hi');
  });
});
