import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase, openDatabaseReadonly } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { createRelation } from '../src/ontology-db.js';
import { listActiveConflicts } from '../src/consistency.js';
import {
  committeePairJudge,
  parseIntegerOption,
  planAction,
  replanFromLog,
  resolveModelId,
  resolveQueue,
  type JudgeVerdict,
  type PairJudge,
} from '../src/relation-resolve.js';
import { suppressConsole } from './test-utils.js';

suppressConsole();

interface FactOpts {
  scope_type?: string;
  scope_project?: string | null;
  confirmed?: number;
}

function mkFact(db: Database.Database, text: string, opts: FactOpts = {}): string {
  const id = insertFact(db, {
    fact: text,
    category: 'decision',
    scope_type: opts.scope_type ?? 'global',
    scope_project: opts.scope_project ?? null,
    source_exchange_ids: [],
    embedding: null,
  });
  if (opts.confirmed) db.prepare('UPDATE facts SET consolidated_count = ? WHERE id = ?').run(opts.confirmed, id);
  return id;
}

/** A judge that answers from a text → verdict table, so tests stay deterministic. */
function tableJudge(table: Record<string, { verdict: string; confidence: number }>): PairJudge {
  return async (pairs) =>
    pairs.map((p, i): JudgeVerdict => {
      const hit = table[p.source.fact] ?? { verdict: 'UNCLEAR', confidence: 0.5 };
      return { pair_index: i, verdict: hit.verdict, confidence: hit.confidence, reasoning: 'test' };
    });
}

function relation(db: Database.Database, id: string) {
  return db.prepare('SELECT relation_type, source_fact_id, target_fact_id, reasoning FROM ontology_relations WHERE id = ?').get(id) as
    | { relation_type: string; source_fact_id: string; target_fact_id: string; reasoning: string | null }
    | undefined;
}

function active(db: Database.Database, id: string): number {
  return (db.prepare('SELECT is_active FROM facts WHERE id = ?').get(id) as { is_active: number }).is_active;
}

describe('relation resolve (gated consistency queue resolution)', () => {
  let testDir: string;
  let archive: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-resolve-test-'));
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    archive = path.join(testDir, 'archive.jsonl');
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('dry-run plans actions but changes nothing and writes no archive', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'blog posts use HTML explain boxes');
      const b = mkFact(db, 'technical answers come back as Korean JSON');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'format mismatch');
      const judge = tableJudge({ [db.prepare('SELECT fact FROM facts WHERE id = ?').pluck().get(a) as string]: { verdict: 'UNRELATED', confidence: 0.95 } });

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 0, judge, archivePath: archive });

      expect(summary.mode).toBe('dry-run');
      expect(summary.planned.delete).toBe(1);
      expect(summary.applied).toEqual({});
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS');
      expect(fs.existsSync(archive)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('CONTRADICTS: UNRELATED deletes the edge and archives it; facts stay active', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'deploys run on Azure Static Web Apps');
      const b = mkFact(db, 'cleanup prefers cron based automation');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'noise');
      const judge = tableJudge({ 'deploys run on Azure Static Web Apps': { verdict: 'UNRELATED', confidence: 0.9 } });

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({ deleted: 1 });
      expect(relation(db, rel.id)).toBeUndefined();
      expect(active(db, a)).toBe(1);
      expect(active(db, b)).toBe(1);
      const lines = fs.readFileSync(archive, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ action: 'delete', relation_id: rel.id, relation_type_before: 'CONTRADICTS', verdict: 'UNRELATED' });
      expect(lines[0].source_fact).toBe('deploys run on Azure Static Web Apps');
      expect(listActiveConflicts(db, 'CONTRADICTS')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('CONTRADICTS: RELATED_NOT_CONFLICTING retypes to INFLUENCES, or drops the edge when INFLUENCES already exists', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'review focuses on static analysis');
      const b = mkFact(db, 'UI changes are verified on a running server');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'scope');
      const c = mkFact(db, 'tests run in CI');
      const d = mkFact(db, 'tests also run locally before push');
      createRelation(db, c, 'INFLUENCES', d, 'already linked');
      const dup = createRelation(db, c, 'CONTRADICTS', d, 'noise on top');
      const judge = tableJudge({
        'review focuses on static analysis': { verdict: 'RELATED_NOT_CONFLICTING', confidence: 0.85 },
        'tests run in CI': { verdict: 'RELATED_NOT_CONFLICTING', confidence: 0.9 },
      });

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({ retyped: 1, 'deleted-duplicate-after-retype': 1 });
      const retyped = relation(db, rel.id);
      expect(retyped?.relation_type).toBe('INFLUENCES');
      expect(retyped?.reasoning).toContain('was CONTRADICTS: scope');
      expect(relation(db, dup.id)).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) AS n FROM ontology_relations WHERE source_fact_id = ? AND target_fact_id = ?').get(c, d)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('CONTRADICTS: TRUE_CONFLICT and low-confidence verdicts leave the edge untouched', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'sessions use JWT');
      const b = mkFact(db, 'sessions use server cookies');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'auth');
      const c = mkFact(db, 'logs go to stdout');
      const d = mkFact(db, 'metrics go to Prometheus');
      const rel2 = createRelation(db, c, 'CONTRADICTS', d, 'noise');
      const judge = tableJudge({
        'sessions use JWT': { verdict: 'TRUE_CONFLICT', confidence: 0.95 },
        'logs go to stdout': { verdict: 'UNRELATED', confidence: 0.55 },
      });

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.planned.keep).toBe(2);
      expect(summary.applied).toEqual({});
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS');
      expect(relation(db, rel2.id)?.relation_type).toBe('CONTRADICTS');
      expect(summary.pairs.find((p) => p.relationId === rel2.id)?.reason).toContain('< 0.6');
      expect(fs.existsSync(archive)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('CONTRADICTS: duplicate-shaped pairs are retyped to SUPERSEDES in the judged direction', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'project uses Tailwind CSS');
      const b = mkFact(db, 'project styling may benefit from Tailwind');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'odd label');
      const c = mkFact(db, 'old: comments must be short');
      const d = mkFact(db, 'new: comments must be short and separate harness output from prose');
      const rel2 = createRelation(db, c, 'CONTRADICTS', d, 'odd label');
      const judge = tableJudge({
        'project uses Tailwind CSS': { verdict: 'SUPERSEDED_BY_SOURCE', confidence: 0.9 },
        'old: comments must be short': { verdict: 'SUPERSEDED_BY_TARGET', confidence: 0.9 },
      });

      await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(relation(db, rel.id)).toMatchObject({ relation_type: 'SUPERSEDES', source_fact_id: a, target_fact_id: b });
      expect(relation(db, rel2.id)).toMatchObject({ relation_type: 'SUPERSEDES', source_fact_id: d, target_fact_id: c });
      expect(listActiveConflicts(db, 'SUPERSEDES')).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('SUPERSEDES: retires the redundant fact with a revision row, in either direction', async () => {
    const db = initDatabase();
    try {
      const newer = mkFact(db, 'TeamAI relays Claude and Codex through a Node supervisor');
      const older = mkFact(db, 'TeamClaude relays through a tmux wrapped Node proxy');
      const rel = createRelation(db, newer, 'SUPERSEDES', older, 'replacement');
      const s2 = mkFact(db, 'reversed: the stale one recorded as superseding');
      const t2 = mkFact(db, 'reversed: the actually current claim');
      const rel2 = createRelation(db, s2, 'SUPERSEDES', t2, 'direction flipped');
      const judge = tableJudge({
        'TeamAI relays Claude and Codex through a Node supervisor': { verdict: 'TARGET_REDUNDANT', confidence: 0.95 },
        'reversed: the stale one recorded as superseding': { verdict: 'SOURCE_REDUNDANT', confidence: 0.92 },
      });

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({ deactivated: 2 });
      expect(active(db, older)).toBe(0);
      expect(active(db, newer)).toBe(1);
      expect(active(db, s2)).toBe(0);
      expect(active(db, t2)).toBe(1);
      const rev = db.prepare('SELECT previous_fact, new_fact, reason FROM fact_revisions WHERE fact_id = ?').get(older) as {
        previous_fact: string; new_fact: string; reason: string;
      };
      expect(rev.previous_fact).toContain('TeamClaude');
      expect(rev.new_fact).toContain('TeamAI');
      expect(rev.reason).toContain(newer);
      expect(relation(db, rel.id)?.relation_type).toBe('SUPERSEDES'); // edge stays; it simply leaves the active-active queue
      // The reversed edge now agrees with the verdict: survivor -> retired fact.
      const corrected = db.prepare('SELECT source_fact_id, target_fact_id, reasoning FROM ontology_relations WHERE id = ?').get(rel2.id) as {
        source_fact_id: string; target_fact_id: string; reasoning: string;
      };
      expect(corrected).toMatchObject({ source_fact_id: t2, target_fact_id: s2 });
      expect(corrected.reasoning).toContain('direction corrected');
      expect(listActiveConflicts(db, 'SUPERSEDES')).toHaveLength(0);
      const lines = fs.readFileSync(archive, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.map((l) => l.action)).toEqual(['deactivate', 'deactivate']);
      // Queue order is by relation created_at (ms resolution): two edges created in the same
      // instant may come back in either order, so look the record up instead of indexing.
      expect(lines).toContainEqual(expect.objectContaining({ deactivated_fact_id: older, survivor_fact_id: newer, source_after: null }));
      expect(lines).toContainEqual(expect.objectContaining({ deactivated_fact_id: s2, survivor_fact_id: t2, source_after: t2, target_after: s2 }));
    } finally {
      db.close();
    }
  });

  it('SUPERSEDES: guards keep cross-scope pairs, better-confirmed losers, and sub-threshold verdicts', async () => {
    const db = initDatabase();
    try {
      const g = mkFact(db, 'global: use pnpm');
      const p = mkFact(db, 'project: use pnpm here', { scope_type: 'project', scope_project: '/tmp/proj' });
      createRelation(db, p, 'SUPERSEDES', g, 'cross scope');
      const weakNew = mkFact(db, 'weak new claim', { confirmed: 1 });
      const strongOld = mkFact(db, 'strong old claim', { confirmed: 5 });
      createRelation(db, weakNew, 'SUPERSEDES', strongOld, 'better confirmed loser');
      const a = mkFact(db, 'uncertain newer');
      const b = mkFact(db, 'uncertain older');
      createRelation(db, a, 'SUPERSEDES', b, 'low confidence');
      const judge = tableJudge({
        'project: use pnpm here': { verdict: 'TARGET_REDUNDANT', confidence: 0.99 },
        'weak new claim': { verdict: 'TARGET_REDUNDANT', confidence: 0.99 },
        'uncertain newer': { verdict: 'TARGET_REDUNDANT', confidence: 0.85 },
      });

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({});
      expect(summary.planned.keep).toBe(3);
      for (const id of [g, p, weakNew, strongOld, a, b]) expect(active(db, id)).toBe(1);
      const reasons = summary.pairs.map((x) => x.reason).sort();
      expect(reasons.some((r) => r.includes('cross-scope'))).toBe(true);
      expect(reasons.some((r) => r.includes('better confirmed'))).toBe(true);
      expect(reasons.some((r) => r.includes('< 0.9'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('SUPERSEDES: BOTH_VALID retypes to INFLUENCES and UNRELATED deletes', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'review desk is one unified workspace');
      const b = mkFact(db, 'review desk flows queue → focus → decision gate');
      const rel = createRelation(db, a, 'SUPERSEDES', b, 'design evolution');
      const c = mkFact(db, 'unrelated newer');
      const d = mkFact(db, 'unrelated older');
      const rel2 = createRelation(db, c, 'SUPERSEDES', d, 'noise');
      const judge = tableJudge({
        'review desk is one unified workspace': { verdict: 'BOTH_VALID', confidence: 0.85 },
        'unrelated newer': { verdict: 'UNRELATED', confidence: 0.9 },
      });

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({ retyped: 1, deleted: 1 });
      expect(relation(db, rel.id)?.relation_type).toBe('INFLUENCES');
      expect(relation(db, rel2.id)).toBeUndefined();
      for (const id of [a, b, c, d]) expect(active(db, id)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('writes the audit row in the same transaction; a failing JSONL mirror never loses the record', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'unrelated one');
      const b = mkFact(db, 'unrelated two');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'noise');
      const judge = tableJudge({ 'unrelated one': { verdict: 'UNRELATED', confidence: 0.9 } });
      const archiveAsDir = path.join(testDir, 'archive-is-a-directory');
      fs.mkdirSync(archiveAsDir); // appendFileSync onto a directory fails

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archiveAsDir });

      expect(summary.applied).toEqual({ deleted: 1 });
      expect(summary.archiveErrors).toBe(1);
      expect(relation(db, rel.id)).toBeUndefined();
      const rows = db.prepare('SELECT action, relation_id, verdict, confidence, source_fact FROM relation_resolution_log').all() as Array<Record<string, unknown>>;
      expect(rows).toEqual([{ action: 'delete', relation_id: rel.id, verdict: 'UNRELATED', confidence: 0.9, source_fact: 'unrelated one' }]);
    } finally {
      db.close();
    }
  });

  it('dry-run does not create the log table', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'x1');
      const b = mkFact(db, 'y1');
      createRelation(db, a, 'CONTRADICTS', b, 'n');
      await resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 0, judge: tableJudge({ x1: { verdict: 'UNRELATED', confidence: 0.9 } }), archivePath: archive });
      const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relation_resolution_log'").get();
      expect(t).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('skips a pair whose fact text or confirmation count changed while the judge was thinking', async () => {
    const db = initDatabase();
    try {
      const newer = mkFact(db, 'current claim');
      const older = mkFact(db, 'stale claim');
      createRelation(db, newer, 'SUPERSEDES', older, 'dup');
      const n2 = mkFact(db, 'current claim 2');
      const o2 = mkFact(db, 'stale claim 2');
      createRelation(db, n2, 'SUPERSEDES', o2, 'dup');
      const judge: PairJudge = async (pairs) => {
        // Another process edits the loser's text in one pair and bumps the loser's confirmation count in the other.
        db.prepare('UPDATE facts SET fact = ? WHERE id = ?').run('stale claim, now revised with a new requirement', older);
        db.prepare('UPDATE facts SET consolidated_count = consolidated_count + 1 WHERE id = ?').run(o2);
        return pairs.map((_, i) => ({ pair_index: i, verdict: 'TARGET_REDUNDANT', confidence: 0.99 }));
      };

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({ 'skipped-changed': 2 });
      expect(active(db, older)).toBe(1);
      expect(active(db, o2)).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM relation_resolution_log').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('never retires a fact longer than the judge could see', async () => {
    const db = initDatabase();
    try {
      const longer = mkFact(db, 'shared prefix. ' + 'x'.repeat(2100));
      const shorter = mkFact(db, 'shared prefix. short');
      createRelation(db, shorter, 'SUPERSEDES', longer, 'looks duplicate when truncated');
      const judge = tableJudge({ 'shared prefix. short': { verdict: 'TARGET_REDUNDANT', confidence: 0.99 } });

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({});
      expect(active(db, longer)).toBe(1);
      expect(summary.pairs[0].reason).toContain('longer than the 2000 characters');
    } finally {
      db.close();
    }
  });

  it('a dry run completes on a read-only connection, and an apply on that connection fails instead of writing', async () => {
    const setup = initDatabase();
    const a = mkFact(setup, 'ro one');
    const b = mkFact(setup, 'ro two');
    const rel = createRelation(setup, a, 'CONTRADICTS', b, 'n');
    setup.close();
    const judge = tableJudge({ 'ro one': { verdict: 'UNRELATED', confidence: 0.95 } });

    const ro = openDatabaseReadonly();
    try {
      expect(ro.readonly).toBe(true);
      const summary = await resolveQueue(ro, 'CONTRADICTS', { apply: false, limit: 0, judge, archivePath: archive });
      expect(summary.examined).toBe(1);
      expect(summary.planned.delete).toBe(1);
      // SQLite, not our discipline, is what guarantees the dry run changed nothing.
      await expect(resolveQueue(ro, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive })).rejects.toThrow(/readonly/i);
    } finally {
      ro.close();
    }
    const check = initDatabase();
    try {
      expect(relation(check, rel.id)?.relation_type).toBe('CONTRADICTS');
      expect(check.prepare("SELECT 1 FROM sqlite_master WHERE name = 'relation_resolution_log'").get()).toBeUndefined();
    } finally {
      check.close();
    }
  });

  it('retiring the source when the corrected edge already exists drops the wrong-way edge instead of duplicating it', async () => {
    const db = initDatabase();
    try {
      const stale = mkFact(db, 'stale claim recorded as superseding');
      const current = mkFact(db, 'current claim');
      const wrongWay = createRelation(db, stale, 'SUPERSEDES', current, 'flipped');
      const rightWay = createRelation(db, current, 'SUPERSEDES', stale, 'correct');
      const judge = tableJudge({ 'stale claim recorded as superseding': { verdict: 'SOURCE_REDUNDANT', confidence: 0.95 } });

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });

      // Both edges are active-active pairs; the right-way one is judged too and simply retires nothing new.
      expect(summary.applied.deactivated).toBeGreaterThanOrEqual(1);
      expect(active(db, stale)).toBe(0);
      expect(active(db, current)).toBe(1);
      expect(relation(db, wrongWay.id)).toBeUndefined();
      expect(relation(db, rightWay.id)?.relation_type).toBe('SUPERSEDES');
      const row = db.prepare("SELECT note FROM relation_resolution_log WHERE deactivated_fact_id = ? AND action = 'deactivate'").get(stale) as { note: string };
      expect(row.note).toContain('edge deleted');
    } finally {
      db.close();
    }
  });

  it('unparseable judge output skips the batch without acting and, under apply, is remembered so bounded runs move on', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'x');
      const b = mkFact(db, 'y');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      const judge: PairJudge = async () => null;

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.unparseableBatches).toBe(1);
      expect(summary.judged).toBe(0);
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS');
      const log = db.prepare('SELECT action, note FROM relation_resolution_log').all() as Array<{ action: string; note: string }>;
      expect(log).toEqual([{ action: 'unresolved', note: 'unparseable judge output' }]);
      const again = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });
      expect(again.examined).toBe(0);
      expect(again.previouslyJudged).toBe(1);
      // A dry run never writes: the same failure leaves no row behind.
      const dry = await resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 0, judge, rejudge: true, archivePath: archive });
      expect(dry.unparseableBatches).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM relation_resolution_log').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('skips a pair whose edge or facts changed between the scan and the action', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'a');
      const b = mkFact(db, 'b');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      // Judge that deactivates a fact mid-flight (another process won the race).
      const judge: PairJudge = async (pairs) => {
        db.prepare('UPDATE facts SET is_active = 0 WHERE id = ?').run(b);
        return pairs.map((_, i) => ({ pair_index: i, verdict: 'UNRELATED', confidence: 0.95 }));
      };

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({ 'skipped-changed': 1 });
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS');
      expect(fs.existsSync(archive)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('committee keeps only majority verdicts with the median confidence', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'p');
      const b = mkFact(db, 'q');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      const votes: JudgeVerdict[][] = [
        [{ pair_index: 0, verdict: 'UNRELATED', confidence: 0.95 }],
        [{ pair_index: 0, verdict: 'UNRELATED', confidence: 0.82 }],
        [{ pair_index: 0, verdict: 'TRUE_CONFLICT', confidence: 0.99 }],
      ];
      let call = 0;
      const base: PairJudge = async () => votes[call++] ?? null;
      const judge = committeePairJudge(base, 3, () => 0);

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 0, judge, votes: 1, archivePath: archive });

      expect(call).toBe(3);
      expect(summary.judged).toBe(1);
      // lower median of the two agreeing votes: the committee is as sure as its less-confident half
      expect(summary.pairs[0]).toMatchObject({ relationId: rel.id, verdict: 'UNRELATED', confidence: 0.82, planned: 'delete' });
    } finally {
      db.close();
    }
  });

  it('one very confident vote cannot carry a doubtful agreeing vote past the retirement threshold', async () => {
    const db = initDatabase();
    try {
      const newer = mkFact(db, 'newer');
      const older = mkFact(db, 'older');
      createRelation(db, newer, 'SUPERSEDES', older, 'dup');
      const votes: JudgeVerdict[][] = [
        [{ pair_index: 0, verdict: 'TARGET_REDUNDANT', confidence: 0.1 }],
        [{ pair_index: 0, verdict: 'TARGET_REDUNDANT', confidence: 0.99 }],
        [{ pair_index: 0, verdict: 'BOTH_VALID', confidence: 0.99 }],
      ];
      let call = 0;
      const base: PairJudge = async () => votes[call++] ?? null;
      const judge = committeePairJudge(base, 3, () => 0);

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, votes: 1, archivePath: archive });

      expect(summary.pairs[0]).toMatchObject({ verdict: 'TARGET_REDUNDANT', confidence: 0.1, planned: 'keep' });
      expect(summary.applied).toEqual({});
      expect(active(db, older)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a dry run tolerates an older-shaped log table and re-judges pairs whose snapshot columns are missing', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'alpha');
      const b = mkFact(db, 'beta');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      db.exec(`CREATE TABLE relation_resolution_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, action TEXT NOT NULL,
        relation_id TEXT NOT NULL, relation_type_before TEXT NOT NULL, relation_type_after TEXT,
        source_fact_id TEXT NOT NULL, target_fact_id TEXT NOT NULL, source_after TEXT, target_after TEXT,
        source_fact TEXT NOT NULL, target_fact TEXT NOT NULL, reasoning_before TEXT,
        verdict TEXT NOT NULL, confidence REAL NOT NULL, judge_reasoning TEXT,
        deactivated_fact_id TEXT, survivor_fact_id TEXT, note TEXT)`);
      db.prepare(
        `INSERT INTO relation_resolution_log (ts, action, relation_id, relation_type_before, relation_type_after,
           source_fact_id, target_fact_id, source_fact, target_fact, reasoning_before, verdict, confidence)
         VALUES ('t', 'keep', ?, 'CONTRADICTS', 'CONTRADICTS', ?, ?, 'alpha', 'beta', 'n', 'TRUE_CONFLICT', 0.9)`,
      ).run(rel.id, a, b);
      const judge = tableJudge({ alpha: { verdict: 'UNRELATED', confidence: 0.95 } });

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 0, judge, archivePath: archive });

      expect(summary.examined).toBe(1); // snapshot incomplete → judged again
      expect(summary.planned.delete).toBe(1);
      const cols = (db.prepare('PRAGMA table_info(relation_resolution_log)').all() as Array<{ name: string }>).length;
      expect(cols).toBe(19); // dry run left the old shape alone
      expect(relation(db, rel.id)).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('a vote that contradicts itself on a pair counts for neither verdict', async () => {
    const db = initDatabase();
    try {
      const newer = mkFact(db, 'n');
      const older = mkFact(db, 'o');
      createRelation(db, newer, 'SUPERSEDES', older, 'dup');
      const votes: JudgeVerdict[][] = [
        [{ pair_index: 0, verdict: 'TARGET_REDUNDANT', confidence: 0.99 }, { pair_index: 0, verdict: 'BOTH_VALID', confidence: 0.99 }],
        [{ pair_index: 0, verdict: 'TARGET_REDUNDANT', confidence: 0.99 }],
        [{ pair_index: 0, verdict: 'BOTH_VALID', confidence: 0.99 }],
      ];
      let call = 0;
      const judge = committeePairJudge(async () => votes[call++] ?? null, 3, () => 0);

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, votes: 1, archivePath: archive });

      expect(summary.judged).toBe(0);
      expect(summary.applied).toEqual({});
      expect(active(db, older)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('out-of-range confidences are excluded from the tally instead of clamped', async () => {
    const db = initDatabase();
    try {
      const newer = mkFact(db, 'n2');
      const older = mkFact(db, 'o2');
      createRelation(db, newer, 'SUPERSEDES', older, 'dup');
      const votes: JudgeVerdict[][] = [
        [{ pair_index: 0, verdict: 'TARGET_REDUNDANT', confidence: 0.1 }],
        [{ pair_index: 0, verdict: 'TARGET_REDUNDANT', confidence: 90 }],
        [{ pair_index: 0, verdict: 'BOTH_VALID', confidence: 0.99 }],
      ];
      let call = 0;
      const judge = committeePairJudge(async () => votes[call++] ?? null, 3, () => 0);

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, votes: 1, archivePath: archive });

      expect(summary.judged).toBe(0); // 0.1 is the only valid TARGET_REDUNDANT vote: no majority
      expect(active(db, older)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a single judge that returns two verdicts for one pair yields no action', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'c1');
      const b = mkFact(db, 'c2');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      const judge: PairJudge = async () => [
        { pair_index: 0, verdict: 'UNRELATED', confidence: 0.95 },
        { pair_index: 0, verdict: 'TRUE_CONFLICT', confidence: 0.9 },
      ];

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.judged).toBe(0);
      expect(summary.spoiledPairs).toBe(1);
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS');
    } finally {
      db.close();
    }
  });

  it('null or scalar elements in the judge array are ignored, not fatal, and later batches still run', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'first unrelated');
      const b = mkFact(db, 'first other');
      const rel1 = createRelation(db, a, 'CONTRADICTS', b, 'n');
      const c = mkFact(db, 'second unrelated');
      const d = mkFact(db, 'second other');
      const rel2 = createRelation(db, c, 'CONTRADICTS', d, 'n');
      let call = 0;
      // Batch size 1 → two batches. The first answer is garbage-shaped, the second is valid.
      const judge: PairJudge = async () => {
        call++;
        if (call === 1) return [null, 'text', 42, [1, 2]] as unknown as JudgeVerdict[];
        return [{ pair_index: 0, verdict: 'UNRELATED', confidence: 0.95 }];
      };

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, batchSize: 1, judge, archivePath: archive });

      expect(call).toBe(2);
      expect(summary.judged).toBe(1);
      expect(summary.applied).toEqual({ deleted: 1 });
      // Exactly one of the two edges was deleted (which one depends on queue order).
      expect([relation(db, rel1.id), relation(db, rel2.id)].filter((r) => r === undefined)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('a self-referential edge never retires its only fact', async () => {
    const db = initDatabase();
    try {
      const only = mkFact(db, 'the only fact');
      db.prepare(
        `INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
         VALUES ('self-edge', ?, 'SUPERSEDES', ?, 'self', ?)`,
      ).run(only, only, new Date().toISOString());
      const judge = tableJudge({ 'the only fact': { verdict: 'TARGET_REDUNDANT', confidence: 0.99 } });

      const summary = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({});
      expect(active(db, only)).toBe(1);
      expect(summary.pairs[0].reason).toContain('self-referential');
    } finally {
      db.close();
    }
  });

  it('skips a pair whose edge reasoning was corrected while the judge was thinking', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'r1');
      const b = mkFact(db, 'r2');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'original explanation');
      const judge: PairJudge = async (pairs) => {
        db.prepare('UPDATE ontology_relations SET reasoning = ? WHERE id = ?').run('corrected explanation', rel.id);
        return pairs.map((_, i) => ({ pair_index: i, verdict: 'UNRELATED', confidence: 0.95 }));
      };

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({ 'skipped-changed': 1 });
      expect(relation(db, rel.id)?.reasoning).toBe('corrected explanation');
    } finally {
      db.close();
    }
  });

  it('bounded apply runs walk the queue: already-judged pairs are skipped unless rejudge is set', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'kept one');
      const b = mkFact(db, 'kept two');
      const kept = createRelation(db, a, 'CONTRADICTS', b, 'real');
      const c = mkFact(db, 'noise one');
      const d = mkFact(db, 'noise two');
      const noise = createRelation(db, c, 'CONTRADICTS', d, 'noise');
      const judge = tableJudge({
        'kept one': { verdict: 'TRUE_CONFLICT', confidence: 0.95 },
        'noise one': { verdict: 'UNRELATED', confidence: 0.95 },
      });

      const first = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 1, judge, archivePath: archive });
      const second = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 1, judge, archivePath: archive });

      expect(first.judged + second.judged).toBe(2);
      // Queue order between two edges created in the same instant is undefined: if the first
      // run took the noise pair it was deleted, so nothing is left to skip in the second run.
      expect(second.previouslyJudged).toBe(first.pairs[0].relationId === kept.id ? 1 : 0);
      expect(new Set([first.pairs[0].relationId, second.pairs[0].relationId])).toEqual(new Set([kept.id, noise.id]));
      expect(relation(db, kept.id)?.relation_type).toBe('CONTRADICTS');
      expect(relation(db, noise.id)).toBeUndefined();
      const log = db.prepare('SELECT action, relation_id FROM relation_resolution_log ORDER BY id').all() as Array<{ action: string; relation_id: string }>;
      expect(log.map((l) => l.action).sort()).toEqual(['delete', 'keep']);

      // A third bounded run has nothing left; --rejudge brings the kept pair back.
      const third = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 1, judge, archivePath: archive });
      expect(third.examined).toBe(0);
      expect(third.previouslyJudged).toBe(1);
      const again = await resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 1, rejudge: true, judge, archivePath: archive });
      expect(again.examined).toBe(1);
      expect(again.pairs[0].relationId).toBe(kept.id);
    } finally {
      db.close();
    }
  });

  it('a kept pair is re-examined once a fact or the edge reasoning changes, and a keep row needs an unchanged pair', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'kept A');
      const b = mkFact(db, 'kept B');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'real');
      const judge = tableJudge({ 'kept A': { verdict: 'TRUE_CONFLICT', confidence: 0.95 } });

      const first = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });
      expect(first.judged).toBe(1);
      const second = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });
      expect(second.examined).toBe(0);

      db.prepare('UPDATE facts SET fact = ? WHERE id = ?').run('kept B, corrected', b);
      const third = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });
      expect(third.examined).toBe(1); // the edited pair is new again
      expect(third.previouslyJudged).toBe(0);

      // A keep verdict for a pair that changed while the judge was thinking writes no row.
      db.prepare('UPDATE ontology_relations SET reasoning = ? WHERE id = ?').run('fresh reasoning', rel.id);
      const racing: PairJudge = async (pairs) => {
        db.prepare('UPDATE ontology_relations SET reasoning = ? WHERE id = ?').run('changed again mid-judge', rel.id);
        return pairs.map((_, i) => ({ pair_index: i, verdict: 'TRUE_CONFLICT', confidence: 0.95 }));
      };
      const rowsBefore = (db.prepare('SELECT COUNT(*) AS n FROM relation_resolution_log').get() as { n: number }).n;
      const fourth = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge: racing, archivePath: archive });
      expect(fourth.applied).toEqual({ 'skipped-changed': 1 });
      expect((db.prepare('SELECT COUNT(*) AS n FROM relation_resolution_log').get() as { n: number }).n).toBe(rowsBefore);
    } finally {
      db.close();
    }
  });

  it('a CONTRADICTS edge retyped to SUPERSEDES is still examined by the next supersedes run', async () => {
    const db = initDatabase();
    try {
      const newer = mkFact(db, 'project uses Tailwind CSS now');
      const older = mkFact(db, 'project may adopt Tailwind');
      const rel = createRelation(db, newer, 'CONTRADICTS', older, 'odd label');
      const contradictsJudge = tableJudge({ 'project uses Tailwind CSS now': { verdict: 'SUPERSEDED_BY_SOURCE', confidence: 0.9 } });
      await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge: contradictsJudge, archivePath: archive });
      expect(relation(db, rel.id)?.relation_type).toBe('SUPERSEDES');

      const supersedesJudge = tableJudge({ 'project uses Tailwind CSS now': { verdict: 'TARGET_REDUNDANT', confidence: 0.95 } });
      const second = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge: supersedesJudge, archivePath: archive });

      expect(second.examined).toBe(1);
      expect(second.previouslyJudged).toBe(0);
      expect(second.applied).toEqual({ deactivated: 1 });
      expect(active(db, older)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('retyping to SUPERSEDES never creates a bidirectional pair: a reverse edge leaves the pair for a human', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'claim A');
      const b = mkFact(db, 'claim B');
      createRelation(db, b, 'SUPERSEDES', a, 'B replaced A (recorded earlier)');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'odd label');
      const judge = tableJudge({ 'claim A': { verdict: 'SUPERSEDED_BY_SOURCE', confidence: 0.9 } }); // committee says A supersedes B

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.applied).toEqual({ 'skipped-conflicting-edge': 1 });
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS');
      expect(db.prepare("SELECT COUNT(*) AS n FROM ontology_relations WHERE relation_type = 'SUPERSEDES'").get()).toEqual({ n: 1 });
      // Remembered as unresolved (nothing changed), so a bounded run does not stall on this pair.
      const log = db.prepare('SELECT action, note FROM relation_resolution_log').all() as Array<{ action: string; note: string }>;
      expect(log).toHaveLength(1);
      expect(log[0].action).toBe('unresolved');
      expect(log[0].note).toContain('skipped-conflicting-edge');
      const again = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });
      expect(again.examined).toBe(0);
      expect(again.previouslyJudged).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a kept pair is re-examined when a confirmation count, category, or scope changes', async () => {
    const db = initDatabase();
    try {
      const newer = mkFact(db, 'newer claim', { confirmed: 1 });
      const older = mkFact(db, 'older claim', { confirmed: 3 }); // better confirmed: kept by policy
      createRelation(db, newer, 'SUPERSEDES', older, 'dup');
      const judge = tableJudge({ 'newer claim': { verdict: 'TARGET_REDUNDANT', confidence: 0.95 } });

      const first = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });
      expect(first.planned.keep).toBe(1);
      expect((await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive })).examined).toBe(0);

      // The survivor gains confirmations: the policy outcome can change, so the pair is new again.
      db.prepare('UPDATE facts SET consolidated_count = 5 WHERE id = ?').run(newer);
      const third = await resolveQueue(db, 'SUPERSEDES', { apply: true, limit: 0, judge, archivePath: archive });
      expect(third.examined).toBe(1);
      expect(third.applied).toEqual({ deactivated: 1 });
      expect(active(db, older)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('a pair with no usable committee verdict is counted as spoiled and, under apply, remembered so bounded runs move on', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'stuck one');
      const b = mkFact(db, 'stuck two');
      createRelation(db, a, 'CONTRADICTS', b, 'n');
      const c = mkFact(db, 'noise one');
      const d = mkFact(db, 'noise two');
      const noise = createRelation(db, c, 'CONTRADICTS', d, 'n');
      // Three votes, three different verdicts for the stuck pair → no consensus; the noise pair is clear.
      let call = 0;
      const base: PairJudge = async (pairs) =>
        pairs.map((p, i) => {
          if (p.source.fact === 'noise one') return { pair_index: i, verdict: 'UNRELATED', confidence: 0.95 };
          const cycle = ['TRUE_CONFLICT', 'UNRELATED', 'RELATED_NOT_CONFLICTING'];
          return { pair_index: i, verdict: cycle[call++ % 3], confidence: 0.9 };
        });
      const judge = committeePairJudge(base, 3, () => 0);

      const first = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 1, judge, votes: 1, archivePath: archive });
      const second = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 1, judge, votes: 1, archivePath: archive });

      expect(first.spoiledPairs + second.spoiledPairs).toBe(1);
      expect(first.judged + second.judged).toBe(1);
      expect(relation(db, noise.id)).toBeUndefined();
      const log = db.prepare('SELECT action FROM relation_resolution_log ORDER BY id').all() as Array<{ action: string }>;
      expect(log.map((l) => l.action).sort()).toEqual(['delete', 'unresolved']);
      const third = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 1, judge, votes: 1, archivePath: archive });
      expect(third.examined).toBe(0); // the unresolved pair no longer stalls the queue
      expect(third.previouslyJudged).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a vote whose call throws is a missing vote: the remaining majority still decides and the run continues', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'first');
      const b = mkFact(db, 'second');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      let call = 0;
      const base: PairJudge = async (pairs) => {
        call++;
        if (call === 2) throw new Error('LLM returned an empty response (attempt 3/3)');
        return pairs.map((_, i) => ({ pair_index: i, verdict: 'UNRELATED', confidence: 0.95 }));
      };
      const errors: string[] = [];
      const judge = committeePairJudge(base, 3, () => 0, (e) => errors.push(e instanceof Error ? e.message : String(e)));

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, votes: 1, archivePath: archive });

      expect(call).toBe(3);
      expect(errors).toHaveLength(1);
      expect(summary.judged).toBe(1);
      expect(summary.applied).toEqual({ deleted: 1 });
      expect(relation(db, rel.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('a batch where every vote fails is left for a later run: no abort, no unresolved row, later pairs still judged', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'newest pair one');
      const b = mkFact(db, 'newest pair two');
      createRelation(db, a, 'CONTRADICTS', b, 'n');
      const c = mkFact(db, 'older pair one');
      const d = mkFact(db, 'older pair two');
      const older = createRelation(db, c, 'CONTRADICTS', d, 'n');
      // The judge fails for any batch containing the newest pair and answers normally otherwise.
      const judge: PairJudge = async (pairs) => {
        if (pairs.some((p) => p.source.fact === 'newest pair one')) throw new Error('service unavailable');
        return pairs.map((_, i) => ({ pair_index: i, verdict: 'UNRELATED', confidence: 0.95 }));
      };

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, votes: 3, batchSize: 1, archivePath: archive });

      expect(summary.judgeFailures).toBe(3);
      expect(summary.unavailableBatches).toBe(1);
      expect(summary.unparseableBatches).toBe(0);
      expect(summary.judged).toBe(1);
      expect(relation(db, older.id)).toBeUndefined();
      const log = db.prepare('SELECT action FROM relation_resolution_log').all() as Array<{ action: string }>;
      expect(log.map((l) => l.action)).toEqual(['delete']); // the unavailable batch left nothing behind
      // The untouched pair is picked up again by the next run.
      const again = await resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 0, judge, votes: 1, archivePath: archive });
      expect(again.examined).toBe(1);
    } finally {
      db.close();
    }
  });

  it('when too few votes arrive for a majority the batch is left for a later run, not recorded as unresolved', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'quorum one');
      const b = mkFact(db, 'quorum two');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      let call = 0;
      // votes=3: two calls fail, one valid vote arrives → 1 < majority 2.
      const base: PairJudge = async (pairs) => {
        call++;
        if (call !== 2) throw new Error('service unavailable');
        return pairs.map((_, i) => ({ pair_index: i, verdict: 'UNRELATED', confidence: 0.95 }));
      };
      const second = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge: base, votes: 3, archivePath: archive });
      expect(call).toBe(3);
      expect(second.judgeFailures).toBe(2);
      expect(second.unavailableBatches).toBe(1);
      expect(second.spoiledPairs).toBe(0);
      expect(second.judged).toBe(0);
      expect(relation(db, rel.id)).toBeDefined();
      expect((db.prepare('SELECT COUNT(*) AS n FROM relation_resolution_log').get() as { n: number }).n).toBe(0);

      // Service is back: the pair is picked up again and acted on.
      const healthy: PairJudge = async (pairs) => pairs.map((_, i) => ({ pair_index: i, verdict: 'UNRELATED', confidence: 0.95 }));
      const third = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge: healthy, votes: 3, archivePath: archive });
      expect(third.examined).toBe(1);
      expect(third.applied).toEqual({ deleted: 1 });
    } finally {
      db.close();
    }
  });

  it('a disagreement with one vote missing is spoiled but not remembered: the missing voice might have decided it', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'partial one');
      const b = mkFact(db, 'partial two');
      createRelation(db, a, 'CONTRADICTS', b, 'n');
      let call = 0;
      const base: PairJudge = async (pairs) => {
        call++;
        if (call === 1) throw new Error('timeout');
        const verdict = call === 2 ? 'UNRELATED' : 'TRUE_CONFLICT';
        return pairs.map((_, i) => ({ pair_index: i, verdict, confidence: 0.9 }));
      };

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge: base, votes: 3, archivePath: archive });

      expect(summary.judgeFailures).toBe(1);
      expect(summary.unavailableBatches).toBe(0); // quorum (2 of 3) was reached, they just disagreed
      expect(summary.spoiledPairs).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM relation_resolution_log').get() as { n: number }).n).toBe(0);
      const again = await resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 0, judge: base, votes: 1, archivePath: archive });
      expect(again.examined).toBe(1);
    } finally {
      db.close();
    }
  });

  it('a failed vote mixed with unreadable votes is not remembered either: the pair is picked up again after recovery', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'mixed one');
      const b = mkFact(db, 'mixed two');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      let call = 0;
      // votes=3: one call throws, the other two return unparseable output → committee null.
      const base: PairJudge = async () => {
        call++;
        if (call === 1) throw new Error('timeout');
        return null;
      };

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge: base, votes: 3, archivePath: archive });

      expect(summary.judgeFailures).toBe(1);
      expect(summary.unparseableBatches).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM relation_resolution_log').get() as { n: number }).n).toBe(0);
      const healthy: PairJudge = async (pairs) => pairs.map((_, i) => ({ pair_index: i, verdict: 'UNRELATED', confidence: 0.95 }));
      const again = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge: healthy, votes: 3, archivePath: archive });
      expect(again.examined).toBe(1);
      expect(relation(db, rel.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('with a single vote a throwing judge is also survived', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'lone one');
      const b = mkFact(db, 'lone two');
      createRelation(db, a, 'CONTRADICTS', b, 'n');
      const judge: PairJudge = async () => {
        throw new Error('boom');
      };
      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, votes: 1, archivePath: archive });
      expect(summary.judgeFailures).toBe(1);
      expect(summary.unavailableBatches).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM relation_resolution_log').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('replan from log: a recorded keep whose verdict now clears the policy is acted on without any model call', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'kept at the old bar');
      const b = mkFact(db, 'its partner');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      const c = mkFact(db, 'true conflict A');
      const d = mkFact(db, 'true conflict B');
      const conflict = createRelation(db, c, 'CONTRADICTS', d, 'n');
      // Simulate the earlier policy: the committee said "related, not conflicting" at 0.7 and the
      // run recorded keep (the old threshold was 0.8). TRUE_CONFLICT stays for a human either way.
      const judge = tableJudge({
        'kept at the old bar': { verdict: 'RELATED_NOT_CONFLICTING', confidence: 0.7 },
        'true conflict A': { verdict: 'TRUE_CONFLICT', confidence: 0.9 },
      });
      // Run with a policy snapshot that keeps 0.7: emulate by recording directly, then replan.
      await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });
      // Both pairs are recorded; the 0.7 pair was already retyped by today's policy, so rewind it to a keep row
      // to model "judged under a stricter policy" without re-running the committee.
      db.prepare("UPDATE ontology_relations SET relation_type = 'CONTRADICTS', reasoning = 'n' WHERE id = ?").run(rel.id);
      db.prepare("UPDATE relation_resolution_log SET action = 'keep', relation_type_after = 'CONTRADICTS', source_after = NULL, target_after = NULL, note = 'confidence 0.7 < 0.8', reasoning_before = 'n' WHERE relation_id = ?").run(rel.id);
      const never: PairJudge = async () => {
        throw new Error('the replan must not call the judge');
      };

      const dry = replanFromLog(db, 'CONTRADICTS', { archivePath: archive, apply: false });
      expect(dry.source).toBe('log');
      expect(dry.judged).toBe(2);
      expect(dry.planned).toEqual({ keep: 1, retype: 1, delete: 0, deactivate: 0 });
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS'); // dry run changed nothing

      const applied = replanFromLog(db, 'CONTRADICTS', { archivePath: archive, apply: true });
      expect(applied.applied).toEqual({ retyped: 1 });
      expect(relation(db, rel.id)?.relation_type).toBe('INFLUENCES');
      expect(relation(db, conflict.id)?.relation_type).toBe('CONTRADICTS');
      const row = db.prepare("SELECT judge_reasoning FROM relation_resolution_log WHERE relation_id = ? AND action = 'retype'").get(rel.id) as { judge_reasoning: string };
      expect(row.judge_reasoning).toContain('[replanned from log #');
      // Nothing is left to replan: the retyped edge is no longer a CONTRADICTS pair, the conflict stays keep.
      const again = replanFromLog(db, 'CONTRADICTS', { archivePath: archive, apply: true });
      expect(again.judged).toBe(1);
      expect(again.applied).toEqual({});
      // And the regular judged path was never needed for this.
      await expect(resolveQueue(db, 'CONTRADICTS', { apply: false, limit: 0, judge: never, votes: 1, archivePath: archive })).resolves.toMatchObject({ examined: 0 });
    } finally {
      db.close();
    }
  });

  it('replan from log skips a pair whose inputs changed since the committee judged it, and ignores rows without a verdict', async () => {
    const db = initDatabase();
    try {
      const a = mkFact(db, 'changed since');
      const b = mkFact(db, 'partner');
      const rel = createRelation(db, a, 'CONTRADICTS', b, 'n');
      const judge = tableJudge({ 'changed since': { verdict: 'UNRELATED', confidence: 0.55 } }); // kept under today's policy
      await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });
      // The committee's confidence would clear a lower bar, but the fact text moved on.
      db.prepare('UPDATE facts SET fact = ? WHERE id = ?').run('changed since (edited)', a);
      db.prepare('UPDATE relation_resolution_log SET confidence = 0.95 WHERE relation_id = ?').run(rel.id);

      const summary = replanFromLog(db, 'CONTRADICTS', { archivePath: archive, apply: true });

      expect(summary.judged).toBe(0);
      expect(summary.previouslyJudged).toBe(1);
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS');

      // An unresolved row (no verdict) is never replanned.
      const c = mkFact(db, 'no verdict one');
      const d = mkFact(db, 'no verdict two');
      const stuck = createRelation(db, c, 'CONTRADICTS', d, 'n');
      const none: PairJudge = async () => null;
      await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge: none, archivePath: archive });
      const second = replanFromLog(db, 'CONTRADICTS', { archivePath: archive, apply: true });
      expect(second.judged).toBe(0);
      expect(relation(db, stuck.id)?.relation_type).toBe('CONTRADICTS');
    } finally {
      db.close();
    }
  });

  it('parseIntegerOption accepts only whole-string safe integers', () => {
    expect(parseIntegerOption('0', 0)).toBe(0);
    expect(parseIntegerOption(' 200 ', 0)).toBe(200);
    expect(parseIntegerOption('0.5', 0)).toBeNull();
    expect(parseIntegerOption('1e3', 1)).toBeNull();
    expect(parseIntegerOption('-1', 0)).toBeNull();
    expect(parseIntegerOption('0', 1)).toBeNull();
    expect(parseIntegerOption(undefined, 0)).toBeNull();
    expect(parseIntegerOption('99999999999999999999', 0)).toBeNull();
  });

  it('resolveModelId maps SDK aliases to full ids and passes full ids through', () => {
    expect(resolveModelId('sonnet')).toBe('claude-sonnet-5');
    expect(resolveModelId(' Haiku ')).toBe('claude-haiku-4-5-20251001');
    expect(resolveModelId('opus')).toBe('claude-opus-5-5');
    expect(resolveModelId('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelId('my-proxy-model')).toBe('my-proxy-model');
  });

  it('planAction is a pure policy: thresholds pin the edge/deactivate asymmetry', () => {
    const slim = (id: string, fact: string, confirmed = 1, scope: [string, string | null] = ['global', null]) => ({
      id, fact, category: 'decision', scope_type: scope[0], scope_project: scope[1], consolidated_count: confirmed, created_at: '2026-10-01T00:00:00Z',
    });
    const pair = (relationType: 'CONTRADICTS' | 'SUPERSEDES') => ({
      relationId: 'r', relationType, reasoning: null, createdAt: '2026-10-01T00:00:00Z', source: slim('s', 'S'), target: slim('t', 'T'),
    });
    expect(planAction(pair('CONTRADICTS'), 'UNRELATED', 0.6).kind).toBe('delete');
    expect(planAction(pair('CONTRADICTS'), 'UNRELATED', 0.59).kind).toBe('keep');
    expect(planAction(pair('CONTRADICTS'), 'RELATED_NOT_CONFLICTING', 0.6).kind).toBe('retype');
    expect(planAction(pair('CONTRADICTS'), 'TRUE_CONFLICT', 1).kind).toBe('keep');
    expect(planAction(pair('SUPERSEDES'), 'TARGET_REDUNDANT', 0.9)).toMatchObject({ kind: 'deactivate', loserId: 't', survivorId: 's' });
    expect(planAction(pair('SUPERSEDES'), 'TARGET_REDUNDANT', 0.89).kind).toBe('keep');
    expect(planAction(pair('SUPERSEDES'), 'SOURCE_REDUNDANT', 0.95)).toMatchObject({ kind: 'deactivate', loserId: 's', survivorId: 't' });
    expect(planAction(pair('SUPERSEDES'), 'UNCLEAR', 1).kind).toBe('keep');
  });
});
