/**
 * SQL predicate + params matching WORKER-PROMPT POLLUTION exchanges — the
 * plugin's own Haiku worker sessions that ephemeral-state cleanup (purge) must
 * remove and indexing must never store. Single source of truth: the prefixes
 * come from paths.ts WORKER_PROMPT_PREFIXES, so adding a new worker prompt there
 * (for the indexing guard) automatically extends the purge too — the old code
 * duplicated the list in the purge script, where the two silently drifted (a
 * new prompt would be excluded from indexing but never purged).
 *
 * Two pollution families:
 *   - SLUG: project slug ends with `-memory-bank-llm` (worker sessions indexed
 *     under their own temp workdir slug). Always included.
 *   - WORKER-PROMPT (opt-in via `legacyPrompts`): sessions from before the fixed
 *     workdir ran with the CALLER project's cwd, so they sit under REAL project
 *     slugs and can only be identified by the exact system-prompt lead.
 *
 * @param opts.legacyPrompts also match worker-prompt leads under real slugs
 * @param opts.alias table alias for the exchanges columns ('' for none)
 * @param opts.prefixes worker-prompt leads (defaults to canonical; injectable for tests)
 */
export declare function buildPollutionWhere(opts?: {
    legacyPrompts?: boolean;
    alias?: string;
    prefixes?: readonly string[];
}): {
    where: string;
    params: Array<number | string>;
};
