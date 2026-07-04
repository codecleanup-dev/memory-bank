import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
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
  writeFileSync(path.join(getIndexDir(), 'exclude.txt'), '-x-secret-proj\n');

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

it('skips codex rollouts that cd into an excluded project mid-session (privacy: no archive copy)', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'codex-excl-mid-'));
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = path.join(dir, 'archive');

  const { syncConversations } = await import('../src/sync.js');
  const { getIndexDir } = await import('../src/paths.js');
  const { initDatabase } = await import('../src/db.js');

  mkdirSync(getIndexDir(), { recursive: true });
  writeFileSync(path.join(getIndexDir(), 'exclude.txt'), '-x-secret-proj\n');

  // Rollout starts in an allowed project, then cd's into an excluded one.
  // The first-cwd-only guard would let this through and copy/summarize the
  // excluded content; the whole file must be skipped (no archive copy either).
  const src = path.join(dir, 'codex');
  mkdirSync(path.join(src, '2026', '06', '22'), { recursive: true });
  const rel = path.join('2026', '06', '22', 'rollout.jsonl');
  writeFileSync(path.join(src, rel),
    JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/x/allowed-proj' } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } }) + '\n' +
    JSON.stringify({ type: 'turn_context', payload: { cwd: '/x/secret-proj' } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'secret data' }] } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }) + '\n');

  await syncConversations(src, process.env.TEST_ARCHIVE_DIR!, { codingAgent: 'codex', recursive: true, skipSummaries: true });

  // No exchange indexed AND the raw file was never copied into the archive.
  const db = initDatabase();
  const n = (db.prepare('SELECT count(*) c FROM exchanges').get() as any).c;
  db.close();
  expect(n).toBe(0);
  expect(existsSync(path.join(process.env.TEST_ARCHIVE_DIR!, rel))).toBe(false);
}, 60000);

it('skips codex rollouts that cd into an excluded project after a long allowed prefix (beyond any window)', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'codex-excl-long-'));
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = path.join(dir, 'archive');

  const { syncConversations } = await import('../src/sync.js');
  const { getIndexDir } = await import('../src/paths.js');
  const { initDatabase } = await import('../src/db.js');

  mkdirSync(getIndexDir(), { recursive: true });
  writeFileSync(path.join(getIndexDir(), 'exclude.txt'), '-x-secret-proj\n');

  // 60 allowed lines (well past any bounded scan window), THEN cd into the
  // excluded project. A windowed sniff would miss this and copy the raw file
  // — including post-cd secret content — into the archive, reachable via `read`.
  const src = path.join(dir, 'codex');
  mkdirSync(path.join(src, '2026', '06', '22'), { recursive: true });
  const rel = path.join('2026', '06', '22', 'rollout.jsonl');
  let content = JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/x/allowed-proj' } }) + '\n';
  for (let i = 0; i < 60; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const ct = i % 2 === 0 ? 'input_text' : 'output_text';
    content += JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: ct, text: `allowed line ${i}` }] } }) + '\n';
  }
  content += JSON.stringify({ type: 'turn_context', payload: { cwd: '/x/secret-proj' } }) + '\n';
  content += JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'secret data' }] } }) + '\n';
  content += JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }) + '\n';
  writeFileSync(path.join(src, rel), content);

  await syncConversations(src, process.env.TEST_ARCHIVE_DIR!, { codingAgent: 'codex', recursive: true, skipSummaries: true });

  // Whole file skipped: nothing indexed AND no raw archive copy on disk.
  const db = initDatabase();
  const n = (db.prepare('SELECT count(*) c FROM exchanges').get() as any).c;
  db.close();
  expect(n).toBe(0);
  expect(existsSync(path.join(process.env.TEST_ARCHIVE_DIR!, rel))).toBe(false);
}, 60000);

it('excludes codex rollouts by the canonical encoded cwd including dots (not basename)', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'codex-excl-dot-'));
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = path.join(dir, 'archive');

  const { syncConversations } = await import('../src/sync.js');
  const { getIndexDir } = await import('../src/paths.js');
  const { initDatabase } = await import('../src/db.js');

  mkdirSync(getIndexDir(), { recursive: true });
  // cwd /x/my.proj → canonical key "-x-my-proj" (both '.' and '/' → '-'), the
  // same form the non-codex projects dir uses. The basename "my.proj" would NOT
  // match this entry, so this pins the exact encoding, not a slash-only mangle.
  writeFileSync(path.join(getIndexDir(), 'exclude.txt'), '-x-my-proj\n');

  const src = path.join(dir, 'codex');
  mkdirSync(path.join(src, '2026', '06', '22'), { recursive: true });
  const rel = path.join('2026', '06', '22', 'rollout.jsonl');
  writeFileSync(path.join(src, rel),
    JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/x/my.proj' } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'secret' }] } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }) + '\n');

  await syncConversations(src, process.env.TEST_ARCHIVE_DIR!, { codingAgent: 'codex', recursive: true, skipSummaries: true });

  const db = initDatabase();
  const n = (db.prepare('SELECT count(*) c FROM exchanges').get() as any).c;
  db.close();
  expect(n).toBe(0);
  expect(existsSync(path.join(process.env.TEST_ARCHIVE_DIR!, rel))).toBe(false);
}, 60000);

it('normalizes a trailing slash in codex cwd before matching the exclude key', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'codex-excl-slash-'));
  process.env.MEMORY_BANK_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.TEST_DB_PATH = path.join(dir, 'db.sqlite');
  process.env.TEST_ARCHIVE_DIR = path.join(dir, 'archive');

  const { syncConversations } = await import('../src/sync.js');
  const { getIndexDir } = await import('../src/paths.js');
  const { initDatabase } = await import('../src/db.js');

  mkdirSync(getIndexDir(), { recursive: true });
  writeFileSync(path.join(getIndexDir(), 'exclude.txt'), '-x-secret-proj\n');

  const src = path.join(dir, 'codex');
  mkdirSync(path.join(src, '2026', '06', '22'), { recursive: true });
  const rel = path.join('2026', '06', '22', 'rollout.jsonl');
  // A trailing slash on the recorded cwd must not defeat the exclude entry:
  // /x/secret-proj/ and /x/secret-proj resolve to the same canonical key.
  writeFileSync(path.join(src, rel),
    JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd: '/x/secret-proj/' } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'secret' }] } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }) + '\n');

  await syncConversations(src, process.env.TEST_ARCHIVE_DIR!, { codingAgent: 'codex', recursive: true, skipSummaries: true });

  const db = initDatabase();
  const n = (db.prepare('SELECT count(*) c FROM exchanges').get() as any).c;
  db.close();
  expect(n).toBe(0);
  expect(existsSync(path.join(process.env.TEST_ARCHIVE_DIR!, rel))).toBe(false);
}, 60000);
