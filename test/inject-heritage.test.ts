import { describe, it, expect } from 'vitest';
import { suppressConsole } from './test-utils.js';
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
