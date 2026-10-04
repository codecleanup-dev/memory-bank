# 해소 큐의 게이트된 정리 (relation resolve)

- 날짜: 2026-10-05
- 브랜치: `feature/261005-relation-resolution`
- 배경: `memory-bank consistency` 는 활성-활성 CONTRADICTS/SUPERSEDES 쌍을 보고만 한다(report-first). 이 머신에서 그 큐가 CONTRADICTS 1,229쌍, SUPERSEDES 693쌍으로 정체돼 있었다. `docs/2026-07-25-principle-contradicts.md` 가 허용한 "명시적으로 게이트된 파이프라인" 을 추가한다.

## 측정 (2026-10-05, 활성 쌍 40개 무작위)

- consolidator 는 살아 있고 커서가 최신이다. 다만 유사도 0.95 이상 중복만 다루어 0.89~0.95 구간의 관계 쌍은 대상이 아니다.
- haiku 단일 판정은 CONTRADICTS 32쌍 중 25쌍을 TRUE_CONFLICT 로 찍었지만 사람이 보면 대부분 서로 무관한 두 사실이다("블로그는 HTML explain-box" 와 "기술 설명은 한국어 JSON" 을 0.95 확신으로 충돌). 진짜 충돌은 6~8쌍이다.
- SUPERSEDES 표본 8쌍 중 7쌍은 같은 날 추출된 거의 같은 문장이거나 명백한 대체였다.

## 설계

두 축을 비대칭으로 다룬다.

| 축 | 팩트 변경 | 간선 변경 | 사람 몫 |
| --- | --- | --- | --- |
| CONTRADICTS | 없음 | UNRELATED → 삭제(아카이브), RELATED_NOT_CONFLICTING → INFLUENCES, 중복 모양 → SUPERSEDES 로 재분류 | TRUE_CONFLICT 는 큐에 남긴다 |
| SUPERSEDES | 위원회 ≥ 0.9, 같은 scope, 패자가 더 많이 확인되지 않았을 때만 패자 `is_active=0` + `fact_revisions` 기록 | BOTH_VALID → INFLUENCES, UNRELATED → 삭제 | dry-run 목록을 보고 `--apply` 를 내리는 것 |

- 판정은 `principle-check` 와 같은 위원회(기본 3표, 과반, 중앙값 confidence, 표마다 순서 섞기). 기본 모델은 추출보다 강한 `sonnet` (`--model` 로 변경).
- 모든 변경은 `<index-dir>/relation-resolution.jsonl` 에 변경 전 상태(간선 행, 두 팩트 원문, 판정)를 한 줄로 남긴다. 되돌리기는 이 기록으로 사람이 한다. 간선 재분류의 reasoning 에도 `was <type>: <원문>` 을 남긴다.
- 행동 직전에 간선과 두 팩트를 다시 읽어 스캔 때와 다르면 건너뛴다(`skipped-changed`).
- `--limit`(기본 200, 0 = 전체)으로 런당 비용을 묶는다. 판정 불가 배치는 건너뛰고 집계한다.

## 상류 수정

관계 추출 프롬프트(`DETECT_RELATION_SYSTEM_PROMPT`)에 "CONTRADICTS/SUPERSEDES 는 두 사실이 같은 질문에 답할 때만" 을 명시하고 응답에 `same_question` 을 요구한다. 코드가 그 필드를 검사해 `true` 가 아닌 CONTRADICTS/SUPERSEDES 는 저장하지 않는다. 프롬프트 문구만 바꾸는 것은 결정론 바닥이 아니므로 코드 게이트를 둔다.

## Non-goals

- haiku 단일 판정으로 팩트를 비활성화하는 것. 측정상 노이즈 라벨을 추인한다.
- 기존 간선의 일괄 DELETE. 삭제는 판정 쌍 단위로만, 아카이브와 함께.
- 원칙 레지스트리 자동 채우기. `principles add/import` 는 그대로 human-gate 다.
