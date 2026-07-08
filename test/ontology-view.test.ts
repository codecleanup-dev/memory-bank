import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { createDomain, createCategory, classifyFact, createRelation } from '../src/ontology-db.js';
import { buildOntologyView } from '../src/ontology-view.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

describe('buildOntologyView', () => {
  let testDir: string;
  let db: Database.Database;

  function seedFact(db: Database.Database, text: string, categoryId: string): string {
    const id = insertFact(db, {
      fact: text,
      category: 'decision',
      scope_type: 'global',
      scope_project: null,
      source_exchange_ids: [],
      embedding: null,
    });
    classifyFact(db, id, categoryId);
    return id;
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ontology-view-test-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    db = initDatabase();

    const frontend = createDomain(db, 'Frontend', 'Frontend development');
    const state = createCategory(db, frontend.id, 'State Management');
    const routing = createCategory(db, frontend.id, 'Routing');
    const backend = createDomain(db, 'Backend', 'Backend development');
    const api = createCategory(db, backend.id, 'API Design');

    for (let i = 0; i < 7; i++) seedFact(db, `state management fact ${i}`, state.id);
    seedFact(db, 'router uses hash mode', routing.id);
    seedFact(db, 'api uses rest', api.id);
    seedFact(db, 'api errors use problem+json', api.id);
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('unfiltered call returns a bounded summary with zero fact lines', () => {
    const out = buildOntologyView(db, {});
    expect(out).toContain('# Ontology Summary');
    expect(out).toContain('| Active facts | 10 |');
    expect(out).toContain('**Frontend** — 2 categories, 8 facts');
    expect(out).toContain('**Backend** — 1 categories, 2 facts');
    // No individual facts leak into summary mode
    expect(out).not.toContain('state management fact');
    expect(out).not.toContain('api uses rest');
  });

  it('domain filter lists facts capped per category with exact remainders', () => {
    const out = buildOntologyView(db, { domain: 'front' });
    expect(out).toContain('## Frontend');
    expect(out).toContain('(showing 5 of 7 facts)');
    expect(out).toContain('…+2 more facts in this category');
    expect(out).toContain('router uses hash mode');
    expect(out).not.toContain('## Backend');
  });

  it('respects a custom limit', () => {
    const out = buildOntologyView(db, { domain: 'front', limit: 2 });
    expect(out).toContain('(showing 2 of 7 facts)');
    expect(out).toContain('…+5 more facts in this category');
  });

  it('category filter matches across domains and skips non-matching ones', () => {
    const out = buildOntologyView(db, { category: 'api' });
    expect(out).toContain('### API Design');
    expect(out).toContain('api uses rest');
    expect(out).not.toContain('State Management');
  });

  it('includes 1-hop relations when requested', () => {
    const domain = createDomain(db, 'Testing', 'test domain');
    const cat = createCategory(db, domain.id, 'Relations');
    const a = seedFact(db, 'relation source fact', cat.id);
    const b = seedFact(db, 'relation target fact', cat.id);
    createRelation(db, a, 'SUPPORTS', b, 'linked');

    const out = buildOntologyView(db, { domain: 'testing', includeRelations: true });
    expect(out).toContain('↔ [SUPPORTS]');
  });

  it('bounds relations per fact when include_relations is set', () => {
    const domain = createDomain(db, 'Hubs', 'hub domain');
    const cat = createCategory(db, domain.id, 'Hub Category');
    const hub = seedFact(db, 'hub fact with many edges', cat.id);
    for (let i = 0; i < 8; i++) {
      const other = seedFact(db, `spoke fact ${i}`, cat.id);
      createRelation(db, hub, 'SUPPORTS', other, `edge ${i}`);
    }
    // Pin the hub as the top-ranked fact so limit:1 renders exactly it
    db.prepare('UPDATE facts SET consolidated_count = 10 WHERE id = ?').run(hub);

    const out = buildOntologyView(db, { domain: 'hubs', includeRelations: true, limit: 1 });
    const relationLines = (out.match(/↔ \[SUPPORTS\]/g) ?? []).length;
    expect(relationLines).toBe(5); // 8 edges → capped at 5
    expect(out).toContain('+3 more relations');
  });

  it('caps rendered categories globally and reports the remainder', () => {
    const bulk = createDomain(db, 'Bulk', 'many categories');
    for (let i = 0; i < 45; i++) {
      const c = createCategory(db, bulk.id, `Bulk Category ${String(i).padStart(2, '0')}`);
      seedFact(db, `bulk fact ${i}`, c.id);
    }
    const out = buildOntologyView(db, { domain: 'bulk' });
    expect(out).toContain('…+5 more categories matched');
  });

  it('reports empty matches explicitly', () => {
    const out = buildOntologyView(db, { domain: 'nonexistent' });
    expect(out).toContain('No ontology data matched the filters');
  });
});
