import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  parseLockMeta,
  decideTakeover,
  staleWorkerVersion,
} from '../src/version-guard.js';

const CACHE = '/Users/u/.claude/plugins/cache/memory-bank-dev/memory-bank';

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.3.3', '1.4.3')).toBe(-1);
    expect(compareVersions('1.4.3', '1.3.3')).toBe(1);
    expect(compareVersions('1.4.3', '1.4.3')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1); // lexical sort would say 1.10 < 1.9
  });

  it('treats missing parts as 0', () => {
    expect(compareVersions('1.4', '1.4.0')).toBe(0);
    expect(compareVersions('1.4', '1.4.1')).toBe(-1);
  });
});

describe('parseLockMeta', () => {
  it('parses the legacy bare-pid form (≤1.4.3)', () => {
    expect(parseLockMeta('36387\n')).toEqual({ pid: 36387, version: null, startedAt: null });
  });

  it('parses the JSON form', () => {
    const raw = JSON.stringify({ pid: 123, version: '1.4.4', startedAt: 1770000000000 });
    expect(parseLockMeta(raw)).toEqual({ pid: 123, version: '1.4.4', startedAt: 1770000000000 });
  });

  it('rejects garbage, empty, and pid<=1 (never kill init)', () => {
    expect(parseLockMeta('')).toBeNull();
    expect(parseLockMeta('not-a-pid')).toBeNull();
    expect(parseLockMeta('{broken json')).toBeNull();
    expect(parseLockMeta('1')).toBeNull();
    expect(parseLockMeta(JSON.stringify({ pid: 0, version: '1.4.4' }))).toBeNull();
  });

  it('normalizes malformed JSON fields to null', () => {
    const meta = parseLockMeta(JSON.stringify({ pid: 42, version: 7, startedAt: 'yesterday' }));
    expect(meta).toEqual({ pid: 42, version: null, startedAt: null });
  });
});

describe('decideTakeover', () => {
  const HOUR = 60 * 60 * 1000;
  const WEDGE = 6 * HOUR;

  it('preempts an older-version holder immediately', () => {
    expect(
      decideTakeover({ pid: 9, version: '1.3.3', startedAt: null }, '1.4.4', 60_000, WEDGE),
    ).toBe('takeover-stale-version');
  });

  it('treats a legacy no-version lock as older by construction', () => {
    expect(decideTakeover({ pid: 9, version: null, startedAt: null }, '1.4.4', null, WEDGE)).toBe(
      'takeover-stale-version',
    );
  });

  it('defers to a same-version holder within the wedge cap', () => {
    expect(decideTakeover({ pid: 9, version: '1.4.4', startedAt: null }, '1.4.4', HOUR, WEDGE)).toBe('defer');
  });

  it('preempts a wedged holder regardless of version (starvation is worse)', () => {
    expect(decideTakeover({ pid: 9, version: '1.4.4', startedAt: null }, '1.4.4', 23 * HOUR, WEDGE)).toBe(
      'takeover-wedged',
    );
    expect(decideTakeover({ pid: 9, version: '1.5.0', startedAt: null }, '1.4.4', 23 * HOUR, WEDGE)).toBe(
      'takeover-wedged',
    );
  });

  it('defers to a newer holder and to unknown runtime', () => {
    expect(decideTakeover({ pid: 9, version: '1.5.0', startedAt: null }, '1.4.4', HOUR, WEDGE)).toBe('defer');
    expect(decideTakeover({ pid: 9, version: '1.4.4', startedAt: null }, '1.4.4', null, WEDGE)).toBe('defer');
  });
});

describe('staleWorkerVersion', () => {
  it('matches older-version detached workers', () => {
    expect(staleWorkerVersion(`node ${CACHE}/1.3.3/dist/sync-cli.js`, '1.4.4')).toBe('1.3.3');
    expect(staleWorkerVersion(`node ${CACHE}/1.3.3/scripts/backfill-extract-worker.js`, '1.4.4')).toBe('1.3.3');
    expect(staleWorkerVersion(`node ${CACHE}/1.4.0/scripts/fact-consolidate-worker.js`, '1.4.4')).toBe('1.4.0');
    expect(staleWorkerVersion(`node ${CACHE}/1.2.2/scripts/reembed-worker.js`, '1.4.4')).toBe('1.2.2');
  });

  it('never matches same or newer versions', () => {
    expect(staleWorkerVersion(`node ${CACHE}/1.4.4/dist/sync-cli.js`, '1.4.4')).toBeNull();
    expect(staleWorkerVersion(`node ${CACHE}/1.5.0/dist/sync-cli.js`, '1.4.4')).toBeNull();
  });

  it('never matches MCP servers or wrappers (owned by live sessions)', () => {
    expect(staleWorkerVersion(`node ${CACHE}/1.3.3/dist/mcp-server.js`, '1.4.4')).toBeNull();
    expect(staleWorkerVersion(`node ${CACHE}/1.3.3/cli/mcp-server-wrapper.js`, '1.4.4')).toBeNull();
  });

  it('never matches unrelated processes or dev checkouts', () => {
    expect(staleWorkerVersion('node /Users/u/Project/Claude/memory-bank/dist/sync-cli.js', '1.4.4')).toBeNull();
    expect(staleWorkerVersion('node /some/other/app/sync-cli.js', '1.4.4')).toBeNull();
    expect(staleWorkerVersion('grep memory-bank', '1.4.4')).toBeNull();
  });
});
