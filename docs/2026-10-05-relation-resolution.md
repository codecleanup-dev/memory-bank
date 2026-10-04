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

- 판정은 `principle-check` 와 같은 위원회(기본 3표, 과반, 표마다 순서 섞기). confidence 는 합의한 표의 **하위 중앙값**이다. 짝수 표에서 위쪽 가운데를 고르면 0.99 한 표가 0.1 표를 끌고 퇴역 기준을 넘길 수 있어서, 위원회는 덜 확신하는 절반만큼만 확신한다고 본다. 기본 모델은 추출보다 강한 `sonnet` (`--model` 로 변경). 표 하나가 같은 쌍에 서로 다른 판정을 내면 그 쌍에 대해 무효표이고, confidence 가 [0, 1] 의 유한수가 아닌 항목은 집계에서 뺀다(보정하지 않는다). 단일 판정이 한 쌍에 두 판정을 내면 그 쌍은 행동 없이 넘어간다.
- 모든 변경은 `relation_resolution_log` 테이블에 변경 전 상태(간선 행, 두 팩트 원문, 판정)와 함께 **같은 트랜잭션으로** 기록된다. 기록 없는 변경은 생길 수 없다. `<index-dir>/relation-resolution.jsonl` 은 그 행의 best-effort 미러이고, 미러 쓰기 실패는 집계만 한다. 되돌리기는 이 기록으로 사람이 한다. 간선 재분류의 reasoning 에도 `was <type>: <원문>` 을 남긴다.
- 행동은 `BEGIN IMMEDIATE` 트랜잭션 안에서 간선과 두 팩트를 다시 읽고, 판정에 쓴 필드(간선 reasoning, 두 팩트의 본문·카테고리·scope·확인 횟수·활성 여부)가 스캔 때와 전부 같을 때만 수행한다. 자기 참조 간선(source = target)은 어떤 판정이든 사람에게 남긴다. 하나라도 다르면 `skipped-changed`. 쓰기 락을 먼저 잡으므로 재확인과 변경 사이에 다른 프로세스가 끼어들 수 없다.
- 판정기는 팩트를 2,000자까지 본다. 그보다 긴 팩트는 잘린 시야로 판정된 것이므로 퇴역시키지 않는다(간선 변경은 되돌릴 수 있어 허용).
- dry-run 은 데이터베이스를 **읽기 전용 연결**로 연다. `initDatabase()` 는 시작 시 마이그레이션과 복구(중복 `ontology_relations` 삭제, `scope_project` 교정)를 돌리므로, 그 경로로 열면 "아무것도 바꾸지 않는다" 는 dry-run 이 판정 전에 그래프를 바꿀 수 있다. 읽기 전용 연결에서는 SQLite 가 쓰기를 거부하므로 보장이 규율이 아니라 엔진에 있다. `--apply` 만 `initDatabase()` 를 쓴다.
- `--votes` 는 1~5, `--batch-size` 는 1~20 만 받고 범위 밖은 거부한다(조용히 자르지 않는다). 런은 보고한 대로 실행돼야 한다.
- `--limit`(기본 200, 0 = 전체)으로 런당 비용을 묶는다. `--apply` 런은 유지(keep) 판정도 로그 테이블에 남기고, 다음 런은 **같은 유형으로** 이미 판정한 쌍을 건너뛰어 같은 최신 200쌍에 반복 과금하지 않는다(`--rejudge` 로 다시 포함). CONTRADICTS 에서 SUPERSEDES 로 재분류된 간선은 id 가 같아도 supersedes 런에 다시 보인다. 건너뛰기는 기록된 판정 입력(두 팩트 본문·간선 reasoning·카테고리·scope·확인 횟수)이 지금과 같을 때만 적용되고, keep 기록도 쌍이 그대로일 때만 쓴다. 위원회가 합의하지 못한 쌍은 spoiled 로 집계하고 `--apply` 에서는 `unresolved` 행으로 남겨 제한 런이 그 쌍에 정체되지 않게 한다. 판정 불가 배치는 건너뛰고 집계한다.
- SUPERSEDES 로 재분류할 때 반대 방향 SUPERSEDES 가 이미 있으면 양방향 쌍을 만들지 않고 원래 간선도 지우지 않는다(`skipped-conflicting-edge`). 방향이 서로 다른 두 주장은 사람이 고른다. 이 쌍도 `unresolved` 행으로 남겨 제한 런이 정체되지 않게 한다. 반대 간선의 존재는 스냅샷에 들어가지 않으므로, 사람이 그 간선을 지운 뒤에는 `--rejudge` 로 다시 포함시킨다.
- SOURCE_REDUNDANT 로 source 를 퇴역시키면 저장된 간선(source → target)이 판정과 반대 방향을 주장하게 된다. 같은 트랜잭션에서 방향을 바로잡고(survivor → 퇴역 팩트), 올바른 방향의 간선이 이미 있으면 틀린 간선을 지운다. 로그의 `source_after`/`target_after`/`note` 에 남는다.
- 위원회의 한 표가 도착하지 않으면(재시도 소진·전송 오류) 그 표는 결석이고 나머지 표로 과반을 낸다. 런은 죽지 않는다. 도착한 표가 과반에 못 미치는 배치는 `unavailableBatches` 로 집계만 하고 기록하지 않아 다음 런이 다시 고른다. 표가 하나라도 결석한 배치에서 합의가 안 된 쌍도 기록하지 않는다(결석한 표가 과반을 만들 수 있었다) (1.12.1, 첫 라이브 런이 `empty response (attempt 3/3)` 한 번에 중단된 실측).
- 판정 출력이 파싱되지 않은 배치도 `--apply` 에서는 그 쌍들을 `unresolved` 로 남긴다. 남기지 않으면 제한 런이 같은 배치를 영원히 다시 고른다. dry-run 은 쓰지 않는다.
- dry-run 은 스키마를 건드리지 않으므로 후속 열이 없는 옛 모양의 로그 테이블을 만날 수 있다. 그때는 없는 열을 NULL 로 읽어 스냅샷이 맞지 않게 하고(= 다시 판정), 테이블 모양은 그대로 둔다.

적대 리뷰(push 게이트, 2026-10-05) 반영: JSONL 만 쓰던 아카이브를 DB 트랜잭션 로그로 바꿨고, 재확인을 쓰기 트랜잭션 안으로 넣고 비교 필드를 늘렸고, 400자 절단 입력으로 팩트를 퇴역시키던 경로를 막았다.

## 상류 수정

관계 추출 프롬프트(`DETECT_RELATION_SYSTEM_PROMPT`)에 "CONTRADICTS/SUPERSEDES 는 두 사실이 같은 질문에 답할 때만" 을 명시하고 응답에 `same_question` 을 요구한다. 코드가 그 필드를 검사해 `true` 가 아닌 CONTRADICTS/SUPERSEDES 는 저장하지 않는다. 프롬프트 문구만 바꾸는 것은 결정론 바닥이 아니므로 코드 게이트를 둔다.

## Non-goals

- haiku 단일 판정으로 팩트를 비활성화하는 것. 측정상 노이즈 라벨을 추인한다.
- 기존 간선의 일괄 DELETE. 삭제는 판정 쌍 단위로만, 아카이브와 함께.
- 원칙 레지스트리 자동 채우기. `principles add/import` 는 그대로 human-gate 다.
