import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase } from '../src/db.js';
import { insertFact, searchSimilarFacts } from '../src/fact-db.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

describe('fact confidence persistence', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-confidence-test-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function insert(confidence: unknown): string {
    const db = initDatabase();
    try {
      return insertFact(db, {
        fact: `fact with confidence ${String(confidence)}`,
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: [],
        embedding: null,
        confidence: confidence as number | null | undefined,
      });
    } finally {
      db.close();
    }
  }

  function readConfidence(id: string): number | null {
    const db = initDatabase();
    try {
      const row = db.prepare('SELECT confidence FROM facts WHERE id = ?').get(id) as {
        confidence: number | null;
      };
      return row.confidence;
    } finally {
      db.close();
    }
  }

  it('persists a valid confidence', () => {
    expect(readConfidence(insert(0.87))).toBe(0.87);
  });

  it('stores NULL when confidence is absent', () => {
    expect(readConfidence(insert(undefined))).toBeNull();
  });

  it('clamps out-of-range values and rejects non-numbers', () => {
    expect(readConfidence(insert(1.7))).toBe(1);
    expect(readConfidence(insert(-0.2))).toBe(0);
    expect(readConfidence(insert(Number.NaN))).toBeNull();
    expect(readConfidence(insert('0.9'))).toBeNull();
  });

  it('exposes confidence on search results via rowToFact', () => {
    const db = initDatabase();
    try {
      const embedding = new Array(384).fill(0.05);
      insertFact(db, {
        fact: 'confidence surfaces in vector search results',
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: [],
        embedding,
        confidence: 0.9,
      });
      const results = searchSimilarFacts(db, embedding, null, 5, 0.5);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].fact.confidence).toBe(0.9);
    } finally {
      db.close();
    }
  });

  it('adds the column to legacy DBs idempotently', () => {
    // First init creates + migrates; a second init must be a no-op.
    const db = initDatabase();
    db.close();
    const db2 = initDatabase();
    try {
      const cols = (
        db2.prepare(`SELECT name FROM pragma_table_info('facts')`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toContain('confidence');
    } finally {
      db2.close();
    }
  });
});
