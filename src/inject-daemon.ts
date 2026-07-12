import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { getIndexDir } from './paths.js';
import { computeInjectContext } from './inject-core.js';
import { initEmbeddings } from './embeddings.js';

/**
 * Warm inject daemon — a unix-socket sidecar inside the long-lived MCP server.
 *
 * Why: the UserPromptSubmit hook pays ~2.3s PER PROMPT as a cold node process
 * (measured: model load 1,130ms + node startup ~400ms + imports 186ms dominate;
 * the actual search is ~30ms). Every Claude session already runs an MCP server
 * with the embedding model warm — this sidecar lets the hook reuse it: the hook
 * connects, sends the prompt, and gets the context back in ~150ms warm.
 *
 * Lifecycle safety (this plugin's orphan-flood history makes this explicit):
 *  - The daemon lives INSIDE the MCP server process — no new detached process,
 *    no new lifecycle to leak. server.unref() so it never keeps the process
 *    alive on its own; it dies exactly when the MCP server dies.
 *  - Only ONE server binds the socket. EADDRINUSE → probe the existing socket:
 *    alive → this server simply doesn't serve (another session's MCP server
 *    does); dead (stale file after SIGKILL) → unlink and bind.
 *  - Socket mode 600 — same-user only; the payload is the user's own prompt.
 *  - Requests are line-delimited JSON; a malformed request gets {ok:false} and
 *    never throws into the MCP server.
 */

export function injectSocketPath(): string {
  return path.join(getIndexDir(), 'inject-daemon.sock');
}

export function startInjectDaemon(): void {
  const sockPath = injectSocketPath();

  // [fork] Global in-flight cap: each request runs an embedding+search on the
  // MCP server's thread pool; unbounded concurrent connections would let one
  // runaway same-user client degrade every session. Over the cap we answer
  // {ok:false} immediately — the thin client cold-falls-back in its own
  // process, so the MCP server itself stays responsive.
  const MAX_INFLIGHT = 4;
  let inflight = 0;

  const server = net.createServer((conn) => {
    let buf = '';
    // [fork] one request per connection, enforced: without this, any data
    // arriving after the first newline re-finds the SAME newline and re-runs
    // the full embedding+search computation — a same-user client that dribbles
    // bytes after its request line turns one prompt into N computations
    // (adversarial-review find, 2026-07-12).
    let handled = false;
    conn.setTimeout(10_000, () => conn.destroy());
    conn.on('error', () => { /* client vanished — fine */ });
    conn.on('data', (chunk) => {
      if (handled) return; // request already consumed — protocol is 1 line per conn
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) {
        if (buf.length > 1_000_000) conn.destroy(); // absurd request — drop
        return;
      }
      handled = true;
      const line = buf.slice(0, nl);
      if (inflight >= MAX_INFLIGHT) {
        try { conn.end(JSON.stringify({ ok: false }) + '\n'); } catch { /* gone */ }
        return;
      }
      inflight++;
      void (async () => {
        try {
          const req = JSON.parse(line) as { prompt?: string; cwd?: string };
          const context = await computeInjectContext(
            String(req.prompt ?? ''),
            String(req.cwd ?? process.cwd()),
            'daemon',
          );
          conn.end(JSON.stringify({ ok: true, context }) + '\n');
        } catch {
          try { conn.end(JSON.stringify({ ok: false }) + '\n'); } catch { /* gone */ }
        } finally {
          inflight--;
        }
      })();
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') return; // best-effort sidecar — never crash the MCP server
    // Another bind exists: live server (skip) or stale socket file (reclaim).
    const probe = net.connect(sockPath);
    probe.setTimeout(500, () => probe.destroy());
    probe.on('connect', () => probe.destroy()); // live — another session serves
    probe.on('error', () => {
      try {
        fs.unlinkSync(sockPath);
        server.listen(sockPath, onListen);
      } catch { /* raced another reclaimer — fine */ }
    });
  });

  const onListen = () => {
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best-effort */ }
    // Pre-warm the embedding model so even the FIRST prompt after session
    // start gets the fast path (load happens once, off the request path).
    void initEmbeddings().catch(() => { /* first request will retry */ });
  };

  try {
    // [fork] Close the bind→chmod race at the directory level: listen()
    // creates the socket with umask-derived perms for a moment before the
    // 0600 chmod lands. The index dir also holds the private conversation DB
    // (found live at 0755 dir / 0644 db — world-readable), so 0700 here is
    // the real boundary: no traversal for other users means neither the
    // pre-chmod socket nor the DB is reachable during (or after) the window.
    try { fs.chmodSync(getIndexDir(), 0o700); } catch { /* best-effort */ }
    server.listen(sockPath, onListen);
    server.unref();
  } catch { /* sidecar is best-effort */ }
}
