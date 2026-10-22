import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
// @ts-ignore floor-guard-ok: plain ESM lane script without type declarations on purpose (it runs under the plugin's pinned node, not tsc)
import { computeDurability, summarizeRun, parseArgs, readEnvFile, renderReport, laneStatus } from '../scripts/resolve-weekly.mjs';

function schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE facts (id TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE ontology_relations (
      id TEXT PRIMARY KEY, source_fact_id TEXT NOT NULL, relation_type TEXT NOT NULL,
      target_fact_id TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE relation_resolution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, action TEXT NOT NULL, relation_id TEXT NOT NULL,
      relation_type_before TEXT NOT NULL, relation_type_after TEXT, source_fact_id TEXT NOT NULL, target_fact_id TEXT NOT NULL,
      source_after TEXT, target_after TEXT, source_fact TEXT NOT NULL, target_fact TEXT NOT NULL, reasoning_before TEXT,
      verdict TEXT NOT NULL, confidence REAL NOT NULL, judge_reasoning TEXT, deactivated_fact_id TEXT, survivor_fact_id TEXT, note TEXT);
  `);
}

function logRow(db: Database.Database, row: Partial<Record<string, unknown>>): void {
  db.prepare(`INSERT INTO relation_resolution_log
    (ts, action, relation_id, relation_type_before, relation_type_after, source_fact_id, target_fact_id, source_fact, target_fact, verdict, confidence, deactivated_fact_id)
    VALUES (@ts, @action, @relation_id, @relation_type_before, @relation_type_after, @source_fact_id, @target_fact_id, 'a', 'b', @verdict, 0.9, @deactivated_fact_id)`)
    .run({ ts: '2026-10-05T00:00:00Z', relation_type_after: null, deactivated_fact_id: null, verdict: 'UNRELATED', ...row });
}

describe('resolve-weekly durability (AKM H4 hit rate)', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-resolve-weekly-'));
    db = new Database(path.join(dir, 'db.sqlite'));
    schema(db);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports unavailable when no apply run was ever recorded', () => {
    db.exec('DROP TABLE relation_resolution_log');
    const d = computeDurability(db);
    expect(d.available).toBe(false);
    expect(d.rate_pct).toBeNull();
  });

  it('counts held vs revived per action, treating CONTRADICTS as symmetric', () => {
    db.prepare("INSERT INTO facts VALUES ('f1',1),('f2',1),('f3',1),('f4',0),('f5',1)").run();
    // delete held: no edge between f1,f2 of CONTRADICTS
    logRow(db, { action: 'delete', relation_id: 'r1', relation_type_before: 'CONTRADICTS', source_fact_id: 'f1', target_fact_id: 'f2' });
    // delete revived in reverse direction
    logRow(db, { action: 'delete', relation_id: 'r2', relation_type_before: 'CONTRADICTS', source_fact_id: 'f2', target_fact_id: 'f3' });
    db.prepare("INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id) VALUES ('r2b','f3','CONTRADICTS','f2')").run();
    // retype held: edge now INFLUENCES
    logRow(db, { action: 'retype', relation_id: 'r3', relation_type_before: 'CONTRADICTS', relation_type_after: 'INFLUENCES', source_fact_id: 'f1', target_fact_id: 'f3', verdict: 'RELATED_NOT_CONFLICTING' });
    db.prepare("INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id) VALUES ('r3','f1','INFLUENCES','f3')").run();
    // retype revived: same edge id back to the old type
    logRow(db, { action: 'retype', relation_id: 'r4', relation_type_before: 'SUPERSEDES', relation_type_after: 'INFLUENCES', source_fact_id: 'f5', target_fact_id: 'f1', verdict: 'BOTH_VALID' });
    db.prepare("INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id) VALUES ('r4','f5','SUPERSEDES','f1')").run();
    // deactivate held (f4 inactive) and revived (f5 active again)
    logRow(db, { action: 'deactivate', relation_id: 'r5', relation_type_before: 'SUPERSEDES', source_fact_id: 'f4', target_fact_id: 'f1', verdict: 'SOURCE_REDUNDANT', deactivated_fact_id: 'f4' });
    logRow(db, { action: 'deactivate', relation_id: 'r6', relation_type_before: 'SUPERSEDES', source_fact_id: 'f5', target_fact_id: 'f1', verdict: 'SOURCE_REDUNDANT', deactivated_fact_id: 'f5' });
    // keep rows never count
    logRow(db, { action: 'keep', relation_id: 'r7', relation_type_before: 'CONTRADICTS', source_fact_id: 'f1', target_fact_id: 'f5', verdict: 'TRUE_CONFLICT' });

    const d = computeDurability(db);
    expect(d.available).toBe(true);
    expect(d.judged_total).toBe(6);
    expect(d.held).toBe(3);
    expect(d.revived).toBe(3);
    expect(d.rate_pct).toBe(50);
    expect(d.by_action).toEqual({ delete: { held: 1, revived: 1 }, retype: { held: 1, revived: 1 }, deactivate: { held: 1, revived: 1 } });
  });
});

describe('resolve-weekly run summary and arguments', () => {
  it('reduces a CLI --json summary and excludes keep from actionable', () => {
    const s = summarizeRun('contradicts', {
      status: 'ok', rc: 0,
      summary: { mode: 'dry-run', examined: 100, judged: 90, spoiledPairs: 2, unavailableBatches: 0, previouslyJudged: 10, judgeFailures: 0,
        planned: { keep: 70, delete: 15, retype: 5 }, applied: {},
        pairs: [{ planned: 'keep', verdict: 'TRUE_CONFLICT', confidence: 0.8, relationId: 'k' }, { planned: 'delete', verdict: 'UNRELATED', confidence: 0.9, relationId: 'd', judgeReasoning: 'different subjects' }] },
    });
    expect(s.status).toBe('ok');
    expect(s.actionable).toBe(20);
    expect(s.pairs).toHaveLength(1);
    expect(s.pairs[0].relationId).toBe('d');
    const f = summarizeRun('supersedes', { status: 'timeout', rc: null, error: 'timeout after 45 min' });
    expect(f.status).toBe('timeout');
    expect(f.actionable).toBe(0);
  });

  it('treats a judge that never answered as judge-unavailable, not ok (CLI exits 0 with unavailableBatches)', () => {
    const u = summarizeRun('contradicts', { status: 'ok', rc: 0, summary: { examined: 10, judged: 0, unavailableBatches: 1, judgeFailures: 3, planned: {}, applied: {}, pairs: [] } });
    expect(u.status).toBe('judge-unavailable');
    expect(laneStatus([u, { status: 'ok' }], null)).toBe('partial');
    const partial = summarizeRun('contradicts', { status: 'ok', rc: 0, summary: { examined: 10, judged: 8, unavailableBatches: 1, planned: { keep: 8 }, applied: {}, pairs: [] } });
    expect(partial.status).toBe('judge-unavailable');
    const fine = summarizeRun('contradicts', { status: 'ok', rc: 0, summary: { examined: 0, judged: 0, unavailableBatches: 0, planned: {}, applied: {}, pairs: [] } });
    expect(fine.status).toBe('ok');
  });

  it('marks the week partial when any replan failed even if both judge runs succeeded', () => {
    const ok = { status: 'ok' };
    expect(laneStatus([ok, ok], null)).toBe('ok');
    expect(laneStatus([ok, ok], [{ status: 'ok' }, { status: 'ok' }])).toBe('ok');
    expect(laneStatus([ok, ok], [{ status: 'ok' }, { status: 'timeout' }])).toBe('partial');
    expect(laneStatus([ok, { status: 'error' }], null)).toBe('partial');
  });

  it('parses arguments strictly and reads the env file without executing it', () => {
    expect(parseArgs(['--db', '/tmp/x.sqlite']).dbExplicit).toBe(true);
    expect(path.isAbsolute(parseArgs(['--db', 'rel.sqlite']).db)).toBe(true);
    expect(path.isAbsolute(parseArgs(['--out', 'reports']).out)).toBe(true);
    const saved = process.env.MEMORY_BANK_DB_PATH;
    delete process.env.MEMORY_BANK_DB_PATH;
    expect(parseArgs([]).dbExplicit).toBe(false);
    process.env.MEMORY_BANK_DB_PATH = 'rel-env.sqlite';
    const viaEnv = parseArgs([]);
    expect(viaEnv.dbExplicit).toBe(true);
    expect(path.isAbsolute(viaEnv.db)).toBe(true);
    if (saved === undefined) delete process.env.MEMORY_BANK_DB_PATH; else process.env.MEMORY_BANK_DB_PATH = saved;
    expect(parseArgs(['--limit', '50', '--votes', '1', '--types', 'contradicts']).types).toEqual(['contradicts']);
    expect(() => parseArgs(['--votes', '9'])).toThrow();
    expect(() => parseArgs(['--limit', '1e3'])).toThrow();
    expect(() => parseArgs(['--types', 'all'])).toThrow();
    expect(() => parseArgs(['--bogus'])).toThrow();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-env-'));
    const f = path.join(dir, 'memory-bank.env');
    fs.writeFileSync(f, 'export MEMORY_BANK_ROOT="/x/1.12.8"\nexport MEMORY_BANK_NODE="/opt/homebrew/bin/node"\nrm -rf /\n');
    expect(readEnvFile(f)).toEqual({ MEMORY_BANK_ROOT: '/x/1.12.8', MEMORY_BANK_NODE: '/opt/homebrew/bin/node' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renders a dry-run report that names the human decision and a failed run', () => {
    const md = renderReport({
      time: '2026-10-26T00:33:00Z', mode: 'dry-run', opts: { limit: 100, votes: 3, model: null, types: ['contradicts', 'supersedes'] },
      rt: { root: '/x', node: '/n' },
      runs: [summarizeRun('contradicts', { status: 'ok', rc: 0, summary: { examined: 3, judged: 3, planned: { keep: 2, delete: 1 }, applied: {}, pairs: [{ planned: 'delete', verdict: 'UNRELATED', confidence: 0.7, relationId: 'abc' }] } }),
        summarizeRun('supersedes', { status: 'error', rc: 1, error: 'resolve failed: judge unavailable' })],
      durability: { available: true, judged_total: 264, held: 38, revived: 226, rate_pct: 14.4, by_action: { delete: { held: 38, revived: 226 } } },
      replans: null,
    });
    expect(md).toContain('dry-run');
    expect(md).toContain('MEMORY_BANK_RESOLVE_APPLY=1');
    expect(md).toContain('relation `abc`');
    expect(md).toContain('실행 실패: error (rc 1)');
    expect(md).toContain('유지 38 / 되살아남 226 (유지율 14.4%)');
  });
});
