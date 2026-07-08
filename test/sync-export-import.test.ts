import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { suppressConsole } from './test-utils.js';

// Mock embeddings (avoid loading the model)
vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.05)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));

const originalEnv = { ...process.env };

describe('sync-export/import', () => {
  let tmpDir: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-sync-'));
    process.env.MEMORY_BANK_CONFIG_DIR = tmpDir;
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMORY_BANK_DB_PATH;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    Object.keys(process.env).forEach(key => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should export empty database', async () => {
    const { exportForSync } = await import('../src/sync-export.js');
    const result = exportForSync();
    expect(result.facts).toBe(0);
    expect(result.domains).toBe(0);
    expect(result.categories).toBe(0);
    expect(result.relations).toBe(0);
  });

  it('should create sync directory', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const dir = getSyncDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain('sync');
  });

  it('should export facts and ontology to JSONL', async () => {
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();

    try {
      // Insert test data
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)`).run(
        'dom-1', 'Frontend', 'Frontend dev', now
      );
      db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        'cat-1', 'dom-1', 'React', 'React patterns', now
      );
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active, ontology_category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'fact-1', 'Use React hooks', 'decision', 'project', 'test-proj', '[]', now, now, 1, 1, 'cat-1'
      );
      db.prepare(`INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        'rel-1', 'fact-1', 'SUPPORTS', 'fact-1', 'self reference test', now
      );
    } finally {
      db.close();
    }

    const { exportForSync } = await import('../src/sync-export.js');
    const result = exportForSync();

    expect(result.facts).toBe(1);
    expect(result.domains).toBe(1);
    expect(result.categories).toBe(1);
    expect(result.relations).toBe(1);

    // Verify files exist
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    expect(fs.existsSync(path.join(syncDir, 'facts.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-domains.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-categories.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'ontology-relations.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(syncDir, 'meta.json'))).toBe(true);

    // Verify meta.json contents
    const meta = JSON.parse(fs.readFileSync(path.join(syncDir, 'meta.json'), 'utf-8'));
    expect(meta.facts_count).toBe(1);
    expect(meta.hostname).toBeTruthy();
    expect(meta.exported_at).toBeTruthy();
  });

  it('should import returns zeros when no sync files exist', async () => {
    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(0);
    expect(result.newDomains).toBe(0);
  });

  it('should import facts from JSONL files', async () => {
    // Create sync files manually
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    fs.writeFileSync(path.join(syncDir, 'ontology-domains.jsonl'),
      JSON.stringify({ id: 'imp-dom-1', name: 'Backend', description: 'Backend dev', created_at: now }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'ontology-categories.jsonl'),
      JSON.stringify({ id: 'imp-cat-1', domain_id: 'imp-dom-1', name: 'API', description: 'API patterns', created_at: now }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      JSON.stringify({
        id: 'imp-fact-1', fact: 'Use REST for APIs', category: 'decision',
        scope_type: 'project', scope_project: 'api-proj', source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: 'imp-cat-1'
      }) + '\n' +
      JSON.stringify({
        id: 'imp-fact-2', fact: 'Version APIs in the URL path', category: 'decision',
        scope_type: 'project', scope_project: 'api-proj', source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: 'imp-cat-1'
      }) + '\n'
    );
    fs.writeFileSync(path.join(syncDir, 'ontology-relations.jsonl'),
      JSON.stringify({
        id: 'imp-rel-1', source_fact_id: 'imp-fact-1', relation_type: 'INFLUENCES',
        target_fact_id: 'imp-fact-2', reasoning: 'test', created_at: now
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();

    expect(result.newDomains).toBe(1);
    expect(result.newCategories).toBe(1);
    expect(result.newFacts).toBe(2);
    expect(result.newRelations).toBe(1);
  });

  it('should normalize out-of-vocabulary categories from legacy sync files instead of dropping them', async () => {
    // Sync files written by machines that predate the facts.category CHECK
    // can carry 'requirement' / enum-echo / 'null' categories — those rows
    // must be normalized on import, not thrown at the constraint and lost.
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    const legacyRow = (id: string, category: string, confidence?: number): string =>
      JSON.stringify({
        id, fact: `legacy fact ${id}`, category,
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null,
        ...(confidence !== undefined ? { confidence } : {}),
      }) + '\n';

    fs.writeFileSync(
      path.join(syncDir, 'facts.jsonl'),
      legacyRow('legacy-1', 'requirement') +
        legacyRow('legacy-2', 'decision|preference|pattern|knowledge|constraint') +
        legacyRow('legacy-3', 'null') +
        legacyRow('legacy-4', 'decision', 0.9),
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(4); // none silently dropped

    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      const byId = new Map(
        (db.prepare(`SELECT id, category, confidence FROM facts WHERE id LIKE 'legacy-%'`).all() as Array<{
          id: string;
          category: string;
          confidence: number | null;
        }>).map((r) => [r.id, r]),
      );
      expect(byId.get('legacy-1')?.category).toBe('constraint');
      expect(byId.get('legacy-2')?.category).toBe('decision');
      expect(byId.get('legacy-3')?.category).toBe('knowledge');
      // Reliability signal survives the sync; pre-confidence files stay NULL
      expect(byId.get('legacy-4')?.confidence).toBe(0.9);
      expect(byId.get('legacy-1')?.confidence).toBeNull();
    } finally {
      db.close();
    }
  });

  it('remaps relation endpoints when a fact was content-deduped to a local fact', async () => {
    // Local DB already knows the fact text; the remote file carries the same
    // text under a different id plus a relation from that id — the edge must
    // land on the surviving local fact instead of being dropped by the FK.
    const { initDatabase } = await import('../src/db.js');
    const { insertFact } = await import('../src/fact-db.js');
    const setupDb = initDatabase();
    let localId: string;
    try {
      localId = insertFact(setupDb, {
        fact: 'shared canonical fact',
        category: 'decision',
        scope_type: 'global',
        scope_project: null,
        source_exchange_ids: [],
        embedding: null,
      });
    } finally {
      setupDb.close();
    }

    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();
    const row = (id: string, fact: string): string =>
      JSON.stringify({
        id, fact, category: 'decision', scope_type: 'global', scope_project: null,
        source_exchange_ids: '[]', created_at: now, updated_at: now,
        consolidated_count: 1, ontology_category_id: null,
      }) + '\n';
    fs.writeFileSync(
      path.join(syncDir, 'facts.jsonl'),
      row('remote-1', 'shared canonical fact') + row('remote-2', 'brand new remote fact'),
    );
    fs.writeFileSync(
      path.join(syncDir, 'ontology-relations.jsonl'),
      JSON.stringify({
        id: 'remote-rel-1', source_fact_id: 'remote-1', relation_type: 'DEPENDS_ON',
        target_fact_id: 'remote-2', reasoning: 'remapped edge', created_at: now,
      }) + '\n',
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(1); // remote-1 deduped onto the local fact
    expect(result.newRelations).toBe(1); // …but its edge survived, remapped

    const db = initDatabase();
    try {
      const rel = db
        .prepare(`SELECT source_fact_id, target_fact_id FROM ontology_relations WHERE id = 'remote-rel-1'`)
        .get() as { source_fact_id: string; target_fact_id: string };
      expect(rel.source_fact_id).toBe(localId);
      expect(rel.target_fact_id).toBe('remote-2');
    } finally {
      db.close();
    }
  });

  it('exports only relations whose both endpoints are active', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { insertFact, deactivateFact } = await import('../src/fact-db.js');
    const { createRelation } = await import('../src/ontology-db.js');
    const db = initDatabase();
    try {
      const mk = (text: string): string =>
        insertFact(db, {
          fact: text, category: 'decision', scope_type: 'global', scope_project: null,
          source_exchange_ids: [], embedding: null,
        });
      const a = mk('active endpoint a');
      const b = mk('soon-inactive endpoint b');
      const c = mk('active endpoint c');
      createRelation(db, a, 'SUPERSEDES', b, 'b was retired');
      createRelation(db, a, 'SUPPORTS', c, 'both active');
      deactivateFact(db, b);
    } finally {
      db.close();
    }

    const { exportForSync, getSyncDir } = await import('../src/sync-export.js');
    const result = exportForSync();
    expect(result.relations).toBe(1); // the edge into the inactive fact is excluded

    const lines = fs
      .readFileSync(path.join(getSyncDir(), 'ontology-relations.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SUPPORTS');
  });

  it('dedupes symmetric relations in either direction on import', async () => {
    const { initDatabase } = await import('../src/db.js');
    const { insertFact } = await import('../src/fact-db.js');
    const { createRelation } = await import('../src/ontology-db.js');
    const setupDb = initDatabase();
    let l1: string;
    let l2: string;
    try {
      const mk = (text: string): string =>
        insertFact(setupDb, {
          fact: text, category: 'decision', scope_type: 'global', scope_project: null,
          source_exchange_ids: [], embedding: null,
        });
      l1 = mk('symmetric fact one');
      l2 = mk('symmetric fact two');
      createRelation(setupDb, l1, 'SUPPORTS', l2, 'local edge');
    } finally {
      setupDb.close();
    }

    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();
    const row = (id: string, fact: string): string =>
      JSON.stringify({
        id, fact, category: 'decision', scope_type: 'global', scope_project: null,
        source_exchange_ids: '[]', created_at: now, updated_at: now,
        consolidated_count: 1, ontology_category_id: null,
      }) + '\n';
    fs.writeFileSync(
      path.join(syncDir, 'facts.jsonl'),
      row('rem-1', 'symmetric fact one') + row('rem-2', 'symmetric fact two'),
    );
    // Reverse direction of the existing local SUPPORTS edge — same claim
    fs.writeFileSync(
      path.join(syncDir, 'ontology-relations.jsonl'),
      JSON.stringify({
        id: 'rem-rel-rev', source_fact_id: 'rem-2', relation_type: 'SUPPORTS',
        target_fact_id: 'rem-1', reasoning: 'reverse duplicate', created_at: now,
      }) + '\n',
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newRelations).toBe(0); // reverse SUPPORTS is the same claim → skipped

    const db = initDatabase();
    try {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ontology_relations`).get() as { n: number }
      ).n;
      expect(n).toBe(1); // only the original local edge
    } finally {
      db.close();
    }
  });

  it('should skip duplicate records on re-import', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    const domainLine = JSON.stringify({ id: 'dup-dom', name: 'DevOps', description: 'DevOps', created_at: now });
    fs.writeFileSync(path.join(syncDir, 'ontology-domains.jsonl'), domainLine + '\n');
    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      JSON.stringify({
        id: 'dup-fact', fact: 'Use Docker', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');

    // First import
    const first = await importFromSync();
    expect(first.newDomains).toBe(1);
    expect(first.newFacts).toBe(1);

    // Second import - should skip duplicates
    const second = await importFromSync();
    expect(second.newDomains).toBe(0);
    expect(second.newFacts).toBe(0);
  });

  it('should skip malformed JSONL lines', async () => {
    const { getSyncDir } = await import('../src/sync-export.js');
    const syncDir = getSyncDir();
    const now = new Date().toISOString();

    fs.writeFileSync(path.join(syncDir, 'facts.jsonl'),
      'not valid json\n' +
      JSON.stringify({
        id: 'valid-fact', fact: 'Valid fact', category: 'decision',
        scope_type: 'global', scope_project: null, source_exchange_ids: '[]',
        created_at: now, updated_at: now, consolidated_count: 1, ontology_category_id: null
      }) + '\n'
    );

    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(1); // Only the valid line
  });

  it('should round-trip export then import', async () => {
    // Insert data and export
    const { initDatabase } = await import('../src/db.js');
    let db = initDatabase();
    const now = new Date().toISOString();

    try {
      db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at, consolidated_count, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'rt-fact', 'Round trip test', 'pattern', 'global', null, '["ex-1"]', now, now, 2, 1
      );
    } finally {
      db.close();
    }

    const { exportForSync } = await import('../src/sync-export.js');
    exportForSync();

    // Delete the fact from DB
    db = initDatabase();
    try {
      db.prepare('DELETE FROM facts WHERE id = ?').run('rt-fact');
    } finally {
      db.close();
    }

    // Import should restore it
    const { importFromSync } = await import('../src/sync-import.js');
    const result = await importFromSync();
    expect(result.newFacts).toBe(1);

    // Verify fact is back
    db = initDatabase();
    try {
      const row = db.prepare('SELECT * FROM facts WHERE id = ?').get('rt-fact') as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row['fact']).toBe('Round trip test');
      expect(row['category']).toBe('pattern');
    } finally {
      db.close();
    }
  });
});
