#!/usr/bin/env node
/**
 * memory-bank resolve — gated resolution of the consistency queue.
 *
 * Dry-run by default: judges the active-active pairs with an LLM committee and
 * prints what it WOULD do. Only --apply changes anything, and every change is
 * appended to <index-dir>/relation-resolution.jsonl so a person can reverse it.
 *
 * Usage:
 *   memory-bank resolve <contradicts|supersedes> [--apply] [--limit N] [--batch-size N] [--votes K] [--model M] [--json]
 *
 *   contradicts   edges only: UNRELATED → delete, RELATED_NOT_CONFLICTING → INFLUENCES,
 *                 duplicate-shaped → SUPERSEDES, TRUE_CONFLICT → left for a human
 *   supersedes    may retire the redundant fact (committee ≥ 0.9, same scope,
 *                 not better confirmed); BOTH_VALID → INFLUENCES, UNRELATED → delete
 *   --limit N     pairs per run (default 200; 0 = all); pairs an earlier --apply run judged are skipped
 *   --rejudge     include pairs an earlier run already judged
 *   --batch-size  pairs per LLM call (default 8, max 20)
 *   --votes K     committee size (default 3, max 5; 1 = single call)
 *   --model M     judge model (default sonnet; aliases haiku|sonnet|opus resolve to full ids;
 *                 sets MEMORY_BANK_FACT_MODEL for this run)
 *   --json        machine-readable summary
 *
 * The dry run opens the database READ-ONLY: initDatabase() runs migrations and repairs
 * (duplicate edge removal, scope fixes) that would change the graph before it is judged.
 */
import { initDatabase, openDatabaseReadonly } from './db.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_RESOLVE_MODEL,
  DEFAULT_VOTES,
  MAX_VOTES,
  formatResolveSummary,
  parseIntegerOption,
  resolveModelId,
  resolveQueue,
} from './relation-resolve.js';
import type { ConflictType } from './consistency.js';

const USAGE =
  'Usage: memory-bank resolve <contradicts|supersedes> [--apply] [--limit N] [--rejudge] [--batch-size N (1-20)] [--votes K (1-5)] [--model M] [--json]';

interface Opts {
  type: ConflictType;
  apply: boolean;
  limit: number;
  rejudge: boolean;
  batchSize: number;
  votes: number;
  model: string;
  json: boolean;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    type: 'CONTRADICTS',
    apply: false,
    limit: 200,
    rejudge: false,
    batchSize: DEFAULT_BATCH_SIZE,
    votes: DEFAULT_VOTES,
    model: process.env.MEMORY_BANK_FACT_MODEL || DEFAULT_RESOLVE_MODEL,
    json: false,
  };
  let typeGiven = false;
  const numeric = (name: string, raw: string | undefined, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    // Whole-string integer only: "0.5" or "1e3" must not silently become 0 or 1 (a --limit of
    // 0 means "everything", so a lenient parse would drop the cost bound the user asked for).
    // Out-of-range values are rejected, never clamped: a run must do what it reports.
    const n = parseIntegerOption(raw, min);
    if (n === null || n > max) {
      const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `between ${min} and ${max}`;
      console.error(`${name}: expected a whole number ${range}, got ${raw ?? '(nothing)'}`);
      process.exit(3);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'contradicts' || arg === 'supersedes') {
      opts.type = arg === 'contradicts' ? 'CONTRADICTS' : 'SUPERSEDES';
      typeGiven = true;
    } else if (arg === '--apply') opts.apply = true;
    else if (arg === '--rejudge') opts.rejudge = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--limit') opts.limit = numeric('--limit', argv[++i], 0);
    else if (arg === '--batch-size') opts.batchSize = numeric('--batch-size', argv[++i], 1, 20);
    else if (arg === '--votes') opts.votes = numeric('--votes', argv[++i], 1, MAX_VOTES);
    else if (arg === '--model') {
      const m = argv[++i];
      if (!m || m.startsWith('-')) {
        console.error('--model: expected a model name');
        process.exit(3);
      }
      opts.model = m;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}\n${USAGE}`);
      process.exit(3);
    }
  }
  if (!typeGiven) {
    console.error(USAGE);
    process.exit(3);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // The shared LLM wrapper reads the model from this variable; scope the override to this
  // process and export a FULL model id so the direct-API fallback (which rejects SDK
  // aliases such as "sonnet") keeps working.
  opts.model = resolveModelId(opts.model);
  process.env.MEMORY_BANK_FACT_MODEL = opts.model;
  // Dry run: read-only connection, so "nothing changed" is enforced by SQLite itself and the
  // startup migrations/repairs in initDatabase() cannot touch the graph before it is judged.
  let db;
  if (opts.apply) {
    db = initDatabase();
  } else {
    try {
      db = openDatabaseReadonly();
    } catch (error) {
      console.error(`resolve: cannot open the database read-only (${error instanceof Error ? error.message : error}); run any indexing command first`);
      process.exit(1);
    }
  }
  try {
    const summary = await resolveQueue(db, opts.type, {
      apply: opts.apply,
      limit: opts.limit,
      rejudge: opts.rejudge,
      batchSize: opts.batchSize,
      votes: opts.votes,
      onProgress: (line) => console.error(`resolve: ${line}`),
    });
    if (opts.json) {
      console.log(JSON.stringify({ ...summary, model: opts.model }, null, 2));
    } else {
      console.log(formatResolveSummary(summary));
      console.log(`_model: ${opts.model} · votes: ${opts.votes} · batch: ${opts.batchSize}_`);
      if (!opts.apply) console.log('\nDry run: nothing changed. Re-run with --apply to act on the plan above.');
    }
  } finally {
    db.close();
  }
}

main()
  // The Agent SDK can leave a child process or transport handle open after the last call;
  // a finished run must not sit there waiting on it (observed: complete JSON printed, no exit).
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('resolve failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
