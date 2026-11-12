#!/bin/bash
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL=com.abdullah.memory-backup
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVICE="gui/$(id -u)/$LABEL"
DOMAIN="gui/$(id -u)"
if [ "${1:-}" = --dry-run ]; then
  echo "Install $HERE/$LABEL.plist -> $PLIST; reload $SERVICE (refuse a running backup)"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/share/memory-system/logs"
pending=$(mktemp "$HOME/Library/LaunchAgents/.$LABEL.XXXXXX")
restore=0
finish() {
  rc=$?
  trap - EXIT
  trap '' INT TERM HUP
  if [ "$restore" = 1 ]; then
    # bootout may return (or be interrupted) before launchd removes the job.
    # Seeing it once here does not prove that it will remain loaded.
    for ((attempt=0; attempt<300; attempt++)); do
      launchctl print "$SERVICE" >/dev/null 2>&1 || break
      sleep 0.1
    done
    if ! launchctl print "$SERVICE" >/dev/null 2>&1; then
      launchctl bootstrap "$DOMAIN" "$PLIST" || { echo "Could not restore $SERVICE" >&2; rc=1; }
    else
      echo "Unload did not finish after 30 s; inspect $SERVICE before retrying" >&2
      rc=1
    fi
  fi
  rm -f "$pending"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

/usr/bin/python3 - "$HERE/$LABEL.plist" "$pending" <<'PY'
import os, plistlib, sys
def render(value):
    if isinstance(value, str):
        return value.replace('__HOME__', os.environ['HOME'])
    if isinstance(value, list):
        return [render(v) for v in value]
    if isinstance(value, dict):
        return {k: render(v) for k, v in value.items()}
    return value
with open(sys.argv[1], 'rb') as f:
    config = render(plistlib.load(f))
with open(sys.argv[2], 'wb') as f:
    plistlib.dump(config, f)
PY
chmod 644 "$pending"
if current=$(launchctl print "$SERVICE" 2>/dev/null); then
  # Reloading also resets StartInterval; frequent source deploys must not
  # postpone the next backup when the installed configuration is unchanged.
  if cmp -s "$pending" "$PLIST"; then
    exit 0
  fi
  if printf '%s\n' "$current" | /usr/bin/grep -Eq '^[[:space:]]*pid = [0-9]+'; then
    echo "Backup is running; install after it exits" >&2
    exit 1
  fi
  # Arm before bootout: even a signal while launchctl returns must restore it.
  restore=1
  launchctl bootout "$SERVICE"
  for ((attempt=0; attempt<300; attempt++)); do
    launchctl print "$SERVICE" >/dev/null 2>&1 || break
    sleep 0.1
  done
  if launchctl print "$SERVICE" >/dev/null 2>&1; then
    echo "Timed out waiting for $SERVICE to unload" >&2
    exit 1
  fi
fi
mv "$pending" "$PLIST"
restore=1
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl print "$SERVICE" >/dev/null
restore=0
