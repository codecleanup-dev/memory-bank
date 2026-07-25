# principle-contradicts 후속 과제 (2026-07-25)

> repo 이슈가 비활성화라 docs로 추적. 출처: v1.8.0 릴리스(PR #12/#13/#14) 직후 라이브 첫 트랜치
> 실측(200 facts / 9 principles). 관련 스펙: `docs/2026-07-25-principle-contradicts.md`

## F1. fact revision이 기존 판정을 무효화하지 않음 — 측정 시점 바인딩

판정(verdict)은 **측정 시점의 fact 텍스트**에 대해서만 유효한데, 현재 구현은 이를 바인딩하지 않는다:

1. `revise_fact`는 텍스트를 바꾸지만 `created_at`을 유지 → keyset 커서 `(created_at, id)` 뒤라 **재측정되지 않음**. 옛 판정이 새 텍스트에 계속 붙음 (stale verdict).
2. consolidation(EVOLUTION) 텍스트 갱신 경로도 동일.
3. 역방향: revise로 모순이 해소돼도 **활성 conflict가 남음** (insert-or-ignore라 재검사도 청소 못함).

### 설계 스케치
- `principle_recheck_queue(fact_id PK)` additive 테이블 + revise/consolidation 텍스트 변경 경로에서 enqueue
- `runPrincipleCheck`가 큐 우선 드레인 + **reconcile 의미론**:
  - 재판정 발견 쌍 → 유지/삽입
  - 재판정 미발견인 해당 fact의 활성 **llm-method** 쌍 → `is_active=0` + `resolution NULL` (system-cleared — 사람 해소 4종과 구분)
  - 사람 해소 쌍(resolution NOT NULL)은 불변 (영속성 계약 유지)
- coverage에 큐 잔량 반영. manual/import 쌍은 reconcile 대상 아님 (사람 소유). report-first 유지.

## F2. judge 정밀도 — "automatic X → 비가역 위반" 과잉 판정 (실측 FP 5/7)

첫 트랜치 표면화 7건 중 정당 ~2 / 과잉 ~5 (FP율 71%). 과잉 패턴 2종:

1. **스코프 무시**: 크롤링(읽기 전용)·개선 반복(가역)을 `human-gate-irreversible` 위반으로 판정 — 원칙 진술의 괄호 스코프(배포·push·DB 파괴·시크릿)를 무시.
2. **부재≠위반**: "테스트 고려가 빠져 있다"류 관찰/진단 fact를 위반 실행으로 판정.

정당 사례(기능 가치 확인): "빌드 성공을 테스트 완료로 취급" ⚠ evidence-over-claims (0.95).

### 개선안 (다음 릴리스, 측정 게이트 뒤)
- 프롬프트 명시 추가: (a) 원칙에 열거된 스코프 밖은 위반 아님 (b) 읽기 전용/가역 작업은 irreversible 아님 (c) 문제를 관찰/비판하는 fact는 위반 실행 기록이 아님 (d) 아키텍처 스타일 선택은 propose-approve-execute 붕괴가 아님
- threshold 0.7→0.8 검토 (이번 실측 0.75~0.80 구간 전부 FP)
- **효과 측정**: 동일 200 facts를 `--recheck --dry-run` 재판정 → before/after FP율 비교 (measured-improvement-only 준수). 큐의 기존 7건 해소 사유 분포도 캘리브레이션 데이터.

### F2 적용 실측 (2026-07-25, feature/260725-f2-judge-precision — 게이트 PASS)

동일 첫 200 facts를 `--recheck --dry-run`으로 3라운드 재판정 (사전 선언 게이트: 정당 신호 2 유지 + 기존 FP 쌍 재출현 ≤1):

| 라운드 | 구성 | 기존 FP 재출현 | 정당 신호 | 관찰 |
|---|---|---|---|---|
| baseline | threshold 0.7, 단발 judge | — (7건: 정당2/FP5, FP율 71%) | 2/2 | FP 전부 0.75–0.85, 정당 전부 0.95 |
| R1 | 가드 4종 + threshold 0.8 | **0/5** | 1/2 | 관찰-비판 가드가 practice-in-force fact까지 제거, 신규 marginal 5 |
| R2 | 가드 정밀화 5종 (practice-in-force 예외 + "언급 부재≠위반") | **0/5** | fact 단위 2/2 (자매 원칙 재라우팅) | 단발 judge의 0.80–0.85 밴드가 런마다 다른 borderline 생성 — 프롬프트만으론 고정 불가 |
| R3 | + **위원회 3표 다수결·중앙값** | **0/5** | **2/2 (exact-pair 복귀)** | 8건 중 5건 ≥0.9로 상향, 내 라벨 기준 FP ~2/8(25%) |

- 확정 배선: NOT-contradiction 가드 5종 + threshold 0.8(실측 밴드 캘리브레이션) + 위원회 기본 3표(`--votes`, 주입 judge는 명시 시에만) + `--threshold`
- 부수 수정(실사고 발): SDK가 rate limit을 **텍스트 결과**로 반환 → "unparseable→커서 전진"으로 오분류되어 outage 중 facts를 조용히 스킵하던 구멍 — 파싱 실패+에러 배너일 때만 throw(미전진)로 교정 (2026-07-25 14:32 KST rate limit 실측)
- 잔여 FP 클래스: "재설계/제거 결정에 승인 언급 없음=위반" (~2/8) — 큐 해소 사유 축적 후 재캘리브레이션 (Beta prior 후보)

## F3. portable sync transient IO 재시도에 backoff 부재

2026-07-25 05:32Z (load avg 49–64 폭주 창): `portable_sync`가 facts-ontology 5개 파일 read에서
errno -11 transient 실패 → **즉시 재시도 3연속 전멸** → 파일 스킵 → 트랜잭션 안전 중단
(exit 75, staged 미승격 — fail-safe 정상 작동, 데이터 무손상). 부하 정상화 후 동일 파일 정상
read 실측 (로그: `memory-bank-sync-loop-20260725T052408Z`).

개선안: transient IO 재시도에 지수 backoff (예: 1s/4s/16s) — load-spike 지속시간은 즉시
재시도 3회의 시간창보다 길다. 측정: 동일 클래스 재발 시 backoff 유무별 트랜잭션 완주율.
