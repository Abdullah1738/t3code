#!/bin/zsh
# activity-digest: fires with a short summary of the unreported lines of the assistant activity log
# when the oldest is 3h+ old, or at 18:00-18:10 Dubai. Never 23:00-08:00 Dubai, and at most once per
# MIN_GAP (2h). The wake text is capped at ~15 lines (totals, counts per topic, path); the full list of
# unreported lines goes to $WATCH_DIR/digests/<stamp>.md for the woken agent to read.
# $WATCH_DIR/marker holds the number of log lines already reported; $WATCH_DIR/last_fire the epoch of
# the last fire. 2026-10-15: replaced a 40-line dump that dropped 30+ items on busy days (72/70 entries).
set -u
LOG="${ACTIVITY_LOG:-$HOME/Documents/assistant/activity-log.md}"
MARKER="$WATCH_DIR/marker"
LAST_FIRE="$WATCH_DIR/last_fire"
DIGESTS="$WATCH_DIR/digests"
MAX_AGE=$((3 * 3600))
MIN_GAP=$((2 * 3600))
# Entries are "- YYYY-MM-DD HH:MM · topic · ..."; agents sometimes drop the "- " or write "~20:45" / "17:3x".
ENTRY_RE='^(- )?[0-9]{4}-[0-9]{2}-[0-9]{2} ~?[0-9]{2}:[0-9x]{2}'
now=${ACTIVITY_NOW:-$(date +%s)}

if [[ ! -f $LOG ]]; then
  mkdir -p "${LOG:h}"
  print -r -- "# Assistant activity log" > "$LOG"
  print -r -- "- YYYY-MM-DD HH:MM · topic · what happened/what I did (one line per silently handled event; Dubai time)" >> "$LOG"
  print -r -- "" >> "$LOG"
fi

total=$(wc -l < "$LOG" | tr -d ' ')
if [[ ! -f $MARKER ]]; then
  print -r -- "$total" > "$MARKER"   # first run: baseline, nothing old fires
  exit 0
fi
seen=$(<"$MARKER")
[[ $seen == <-> ]] || seen=0
(( total < seen )) && seen=0          # log was truncated or rewritten: start over

entries=("${(@f)$(tail -n +$((seen + 1)) "$LOG" | grep -E "$ENTRY_RE" || true)}")
entries=(${entries:#})
(( ${#entries} )) || exit 0

hour=$(TZ=Asia/Dubai date -r "$now" +%H)
minute=$(TZ=Asia/Dubai date -r "$now" +%M)
(( 10#$hour >= 23 || 10#$hour < 8 )) && exit 0

# At most one digest per MIN_GAP. Before last_fire existed, the marker was only written on a fire.
if [[ -f $LAST_FIRE ]]; then last_fire=$(<"$LAST_FIRE"); else last_fire=$(stat -f %m "$MARKER" 2>/dev/null || print 0); fi
[[ $last_fire == <-> ]] || last_fire=0
(( now - last_fire < MIN_GAP )) && exit 0

oldest=${entries[1]#- }
oldest=${${oldest//\~/}[1,16]}
oldest=${oldest//x/0}
oldest_s=$(TZ=Asia/Dubai date -j -f "%Y-%m-%d %H:%M" "$oldest" +%s 2>/dev/null || print "$now")
if (( now - oldest_s < MAX_AGE )) && ! (( 10#$hour == 18 && 10#$minute < 10 )); then
  exit 0
fi

mkdir -p "$DIGESTS"
full="$DIGESTS/$(TZ=Asia/Dubai date -r "$now" +%Y-%m-%d-%H%M).md"
{
  print -r -- "# Activity digest: ${#entries} unreported entries (log lines $((seen + 1))-$total of $LOG)"
  print -r -- ""
  print -rl -- "${entries[@]}"
} > "$full"
summary=$(print -rl -- "${entries[@]}" | /usr/bin/python3 "${0:A:h}/summarize.py" "$full") || { print -r -- "digest summary failed" >&2; exit 1; }
[[ -n $summary ]] || { print -r -- "digest summary empty" >&2; exit 1; }

print -r -- "$total" > "$MARKER"
print -r -- "$now" > "$LAST_FIRE"
old=("$DIGESTS"/*.md(Nom[31,-1]))       # keep the newest 30 digest files
(( ${#old} )) && rm -f -- "${old[@]}"
print -r -- "$summary"
exit 0
