# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.2] - 2026-07-26

### Fixed (색인 오염 — 서브에이전트 워밍업 · 요약기)
- **handshake 계열 신설**: 호스트 CLI가 서브에이전트를 띄울 때 내는 `Warmup` 교환이
  색인되고 있었다 — 실측 17,705건으로 **전체 색인의 54.9%**, 그중 7,053건은 실패한
  핸드셰이크라 응답 쪽이 인증 오류 문자열이었다(오류 로그가 검색 대상). 워커 프롬프트와
  달리 이 계열은 **지금도 유입 중**(2026-07에 119건)이라 정리만으로는 부족해
  `sync` 색인 가드와 purge 술어 양쪽에 배선했다. 판별은 접두사가 아니라 **정확 일치 +
  `is_sidechain`** — 문자열이 6자뿐이라 접두사 규칙이면 사람이 쓴 "Warmup 루틴…"까지
  삼킨다(실측: 정확 일치 17,705건 전부 sidechain, 다르게 이어지는 행 0건).
- **요약기 마커 purge 대상 추가**: 8,367건. 색인 쪽은 이미 파일 단위 가드가 막고 있어
  (2026-06·07 유입 0) 빠진 것은 제거 수단뿐이었다. `WORKER_PROMPT_PREFIXES`가 아니라
  신설 `POLLUTION_PROMPT_LEADS`에 넣는다 — 전자는 4개 시스템 프롬프트와 1:1 결합
  계약이라 요약기 3종이 공유하는 마커를 넣으면 "dead prefix"로 계약이 깨진다.
- purge 스크립트: `--no-handshake`로 종전 술어 재현, `families` 출력에 활성 계열 전부 표기.

### Ops
- 라이브 정리 실행: 32,276 → **3,011 exchange**(−29,265, −90.7%). 잔여 오염 0,
  `exchanges_fts` 일치, `quick_check ok`, 검색 정상. 실행 중 만난 `CORRUPT_VTAB`은
  FTS5 external-content desync로 rebuild(2초) 후 해소 — 디스크 손상 아님.

## [1.10.1] - 2026-07-25

### Changed (F5 — judge 순서 효과 대응, 파일럿 양성 후 적용)
- **위원회 표별 배치 셔플**: 파일럿 실측(동일 200 facts, 단일표 4런)에서 동일순서 재현율
  J=0.400 vs 교차순서 평균 0.218 — orderEffectDelta 0.182 > 임계 0.10으로 **계통적 순서
  효과 실재** 판명. `committeeJudge`가 2표부터 독립 배치 순열로 판정하고 `fact_index`를
  호출자 순서로 역매핑 — 순서-계통 편향이 표간 분산으로 바뀌어 다수결이 흡수한다.
  (배경: 질문 순서 효과 — 판정이 배치 순서에 의존하는 현상의 직접 측정·대응)

### Ops
- stale fact 1건 정식 revise (Node 핀 방향 역전 기록 — revision 기록 + 재판정 큐 자동 등록,
  F1 경로 라이브 첫 사용)

## [1.10.0] - 2026-07-25

### Added (F1 — revision 측정시점 바인딩, followups F1 종결)
- `principle_recheck_queue`: `updateFact` 텍스트 변경(consolidation merge 포함, count-only 제외)이
  enqueue → 다음 `principles check`가 **forward 스캔 전에** 드레인. reconcile 의미론:
  재발견 쌍 유지 / 미재발견 활성 자동판정 쌍 system-clear(`is_active=0`·`resolution NULL` —
  사람 해소 4종·manual/import 쌍 불변) / unparseable→no-op 드레인 / judge 예외→큐 보존.
- coverage에 `recheckQueued` — 모순 0이어도 재판정 대기 큐가 표시됨.

### Added (E2 v2 — model_surprise, G2 기각의 직접 대응)
- `facts.model_surprise` (0..1, NULL=미측정): 추출 LLM이 추출 시점에 **모델-상대 novelty**를
  직접 평점(일반 어시스턴트 가정 0 ↔ 사용자 특이/기본가정 교정 1, confidence와 독립).
  기존 행 backfill 없음 — 신규 fact부터 축적, 30일 후 G2 재검정 쿼리는 E2 스펙에 고정.
  v1 코퍼스-상대 `surprise`는 대조 기준선으로 존치.

### Fixed
- `archive-io`: bare `'stream'` import → `node:stream` — git worktree 레이아웃에서 vite-node가
  프로젝트 루트 상대로 오해석해 테스트 수집이 실패하던 문제 (실측).

### Ops (릴리스 외 운영 기록)
- 첫 트랜치 큐 7건 사람 해소 완료 (false_positive 5 · acknowledged 2 — judge 캘리브레이션 데이터)
- 증분 `principles check` 일일 크론 등록 (03:17, --max-facts 400, 위원회 3표)

## [1.9.0] - 2026-07-25

### Changed (F2 — judge 정밀도, 동일 200 facts 이중 실측 게이트 PASS)
- **NOT-contradiction 가드 5종**: 스코프 열거 밖 비위반 / 가역 작업 ≠ irreversible /
  관찰-비판 fact 예외(practice-in-force는 위반) / "언급 부재 ≠ 위반" / 아키텍처 스타일 비위반.
  실측: 기존 FP 클래스 5종이 독립 이중 측정(A: n=2, B: 3라운드)에서 공히 0 재출현.
- **threshold 0.7→0.8** (캘리브레이션: FP 밴드 0.75–0.85, 정당 0.95) + `check --threshold T`
- **위원회 3표 다수결·중앙값 confidence** (기본, `--votes K`): 단발 judge의 0.80–0.85 밴드
  런간 churn 실측 대응 — 주입 judge는 `votes` 명시 시에만 위원회.
- **outage 오분류 수정**: SDK가 rate limit을 텍스트 결과로 반환 시 "unparseable→커서 전진"으로
  facts를 조용히 스킵하던 구멍 — 파싱 실패+에러 배너일 때만 throw(미전진). 라이브 실사고에서 발견.

### Added (E2 — surprise 주입 랭킹 필드, 스펙: docs/2026-07-25-e2-surprise-ranking-spec.md)
- `facts.surprise` (0..1, NULL=미측정): 결정론 novelty `1 − max cosine 유사도`, insert 시
  pre-insert KNN으로 계산(자기매칭 구조적 불가). **주입 랭킹 신호 전용** — 저장 필터·검색 랭킹 불개입.
- `memory-bank surprise-backfill [--limit N]`: NULL 술어=자연 커서, embedding 없는 행은 NULL 유지.
- 주입 telemetry(injected fact별 surprise) + `MEMORY_BANK_INJECT_SURPRISE_WEIGHT`(기본 0 —
  측정 게이트 G1–G3 통과 후에만 상향 논의).

### Docs
- followups: F2 이중 실측(A/B) + 조정 노트, F3(잔여 judge FP 모드 2종), F4(sync transient IO backoff)

## [1.8.0] - 2026-07-25

### Added
- **fact↔principle 교차 모순 (principle contradicts)**: 운영 원칙 레지스트리
  (`principles` — CLI 수동 큐레이션, human-gate; rules 파일이 정본) +
  `principle_conflicts` 해소 큐. 표면화는 전부 표시 전용 — `search_facts` 결과의
  `⚠ Principle conflicts` 주석, `graph_stats` Graph Health 카운트, `consistency`
  리포트 섹션. 랭킹·기록·진위에는 불개입, 게이트 편입은 `--gate-principles` opt-in.
- **`memory-bank principles` CLI**: `list / add / import / activate / deactivate /
  conflicts / resolve / check`. `check`는 keyset 커서 배치(LLM judge, confidence
  ≥ 0.7만 저장; unparseable→no-op+커서 전진, judge 예외→미전진 중단, 원칙 집합
  해시 변경→전체 재스캔).
- **Scan coverage**: "모순 0"이 "측정되고 깨끗"인지 "아직 미측정"인지 구분 —
  `principles conflicts`/`consistency` 출력에 `unscanned / principles-changed /
  partial / complete` 상태와 미측정 fact 수를 표시 (측정 전 상태를 무모순으로
  오인하는 것 방지).

### Notes
- 스키마 additive (`principles` / `principle_conflicts` / `principle_check_state`)
  — 기존 DB 무마이그레이션. 사람의 해소 결정(false_positive 등)은 영속: UNIQUE
  pair + insert-or-ignore라 재탐지가 재오픈할 수 없음.
- 설계 문서: `docs/2026-07-25-principle-contradicts.md` (경계선: 원칙은 표시·게이트에만 개입)

## [1.7.0] - 2026-07-17

_Fork release: true merge of upstream v1.4.0–v1.4.4 (`0b879d2..1c8e465`) — restores
shared history (behind count converges to 0) and closes the v1.5.0 sync-point gap._

### Added (upstream v1.4.0 "injection pipeline v2", adopted)
- **Per-session dedup ledger** (`src/inject-ledger.ts`): each fact is injected at
  most once per session — bounded (400 cap, oldest-evict) + 7-day TTL +
  session_id sanitize + atomic writes + fail-open (a corrupt ledger never blocks
  injection). Upstream measured ~10k tokens of duplicate injection removed over
  a 30-prompt session.
- **Token budget**: facts truncated at 160 chars, whole block capped at 1,000
  chars; inject log now reports `chars` (block size) and `deduped` (savings).
- **session_id plumbing**: hook stdin → daemon payload / cold fallback →
  `computeInjectContext` — integrated into the fork's tri-state cold-fallback
  (`ok`/`no-daemon`/`gave-up`) without weakening the daemon-saturation guards.
- **Cold-path deps self-heal** (upstream v1.4.2): one-shot detached
  `npm install` when the cold import hits missing native deps.
- **detectRepeat elapsed-budget gate** (upstream v1.4.3): replaces the
  ineffective wall-clock timebox.

### Kept (fork side on merge conflicts)
- Version-guard trio + sync-cli lock logic: fork's hardened port (1.6.0) is a
  strict superset of upstream v1.4.4 (self-declared script identity, etime
  start-time check, mkdir-atomic acquire, ownership-checked release) — kept
  wholesale.
- `hooks/hooks.json` node-pin launcher wrapping (hook lists verified identical).

### Excluded at merge
- Knowledge Galaxy (`ui/relations/`, 2 commits): hold decision from 1.5.0
  maintained — the fork runs its own knowledge-graph-viz stack. Re-evaluate at
  the next sync.
- Upstream runtime artifacts (process-state JSONs, results.tsv): not plugin code.

## [1.6.0] - 2026-07-16

### Added (upstream v1.4.4 port — the last piece past the v1.5.0 sync point)
- **Version drift guard** (`src/version-guard.ts`): the sync singleton lock now
  carries `{pid, version, startedAt}` — a newer sync PREEMPTS an older-version
  or wedged (>6h) holder instead of skipping forever (upstream incident: a
  stale sync wedged 23h froze indexing). Lock reclaim is rename-atomic (two
  contenders can never both win), holder identity is re-verified against ps
  before any kill (pid-recycle guard), and SIGTERM/SIGINT release the lock.
- **SessionStart stale-worker sweep** (`scripts/version-drift-check.js`, wired
  through the node-pin launcher): detached workers running from an OLDER
  versioned plugin cache dir are terminated at session start; MCP servers are
  never touched. Matching is ANCHORED to the executing node binary + script
  argv position, so unrelated processes merely carrying a worker path as data
  (editor/grep/another script) can never be killed — locked by 6 regression
  cases.

### Fixed
- `deleteFact` deletes `ontology_relations` edges (either direction) before
  the fact row — `REFERENCES facts(id)` + `foreign_keys=ON` made deleting a
  related fact throw `SQLITE_CONSTRAINT_FOREIGNKEY` (latent since the FK was
  declared; regression test added).
- `consolidator` error-classification docs matched the superseded R23
  semantics ("unknown → bounded advance") while the code implements the final
  R24 contract (unknown HOLDS, like transient — an outage must never silently
  drain the backlog); docs now state the real contract, and
  "internal server error" message text classifies as transient.

## [1.5.0] - 2026-07-12

_Fork release: merges upstream v1.3.4 + post-tag autoresearch fixes (iter18~38,
merged at 0b879d2 — the pre-galaxy "drain complete" baseline; its 1.3.4 section
below), plus fork-side hook-runtime hardening._

Version jumps 1.4.2 -> 1.5.0: upstream published its own v1.4.0-v1.4.3 while this
release was in flight, so the fork leaves the 1.4.x namespace to avoid two
different codebases sharing a version string.

### Added (fork)
- **`cli/node-pin.sh`** — single bash launcher that resolves the pinned runtime
  for every session-hook entry (same contract as the MCP wrapper:
  `MEMORY_BANK_NODE_BIN` -> `memory-bank.env` pin (allowlisted) -> `.nvmrc` ->
  PATH). All 5 `hooks.json` commands and the inject cold-fallback now go
  through it — bare PATH `node` in hooks was the remaining ABI-split surface
  (2026-07-05 / 2026-07-09 class). Regression tests in
  `test/node-pin-resolution.test.ts`.
- **Codex x worker-prompt seam test** (`test/codex-worker-prompt.test.ts`) —
  pins that upstream's `isWorkerPromptMessage` guard (v1.3.4) also fires for
  exchanges produced by the fork-only codex discovery path.
- **upstream-watch release-tag alerts** — a new upstream `v*` tag now raises an
  emphasized notification (head-only alerts let 48 commits pile up silently
  between v1.3.3 and v1.3.4).

### Merged (upstream v1.3.4 + iter18~38, see 1.3.4 section below)
- Warm inject daemon (per-prompt ~2.3s -> ~0.2s), fact/category vector int8
  (25.4 -> 3.8ms), reembed stamp-vector self-heal + spawn-condition fixes,
  formatResults 199~1600ms -> 26ms, WAL `journal_size_limit` 64MiB, pollution
  predicate single-source + `purge-llm-sessions` script, DRY/test hardening.
- Excluded for now: 3D Knowledge Galaxy (`ui/relations/`) — the fork operates a
  separate visualization stack (knowledge-graph-viz); re-evaluate next sync.
- `src/sync-import.ts` upstream delta hand-ported (ancestor had raw NUL bytes ->
  git binary merge): dtype-aware vec inserts + unicode-escape contentKey
  separator, applied on top of the fork's per-fact atomic transaction shape.

## [1.4.2] - 2026-07-08

_Fork release: ships the ontology work below compiled into dist, and merges
upstream v1.3.2–v1.3.3 (own sections below)._

### Added
- **Controlled category vocabulary**: `facts.category` now carries
  NOT NULL + CHECK over the five categories. Legacy DBs are rebuilt once with
  deterministic normalization of out-of-vocabulary values
  (`requirement`→`constraint`, enum echoes→first valid token, everything
  else→`knowledge`; measured contamination: 44+10+‥ rows). All writes
  normalize at the `insertFact` chokepoint (`src/fact-category.ts`).
- **Extraction confidence persisted** (`facts.confidence REAL`): previously
  consumed only by the ≥0.7 extraction gate and discarded; now stored
  (clamped 0..1) and surfaced in `search_facts` output next to the
  `consolidated_count` reinforcement signal.
- **Consistency checks** (`memory-bank consistency`, `src/consistency.ts`):
  active-active CONTRADICTS/SUPERSEDES pairs exposed as a resolution queue
  (report-first — nothing auto-deactivates), plus orphan-fact coverage and
  single-fact-category counts. `--gate` exits 2 on violations for
  deterministic health gating; `graph_stats` gained a Graph Health section.
  Live baseline that motivated this: 405/417 CONTRADICTS and 437/446
  SUPERSEDES pairs had both endpoints still active; 37.5% of facts had no
  relations at all.
- **Taxonomy alignment** (`memory-bank taxonomy-align`): embedding-KNN merge
  candidates for near-duplicate categories (2,809 categories / 1,014
  single-fact ones measured). Report-first; `--apply` merges same-domain
  pairs only, resolves chains onto the final survivor, protects the
  `General`/`Misc` parking category, and never bumps `updated_at`. Unblocks
  re-measuring the deterministic reuse gate on a consolidated taxonomy.
- **Relation vocabulary + co-extraction channel**: new `DEPENDS_ON` /
  `DERIVED_FROM` relation types, single-sourced in `RELATION_TYPES` with the
  DB CHECK generated from it (legacy 4-type tables rebuilt once).
  Consecutive facts from one extraction batch are probed (≤3 calls) for
  dependency/derivation links the similarity channel structurally misses —
  SUPPORTS was 83% of all 8,948 relations because candidates were
  embedding-near pairs only. Off-vocabulary LLM answers are rejected before
  persist; dedup honours relation semantics — symmetric types
  (SUPPORTS/CONTRADICTS) dedupe in either direction, directional types
  (DEPENDS_ON/DERIVED_FROM/SUPERSEDES/INFLUENCES) only exact-direction so
  reverse claims (dependency cycles, competing canonicality) stay
  recordable, and a different type between an already-linked pair
  (relationship evolution, e.g. SUPPORTS later found CONTRADICTS) is
  recorded so the consistency queue can see late conflicts.

### Changed
- `search_ontology` output is bounded: unfiltered calls return a summary
  (counts only — previously a full-tree dump measured at 4.9MB in a single
  tool result); filtered calls cap facts per category via `limit` (default 5,
  max 50) plus a global category render cap, all truncations reported with
  exact remainders.
- Graph traversal weights: only CONTRADICTS/SUPERSEDES edges traverse at 0.7;
  every structural edge (SUPPORTS/INFLUENCES/DEPENDS_ON/DERIVED_FROM) at 1.0.

### Fixed
- Table-rebuild migrations toggle `foreign_keys` around the rebuild —
  better-sqlite3 enables FK enforcement by default, so dropping a referenced
  parent (`facts`) tripped child constraints on live-shaped DBs.
- `search_ontology` handler now closes the DB in `finally` (previously leaked
  the connection on error).
- Sync import remaps relation endpoints through content-dedup survivors — an
  edge whose fact was deduped onto an existing local fact used to be dropped
  by the FK check; post-remap self-loops and already-present edges are
  skipped instead of duplicated.
_The sections below are upstream's own v1.4.x release notes, kept verbatim
at the 2026-07-17 merge (fork 1.7.0). Fork-side coverage: v1.4.4 was already
ported (hardened) in 1.6.0; inject v2 (v1.4.0) is adopted in 1.7.0._

## [1.4.3] - 2026-07-12

### Fixed
- **Ineffective repeat-detection timebox replaced** (found by adversarial
  review): the v1.4.0 `Promise.race` 250ms timebox could never preempt
  `detectRepeat`'s synchronous better-sqlite3 vector search — the timer only
  fires after the blocking call completes. Replaced with an elapsed-budget
  gate: repeat detection is skipped entirely when injection has already spent
  >700ms, which actually bounds tail latency.

## [1.4.2] - 2026-07-12

### Fixed
- **Dependency self-heal**: `claude plugin update` non-deterministically skips
  `npm install` for the new cache dir (observed: 1.4.0 got node_modules,
  1.4.1 did not — every hook then died with `Cannot find package
  'better-sqlite3'`), and cc-sync ships plugin caches to other machines
  WITHOUT node_modules by design. The injection thin client (the only
  dep-free entry point, runs on every prompt) now detects
  ERR_MODULE_NOT_FOUND in its cold fallback and spawns a one-shot detached
  `npm install` in the plugin root, gated by an atomic `wx` marker file so it
  can never loop. Verified in isolation: detect → spawn → marker suppresses
  repeats → better-sqlite3 installed.

## [1.4.1] - 2026-07-12

### Fixed
- **Packaging**: v1.4.0 shipped a stale committed `dist/` (the injection-v2
  build output was not committed with its sources), so fresh installs got the
  new thin client but an old core without the dedup ledger. `dist/` is now
  rebuilt and committed; release checklist gains a HARD check that
  `git status dist/` is clean before tagging.

## [1.4.0] - 2026-07-12

### Added
- **Injection pipeline v2 — session dedup ledger** (`src/inject-ledger.ts`):
  a fact is injected at most ONCE per session. Measured waste before: 74%
  inject rate × 5.5–8 facts × ~140 chars ≈ ~470 tokens/prompt with the SAME
  facts re-injected across a session (~10k tokens per 30-prompt session).
  Ledger is bounded (400 ids, oldest-evict), TTL-pruned (7 days), session-id
  sanitized (path-traversal safe), atomic-write, and fail-open (a corrupt
  ledger never blocks injection). E2E: 2nd call in the same session injects
  0 bytes (`status:deduped`, ~330 tokens saved per repeated prompt).
- **Token budget**: per-fact 160-char truncation + 1,000-char block budget
  (lowest-relevance facts dropped first).
- **Observability**: inject log gains `chars` (block size) and `deduped`
  (facts saved by the ledger) so real-world savings are continuously measured.
- **Knowledge Galaxy** (`ui/relations/`): Three.js 3D visualization of the
  ontology — 32 domains / 4.2k categories / 24.7k facts / 27.8k typed
  relations, with search, per-type edge toggles, relation-navigating detail
  panel, and adaptive performance (compositor-only labels, point-size cap,
  eco-mode DPR degrade).

### Fixed
- `session_id` is now plumbed end-to-end through the injection path
  (hook stdin → thin client → daemon payload → core), which the dedup
  ledger requires.
- `detectRepeat` tail latency bounded (its 313k-exchange vector search has a
  measured p95 of 498ms): the search is synchronous and cannot be preempted
  once started, so it is skipped when injection has already spent >700ms
  (v1.4.0 shipped a Promise.race "timebox" that could not actually preempt
  the sync work — replaced in v1.4.3 with this elapsed-budget gate).
- bench-perf `exchanges_invisible_to_vector_search` counted only
  stale-version rows and reported 0 while ~90k missing-vector rows were
  unsearchable; it now counts true invisibility (stale OR missing vector).
- Vector drain completed: 87,727 invisible exchanges → 0 (all 313k
  exchanges searchable; final baseline: vector p50 20.9ms, fts 3.4ms).

## [1.3.4] - 2026-07-11

### Performance
- **Per-prompt context injection: ~2.3s → ~0.07s (35×)** — the UserPromptSubmit
  hook used to pay a full cold start on EVERY prompt (measured: model load
  1,130ms + node startup ~400ms + imports 186ms; the actual search was ~30ms).
  A warm unix-socket sidecar (`startInjectDaemon`) now lives inside the
  long-lived MCP server (which already has the embedding model loaded); the
  hook is a thin client with a cold local fallback that behaves exactly as
  before when no server is running. No new process, no new lifecycle: the
  sidecar is unref'd and dies with the MCP server; stale sockets are probed
  and reclaimed; socket mode 600. The shell wrapper also went from 4 node
  spawns to 1 (JSON parsing moved into the client), so even the cold fallback
  dropped ~2.3s → ~1.6s.
- **Fact/category vector search: 25.4ms → 3.8ms (6.7×)** — vec_facts /
  vec_facts_kr / vec_categories migrated to int8 (scripts/migrate-vec-facts-int8.mjs),
  same quantization the exchanges index got in v1.3.x. All writers/readers are
  dtype-aware via the new `getVecTableDtype()` (per-table, read from
  sqlite_master — never a flag), with distances normalized BEFORE the
  cross-language-index merge so mixed-dtype states mid-migration stay correct.
  Fresh DBs now create all vec tables as int8. Measured quality: same-id
  distance deviation ≤0.0098 (quantization noise), divergent picks are
  near-ties only.
- Exchanges vector KNN (int8, migrated on-machine via existing
  migrate-vec-int8.mjs): 58.5ms → 13.4ms at equal corpus size.

### Fixed
- **Self-heal for stamp-vector mismatch** — 197K exchanges (53% of one
  production corpus) claimed the current embedding_version but had NO vector
  row, leaving them permanently invisible to semantic search AND to the
  version-only reembed selector. The worker now also selects rows whose
  vec_exchanges row is missing (exact set-diff via the vec0 shadow `_rowids`
  table) and repairs them.
- **Legacy worker-prompt pollution purge + guard** — Haiku worker sessions
  from BEFORE the fixed LLM workdir ran with the caller project cwd, so their
  transcripts were indexed under REAL project slugs (measured: 59,940
  exchanges / ~16% of one corpus) where the v1.3.3 slug exclusion cannot see
  them. `purge-llm-sessions.mjs --legacy-prompts` removes them (backup-first,
  batched transactions), and `isWorkerPromptMessage()` now guards every
  indexing path so re-parsed archives can never re-pollute.
- `sync-import.ts` contained two literal NUL bytes (dedup-key separators) that
  made grep treat the file as BINARY — invisible to every code sweep. Replaced
  with the `\u0000` escape (runtime-identical) and made its vector writes
  dtype-aware.
- `bench-perf.mjs` / `bench/setup-bench-db.mjs`: dtype-aware against int8
  production tables.

### Operations note (per-machine)
Existing installs get the code via plugin update, but the DB-side migrations
run per machine: `node scripts/migrate-vec-int8.mjs` (exchanges),
`node scripts/migrate-vec-facts-int8.mjs` (facts/categories),
`node scripts/purge-llm-sessions.mjs --legacy-prompts --apply` (legacy
pollution), then let the reembed worker drain missing vectors. All are
idempotent, dry-run-first, backup-first.

## [1.3.3] - 2026-07-08

### Fixed
- **LLM worker sessions no longer pollute the conversation index** — every Haiku
  call spawns a one-shot headless CLI session under `<tmpdir>/memory-bank-llm`;
  those transcripts were being indexed like real conversations (measured: 4,351
  sessions / 6.7k exchange rows). `isExcludedProject()` (paths.ts) now built-in
  excludes any project slug ending with `-memory-bank-llm` (current fixed workdir
  and legacy mkdtemp variants alike) and is applied at every exchange-inserting
  walk: `indexConversations` / `indexSession` / `indexUnprocessed` (indexer.ts),
  sync (sync.ts) and verify (verify.ts). Ephemeral worker state is not knowledge.
- **Worker transcripts no longer accumulate forever** — nothing ever deleted the
  one-shot session transcripts (measured: 11,573 files / 99MB under
  `~/.claude/projects/*-memory-bank-llm`). `pruneLlmTranscripts()` (llm.ts) now
  runs opportunistically (throttled to at most hourly) on each LLM call: deletes
  only `.jsonl` / `-summary.txt` files older than a TTL
  (`MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS`, default 24h, hard floor 1h so an
  in-flight transcript can never be reaped), strictly inside the reserved
  `*-memory-bank-llm` slug namespace, never following symlinks, removing legacy
  slug dirs once emptied, and never throwing into the LLM call path.
- **Polluted rows cannot become extraction candidates** (defense in depth) —
  `backfill-extract-worker` drops sessions whose `cwd` ends with
  `/memory-bank-llm` from the pending queue, so exchanges indexed before this
  fix cannot feed fact extraction (which would spawn yet more Haiku sessions —
  a self-referential loop). The `NOT IN` subquery filters `session_id IS NOT
  NULL` explicitly: one NULL inside `NOT IN` nulls the whole predicate
  (3-valued logic) and would silently drain the entire backfill.
- **All Agent SDK spawn sites are now contained** — summarizer.ts and
  translate-facts.mjs ran `query()` without `cwd`/`settingSources`, so their
  sessions landed in the caller's project slug (indexable, unpruned) and loaded
  user settings whose SessionStart/End hooks re-spawn sync/backfill workers
  (session cascade). Both now share the same containment as llm.ts `callHaiku`:
  `cwd: llmWorkdir()`, `settingSources: []`.
- `BACKFILL_MIN_EXCHANGES` is validated via `boundedInt` before being
  interpolated into SQL — a garbage value (`'abc'` → `NaN`) used to produce
  invalid query text at runtime.

## [1.3.2] - 2026-07-05

### Fixed
- **`fact-consolidate-worker` had no single-instance lock** — the SessionStart hook
  spawns it detached on every session with no lock, so orphaned workers (ppid=1) piled
  up (measured 14 at once), each spawning a headless Claude session per LLM call and
  flooding the proxy across the account pool. Added a GLOBAL atomic `wx` pid-lock (same
  pattern as the ontology/extract/reembed workers). The lock is global, not per-project,
  because consolidation touches shared global-scope facts — concurrent per-project
  workers would race on the same rows.
- **Consolidation now processes the whole backlog in one pass** (`consolidateAllPending`
  / `getAllNewFactsSince`): the single lock-holder walks every new fact across all
  scopes/projects exactly once under a single Haiku budget, instead of looping
  `consolidateFacts` per project — which re-examined shared global facts once per project
  (up to `MAX_HAIKU_CALLS × projectCount` calls, since INDEPENDENT/CONTRADICTION verdicts
  keep the fact active) and could starve a project whose only pending work was an old
  fact matching a new global one. Same orphan-flood class fixed for the backfill workers
  in v1.3.0; the consolidate worker was the last detached worker missing a lock.
- **Same-scope-only consolidation** (`searchSimilarFactsSameScope`): a fact is compared
  ONLY within its own scope — a project fact against its own project's facts, a global
  fact against other global facts — with the scope gate applied to the full candidate
  overfetch BEFORE truncation, so an in-scope match is never starved out by closer
  out-of-scope rows. This closes a cross-scope data-leak/mutation path in both directions:
  a global driver reaching into a project's private rows, AND a project-private driver
  rewriting a shared global fact via EVOLUTION (leaking private text to every project) or
  deactivating it via CONTRADICTION. The old per-project `consolidateFacts()` (which used
  a project-scoped search that still included globals) was removed — all consolidation
  now goes through the single-pass, scope-isolated `consolidateAllPending`. The
  same-scope search pages the KNN fetch (growing until enough in-scope hits or the
  whole index is scanned) so even >200 closer out-of-scope rows cannot hide a valid
  in-scope match. `consolidateFacts` is kept as a deprecated, now-scope-safe back-compat
  export so existing importers don't crash at module load.
- **Unparseable comparison output is a no-op, not a hard stop**: consolidation is a
  best-effort background dedup, so a comparison whose LLM output isn't valid JSON is
  treated as "no verdict" and the cursor advances past it (the call still counts against
  the per-run Haiku budget). The pair is not lost — both facts stay active and the
  comparison re-triggers whenever either is a driver/candidate later — and no single fact
  (a transient non-JSON response, or a deliberately crafted one) can hold the cursor and
  starve the rest of the backlog. Only TRANSIENT call failures (callHaiku rejected — infra
  down) hold the cursor to retry, which is safe because during an outage nothing else
  would progress either.
- **Keyset consolidation cursor `(created_at, id)`**: the progress cursor was keyed on
  `created_at` alone, which stalled forever when a single timestamp group held more facts
  than the per-run Haiku budget (the cursor couldn't advance into a shared timestamp
  without risking a skip, so every run reprocessed the same oldest N and never reached the
  rest of the backlog). Keying on the unique `(created_at, id)` pair lets the drain advance
  one fact at a time — no stall, no same-timestamp skip. The cursor is persisted as JSON;
  an absent/legacy/corrupt cursor makes the drain start from the BEGINNING (no active fact
  is skipped — the per-run budget only caps actual consolidation calls, so the whole
  backlog drains across a few runs regardless of age). A fact imported mid-drain with an
  old timestamp is not re-driven by the current pass but is still a candidate for future
  comparisons (best-effort dedup, documented).
- **Bounded drain page + index**: the consolidation query pages the keyset (LIMIT 2000)
  instead of materializing every active fact, and a new `idx_facts_active_created_id`
  index serves the `(is_active, created_at, id)` filter+sort — so a from-the-beginning
  drain over tens of thousands of facts can't OOM or trigger a full-table temp sort.
- **Error-classified consolidation failure handling** (`classifyLlmError`): a comparison
  CALL rejection is three-valued — TRANSIENT (429/5xx/timeout/network/auth), DETERMINISTIC
  (400/413/422/oversized-prompt), or UNKNOWN (unrecognized). The status is read from the
  structured error (`status`/`statusCode`) OR the nested SDK/axios shape
  (`error.response.status`) OR a status number explicitly labelled in the message
  ("status code 400") — never a bare incidental number ("retry after 400 ms"). The drain
  loop SKIPS (advances after `facts.consolidation_attempts` reaches MAX, idempotent
  migration) **only** on a recognized DETERMINISTIC rejection — the one case where the fact
  itself is provably at fault. TRANSIENT, UNKNOWN, and any non-LLM internal error
  (parser/DB bug, tagged apart via `LlmCallError`) all HOLD the cursor and retry — an
  outage or an unrecognized error never silently drains the backlog, and a code bug never
  gets miscounted as a "bad fact". Skipping only on a certain per-request rejection is the
  narrowest, safest criterion that satisfies both "an outage must not silently drain the
  backlog" and "one un-processable fact must not wedge the cursor".
- **Persisted consolidation cursor**: the worker records the last fully-examined
  `created_at` (`fact-consolidate-cursor.txt`) and resumes after it, so the single Haiku
  budget reaches newer/project backlog instead of re-spending every run on the same
  oldest INDEPENDENT facts. The cursor only advances past a timestamp strictly older than
  the first unexamined fact, so same-millisecond facts at the budget wall are never
  skipped; a fact whose comparison errors (transient LLM failure) also holds the cursor
  back so it is retried, not permanently skipped.

## [1.3.1] - 2026-07-05

### Documentation
- **README**: "What's New" refreshed for v1.3.0 (batch classification, spawn isolation,
  attempt ledger, vec-index self-heal, hardened worker caps) and new **Configuration**
  entries for the backfill worker env knobs (`BACKFILL_ONTOLOGY_MAX`, `BACKFILL_EXTRACT_MAX`,
  `BACKFILL_BATCH_SIZE`, `BACKFILL_CONCURRENCY`, `BACKFILL_RELATIONS`) and the opt-in
  deterministic reuse gate (`MEMORY_BANK_ONTOLOGY_DET_GATE`, disabled by default per
  live measurement)

## [1.3.0] - 2026-07-05

### Changed
- **Ontology backfill batching**: `backfill-ontology-worker` now classifies facts in
  batches (default 20 per LLM call, `BACKFILL_BATCH_SIZE` env, ceiling 50) — one
  headless Agent SDK spawn per batch instead of per fact. Measured on live data:
  40 facts in 19s vs ~8min with per-fact calls (~25× wall-clock, 20× fewer spawns).
- **Headless LLM spawn isolation** (`llm.ts`): Agent SDK sessions now run with
  `maxTurns: 1`, `settingSources: []`, and a dedicated tmp `cwd` — worker LLM calls
  no longer fire user SessionStart/End hooks (which re-spawned sync/backfill workers
  per call) and no longer drop transcripts into user project dirs (where
  `claude --resume` could pick up a worker session).
- **Backfill relation detection defaults OFF** (`BACKFILL_RELATIONS=1` to opt in):
  each relation probe costs an extra LLM call; insert-time detection is unchanged.

### Added
- **Ontology attempt ledger** (`facts.ontology_attempts` / `ontology_last_attempt_at`,
  idempotent migration): failed classifications are counted per fact; after
  3 attempts the fact is parked in General/Misc and permanently leaves the backfill
  queue (it stays fully searchable — ontology is an overlay). Ends the
  re-select-and-re-bill-forever loop for permanently failing facts.
- `scripts/measure-det-gate.mjs` — live-data measurement harness for the
  deterministic category-reuse gate. The gate ships DISABLED by default
  (opt-in via `MEMORY_BANK_ONTOLOGY_DET_GATE`): measured top-1 agreement with LLM
  assignments was only 72% at sim≥0.93 (n=800 sample) — insufficient for auto-assign.

### Fixed
- **Fallback classification was never persisted**: on unparseable LLM output the
  classifier built General/Misc but returned without writing the fact's
  `ontology_category_id`, leaving it NULL — re-selected (and re-billed) by every
  backfill run. Classification failure now raises, feeds the attempt ledger, and
  the fallback is actually persisted at the attempt cap.
- **Honest failure counts** in the backfill log: errors were swallowed inside
  `classifyAndLinkFact`, so the log always reported `failed 0`. The batch pipeline
  reports llm/deterministic/fallback/failed separately.

## [1.2.2] - 2026-07-04

### Documentation
- **README**: "What's New" refreshed for v1.2.x, new **Context Injection** section
  (per-prompt injection pipeline, baseline-margin relevance gate, 1-hop ontology
  expansion, observability log locations, troubleshooting), Context Injection
  added to the feature list and data-flow diagram.

## [1.2.1] - 2026-07-04

### Added
- **Injection observability (fail-loud)**: the UserPromptSubmit context-injection
  pipeline now records every run as a JSONL entry
  (`<config>/conversation-index/logs/inject-context.jsonl` — status
  injected/no-match/skipped/error, candidate/injected counts, duration), and the
  hook wrapper routes node-level crash output to `logs/inject-context.err.log`
  instead of discarding it. A silently broken install (stale plugin, missing
  `node_modules`) is now measurable instead of invisible — the previous
  silent-failure mode went unnoticed for months.

### Fixed
- Injection error paths now log the failure reason (truncated to 300 chars)
  alongside the existing stderr message.

## [1.2.0] - 2026-07-03

### Added
- **`memory-bank analyze` command**: Deterministic full-history analysis of the entire
  conversation index — coverage (fact extraction / summaries), fact breakdowns by
  category/scope, top knowledge domains, per-project rollups, monthly activity
  timeline, and backfill recommendations. Supports `--json`, `--out`, `--top`, `--months`.
- **`analyzing-all-conversations` skill**: Plugin skill that runs the analyze engine,
  kicks off backfill for unanalyzed sessions, enriches the numbers with fact/ontology
  search, and presents an organized report of the whole conversation history.
- **Transparent `.zst` archive support** (`src/archive-io.ts`): The conversation archive
  may be compressed out-of-band (`*.jsonl` → `*.jsonl.zst`). All read paths — parser,
  `read` MCP tool, search summaries/line counts, sync, stats, indexer, verify — now
  resolve either variant using Node's built-in zstd (Node >= 22.15), no new dependency.

### Changed
- **FTS5 text search**: BM25-ranked full-text search (`exchanges_fts`, detail=column) replaces
  the O(rows) LIKE full scan — recall@10 0.93 → 1.00, FTS index 2,953MB → 407MB. Query
  tokenization aligned with the unicode61 tokenizer; identifier tokens preserved; rank
  budget + sparse-token AND ladder to avoid BM25 pathologies.
- **Search-path performance**: cached search DB connection (path-keyed, mtime-checked),
  int8 vector quantization for `vec_exchanges` (dual-dtype with migration), and
  query-embedding LRU memoization (removes double embedding per MCP search).
- **Backfill extraction guards**: self-referential projects excluded by default
  (`BACKFILL_EXCLUDE_PROJECTS`) and minimum-exchange filter to skip empty sessions.
- **Fact extraction quality/cost improvements**:
  - Trivial exchanges (bare slash commands, harness artifacts, short acknowledgements)
    are filtered before LLM calls.
  - Cross-batch duplicate facts within a session are dropped via normalized comparison.
  - Long sessions cap LLM calls (default 12, `MEMORY_BANK_MAX_EXTRACT_CALLS`) with
    evenly-spread batch selection so the whole session is represented.
  - Extraction prompt now prefers durable facts and problem→solution lessons.
- **Sync no longer re-copies archives compressed out-of-band**: `copyIfNewer` treats a
  current `.zst` copy as up-to-date, preventing full-history re-copy churn each session.

### Fixed
- **`read` MCP tool worked only on plain `.jsonl`**: reading any archived conversation
  failed with "File not found" once the archive was compressed. Now resolves `.zst`.
- **Summary coverage was misreported as zero**: existing `-summary.txt.zst` files are
  now detected by stats/analyze/sync/indexer/verify.

## [1.1.0] - 2026-04-12

### Added
- **Multi coding-agent tagging**: Conversations and extracted facts now record which coding agent produced them.
  - Default source remains `claude-code`.
  - Additional sources can be configured with `MEMORY_BANK_AGENT_SOURCES` or `conversation-index/agent-sources.json`.
  - Supported agent labels include `claude-code`, `codex`, `opencode`, and custom agent names.
- **Agent-aware search filters**: MCP and library search paths can filter conversations and facts by `coding_agent`.
  - `search` supports a `coding_agent` filter.
  - `search_facts` supports a `coding_agent` filter.
  - Search result formatting shows an agent tag for non-default sources.

### Changed
- **Sync now preserves source-agent identity**: Synced exchanges are tagged during indexing so multi-agent setups can share one memory bank without losing provenance.
- **Search agent upgraded to Sonnet**: The bundled `search-conversations` agent now uses Sonnet instead of Haiku for stronger retrieval and synthesis.
- **Plugin update docs clarified**: README update instructions now use the correct `/plugin update memory-bank` command.

### Fixed
- **Facts inherit coding-agent metadata**: Fact extraction now carries the exchange agent through to saved facts.
- **Search and fact schema migrations are backward-compatible**: Existing databases gain the new `coding_agent` columns through idempotent migrations.

## [1.0.16] - 2026-03-25

### Added
- **`/show-memory-bank` slash command**: Opens the Memory Bank web dashboard from Claude Code.
- **Automatic command installation**: SessionStart hooks install bundled slash commands into user scope.

### Changed
- **Plugin command manifest format**: `commands` now points to the commands directory so Claude Code can discover bundled commands correctly.

## [1.0.15] - 2025-12-17

### Changed
- **Stop shipping package-lock.json**: Removed from git tracking so npm generates platform-appropriate lockfile on install
- **Remove file deletion from MCP wrapper**: No longer deletes package-lock.json on first run (unnecessary without shipped lockfile)

## [1.0.14] - 2025-12-16

### Fixed
- **Windows spawn ENOENT error**: Add `shell` option for npx commands on Windows (#36, thanks @andrewcchoi!)
  - On Windows, npx is a .cmd file requiring `shell: true` for spawn() to work
  - Applied fix to `cli/memory-bank.js` and `cli/index-conversations.js`
  - Resolves plugin initialization failures and silent SessionStart hook failures on Windows
- **Agent conversations polluting search index**: Add exclusion marker to summarizer prompts (#15, thanks @one1zero1one!)
  - Summarizer agent conversations are now properly excluded from indexing
  - Extracted marker to shared constant (`SUMMARIZER_CONTEXT_MARKER`) for maintainability
- **Background sync silently failing**: CLI now uses compiled JS instead of tsx at runtime (#25 root cause, thanks @stromseth for identifying!)
  - `--background` flag on sync command now works correctly
  - Fixes SessionStart hook auto-sync that was silently failing
- **Directory auto-creation**: Config directories are now created automatically (inspired by #18, thanks @gingerbeardman!)
  - `getSuperpowersDir()`, `getArchiveDir()`, `getIndexDir()` now ensure directories exist
  - Prevents errors on fresh installs where directories don't exist yet

### Changed
- **CLI uses compiled JavaScript**: Remove tsx from runtime path
  - All CLI commands now route through `dist/*.js` instead of `npx tsx src/*.ts`
  - Faster startup, lighter runtime dependencies
  - tsx is now dev-only (for tests and development)
  - Obsoletes PR #25 (background sync fix) by fixing root cause
- **CLI architecture cleanup**: Replace bash scripts with Node.js wrappers
  - All CLI entry points (`memory-bank`, `index-conversations`, `search-conversations`, `mcp-server`) are now Node.js scripts
  - Eliminates bash dependency entirely for full cross-platform support (Windows, NixOS, etc.)
  - SessionStart hook now calls `node cli/memory-bank.js` directly
  - Added `search-conversations.js` to complete Node.js CLI coverage
  - Obsoletes PRs #29 (pnpm workspace), #11 (env bash), and #17 (shebang fix)

## [1.0.13] - 2025-11-22

### Fixed
- **MCP server startup error**: Fix "Invalid or unexpected token" error when starting MCP server
  - Changed plugin.json to use `cli/mcp-server-wrapper.js` instead of bash script `cli/mcp-server`
  - MCP server configuration was pointing to bash script which was being executed with `node` command
  - Wrapper script properly handles Node.js execution and runs bundled `dist/mcp-server.js`

## [1.0.12] - 2025-11-22

### Changed
- **Skill triggering behavior**: Improved memory bank skill to trigger at appropriate times
  - Changed from "ALWAYS USE THIS SKILL WHEN STARTING ANY KIND OF WORK" to contextual triggers
  - Now triggers when user asks for approach/decision after exploring code
  - Now triggers when stuck on complex problems after investigating
  - Now triggers for unfamiliar workflows or explicit historical references
  - Prevents premature memory searches before understanding current codebase
  - Empirically tested with subagents: 5/5 scenarios passed vs 3/5 with previous description

## [1.0.11] - 2025-11-20

### Fixed
- **Plugin Configuration**: Fix duplicate hooks file error in Claude Code
  - Remove duplicate `"hooks": "./hooks/hooks.json"` reference from plugin.json
  - Claude Code automatically loads hooks/hooks.json, so manifest should only reference additional hook files
  - Update MCP server reference from obsolete `mcp-server-wrapper.js` to direct `mcp-server` script

### Changed
- Simplified plugin.json configuration for cleaner Claude Code integration

## [1.0.10] - 2025-11-20

### Fixed
- **Search result formatting**: Prevent Claude's Read tool 256KB limit failures
  - Search results now include file metadata (size in KB, total line count)
  - Changed from verbose 3-line format to clean 1-line: "Lines 10-25 in /path/file.jsonl (295.7KB, 1247 lines)"
  - Removes prescriptive MCP tool instructions, trusting Claude to choose correct tool based on file size
  - Eliminates issue where memory bank search triggered built-in Read tool instead of specialized MCP read tool

### Changed
- Enhanced `formatResults()` and `formatMultiConceptResults()` with async file metadata collection
- Added efficient streaming line counting and file size utilities
- Updated MCP server and CLI callers to handle async formatting functions

## [1.0.9] - 2025-10-31

### Removed
- **Dead code cleanup**: Removed obsolete bash script `cli/mcp-server-wrapper`
  - Eliminates duplicate wrapper implementations
  - Only Node.js cross-platform wrapper `mcp-server-wrapper.js` remains
  - Prevents confusion about which wrapper to use
  - Cleaner codebase with single MCP server entry point

### Changed
- Simplified MCP server architecture with single wrapper implementation
- Improved maintainability by removing redundant bash script

## [1.0.8] - 2025-10-31

### Fixed
- **Issue #7**: Fixed Windows support for MCP server provided in plugin
  - Replaced bash script `mcp-server-wrapper` with cross-platform Node.js version
  - MCP server now works on Windows with Claude Code native install
  - Resolves "No such file or directory" errors on Windows when using `/bin/bash`

### Changed
- MCP server wrapper now uses `node cli/mcp-server-wrapper.js` instead of bash script
- Cross-platform dependency installation with proper Windows npm.cmd handling
- Improved signal forwarding and process management in wrapper

### Added
- Cross-platform Node.js wrapper script for MCP server initialization
- Better error handling and messaging for missing dependencies
- Windows-compatible npm command detection (`npm.cmd` vs `npm`)

## [1.0.7] - 2025-10-31

### Fixed
- **Issue #10**: Fixed SessionStart hook configuration that prevented memory sync from running
  - Removed invalid `args` property from hook configuration
  - Added `async: true` and `--background` flag to prevent blocking Claude startup
- **Issue #5**: Fixed summary generation failure during sync command
  - Resolved confusion between archived conversation IDs and active session IDs
  - Sync now properly generates summaries for archived conversations
- **Issue #9**: Fixed better-sqlite3 Node.js version compatibility issues
  - Added postinstall script to automatically rebuild native modules
  - Resolves NODE_MODULE_VERSION mismatch errors on Node.js v25+
- **Issue #8**: Fixed version mismatch between git tags and marketplace.json
  - Synchronized plugin version metadata with release tags

### Added
- Background sync mode with `--background` flag for non-blocking operation
- Automatic native module rebuilding for cross-Node.js version compatibility
- Enhanced CLI help documentation with background mode usage examples

### Changed
- SessionStart hook now uses `memory-bank sync --background` for instant startup
- Sync command forks to background process when `--background` flag is used
- Improved hook configuration follows Claude Code hook specification exactly
- Updated marketplace.json versions in both embedded and superpowers-marketplace locations

### Security
- Fixed potential process blocking during Claude Code startup
- Improved process detachment for background operations

## [1.0.6] - 2025-10-27

### Fixed
- **Issue #1**: Fixed Windows CLI execution failure by replacing bash scripts with cross-platform Node.js implementation
- **Issue #4**: Fixed sqlite-vec extension loading error on macOS ARM64 and Linux by adding `--external:sqlite-vec` to esbuild configuration
- Resolved "Loadable extension for sqlite-vec not found" error on affected platforms

### Added
- Cross-platform CLI support using Node.js instead of bash scripts
- Enhanced error handling with clear error messages and troubleshooting guidance
- Automatic dependency validation (npx, tsx) in CLI tools
- Proper symlink resolution for npm link and global installations

### Changed
- CLI entry points now use `.js` extension for universal compatibility
- Replaced `shell: true` spawn calls with direct spawn for improved security
- Updated build configuration to externalize sqlite-vec native module
- Improved process execution without shell interpretation to prevent command injection

### Security
- Removed shell dependencies from CLI execution
- Added input validation and protection against command injection vulnerabilities
- Safer process execution using direct spawn calls

## [1.0.5] - 2025-10-25

### Fixed
- MCP server wrapper now deletes package-lock.json before npm install to ensure platform-specific sqlite-vec packages are installed
- Resolves "Loadable extension for sqlite-vec not found" error on fresh plugin installs

### Changed
- Add package-lock.json to .gitignore to prevent cross-platform optional dependency issues
- Improve wrapper script to handle npm's platform-specific optional dependency installation behavior

## [1.0.4] - 2025-10-23

### Changed
- Strengthen agent and MCP tool descriptions to emphasize memory restoration
- Use empowering "this restores it" framing instead of deficit-focused language
- Make it crystal clear the tool provides cross-session memory and should be used before every task

## [1.0.3] - 2025-10-23

### Fixed
- MCP server now automatically installs npm dependencies on first startup via wrapper script
- Resolves "Cannot find module" errors for @modelcontextprotocol/sdk and native dependencies

### Added
- MCP server wrapper script (`cli/mcp-server-wrapper`) that auto-installs dependencies before starting
- esbuild bundling for MCP server to reduce dependency load time

### Changed
- MCP server now uses wrapper script instead of direct node execution
- Removed SessionStart ensure-dependencies hook (no longer needed)

### Removed
- `cli/ensure-dependencies` script (replaced by MCP server wrapper)

## [1.0.2] - 2025-10-23

### Fixed
- Pre-build and commit dist/ directory to avoid MCP server startup errors
- Remove dist/ from .gitignore to ensure built files are available after plugin install

### Changed
- Built JavaScript files now tracked in git for immediate plugin availability

## [1.0.1] - 2025-10-23

### Added
- Automatic dependency installation on plugin install via SessionStart hook
- `ensure-dependencies` script that checks and installs npm dependencies when needed

### Changed
- Plugin installation now automatically runs `npm install` if `node_modules` is missing
- Improved first-time plugin installation experience

### Fixed
- Plugin dependencies not being installed automatically after plugin installation

## [1.0.0] - 2025-10-14

### Added
- Initial release of memory-bank
- Semantic search for Claude Code conversations
- MCP server integration for Claude Code
- Automatic session-end indexing via plugin hooks
- Multi-concept AND search for finding conversations matching all terms
- Unified CLI with commands: sync, search, show, stats, index
- Support for excluding conversations from indexing via DO NOT INDEX marker
- Comprehensive metadata tracking (session ID, git branch, thinking level, etc.)
- Both vector (semantic) and text (exact match) search modes
- Conversation display with markdown and HTML output formats
- Database verification and repair tools
- Full test suite with 71 tests

### Features
- **Search Modes**: Vector search, text search, or combined
- **Automatic Indexing**: SessionStart hook runs sync automatically
- **Privacy**: Exclude sensitive conversations from search index
- **Offline**: Uses local Transformers.js for embeddings (no API calls)
- **Fast**: SQLite with sqlite-vec for efficient similarity search
- **Rich Metadata**: Tracks project, date, git branch, Claude version, and more

### Components
- Core TypeScript library for indexing and searching
- CLI tools for manual operations
- MCP server for Claude Code integration
- Automatic search agent that triggers on relevant queries
- SessionStart hook for dependency installation and sync
