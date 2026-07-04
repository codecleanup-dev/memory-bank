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

## 미결정 (활성화 시 확정) — 브랜치 추적 아키텍처
- **추천 A**: fork main=업스트림 순정 미러(clean), codex-support 브랜치=main+패치, Claude Code는
  codex-support 추적. 업데이트: main FF 동기화 → codex-support 리베이스 → push. main clean이라 리베이스·업스트림 diff 확인이 쉬움.
- B: 패치를 main에 직접 (force-push 추적, 단순하나 gh repo sync 불가).
- 업데이트 알림: 기존 `com.codecleanup.memory-bank-plugin-update` launchd가 업스트림 head 변경 감지
  → 그 신호가 곧 "리베이스 타이밍".

## 최종 형태 — 영구 사설 포크 (사용자 결정 2026-07-04: 업스트림 PR 안 함)
codex-support 완성·검증 후 활성화까지가 끝. **원작자에게 PR 하지 않음** — 프라이버시·독립성 우선.
결과: 포크는 영구 유지, 업스트림 업데이트마다 codex-support를 리베이스로 추적(launchd 알림 활용).
→ 이 선택에서 "업데이트 추적"은 옵션이 아니라 필수. 아키텍처 A(패치 브랜치 분리)가 리베이스 위생에 유리.
