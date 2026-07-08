#!/usr/bin/env node
/**
 * memory-bank taxonomy-align — category sprawl consolidation.
 *
 * Report-first: without --apply nothing is written. --apply merges
 * same-domain candidates at/above the threshold; cross-domain candidates are
 * always report-only.
 *
 * Usage:
 *   memory-bank taxonomy-align [--threshold N] [--apply] [--json] [--show N]
 *
 *   --threshold N  cosine similarity floor for candidates (default 0.9)
 *   --apply        merge same-domain candidates (facts remapped, category dropped)
 *   --show N       candidates listed in the report (default 30)
 *   --json         machine-readable output
 */
import { initDatabase } from './db.js';
import {
  applyMerges,
  DEFAULT_MERGE_THRESHOLD,
  findMergeCandidates,
  formatAlignmentReport,
} from './taxonomy-align.js';

interface CliOpts {
  threshold: number;
  apply: boolean;
  json: boolean;
  show: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { threshold: DEFAULT_MERGE_THRESHOLD, apply: false, json: false, show: 30 };
  const num = (raw: string | undefined): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--threshold') {
      const n = num(argv[++i]);
      if (n !== null && n > 0 && n < 1) opts.threshold = n;
    } else if (arg.startsWith('--threshold=')) {
      const n = num(arg.slice('--threshold='.length));
      if (n !== null && n > 0 && n < 1) opts.threshold = n;
    } else if (arg === '--show') {
      const n = num(argv[++i]);
      if (n !== null && n > 0) opts.show = Math.floor(n);
    } else if (arg.startsWith('--show=')) {
      const n = num(arg.slice('--show='.length));
      if (n !== null && n > 0) opts.show = Math.floor(n);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: memory-bank taxonomy-align [--threshold N] [--apply] [--json] [--show N]');
      process.exit(0);
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const db = initDatabase();
  try {
    const find = findMergeCandidates(db, { threshold: opts.threshold });
    const applied = opts.apply ? applyMerges(db, find.candidates) : undefined;

    if (opts.json) {
      console.log(JSON.stringify({ threshold: opts.threshold, ...find, applied: applied ?? null }, null, 2));
    } else {
      console.log(formatAlignmentReport(find, { threshold: opts.threshold, show: opts.show }, applied));
    }
  } finally {
    db.close();
  }
}

main();
