#!/bin/bash
# upstream(jung-wan-kim/memory-bank) head 변경 감지 → 알림 전용.
# 자동 병합/업데이트는 하지 않는다 — 이식은 사람이 triage 후 진행 (PORT-PLAN.md 운영 계약).
set -uo pipefail

UPSTREAM_URL="${MEMORY_BANK_UPSTREAM_URL:-https://github.com/jung-wan-kim/memory-bank.git}"
STATE_DIR="${MEMORY_BANK_WATCH_STATE_DIR:-$HOME/.claude/logs}"
STATE_FILE="$STATE_DIR/memory-bank-upstream-head.txt"
LOG_FILE="$STATE_DIR/memory-bank-upstream-watch.log"

mkdir -p "$STATE_DIR"

cur="$(git ls-remote "$UPSTREAM_URL" HEAD 2>/dev/null | awk '{print $1}')"
[ -n "$cur" ] || exit 0   # 네트워크 실패는 조용히 종료 — 다음 주기에 재시도

prev="$(cat "$STATE_FILE" 2>/dev/null || true)"
[ "$cur" = "$prev" ] && exit 0

printf '%s\n' "$cur" > "$STATE_FILE"
[ -z "$prev" ] && exit 0   # 첫 실행은 기준점 기록만

printf '%s upstream head %.8s -> %.8s\n' "$(date '+%F %T')" "$prev" "$cur" >> "$LOG_FILE"
if command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "upstream memory-bank에 새 커밋 — PORT-PLAN 절차로 이식 검토" with title "memory-bank fork"' >/dev/null 2>&1 || true
fi
