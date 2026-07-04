#!/usr/bin/env node
/**
 * Cross-platform wrapper script for MCP server that ensures dependencies are installed
 * This runs before the MCP server starts and works on Windows, macOS, and Linux
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Determine plugin root directory
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..');

// [fork] Native deps (better-sqlite3) are ABI-built for the runtime pinned in .nvmrc,
// so the server must start on a matching node even when PATH points at a newer one.
// Resolution: MEMORY_BANK_NODE_BIN → .nvmrc (exact, then same-major highest) → process.execPath
function resolveNodeBin() {
  const envBin = process.env.MEMORY_BANK_NODE_BIN;
  if (envBin && existsSync(envBin)) return envBin;
  try {
    const pin = readFileSync(join(PLUGIN_ROOT, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
    const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
    const exact = join(nvmDir, `v${pin}`, 'bin', 'node');
    if (existsSync(exact)) return exact;
    const major = pin.split('.')[0];
    const sameMajor = readdirSync(nvmDir)
      .filter((d) => d.startsWith(`v${major}.`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of sameMajor) {
      const candidate = join(nvmDir, d, 'bin', 'node');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // no .nvmrc or no nvm install — fall back to the invoking runtime
  }
  return process.execPath;
}

const NODE_BIN = resolveNodeBin();

// Helper function to run npm install
function runNpmInstall() {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const npmFromPin = join(dirname(NODE_BIN), 'npm');
    const npmCommand = isWindows ? 'npm.cmd' : existsSync(npmFromPin) ? npmFromPin : 'npm';

    console.error('Installing memory-bank dependencies (first run only)...');
    console.error('This may take 30-60 seconds...');

    // Install dependencies - npm will auto-install optionalDependencies for current platform
    const child = spawn(npmCommand, ['install', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: PLUGIN_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows // On Windows, we need shell: true to find npm.cmd
    });

    child.stdout.on('data', (data) => {
      // Suppress npm install output to stderr to avoid cluttering MCP logs
      process.stderr.write(data);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        console.error('Dependencies installed successfully.');
        resolve();
      } else {
        console.error('ERROR: Failed to install dependencies.');
        console.error(`Please run manually: cd "${PLUGIN_ROOT}" && npm install`);
        reject(new Error(`npm install failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to run npm install: ${err.message}`);
      reject(err);
    });
  });
}

async function main() {
  try {
    // Check if node_modules exists
    const nodeModulesPath = join(PLUGIN_ROOT, 'node_modules');
    if (!existsSync(nodeModulesPath)) {
      await runNpmInstall();
    }

    // Start the MCP server
    const mcpServerPath = join(PLUGIN_ROOT, 'dist', 'mcp-server.js');

    if (!existsSync(mcpServerPath)) {
      console.error(`ERROR: MCP server not found at ${mcpServerPath}`);
      console.error('Please run: npm run build');
      process.exit(1);
    }

    // Use spawn with shell: false for better cross-platform compatibility
    const child = spawn(NODE_BIN, [mcpServerPath], {
      stdio: 'inherit',
      shell: false
    });

    // Forward signals to the child process
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => child.kill('SIGINT'));

    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        process.exit(code || 0);
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to start MCP server: ${err.message}`);
      process.exit(1);
    });

  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Unexpected error: ${error.message}`);
  process.exit(1);
});