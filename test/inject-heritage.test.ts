import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';
import { initDatabase } from '../src/db.js';
import { insertFact, searchSimilarFacts } from '../src/fact-db.js';
import { DEFAULT_HERITAGE_CUTOFF, heritageCutoff, isHeritageFact } from '../src/inject-core.js';

suppressConsole();

/**
 * [fork v0-3] 유산 컷오프 — 원작자 수입 fact 를 세션 주입에서만 제외하는 결정론 필터.
 * 순수 함수만 고정한다. DB·임베딩 경로는 inject-core 의 기존 계약(surprise.test 와 같은 패턴).
 */
describe('heritageCutoff (env)', () => {
  it('unset → default 2026-05-01', () => {
    expect(DEFAULT_HERITAGE_CUTOFF).toBe('2026-05-01');
    expect(heritageCutoff({})).toBe('2026-05-01');
  });

  it('ISO date override is honoured', () => {
    expect(heritageCutoff({ MEMORY_BANK_INJECT_HERITAGE_CUTOFF: '2026-06-15' })).toBe('2026-06-15');
    expect(heritageCutoff({ MEMORY_BANK_INJECT_HERITAGE_CUTOFF: '  2026-06-15  ' })).toBe('2026-06-15');
  });

  it("'' or 'off' disables the filter", () => {
    expect(heritageCutoff({ MEMORY_BANK_INJECT_HERITAGE_CUTOFF: '' })).toBeNull();
    expect(heritageCutoff({ MEMORY_BANK_INJECT_HERITAGE_CUTOFF: 'off' })).toBeNull();
    expect(heritageCutoff({ MEMORY_BANK_INJECT_HERITAGE_CUTOFF: 'OFF' })).toBeNull();
  });

  it('malformed value falls back to the default (not to "inject everything")', () => {
    expect(heritageCutoff({ MEMORY_BANK_INJECT_HERITAGE_CUTOFF: 'yesterday' })).toBe('2026-05-01');
    expect(heritageCutoff({ MEMORY_BANK_INJECT_HERITAGE_CUTOFF: '2026-5-1' })).toBe('2026-05-01');
  });
});

describe('isHeritageFact', () => {
  const cutoff = '2026-05-01';

  it('created before the cutoff → heritage', () => {
    expect(isHeritageFact({ created_at: '2026-04-30T23:59:59.000Z' }, cutoff)).toBe(true);
    expect(isHeritageFact({ created_at: '2026-03-25' }, cutoff)).toBe(true);
  });

  it('created on or after the cutoff → not heritage', () => {
    expect(isHeritageFact({ created_at: '2026-05-01T00:00:00.000Z' }, cutoff)).toBe(false);
    expect(isHeritageFact({ created_at: '2026-10-05T01:02:03.000Z' }, cutoff)).toBe(false);
  });

  it('missing or malformed created_at is never treated as heritage', () => {
    expect(isHeritageFact({ created_at: '' }, cutoff)).toBe(false);
    expect(isHeritageFact({ created_at: null }, cutoff)).toBe(false);
    expect(isHeritageFact({}, cutoff)).toBe(false);
    expect(isHeritageFact({ created_at: '2026' }, cutoff)).toBe(false);
  });

  it('null cutoff (filter disabled) → never heritage', () => {
    expect(isHeritageFact({ created_at: '2026-03-25' }, null)).toBe(false);
  });
});

/**
 * 적대 리뷰 HIGH (2026-10-05): TOP_K 뒤에서 걸러내면 유산이 슬롯을 차지해 바로 다음 순위의
 * 유효한 fact 가 밀려난다. 그래서 컷오프는 searchSimilarFacts 의 후보 walk 안에서 적용된다.
 * 실제 vec 테이블로 고정한다: 유산 5개가 질의와 거리 0 으로 최상위를 차지하고, 최신 fact 3개가
 * 그 뒤에 온다. limit 3 이면 유산 없이 최신 3개가 전부 나와야 한다.
 */
describe('searchSimilarFacts minCreatedAt (search-stage exclusion)', () => {
  let db: Database.Database;
  const testDir = path.join(os.tmpdir(), 'inject-heritage-test-' + Date.now());
  const dbPath = path.join(testDir, 'test.db');
  const cutoff = '2026-05-01';

  /** Deterministic 384-dim one-hot vectors: identical → distance 0, distinct → √2. */
  function oneHot(index: number): number[] {
    const v = new Array(384).fill(0);
    v[index % 384] = 1;
    return v;
  }
  function insertAt(fact: string, vecIndex: number, createdAt: string): string {
    const id = insertFact(db, {
      fact, category: 'decision', scope_type: 'global', scope_project: null,
      source_exchange_ids: [], embedding: oneHot(vecIndex),
    });
    db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(createdAt, id);
    return id;
  }

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = dbPath;
    db = initDatabase();
    for (let i = 0; i < 5; i++) insertAt(`heritage ${i}`, 0, '2026-04-0' + (i + 1) + 'T00:00:00.000Z');
    for (let i = 0; i < 3; i++) insertAt(`recent ${i}`, 1, '2026-09-0' + (i + 1) + 'T00:00:00.000Z');
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('heritage rows ranked above the limit do not consume slots; recent rows fill them', () => {
    const stats = { heritageSkipped: 0 };
    const r = searchSimilarFacts(db, oneHot(0), null, 3, 0, { minCreatedAt: cutoff, stats });
    expect(r.map((x) => x.fact.fact).sort()).toEqual(['recent 0', 'recent 1', 'recent 2']); // 동거리 행의 순서는 미정의 — 집합으로 비교
    expect(stats.heritageSkipped).toBe(5);
    expect(r.every((x) => !isHeritageFact(x.fact, cutoff))).toBe(true);
  });

  it('without the option the heritage rows win the slots (baseline behaviour unchanged)', () => {
    const r = searchSimilarFacts(db, oneHot(0), null, 3, 0);
    expect(r.map((x) => x.fact.fact).every((f) => f.startsWith('heritage '))).toBe(true); expect(r).toHaveLength(3);
  });

  it('minCreatedAt null (filter disabled) behaves like the baseline and records nothing', () => {
    const stats = { heritageSkipped: 0 };
    const r = searchSimilarFacts(db, oneHot(0), null, 3, 0, { minCreatedAt: null, stats });
    expect(r.map((x) => x.fact.fact).every((f) => f.startsWith('heritage '))).toBe(true); expect(r).toHaveLength(3);
    expect(stats.heritageSkipped).toBe(0);
  });

  it('stats is optional: skipping still works without a counter', () => {
    const r = searchSimilarFacts(db, oneHot(0), null, 5, 0, { minCreatedAt: cutoff });
    expect(r.map((x) => x.fact.fact).sort()).toEqual(['recent 0', 'recent 1', 'recent 2']); // 동거리 행의 순서는 미정의 — 집합으로 비교
  });
});
