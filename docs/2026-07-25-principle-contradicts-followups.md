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

### F2 적용 실측 A (2026-07-25, `d2daa08` 가드 4종 — 단발 judge, 조건당 n=2, PR #18)

동일 200 facts `--recheck --dry-run` 재판정, judge 확률성을 반영해 **조건당 n=2**.
before = main(1.8.0) dist·threshold 0.7, after = 가드 4종 적용 빌드·`--threshold 0.7`로
전 밴드 캡처 후 0.8 효과는 동일 데이터에서 분석. 판정은 저장된 7건 pair 집합 기준.

| run | n | 정당 유지 | 저장 FP 재출현 | 0.8컷 (n / 정당 / FP) |
|---|---|---|---|---|
| before-1 | 5 | 1/2 | 1/5 | 4 / 1 / 1 |
| before-2 | 8 | 2/2 | 1/5 | 7 / 2 / 1 |
| after-1 | 8 | **2/2** | **0/5** | 7 / 2 / **0** |
| after-2 | 8 | **2/2** | **0/5** | 7 / 2 / **0** |

- **판정: 합격** — 게이트(정당 ≥2 유지 · FP ≤1 재출현)를 after 2회 모두 충족 (FP 0/5, 0.8컷에서도 동일).
- 쌍 단위보다 강한 증거는 **클래스 수준**: 측정된 4개 FP 클래스(스코프 무시 · 가역
  작업 · 관찰 fact · 아키텍처 스타일) 소속 발견이 before 3~4건/run → **after 0건/run** (2회 공히).
- 부수 실측 1 — **judge 런간 분산이 크다**: baseline 재실행조차 저장 7쌍 중 재현이 2~3쌍뿐
  (같은 클래스의 신규 유사 쌍으로 대체됨, before-1은 총 5건·before-2는 8건). 향후 판정
  게이트는 쌍 집합보다 클래스 집합 기준을 권장.
- 부수 실측 2 — **신규 FP 모드 2종이 after 양 런에서 안정 재현** (→ F3으로 승격):
  1. 추측·가정의 위반화: "risks irreversible…", "If … currently …" 류 리스크/가정 서술을
     실행된 위반으로 판정 (`3a1791e0`, `9fbc6b54`)
  2. 승인 증거 부재 추론: fact에 승인 단계 언급이 없다는 이유만으로 planner-executor
     위반 판정 — 부재≠위반의 변형 (`f288d14e`, `9fe88b32` 목표 서술 포함)

### F2 적용 실측 B (2026-07-25, feature/260725-f2-judge-precision — 반복 개선 3라운드, 게이트 PASS)

동일 첫 200 facts, 사전 선언 게이트(정당 신호 2 유지 + 기존 FP 쌍 재출현 ≤1). A와 독립 수행:

| 라운드 | 구성 | 기존 FP 재출현 | 정당 신호 | 관찰 |
|---|---|---|---|---|
| baseline | threshold 0.7, 단발 judge | — (7건: 정당2/FP5, FP율 71%) | 2/2 | FP 전부 0.75–0.85, 정당 전부 0.95 |
| R1 | 가드 4종 + threshold 0.8 | **0/5** | 1/2 | 관찰-비판 가드가 practice-in-force fact까지 제거, 신규 marginal 5 |
| R2 | 가드 정밀화 5종 (practice-in-force 예외 + "언급 부재≠위반") | **0/5** | fact 단위 2/2 (자매 원칙 재라우팅) | 단발 judge의 0.80–0.85 밴드가 런마다 다른 borderline 생성 |
| R3 | + **위원회 3표 다수결·중앙값** | **0/5** | **2/2 (exact-pair 복귀)** | 8건 중 5건 ≥0.9로 상향, 라벨 기준 FP ~2/8(25%) |

- 확정 배선(B에서 추가): 가드 5종(R2 정밀화) + 위원회 기본 3표(`--votes`, 주입 judge는 명시 시에만)
- 부수 수정(실사고 발): SDK가 rate limit을 **텍스트 결과**로 반환 → "unparseable→커서 전진"으로
  오분류되어 outage 중 facts를 조용히 스킵하던 구멍 — 파싱 실패+에러 배너일 때만 throw(미전진)로
  교정 (2026-07-25 14:32 KST rate limit 실측)

### 실측 A/B 조정 노트 (독립 2회 측정의 교차 확인)

같은 200 facts를 두 세션이 독립 측정한 결과가 서로를 보강한다:

1. **일치**: 가드 도입 후 기존 FP 클래스 소멸 (A: after 2런 0건, B: R1~R3 3런 0/5) — 가드 효과는 견고.
2. **일치**: 단발 judge의 런간 분산이 크다 (A 부수실측1 = B의 R1↔R2 관찰) — 쌍 단위 게이트는 운에 민감.
3. **상보적 해법**: A는 *판정 기준*을 클래스 집합으로 옮기길 권고, B는 *측정기 자체*를 위원회 3표로
   안정화 (R3에서 exact-pair 게이트까지 복귀). 확정 배선은 둘 다 채택: 위원회 기본 + 향후 게이트는
   클래스 기준 병기.
4. A의 잔여 FP 모드 #2(승인 부재 추론)는 B의 R2 가드("언급 부재≠위반")가 겨냥 — R3에서 ~2/8로
   잔존. F3에서 A의 모드 #1(추측·가정의 위반화)과 함께 별도 측정 라운드로.

## F3. 잔여 judge FP 모드 2종 — 가드 후보 (별도 측정 라운드 필요)

실측 A 부수실측 2에서 안정 재현, 실측 B R3에서도 잔존 (~2/8):

1. **추측·가정의 위반화**: 리스크/가정 서술("risks irreversible…", "If … currently …")을 실행된 위반으로 판정
2. **승인 증거 부재 추론**: 승인 단계 미언급만으로 위반 판정 (R2 가드가 절반 해소, 결정-서술 fact에서 잔존)

가드 추가는 measured-improvement-only에 따라 동일 200 facts 재측정 게이트 뒤에만. 큐 해소 사유
분포(false_positive 비율)가 쌓이면 원칙별 Beta prior 캘리브레이션과 병행.

## F4. portable sync transient IO 재시도에 backoff 부재

2026-07-25 05:32Z (load avg 49–64 폭주 창): `portable_sync`가 facts-ontology 5개 파일 read에서
errno -11 transient 실패 → **즉시 재시도 3연속 전멸** → 파일 스킵 → 트랜잭션 안전 중단
(exit 75, staged 미승격 — fail-safe 정상 작동, 데이터 무손상). 부하 정상화 후 동일 파일 정상
read 실측 (로그: `memory-bank-sync-loop-20260725T052408Z`).

개선안: transient IO 재시도에 지수 backoff (예: 1s/4s/16s) — load-spike 지속시간은 즉시
재시도 3회의 시간창보다 길다. 측정: 동일 클래스 재발 시 backoff 유무별 트랜잭션 완주율.
