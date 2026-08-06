// F5 사후 분석 (리뷰 수리 B — 기존 수집 데이터 재계산, 신규 콜 0)
//
//  (1) 런 단위(클러스터) 부트스트랩: 쌍이 런을 공유해 종속이므로, 조건별 런을
//      재표집한 뒤 그 조합에서 쌍 Jaccard 를 재계산한다. 쌍 단위 부트스트랩보다
//      불확실성을 넓게(정직하게) 추정한다.
//  (2) 판정 시점 위치별 발견율: 셔플이 결정론(mulberry32)이라 각 런의 순열을
//      재생해 모든 발견의 "판정 시점 배치 내 위치(0..19)"를 복원할 수 있다.
//      초두/최신 효과가 보이면 위치 메커니즘의 직접 증거다. 위원회 런은 표별
//      순열이 섞여 위치가 정의되지 않으므로 제외한다(단일표 S·O·R 만).
//
// 사용: node bench/f5-post-analysis.mjs <결과디렉토리> [<추가디렉토리>...]

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SAMPLE_SIZE = 200;
const BATCH_SIZE = 20;
const CONF = 0.8;
const ITERS = 10_000;
const DB_PATH =
  process.env.MEMORY_BANK_DB_PATH ||
  join(homedir(), '.config', 'superpowers', 'conversation-index', 'db.sqlite');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffledIdx(n, rng) {
  const a = [...Array(n).keys()];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

// ── 입력 적재 ──
const dirs = process.argv.slice(2);
if (dirs.length === 0) { console.error('usage: node bench/f5-post-analysis.mjs <dir> [...]'); process.exit(2); }
const runs = new Map(); // label → { kind, seed, set(Set), findings[] }
let metaHash = null;
for (const dir of dirs) {
  const lines = readFileSync(join(dir, 'raw.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.type === 'meta');
  const h = meta.sampleSha256 ?? meta.sampleHash;
  if (metaHash && h !== metaHash) { console.error(`표본 해시 불일치: ${dir}`); process.exit(2); }
  metaHash = h;
  for (const l of lines) {
    if (l.type !== 'run-done') continue;
    const set = new Set(l.detail.filter((f) => f.confidence >= CONF).map((f) => `${f.fact_id}::${f.principle_slug}`));
    runs.set(l.run, { kind: l.kind, seed: l.seed ?? null, set, findings: l.detail });
  }
}

// ── 표본 복원 + 해시 검증 (위치 분석용) ──
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const facts = db
  .prepare(`SELECT id FROM facts WHERE is_active = 1 ORDER BY created_at, id LIMIT ?`)
  .all(SAMPLE_SIZE);
db.close();
const liveHash = sha256(facts.map((f) => f.id).join('\n'));
const sampleOk = liveHash === metaHash;
const idxOf = new Map(facts.map((f, i) => [f.id, i]));

// ── (1) 클러스터 부트스트랩 ──
const S = [...runs.keys()].filter((k) => /^S\d$/.test(k));
const O = [...runs.keys()].filter((k) => /^O\d+$/.test(k));
function pairsJ(labelsA, labelsB, same) {
  const out = [];
  if (same) {
    for (let i = 0; i < labelsA.length; i++)
      for (let j = i + 1; j < labelsA.length; j++)
        out.push(jaccard(runs.get(labelsA[i]).set, runs.get(labelsA[j]).set));
  } else {
    for (const a of labelsA) for (const b of labelsB) out.push(jaccard(runs.get(a).set, runs.get(b).set));
  }
  return out;
}
const obsDelta = mean(pairsJ(S, null, true)) - mean(pairsJ(S, O, false));
const rng = mulberry32(20260807);
const deltas = [];
for (let it = 0; it < ITERS; it++) {
  const rs = Array.from({ length: S.length }, () => S[Math.floor(rng() * S.length)]);
  const ro = Array.from({ length: O.length }, () => O[Math.floor(rng() * O.length)]);
  // 재표집에서 같은 런이 중복되면 자기쌍(J=1)이 생겨 왜곡 — 서로 다른 라벨 쌍만 사용
  const jss = [];
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++)
      if (rs[i] !== rs[j]) jss.push(jaccard(runs.get(rs[i]).set, runs.get(rs[j]).set));
  const jso = [];
  for (const a of rs) for (const b of ro) jso.push(jaccard(runs.get(a).set, runs.get(b).set));
  if (jss.length === 0 || jso.length === 0) { it--; continue; }
  deltas.push(mean(jss) - mean(jso));
}
deltas.sort((a, b) => a - b);
const clusterCI = { lo: pct(deltas, 0.025), hi: pct(deltas, 0.975) };

// ── (2) 판정 시점 위치별 발견율 (단일표 런만) ──
const posCount = Array(BATCH_SIZE).fill(0);
let posRuns = 0;
let posSkipped = [];
for (const [label, r] of runs) {
  if (r.kind !== 'single') { posSkipped.push(label); continue; }
  if (!sampleOk) break;
  posRuns += 1;
  // 순열 재생: seed null → 항등, 숫자 → 런 시작에서 rng 하나로 배치 순서대로 소비
  const rrng = r.seed == null ? null : mulberry32(r.seed);
  const perms = [];
  for (let b = 0; b < SAMPLE_SIZE / BATCH_SIZE; b++) {
    perms.push(rrng ? shuffledIdx(BATCH_SIZE, rrng) : [...Array(BATCH_SIZE).keys()]);
  }
  // perms[b][judgePos] = 호출자(캐논) 배치 내 인덱스 — shuffled()가 a[perm순서]로 재배열하므로
  const seen = new Set();
  for (const f of r.findings) {
    if (f.confidence < CONF) continue;
    const key = `${f.fact_id}`;
    if (seen.has(key)) continue; // fact 단위 위치 카운트 (fact,slug 중복 방지)
    seen.add(key);
    const gi = idxOf.get(f.fact_id);
    if (gi == null) continue;
    const b = Math.floor(gi / BATCH_SIZE);
    const caller = gi % BATCH_SIZE;
    const judgePos = perms[b].indexOf(caller);
    if (judgePos >= 0) posCount[judgePos] += 1;
  }
}
const posRate = posCount.map((c) => (posRuns ? +(c / (posRuns * (SAMPLE_SIZE / BATCH_SIZE))).toFixed(4) : null));

const result = {
  inputs: dirs,
  sampleHashOk: sampleOk,
  clusterBootstrap: {
    observedDelta: +obsDelta.toFixed(4),
    ci95: { lo: +clusterCI.lo.toFixed(4), hi: +clusterCI.hi.toFixed(4) },
    note: '런 단위 재표집(자기쌍 제외), 조건 내 런 수가 작아(4·6) CI 는 보수적 기술 통계',
  },
  positionEffect: {
    singleVoteRuns: posRuns,
    excluded: posSkipped,
    judgeTimePositionCounts: posCount,
    judgeTimePositionRate: posRate,
    note: '판정 시점 배치 내 위치별 발견 fact 수/비율 (conf>=0.8, fact 단위)',
  },
};
writeFileSync(join(dirs[0], 'post-analysis.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
