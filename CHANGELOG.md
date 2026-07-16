# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-07-16

Fork-independent versioning: upstream memory-bank's v1.4.x line carries a
DIFFERENT 1.4.0 than this fork's 1.4.0 — the 2.x line removes that ambiguity.
This release ships the fork's ontology-gaps work (sections below) plus a
selective port of upstream integrity fixes (upstream v1.3.1–v1.4.4 range,
cherry-picked; no wholesale merge).

### Ported from upstream (integrity set)
- **LLM worker pollution blocking** (upstream v1.3.3): built-in exclusion of
  `memory-bank-llm` session slugs + `WORKER_PROMPT_PREFIXES` content
  discriminator (`src/pollution-predicate.ts`) wired into indexer/sync/verify;
  worker transcript TTL pruning in `llm.ts`; `scripts/purge-llm-sessions.mjs`
  for legacy pollution cleanup; summarizer gains the same cwd/settings
  containment as `callHaiku`. Prompt↔prefix drift is locked by
  `test/worker-prompt-coupling.test.ts` (fork prompt leads verified identical).
- **Consolidation gates** (upstream R2–R25 series): same-scope-only candidate
  search (`searchSimilarFactsSameScope` — project/global facts can never
  merge across the boundary), keyset `(created_at, id)` drain cursor with
  persist (`getAllNewFactsSince` + covering index), 3-class LLM error
  classification (transient/deterministic/unknown) with circuit breaker,
  cross-run attempt ledger (`facts.consolidation_attempts`), and the
  single-run lock in `scripts/fact-consolidate-worker.js`.
- **Reembed/pending self-heal**: stamp–vector mismatch self-heal + periodic
  WAL truncate + ORDER BY rowid in `scripts/reembed-worker.js`, extracted
  selector with pollution re-injection guard (`src/reembed-selector.ts`),
  pending predicates single-sourced (`src/pending-extraction.ts`) and spawn
  conditions that see missing-vector/KR backlogs
  (`scripts/fact-consolidate-hook.js`).
- **WAL cap**: `journal_size_limit = 64MiB` on every connection (upstream
  observed an unbounded 1.4GB WAL crawling the reembed drain).
- **Version drift guard** (upstream v1.4.4): sync singleton lock now carries
  `{pid, version, startedAt}` — a newer sync preempts an older or wedged
  (>6h) holder (`src/version-guard.ts`); SessionStart sweeps detached workers
  running from older plugin versions (`scripts/version-drift-check.js`).
- **Relation exact-duplicate guard**: UNIQUE index on the
  (source, type, target) TRIPLE with one-time dedup — compatible with the
  fork's direction/symmetry dedup semantics (strictly narrower);
  `createRelation` writes with `INSERT OR IGNORE` to absorb the insert race.
- Deliberately NOT ported: inject pipeline v2 / warm daemon, fact-vector int8
  migration (fact vec tables stay FLOAT; dtype-aware code handles either),
  Knowledge Galaxy UI, upstream ontology-classifier R9–R20 internals (the
  fork has its own reviewed dedup/consistency layer), replacement-os/hue-os.

### Fixed (release hygiene)
- `dist/` rebuilt and recommitted — PR #3 merged src without a dist rebuild,
  so `main`'s dist lacked the fact-category/consistency/taxonomy-align
  modules entirely.

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
