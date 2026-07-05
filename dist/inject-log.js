import fs from 'fs';
import path from 'path';
import { getIndexDir } from './paths.js';
/**
 * Observability log for the UserPromptSubmit context injection pipeline.
 *
 * The injection hook historically failed silently (stderr discarded, empty
 * output indistinguishable from "no relevant facts"), which let a broken
 * install go unnoticed for months. Every run now appends one JSONL line so
 * "injection never fires" becomes measurable instead of invisible.
 *
 * Logging is strictly best-effort: it must never throw or block injection.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate at 5MB
export function getInjectLogPath() {
    const dir = path.join(getIndexDir(), 'logs');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'inject-context.jsonl');
}
/**
 * Append a single JSONL entry to the injection log.
 * Rotates to `.old` (replacing any previous rotation) when the log exceeds 5MB.
 * Never throws.
 */
export function appendInjectLog(entry) {
    try {
        const logPath = getInjectLogPath();
        try {
            const stat = fs.statSync(logPath);
            if (stat.size > MAX_LOG_BYTES) {
                fs.renameSync(logPath, `${logPath}.old`);
            }
        }
        catch {
            // No existing log — nothing to rotate.
        }
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
        fs.appendFileSync(logPath, line + '\n');
    }
    catch {
        // Best-effort only: observability must not break injection.
    }
}
