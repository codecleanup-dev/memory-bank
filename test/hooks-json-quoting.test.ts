import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_JSON = path.join(__dirname, '..', 'hooks', 'hooks.json');

type HooksFile = { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };

function allCommands(): Array<{ event: string; command: string }> {
  const data = JSON.parse(readFileSync(HOOKS_JSON, 'utf8')) as HooksFile;
  const out: Array<{ event: string; command: string }> = [];
  for (const [event, matchers] of Object.entries(data.hooks)) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) out.push({ event, command: hook.command });
    }
  }
  return out;
}

// Claude Code hands hook commands to a shell with CLAUDE_PLUGIN_ROOT in the
// environment. An unquoted `${CLAUDE_PLUGIN_ROOT}/x` word-splits when the plugin
// cache path contains whitespace (a home directory with a space is enough), and
// the hook then fails silently. Until 1.12.7 only the version-drift entry was
// quoted; a keystone wrapper script masked the gap for the session hooks until
// its duplicate registration was removed (2026-10-07).
describe('hooks/hooks.json command quoting', () => {
  it('references the plugin root only inside double quotes', () => {
    const commands = allCommands();
    expect(commands.length).toBeGreaterThan(0);
    const unquoted = commands.filter(({ command }) => /(?<!")\$\{CLAUDE_PLUGIN_ROOT\}/.test(command));
    expect(unquoted).toEqual([]);
    for (const { command } of commands) expect(command).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  // Static quoting is only a proxy. This runs every command through bash with a
  // plugin root whose path contains a space and stub scripts in place of the real
  // ones, then checks that each stub was reached and received the full path.
  // POSIX-only: the stubs are shell scripts.
  describe.skipIf(process.platform === 'win32')('execution with a plugin root containing whitespace', () => {
    let root: string;
    let log: string;

    function stub(relPath: string): void {
      const full = path.join(root, relPath);
      mkdirSync(path.dirname(full), { recursive: true });
      // Record who was called and every argument, one per line, then succeed.
      writeFileSync(full, `#!/bin/sh\nprintf 'CALLED %s\\n' "$0" >> "$MB_TEST_LOG"\nfor a in "$@"; do printf 'ARG %s\\n' "$a" >> "$MB_TEST_LOG"; done\nexit 0\n`);
      chmodSync(full, 0o755);
    }

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'mb plugin root-'));
      expect(root).toMatch(/\s/);
      log = path.join(root, 'calls.log');
      stub('cli/node-pin.sh');
      stub('scripts/install-commands.sh');
      stub('hooks/inject-context.sh');
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('reaches every stub with the whole path intact', () => {
      for (const { event, command } of allCommands()) {
        if (existsSync(log)) rmSync(log);
        const run = spawnSync('bash', ['-c', command], {
          env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, MB_TEST_LOG: log },
          input: '',
          encoding: 'utf8',
          timeout: 10_000,
        });
        // An unquoted path makes bash look for "<prefix-before-space>" and exit 127.
        expect(run.status, `${event}: ${command}\n${run.stderr}`).toBe(0);
        expect(existsSync(log), `${event}: stub never reached for ${command}`).toBe(true);

        const lines = readFileSync(log, 'utf8').trim().split('\n');
        const called = lines.filter((line) => line.startsWith('CALLED ')).map((line) => line.slice(7));
        expect(called.length, `${event}: ${command}`).toBe(1);
        expect(called[0].startsWith(root), `${event}: stub path lost its prefix: ${called[0]}`).toBe(true);

        // node-pin.sh entries pass a script path as the first argument; it must
        // arrive as one argument that still starts with the whitespace root.
        const args = lines.filter((line) => line.startsWith('ARG ')).map((line) => line.slice(4));
        if (called[0].endsWith('/cli/node-pin.sh')) {
          expect(args.length, `${event}: ${command}`).toBeGreaterThan(0);
          expect(args[0].startsWith(path.join(root, '')), `${event}: first arg split: ${args[0]}`).toBe(true);
          expect(args[0].endsWith('.js'), `${event}: first arg is not the script path: ${args[0]}`).toBe(true);
        }
      }
    });
  });
});
