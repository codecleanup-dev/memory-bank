import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { buildReembedPending } from '../src/reembed-selector.js';

// A tiny real vec0-backed DB so the NOT EXISTS set-diff against the vec0 shadow
// `_rowids` table is exercised for real (not mocked) — that shadow table is the
// exact mechanism the stamp-vector-mismatch self-heal depends on.
describe('buildReembedPending', () => {
  let db: Database.Database;
  const PREFIXES = ['You are a WORKER PROMPT alpha', 'ANOTHER worker lead beta'];

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    db.exec(`CREATE TABLE exchanges (
      id TEXT PRIMARY KEY, user_message TEXT, assistant_message TEXT,
      embedding_version INTEGER, timestamp TEXT
    )`);
    db.exec('CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding int8[384])');
  });
  afterEach(() => db.close());

  const add = (id: string, um: string, version: number, withVector: boolean) => {
    db.prepare('INSERT INTO exchanges VALUES (?,?,?,?,?)').run(id, um, 'a', version, '2026-01-01');
    if (withVector) {
      const buf = Buffer.from(new Int8Array(384).fill(1).buffer);
      db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, vec_int8(?))').run(id, buf);
    }
  };

  const selected = (): string[] => {
    const { clause, params } = buildReembedPending(3, PREFIXES);
    return (db.prepare(`SELECT e.id FROM exchanges e WHERE ${clause} ORDER BY e.id`).all(...params) as Array<{ id: string }>)
      .map((r) => r.id);
  };

  it('selects stale-version rows (a)', () => {
    add('stale', 'a real user message about bugs', 2, true); // version 2 != 3
    add('current', 'another real message', 3, true);
    expect(selected()).toEqual(['stale']);
  });

  it('selects current-version rows that are MISSING their vector (b) — stamp-vector mismatch', () => {
    add('novec', 'real message with no vector row', 3, false); // version 3 but no vec row
    add('ok', 'real message fully indexed', 3, true);
    expect(selected()).toEqual(['novec']);
  });

  it('EXCLUDES worker-prompt rows even when they are missing a vector', () => {
    add('junk', PREFIXES[0] + ' trailing detail', 3, false); // pollution: no vector, would self-heal
    add('junk2', PREFIXES[1] + ' more', 2, false);           // pollution AND stale
    add('real', 'a genuine user question', 3, false);         // real missing-vector row
    expect(selected()).toEqual(['real']); // junk/junk2 must NOT be re-embedded
  });

  it('a healthy corpus (all current + vectored, no pollution) selects nothing', () => {
    add('a', 'msg one', 3, true);
    add('b', 'msg two', 3, true);
    expect(selected()).toEqual([]);
  });

  it('params order is [version, then (len, prefix) per worker prompt]', () => {
    const { params } = buildReembedPending(3, PREFIXES);
    expect(params[0]).toBe(3);
    expect(params.slice(1)).toEqual([PREFIXES[0].length, PREFIXES[0], PREFIXES[1].length, PREFIXES[1]]);
  });

  it('empty prefix list excludes nothing (degenerate guard)', () => {
    add('novec', 'real', 3, false);
    const { clause, params } = buildReembedPending(3, []);
    const ids = (db.prepare(`SELECT e.id FROM exchanges e WHERE ${clause}`).all(...params) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['novec']);
  });
});
