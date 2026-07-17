/**
 * inject-ledger — 세션당 "이미 주입한 fact id" 원장 (bounded, TTL).
 *
 * 왜: UserPromptSubmit 주입에 세션 dedup 이 없어서 같은 fact 가 한 세션에서
 * 반복 주입됐다 (실측: 주입률 74%, 평균 5.5~8건/프롬프트 × fact 평균 140자
 * ≈ ~470 tok/프롬프트, 30-프롬프트 세션 ≈ 10k tok — 상당분이 동일 fact 반복).
 * 이미 대화 컨텍스트에 들어간 fact 의 재주입은 순수 토큰 낭비다.
 *
 * 설계 (bounded-constant-memory-injection):
 *  - 세션당 파일 1개: <indexDir>/state/inject-ledger/<session_id>.json
 *  - bounded: id 400개 상한 — 초과 시 oldest evict (삽입순 배열 유지)
 *  - TTL: 저장 시 7일 지난 원장 파일 정리 (디렉토리 소형 — 나열 비용 무시 가능)
 *  - 원자적 쓰기: tmp + rename (부분 쓰기 파일이 다음 로드를 깨지 않게)
 *  - session_id 는 파일명이 되므로 화이트리스트 sanitize (path traversal 차단)
 *  - 모든 실패는 best-effort: 원장이 깨져도 주입 자체를 막지 않는다
 *    (dedup 은 최적화지 정합성 요건이 아님 — fail-open 이 옳다)
 */
import fs from 'node:fs';
import path from 'node:path';
import { getIndexDir } from './paths.js';

const MAX_IDS = 400;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TMP_TTL_MS = 60 * 60 * 1000;

export function ledgerDir(): string {
  return path.join(getIndexDir(), 'state', 'inject-ledger');
}

/** 파일명 안전화: uuid/영숫자/dash/underscore 외 전부 제거. 빈 결과면 null. */
export function sanitizeSessionId(sessionId: string | undefined | null): string | null {
  if (!sessionId) return null;
  const clean = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  return clean.length >= 4 ? clean : null;
}

function ledgerPath(cleanId: string): string {
  return path.join(ledgerDir(), cleanId + '.json');
}

/** 세션의 기존 주입 id 집합. 없거나 깨졌으면 빈 집합 (fail-open). */
export function loadLedger(sessionId: string | undefined | null): Set<string> {
  const id = sanitizeSessionId(sessionId);
  if (!id) return new Set();
  try {
    const raw = fs.readFileSync(ledgerPath(id), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
  } catch { /* absent/corrupt → empty */ }
  return new Set();
}

/**
 * 신규 주입 id 를 원장에 추가 저장. 삽입순 유지 + 400 상한(oldest evict).
 * 저장 시 7일 지난 다른 세션 원장을 opportunistic 정리.
 */
export function appendLedger(
  sessionId: string | undefined | null,
  existing: Set<string>,
  newIds: string[],
): void {
  const id = sanitizeSessionId(sessionId);
  if (!id || newIds.length === 0) return;
  const p = ledgerPath(id);
  // [fork] writer 고유 tmp: 데몬 동시 요청(in-flight 4)과 콜드폴백 프로세스가
  // 같은 세션 원장을 쓸 수 있다 — 공유 tmp 이름이면 두 writer 가 서로의
  // 스냅샷을 덮고 rename 을 경합한다 (적대 리뷰 발견, 2026-07-17).
  // 고유 tmp 는 모든 rename 을 "완결 스냅샷의 원자 교체"로 유지한다.
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const dir = ledgerDir();
    fs.mkdirSync(dir, { recursive: true });
    // [fork] 쓰기 시점 재로드 + 합집합: `existing` 은 프롬프트 시작에 로드된
    // 스냅샷이라 그대로 되쓰면 그 사이 다른 writer 가 저장한 id 를 전부
    // 지운다 (lost update). 재로드-합집합은 유실 창을 프롬프트 연산 전체에서
    // 이 read→rename 갭으로 줄인다. 락은 두지 않는다 — dedup 은 최적화지
    // 정합성 요건이 아니라 fail-open/best-effort 가 계약이다.
    const current = loadLedger(id);
    const merged: string[] = [...current];
    for (const x of [...existing, ...newIds]) {
      if (!current.has(x)) { merged.push(x); current.add(x); }
    }
    const bounded = merged.length > MAX_IDS ? merged.slice(merged.length - MAX_IDS) : merged;
    fs.writeFileSync(tmp, JSON.stringify(bounded));
    fs.renameSync(tmp, p);
    pruneOldLedgers(dir);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 이미 없음 — rename 성공 후 실패 등 */ }
  }
}

/** 7일 넘은 원장 파일 정리 — 세션 원장은 세션과 함께 죽는 상태이지 지식이 아니다.
 * [fork] writer 고유 tmp 도입으로 크래시가 고아 tmp 를 남길 수 있어 1시간 TTL 로 함께 정리. */
function pruneOldLedgers(dir: string): void {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const isLedger = f.endsWith('.json');
      const isOrphanTmp = f.endsWith('.tmp');
      if (!isLedger && !isOrphanTmp) continue;
      const fp = path.join(dir, f);
      try {
        const age = now - fs.statSync(fp).mtimeMs;
        if (age > (isLedger ? TTL_MS : TMP_TTL_MS)) fs.unlinkSync(fp);
      } catch { /* race — fine */ }
    }
  } catch { /* best-effort */ }
}
