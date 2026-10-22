#!/bin/bash
# keystone-launchd-label: com.codecleanup.memory-bank-resolve-weekly
# Register the weekly consistency-queue resolve lane (dry-run by default) as a macOS LaunchAgent.
#
# Schedule: Sunday 08:33 — before keystone's loopy-era weekly review (Sunday 09:30) so section 3o
# can show this week's dry-run. Applying stays a human decision: re-register with
# MEMORY_BANK_RESOLVE_APPLY=1 only after that decision (docs/2026-10-05-relation-resolution.md).
#
# usage: register-resolve-weekly-launchd.sh [--dry-run] [--unregister] [--apply-mode]
#   --dry-run      print the plist, change nothing
#   --unregister   bootout + remove the plist
#   --apply-mode   register with MEMORY_BANK_RESOLVE_APPLY=1 (graph-changing; needs the owner's decision)
# env: MEMORY_BANK_RESOLVE_WEEKDAY (0-7, default 0) · MEMORY_BANK_RESOLVE_HOUR (default 8) · MEMORY_BANK_RESOLVE_MINUTE (default 33)
set -euo pipefail

LABEL="com.codecleanup.memory-bank-resolve-weekly"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WEEKDAY="${MEMORY_BANK_RESOLVE_WEEKDAY:-0}"
HOUR="${MEMORY_BANK_RESOLVE_HOUR:-8}"
MINUTE="${MEMORY_BANK_RESOLVE_MINUTE:-33}"
DRY=0; UNREG=0; APPLY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --unregister) UNREG=1 ;;
    --apply-mode) APPLY=1 ;;
    *) echo "usage: $0 [--dry-run] [--unregister] [--apply-mode]" >&2; exit 2 ;;
  esac
done
for v in "$WEEKDAY:0:7" "$HOUR:0:23" "$MINUTE:0:59"; do
  n="${v%%:*}"; rest="${v#*:}"; lo="${rest%%:*}"; hi="${rest#*:}"
  case "$n" in *[!0-9]*|"") echo "schedule must be an integer: $n" >&2; exit 2 ;; esac
  [ "$n" -ge "$lo" ] && [ "$n" -le "$hi" ] || { echo "schedule out of range: $n ($lo-$hi)" >&2; exit 2; }
done

if [ "$UNREG" = "1" ]; then
  if [ "$DRY" = "1" ]; then                      # --dry-run never changes anything, whatever else is passed
    echo "[dry-run] would bootout gui/$(id -u)/$LABEL and remove $PLIST"
    exit 0
  fi
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "unregistered $LABEL"
  exit 0
fi

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e "s/'/\&apos;/g" -e 's/"/\&quot;/g'; }
RUNNER="$(xml_escape "$REPO_ROOT/scripts/resolve-weekly.sh")"
LOG="$(xml_escape "$HOME/.claude/logs/memory-bank-resolve/launchd.log")"
APPLY_ENV=""
if [ "$APPLY" = "1" ]; then
  APPLY_ENV="    <key>MEMORY_BANK_RESOLVE_APPLY</key><string>1</string>
"
fi
PLIST_BODY="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
${APPLY_ENV}  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>$WEEKDAY</integer>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>"

if [ "$DRY" = "1" ]; then
  printf '%s\n' "$PLIST_BODY"
  exit 0
fi
[ -x "$REPO_ROOT/scripts/resolve-weekly.sh" ] || { echo "runner not executable: $REPO_ROOT/scripts/resolve-weekly.sh" >&2; exit 1; }
mkdir -p "$(dirname "$PLIST")" "$HOME/.claude/logs/memory-bank-resolve"
printf '%s\n' "$PLIST_BODY" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "registered $LABEL (weekday $WEEKDAY $HOUR:$MINUTE, apply=$APPLY) -> $PLIST"
