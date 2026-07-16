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
}

/** Dotted-version compare: -1 / 0 / 1. Missing parts count as 0. A prerelease
 * suffix sorts BELOW its release (semver §11: 1.6.0-beta.1 < 1.6.0) — naive
 * parseInt over "0-beta.1" would silently equate them and invert takeover
 * decisions if a prerelease build ever ships. Between two prereleases a plain
 * string compare is sufficient for our stale/newer decisions. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string | null } => {
    const dash = v.indexOf('-');
    const core = dash === -1 ? v : v.slice(0, dash);
    const pre = dash === -1 ? null : v.slice(dash + 1);
    return { nums: core.split('.').map((n) => parseInt(n, 10)), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa.nums[i]) ? pa.nums[i] : 0;
    const y = Number.isFinite(pb.nums[i]) ? pb.nums[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * Parse lock pid-file content. Accepts the v1.4.4+ JSON form
 * {pid, version, startedAt} and the legacy bare-pid form (≤1.4.3).
 * Returns null when no usable pid can be extracted (caller treats the
 * lock as garbage: reclaim without killing anything).
 */
export function parseLockMeta(raw: string): LockMeta | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as { pid?: unknown; version?: unknown; startedAt?: unknown };
      const pid = typeof o.pid === 'number' ? o.pid : parseInt(String(o.pid), 10);
      if (!Number.isFinite(pid) || pid <= 1) return null;
      return {
        pid,
        version: typeof o.version === 'string' && o.version ? o.version : null,
        startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : null,
      };
    } catch {
      return null;
    }
  }
  const pid = parseInt(t, 10);
  if (!Number.isFinite(pid) || pid <= 1) return null;
  return { pid, version: null, startedAt: null };
}

export type TakeoverDecision = 'takeover-stale-version' | 'takeover-wedged' | 'defer';

/**
 * Decide whether a live lock holder should be preempted.
 *  - Older version (a legacy no-version lock can only come from ≤1.4.3, i.e.
 *    older by construction) → take over: stale code must not keep indexing.
 *  - Runtime above wedgeMaxMs → take over regardless of version: a wedged sync
 *    starves indexing either way (observed: 23h; normal incremental sync is
 *    minutes). holderRunMs null (unknown start) → no wedge judgement.
 */
export function decideTakeover(
  holder: LockMeta,
  myVersion: string,
  holderRunMs: number | null,
  wedgeMaxMs: number,
): TakeoverDecision {
  const holderVersion = holder.version ?? '0.0.0';
  if (compareVersions(holderVersion, myVersion) < 0) return 'takeover-stale-version';
  // Wedge preemption never DOWNGRADES: an older contender killing a newer
  // wedged holder would resume indexing on older code. Defer instead — sync
  // fires at every SessionStart, so the newer plugin's own next session
  // preempts its wedged sibling (same-version wedge takeover below).
  if (compareVersions(holderVersion, myVersion) > 0) return 'defer';
  if (holderRunMs !== null && holderRunMs > wedgeMaxMs) return 'takeover-wedged';
  return 'defer';
}

/**
 * Detached memory-bank workers running from a versioned plugin cache dir.
 * Deliberately excludes mcp-server / mcp-server-wrapper (owned by live sessions).
 *
 * ANCHORED to "node executing this script": the first argv token must be a
 * node binary (bare `node`/`nodejs` or a path ending in /node) and the worker
 * path must be the first non-flag argument, terminated by whitespace/EOL. A
 * bare substring match would also hit unrelated processes that merely carry
 * the path as inert argv (editor, grep, a different node script taking the
 * path as data) — and those must never be killed by the sweep.
 */
const WORKER_RE =
  /^\s*(?:\S*\/)?node(?:js)?(?:\s+--\S+)*\s+\S*plugins\/cache\/memory-bank-dev\/memory-bank\/(\d+(?:\.\d+)*)\/(?:dist\/sync-cli\.js|scripts\/(?:backfill-extract-worker|backfill-ontology-worker|fact-consolidate-worker|fact-extract-worker|reembed-worker)\.js)(?:\s|$)/;


/**
 * True if a ps command line IS a running memory-bank sync-cli — anchored the
 * same way as WORKER_RE: the executable must be a node binary and the executed
 * script (first non-flag argv) must be a MEMORY-BANK-marked sync entrypoint
 * (a PATH SEGMENT starting with "memory-bank" — memory-bank/, memory-bank-
 * fork/, the plugin cache — somewhere above dist/sync-cli.js, or
 * cli/memory-bank.js with the `sync` subcommand). Segment anchoring keeps
 * both an unrelated app's own dist/sync-cli.js AND look-alike segments
 * (not-memory-bank/) out of the kill set. Used as the pid-recycle
 * guard before the lock takeover kills a holder: a recycled pid whose argv
 * merely CONTAINS "memory-bank"/"sync-cli" as data must never be killed.
 */
const SYNC_CLI_RE =
  /^\s*(?:\S*\/)?node(?:js)?(?:\s+--\S+)*\s+(?:(?:\S*\/)?memory-bank[^/\s]*\/(?:\S*\/)?dist\/sync-cli\.js(?:\s|$)|\S*\/cli\/memory-bank\.js\s+sync\b)/;

export function isSyncCliCommand(command: string): boolean {
  return SYNC_CLI_RE.test(command);
}

/**
 * If `command` is a memory-bank detached worker from a version OLDER than
 * `myVersion`, return that stale version string; otherwise null.
 */
export function staleWorkerVersion(command: string, myVersion: string): string | null {
  const m = WORKER_RE.exec(command);
  if (!m) return null;
  return compareVersions(m[1], myVersion) < 0 ? m[1] : null;
}
