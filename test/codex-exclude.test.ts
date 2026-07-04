import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.MEMORY_BANK_CONFIG_DIR;
  delete process.env.TEST_DB_PATH;
  delete process.env.TEST_ARCHIVE_DIR;
});

it('does not index codex rollouts whose cwd project is excluded (privacy)', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'codex-excl-'));
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = path.join(dir, 'archive');

  const { syncConversations } = await import('../src/sync.js');
  const { getIndexDir } = await import('../src/paths.js');
  const { initDatabase } = await import('../src/db.js');

  mkdirSync(getIndexDir(), { recursive: true });
  writeFileSync(path.join(getIndexDir(), 'exclude.txt'), 'secret-proj\n');

  const src = path.join(dir, 'codex');
  mkdirSync(path.join(src, '2026', '06', '22'), { recursive: true });
  writeFileSync(path.join(src, '2026', '06', '22', 'rollout.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/x/secret-proj' } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'secret' }] } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }) + '\n');

  await syncConversations(src, process.env.TEST_ARCHIVE_DIR!, { codingAgent: 'codex', recursive: true, skipSummaries: true });
  const db = initDatabase();
  const n = (db.prepare('SELECT count(*) c FROM exchanges').get() as any).c;
  db.close();
  expect(n).toBe(0);
}, 60000);
