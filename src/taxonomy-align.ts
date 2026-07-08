import Database from 'better-sqlite3';
import type { OntologyCategory } from './types.js';
import { listCategories, listDomains } from './ontology-db.js';

/**
 * Taxonomy alignment: detect near-duplicate ontology categories via their
 * vec_categories embeddings and (optionally) merge them.
 *
 * Why: category sprawl is measured, not hypothetical — 2,809 categories for
 * 12,995 active facts with 1,014 single-fact categories (2026-07-07). The
 * classifier's deterministic reuse gate ships disabled with the note "opt in
 * once the taxonomy is consolidated" (ontology-classifier.ts); this module is
 * that consolidation step.
 *
 * Report-first by design:
 * - findMergeCandidates() never writes.
 * - applyMerges() runs only from an explicit CLI --apply, merges only
 *   same-domain pairs, and never touches the General/Misc parking category
 *   (facts are parked there by the attempt ledger, not by topic similarity).
 */

export interface MergeCandidate {
  keepId: string;
  keepName: string;
  keepDomain: string;
  keepFactCount: number;
  dropId: string;
  dropName: string;
  dropDomain: string;
  dropFactCount: number;
  similarity: number;
  sameDomain: boolean;
}

export interface FindResult {
  candidates: MergeCandidate[];
  /** Live categories without a vec_categories row — invisible to detection. */
  unindexedCategories: number;
  totalCategories: number;
}

export interface ApplyResult {
  merged: number;
  factsRemapped: number;
  skippedCrossDomain: number;
  /** Pairs whose sides were already unified (or vanished) by earlier merges. */
  skippedStale: number;
}

export const DEFAULT_MERGE_THRESHOLD = 0.9;
const NEIGHBORS_PER_CATEGORY = 4;

/** vec0 L2 distance on (near-)normalized embeddings → cosine similarity. */
function l2ToCosine(distance: number): number {
  return 1 - (distance * distance) / 2;
}

function isParkingCategory(cat: OntologyCategory, domainNames: Map<string, string>): boolean {
  return cat.name === 'Misc' && (domainNames.get(cat.domain_id) ?? '') === 'General';
}

export function findMergeCandidates(
  db: Database.Database,
  opts: { threshold?: number } = {},
): FindResult {
  const threshold = opts.threshold ?? DEFAULT_MERGE_THRESHOLD;
  const categories = listCategories(db);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const domainNames = new Map(listDomains(db).map((d) => [d.id, d.name]));

  // Active-fact counts decide which side of a pair survives.
  const counts = new Map<string, number>();
  const countRows = db
    .prepare(
      `SELECT ontology_category_id AS id, COUNT(*) AS n
       FROM facts WHERE is_active = 1 AND ontology_category_id IS NOT NULL
       GROUP BY ontology_category_id`,
    )
    .all() as Array<{ id: string; n: number }>;
  for (const row of countRows) counts.set(row.id, row.n);

  let embStmt: Database.Statement;
  let knnStmt: Database.Statement;
  try {
    embStmt = db.prepare('SELECT embedding FROM vec_categories WHERE id = ?');
    knnStmt = db.prepare(
      'SELECT id, distance FROM vec_categories WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
    );
  } catch {
    // Index table absent (very old DB) — nothing detectable.
    return { candidates: [], unindexedCategories: categories.length, totalCategories: categories.length };
  }

  const seenPairs = new Set<string>();
  const candidates: MergeCandidate[] = [];
  let unindexed = 0;

  for (const cat of categories) {
    let embRow: { embedding: Buffer } | undefined;
    try {
      embRow = embStmt.get(cat.id) as { embedding: Buffer } | undefined;
    } catch {
      embRow = undefined;
    }
    if (!embRow?.embedding) {
      unindexed++;
      continue;
    }

    let hits: Array<{ id: string; distance: number }>;
    try {
      hits = knnStmt.all(embRow.embedding, NEIGHBORS_PER_CATEGORY + 1) as Array<{
        id: string;
        distance: number;
      }>;
    } catch {
      continue;
    }

    for (const hit of hits) {
      if (hit.id === cat.id) continue;
      const similarity = l2ToCosine(hit.distance);
      if (similarity < threshold) continue;

      const other = byId.get(hit.id);
      if (!other) continue; // stale vec row (category already deleted)

      const pairKey = [cat.id, other.id].sort().join('|');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      if (isParkingCategory(cat, domainNames) || isParkingCategory(other, domainNames)) continue;

      const catCount = counts.get(cat.id) ?? 0;
      const otherCount = counts.get(other.id) ?? 0;
      // Keep the category holding more facts; tie → the older one (stable id).
      const keepFirst =
        catCount > otherCount || (catCount === otherCount && cat.created_at <= other.created_at);
      const keep = keepFirst ? cat : other;
      const drop = keepFirst ? other : cat;

      candidates.push({
        keepId: keep.id,
        keepName: keep.name,
        keepDomain: domainNames.get(keep.domain_id) ?? '?',
        keepFactCount: counts.get(keep.id) ?? 0,
        dropId: drop.id,
        dropName: drop.name,
        dropDomain: domainNames.get(drop.domain_id) ?? '?',
        dropFactCount: counts.get(drop.id) ?? 0,
        similarity: Number(similarity.toFixed(4)),
        sameDomain: cat.domain_id === other.domain_id,
      });
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return { candidates, unindexedCategories: unindexed, totalCategories: categories.length };
}

/**
 * Merge same-domain candidates: remap every fact (active AND inactive — no
 * dangling references) from drop → keep, delete the dropped category and its
 * index row. Chains (a→b, b→c) are resolved through a remap table so later
 * pairs land on the final survivor. facts.updated_at is deliberately NOT
 * bumped — a taxonomy remap is not new evidence and must not goose recency
 * scoring.
 */
export function applyMerges(db: Database.Database, candidates: MergeCandidate[]): ApplyResult {
  const remap = new Map<string, string>();
  const resolve = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (remap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = remap.get(cur)!;
    }
    return cur;
  };

  const catStmt = db.prepare('SELECT id, created_at FROM ontology_categories WHERE id = ?');
  const countStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM facts WHERE is_active = 1 AND ontology_category_id = ?',
  );
  const mergeTx = db.transaction((keepId: string, dropId: string): number => {
    const res = db
      .prepare('UPDATE facts SET ontology_category_id = ? WHERE ontology_category_id = ?')
      .run(keepId, dropId);
    db.prepare('DELETE FROM ontology_categories WHERE id = ?').run(dropId);
    try {
      db.prepare('DELETE FROM vec_categories WHERE id = ?').run(dropId);
    } catch {
      // index table absent on very old DBs; stale rows are also purged by
      // the classifier's healCategoryIndex self-repair.
    }
    return res.changes;
  });

  const result: ApplyResult = { merged: 0, factsRemapped: 0, skippedCrossDomain: 0, skippedStale: 0 };

  for (const cand of candidates) {
    if (!cand.sameDomain) {
      result.skippedCrossDomain++;
      continue;
    }
    const a = resolve(cand.keepId);
    const b = resolve(cand.dropId);
    if (a === b) {
      result.skippedStale++;
      continue;
    }
    const aRow = catStmt.get(a) as { id: string; created_at: string } | undefined;
    const bRow = catStmt.get(b) as { id: string; created_at: string } | undefined;
    if (!aRow || !bRow) {
      result.skippedStale++;
      continue;
    }

    // Re-decide the survivor with CURRENT state — earlier merges may have
    // moved facts, so carrying the stale candidate's keep/drop roles across a
    // resolved chain can invert the intended survivor (e.g. A absorbs C,
    // then a stale B-C pair would delete A into B). Same rule as detection:
    // more active facts wins, tie → the older category.
    const aCount = (countStmt.get(a) as { n: number }).n;
    const bCount = (countStmt.get(b) as { n: number }).n;
    const aSurvives = aCount > bCount || (aCount === bCount && aRow.created_at <= bRow.created_at);
    const survivor = aSurvives ? a : b;
    const absorbed = aSurvives ? b : a;

    result.factsRemapped += mergeTx.immediate(survivor, absorbed);
    remap.set(absorbed, survivor);
    result.merged++;
  }
  return result;
}

export function formatAlignmentReport(
  find: FindResult,
  opts: { threshold: number; show: number },
  applied?: ApplyResult,
): string {
  const sameDomain = find.candidates.filter((c) => c.sameDomain);
  const crossDomain = find.candidates.filter((c) => !c.sameDomain);

  let out = `# Taxonomy Alignment Report\n\n`;
  out += `| Metric | Value |\n|--------|-------|\n`;
  out += `| Categories | ${find.totalCategories} |\n`;
  out += `| Unindexed categories (no embedding) | ${find.unindexedCategories} |\n`;
  out += `| Similarity threshold | ${opts.threshold} |\n`;
  out += `| Same-domain merge candidates | ${sameDomain.length} |\n`;
  out += `| Cross-domain candidates (manual review only) | ${crossDomain.length} |\n\n`;

  if (find.unindexedCategories > 0) {
    out += `_${find.unindexedCategories} categories have no embedding and were invisible to detection — run \`node scripts/backfill-category-embeddings.mjs\` first for full coverage._\n\n`;
  }

  const line = (c: MergeCandidate): string =>
    `- ${c.similarity.toFixed(3)} [${c.keepDomain}] "${c.dropName}" (${c.dropFactCount} facts) → merge into "${c.keepName}" (${c.keepFactCount} facts)${c.sameDomain ? '' : ` — cross-domain: [${c.dropDomain}] vs [${c.keepDomain}]`}\n`;

  if (sameDomain.length > 0) {
    out += `## Same-domain merge candidates\n\n`;
    for (const c of sameDomain.slice(0, opts.show)) out += line(c);
    if (sameDomain.length > opts.show) {
      out += `\n_…+${sameDomain.length - opts.show} more (raise --show)._\n`;
    }
    out += '\n';
  }

  if (crossDomain.length > 0) {
    out += `## Cross-domain candidates (never auto-applied)\n\n`;
    for (const c of crossDomain.slice(0, Math.min(10, opts.show))) out += line(c);
    if (crossDomain.length > Math.min(10, opts.show)) {
      out += `\n_…+${crossDomain.length - Math.min(10, opts.show)} more._\n`;
    }
    out += '\n';
  }

  if (find.candidates.length === 0) {
    out += `_No merge candidates at threshold ${opts.threshold} — taxonomy looks aligned._\n`;
  }

  if (applied) {
    out += `## Applied\n\n`;
    out += `- merged categories: ${applied.merged}\n`;
    out += `- facts remapped: ${applied.factsRemapped}\n`;
    out += `- skipped (cross-domain): ${applied.skippedCrossDomain}\n`;
    out += `- skipped (stale/chained): ${applied.skippedStale}\n\n`;
    out += `_Next: re-measure the deterministic reuse gate on the consolidated taxonomy (\`node scripts/measure-det-gate.mjs\`) before enabling MEMORY_BANK_ONTOLOGY_DET_GATE._\n`;
  }

  return out;
}
