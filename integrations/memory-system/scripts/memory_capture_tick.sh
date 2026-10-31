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
CLAUDE_HARD_STAGE="${MEMORY_CLAUDE_HARD_SECS:-240}"
CODEX_HARD_STAGE="${MEMORY_CODEX_HARD_SECS:-240}"

bash "$ROOT/scripts/memory_stall_watch.sh" >> "$STAGE_LOG" 2>&1

stage_begin capture "$((HARD + MUSE_HARD + 2 * CLAUDE_HARD_STAGE + 60))" || exit 0
stage_log "start"
# Every stage runs even when an earlier one fails; the aggregate status below
# is failed if any of them failed (the stage's own status only reflects the
# last command, which hid Muse and Claude failures before).
agg=0
stage_run "$MUSE_HARD" $PY -u src/sync_muse.py --deadline 120 >> "$STAGE_LOG" 2>&1
muse_rc=$?
[ "$muse_rc" = 0 ] || { stage_log "muse capture failed rc=$muse_rc"; agg=1; }
stage_run "$CLAUDE_HARD_STAGE" $PY -u src/sync_claude.py --deadline 120 >> "$STAGE_LOG" 2>&1
claude_rc=$?
[ "$claude_rc" = 0 ] || { stage_log "claude capture failed rc=$claude_rc"; agg=1; }
stage_run "$CODEX_HARD_STAGE" $PY -u src/sync_codex.py --deadline 120 >> "$STAGE_LOG" 2>&1
codex_rc=$?
[ "$codex_rc" = 0 ] || { stage_log "codex capture failed rc=$codex_rc"; agg=1; }
stage_run 60 $PY -u src/sync_thread_identity.py >> "$STAGE_LOG" 2>&1
identity_rc=$?
[ "$identity_rc" = 0 ] || { stage_log "thread identity failed rc=$identity_rc"; agg=1; }
stage_run "$HARD" $PY -u src/sync_opencode_v2.py --deadline "$SOFT" \
  --progress "$STAGE_STATE/capture.progress.json" >> "$STAGE_LOG" 2>&1
opencode_rc=$?
[ "$opencode_rc" = 0 ] || { stage_log "opencode capture failed rc=$opencode_rc"; agg=1; }
stage_log "rc muse=$muse_rc claude=$claude_rc codex=$codex_rc identity=$identity_rc opencode=$opencode_rc"
if [ "$agg" = 0 ]; then stage_end 0; else stage_end 1; fi
