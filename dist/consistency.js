function countActiveActive(db, type) {
    return db
        .prepare(`SELECT COUNT(*) AS n
         FROM ontology_relations r
         JOIN facts a ON a.id = r.source_fact_id
         JOIN facts b ON b.id = r.target_fact_id
         WHERE r.relation_type = ? AND a.is_active = 1 AND b.is_active = 1`)
        .get(type).n;
}
export function getConsistencyCounts(db) {
    const activeFacts = db.prepare('SELECT COUNT(*) AS n FROM facts WHERE is_active = 1').get().n;
    const orphanFacts = db
        .prepare(`SELECT COUNT(*) AS n FROM facts f
         WHERE f.is_active = 1
           AND NOT EXISTS (
             SELECT 1 FROM ontology_relations r
             WHERE r.source_fact_id = f.id OR r.target_fact_id = f.id
           )`)
        .get().n;
    const totalCategories = db.prepare('SELECT COUNT(*) AS n FROM ontology_categories').get().n;
    const singleFactCategories = db
        .prepare(`SELECT COUNT(*) AS n FROM (
           SELECT ontology_category_id FROM facts
           WHERE is_active = 1 AND ontology_category_id IS NOT NULL
           GROUP BY ontology_category_id
           HAVING COUNT(*) = 1
         )`)
        .get().n;
    return {
        activeFacts,
        activeContradictsPairs: countActiveActive(db, 'CONTRADICTS'),
        activeSupersedesPairs: countActiveActive(db, 'SUPERSEDES'),
        orphanFacts,
        orphanRate: activeFacts > 0 ? orphanFacts / activeFacts : 0,
        totalCategories,
        singleFactCategories,
    };
}
export function hasActiveConflicts(counts) {
    return counts.activeContradictsPairs + counts.activeSupersedesPairs > 0;
}
/**
 * Active-active conflict pairs of one type, newest relation first.
 * `limit` bounds the fetch; use getConsistencyCounts() for the true totals.
 */
export function listActiveConflicts(db, type, limit = 100) {
    const rows = db
        .prepare(`SELECT r.id AS rel_id, r.relation_type, r.reasoning, r.created_at AS rel_created_at,
              a.id AS s_id, a.fact AS s_fact, a.category AS s_category, a.scope_type AS s_scope_type,
              a.scope_project AS s_scope_project, a.consolidated_count AS s_count, a.created_at AS s_created_at,
              b.id AS t_id, b.fact AS t_fact, b.category AS t_category, b.scope_type AS t_scope_type,
              b.scope_project AS t_scope_project, b.consolidated_count AS t_count, b.created_at AS t_created_at
       FROM ontology_relations r
       JOIN facts a ON a.id = r.source_fact_id
       JOIN facts b ON b.id = r.target_fact_id
       WHERE r.relation_type = ? AND a.is_active = 1 AND b.is_active = 1
       ORDER BY r.created_at DESC
       LIMIT ?`)
        .all(type, limit);
    return rows.map((r) => ({
        relationId: r.rel_id,
        relationType: r.relation_type,
        reasoning: r.reasoning,
        createdAt: r.rel_created_at,
        source: {
            id: r.s_id, fact: r.s_fact, category: r.s_category, scope_type: r.s_scope_type,
            scope_project: r.s_scope_project, consolidated_count: r.s_count, created_at: r.s_created_at,
        },
        target: {
            id: r.t_id, fact: r.t_fact, category: r.t_category, scope_type: r.t_scope_type,
            scope_project: r.t_scope_project, consolidated_count: r.t_count, created_at: r.t_created_at,
        },
    }));
}
function snippet(text, max = 110) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
export function formatConsistencyReport(counts, contradicts, supersedes) {
    let out = `# Knowledge Graph Consistency Report\n\n`;
    out += `| Metric | Value |\n|--------|-------|\n`;
    out += `| Active facts | ${counts.activeFacts} |\n`;
    out += `| Active CONTRADICTS pairs | ${counts.activeContradictsPairs} |\n`;
    out += `| Active SUPERSEDES pairs | ${counts.activeSupersedesPairs} |\n`;
    out += `| Orphan facts (no relations) | ${counts.orphanFacts} (${(counts.orphanRate * 100).toFixed(1)}%) |\n`;
    out += `| Single-fact categories | ${counts.singleFactCategories} / ${counts.totalCategories} |\n\n`;
    if (!hasActiveConflicts(counts)) {
        out += `_No active-active conflict pairs — the graph is consistent._\n`;
        return out;
    }
    const section = (title, pairs, total, hint) => {
        if (total === 0)
            return '';
        let s = `## ${title} (${total})\n\n${hint}\n\n`;
        for (const p of pairs) {
            s += `- relation \`${p.relationId}\` (${p.createdAt.slice(0, 10)})\n`;
            s += `  - source [${p.source.category}] ${snippet(p.source.fact)} _(confirmed ${p.source.consolidated_count}x)_\n`;
            s += `  - target [${p.target.category}] ${snippet(p.target.fact)} _(confirmed ${p.target.consolidated_count}x)_\n`;
            if (p.reasoning)
                s += `  - reasoning: ${snippet(p.reasoning)}\n`;
        }
        if (total > pairs.length) {
            s += `\n_…showing ${pairs.length} of ${total} pairs (raise --limit to list more)._\n`;
        }
        return s + '\n';
    };
    out += section('Active CONTRADICTS pairs', contradicts, counts.activeContradictsPairs, '_Both facts are still active while recorded as contradicting — decide which side is current, then deactivate or re-consolidate the loser._');
    out += section('Active SUPERSEDES pairs', supersedes, counts.activeSupersedesPairs, '_The superseded (target) fact is still active — it should normally be deactivated so only the canonical fact keeps answering._');
    return out;
}
