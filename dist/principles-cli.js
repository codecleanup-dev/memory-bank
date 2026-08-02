#!/usr/bin/env node
/**
 * memory-bank principles — operating-principles registry + fact↔principle
 * conflict queue.
 *
 * Registration is deliberately manual (human-gated): the canonical rules
 * files stay the source of truth, this registry only mirrors one-line
 * statements for conflict checking. Report-first: nothing here mutates facts.
 *
 * Usage:
 *   memory-bank principles list [--all] [--json]
 *   memory-bank principles add --slug S --statement "..." [--source PATH] [--layer identity|principle|policy]
 *   memory-bank principles import --file principles.json [--json]
 *   memory-bank principles activate --slug S
 *   memory-bank principles deactivate --slug S
 *   memory-bank principles conflicts [--limit N] [--json]
 *   memory-bank principles resolve --id CONFLICT_ID --resolution fact_deprecated|acknowledged|false_positive|principle_updated
 *   memory-bank principles check [--dry-run] [--max-facts N] [--batch-size N] [--recheck] [--json]
 *
 * `import` reads a JSON array: [{"slug": "...", "statement": "...", "source": "...", "layer": "principle"}]
 * (upsert semantics — safe to re-run a curated seed file).
 */
import { readFileSync } from 'fs';
import { initDatabase } from './db.js';
import { addPrinciple, countActivePrincipleConflicts, formatPrincipleConflictSection, listActivePrincipleConflicts, listPrinciples, resolvePrincipleConflict, setPrincipleActive, upsertPrinciple, CONFLICT_RESOLUTIONS, PRINCIPLE_LAYERS, } from './principles.js';
import { getPrincipleCheckCoverage, runPrincipleCheck } from './principle-check.js';
const USAGE = `Usage: memory-bank principles <list|add|import|activate|deactivate|conflicts|resolve|check> [options]

  list        Registered principles (--all includes inactive; --json)
  add         Register one principle: --slug S --statement "..." [--source PATH] [--layer ${PRINCIPLE_LAYERS.join('|')}]
  import      Upsert from a JSON seed file: --file principles.json
  activate    Re-activate a principle: --slug S
  deactivate  Deactivate a principle: --slug S (its conflicts leave the queue; canon file stays yours to update)
  conflicts   Active fact↔principle conflict queue [--limit N] [--json]
  resolve     Close a conflict: --id CONFLICT_ID --resolution ${CONFLICT_RESOLUTIONS.join('|')}
  check       Scan active facts with the LLM judge [--dry-run] [--max-facts N] [--batch-size N] [--threshold T] [--votes K] [--recheck] [--json]`;
function parseArgs(argv) {
    const flags = new Set();
    const values = new Map();
    const VALUE_OPTS = new Set([
        '--slug',
        '--statement',
        '--source',
        '--layer',
        '--file',
        '--limit',
        '--id',
        '--resolution',
        '--max-facts',
        '--batch-size',
        '--threshold',
        '--votes',
    ]);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const eq = arg.indexOf('=');
        if (arg.startsWith('--') && eq > 0) {
            values.set(arg.slice(0, eq), arg.slice(eq + 1));
        }
        else if (VALUE_OPTS.has(arg)) {
            values.set(arg, argv[++i] ?? '');
        }
        else {
            flags.add(arg);
        }
    }
    return { flags, values };
}
function intOpt(opts, name, fallback) {
    const raw = opts.values.get(name);
    if (raw === undefined)
        return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
function requireValue(opts, name) {
    const v = (opts.values.get(name) ?? '').trim();
    if (!v) {
        console.error(`missing required option: ${name}`);
        console.error(USAGE);
        process.exit(1);
    }
    return v;
}
async function main() {
    const [sub, ...rest] = process.argv.slice(2);
    if (!sub || sub === '--help' || sub === '-h') {
        console.log(USAGE);
        return;
    }
    const opts = parseArgs(rest);
    const json = opts.flags.has('--json');
    const db = initDatabase();
    try {
        switch (sub) {
            case 'list': {
                const principles = listPrinciples(db, opts.flags.has('--all'));
                if (json) {
                    console.log(JSON.stringify(principles, null, 2));
                }
                else if (principles.length === 0) {
                    console.log('No principles registered. Add one with:');
                    console.log('  memory-bank principles add --slug S --statement "..." [--layer identity|principle|policy]');
                }
                else {
                    for (const p of principles) {
                        const flag = p.is_active ? '' : ' (inactive)';
                        console.log(`[${p.layer}] ${p.slug}${flag}`);
                        console.log(`  ${p.statement}`);
                        if (p.source_path)
                            console.log(`  source: ${p.source_path}`);
                    }
                }
                break;
            }
            case 'add': {
                const principle = addPrinciple(db, {
                    slug: requireValue(opts, '--slug'),
                    statement: requireValue(opts, '--statement'),
                    sourcePath: opts.values.get('--source') ?? null,
                    layer: opts.values.get('--layer') ?? 'principle',
                });
                console.log(json ? JSON.stringify(principle, null, 2) : `registered [${principle.layer}] ${principle.slug}`);
                break;
            }
            case 'import': {
                const file = requireValue(opts, '--file');
                let entries;
                try {
                    entries = JSON.parse(readFileSync(file, 'utf-8'));
                }
                catch (e) {
                    console.error(`cannot read seed file: ${e instanceof Error ? e.message : e}`);
                    process.exitCode = 1;
                    return;
                }
                if (!Array.isArray(entries)) {
                    console.error('seed file must be a JSON array of {slug, statement, source?, layer?}');
                    process.exitCode = 1;
                    return;
                }
                const summary = { inserted: 0, updated: 0, failed: 0 };
                for (const entry of entries) {
                    try {
                        const action = upsertPrinciple(db, {
                            slug: entry.slug,
                            statement: entry.statement,
                            sourcePath: entry.source ?? null,
                            layer: entry.layer ?? 'principle',
                        });
                        summary[action] += 1;
                    }
                    catch (e) {
                        summary.failed += 1;
                        console.error(`skip ${entry?.slug ?? '(no slug)'}: ${e instanceof Error ? e.message : e}`);
                    }
                }
                console.log(json
                    ? JSON.stringify(summary)
                    : `imported: ${summary.inserted} inserted, ${summary.updated} updated, ${summary.failed} failed`);
                if (summary.failed > 0)
                    process.exitCode = 1;
                break;
            }
            case 'activate':
            case 'deactivate': {
                const slug = requireValue(opts, '--slug');
                const active = sub === 'activate';
                const changed = setPrincipleActive(db, slug, active);
                console.log(changed ? `${sub}d ${slug}` : `no change (${slug} missing or already ${sub}d)`);
                if (!changed)
                    process.exitCode = 1;
                break;
            }
            case 'conflicts': {
                const limit = intOpt(opts, '--limit', 20);
                const count = countActivePrincipleConflicts(db);
                const conflicts = listActivePrincipleConflicts(db, limit);
                const coverage = getPrincipleCheckCoverage(db);
                if (json) {
                    console.log(JSON.stringify({ count, coverage, conflicts }, null, 2));
                }
                else if (count === 0) {
                    const section = formatPrincipleConflictSection(0, [], coverage);
                    console.log(section || 'No active principle conflicts (scan complete — measured and clean).');
                }
                else {
                    console.log(formatPrincipleConflictSection(count, conflicts, coverage));
                }
                break;
            }
            case 'resolve': {
                const id = requireValue(opts, '--id');
                const resolution = requireValue(opts, '--resolution');
                const ok = resolvePrincipleConflict(db, id, resolution);
                console.log(ok ? `resolved ${id} (${resolution})` : `no active conflict with id ${id}`);
                if (!ok)
                    process.exitCode = 1;
                break;
            }
            case 'check': {
                const result = await runPrincipleCheck(db, {
                    dryRun: opts.flags.has('--dry-run'),
                    recheck: opts.flags.has('--recheck'),
                    maxFacts: intOpt(opts, '--max-facts', 200),
                    batchSize: intOpt(opts, '--batch-size', 20),
                    confidenceThreshold: opts.values.has('--threshold')
                        ? parseFloat(opts.values.get('--threshold') ?? '')
                        : undefined,
                    votes: opts.values.has('--votes') ? intOpt(opts, '--votes', 3) : undefined,
                });
                if (json) {
                    console.log(JSON.stringify(result, null, 2));
                }
                else {
                    if (result.activePrinciples === 0) {
                        console.log('No active principles — register some first (memory-bank principles add).');
                        break;
                    }
                    console.log(`checked ${result.factsChecked} facts in ${result.batches} batches against ${result.activePrinciples} principles`);
                    console.log(`findings: ${result.findings}, inserted: ${result.inserted}${result.done ? ' (scan complete)' : ' (more facts remain — run again to continue)'}`);
                    for (const f of result.dryRunFindings) {
                        console.log(`  [dry-run] fact ${f.factId} ⚠ ${f.principleSlug} (${f.confidence.toFixed(2)})${f.reasoning ? ` — ${f.reasoning}` : ''}`);
                    }
                    if (result.error)
                        console.error(`judge error (run stopped, batch will retry next run): ${result.error}`);
                }
                if (result.error)
                    process.exitCode = 1;
                break;
            }
            default:
                console.error(`Unknown subcommand: ${sub}`);
                console.error(USAGE);
                process.exitCode = 1;
        }
    }
    finally {
        db.close();
    }
}
main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
