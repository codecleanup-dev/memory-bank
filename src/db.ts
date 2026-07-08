import Database from 'better-sqlite3';
import { ConversationExchange } from './types.js';
import path from 'path';
import fs from 'fs';
import * as sqliteVec from 'sqlite-vec';
import { getDbPath } from './paths.js';
import { autoHealScopeProjects } from './project-canon.js';
import { EMBEDDING_VERSION } from './embeddings.js';
import { FACT_CATEGORY_CHECK_SQL, normalizeFactCategory } from './fact-category.js';
import { RELATION_TYPES } from './types.js';

const RELATION_TYPE_CHECK_SQL = `relation_type IN (${RELATION_TYPES.map((t) => `'${t}'`).join(',')})`;

// === vec_exchanges dtype support (float32 legacy / int8 quantized) ===
// int8 quantization: q = clamp(round(x*127)). e5 embeddings are L2-normalized
// (components ≪ 1), so 127-scaling loses <1% distance precision — measured
// recall@10 is identical to float32 while storage is 4× smaller and KNN ~2×
// faster. IMPORTANT: int8 L2 distances are scaled by ×127 vs float32 —
// consumers converting distance→similarity must divide by VEC_INT8_SCALE first.

export type VecDtype = 'float32' | 'int8';
export const VEC_INT8_SCALE = 127;

/**
 * Authoritative vector dtype for vec_exchanges.
 *
 * Derived from the ACTUAL table schema in sqlite_master — not a metadata flag.
 * A flag can diverge from the real schema (missing/corrupt flag on an int8
 * table would silently send float32 params against int8 storage); parsing the
 * declared column type cannot. Absent table ⇒ 'int8' (that is what
 * initDatabase creates for fresh DBs).
 */
export function getVecDtype(db: Database.Database): VecDtype {
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_exchanges'`
  ).get() as { sql: string } | undefined;
  if (!row?.sql) return 'int8';
  return /int8\s*\[/i.test(row.sql) ? 'int8' : 'float32';
}

/** Convert a float embedding to the blob matching the table dtype. */
export function embeddingToVecBlob(embedding: number[], dtype: VecDtype): Buffer {
  if (dtype === 'int8') {
    const q = new Int8Array(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      q[i] = Math.max(-127, Math.min(127, Math.round(embedding[i] * VEC_INT8_SCALE)));
    }
    return Buffer.from(q.buffer);
  }
  return Buffer.from(new Float32Array(embedding).buffer);
}

/** SQL placeholder for a vec_exchanges MATCH/INSERT param under the dtype. */
export function vecParamSql(dtype: VecDtype): string {
  return dtype === 'int8' ? 'vec_int8(?)' : '?';
}

/** Normalize a vec KNN distance back to float32 scale (int8 distances are ×127). */
export function normalizeVecDistance(distance: number, dtype: VecDtype): number {
  return dtype === 'int8' ? distance / VEC_INT8_SCALE : distance;
}

export function migrateSchema(db: Database.Database): void {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('exchanges')`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map(c => c.name));

  const migrations: Array<{ name: string; sql: string }> = [
    { name: 'last_indexed', sql: 'ALTER TABLE exchanges ADD COLUMN last_indexed INTEGER' },
    { name: 'parent_uuid', sql: 'ALTER TABLE exchanges ADD COLUMN parent_uuid TEXT' },
    { name: 'is_sidechain', sql: 'ALTER TABLE exchanges ADD COLUMN is_sidechain BOOLEAN DEFAULT 0' },
    { name: 'session_id', sql: 'ALTER TABLE exchanges ADD COLUMN session_id TEXT' },
    { name: 'cwd', sql: 'ALTER TABLE exchanges ADD COLUMN cwd TEXT' },
    { name: 'git_branch', sql: 'ALTER TABLE exchanges ADD COLUMN git_branch TEXT' },
    { name: 'claude_version', sql: 'ALTER TABLE exchanges ADD COLUMN claude_version TEXT' },
    { name: 'thinking_level', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_level TEXT' },
    { name: 'thinking_disabled', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_disabled BOOLEAN' },
    { name: 'thinking_triggers', sql: 'ALTER TABLE exchanges ADD COLUMN thinking_triggers TEXT' },
    { name: 'coding_agent', sql: "ALTER TABLE exchanges ADD COLUMN coding_agent TEXT DEFAULT 'claude-code'" },
  ];

  let migrated = false;
  for (const migration of migrations) {
    if (!columnNames.has(migration.name)) {
      console.error(`Migrating schema: adding ${migration.name} column...`);
      db.prepare(migration.sql).run();
      migrated = true;
    }
  }

  if (migrated) {
    console.error('Migration complete.');
  }
}

/**
 * Enforce the facts.category controlled vocabulary on legacy DBs.
 *
 * facts.category was plain TEXT with no constraint, so LLM output drift
 * accumulated out-of-vocabulary values ('requirement' ×44, enum echoes,
 * 'null', NULL — measured 2026-07-07). SQLite cannot ADD a CHECK constraint,
 * so this rebuilds the table once: normalize existing rows through the same
 * deterministic mapping the write path uses, then copy into a table that
 * carries NOT NULL + CHECK. Generic column copy via pragma_table_info keeps
 * the rebuild independent of which optional columns this DB already has.
 *
 * Idempotent: guarded on the CHECK already being present in sqlite_master.
 * FK clauses in fact_revisions/ontology_relations reference the table name
 * only and enforcement is off (better-sqlite3 default), so drop+rename is
 * safe.
 */
/**
 * Run a table-rebuild transaction with foreign_keys OFF.
 *
 * better-sqlite3 enables FK enforcement by default, and DROP TABLE on a
 * referenced parent performs an implicit DELETE that trips child constraints
 * (facts is referenced by fact_revisions and ontology_relations — 8,948 rows
 * live). The standard SQLite rebuild procedure toggles the pragma around the
 * transaction; toggling inside one is a no-op, hence this wrapper.
 */
function withForeignKeysOff(db: Database.Database, fn: () => void): void {
  const wasOn = (db.pragma('foreign_keys', { simple: true }) as number) === 1;
  if (wasOn) db.pragma('foreign_keys = OFF');
  try {
    fn();
  } finally {
    if (wasOn) db.pragma('foreign_keys = ON');
  }
}

/**
 * Extend the ontology_relations CHECK to the current relation vocabulary.
 * SQLite cannot alter a CHECK, so legacy tables (4-type constraint) are
 * rebuilt once; existing rows are all valid under the extended list, so this
 * is a pure schema copy. Idempotent: guarded on every vocabulary member
 * already appearing in the stored DDL.
 */
/**
 * DEFAULT clause for a rebuilt column from pragma_table_info's dflt_value:
 * literals (quoted strings, numbers, already-parenthesized expressions) pass
 * through; bare expressions like datetime('now') must be re-wrapped in
 * parens or the generated DDL is a syntax error.
 */
function defaultClause(dfltValue: string | null): string {
  if (dfltValue == null) return '';
  const v = dfltValue.trim();
  const literal = /^['"(]|^-?\d/.test(v) || /^(NULL|TRUE|FALSE|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/i.test(v);
  return ` DEFAULT ${literal ? v : `(${v})`}`;
}

export function migrateRelationTypeVocabulary(db: Database.Database): void {
  const tbl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ontology_relations'`)
    .get() as { sql: string } | undefined;
  if (!tbl?.sql) return;
  if (RELATION_TYPES.every((t) => tbl.sql.includes(`'${t}'`))) return;

  // Fail-safe for hand-modified DBs: the two shipped FKs (source/target →
  // facts.id) are reconstructed below; any OTHER foreign key is DDL this
  // rebuild cannot reproduce, so leave the table alone (new relation types
  // are then rejected by the old CHECK on that DB — detection probes treat
  // that as a non-fatal skip).
  const fks = db.pragma(`foreign_key_list('ontology_relations')`) as Array<{
    table: string;
    from: string;
  }>;
  const isShippedFk = (fk: { table: string; from: string }): boolean =>
    fk.table === 'facts' && (fk.from === 'source_fact_id' || fk.from === 'target_fact_id');
  if (fks.some((fk) => !isShippedFk(fk))) {
    console.error(
      'ontology_relations vocabulary migration skipped: custom FOREIGN KEY present — legacy CHECK stays in place.',
    );
    return;
  }
  // Same fail-safe for other irreproducible constraint DDL: the shipped
  // table has exactly ONE CHECK (the relation_type vocabulary this rebuild
  // replaces) and no UNIQUE/GENERATED — anything beyond that is custom.
  const checkCount = (tbl.sql.match(/CHECK/gi) ?? []).length;
  if (checkCount > 1 || /UNIQUE|GENERATED/i.test(tbl.sql)) {
    console.error(
      'ontology_relations vocabulary migration skipped: custom constraint DDL present — legacy CHECK stays in place (new relation types are rejected on this DB).',
    );
    return;
  }

  // Column-generic copy (custom columns and their data are preserved), plus
  // capture/replay of attached indexes/triggers — nothing outside a
  // hardcoded list may be silently dropped.
  const cols = db
    .prepare(`SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info('ontology_relations')`)
    .all() as Array<{ name: string; type: string; nn: number; dflt_value: string | null; pk: number }>;
  const attachedDdl = (
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE tbl_name='ontology_relations' AND type IN ('index','trigger') AND sql IS NOT NULL`,
      )
      .all() as Array<{ sql: string }>
  ).map((r) => r.sql);

  // Mirror-what-exists: reproduce the shipped FK clauses only when the
  // legacy table actually declared them. A hand-made no-FK table must not
  // gain constraints its (possibly dangling) rows never satisfied.
  const hadShippedFk = (col: string): boolean =>
    fks.some((fk) => fk.table === 'facts' && fk.from === col);

  const rebuild = db.transaction(() => {
    const defs = cols.map((c) => {
      const base = `${c.name} ${c.type}${c.pk ? ' PRIMARY KEY' : ''}${c.nn ? ' NOT NULL' : ''}${defaultClause(c.dflt_value)}`;
      if (c.name === 'relation_type') return `${base} CHECK(${RELATION_TYPE_CHECK_SQL})`;
      if ((c.name === 'source_fact_id' || c.name === 'target_fact_id') && hadShippedFk(c.name)) {
        return `${base} REFERENCES facts(id)`;
      }
      return base;
    });
    const names = cols.map((c) => c.name).join(', ');
    db.exec(`CREATE TABLE ontology_relations_vocab_rebuild (${defs.join(', ')})`);
    db.exec(`INSERT INTO ontology_relations_vocab_rebuild (${names}) SELECT ${names} FROM ontology_relations`);
    db.exec(`DROP TABLE ontology_relations`);
    db.exec(`ALTER TABLE ontology_relations_vocab_rebuild RENAME TO ontology_relations`);
    for (const ddl of attachedDdl) db.exec(ddl);
    // Standard indexes may not exist yet on very old DBs (created later in
    // init on the fresh path) — ensure them regardless of the capture.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON ontology_relations(source_fact_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON ontology_relations(target_fact_id)`);
  });
  try {
    withForeignKeysOff(db, () => rebuild.immediate());
  } catch (error) {
    // A failed migration must never brick startup: the transaction rolled
    // back, the legacy table (old CHECK) stays — new relation types are
    // rejected on this DB until repaired, which detection treats as
    // non-fatal per-probe skips.
    console.error('ontology_relations vocabulary migration failed — keeping legacy table:', error);
    return;
  }
  console.error('Migrated ontology_relations: vocabulary extended (DEPENDS_ON, DERIVED_FROM).');
  // Observability, not enforcement: dangling relation rows (facts hard-deleted
  // out from under an edge) predate this rebuild and are copied verbatim —
  // surface the count so they can be repaired instead of silently vanishing
  // from JOIN-based graph queries.
  try {
    const dangling = db.pragma(`foreign_key_check('ontology_relations')`) as unknown[];
    if (dangling.length > 0) {
      console.error(
        `ontology_relations: ${dangling.length} dangling relation rows reference missing facts (pre-existing; see PRAGMA foreign_key_check).`,
      );
    }
  } catch {
    /* pragma unavailable on very old SQLite builds */
  }
}

export function migrateFactsCategoryVocabulary(db: Database.Database): void {
  const tbl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'`)
    .get() as { sql: string } | undefined;
  if (!tbl?.sql) return;
  if (/CHECK\s*\(\s*category\s+IN/i.test(tbl.sql)) return; // already enforced

  // Fail-safe for hand-modified DBs: a pragma-based column rebuild cannot
  // reproduce arbitrary table-level or custom column constraints (FKs,
  // UNIQUE, custom CHECKs, generated columns). No shipped facts schema ever
  // carried any of these — this guard runs only when the vocabulary CHECK is
  // absent, so ANY constraint keyword here is custom DDL. Leaving the
  // vocabulary write-path-enforced-only beats silently dropping someone's
  // data-integrity constraints.
  if (/FOREIGN\s+KEY|REFERENCES|UNIQUE|CHECK|GENERATED/i.test(tbl.sql)) {
    console.error(
      'facts.category migration skipped: custom constraint DDL on facts — vocabulary stays write-path-enforced only.',
    );
    return;
  }

  // Everything hanging off the table (indexes incl. user-added ones,
  // triggers) is dropped with it — capture the DDL now and replay after the
  // rename. A hardcoded recreate list would silently drop custom artifacts.
  const attachedDdl = (
    db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE tbl_name='facts' AND type IN ('index','trigger') AND sql IS NOT NULL`,
      )
      .all() as Array<{ sql: string }>
  ).map((r) => r.sql);

  const cols = db
    // NOTNULL is an SQLite keyword (IS NOTNULL), so the pragma column must be
    // re-aliased to a neutral name.
    .prepare(`SELECT name, type, "notnull" AS nn, dflt_value, pk FROM pragma_table_info('facts')`)
    .all() as Array<{ name: string; type: string; nn: number; dflt_value: string | null; pk: number }>;

  const rebuild = db.transaction(() => {
    // 1) Normalize legacy rows first — the copy below must not violate the
    //    new constraint. DISTINCT keeps this to a handful of UPDATEs.
    const distinct = db.prepare(`SELECT DISTINCT category FROM facts`).all() as Array<{
      category: string | null;
    }>;
    const update = db.prepare(`UPDATE facts SET category = ? WHERE category IS ?`);
    for (const { category } of distinct) {
      const normalized = normalizeFactCategory(category);
      if (normalized !== category) update.run(normalized, category);
    }

    // 2) Rebuild with NOT NULL + CHECK, copying every existing column.
    const defs = cols.map((c) => {
      const notNull = c.name === 'category' ? ' NOT NULL' : c.nn ? ' NOT NULL' : '';
      const pk = c.pk ? ' PRIMARY KEY' : '';
      return `${c.name} ${c.type}${pk}${notNull}${defaultClause(c.dflt_value)}`;
    });
    const names = cols.map((c) => c.name).join(', ');
    db.exec(`CREATE TABLE facts_vocab_rebuild (${defs.join(', ')}, CHECK (${FACT_CATEGORY_CHECK_SQL}))`);
    db.exec(`INSERT INTO facts_vocab_rebuild (${names}) SELECT ${names} FROM facts`);
    db.exec(`DROP TABLE facts`);
    db.exec(`ALTER TABLE facts_vocab_rebuild RENAME TO facts`);

    // 3) Replay every captured index/trigger DDL (standard indexes were
    //    created earlier in this same init, so they are in the capture too).
    for (const ddl of attachedDdl) db.exec(ddl);
  });
  // facts is a referenced parent (fact_revisions, ontology_relations) — the
  // DROP inside the rebuild needs FK enforcement suspended.
  try {
    withForeignKeysOff(db, () => rebuild.immediate());
  } catch (error) {
    // Never brick startup on a migration: the transaction rolled back, the
    // legacy table stays, and the vocabulary remains write-path-enforced
    // only on this DB until repaired.
    console.error('facts.category vocabulary migration failed — keeping legacy table:', error);
    return;
  }
  console.error('Migrated facts.category: vocabulary normalized, CHECK constraint added.');
}

export function initDatabase(): Database.Database {
  const dbPath = getDbPath();

  // Ensure directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // Referential integrity is a pinned invariant, not a driver default:
  // better-sqlite3 currently ships with foreign_keys ON, but the graph
  // (facts ↔ fact_revisions/ontology_relations) and the rebuild migrations
  // depend on it — enable explicitly so a driver-default change can never
  // silently disable enforcement.
  db.pragma('foreign_keys = ON');
  // Required so the exchanges_fts AFTER DELETE trigger fires when an exchange is
  // re-indexed via `INSERT OR REPLACE` (the REPLACE-induced delete does NOT fire
  // delete triggers unless recursive_triggers is on — verified: without it a
  // re-indexed exchange leaves a stale FTS row). Keeps the external-content FTS
  // index consistent with the source table on every write path.
  db.pragma('recursive_triggers = ON');

  // Create exchanges table
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      embedding BLOB,
      last_indexed INTEGER,
      parent_uuid TEXT,
      is_sidechain BOOLEAN DEFAULT 0,
      session_id TEXT,
      cwd TEXT,
      git_branch TEXT,
      claude_version TEXT,
      thinking_level TEXT,
      thinking_disabled BOOLEAN,
      thinking_triggers TEXT,
      coding_agent TEXT DEFAULT 'claude-code'
    )
  `);

  // Create tool_calls table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      exchange_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result TEXT,
      is_error BOOLEAN DEFAULT 0,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (exchange_id) REFERENCES exchanges(id)
    )
  `);

  // Create vector search index.
  //
  // dtype: int8 quantized vectors use 4× less storage and ~2× faster KNN with
  // no recall@10 loss (measured on a 50K-exchange benchmark: 73.6MB→18.4MB,
  // p50 19.1ms→8.7ms, recall identical). Fresh DBs are created int8; existing
  // float32 DBs keep float32 until scripts/migrate-vec-int8.mjs converts them.
  // The authoritative dtype is the ACTUAL schema in sqlite_master (getVecDtype)
  // — float32 and int8 blobs are not interchangeable, and deriving from the
  // real schema (not a flag) makes flag/schema divergence impossible.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
      id TEXT PRIMARY KEY,
      embedding int8[384]
    )
  `);

  // Run migrations first
  migrateSchema(db);

  // Create indexes (after migrations ensure columns exist)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_timestamp ON exchanges(timestamp DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_id ON exchanges(session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project ON exchanges(project)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sidechain ON exchanges(is_sidechain)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_path ON exchanges(archive_path)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_git_branch ON exchanges(git_branch)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_coding_agent ON exchanges(coding_agent)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_calls(tool_name)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tool_exchange ON tool_calls(exchange_id)
  `);

  // === Full-text search index (FTS5) for exchanges ===
  // External-content FTS5: stores only the inverted index (not a second copy of
  // the text), reading the source columns from `exchanges` via rowid. Replaces
  // the O(rows) `LIKE '%q%'` full scan (measured p50 3.2s / p95 14.5s on 239K
  // rows) with a BM25-ranked index lookup. Triggers keep it in sync on every
  // insert/update/delete (INSERT OR REPLACE fires AFTER DELETE then AFTER INSERT,
  // so re-indexed exchanges stay consistent). The one-time backfill of existing
  // rows is done by scripts/backfill-fts.mjs (`'rebuild'`), NOT here — keeping
  // initDatabase() cheap since it runs on every MCP/hook invocation.
  //
  // detail=column: token positions are not stored — search.ts only issues
  // per-token (quoted single-term) matches, never phrase/NEAR queries, and
  // BM25 ranking still works at column granularity. On the production DB the
  // default detail=full index cost 2.9GB vs ~1.3GB for detail=column.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
      user_message, assistant_message,
      content='exchanges', content_rowid='rowid',
      tokenize='porter unicode61',
      detail=column
    )
  `);
  // Readiness flag (deterministic, not probed). For an external-content FTS5
  // table the index is EMPTY right after creation even though the content table
  // (exchanges) already has rows — so `SELECT rowid FROM exchanges_fts` would
  // falsely look "ready". Track readiness explicitly instead. We (re)initialize
  // the flag whenever it is MISSING — not only when the FTS table is newly
  // created — so a DB from an earlier build (FTS table present, flag absent) or
  // a crash between CREATE and the flag write is still handled correctly rather
  // than permanently falling back to LIKE. When the flag is absent we cannot
  // prove the index is populated, so be conservative: an empty exchanges set is
  // ready (triggers index every future insert); a non-empty set stays NOT ready
  // until scripts/backfill-fts.mjs rebuilds the index and sets the flag.
  db.exec(`CREATE TABLE IF NOT EXISTS fts_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const hasFtsFlag = db.prepare(`SELECT 1 FROM fts_meta WHERE key='exchanges_fts_built'`).get() !== undefined;
  if (!hasFtsFlag) {
    const exchangesHaveRows = db.prepare('SELECT 1 FROM exchanges LIMIT 1').get() !== undefined;
    // INSERT OR IGNORE (not plain INSERT): initDatabase() runs in every MCP/hook
    // process, so two callers can both observe a missing flag and race to insert.
    // OR IGNORE makes the first writer win and the rest no-op instead of crashing
    // on SQLITE_CONSTRAINT_PRIMARYKEY. The value is deterministic for the DB state,
    // so a lost race is harmless.
    db.prepare(`INSERT OR IGNORE INTO fts_meta(key, value) VALUES('exchanges_fts_built', ?)`)
      .run(exchangesHaveRows ? '0' : '1');
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ai AFTER INSERT ON exchanges BEGIN
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_ad AFTER DELETE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS exchanges_fts_au AFTER UPDATE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_message, assistant_message)
      VALUES('delete', old.rowid, old.user_message, old.assistant_message);
      INSERT INTO exchanges_fts(rowid, user_message, assistant_message)
      VALUES (new.rowid, new.user_message, new.assistant_message);
    END
  `);

  // === Facts Schema ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      category TEXT NOT NULL CHECK (${FACT_CATEGORY_CHECK_SQL}),
      scope_type TEXT NOT NULL DEFAULT 'project',
      scope_project TEXT,
      source_exchange_ids TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consolidated_count INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope_type, scope_project)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(is_active)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_revisions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL,
      previous_fact TEXT NOT NULL,
      new_fact TEXT NOT NULL,
      reason TEXT,
      source_exchange_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (fact_id) REFERENCES facts(id)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_revisions_fact ON fact_revisions(fact_id)
  `);

  // vec_facts virtual table (sqlite-vec)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);

  // Korean-text vector index: facts are embedded twice (fact / fact_kr) because
  // multilingual models match same-language pairs far better than cross-language.
  // Queries search both tables and take the best score per fact id.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts_kr USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);

  // Category embedding index: lets the ontology classifier retrieve the top-K
  // most-similar existing categories for a fact instead of dumping ALL
  // categories into the LLM prompt (measured 1,612 categories ≈ 95K tokens per
  // classify call). Embeddings (category name + description, 'passage' mode) are
  // written on createCategory; existing rows are backfilled by
  // scripts/backfill-category-embeddings.mjs.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_categories USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[384]
    )
  `);

  // === Ontology Schema ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_domains (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_categories (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES ontology_domains(id),
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Idempotent column addition for facts.ontology_category_id
  const factColumns = db.prepare(
    `SELECT name FROM pragma_table_info('facts')`
  ).all() as Array<{ name: string }>;
  const factColumnNames = new Set(factColumns.map((c) => c.name));
  if (!factColumnNames.has('ontology_category_id')) {
    db.prepare('ALTER TABLE facts ADD COLUMN ontology_category_id TEXT').run();
  }
  if (!factColumnNames.has('fact_kr')) {
    db.prepare('ALTER TABLE facts ADD COLUMN fact_kr TEXT').run();
  }
  if (!factColumnNames.has('coding_agent')) {
    db.prepare("ALTER TABLE facts ADD COLUMN coding_agent TEXT DEFAULT 'claude-code'").run();
  }
  // Embedding model version (1 = all-MiniLM-L6-v2, 2 = multilingual L12-v2).
  // The re-embed worker upgrades rows where version < current.
  if (!factColumnNames.has('embedding_version')) {
    db.prepare('ALTER TABLE facts ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 1').run();
  }
  // Ontology classification attempt ledger: without it, a fact whose
  // classification permanently fails (unparseable LLM output, oversized
  // content) stays NULL forever and is re-selected by every backfill run —
  // one wasted LLM call per run per stuck fact. After MAX attempts the
  // classifier persists the General/Misc fallback so the fact leaves the
  // queue for good (it stays fully searchable — ontology is an overlay).
  if (!factColumnNames.has('ontology_attempts')) {
    db.prepare('ALTER TABLE facts ADD COLUMN ontology_attempts INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!factColumnNames.has('ontology_last_attempt_at')) {
    db.prepare('ALTER TABLE facts ADD COLUMN ontology_last_attempt_at TEXT').run();
  }
  // Extraction confidence (0..1). Previously consumed only as the extraction
  // gate and discarded; persisting it gives each fact a reliability signal
  // alongside consolidated_count. NULL on pre-migration rows (unknown).
  if (!factColumnNames.has('confidence')) {
    db.prepare('ALTER TABLE facts ADD COLUMN confidence REAL').run();
  }
  const exchangeColumns = db.prepare(
    `SELECT name FROM pragma_table_info('exchanges')`
  ).all() as Array<{ name: string }>;
  if (!exchangeColumns.some((c) => c.name === 'embedding_version')) {
    db.prepare('ALTER TABLE exchanges ADD COLUMN embedding_version INTEGER NOT NULL DEFAULT 0').run();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ontology_relations (
      id TEXT PRIMARY KEY,
      source_fact_id TEXT NOT NULL REFERENCES facts(id),
      relation_type TEXT NOT NULL CHECK(${RELATION_TYPE_CHECK_SQL}),
      target_fact_id TEXT NOT NULL REFERENCES facts(id),
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON ontology_relations(source_fact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON ontology_relations(target_fact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_ontology ON facts(ontology_category_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_coding_agent ON facts(coding_agent)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ontology_categories_domain ON ontology_categories(domain_id)`);

  // Tracks which sessions have been through fact extraction (SessionEnd hook
  // or the backfill worker). Makes extraction idempotent and lets the backfill
  // find unprocessed sessions across ALL projects.
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_log (
      session_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL,
      extracted INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Vocabulary migrations (one-time rebuilds on legacy DBs; fresh DBs already
  // carry both CHECKs from CREATE TABLE above). Run after the ALTER block so
  // the generic column copy sees every column.
  migrateRelationTypeVocabulary(db);
  migrateFactsCategoryVocabulary(db);

  // Self-heal slug-format scope_project rows (cheap probe; no-op when clean).
  // Keeps the canonical path format intact even when other devices sync in
  // facts written by older code.
  autoHealScopeProjects(db);

  return db;
}

export function insertExchange(
  db: Database.Database,
  exchange: ConversationExchange,
  embedding: number[],
  _toolNames?: string[]
): void {
  const now = Date.now();

  // ONE transaction for exchanges + vec + tool_calls, with the dtype read
  // INSIDE it. Two invariants depend on this:
  //  1. No partial state: an exchanges row without its vector must never be
  //     observable (the int8 migration snapshots/verifies by comparing the
  //     two tables — a row committed between separate transactions would be
  //     missed by its delta pass and lose its vector permanently).
  //  2. dtype consistency: the migration swaps the vec table dtype under
  //     BEGIN IMMEDIATE; reading dtype inside our own write transaction
  //     serializes against the swap, so we can never quantize for a schema
  //     that changed between the read and the write.
  const insertAll = db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end, last_indexed,
       parent_uuid, is_sidechain, session_id, cwd, git_branch, claude_version,
       thinking_level, thinking_disabled, thinking_triggers, coding_agent, embedding_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      exchange.id,
      exchange.project,
      exchange.timestamp,
      exchange.userMessage,
      exchange.assistantMessage,
      exchange.archivePath,
      exchange.lineStart,
      exchange.lineEnd,
      now,
      exchange.parentUuid || null,
      exchange.isSidechain ? 1 : 0,
      exchange.sessionId || null,
      exchange.cwd || null,
      exchange.gitBranch || null,
      exchange.claudeVersion || null,
      exchange.thinkingLevel || null,
      exchange.thinkingDisabled ? 1 : 0,
      exchange.thinkingTriggers || null,
      exchange.codingAgent || 'claude-code',
      // The embedding parameter was just generated with the current model, so
      // stamp the current version — search filters on it and the re-embed
      // worker must not redo freshly indexed rows.
      EMBEDDING_VERSION
    );

    // Vector upsert: DELETE+INSERT since virtual tables don't support REPLACE.
    const vecDtype = getVecDtype(db);
    db.prepare('DELETE FROM vec_exchanges WHERE id = ?').run(exchange.id);
    db.prepare(`INSERT INTO vec_exchanges (id, embedding) VALUES (?, ${vecParamSql(vecDtype)})`)
      .run(exchange.id, embeddingToVecBlob(embedding, vecDtype));

    if (exchange.toolCalls && exchange.toolCalls.length > 0) {
      const toolStmt = db.prepare(`
        INSERT OR REPLACE INTO tool_calls
        (id, exchange_id, tool_name, tool_input, tool_result, is_error, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const toolCall of exchange.toolCalls) {
        toolStmt.run(
          toolCall.id,
          toolCall.exchangeId,
          toolCall.toolName,
          toolCall.toolInput ? JSON.stringify(toolCall.toolInput) : null,
          toolCall.toolResult || null,
          toolCall.isError ? 1 : 0,
          toolCall.timestamp
        );
      }
    }
  });
  // .immediate(): acquire the write lock at BEGIN, before any read — a
  // deferred BEGIN would let the int8 migration swap commit between our reads
  // and the lock upgrade (stale-dtype write / SQLITE_BUSY_SNAPSHOT).
  insertAll.immediate();
}

export function getAllExchanges(db: Database.Database): Array<{ id: string; archivePath: string }> {
  const stmt = db.prepare(`SELECT id, archive_path as archivePath FROM exchanges`);
  return stmt.all() as Array<{ id: string; archivePath: string }>;
}

export function getFileLastIndexed(db: Database.Database, archivePath: string): number | null {
  const stmt = db.prepare(`
    SELECT MAX(last_indexed) as lastIndexed
    FROM exchanges
    WHERE archive_path = ?
  `);
  const row = stmt.get(archivePath) as { lastIndexed: number | null };
  return row.lastIndexed;
}

export function deleteExchange(db: Database.Database, id: string): void {
  // Delete from vector table
  db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`).run(id);

  // Delete from main table
  db.prepare(`DELETE FROM exchanges WHERE id = ?`).run(id);
}
