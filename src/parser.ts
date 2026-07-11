import readline from 'readline';
import path from 'path';
import { ConversationExchange, ToolCall } from './types.js';
import crypto from 'crypto';
import { createArchiveReadStream } from './archive-io.js';

interface JSONLMessage {
  type: string;
  message?: {
    role: 'user' | 'assistant';
    content: string | Array<any>;
  };
  timestamp?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  thinkingMetadata?: {
    level?: string;
    disabled?: boolean;
    triggers?: Array<any>;
  };
}

// Router: detect harness (Claude vs Codex) then dispatch to the right parser.
export async function parseConversation(
  filePath: string,
  projectName: string,
  archivePath: string
): Promise<ConversationExchange[]> {
  const harness = await detectConversationHarness(filePath);
  if (harness === 'codex') {
    return parseCodexConversation(filePath, projectName, archivePath);
  }
  return parseClaudeConversation(filePath, projectName, archivePath);
}

async function parseClaudeConversation(
  filePath: string,
  projectName: string,
  archivePath: string
): Promise<ConversationExchange[]> {
  const exchanges: ConversationExchange[] = [];
  const fileStream = createArchiveReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  let currentExchange: {
    userMessage: string;
    userLine: number;
    assistantMessages: string[];
    lastAssistantLine: number;
    timestamp: string;
    parentUuid?: string;
    isSidechain?: boolean;
    sessionId?: string;
    cwd?: string;
    gitBranch?: string;
    claudeVersion?: string;
    thinkingLevel?: string;
    thinkingDisabled?: boolean;
    thinkingTriggers?: string;
    toolCalls: ToolCall[];
  } | null = null;

  const finalizeExchange = () => {
    if (currentExchange && currentExchange.assistantMessages.length > 0) {
      const exchangeId = crypto
        .createHash('md5')
        .update(`${archivePath}:${currentExchange.userLine}-${currentExchange.lastAssistantLine}`)
        .digest('hex');

      // Update tool call exchange IDs
      const toolCalls = currentExchange.toolCalls.map(tc => ({
        ...tc,
        exchangeId
      }));

      const exchange: ConversationExchange = {
        id: exchangeId,
        project: projectName,
        timestamp: currentExchange.timestamp,
        userMessage: currentExchange.userMessage,
        assistantMessage: currentExchange.assistantMessages.join('\n\n'),
        archivePath,
        lineStart: currentExchange.userLine,
        lineEnd: currentExchange.lastAssistantLine,
        parentUuid: currentExchange.parentUuid,
        isSidechain: currentExchange.isSidechain,
        sessionId: currentExchange.sessionId,
        cwd: currentExchange.cwd,
        gitBranch: currentExchange.gitBranch,
        claudeVersion: currentExchange.claudeVersion,
        thinkingLevel: currentExchange.thinkingLevel,
        thinkingDisabled: currentExchange.thinkingDisabled,
        thinkingTriggers: currentExchange.thinkingTriggers,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      };
      exchanges.push(exchange);
    }
  };

  for await (const line of rl) {
    lineNumber++;

    try {
      const parsed: JSONLMessage = JSON.parse(line);

      // Skip non-message types
      if (parsed.type !== 'user' && parsed.type !== 'assistant') {
        continue;
      }

      if (!parsed.message) {
        continue;
      }

      // Extract text from message content
      let text = '';
      const toolCalls: ToolCall[] = [];

      if (typeof parsed.message.content === 'string') {
        text = parsed.message.content;
      } else if (Array.isArray(parsed.message.content)) {
        // Extract text blocks
        const textBlocks = parsed.message.content
          .filter(block => block.type === 'text' && block.text)
          .map(block => block.text);
        text = textBlocks.join('\n');

        // Extract tool use blocks
        if (parsed.message.role === 'assistant') {
          for (const block of parsed.message.content) {
            if (block.type === 'tool_use') {
              const toolCallId = crypto.randomUUID();
              toolCalls.push({
                id: toolCallId,
                exchangeId: '', // Will be set when we know the exchange ID
                toolName: block.name || 'unknown',
                toolInput: block.input,
                isError: false,
                timestamp: parsed.timestamp || new Date().toISOString()
              });
            }
          }
        }

        // Tool RESULTS are intentionally not associated back to their tool_use
        // here. The tool_calls table therefore stores tool_name + tool_input
        // only; `tool_result` stays NULL and `is_error` stays 0 for every row.
        // This is fine because NO feature reads those two columns — embeddings
        // include tool NAMES only ("Tools: a, b"), search shows name counts, and
        // the `read` tool returns the raw archive (which has full results). If a
        // future feature needs real result/error data, MATCH tool_result blocks
        // to the preceding tool_use by tool_use_id and populate both columns —
        // do NOT trust the current always-0 `is_error`.
      }

      // Skip empty messages
      if (!text.trim() && toolCalls.length === 0) {
        continue;
      }

      if (parsed.message.role === 'user') {
        // Finalize previous exchange before starting new one
        finalizeExchange();

        // Start new exchange
        currentExchange = {
          userMessage: text || '(tool results only)',
          userLine: lineNumber,
          assistantMessages: [],
          lastAssistantLine: lineNumber,
          timestamp: parsed.timestamp || new Date().toISOString(),
          parentUuid: parsed.parentUuid,
          isSidechain: parsed.isSidechain,
          sessionId: parsed.sessionId,
          cwd: parsed.cwd,
          gitBranch: parsed.gitBranch,
          claudeVersion: parsed.version,
          thinkingLevel: parsed.thinkingMetadata?.level,
          thinkingDisabled: parsed.thinkingMetadata?.disabled,
          thinkingTriggers: parsed.thinkingMetadata?.triggers ? JSON.stringify(parsed.thinkingMetadata.triggers) : undefined,
          toolCalls: []
        };
      } else if (parsed.message.role === 'assistant' && currentExchange) {
        // Accumulate assistant messages
        if (text.trim()) {
          currentExchange.assistantMessages.push(text);
        }
        currentExchange.lastAssistantLine = lineNumber;

        // Add tool calls to current exchange
        if (toolCalls.length > 0) {
          currentExchange.toolCalls.push(...toolCalls);
        }

        // Update timestamp to last assistant message
        if (parsed.timestamp) {
          currentExchange.timestamp = parsed.timestamp;
        }

        // Update metadata from assistant messages (use most recent)
        if (parsed.sessionId) currentExchange.sessionId = parsed.sessionId;
        if (parsed.cwd) currentExchange.cwd = parsed.cwd;
        if (parsed.gitBranch) currentExchange.gitBranch = parsed.gitBranch;
        if (parsed.version) currentExchange.claudeVersion = parsed.version;
      }
    } catch (error) {
      // Skip malformed JSON lines
      continue;
    }
  }

  // Finalize last exchange
  finalizeExchange();

  return exchanges;
}

// ── Codex rollout support (ported from episodic-memory 1.4.2) ───────────────
// Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl with a different
// line schema: {type: 'response_item'|'session_meta'|'turn_context', payload}.
// We map it onto the same ConversationExchange shape; coding_agent='codex'.
interface CodexRolloutLine {
  timestamp?: string;
  type?: string;
  payload?: any;
}

const CODEX_LINE_TYPES = new Set([
  'session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted',
]);

async function detectConversationHarness(filePath: string): Promise<'claude' | 'codex'> {
  const fileStream = createArchiveReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  // Scan a bounded window of lines rather than deciding on the first one: a
  // single leading line that matches neither shape (format drift, blank-ish
  // preamble) must not misclassify and silently drop the whole session.
  let scanned = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line) as CodexRolloutLine;
      } catch {
        continue;
      }
      // Codex rollout lines carry a payload and a codex-specific type.
      if (parsed && parsed.payload && CODEX_LINE_TYPES.has(parsed.type)) {
        return 'codex';
      }
      // Claude transcript lines are type 'user'/'assistant' with a message.
      if (parsed && (parsed.type === 'user' || parsed.type === 'assistant') && parsed.message) {
        return 'claude';
      }
      // Neither shape yet — keep scanning up to a bounded number of lines.
      if (++scanned >= 40) break;
    }
  } finally {
    // Detection returns early after the first non-empty line, so the readline
    // interface never drains the stream. rl.close() alone leaves the underlying
    // file descriptor open — destroy the stream too, or a large backfill
    // (hundreds of codex sessions) exhausts the FD ulimit and crashes (EMFILE).
    rl.close();
    (fileStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  }
  return 'claude';
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(block => block && typeof block === 'object' && typeof (block as any).text === 'string')
    .map(block => (block as any).text)
    .join('\n');
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringifyToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) {
    return undefined;
  }
  if (typeof output === 'string') {
    return output;
  }
  const text = extractTextFromContent(output);
  if (text.trim()) {
    return text;
  }
  return JSON.stringify(output);
}

function projectFromCwd(cwd?: string): string | undefined {
  if (!cwd) {
    return undefined;
  }
  const project = path.basename(cwd);
  return project || undefined;
}

/**
 * Encode an absolute path to the canonical project key used across the index —
 * the same transform the non-codex projects directory uses: every
 * non-alphanumeric character (including '/' and '.') becomes '-'. So
 * /Users/me/my.project → -Users-me-my-project, matching the projects dir-name
 * form. Codex records only a cwd; this maps it to the shared key so a single
 * exclude entry (in that canonical form) applies across agents. Basename is
 * deliberately NOT used as a key — it collides across unrelated paths.
 *
 * Trailing slashes are stripped so /x/secret and /x/secret/ yield one key.
 * Matching is otherwise on the recorded path string: NO symlink/realpath
 * resolution and NO case folding — on purpose. The non-codex projects key
 * encodes the literal project path the same way; resolving symlinks or folding
 * case here would DIVERGE from that key and break cross-agent exclusion, so an
 * exclude entry must use the same canonical path the agent records.
 */
export function encodeProjectPath(absPath: string): string {
  const trimmed = absPath.replace(/\/+$/, '') || absPath;
  return trimmed.replace(/[^a-zA-Z0-9]/g, '-');
}

interface CodexExchangeBuilder {
  project: string;
  userMessage: string;
  userLine: number;
  assistantMessages: string[];
  lastAssistantLine: number;
  timestamp: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  toolCalls: ToolCall[];
}

async function parseCodexConversation(
  filePath: string,
  projectName: string,
  archivePath: string
): Promise<ConversationExchange[]> {
  const exchanges: ConversationExchange[] = [];
  const fileStream = createArchiveReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let currentExchange: CodexExchangeBuilder | null = null;
  const toolCallsByCallId = new Map<string, ToolCall>();

  const currentProject = () => projectFromCwd(cwd) || projectName;

  const applyMetadataToCurrentExchange = () => {
    if (!currentExchange) return;
    currentExchange.project = currentProject();
    currentExchange.sessionId = sessionId;
    currentExchange.cwd = cwd;
    currentExchange.gitBranch = gitBranch;
  };

  const finalizeExchange = () => {
    if (currentExchange && currentExchange.assistantMessages.length > 0) {
      applyMetadataToCurrentExchange();
      const exchangeId = crypto
        .createHash('md5')
        .update(`${archivePath}:${currentExchange.userLine}-${currentExchange.lastAssistantLine}`)
        .digest('hex');

      const toolCalls = currentExchange.toolCalls.map(tc => ({ ...tc, exchangeId }));

      exchanges.push({
        id: exchangeId,
        project: currentExchange.project,
        timestamp: currentExchange.timestamp,
        userMessage: currentExchange.userMessage,
        assistantMessage: currentExchange.assistantMessages.join('\n\n'),
        archivePath,
        lineStart: currentExchange.userLine,
        lineEnd: currentExchange.lastAssistantLine,
        sessionId: currentExchange.sessionId,
        cwd: currentExchange.cwd,
        gitBranch: currentExchange.gitBranch,
        codingAgent: 'codex',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
      });
    }
    currentExchange = null;
    toolCallsByCallId.clear();
  };

  const startExchange = (text: string, timestamp: string) => {
    finalizeExchange();
    currentExchange = {
      project: currentProject(),
      userMessage: text,
      userLine: lineNumber,
      assistantMessages: [],
      lastAssistantLine: lineNumber,
      timestamp,
      sessionId,
      cwd,
      gitBranch,
      toolCalls: []
    };
  };

  const appendToolCall = (payload: any, timestamp: string) => {
    if (!currentExchange) return;
    const callId = payload.call_id || crypto.randomUUID();
    let toolInput: unknown = payload.arguments;
    if (typeof toolInput === 'string') {
      toolInput = safeParseJson(toolInput);
    } else if (payload.input !== undefined) {
      toolInput = payload.input;
    } else if (payload.action !== undefined) {
      toolInput = payload.action;
    }
    const toolCall: ToolCall = {
      id: callId,
      exchangeId: '',
      toolName: payload.name || payload.namespace || payload.type || 'unknown',
      toolInput,
      isError: false,
      timestamp
    };
    currentExchange.toolCalls.push(toolCall);
    toolCallsByCallId.set(callId, toolCall);
    currentExchange.lastAssistantLine = lineNumber;
  };

  const appendToolResult = (payload: any) => {
    const callId = payload.call_id;
    if (!callId) return;
    const toolCall = toolCallsByCallId.get(callId);
    if (!toolCall) return;
    const output = stringifyToolOutput(payload.output);
    if (output !== undefined) {
      toolCall.toolResult = output;
    }
    if (currentExchange) {
      currentExchange.lastAssistantLine = lineNumber;
    }
  };

  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as CodexRolloutLine;
      const payload = parsed.payload;
      const timestamp = parsed.timestamp || new Date().toISOString();

      if (parsed.type === 'session_meta' && payload) {
        sessionId = payload.id || sessionId;
        cwd = payload.cwd || cwd;
        gitBranch = payload.git?.branch || gitBranch;
        applyMetadataToCurrentExchange();
        continue;
      }

      if (parsed.type === 'turn_context' && payload) {
        cwd = payload.cwd || cwd;
        applyMetadataToCurrentExchange();
        continue;
      }

      if (parsed.type !== 'response_item' || !payload) {
        continue;
      }

      if (payload.type === 'message') {
        const text = extractTextFromContent(payload.content);
        if (!text.trim()) continue;

        if (payload.role === 'user') {
          startExchange(text, timestamp);
        } else if (payload.role === 'assistant') {
          // Assertion mirrors episodic-memory: closures above defeat TS's
          // control-flow narrowing, leaving currentExchange typed as never.
          const exchange = currentExchange as CodexExchangeBuilder | null;
          if (exchange) {
            exchange.assistantMessages.push(text);
            exchange.lastAssistantLine = lineNumber;
            exchange.timestamp = timestamp;
          }
        }
      } else if (
        payload.type === 'function_call' ||
        payload.type === 'custom_tool_call' ||
        payload.type === 'tool_search_call' ||
        payload.type === 'local_shell_call'
      ) {
        appendToolCall(payload, timestamp);
      } else if (
        payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output' ||
        payload.type === 'tool_search_output' ||
        payload.type === 'local_shell_call_output'
      ) {
        appendToolResult(payload);
      }
    } catch {
      continue;
    }
  }

  finalizeExchange();
  return exchanges;
}

/**
 * Determine a Codex rollout's project from its recorded cwd. Needed because
 * Codex files live under YYYY/MM/DD (the path carries no project name) — the
 * real project comes from session_meta/turn_context cwd.
 *
 * Privacy-critical: scans the ENTIRE file, not a leading window. A rollout can
 * run in an allowed project for many lines and then `cd` into an excluded one;
 * a bounded window would miss that and let copyIfNewer write the raw transcript
 * (post-cd secret content included) into the archive, where it stays reachable
 * via the `read` tool even though the index-time guard hides the exchanges. So:
 * if ANY cwd anywhere resolves to an excluded project, return it immediately
 * (early-out — excluded files stay cheap) so the caller skips the whole file:
 * archive copy, summary, and index. Files with no excluded cwd are read fully
 * to confirm that; the first cwd's project is the fallback, undefined if none.
 */
export async function sniffCodexProject(
  filePath: string,
  excludedProjects: readonly string[] = []
): Promise<string | undefined> {
  const fileStream = createArchiveReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  let firstProject: string | undefined;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line) as CodexRolloutLine;
      } catch {
        continue;
      }
      const cwd = parsed?.payload?.cwd;
      if (typeof cwd === 'string' && cwd) {
        // Exclude by the canonical encoded cwd (same form as the projects
        // dir-name used across agents), never by basename.
        const encoded = encodeProjectPath(cwd);
        if (excludedProjects.includes(encoded)) {
          return encoded;
        }
        if (firstProject === undefined) firstProject = projectFromCwd(cwd);
      }
    }
  } finally {
    rl.close();
    (fileStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  }
  return firstProject;
}

/**
 * Convenience function to parse a conversation file
 * Extracts project name from the file path and returns exchanges with metadata
 */
export async function parseConversationFile(filePath: string): Promise<{
  project: string;
  exchanges: ConversationExchange[];
}> {
  // Extract project name from path (directory name before the .jsonl file)
  const pathParts = filePath.split('/');
  let project = 'unknown';

  // Find the parent directory name (second to last part)
  if (pathParts.length >= 2) {
    project = pathParts[pathParts.length - 2];
  }

  const exchanges = await parseConversation(filePath, project, filePath);

  return {
    project,
    exchanges
  };
}
