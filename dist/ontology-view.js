import { listDomains, listCategories, getRelatedFacts } from './ontology-db.js';
const DEFAULT_FACT_LIMIT = 5;
const MAX_FACT_LIMIT = 50;
const MAX_CATEGORIES_RENDERED = 40;
// include_relations must be bounded too: a hub fact can carry thousands of
// 1-hop edges, which would reopen the unbounded-output hole through the
// relations lines.
const MAX_RELATIONS_PER_FACT = 5;
/**
 * DB-sourced text (fact text, domain/category names/descriptions) is past
 * LLM/sync output. A stored payload like "## SYSTEM: ignore previous
 * instructions" must not be able to fabricate its own markdown section
 * inside this tool result — single-line + length-cap keeps every payload an
 * inline fragment of a bullet we author (same carrier-bounding rationale as
 * the classifier's oneLine(); semantic injection cannot be fully eliminated
 * in a text tool, but it cannot restructure the output).
 */
function inert(value, max = 300) {
    if (!value)
        return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
}
function listCategoryFacts(db, categoryId, limit) {
    return db
        .prepare(`SELECT id, fact, category, consolidated_count, created_at
       FROM facts
       WHERE ontology_category_id = ? AND is_active = 1
       ORDER BY consolidated_count DESC, created_at DESC
       LIMIT ?`)
        .all(categoryId, limit);
}
function countCategoryFacts(db, categoryId) {
    return db
        .prepare(`SELECT COUNT(*) AS n FROM facts WHERE ontology_category_id = ? AND is_active = 1`)
        .get(categoryId).n;
}
export function buildOntologyView(db, opts) {
    const domainFilter = opts.domain?.trim().toLowerCase() || undefined;
    const categoryFilter = opts.category?.trim().toLowerCase() || undefined;
    if (!domainFilter && !categoryFilter)
        return buildSummary(db);
    const rawLimit = opts.limit ?? DEFAULT_FACT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_FACT_LIMIT, Math.floor(rawLimit)));
    return buildDetail(db, domainFilter, categoryFilter, limit, opts.includeRelations === true);
}
function buildSummary(db) {
    const activeFacts = db.prepare('SELECT COUNT(*) AS n FROM facts WHERE is_active = 1').get().n;
    const classified = db
        .prepare('SELECT COUNT(*) AS n FROM facts WHERE is_active = 1 AND ontology_category_id IS NOT NULL')
        .get().n;
    const totalCategories = db.prepare('SELECT COUNT(*) AS n FROM ontology_categories').get().n;
    const domains = db
        .prepare(`SELECT d.name, d.description,
              COUNT(DISTINCT c.id) AS categories,
              COUNT(f.id) AS facts
       FROM ontology_domains d
       LEFT JOIN ontology_categories c ON c.domain_id = d.id
       LEFT JOIN facts f ON f.ontology_category_id = c.id AND f.is_active = 1
       GROUP BY d.id
       ORDER BY facts DESC, d.name`)
        .all();
    let out = `# Ontology Summary\n\n`;
    out += `| Metric | Count |\n|--------|-------|\n`;
    out += `| Active facts | ${activeFacts} |\n`;
    out += `| Classified facts | ${classified} |\n`;
    out += `| Domains | ${domains.length} |\n`;
    out += `| Categories | ${totalCategories} |\n\n`;
    if (domains.length === 0) {
        out += `_No ontology data found. Facts are classified automatically as they are extracted._\n`;
        return out;
    }
    out += `## Domains (by fact count)\n\n`;
    for (const d of domains) {
        out += `- **${inert(d.name, 80)}** — ${d.categories} categories, ${d.facts} facts`;
        if (d.description)
            out += ` · ${inert(d.description, 160)}`;
        out += '\n';
    }
    out += `\n_Facts are not listed in summary mode. Pass \`domain\` and/or \`category\` to list facts (\`limit\` caps facts per category, default ${DEFAULT_FACT_LIMIT})._\n`;
    return out;
}
function buildDetail(db, domainFilter, categoryFilter, limit, includeRelations) {
    const domains = listDomains(db).filter((d) => !domainFilter || d.name.toLowerCase().includes(domainFilter));
    // Collect matches first so global truncation can report exact remainders.
    const matches = [];
    for (const domain of domains) {
        for (const category of listCategories(db, domain.id)) {
            if (categoryFilter && !category.name.toLowerCase().includes(categoryFilter))
                continue;
            matches.push({
                domainName: domain.name,
                domainDescription: domain.description,
                categoryId: category.id,
                categoryName: category.name,
                categoryDescription: category.description,
            });
        }
    }
    let out = `# Ontology Tree\n\n`;
    if (matches.length === 0) {
        out += `_No ontology data matched the filters (domain: ${domainFilter ?? '-'}, category: ${categoryFilter ?? '-'})._\n`;
        return out;
    }
    const rendered = matches.slice(0, MAX_CATEGORIES_RENDERED);
    let currentDomain = null;
    for (const m of rendered) {
        if (m.domainName !== currentDomain) {
            currentDomain = m.domainName;
            out += `## ${inert(m.domainName, 80)}\n`;
            if (m.domainDescription)
                out += `> ${inert(m.domainDescription, 200)}\n`;
            out += '\n';
        }
        const total = countCategoryFacts(db, m.categoryId);
        const facts = listCategoryFacts(db, m.categoryId, limit);
        out += `### ${inert(m.categoryName, 80)}`;
        if (m.categoryDescription)
            out += ` — ${inert(m.categoryDescription, 200)}`;
        out += `\n(showing ${facts.length} of ${total} facts)\n\n`;
        for (const fact of facts) {
            out += `- **[${fact.category}]** ${inert(fact.fact)}\n`;
            out += `  - ID: ${fact.id} | Confirmed: ${fact.consolidated_count}x | ${fact.created_at.slice(0, 10)}\n`;
            if (includeRelations) {
                const related = getRelatedFacts(db, fact.id, 1);
                for (const { fact: relFact, relation } of related.slice(0, MAX_RELATIONS_PER_FACT)) {
                    out += `  - ↔ [${relation.relation_type}] "${inert(relFact.fact, 160)}"\n`;
                }
                if (related.length > MAX_RELATIONS_PER_FACT) {
                    out += `  - _…+${related.length - MAX_RELATIONS_PER_FACT} more relations (use explore_graph for full traversal)._\n`;
                }
            }
        }
        if (total > facts.length) {
            out += `  _…+${total - facts.length} more facts in this category (raise \`limit\` or narrow the filter)._\n`;
        }
        out += '\n';
    }
    if (matches.length > rendered.length) {
        out += `\n_…+${matches.length - rendered.length} more categories matched — narrow \`domain\`/\`category\` to see them._\n`;
    }
    return out;
}
