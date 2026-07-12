#!/usr/bin/env node
/**
 * Migrate the fact-side vec0 tables (vec_facts / vec_facts_kr / vec_categories)
 * from float32 to int8 — the same quantization the exchanges index got in
 * migrate-vec-int8.mjs (4× smaller scan, ~2× faster KNN, no measured recall
 * loss; distances come back ×127-scaled and every reader already normalizes
 * via getVecTableDtype()/normalizeVecDistance()).
 *
 * These tables are small (measured: 25K / 7K / 4.5K rows), so each table swaps
 * in ONE BEGIN IMMEDIATE transaction — read float32 rows, drop, recreate int8,
 * insert quantized. Well under the ~50K-rows-per-tx vec0 bookkeeping limit
 * observed on bulk DELETEs; a crash leaves either the old float32 table or the
 * completed int8 table (dtype is derived from sqlite_master, never a flag).
 *
 * Refuses to run while the reembed worker is alive (it writes these tables),
 * and takes the same migration lock as the exchanges migration so the two
 * can't interleave.
 *
 * Usage: node scripts/migrate-vec-facts-int8.mjs [--db /path/to/db.sqlite] [--dry-run]
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddingToVecBlob } from '../dist/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const TABLES = ['vec_facts', 'vec_facts_kr', 'vec_categories'];

// Delegate to the canonical quantizer (VEC_INT8_SCALE, single source of truth
// in src/db.ts). A hardcoded copy here would silently corrupt the vector space
// if the live-insert scale is ever tuned — the migration would re-quantize on a
// different scale than every subsequent write.
const quant = (f32) => embeddingToVecBlob(Array.from(f32), 'int8');

function pidAlive(lockPath) {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, 'utf-8'), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { getIndexDir } = await import(path.join(REPO, 'dist/paths.js'));
  const dbArg = process.argv.indexOf('--db');
  const dbPath = dbArg > -1 ? process.argv[dbArg + 1]
    : process.env.MEMORY_BANK_DB_PATH || path.join(getIndexDir(), 'db.sqlite');
  const dryRun = process.argv.includes('--dry-run');

  const REEMBED_LOCK = path.join(getIndexDir(), 'reembed.lock');
  const LOCK = path.join(getIndexDir(), 'migrate-vec-int8.lock');
  if (pidAlive(REEMBED_LOCK)) throw new Error('reembed-worker is running — stop it before migrating');
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    if (pidAlive(LOCK)) throw new Error('another migration is running');
    fs.unlinkSync(LOCK);
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  }
  process.on('exit', () => {
    try { if (parseInt(fs.readFileSync(LOCK, 'utf8'), 10) === process.pid) fs.unlinkSync(LOCK); } catch { /* ignore */ }
  });

  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma('busy_timeout = 15000');
  console.log('db:', dbPath);

  try {
    for (const table of TABLES) {
      const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!ddl?.sql) { console.log(`${table}: absent — skip`); continue; }
      if (/int8\s*\[/i.test(ddl.sql)) { console.log(`${table}: already int8 — skip`); continue; }
      const n = db.prepare(`SELECT count(*) AS n FROM ${table}_rowids`).get().n;
      console.log(`${table}: ${n} float32 rows`);
      if (dryRun) continue;

      db.exec('BEGIN IMMEDIATE');
      try {
        // Read every row into memory first (small tables), then swap.
        const rows = db.prepare(`SELECT id, embedding FROM ${table}`).all()
          .map((r) => [r.id, quant(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 384))]);
        if (rows.length !== n) throw new Error(`${table}: read ${rows.length}/${n} rows`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(id TEXT PRIMARY KEY, embedding int8[384])`);
        const ins = db.prepare(`INSERT INTO ${table} (id, embedding) VALUES (?, vec_int8(?))`);
        for (const [id, buf] of rows) ins.run(id, buf);
        const after = db.prepare(`SELECT count(*) AS n FROM ${table}_rowids`).get().n;
        if (after !== n) throw new Error(`${table}: count mismatch after swap ${after}/${n}`);
        db.exec('COMMIT');
        console.log(`${table}: ✅ ${after} rows → int8`);
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    console.log('done.');
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
