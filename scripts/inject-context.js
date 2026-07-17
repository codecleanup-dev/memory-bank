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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Self-heal missing runtime deps (better-sqlite3 등 native 모듈).
 *
 * 왜: (a) `claude plugin update` 가 npm install 을 비결정적으로 누락한다
 * (실측: 1.4.0 캐시엔 node_modules 생성, 1.4.1 캐시엔 미생성 → 콜드 경로
 * 전체가 Cannot find package 로 사망). (b) cc-sync 는 node_modules 를
 * 제외하고 plugins/cache 를 타 머신에 실어 나르므로, 동기화로 받은 캐시는
 * 항상 deps 가 없다. 두 경우 모두 첫 프롬프트에서 감지해 1회 한정으로
 * detached npm install 을 시도한다 (marker 파일 'wx' 원자 생성으로 중복
 * 방지 — 실패해도 다음 설치 디렉토리에서만 재시도, 무한 루프 없음).
 */
function selfHealDeps(pluginRoot) {
  const marker = path.join(pluginRoot, '.deps-heal-attempted');
  // [fork] 마커는 "성공 증거"가 아니라 "최근 시도 기록"이다. 영구 1회 게이트로
  // 두면 일시 실패(레지스트리 장애, npm 비정상 종료)가 재시도를 영원히 막아
  // 콜드 주입이 조용히 계속 죽는다 (적대 리뷰 발견, 2026-07-17). 24h TTL 로
  // 만료시켜 "하루 최대 1회 시도"로 완화 — npm 폭주 방지는 유지된다.
  const RETRY_TTL_MS = 24 * 60 * 60 * 1000;
  try {
    if (Date.now() - fs.statSync(marker).mtimeMs < RETRY_TTL_MS) return false; // 최근 시도됨
    fs.rmSync(marker, { force: true }); // 만료 — 재시도 허용
  } catch { /* 마커 없음 — 첫 시도 */ }
  try {
    fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx' }); // 원자적 시도 게이트
  } catch {
    return false; // 동시 프로세스가 방금 시도 시작
  }
  try {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: pluginRoot, detached: true, stdio: 'ignore',
    });
    // detached 라 exit code 는 못 보지만 spawn 자체 실패(ENOENT 등)는 잡힌다 —
    // 마커를 지워 다음 콜드 경로가 TTL 대기 없이 재시도할 수 있게 한다.
    child.on('error', () => { try { fs.rmSync(marker, { force: true }); } catch { /* best-effort */ } });
    child.unref();
    process.stderr.write('inject-context: missing deps detected — spawned background npm install (once per 24h)\n');
    return true;
  } catch (e) {
    try { fs.rmSync(marker, { force: true }); } catch { /* best-effort */ }
    process.stderr.write(`inject-context: self-heal spawn failed: ${e && e.message}\n`);
    return false;
  }
}

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

/** Ask the warm daemon. Resolves to:
 *  - { status: 'ok', context }   — daemon answered
 *  - { status: 'no-daemon' }     — could not connect (no MCP server serving)
 *  - { status: 'gave-up' }       — connected but slow/declined/failed mid-request
 * [fork] The caller cold-falls-back ONLY on 'no-daemon'. A connected-but-slow
 * daemon is still doing the work — piling a cold model load in this process on
 * top of the in-flight daemon computation is pure amplification (adversarial-
 * review find, 2026-07-12). Giving up injection for one prompt is the cheaper
 * failure. Never rejects — the hook must never break a user prompt.
 * sessionId rides along for the daemon's session dedup ledger (inject v2). */
function askDaemon(prompt, cwd, sessionId) {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    // [fork] Distinguish "no daemon" from "daemon saturated": when the server
    // hits maxConnections, connects are refused/queued while the socket FILE
    // still exists — falling back cold there would stampede model loads while
    // the daemon is busiest. Socket file present -> failures mean 'gave-up'
    // (skip this injection); file absent -> genuinely no daemon -> cold path.
    let sockExists = false;
    try { sockExists = fs.existsSync(injectSocketPath()); } catch { /* treat as absent */ }
    const failStatus = () => ({ status: (connected || sockExists) ? 'gave-up' : 'no-daemon' });
    let conn;
    try {
      conn = net.connect(injectSocketPath());
    } catch {
      return done(failStatus());
    }
    const connectTimer = setTimeout(() => { conn.destroy(); done(failStatus()); }, SOCKET_CONNECT_TIMEOUT_MS);
    conn.on('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      conn.setTimeout(SOCKET_RESPONSE_TIMEOUT_MS, () => { conn.destroy(); done({ status: 'gave-up' }); });
      conn.write(JSON.stringify({ prompt, cwd, session_id: sessionId }) + '\n');
      let buf = '';
      conn.on('data', (c) => {
        buf += c.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        try {
          const res = JSON.parse(buf.slice(0, nl));
          if (res && res.ok) done({ status: 'ok', context: String(res.context ?? '') });
          else done({ status: 'gave-up' }); // daemon alive but declined (over cap / error)
        } catch {
          done({ status: 'gave-up' });
        }
        conn.destroy();
      });
    });
    conn.on('error', () => {
      clearTimeout(connectTimer);
      done(failStatus());
    });
  });
}

async function main() {
  // Parse hook input: stdin JSON first, env fallback (manual runs).
  const raw = await readStdin();
  let prompt = '';
  let cwd = '';
  let sessionId = '';
  if (raw) {
    try {
      const j = JSON.parse(raw);
      prompt = String(j.prompt ?? '');
      cwd = String(j.cwd ?? '');
      sessionId = String(j.session_id ?? ''); // 세션 dedup 원장 키 (hook stdin 계약)
    } catch {
      prompt = raw; // plain-text stdin = the prompt itself
    }
  }
  if (!prompt) prompt = process.env.USER_PROMPT || '';
  if (!cwd) cwd = process.env.CWD || process.cwd();
  if (!sessionId) sessionId = process.env.SESSION_ID || '';

  if (!prompt || prompt.length < 20) return; // not worth an injection

  // FAST PATH — warm daemon inside a running MCP server.
  const daemonRes = await askDaemon(prompt, cwd, sessionId);
  if (daemonRes.status === 'ok') {
    if (daemonRes.context) process.stdout.write(daemonRes.context + '\n');
    return;
  }
  // Daemon exists but was slow or declined: its computation may still be
  // running — do NOT stack a cold model load on top. Skip this injection.
  if (daemonRes.status === 'gave-up') return;

  // COLD FALLBACK — compute locally (heavy imports load only here).
  try {
    const { computeInjectContextDeferred } = await import(path.join(__dirname, '../dist/inject-core.js'));
    const r = await computeInjectContextDeferred(prompt, cwd, 'fallback', sessionId || undefined);
    if (r.block) {
      process.stdout.write(r.block + '\n');
      // [fork] stdout 기록(=훅으로 전달) 후에만 원장 커밋 — 데몬 경로와 동일 계약
      r.commitLedger();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`inject-context: error: ${msg}\n`);
    // deps 누락(plugin update 미설치 / cc-sync 로 받은 캐시)이면 1회 자가치유
    if (/Cannot find (package|module)|ERR_MODULE_NOT_FOUND/.test(msg)) {
      selfHealDeps(path.join(__dirname, '..'));
    }
  }
}

main();
