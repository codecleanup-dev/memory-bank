import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

// Mock only the LLM call; keep the real JSON parser so the gate sees what production sees.
vi.mock('../src/llm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/llm.js')>()),
  callHaiku: vi.fn(),
}));

vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));

import { callHaiku } from '../src/llm.js';
import { detectCoExtractionRelations } from '../src/ontology-classifier.js';
import { getRelationsForFact } from '../src/ontology-db.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

describe('relation detection gate: CONTRADICTS / SUPERSEDES need same_question', () => {
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
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-detect-gate-test-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('drops a CONTRADICTS answer that does not assert the facts answer the same question', async () => {
    const a = mkFact('blog posts are explained with HTML explain boxes');
    const b = mkFact('technical answers are returned as Korean JSON');
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"has_relation":true,"relation_type":"CONTRADICTS","same_question":false,"reasoning":"different formats"}',
    );
    await detectCoExtractionRelations(db, [a, b]);
    expect(getRelationsForFact(db, b)).toHaveLength(0);
  });

  it('drops a CONTRADICTS answer that omits same_question entirely (old-shape output)', async () => {
    const a = mkFact('x');
    const b = mkFact('y');
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"has_relation":true,"relation_type":"SUPERSEDES","reasoning":"newer"}',
    );
    await detectCoExtractionRelations(db, [a, b]);
    expect(getRelationsForFact(db, b)).toHaveLength(0);
  });

  it('keeps a CONTRADICTS answer that asserts the same question', async () => {
    const a = mkFact('sessions use JWT tokens');
    const b = mkFact('sessions use server-side cookies');
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"has_relation":true,"relation_type":"CONTRADICTS","same_question":true,"reasoning":"same auth storage question"}',
    );
    await detectCoExtractionRelations(db, [a, b]);
    const rels = getRelationsForFact(db, b);
    expect(rels).toHaveLength(1);
    expect(rels[0].relation_type).toBe('CONTRADICTS');
  });

  it('does not gate non-conflict types', async () => {
    const a = mkFact('service reads config from Vault');
    const b = mkFact('deploy script must export VAULT_ADDR first');
    (callHaiku as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"has_relation":true,"relation_type":"DEPENDS_ON","reasoning":"prerequisite"}',
    );
    await detectCoExtractionRelations(db, [a, b]);
    expect(getRelationsForFact(db, b).map((r) => r.relation_type)).toEqual(['DEPENDS_ON']);
  });
});
