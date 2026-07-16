/**
 * Version drift guard — a plugin update must not leave old-version processes running.
 *
 * Incident (2026-07-14): a v1.3.3 sync-cli wedged for 23h kept the singleton lock,
 * silently starving every newer sync (indexing frozen), while the stale install
 * record kept spawning v1.3.3 into every new session after v1.4.3 shipped.
 *
 * Two enforcement points use this module:
 *  - sync-cli lock: the lock file carries {pid, version, startedAt} so a newer
 *    sync takes over from an older or wedged holder instead of skipping forever.
 *  - SessionStart sweep (scripts/version-drift-check.js): detached workers
 *    running from an older versioned plugin dir are terminated. MCP servers are
 *    never swept — killing one breaks a live session's tools; those only rotate
 *    on session restart.
 */
export interface LockMeta {
    pid: number;
    version: string | null;
    startedAt: number | null;
    /** Absolute path of the creator's own entry script (process.argv[1]) —
     * the lock's SELF-DECLARED identity. Holder recognition compares the ps
     * command line against THIS exact token instead of a path heuristic, which
     * is simultaneously tighter (an unrelated look-alike path never matches a
     * lock it did not create) and looser (any invocation form — exotic node
     * flags, wrappers — still contains its own script path). null on legacy
     * (<=1.6.0-pre) locks → heuristic fallback. */
    script: string | null;
}
/** Dotted-version compare: -1 / 0 / 1. Missing parts count as 0. A prerelease
 * suffix sorts BELOW its release (semver §11: 1.6.0-beta.1 < 1.6.0) — naive
 * parseInt over "0-beta.1" would silently equate them and invert takeover
 * decisions if a prerelease build ever ships. Between two prereleases a plain
 * string compare is sufficient for our stale/newer decisions. */
export declare function compareVersions(a: string, b: string): number;
/**
 * Parse lock pid-file content. Accepts the v1.4.4+ JSON form
 * {pid, version, startedAt} and the legacy bare-pid form (≤1.4.3).
 * Returns null when no usable pid can be extracted (caller treats the
 * lock as garbage: reclaim without killing anything).
 */
export declare function parseLockMeta(raw: string): LockMeta | null;
export type TakeoverDecision = 'takeover-stale-version' | 'takeover-wedged' | 'defer';
/**
 * Decide whether a live lock holder should be preempted.
 *  - Older version (a legacy no-version lock can only come from ≤1.4.3, i.e.
 *    older by construction) → take over: stale code must not keep indexing.
 *  - Runtime above wedgeMaxMs → take over regardless of version: a wedged sync
 *    starves indexing either way (observed: 23h; normal incremental sync is
 *    minutes). holderRunMs null (unknown start) → no wedge judgement.
 */
export declare function decideTakeover(holder: LockMeta, myVersion: string, holderRunMs: number | null, wedgeMaxMs: number): TakeoverDecision;
export declare function isSyncCliCommand(command: string): boolean;
/**
 * If `command` is a memory-bank detached worker from a version OLDER than
 * `myVersion`, return that stale version string; otherwise null.
 */
export declare function staleWorkerVersion(command: string, myVersion: string, cacheBase?: string | null): string | null;
