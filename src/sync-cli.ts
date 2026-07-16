import { syncConversations } from './sync.js';
import { getArchiveDir, getAgentSources } from './paths.js';
import { parseLockMeta, decideTakeover, isSyncCliCommand, type LockMeta } from './version-guard.js';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: memory-bank sync [--background]

Sync conversations from ~/.claude/projects to archive and index them.

This command:
1. Copies new or updated .jsonl files to conversation archive
2. Generates embeddings for semantic search
3. Updates the search index

Only processes files that are new or have been modified since last sync.
Safe to run multiple times - subsequent runs are fast no-ops.

OPTIONS:
  --background    Run sync in background (for hooks, returns immediately)

EXAMPLES:
  # Sync all new conversations
  memory-bank sync

  # Sync in background (for hooks)
  memory-bank sync --background

  # Use in Claude Code hook
  # In .claude/hooks/session-end:
  memory-bank sync --background
`);
  process.exit(0);
}

// Check if running in background mode
const isBackground = args.includes('--background');

// If background mode, fork the process and exit immediately
if (isBackground) {
  const filteredArgs = args.filter(arg => arg !== '--background');

  // Spawn a detached process
  const child = spawn(process.execPath, [
    process.argv[1], // This script
    ...filteredArgs
  ], {
    detached: true,
    stdio: 'ignore'
  });

  child.unref(); // Allow parent to exit
  console.log('Sync started in background...');
  process.exit(0);
}

// ---- singleton lock (2026-07-02): SessionStart hook fires sync --background on EVERY
// session start; with many concurrent sessions (auto-issue workers, QA cron, interactive)
// detached syncs pile up unbounded (measured: 76 concurrent -> load avg 164).
// Sync is idempotent - if one is already running, later ones can safely skip.
//
// Version takeover + wedge cap (2026-07-14): the lock records {pid, version,
// startedAt}. A v1.3.3 sync wedged for 23h held the bare-pid lock and every
// newer sync skipped — indexing frozen for a day on stale code. Now a newer
// version preempts an older holder, and any holder past WEDGE_MAX_MS is
// preempted regardless of version (normal incremental sync completes in
// minutes; 6h means wedged).
const __lockDir = path.join(os.homedir(), '.claude', 'run-locks', 'memory-bank-sync.lock');
const __pidFile = path.join(__lockDir, 'pid');
const WEDGE_MAX_MS = 6 * 60 * 60 * 1000;

const __myVersion: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
})();

function __pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Pid-recycling guard: only treat the holder as "our" process if its command
 * line matches the lock's SELF-DECLARED identity — the exact entry-script
 * path the creator recorded in its own meta (present as a whole argv token).
 * This is tighter than any path heuristic (an unrelated process never matches
 * a lock it did not create) AND robust to invocation form (wrappers / exotic
 * node flags still carry their own script path). Legacy locks without a
 * recorded script fall back to the anchored isSyncCliCommand heuristic. */
function __isSyncCliProcess(pid: number, expectedScript: string | null): boolean {
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (expectedScript) return cmd.split(/\s+/).includes(expectedScript);
    return isSyncCliCommand(cmd);
  } catch { return false; }
}


/** Process start time (ms epoch), derived from `ps -o etime=` — elapsed time
 * is pure digits ([[dd-]hh:]mm:ss) and locale-independent, unlike lstart
 * (localized month/day names on non-C locales). 1s resolution is plenty for
 * the 60s creator-vs-recycled slack below. */
function __processStartMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(out);
    if (!m) return null;
    const days = parseInt(m[1] ?? '0', 10);
    const hours = parseInt(m[2] ?? '0', 10);
    const elapsedMs = (((days * 24 + hours) * 60 + parseInt(m[3], 10)) * 60 + parseInt(m[4], 10)) * 1000;
    return Date.now() - elapsedMs;
  } catch { return null; }
}

async function __killAndConfirm(pid: number, expectedScript: string | null): Promise<boolean> {
  // Re-verify the holder's command line immediately before EVERY signal — the
  // earlier check is a separate ps read, and a holder that exits in between
  // could have its pid recycled by an unrelated process (TOCTOU). ps-based
  // identity can't be fully atomic with kill(2), but re-checking right before
  // each signal shrinks the window from seconds to microseconds.
  if (!__isSyncCliProcess(pid, expectedScript)) return !__pidAlive(pid);
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (!__pidAlive(pid)) return true;
  }
  if (!__isSyncCliProcess(pid, expectedScript)) return !__pidAlive(pid);
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  return !__pidAlive(pid);
}

/** Acquire-and-install: mkdir(2) is the atomic winner selection — it fails
 * EEXIST for every loser and, unlike rename(2), can never REPLACE an existing
 * (even empty) directory, so a legacy (<=1.5.0) creator paused inside its own
 * mkdir->write gap cannot be silently dispossessed. The pid meta is written
 * immediately after; observers that catch the microsecond meta-less gap
 * grace-defer on young dirs instead of reclaiming (see __acquireLock), and a
 * crash inside the gap simply ages past the grace and is reclaimed as
 * garbage. */
function __installLock(): boolean {
  try {
    fs.mkdirSync(__lockDir, { recursive: false });
  } catch {
    return false; // someone else holds (or just won) the lock
  }
  try {
    fs.writeFileSync(__pidFile, JSON.stringify({ pid: process.pid, version: __myVersion, startedAt: Date.now(), script: process.argv[1] ?? null }));
  } catch { /* meta write failed — readers will grace-defer, then treat as garbage */ }
  return true;
}

function __reclaimLock(expectedPid: number | null): boolean {
  // Atomic takeover: rename(2) is the single mutual-exclusion point — exactly
  // ONE contender can move the lock dir aside; every loser's rename throws
  // (ENOENT) and it must NOT touch the winner's freshly recreated lock. The
  // previous rm+mkdir pair had a window where a second contender's rmSync
  // deleted the winner's brand-new lock and BOTH proceeded as writers.
  const grave = `${__lockDir}.stale.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(__lockDir, grave);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    // The (killed) holder released the lock itself via its ownership-checked
    // cleanup between our decision and the rename — the path is simply free;
    // fall through and recreate. Any OTHER contender that got here first will
    // have recreated the dir already, making our mkdir below fail → defer.
  }
  // Identity check on what we actually captured: between our takeover
  // decision and the rename, ANOTHER contender may have completed its own
  // reclaim and created a FRESH lock — renaming blindly would steal it and
  // run two writers. If the captured lock's pid is not the holder we decided
  // to preempt and that pid is alive, hand it back and defer.
  if (expectedPid !== null) {
    let captured: LockMeta | null = null;
    try { captured = parseLockMeta(fs.readFileSync(path.join(grave, 'pid'), 'utf8')); } catch { /* empty/missing meta — treat as the stale lock we expected */ }
    if (captured && captured.pid !== expectedPid && __pidAlive(captured.pid)) {
      try { fs.renameSync(grave, __lockDir); } catch { try { fs.rmSync(grave, { recursive: true, force: true }); } catch {} }
      return false;
    }
  }
  try { fs.rmSync(grave, { recursive: true, force: true }); } catch { /* leftover grave dir is inert */ }
  // Leave the path ABSENT — the caller finishes with the atomic __installLock,
  // so the lock is never observable in a half-built (meta-less) state.
  return true;
}

async function __acquireLock(): Promise<boolean> {
  if (__installLock()) return true; // fast path: lock was absent
  {
    let raw = '';
    try { raw = fs.readFileSync(__pidFile, 'utf8'); } catch {}
    const holder = parseLockMeta(raw);
    if (!holder || !__pidAlive(holder.pid)) {
      if (!holder) {
        // No/garbage meta. A LEGACY (<=1.5.0) creator writes its pid AFTER
        // mkdir — if the dir is brand new, its creator is likely mid-write:
        // grace-defer instead of reclaiming a live lock out from under it.
        // A crashed half-built lock simply ages past the grace and is then
        // reclaimed as garbage.
        try {
          if (Date.now() - fs.statSync(__lockDir).mtimeMs < 15_000) return false;
        } catch { /* dir vanished — fall through, reclaim will no-op via ENOENT */ }
      }
      // Garbage or dead holder — reclaim (pre-existing behavior).
      if (!__reclaimLock(holder ? holder.pid : null)) return false;
    } else {
      // Live holder: preempt if it runs older code or is wedged.
      let runMs: number | null = holder.startedAt !== null ? Date.now() - holder.startedAt : null;
      if (runMs === null) {
        try { runMs = Date.now() - fs.statSync(__lockDir).mtimeMs; } catch { runMs = null; }
      }
      const decision = decideTakeover(holder, __myVersion, runMs, WEDGE_MAX_MS);
      if (decision === 'defer') return false;
      if (!__isSyncCliProcess(holder.pid, holder.script)) {
        if (!__pidAlive(holder.pid)) {
          // Died between checks — normal dead-holder reclaim.
          if (!__reclaimLock(holder.pid)) return false;
        } else {
          // Live but not recognizable as a sync. Discriminate CREATOR vs
          // RECYCLED pid by process start time: the lock's creator was
          // already running when the lock was born, so an occupant that
          // STARTED AFTER the lock existed cannot be its creator — the pid
          // was recycled and the lock is garbage. Reclaim WITHOUT killing
          // (never signal an unidentified pid); this frees a recycled-pid
          // hostage immediately instead of freezing indexing until a manual
          // rm. If the start time is compatible with lock creation (or
          // unavailable), the process may be a REAL sync behind a wrapper we
          // cannot recognize — fail closed and defer: a second concurrent
          // writer (the original 76-concurrent-sync load incident class) is
          // strictly worse than skipping runs, and killing an unidentified
          // pid is never acceptable.
          const lockBirthMs = holder.startedAt ?? (runMs !== null ? Date.now() - runMs : null);
          const procStartMs = __processStartMs(holder.pid);
          if (lockBirthMs !== null && procStartMs !== null && procStartMs > lockBirthMs + 60_000) {
            console.error(`Sync lock holder pid=${holder.pid} started after the lock was created - recycled pid, reclaiming without kill`);
            if (!__reclaimLock(holder.pid)) return false;
          } else {
            console.error(`Sync lock holder pid=${holder.pid} is alive but not recognizable as a memory-bank sync - deferring (to override manually: rm -rf ~/.claude/run-locks/memory-bank-sync.lock)`);
            return false;
          }
        }
      } else {
        console.log(`Preempting sync lock holder pid=${holder.pid} version=${holder.version ?? 'legacy'} (${decision})`);
        if (!(await __killAndConfirm(holder.pid, holder.script))) {
          console.error(`Failed to terminate lock holder pid=${holder.pid} - skip`);
          return false;
        }
        if (!__reclaimLock(holder.pid)) return false;
      }
    }
  }
  // Reclaim succeeded and left the path absent — finish with the atomic
  // install; if another contender slipped in first, this fails → defer.
  return __installLock();
}

if (!(await __acquireLock())) {
  console.log('Sync already running - skip (singleton lock)');
  process.exit(0);
}
// Ownership-checked release: after a takeover the lock belongs to the
// PREEMPTOR — a dying (preempted) holder must remove the lock only while the
// pid file still records ITS pid, never a successor's fresh lock. If the
// preemptor already renamed the dir away, the read fails → nothing to do.
function __releaseLockIfOwned(): void {
  try {
    const meta = parseLockMeta(fs.readFileSync(__pidFile, 'utf8'));
    if (meta && meta.pid === process.pid) {
      fs.rmSync(__lockDir, { recursive: true, force: true });
    }
  } catch { /* lock gone or unreadable — not ours to release */ }
}
process.on('exit', __releaseLockIfOwned);
// Default signal death skips 'exit' handlers (observed: SIGTERM left a stale
// lock behind). Route signals through process.exit so the lock is released.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => process.exit(143));
}

const destDir = getArchiveDir();
const sources = getAgentSources();

console.log('Syncing conversations...');
console.log(`Sources: ${sources.map(s => `${s.name} (${s.sourceDir})`).join(', ')}`);
console.log(`Destination: ${destDir}\n`);

(async () => {
  const totals = { copied: 0, skipped: 0, indexed: 0, summarized: 0 };
  const errors: Array<{ file: string; error: string }> = [];
  for (const source of sources) {
    // codingAgent override ties every exchange from this source to its agent,
    // so Codex rollouts are stamped coding_agent=codex regardless of parse order.
    const result = await syncConversations(source.sourceDir, destDir, {
      codingAgent: source.name,
      recursive: source.recursive,
    });
    totals.copied += result.copied;
    totals.skipped += result.skipped;
    totals.indexed += result.indexed;
    totals.summarized += result.summarized;
    errors.push(...result.errors);
  }

  console.log(`\n✅ Sync complete!`);
  console.log(`  Copied: ${totals.copied}`);
  console.log(`  Skipped: ${totals.skipped}`);
  console.log(`  Indexed: ${totals.indexed}`);
  console.log(`  Summarized: ${totals.summarized}`);

  if (errors.length > 0) {
    console.log(`\n⚠️  Errors: ${errors.length}`);
    errors.forEach(err => console.log(`  ${err.file}: ${err.error}`));
  }
})().catch(error => {
  console.error('Error syncing:', error);
  process.exit(1);
});
