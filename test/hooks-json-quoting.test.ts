import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_JSON = path.join(__dirname, '..', 'hooks', 'hooks.json');

// Claude Code hands hook commands to a shell with CLAUDE_PLUGIN_ROOT in the
// environment. An unquoted `${CLAUDE_PLUGIN_ROOT}/x` word-splits when the plugin
// cache path contains whitespace (a home directory with a space is enough), and
// the hook then fails silently. Until 1.12.7 only the version-drift entry was
// quoted; a keystone wrapper script masked the gap for the session hooks until
// its duplicate registration was removed (2026-10-07). Every command that
// references the plugin root must quote it.
describe('hooks/hooks.json command quoting', () => {
  it('wraps every ${CLAUDE_PLUGIN_ROOT} path in double quotes', () => {
    const data = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands: string[] = [];
    for (const matchers of Object.values(data.hooks)) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) commands.push(hook.command);
      }
    }
    expect(commands.length).toBeGreaterThan(0);

    const unquoted = commands.filter((command) => /(?<!")\$\{CLAUDE_PLUGIN_ROOT\}/.test(command));
    expect(unquoted).toEqual([]);

    // Every quoted reference must also close its quote after the path segment.
    for (const command of commands) {
      for (const match of command.matchAll(/"\$\{CLAUDE_PLUGIN_ROOT\}[^"]*"/g)) {
        expect(match[0].endsWith('"')).toBe(true);
      }
      expect(command.includes('${CLAUDE_PLUGIN_ROOT}')).toBe(true);
    }
  });
});
