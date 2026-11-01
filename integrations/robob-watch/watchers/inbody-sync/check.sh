#!/bin/zsh
# Hourly 08:00-12:59 Asia/Dubai: import new InBody scans; print only notable changes.
export TZ=Asia/Dubai
hr=$(date +%H); slot=$(date +%F-%H)
(( 10#$hr >= 8 && 10#$hr <= 12 )) || exit 0
[[ "$(cat "$WATCH_DIR/last_slot" 2>/dev/null)" == "$slot" ]] && exit 0
# No creds yet: stay silent (owner hasn't supplied them).
/usr/bin/security find-generic-password -s inbody-password -a ardud >/dev/null 2>&1 || exit 0
imp=$HOME/health-data/abdullah/inbody/import_inbody.py
if [[ ! -f "$WATCH_DIR/primed" ]]; then
  "$imp" --full >>"$WATCH_DIR/import.out" 2>&1 || exit 1
  touch "$WATCH_DIR/primed"; echo $slot > "$WATCH_DIR/last_slot"; exit 0
fi
out=$("$imp" --alert 2>>"$WATCH_DIR/import.out") || exit 1
echo $slot > "$WATCH_DIR/last_slot"
[[ -n "$out" ]] && print -r -- "$out"
exit 0
