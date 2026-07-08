# memory-bank-fork — 개선 계획 v1 (오피스 정비 패스)

> 작성: 2026-07-06 · 상위: keystone-hub `docs/analysis/2026-07-06-llm-work-quality-master-plan.md` (PR #221)
> 성격: 마스터 플랜 방안 C(AI 오피스) C-1 인벤토리 감사의 프로젝트 실행분. **실행은 항목별 사람 승인.**

## 오피스 좌표
- 부서: **지식실(정본)** — 전 세션 대화·판단의 자동 색인·검색. Claude/Codex 양쪽의 메모리 정본 (Codex 메모리 정본 = memory-bank, keystone 7차 진화 판정)
- 등급: 활성 · 원격 `codecleanup-dev/memory-bank` (upstream: jung-wan-kim/memory-bank — merge-only 추적 계약)

## 현황 [검증됨: 프로브 + 메모리 노트]
- **1.4.1 릴리스 완료** (upstream v1.3.1 병합 반영) — 메모리 노트(1.4.0 기록)보다 진전됨. main dirty 1건
- 운영 계약: `.nvmrc` 22.22.3 Node pin · 마켓플레이스=로컬 디렉토리 고정(URL이면 포크 덮어씀) · remove가 plugin도 내림(재install 필요) · merge-only 추적 + 버전 단조증가(PORT-PLAN 정본)
- watcher: launchd 6h 주기 upstream 감시 — 기준 커밋 이후 신규 커밋 대기 중이었음(직전 기록 5커밋)
- 미완(메모리 노트): 세션훅 bare node 이슈 · Air/Windows 머신 전개 · 재시작 후 검색 확인 · 3머신 iCloud 동기화(Pro만 완료)
- 최근 실전 교훈: 플러그인 native 모듈(better-sqlite3) ABI ↔ 런처 node 불일치가 MCP 읽기 경로만 11일 침묵 사망 — toolchain-smoke에 probe 추가됨 (keystone 반영 완료)

## 마스터 플랜 축 적용
| 축 | 이 repo에서의 의미 |
|---|---|
| 커널(방안 A) | "근거 먼저" 조항의 1차 도구 — 커널이 memory-bank 검색을 세션 시작 근거 확보 수단으로 지목 |
| AGENTS.md(방안 B) | Codex 세션의 메모리 접근 경로 문서화 대상 (정본 지위 명문화) |
| 측정(방안 D) | 검색 품질(회수율)의 측정 과제화 후보 — 장기 |
| 오피스(방안 C) | 지식실 정본 — atlas(knowledge-graph-viz)·pkb-wiki·collection 레인이 전부 이 DB를 소비 |

## 개선 항목
| # | 항목 | 완료기준 | risk |
|---|---|---|---|
| 1 | 메모리 노트 미완 3건 회수 — 세션훅 bare node 확인 · 재시작 후 검색 확인 · watcher 대기 커밋 판정 | 각 항목 판정 기록 | R0~R1 |
| 2 | Air/Windows 전개 + iCloud 동기화 완결 (3머신) | 두 머신에서 검색 동작 확인 | R1 (머신별 작업) |
| 3 | main dirty 1건 처분 | clean | R0~R1 |
| 4 | 지식실 정본 지위 명문화 — README에 "Claude/Codex 공용 메모리 정본, episodic 재활성 금지(DB 공유)" 1절 | README 반영 | R0 |

## 스코프 컷
upstream 기능 선반영 없음 (merge-only 불변). DB rebuild 절대 금지 (기존 계약 유지).
