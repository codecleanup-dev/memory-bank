import { syncConversations } from './sync.js';
import { getArchiveDir, getAgentSources } from './paths.js';
import { parseLockMeta, decideTakeover, isSyncCliCommand } from './version-guard.js';
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
const __myVersion = (() => {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
})();
function __pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return !!e && e.code === 'EPERM';
    }
}
/** Pid-recycling guard: only treat the holder as "our" process if its command
 * line IS a running sync-cli (anchored to the node executable + script argv —
 * see isSyncCliCommand). A recycled pid must not be killed. */
function __isSyncCliProcess(pid) {
    try {
        const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
        return isSyncCliCommand(cmd);
    }
    catch {
        return false;
    }
}
async function __killAndConfirm(pid) {
    // Re-verify the holder's command line immediately before EVERY signal — the
    // earlier check is a separate ps read, and a holder that exits in between
    // could have its pid recycled by an unrelated process (TOCTOU). ps-based
    // identity can't be fully atomic with kill(2), but re-checking right before
    // each signal shrinks the window from seconds to microseconds.
    if (!__isSyncCliProcess(pid))
        return !__pidAlive(pid);
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch { }
    for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (!__pidAlive(pid))
            return true;
    }
    if (!__isSyncCliProcess(pid))
        return !__pidAlive(pid);
    try {
        process.kill(pid, 'SIGKILL');
    }
    catch { }
    await new Promise((r) => setTimeout(r, 500));
    return !__pidAlive(pid);
}
function __writeLockMeta() {
    try {
        fs.writeFileSync(__pidFile, JSON.stringify({ pid: process.pid, version: __myVersion, startedAt: Date.now() }));
    }
    catch { }
}
function __reclaimLock() {
    // Atomic takeover: rename(2) is the single mutual-exclusion point — exactly
    // ONE contender can move the stale dir aside; every loser's rename throws
    // (ENOENT) and it must NOT touch the winner's freshly recreated lock. The
    // previous rm+mkdir pair had a window where a second contender's rmSync
    // deleted the winner's brand-new lock and BOTH proceeded as writers.
    const grave = `${__lockDir}.stale.${process.pid}.${Date.now()}`;
    try {
        fs.renameSync(__lockDir, grave);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            return false;
        // The (killed) holder released the lock itself via its ownership-checked
        // cleanup between our decision and the rename — the path is simply free;
        // fall through and recreate. Any OTHER contender that got here first will
        // have recreated the dir already, making our mkdir below fail → defer.
    }
    try {
        fs.rmSync(grave, { recursive: true, force: true });
    }
    catch { /* leftover grave dir is inert */ }
    try {
        fs.mkdirSync(__lockDir, { recursive: false });
        return true;
    }
    catch {
        return false;
    }
}
async function __acquireLock() {
    try {
        fs.mkdirSync(__lockDir, { recursive: false });
    }
    catch {
        let raw = '';
        try {
            raw = fs.readFileSync(__pidFile, 'utf8');
        }
        catch { }
        const holder = parseLockMeta(raw);
        if (!holder || !__pidAlive(holder.pid)) {
            // Garbage or dead holder — reclaim (pre-existing behavior).
            if (!__reclaimLock())
                return false;
        }
        else {
            // Live holder: preempt if it runs older code or is wedged.
            let runMs = holder.startedAt !== null ? Date.now() - holder.startedAt : null;
            if (runMs === null) {
                try {
                    runMs = Date.now() - fs.statSync(__lockDir).mtimeMs;
                }
                catch {
                    runMs = null;
                }
            }
            const decision = decideTakeover(holder, __myVersion, runMs, WEDGE_MAX_MS);
            if (decision === 'defer')
                return false;
            if (!__isSyncCliProcess(holder.pid)) {
                if (!__pidAlive(holder.pid)) {
                    // Died between checks — normal dead-holder reclaim.
                    if (!__reclaimLock())
                        return false;
                }
                else {
                    // FAIL-CLOSED: a live pid we cannot POSITIVELY identify as a
                    // memory-bank sync is neither killed nor has its lock reclaimed.
                    // Recognition can fail on legitimate wrappers (bin shim / tsx /
                    // quoted paths / exotic node flags) — reclaiming under a live real
                    // sync would run two concurrent writers (the original
                    // 76-concurrent-sync load incident class), which is strictly worse
                    // than skipping this run. A genuinely recycled pid holds the lock
                    // only until that process exits; manual escape is logged below.
                    console.error(`Sync lock holder pid=${holder.pid} is alive but not recognizable as a memory-bank sync — deferring (to override manually: rm -rf ~/.claude/run-locks/memory-bank-sync.lock)`);
                    return false;
                }
            }
            else {
                console.log(`Preempting sync lock holder pid=${holder.pid} version=${holder.version ?? 'legacy'} (${decision})`);
                if (!(await __killAndConfirm(holder.pid))) {
                    console.error(`Failed to terminate lock holder pid=${holder.pid} - skip`);
                    return false;
                }
                if (!__reclaimLock())
                    return false;
            }
        }
    }
    __writeLockMeta();
    return true;
}
if (!(await __acquireLock())) {
    console.log('Sync already running - skip (singleton lock)');
    process.exit(0);
}
// Ownership-checked release: after a takeover the lock belongs to the
// PREEMPTOR — a dying (preempted) holder must remove the lock only while the
// pid file still records ITS pid, never a successor's fresh lock. If the
// preemptor already renamed the dir away, the read fails → nothing to do.
function __releaseLockIfOwned() {
    try {
        const meta = parseLockMeta(fs.readFileSync(__pidFile, 'utf8'));
        if (meta && meta.pid === process.pid) {
            fs.rmSync(__lockDir, { recursive: true, force: true });
        }
    }
    catch { /* lock gone or unreadable — not ours to release */ }
}
process.on('exit', __releaseLockIfOwned);
// Default signal death skips 'exit' handlers (observed: SIGTERM left a stale
// lock behind). Route signals through process.exit so the lock is released.
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => process.exit(143));
}
const destDir = getArchiveDir();
const sources = getAgentSources();
console.log('Syncing conversations...');
console.log(`Sources: ${sources.map(s => `${s.name} (${s.sourceDir})`).join(', ')}`);
console.log(`Destination: ${destDir}\n`);
(async () => {
    const totals = { copied: 0, skipped: 0, indexed: 0, summarized: 0 };
    const errors = [];
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
