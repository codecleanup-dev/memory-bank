import fs from 'fs';
import os from 'os';
import path from 'path';

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
export const DEFAULT_SYNC_MIN_INTERVAL_MS = 600_000;

export function defaultLastSyncFile(): string {
  return path.join(os.homedir(), '.claude', 'run-locks', 'memory-bank-sync.last');
}

export function minIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMORY_BANK_SYNC_MIN_INTERVAL_S;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SYNC_MIN_INTERVAL_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 86_400 ? n * 1000 : DEFAULT_SYNC_MIN_INTERVAL_MS;
}

export function lastSyncAgeMs(file: string, now: number = Date.now()): number | null {
  try {
    const at = Number(fs.readFileSync(file, 'utf8').trim());
    if (!Number.isFinite(at) || at <= 0) return null;
    const age = now - at;
    return age >= 0 ? age : null; // a future stamp (clock change) never suppresses a sync
  } catch {
    return null;
  }
}

export interface CooldownDecision {
  skip: boolean;
  ageS: number | null;
  minS: number;
}

/** skip === true → the background sync should not start. */
export function shouldSkipBackgroundSync(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): CooldownDecision {
  const minMs = minIntervalMs(env);
  const age = lastSyncAgeMs(file, now);
  const skip = minMs > 0 && age !== null && age < minMs;
  return { skip, ageS: age === null ? null : Math.round(age / 1000), minS: minMs / 1000 };
}

export function recordSyncCompletion(file: string, now: number = Date.now()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(now));
}
