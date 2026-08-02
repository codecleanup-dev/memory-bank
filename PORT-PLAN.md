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

### 2026-08-02 — upstream v1.5.0 반영 (1c8e465 → 18762b6, 34커밋) → 포크 1.8.0

| 묶음 | 커밋 | 내용 | 판정 |
|---|---|---|---|
| LLM 재시도·복구 | 8c4aaca~13e7558 | callHaiku 유계 재시도+백오프, 빈 응답 EmptyLlmResponseError 승격(무음 손실 수정), llm-error-class 단일 소스, dead-letter(dropped_batches) | 채택 |
| claim/리스 | 7e49c77~6ba64c2 등 | 세션 선점+claim_owner+리스 만료 회수, fact 저장·완료 마커 원자 커밋, -4 재시도 상태, 제외 목록 경로 경계 수정 | 채택 |
| 후속 4커밋 | dba8ea8~18762b6 | analyze pending 의미 정렬, 캡처 로그 명시 제거 표시, 문서 | 채택 |

충돌 해소: consolidator(인라인 분류기→re-export, 포크 변경은 upstream 상위집합 확인),
db.ts(union: upstream 컬럼 자가치유 + 포크 vocabulary), fact-extractor(upstream 2단계
구조 + 포크 confidence·co-extraction 재이식). 테스트 57파일 541건 전체 통과.
적대 리뷰(2026-08-02) 반영 4건: (1) 병합 커밋 dist 혼합-버전 결함 → 릴리스 커밋에 재빌드
dist 포함으로 해소, (2) llm-error-class.ts 'unknown' doc 주석을 실제 동작(HOLD)에 정렬
(upstream 은 주석 stale — 다음 sync 때 충돌 시 포크판 유지), (3) CHANGELOG upstream 1.5.0
헤딩 중복 구분 표기, (4) .codex/loopy-era upstream 런타임 산출물 유입 → 포크판 복원.
후속 후보: 포크 자체 .codex/loopy-era 2파일에 원작자 문자열 잔존(병합 전부터, privacy 스크럽
누락), upstream analyze.ts CLAIMED(-3) 미집계(upstream 고유 — 포크 미수정).

### 2026-07-17 — upstream v1.4.0~v1.4.4 반영 (0b879d2 → 1c8e465, 10커밋) → 포크 1.7.0

| 묶음 | 커밋 | 내용 | 판정 |
|---|---|---|---|
| inject v2 | 1e695ad, 222a8b2 | 세션 dedup 원장(inject-ledger: 400 cap + 7일 TTL + fail-open) + fact 160자/블록 1,000자 토큰 예산 + session_id 배관(hook stdin→데몬/콜드) + 관측성(chars/deduped). 실측: 30-프롬프트 세션 ~10k tok 중복 제거 | 채택 |
| v1.4.1~1.4.3 | fd3a416, caf1ea3, f4ddb23, 053f0de | 콜드 경로 deps 자가치유(selfHealDeps — plugin update npm 누락/cc-sync 무deps 캐시 대응), detectRepeat 무효 timebox→경과예산 게이트, README | 채택 |
| v1.4.4 | 1c8e465 | 버전 드리프트 가드 — **1.6.0에서 이미 하드닝 이식** (guard 3종·sync-cli 락 충돌은 전부 포크판=상위집합 유지, upstream에 없는 isSyncCliCommand·etime 신원·mkdir 원자획득 보존) | 채택(기이식) |
| 3D Knowledge Galaxy | 40db399, 5c2731b | ui/relations 6파일 + plan doc + README 항목 + .gitignore | **보류 유지** (1.5.0 판정 동일 — knowledge-graph-viz 운영. merge에서 제외, 차기 재평가) |
| team chore | d1df2c7 | 원작자 프로세스 상태(loopy-era 2파일, results.tsv) | 제외 (런타임 노이즈 — 코드 아님) |

- 방식: **진짜 merge** (PR #9의 v1.4.4 재구현 포팅과 달리 공유 히스토리 복원 — behind 카운트 0으로 수렴, 다음 동기화부터 충돌 표면 축소).
- 실충돌 14: dist 4(재빌드로 대체), guard 3종+sync-cli(포크판), inject-context.js(포크 3-상태 콜드폴백 × upstream sessionId 수동 통합 — 자동병합이 만든 `import fs` 중복도 교정), hooks.json(포크 node-pin 래핑 유지, 훅 목록 양측 동일 확인), 버전 3파일+CHANGELOG(1.7.0, upstream 1.4.x 원문 보존).
- 검증: 핀 노드(v26.4.0) 빌드 + vitest **470/470** (inject-ledger 신규 포함). 포크 패치 대장 5종 보존 확인 (parseCodex 2·codex 테스트 4·encodeProjectPath parser/sync 각 2·node pin 5개소·upstream-watch·node-pin.sh).
- **활성화 체크리스트 (별도 세션)**: ① 마켓플레이스 update → 캐시 1.7.0 설치 ② `~/.claude/memory-bank.env`의 `MEMORY_BANK_ROOT`를 1.7.0 경로로 갱신 (**버전 경로 하드코딩이라 릴리스마다 수동 갱신 필수** — 2026-07-16 sync 크래시 조사에서 stale 위험 확인) ③ MCP 재시작 ④ inject 로그에서 deduped/chars 관측 확인.
- push 게이트(adversarial review) 3라운드 — **실수정 4건**: ① inject-ledger 공유 tmp → writer 고유 tmp(pid+난수, rename=완결 스냅샷 원자 교체) ② append 시 재로드-합집합(lost update 창을 프롬프트 연산 전체→read-rename 갭으로) + 실패 시 tmp unlink + 고아 tmp 1h prune ③ 원장 커밋을 전달 확인 뒤로 — `computeInjectContextDeferred` 도입, 데몬은 소켓 flush 콜백·콜드는 stdout drain 콜백 후 commit (미전달 fact 가 세션 내내 억제되는 역방향 결함 제거) ④ self-heal 마커 영구 게이트 → 24h TTL + spawn 실패 시 마커 제거.
- 게이트 **기각 2건**(근거 기록): ① 원장 락/CAS 요구 — 원장은 세션당 파일 + 한 세션의 프롬프트는 순차 발화라 동일 파일 동시 writer 는 배포 모델상 사실상 불발생 (콜드 경로는 데몬 부재 시에만 가동 = 구조적 상호배제, 프로세스 내부는 동기 코드라 이미 직렬). 잔여 창 ms 급 · 최악 영향 = fact 1~2건 재주입(토큰 소량 낭비) — dedup 은 fail-open 최적화 계약이고 프롬프트 핫패스의 fs 락은 stale lock 등 더 큰 실패 모드를 들여온다. ② 소켓 flush 이상의 전달 보증(클라이언트 ACK) 요구 — 와이어 프로토콜 변경 필요, 잔여 창(flush 직후 클라이언트 포기) ms 급이며 영향은 해당 세션 한정(원장은 세션당 파일 + 7일 TTL). 비수렴 회전 시 1.5.0 선례대로 운영자 경로 사용.

### 2026-07-12 — upstream v1.3.4 + iter18~38 반영 (70c17c6 → 0b879d2, 46커밋) → 포크 1.5.0

| 묶음 | 커밋 | 내용 | 판정 |
|---|---|---|---|
| v1.3.4 성능 배치 | 5d05443…0fe2bba (9) | inject warm 데몬(매 프롬프트 2.3s→0.2s), fact/category 벡터 int8(25.4→3.8ms), reembed stamp-vector self-heal(업스트림 197K행 복구), 레거시 워커 프롬프트 오염 근절(content-prefix 판별자), purge-llm-sessions 스크립트 | 채택 |
| 태그 후 autoresearch 수정 | 55748d4…0b879d2 (iter18~38) | formatResults 199~1600ms→26ms, WAL journal_size_limit 64MiB + reembed 주기적 truncate, inject 데몬 server.connect 前 기동, SessionStart/pendingFact/pendingExtract spawn 조건이 missing-vector 백로그 감지, ORDER BY rowid, distance→similarity·오염판별자·int8 양자화 단일소스화 + 회귀테스트 다수, bench-perf 미가시 0-오보고 수정 | 채택 |
| 3D Knowledge Galaxy | 40db399·5c2731b (2) | ui/relations/ three.js 시각화 (~1,900줄 + three.min.js vendoring) | **보류** — 포크는 별도 시각화 스택(knowledge-graph-viz) 운영, 병합 기준점을 galaxy 직전 0b879d2로 잡아 자연 제외. 차기 동기화에서 재평가 |

- 실충돌: 버전 3파일 + CHANGELOG + dist 8 + src/db.ts(pragma 양측 유지)·fact-db.ts(import 양측 유지)·sync.ts(codex 가드 ∥ 워커프롬프트 가드 공존)·**src/sync-import.ts(조상 NUL로 binary 병합 → 수동 이식**: dtype-aware vec insert +   이스케이프 구분자를 포크의 팩트당 원자 트랜잭션 구조 위에 적용).
- 포크 측 추가: cli/node-pin.sh 훅 런처(세션 훅 bare node 제거) + codex×워커프롬프트 이음새 테스트 + upstream-watch 릴리스 태그 강조.
- push 게이트(adversarial review) 9라운드 — **실수정 7건**: inject-daemon 요청 재발화 차단(handled), bind→chmod 레이스는 디렉토리 0700 경계+fail-closed(uid/mode stat 재검증, win32 비기동), in-flight 상한 4, 연결 상한 32(maxConnections), 1MB 게이트를 개행 처리 前으로(단일 chunk 우회 봉쇄), 클라이언트 콜드폴백을 no-daemon 한정(연산 증폭 제거)+소켓 파일 존재로 포화/부재 구분, sync 종료 시 wal_checkpoint(TRUNCATE) 능동 회수. 라이브 dir 0755/db 0644 노출 즉시 교정.
- 게이트 **기각 3건**(근거 기록): ① journal_size_limit 한계 재비판 — 업스트림 db.ts 주석에 문서화된 잔존이고 병리 워크로드(reembed)는 능동 truncate 커버, 라이브 WAL 4.2MB 정상 + sync 측 능동 회수 추가로 보완 완료. ② prefix 오염 판별이 정상 대화를 오분류할 가능성 — 업스트림이 "verbatim 템플릿 선두 일치는 극희소 + 행 단위 검증 백업이 커버"로 명시 정당화한 설계. ③ 다중 프로필 교차 주입·SIGKILL stale 소켓 — 인위적 env 혼합/세션 수명 계약 밖 시나리오, 세션 재시작 시 자가회복 존재. 라운드마다 신규 HIGH 회전(9라운드 연속)으로 비수렴 판정 → 운영자 경로(AUTO_REVIEW_SKIP=1, 사람 터미널)로 최종 push.
- **P2 머신 작업(이 Mac, 2026-07-12)**: FTS rebuild(3.4s — purge가 CORRUPT_VTAB으로 죽는 진범이 exchanges_fts 외부-콘텐츠 desync였음, APFS 클론 이등분으로 특정) → purge --legacy-prompts --apply (**21,599 exchanges + 310 tool_calls + 15,594 vectors 제거**, 코퍼스의 25%, 백업 310MB 보존) → reembed 드레인 완료(**미가시 23,892→0 실측**, 83행/s, bench invisible=0·stale=0). vec_exchanges는 기존 int8. 라이브 인덱스 디렉토리 0755/0644 → 0700/0600 교정. **Air/Windows 활성화 시 동일 순서 필요** (purge 스크립트에 FTS 힌트 내장).
- **facts int8 순서 교훈**: migrate-vec-facts-int8을 라이브 플러그인(1.4.2, dtype-aware 이전)보다 먼저 실행 → 라이브 fact 검색이 조용히 0건(무증상 실패). facts.embedding 정확 소스 + int8 역양자화로 float32 즉시 원복해 복구(검색 5건 정상 확인). **계약: DB dtype 마이그레이션은 반드시 대응 플러그인 활성화 後** — 1.5.0 활성화 체크리스트에 migrate-vec-facts-int8 재실행 포함.
- **버전 1.5.0 점프**: 병합 진행 중 업스트림이 v1.4.0~v1.4.3을 릴리스(주입 파이프라인 v2·deps 자가치유·galaxy 패키징) — 1.4.x 네임스페이스 충돌 회피. 신규 v1.4.x 7커밋(5c2731b..d1df2c7)은 **차기 동기화 후보**: inject v2(세션 dedup 원장+토큰 예산)는 채택 가치 높음, galaxy는 이때 재판정.

### 2026-07-08 — upstream v1.3.2·v1.3.3 반영 (b453234 → 70c17c6, 27커밋) → 포크 1.4.2

| 묶음 | 커밋 | 내용 | 판정 |
|---|---|---|---|
| consolidation 워커 락·게이트 | df88784…1f69cb2 (v1.3.2 + R2~R18, 17) | 단일 실행 락(고아 워커 flood 차단), 전역 락+전 프로젝트 drain, same-scope 격리(R4~R6 CRITICAL), keyset 커서(R14), drain 페이지네이션+쿼런틴(R16 CRITICAL), circuit-breaker→cross-run ledger | 채택 |
| 에러 분류 수렴 | 47c2d59…aff39a9 (R19~R25, 7) | outage/deterministic/내부버그 3-값 분류(무한 wedge 제거), auth 401/403/404 명시 hold(silent drain 방지), 중첩 SDK/axios status 추출 | 채택 |
| 워커 세션 색인 오염 차단 | 70c17c6 (v1.3.3) | isExcludedProject 내장 제외(`*-memory-bank-llm`, indexer/sync/verify 전 경로) + 트랜스크립트 TTL prune (upstream 측정: 11,573파일/99MB) | 채택 |
| 문서·빌드 | 03f16de, ae2ff13 | CHANGELOG 1.3.2 + consolidator.d.ts 타입 동기화 | 채택 |

- 전량 채택. 선행: 분기 정합 PR #4 (로컬 1.4.1 계열 15커밋 ∥ origin ontology 독립리뷰 29커밋 — CHANGELOG·ontology-db 충돌 해소) 위에서 수행.
- 실충돌: 버전 3파일 + CHANGELOG + dist 3 + src/paths.ts·src/sync.ts. paths는 포크
  findJsonlFiles ∥ upstream isExcludedProject 가산 공존, sync는 포크 재구조화(재귀
  코덱스/1단 기본) 유지 + 1단 분기 제외 검사만 upstream 의미로 교체.
- 포크 패치 대장 4종 보존 확인 (parser 라우터·paths/sync-cli/sync stamp, 프라이버시
  인코딩, 런타임 pin .nvmrc/engines/wrapper, upstream-watch).
- 검증: tsc 통과, vitest 412/414 (upstream 신규 paths/llm/consolidate 테스트 포함) —
  실패 2건은 알려진 베이스라인(api-config httpbin 외부 네트워크·verify re-index 30s 마진).
- dist는 pin 노드(v22.22.3)로 전체 재빌드 — **ontology 작업 신규 12파일(consistency·
  taxonomy-align·fact-category·ontology-view + CLI·d.ts)이 최초 컴파일 포함** (origin/main
  dist는 PR #3 이후 src 대비 stale였음). import 스모크 8/8 통과.
- 참고: `*-memory-bank-llm` 제외(v1.3.3)는 이 머신의 워커 세션 오염에도 직접 적용 —
  플러그인 갱신 후 verify/repair 1회로 기존 색인 오염 정리 후보.

### 2026-07-05 — upstream v1.3.1 반영 (e8bec6d → b453234, 13커밋) → 포크 1.4.1

| 묶음 | 커밋 | 내용 | 판정 |
|---|---|---|---|
| 인덱스 self-heal fail-loud | d5ab396…c3fd8dc (R9~R14, 6) | heal 트리거 id set-diff 정합, staleRemaining 거부, IndexRepairError 타입 분리 + rethrow 재배열 | 채택 |
| 관계 dedup | 6d753b9, 27536c0 (R15~R17) | 관계 엣지 멱등화(쌍 단위 + UNIQUE 인덱스) + dedup pair→TRIPLE 교정(CRITICAL)·라이브 복원 | 채택 |
| 그래프 탐색 문턱 | 657c118…e9f21a2 (R18~R20, 3) | 결정론적 belief-safety 우선 순회, safety 엣지의 이웃 숨김 방지, 문턱 미달 frontier 진입 차단 | 채택 |
| 문서 | 063000b, b453234 | README What's New v1.3.0 + backfill 워커 env 문서화, 게이트 MEDIUM 2건 반영 | 채택 |

- 전량 채택. 실충돌은 버전 필드 3파일(package.json engines 블록 포함)뿐 — 소스 겹침 0
  (upstream: db/ontology-* ∥ 포크: parser/paths/sync).
- 포크 패치 대장 4종 보존 확인: 병합이 해당 파일 미접촉.
- 검증: ontology-classifier 50/50 통과. 전체 스위트 329 중 2건 실패는
  api-config(httpbin 외부 네트워크)·verify re-index(30s 마진 콜드로드) — 병합 전
  origin/main 베이스라인 worktree에서 동일 재현 확인, 회귀 아님.
- dist는 pin 노드(v22.22.3)로 재빌드, dist/db·ontology-* import 스모크 통과.

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

1. 코덱스 세션 색인 — src/parser.ts(라우터+parseCodexConversation), src/paths.ts·src/sync-cli.ts(소스 발견), src/sync.ts(stamp), test/codex-*.test.ts 3종 + test/codex-worker-prompt.test.ts(업스트림 가드×codex 경로 이음새, 2026-07-12)
2. exclude 프라이버시 방어 강화 (encodeProjectPath 등 6종)
3. Node 런타임 pin — memory-bank.env 핀 우선 해석(2026-07-09) + .nvmrc(22.22.3) + package.json engines(>=22.15) + cli/mcp-server-wrapper.js resolveNodeBin
   ※ Windows는 nvm 경로 상이 → execPath 폴백 (해당 머신 활성화 시 MEMORY_BANK_NODE_BIN으로 지정)
4. scripts/upstream-watch.sh — upstream head 변경 + 릴리스 태그 강조 알림 (2026-07-05, 태그 2026-07-12)
5. cli/node-pin.sh — 세션 훅(hooks.json 5곳 + inject 콜드폴백) 핀 런처 + test/node-pin-resolution.test.ts (2026-07-12)

## 운영 계약

- **버전**: 포크 버전은 항상 max(upstream, 직전 포크)보다 크게 단조 증가 — 설치 update는 SHA 무시, version만 봄.
  업스트림이 같은 네임스페이스에 진입하면 포크가 다음 마이너로 점프 (2026-07-12: upstream v1.4.0~v1.4.3 출현 → 포크 1.4.2에서 **1.5.0**으로).
- **런타임**: 계약의 본질은 특정 벤더 배제가 아니라 **"빌드와 모든 실행 경로가 단 하나의 런타임"**.
  정본 핀은 `~/.claude/memory-bank.env`의 `MEMORY_BANK_NODE`(현재 /opt/homebrew/bin/node, node 26/ABI 147)이고,
  해석 순서는 `MEMORY_BANK_NODE_BIN → env 핀(allowlist) → .nvmrc → 폴백` — 래퍼·node-pin.sh·sync loop 전부 동일.
  빌드(dist·better-sqlite3)는 반드시 env 핀 노드로 실행.
  이력: 2026-06-24 사고(모듈=nvm22 빌드 ∥ 실행=brew26)와 2026-07-09 사고(모듈=brew26 빌드 ∥ 실행=nvm22)는
  방향만 반대인 같은 클래스 — "brew 배제"라는 과거 서술은 06-24 방향에만 맞는 오진이라 폐기 (2026-07-12 정정).
- **병합**: upstream 반영은 merge로만. 커밋 단위 triage(채택/보류/거부 + 사유)를 이 문서 "동기화 기록"에 남긴다.
- **마켓플레이스**: source는 로컬 포크 디렉토리 고정 — upstream URL로 두면 update가 포크를 덮어쓸 수 있음 (2026-07-05 발견·교정).
