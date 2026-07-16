#!/usr/bin/env node

/**
 * SessionStart Hook: version drift guard.
 *
 * A plugin update must not leave old-version processes running (2026-07-14
 * incident: after v1.4.3 shipped, a v1.3.3 sync-cli wedged 23h kept indexing
 * frozen and stale-version workers kept spawning).
 *
 * This hook, running from the NEWEST installed version at every session start:
 *  1. Sweeps detached memory-bank workers (sync-cli / backfill / consolidate /
 *     extract / reembed) that run from an OLDER versioned plugin cache dir.
 *     Their work is idempotent and re-fired on every session start, so killing
 *     a stale one loses nothing. MCP servers are never touched — they belong
 *     to live sessions and only rotate on session restart.
 *  2. Emits a drift warning to stdout (= session context) when the plugin
 *     cache contains a newer version than the one this session is running,
 *     so "update installed but session not restarted" is loudly visible.
 *
 * Progress/errors go to stderr; stdout is reserved for context injection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { staleWorkerVersion, compareVersions } from '../dist/version-guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function myVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}

/** Re-read this pid's ppid+command and confirm it is STILL a stale orphaned
 * worker — called immediately before EVERY signal to shrink the pid-reuse
 * (TOCTOU) window: the original ps snapshot may be seconds old, and a worker
 * that exited naturally could have its pid recycled by an unrelated process. */
function stillStaleOrphan(pid, version) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' });
    const m = /^\s*(\d+)\s+(.*)$/.exec(out.trim());
    if (!m) return false;
    if (parseInt(m[1], 10) !== 1) return false;
    return staleWorkerVersion(m[2], version) !== null;
  } catch {
    return false; // pid gone (or ps failed) — nothing to kill
  }
}

async function killAndConfirm(pid, version) {
  if (!stillStaleOrphan(pid, version)) return !pidAlive(pid);
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!pidAlive(pid)) return true;
  }
  if (!stillStaleOrphan(pid, version)) return !pidAlive(pid);
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  return !pidAlive(pid);
}

async function main() {
  const version = myVersion();
  if (!version) return;

  // 1) Sweep stale-version detached workers.
  let psOut = '';
  try {
    psOut = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return; // no ps — nothing enforceable, stay silent
  }
  const swept = [];
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    const stale = staleWorkerVersion(m[3], version);
    if (!stale) continue;
    // Only ORPHANED processes (reparented to init/launchd) are swept: stale
    // detached workers were spawned detached+unref'd and their short-lived
    // spawner hook is long gone by the time a newer session starts, so their
    // ppid is 1. A process that merely RUNS an old worker path under a live
    // parent (manual debugging, a shell child, a supervisor) is left alone —
    // the sweep only ever reaps daemons nobody owns. (Cross-user kills are
    // impossible anyway: signalling another uid's pid fails with EPERM.)
    if (ppid !== 1) {
      console.error(`[memory-bank drift] stale v${stale} candidate pid=${pid} skipped (attached, ppid=${ppid})`);
      continue;
    }
    const dead = await killAndConfirm(pid, version);
    swept.push({ pid, stale, dead });
    console.error(`[memory-bank drift] stale v${stale} worker pid=${pid} ${dead ? 'terminated' : 'TERMINATION FAILED'}`);
  }
  if (swept.length > 0) {
    const failed = swept.filter((s) => !s.dead);
    console.log(
      `[memory-bank] swept ${swept.length - failed.length} stale-version worker(s) (running < v${version})` +
        (failed.length ? ` — FAILED to stop pid(s): ${failed.map((f) => f.pid).join(', ')}` : ''),
    );
  }

  // 2) Drift visibility: newer version present in the plugin cache than the
  //    one THIS session runs (i.e. update landed but session not restarted,
  //    or install record lags the cache).
  const cacheBase = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.claude', 'plugins', 'cache', 'memory-bank-dev', 'memory-bank',
  );
  try {
    const versions = fs
      .readdirSync(cacheBase)
      .filter((d) => /^\d+(\.\d+)*$/.test(d))
      .sort(compareVersions);
    const newest = versions.at(-1);
    if (newest && compareVersions(version, newest) < 0) {
      console.log(
        `[memory-bank] version drift: this session runs v${version} but v${newest} is installed. ` +
          `Restart the session (or run: claude plugin update memory-bank@memory-bank-dev) to apply.`,
      );
    }
  } catch {
    /* no cache dir (dev checkout) — skip */
  }
}

main().catch((e) => {
  console.error(`[memory-bank drift] ${e && e.message ? e.message : e}`);
});
