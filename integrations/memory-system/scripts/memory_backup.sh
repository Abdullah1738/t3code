#!/bin/bash
# Continuous backup of the memory system to Dropbox.
#
# 1. Consistent replicas of the live SQLite DBs on the external SSD
#    (sqlite3_rsync: page-level incremental, safe while the DBs are written).
# 2. restic snapshot of the replicas + profile/config files into an encrypted
#    local repo on the SSD (dedup, so each run adds only changed chunks).
# 3. Retention (forget + prune) once a day.
# 4. Mirror the repo to Dropbox (/Backups/memory-system/live) with the official
#    Dropbox CLI (src/dropbox_mirror.py), verified by Dropbox content_hash.
# Status goes to logs/backup_last.json; the health check reads it.
set -u
ROOT="$HOME/.local/share/memory-system"
DATA="$ROOT/data"
LOGDIR="$ROOT/logs"
STAGE="${MEMORY_BACKUP_STAGE:-/Volumes/ExternalSSD/memory-system-backup/replica}"
REPO_ROOT="${MEMORY_BACKUP_REPO_ROOT:-/Volumes/ExternalSSD/memory-system-backup/restic}"
export RESTIC_REPOSITORY="$REPO_ROOT/live"
DROPBOX_DEST="/Backups/memory-system/live"
MIRROR="$ROOT/src/dropbox_mirror.py"
export RESTIC_PASSWORD_COMMAND="${MEMORY_BACKUP_PASSWORD_COMMAND:-security find-generic-password -s restic-memory-backup -w}"
export RESTIC_CACHE_DIR="${MEMORY_BACKUP_CACHE_DIR:-/Volumes/ExternalSSD/.restic-cache}"
RESTIC=/opt/homebrew/bin/restic
SQRSYNC="$ROOT/bin/sqlite3_rsync"
SQLITE=/opt/homebrew/opt/sqlite/bin/sqlite3
STATUS="$LOGDIR/backup_last.json"
LOG="$LOGDIR/backup-$(date +%Y%m).log"
LOCK="$LOGDIR/backup.lock"
PRUNE_STAMP="$LOGDIR/backup_prune.stamp"
MIN_FREE_GB="${MEMORY_BACKUP_MIN_FREE_GB:-25}"
REPLICA_TIMEOUT_S="${MEMORY_BACKUP_REPLICA_TIMEOUT_S:-10800}"
RESTIC_TIMEOUT_S="${MEMORY_BACKUP_RESTIC_TIMEOUT_S:-7200}"

mkdir -p "$LOGDIR"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  # launchd never overlaps runs, so this only sees manual runs or a lock left
  # by a killed run. A hung run is reported by health_check.py (backup_lock).
  if [ -n "$holder" ] && ps -p "$holder" -o command= 2>/dev/null | grep -q memory_backup.sh; then
    log "skip: backup $holder still running"; exit 0
  fi
  log "removing stale backup.lock (holder ${holder:-?} is gone)"
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 0
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

START=$(date +%s)
write_status() { # ok stage message snapshot added_bytes
  /opt/homebrew/bin/python3 - "$STATUS" "$1" "$2" "$3" "$4" "$5" "$START" <<'PY'
import json, sys, time, os
path, ok, stage, msg, snap, added, start = sys.argv[1:8]
prev = {}
try:
    prev = json.load(open(path))
except Exception:
    pass
now = int(time.time())
st = {
    "ts": now, "ok": ok == "1", "stage": stage, "message": msg[-800:],
    "snapshot": snap or None, "data_added": int(added or 0),
    "duration_s": now - int(start),
    "last_success_ts": now if ok == "1" else prev.get("last_success_ts"),
    "last_snapshot": snap if ok == "1" and snap else prev.get("last_snapshot"),
}
tmp = path + ".tmp"
json.dump(st, open(tmp, "w"), indent=1)
os.replace(tmp, path)
PY
}
fail() { log "FAIL [$1] $2"; write_status 0 "$1" "$2" "" 0; exit 1; }
run_bg_limited() { # seconds command...
  local seconds="$1"; shift
  /opt/homebrew/bin/python3 "$ROOT/src/run_limited.py" --seconds "$seconds" --background -- "$@"
}

log "backup start"
[ -d "$STAGE" ] || mkdir -p "$STAGE" 2>/dev/null || fail stage "cannot create $STAGE (SSD mounted?)"
[ -f "$RESTIC_REPOSITORY/config" ] || fail repo "restic repo missing: $RESTIC_REPOSITORY (SSD mounted?)"
free_gb=$(df -g "$REPO_ROOT" | awk 'NR==2{print $4}')
[ "$free_gb" -ge "$MIN_FREE_GB" ] || fail disk "SSD free ${free_gb}G < ${MIN_FREE_GB}G"

# 1. replicas
# sqlite3_rsync can exit 0 without bringing the replica up to date (seen
# 2026-09-30..10-02: memory.db replica frozen for two days while every run
# "succeeded"). So record the live high-water mark of the append-only tables
# *before* syncing and require the replica to reach it afterwards; retry once,
# then fail loudly.
hwm_sql() { # replica name -> query returning the append-only high-water mark ("" = none)
  case "$1" in
    memory.db) echo "SELECT coalesce(max(id),0) FROM episodic_events" ;;
    opencode_raw.db) echo "SELECT coalesce(max(rowid),0) FROM raw_messages" ;;
    *) echo "" ;;
  esac
}
replicate() { # live-path replica-name
  local src="$1" db="$2" sql want="" out got attempt rc replica_start
  sql=$(hwm_sql "$db")
  if [ -n "$sql" ]; then
    want=$("$SQLITE" -readonly "$src" "$sql" 2>&1)
    [[ "$want" =~ ^[0-9]+$ ]] || fail replica "$db: cannot read live high-water mark: $want"
  fi
  for attempt in 1 2; do
    replica_start=$(date +%s)
    rc=0
    out=$(run_bg_limited "$REPLICA_TIMEOUT_S" "$SQRSYNC" -v "$src" "$STAGE/$db" 2>&1) || rc=$?
    if [ "$rc" -eq 124 ]; then
      [ -z "$out" ] || log "replica $db timeout output: $(printf '%s' "$out" | tail -c 600)"
      fail replica "$db: sqlite3_rsync timed out after $REPLICA_TIMEOUT_S s (disk contention?)"
    fi
    [ "$rc" -eq 0 ] || fail replica "$db: $out"
    log "replica $db try$attempt: elapsed_s=$(( $(date +%s) - replica_start )) $(printf '%s' "$out" | tail -1)"
    [ -z "$want" ] && break
    got=$("$SQLITE" -readonly "$STAGE/$db" "$sql" 2>&1)
    [[ "$got" =~ ^[0-9]+$ ]] && [ "$got" -ge "$want" ] && break
    [ "$attempt" = 2 ] && fail replica "$db replica not updated by sqlite3_rsync: replica=$got live>=$want"
    log "replica $db behind after sync (replica=$got live>=$want), retrying"
  done
}
# recall_catalog.db is derived from memory.db (rebuilt in ~1 min), so it is not backed up.
for db in memory.db opencode_raw.db; do
  [ -f "$DATA/$db" ] && replicate "$DATA/$db" "$db"
done
# Under launchd only the Homebrew binaries (sqlite3, python3, rsync, restic)
# may touch files on the SSD; /bin/bash redirections, rm, mv, cp and grep get
# "Operation not permitted". So all file work in $STAGE goes through them.
# Replicas of retired databases (facts, vectors, notes) and the old full Robob
# state replica are deleted, and excluded from the snapshot in case that fails.
RETIRED=("consolidation.db*" "fact_vectors.db*" "agent_notes.db*" "robob-state.sqlite*")
out=$(/opt/homebrew/bin/python3 - "$STAGE" "${RETIRED[@]}" <<'PY' 2>&1
import glob, os, sys
for pat in sys.argv[2:]:
    for p in glob.glob(os.path.join(sys.argv[1], pat)):
        os.remove(p)
        print("removed", os.path.basename(p))
PY
) || log "retired replicas not removed: $(printf '%s' "$out" | tail -1)"
[ -n "$out" ] && log "$(printf '%s' "$out" | tr '\n' ' ')"
# Robob state: only the small tables nothing else backs up (schedules, projects,
# session board, OpenCode import map, thread origins, thread/subagent index), plus
# the retired missions' tables (ardud_mission_*), kept in the DB as an archive.
# A name with % is a LIKE pattern (sqlite .dump takes them).
# The full DB is ~70 GB of event log and message projections rebuilt from the
# OpenCode/Muse sessions that memory.db and opencode_raw.db already hold; it
# added 2-4 GB to restic every run. .dump reads in one transaction (~2 s).
# Restore: sqlite3 new.sqlite < robob-state.sql. Skipped until Robob is installed.
ROBOB_DB="${ROBOB_STATE_DB:-$HOME/.robob/userdata/statev2.sqlite}"
ROBOB_TABLES="scheduled_tasks projection_projects ardud_board_% ardud_kanban_% ardud_mission_%
  ardud_opencode_import ardud_opencode_import_state ardud_thread_origin
  orchestration_v2_projection_threads orchestration_v2_projection_provider_threads
  orchestration_v2_projection_provider_session_bindings
  orchestration_v2_projection_subagents effect_sql_migrations"
if [ -f "$ROBOB_DB" ]; then
  out=$("$SQLITE" -readonly -bail "$ROBOB_DB" ".output '$STAGE/robob-state.sql.tmp'" \
    ".dump $(echo $ROBOB_TABLES)" 2>&1) || fail replica "robob-state.sql: $out"
  [ -z "$out" ] || fail replica "robob-state.sql: $out"
  # Check, then move into place. A table Robob renamed or dropped is skipped by
  # .dump; it's logged as missing, not a failure.
  out=$(/opt/homebrew/bin/python3 - "$STAGE" $ROBOB_TABLES <<'PY' 2>&1
import os, re, sys
stage, tables = sys.argv[1], sys.argv[2:]
tmp, dst = os.path.join(stage, "robob-state.sql.tmp"), os.path.join(stage, "robob-state.sql")
text = open(tmp, encoding="utf-8", errors="replace").read()
made = set(re.findall(r'^CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?', text, re.M))
if not made:
    sys.exit("no tables dumped")
os.replace(tmp, dst)
def like(pat):
    return re.compile("".join(".*" if c == "%" else "." if c == "_" else re.escape(c) for c in pat) + "$")
missing = [t for t in tables if not any(like(t).match(m) for m in made)]
print(f"{len(made)} tables, {os.path.getsize(dst)} bytes" + (", missing: " + " ".join(missing) if missing else ""))
PY
) || fail replica "robob-state.sql: $(printf '%s' "$out" | tail -1)"
  log "robob-state.sql: $out"
fi
# sqlite3_rsync verifies page hashes itself and replicate() already checked
# each replica against the live high-water mark taken before its sync; here we
# only confirm each replica opens and has a schema (quick_check on the 70 GB
# memory.db takes too long). Don't compare against live again: rows inserted
# after the sync can carry old timestamps (reprojection), so that races.
for db in memory.db opencode_raw.db; do
  [ -f "$STAGE/$db" ] || continue
  q=$("$SQLITE" -readonly "$STAGE/$db" "SELECT count(*) > 0 FROM sqlite_master;" 2>&1 | head -1)
  [ "$q" = "1" ] || fail verify "$db replica unreadable: $q"
done
mkdir -p "$STAGE/files"
/opt/homebrew/bin/rsync -a --delete \
  --include='profile*' --include='*.md' --include='*.json' --include='*.txt' --exclude='*' \
  "$DATA/" "$STAGE/files/data/" >>"$LOG" 2>&1 || fail files "rsync data files"
/opt/homebrew/bin/rsync -a --delete --exclude='__pycache__' --exclude='*.pyc' \
  "$ROOT/src" "$ROOT/scripts" "$ROOT/HANDOFF.md" \
  "$STAGE/files/" >>"$LOG" 2>&1 || fail files "rsync code"
# Muse Code's own session logs are the raw source for its rows in memory.db
# (append-only JSONL, like opencode_raw.db is for OpenCode).
MUSE_SESSIONS="${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions"
if [ -d "$MUSE_SESSIONS" ]; then
  # Skip Muse's live scratch (spool/tmp files, its own SQLite DBs, locks). rsync
  # exits 24 when a file vanishes mid-copy; that's fine for a live tree.
  mrc=0
  /opt/homebrew/bin/rsync -a --delete --delete-excluded --exclude='.msp-view-v1/' --exclude='.spool/' \
    --exclude='*.tmp' --exclude='*.lock' --exclude='*.sqlite3*' --exclude='*.db' --exclude='*.db-*' \
    "$MUSE_SESSIONS/" "$STAGE/files/muse-sessions/" >>"$LOG" 2>&1 || mrc=$?
  [ "$mrc" = 0 ] || [ "$mrc" = 24 ] || fail files "rsync muse sessions rc=$mrc"
fi
/opt/homebrew/bin/rsync -a "$HOME/Library/LaunchAgents/"com.abdullah.memory-*.plist \
  "$HOME/Library/LaunchAgents/com.abdullah.recall.plist" "$STAGE/files/" 2>/dev/null
# Harness transcripts (Claude Code and Codex homes). Only transcript dirs are
# copied; auth/credential files and SQLite/WAL files are excluded. The manifest
# below must match the staged copy, or the run fails.
HARNESS="${ROBOB_HARNESS_HOMES:-$HOME/.robob/harness-homes}"
TSTAGE="$STAGE/files/transcripts"
TMANIFEST="$STAGE/files/transcript-manifest"
TRANSCRIPT_PAIRS=("claude/projects" "codex/sessions" "codex/archived_sessions" "codex-cu/sessions" "codex-cu/archived_sessions")
# Clean the entire persistent stage, even roots missing from the source. Python
# is allowed to write on the SSD under launchd, unlike system rm, cp and find.
out=$(/opt/homebrew/bin/python3 "$ROOT/src/transcript_backup_manifest.py" prepare "$STAGE" "${TRANSCRIPT_PAIRS[@]}" 2>&1) \
  || fail files "transcript stage preparation: $(printf '%s' "$out" | tail -1)"
for pair in "${TRANSCRIPT_PAIRS[@]}"; do
  src="$HARNESS/$pair"
  [ -d "$src" ] || continue
  dst="$TSTAGE/$pair"
  /opt/homebrew/bin/rsync -a --no-links --no-specials --no-devices --delete --delete-excluded \
    --exclude='.credentials.json' --exclude='auth.json' --exclude='settings.local.json' \
    --exclude='*.key' --exclude='*.sqlite*' --exclude='*.db' --exclude='*.db-*' --exclude='*-wal' --exclude='*-shm' \
    "$src/" "$dst/" >>"$LOG" 2>&1 || fail files "rsync harness transcripts $pair"
done
# Build and verify inside the actual snapshot tree, not just in live data.
mout=$(/opt/homebrew/bin/python3 "$ROOT/src/transcript_backup_manifest.py" build "$TSTAGE" "$TMANIFEST" 2>&1) \
  || fail files "transcript manifest build: $(printf '%s' "$mout" | tail -1)"
MPATH="$mout"
vout=$(/opt/homebrew/bin/python3 "$ROOT/src/transcript_backup_manifest.py" verify "$MPATH" "$TSTAGE" 2>&1) \
  || fail files "transcript manifest mismatch: $(printf '%s' "$vout" | tail -1)"
log "transcript manifest $(basename "$MPATH") verified"

# 2. snapshot
excl=(--exclude "$STAGE/robob-state.sql.tmp" --exclude "$STAGE/files/data/backup-manifests")
for p in "${RETIRED[@]}"; do excl+=(--exclude "$STAGE/$p"); done
# Scope the second fence to transcripts so database replicas elsewhere remain.
for p in '.credentials.json' 'auth.json' 'settings.local.json' '*.key' '*.sqlite*' '*.db' '*.db-*' '*-wal' '*-shm'; do
  excl+=(--exclude "$TSTAGE/$p" --exclude "$TSTAGE/**/$p")
done
out=$(run_bg_limited "$RESTIC_TIMEOUT_S" nice -n 10 "$RESTIC" backup --host ardud-mac --tag memory-live --json --quiet \
  --pack-size 64 "${excl[@]}" "$STAGE" 2>&1)
rc=$?
if [ "$rc" -eq 124 ]; then
  [ -z "$out" ] || log "restic timeout output: $(printf '%s' "$out" | tail -c 600)"
  fail restic "restic backup timed out after $RESTIC_TIMEOUT_S s (disk contention?)"
fi
summary=$(printf '%s\n' "$out" | grep '"message_type":"summary"' | tail -1)
[ $rc -eq 0 ] && [ -n "$summary" ] || fail restic "rc=$rc $(printf '%s' "$out" | tail -c 600)"
snap=$(printf '%s' "$summary" | /opt/homebrew/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshot_id"][:8])')
added=$(printf '%s' "$summary" | /opt/homebrew/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("data_added_packed",0))')
log "snapshot $snap added_packed=$added"

# 3. retention, daily
if [ ! -f "$PRUNE_STAMP" ] || [ $(( $(date +%s) - $(stat -f %m "$PRUNE_STAMP") )) -gt 86400 ]; then
  pout=$(/usr/sbin/taskpolicy -b nice -n 10 "$RESTIC" forget --host ardud-mac --tag memory-live \
    --keep-last 12 --keep-daily 7 --keep-weekly 4 --keep-monthly 6 \
    --prune --max-unused 15% 2>&1)
  prc=$?
  log "prune rc=$prc $(printf '%s' "$pout" | tail -3 | tr '\n' ' ')"
  [ $prc -eq 0 ] && touch "$PRUNE_STAMP"
fi

# 4. Dropbox mirror (upload new packs, delete pruned ones, verify hashes)
mout=$(/opt/homebrew/bin/python3 "$MIRROR" "$RESTIC_REPOSITORY" "$DROPBOX_DEST" --delete 2>&1)
mrc=$?
log "dropbox mirror rc=$mrc $(printf '%s' "$mout" | tail -1)"
[ $mrc -eq 0 ] || fail dropbox "mirror rc=$mrc $(printf '%s' "$mout" | tail -c 600)"
printf '%s' "$mout" | tail -1 > "$LOGDIR/dropbox_mirror_live.json"

# The reaper must never see a manifest for a failed snapshot or mirror. Publish
# the bytes from that snapshot, failing if the staged tree changed meanwhile.
pout=$(/opt/homebrew/bin/python3 "$ROOT/src/transcript_backup_manifest.py" publish "$MPATH" "$TSTAGE" "$DATA/backup-manifests" 2>&1) \
  || fail files "transcript manifest publish: $(printf '%s' "$pout" | tail -1)"
log "transcript manifest published: $pout"
write_status 1 done "ok" "$snap" "$added"
log "backup done ($(( $(date +%s) - START ))s)"
