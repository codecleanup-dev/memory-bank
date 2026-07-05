/**
 * Call Haiku via Claude Agent SDK (no API key needed inside Claude Code —
 * billed to the local subscription, NOT a metered API key).
 * Falls back to direct Anthropic SDK only if ANTHROPIC_API_KEY is set
 * (standalone use outside Claude Code).
 */
export declare function callHaiku(systemPrompt: string, userMessage: string, maxTokens?: number): Promise<string>;
export declare function parseJsonResponse<T>(text: string): T | null;
