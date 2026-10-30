import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_CLI = path.join(__dirname, '..', 'dist', 'sync-cli.js');

// 2026-10-30 regression: the singleton lock is ~/.claude/run-locks/memory-bank-sync.lock,
// created with a non-recursive mkdir. On a machine where nothing else had created
// ~/.claude/run-locks, mkdir failed with ENOENT, which the lock code reads as "held",
// so every sync printed "Sync already running" and exited 0. Indexing on one Mac stayed
// frozen from 2026-07-04 to 2026-10-30 while every log line looked healthy.
describe.skipIf(process.platform === 'win32')('sync singleton lock parent directory', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'sync-lock-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('runs a sync when ~/.claude/run-locks does not exist yet', () => {
    expect(existsSync(path.join(home, '.claude', 'run-locks'))).toBe(false);

    const res = spawnSync(process.execPath, [SYNC_CLI], {
      env: { PATH: process.env.PATH, HOME: home },
      timeout: 60000,
      encoding: 'utf8',
    });

    expect(res.error).toBeUndefined();
    expect(res.stdout).not.toContain('Sync already running');
    expect(res.stdout).toContain('Sync complete');
    expect(existsSync(path.join(home, '.claude', 'run-locks'))).toBe(true);
    // The lock itself is released on exit.
    expect(existsSync(path.join(home, '.claude', 'run-locks', 'memory-bank-sync.lock'))).toBe(false);
  });

  it('fails non-zero instead of reporting "already running" when the lock cannot be created', () => {
    // A plain file where the run-locks directory should be: mkdir can never succeed.
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'run-locks'), 'not a directory');

    const res = spawnSync(process.execPath, [SYNC_CLI], {
      env: { PATH: process.env.PATH, HOME: home },
      timeout: 60000,
      encoding: 'utf8',
    });

    expect(res.error).toBeUndefined();
    expect(res.status).not.toBe(0);
    expect(res.stdout).not.toContain('Sync already running');
    expect(res.stderr).toContain('Cannot create sync lock');
  });
});
