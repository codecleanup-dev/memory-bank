import type { FactCategory } from './types.js';
/**
 * Controlled vocabulary for facts.category.
 *
 * The DB enforces this list with a CHECK constraint (fresh DBs get it from
 * CREATE TABLE; legacy DBs are rebuilt once by migrateFactsCategoryVocabulary
 * in db.ts). Every write path must normalize through normalizeFactCategory()
 * first, so LLM output drift ('requirement', enum echoes like
 * 'decision|preference|...', 'null') can never reach the constraint and throw
 * mid-pipeline.
 */
export declare const FACT_CATEGORIES: readonly ["decision", "preference", "pattern", "knowledge", "constraint"];
export declare function isFactCategory(value: unknown): value is FactCategory;
/**
 * Deterministic mapping from arbitrary (LLM-produced) category strings to the
 * controlled vocabulary. Measured contamination on live data (2026-07-07,
 * 12,995 active facts): 'requirement' ×44, enum echo
 * 'decision|preference|pattern|knowledge|constraint' ×10, 'null' ×1 plus
 * one-offs ('architecture', 'project', 'plan', ...).
 *
 * Rules, in order:
 * 1. valid value (case/whitespace-insensitive) → itself
 * 2. 'requirement(s)' → 'constraint' (closest semantics)
 * 3. enum echo containing '|' → first valid token
 * 4. everything else (including null/empty) → 'knowledge' (neutral bucket)
 */
export declare function normalizeFactCategory(raw: unknown): FactCategory;
/** SQL fragment shared by the CREATE TABLE path and the rebuild migration. */
export declare const FACT_CATEGORY_CHECK_SQL: string;
