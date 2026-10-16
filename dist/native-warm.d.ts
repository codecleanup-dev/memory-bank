/**
 * Validate-and-publish the model cache that is already on disk, without
 * proof: the heuristic path (every required file present, quiet for a while,
 * structurally intact). Needed when no pipeline was built in this process —
 * e.g. another server owns the inject socket, so no pre-warm happened here.
 * Returns true once the model is served from a published mirror.
 */
export declare function publishExistingModel(): boolean;
/**
 * Keep trying `publish` on an interval until it reports success or the
 * attempts run out. Covers a bundled cache that another process is still
 * downloading at warm-up time. Each attempt is a handful of stat() calls while
 * the source is incomplete. Timers are unref'd so they never keep the process
 * alive.
 */
export declare function scheduleModelMirrorRetry(publish: () => boolean, intervalMs?: number, maxAttempts?: number): void;
/**
 * Run once right after the MCP initialize handshake (never before the client
 * has its answer — this is synchronous and may be slow in bad cases), while
 * this plugin version's directory still exists on disk:
 *
 *  1. mirror the sqlite-vec extension to the stable dir — see
 *     runtime-assets.ts for why it cannot simply be "loaded once";
 *  2. allow embedding-model mirroring: a model that transformers.js already
 *     loaded in this process (inject daemon pre-warm) is published now, and
 *     any model loaded later is published right after that load. If nothing
 *     was loaded here, the cache already on disk is validated and published
 *     on the heuristic path, with a few background retries while it is still
 *     incomplete;
 *  3. open and close the database so better-sqlite3's lazily required
 *     `bindings` + native addon are mapped into this process.
 *
 * Why: Claude Code sweeps superseded plugin versions after an update, but a
 * long-lived session keeps running this server from the old path. Before this
 * warm-up, a session that had not yet called a tool failed on its first call
 * with "Cannot find module 'bindings'" (2026-10-16, 1.12.6 after 1.12.7 was
 * installed), and sessions that HAD opened the database still failed on the
 * next call at sqlite-vec's per-connection dlopen of the deleted path.
 *
 * Best-effort: nothing here prevents the MCP transport from starting. Returns
 * true only when every step succeeded; failures are logged to stderr and the
 * per-call path surfaces the real error with context.
 */
export declare function warmNativeBindings(open?: () => {
    close(): void;
}, retry?: (publish: () => boolean) => void): boolean;
