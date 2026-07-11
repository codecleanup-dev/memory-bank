import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildPollutionWhere } from '../src/pollution-predicate.js';
import { WORKER_PROMPT_PREFIXES } from '../src/paths.js';

// This predicate drives a DATA-DELETING path (purge-llm-sessions). A bug that
// widened it would delete real user exchanges; one that narrowed it would leave
// pollution in search. Both directions are covered against a real table.
describe('buildPollutionWhere', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE exchanges (id TEXT PRIMARY KEY, project TEXT, user_message TEXT)');
  });
  afterEach(() => db.close());

  const add = (id: string, project: string, um: string) =>
    db.prepare('INSERT INTO exchanges VALUES (?,?,?)').run(id, project, um);

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

  it('params align with placeholders: 1 slug + (len, prefix) per worker prompt', () => {
    const { params } = buildPollutionWhere({ legacyPrompts: true });
    expect(params[0]).toBe('%-memory-bank-llm');
    expect(params.length).toBe(1 + WORKER_PROMPT_PREFIXES.length * 2);
    expect(params[1]).toBe(WORKER_PROMPT_PREFIXES[0].length);
    expect(params[2]).toBe(WORKER_PROMPT_PREFIXES[0]);
  });

  it('draws its prefix list from the single source of truth (paths.ts)', () => {
    // Adding a prompt to WORKER_PROMPT_PREFIXES must flow through automatically —
    // the purge script no longer keeps its own copy. Inject a custom list to
    // prove the wiring (not the specific canonical values).
    add('custom', '-Users-me-Project-real', 'CUSTOM_LEAD_XYZ trailing');
    expect(matched({ legacyPrompts: true, prefixes: ['CUSTOM_LEAD_XYZ'] })).toEqual(['custom']);
  });
});
