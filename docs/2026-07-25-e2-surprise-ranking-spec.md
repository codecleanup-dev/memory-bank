# E2 스펙 — surprise 점수 (주입 랭킹 필드)

- 날짜: 2026-07-25 / 브랜치: `feature/260725-e2-surprise`
- 선행 문서: `docs/2026-07-25-retrieval-trace-experiment.md`의 후순위 조항("별도 스펙 전 착수 금지") 이행.
  설계 합의 출처: 10이론 검토 2·3차 — PP("메모리 가치 = 모델/코퍼스가 이미 아는 것과의 편차") +
  Shannon(novelty) 합본, correction-driven-memory가 기존 실증.

## 정의 (결정론)

```
surprise(fact) = 1 − max cosine 유사도(fact 임베딩, 기존 활성 facts의 임베딩)
```

- EN/KR 이중 벡터(vec_facts, vec_facts_kr) 중 **최대 유사도** 사용 (검색과 동일 의미론).
- 범위 [0,1]. 비교 대상 없음(첫 fact 등) → 1.0.
- **측정 시점 의미론**: insert 시점의 코퍼스 대비 값. 코퍼스가 자라면 낡는다 — F1과 같은
  staleness 클래스임을 명시. v1은 재계산하지 않고, NULL=미측정으로 구분(coverage 원칙).

## 경계선 (모든 검토에서 합의된 불변 조항)

1. **주입/랭킹 신호로만** — 저장 차단 하드 필터 금지. 반복은 확인 신호(consolidation이 강화 담당).
2. **검색(search_facts) 랭킹 불변** — 사용자 질의 검색에는 개입하지 않는다. 대상은 UserPromptSubmit
   주입 후보 정렬뿐.
3. **soft-to-hard 승격 절차**: v1은 필드 + 관측(주입 로그 telemetry)만. 랭킹 가중치는
   `MEMORY_BANK_INJECT_SURPRISE_WEIGHT` (기본 0 = off) 뒤에 두고, 측정 게이트 통과 후에만
   기본값 상향을 논의한다.

## 구현

1. **스키마 (additive)**: `facts.surprise REAL` (NULL=미측정) — pragma_table_info 멱등 ALTER.
2. **insert 시 계산**: `insertFact` 직전/직후 1회 KNN (임베딩 이미 보유 — 비용 ~ms).
   sync-import로 들어온 타 머신 facts는 NULL 유지 → backfill이 담당.
3. **backfill CLI**: `memory-bank surprise-backfill [--limit N]` — surprise IS NULL인 활성
   fact를 keyset 커서로 배치 계산 (principle-check와 동일 패턴, LLM 불필요·전부 로컬).
4. **telemetry**: 주입 로그(inject-log)에 후보별 surprise 기록 — 관측 전용.
5. **가중 랭킹 (flag 뒤)**: 주입 후보 정렬 점수에 `w × surprise` 가산 (w = env, 기본 0).

## 측정 게이트 (기본 가중치 상향 전 통과 필수)

- **G1 분포 sanity**: backfill 후 surprise 분포가 퇴화하지 않음 (전부 ~0 / 전부 ~1 아님;
  중앙값·사분위 보고).
- **G2 face validity (PP 가설의 직접 검정)**: correction/constraint 계열 fact의 평균 surprise
  \> knowledge 계열 평균 — "교정이 곧 예측 오차"라면 참이어야 한다. 상위/하위 20건 수동 검토 병행.
- **G3 주입 델타**: w=0 vs w>0에서 주입 셋 변화율과 토큰 예산 내 고유값 비율 (관측 로그 기반).

## 게이트 실측 (2026-07-25, v1.9.0 backfill 완주 후 — live DB 16,621 facts)

- **backfill**: 16,621/16,621 측정 완료 (4런 × 5,000), 347건은 embedding 부재로 정직한 NULL 유지.
- **G1 — 조건부 통과**: 분포 min 0.000 / p25 0.044 / median 0.066 / p75 0.084 / **max 0.145**.
  퇴화 아님(사분위 스프레드 ~2×)이나 **절대 스케일이 [0, 0.145]로 압축** — e5 계열의 알려진
  유사도 압축(inject-core의 probe-baseline 주석과 동일 현상). ⇒ 가중치를 켤 경우 raw 값이 아니라
  **백분위 정규화** 값을 써야 한다 (raw w×surprise는 미미한 넛지에 불과).
- **G2 — FAIL**: user-specific(constraint+preference) 평균 **0.0635** vs generic(knowledge)
  평균 **0.0638** — 사실상 동률 (카테고리별: pattern 0.0706 > constraint 0.0660 > knowledge
  0.0638 > preference 0.0611 > decision 0.0600). **해석: 코퍼스-상대 novelty는 PP의
  "모델-상대 novelty"의 대리가 아니다.** 사용자 선호는 코퍼스 안에서 서로 뭉쳐(자기 유사)
  낮게 측정되고, 일반 지식은 주제가 다양해 높게 측정된다 — 측정이 이식 가설을 기각했다.
- **판정**: measured-improvement-only에 따라 **가중치 기본 0 유지 확정** (G2 미통과 상태에서
  랭킹 개입 금지). 필드·telemetry·backfill은 존치 — (a) 관측 데이터 축적, (b) v2 정의
  (모델-prior 기반: 추출 시 LLM에게 "일반론 vs 사용자 특이" 평점)의 비교 기준선.
- 부수 관찰: `avg(surprise | consolidated_count>1)`이 전 카테고리에서 더 낮음 (0.031~0.045)
  — 확인 누적 fact일수록 코퍼스 밀집대에 있다는 정합 신호 (측정 자체는 건강함).

## Non-goals

- 모델-prior 기반 surprise(LLM에게 "일반론인가" 묻기) — v2 후보. v1은 코퍼스-상대 결정론 정의.
- 저장/추출 게이트 개입, 검색 랭킹 개입, surprise 재계산 데몬.
