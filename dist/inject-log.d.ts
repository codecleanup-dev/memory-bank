export interface InjectLogEntry {
    ts: string;
    status: 'injected' | 'no-match' | 'skipped' | 'error';
    project?: string;
    prompt_len?: number;
    candidates?: number;
    injected?: number;
    duration_ms?: number;
    error?: string;
    /** Which execution path served this injection: warm MCP-server daemon or cold fallback. */
    via?: 'daemon' | 'fallback';
}
export declare function getInjectLogPath(): string;
/**
 * Append a single JSONL entry to the injection log.
 * Rotates to `.old` (replacing any previous rotation) when the log exceeds 5MB.
 * Never throws.
 */
export declare function appendInjectLog(entry: Omit<InjectLogEntry, 'ts'>): void;
