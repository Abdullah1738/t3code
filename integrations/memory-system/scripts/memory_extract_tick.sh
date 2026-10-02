#!/bin/bash
# Fact extraction stage (launchd com.abdullah.memory-extract, every 120 s).
# Extracts facts from OpenCode sessions the capture stage touched since the
# last successful extraction. Separate lock and deadline from capture, so a
# model outage or a hang here never stops raw capture.
set -u
ROOT="$HOME/.local/share/memory-system"
cd "$ROOT" || exit 1
STAGE_LOG="$ROOT/logs/extract-$(date +%Y%m%d).log"
. "$ROOT/scripts/stage_lib.sh"
PY=/opt/homebrew/bin/python3
HARD="${MEMORY_EXTRACT_HARD_SECS:-1500}"
# ongoing extraction: $1000 per calendar month (extraction+judge+profile);
# the one-time $200 cumulative cap only applies to the historical backfill
BUDGET="${MEMORY_EXTRACT_MONTHLY_BUDGET:-1000}"
MODEL="${MEMORY_EXTRACT_MODEL:-glm-5.3-flash}"

bash "$ROOT/scripts/memory_stall_watch.sh" >> "$STAGE_LOG" 2>&1

stage_begin extract "$HARD" || exit 0
# don't compete with a manual bulk extractor run
if pgrep -f "chronological_extractor.py --workers 64" >/dev/null; then
  stage_log "bulk extractor running; extract skipped"
  stage_end 0
  exit 0
fi
# Sessions synced since the last successful extraction started (10 min
# overlap, at least the last hour, at most 7 days back). A failed or timed-out
# run leaves extract.last_ok_start alone, so the next run covers the same
# range again; finished windows are recorded per window in extraction_runs,
# so the retry skips them and only does what is left.
NOW=$(stage_now)
LAST=$(cat "$STAGE_STATE/extract.last_ok_start" 2>/dev/null || echo 0)
SINCE=$((NOW - 3600))
[ "$LAST" -gt 0 ] && [ $((LAST - 600)) -lt "$SINCE" ] && SINCE=$((LAST - 600))
[ "$SINCE" -lt $((NOW - 7 * 86400)) ] && SINCE=$((NOW - 7 * 86400))
stage_log "start (changed-since $(date -r "$SINCE" '+%F %T'))"
# near-real-time: includes still-active sessions; the MCP server's embed
# loop vectors new facts <60 s later
stage_run "$HARD" $PY -u src/chronological_extractor.py --sources opencode --workers 16 \
  --active --max-cost "$BUDGET" --budget-mode monthly --model "$MODEL" \
  --changed-since "$SINCE" >> "$STAGE_LOG" 2>&1
stage_end $?
