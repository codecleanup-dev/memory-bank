#!/bin/bash
# upstream(jung-wan-kim/memory-bank) head 변경 감지 → 알림 전용.
# 자동 병합/업데이트는 하지 않는다 — 이식은 사람이 triage 후 진행 (PORT-PLAN.md 운영 계약).
set -uo pipefail

UPSTREAM_URL="${MEMORY_BANK_UPSTREAM_URL:-https://github.com/jung-wan-kim/memory-bank.git}"
STATE_DIR="${MEMORY_BANK_WATCH_STATE_DIR:-$HOME/.claude/logs}"
STATE_FILE="$STATE_DIR/memory-bank-upstream-head.txt"
TAG_STATE_FILE="$STATE_DIR/memory-bank-upstream-tag.txt"
LOG_FILE="$STATE_DIR/memory-bank-upstream-watch.log"

mkdir -p "$STATE_DIR"

cur="$(git ls-remote "$UPSTREAM_URL" HEAD 2>/dev/null | awk '{print $1}')"
[ -n "$cur" ] || exit 0   # 네트워크 실패는 조용히 종료 — 다음 주기에 재시도

# 릴리스 태그 감지: head 잔변경보다 태그가 triage 신호로 훨씬 강하다.
# (2026-07 실측: head 알림만으로는 v1.3.3→v1.3.4 사이 48커밋이 조용히 누적)
latest_tag="$(git ls-remote --tags --refs "$UPSTREAM_URL" 'v*' 2>/dev/null \
  | awk -F/ '{print $NF}' | sort -V | tail -1)"
prev_tag="$(cat "$TAG_STATE_FILE" 2>/dev/null || true)"
new_release=""
if [ -n "$latest_tag" ] && [ "$latest_tag" != "$prev_tag" ]; then
  printf '%s\n' "$latest_tag" > "$TAG_STATE_FILE"
  [ -n "$prev_tag" ] && new_release="$latest_tag"
fi

prev="$(cat "$STATE_FILE" 2>/dev/null || true)"
if [ "$cur" = "$prev" ] && [ -z "$new_release" ]; then exit 0; fi

printf '%s\n' "$cur" > "$STATE_FILE"
[ -z "$prev" ] && exit 0   # 첫 실행은 기준점 기록만

if [ -n "$new_release" ]; then
  printf '%s upstream RELEASE %s (head %.8s -> %.8s)\n' "$(date '+%F %T')" "$new_release" "$prev" "$cur" >> "$LOG_FILE"
  msg="upstream memory-bank 릴리스 $new_release — PORT-PLAN 절차로 병합 검토 권장"
else
  printf '%s upstream head %.8s -> %.8s\n' "$(date '+%F %T')" "$prev" "$cur" >> "$LOG_FILE"
  msg="upstream memory-bank에 새 커밋 — PORT-PLAN 절차로 이식 검토"
fi
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"$msg\" with title \"memory-bank fork\"" >/dev/null 2>&1 || true
fi
