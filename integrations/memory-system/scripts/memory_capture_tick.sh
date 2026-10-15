#!/bin/bash
# Raw capture stage (launchd com.abdullah.memory-sync, every 120 s): tail new
# Muse Code session logs into memory.db, then copy new OpenCode messages into
# opencode_raw.db and project them into memory.db. It has its own lock and
# deadline. The stage status tracks OpenCode; Muse writes logs/muse_last.json,
# which the health check (muse_lag) reads. It also runs the stall watcher.
set -u
ROOT="$HOME/.local/share/memory-system"
cd "$ROOT" || exit 1
STAGE_LOG="$ROOT/logs/capture-$(date +%Y%m%d).log"
. "$ROOT/scripts/stage_lib.sh"
PY=/opt/homebrew/bin/python3
# soft: stop starting new sessions; hard: kill the whole process tree
SOFT="${MEMORY_CAPTURE_SOFT_SECS:-600}"
HARD="${MEMORY_CAPTURE_HARD_SECS:-1200}"
MUSE_HARD="${MEMORY_MUSE_HARD_SECS:-240}"

bash "$ROOT/scripts/memory_stall_watch.sh" >> "$STAGE_LOG" 2>&1

stage_begin capture "$((HARD + MUSE_HARD))" || exit 0
stage_log "start"
stage_run "$MUSE_HARD" $PY -u src/sync_muse.py --deadline 120 >> "$STAGE_LOG" 2>&1
muse_rc=$?
[ "$muse_rc" = 0 ] || stage_log "muse capture failed rc=$muse_rc"
stage_run "$HARD" $PY -u src/sync_opencode_v2.py --deadline "$SOFT" \
  --progress "$STAGE_STATE/capture.progress.json" >> "$STAGE_LOG" 2>&1
stage_end $?
