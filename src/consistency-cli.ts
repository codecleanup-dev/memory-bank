#!/usr/bin/env node
/**
 * memory-bank consistency — knowledge-graph consistency report.
 *
 * Report-first by design: this CLI never mutates facts. It surfaces
 * active-active CONTRADICTS / SUPERSEDES pairs (the resolution queue),
 * orphan-fact coverage, taxonomy-sprawl counts, and fact↔principle
 * conflicts (advisory section; gated only with --gate-principles).
 *
 * Usage:
 *   memory-bank consistency [--json] [--gate] [--gate-principles] [--limit N]
 *
 *   --json             machine-readable output
 *   --gate             exit 2 when any active-active fact↔fact conflict pair exists
 *                      (usable as a deterministic health gate in hooks/CI)
 *   --gate-principles  ALSO exit 2 when any active fact↔principle conflict exists
 *                      (opt-in: principle conflicts are advisory by default)
 *   --limit N          pairs listed per type (default 20; counts are always exact)
 */
import { initDatabase } from './db.js';
import {
  formatConsistencyReport,
  getConsistencyCounts,
  hasActiveConflicts,
  listActiveConflicts,
} from './consistency.js';
import {
  countActivePrincipleConflicts,
  formatPrincipleConflictSection,
  listActivePrincipleConflicts,
} from './principles.js';
import { getPrincipleCheckCoverage } from './principle-check.js';

function parseArgs(argv: string[]): { json: boolean; gate: boolean; gatePrinciples: boolean; limit: number } {
  const opts = { json: false, gate: false, gatePrinciples: false, limit: 20 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--gate') opts.gate = true;
    else if (arg === '--gate-principles') opts.gatePrinciples = true;
    else if (arg === '--limit') {
      const n = parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: memory-bank consistency [--json] [--gate] [--gate-principles] [--limit N]');
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
    const principleConflictCount = countActivePrincipleConflicts(db);
    const principleConflicts = listActivePrincipleConflicts(db, opts.limit);
    const principleCoverage = getPrincipleCheckCoverage(db);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            counts,
            contradicts,
            supersedes,
            principleConflicts: {
              count: principleConflictCount,
              coverage: principleCoverage,
              conflicts: principleConflicts,
            },
          },
          null,
          2,
        ),
      );
    } else {
      let report = formatConsistencyReport(counts, contradicts, supersedes);
      const principleSection = formatPrincipleConflictSection(
        principleConflictCount,
        principleConflicts,
        principleCoverage,
      );
      if (principleSection) report += `\n${principleSection}`;
      console.log(report);
    }

    if (opts.gate && hasActiveConflicts(counts)) {
      console.error(
        `consistency gate: ${counts.activeContradictsPairs} CONTRADICTS + ${counts.activeSupersedesPairs} SUPERSEDES active-active pairs`,
      );
      process.exitCode = 2;
    }
    if (opts.gatePrinciples && principleConflictCount > 0) {
      console.error(`consistency gate: ${principleConflictCount} active fact↔principle conflicts`);
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

main();
