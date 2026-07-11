#!/usr/bin/env node
/**
 * UserPromptSubmit context injection — thin client.
 *
 * Fast path: connect to the warm inject daemon (a unix-socket sidecar inside
 * any running MCP server, which already has the embedding model loaded) and
 * get the context back in ~150ms. Cold fallback: compute locally exactly as
 * before (~2.3s, dominated by model load) when no daemon answers — first
 * session start, daemon disabled, or any socket hiccup.
 *
 * Input (either):
 *   stdin JSON  { "prompt": "...", "cwd": "..." }   ← Claude Code hook contract
 *   env         USER_PROMPT / CWD                   ← manual invocation
 *
 * IMPORTANT: keep the import list here LIGHT — the fast path must not pay for
 * better-sqlite3/transformers imports. Heavy modules load lazily only in the
 * fallback.
 */

import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOCKET_CONNECT_TIMEOUT_MS = 300;
const SOCKET_RESPONSE_TIMEOUT_MS = 3000;

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function injectSocketPath() {
  // Mirrors paths.ts getIndexDir() without importing the heavy dist chain.
  const base = process.env.MEMORY_BANK_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'superpowers');
  return path.join(base, 'conversation-index', 'inject-daemon.sock');
}

/** Ask the warm daemon; resolve null (not reject) on ANY failure so the caller
 * falls back — the hook must never break a user prompt. */
function askDaemon(prompt, cwd) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let conn;
    try {
      conn = net.connect(injectSocketPath());
    } catch {
      return done(null);
    }
    const connectTimer = setTimeout(() => { conn.destroy(); done(null); }, SOCKET_CONNECT_TIMEOUT_MS);
    conn.on('connect', () => {
      clearTimeout(connectTimer);
      conn.setTimeout(SOCKET_RESPONSE_TIMEOUT_MS, () => { conn.destroy(); done(null); });
      conn.write(JSON.stringify({ prompt, cwd }) + '\n');
      let buf = '';
      conn.on('data', (c) => {
        buf += c.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        try {
          const res = JSON.parse(buf.slice(0, nl));
          done(res && res.ok ? String(res.context ?? '') : null);
        } catch {
          done(null);
        }
        conn.destroy();
      });
    });
    conn.on('error', () => { clearTimeout(connectTimer); done(null); });
  });
}

async function main() {
  // Parse hook input: stdin JSON first, env fallback (manual runs).
  const raw = await readStdin();
  let prompt = '';
  let cwd = '';
  if (raw) {
    try {
      const j = JSON.parse(raw);
      prompt = String(j.prompt ?? '');
      cwd = String(j.cwd ?? '');
    } catch {
      prompt = raw; // plain-text stdin = the prompt itself
    }
  }
  if (!prompt) prompt = process.env.USER_PROMPT || '';
  if (!cwd) cwd = process.env.CWD || process.cwd();

  if (!prompt || prompt.length < 20) return; // not worth an injection

  // FAST PATH — warm daemon inside a running MCP server.
  const daemonContext = await askDaemon(prompt, cwd);
  if (daemonContext !== null) {
    if (daemonContext) process.stdout.write(daemonContext + '\n');
    return;
  }

  // COLD FALLBACK — compute locally (heavy imports load only here).
  try {
    const { computeInjectContext } = await import(path.join(__dirname, '../dist/inject-core.js'));
    const context = await computeInjectContext(prompt, cwd, 'fallback');
    if (context) process.stdout.write(context + '\n');
  } catch (error) {
    process.stderr.write(`inject-context: error: ${error instanceof Error ? error.message : error}\n`);
  }
}

main();
