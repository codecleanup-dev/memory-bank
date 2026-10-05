import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_SYNC_MIN_INTERVAL_MS,
  lastSyncAgeMs,
  minIntervalMs,
  recordSyncCompletion,
  shouldSkipBackgroundSync,
} from '../src/sync-cooldown.js';

/** upstream 10bec9e 손 포팅 — 순수 함수만 고정한다 (sync-cli 는 import 시 실행되는 CLI 라 직접 시험하지 않는다). */
describe('sync cooldown (upstream 10bec9e port)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-cooldown-'));
  const file = path.join(dir, 'run-locks', 'memory-bank-sync.last');
  const now = 1_700_000_000_000;

  it('interval: default 600s, env override, 0 disables, invalid or out-of-range → default', () => {
    expect(minIntervalMs({})).toBe(DEFAULT_SYNC_MIN_INTERVAL_MS);
    expect(minIntervalMs({ MEMORY_BANK_SYNC_MIN_INTERVAL_S: '30' })).toBe(30_000);
    expect(minIntervalMs({ MEMORY_BANK_SYNC_MIN_INTERVAL_S: '0' })).toBe(0);
    expect(minIntervalMs({ MEMORY_BANK_SYNC_MIN_INTERVAL_S: '' })).toBe(DEFAULT_SYNC_MIN_INTERVAL_MS);
    expect(minIntervalMs({ MEMORY_BANK_SYNC_MIN_INTERVAL_S: 'abc' })).toBe(DEFAULT_SYNC_MIN_INTERVAL_MS);
    expect(minIntervalMs({ MEMORY_BANK_SYNC_MIN_INTERVAL_S: '-5' })).toBe(DEFAULT_SYNC_MIN_INTERVAL_MS);
    expect(minIntervalMs({ MEMORY_BANK_SYNC_MIN_INTERVAL_S: '1.5' })).toBe(DEFAULT_SYNC_MIN_INTERVAL_MS);
    expect(minIntervalMs({ MEMORY_BANK_SYNC_MIN_INTERVAL_S: '100000' })).toBe(DEFAULT_SYNC_MIN_INTERVAL_MS);
  });

  it('no stamp → run; fresh stamp → skip; stale stamp → run; future stamp → run', () => {
    expect(lastSyncAgeMs(file, now)).toBeNull();
    expect(shouldSkipBackgroundSync(file, {}, now).skip).toBe(false);

    recordSyncCompletion(file, now - 60_000);
    expect(shouldSkipBackgroundSync(file, {}, now)).toEqual({ skip: true, ageS: 60, minS: 600 });

    recordSyncCompletion(file, now - 601_000);
    expect(shouldSkipBackgroundSync(file, {}, now).skip).toBe(false);

    recordSyncCompletion(file, now + 60_000);
    expect(lastSyncAgeMs(file, now)).toBeNull();
    expect(shouldSkipBackgroundSync(file, {}, now).skip).toBe(false);
  });

  it('interval 0 disables the skip even with a fresh stamp; a garbage stamp never skips', () => {
    recordSyncCompletion(file, now - 1_000);
    expect(shouldSkipBackgroundSync(file, { MEMORY_BANK_SYNC_MIN_INTERVAL_S: '0' }, now).skip).toBe(false);
    fs.writeFileSync(file, 'not-a-number');
    expect(lastSyncAgeMs(file, now)).toBeNull();
    expect(shouldSkipBackgroundSync(file, {}, now).skip).toBe(false);
  });

  it('recordSyncCompletion creates the parent directory and writes the epoch', () => {
    const fresh = path.join(dir, 'deeper', 'nested', 'memory-bank-sync.last');
    recordSyncCompletion(fresh, now);
    expect(fs.readFileSync(fresh, 'utf8')).toBe(String(now));
  });
});
