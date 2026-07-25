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

### F2 적용 실측 (2026-07-25, feature/260725-f2-judge-precision `d2daa08`)

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
- 부수 실측 2 — **신규 FP 모드 2종이 after 양 런에서 안정 재현** (F3 후보, 가드 추가는
  measured-improvement-only에 따라 별도 측정 라운드로):
  1. 추측·가정의 위반화: "risks irreversible…", "If … currently …" 류 리스크/가정 서술을
     실행된 위반으로 판정 (`3a1791e0`, `9fbc6b54`)
  2. 승인 증거 부재 추론: fact에 승인 단계 언급이 없다는 이유만으로 planner-executor
     위반 판정 — 부재≠위반의 변형 (`f288d14e`, `9fe88b32` 목표 서술 포함)
