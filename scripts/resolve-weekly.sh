#!/bin/bash
# resolve-weekly.sh — launchd 진입점. 비로그인 셸이라 PATH 가 최소이므로 node 를 memory-bank.env 의 정본 핀으로 고른다.
# 실제 일은 scripts/resolve-weekly.mjs 가 한다 (기본 dry-run, MEMORY_BANK_RESOLVE_APPLY=1 또는 --apply 로만 적용).
# 중복 실행 가드: mkdir 락. 6시간 넘은 락은 죽은 런의 잔해로 보고 치운다 (판정 런은 45분 상한 ×3).
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HOME/.claude/memory-bank.env"
LOG_DIR="${MEMORY_BANK_RESOLVE_OUT:-$HOME/.claude/logs/memory-bank-resolve}"
LOCK="$HOME/.claude/state/memory-bank-resolve-weekly.lock"
mkdir -p "$LOG_DIR" "$(dirname "$LOCK")"

NODE_BIN="${MEMORY_BANK_RESOLVE_NODE:-}"
if [ -z "$NODE_BIN" ] && [ -r "$ENV_FILE" ]; then
  NODE_BIN="$(sed -n 's/^export MEMORY_BANK_NODE="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$ENV_FILE" | head -1)"
fi
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  printf '%s resolve-weekly: no node runtime\n' "$(date -u +%FT%TZ)" >> "$LOG_DIR/lane.log"
  exit 3
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || rm -rf "$LOCK"
    mkdir "$LOCK" 2>/dev/null || { printf '%s resolve-weekly: lock contention\n' "$(date -u +%FT%TZ)" >> "$LOG_DIR/lane.log"; exit 0; }
  else
    printf '%s resolve-weekly: already running (lock %s)\n' "$(date -u +%FT%TZ)" "$LOCK" >> "$LOG_DIR/lane.log"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM

printf '%s resolve-weekly: start (apply=%s)\n' "$(date -u +%FT%TZ)" "${MEMORY_BANK_RESOLVE_APPLY:-0}" >> "$LOG_DIR/lane.log"
"$NODE_BIN" "$SELF_DIR/resolve-weekly.mjs" "$@" >> "$LOG_DIR/lane.log" 2>&1
rc=$?
printf '%s resolve-weekly: end rc=%s\n' "$(date -u +%FT%TZ)" "$rc" >> "$LOG_DIR/lane.log"
exit "$rc"
