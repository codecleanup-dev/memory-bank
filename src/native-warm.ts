import { initDatabase } from './db.js';
import { EMBEDDING_MODEL } from './embeddings.js';
import { allowModelMirroring, isModelMirrored, stableSqliteVecPath } from './runtime-assets.js';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run once right after the MCP initialize handshake (never before the client
 * has its answer — this is synchronous and may be slow in bad cases), while
 * this plugin version's directory still exists on disk:
 *
 *  1. mirror the sqlite-vec extension to the stable dir — see
 *     runtime-assets.ts for why it cannot simply be "loaded once";
 *  2. allow embedding-model mirroring: a model that transformers.js already
 *     loaded in this process (inject daemon pre-warm) is published now, and
 *     any model loaded later is published right after that load;
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
export function warmNativeBindings(open: () => { close(): void } = initDatabase): boolean {
  let ok = true;

  if (!stableSqliteVecPath()) {
    console.error('native warm-up: sqlite-vec mirror unavailable; connections will load it from the plugin directory');
    ok = false;
  }

  try {
    allowModelMirroring();
    if (!isModelMirrored(EMBEDDING_MODEL)) {
      // Informational: no model has been loaded in this process yet, so there
      // is no proof to publish. The first successful load publishes it.
      console.error('native warm-up: embedding model not mirrored yet; it is published after its first successful load');
    }
  } catch (error) {
    console.error('native warm-up: embedding model cache relocation failed:', describe(error));
    ok = false;
  }

  try {
    const db = open();
    db.close();
  } catch (error) {
    console.error('native warm-up skipped (tools will retry on first call):', describe(error));
    return false;
  }

  return ok;
}
