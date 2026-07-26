import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildPollutionWhere, POLLUTION_PROMPT_LEADS } from '../src/pollution-predicate.js';
import { WORKER_PROMPT_PREFIXES, AGENT_HANDSHAKE_MESSAGE, isAgentHandshakeExchange } from '../src/paths.js';
import { SUMMARIZER_CONTEXT_MARKER } from '../src/constants.js';

// This predicate drives a DATA-DELETING path (purge-llm-sessions). A bug that
// widened it would delete real user exchanges; one that narrowed it would leave
// pollution in search. Both directions are covered against a real table.
describe('buildPollutionWhere', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // is_sidechain mirrors the real schema — the handshake family reads it.
    db.exec('CREATE TABLE exchanges (id TEXT PRIMARY KEY, project TEXT, user_message TEXT, is_sidechain INTEGER DEFAULT 0)');
  });
  afterEach(() => db.close());

  const add = (id: string, project: string, um: string, isSidechain = 0) =>
    db.prepare('INSERT INTO exchanges VALUES (?,?,?,?)').run(id, project, um, isSidechain);

  const matched = (opts: Parameters<typeof buildPollutionWhere>[0]): string[] => {
    const { where, params } = buildPollutionWhere(opts);
    return (db.prepare(`SELECT id FROM exchanges WHERE ${where} ORDER BY id`).all(...params) as Array<{ id: string }>)
      .map((r) => r.id);
  };

  it('slug family: matches only slugs ending -memory-bank-llm', () => {
    add('a', '-private-tmp-memory-bank-llm', 'anything');
    add('b', '-Users-me-Project-foo-memory-bank-llm', 'x');
    add('real', '-Users-me-Project-real-app', 'a genuine user message');
    add('near', '-Users-me-memory-bank-llm-notsuffix', 'x'); // contains but does NOT end with
    expect(matched({})).toEqual(['a', 'b']); // 'real' and 'near' are NOT matched
  });

  it('legacy-prompts: also matches worker-prompt leads under REAL slugs', () => {
    add('slug', '-tmp-memory-bank-llm', 'x');
    add('legacy', '-Users-me-Project-real', WORKER_PROMPT_PREFIXES[0] + ' extra');
    add('real', '-Users-me-Project-real', 'a genuine question about my code');
    expect(matched({ legacyPrompts: true })).toEqual(['legacy', 'slug']);
    expect(matched({})).toEqual(['slug']); // without legacyPrompts, the real-slug worker prompt is left alone
  });

  it('never matches a real message that merely resembles a prompt', () => {
    add('real', '-Users-me-Project-real', 'You are an expert developer, please help'); // NOT an exact worker-prompt lead
    expect(matched({ legacyPrompts: true })).toEqual([]);
  });

  it('alias option qualifies columns for a joined query', () => {
    const { where } = buildPollutionWhere({ legacyPrompts: true, alias: 'e' });
    expect(where).toContain('e.project LIKE ?');
    expect(where).toContain('substr(e.user_message, 1, ?)');
  });

  it('params align with placeholders: 1 slug + (len, prefix) per worker prompt + 1 handshake', () => {
    const { params } = buildPollutionWhere({ legacyPrompts: true });
    expect(params[0]).toBe('%-memory-bank-llm');
    // handshake family is ON by default → one extra trailing param
    expect(params.length).toBe(1 + POLLUTION_PROMPT_LEADS.length * 2 + 1);
    expect(params[1]).toBe(POLLUTION_PROMPT_LEADS[0].length);
    expect(params[2]).toBe(POLLUTION_PROMPT_LEADS[0]);
    expect(params[params.length - 1]).toBe(AGENT_HANDSHAKE_MESSAGE);
    // opt-out reproduces the pre-fork predicate exactly
    expect(buildPollutionWhere({ legacyPrompts: true, handshake: false }).params.length)
      .toBe(1 + POLLUTION_PROMPT_LEADS.length * 2);
  });

  // --- [fork] handshake family -------------------------------------------
  it('handshake family: matches exact "Warmup" ONLY on sidechain rows', () => {
    add('hs', '-Users-me-Project-real', AGENT_HANDSHAKE_MESSAGE, 1);
    add('human', '-Users-me-Project-real', AGENT_HANDSHAKE_MESSAGE, 0); // top-level human — keep
    expect(matched({})).toEqual(['hs']);
  });

  it('handshake family: never matches a longer human message that starts with Warmup', () => {
    add('long', '-Users-me-Project-real', 'Warmup routine for my workout app', 1);
    expect(matched({})).toEqual([]); // exact equality, not prefix
  });

  it('handshake family can be disabled for pre-fork parity', () => {
    add('hs', '-Users-me-Project-real', AGENT_HANDSHAKE_MESSAGE, 1);
    expect(matched({ handshake: false })).toEqual([]);
  });

  it('isAgentHandshakeExchange requires exact text AND sidechain', () => {
    expect(isAgentHandshakeExchange('Warmup', 1)).toBe(true);
    expect(isAgentHandshakeExchange('Warmup', true)).toBe(true);
    expect(isAgentHandshakeExchange('Warmup', 0)).toBe(false);      // top-level human
    expect(isAgentHandshakeExchange('Warmup ', 1)).toBe(false);     // trailing space
    expect(isAgentHandshakeExchange('Warmup me up', 1)).toBe(false);
    expect(isAgentHandshakeExchange(null, 1)).toBe(false);
  });

  // --- [fork] drift guard -------------------------------------------------
  it('purge leads = worker prompts (1:1 contract) PLUS the summarizer marker', () => {
    // WORKER_PROMPT_PREFIXES keeps its 1:1 coupling with the four Haiku system
    // prompts (test/worker-prompt-coupling). The summarizer marker is purge-only
    // because three summarizer prompts share it — adding it there would create
    // a "dead prefix" by that test's definition.
    for (const p of WORKER_PROMPT_PREFIXES) expect(POLLUTION_PROMPT_LEADS).toContain(p);
    expect(POLLUTION_PROMPT_LEADS).toContain(SUMMARIZER_CONTEXT_MARKER);
    expect(WORKER_PROMPT_PREFIXES).not.toContain(SUMMARIZER_CONTEXT_MARKER);
    expect(POLLUTION_PROMPT_LEADS.length).toBe(WORKER_PROMPT_PREFIXES.length + 1);
  });

  it('legacy-prompts family covers summarizer rows under real slugs', () => {
    add('summ', '-Users-me-Project-real', SUMMARIZER_CONTEXT_MARKER + '\n\nsome conversation');
    expect(matched({ legacyPrompts: true })).toEqual(['summ']);
    expect(matched({})).toEqual([]); // opt-in only, like the other worker prompts
  });

  it('draws its prefix list from the single source of truth (paths.ts)', () => {
    // Adding a prompt to WORKER_PROMPT_PREFIXES must flow through automatically —
    // the purge script no longer keeps its own copy. Inject a custom list to
    // prove the wiring (not the specific canonical values).
    add('custom', '-Users-me-Project-real', 'CUSTOM_LEAD_XYZ trailing');
    expect(matched({ legacyPrompts: true, prefixes: ['CUSTOM_LEAD_XYZ'] })).toEqual(['custom']);
  });
});
