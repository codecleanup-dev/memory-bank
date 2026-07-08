import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// Mock LLM module (no real Haiku calls)
vi.mock('../src/llm.js', () => ({
  callHaiku: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

// Mock embeddings (avoid loading the model)
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));

import { callHaiku, parseJsonResponse } from '../src/llm.js';
import { detectCoExtractionRelations, MAX_COEXTRACT_PAIRS } from '../src/ontology-classifier.js';
import { createRelation, getRelatedFacts, getRelationsForFact } from '../src/ontology-db.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

describe('co-extraction relation channel', () => {
  let testDir: string;
  let db: Database.Database;

  function mkFact(text: string): string {
    return insertFact(db, {
      fact: text,
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: null,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-coextract-test-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('persists a validated DEPENDS_ON relation between co-extracted facts', async () => {
    const a = mkFact('service reads config from Vault');
    const b = mkFact('deploy script must export VAULT_ADDR first');

    (callHaiku as Mock).mockResolvedValue('raw');
    (parseJsonResponse as Mock).mockReturnValue({
      has_relation: true,
      relation_type: 'DEPENDS_ON',
      reasoning: 'deploy depends on vault config',
    });

    await detectCoExtractionRelations(db, [a, b]);

    const rels = getRelationsForFact(db, a);
    expect(rels).toHaveLength(1);
    expect(rels[0].relation_type).toBe('DEPENDS_ON'); // fresh-DB CHECK accepts the new type
    expect(rels[0].reasoning).toBe('deploy depends on vault config');
  });

  it('rejects off-vocabulary relation types without persisting or throwing', async () => {
    const a = mkFact('fact a');
    const b = mkFact('fact b');

    (callHaiku as Mock).mockResolvedValue('raw');
    (parseJsonResponse as Mock).mockReturnValue({
      has_relation: true,
      relation_type: 'BOGUS_TYPE',
      reasoning: 'junk',
    });

    await detectCoExtractionRelations(db, [a, b]);
    expect(getRelationsForFact(db, a)).toHaveLength(0);
  });

  it('never duplicates a same-type edge, but records relationship evolution (different type)', async () => {
    const a = mkFact('fact a');
    const b = mkFact('fact b');
    createRelation(db, b, 'SUPPORTS', a, 'pre-existing reverse edge');

    // Probe returns the SAME type (opposite direction) → no duplicate edge
    (callHaiku as Mock).mockResolvedValue('raw');
    (parseJsonResponse as Mock).mockReturnValue({
      has_relation: true,
      relation_type: 'SUPPORTS',
      reasoning: 'same type again',
    });
    await detectCoExtractionRelations(db, [a, b]);
    expect(getRelationsForFact(db, a)).toHaveLength(1); // still only the pre-existing edge

    // Probe returns a DIFFERENT type → relationship evolution is recorded
    // (a blanket any-relation skip would permanently hide late conflicts
    // from the consistency queue)
    (parseJsonResponse as Mock).mockReturnValue({
      has_relation: true,
      relation_type: 'CONTRADICTS',
      reasoning: 'later evidence conflicts',
    });
    await detectCoExtractionRelations(db, [a, b]);
    const rels = getRelationsForFact(db, a);
    expect(rels).toHaveLength(2);
    expect(rels.map((r) => r.relation_type).sort()).toEqual(['CONTRADICTS', 'SUPPORTS']);
  });

  it('caps probes at MAX_COEXTRACT_PAIRS consecutive pairs', async () => {
    const ids = ['one', 'two', 'three', 'four', 'five'].map((n) => mkFact(`fact ${n}`));

    (callHaiku as Mock).mockResolvedValue('raw');
    (parseJsonResponse as Mock).mockReturnValue({ has_relation: false, relation_type: null, reasoning: '' });

    await detectCoExtractionRelations(db, ids);
    expect(callHaiku).toHaveBeenCalledTimes(MAX_COEXTRACT_PAIRS);
  });

  it('does nothing for a single-fact batch', async () => {
    const a = mkFact('lonely fact');
    await detectCoExtractionRelations(db, [a]);
    expect(callHaiku).not.toHaveBeenCalled();
  });

  it('traversal weights treat DEPENDS_ON as structural in BOTH directions', () => {
    const a = mkFact('service depends on vault');
    const b = mkFact('vault is the secret store');
    const c = mkFact('sessions use cookies');
    createRelation(db, a, 'DEPENDS_ON', b, 'a depends on b');
    createRelation(db, a, 'CONTRADICTS', c, 'conflict edge');

    // Outgoing direction (from a): structural edge at full weight
    const fromA = getRelatedFacts(db, a, 1);
    const outDep = fromA.find((r) => r.fact.id === b);
    expect(outDep?.relevance).toBe(1.0);

    // Incoming direction (from b): must ALSO be full weight — the incoming
    // branch previously kept the legacy SUPPORTS/INFLUENCES-only whitelist
    const fromB = getRelatedFacts(db, b, 1);
    const inDep = fromB.find((r) => r.fact.id === a);
    expect(inDep?.relevance).toBe(1.0);

    // Conflict edges stay dampened in the incoming direction too
    const fromC = getRelatedFacts(db, c, 1);
    const inConflict = fromC.find((r) => r.fact.id === a);
    expect(inConflict?.relevance).toBeCloseTo(0.7);
  });
});
