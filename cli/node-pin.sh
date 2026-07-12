#!/bin/bash
# [fork] Run a plugin JS entry on the ONE pinned runtime shared by every entry
# point (mcp wrapper, bootstrap self-heal, sync loop, toolchain probe). Native
# deps (better-sqlite3) are ABI-built for that runtime — a PATH-resolved bare
# `node` here is exactly how the ABI splits of 2026-07-05 / 2026-07-09 happened
# (module ABI 147 vs launch node ABI 127 → read path dead while writers ran).
# Resolution order mirrors cli/mcp-server-wrapper.js and is contract-tested in
# test/node-pin-resolution.test.ts:
#   MEMORY_BANK_NODE_BIN → memory-bank.env pin (allowlisted paths only)
#   → .nvmrc (exact, then same-major highest) → PATH node
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$SELF_DIR")}"

resolve_node() {
  # 1. explicit override
  if [ -n "${MEMORY_BANK_NODE_BIN:-}" ] && [ -x "$MEMORY_BANK_NODE_BIN" ]; then
    printf '%s' "$MEMORY_BANK_NODE_BIN"; return
  fi
  # 2. memory-bank.env pin — execute only well-known user-owned install
  #    locations (homebrew / usr-local / usr-bin / nvm): a tampered env file
  #    must not become arbitrary-binary execution (same posture as the wrapper).
  local env_file="${MEMORY_BANK_ENV_FILE:-$HOME/.claude/memory-bank.env}"
  if [ -r "$env_file" ]; then
    local pinned
    pinned="$(sed -n 's/^export MEMORY_BANK_NODE="\([^"]*\)"$/\1/p' "$env_file" | head -1)"
    if [ -n "$pinned" ] && [ -x "$pinned" ]; then
      case "$pinned" in
        /opt/homebrew/bin/node|/usr/local/bin/node|/usr/bin/node)
          printf '%s' "$pinned"; return ;;
        "$HOME"/.nvm/versions/node/*/bin/node)
          printf '%s' "$pinned"; return ;;
      esac
    fi
  fi
  # 3. .nvmrc — exact version, then highest same-major nvm install
  if [ -r "$PLUGIN_ROOT/.nvmrc" ]; then
    local pin major cand
    pin="$(tr -d 'v[:space:]' < "$PLUGIN_ROOT/.nvmrc")"
    cand="$HOME/.nvm/versions/node/v$pin/bin/node"
    if [ -x "$cand" ]; then printf '%s' "$cand"; return; fi
    major="${pin%%.*}"
    cand="$(ls -d "$HOME/.nvm/versions/node/v$major."*/bin/node 2>/dev/null | sort -V | tail -1)"
    if [ -n "$cand" ] && [ -x "$cand" ]; then printf '%s' "$cand"; return; fi
  fi
  # 4. PATH fallback — better than failing outright on machines with no pin
  command -v node || true
}

NODE_BIN="$(resolve_node)"
if [ -z "$NODE_BIN" ]; then
  echo "node-pin: no node runtime found" >&2
  exit 127
fi
exec "$NODE_BIN" "$@"
