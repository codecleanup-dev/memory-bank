#!/usr/bin/env node
/**
 * Measure the deterministic reuse gate threshold on LIVE data (read-only).
 *
 * Scaffold rule: absolute similarity thresholds are model-scale dependent and
 * must be measured on real DB data, never guessed. This samples classified
 * facts and asks: "if the gate had fired at threshold T, how often would the
 * top-1 nearest category have matched the LLM's actual assignment?"
 *
 * Interpretation: agreement is a LOWER bound on gate quality — with a sprawly
 * taxonomy the top-1 can be a near-duplicate of the assigned category that is
 * equally correct. Pick the smallest T with high agreement and enough volume.
 *
 * Usage: node scripts/measure-det-gate.mjs [sampleSize]
 */
import { initDatabase } from '../dist/db.js';
import { searchSimilarCategories } from '../dist/ontology-db.js';

const SAMPLE = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 400;

const db = initDatabase();
try {
  const rows = db.prepare(`
    SELECT id, embedding, ontology_category_id FROM facts
    WHERE is_active = 1 AND ontology_category_id IS NOT NULL AND embedding IS NOT NULL
    ORDER BY RANDOM() LIMIT ?
  `).all(SAMPLE);

  const samples = [];
  for (const row of rows) {
    if (!(row.embedding instanceof Buffer)) continue;
    const emb = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
    const hits = searchSimilarCategories(db, emb, 1);
    if (hits.length === 0) continue;
    const sim = 1 - (hits[0].distance * hits[0].distance) / 2; // L2 → cosine (normalized embeddings)
    samples.push({ sim, agree: hits[0].category.id === row.ontology_category_id });
  }

  console.log(`samples: ${samples.length}`);
  console.log('threshold | fired | agree | agreement% | fired%');
  for (const t of [0.88, 0.9, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97]) {
    const fired = samples.filter((s) => s.sim >= t);
    const agree = fired.filter((s) => s.agree).length;
    const pct = fired.length ? ((agree / fired.length) * 100).toFixed(1) : '-';
    const vol = ((fired.length / samples.length) * 100).toFixed(1);
    console.log(`${t.toFixed(2)}      | ${String(fired.length).padStart(5)} | ${String(agree).padStart(5)} | ${String(pct).padStart(9)}% | ${vol}%`);
  }
} finally {
  db.close();
}
