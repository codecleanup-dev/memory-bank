import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type {
  OntologyDomain,
  OntologyCategory,
  OntologyRelation,
  RelationType,
  DomainTree,
  Fact,
} from './types.js';

// === Domain CRUD ===

export function createDomain(
  db: Database.Database,
  name: string,
  description?: string,
): OntologyDomain {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, name, description ?? null, now);
  return { id, name, description: description ?? null, created_at: now };
}

export function listDomains(db: Database.Database): OntologyDomain[] {
  return (db.prepare(`SELECT * FROM ontology_domains ORDER BY name`).all() as OntologyDomain[]);
}

export function getDomain(db: Database.Database, id: string): OntologyDomain | null {
  return (
    (db.prepare(`SELECT * FROM ontology_domains WHERE id = ?`).get(id) as OntologyDomain | undefined) ?? null
  );
}

export function getDomainByName(db: Database.Database, name: string): OntologyDomain | null {
  return (
    (db
      .prepare(`SELECT * FROM ontology_domains WHERE name = ? COLLATE NOCASE`)
      .get(name) as OntologyDomain | undefined) ?? null
  );
}

// === Category CRUD ===

export function createCategory(
  db: Database.Database,
  domainId: string,
  name: string,
  description?: string,
): OntologyCategory {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, domainId, name, description ?? null, now);
  return { id, domain_id: domainId, name, description: description ?? null, created_at: now };
}

export function listCategories(
  db: Database.Database,
  domainId?: string,
): OntologyCategory[] {
  if (domainId) {
    return (db
      .prepare(`SELECT * FROM ontology_categories WHERE domain_id = ? ORDER BY name`)
      .all(domainId) as OntologyCategory[]);
  }
  return (db.prepare(`SELECT * FROM ontology_categories ORDER BY name`).all() as OntologyCategory[]);
}

export function getCategoryByName(
  db: Database.Database,
  name: string,
  domainId?: string,
): OntologyCategory | null {
  if (domainId) {
    return (
      (db
        .prepare(
          `SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE AND domain_id = ?`,
        )
        .get(name, domainId) as OntologyCategory | undefined) ?? null
    );
  }
  return (
    (db
      .prepare(`SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE`)
      .get(name) as OntologyCategory | undefined) ?? null
  );
}

// === Category embeddings (candidate retrieval for the classifier) ===

/**
 * Store/replace a category's embedding in vec_categories (atomic DELETE+INSERT,
 * since vec0 virtual tables don't support REPLACE). The embedding is generated
 * by the caller from "name: description" in 'passage' mode.
 */
export function upsertCategoryEmbedding(
  db: Database.Database,
  categoryId: string,
  embedding: number[],
): void {
  const buf = Buffer.from(new Float32Array(embedding).buffer);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
    db.prepare('INSERT INTO vec_categories (id, embedding) VALUES (?, ?)').run(categoryId, buf);
  });
  tx();
}

export function deleteCategoryEmbedding(db: Database.Database, categoryId: string): void {
  try {
    db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
  } catch { /* table may not exist on very old DBs */ }
}

/**
 * Return the top-K most similar existing categories to a fact embedding, so the
 * classifier can present a short candidate list to the LLM instead of all
 * categories. Each result includes the owning domain name for a compact prompt.
 * Returns [] if the index is empty (caller falls back to the full list).
 */
export function searchSimilarCategories(
  db: Database.Database,
  embedding: number[],
  k: number = 20,
): Array<{ category: OntologyCategory; domainName: string; distance: number }> {
  const buf = Buffer.from(new Float32Array(embedding).buffer);
  let hits: Array<{ id: string; distance: number }>;
  try {
    hits = db.prepare(`
      SELECT id, distance FROM vec_categories
      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    `).all(buf, k) as Array<{ id: string; distance: number }>;
  } catch {
    return []; // index absent → caller uses the full category list
  }

  const results: Array<{ category: OntologyCategory; domainName: string; distance: number }> = [];
  const catStmt = db.prepare('SELECT * FROM ontology_categories WHERE id = ?');
  const domStmt = db.prepare('SELECT name FROM ontology_domains WHERE id = ?');
  for (const h of hits) {
    const category = catStmt.get(h.id) as OntologyCategory | undefined;
    if (!category) continue; // stale vector row (category was merged/deleted)
    const dom = domStmt.get(category.domain_id) as { name: string } | undefined;
    results.push({ category, domainName: dom?.name ?? '?', distance: h.distance });
  }
  return results;
}

// === Fact Classification ===

export function classifyFact(
  db: Database.Database,
  factId: string,
  categoryId: string,
): void {
  db.prepare(
    `UPDATE facts SET ontology_category_id = ?, updated_at = ? WHERE id = ?`,
  ).run(categoryId, new Date().toISOString(), factId);
}

export function getFactsByCategory(db: Database.Database, categoryId: string): Fact[] {
  return (db
    .prepare(
      `SELECT * FROM facts WHERE ontology_category_id = ? AND is_active = 1 ORDER BY consolidated_count DESC`,
    )
    .all(categoryId) as Record<string, unknown>[])
    .map(rowToFact);
}

export function getFactsByDomain(db: Database.Database, domainId: string): Fact[] {
  return (db
    .prepare(
      `SELECT f.* FROM facts f
       JOIN ontology_categories c ON f.ontology_category_id = c.id
       WHERE c.domain_id = ? AND f.is_active = 1
       ORDER BY f.consolidated_count DESC`,
    )
    .all(domainId) as Record<string, unknown>[])
    .map(rowToFact);
}

// === Relation CRUD ===

export function createRelation(
  db: Database.Database,
  sourceFactId: string,
  relationType: RelationType,
  targetFactId: string,
  reasoning?: string,
): OntologyRelation {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceFactId, relationType, targetFactId, reasoning ?? null, now);
  return {
    id,
    source_fact_id: sourceFactId,
    relation_type: relationType,
    target_fact_id: targetFactId,
    reasoning: reasoning ?? null,
    created_at: now,
  };
}

/**
 * Whether ANY relation (either direction) already links the two facts.
 * Both detection channels (similarity + co-extraction) can nominate the same
 * pair across runs — checking first saves the LLM probe and prevents
 * duplicate edges.
 */
export function relationExistsBetween(
  db: Database.Database,
  factIdA: string,
  factIdB: string,
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS one FROM ontology_relations
         WHERE (source_fact_id = ? AND target_fact_id = ?)
            OR (source_fact_id = ? AND target_fact_id = ?)
         LIMIT 1`,
      )
      .get(factIdA, factIdB, factIdB, factIdA) !== undefined
  );
}

/**
 * Get related facts with relevance decay.
 *
 * Each hop reduces relevance by the decay factor:
 * - hop 0 (direct): relevance = 1.0
 * - hop 1: relevance = decay (default 0.6)
 * - hop 2: relevance = decay^2 (default 0.36)
 *
 * Results are sorted by relevance descending.
 * Facts below minRelevance are pruned.
 */
/**
 * @param scopeProject - If provided, only return facts from this project or global scope.
 *                       Prevents cross-project noise in graph traversal.
 *                       Pass null/undefined to allow cross-project traversal (e.g., explore_graph).
 */
export function getRelatedFacts(
  db: Database.Database,
  factId: string,
  hops: number = 1,
  decay: number = 0.6,
  minRelevance: number = 0.2,
  scopeProject?: string | null,
): Array<{ fact: Fact; relation: OntologyRelation; relevance: number; hop: number }> {
  const visited = new Set<string>([factId]);
  const results: Array<{ fact: Fact; relation: OntologyRelation; relevance: number; hop: number }> = [];

  let frontier = [factId];

  for (let hop = 0; hop < hops; hop++) {
    const hopRelevance = Math.pow(decay, hop);
    if (hopRelevance < minRelevance) break; // Prune entire hop if too weak

    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      // Outgoing relations (source → target)
      const outgoing = db
        .prepare(
          `SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.target_fact_id = f.id
           WHERE r.source_fact_id = ? AND f.is_active = 1`,
        )
        .all(currentId) as Array<Record<string, unknown>>;

      for (const row of outgoing) {
        const targetId = row['target_fact_id'] as string;
        if (visited.has(targetId)) continue;

        const relation = rowToRelation(row);
        const fact = rowToFact(row);

        // Scope filter: skip facts from other projects (unless scopeProject is null)
        if (scopeProject && fact.scope_type === 'project' && fact.scope_project !== scopeProject) continue;

        visited.add(targetId);
        nextFrontier.push(targetId);

        // Conflict/retirement edges traverse weaker; every structural edge
        // (SUPPORTS/INFLUENCES/DEPENDS_ON/DERIVED_FROM) traverses fully.
        const typeWeight = (relation.relation_type === 'CONTRADICTS' || relation.relation_type === 'SUPERSEDES') ? 0.7 : 1.0;
        const relevance = hopRelevance * typeWeight;

        if (relevance >= minRelevance) {
          results.push({ fact, relation, relevance, hop: hop + 1 });
        }
      }

      // Incoming relations (target ← source)
      const incoming = db
        .prepare(
          `SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.source_fact_id = f.id
           WHERE r.target_fact_id = ? AND f.is_active = 1`,
        )
        .all(currentId) as Array<Record<string, unknown>>;

      for (const row of incoming) {
        const sourceId = row['source_fact_id'] as string;
        if (visited.has(sourceId)) continue;

        const relation = rowToRelation(row);
        const fact = rowToFact(row);

        // Scope filter: skip facts from other projects
        if (scopeProject && fact.scope_type === 'project' && fact.scope_project !== scopeProject) continue;

        visited.add(sourceId);
        nextFrontier.push(sourceId);

        const typeWeight = (relation.relation_type === 'SUPPORTS' || relation.relation_type === 'INFLUENCES') ? 1.0 : 0.7;
        const relevance = hopRelevance * typeWeight;

        if (relevance >= minRelevance) {
          results.push({ fact, relation, relevance, hop: hop + 1 });
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Sort by relevance descending
  results.sort((a, b) => b.relevance - a.relevance);

  return results;
}

export function getRelationsForFact(
  db: Database.Database,
  factId: string,
): OntologyRelation[] {
  return db
    .prepare(
      `SELECT * FROM ontology_relations
       WHERE source_fact_id = ? OR target_fact_id = ?
       ORDER BY created_at DESC`,
    )
    .all(factId, factId) as OntologyRelation[];
}

// === Ontology Tree ===

export function getOntologyTree(db: Database.Database): DomainTree[] {
  const domains = listDomains(db);
  const tree: DomainTree[] = [];

  for (const domain of domains) {
    const categories = listCategories(db, domain.id);
    const domainEntry: DomainTree = {
      domain,
      categories: [],
    };

    for (const category of categories) {
      const facts = getFactsByCategory(db, category.id);
      domainEntry.categories.push({ category, facts });
    }

    tree.push(domainEntry);
  }

  return tree;
}

// === Row Mappers ===

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
  };
}

function rowToRelation(row: Record<string, unknown>): OntologyRelation {
  return {
    id: (row['rel_id'] ?? row['id']) as string,
    source_fact_id: row['source_fact_id'] as string,
    relation_type: row['relation_type'] as RelationType,
    target_fact_id: row['target_fact_id'] as string,
    reasoning: (row['reasoning'] as string | null) ?? null,
    created_at: (row['rel_created_at'] ?? row['created_at']) as string,
  };
}
