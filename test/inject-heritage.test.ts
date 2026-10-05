import { describe, it, expect } from 'vitest';
import { suppressConsole } from './test-utils.js';
import {
  DEFAULT_HERITAGE_CUTOFF,
  HERITAGE_REFETCH_FACTOR,
  heritageCutoff,
  isHeritageFact,
  selectInjectCandidates,
} from '../src/inject-core.js';

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
 * 유효한 fact 가 밀려난다. fetch 를 주입해 그 경로를 고정한다. 순위가 낮을수록 뒤에 온다.
 */
describe('selectInjectCandidates (slot-stealing guard)', () => {
  const cutoff = '2026-05-01';
  const TOP_K = 5;
  const heritage = (i: number) => ({ fact: { id: `h${i}`, created_at: '2026-04-01' }, distance: 0.1 + i * 0.01 });
  const recent = (i: number) => ({ fact: { id: `r${i}`, created_at: '2026-09-01' }, distance: 0.2 + i * 0.01 });
  // 전체 순위: 유산 5개가 상위, 그 뒤에 최신 fact 6개
  const ranked = [heritage(0), heritage(1), heritage(2), heritage(3), heritage(4),
    recent(0), recent(1), recent(2), recent(3), recent(4), recent(5)];
  const fetchRanked = (calls: number[]) => (limit: number) => { calls.push(limit); return ranked.slice(0, limit); };

  it('top-K all heritage → refetches with a wider limit and returns the next valid facts', () => {
    const calls: number[] = [];
    const r = selectInjectCandidates(fetchRanked(calls), TOP_K, cutoff);
    expect(calls).toEqual([TOP_K, TOP_K * HERITAGE_REFETCH_FACTOR]);
    expect(r.refetched).toBe(true);
    expect(r.candidates.map((c) => c.fact.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']); // sliced to TOP_K, order kept
    expect(r.heritageExcluded).toBe(5);
  });

  it('partially heritage → refetch fills the slots; the post-filter list never exceeds TOP_K', () => {
    const calls: number[] = [];
    const mixed = [recent(0), heritage(0), recent(1), heritage(1), recent(2), recent(3), recent(4), recent(5)];
    const r = selectInjectCandidates((limit) => { calls.push(limit); return mixed.slice(0, limit); }, TOP_K, cutoff);
    expect(calls).toEqual([TOP_K, TOP_K * HERITAGE_REFETCH_FACTOR]);
    expect(r.candidates.map((c) => c.fact.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(r.heritageExcluded).toBe(2);
  });

  it('no heritage in the first fetch → single fetch, nothing dropped', () => {
    const calls: number[] = [];
    const clean = [recent(0), recent(1), recent(2), recent(3), recent(4), heritage(0)];
    const r = selectInjectCandidates((limit) => { calls.push(limit); return clean.slice(0, limit); }, TOP_K, cutoff);
    expect(calls).toEqual([TOP_K]);
    expect(r.refetched).toBe(false);
    expect(r.heritageExcluded).toBe(0);
    expect(r.candidates).toHaveLength(5);
  });

  it('filter disabled (null cutoff) → heritage is kept and no refetch happens', () => {
    const calls: number[] = [];
    const r = selectInjectCandidates(fetchRanked(calls), TOP_K, null);
    expect(calls).toEqual([TOP_K]);
    expect(r.candidates.map((c) => c.fact.id)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4']);
    expect(r.heritageExcluded).toBe(0);
  });

  it('refetch is bounded to one extra query even when the wider window is still all heritage', () => {
    const calls: number[] = [];
    const allHeritage = Array.from({ length: 60 }, (_, i) => heritage(i));
    const r = selectInjectCandidates((limit) => { calls.push(limit); return allHeritage.slice(0, limit); }, TOP_K, cutoff);
    expect(calls).toHaveLength(2);
    expect(r.candidates).toEqual([]);
    expect(r.heritageExcluded).toBe(TOP_K * HERITAGE_REFETCH_FACTOR);
  });
});
