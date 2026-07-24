# fact↔principle 교차 모순 (Principle Contradicts)

- 날짜: 2026-07-25
- 브랜치: `feature/260725-principle-contradicts`
- 배경: 기존 consistency 큐는 fact↔fact CONTRADICTS/SUPERSEDES만 다룬다. 계층 관점(Identity→Principles→Policies→Facts)에서
  빠져 있던 축은 **fact가 사용자의 운영 원칙(principle)과 모순되는 경우**의 간섭 신호다.
  (설계 논의 출처: grover-transfer의 "모순을 숨기지 말고 검색 시점에 노출" + 가치 계층 논의)

## 설계 원칙 (경계선)

1. **원칙은 표시·게이트에만 개입한다.** fact의 기록, 진위 판정, 검색 랭킹에는 절대 개입하지 않는다
   (확증편향 구조화 방지). 검색 결과 순서는 변경 없음 — 주석(annotation)만 추가.
2. **Report-first.** consistency 철학 그대로: 어떤 것도 자동으로 비활성화/삭제하지 않는다.
   해소는 사람(CLI) 또는 명시적으로 게이트된 파이프라인의 결정.
3. **원칙 등록은 human-gate.** 자동 스크랩 없음 — CLI `add`/`import`로만 등록 (Identity 계층 변경은 사람 승인이라는 상위 규칙의 구현).
4. **사람의 해소 결정은 영속.** 한 번 `false_positive`/`acknowledged`로 해소된 (principle, fact) 쌍은 재탐지가 다시 열지 않는다
   (UNIQUE + ON CONFLICT DO NOTHING).
5. **판정 기본값은 보수적.** LLM judge는 명백한 직접 모순만, confidence ≥ 0.7만 저장. 게이트 편입은 opt-in (`--gate-principles`) —
   soft-to-hard 승격 원칙(관측 먼저, 차단은 나중).

## 스키마 (additive)

```sql
principles(id PK, slug UNIQUE, statement, source_path, layer IN(identity|principle|policy),
           is_active, created_at, updated_at)
principle_conflicts(id PK, principle_id FK, fact_id FK, reasoning, method IN(llm|manual|import),
                    confidence, is_active, resolution, created_at, resolved_at)
  UNIQUE(principle_id, fact_id)
principle_check_state(key PK, value)   -- 'cursor' = JSON {created_at, id, principles_hash}
```

- "활성 모순" 정의: conflict.is_active=1 AND fact.is_active=1 AND principle.is_active=1 (active-active-active).
- fact가 deprecate되거나 원칙이 비활성화되면 모순은 자동으로 큐에서 사라진다 (행 삭제 없이).

## 탐지 파이프라인 (`principle-check`)

- 활성 fact 전체를 keyset 커서(`(created_at, id)`, 기존 `idx_facts_active_created_id` 재사용)로 배치 순회.
- 배치당 기본 20 facts, 런당 기본 200 facts. judge는 주입 가능(`PrincipleJudge`) — 기본 구현은 `callHaiku` + `parseJsonResponse`.
- 커서 정책 (repo 기존 패턴 준수):
  - **unparseable LLM 출력 → no-op + 커서 전진** (R13 패턴: poison fact가 커서를 못 막게)
  - **judge 호출 자체 실패(예외) → 커서 미전진 + 런 중단** (transient outage는 다음 런에서 재시도, R17 구분)
  - **활성 원칙 집합의 해시가 바뀌면 커서 리셋** — 원칙이 바뀌면 전체 재스캔
- 프롬프트 신뢰경계: fact 텍스트는 untrusted data로 구획하고, 내부 지시문 무시를 시스템 프롬프트에 명시.

## 표면화 (모두 표시 전용)

1. `search_facts` (MCP): 결과 페이지의 fact id들로 **단일 IN 쿼리** → 활성 모순이 있는 fact에
   `⚠ Principle conflict: [slug] statement` 라인 추가. 랭킹·필터 불변.
2. `graph_stats` (MCP): Graph Health에 `Active principle conflicts` 카운트 1줄.
3. `memory-bank consistency`: Principle conflicts 섹션 추가 (advisory). `--gate`는 기존 의미 유지(fact↔fact만),
   `--gate-principles`를 켠 경우에만 원칙 모순도 exit 2에 포함.
4. `memory-bank principles` CLI: `list | add | import | activate | deactivate | conflicts | resolve | check`.

## 해소 흐름 (TMS 패턴)

모순 발견 → 사람이 판단:
- fact가 낡음 → 기존 도구로 `revise_fact`/`set_fact_deprecated` (fact 비활성화 시 모순 자동 소멸)
- 원칙이 낡음 → `principles deactivate` 후 정본(rules) 갱신
- 공존 정당/오탐 → `principles resolve --resolution acknowledged|false_positive`

## 측정

- 표면화된 활성 모순 수 (consistency/graph_stats에서 상시 관측)
- 해소 사유 분포 — `false_positive` 비율이 높으면 judge 프롬프트/threshold 조정 근거

## Non-goals (v1)

- rules/*.md 자동 스크랩·동기화 (원칙은 수동 큐레이션 — 정본은 여전히 rules 파일)
- 검색 랭킹/주입 파이프라인 개입
- 자동 해소·자동 fact 비활성화
- 임베딩 프리필터 (활성 원칙 수가 수십 개 수준인 동안은 전 원칙을 프롬프트에 포함)
