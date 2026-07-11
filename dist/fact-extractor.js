import { callHaiku, parseJsonResponse } from './llm.js';
import { insertFact } from './fact-db.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { classifyAndLinkFact } from './ontology-classifier.js';
export const EXTRACTION_SYSTEM_PROMPT = `You are an expert at extracting long-term facts from conversations.

## Rules
- 1 fact = 1 sentence (concise)
- Ignore trivial exchanges (greetings, "yes", "thanks")
- Code snippets are NOT facts - extract only decisions/patterns
- No duplicate facts within the same batch
- Prefer durable facts (decisions, conventions, constraints, lessons) over
  session-ephemeral details ("user is currently editing file X" is NOT a fact)
- Capture problem→solution lessons as "pattern"
  (e.g., "X error in this project is caused by Y and fixed by Z")

## scope determination
- project: specific files/paths/DB/API/framework/business logic
- global: coding style, language/response format, common tool usage

## Output format (JSON array)
[
  {
    "fact": "User uses Riverpod for state management",
    "fact_kr": "사용자는 상태 관리에 Riverpod을 사용한다",
    "category": "decision",
    "scope_type": "project",
    "confidence": 0.9
  }
]

## fact_kr rules
- Natural Korean translation of "fact"
- Keep technical terms (API/tool/framework names, file paths, commands) in English

## category choices
- decision: architecture/technology decisions
- preference: user preferences
- pattern: repeated patterns
- knowledge: project knowledge
- constraint: constraints

## confidence criteria
- 0.9+: explicit decision/declaration
- 0.7-0.9: inferred from behavior
- Below 0.7: do not extract`;
const BATCH_SIZE = 5; // configurable-ok
const MAX_FACTS_PER_SESSION = 20; // configurable-ok
const CONFIDENCE_THRESHOLD = 0.7; // configurable-ok
const DEFAULT_MAX_LLM_CALLS = 12; // configurable-ok — per-session LLM call budget
/** Trivial acknowledgements (EN/KR) that carry no extractable signal. */
const TRIVIAL_USER_PATTERN = /^(ok(ay)?|yes|no|y|n|thanks?|thank you|good|nice|great|done|go|proceed|continue|응|넵?|네|예|아니오?|ㅇㅇ|ㅇㅋ|ㄱㄱ|좋아요?|그래|고마워요?|감사(합니다|해요)?|해줘|진행해?줘?|계속(해줘)?)[.!~\s]*$/i;
/**
 * Whether an exchange is worth sending to the extraction LLM.
 * Filters harness artifacts (local command output), bare slash commands,
 * and trivial acknowledgements — they waste LLM calls and produce noise facts.
 */
export function isSubstantiveExchange(userMessage, assistantMessage) {
    const user = (userMessage ?? '').trim();
    const assistant = (assistantMessage ?? '').trim();
    if (!user)
        return false;
    // Harness/system artifacts injected as user turns, not human input
    if (user.startsWith('<local-command-stdout>') ||
        user.startsWith('<local-command-caveat>') ||
        user.startsWith('<command-name>') ||
        user.startsWith('Caveat:'))
        return false;
    // Bare slash commands like /clear, /model, /codex:review
    if (/^\/[\w:-]+$/.test(user))
        return false;
    // Trivial acknowledgement with no substantive reply
    if (TRIVIAL_USER_PATTERN.test(user) && assistant.length < 200)
        return false;
    // Near-empty prompt with a near-empty answer
    if (user.length < 5 && assistant.length < 80)
        return false;
    return true;
}
/** Normalize fact text for cross-batch duplicate detection within a session. */
export function normalizeFactText(fact) {
    return fact.toLowerCase().replace(/\s+/g, ' ').replace(/[.!。]+$/g, '').trim();
}
/**
 * Confidence gate for extracted facts. Rejects missing/NaN confidence —
 * `undefined < 0.7` is false, so a naive `<` check would accept unscored
 * facts from malformed LLM output.
 */
export function passesConfidenceGate(confidence) {
    return typeof confidence === 'number'
        && !Number.isNaN(confidence)
        && confidence >= CONFIDENCE_THRESHOLD;
}
/**
 * Cap LLM calls for long sessions by picking evenly spread batches, so the
 * beginning, middle, and end of a session are all represented instead of
 * only the head.
 */
export function selectSpreadBatches(batches, maxBatches) {
    if (batches.length <= maxBatches)
        return batches;
    if (maxBatches <= 1)
        return [batches[0]];
    const selected = [];
    const step = (batches.length - 1) / (maxBatches - 1);
    const used = new Set();
    for (let i = 0; i < maxBatches; i++) {
        const idx = Math.round(i * step);
        if (!used.has(idx)) {
            used.add(idx);
            selected.push(batches[idx]);
        }
    }
    return selected;
}
function maxLlmCallsPerSession() {
    const parsed = parseInt(process.env.MEMORY_BANK_MAX_EXTRACT_CALLS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LLM_CALLS;
}
// Self-referential repos whose conversations must NOT be extracted (e.g.
// memory-bank's own monitoring/cron sessions — extracting them creates noise
// facts and an endless feedback loop). Comma-separated cwd paths, env-overridable.
const EXCLUDE_PROJECTS = (process.env.BACKFILL_EXCLUDE_PROJECTS ||
    '/Users/jung-wankim/Project/Claude/memory-bank')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
function isExcludedProject(project) {
    if (!project)
        return false;
    return EXCLUDE_PROJECTS.some((p) => project === p || project.startsWith(p));
}
export function buildExtractionPrompt(exchanges) {
    return exchanges.map((ex, i) => {
        const userSnippet = ex.user_message.slice(0, 1000);
        const assistantSnippet = ex.assistant_message.slice(0, 1000);
        return `### Exchange ${i + 1}\nUser: ${userSnippet}\nAssistant: ${assistantSnippet}`;
    }).join('\n\n');
}
export async function extractFactsFromExchanges(db, sessionId) {
    const exchanges = db.prepare(`
    SELECT id, user_message, assistant_message
    FROM exchanges
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(sessionId);
    const substantive = exchanges.filter(ex => isSubstantiveExchange(ex.user_message, ex.assistant_message));
    if (substantive.length === 0)
        return [];
    const batches = [];
    for (let i = 0; i < substantive.length; i += BATCH_SIZE) {
        batches.push(substantive.slice(i, i + BATCH_SIZE));
    }
    const selectedBatches = selectSpreadBatches(batches, maxLlmCallsPerSession());
    const allFacts = [];
    const seen = new Set();
    for (let b = 0; b < selectedBatches.length; b++) {
        if (allFacts.length >= MAX_FACTS_PER_SESSION)
            break;
        const prompt = buildExtractionPrompt(selectedBatches[b]);
        try {
            const response = await callHaiku(EXTRACTION_SYSTEM_PROMPT, prompt);
            const extracted = parseJsonResponse(response);
            if (extracted && Array.isArray(extracted)) {
                for (const fact of extracted) {
                    if (typeof fact?.fact !== 'string' || fact.fact.trim() === '')
                        continue;
                    if (!passesConfidenceGate(fact.confidence))
                        continue;
                    if (allFacts.length >= MAX_FACTS_PER_SESSION)
                        break;
                    const key = normalizeFactText(fact.fact);
                    if (seen.has(key))
                        continue; // cross-batch duplicate within this session
                    seen.add(key);
                    allFacts.push(fact);
                }
            }
        }
        catch (error) {
            console.error(`Batch ${b} extraction failed:`, error);
        }
    }
    return allFacts;
}
export async function saveExtractedFacts(db, facts, project, sourceExchangeIds, codingAgent) {
    await initEmbeddings();
    const savedIds = [];
    for (const fact of facts) {
        const embedding = await generateEmbedding(fact.fact);
        const embeddingKr = fact.fact_kr ? await generateEmbedding(fact.fact_kr) : null;
        const id = insertFact(db, {
            fact: fact.fact,
            category: fact.category,
            scope_type: fact.scope_type,
            scope_project: fact.scope_type === 'project' ? project : null,
            source_exchange_ids: sourceExchangeIds,
            embedding,
            coding_agent: codingAgent,
            fact_kr: fact.fact_kr ?? null,
            embedding_kr: embeddingKr,
        });
        savedIds.push(id);
        // Ontology classification + relation detection (must await to prevent DB close race)
        try {
            await classifyAndLinkFact(db, id, embedding);
        }
        catch (err) {
            console.error(`Ontology pipeline failed for fact ${id}:`, err);
        }
    }
    return savedIds;
}
export async function runFactExtraction(db, sessionId, project, codingAgent) {
    // Skip self-referential repos (memory-bank's own monitoring sessions) — mark
    // as processed with zero facts so they are never re-attempted, no LLM calls.
    if (isExcludedProject(project)) {
        try {
            db.prepare(`
        INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
        VALUES (?, ?, 0, 0)
        ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
          extracted = 0, saved = 0
      `).run(sessionId, new Date().toISOString());
        }
        catch { /* log table may not exist on very old DBs */ }
        return { extracted: 0, saved: 0 };
    }
    const facts = await extractFactsFromExchanges(db, sessionId);
    let saved = 0;
    if (facts.length > 0) {
        // Detect coding agent from session's exchanges if not provided
        const agent = codingAgent || detectAgentFromSession(db, sessionId);
        const exchangeIds = db.prepare('SELECT id FROM exchanges WHERE session_id = ?').all(sessionId).map(r => r.id);
        saved = (await saveExtractedFacts(db, facts, project, exchangeIds, agent)).length;
    }
    // Record the session as processed (idempotency marker shared by the
    // SessionEnd hook and the cross-project backfill worker).
    try {
        db.prepare(`
      INSERT INTO extraction_log (session_id, processed_at, extracted, saved)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET processed_at = excluded.processed_at,
        extracted = excluded.extracted, saved = excluded.saved
    `).run(sessionId, new Date().toISOString(), facts.length, saved);
    }
    catch {
        // log table may not exist on very old DBs — extraction result still stands
    }
    return { extracted: facts.length, saved };
}
/**
 * Detect the coding agent from a session's exchanges.
 * Returns the coding_agent of the first exchange in the session, or 'claude-code' as default.
 */
function detectAgentFromSession(db, sessionId) {
    const row = db.prepare('SELECT coding_agent FROM exchanges WHERE session_id = ? LIMIT 1').get(sessionId);
    return row?.coding_agent || 'claude-code';
}
