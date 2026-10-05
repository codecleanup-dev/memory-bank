/**
 * Background-sync cooldown. Hand-ported from upstream jung-wan-kim/memory-bank 10bec9e
 * (2026-09-27, "fix(sync): 백그라운드 동기화에 최소 간격(기본 600초)") under the fork's
 * cherry-pick contract (PORT-PLAN, 2026-10-05): the singleton lock stops *concurrent* syncs
 * but not *frequent* ones. SessionStart fires on every session start, and headless sessions
 * (pipeline stages, eval runners) start every few minutes, so a fresh sync (embedding model
 * load + indexing, 1-2 min at 2-4 cores) restarted right after the previous one finished
 * (upstream measured 17:41, 17:43, 17:51 on one machine, load 85).
 *
 * Background (hook) syncs skip when the last successful sync finished less than
 * MEMORY_BANK_SYNC_MIN_INTERVAL_S ago (default 600, 0 disables). A foreground
 * `memory-bank sync` is never throttled. Failed syncs do not stamp, so the next session start
 * retries. A stamp in the future (clock change) never suppresses a sync.
 *
 * Kept in its own module so the pure parts are testable without executing the CLI.
 */
export declare const DEFAULT_SYNC_MIN_INTERVAL_MS = 600000;
export declare function defaultLastSyncFile(): string;
export declare function minIntervalMs(env?: NodeJS.ProcessEnv): number;
export declare function lastSyncAgeMs(file: string, now?: number): number | null;
export interface CooldownDecision {
    skip: boolean;
    ageS: number | null;
    minS: number;
}
/** skip === true → the background sync should not start. */
export declare function shouldSkipBackgroundSync(file: string, env?: NodeJS.ProcessEnv, now?: number): CooldownDecision;
export declare function recordSyncCompletion(file: string, now?: number): void;
