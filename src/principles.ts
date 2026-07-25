import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';

/**
 * Principles registry + fact↔principle conflict store.
 *
 * Principles are the user's curated operating rules — one-line statements
 * mirroring the canonical rules files. They enter this table ONLY through the
 * `principles` CLI (human-gated by design; no auto-scraping — the rules files
 * remain the canon, this table is a reference index for conflict checking).
 *
 * Boundary contract (deliberate, mirrors consistency.ts report-first stance):
 * nothing in this module touches fact recording, truth, or retrieval ranking.
 * Conflicts are display/report state plus a resolution queue — a human (CLI)
 * decides whether the fact is stale, the principle is outdated, or the pair
 * is acceptable.
 */

export type PrincipleLayer = 'identity' | 'principle' | 'policy';

export const PRINCIPLE_LAYERS: readonly PrincipleLayer[] = ['identity', 'principle', 'policy'];

export type ConflictResolution =
  | 'fact_deprecated'
  | 'acknowledged'
  | 'false_positive'
  | 'principle_updated';

export const CONFLICT_RESOLUTIONS: readonly ConflictResolution[] = [
  'fact_deprecated',
  'acknowledged',
  'false_positive',
  'principle_updated',
];

export type ConflictMethod = 'llm' | 'manual' | 'import';

export interface Principle {
  id: string;
  slug: string;
  statement: string;
  source_path: string | null;
  layer: PrincipleLayer;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface PrincipleInput {
  slug: string;
  statement: string;
  sourcePath?: string | null;
  layer?: PrincipleLayer;
}

/** Active conflict joined with both endpoints (for reports/CLI). */
export interface ActivePrincipleConflict {
  conflictId: string;
  reasoning: string | null;
  method: string;
  confidence: number | null;
  createdAt: string;
  principle: { id: string; slug: string; statement: string; layer: string };
  fact: {
    id: string;
    fact: string;
    category: string;
    scope_type: string;
    scope_project: string | null;
    consolidated_count: number;
    created_at: string;
  };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function normalizeInput(input: PrincipleInput): { slug: string; statement: string; sourcePath: string | null; layer: PrincipleLayer } {
  const slug = (input.slug || '').trim().toLowerCase();
  const statement = (input.statement || '').replace(/\s+/g, ' ').trim();
  const layer = input.layer ?? 'principle';
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid principle slug: "${input.slug}" (expected lowercase kebab-case, max 64 chars)`);
  }
  if (!statement) {
    throw new Error('principle statement must be non-empty');
  }
  if (!PRINCIPLE_LAYERS.includes(layer)) {
    throw new Error(`invalid principle layer: "${layer}" (expected ${PRINCIPLE_LAYERS.join('|')})`);
  }
  return { slug, statement, sourcePath: input.sourcePath ?? null, layer };
}

export function addPrinciple(db: Database.Database, input: PrincipleInput): Principle {
  const { slug, statement, sourcePath, layer } = normalizeInput(input);
  const existing = db.prepare('SELECT slug FROM principles WHERE slug = ?').get(slug);
  if (existing) {
    throw new Error(`principle slug already exists: "${slug}" (use \`principles import\` to update)`);
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO principles (id, slug, statement, source_path, layer) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, slug, statement, sourcePath, layer);
  return db.prepare('SELECT * FROM principles WHERE id = ?').get(id) as Principle;
}

/** Idempotent upsert for seed-file imports: updates statement/source/layer and reactivates. */
export function upsertPrinciple(db: Database.Database, input: PrincipleInput): 'inserted' | 'updated' {
  const { slug, statement, sourcePath, layer } = normalizeInput(input);
  const existing = db.prepare('SELECT id FROM principles WHERE slug = ?').get(slug) as { id: string } | undefined;
  if (!existing) {
    addPrinciple(db, { slug, statement, sourcePath, layer });
    return 'inserted';
  }
  db.prepare(
    `UPDATE principles
     SET statement = ?, source_path = ?, layer = ?, is_active = 1, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(statement, sourcePath, layer, existing.id);
  return 'updated';
}

export function listPrinciples(db: Database.Database, includeInactive: boolean = false): Principle[] {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  return db.prepare(`SELECT * FROM principles ${where} ORDER BY layer, slug`).all() as Principle[];
}

export function getActivePrinciples(db: Database.Database): Principle[] {
  return listPrinciples(db, false);
}

export function getPrincipleBySlug(db: Database.Database, slug: string): Principle | null {
  const row = db.prepare('SELECT * FROM principles WHERE slug = ?').get(slug.trim().toLowerCase());
  return (row as Principle | undefined) ?? null;
}

/** Returns true when the row existed and its active flag actually changed. */
export function setPrincipleActive(db: Database.Database, slug: string, active: boolean): boolean {
  const info = db
    .prepare(
      `UPDATE principles SET is_active = ?, updated_at = datetime('now')
       WHERE slug = ? AND is_active != ?`,
    )
    .run(active ? 1 : 0, slug.trim().toLowerCase(), active ? 1 : 0);
  return info.changes > 0;
}

/**
 * Deterministic digest of the ACTIVE principle set (slug + statement, sorted).
 * The principle-check cursor stores this hash: when the set changes, the whole
 * fact scan restarts — verdicts against an old principle set are stale.
 */
export function activePrinciplesHash(db: Database.Database): string {
  const rows = db
    .prepare('SELECT slug, statement FROM principles WHERE is_active = 1 ORDER BY slug')
    .all() as Array<{ slug: string; statement: string }>;
  const digest = createHash('sha256');
  for (const r of rows) digest.update(`${r.slug}\x1f${r.statement}\n`);
  return digest.digest('hex');
}

/**
 * Insert-or-ignore on the (principle, fact) pair. Human resolutions are
 * durable: a pair resolved as false_positive/acknowledged keeps its row
 * (is_active = 0), so re-detection cannot re-open it.
 */
export function recordPrincipleConflict(
  db: Database.Database,
  params: {
    principleId: string;
    factId: string;
    reasoning?: string | null;
    method: ConflictMethod;
    confidence?: number | null;
  },
): 'inserted' | 'exists' {
  const reasoning = params.reasoning ? params.reasoning.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
  const info = db
    .prepare(
      `INSERT INTO principle_conflicts (id, principle_id, fact_id, reasoning, method, confidence)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(principle_id, fact_id) DO NOTHING`,
    )
    .run(randomUUID(), params.principleId, params.factId, reasoning, params.method, params.confidence ?? null);
  return info.changes > 0 ? 'inserted' : 'exists';
}

/** Conflicts where the conflict row, the fact, AND the principle are all still active. */
export function countActivePrincipleConflicts(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM principle_conflicts c
         JOIN principles p ON p.id = c.principle_id
         JOIN facts f ON f.id = c.fact_id
         WHERE c.is_active = 1 AND p.is_active = 1 AND f.is_active = 1`,
      )
      .get() as { n: number }
  ).n;
}

interface ActiveConflictRow {
  c_id: string;
  reasoning: string | null;
  method: string;
  confidence: number | null;
  c_created_at: string;
  p_id: string;
  p_slug: string;
  p_statement: string;
  p_layer: string;
  f_id: string;
  f_fact: string;
  f_category: string;
  f_scope_type: string;
  f_scope_project: string | null;
  f_count: number;
  f_created_at: string;
}

export function listActivePrincipleConflicts(
  db: Database.Database,
  limit: number = 100,
): ActivePrincipleConflict[] {
  const rows = db
    .prepare(
      `SELECT c.id AS c_id, c.reasoning, c.method, c.confidence, c.created_at AS c_created_at,
              p.id AS p_id, p.slug AS p_slug, p.statement AS p_statement, p.layer AS p_layer,
              f.id AS f_id, f.fact AS f_fact, f.category AS f_category, f.scope_type AS f_scope_type,
              f.scope_project AS f_scope_project, f.consolidated_count AS f_count, f.created_at AS f_created_at
       FROM principle_conflicts c
       JOIN principles p ON p.id = c.principle_id
       JOIN facts f ON f.id = c.fact_id
       WHERE c.is_active = 1 AND p.is_active = 1 AND f.is_active = 1
       ORDER BY c.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as ActiveConflictRow[];

  return rows.map((r) => ({
    conflictId: r.c_id,
    reasoning: r.reasoning,
    method: r.method,
    confidence: r.confidence,
    createdAt: r.c_created_at,
    principle: { id: r.p_id, slug: r.p_slug, statement: r.p_statement, layer: r.p_layer },
    fact: {
      id: r.f_id,
      fact: r.f_fact,
      category: r.f_category,
      scope_type: r.f_scope_type,
      scope_project: r.f_scope_project,
      consolidated_count: r.f_count,
      created_at: r.f_created_at,
    },
  }));
}

/** Returns true when the conflict existed, was active, and is now resolved. */
export function resolvePrincipleConflict(
  db: Database.Database,
  conflictId: string,
  resolution: ConflictResolution,
): boolean {
  if (!CONFLICT_RESOLUTIONS.includes(resolution)) {
    throw new Error(`invalid resolution: "${resolution}" (expected ${CONFLICT_RESOLUTIONS.join('|')})`);
  }
  const info = db
    .prepare(
      `UPDATE principle_conflicts
       SET is_active = 0, resolution = ?, resolved_at = datetime('now')
       WHERE id = ? AND is_active = 1`,
    )
    .run(resolution, conflictId);
  return info.changes > 0;
}

/**
 * One IN query for a search-result page: fact id → active principle conflicts.
 * Display-only annotation — callers must not use this to rank or filter.
 */
export function annotatePrincipleConflictsForFacts(
  db: Database.Database,
  factIds: string[],
): Map<string, Array<{ slug: string; statement: string; layer: string }>> {
  const map = new Map<string, Array<{ slug: string; statement: string; layer: string }>>();
  if (factIds.length === 0) return map;
  const placeholders = factIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT c.fact_id AS fact_id, p.slug AS slug, p.statement AS statement, p.layer AS layer
       FROM principle_conflicts c
       JOIN principles p ON p.id = c.principle_id
       WHERE c.is_active = 1 AND p.is_active = 1 AND c.fact_id IN (${placeholders})
       ORDER BY p.slug`,
    )
    .all(...factIds) as Array<{ fact_id: string; slug: string; statement: string; layer: string }>;
  for (const r of rows) {
    const list = map.get(r.fact_id) ?? [];
    list.push({ slug: r.slug, statement: r.statement, layer: r.layer });
    map.set(r.fact_id, list);
  }
  return map;
}

function snippet(text: string, max: number = 110): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Coverage summary shape (defined in principle-check.ts; duplicated here to avoid an import cycle). */
export interface PrincipleCoverageInfo {
  state: 'no-principles' | 'unscanned' | 'principles-changed' | 'partial' | 'complete';
  uncheckedFacts: number;
  /** F1: active revised facts awaiting re-judgement (optional for older callers). */
  recheckQueued?: number;
}

function coverageNote(coverage: PrincipleCoverageInfo): string {
  switch (coverage.state) {
    case 'unscanned':
      return `_Principle scan has not run yet (${coverage.uncheckedFacts} active facts unmeasured) — "no conflicts" is NOT "verified consistent". Run \`memory-bank principles check\`._`;
    case 'principles-changed':
      return `_Principle set changed since the last scan (${coverage.uncheckedFacts} active facts need re-measuring) — existing verdicts are against an old set. Run \`memory-bank principles check\`._`;
    case 'partial':
      return `_Principle scan incomplete: ${coverage.uncheckedFacts} active facts unmeasured — run \`memory-bank principles check\` to continue._`;
    default:
      return '';
  }
}

/**
 * Markdown section for the consistency report. Empty when there is nothing to
 * show AND nothing unmeasured — an incomplete scan is surfaced even with zero
 * conflicts, so "no conflicts" cannot masquerade as "measured and clean".
 */
export function formatPrincipleConflictSection(
  total: number,
  conflicts: ActivePrincipleConflict[],
  coverage?: PrincipleCoverageInfo,
): string {
  const note = coverage ? coverageNote(coverage) : '';
  // F1: revised facts carry text-bound verdicts that may be stale — surface
  // the pending re-judgement queue even when the conflict count is zero.
  const queueNote =
    coverage && coverage.recheckQueued && coverage.recheckQueued > 0
      ? `_${coverage.recheckQueued} revised fact(s) await re-judgement — the next \`principles check\` drains them first (stale verdicts may be cleared or re-confirmed)._`
      : '';
  if (total === 0) {
    if (!note && !queueNote) return '';
    const notes = [note, queueNote].filter(Boolean).join('\n\n');
    return `## Active principle conflicts (0)\n\n${notes}\n\n`;
  }
  let out = `## Active principle conflicts (${total})\n\n`;
  if (note) out += `${note}\n\n`;
  if (queueNote) out += `${queueNote}\n\n`;
  out +=
    '_A stored fact contradicts a registered operating principle — decide whether the fact is stale ' +
    '(deprecate/revise it), the principle is outdated (deactivate it and update the canon), or the pair ' +
    'is acceptable (`principles resolve --resolution acknowledged|false_positive`)._\n\n';
  for (const c of conflicts) {
    const conf = c.confidence != null ? `, confidence ${c.confidence.toFixed(2)}` : '';
    out += `- conflict \`${c.conflictId}\` (${c.createdAt.slice(0, 10)}, ${c.method}${conf})\n`;
    out += `  - principle [${c.principle.layer}] ${c.principle.slug}: ${snippet(c.principle.statement)}\n`;
    out += `  - fact [${c.fact.category}] ${snippet(c.fact.fact)} _(confirmed ${c.fact.consolidated_count}x)_\n`;
    if (c.reasoning) out += `  - reasoning: ${snippet(c.reasoning)}\n`;
  }
  if (total > conflicts.length) {
    out += `\n_…showing ${conflicts.length} of ${total} conflicts (raise --limit to list more)._\n`;
  }
  return out + '\n';
}
