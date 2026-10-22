#!/usr/bin/env node
/**
 * resolve-weekly — the consistency-queue resolver as a weekly lane.
 *
 * Default is a DRY RUN: it runs `relation-resolve-cli.js contradicts|supersedes --json`
 * (read-only connection, judge committee via the local subscription), writes a human-readable
 * report of what WOULD change, measures how well earlier --apply runs have held, and appends one
 * JSON line for the keystone weekly review (section 3o). Nothing in the graph changes.
 *
 * Applying is opt-in and a human decision (docs/2026-10-05-relation-resolution.md: the person
 * reads the dry-run list and issues --apply). `--apply` or MEMORY_BANK_RESOLVE_APPLY=1 turns the
 * lane into: `--replan --apply` (re-run today's policy on recorded verdicts, incl. edges a peer
 * import revived) → `contradicts --apply` → `supersedes --apply`.
 *
 * Durability ("hit rate", AKM H4): for every delete/retype/deactivate row in relation_resolution_log,
 * is the change still in effect? delete → no edge of the old type between the pair (CONTRADICTS is
 * symmetric); retype → no edge of the old type between the pair; deactivate → the fact is still
 * inactive. held / (held + revived) is the rate. 2026-10-05 measured 226/264 deletions revived by a
 * peer import before the tombstone fix (1.12.6); this number is how we know whether that holds.
 *
 * Usage:
 *   node scripts/resolve-weekly.mjs [--apply] [--limit N] [--votes K] [--model M] [--types contradicts,supersedes]
 *                                   [--root DIR] [--node BIN] [--out DIR] [--jsonl FILE] [--db FILE] [--json]
 *   node scripts/resolve-weekly.mjs --durability-only [--db FILE] [--root DIR]
 *
 * Resolution of the plugin root (where dist/relation-resolve-cli.js and the ABI-matched
 * better-sqlite3 live): --root → MEMORY_BANK_RESOLVE_ROOT → MEMORY_BANK_ROOT in ~/.claude/memory-bank.env
 * → highest semver under ~/.claude/plugins/cache/memory-bank-dev/memory-bank. Node: --node →
 * MEMORY_BANK_RESOLVE_NODE → MEMORY_BANK_NODE in the env file → process.execPath.
 *
 * Exit codes: 0 lane completed (even if a judge run failed — the failure is recorded in the report
 * and jsonl, a monitoring lane must not hide its own partial failure as success nor die on it);
 * 2 bad arguments; 3 plugin root / CLI not found (nothing to run — recorded in jsonl too).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
const DEFAULT_OUT = path.join(HOME, '.claude', 'logs', 'memory-bank-resolve');
const DEFAULT_JSONL = path.join(HOME, '.claude', 'logs', 'memory-bank-resolve.jsonl');
const DEFAULT_DB = path.join(HOME, '.config', 'superpowers', 'conversation-index', 'db.sqlite');
const RUN_TIMEOUT_MS = 45 * 60 * 1000;

export function parseArgs(argv) {
  const opts = {
    apply: process.env.MEMORY_BANK_RESOLVE_APPLY === '1',
    limit: 100,
    votes: 3,
    model: null,
    types: ['contradicts', 'supersedes'],
    root: process.env.MEMORY_BANK_RESOLVE_ROOT || null,
    node: process.env.MEMORY_BANK_RESOLVE_NODE || null,
    out: process.env.MEMORY_BANK_RESOLVE_OUT || DEFAULT_OUT,
    jsonl: process.env.MEMORY_BANK_RESOLVE_JSONL || DEFAULT_JSONL,
    // An env-given DB path is absolutized and forwarded like --db: the child runs in the report folder, so a relative
    // MEMORY_BANK_DB_PATH would otherwise resolve to a different file there.
    db: process.env.MEMORY_BANK_DB_PATH ? path.resolve(process.env.MEMORY_BANK_DB_PATH) : DEFAULT_DB,
    dbExplicit: Boolean(process.env.MEMORY_BANK_DB_PATH),
    json: false,
    durabilityOnly: false,
  };
  const whole = (name, raw, min, max) => {
    if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${name}: expected a whole number, got ${raw ?? '(nothing)'}`);
    const n = Number(raw);
    if (n < min || n > max) throw new Error(`${name}: expected ${min}..${max}, got ${raw}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--limit') opts.limit = whole('--limit', argv[++i], 0, 100000);
    else if (a === '--votes') opts.votes = whole('--votes', argv[++i], 1, 5);
    else if (a === '--model') { opts.model = argv[++i]; if (!opts.model || opts.model.startsWith('-')) throw new Error('--model: expected a name'); }
    else if (a === '--types') {
      const list = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!list.length || list.some((t) => t !== 'contradicts' && t !== 'supersedes')) throw new Error('--types: contradicts,supersedes only');
      opts.types = list;
    }
    // Paths are fixed to absolute at parse time: the judge child runs with cwd = report folder, so a relative --db
    // would point the parent (durability) and the child (apply) at two different files.
    else if (a === '--root') opts.root = path.resolve(argv[++i]);
    else if (a === '--node') opts.node = path.resolve(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--jsonl') opts.jsonl = path.resolve(argv[++i]);
    else if (a === '--db') { opts.db = path.resolve(argv[++i]); opts.dbExplicit = true; }
    else if (a === '--json') opts.json = true;
    else if (a === '--durability-only') opts.durabilityOnly = true;
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

/** Read `export KEY="value"` lines without sourcing the file (no code execution). */
export function readEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=("?)([^"]*)\2\s*$/.exec(line);
    if (m) out[m[1]] = m[3];
  }
  return out;
}

function highestVersionRoot(cacheBase) {
  let best = null;
  let names;
  try { names = fs.readdirSync(cacheBase); } catch { return null; }
  for (const n of names) {
    if (!/^\d+\.\d+\.\d+/.test(n)) continue;
    if (!fs.existsSync(path.join(cacheBase, n, 'dist', 'relation-resolve-cli.js'))) continue;
    const key = n.split(/[.-]/).slice(0, 3).map((x) => Number(x) || 0);
    if (!best || key > best.key || (key.join('.') > best.key.join('.'))) best = { key, path: path.join(cacheBase, n) };
  }
  return best?.path ?? null;
}

export function resolveRuntime(opts, envFile = path.join(HOME, '.claude', 'memory-bank.env')) {
  const env = readEnvFile(envFile);
  const root = opts.root || env.MEMORY_BANK_ROOT || highestVersionRoot(path.join(HOME, '.claude', 'plugins', 'cache', 'memory-bank-dev', 'memory-bank'));
  const node = opts.node || env.MEMORY_BANK_NODE || process.execPath;
  const cli = root ? path.join(root, 'dist', 'relation-resolve-cli.js') : null;
  return { root, node, cli, cliExists: Boolean(cli && fs.existsSync(cli)) };
}

/* ------------------------------------------------------------------ durability */

function tableExists(db, name) {
  return Boolean(db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name));
}

/**
 * @param db better-sqlite3 Database (read-only is fine)
 * @returns {{available:boolean, judged_total:number, held:number, revived:number, rate_pct:number|null, by_action:object, note?:string}}
 */
export function computeDurability(db) {
  if (!tableExists(db, 'relation_resolution_log') || !tableExists(db, 'ontology_relations')) {
    return { available: false, judged_total: 0, held: 0, revived: 0, rate_pct: null, by_action: {}, note: 'no apply run recorded yet (relation_resolution_log absent)' };
  }
  const rows = db.prepare(
    `select action, relation_id, relation_type_before, relation_type_after, source_fact_id, target_fact_id,
            source_after, target_after, deactivated_fact_id
       from relation_resolution_log where action in ('delete','retype','deactivate')`,
  ).all();
  const edgeOfType = db.prepare(
    'select 1 from ontology_relations where source_fact_id=? and target_fact_id=? and relation_type=? limit 1',
  );
  const edgeById = db.prepare('select relation_type from ontology_relations where id=?');
  const factActive = tableExists(db, 'facts') ? db.prepare('select is_active from facts where id=?') : null;
  const typeBetween = (a, b, type) => {
    if (edgeOfType.get(a, b, type)) return true;
    if (type === 'CONTRADICTS' && edgeOfType.get(b, a, type)) return true;
    return false;
  };
  const by = {};
  let held = 0;
  let revived = 0;
  for (const r of rows) {
    const slot = (by[r.action] ||= { held: 0, revived: 0 });
    let ok;
    if (r.action === 'delete') {
      ok = !typeBetween(r.source_fact_id, r.target_fact_id, r.relation_type_before);
    } else if (r.action === 'retype') {
      const cur = edgeById.get(r.relation_id);
      const sameEdgeReverted = Boolean(cur && cur.relation_type === r.relation_type_before);
      ok = !sameEdgeReverted && !typeBetween(r.source_fact_id, r.target_fact_id, r.relation_type_before);
    } else {
      const f = factActive && r.deactivated_fact_id ? factActive.get(r.deactivated_fact_id) : null;
      ok = f ? Number(f.is_active) === 0 : true; // a fact that no longer exists is not "revived"
    }
    if (ok) { held++; slot.held++; } else { revived++; slot.revived++; }
  }
  const total = held + revived;
  return { available: true, judged_total: total, held, revived, rate_pct: total ? Math.round((held * 1000) / total) / 10 : null, by_action: by };
}

export function openDurability(dbPath, root) {
  if (!fs.existsSync(dbPath)) return { available: false, judged_total: 0, held: 0, revived: 0, rate_pct: null, by_action: {}, note: `db not found: ${dbPath}` };
  let Database;
  try {
    const req = createRequire(path.join(root, 'package.json'));
    Database = req('better-sqlite3');
  } catch (e) {
    return { available: false, judged_total: 0, held: 0, revived: 0, rate_pct: null, by_action: {}, note: `better-sqlite3 unavailable under ${root}: ${e.message}` };
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    return computeDurability(db);
  } catch (e) {
    return { available: false, judged_total: 0, held: 0, revived: 0, rate_pct: null, by_action: {}, note: `read failed: ${e.message}` };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ runs */

/** Reduce a CLI --json summary to what the report and the weekly review need. */
export function summarizeRun(type, result) {
  const base = { type, status: 'ok', examined: 0, judged: 0, actionable: 0, planned: {}, applied: {}, spoiled: 0, unavailable: 0, previously_judged: 0, judge_failures: 0, pairs: [] };
  if (result.status !== 'ok') return { ...base, status: result.status, rc: result.rc ?? null, error: result.error ?? null };
  const s = result.summary || {};
  const planned = s.planned || {};
  const actionable = Object.entries(planned).filter(([k]) => k !== 'keep').reduce((n, [, v]) => n + (Number(v) || 0), 0);
  const out = {
    ...base,
    examined: Number(s.examined) || 0,
    judged: Number(s.judged) || 0,
    actionable,
    planned,
    applied: s.applied || {},
    spoiled: Number(s.spoiledPairs) || 0,
    unavailable: Number(s.unavailableBatches) || 0,
    previously_judged: Number(s.previouslyJudged) || 0,
    judge_failures: Number(s.judgeFailures) || 0,
    mode: s.mode || null,
    model: s.model || null,
    pairs: (Array.isArray(s.pairs) ? s.pairs : []).filter((p) => p && p.planned !== 'keep').slice(0, 50).map((p) => ({
      planned: p.planned, applied: p.applied ?? null, verdict: p.verdict, confidence: p.confidence, relationId: p.relationId, reasoning: p.judgeReasoning ?? null,
    })),
  };
  // The CLI exits 0 when the judge never answered: it just counts unavailableBatches and leaves those pairs for a later
  // run. For the lane that is not a successful week — nothing was judged. Record it as its own status.
  if (type !== 'replan' && (out.unavailable > 0 || (out.examined > 0 && out.judged === 0))) {
    out.status = 'judge-unavailable';
    out.error = `judge did not answer: unavailable batches ${out.unavailable}, judged ${out.judged}/${out.examined}`;
  }
  return out;
}

/** The judge/apply child must look at the same database the durability pass measures: an explicit --db is
 *  handed down as MEMORY_BANK_DB_PATH (what paths.ts reads). Without --db the child keeps its own resolution. */
function childEnv(opts) {
  return opts.dbExplicit ? { ...process.env, MEMORY_BANK_DB_PATH: opts.db } : process.env;
}

/** Lane status: every judge run AND every replan (when they ran) must be ok. A failed replan means revived edges were
 *  not re-cleaned even if the judge runs succeeded; a judge that never answered is not a successful week either. */
export function laneStatus(runs, replans) {
  const judgeOk = runs.every((r) => r.status === 'ok');
  const replanOk = !replans || replans.every((r) => r.status === 'ok');
  return judgeOk && replanOk ? 'ok' : 'partial';
}

function runCli(rt, args, cwd, opts) {
  const r = spawnSync(rt.node, [rt.cli, ...args], { cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: childEnv(opts) });
  if (r.error && r.error.code === 'ETIMEDOUT') return { status: 'timeout', rc: null, error: `timeout after ${RUN_TIMEOUT_MS / 60000} min`, stderr: r.stderr };
  if (r.error) return { status: 'error', rc: null, error: r.error.message, stderr: r.stderr };
  if (r.status !== 0) return { status: 'error', rc: r.status, error: (r.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 400), stderr: r.stderr };
  try {
    return { status: 'ok', rc: 0, summary: JSON.parse(r.stdout), stderr: r.stderr };
  } catch (e) {
    return { status: 'error', rc: 0, error: `unparseable --json output: ${e.message}`, stderr: r.stderr };
  }
}

/* ------------------------------------------------------------------ report */

export function renderReport({ time, mode, opts, rt, runs, durability, replans }) {
  const lines = [];
  lines.push(`# memory-bank resolve 주간 레인 (${mode === 'apply' ? 'APPLY' : 'dry-run'}) · ${time}`);
  lines.push('');
  lines.push(`- 플러그인 루트: ${rt.root}  · node: ${rt.node}`);
  lines.push(`- 설정: limit ${opts.limit} · votes ${opts.votes} · model ${opts.model || '(CLI 기본)'} · types ${opts.types.join(',')}`);
  lines.push(mode === 'apply'
    ? '- 모드: APPLY — 기록된 판정 재적용(--replan) 뒤 두 축을 적용했다. 모든 변경은 relation_resolution_log 에 같은 트랜잭션으로 남는다.'
    : '- 모드: dry-run — 읽기 전용 연결. 아래 "적용 예정" 은 제안이며 그래프는 바뀌지 않았다. 적용은 사람의 결정(MEMORY_BANK_RESOLVE_APPLY=1 재등록 또는 수동 --apply).');
  lines.push('');
  if (replans && replans.length) {
    lines.push(mode === 'apply' ? '## 기록된 판정 재적용 (--replan --apply, 유형별)' : '## 기록된 판정 재적용 예정 (--replan 미리보기, 유형별)');
    lines.push('');
    for (const r of replans) {
      const planned = JSON.stringify(r.planned || {});
      lines.push(`- ${r.type}: ${r.status}${r.error ? `: ${r.error}` : ''} · 검사 ${r.examined} · 계획 ${planned}${mode === 'apply' ? ` · 적용 ${JSON.stringify(r.applied)}` : ''}`);
    }
    lines.push('- 되살아난 간선(같은 id 로 복원)은 일반 판정 런이 "이미 판정됨"으로 건너뛰므로 이 절에만 나타난다. 적용 결정은 두 절을 함께 본다.');
    lines.push('');
  }
  for (const r of runs) {
    lines.push(`## ${r.type}`);
    lines.push('');
    if (r.status !== 'ok') {
      lines.push(`- 실행 실패: ${r.status}${r.rc !== null && r.rc !== undefined ? ` (rc ${r.rc})` : ''}${r.error ? ` — ${r.error}` : ''}`);
      lines.push('');
      continue;
    }
    lines.push('| 항목 | 값 |');
    lines.push('|---|---|');
    lines.push(`| 검사한 쌍 | ${r.examined} |`);
    lines.push(`| 판정된 쌍 | ${r.judged} |`);
    lines.push(`| 적용 예정(keep 제외) | ${r.actionable} |`);
    for (const [k, v] of Object.entries(r.planned)) lines.push(`| 계획: ${k} | ${v} |`);
    for (const [k, v] of Object.entries(r.applied)) lines.push(`| 적용: ${k} | ${v} |`);
    lines.push(`| 합의 실패(spoiled) | ${r.spoiled} |`);
    lines.push(`| 판정기 미도달 배치 | ${r.unavailable} |`);
    lines.push(`| 이전 런이 판정해 건너뜀 | ${r.previously_judged} |`);
    lines.push('');
    if (r.pairs.length) {
      lines.push(`### ${mode === 'apply' ? '적용' : '적용 예정'} 목록 (${r.pairs.length}${r.actionable > r.pairs.length ? ` / ${r.actionable}` : ''})`);
      lines.push('');
      for (const p of r.pairs) {
        lines.push(`- ${p.planned}${p.applied ? ` → ${p.applied}` : ''} · ${p.verdict} (${p.confidence}) · relation \`${p.relationId}\``);
        if (p.reasoning) lines.push(`  - ${p.reasoning}`);
      }
      lines.push('');
    } else {
      lines.push('_적용 예정 쌍 없음 — 판정된 쌍이 전부 keep 이거나 판정이 없었다._');
      lines.push('');
    }
  }
  lines.push('## 적용분 내구성 (히트율)');
  lines.push('');
  if (!durability.available) {
    lines.push(`- 측정 불가: ${durability.note}`);
  } else if (durability.judged_total === 0) {
    lines.push('- 적용 기록 0건 — 아직 --apply 런이 없다.');
  } else {
    lines.push(`- 유지 ${durability.held} / 되살아남 ${durability.revived} (유지율 ${durability.rate_pct}%) · 기록 ${durability.judged_total}건`);
    for (const [k, v] of Object.entries(durability.by_action)) lines.push(`  - ${k}: 유지 ${v.held} · 되살아남 ${v.revived}`);
    lines.push('- 되살아남 = 지운 간선이 같은 쌍에 같은 유형으로 다시 있거나, 재분류한 간선이 옛 유형으로 돌아왔거나, 퇴역시킨 팩트가 다시 활성이다. 1.12.6 import tombstone 이 작동하면 이 수는 늘지 않아야 한다.');
  }
  lines.push('');
  lines.push('근거: docs/2026-10-05-relation-resolution.md · keystone 주간 리뷰 3o 절이 이 레인의 jsonl 을 읽는다.');
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ main */

export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`resolve-weekly: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    console.log('usage: resolve-weekly.mjs [--apply] [--limit N] [--votes K] [--model M] [--types a,b] [--root DIR] [--node BIN] [--out DIR] [--jsonl FILE] [--db FILE] [--json] [--durability-only]');
    return 0;
  }
  const rt = resolveRuntime(opts);
  const time = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const mode = opts.apply ? 'apply' : 'dry-run';
  fs.mkdirSync(opts.out, { recursive: true });
  const record = { kind: 'resolve-weekly', time, mode, limit: opts.limit, votes: opts.votes, model: opts.model, root: rt.root, runs: {}, durability: null, report: null };

  if (!rt.cliExists) {
    record.status = 'no-cli';
    record.error = `relation-resolve-cli.js not found (root=${rt.root ?? 'unresolved'})`;
    appendJsonl(opts.jsonl, record);
    console.error(`resolve-weekly: ${record.error}`);
    return 3;
  }

  if (opts.durabilityOnly) {
    const d = openDurability(opts.db, rt.root);
    console.log(JSON.stringify(d, null, 2));
    return 0;
  }

  // Replan per selected type: replanFromLog only re-applies recorded verdicts of the type it is given, and a later plain
  // supersedes run skips pairs whose judged input is unchanged — so a revived SUPERSEDES edge would survive forever if
  // only contradicts were replanned.
  // The replan runs in BOTH modes. In dry-run it previews (no --apply) what the recorded verdicts would re-do, because
  // a revived edge with its old id is skipped by the plain judge run as previouslyJudged — without the preview the
  // person deciding on --apply would see "0 planned" and then the apply would delete it anyway.
  const replans = [];
  record.runs.replan = {};
  for (const type of opts.types) {
    const args = [type, '--replan', '--json', '--limit', String(opts.limit)];
    if (opts.apply) args.push('--apply');
    const r = runCli(rt, args, opts.out, opts);
    const s = { ...summarizeRun('replan', r), type };
    replans.push(s);
    record.runs.replan[type] = { status: s.status, examined: s.examined, planned: s.planned, applied: s.applied, error: s.error ?? null };
  }
  const runs = [];
  for (const type of opts.types) {
    const args = [type, '--json', '--limit', String(opts.limit), '--votes', String(opts.votes)];
    if (opts.model) args.push('--model', opts.model);
    if (opts.apply) args.push('--apply');
    const s = summarizeRun(type, runCli(rt, args, opts.out, opts));
    runs.push(s);
    record.runs[type] = {
      status: s.status, rc: s.rc ?? 0, examined: s.examined, judged: s.judged, actionable: s.actionable,
      planned: s.planned, applied: s.applied, spoiled: s.spoiled, unavailable: s.unavailable, error: s.error ?? null,
    };
  }
  const durability = openDurability(opts.db, rt.root);
  record.durability = { available: durability.available, judged_total: durability.judged_total, held: durability.held, revived: durability.revived, rate_pct: durability.rate_pct, by_action: durability.by_action, note: durability.note ?? null };

  const reportPath = path.join(opts.out, `${time.slice(0, 10)}-${mode}.md`);
  fs.writeFileSync(reportPath, renderReport({ time, mode, opts, rt, runs, durability, replans }), 'utf8');
  record.report = reportPath;
  record.status = laneStatus(runs, replans);
  appendJsonl(opts.jsonl, record);
  if (opts.json) console.log(JSON.stringify(record, null, 2));
  else console.log(`resolve-weekly: ${record.status} · report ${reportPath} · ` + runs.map((r) => `${r.type} ${r.status} judged ${r.judged} actionable ${r.actionable}`).join(' · '));
  return 0;
}

function appendJsonl(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.error(`resolve-weekly: jsonl append failed: ${e.message}`);
  }
}

// Entry detection by real path: /tmp vs /private/tmp (macOS) and symlinked checkouts would otherwise never match.
function samePath(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}
const invokedDirectly = Boolean(process.argv[1]) && samePath(process.argv[1], fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
