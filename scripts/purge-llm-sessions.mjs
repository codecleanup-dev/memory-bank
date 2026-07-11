#!/usr/bin/env node

/**
 * One-time cleanup for exchanges indexed from LLM worker sessions BEFORE the
 * v1.3.3 exclusion (`isExcludedProject`) existed. v1.3.3 stops NEW pollution
 * (indexing/sync/verify all skip `*-memory-bank-llm` slugs) and keeps old rows
 * out of fact extraction — but rows indexed earlier remain in the exchanges
 * table, the FTS index, and the vec_exchanges vector index, actively polluting
 * both text and semantic search. This script removes them.
 *
 * TWO pollution families (both pre-v1.3.3 legacies):
 *   1. SLUG family (default): project slug ends with `-memory-bank-llm` —
 *      worker sessions after the fixed-workdir change but before indexing
 *      exclusion. Measured locally: 14,287 exchanges.
 *   2. LEGACY-PROMPT family (--legacy-prompts): worker sessions from BEFORE
 *      the fixed workdir existed — the Agent SDK query() ran with the CALLER
 *      project's cwd, so their transcripts were indexed under REAL project
 *      slugs and cannot be identified by slug at all. Identified instead by
 *      the exact leading text of the worker system prompts (versioned in
 *      src/). Measured locally: 59,940 exchanges (~16% of the corpus) across
 *      fact-extract / ontology-classify / relation-detect / consolidation.
 *
 * Safety model:
 *   - DRY-RUN BY DEFAULT: prints what would be deleted. Pass --apply to mutate.
 *   - BACKUP FIRST: on --apply, the polluted exchanges + tool_calls rows are
 *     copied into a timestamped sqlite file next to the index DB before any
 *     delete runs (verified row-for-row before the first delete). Embeddings
 *     are not backed up — regenerable from the exchange text.
 *   - Slug discriminator matches v1.3.3 isExcludedProject exactly (slug ending
 *     `-memory-bank-llm`). Prompt discriminators are exact multi-word template
 *     leads (≥49 chars) — a real human message starting with the verbatim
 *     template text is vanishingly rare, and the backup covers even that.
 *   - All deletes run in a single transaction; tool_calls are deleted
 *     explicitly (the FK is ON DELETE CASCADE but that only fires when
 *     PRAGMA foreign_keys is ON, which we don't assume).
 *
 * Usage:
 *   node scripts/purge-llm-sessions.mjs                            # dry-run, slug family
 *   node scripts/purge-llm-sessions.mjs --apply                    # backup + delete, slug family
 *   node scripts/purge-llm-sessions.mjs --legacy-prompts           # dry-run, BOTH families
 *   node scripts/purge-llm-sessions.mjs --legacy-prompts --apply   # backup + delete, BOTH families
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { getIndexDir } from '../dist/paths.js';
import { buildPollutionWhere } from '../dist/pollution-predicate.js';



const apply = process.argv.includes('--apply');
const legacyPrompts = process.argv.includes('--legacy-prompts');

function main() {
  const db = initDatabase();
  try {
    // Build the pollution predicate once (shared src helper, canonical prefixes);
    // every count / backup / delete below uses the SAME (where, params) so they
    // can never diverge.
    const { where, params } = buildPollutionWhere({ legacyPrompts });

    const counts = {
      exchanges: db.prepare(`SELECT count(*) AS n FROM exchanges WHERE ${where}`).get(...params).n,
      toolCalls: db.prepare(
        `SELECT count(*) AS n FROM tool_calls WHERE exchange_id IN (SELECT id FROM exchanges WHERE ${where})`
      ).get(...params).n,
      vectors: db.prepare(
        `SELECT count(*) AS n FROM vec_exchanges_rowids WHERE id IN (SELECT id FROM exchanges WHERE ${where})`
      ).get(...params).n,
    };

    console.log(`families: slug${legacyPrompts ? ' + legacy-prompts' : ''}`);
    console.log(`polluted exchanges: ${counts.exchanges}`);
    console.log(`polluted tool_calls: ${counts.toolCalls}`);
    console.log(`polluted vectors:    ${counts.vectors}`);

    if (counts.exchanges === 0 && counts.vectors === 0) {
      console.log('nothing to purge — index is clean.');
      return;
    }
    if (!apply) {
      console.log('\nDRY-RUN (no changes made). Re-run with --apply to backup + delete.');
      return;
    }

    // --- Backup first (reversibility): copy full rows into a timestamped DB.
    // Its own IMMEDIATE transaction (write lock up front — a deferred BEGIN
    // would start as a reader and the later lock upgrade dies with
    // SQLITE_BUSY_SNAPSHOT whenever a concurrent worker commits in between). ---
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(getIndexDir(), `purge-llm-backup-${ts}.sqlite`);
    // Refuse to overwrite an existing backup file (should be impossible with the
    // timestamp, but never clobber).
    if (fs.existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
    db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS bak`);
    let ids;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`CREATE TABLE bak.exchanges AS SELECT * FROM exchanges WHERE ${where}`).run(...params);
        db.prepare(
          `CREATE TABLE bak.tool_calls AS SELECT * FROM tool_calls WHERE exchange_id IN (SELECT id FROM exchanges WHERE ${where})`
        ).run(...params);
        // The id worklist is captured in the SAME transaction as the backup so
        // the two can never diverge; deletes below run off this exact list.
        ids = db.prepare(`SELECT id FROM exchanges WHERE ${where}`).all(...params).map((r) => r.id);
        // Verify the backup captured every row BEFORE any delete runs.
        const bakEx = db.prepare('SELECT count(*) AS n FROM bak.exchanges').get().n;
        const bakTc = db.prepare('SELECT count(*) AS n FROM bak.tool_calls').get().n;
        if (bakEx !== ids.length || bakTc !== counts.toolCalls) {
          throw new Error(`backup row mismatch: exchanges ${bakEx}/${ids.length}, tool_calls ${bakTc}/${counts.toolCalls}`);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        // A failed run must not leave a half-written backup that a later retry
        // would refuse to overwrite — remove it (the main DB is untouched).
        try { fs.unlinkSync(backupPath); } catch { /* best-effort */ }
        throw e;
      }
    } finally {
      try { db.exec('DETACH DATABASE bak'); } catch { /* already detached on error paths */ }
    }

    // --- Delete in BATCHED transactions (2K ids each). One giant transaction
    // deleting 50K+ vec0 rows trips SQLITE_CORRUPT_VTAB in the extension's
    // chunk bookkeeping (observed live at ~54K); small batches are safe. A
    // crash between batches leaves a partial purge — harmless: the run is
    // idempotent (predicate-driven) and the NEXT run resumes where this one
    // stopped, while the up-front backup already holds every row.
    // Order inside a batch: vec rows (per-id — vec0 takes no subqueries),
    // tool_calls, then exchanges (FTS triggers keep exchanges_fts in sync).
    const BATCH = 2000;
    const delVec = db.prepare('DELETE FROM vec_exchanges WHERE id = ?');
    const delTc = db.prepare('DELETE FROM tool_calls WHERE exchange_id = ?');
    const delEx = db.prepare('DELETE FROM exchanges WHERE id = ?');
    const delBatch = db.transaction((chunk) => {
      for (const id of chunk) { delVec.run(id); delTc.run(id); delEx.run(id); }
    });
    let deleted = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      delBatch.immediate(ids.slice(i, i + BATCH));
      deleted += Math.min(BATCH, ids.length - i);
      if (deleted % 10000 < BATCH) console.log(`  deleted ${deleted}/${ids.length}`);
    }

    // --- Post-verify: everything gone ---
    const left = {
      exchanges: db.prepare(`SELECT count(*) AS n FROM exchanges WHERE ${where}`).get(...params).n,
      vectors: db.prepare(
        `SELECT count(*) AS n FROM vec_exchanges_rowids WHERE id IN (SELECT id FROM exchanges WHERE ${where})`
      ).get(...params).n,
    };
    console.log(`\npurged. remaining polluted exchanges: ${left.exchanges}, vectors: ${left.vectors}`);
    console.log(`backup: ${backupPath}`);
    if (left.exchanges !== 0 || left.vectors !== 0) {
      process.exitCode = 1;
      console.error('WARNING: purge incomplete — inspect manually.');
    }
  } finally {
    db.close();
  }
}

main();
