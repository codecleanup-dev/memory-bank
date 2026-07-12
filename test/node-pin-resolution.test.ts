import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_PIN = path.join(__dirname, '..', 'cli', 'node-pin.sh');

// Session hooks (hooks.json + inject-context.sh) used to spawn bare PATH
// `node`, while better-sqlite3 is ABI-built for the runtime pinned in
// ~/.claude/memory-bank.env — the exact class that killed the MCP read path
// on 2026-07-05 and again on 2026-07-09. cli/node-pin.sh is the single bash
// launcher for every hook entry; these tests pin its resolution contract to
// the wrapper's: MEMORY_BANK_NODE_BIN → memory-bank.env pin (allowlisted)
// → .nvmrc (nvm exact/same-major) → PATH node.
// POSIX-only: stub node binaries are shell scripts.
describe.skipIf(process.platform === 'win32')('cli/node-pin.sh resolution', () => {
  let home: string;
  let pluginRoot: string;

  function makeStubNode(binPath: string, tag: string): string {
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(binPath, `#!/bin/sh\necho "STUB:${tag}"\nexit 0\n`);
    chmodSync(binPath, 0o755);
    return binPath;
  }

  function runPin(extraEnv: Record<string, string | undefined> = {}): string {
    const res = spawnSync('bash', [NODE_PIN, '/dev/null'], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        ...extraEnv,
      },
      timeout: 15000,
      encoding: 'utf8',
    });
    expect(res.error).toBeUndefined();
    return (res.stdout || '').trim();
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'node-pin-home-'));
    pluginRoot = path.join(home, 'plugin');
    mkdirSync(pluginRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('MEMORY_BANK_NODE_BIN override wins over everything', () => {
    const override = makeStubNode(path.join(home, 'custom', 'node'), 'override');
    const nvmPin = makeStubNode(
      path.join(home, '.nvm', 'versions', 'node', 'v22.22.3', 'bin', 'node'), 'nvm');
    writeFileSync(path.join(home, '.claude-env'), `export MEMORY_BANK_NODE="${nvmPin}"\n`);
    writeFileSync(path.join(pluginRoot, '.nvmrc'), '22.22.3\n');
    expect(runPin({
      MEMORY_BANK_NODE_BIN: override,
      MEMORY_BANK_ENV_FILE: path.join(home, '.claude-env'),
    })).toBe('STUB:override');
  });

  it('memory-bank.env pin (nvm-allowlisted path) wins over .nvmrc', () => {
    const envPin = makeStubNode(
      path.join(home, '.nvm', 'versions', 'node', 'v26.4.0', 'bin', 'node'), 'env-pin');
    makeStubNode(
      path.join(home, '.nvm', 'versions', 'node', 'v22.22.3', 'bin', 'node'), 'nvmrc');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'memory-bank.env'),
      `export MEMORY_BANK_NODE="${envPin}"\n`);
    writeFileSync(path.join(pluginRoot, '.nvmrc'), '22.22.3\n');
    expect(runPin()).toBe('STUB:env-pin');
  });

  it('rejects a non-allowlisted env pin and falls back to .nvmrc', () => {
    const evil = makeStubNode(path.join(home, 'evil', 'node'), 'evil');
    makeStubNode(
      path.join(home, '.nvm', 'versions', 'node', 'v22.22.3', 'bin', 'node'), 'nvmrc');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'memory-bank.env'),
      `export MEMORY_BANK_NODE="${evil}"\n`);
    writeFileSync(path.join(pluginRoot, '.nvmrc'), '22.22.3\n');
    expect(runPin()).toBe('STUB:nvmrc');
  });

  it('.nvmrc same-major fallback picks the highest installed version', () => {
    makeStubNode(
      path.join(home, '.nvm', 'versions', 'node', 'v22.20.0', 'bin', 'node'), 'v22.20.0');
    makeStubNode(
      path.join(home, '.nvm', 'versions', 'node', 'v22.21.1', 'bin', 'node'), 'v22.21.1');
    writeFileSync(path.join(pluginRoot, '.nvmrc'), '22.99.0\n');
    expect(runPin()).toBe('STUB:v22.21.1');
  });

  it('custom MEMORY_BANK_ENV_FILE location is honored', () => {
    const envPin = makeStubNode(
      path.join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin', 'node'), 'custom-env');
    const envFile = path.join(home, 'elsewhere', 'mb.env');
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeFileSync(envFile, `export MEMORY_BANK_NODE="${envPin}"\n`);
    expect(runPin({ MEMORY_BANK_ENV_FILE: envFile })).toBe('STUB:custom-env');
  });
});
