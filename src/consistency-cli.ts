#!/usr/bin/env node
/**
 * memory-bank consistency — knowledge-graph consistency report.
 *
 * Report-first by design: this CLI never mutates facts. It surfaces
 * active-active CONTRADICTS / SUPERSEDES pairs (the resolution queue),
 * orphan-fact coverage, and taxonomy-sprawl counts.
 *
 * Usage:
 *   memory-bank consistency [--json] [--gate] [--limit N]
 *
 *   --json     machine-readable output
 *   --gate     exit 2 when any active-active conflict pair exists
 *              (usable as a deterministic health gate in hooks/CI)
 *   --limit N  pairs listed per type (default 20; counts are always exact)
 */
import { initDatabase } from './db.js';
import {
  formatConsistencyReport,
  getConsistencyCounts,
  hasActiveConflicts,
  listActiveConflicts,
} from './consistency.js';

function parseArgs(argv: string[]): { json: boolean; gate: boolean; limit: number } {
  const opts = { json: false, gate: false, limit: 20 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--gate') opts.gate = true;
    else if (arg === '--limit') {
      const n = parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: memory-bank consistency [--json] [--gate] [--limit N]');
      process.exit(0);
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = initDatabase();
  try {
    const counts = getConsistencyCounts(db);
    const contradicts = listActiveConflicts(db, 'CONTRADICTS', opts.limit);
    const supersedes = listActiveConflicts(db, 'SUPERSEDES', opts.limit);

    if (opts.json) {
      console.log(JSON.stringify({ counts, contradicts, supersedes }, null, 2));
    } else {
      console.log(formatConsistencyReport(counts, contradicts, supersedes));
    }

    if (opts.gate && hasActiveConflicts(counts)) {
      console.error(
        `consistency gate: ${counts.activeContradictsPairs} CONTRADICTS + ${counts.activeSupersedesPairs} SUPERSEDES active-active pairs`,
      );
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

main();
