#!/bin/zsh
# Fires at/after 09:00 Asia/Dubai (only 09:00-12:00 so a late Mac wake doesn't spam in the evening).
# Nightly fix 2026-10-22: the same two items were asked about every morning for 9 days with no answer.
# Now it fires only when the Pending list changed since the last ask, or once a week (Mondays) if unchanged.
export TZ=Asia/Dubai
today=$(date +%F); hr=$(date +%H); dow=$(date +%u)
last=$(cat "$WATCH_DIR/last_fired" 2>/dev/null)
pending=$(sed -n '/## Pending/,/## Log/p' ~/Documents/assistant/shopping-list.md | grep '^- ')
hash=$(print -r -- "$pending" | shasum | cut -c1-16)
last_hash=$(cat "$WATCH_DIR/last_hash" 2>/dev/null)
if [[ ! -f "$WATCH_DIR/primed" ]]; then touch "$WATCH_DIR/primed"; [[ $hr -ge 9 ]] && echo $today > "$WATCH_DIR/last_fired"; echo $hash > "$WATCH_DIR/last_hash"; exit 0; fi
[[ "$last" == "$today" || $hr -lt 9 || $hr -ge 12 ]] && exit 0
if [[ "$hash" == "$last_hash" && $dow -ne 1 ]]; then exit 0; fi
echo $today > "$WATCH_DIR/last_fired"
echo $hash > "$WATCH_DIR/last_hash"
if [[ "$hash" == "$last_hash" ]]; then
  echo "Weekly shopping-list check ($today). Unchanged since $(cat "$WATCH_DIR/last_changed" 2>/dev/null || echo 'last ask')."
else
  echo $today > "$WATCH_DIR/last_changed"
  echo "Morning shopping-list check ($today)"
fi
[[ -n "$pending" ]] && print -r -- "$pending" || echo "(list is empty)"
exit 0
