# Codex 세션 색인 지원 — 포팅 계획 (codex-support 브랜치)

> 목표: memory-bank가 `~/.codex/sessions`의 Codex rollout jsonl을 Claude 대화와 동일하게 색인.
> 원본: episodic-memory 1.4.2 (memory-bank의 조상, 동일 계보) — 이미 구현돼 있음.
> 베이스라인: fork main = upstream 90fbd3d (동기화 완료). 이 브랜치 = main + 아래 패치.

## 실측 현황 (2026-07-04)
- Codex 로그: `~/.codex/sessions` 913개 jsonl, 1.3GB, 2026-05~07 (실재)
- 포크 스키마: `types.ts:37 codingAgent?` + `:75 coding_agent?` 이미 존재 (준비됨)
- 포크 sync.ts: 이미 다중소스 — `:92 detectCodingAgent(sourceDir)`, `:173 exchange.codingAgent=` (준비됨)
- **없는 것**: (a) Codex jsonl 파서, (b) `~/.codex/sessions` 소스 발견

## 포팅 대상 (정밀)
### ① src/parser.ts — Codex 포맷 파싱 (핵심 작업)
현재: `parseConversation()`(27행~)이 Claude jsonl 전용.
목표: episodic 구조로 재구성 —
- `parseConversation()`를 **라우터**로: harness 감지 → `parseClaudeConversation` | `parseCodexConversation` 분기
  (episodic parser.ts:88 router, :100 claude, :329 codex)
- `interface CodexRolloutLine { timestamp?, type?, payload? }` 추가 (episodic :29)
- `parseCodexConversation()` 이식 (episodic :329~530) — Codex jsonl 스키마:
  `{"type":"response_item","payload":{"role":"user|assistant","content":[{"text":...}]}}`
- **매핑**: episodic은 `harness: 'codex'` enum → 포크는 `codingAgent: 'codex'` string으로 변환
  (포크엔 harness enum 없음. ExchangeBuilder의 harness/agentVersion/model/modelProvider 중
   포크 types에 있는 것만 채우고 나머지는 생략 — 스키마 확인: types.ts)

### ② src/paths.ts + src/sync-cli.ts — 소스 발견
- `~/.codex/sessions` 를 색인 소스 목록에 추가 (episodic sync-cli.ts:87, paths.ts 참조)
- 재귀 발견: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (Claude와 디렉토리 뎁스 다름 — glob 조정)
- sync 호출 시 `{codingAgent:'codex'}` 로 stamp (sync.ts는 이미 지원)

## 검증
- `npm install && npm run build && npm test` (기존 218 테스트 회귀 없음)
- episodic의 `test/codex-transcripts.test.ts` fixture 차용 → Codex 파서 단위 테스트 추가
- 실데이터 스모크: `~/.codex/sessions`의 rollout 1개 파싱 → exchange 추출 확인 (DB 미접촉, dry-run)

## 활성화 (별도 세션 경계 필수 — MCP 재시작 동반)
1. DB 백업 확인 (이미: `~/.config/superpowers/conversation-index/fork-baseline-backup-*`)
2. 라이브 마켓플레이스 repoint → codecleanup-dev/memory-bank (아키텍처 결정 후, §아래)
3. MCP 재시작 (새 세션) → codex 파서 라이브
4. 백필: `~/.codex/sessions` 913개 색인 (임베딩 수십 분, 백그라운드)

## 결정 (2026-07-05 확정) — 브랜치 추적 아키텍처
- 마켓플레이스가 브랜치 추적 불가 → **패치는 main에 유지, upstream은 main으로 merge**해 추적.
  rebase·force-push 금지 — 공유 히스토리 보존이 다음 동기화의 전제. PR 병합도 merge commit 전략 고정.
- 업데이트 알림: `scripts/upstream-watch.sh`(알림 전용, 자동 병합 없음) + 머신 로컬 launchd.
  기존 `com.codecleanup.memory-bank-plugin-update` plist는 .bak 폐기 상태 유지.

## 최종 형태 — 영구 사설 포크 (사용자 결정 2026-07-04: 업스트림 PR 안 함)
codex-support 완성·검증 후 활성화까지가 끝. **원작자에게 PR 하지 않음** — 프라이버시·독립성 우선.
결과: 포크는 영구 유지, 업스트림 업데이트마다 merge로 추적(upstream-watch 알림 활용).

## 업스트림 동기화 기록

### 2026-07-05 — upstream v1.3.0 반영 (90fbd3d → e8bec6d, 15커밋) → 포크 1.4.0

| 묶음 | 커밋 | 내용 | 판정 |
|---|---|---|---|
| 주입 관측 | d6d54bd, e26b546 | 주입 파이프라인 fail-loud 로그 + Context Injection 문서 (v1.2.1~1.2.2) | 채택 |
| backfill 비용 | d9dfb61, 3a6ef84 | 온톨로지 backfill 배치화 + attempt ledger — LLM 스폰 1/20, per-run 상한 (v1.3.0) | 채택 |
| 적대 리뷰 픽스 | 34770a9, 6536e0f, f039462 | 배치 프롬프트 JSON화·transient/content 분리, 서킷 브레이커, poisoning 새니타이즈 | 채택 |
| push 게이트 heal | 7b4c082…e8bec6d (8) | 후보 기아 거부 + 인덱스 self-heal 체인 R2~R8 (stale vec 양방향 purge) | 채택 |

- 전량 채택. 코드 겹침 0 실측 (merge 드라이런 충돌 0; 실제 충돌은 pin 커밋의 engines 블록 1곳뿐).
- 포크 패치 보존 확인: src/parser.ts parseCodex 2, codex 테스트 3파일.
- 테스트 321개 중 320 통과 + `test/verify.test.ts` re-index 1건은 이 머신에서 27.5s/30s 마진 —
  전체 스위트 병렬 시 타임아웃 flake, 단독 실행 통과 확인 (회귀 아님).
- dist는 병합 후 pin 노드로 전체 재빌드해 릴리스 커밋에 포함 (git dist ↔ 배포물 정합 회복).

## 포크 패치 대장 (upstream 병합 시 보존 확인 목록)

1. 코덱스 세션 색인 — src/parser.ts(라우터+parseCodexConversation), src/paths.ts·src/sync-cli.ts(소스 발견), src/sync.ts(stamp), test/codex-*.test.ts 3종
2. exclude 프라이버시 방어 강화 (encodeProjectPath 등 6종)
3. Node 런타임 pin — .nvmrc(22.22.3) + package.json engines(>=22.15) + cli/mcp-server-wrapper.js resolveNodeBin (2026-07-05)
   ※ Windows는 nvm 경로 상이 → execPath 폴백 (해당 머신 활성화 시 MEMORY_BANK_NODE_BIN으로 지정)
4. scripts/upstream-watch.sh — upstream head 변경 알림 (2026-07-05)

## 운영 계약

- **버전**: 포크 버전은 항상 max(upstream, 직전 포크)보다 크게 단조 증가 — 설치 update는 SHA 무시, version만 봄.
  이번: upstream v1.3.0 ∥ 포크 1.3.0(코덱스) → **1.4.0**.
- **런타임**: 빌드·MCP·워커 전부 .nvmrc 단일 pin. 빌드는 반드시 pin 노드로 소스 디렉토리에서 실행 후 설치.
  brew node는 memory-bank 경로에서 배제 (2026-06-24 brew node26 유입으로 MCP 읽기 경로만 11일 사망했던 원인).
- **병합**: upstream 반영은 merge로만. 커밋 단위 triage(채택/보류/거부 + 사유)를 이 문서 "동기화 기록"에 남긴다.
- **마켓플레이스**: source는 로컬 포크 디렉토리 고정 — upstream URL로 두면 update가 포크를 덮어쓸 수 있음 (2026-07-05 발견·교정).
