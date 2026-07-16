import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  parseLockMeta,
  decideTakeover,
  staleWorkerVersion,
  isSyncCliCommand,
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
    expect(parseLockMeta('36387\n')).toEqual({ pid: 36387, version: null, startedAt: null, script: null });
  });

  it('parses the JSON form', () => {
    const raw = JSON.stringify({ pid: 123, version: '1.4.4', startedAt: 1770000000000 });
    expect(parseLockMeta(raw)).toEqual({ pid: 123, version: '1.4.4', startedAt: 1770000000000, script: null });
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
    expect(meta).toEqual({ pid: 42, version: null, startedAt: null, script: null });
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

  it('preempts a wedged same-version holder, but never DOWNGRADES onto a newer one', () => {
    expect(decideTakeover({ pid: 9, version: '1.4.4', startedAt: null }, '1.4.4', 23 * HOUR, WEDGE)).toBe(
      'takeover-wedged',
    );
    // An older contender defers to a newer wedged holder: killing it would
    // resume indexing on older code, and sync fires at every SessionStart so
    // the newer plugin's own next session recovers the wedge instead.
    expect(decideTakeover({ pid: 9, version: '1.5.0', startedAt: null }, '1.4.4', 23 * HOUR, WEDGE)).toBe(
      'defer',
    );
  });

  it('defers to a newer holder and to unknown runtime', () => {
    expect(decideTakeover({ pid: 9, version: '1.5.0', startedAt: null }, '1.4.4', HOUR, WEDGE)).toBe('defer');
    expect(decideTakeover({ pid: 9, version: '1.4.4', startedAt: null }, '1.4.4', null, WEDGE)).toBe('defer');
    // Never downgrade: an OLDER contender must not preempt a NEWER wedged holder.
    expect(decideTakeover({ pid: 9, version: '1.6.0', startedAt: null }, '1.5.0', 7 * 60 * 60 * 1000, WEDGE)).toBe('defer');
    // Same-version wedged holder IS preempted (recovery path).
    expect(decideTakeover({ pid: 9, version: '1.6.0', startedAt: null }, '1.6.0', 7 * 60 * 60 * 1000, WEDGE)).toBe('takeover-wedged');
  });
});

describe('parseLockMeta script identity', () => {
  it('parses the self-declared entry script and defaults to null', () => {
    const withScript = parseLockMeta(JSON.stringify({ pid: 7, version: '1.6.0', startedAt: 1, script: '/a/dist/sync-cli.js' }));
    expect(withScript?.script).toBe('/a/dist/sync-cli.js');
    const without = parseLockMeta(JSON.stringify({ pid: 7, version: '1.6.0', startedAt: 1 }));
    expect(without?.script).toBeNull();
    expect(parseLockMeta('1234')?.script).toBeNull(); // legacy bare pid
  });
});

describe('compareVersions prerelease ordering', () => {
  it('a prerelease sorts below its release (semver 11)', () => {
    expect(compareVersions('1.6.0-beta.1', '1.6.0')).toBe(-1);
    expect(compareVersions('1.6.0', '1.6.0-beta.1')).toBe(1);
    expect(compareVersions('1.6.0-beta.1', '1.6.0-beta.1')).toBe(0);
    expect(compareVersions('1.6.0-alpha', '1.6.0-beta')).toBe(-1);
    expect(compareVersions('1.6.1-beta.1', '1.6.0')).toBe(1); // core wins first
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

  it('rejects cache-path look-alikes outside the real cache root', () => {
    const real = '/Users/u/.claude/plugins/cache/memory-bank-dev/memory-bank';
    expect(staleWorkerVersion(`node ${real}/1.0.0/scripts/reembed-worker.js`, '1.6.0', real)).toBe('1.0.0');
    // Same SHAPE under a different root — outside the runtime-anchored cache.
    expect(staleWorkerVersion('node /tmp/x/plugins/cache/memory-bank-dev/memory-bank/1.0.0/scripts/reembed-worker.js', '1.6.0', real)).toBeNull();
  });

  it('never matches processes that only CARRY a worker path as inert argv', () => {
    // Executable is not node — editor/grep holding the path as data.
    expect(staleWorkerVersion(`vim ${CACHE}/1.3.3/dist/sync-cli.js`, '1.4.4')).toBeNull();
    expect(staleWorkerVersion(`grep -r drift ${CACHE}/1.3.3/scripts/reembed-worker.js`, '1.4.4')).toBeNull();
    // Node, but the worker path is a LATER argument, not the executed script.
    expect(staleWorkerVersion(`node /tmp/inspect.js ${CACHE}/1.3.3/dist/sync-cli.js`, '1.4.4')).toBeNull();
    // Executable merely ENDS with "node" (foonode) — not a node binary.
    expect(staleWorkerVersion(`/opt/foonode ${CACHE}/1.3.3/dist/sync-cli.js`, '1.4.4')).toBeNull();
  });

  it('matches with an absolute node path and node flags', () => {
    expect(staleWorkerVersion(`/usr/local/bin/node --max-old-space-size=4096 ${CACHE}/1.3.3/scripts/reembed-worker.js`, '1.4.4')).toBe('1.3.3');
    expect(staleWorkerVersion(`/Users/u/.nvm/versions/node/v22.22.3/bin/node ${CACHE}/1.4.0/dist/sync-cli.js --background`, '1.4.4')).toBe('1.4.0');
  });
});

describe('isSyncCliCommand (pid-recycle kill gate)', () => {
  it('matches real sync-cli holders', () => {
    expect(isSyncCliCommand('node /Users/u/.claude/plugins/cache/memory-bank-dev/memory-bank/1.5.0/dist/sync-cli.js')).toBe(true);
    expect(isSyncCliCommand('/usr/local/bin/node --max-old-space-size=4096 /repo/memory-bank/dist/sync-cli.js --background')).toBe(true);
    expect(isSyncCliCommand('node /repo/memory-bank/cli/memory-bank.js sync --background')).toBe(true);
  });

  it('never matches recycled pids that merely carry the substrings as data', () => {
    expect(isSyncCliCommand('node /tmp/sync-cli-helper.js memory-bank')).toBe(false); // reviewer repro
    expect(isSyncCliCommand('vim /repo/memory-bank/dist/sync-cli.js')).toBe(false);
    expect(isSyncCliCommand('node /repo/app.js /x/dist/sync-cli.js')).toBe(false); // later arg, not the script
    expect(isSyncCliCommand('node /repo/memory-bank/cli/memory-bank.js search sync-cli')).toBe(false); // wrong subcommand
    expect(isSyncCliCommand('grep -r sync-cli /repo/memory-bank')).toBe(false);
    expect(isSyncCliCommand('node /other-app/dist/sync-cli.js')).toBe(false); // no memory-bank marker — unrelated app's own sync-cli.js
    expect(isSyncCliCommand('node /tmp/not-memory-bank/dist/sync-cli.js')).toBe(false); // look-alike segment must not count as the marker
    expect(isSyncCliCommand('node /other-app/cli/tool.js sync')).toBe(false);
  });
});
