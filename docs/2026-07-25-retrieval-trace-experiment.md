# retrieval trace 실험 후보 (2026-07-25)

> repo 이슈가 비활성화라 docs로 추적. 출처: 2026-07-25 인지 축 합의(베이즈·인지과학·그래프 중심,
> QM은 구조 채석장만) 후속 — 산란 이론·Friston(AIF/FEP/PP) 글의 3단 심사(de-jargon → 정식 홈 →
> 고유 잔여물)에서 살아남은 유일 신규 구조. 해당 글 전체 수율 ~1.5/10 (FEP 제안은 기구현
> consistency+resolve 큐의 리네이밍으로 기각). 관련: `docs/2026-07-25-principle-contradicts-followups.md`

## E1. 읽기측 강화 신호 부재 — retrieval trace

강화 신호가 현재 **쓰기측뿐**이다: `consolidated_count`는 응고 시점에 증가하지만, **질의가 어떤
fact를 활성화했고 그중 무엇이 답에 실제 사용됐는지**는 어디에도 기록되지 않는다.

실측 근거 (2026-07-25):

- CREATE TABLE 전수 14종(exchanges·tool_calls·facts·fact_revisions·fts_meta·ontology_*·
  principles·principle_conflicts·principle_check_state·extraction_log)에 검색/트레이스 계열 없음.
  `search_history|retrieval_trace|query_log` grep 0건.
- 라이브 그래프: 활성 fact 16,953 / orphan(무관계) 30.9%. orphan과 직교하는 축 —
  "관계는 있으나 **읽힌 적 없는**" dead fact는 현재 측정 자체가 불가능.

de-jargon 결과 이것은 IR의 query log / relevance feedback, LLM observability의 retrieval
tracing에 해당하는 표준 관행이다. "인지적 산란" 같은 물리 명명은 채택하지 않는다 — 은유는
채석장이었고 남는 것은 계측이다.

채워지면 얻는 것:

1. **엣지 강화 데이터 소스** — 자주 함께 활성화·사용되는 fact 쌍의 traversal 카운트
   (consolidation dynamics의 전제 데이터).
2. **dead fact 탐지** — 관계 유무와 무관하게 N일간 활성화 0인 fact 목록 → 정리/보강 대상.
3. **설명가능성** — "왜 이 답인가"를 활성화→사용 경로로 재구성.

### 설계 스케치 (observation-only first — principle-check와 동일 패턴)

- additive 테이블: `retrieval_trace(id, ts, tool, query_text, activated_fact_ids JSON,
  used_fact_ids JSON NULL, conflict_fact_ids JSON NULL, session_id TEXT NULL)`
- 기록 지점: `src/mcp-server.ts`의 `search`(386) · `search_facts`(514) · `explore_graph`(893)
  핸들러 — 결과 반환 직전 activated만 기록. 기록 실패는 검색을 막지 않는다(fail-open, 관찰 전용).
- **used 귀속은 v1에서 비운다**(NULL). cited ≠ causally-used 난제가 핵심 리스크라 v2로 분리:
  - (a) 답변에 fact ID 구조화 인용을 강제하는 프록시
  - (b) 표본 ablation 대조 프록시
- **자동 개입 금지**: trace를 rerank·기록 필터링에 자동 반영하지 않는다 (principle-contradicts의
  report-first / 표시 전용 경계와 동일 — Identity 불개입 합의의 확장).

### 측정 게이트 (채택 전 통과 필수 — measured-improvement-only)

1. 축적: 7일간 trace ≥ 50건 (실사용 존재 증명 — 미달이면 계측 자체가 무의미, discard).
2. 오버헤드: search p95 지연 증가 ≤ 5% (before/after 실측).
3. 신호 유용성: dead-fact 후보 목록이 실제 정리/강화 행동 ≥ 1회로 이어짐 — 리포트만 쌓이면 discard.
4. v2(used 귀속) 진입 조건: 20건 표본 수동 대조에서 귀속 precision ≥ 0.7.

## 후순위 후보 (미착수 — 별도 스펙 전 착수 금지)

- **E2. novelty 입장 게이트** (Shannon 잔여물): fact 추출 시 `novelty ≈ 1 − max 유사도` 임계
  미달이면 신규 저장 대신 기존 fact 강화로 라우팅. 현행 dedup·consolidation과 중복 범위 실측 후 판단.
- **E3. expected/actual 델타** (AIF·FEP·PP 가족 전체의 정직한 잔여물): decision fact에
  `expected_outcome` 기록 → 사후 `actual` 대조 → 불일치 시 correction/CONTRADICTS 생성.
