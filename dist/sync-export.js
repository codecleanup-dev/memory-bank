import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase } from './db.js';
import { getSuperpowersDir } from './paths.js';
const SYNC_DIR_NAME = 'sync';
export function getSyncDir() {
    const dir = path.join(getSuperpowersDir(), 'conversation-index', SYNC_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}
/**
 * Export facts, ontology domains/categories, and relations to JSONL files.
 * These files are small (~90KB) and safe for cloud sync (cc-sync, iCloud, etc).
 * The local SQLite DB (544MB) should NOT be synced — it's rebuilt from these + JSONL archives.
 */
export function exportForSync() {
    const db = initDatabase();
    const syncDir = getSyncDir();
    try {
        // Export facts (fact_kr included so other devices can build Korean
        // vectors; confidence included so the reliability signal survives sync)
        const facts = db.prepare(`
      SELECT id, fact, fact_kr, category, scope_type, scope_project, source_exchange_ids,
             created_at, updated_at, consolidated_count, ontology_category_id, confidence
      FROM facts WHERE is_active = 1
    `).all();
        const factsPath = path.join(syncDir, 'facts.jsonl');
        const factsLines = facts.map(f => JSON.stringify(f));
        fs.writeFileSync(factsPath, factsLines.join('\n') + '\n');
        // Export domains
        const domains = db.prepare('SELECT * FROM ontology_domains').all();
        const domainsPath = path.join(syncDir, 'ontology-domains.jsonl');
        fs.writeFileSync(domainsPath, domains.map(d => JSON.stringify(d)).join('\n') + '\n');
        // Export categories
        const categories = db.prepare('SELECT * FROM ontology_categories').all();
        const categoriesPath = path.join(syncDir, 'ontology-categories.jsonl');
        fs.writeFileSync(categoriesPath, categories.map(c => JSON.stringify(c)).join('\n') + '\n');
        // Export relations — only edges whose BOTH endpoints are in the export
        // set (active facts). An edge referencing an inactive/superseded fact
        // would be silently dropped by the importer's FK check anyway; filtering
        // here makes the sync set self-consistent, and the exclusion is counted
        // instead of silent.
        const relationsTotal = db.prepare('SELECT COUNT(*) AS n FROM ontology_relations').get().n;
        const relations = db.prepare(`
      SELECT r.* FROM ontology_relations r
      JOIN facts a ON a.id = r.source_fact_id AND a.is_active = 1
      JOIN facts b ON b.id = r.target_fact_id AND b.is_active = 1
    `).all();
        if (relationsTotal > relations.length) {
            console.error(`sync-export: ${relationsTotal - relations.length} relations excluded (endpoint inactive or missing — local history only).`);
        }
        const relationsPath = path.join(syncDir, 'ontology-relations.jsonl');
        fs.writeFileSync(relationsPath, relations.map(r => JSON.stringify(r)).join('\n') + '\n');
        // Export metadata
        const meta = {
            exported_at: new Date().toISOString(),
            hostname: os.hostname(),
            facts_count: facts.length,
            domains_count: domains.length,
            categories_count: categories.length,
            relations_count: relations.length,
        };
        fs.writeFileSync(path.join(syncDir, 'meta.json'), JSON.stringify(meta, null, 2));
        return {
            facts: facts.length,
            domains: domains.length,
            categories: categories.length,
            relations: relations.length,
        };
    }
    finally {
        db.close();
    }
}
