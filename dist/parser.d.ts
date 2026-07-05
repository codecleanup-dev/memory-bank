import { ConversationExchange } from './types.js';
export declare function parseConversation(filePath: string, projectName: string, archivePath: string): Promise<ConversationExchange[]>;
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
export declare function encodeProjectPath(absPath: string): string;
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
export declare function sniffCodexProject(filePath: string, excludedProjects?: readonly string[]): Promise<string | undefined>;
/**
 * Convenience function to parse a conversation file
 * Extracts project name from the file path and returns exchanges with metadata
 */
export declare function parseConversationFile(filePath: string): Promise<{
    project: string;
    exchanges: ConversationExchange[];
}>;
