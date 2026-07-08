#!/usr/bin/env node

/**
 * Detached worker spawned by fact-consolidate-hook.js.
 * Runs LLM-based fact consolidation without blocking SessionStart.
 *
 * Environment:
 *   CWD                  - project path (canonical: absolute path)
 *   LAST_CONSOLIDATED_AT - last consolidation time (default: 24h ago)
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { consolidateAllPending } from '../dist/consolidator.js';
import { getIndexDir } from '../dist/paths.js';

// GLOBAL single-instance lock (NOT per-project): consolidation touches shared
// global-scope facts (getAllNewFactsSince spans every scope), so concurrent
// per-project workers would race on the same rows. One lock-holder processes
// the ENTIRE backlog in a single pass — every new fact once, one Haiku budget —
// so no project is starved and shared globals aren't reprocessed per project.
// This kills the flood: the SessionStart hook re-spawns this worker on every
// session with no lock (measured 14 orphaned ppid=1 workers at once, each
// spawning a headless Claude session per LLM call).
const LOCK = path.join(getIndexDir(), 'fact-consolidate.lock');
// Persisted progress cursor: without it, INDEPENDENT facts (which stay active)
// would re-consume the whole Haiku budget on the same oldest rows every run and
// never reach newer backlog. Each run resumes from the last fully-examined
// created_at.
const CURSOR = path.join(getIndexDir(), 'fact-consolidate-cursor.txt');

// Keyset cursor persisted as JSON { createdAt, id }.
function readCursor() {
  try {
    const c = JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
    if (c && typeof c.createdAt === 'string' && typeof c.id === 'string' && !Number.isNaN(Date.parse(c.createdAt))) {
      return { createdAt: c.createdAt, id: c.id };
    }
  } catch { /* absent/legacy/corrupt → start from the beginning */ }
  return null;
}

function writeCursor(cursor) {
  if (!cursor || typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string') return;
  try {
    const tmp = `${CURSOR}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cursor));
    fs.renameSync(tmp, CURSOR); // atomic
  } catch { /* best-effort */ }
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), 'fact-consolidate.log'), msg + '\n');
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

// Atomic exclusive create ('wx') + pid-liveness check so a stale lock from a
// killed worker is cleared and re-acquired.
function acquireLock() {
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

async function main() {
  if (!acquireLock()) {
    // Another consolidate worker already holds the GLOBAL lock — exit cleanly.
    // It processes the whole backlog (every scope/project), so nothing is lost;
    // this session's spawn simply steps aside instead of piling up.
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  // Resume from the persisted keyset cursor. Absent/legacy/corrupt cursor →
  // start from the BEGINNING (null) so no active fact is ever skipped — the
  // per-run Haiku budget only caps actual consolidation CALLS, and facts with
  // no similar candidate don't consume budget, so the whole backlog drains
  // across a few runs regardless of age. An explicit LAST_CONSOLIDATED_AT env
  // (manual/scoped runs) still seeds a starting timestamp.
  let since = readCursor();
  if (!since && process.env.LAST_CONSOLIDATED_AT) {
    since = { createdAt: process.env.LAST_CONSOLIDATED_AT, id: '' };
  }

  let db;
  try {
    db = initDatabase();
    // One pass over the backlog after the cursor: every new fact once, single
    // Haiku budget, then advance the cursor so the next run reaches newer rows.
    const result = await consolidateAllPending(db, since);
    writeCursor(result.cursor);
    if (result.haikuCalls > 0) {
      log(`worker: processed=${result.processed} haiku=${result.haikuCalls} merged=${result.merged} contradictions=${result.contradictions} evolutions=${result.evolutions} cursor=${JSON.stringify(result.cursor)}`);
    }
  } catch (error) {
    log(`worker: FATAL ${error instanceof Error ? error.message : error}`);
    process.exitCode = 0;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
