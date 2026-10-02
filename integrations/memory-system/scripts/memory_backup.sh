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
export RESTIC_PASSWORD_COMMAND="security find-generic-password -s restic-memory-backup -w"
export RESTIC_CACHE_DIR="/Volumes/ExternalSSD/.restic-cache"
RESTIC=/opt/homebrew/bin/restic
SQRSYNC="$ROOT/bin/sqlite3_rsync"
SQLITE=/opt/homebrew/opt/sqlite/bin/sqlite3
STATUS="$LOGDIR/backup_last.json"
LOG="$LOGDIR/backup-$(date +%Y%m).log"
LOCK="$LOGDIR/backup.lock"
PRUNE_STAMP="$LOGDIR/backup_prune.stamp"
MIN_FREE_GB="${MEMORY_BACKUP_MIN_FREE_GB:-25}"

mkdir -p "$LOGDIR"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    log "skip: backup $holder still running"; exit 0
  fi
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

log "backup start"
[ -d "$STAGE" ] || mkdir -p "$STAGE" 2>/dev/null || fail stage "cannot create $STAGE (SSD mounted?)"
[ -f "$RESTIC_REPOSITORY/config" ] || fail repo "restic repo missing: $RESTIC_REPOSITORY (SSD mounted?)"
free_gb=$(df -g "$REPO_ROOT" | awk 'NR==2{print $4}')
[ "$free_gb" -ge "$MIN_FREE_GB" ] || fail disk "SSD free ${free_gb}G < ${MIN_FREE_GB}G"

# 1. replicas
for db in memory.db opencode_raw.db consolidation.db fact_vectors.db; do
  [ -f "$DATA/$db" ] || continue
  out=$("$SQRSYNC" "$DATA/$db" "$STAGE/$db" 2>&1) || fail replica "$db: $out"
done
"$SQLITE" "$DATA/agent_notes.db" ".backup '$STAGE/agent_notes.db'" 2>>"$LOG" || fail replica "agent_notes.db backup failed"
# sqlite3_rsync verifies page hashes itself; here we only confirm each replica
# opens and has a schema (quick_check on the 70 GB memory.db takes too long).
for db in memory.db opencode_raw.db consolidation.db fact_vectors.db agent_notes.db; do
  [ -f "$STAGE/$db" ] || continue
  q=$("$SQLITE" -readonly "$STAGE/$db" "SELECT count(*) > 0 FROM sqlite_master;" 2>&1 | head -1)
  [ "$q" = "1" ] || fail verify "$db replica unreadable: $q"
done
q=$("$SQLITE" -readonly "$STAGE/memory.db" "SELECT (SELECT max(id) FROM episodic_events) >= $(
  "$SQLITE" -readonly "$DATA/memory.db" "SELECT max(id) FROM episodic_events WHERE timestamp < strftime('%s','now','-1 day')")" 2>&1)
[ "$q" = "1" ] || fail verify "memory.db replica behind live: $q"
mkdir -p "$STAGE/files"
/opt/homebrew/bin/rsync -a --delete \
  --include='profile*' --include='*.md' --include='*.json' --include='*.txt' --exclude='*' \
  "$DATA/" "$STAGE/files/data/" >>"$LOG" 2>&1 || fail files "rsync data files"
/opt/homebrew/bin/rsync -a --delete --exclude='__pycache__' --exclude='*.pyc' \
  "$ROOT/src" "$ROOT/scripts" "$ROOT/schema" "$ROOT/sql" "$ROOT/HANDOFF.md" \
  "$STAGE/files/" >>"$LOG" 2>&1 || fail files "rsync code"
cp -p "$HOME/Library/LaunchAgents/"com.abdullah.memory-*.plist "$STAGE/files/" 2>/dev/null

# 2. snapshot
out=$(nice -n 10 "$RESTIC" backup --host ardud-mac --tag memory-live --json --quiet \
  --pack-size 64 "$STAGE" 2>&1)
rc=$?
summary=$(printf '%s\n' "$out" | grep '"message_type":"summary"' | tail -1)
[ $rc -eq 0 ] && [ -n "$summary" ] || fail restic "rc=$rc $(printf '%s' "$out" | tail -c 600)"
snap=$(printf '%s' "$summary" | /opt/homebrew/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshot_id"][:8])')
added=$(printf '%s' "$summary" | /opt/homebrew/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("data_added_packed",0))')
log "snapshot $snap added_packed=$added"

# 3. retention, daily
if [ ! -f "$PRUNE_STAMP" ] || [ $(( $(date +%s) - $(stat -f %m "$PRUNE_STAMP") )) -gt 86400 ]; then
  pout=$(nice -n 10 "$RESTIC" forget --host ardud-mac --tag memory-live \
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

write_status 1 done "ok" "$snap" "$added"
log "backup done ($(( $(date +%s) - START ))s)"
