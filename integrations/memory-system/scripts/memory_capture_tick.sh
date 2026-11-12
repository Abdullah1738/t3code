#!/bin/bash
# Raw capture stage (launchd com.abdullah.memory-sync, every 120 s): tail new
# Muse Code session logs into memory.db, then copy new OpenCode messages into
# opencode_raw.db and project them into memory.db. It has its own lock and
# deadline. The stage status tracks OpenCode; Muse writes logs/muse_last.json,
# which the health check (muse_lag) reads. It also runs the stall watcher.
set -u
# launchd's LowPriorityIO puts this job (and every child) at IOPOL_THROTTLE. Since
# the data moved to the USB ExternalSSD (2026-11-02) throttled reads drop to
# ~0.05 MB/s whenever anything else touches the disk, and ticks went from ~15 s to
# 600-1200 s with stage timeouts. Re-run once at normal I/O priority; launchd's
# Nice 10 still applies.
if [ -z "${MEMORY_TICK_IOPOL:-}" ] && [ -x /usr/sbin/taskpolicy ]; then
  export MEMORY_TICK_IOPOL=default
  exec /usr/sbin/taskpolicy -d default /bin/bash "$0" "$@"
fi
ROOT="$HOME/.local/share/memory-system"
if [ "${RECALL_FENCED:-}" != 1 ]; then
  exec /opt/homebrew/bin/python3 "$ROOT/src/redact_lock.py" /bin/bash "$0" "$@"
fi
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

WAL_HARD="${MEMORY_WAL_HARD_SECS:-120}"

bash "$ROOT/scripts/memory_stall_watch.sh" >> "$STAGE_LOG" 2>&1

# identity 60 s + rules 15 s are fixed stage limits below
stage_begin capture "$((HARD + MUSE_HARD + CLAUDE_HARD_STAGE + CODEX_HARD_STAGE + 60 + 15 + WAL_HARD))" || exit 0
stage_log "start"
# Every stage runs even when an earlier one fails; the aggregate status below
# is failed if any of them failed (the stage's own status only reflects the
# last command, which hid Muse and Claude failures before).
# The one-time source CHECK widening (schema_migrations) is an in-place catalog
# edit, measured in well under a second on the 97 GB memory.db, so it fits any
# stage budget below. The full 12-step table rebuild is never run by a tick.
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
stage_run 60 $PY -u src/sync_thread_identity.py --deadline 45 >> "$STAGE_LOG" 2>&1
identity_rc=$?
[ "$identity_rc" = 0 ] || { stage_log "thread identity failed rc=$identity_rc"; agg=1; }
stage_run "$HARD" $PY -u src/sync_opencode_v2.py --deadline "$SOFT" \
  --progress "$STAGE_STATE/capture.progress.json" >> "$STAGE_LOG" 2>&1
opencode_rc=$?
[ "$opencode_rc" = 0 ] || { stage_log "opencode capture failed rc=$opencode_rc"; agg=1; }
# Rules capture is a separate bounded projection. Missing sources fail here,
# never by opening the provider's live database from a prompt hook.
rules_args=(--db "${RECALL_RULES_DB:-$ROOT/data/recall_rules.db}"
  --skills "$HOME/.config/opencode/skills" --agents "$HOME/.config/opencode/AGENTS.md"
  --transcripts "${MEMORY_DB:-$ROOT/data/memory.db}" --max-rows 5000 --seconds 2 --repo-agents)
stage_run 15 $PY -u scripts/index_rules.py "${rules_args[@]}" >> "$STAGE_LOG" 2>&1
rules_rc=$?
[ "$rules_rc" = 0 ] || { stage_log "rules capture failed rc=$rules_rc"; agg=1; }
# Writers run with auto-checkpoints off, so reset the WALs here with a
# zero-wait PASSIVE then TRUNCATE checkpoint. A busy reader only means "next
# tick"; it never fails the tick. Without this the memory.db WAL grew to 9 GB
# and the sqlite3_rsync replica backup timed out on every run (Nov 2026).
# Runs last, after every writer including the rules projection.
stage_run "$WAL_HARD" $PY -u src/wal_truncate.py >> "$STAGE_LOG" 2>&1
wal_rc=$?
[ "$wal_rc" = 0 ] || stage_log "wal truncate rc=$wal_rc (ignored)"
stage_log "rc muse=$muse_rc claude=$claude_rc codex=$codex_rc identity=$identity_rc opencode=$opencode_rc rules=$rules_rc wal=$wal_rc"
if [ "$agg" = 0 ]; then stage_end 0; else stage_end 1; fi
