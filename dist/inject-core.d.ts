/**
 * Compute the UserPromptSubmit context block for a prompt: top-K similar
 * facts gated by the probe baseline, expanded with 1-hop ontology relations,
 * plus repeated-prompt detection. Returns '' when there is nothing to inject.
 *
 * Shared by BOTH execution paths:
 *  - the warm in-process daemon inside the MCP server (embeddings already
 *    loaded → ~150ms), and
 *  - the cold fallback in scripts/inject-context.js (fresh node process,
 *    ~2.3s dominated by model load) used when no MCP server is running.
 *
 * `via` tags the inject log so the two paths stay distinguishable.
 */
export declare function computeInjectContext(userPrompt: string, project: string, via: 'daemon' | 'fallback'): Promise<string>;
