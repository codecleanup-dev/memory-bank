import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { suppressConsole } from './test-utils.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { EMBEDDING_VERSION } from '../src/embeddings.js';
import { HERITAGE_DOC_PATTERN, isHeritageFact } from '../src/heritage.js';

suppressConsole();

const cutoff = '2026-05-01';
const memDoc = ['memory-doc:auto-memory/-Users-x/10-cognitive-architecture-and-self-model.md#3:abc'];

/**
 * [fork v1] 날짜 컷오프의 구멍: 2026-05-17 에 memory-doc 레인이 다시 색인한 원작자 번호 문서(실측 10건)는
 * 컷오프 뒤 날짜라 주입됐다. 번호 접두 + memory-doc 출처 두 조건으로 잡고, 원작자를 주제로 삼은 사용자
 * 본인의 fact 는 건드리지 않는다.
 */
describe('heritage doc rule (re-indexed author documents)', () => {
  it('numbered author doc + memory-doc source → heritage even after the cutoff', () => {
    expect(isHeritageFact({
      created_at: '2026-05-17T00:00:00.000Z',
      fact: '10-cognitive-architecture-and-self-model memory — Hugh의 인지 아키텍처와 자기 모델 / 1. 반왜곡',
      source_exchange_ids: memDoc,
    }, cutoff)).toBe(true);
    expect(isHeritageFact({
      created_at: '2026-09-01',
      fact: '05-report-and-handoff-format memory — Hugh의 보고/전달 포맷 기준',
      source_exchange_ids: memDoc,
    }, cutoff)).toBe(true);
  });

  it('same title from a non memory-doc source (or no source) is not heritage', () => {
    const title = '10-cognitive-architecture-and-self-model memory — x';
    expect(isHeritageFact({ created_at: '2026-09-01', fact: title, source_exchange_ids: ['session:abc'] }, cutoff)).toBe(false);
    expect(isHeritageFact({ created_at: '2026-09-01', fact: title, source_exchange_ids: [] }, cutoff)).toBe(false);
    expect(isHeritageFact({ created_at: '2026-09-01', fact: title }, cutoff)).toBe(false);
  });

  it("the user's own facts about the author (no numbered prefix) are not heritage", () => {
    expect(isHeritageFact({ created_at: '2026-08-10', fact: 'hugh-corpus-v0 memory — 원작자 코퍼스 v0 설계', source_exchange_ids: memDoc }, cutoff)).toBe(false);
    expect(isHeritageFact({ created_at: '2026-08-10', fact: 'hughsoft-diorama-site memory — 사이트 구조', source_exchange_ids: memDoc }, cutoff)).toBe(false);
    expect(isHeritageFact({ created_at: '2026-09-13', fact: 'Hugh 공개 원칙과 BS 회사 자산을 섞지 않는다', source_exchange_ids: ['session:x'] }, cutoff)).toBe(false);
  });

  it('pattern bounds: 01..10 only, lowercase slug, then the word memory', () => {
    expect(HERITAGE_DOC_PATTERN.test('01-communication-style memory — x')).toBe(true);
    expect(HERITAGE_DOC_PATTERN.test('10-cognitive-architecture-and-self-model memory: x')).toBe(true);
    expect(HERITAGE_DOC_PATTERN.test('11-something memory — x')).toBe(false);
    expect(HERITAGE_DOC_PATTERN.test('00-something memory — x')).toBe(false);
    expect(HERITAGE_DOC_PATTERN.test('05-report memories — x')).toBe(false);
    expect(HERITAGE_DOC_PATTERN.test(' 05-report memory — leading space')).toBe(false);
  });

  it('the date rule still applies on its own, and a null cutoff disables both rules', () => {
    expect(isHeritageFact({ created_at: '2026-04-20', fact: 'anything', source_exchange_ids: ['session:x'] }, cutoff)).toBe(true);
    expect(isHeritageFact({ created_at: '2026-05-17', fact: '10-cognitive-architecture-and-self-model memory — x', source_exchange_ids: memDoc }, null)).toBe(false);
  });
});

/** [fork v1] 벡터 없는 fact 는 스탬프 0 — 재임베딩 워커(embedding_version != current)가 집어 간다. */
describe('insertFact embedding_version stamp', () => {
  let db: Database.Database;
  const testDir = path.join(os.tmpdir(), 'heritage-stamp-test-' + Date.now());
  const base = { category: 'knowledge', scope_type: 'global', scope_project: null, source_exchange_ids: [] as string[] };

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
    db = initDatabase();
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('no vector → 0 so the resumable reembed worker picks it up', () => {
    const id = insertFact(db, { ...base, fact: 'text only', embedding: null });
    expect(db.prepare('SELECT embedding_version AS v FROM facts WHERE id = ?').get(id)).toEqual({ v: 0 });
  });

  it('with a vector → current model version (unchanged behaviour)', () => {
    const v = new Array(384).fill(0);
    v[7] = 1;
    const id = insertFact(db, { ...base, fact: 'with vector', embedding: v });
    expect(db.prepare('SELECT embedding_version AS v FROM facts WHERE id = ?').get(id)).toEqual({ v: EMBEDDING_VERSION });
  });
});
