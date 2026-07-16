import { randomUUID } from 'crypto';
import { SYMMETRIC_RELATION_TYPES } from './types.js';
// === Domain CRUD ===
export function createDomain(db, name, description) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)`).run(id, name, description ?? null, now);
    return { id, name, description: description ?? null, created_at: now };
}
export function listDomains(db) {
    return db.prepare(`SELECT * FROM ontology_domains ORDER BY name`).all();
}
export function getDomain(db, id) {
    return (db.prepare(`SELECT * FROM ontology_domains WHERE id = ?`).get(id) ?? null);
}
export function getDomainByName(db, name) {
    return (db
        .prepare(`SELECT * FROM ontology_domains WHERE name = ? COLLATE NOCASE`)
        .get(name) ?? null);
}
// === Category CRUD ===
export function createCategory(db, domainId, name, description) {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, domainId, name, description ?? null, now);
    return { id, domain_id: domainId, name, description: description ?? null, created_at: now };
}
export function listCategories(db, domainId) {
    if (domainId) {
        return db
            .prepare(`SELECT * FROM ontology_categories WHERE domain_id = ? ORDER BY name`)
            .all(domainId);
    }
    return db.prepare(`SELECT * FROM ontology_categories ORDER BY name`).all();
}
export function getCategoryByName(db, name, domainId) {
    if (domainId) {
        return (db
            .prepare(`SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE AND domain_id = ?`)
            .get(name, domainId) ?? null);
    }
    return (db
        .prepare(`SELECT * FROM ontology_categories WHERE name = ? COLLATE NOCASE`)
        .get(name) ?? null);
}
// === Category embeddings (candidate retrieval for the classifier) ===
/**
 * Store/replace a category's embedding in vec_categories (atomic DELETE+INSERT,
 * since vec0 virtual tables don't support REPLACE). The embedding is generated
 * by the caller from "name: description" in 'passage' mode.
 */
export function upsertCategoryEmbedding(db, categoryId, embedding) {
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
        db.prepare('INSERT INTO vec_categories (id, embedding) VALUES (?, ?)').run(categoryId, buf);
    });
    tx();
}
export function deleteCategoryEmbedding(db, categoryId) {
    try {
        db.prepare('DELETE FROM vec_categories WHERE id = ?').run(categoryId);
    }
    catch { /* table may not exist on very old DBs */ }
}
/**
 * Return the top-K most similar existing categories to a fact embedding, so the
 * classifier can present a short candidate list to the LLM instead of all
 * categories. Each result includes the owning domain name for a compact prompt.
 * Returns [] if the index is empty (caller falls back to the full list).
 */
export function searchSimilarCategories(db, embedding, k = 20) {
    const buf = Buffer.from(new Float32Array(embedding).buffer);
    let hits;
    try {
        hits = db.prepare(`
      SELECT id, distance FROM vec_categories
      WHERE embedding MATCH ? ORDER BY distance LIMIT ?
    `).all(buf, k);
    }
    catch {
        return []; // index absent → caller uses the full category list
    }
    const results = [];
    const catStmt = db.prepare('SELECT * FROM ontology_categories WHERE id = ?');
    const domStmt = db.prepare('SELECT name FROM ontology_domains WHERE id = ?');
    for (const h of hits) {
        const category = catStmt.get(h.id);
        if (!category)
            continue; // stale vector row (category was merged/deleted)
        const dom = domStmt.get(category.domain_id);
        results.push({ category, domainName: dom?.name ?? '?', distance: h.distance });
    }
    return results;
}
// === Fact Classification ===
export function classifyFact(db, factId, categoryId) {
    db.prepare(`UPDATE facts SET ontology_category_id = ?, updated_at = ? WHERE id = ?`).run(categoryId, new Date().toISOString(), factId);
}
export function getFactsByCategory(db, categoryId) {
    return db
        .prepare(`SELECT * FROM facts WHERE ontology_category_id = ? AND is_active = 1 ORDER BY consolidated_count DESC`)
        .all(categoryId)
        .map(rowToFact);
}
export function getFactsByDomain(db, domainId) {
    return db
        .prepare(`SELECT f.* FROM facts f
       JOIN ontology_categories c ON f.ontology_category_id = c.id
       WHERE c.domain_id = ? AND f.is_active = 1
       ORDER BY f.consolidated_count DESC`)
        .all(domainId)
        .map(rowToFact);
}
// === Relation CRUD ===
export function createRelation(db, sourceFactId, relationType, targetFactId, reasoning) {
    const id = randomUUID();
    const now = new Date().toISOString();
    // OR IGNORE: the UNIQUE(source, type, target) index makes exact-duplicate
    // triples a constraint hit under concurrent writers — the app-level
    // relationExistsBetween() pre-check keeps semantics (direction/symmetry),
    // this only absorbs the narrow insert race instead of throwing.
    db.prepare(`INSERT OR IGNORE INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(id, sourceFactId, relationType, targetFactId, reasoning ?? null, now);
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
 * Duplicate-edge check used by the detection channels, honouring relation
 * semantics:
 *
 * - type given, SYMMETRIC (SUPPORTS/CONTRADICTS): either direction counts as
 *   a duplicate — the reverse edge carries the same claim.
 * - type given, DIRECTIONAL (DEPENDS_ON/DERIVED_FROM/SUPERSEDES/INFLUENCES):
 *   only the exact a→b edge is a duplicate. The reverse edge is a distinct
 *   claim (dependency cycle, competing canonicality) that the graph — and
 *   the consistency queue — must be able to record.
 * - no type: any edge in either direction (coarse existence probe).
 *
 * A DIFFERENT type between the same pair is never a duplicate: that is
 * relationship evolution (a SUPPORTS pair can turn CONTRADICTS after a fact
 * is revised in place) and must stay recordable.
 */
export function relationExistsBetween(db, factIdA, factIdB, relationType) {
    if (relationType && !SYMMETRIC_RELATION_TYPES.has(relationType)) {
        return (db
            .prepare(`SELECT 1 AS one FROM ontology_relations
           WHERE source_fact_id = ? AND target_fact_id = ? AND relation_type = ?
           LIMIT 1`)
            .get(factIdA, factIdB, relationType) !== undefined);
    }
    return (db
        .prepare(`SELECT 1 AS one FROM ontology_relations
         WHERE ((source_fact_id = @a AND target_fact_id = @b)
             OR (source_fact_id = @b AND target_fact_id = @a))
           AND (@type IS NULL OR relation_type = @type)
         LIMIT 1`)
        .get({ a: factIdA, b: factIdB, type: relationType ?? null }) !== undefined);
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
export function getRelatedFacts(db, factId, hops = 1, decay = 0.6, minRelevance = 0.2, scopeProject) {
    const visited = new Set([factId]);
    const results = [];
    let frontier = [factId];
    for (let hop = 0; hop < hops; hop++) {
        const hopRelevance = Math.pow(decay, hop);
        if (hopRelevance < minRelevance)
            break; // Prune entire hop if too weak
        const nextFrontier = [];
        for (const currentId of frontier) {
            // Outgoing relations (source → target)
            const outgoing = db
                .prepare(`SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.target_fact_id = f.id
           WHERE r.source_fact_id = ? AND f.is_active = 1`)
                .all(currentId);
            for (const row of outgoing) {
                const targetId = row['target_fact_id'];
                if (visited.has(targetId))
                    continue;
                const relation = rowToRelation(row);
                const fact = rowToFact(row);
                // Scope filter: skip facts from other projects (unless scopeProject is null)
                if (scopeProject && fact.scope_type === 'project' && fact.scope_project !== scopeProject)
                    continue;
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
                .prepare(`SELECT r.*, f.*,
                  r.id as rel_id, r.created_at as rel_created_at
           FROM ontology_relations r
           JOIN facts f ON r.source_fact_id = f.id
           WHERE r.target_fact_id = ? AND f.is_active = 1`)
                .all(currentId);
            for (const row of incoming) {
                const sourceId = row['source_fact_id'];
                if (visited.has(sourceId))
                    continue;
                const relation = rowToRelation(row);
                const fact = rowToFact(row);
                // Scope filter: skip facts from other projects
                if (scopeProject && fact.scope_type === 'project' && fact.scope_project !== scopeProject)
                    continue;
                visited.add(sourceId);
                nextFrontier.push(sourceId);
                // Conflict/retirement edges traverse weaker; every structural edge
                // (SUPPORTS/INFLUENCES/DEPENDS_ON/DERIVED_FROM) traverses fully.
                const typeWeight = (relation.relation_type === 'CONTRADICTS' || relation.relation_type === 'SUPERSEDES') ? 0.7 : 1.0;
                const relevance = hopRelevance * typeWeight;
                if (relevance >= minRelevance) {
                    results.push({ fact, relation, relevance, hop: hop + 1 });
                }
            }
        }
        frontier = nextFrontier;
        if (frontier.length === 0)
            break;
    }
    // Sort by relevance descending
    results.sort((a, b) => b.relevance - a.relevance);
    return results;
}
export function getRelationsForFact(db, factId) {
    return db
        .prepare(`SELECT * FROM ontology_relations
       WHERE source_fact_id = ? OR target_fact_id = ?
       ORDER BY created_at DESC`)
        .all(factId, factId);
}
// === Ontology Tree ===
export function getOntologyTree(db) {
    const domains = listDomains(db);
    const tree = [];
    for (const domain of domains) {
        const categories = listCategories(db, domain.id);
        const domainEntry = {
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
function rowToFact(row) {
    const embeddingRaw = row['embedding'];
    let embedding = null;
    if (embeddingRaw instanceof Buffer) {
        embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
    }
    else if (embeddingRaw instanceof Uint8Array) {
        embedding = new Float32Array(embeddingRaw.buffer, embeddingRaw.byteOffset, embeddingRaw.byteLength / 4);
    }
    return {
        id: row['id'],
        fact: row['fact'],
        category: row['category'],
        scope_type: row['scope_type'],
        scope_project: row['scope_project'] ?? null,
        source_exchange_ids: row['source_exchange_ids']
            ? JSON.parse(row['source_exchange_ids'])
            : [],
        embedding,
        created_at: row['created_at'],
        updated_at: row['updated_at'],
        consolidated_count: row['consolidated_count'],
        is_active: Boolean(row['is_active']),
    };
}
function rowToRelation(row) {
    return {
        id: (row['rel_id'] ?? row['id']),
        source_fact_id: row['source_fact_id'],
        relation_type: row['relation_type'],
        target_fact_id: row['target_fact_id'],
        reasoning: row['reasoning'] ?? null,
        created_at: (row['rel_created_at'] ?? row['created_at']),
    };
}
