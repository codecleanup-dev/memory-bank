// F5 순서 효과 반복 측정 하네스 (memory-bank#36 · keystone-workbench#42 EV-003 데이터)
//
// 2026-07-25 파일럿(docs/2026-07-25-principle-contradicts-followups.md F5, 총 40콜,
// orderEffectDelta 0.182 > 0.10 양성)의 반복 측정판. 파일럿 스크립트는 미커밋이라
// 이 파일이 재구현 정본이다.
//
// ── 사전등록 (이 블록이 계약 — 수집 시작 후 변경 금지, 변경 시 새 run-id 로) ──
//  표본     : 실행 시점 active facts 를 (created_at, id) 오름차순 첫 200개 스냅샷.
//             7/25 파일럿과 표본이 다름(그동안 DB 성장)을 명시 — 동일 프로토콜의
//             새 표본 측정이지 파일럿 재현이 아니다. 표본 id 목록의 sha256 을 기록.
//  배치     : 20개 × 10배치. 배치 구성(어떤 fact 가 같은 배치인가)은 전 조건 동일 —
//             변인은 "배치 내 순서"뿐이다 (배포된 committeeJudge 의 개입 지점과 일치).
//  조건     : S = canonical 순서, 4런 (S1..S4 — 동일 입력의 확률 재현율 기준선)
//             O = 배치 내 결정론 셔플(mulberry32), 시드 [41,97,131,227,331,433] 각 1런
//             C = 배포본 위원회(votes=3, 표별 셔플), canonical 입력, 시드
//                 [1013,2027,3041,4057] 각 1런 — before/after 의 after 축
//  지표     : finding set = 검증 통과(contradicts·index 유효·slug 실존) 쌍의
//             `${fact_id}::${principle_slug}` 집합.
//             primary  = confidence ≥ 0.8 (프로덕션 임계)
//             secondary= 임계 미적용 전체 (탐색용, 함께 기록)
//             J(A,B) = |A∩B| / |A∪B| (양쪽 공집합이면 1로 정의)
//             orderEffectDelta = mean J(S,S') − mean J(S,O)   [primary 지표]
//             J_OO(시드 간), J_CC(위원회 재현율, vs J_SS) 는 보조 지표
//  판정     : 파일럿 임계 0.10 과의 정성 비교만 한다. 쌍들이 런을 공유해 독립이
//             아니므로 부트스트랩 CI(쌍 재표집 10,000회)는 기술 통계로만 보고하고
//             "통계적 유의성" 주장은 하지 않는다.
//  안전     : 프로덕션 DB 는 readonly 로 연다. 쓰기 0 (cursor·conflicts 무접촉).
// ──────────────────────────────────────────────────────────────────────────
//
// 사용:
//   node bench/f5-order-effect-rerun.mjs --plan            # 호출 수·설계 출력
//   node bench/f5-order-effect-rerun.mjs --smoke           # 1배치 1콜 배선 확인
//   node bench/f5-order-effect-rerun.mjs --collect         # 전체 수집 (~220콜)
//   node bench/f5-order-effect-rerun.mjs --analyze <dir>   # 수집 결과 분석

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { llmJudge, committeeJudge, buildJudgePrompt } from '../dist/principle-check.js';
import { parseJsonResponse } from '../dist/llm.js';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { readFile as readFileAsync, rm as rmAsync } from 'node:fs/promises';

// ── 사전등록 파라미터 ──
const SAMPLE_SIZE = 200;
const BATCH_SIZE = 20;
const S_RUNS = 4;
const O_SEEDS = [41, 97, 131, 227, 331, 433];
const C_SEEDS = [1013, 2027, 3041, 4057];
const COMMITTEE_VOTES = 3;
const CONFIDENCE_PRIMARY = 0.8;
const PILOT_DELTA_THRESHOLD = 0.1; // 정성 비교 기준 (파일럿과 동일)
const BOOTSTRAP_ITERS = 10_000;

const DB_PATH =
  process.env.MEMORY_BANK_DB_PATH ||
  join(homedir(), '.config', 'superpowers', 'conversation-index', 'db.sqlite');

// ── 결정론 PRNG (파일럿·committeeJudge 와 동일 계열: mulberry32) ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates — rng 스트림 하나를 배치 순서대로 소비 (런 단위 결정론). */
function shuffled(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function mean(xs) {
  return xs.length === 0 ? NaN : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 쌍 재표집 부트스트랩 — 기술 통계 전용 (런 공유로 쌍 비독립, 유의성 주장 금지). */
function bootstrapCI(values, iters, rng) {
  if (values.length === 0) return { lo: NaN, hi: NaN };
  const means = new Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let k = 0; k < values.length; k++) {
      s += values[Math.floor(rng() * values.length)];
    }
    means[i] = s / values.length;
  }
  means.sort((x, y) => x - y);
  return { lo: means[Math.floor(iters * 0.025)], hi: means[Math.floor(iters * 0.975)] };
}

// ── 표본 스냅샷 (readonly) ──
// 원칙 세트는 DB 가 아니라 사전등록 seed 파일에서 핀 고정한다. 이 머신 DB 의
// principles 테이블은 비어 있고(파일럿은 다른 환경에서 실행), DB 가변 상태에
// 측정이 좌우되지 않도록 seed 를 계약으로 삼는다. 판정기는 slug/statement 만 쓴다.
const SEED_PATH = new URL('./f5-principles-seed.json', import.meta.url).pathname;

function snapshotSample() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const facts = db
      .prepare(
        `SELECT id, fact, category, scope_type, scope_project, created_at
         FROM facts WHERE is_active = 1
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(SAMPLE_SIZE);
    const seedRaw = readFileSync(SEED_PATH, 'utf8');
    const principles = JSON.parse(seedRaw).map((p, i) => ({
      id: `seed-${i}`,
      slug: p.slug,
      statement: p.statement,
      source_path: p.source ?? null,
      layer: p.layer ?? 'principle',
    }));
    const principlesSha256 = sha256(seedRaw);
    return { facts, principles, principlesSha256 };
  } finally {
    db.close();
  }
}

// ── 교차 벤더 심판 (HARNESS_JUDGE=codex) ──
// codex exec 를 read-only 샌드박스로 스폰해 동일 프롬프트(buildJudgePrompt)를 판정.
// 모델은 CODEX_MODEL(기본 gpt-5.6-luna) + reasoning effort low. 실패는 throw(fail-stop).
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.6-luna';
let codexSeq = 0;
function codexExec(prompt, timeoutMs = 180_000) {
  const outFile = `${tmpdir()}/f5-codex-${process.pid}-${codexSeq++}.txt`;
  return new Promise((resolve, reject) => {
    const child = execFile(
      'codex',
      ['exec', '-m', CODEX_MODEL, '-c', 'model_reasoning_effort=low', '-s', 'read-only', '-o', outFile, '-'],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      async (err) => {
        try {
          const text = await readFileAsync(outFile, 'utf8').catch(() => '');
          await rmAsync(outFile, { force: true }).catch(() => {});
          if (err && !text) return reject(new Error(`codex exec failed: ${String(err).slice(0, 200)}`));
          resolve(text);
        } catch (e) {
          reject(e);
        }
      },
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const codexJudge = async (facts, principles) => {
  const { system, user } = buildJudgePrompt(facts, principles);
  const raw = await codexExec(`${system}\n\n${user}`);
  const parsed = parseJsonResponse(raw);
  if (parsed === null && /rate limit|quota|error/i.test(raw.slice(0, 200)) && raw.trim().length < 300) {
    throw new Error(`codex judge error response: ${raw.trim().slice(0, 160)}`);
  }
  return parsed;
};

const ACTIVE_JUDGE = process.env.HARNESS_JUDGE === 'codex' ? codexJudge : llmJudge;
const JUDGE_LABEL = process.env.HARNESS_JUDGE === 'codex'
  ? `codex:${CODEX_MODEL}+low`
  : (process.env.MEMORY_BANK_FACT_MODEL || 'haiku (default)');

function partitionBatches(facts) {
  const batches = [];
  for (let i = 0; i < facts.length; i += BATCH_SIZE) {
    batches.push(facts.slice(i, i + BATCH_SIZE));
  }
  return batches;
}

/** runPrincipleCheck 과 동일한 검증 규칙 (저장 없이 집계만). */
function validateFindings(findings, batch, slugSet) {
  const valid = [];
  if (!Array.isArray(findings)) return valid;
  for (const f of findings) {
    if (
      !Number.isInteger(f.fact_index) ||
      f.fact_index < 0 ||
      f.fact_index >= batch.length ||
      typeof f.principle_slug !== 'string' ||
      !slugSet.has(f.principle_slug) ||
      f.verdict !== 'contradicts' ||
      typeof f.confidence !== 'number' ||
      f.confidence < 0 ||
      f.confidence > 1
    ) {
      continue;
    }
    valid.push({
      fact_id: batch[f.fact_index].id,
      principle_slug: f.principle_slug,
      confidence: f.confidence,
      reasoning: typeof f.reasoning === 'string' ? f.reasoning.slice(0, 300) : null,
    });
  }
  return valid;
}

// ── 런 실행 ──
/**
 * 단일표 런: 배치 구성 고정, 배치 내 순서만 조건에 따라 결정.
 * seed=null 이면 canonical(S), 숫자면 그 시드의 mulberry32 스트림으로
 * 각 배치를 순서대로 셔플(O).
 */
async function runSingleVote(batches, principles, seed, label, log) {
  const rng = seed == null ? null : mulberry32(seed);
  const findings = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = rng ? shuffled(batches[b], rng) : batches[b];
    const out = await ACTIVE_JUDGE(batch, principles);
    const valid = validateFindings(out, batch, new Set(principles.map((p) => p.slug)));
    findings.push(...valid);
    log({ type: 'batch', run: label, batch: b, judged: batch.length, raw: Array.isArray(out) ? out.length : null, valid: valid.length });
  }
  return findings;
}

/** 위원회 런(after 축): 배포본 committeeJudge — canonical 입력, 표별 셔플은 내부에서. */
async function runCommittee(batches, principles, seed, label, log) {
  const judge = committeeJudge(ACTIVE_JUDGE, COMMITTEE_VOTES, mulberry32(seed));
  const findings = [];
  for (let b = 0; b < batches.length; b++) {
    const out = await judge(batches[b], principles);
    const valid = validateFindings(out, batches[b], new Set(principles.map((p) => p.slug)));
    findings.push(...valid);
    log({ type: 'batch', run: label, batch: b, judged: batches[b].length, raw: Array.isArray(out) ? out.length : null, valid: valid.length });
  }
  return findings;
}

const toSet = (findings, threshold) =>
  new Set(
    findings
      .filter((f) => (threshold == null ? true : f.confidence >= threshold))
      .map((f) => `${f.fact_id}::${f.principle_slug}`),
  );

// ── 수집 ──
async function collect(outDir, { resume = false, design = null } = {}) {
  const D = design ?? { sRuns: S_RUNS, oSeeds: O_SEEDS, cSeeds: C_SEEDS };
  mkdirSync(outDir, { recursive: true });
  const rawPath = join(outDir, 'raw.jsonl');
  const log = (obj) => {
    appendFileSync(rawPath, JSON.stringify(obj) + '\n');
    if (obj.type === 'batch') console.log(`[${obj.run}] batch ${obj.batch} judged=${obj.judged} valid=${obj.valid}`);
    else if (obj.type === 'run-done') console.log(`── ${obj.run} 완료: findings ${obj.findings}`);
  };

  const { facts, principles, principlesSha256 } = snapshotSample();
  if (facts.length < SAMPLE_SIZE) {
    console.error(`표본 부족: active facts ${facts.length} < ${SAMPLE_SIZE}`);
    process.exit(2);
  }
  const batches = partitionBatches(facts);
  const sampleSha256 = sha256(facts.map((f) => f.id).join('\n'));

  // resume: 완료(run-done) 런은 스킵. 표본·원칙이 원 수집과 달라졌으면 중단 —
  // 다른 입력의 런을 한 결과 디렉토리에 섞으면 측정이 오염된다.
  const doneRuns = new Set();
  if (resume && existsSync(rawPath)) {
    const prior = readFileSync(rawPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const meta = prior.find((l) => l.type === 'meta');
    if (!meta) { console.error('resume: meta 없음'); process.exit(2); }
    if (meta.sampleSha256 !== sampleSha256 || meta.principlesSha256 !== principlesSha256) {
      console.error(`resume 중단: 표본/원칙 드리프트 (sample ${meta.sampleSha256 === sampleSha256 ? 'ok' : 'CHANGED'}, principles ${meta.principlesSha256 === principlesSha256 ? 'ok' : 'CHANGED'})`);
      process.exit(2);
    }
    for (const l of prior) if (l.type === 'run-done') doneRuns.add(l.run);
    log({ type: 'resume-meta', resumedAt: new Date().toISOString(), skippingRuns: [...doneRuns] });
    console.log(`resume: 완료 런 ${doneRuns.size}개 스킵 — ${[...doneRuns].join(', ')}`);
  } else {
    log({
      type: 'meta',
      startedAt: new Date().toISOString(),
      dbPath: DB_PATH,
      sampleSize: facts.length,
      sampleSha256,
      principles: principles.length,
      principlesSha256,
      config: { SAMPLE_SIZE, BATCH_SIZE, sRuns: D.sRuns, oSeeds: D.oSeeds, cSeeds: D.cSeeds, COMMITTEE_VOTES, CONFIDENCE_PRIMARY },
      judgeModel: JUDGE_LABEL,
    });
  }

  const runs = [];
  for (let i = 1; i <= D.sRuns; i++) runs.push({ label: `S${i}`, kind: 'single', seed: null });
  for (const s of D.oSeeds) runs.push({ label: `O${s}`, kind: 'single', seed: s });
  for (const s of D.cSeeds) runs.push({ label: `C${s}`, kind: 'committee', seed: s });
  const pending = runs.filter((r) => !doneRuns.has(r.label));

  // 실행 병렬화는 런 단위만 — 런 내부는 순차라 O 런의 rng 스트림 결정론이 보존된다.
  // (측정 설계가 아니라 실행 세부: 각 판정 콜은 상호 독립)
  const CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.HARNESS_CONCURRENCY || '3', 10) || 3));
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const r = pending[next++];
      const findings =
        r.kind === 'single'
          ? await runSingleVote(batches, principles, r.seed, r.label, log)
          : await runCommittee(batches, principles, r.seed, r.label, log);
      log({ type: 'run-done', run: r.label, kind: r.kind, seed: r.seed, findings: findings.length, detail: findings });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log({ type: 'collect-done', finishedAt: new Date().toISOString() });
  console.log(`\n수집 완료 → ${rawPath}\n분석: node bench/f5-order-effect-rerun.mjs --analyze ${outDir}`);
}

// ── 분석 ──
function analyze(outDir) {
  const lines = readFileSync(join(outDir, 'raw.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.type === 'meta');
  const runDone = lines.filter((l) => l.type === 'run-done');
  const sets = new Map();
  for (const r of runDone) {
    sets.set(r.run, {
      kind: r.kind,
      primary: toSet(r.detail, CONFIDENCE_PRIMARY),
      secondary: toSet(r.detail, null),
    });
  }
  const labels = (prefix) => [...sets.keys()].filter((k) => k.startsWith(prefix));
  const pairsWithin = (ls) => ls.flatMap((a, i) => ls.slice(i + 1).map((b) => [a, b]));
  const pairsAcross = (as, bs) => as.flatMap((a) => bs.map((b) => [a, b]));

  const S = labels('S'), O = labels('O'), C = labels('C');
  const rng = mulberry32(20260806);
  const summarize = (tier) => {
    const J = (pairs) => pairs.map(([a, b]) => jaccard(sets.get(a)[tier], sets.get(b)[tier]));
    const jSS = J(pairsWithin(S)), jSO = J(pairsAcross(S, O)), jOO = J(pairsWithin(O)), jCC = J(pairsWithin(C));
    const deltaSamples = [];
    // 부트스트랩: SS·SO 쌍 리스트를 각각 재표집해 delta 분포 (기술 통계)
    for (let i = 0; i < BOOTSTRAP_ITERS; i++) {
      const m = (xs) => mean(Array.from({ length: xs.length }, () => xs[Math.floor(rng() * xs.length)]));
      deltaSamples.push(m(jSS) - m(jSO));
    }
    deltaSamples.sort((a, b) => a - b);
    return {
      setSizes: Object.fromEntries([...sets.entries()].map(([k, v]) => [k, v[tier].size])),
      J_SS: { mean: mean(jSS), pairs: jSS.length, ci: bootstrapCI(jSS, BOOTSTRAP_ITERS, mulberry32(11)) },
      J_SO: { mean: mean(jSO), pairs: jSO.length, ci: bootstrapCI(jSO, BOOTSTRAP_ITERS, mulberry32(13)) },
      J_OO: { mean: mean(jOO), pairs: jOO.length },
      J_CC: { mean: mean(jCC), pairs: jCC.length, ci: bootstrapCI(jCC, BOOTSTRAP_ITERS, mulberry32(17)) },
      orderEffectDelta: mean(jSS) - mean(jSO),
      deltaCI: {
        lo: deltaSamples[Math.floor(BOOTSTRAP_ITERS * 0.025)],
        hi: deltaSamples[Math.floor(BOOTSTRAP_ITERS * 0.975)],
      },
      pilotThreshold: PILOT_DELTA_THRESHOLD,
    };
  };

  const result = {
    meta: { sampleSha256: meta.sampleSha256, sampleSize: meta.sampleSize, principles: meta.principles, principlesSha256: meta.principlesSha256, judgeModel: meta.judgeModel ?? 'haiku (default)', config: meta.config },
    primary: summarize('primary'),
    secondary: summarize('secondary'),
  };
  writeFileSync(join(outDir, 'analysis.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n분석 저장 → ${join(outDir, 'analysis.json')}`);
}

// ── CLI ──
const argv = process.argv.slice(2);
if (argv.includes('--plan')) {
  const single = (S_RUNS + O_SEEDS.length) * Math.ceil(SAMPLE_SIZE / BATCH_SIZE);
  const committee = C_SEEDS.length * Math.ceil(SAMPLE_SIZE / BATCH_SIZE) * COMMITTEE_VOTES;
  console.log(JSON.stringify({ singleVoteCalls: single, committeeCalls: committee, totalCalls: single + committee, runs: S_RUNS + O_SEEDS.length + C_SEEDS.length }, null, 2));
} else if (argv.includes('--smoke')) {
  const { facts, principles } = snapshotSample();
  const batch = partitionBatches(facts)[0];
  console.log(`smoke: 1배치 ${batch.length} facts, principles ${principles.length}`);
  const out = await ACTIVE_JUDGE(batch, principles);
  const valid = validateFindings(out, batch, new Set(principles.map((p) => p.slug)));
  console.log(`raw findings: ${Array.isArray(out) ? out.length : out} / valid: ${valid.length}`);
  console.log(JSON.stringify(valid.slice(0, 3), null, 2));
  process.exit(0); // Agent SDK 가 핸들을 남겨 이벤트 루프가 안 비는 경우 대비 — 명시 종료
} else if (argv.includes('--probe')) {
  // rate limit 회복 탐지: 초소형 판정 1콜. 성공 exit 0 / 실패 exit 2.
  const { callHaiku } = await import('../dist/llm.js');
  try {
    const raw = process.env.HARNESS_JUDGE === 'codex'
      ? await codexExec('Reply with exactly: []')
      : await callHaiku('Reply with exactly: []', 'Reply with exactly: []', 16);
    if (/rate limit|API Error|overloaded/i.test(raw)) { console.log(`probe: limited — ${raw.slice(0, 80)}`); process.exit(2); }
    console.log(`probe: ok — ${raw.trim().slice(0, 40)}`);
    process.exit(0);
  } catch (e) {
    console.log(`probe: fail — ${String(e).slice(0, 120)}`);
    process.exit(2);
  }
} else if (argv.includes('--model-check')) {
  // 교차 모델 검증 (사전등록 축소 설계): 질문은 delta 의 존재 여부뿐이므로
  // S 3런 + O 시드 3종(41/97/131) = 60콜, 위원회 생략. 심판 모델은
  // MEMORY_BANK_FACT_MODEL 로 지정하고 meta.judgeModel 에 기록된다.
  const model = process.env.HARNESS_JUDGE === 'codex' ? `codex_${CODEX_MODEL}` : process.env.MEMORY_BANK_FACT_MODEL;
  if (!model) { console.error('--model-check 는 MEMORY_BANK_FACT_MODEL 또는 HARNESS_JUDGE=codex 지정 필수'); process.exit(2); }
  const resumeIdx2 = argv.indexOf('--resume');
  if (resumeIdx2 !== -1) {
    const dir = argv[resumeIdx2 + 1];
    if (!dir) { console.error('--resume <dir>'); process.exit(2); }
    await collect(dir, { resume: true, design: { sRuns: 3, oSeeds: [41, 97, 131], cSeeds: [] } });
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await collect(join('bench', 'results', `f5-model-${model.replace(/[^a-z0-9.-]/gi, '_')}-${stamp}`), {
      design: { sRuns: 3, oSeeds: [41, 97, 131], cSeeds: [] },
    });
  }
  process.exit(0);
} else if (argv.includes('--collect')) {
  const resumeIdx = argv.indexOf('--resume');
  if (resumeIdx !== -1) {
    const dir = argv[resumeIdx + 1];
    if (!dir) { console.error('--resume <dir>'); process.exit(2); }
    await collect(dir, { resume: true });
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await collect(join('bench', 'results', `f5-rerun-${stamp}`));
  }
  process.exit(0);
} else if (argv.includes('--analyze')) {
  const dir = argv[argv.indexOf('--analyze') + 1];
  if (!dir) { console.error('--analyze <dir>'); process.exit(2); }
  analyze(dir);
} else {
  console.log('usage: --plan | --smoke | --collect | --analyze <dir>');
}
