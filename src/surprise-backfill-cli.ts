#!/usr/bin/env node
/**
 * memory-bank surprise-backfill — E2: measure corpus-relative novelty for
 * active facts that predate the surprise column.
 *
 * Deterministic and fully local (embedding KNN only, no LLM). Repeated runs
 * resume naturally: `surprise IS NULL AND embedding IS NOT NULL` shrinks
 * monotonically. Reports the post-run distribution (the spec's G1 sanity
 * gate: a degenerate all-~0 / all-~1 distribution fails face validity).
 *
 * Usage:
 *   memory-bank surprise-backfill [--limit N] [--json]
 */
import { initDatabase } from './db.js';
import { runSurpriseBackfill } from './fact-db.js';

function parseArgs(argv: string[]): { json: boolean; limit: number } {
  const opts = { json: false, limit: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--limit') {
      const n = parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
    } else if (arg.startsWith('--limit=')) {
      const n = parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: memory-bank surprise-backfill [--limit N] [--json]');
      process.exit(0);
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = initDatabase();
  try {
    const result = runSurpriseBackfill(db, opts.limit);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`measured ${result.updated}/${result.scanned} facts this run`);
    console.log(
      `remaining: ${result.remaining} (embedding 보유) / unmeasurable: ${result.unmeasurable} (embedding 없음 — NULL 유지)`,
    );
    if (result.distribution) {
      const d = result.distribution;
      console.log(
        `distribution (n=${d.count}): min ${d.min.toFixed(3)} | p25 ${d.p25.toFixed(3)} | median ${d.median.toFixed(3)} | p75 ${d.p75.toFixed(3)} | max ${d.max.toFixed(3)}`,
      );
    }
    if (result.remaining > 0) {
      console.log('run again to continue (the NULL predicate is its own cursor).');
    }
  } finally {
    db.close();
  }
}

main();
