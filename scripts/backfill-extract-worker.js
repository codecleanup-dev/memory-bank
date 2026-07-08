#!/usr/bin/env node

/**
 * Cross-project fact-extraction backfill (detached, resumable).
 *
 * The SessionEnd hook only covers sessions that end while the fixed hook is
 * installed — every earlier session (all projects) was never extracted. This
 * worker walks ALL unprocessed sessions, newest first, runs the same
 * extraction pipeline, and records each session in extraction_log so work is
 * idempotent and resumable.
 *
 * Seed step: sessions that already produced facts (via source_exchange_ids)
 * are pre-marked as processed so they are not re-extracted into duplicates.
 *
 * Usage: node scripts/backfill-extract-worker.js [--max N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { runFactExtraction } from '../dist/fact-extractor.js';
import { canonicalizeProject } from '../dist/project-canon.js';
import { getIndexDir } from '../dist/paths.js';

const maxArg = process.argv.indexOf('--max');
// Per-run cap (env-overridable). Bounded by DEFAULT — NOT Infinity — so a single
// run (including a detached run whose session has ended) can never flood the LLM
// proxy: it processes at most this many sessions, then exits cleanly. The
// SessionStart hook re-spawns to drain the rest across sessions (resumable via
// extraction_log). Garbage --max/env values must not silently fall back to
// unbounded, so validate to a finite non-negative integer.
// (def, cap): validate to a finite non-negative int, then clamp to an absolute
// per-run ceiling so NO invocation path — explicit --max, hook-inherited env, or
// default — can exceed `cap` and flood the proxy.
function boundedInt(raw, def, cap) {
  // Strict: only an all-digits string is a valid override; malformed input
  // ('', '1e9', '200.9', '999abc', undefined) falls back to the default rather
  // than being partially parsed by parseInt. Then clamp to the absolute ceiling.
  const s = raw == null ? '' : String(raw);
  const v = /^\d+$/.test(s) ? parseInt(s, 10) : def;
  return Math.min(v, cap);
}
const MAX_SESSIONS = maxArg > -1
  ? boundedInt(process.argv[maxArg + 1], 40, 200)
  : boundedInt(process.env.BACKFILL_EXTRACT_MAX, 40, 200);
// Strict + clamped to [1, 8]: BACKFILL_CONCURRENCY=0/'abc'/'-1' must not yield
// zero workers (silent no-op) or overspawn.
const CONCURRENCY = Math.max(1, boundedInt(process.env.BACKFILL_CONCURRENCY, 4, 8));

// Exclude self-referential repo conversations (memory-bank's own monitoring /
// cron sessions). These are ~98% 1-exchange noise that the backfill itself
// generates, so including them is a feedback loop that never converges.
// Comma-separated cwd paths; env-overridable.
const EXCLUDE_PROJECTS = (
  process.env.BACKFILL_EXCLUDE_PROJECTS ||
  '/Users/jung-wankim/Project/Claude/memory-bank'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Minimum exchanges per session to be worth extracting. 1-exchange sessions are
// overwhelmingly automated-worker/monitoring noise (bs-auto-issue, cron checks)
// that yield no durable facts and never converge. Default 2; set to 1 to include
// single-turn sessions. boundedInt (not bare parseInt): the value is
// interpolated into SQL, so 'abc' → NaN must not reach the query text.
const MIN_EXCHANGES = boundedInt(process.env.BACKFILL_MIN_EXCHANGES, 2, 1000);

const LOCK = path.join(getIndexDir(), 'backfill-extract.lock');
const LOG = path.join(getIndexDir(), 'backfill-extract.log');

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try { fs.appendFileSync(LOG, msg + '\n'); } catch { /* best-effort */ }
  console.log(msg);
}

function acquireLock() {
  // Atomic exclusive create ('wx') — a read-then-write check is racy when two
  // SessionStart hooks spawn workers simultaneously.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        const pid = parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
        if (pid && !Number.isNaN(pid)) {
          try { process.kill(pid, 0); return false; } // alive → don't run
          catch { /* stale lock */ }
        }
        fs.unlinkSync(LOCK); // stale — remove and retry the exclusive create
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK);
  } catch { /* ignore */ }
}

/** Pre-mark sessions that already yielded facts (historic batch runs). */
function seedFromExistingFacts(db) {
  const facts = db.prepare(
    "SELECT source_exchange_ids FROM facts WHERE source_exchange_ids IS NOT NULL AND source_exchange_ids != '[]'"
  ).all();
  const exchangeIds = new Set();
  for (const f of facts) {
    try { for (const id of JSON.parse(f.source_exchange_ids)) exchangeIds.add(id); }
    catch { /* skip malformed */ }
  }
  if (exchangeIds.size === 0) return 0;

  const sessionStmt = db.prepare('SELECT session_id FROM exchanges WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO extraction_log (session_id, processed_at, extracted, saved)
    VALUES (?, ?, -1, -1)
  `);
  const now = new Date().toISOString();
  let seeded = 0;
  const tx = db.transaction(() => {
    const seen = new Set();
    for (const exId of exchangeIds) {
      const row = sessionStmt.get(exId);
      const sid = row?.session_id;
      if (sid && !seen.has(sid)) {
        seen.add(sid);
        if (insertStmt.run(sid, now).changes > 0) seeded++;
      }
    }
  });
  tx();
  return seeded;
}

function pendingSessions(db, limit) {
  // Content-rich sessions first (more exchanges → more extractable facts),
  // then recency. 1-exchange sessions are processed last.
  // Excluded projects (e.g. memory-bank's own monitoring sessions) are dropped
  // entirely to break the self-referential feedback loop.
  // Built-in: the plugin's own headless LLM worker sessions (llm.ts spawns
  // them with cwd <tmpdir>/memory-bank-llm). Indexing now skips them at the
  // source (paths.ts isExcludedProject), but exchanges indexed before that
  // fix — 6.4k rows observed 2026-07-08 — must not become extraction
  // candidates (defense in depth against the self-referential loop).
  const exTerms = EXCLUDE_PROJECTS;
  // x.session_id IS NOT NULL is load-bearing: a single NULL inside a NOT IN
  // subquery makes the whole predicate NULL (3-valued logic) → zero pending
  // sessions → silent drain of the entire backfill.
  const exClause = `AND e.session_id NOT IN (
         SELECT DISTINCT x.session_id FROM exchanges x
         WHERE x.session_id IS NOT NULL
           AND (x.cwd LIKE '%/memory-bank-llm'
         ${exTerms.length ? 'OR ' + exTerms.map(() => 'x.cwd = ?').join(' OR ') : ''})
       )`;
  return db.prepare(`
    SELECT e.session_id AS sid, MAX(e.timestamp) AS ts, COUNT(*) AS n
    FROM exchanges e
    WHERE e.is_sidechain = 0 AND e.session_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM extraction_log l WHERE l.session_id = e.session_id)
      ${exClause}
    GROUP BY e.session_id
    HAVING COUNT(*) >= ${MIN_EXCHANGES}
    ORDER BY ts DESC
    LIMIT ?
  `).all(...exTerms, limit);
}

/** Simple concurrency pool — LLM latency dominates, DB writes are sync-safe. */
async function runPool(items, concurrency, fn) {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await fn(item);
    }
  });
  await Promise.all(workers);
}

function sessionProject(db, sid) {
  const byCwd = db.prepare(`
    SELECT cwd, COUNT(*) AS n FROM exchanges
    WHERE session_id = ? AND cwd IS NOT NULL
    GROUP BY cwd ORDER BY n DESC LIMIT 1
  `).get(sid);
  if (byCwd?.cwd) return byCwd.cwd;
  const bySlug = db.prepare(
    'SELECT project FROM exchanges WHERE session_id = ? LIMIT 1'
  ).get(sid);
  return bySlug ? canonicalizeProject(db, bySlug.project) : null;
}

async function main() {
  if (!acquireLock()) {
    console.log('backfill-extract: another worker is running, exiting');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  let db;
  try {
    db = initDatabase();

    const seeded = seedFromExistingFacts(db);
    if (seeded) log(`seed: marked ${seeded} already-extracted sessions`);

    const sessions = pendingSessions(db, MAX_SESSIONS);
    log(`backfill-extract: ${sessions.length} sessions this run (concurrency ${CONCURRENCY})`);

    let done = 0, totalSaved = 0;
    await runPool(sessions, CONCURRENCY, async (next) => {
      const project = sessionProject(db, next.sid);
      try {
        const result = await runFactExtraction(db, next.sid, project ?? 'unknown');
        totalSaved += result.saved;
        if (result.saved > 0) {
          log(`session ${next.sid} (${project ?? '?'}, ${next.n} exch): saved ${result.saved}`);
        }
      } catch (error) {
        // record failure so the loop cannot spin on one bad session
        log(`session ${next.sid}: ERROR ${error instanceof Error ? error.message : error}`);
        try {
          db.prepare(`
            INSERT OR IGNORE INTO extraction_log (session_id, processed_at, extracted, saved)
            VALUES (?, ?, -2, 0)
          `).run(next.sid, new Date().toISOString());
        } catch { /* ignore */ }
      }
      done++;
      if (done % 25 === 0) log(`progress: ${done}/${sessions.length} sessions, facts saved ${totalSaved}`);
    });
    log(`backfill-extract: done this run (sessions ${done}, facts saved ${totalSaved})`);
  } catch (error) {
    log(`backfill-extract: FATAL ${error instanceof Error ? error.message : error}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
