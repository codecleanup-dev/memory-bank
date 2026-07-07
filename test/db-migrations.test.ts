import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

describe('facts.category vocabulary migration', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-migration-test-'));
    dbPath = path.join(testDir, 'test.db');
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** Pre-CHECK schema as shipped before this migration, with live-data junk. */
  function createLegacyDb(): void {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        fact TEXT NOT NULL,
        category TEXT,
        scope_type TEXT NOT NULL DEFAULT 'project',
        scope_project TEXT,
        source_exchange_ids TEXT,
        embedding BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        consolidated_count INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 1
      )
    `);
    const ins = raw.prepare(
      `INSERT INTO facts (id, fact, category, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    );
    ins.run('f-req', 'needs auth header', 'requirement');
    ins.run('f-echo', 'enum echo row', 'decision|preference|pattern|knowledge|constraint');
    ins.run('f-null', 'null category row', null);
    ins.run('f-ok', 'valid row', 'decision');
    raw.close();
  }

  it('rebuilds legacy tables: junk normalized, CHECK + NOT NULL added, data intact', () => {
    createLegacyDb();

    const db = initDatabase();
    try {
      const sql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'`).get() as { sql: string }
      ).sql;
      expect(sql).toMatch(/CHECK\s*\(\s*category\s+IN/i);

      const byId = new Map(
        (db.prepare('SELECT id, category FROM facts').all() as Array<{ id: string; category: string }>).map(
          (r) => [r.id, r.category],
        ),
      );
      expect(byId.get('f-req')).toBe('constraint');
      expect(byId.get('f-echo')).toBe('decision');
      expect(byId.get('f-null')).toBe('knowledge');
      expect(byId.get('f-ok')).toBe('decision');

      expect(() =>
        db
          .prepare(
            `INSERT INTO facts (id, fact, category, created_at, updated_at) VALUES ('x', 'x', 'junk', datetime('now'), datetime('now'))`,
          )
          .run(),
      ).toThrow();

      // Indexes recreated after the rebuild
      const indexes = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='facts'`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(indexes).toContain('idx_facts_category');
      expect(indexes).toContain('idx_facts_scope');
    } finally {
      db.close();
    }

    // Idempotent: a second init must not rebuild again or lose rows
    const db2 = initDatabase();
    try {
      const count = (db2.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n;
      expect(count).toBe(4);
    } finally {
      db2.close();
    }
  });

  it('fresh DBs enforce the CHECK from creation and insertFact normalizes junk', () => {
    const db = initDatabase();
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO facts (id, fact, category, created_at, updated_at) VALUES ('x', 'x', 'requirement', datetime('now'), datetime('now'))`,
          )
          .run(),
      ).toThrow(); // raw junk is blocked at the DB layer...

      const id = insertFact(db, {
        fact: 'llm returned an out-of-vocabulary category',
        category: 'requirement', // ...but the write path maps it deterministically
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: [],
        embedding: null,
      });
      const row = db.prepare('SELECT category FROM facts WHERE id = ?').get(id) as { category: string };
      expect(row.category).toBe('constraint');
    } finally {
      db.close();
    }
  });
});
