export interface InjectLogEntry {
    ts: string;
    /** 'deduped': 후보 전부가 이 세션에서 이미 주입됨 → 재주입 0 (토큰 절약 관측용). */
    status: 'injected' | 'no-match' | 'skipped' | 'error' | 'deduped';
    project?: string;
    prompt_len?: number;
    candidates?: number;
    injected?: number;
    /** 세션 원장 dedup 으로 걸러진 fact 수 — 절감량이 로그로 상시 측정된다. */
    deduped?: number;
    /** 실제 주입된 블록 크기(자) — 토큰 비용 관측용 (~chars/3 tok). */
    chars?: number;
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
