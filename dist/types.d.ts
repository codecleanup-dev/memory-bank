export interface ToolCall {
    id: string;
    exchangeId: string;
    toolName: string;
    toolInput?: any;
    toolResult?: string;
    isError: boolean;
    timestamp: string;
}
export interface ConversationExchange {
    id: string;
    project: string;
    timestamp: string;
    userMessage: string;
    assistantMessage: string;
    archivePath: string;
    lineStart: number;
    lineEnd: number;
    parentUuid?: string;
    isSidechain?: boolean;
    sessionId?: string;
    cwd?: string;
    gitBranch?: string;
    claudeVersion?: string;
    thinkingLevel?: string;
    thinkingDisabled?: boolean;
    thinkingTriggers?: string;
    codingAgent?: string;
    toolCalls?: ToolCall[];
}
export interface SearchResult {
    exchange: ConversationExchange;
    similarity: number;
    snippet: string;
}
export interface MultiConceptResult {
    exchange: ConversationExchange;
    snippet: string;
    conceptSimilarities: number[];
    averageSimilarity: number;
}
export type FactCategory = 'decision' | 'preference' | 'pattern' | 'knowledge' | 'constraint';
export type FactScopeType = 'global' | 'project';
export type FactRelation = 'DUPLICATE' | 'CONTRADICTION' | 'EVOLUTION' | 'INDEPENDENT';
export interface Fact {
    id: string;
    fact: string;
    category: FactCategory;
    scope_type: FactScopeType;
    scope_project: string | null;
    source_exchange_ids: string[];
    embedding: Float32Array | null;
    created_at: string;
    updated_at: string;
    consolidated_count: number;
    is_active: boolean;
    ontology_category_id?: string | null;
    coding_agent?: string | null;
    confidence?: number | null;
    surprise?: number | null;
}
export interface FactRevision {
    id: string;
    fact_id: string;
    previous_fact: string;
    new_fact: string;
    reason: string | null;
    source_exchange_id: string | null;
    created_at: string;
}
export interface FactSearchResult {
    fact: Fact;
    similarity: number;
}
export interface ExtractedFact {
    fact: string;
    fact_kr?: string;
    category: FactCategory;
    scope_type: FactScopeType;
    confidence: number;
}
export interface ConsolidationResult {
    relation: FactRelation;
    merged_fact: string;
    reason: string;
}
export interface OntologyDomain {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
}
export interface OntologyCategory {
    id: string;
    domain_id: string;
    name: string;
    description: string | null;
    created_at: string;
}
/**
 * Relation vocabulary. The original four types skew heavily toward SUPPORTS
 * (measured 83% of 8,948 relations, 2026-07-07) because candidates come from
 * embedding-similar pairs. DEPENDS_ON / DERIVED_FROM cover the
 * prerequisite/derivation axis surfaced by the co-extraction channel.
 * Single source of truth — the DB CHECK constraint is generated from this list.
 */
export declare const RELATION_TYPES: readonly ["INFLUENCES", "SUPERSEDES", "SUPPORTS", "CONTRADICTS", "DEPENDS_ON", "DERIVED_FROM"];
export type RelationType = (typeof RELATION_TYPES)[number];
/**
 * Order-independent relation semantics: A SUPPORTS B carries the same claim
 * as B SUPPORTS A, and CONTRADICTS is inherently mutual — an
 * opposite-direction duplicate of these is pure noise. Every other type is
 * directional: the reverse edge is a DISTINCT claim (dependency cycle,
 * competing canonicality, mutual derivation) that dedup must not swallow.
 */
export declare const SYMMETRIC_RELATION_TYPES: ReadonlySet<RelationType>;
export interface OntologyRelation {
    id: string;
    source_fact_id: string;
    relation_type: RelationType;
    target_fact_id: string;
    reasoning: string | null;
    created_at: string;
}
export interface AvatarResponse {
    answer: string;
    sources: Array<{
        fact: Fact;
        domain: string;
        category: string;
        relevance: number;
    }>;
    confidence: number;
    relatedDecisions: Array<{
        fact: Fact;
        relation: RelationType;
    }>;
}
export interface DomainTree {
    domain: OntologyDomain;
    categories: Array<{
        category: OntologyCategory;
        facts: Fact[];
    }>;
}
