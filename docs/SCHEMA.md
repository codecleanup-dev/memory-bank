# Database Schema

## Tables

### `exchanges`

Core conversation exchanges (user-agent pairs).

```sql
CREATE TABLE exchanges (
  id TEXT PRIMARY KEY,

  -- Content
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,

  -- Location
  project TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,

  -- Timing
  timestamp TEXT NOT NULL,
  last_indexed INTEGER,

  -- Conversation structure
  parent_uuid TEXT,           -- Links to parent exchange
  is_sidechain BOOLEAN,       -- True if subagent conversation

  -- Session context
  session_id TEXT,
  cwd TEXT,                   -- Working directory
  git_branch TEXT,
  claude_version TEXT,

  -- Thinking metadata
  thinking_level TEXT,        -- "none", "high", etc.
  thinking_disabled BOOLEAN,
  thinking_triggers TEXT      -- JSON array of trigger info
);
```

### `tool_calls`

Tool usage tracking for searchable tool patterns.

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,  -- Foreign key to exchanges.id
  tool_name TEXT NOT NULL,
  tool_input TEXT,            -- JSON of tool parameters
  tool_result TEXT,           -- Result content
  is_error BOOLEAN,
  timestamp TEXT NOT NULL,

  FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
);

CREATE INDEX idx_tool_name ON tool_calls(tool_name);
CREATE INDEX idx_exchange_id ON tool_calls(exchange_id);
```

### `vec_exchanges`

Vector embeddings for semantic search (sqlite-vec). Fresh DBs are created
with `int8[384]` (quantized: 4× smaller, ~2× faster KNN, identical recall@10);
pre-quantization DBs keep `FLOAT[384]` until migrated. The authoritative dtype
is read from `sqlite_master` (`getVecDtype`).

```sql
CREATE VIRTUAL TABLE vec_exchanges USING vec0(
  id TEXT PRIMARY KEY,
  embedding int8[384]  -- FLOAT[384] on legacy DBs
);
```

### `facts`

Long-term facts extracted from conversations. `category` is a controlled
vocabulary enforced by a CHECK constraint; every write path normalizes
through `normalizeFactCategory()` (`src/fact-category.ts`), and legacy DBs
are rebuilt once by `migrateFactsCategoryVocabulary()`.

```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  fact TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('decision','preference','pattern','knowledge','constraint')),
  scope_type TEXT NOT NULL DEFAULT 'project',   -- 'project' | 'global'
  scope_project TEXT,                           -- canonical absolute path
  source_exchange_ids TEXT,                     -- JSON array (provenance)
  embedding BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consolidated_count INTEGER DEFAULT 1,         -- reinforcement (times re-confirmed)
  is_active INTEGER DEFAULT 1,
  ontology_category_id TEXT,                    -- ontology overlay assignment
  fact_kr TEXT,                                 -- Korean translation
  coding_agent TEXT DEFAULT 'claude-code',
  embedding_version INTEGER NOT NULL DEFAULT 1,
  ontology_attempts INTEGER NOT NULL DEFAULT 0, -- classification attempt ledger
  ontology_last_attempt_at TEXT,
  confidence REAL                               -- extraction confidence 0..1 (NULL on legacy rows)
);
```

### `fact_revisions`

Change history for evolved/contradicted facts (append-only evidence chain).

```sql
CREATE TABLE fact_revisions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  previous_fact TEXT NOT NULL,
  new_fact TEXT NOT NULL,
  reason TEXT,
  source_exchange_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (fact_id) REFERENCES facts(id)
);
```

### `vec_facts` / `vec_facts_kr` / `vec_categories`

Vector indexes (all `FLOAT[384]`): facts in English and Korean (queries hit
both, best score per id wins), and category embeddings used as reuse
candidates by the ontology classifier and as merge-candidate source by
`taxonomy-align`.

### `ontology_domains` / `ontology_categories`

Two-level taxonomy overlay (Domain > Category). Facts point in via
`facts.ontology_category_id`; `General`/`Misc` is the parking category for
facts whose classification exhausted the attempt ledger.

### `ontology_relations`

Typed fact-to-fact edges. The vocabulary is single-sourced from
`RELATION_TYPES` (`src/types.ts`); legacy 4-type tables are rebuilt once by
`migrateRelationTypeVocabulary()`. Candidates come from two channels:
embedding similarity (≥0.89, top-2) and co-extraction (consecutive facts of
one extraction batch). `memory-bank consistency` reports active-active
CONTRADICTS/SUPERSEDES pairs as a resolution queue.

```sql
CREATE TABLE ontology_relations (
  id TEXT PRIMARY KEY,
  source_fact_id TEXT NOT NULL REFERENCES facts(id),
  relation_type TEXT NOT NULL CHECK(relation_type IN
    ('INFLUENCES','SUPERSEDES','SUPPORTS','CONTRADICTS','DEPENDS_ON','DERIVED_FROM')),
  target_fact_id TEXT NOT NULL REFERENCES facts(id),
  reasoning TEXT,                               -- per-edge justification (provenance)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `extraction_log`

Idempotency marker: which sessions already went through fact extraction.

```sql
CREATE TABLE extraction_log (
  session_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL,
  extracted INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0
);
```

## Indexes

```sql
-- Time-based sorting
CREATE INDEX idx_timestamp ON exchanges(timestamp DESC);

-- Session lookups
CREATE INDEX idx_session_id ON exchanges(session_id);

-- Project filtering
CREATE INDEX idx_project ON exchanges(project);

-- Sidechain filtering
CREATE INDEX idx_sidechain ON exchanges(is_sidechain);

-- Branch filtering
CREATE INDEX idx_git_branch ON exchanges(git_branch);
```

## Schema Evolution

Schema changes are applied via migrations in `src/db.ts`:

1. Check for missing columns using `pragma_table_info()`
2. Add new columns with `ALTER TABLE`
3. Populate with data from re-indexing if needed

Constraint changes (CHECK) cannot be ALTERed in SQLite — those run as
one-time table rebuilds (`migrateFactsCategoryVocabulary`,
`migrateRelationTypeVocabulary`), guarded on the constraint already being
present in `sqlite_master`, with `foreign_keys` toggled OFF around the
rebuild (better-sqlite3 enforces FKs by default and `DROP TABLE` on a
referenced parent trips child constraints).

Migrations are idempotent - safe to run multiple times.
