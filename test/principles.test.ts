import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { suppressConsole } from './test-utils.js';
import {
  addPrinciple,
  upsertPrinciple,
  listPrinciples,
  getActivePrinciples,
  getPrincipleBySlug,
  setPrincipleActive,
  activePrinciplesHash,
  recordPrincipleConflict,
  countActivePrincipleConflicts,
  listActivePrincipleConflicts,
  resolvePrincipleConflict,
  annotatePrincipleConflictsForFacts,
  formatPrincipleConflictSection,
} from '../src/principles.js';

suppressConsole();

function insertTestFact(
  db: Database.Database,
  id: string,
  fact: string,
  createdAt: string,
  category: string = 'decision',
): void {
  db.prepare(
    `INSERT INTO facts (id, fact, category, scope_type, scope_project, created_at, updated_at)
     VALUES (?, ?, ?, 'global', NULL, ?, ?)`,
  ).run(id, fact, category, createdAt, createdAt);
}

function setFactActive(db: Database.Database, id: string, active: boolean): void {
  db.prepare('UPDATE facts SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

describe('Principles registry', () => {
  let db: Database.Database;
  const testDir = path.join(os.tmpdir(), 'principles-test-' + Date.now());
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

  it('creates principles tables and the unique conflict-pair index', () => {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('principles','principle_conflicts','principle_check_state')`,
      )
      .all();
    expect(tables).toHaveLength(3);
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_principle_conflicts_pair'`)
      .all();
    expect(idx).toHaveLength(1);
  });

  it('adds and lists principles with normalization', () => {
    const p = addPrinciple(db, {
      slug: '  No-Merge-Without-Review ',
      statement: '  Review  없이   merge 금지  ',
      sourcePath: 'rules/review.md',
      layer: 'policy',
    });
    expect(p.slug).toBe('no-merge-without-review');
    expect(p.statement).toBe('Review 없이 merge 금지');
    expect(p.layer).toBe('policy');
    expect(listPrinciples(db)).toHaveLength(1);
    expect(getPrincipleBySlug(db, 'No-Merge-Without-Review')?.id).toBe(p.id);
  });

  it('rejects duplicate slug, bad slug, empty statement, bad layer', () => {
    addPrinciple(db, { slug: 'p1', statement: 's1' });
    expect(() => addPrinciple(db, { slug: 'p1', statement: 'other' })).toThrow(/already exists/);
    expect(() => addPrinciple(db, { slug: 'Bad Slug!', statement: 's' })).toThrow(/invalid principle slug/);
    expect(() => addPrinciple(db, { slug: 'p2', statement: '   ' })).toThrow(/non-empty/);
    expect(() =>
      addPrinciple(db, { slug: 'p3', statement: 's', layer: 'vibe' as never }),
    ).toThrow(/invalid principle layer/);
  });

  it('upsert inserts, updates, and reactivates', () => {
    expect(upsertPrinciple(db, { slug: 'p1', statement: 'v1' })).toBe('inserted');
    setPrincipleActive(db, 'p1', false);
    expect(upsertPrinciple(db, { slug: 'p1', statement: 'v2', layer: 'identity' })).toBe('updated');
    const p = getPrincipleBySlug(db, 'p1');
    expect(p?.statement).toBe('v2');
    expect(p?.layer).toBe('identity');
    expect(p?.is_active).toBe(1);
  });

  it('setPrincipleActive toggles and reports actual change', () => {
    addPrinciple(db, { slug: 'p1', statement: 's1' });
    expect(setPrincipleActive(db, 'p1', false)).toBe(true);
    expect(setPrincipleActive(db, 'p1', false)).toBe(false); // already inactive
    expect(getActivePrinciples(db)).toHaveLength(0);
    expect(setPrincipleActive(db, 'missing', true)).toBe(false);
  });

  it('activePrinciplesHash tracks the active statement set only', () => {
    addPrinciple(db, { slug: 'a', statement: 's-a' });
    addPrinciple(db, { slug: 'b', statement: 's-b' });
    const h1 = activePrinciplesHash(db);
    // Metadata churn (updated_at via toggle round-trip) must not move the hash.
    setPrincipleActive(db, 'a', false);
    setPrincipleActive(db, 'a', true);
    expect(activePrinciplesHash(db)).toBe(h1);
    // Statement change moves it.
    upsertPrinciple(db, { slug: 'a', statement: 's-a2' });
    const h2 = activePrinciplesHash(db);
    expect(h2).not.toBe(h1);
    // Deactivation moves it.
    setPrincipleActive(db, 'b', false);
    expect(activePrinciplesHash(db)).not.toBe(h2);
  });

  it('recordPrincipleConflict is idempotent on the (principle, fact) pair', () => {
    const p = addPrinciple(db, { slug: 'p1', statement: 's1' });
    insertTestFact(db, 'f1', 'some fact', '2026-01-01 00:00:00');
    expect(
      recordPrincipleConflict(db, { principleId: p.id, factId: 'f1', method: 'manual', confidence: 0.9 }),
    ).toBe('inserted');
    expect(
      recordPrincipleConflict(db, { principleId: p.id, factId: 'f1', method: 'llm', confidence: 0.8 }),
    ).toBe('exists');
    expect(countActivePrincipleConflicts(db)).toBe(1);
  });

  it('active count requires conflict, fact, and principle all active', () => {
    const p = addPrinciple(db, { slug: 'p1', statement: 's1' });
    insertTestFact(db, 'f1', 'some fact', '2026-01-01 00:00:00');
    recordPrincipleConflict(db, { principleId: p.id, factId: 'f1', method: 'manual' });
    expect(countActivePrincipleConflicts(db)).toBe(1);

    setFactActive(db, 'f1', false);
    expect(countActivePrincipleConflicts(db)).toBe(0);
    setFactActive(db, 'f1', true);

    setPrincipleActive(db, 'p1', false);
    expect(countActivePrincipleConflicts(db)).toBe(0);
    setPrincipleActive(db, 'p1', true);
    expect(countActivePrincipleConflicts(db)).toBe(1);
  });

  it('resolve closes the conflict once and keeps the pair closed against re-detection', () => {
    const p = addPrinciple(db, { slug: 'p1', statement: 's1' });
    insertTestFact(db, 'f1', 'some fact', '2026-01-01 00:00:00');
    recordPrincipleConflict(db, { principleId: p.id, factId: 'f1', method: 'llm', confidence: 0.9 });
    const conflict = listActivePrincipleConflicts(db)[0];

    expect(resolvePrincipleConflict(db, conflict.conflictId, 'false_positive')).toBe(true);
    expect(resolvePrincipleConflict(db, conflict.conflictId, 'acknowledged')).toBe(false); // already closed
    expect(() => resolvePrincipleConflict(db, conflict.conflictId, 'nope' as never)).toThrow(/invalid resolution/);
    expect(countActivePrincipleConflicts(db)).toBe(0);

    // Re-detection of a human-resolved pair must NOT re-open it.
    expect(
      recordPrincipleConflict(db, { principleId: p.id, factId: 'f1', method: 'llm', confidence: 0.95 }),
    ).toBe('exists');
    expect(countActivePrincipleConflicts(db)).toBe(0);

    const row = db
      .prepare('SELECT resolution, resolved_at, is_active FROM principle_conflicts WHERE id = ?')
      .get(conflict.conflictId) as { resolution: string; resolved_at: string | null; is_active: number };
    expect(row.resolution).toBe('false_positive');
    expect(row.resolved_at).not.toBeNull();
    expect(row.is_active).toBe(0);
  });

  it('annotates only conflicted fact ids (display-only map)', () => {
    const p = addPrinciple(db, { slug: 'p1', statement: 'the rule' });
    insertTestFact(db, 'f1', 'conflicted fact', '2026-01-01 00:00:00');
    insertTestFact(db, 'f2', 'clean fact', '2026-01-02 00:00:00');
    recordPrincipleConflict(db, { principleId: p.id, factId: 'f1', method: 'manual' });

    const map = annotatePrincipleConflictsForFacts(db, ['f1', 'f2']);
    expect(map.size).toBe(1);
    expect(map.get('f1')).toEqual([{ slug: 'p1', statement: 'the rule', layer: 'principle' }]);
    expect(map.get('f2')).toBeUndefined();
    expect(annotatePrincipleConflictsForFacts(db, []).size).toBe(0);

    // Inactive principle disappears from annotations too.
    setPrincipleActive(db, 'p1', false);
    expect(annotatePrincipleConflictsForFacts(db, ['f1']).size).toBe(0);
  });

  it('formats the report section only when there is something to show', () => {
    expect(formatPrincipleConflictSection(0, [])).toBe('');
    const p = addPrinciple(db, { slug: 'p1', statement: 'the rule statement' });
    insertTestFact(db, 'f1', 'a fact that violates the rule', '2026-01-01 00:00:00');
    recordPrincipleConflict(db, { principleId: p.id, factId: 'f1', method: 'llm', confidence: 0.88 });
    const conflicts = listActivePrincipleConflicts(db);
    const section = formatPrincipleConflictSection(5, conflicts);
    expect(section).toContain('Active principle conflicts (5)');
    expect(section).toContain('[principle] p1');
    expect(section).toContain('violates the rule');
    expect(section).toContain('showing 1 of 5');
  });
});
