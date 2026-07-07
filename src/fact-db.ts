import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Fact, FactRevision } from './types.js';
import { canonicalizeProject } from './project-canon.js';
import { EMBEDDING_VERSION } from './embeddings.js';
import { normalizeFactCategory } from './fact-category.js';

interface InsertFactParams {
  fact: string;
  category: string;
  scope_type: string;
  scope_project: string | null;
  source_exchange_ids: string[];
  embedding: number[] | null;  // number[] to match generateEmbedding() return type
  coding_agent?: string;       // e.g., 'claude-code', 'codex', 'opencode'
  fact_kr?: string | null;     // Korean translation — enables same-language matching for Korean queries
  embedding_kr?: number[] | null;
}

interface UpdateFactParams {
  fact?: string;
  embedding?: number[] | null;
  consolidated_count_increment?: boolean;
}

interface InsertRevisionParams {
  fact_id: string;
  previous_fact: string;
  new_fact: string;
  reason: string | null;
  source_exchange_id: string | null;
}

export function insertFact(db: Database.Database, params: InsertFactParams): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const scopeProject = params.scope_project
    ? canonicalizeProject(db, params.scope_project)
    : params.scope_project;

  db.prepare(`
    INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids, embedding, created_at, updated_at, consolidated_count, is_active, coding_agent, fact_kr, embedding_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
  `).run(
    id,
    params.fact,
    // Chokepoint normalization: every caller (extractor, backfill, sync)
    // funnels through here, so out-of-vocabulary LLM output is mapped to the
    // controlled vocabulary instead of tripping the facts.category CHECK.
    normalizeFactCategory(params.category),
    params.scope_type,
    scopeProject,
    JSON.stringify(params.source_exchange_ids),
    params.embedding ? Buffer.from(new Float32Array(params.embedding).buffer) : null,
    now,
    now,
    params.coding_agent || 'claude-code',
    params.fact_kr ?? null,
    EMBEDDING_VERSION,
  );

  // Insert into vector index (atomic DELETE+INSERT via transaction)
  if (params.embedding) {
    const upsertVec = db.transaction((vecId: string, buf: Buffer) => {
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(vecId);
      db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(vecId, buf);
    });
    upsertVec(id, Buffer.from(new Float32Array(params.embedding).buffer));
  }

  // Korean-text vector index (same-language matching for Korean queries)
  if (params.embedding_kr) {
    const upsertVecKr = db.transaction((vecId: string, buf: Buffer) => {
      db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(vecId);
      db.prepare('INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ?)').run(vecId, buf);
    });
    upsertVecKr(id, Buffer.from(new Float32Array(params.embedding_kr).buffer));
  }

  return id;
}

export function getActiveFacts(db: Database.Database): Fact[] {
  return (db.prepare('SELECT * FROM facts WHERE is_active = 1 ORDER BY consolidated_count DESC')
    .all() as Record<string, unknown>[])
    .map(rowToFact);
}

export function getFactsByProject(db: Database.Database, project: string): Fact[] {
  const canon = canonicalizeProject(db, project);
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
  `).all(canon) as Record<string, unknown>[]).map(rowToFact);
}

export function updateFact(db: Database.Database, id: string, params: UpdateFactParams): void {
  const now = new Date().toISOString();
  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (params.fact !== undefined) {
    updates.push('fact = ?');
    values.push(params.fact);
  }
  if (params.embedding !== undefined) {
    updates.push('embedding = ?');
    values.push(params.embedding ? Buffer.from(new Float32Array(params.embedding).buffer) : null);
  }
  if (params.consolidated_count_increment) {
    updates.push('consolidated_count = consolidated_count + 1');
  }

  values.push(id);
  db.prepare(`UPDATE facts SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // Update vector index (atomic DELETE+INSERT via transaction)
  if (params.embedding) {
    const upsertVec = db.transaction((vecId: string, buf: Buffer) => {
      db.prepare('DELETE FROM vec_facts WHERE id = ?').run(vecId);
      db.prepare('INSERT INTO vec_facts (id, embedding) VALUES (?, ?)').run(vecId, buf);
    });
    upsertVec(id, Buffer.from(new Float32Array(params.embedding).buffer));
  }
}

export function deactivateFact(db: Database.Database, id: string): void {
  db.prepare('UPDATE facts SET is_active = 0, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  );
  // Deactivated facts must not occupy vector index slots
  db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
  db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
}

export function deleteFact(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM vec_facts WHERE id = ?').run(id);
  db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(id);
  db.prepare('DELETE FROM fact_revisions WHERE fact_id = ?').run(id);
  db.prepare('DELETE FROM facts WHERE id = ?').run(id);
}

export function insertRevision(db: Database.Database, params: InsertRevisionParams): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO fact_revisions (id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.fact_id, params.previous_fact, params.new_fact, params.reason, params.source_exchange_id, new Date().toISOString());
  return id;
}

export function getRevisions(db: Database.Database, factId: string): FactRevision[] {
  return db.prepare(
    'SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY created_at DESC'
  ).all(factId) as FactRevision[];
}

export function searchSimilarFacts(
  db: Database.Database,
  embedding: number[],
  project: string | null,
  limit: number = 5,
  threshold: number = 0.85,
): Array<{ fact: Fact; distance: number }> {
  const canonProject = project ? canonicalizeProject(db, project) : project;
  const buf = Buffer.from(new Float32Array(embedding).buffer);

  // Search both language indexes: the query language is unknown, and
  // multilingual models score same-language pairs far higher than
  // cross-language pairs. Keep the best (smallest) distance per fact id.
  //
  // Overfetch well beyond `limit`: the scope filter below runs AFTER the
  // vector lookup, and in a multi-project DB the global top-N is easily
  // dominated by other projects' facts — fetching only limit*2 starves the
  // requested scope of candidates entirely.
  const candidateFetch = Math.max(limit * 2, 50);
  const fetch = (table: string) => {
    try {
      return db.prepare(`
        SELECT id, distance FROM ${table}
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(buf, candidateFetch) as Array<{ id: string; distance: number }>;
    } catch {
      return []; // table may not exist on very old DBs
    }
  };

  const best = new Map<string, number>();
  for (const vr of [...fetch('vec_facts'), ...fetch('vec_facts_kr')]) {
    const cur = best.get(vr.id);
    if (cur === undefined || vr.distance < cur) best.set(vr.id, vr.distance);
  }
  const merged = [...best.entries()]
    .map(([id, distance]) => ({ id, distance }))
    .sort((a, b) => a.distance - b.distance);

  const results: Array<{ fact: Fact; distance: number }> = [];
  for (const vr of merged) {
    // L2 distance -> cosine similarity approximation
    const similarity = 1 - (vr.distance * vr.distance) / 2;
    if (similarity < threshold) continue;

    // embedding_version filter: during a model migration the vector tables
    // can still hold old-model rows; comparing them against a current-model
    // query embedding silently misranks. Skip until the worker upgrades them.
    const row = db.prepare(
      'SELECT * FROM facts WHERE id = ? AND is_active = 1 AND embedding_version = ?'
    ).get(vr.id, EMBEDDING_VERSION) as Record<string, unknown> | undefined;
    if (!row) continue;

    const fact = rowToFact(row);
    // Scope filter: same project or global only
    if (canonProject && fact.scope_type === 'project' && fact.scope_project !== canonProject) continue;

    results.push({ fact, distance: vr.distance });
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Get top facts using a relevance score that combines:
 * - Confirmation count (consolidated_count) — how established is this fact
 * - Recency (updated_at) — how recent is this fact
 * - Scope priority — project-specific facts rank higher than global for that project
 *
 * Score = (log2(consolidated_count + 1) * 3) + recency_bonus + scope_bonus
 *   recency_bonus: 5 if updated in last 7 days, 3 if last 30 days, 1 if last 90 days, 0 otherwise
 *   scope_bonus: 2 for project-scoped facts, 0 for global
 *
 * Project facts are guaranteed up to half of the result slots: heavily-confirmed
 * global facts otherwise outscore any newly extracted project fact (count=1)
 * forever, so project context would never surface in injection.
 */
export function getTopFacts(db: Database.Database, rawProject: string, limit: number = 10): Fact[] {
  const project = canonicalizeProject(db, rawProject);
  const now = new Date();
  const d7 = new Date(now.getTime() - 7 * 86400000).toISOString();
  const d30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const d90 = new Date(now.getTime() - 90 * 86400000).toISOString();

  const scoreExpr = `
      (
        CASE WHEN consolidated_count > 0 THEN (3.0 * (1.0 + LOG(consolidated_count + 1) / LOG(2))) ELSE 3.0 END
        + CASE WHEN updated_at >= ? THEN 5 WHEN updated_at >= ? THEN 3 WHEN updated_at >= ? THEN 1 ELSE 0 END
        + CASE WHEN scope_type = 'project' AND scope_project = ? THEN 2 ELSE 0 END
      ) as relevance_score`;

  type ScoredRow = Record<string, unknown> & { relevance_score: number };

  const projectRows = db.prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE is_active = 1 AND scope_type = 'project' AND scope_project = ?
    ORDER BY relevance_score DESC
    LIMIT ?
  `).all(d7, d30, d90, project, project, limit) as ScoredRow[];

  const globalRows = db.prepare(`
    SELECT *, ${scoreExpr}
    FROM facts
    WHERE is_active = 1 AND scope_type = 'global'
    ORDER BY relevance_score DESC
    LIMIT ?
  `).all(d7, d30, d90, project, limit) as ScoredRow[];

  const reserved = Math.ceil(limit / 2);
  const guaranteed = projectRows.slice(0, reserved);
  const rest = [...projectRows.slice(reserved), ...globalRows]
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, Math.max(0, limit - guaranteed.length));

  return [...guaranteed, ...rest]
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .map(rowToFact);
}

/**
 * Legacy: get facts by pure confirmation count (for backward compatibility).
 */
export function getTopFactsByCount(db: Database.Database, project: string, limit: number = 10): Fact[] {
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY consolidated_count DESC
    LIMIT ?
  `).all(canonicalizeProject(db, project), limit) as Record<string, unknown>[]).map(rowToFact);
}

export function getNewFactsSince(db: Database.Database, project: string, since: string): Fact[] {
  return (db.prepare(`
    SELECT * FROM facts
    WHERE is_active = 1
      AND created_at > ?
      AND ((scope_type = 'project' AND scope_project = ?) OR scope_type = 'global')
    ORDER BY created_at ASC
  `).all(since, canonicalizeProject(db, project)) as Record<string, unknown>[]).map(rowToFact);
}

/**
 * Search facts across ALL projects (no scope filter).
 * Used for cross-project knowledge transfer.
 */
export function searchAllFacts(
  db: Database.Database,
  embedding: number[],
  limit: number = 10,
  threshold: number = 0.6,
): Array<{ fact: Fact; distance: number }> {
  const vecResults = db.prepare(`
    SELECT id, distance
    FROM vec_facts
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(Buffer.from(new Float32Array(embedding).buffer), limit * 2) as Array<{ id: string; distance: number }>;

  const results: Array<{ fact: Fact; distance: number }> = [];
  for (const vr of vecResults) {
    const similarity = 1 - (vr.distance * vr.distance) / 2;
    if (similarity < threshold) continue;

    const row = db.prepare('SELECT * FROM facts WHERE id = ? AND is_active = 1').get(vr.id) as Record<string, unknown> | undefined;
    if (!row) continue;

    results.push({ fact: rowToFact(row), distance: vr.distance });
    if (results.length >= limit) break;
  }

  return results;
}

function rowToFact(row: Record<string, unknown>): Fact {
  const embeddingRaw = row['embedding'];
  let embedding: Float32Array | null = null;
  if (embeddingRaw instanceof Buffer) {
    embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
  } else if (embeddingRaw instanceof Uint8Array) {
    embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
  }

  return {
    id: row['id'] as string,
    fact: row['fact'] as string,
    category: row['category'] as Fact['category'],
    scope_type: row['scope_type'] as Fact['scope_type'],
    scope_project: (row['scope_project'] as string | null) ?? null,
    source_exchange_ids: row['source_exchange_ids']
      ? JSON.parse(row['source_exchange_ids'] as string)
      : [],
    embedding,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    consolidated_count: row['consolidated_count'] as number,
    is_active: Boolean(row['is_active']),
    ontology_category_id: (row['ontology_category_id'] as string | null) ?? null,
    coding_agent: (row['coding_agent'] as string | null) ?? null,
  };
}
