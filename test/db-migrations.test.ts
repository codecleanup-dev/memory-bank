import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { deleteExchange, initDatabase, insertExchange } from '../src/db.js';
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

    // Child rows referencing facts — the production shape (8,948 relations,
    // 83 revisions). The facts rebuild must survive dropping a referenced
    // parent (better-sqlite3 enforces foreign_keys by default).
    // Shipped shape: FK clauses present — the rebuild must reproduce them.
    raw.exec(`
      CREATE TABLE ontology_relations (
        id TEXT PRIMARY KEY,
        source_fact_id TEXT NOT NULL REFERENCES facts(id),
        relation_type TEXT NOT NULL CHECK(relation_type IN ('INFLUENCES','SUPERSEDES','SUPPORTS','CONTRADICTS')),
        target_fact_id TEXT NOT NULL REFERENCES facts(id),
        reasoning TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    raw
      .prepare(
        `INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning) VALUES ('rel-legacy', 'f-ok', 'SUPPORTS', 'f-req', 'child row across the rebuild')`,
      )
      .run();

    // User-added artifacts hanging off facts — the rebuild must replay them,
    // not silently drop everything outside a hardcoded list.
    raw.exec(`CREATE INDEX idx_custom_created ON facts(created_at)`);
    raw.exec(`CREATE TRIGGER trg_facts_custom AFTER UPDATE ON facts BEGIN SELECT 1; END`);
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

      // Child rows survived the parent rebuild, and FK enforcement is back on
      const rel = db.prepare(`SELECT reasoning FROM ontology_relations WHERE id = 'rel-legacy'`).get() as {
        reasoning: string;
      };
      expect(rel.reasoning).toBe('child row across the rebuild');
      expect((db.pragma('foreign_keys', { simple: true }) as number)).toBe(1);

      // User-added index/trigger were captured and replayed across the rebuild
      expect(indexes).toContain('idx_custom_created');
      const triggers = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='facts'`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(triggers).toContain('trg_facts_custom');

      // Relations table (shipped shape) kept its FK clauses AND gained the vocabulary
      const relSql = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ontology_relations'`)
          .get() as { sql: string }
      ).sql;
      expect(relSql).toMatch(/REFERENCES\s+facts/i);
      expect(relSql).toContain("'DEPENDS_ON'");
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

  it('bails out (fail-safe) on exotic facts DDL it cannot reproduce, instead of dropping constraints', () => {
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE legacy_parent (id TEXT PRIMARY KEY)`);
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
        is_active INTEGER DEFAULT 1,
        custom_ref TEXT REFERENCES legacy_parent(id)
      )
    `);
    raw
      .prepare(
        `INSERT INTO facts (id, fact, category, created_at, updated_at) VALUES ('f-exotic', 'row on exotic schema', 'requirement', datetime('now'), datetime('now'))`,
      )
      .run();
    raw.close();

    const db = initDatabase(); // must not throw
    try {
      const sql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'`).get() as { sql: string }
      ).sql;
      expect(sql).toMatch(/REFERENCES/i); // custom constraint preserved…
      expect(sql).not.toMatch(/CHECK\s*\(\s*category\s+IN/i); // …at the cost of skipping the CHECK
      // Degraded mode is explicit: legacy junk stays, write path still normalizes
      const row = db.prepare(`SELECT category FROM facts WHERE id = 'f-exotic'`).get() as { category: string };
      expect(row.category).toBe('requirement');
    } finally {
      db.close();
    }
  });

  it('re-indexes an exchange that has tool_calls under FK enforcement (upsert, no parent delete)', () => {
    const db = initDatabase();
    try {
      const exchange = {
        id: 'ex-reindex',
        project: 'proj',
        timestamp: new Date().toISOString(),
        userMessage: 'first pass',
        assistantMessage: 'answer',
        archivePath: '/tmp/a.jsonl',
        lineStart: 1,
        lineEnd: 2,
        toolCalls: [
          {
            id: 'tc-1',
            exchangeId: 'ex-reindex',
            toolName: 'Bash',
            toolInput: { cmd: 'ls' },
            toolResult: 'ok',
            isError: false,
            timestamp: new Date().toISOString(),
          },
        ],
      };
      const embedding = new Array(384).fill(0.05);

      insertExchange(db, exchange, embedding);
      // Re-index the SAME id while a tool_calls child references it —
      // INSERT OR REPLACE would delete the parent and trip the FK.
      insertExchange(db, { ...exchange, userMessage: 'second pass' }, embedding);

      const row = db.prepare(`SELECT user_message FROM exchanges WHERE id = 'ex-reindex'`).get() as {
        user_message: string;
      };
      expect(row.user_message).toBe('second pass');
      const tc = db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE exchange_id = 'ex-reindex'`).get() as {
        n: number;
      };
      expect(tc.n).toBe(1);

      // The archive is the source of truth: a re-index with a DIFFERENT tool
      // call set must not leave stale children behind
      insertExchange(
        db,
        {
          ...exchange,
          toolCalls: [{ ...exchange.toolCalls![0], id: 'tc-2' }],
        },
        embedding,
      );
      const replaced = (
        db.prepare(`SELECT id FROM tool_calls WHERE exchange_id = 'ex-reindex'`).all() as Array<{ id: string }>
      ).map((r) => r.id);
      expect(replaced).toEqual(['tc-2']);

      insertExchange(db, { ...exchange, toolCalls: [] }, embedding);
      const cleared = db
        .prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE exchange_id = 'ex-reindex'`)
        .get() as { n: number };
      expect(cleared.n).toBe(0);

      // Deleting the exchange must clear its children first (FK is ON)
      deleteExchange(db, 'ex-reindex');
      const gone = db.prepare(`SELECT COUNT(*) AS n FROM exchanges WHERE id = 'ex-reindex'`).get() as {
        n: number;
      };
      expect(gone.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('bails out on legacy facts tables carrying custom UNIQUE constraints', () => {
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
        is_active INTEGER DEFAULT 1,
        UNIQUE (fact, scope_type)
      )
    `);
    raw.close();

    const db = initDatabase(); // must not throw
    try {
      const sql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'`).get() as { sql: string }
      ).sql;
      expect(sql).toMatch(/UNIQUE/i); // custom integrity constraint preserved…
      expect(sql).not.toMatch(/CHECK\s*\(\s*category\s+IN/i); // …by skipping the rebuild
    } finally {
      db.close();
    }
  });

  it('bails out on legacy relations tables carrying extra custom CHECKs', () => {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE ontology_relations (
        id TEXT PRIMARY KEY,
        source_fact_id TEXT NOT NULL,
        relation_type TEXT NOT NULL CHECK(relation_type IN ('INFLUENCES','SUPERSEDES','SUPPORTS','CONTRADICTS')),
        target_fact_id TEXT NOT NULL,
        reasoning TEXT CHECK(length(reasoning) < 500),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    raw.close();

    const db = initDatabase(); // must not throw
    try {
      const sql = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ontology_relations'`)
          .get() as { sql: string }
      ).sql;
      expect(sql).toContain('length(reasoning)'); // custom CHECK preserved…
      expect(sql).not.toContain("'DEPENDS_ON'"); // …by keeping the legacy vocabulary
    } finally {
      db.close();
    }
  });

  it('extends the ontology_relations CHECK to the new relation vocabulary', () => {
    // Legacy 4-type table with a row — PLUS a custom column with data and a
    // custom index on it: the generic rebuild must preserve all of it.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE ontology_relations (
        id TEXT PRIMARY KEY,
        source_fact_id TEXT NOT NULL,
        relation_type TEXT NOT NULL CHECK(relation_type IN ('INFLUENCES','SUPERSEDES','SUPPORTS','CONTRADICTS')),
        target_fact_id TEXT NOT NULL,
        reasoning TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        custom_provenance TEXT
      )
    `);
    raw.exec(`CREATE INDEX idx_custom_provenance ON ontology_relations(custom_provenance)`);
    raw
      .prepare(
        `INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, custom_provenance) VALUES ('r1', 'a', 'SUPPORTS', 'b', 'legacy row', 'hand-added')`,
      )
      .run();
    raw.close();

    const db = initDatabase();
    try {
      const sql = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ontology_relations'`)
          .get() as { sql: string }
      ).sql;
      expect(sql).toContain("'DEPENDS_ON'");
      expect(sql).toContain("'DERIVED_FROM'");
      // Mirror-what-exists: this legacy fixture declared NO foreign keys, so
      // the rebuild must not add constraints its rows never satisfied
      expect(sql).not.toMatch(/REFERENCES/i);

      const legacy = db
        .prepare(`SELECT reasoning, custom_provenance FROM ontology_relations WHERE id = 'r1'`)
        .get() as { reasoning: string; custom_provenance: string };
      expect(legacy.reasoning).toBe('legacy row');
      expect(legacy.custom_provenance).toBe('hand-added'); // custom column + data preserved

      const relIndexes = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ontology_relations'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(relIndexes).toContain('idx_custom_provenance'); // custom index replayed

      // New inserts run under FK enforcement — reference a real fact
      const factId = insertFact(db, {
        fact: 'anchor fact for relation inserts',
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: [],
        embedding: null,
      });

      db.prepare(
        `INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id) VALUES ('r2', ?, 'DEPENDS_ON', ?)`,
      ).run(factId, factId); // new type accepted after the rebuild

      expect(() =>
        db
          .prepare(
            `INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id) VALUES ('r3', ?, 'BOGUS', ?)`,
          )
          .run(factId, factId),
      ).toThrow();
    } finally {
      db.close();
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
