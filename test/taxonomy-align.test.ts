import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import {
  createDomain,
  createCategory,
  classifyFact,
  upsertCategoryEmbedding,
} from '../src/ontology-db.js';
import { applyMerges, findMergeCandidates, formatAlignmentReport } from '../src/taxonomy-align.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

// (Near-)unit-norm vectors: identical pairs → cosine ~1.0, the alternating
// vector is orthogonal to the flat one → cosine ~0.
const VEC_FLAT = new Array(384).fill(0.051);
const VEC_ALT = new Array(384).fill(0).map((_, i) => (i % 2 === 0 ? 0.051 : -0.051));

describe('taxonomy alignment', () => {
  let testDir: string;
  let db: Database.Database;

  function seedFacts(categoryId: string, n: number, label: string): void {
    for (let i = 0; i < n; i++) {
      const id = insertFact(db, {
        fact: `${label} fact ${i}`,
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: [],
        embedding: null,
      });
      classifyFact(db, id, categoryId);
    }
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-taxonomy-test-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('finds same-domain near-duplicates, keeps the larger side, flags cross-domain', () => {
    const frontend = createDomain(db, 'Frontend');
    const a1 = createCategory(db, frontend.id, 'State Management');
    const a2 = createCategory(db, frontend.id, 'State Mgmt');
    const a3 = createCategory(db, frontend.id, 'Database Indexing');
    const backend = createDomain(db, 'Backend');
    const b1 = createCategory(db, backend.id, 'State Handling');

    upsertCategoryEmbedding(db, a1.id, VEC_FLAT);
    upsertCategoryEmbedding(db, a2.id, VEC_FLAT);
    upsertCategoryEmbedding(db, a3.id, VEC_ALT);
    upsertCategoryEmbedding(db, b1.id, VEC_FLAT);

    seedFacts(a1.id, 2, 'a1');
    seedFacts(a2.id, 1, 'a2');
    seedFacts(a3.id, 1, 'a3');

    const { candidates, unindexedCategories } = findMergeCandidates(db, { threshold: 0.95 });
    expect(unindexedCategories).toBe(0);

    const same = candidates.filter((c) => c.sameDomain);
    const cross = candidates.filter((c) => !c.sameDomain);
    expect(same).toHaveLength(1);
    expect(same[0].keepId).toBe(a1.id); // 2 facts beat 1 fact
    expect(same[0].dropId).toBe(a2.id);
    expect(same[0].similarity).toBeGreaterThan(0.95);
    expect(cross.length).toBe(2); // b1 pairs with a1 and a2, never auto-applied

    // The dissimilar category never appears
    expect(candidates.some((c) => c.keepId === a3.id || c.dropId === a3.id)).toBe(false);
  });

  it('applyMerges remaps facts, drops the category and its index row, skips cross-domain', () => {
    const frontend = createDomain(db, 'Frontend');
    const a1 = createCategory(db, frontend.id, 'State Management');
    const a2 = createCategory(db, frontend.id, 'State Mgmt');
    const backend = createDomain(db, 'Backend');
    const b1 = createCategory(db, backend.id, 'State Handling');

    upsertCategoryEmbedding(db, a1.id, VEC_FLAT);
    upsertCategoryEmbedding(db, a2.id, VEC_FLAT);
    upsertCategoryEmbedding(db, b1.id, VEC_FLAT);

    seedFacts(a1.id, 2, 'a1');
    seedFacts(a2.id, 1, 'a2');

    const { candidates } = findMergeCandidates(db, { threshold: 0.95 });
    const result = applyMerges(db, candidates);

    expect(result.merged).toBe(1);
    expect(result.factsRemapped).toBe(1);
    expect(result.skippedCrossDomain).toBe(2);

    const remaining = db.prepare('SELECT id FROM ontology_categories').all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).not.toContain(a2.id);

    const moved = db
      .prepare('SELECT COUNT(*) AS n FROM facts WHERE ontology_category_id = ?')
      .get(a1.id) as { n: number };
    expect(moved.n).toBe(3);

    const vecIds = (db.prepare('SELECT id FROM vec_categories').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(vecIds).not.toContain(a2.id);
  });

  it('resolves merge chains onto the final survivor', () => {
    const domain = createDomain(db, 'Chained');
    const cA = createCategory(db, domain.id, 'Chain A');
    const cB = createCategory(db, domain.id, 'Chain B');
    const cC = createCategory(db, domain.id, 'Chain C');
    upsertCategoryEmbedding(db, cA.id, VEC_FLAT);
    upsertCategoryEmbedding(db, cB.id, VEC_FLAT);
    upsertCategoryEmbedding(db, cC.id, VEC_FLAT);
    seedFacts(cA.id, 3, 'A');
    seedFacts(cB.id, 2, 'B');
    seedFacts(cC.id, 1, 'C');

    const { candidates } = findMergeCandidates(db, { threshold: 0.95 });
    expect(candidates).toHaveLength(3); // A-B, A-C, B-C

    const result = applyMerges(db, candidates);
    expect(result.merged).toBe(2);
    expect(result.skippedStale).toBe(1); // the third pair collapsed into the same survivor
    expect(result.factsRemapped).toBe(3);

    const total = db
      .prepare('SELECT COUNT(*) AS n FROM facts WHERE ontology_category_id = ?')
      .get(cA.id) as { n: number };
    expect(total.n).toBe(6);
    const remaining = (db.prepare('SELECT id FROM ontology_categories').all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(remaining).toContain(cA.id);
    expect(remaining).not.toContain(cB.id);
    expect(remaining).not.toContain(cC.id);
  });

  it('re-decides the survivor after chain resolution — stale roles cannot invert it', () => {
    const domain = createDomain(db, 'Stale');
    const cA = createCategory(db, domain.id, 'Stale A');
    const cB = createCategory(db, domain.id, 'Stale B');
    const cC = createCategory(db, domain.id, 'Stale C');
    seedFacts(cA.id, 3, 'A');
    seedFacts(cB.id, 2, 'B');
    seedFacts(cC.id, 1, 'C');

    // Adversarial candidate ORDER: A absorbs C first; the later stale B–C
    // pair resolves its drop side to A — without re-deciding, the largest
    // category (A) would be deleted into B.
    const cand = (keepId: string, keepName: string, keepN: number, dropId: string, dropName: string, dropN: number) => ({
      keepId, keepName, keepDomain: 'Stale', keepFactCount: keepN,
      dropId, dropName, dropDomain: 'Stale', dropFactCount: dropN,
      similarity: 1, sameDomain: true,
    });
    const result = applyMerges(db, [
      cand(cA.id, 'Stale A', 3, cC.id, 'Stale C', 1),
      cand(cB.id, 'Stale B', 2, cC.id, 'Stale C', 1),
    ]);

    expect(result.merged).toBe(2);
    const remaining = (db.prepare(`SELECT id FROM ontology_categories WHERE id IN (?, ?, ?)`).all(
      cA.id, cB.id, cC.id,
    ) as Array<{ id: string }>).map((r) => r.id);
    expect(remaining).toEqual([cA.id]); // the largest category survives
    const total = db
      .prepare('SELECT COUNT(*) AS n FROM facts WHERE ontology_category_id = ?')
      .get(cA.id) as { n: number };
    expect(total.n).toBe(6);
  });

  it('never proposes merging the General/Misc parking category', () => {
    const general = createDomain(db, 'General', 'General purpose facts');
    const misc = createCategory(db, general.id, 'Misc', 'Miscellaneous facts');
    const twin = createCategory(db, general.id, 'Misc-like');
    upsertCategoryEmbedding(db, misc.id, VEC_FLAT);
    upsertCategoryEmbedding(db, twin.id, VEC_FLAT);

    const { candidates } = findMergeCandidates(db, { threshold: 0.95 });
    expect(candidates.some((c) => c.keepId === misc.id || c.dropId === misc.id)).toBe(false);
  });

  it('reports unindexed categories instead of silently skipping them', () => {
    const domain = createDomain(db, 'Partial');
    createCategory(db, domain.id, 'No Embedding Yet');
    const find = findMergeCandidates(db, { threshold: 0.9 });
    expect(find.unindexedCategories).toBe(1);
    const report = formatAlignmentReport(find, { threshold: 0.9, show: 10 });
    expect(report).toContain('backfill-category-embeddings');
  });
});
