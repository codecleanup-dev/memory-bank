import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolated working directory for headless Agent SDK sessions. The CLI that
// query() spawns persists a transcript under ~/.claude/projects/<cwd-slug>/;
// running it from the caller's cwd drops worker transcripts into that
// project's dir, where a user `claude --resume` can pick one up as their own
// session (observed 2026-07-05). A dedicated cwd keeps them in their own slug.
const LLM_WORKDIR = path.join(os.tmpdir(), 'memory-bank-llm');
function llmWorkdir(): string {
  try {
    fs.mkdirSync(LLM_WORKDIR, { recursive: true });
  } catch {
    /* fall through — SDK will spawn in process cwd */
  }
  return LLM_WORKDIR;
}

/**
 * Call Haiku via Claude Agent SDK (no API key needed inside Claude Code —
 * billed to the local subscription, NOT a metered API key).
 * Falls back to direct Anthropic SDK only if ANTHROPIC_API_KEY is set
 * (standalone use outside Claude Code).
 */
export async function callHaiku(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 2048,
): Promise<string> {
  const model = process.env.MEMORY_BANK_FACT_MODEL || 'haiku';

  // Try Claude Agent SDK first (works inside Claude Code without API key)
  try {
    for await (const message of query({
      prompt: `${systemPrompt}\n\n${userMessage}`,
      options: {
        model,
        max_tokens: maxTokens,
        systemPrompt,
        // One-shot classification calls: no tools/turn loops needed, and the
        // spawned session must NOT load user settings/plugins — otherwise its
        // own SessionStart/End hooks re-spawn sync/backfill workers and every
        // LLM call cascades into more sessions (observed as a proxy flood).
        maxTurns: 1,
        settingSources: [],
        cwd: llmWorkdir(),
      } as any,
    })) {
      if (message && typeof message === 'object' && 'type' in message && (message as any).type === 'result') {
        return (message as any).result || '';
      }
    }
    return '';
  } catch (agentSdkError) {
    // Fallback to direct Anthropic SDK if agent SDK fails (standalone mode)
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.MEMORY_BANK_API_TOKEN;
    if (!apiKey) {
      throw new Error(`LLM call failed: ${agentSdkError instanceof Error ? agentSdkError.message : agentSdkError}`);
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const baseURL = process.env.MEMORY_BANK_API_BASE_URL;
    const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });

    const response = await client.messages.create({
      model: process.env.MEMORY_BANK_FACT_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b: any) => b.type === 'text');
    return (textBlock as any)?.text || '';
  }
}

export function parseJsonResponse<T>(text: string): T | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
    || text.match(/(\[[\s\S]*\])/)
    || text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    console.error('parseJsonResponse: no JSON found in LLM response:', text.substring(0, 200));
    return null;
  }

  try {
    return JSON.parse(jsonMatch[1]) as T;
  } catch (e) {
    console.error('parseJsonResponse: invalid JSON:', (e as Error).message, jsonMatch[1].substring(0, 200));
    return null;
  }
}
