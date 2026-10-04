import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { createRelation } from '../src/ontology-db.js';
import { listActiveConflicts } from '../src/consistency.js';
import {
  committeePairJudge,
  planAction,
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
        'logs go to stdout': { verdict: 'UNRELATED', confidence: 0.6 },
      });

      const summary = await resolveQueue(db, 'CONTRADICTS', { apply: true, limit: 0, judge, archivePath: archive });

      expect(summary.planned.keep).toBe(2);
      expect(summary.applied).toEqual({});
      expect(relation(db, rel.id)?.relation_type).toBe('CONTRADICTS');
      expect(relation(db, rel2.id)?.relation_type).toBe('CONTRADICTS');
      expect(summary.pairs.find((p) => p.relationId === rel2.id)?.reason).toContain('< 0.8');
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
      createRelation(db, s2, 'SUPERSEDES', t2, 'direction flipped');
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
      expect(listActiveConflicts(db, 'SUPERSEDES')).toHaveLength(0);
      const lines = fs.readFileSync(archive, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.map((l) => l.action)).toEqual(['deactivate', 'deactivate']);
      // Queue order is by relation created_at (ms resolution): two edges created in the same
      // instant may come back in either order, so look the record up instead of indexing.
      expect(lines).toContainEqual(expect.objectContaining({ deactivated_fact_id: older, survivor_fact_id: newer }));
      expect(lines).toContainEqual(expect.objectContaining({ deactivated_fact_id: s2, survivor_fact_id: t2 }));
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

  it('unparseable judge output skips the batch without acting', async () => {
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
      // median of the two agreeing votes (same upper-median rule as principle-check's committee)
      expect(summary.pairs[0]).toMatchObject({ relationId: rel.id, verdict: 'UNRELATED', confidence: 0.95, planned: 'delete' });
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
    expect(planAction(pair('CONTRADICTS'), 'UNRELATED', 0.8).kind).toBe('delete');
    expect(planAction(pair('CONTRADICTS'), 'UNRELATED', 0.79).kind).toBe('keep');
    expect(planAction(pair('CONTRADICTS'), 'TRUE_CONFLICT', 1).kind).toBe('keep');
    expect(planAction(pair('SUPERSEDES'), 'TARGET_REDUNDANT', 0.9)).toMatchObject({ kind: 'deactivate', loserId: 't', survivorId: 's' });
    expect(planAction(pair('SUPERSEDES'), 'TARGET_REDUNDANT', 0.89).kind).toBe('keep');
    expect(planAction(pair('SUPERSEDES'), 'SOURCE_REDUNDANT', 0.95)).toMatchObject({ kind: 'deactivate', loserId: 's', survivorId: 't' });
    expect(planAction(pair('SUPERSEDES'), 'UNCLEAR', 1).kind).toBe('keep');
  });
});
