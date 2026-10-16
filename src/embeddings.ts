import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';
import { adoptStableModelCache, currentModelCacheDir, notifyModelLoaded } from './runtime-assets.js';

/**
 * Multilingual retrieval model (Korean/English/100 langs), 384-dim — same
 * dimension as the original all-MiniLM-L6-v2 so vec tables are unchanged.
 *
 * Model selection (2026-06-12, measured on real-DB Korean/English pairs):
 *   - all-MiniLM-L6-v2: English-only — Korean queries score ~0 vs English facts
 *   - paraphrase-multilingual-MiniLM-L12-v2: top-1 ranking broke on real data
 *     (unrelated Korean pairs up to 0.82 — strong anisotropy)
 *   - multilingual-e5-small: perfect top-1 ranking on the hard set; absolute
 *     scores are compressed (~0.72-0.99) so consumers use either retuned
 *     thresholds (passage↔passage) or probe-baseline normalization (queries).
 *
 * e5 protocol: queries are embedded with a "query: " prefix, stored content
 * with "passage: ". Pass the mode explicitly at call sites.
 *
 * Vectors from different models are NOT comparable; EMBEDDING_VERSION tracks
 * which model produced a stored vector and the re-embed worker upgrades rows.
 */
const DEFAULT_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small';

export const EMBEDDING_MODEL =
  process.env.MEMORY_BANK_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;

/**
 * Curated model → version map:
 *   1 = all-MiniLM-L6-v2 (English-only)
 *   2 = paraphrase-multilingual-MiniLM-L12-v2 (rejected — anisotropy)
 *   3 = multilingual-e5-small (query/passage prefixes)
 *
 * The version is DERIVED from the model so a MEMORY_BANK_EMBEDDING_MODEL
 * override can never poison stored vectors: an unknown model gets its own
 * deterministic version (1000+), so switching back later re-embeds those
 * rows instead of silently mixing incompatible vector spaces.
 */
const KNOWN_MODEL_VERSIONS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2': 1,
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 2,
  [DEFAULT_EMBEDDING_MODEL]: 3,
};

function modelVersion(model: string): number {
  const known = KNOWN_MODEL_VERSIONS[model];
  if (known !== undefined) return known;
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return 1000 + (h % 1000000);
}

export const EMBEDDING_VERSION = modelVersion(EMBEDDING_MODEL);

export type EmbeddingMode = 'query' | 'passage';

let embeddingPipeline: FeatureExtractionPipeline | null = null;

export async function initEmbeddings(): Promise<void> {
  if (!embeddingPipeline) {
    // Read the model from the stable mirror when a complete one exists, so a
    // swept plugin directory cannot break this lazy first load. This only
    // ADOPTS a mirror; it never copies. Mirroring is done by the MCP server's
    // post-initialize warm-up (see runtime-assets.ts) because this function
    // also runs before the initialize handshake (inject daemon pre-warm) and
    // must not block it.
    adoptStableModelCache(EMBEDDING_MODEL);
    const cacheDirUsed = currentModelCacheDir();
    // stderr: stdout of hook scripts is injected into the session as context,
    // so progress logs must never go to stdout.
    console.error(`Loading embedding model ${EMBEDDING_MODEL} (first run may take time)...`);
    embeddingPipeline = await pipeline(
      'feature-extraction',
      EMBEDDING_MODEL
    );
    console.error('Embedding model loaded');
    // A built pipeline is the proof that every required file is in that cache
    // dir: publish it to the stable mirror (now, or after the MCP handshake).
    notifyModelLoaded(EMBEDDING_MODEL, cacheDirUsed);
  }
}

function applyModePrefix(text: string, mode: EmbeddingMode): string {
  // e5-family models require asymmetric prefixes; other models take raw text.
  if (EMBEDDING_MODEL.toLowerCase().includes('e5')) {
    return `${mode}: ${text}`;
  }
  return text;
}

// Small LRU memo for query embeddings. One MCP search embeds the SAME query
// text twice (searchConversations + getKnowledgeContext), each costing a full
// model inference (~35ms measured) — the memo collapses that to one. Also
// covers a user re-running the same query. 'query' mode only: passage-mode
// callers embed unique content (indexing), where a memo is pure overhead.
const QUERY_EMBED_MEMO_MAX = 32;
const queryEmbedMemo = new Map<string, number[]>();

/**
 * @param mode 'passage' for stored/indexed content (facts, exchanges),
 *             'query' for search queries. Defaults to 'passage' because most
 *             call sites embed content; search paths must pass 'query'.
 */
export async function generateEmbedding(text: string, mode: EmbeddingMode = 'passage'): Promise<number[]> {
  if (mode === 'query') {
    const hit = queryEmbedMemo.get(text);
    if (hit) {
      // refresh LRU position
      queryEmbedMemo.delete(text);
      queryEmbedMemo.set(text, hit);
      return hit.slice();
    }
  }

  if (!embeddingPipeline) {
    await initEmbeddings();
  }

  // Truncate text to avoid token limits (512 tokens max for this model)
  const truncated = applyModePrefix(text.substring(0, 2000), mode);

  const output = await embeddingPipeline!(truncated, {
    pooling: 'mean',
    normalize: true
  });

  const embedding = Array.from(output.data) as number[];
  if (mode === 'query') {
    queryEmbedMemo.set(text, embedding.slice());
    if (queryEmbedMemo.size > QUERY_EMBED_MEMO_MAX) {
      queryEmbedMemo.delete(queryEmbedMemo.keys().next().value as string);
    }
  }
  return embedding;
}

export async function generateExchangeEmbedding(
  userMessage: string,
  assistantMessage: string,
  toolNames?: string[]
): Promise<number[]> {
  // Combine user question, assistant answer, and tools used for better searchability
  let combined = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;

  // Include tool names in embedding for tool-based searches
  if (toolNames && toolNames.length > 0) {
    combined += `\n\nTools: ${toolNames.join(', ')}`;
  }

  return generateEmbedding(combined, 'passage');
}

/**
 * Query-side anisotropy normalization (probe baseline).
 *
 * e5 similarity scores sit in a compressed band (~0.72-0.9 even for unrelated
 * pairs), so a fixed absolute threshold cannot separate relevant from
 * irrelevant. Instead, compare each query↔fact score against the query's own
 * baseline: its best similarity to a fixed set of neutral "background probe"
 * sentences. A fact is relevant only if it beats that baseline by a margin
 * (measured: related pairs +0.047~+0.123, unrelated pairs -0.028~-0.091).
 */
export const BACKGROUND_PROBES = [
  '오늘 날씨가 참 좋네요',
  '주말에 뭐 할지 고민 중이야',
  '맛있는 저녁 식사를 했다',
  'The weather is nice today',
  'I went for a walk in the park',
  '음악을 들으면서 휴식을 취했다',
  '새로운 취미를 시작해볼까 생각 중',
  'Let me think about what to do next',
];

let probeEmbeddings: number[][] | null = null;

/** Max cosine similarity between the query embedding and the background probes. */
export async function queryBaseline(queryEmbedding: number[]): Promise<number> {
  if (!probeEmbeddings) {
    probeEmbeddings = [];
    for (const p of BACKGROUND_PROBES) {
      probeEmbeddings.push(await generateEmbedding(p, 'passage'));
    }
  }
  let max = -1;
  for (const probe of probeEmbeddings) {
    let dot = 0;
    for (let i = 0; i < probe.length; i++) dot += probe[i] * queryEmbedding[i];
    if (dot > max) max = dot;
  }
  return max;
}
