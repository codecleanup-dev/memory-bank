import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Fork×upstream seam: upstream's worker-prompt guard (isWorkerPromptMessage,
// v1.3.4) was written for the Claude discovery path; the codex discovery path
// is fork-only code. Upstream will never test that the guard fires for
// exchanges produced by the codex parser — this test pins that seam so a
// future merge can't silently route codex exchanges around the guard.

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.TEST_DB_PATH;
  delete process.env.TEST_ARCHIVE_DIR;
});

it('drops worker-prompt exchanges on the codex path, keeps real ones', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'codex-worker-'));
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = path.join(dir, 'archive');

  const { syncConversations } = await import('../src/sync.js');
  const { initDatabase } = await import('../src/db.js');
  const { WORKER_PROMPT_PREFIXES } = await import('../src/paths.js');

  // One rollout in an allowed project: a real exchange plus one exchange per
  // canonical worker-prompt prefix (ephemeral state, never knowledge).
  const src = path.join(dir, 'codex');
  mkdirSync(path.join(src, '2026', '07', '11'), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/x/allowed-proj' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'real question about the build' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'real answer' }] } }),
  ];
  for (const prefix of WORKER_PROMPT_PREFIXES) {
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${prefix} Facts: ...` }] } }));
    lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'NO_INSIGHTS_FOUND' }] } }));
  }
  writeFileSync(path.join(src, '2026', '07', '11', 'rollout.jsonl'), lines.join('\n') + '\n');

  await syncConversations(src, process.env.TEST_ARCHIVE_DIR!, { codingAgent: 'codex', recursive: true, skipSummaries: true });

  const db = initDatabase();
  const rows = db.prepare('SELECT user_message FROM exchanges').all() as { user_message: string }[];
  db.close();

  // Exactly the real exchange survives; every worker-prompt exchange is dropped.
  expect(rows.length).toBe(1);
  expect(rows[0].user_message).toContain('real question');
}, 60000);
