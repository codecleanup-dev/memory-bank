#!/usr/bin/env node

/**
 * Ontology classification backfill (detached, resumable).
 *
 * classifyAndLinkFact normally runs at insert time, but historic facts
 * (batch-extracted or imported) were saved without classification. This
 * worker classifies every active fact whose ontology_category_id is NULL.
 * The NULL column doubles as the resume marker, so the worker can be killed
 * and relaunched at any time.
 *
 * Usage: node scripts/backfill-ontology-worker.js [--max N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { backfillClassifyBatch, parkExhaustedFacts, MAX_CLASSIFY_ATTEMPTS } from '../dist/ontology-classifier.js';
import { getIndexDir } from '../dist/paths.js';

const maxArg = process.argv.indexOf('--max');
// Per-run cap (env-overridable). Bounded by DEFAULT — NOT Infinity — so a single
// run (including a detached run whose session has ended) can never flood the LLM
// proxy: it processes at most this many facts, then exits cleanly. The
// SessionStart hook re-spawns to drain the rest across sessions (resumable via
// the NULL ontology_category_id marker). Garbage --max/env values must not
// silently fall back to unbounded, so validate to a finite non-negative integer.
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
const MAX_FACTS = maxArg > -1
  ? boundedInt(process.argv[maxArg + 1], 200, 1000)
  : boundedInt(process.env.BACKFILL_ONTOLOGY_MAX, 200, 1000);
// Strict + clamped to [1, 8]: BACKFILL_CONCURRENCY=0/'abc'/'-1' must not yield
// zero workers (silent no-op) or overspawn. With batching, CONCURRENCY is the
// number of batch LLM calls in flight (= concurrent headless spawns).
const CONCURRENCY = Math.max(1, boundedInt(process.env.BACKFILL_CONCURRENCY, 4, 8));
// Facts per LLM call. One callHaiku() = one headless Claude spawn (~10-14s +
// transcript + auxiliary calls), so per-fact single calls made the drain
// dominate the proxy; batching divides spawn count by BATCH_SIZE.
const BATCH_SIZE = Math.max(1, boundedInt(process.env.BACKFILL_BATCH_SIZE, 20, 50));
// Relation detection costs extra LLM calls per fact; the historic corpus
// already carries ~29K relations and new-fact inserts keep detecting them,
// so backfill defaults to classification only. Explicit opt-in via env.
const DETECT_RELATIONS = process.env.BACKFILL_RELATIONS === '1';

const LOCK = path.join(getIndexDir(), 'backfill-ontology.lock');
const LOG = path.join(getIndexDir(), 'backfill-ontology.log');

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

async function main() {
  if (!acquireLock()) {
    console.log('backfill-ontology: another worker is running, exiting');
    process.exit(0);
  }
  process.on('exit', releaseLock);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  let db;
  try {
    db = initDatabase();
    // Self-heal ledger orphans first: a crash between the MAXth attempt
    // increment and the fallback write leaves attempts>=MAX with a NULL
    // category — excluded from selection below yet never parked.
    const orphansParked = parkExhaustedFacts(db);
    if (orphansParked > 0) log(`backfill-ontology: parked ${orphansParked} ledger orphan(s) into fallback`);

    // Attempt ledger filter: facts that already burned MAX_CLASSIFY_ATTEMPTS
    // are parked in General/Misc by the classifier and never re-selected —
    // without this, one permanently-failing fact wastes an LLM call in every
    // run forever (COALESCE guards rows predating the migration).
    const pending = db.prepare(`
      SELECT id FROM facts
      WHERE is_active = 1 AND ontology_category_id IS NULL
        AND COALESCE(ontology_attempts, 0) < ?
      ORDER BY consolidated_count DESC, created_at DESC
      LIMIT ?
    `).all(MAX_CLASSIFY_ATTEMPTS, MAX_FACTS);
    log(`backfill-ontology: ${pending.length} facts this run (batch ${BATCH_SIZE}, concurrency ${CONCURRENCY}, relations ${DETECT_RELATIONS ? 'on' : 'off'})`);

    // Chunk into batches — each batch is ONE LLM call (one headless spawn).
    const batches = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      batches.push(pending.slice(i, i + BATCH_SIZE).map((row) => row.id));
    }

    const totals = { classified: 0, deterministic: 0, fallback: 0, failed: 0, transient: 0, processed: 0 };
    const queue = [...batches];
    // Circuit breaker: transient failures burn no attempts (by design), so a
    // dead proxy/SDK would otherwise let every run re-spawn batch after batch
    // of doomed calls — a slow-motion flood, every SessionStart. After this
    // many consecutive all-transient batches the run aborts; the facts stay
    // NULL + attempts-untouched and drain resumes when the LLM path is back.
    // Threshold ≥ CONCURRENCY+1: with N workers, N batches can be in flight
    // when transients start landing — requiring a full wave plus one to be
    // all-transient prevents a late-completing successful batch from being
    // pre-empted by 3 fast failures (the residual race is benign: facts are
    // preserved untouched and the next run resumes).
    const TRANSIENT_TRIP = Math.max(3, CONCURRENCY + 1);
    let consecutiveTransient = 0;
    let circuitOpen = false;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0 && !circuitOpen) {
        const batch = queue.shift();
        if (!batch) break;
        try {
          const stats = await backfillClassifyBatch(db, batch, { detectRelationsToo: DETECT_RELATIONS });
          totals.classified += stats.classified;
          totals.deterministic += stats.deterministic;
          totals.fallback += stats.fallback;
          totals.failed += stats.failed;
          totals.transient += stats.transient;
          const anyProgress = stats.classified + stats.deterministic + stats.fallback + stats.failed > 0;
          consecutiveTransient = !anyProgress && stats.transient > 0 ? consecutiveTransient + 1 : 0;
        } catch (error) {
          // Unexpected (non-LLM) error: facts stay NULL with attempts
          // untouched → re-selected next run. Transient LLM failures are
          // already ledger-exempt inside classifyFactsBatch.
          totals.transient += batch.length;
          consecutiveTransient += 1;
          log(`batch of ${batch.length}: ERROR ${error instanceof Error ? error.message : error}`);
        }
        totals.processed += batch.length;
        if (consecutiveTransient >= TRANSIENT_TRIP && !circuitOpen) {
          circuitOpen = true;
          log(`circuit breaker OPEN: ${consecutiveTransient} consecutive all-transient batches — aborting run (${queue.length} batches unprocessed, resume next run)`);
          queue.length = 0;
        }
        log(`progress: ${totals.processed}/${pending.length} (llm ${totals.classified}, deterministic ${totals.deterministic}, fallback ${totals.fallback}, failed ${totals.failed}, transient ${totals.transient})`);
      }
    });
    await Promise.all(workers);
    log(`backfill-ontology: done this run (llm ${totals.classified}, deterministic ${totals.deterministic}, fallback ${totals.fallback}, failed ${totals.failed}, transient ${totals.transient})`);
  } catch (error) {
    log(`backfill-ontology: FATAL ${error instanceof Error ? error.message : error}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
