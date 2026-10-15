#!/bin/bash
# Raw-capture stall watcher. Called at the start of each capture tick; the
# health check (com.abdullah.memory-health) also flags capture lag. Pure bash
# plus system binaries, so it works while Homebrew python launches hang.
# When the last successful capture is older than MEMORY_STALL_SECS (default
# 6 h), it sends ONE Telegram alert per stall episode. The episode ends
# when capture succeeds again.
#
# --test-notify sends a clearly labelled test alert and exits.
set -u
ROOT="${MEMORY_ROOT:-$HOME/.local/share/memory-system}"
STATE_DIR="$ROOT/logs/state"
STALL_SECS="${MEMORY_STALL_SECS:-21600}"
BUN="${MEMORY_TG_BUN:-$HOME/.bun/bin/bun}"
TG_CLI="${MEMORY_TG_CLI:-$HOME/.local/share/telegram-bridge/src/cli.ts}"
ALERTED="$STATE_DIR/capture.stall_alerted"
mkdir -p "$STATE_DIR"

log() { echo "$(date '+%F %T') [stall-watch] $*"; }

# run with a hard deadline (bun is not a system binary and can hang too)
run_deadline() {  # secs cmd...
  local d=$1 pid t=0
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$t" -ge "$d" ]; then
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 1
    t=$((t + 1))
  done
  wait "$pid"
}

notify() {  # severity key text
  run_deadline 60 "$BUN" "$TG_CLI" notify --source "Memory capture" \
    --severity "$1" --key "$2" --text "$3" >/dev/null 2>&1
}

if [ "${1:-}" = "--test-notify" ]; then
  notify info "memory-stall-watch:test:$(date +%Y%m%d%H%M)" \
    "Test of the memory capture stall alert (no action needed)."
  rc=$?
  log "test notify rc=$rc"
  exit $rc
fi

now=$(date +%s)
last_ok=$(cat "$STATE_DIR/capture.last_ok" 2>/dev/null || echo 0)
if [ "$last_ok" = 0 ]; then
  # no successful capture recorded yet: count from when watching began
  [ -f "$STATE_DIR/capture.watch_since" ] || echo "$now" > "$STATE_DIR/capture.watch_since"
  last_ok=$(cat "$STATE_DIR/capture.watch_since")
fi
age=$((now - last_ok))

if [ "$age" -le "$STALL_SECS" ]; then
  if [ -f "$ALERTED" ]; then
    log "capture recovered (last ok ${age}s ago); stall episode $(cat "$ALERTED") closed"
    rm -f "$ALERTED"
  fi
  exit 0
fi

# one alert per stall episode (episode id = last successful capture time)
[ "$(cat "$ALERTED" 2>/dev/null)" = "$last_ok" ] && exit 0
# take a tiny lock so overlapping ticks don't both send. A lock
# left by a killed watcher (older than 5 min; a send takes at most ~60 s)
# is removed, otherwise no alert could ever be sent again.
WL="$STATE_DIR/stall_watch.lock"
if [ -d "$WL" ] && [ $((now - $(stat -f %m "$WL" 2>/dev/null || echo "$now"))) -gt 300 ]; then
  log "removing stale stall_watch.lock"
  rmdir "$WL" 2>/dev/null
fi
mkdir "$WL" 2>/dev/null || exit 0
trap 'rmdir "$STATE_DIR/stall_watch.lock" 2>/dev/null' EXIT
[ "$(cat "$ALERTED" 2>/dev/null)" = "$last_ok" ] && exit 0

hours=$((age / 3600))
detail=$(sed -n 's/.*"state": "\([a-z]*\)".*"rc": \([0-9a-z]*\).*/last run \1, rc \2/p' \
  "$ROOT/logs/capture_last.json" 2>/dev/null)
text="Memory raw capture has not completed for ${hours} h (since $(date -r "$last_ok" '+%F %H:%M')). New OpenCode sessions are not reaching memory. ${detail:-no capture status}. Check logs/capture-*.log and logs/state/ in ~/.local/share/memory-system."
if notify error "memory-capture-stall:$last_ok" "$text"; then
  echo "$last_ok" > "$ALERTED"
  log "ALERT sent: capture stalled ${age}s"
else
  log "ALERT send failed (rc=$?); will retry next tick"
fi
