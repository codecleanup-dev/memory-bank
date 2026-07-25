import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { suppressConsole } from './test-utils.js';
import {
  computeSurprise,
  getActiveFacts,
  insertFact,
  runSurpriseBackfill,
} from '../src/fact-db.js';
import { surpriseWeight } from '../src/inject-core.js';

suppressConsole();

/** Deterministic 384-dim one-hot vectors: identical → similarity 1, distinct → 0. */
function oneHot(index: number): number[] {
  const v = new Array(384).fill(0);
  v[index % 384] = 1;
  return v;
}

function insertWithVec(db: Database.Database, fact: string, vecIndex: number, surprise?: number | null): string {
  return insertFact(db, {
    fact,
    category: 'decision',
    scope_type: 'global',
    scope_project: null,
    source_exchange_ids: [],
    embedding: oneHot(vecIndex),
    surprise,
  });
}

describe('E2 surprise', () => {
  let db: Database.Database;
  const testDir = path.join(os.tmpdir(), 'surprise-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('adds the surprise column (additive migration)', () => {
    const cols = db.prepare(`SELECT name FROM pragma_table_info('facts')`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'surprise')).toBe(true);
  });

  it('returns 1 on an empty corpus and null without an embedding', () => {
    expect(computeSurprise(db, oneHot(0))).toBe(1);
    expect(computeSurprise(db, null)).toBeNull();
    expect(computeSurprise(db, [])).toBeNull();
  });

  it('scores a duplicate ~0 and an orthogonal fact ~1', () => {
    insertWithVec(db, 'existing fact', 0);
    const dup = computeSurprise(db, oneHot(0));
    const novel = computeSurprise(db, oneHot(1));
    expect(dup).not.toBeNull();
    expect(dup as number).toBeLessThan(0.05);
    expect(novel).not.toBeNull();
    expect(novel as number).toBeGreaterThan(0.95);
  });

  it('excludeFactId prevents self-match on already-indexed facts', () => {
    const id = insertWithVec(db, 'only fact', 0);
    // Without exclusion the fact matches itself → surprise ~0.
    expect(computeSurprise(db, oneHot(0)) as number).toBeLessThan(0.05);
    // Excluding self leaves an empty corpus → maximally novel.
    expect(computeSurprise(db, oneHot(0), null, id)).toBe(1);
  });

  it('insertFact persists a clamped surprise and rowToFact round-trips it', () => {
    insertWithVec(db, 'fact a', 0, 0.42);
    insertWithVec(db, 'fact b', 1, 1.7); // clamp → 1
    const facts = getActiveFacts(db);
    const byText = new Map(facts.map((f) => [f.fact, f.surprise]));
    expect(byText.get('fact a')).toBe(0.42);
    expect(byText.get('fact b')).toBe(1);
  });

  it('backfill measures NULL rows via self-excluding KNN and reports the distribution', () => {
    const a = insertWithVec(db, 'dup one', 0);
    const b = insertWithVec(db, 'dup two', 0);
    const c = insertWithVec(db, 'loner', 1);
    db.prepare('UPDATE facts SET surprise = NULL').run();

    const result = runSurpriseBackfill(db, 100);
    expect(result.scanned).toBe(3);
    expect(result.updated).toBe(3);
    expect(result.remaining).toBe(0);

    const rows = new Map(
      (db.prepare('SELECT id, surprise FROM facts').all() as Array<{ id: string; surprise: number }>).map(
        (r) => [r.id, r.surprise],
      ),
    );
    expect(rows.get(a) as number).toBeLessThan(0.05); // twin b exists
    expect(rows.get(b) as number).toBeLessThan(0.05);
    expect(rows.get(c) as number).toBeGreaterThan(0.95); // orthogonal to both
    expect(result.distribution).not.toBeNull();
    expect(result.distribution?.count).toBe(3);

    // Second run: the NULL predicate is its own cursor — nothing left to scan.
    const again = runSurpriseBackfill(db, 100);
    expect(again.scanned).toBe(0);
  });

  it('backfill leaves embedding-less rows honestly unmeasured without looping', () => {
    db.prepare(
      `INSERT INTO facts (id, fact, category, scope_type, scope_project, created_at, updated_at)
       VALUES ('no-emb', 'imported without vector', 'knowledge', 'global', NULL, '2026-01-01', '2026-01-01')`,
    ).run();
    const result = runSurpriseBackfill(db, 100);
    expect(result.scanned).toBe(0);
    expect(result.unmeasurable).toBe(1);
    const row = db.prepare(`SELECT surprise FROM facts WHERE id = 'no-emb'`).get() as { surprise: number | null };
    expect(row.surprise).toBeNull();
  });

  it('surpriseWeight parses the env flag with a hard-off default and clamping', () => {
    expect(surpriseWeight({})).toBe(0);
    expect(surpriseWeight({ MEMORY_BANK_INJECT_SURPRISE_WEIGHT: '0.3' })).toBe(0.3);
    expect(surpriseWeight({ MEMORY_BANK_INJECT_SURPRISE_WEIGHT: '7' })).toBe(1);
    expect(surpriseWeight({ MEMORY_BANK_INJECT_SURPRISE_WEIGHT: '-1' })).toBe(0);
    expect(surpriseWeight({ MEMORY_BANK_INJECT_SURPRISE_WEIGHT: 'nope' })).toBe(0);
  });
});
