import { syncConversations } from './sync.js';
import { getArchiveDir, getAgentSources } from './paths.js';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
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
const __lockDir = path.join(os.homedir(), '.claude', 'run-locks', 'memory-bank-sync.lock');
const __pidFile = path.join(__lockDir, 'pid');

function __pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function __acquireLock(): boolean {
  try {
    fs.mkdirSync(__lockDir, { recursive: false });
  } catch {
    let holder = NaN;
    try { holder = parseInt(fs.readFileSync(__pidFile, 'utf8').trim(), 10); } catch {}
    if (Number.isFinite(holder) && __pidAlive(holder)) return false;
    try { fs.rmSync(__lockDir, { recursive: true, force: true }); fs.mkdirSync(__lockDir, { recursive: false }); }
    catch { return false; }
  }
  try { fs.writeFileSync(__pidFile, String(process.pid)); } catch {}
  return true;
}

if (!__acquireLock()) {
  console.log('Sync already running - skip (singleton lock)');
  process.exit(0);
}
process.on('exit', () => { try { fs.rmSync(__lockDir, { recursive: true, force: true }); } catch {} });

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
