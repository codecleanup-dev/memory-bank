import fs from 'fs';
import path from 'path';
import { initDatabase, getVecTableDtype, embeddingToVecBlob, vecParamSql } from './db.js';
import { generateEmbedding, initEmbeddings, EMBEDDING_VERSION } from './embeddings.js';
import { getSyncDir } from './sync-export.js';
import { canonicalizeProject } from './project-canon.js';
import { normalizeFactCategory } from './fact-category.js';
import { relationExistsBetween } from './ontology-db.js';
/**
 * Import facts and ontology from sync/ JSONL files into local DB.
 * Only inserts records that don't already exist (by ID).
 * Generates embeddings for new facts.
 */
export async function importFromSync() {
    const syncDir = getSyncDir();
    const result = { newFacts: 0, newDomains: 0, newCategories: 0, newRelations: 0 };
    // Check if sync files exist
    const factsPath = path.join(syncDir, 'facts.jsonl');
    if (!fs.existsSync(factsPath)) {
        return result;
    }
    const db = initDatabase();
    try {
        // Import domains first (facts reference them via categories)
        const domainsPath = path.join(syncDir, 'ontology-domains.jsonl');
        if (fs.existsSync(domainsPath)) {
            const lines = fs.readFileSync(domainsPath, 'utf-8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const d = JSON.parse(line);
                    const existing = db.prepare('SELECT id FROM ontology_domains WHERE id = ?').get(d.id);
                    if (!existing) {
                        db.prepare('INSERT INTO ontology_domains (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(d.id, d.name, d.description, d.created_at);
                        result.newDomains++;
                    }
                }
                catch { /* skip malformed */ }
            }
        }
        // Import categories
        const categoriesPath = path.join(syncDir, 'ontology-categories.jsonl');
        if (fs.existsSync(categoriesPath)) {
            const lines = fs.readFileSync(categoriesPath, 'utf-8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const c = JSON.parse(line);
                    const existing = db.prepare('SELECT id FROM ontology_categories WHERE id = ?').get(c.id);
                    if (!existing) {
                        db.prepare('INSERT INTO ontology_categories (id, domain_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)').run(c.id, c.domain_id, c.name, c.description, c.created_at);
                        result.newCategories++;
                    }
                }
                catch { /* skip malformed */ }
            }
        }
        // Import facts (need to generate embeddings for new ones).
        // remoteToLocal maps every remote fact id to its local canonical id —
        // content-deduped facts resolve to the surviving local/batch fact, so
        // relations referencing a deduped endpoint can be remapped instead of
        // being dropped by the FK check.
        const factsLines = fs.readFileSync(factsPath, 'utf-8').split('\n').filter(l => l.trim());
        const newFacts = [];
        const seenInBatch = new Map(); // contentKey → surviving remote id
        const remoteToLocal = new Map();
        for (const line of factsLines) {
            try {
                const f = JSON.parse(line);
                const existingById = db.prepare('SELECT id FROM facts WHERE id = ?').get(f.id);
                if (existingById) {
                    remoteToLocal.set(f.id, f.id);
                    continue;
                }
                // Canonicalize scope before dedup/insert — other devices may still
                // export slug-format project names.
                if (f.scope_project) {
                    f.scope_project = canonicalizeProject(db, f.scope_project);
                }
                // Content-based dedup: re-exports from other devices assign new ids
                // to identical facts, so id-only checks accumulate duplicates.
                const contentKey = `${f.fact}\u0000${f.scope_type}\u0000${f.scope_project ?? ''}`;
                const batchSurvivor = seenInBatch.get(contentKey);
                if (batchSurvivor) {
                    remoteToLocal.set(f.id, batchSurvivor);
                    continue;
                }
                const existingByContent = db.prepare(`
          SELECT id FROM facts
          WHERE is_active = 1 AND fact = ? AND scope_type = ? AND COALESCE(scope_project, '') = ?
        `).get(f.fact, f.scope_type, f.scope_project ?? '');
                if (existingByContent) {
                    remoteToLocal.set(f.id, existingByContent.id);
                    continue;
                }
                seenInBatch.set(contentKey, f.id);
                remoteToLocal.set(f.id, f.id);
                newFacts.push(f);
            }
            catch { /* skip malformed */ }
        }
        if (newFacts.length > 0) {
            await initEmbeddings();
            for (const f of newFacts) {
                try {
                    // Embeddings are async — generate BEFORE the transaction below.
                    const embedding = await generateEmbedding(f.fact);
                    const embeddingKr = f.fact_kr ? await generateEmbedding(f.fact_kr) : null;
                    // Same clamp as insertFact — foreign files may carry junk values,
                    // and dropping the field entirely would NULL the reliability
                    // signal on every cross-machine sync.
                    const confidence = typeof f.confidence === 'number' && Number.isFinite(f.confidence)
                        ? Math.min(1, Math.max(0, f.confidence))
                        : null;
                    // ONE transaction per fact: a fact row committed without its
                    // vector rows would be permanently unindexed (later imports skip
                    // it by id), so partial state must be impossible — on failure the
                    // whole fact rolls back and the next import retries it.
                    const insertTx = db.transaction(() => {
                        db.prepare(`
              INSERT INTO facts (id, fact, category, scope_type, scope_project, source_exchange_ids,
                embedding, created_at, updated_at, consolidated_count, is_active, ontology_category_id,
                fact_kr, embedding_version, confidence)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            `).run(f.id, f.fact, 
                        // Sync files from other machines may predate the category CHECK
                        // ('requirement', enum echoes, 'null') — normalize like every
                        // other write path, or the insert throws and the fact is
                        // silently dropped from the sync.
                        normalizeFactCategory(f.category), f.scope_type, f.scope_project, f.source_exchange_ids, Buffer.from(new Float32Array(embedding).buffer), f.created_at, f.updated_at, f.consolidated_count, f.ontology_category_id, f.fact_kr ?? null, EMBEDDING_VERSION, confidence);
                        // Vector index (dtype-aware: int8 tables need vec_int8()-wrapped
                        // quantized blobs — a raw float32 blob throws on an int8 table)
                        const dtF = getVecTableDtype(db, 'vec_facts');
                        db.prepare('DELETE FROM vec_facts WHERE id = ?').run(f.id);
                        db.prepare(`INSERT INTO vec_facts (id, embedding) VALUES (?, ${vecParamSql(dtF)})`).run(f.id, embeddingToVecBlob(embedding, dtF));
                        // Korean-text vector index (same-language matching for Korean queries)
                        if (embeddingKr) {
                            const dtK = getVecTableDtype(db, 'vec_facts_kr');
                            db.prepare('DELETE FROM vec_facts_kr WHERE id = ?').run(f.id);
                            db.prepare(`INSERT INTO vec_facts_kr (id, embedding) VALUES (?, ${vecParamSql(dtK)})`).run(f.id, embeddingToVecBlob(embeddingKr, dtK));
                        }
                    });
                    insertTx.immediate();
                    result.newFacts++;
                }
                catch (e) {
                    console.error(`sync-import: failed to import fact ${f.id}:`, e instanceof Error ? e.message : e);
                }
            }
        }
        // Import relations — endpoints are remapped through remoteToLocal so an
        // edge whose fact was content-deduped lands on the surviving local fact
        // instead of being dropped by the FK check.
        const relationsPath = path.join(syncDir, 'ontology-relations.jsonl');
        if (fs.existsSync(relationsPath)) {
            const lines = fs.readFileSync(relationsPath, 'utf-8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const r = JSON.parse(line);
                    const existing = db.prepare('SELECT id FROM ontology_relations WHERE id = ?').get(r.id);
                    if (existing)
                        continue;
                    const source = remoteToLocal.get(r.source_fact_id) ?? r.source_fact_id;
                    const target = remoteToLocal.get(r.target_fact_id) ?? r.target_fact_id;
                    // Remap can collapse both endpoints onto one fact — a self-loop
                    // carries no information.
                    if (source === target)
                        continue;
                    // Remap can also land on an edge that already exists locally —
                    // same semantics as the extraction channels: symmetric types
                    // (SUPPORTS/CONTRADICTS) dedupe in either direction, directional
                    // types exact-direction only.
                    if (relationExistsBetween(db, source, target, r.relation_type))
                        continue;
                    db.prepare(`
            INSERT INTO ontology_relations (id, source_fact_id, relation_type, target_fact_id, reasoning, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(r.id, source, r.relation_type, target, r.reasoning, r.created_at);
                    result.newRelations++;
                }
                catch { /* skip malformed (incl. edges whose endpoints never existed locally) */ }
            }
        }
        return result;
    }
    finally {
        db.close();
    }
}
