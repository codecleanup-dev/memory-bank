import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact, deactivateFact } from '../src/fact-db.js';
import { createDomain, createCategory, classifyFact, createRelation } from '../src/ontology-db.js';
import {
  formatConsistencyReport,
  getConsistencyCounts,
  hasActiveConflicts,
  listActiveConflicts,
} from '../src/consistency.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

function mkFact(db: Database.Database, text: string): string {
  return insertFact(db, {
    fact: text,
    category: 'decision',
    scope_type: 'global',
    scope_project: null,
    source_exchange_ids: [],
    embedding: null,
  });
}

describe('knowledge graph consistency', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-consistency-test-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('counts active-active conflict pairs and clears them on deactivation', () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'sessions use JWT tokens');
      const b = mkFact(db, 'sessions use server-side cookies');
      const c = mkFact(db, 'deploys run on Vercel');
      const d = mkFact(db, 'deploys run on bare EC2');
      createRelation(db, a, 'CONTRADICTS', b, 'auth storage conflict');
      createRelation(db, c, 'SUPERSEDES', d, 'moved off EC2');

      let counts = getConsistencyCounts(db);
      expect(counts.activeContradictsPairs).toBe(1);
      expect(counts.activeSupersedesPairs).toBe(1);
      expect(hasActiveConflicts(counts)).toBe(true);

      const pairs = listActiveConflicts(db, 'CONTRADICTS');
      expect(pairs).toHaveLength(1);
      expect(pairs[0].source.id).toBe(a);
      expect(pairs[0].target.id).toBe(b);
      expect(pairs[0].reasoning).toBe('auth storage conflict');

      // Resolving the SUPERSEDES pair (retiring the superseded fact) clears it
      deactivateFact(db, d);
      counts = getConsistencyCounts(db);
      expect(counts.activeSupersedesPairs).toBe(0);
      expect(counts.activeContradictsPairs).toBe(1);
      expect(listActiveConflicts(db, 'SUPERSEDES')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('reports orphan facts (active, relation-less) and taxonomy sprawl', () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'connected fact A');
      const b = mkFact(db, 'connected fact B');
      const orphan = mkFact(db, 'island fact with no relations');
      createRelation(db, a, 'SUPPORTS', b, 'related pair');

      const domain = createDomain(db, 'Testing', 'test domain');
      const lonely = createCategory(db, domain.id, 'Lonely Category');
      const shared = createCategory(db, domain.id, 'Shared Category');
      classifyFact(db, orphan, lonely.id);
      classifyFact(db, a, shared.id);
      classifyFact(db, b, shared.id);

      const counts = getConsistencyCounts(db);
      expect(counts.activeFacts).toBe(3);
      expect(counts.orphanFacts).toBe(1);
      expect(counts.orphanRate).toBeCloseTo(1 / 3);
      expect(counts.totalCategories).toBe(2);
      expect(counts.singleFactCategories).toBe(1);
    } finally {
      db.close();
    }
  });

  it('formats a report with exact totals and truncation notes', () => {
    const db = initDatabase();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(mkFact(db, `left fact ${i}`), mkFact(db, `right fact ${i}`));
        createRelation(db, ids[ids.length - 2], 'CONTRADICTS', ids[ids.length - 1], `conflict ${i}`);
      }

      const counts = getConsistencyCounts(db);
      const shown = listActiveConflicts(db, 'CONTRADICTS', 2); // fewer than total
      const report = formatConsistencyReport(counts, shown, []);

      expect(report).toContain('Consistency Report');
      expect(report).toContain('| Active CONTRADICTS pairs | 3 |');
      expect(report).toContain('showing 2 of 3');
    } finally {
      db.close();
    }
  });

  it('reports a clean graph explicitly', () => {
    const db = initDatabase();
    try {
      const counts = getConsistencyCounts(db);
      expect(hasActiveConflicts(counts)).toBe(false);
      const report = formatConsistencyReport(counts, [], []);
      expect(report).toContain('graph is consistent');
    } finally {
      db.close();
    }
  });
});
