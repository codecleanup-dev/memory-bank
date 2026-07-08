import Database from 'better-sqlite3';
/**
 * Bounded rendering for the search_ontology MCP tool.
 *
 * The previous implementation loaded the FULL tree and rendered every fact —
 * an unfiltered call returned 4.9MB in one tool result (measured 2026-07-07:
 * 2,809 categories). An LLM-facing tool must return bounded output, so:
 *
 * - no filters      → summary only (domain/category/fact counts, zero fact lines)
 * - domain/category → facts, capped per category by `limit` (default 5) and
 *                     globally by MAX_CATEGORIES_RENDERED
 *
 * Every truncation is reported with exact remaining counts — no silent caps.
 */
export interface OntologyViewOptions {
    domain?: string;
    category?: string;
    includeRelations?: boolean;
    /** Max facts rendered per category (1..50, default 5). */
    limit?: number;
}
export declare function buildOntologyView(db: Database.Database, opts: OntologyViewOptions): string;
