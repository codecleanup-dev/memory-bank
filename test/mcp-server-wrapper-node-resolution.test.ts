import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(__dirname, '..', 'cli', 'mcp-server-wrapper.js');

// 2026-07-09 regression: the wrapper resolved node via .nvmrc only, while every other
// entry point (bootstrap, sync loop, toolchain probe) converged on the runtime pinned
// in ~/.claude/memory-bank.env. better-sqlite3 was ABI-built for the env-pinned node,
// so the MCP read path died while writers stayed up. These tests pin the resolution
// order: MEMORY_BANK_NODE_BIN → memory-bank.env pin (allowlisted) → .nvmrc → execPath.
// POSIX-only: stub node binaries are shell scripts.
describe.skipIf(process.platform === 'win32')('mcp-server-wrapper node resolution', () => {
  let home: string;
  let pluginRoot: string;
  let marker: string;

  function makeStubNode(binPath: string): string {
    mkdirSync(path.dirname(binPath), { recursive: true });
    writeFileSync(binPath, '#!/bin/sh\necho "$0" >> "$WRAPPER_TEST_MARKER"\nexit 0\n');
    chmodSync(binPath, 0o755);
    return binPath;
  }

  function runWrapper(extraEnv: Record<string, string | undefined> = {}): string {
    const res = spawnSync(process.execPath, [WRAPPER], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        WRAPPER_TEST_MARKER: marker,
        ...extraEnv,
      },
      timeout: 15000,
      encoding: 'utf8',
    });
    expect(res.error).toBeUndefined();
    return existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'wrapper-home-'));
    pluginRoot = path.join(home, 'plugin');
    // node_modules present → wrapper skips npm install; dist/mcp-server.js must exist.
    mkdirSync(path.join(pluginRoot, 'node_modules'), { recursive: true });
    mkdirSync(path.join(pluginRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(pluginRoot, 'dist', 'mcp-server.js'), '// fixture\n');
    marker = path.join(home, 'spawned.txt');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('prefers the memory-bank.env pin over .nvmrc', () => {
    const envPinNode = makeStubNode(path.join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'node'));
    makeStubNode(path.join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin', 'node'));
    writeFileSync(path.join(pluginRoot, '.nvmrc'), '20.0.0\n');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'memory-bank.env'),
      `export MEMORY_BANK_NODE="${envPinNode}"\n`
    );
    expect(runWrapper()).toBe(envPinNode);
  });

  it('falls back to .nvmrc when no env file exists', () => {
    const nvmrcNode = makeStubNode(path.join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin', 'node'));
    writeFileSync(path.join(pluginRoot, '.nvmrc'), '20.0.0\n');
    expect(runWrapper()).toBe(nvmrcNode);
  });

  it('lets MEMORY_BANK_NODE_BIN override the env-file pin', () => {
    const envPinNode = makeStubNode(path.join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'node'));
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude', 'memory-bank.env'),
      `export MEMORY_BANK_NODE="${envPinNode}"\n`
    );
    const explicit = makeStubNode(path.join(home, 'explicit', 'node'));
    expect(runWrapper({ MEMORY_BANK_NODE_BIN: explicit })).toBe(explicit);
  });

  it('ignores an env-file pin outside the allowlist (tamper posture)', () => {
    const evil = makeStubNode(path.join(home, 'evil', 'node'));
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'memory-bank.env'), `export MEMORY_BANK_NODE="${evil}"\n`);
    const nvmrcNode = makeStubNode(path.join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin', 'node'));
    writeFileSync(path.join(pluginRoot, '.nvmrc'), '20.0.0\n');
    expect(runWrapper()).toBe(nvmrcNode);
  });

  it('honors MEMORY_BANK_ENV_FILE override for the pin location', () => {
    const envPinNode = makeStubNode(path.join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'node'));
    const altEnvFile = path.join(home, 'alt-memory-bank.env');
    writeFileSync(altEnvFile, `export MEMORY_BANK_NODE="${envPinNode}"\n`);
    expect(runWrapper({ MEMORY_BANK_ENV_FILE: altEnvFile })).toBe(envPinNode);
  });
});
