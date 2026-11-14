#!/bin/bash
# Backup of ~/health-data/abdullah to Dropbox. Mirrors the memory-system backup
# (integrations/memory-system/scripts/memory_backup.sh):
#   1. consistent snapshots of every SQLite DB in the vault (sqlite3 .backup, safe
#      while other agents write; WAL/journal files are never copied raw)
#      + PRAGMA quick_check on each snapshot
#   2. rsync of every other file (exports, PDFs, imports, scripts, raw API pages)
#   3. restic snapshot into an encrypted local repo (dedup; password in Keychain
#      `restic-health-backup`)
#   4. retention once a day (forget --prune)
#   5. mirror the repo to Dropbox /Backups/health-data/restic with the memory
#      system's dropbox_mirror.py (dbxcli upload, verified by Dropbox content_hash)
# Status: ~/.local/share/health-backup/backup_last.json. LaunchAgent com.abdullah.health-backup.
set -u
mac_log() { :; }
. "${MAC_LOG_HOME:-$HOME/.local/lib/mac-logging}/toollog.sh" 2>/dev/null || :
TL_START=$(date +%s)
TL_RESTIC_RC=""
TL_SNAPSHOT_AT=0
TL_SKIP_REASON=other
summary=""
backup_log_exit() {
  local status=$?
  printf '%s' "$summary" | mac_log backup health "$TL_START" "$TL_RESTIC_RC" "$status" "$TL_SNAPSHOT_AT" "$TL_SKIP_REASON" "${LOCK:-}"
}
trap backup_log_exit EXIT
VAULT="${HEALTH_VAULT:-$HOME/health-data/abdullah}"
ROOT="$HOME/.local/share/health-backup"
STAGE="$ROOT/stage"
export RESTIC_REPOSITORY="$ROOT/restic"
export RESTIC_PASSWORD_COMMAND="security find-generic-password -s restic-health-backup -a ardud -w"
export RESTIC_CACHE_DIR="$ROOT/.restic-cache"
DROPBOX_DEST="/Backups/health-data/restic"
MIRROR="$HOME/.local/share/memory-system/src/dropbox_mirror.py"
RESTIC=/opt/homebrew/bin/restic
SQLITE=/opt/homebrew/opt/sqlite/bin/sqlite3
[ -x "$SQLITE" ] || SQLITE=/usr/bin/sqlite3
PY=/opt/homebrew/bin/python3
STATUS="$ROOT/backup_last.json"
LOG="$ROOT/backup-$(date +%Y%m).log"
LOCK="$ROOT/backup.lock"
PRUNE_STAMP="$ROOT/prune.stamp"
NOTIFY="$HOME/.bun/bin/bun $HOME/.local/share/telegram-bridge/src/cli.ts"

mkdir -p "$ROOT" "$STAGE"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ] && ps -p "$holder" -o command= 2>/dev/null | grep -q health_backup.sh; then
    TL_SKIP_REASON=lock_held
    log "skip: backup $holder still running"; exit 0
  fi
  log "removing stale lock (holder ${holder:-?} gone)"; rm -rf "$LOCK"; mkdir "$LOCK" || exit 0
fi
echo $$ > "$LOCK/pid"
trap 'backup_log_exit; rm -rf "$LOCK"' EXIT
START=$(date +%s)

write_status() { # ok stage message snapshot files
  "$PY" - "$STATUS" "$1" "$2" "$3" "$4" "$5" "$START" <<'PY'
import json, sys, time, os
path, ok, stage, msg, snap, files, start = sys.argv[1:8]
prev = {}
try: prev = json.load(open(path))
except Exception: pass
now = int(time.time())
st = {"ts": now, "ok": ok == "1", "stage": stage, "message": msg[-800:], "snapshot": snap or None,
      "dropbox": files or None, "duration_s": now - int(start),
      "last_success_ts": now if ok == "1" else prev.get("last_success_ts"),
      "last_snapshot": snap if ok == "1" and snap else prev.get("last_snapshot")}
json.dump(st, open(path + ".tmp", "w"), indent=1); os.replace(path + ".tmp", path)
PY
}
fail() {
  if [ "$TL_SNAPSHOT_AT" = 0 ] && { [ "$TL_SKIP_REASON" = other ] || [ -z "$TL_SKIP_REASON" ]; }; then
    TL_SKIP_REASON=$(printf '%s' "$2" | mac_log backup-reason "$1" "$TL_RESTIC_RC")
    TL_SKIP_REASON=${TL_SKIP_REASON:-other}
  fi
  log "FAIL [$1] $2"; write_status 0 "$1" "$2" "" ""
  # one Telegram alert per failing stage per day
  nout=$($NOTIFY notify --source "health-data backup" --severity attention \
    --text "Health-data Dropbox backup failed at $1: ${2:0:200}" --key "health-backup:$1:$(date +%F)" 2>&1) \
    || log "telegram alert failed: $(printf '%s' "$nout" | tail -c 300)"
  exit 1
}

log "backup start"
# canonical (no symlinked parts): snapshot_extra.py refuses destinations that go through a symlink
STAGE=$(cd "$STAGE" && pwd -P) || fail stage "stage dir unreadable: $STAGE"
# output roots are rebuilt or synced below; a symlink there would send rsync --delete or cp elsewhere
for p in db files files-extra meta meta-pet-records.SKILL.md; do
  [ -L "$STAGE/$p" ] && { log "removing symlink in stage: $p"; rm -f "$STAGE/$p"; }
done
[ -d "$VAULT" ] || fail vault "vault missing: $VAULT"
if [ ! -f "$RESTIC_REPOSITORY/config" ]; then
  out=$("$RESTIC" init 2>&1)
  rc=$?
  TL_RESTIC_RC=$(printf '%s' "$out" | mac_log backup-restic-exit "$RESTIC" "$rc")
  printf '%s\n' "$out" >>"$LOG"
  if [ "$rc" != 0 ]; then
    TL_SKIP_REASON=$(printf '%s' "$out" | mac_log backup-reason repo "$TL_RESTIC_RC")
    fail repo "restic init failed"
  fi
  log "initialised repo $RESTIC_REPOSITORY"
fi

# 1. DB snapshots (any *.db / *.sqlite in the vault, any depth)
rm -rf "$STAGE/db"; mkdir -p "$STAGE/db"
ndb=0
while IFS= read -r -d '' db; do
  rel="${db#$VAULT/}"
  dst="$STAGE/db/$rel"
  mkdir -p "$(dirname "$dst")"
  "$SQLITE" "$db" ".timeout 30000" ".backup '$dst'" 2>>"$LOG" || fail snapshot "$rel: .backup failed"
  # self-contained file: WAL-mode snapshots can't be opened read-only without a -shm
  "$SQLITE" "$dst" "PRAGMA journal_mode=DELETE;" >/dev/null 2>>"$LOG" || fail snapshot "$rel: journal_mode"
  q=$("$SQLITE" -readonly "$dst" "PRAGMA quick_check;" 2>&1 | head -1)
  [ "$q" = "ok" ] || fail verify "$rel snapshot quick_check: $q"
  ndb=$((ndb+1))
done < <(find "$VAULT" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0)
# 1b. extra data dirs outside the vault (same treatment): pet records
EXTRA_DIRS=("$HOME/Documents/assistant/pets")
for ex in "${EXTRA_DIRS[@]}"; do
  # required: snapshot_extra.py fails the run when the dir is missing or unreadable
  name=$(basename "$ex")
  # the live DB the dir must yield; old copies under backups/ would keep the count positive without it
  case "$name" in pets) req=pets.db ;; *) req= ;; esac
  # Homebrew python, not find/sqlite3/rsync: under launchd only it may read ~/Documents (see snapshot_extra.py)
  mkdir -p "$STAGE/files-extra"
  xout=$("$PY" "$VAULT/backup/snapshot_extra.py" "$ex" "$STAGE/db/_extra/$name" "$STAGE/files-extra/$name" $req 2>&1)
  xrc=$?
  if [ $xrc -ne 0 ]; then
    [ -d "$ex" ] || TL_SKIP_REASON=source_missing
    [ -z "$req" ] || [ -f "$ex/$req" ] || TL_SKIP_REASON=source_missing
    fail snapshot "extra $name: $(printf '%s' "$xout" | tail -c 300)"
  fi
  [ "$xout" -gt 0 ] 2>/dev/null || fail snapshot "extra $name: no databases found"
  log "snapshotted $xout databases from $ex"
  ndb=$((ndb+xout))
done
cp -p "$HOME/.config/opencode/skills/pet-records/SKILL.md" "$STAGE/meta-pet-records.SKILL.md" 2>/dev/null
log "snapshotted $ndb databases"

# 2. everything else (raw exports, PDFs, imports, scripts); live DB files and their journals excluded
/opt/homebrew/bin/rsync -a --delete \
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db-journal' \
  --exclude='*.sqlite' --exclude='*.sqlite-wal' --exclude='*.sqlite-shm' --exclude='*.sqlite3' \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='.DS_Store' --exclude='.watch-state' \
  "$VAULT/" "$STAGE/files/" >>"$LOG" 2>&1 || fail files "rsync vault files"
rm -rf "$STAGE/meta"; mkdir "$STAGE/meta"
cp -p "$HOME/Library/LaunchAgents/com.abdullah.health-backup.plist" "$STAGE/meta/" 2>/dev/null
cp -p "$HOME/.config/opencode/skills/nutrition-tracker/SKILL.md" "$STAGE/meta/nutrition-tracker.SKILL.md" 2>/dev/null
for w in nutrition-checkin nutrition-nudge forge-workouts; do
  [ -f "$HOME/.local/share/robob-watch/watchers/$w/watcher.json" ] && cp -p "$HOME/.local/share/robob-watch/watchers/$w/watcher.json" "$STAGE/meta/watcher-$w.json"
done

# 3. snapshot
out=$(nice -n 10 "$RESTIC" backup --host ardud-mac --tag health-data --json --quiet "$STAGE" 2>&1)
rc=$?
TL_RESTIC_RC=$(printf '%s' "$out" | mac_log backup-restic-exit "$RESTIC" "$rc")
TL_SKIP_REASON=""
summary=$(printf '%s\n' "$out" | grep '"message_type":"summary"' | tail -1)
[ $rc -eq 0 ] && [ -n "$summary" ] || fail restic "rc=$rc $(printf '%s' "$out" | tail -c 400)"
snap=$(printf '%s' "$summary" | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["snapshot_id"][:8])')
TL_SNAPSHOT_AT=$(date +%s)
TL_SKIP_REASON=""
log "snapshot $snap"

# 4. retention, daily
if [ ! -f "$PRUNE_STAMP" ] || [ $(( $(date +%s) - $(stat -f %m "$PRUNE_STAMP") )) -gt 86400 ]; then
  pout=$("$RESTIC" forget --host ardud-mac --tag health-data \
    --keep-last 8 --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --keep-yearly 5 --prune 2>&1)
  prc=$?
  log "prune rc=$prc $(printf '%s' "$pout" | tail -2 | tr '\n' ' ')"
  [ $prc -eq 0 ] && touch "$PRUNE_STAMP"
  # monthly deep integrity check of the repo
  if [ "$(date +%d)" = "01" ]; then
    "$RESTIC" check --read-data-subset=10% >>"$LOG" 2>&1 || fail check "restic check failed"
  fi
fi

# 5. Dropbox mirror
mout=$("$PY" "$MIRROR" "$RESTIC_REPOSITORY" "$DROPBOX_DEST" --delete 2>&1)
mrc=$?
log "dropbox mirror rc=$mrc $(printf '%s' "$mout" | tail -1)"
[ $mrc -eq 0 ] || fail dropbox "mirror rc=$mrc $(printf '%s' "$mout" | tail -c 400)"
write_status 1 done "ok ($ndb dbs)" "$snap" "$(printf '%s' "$mout" | tail -1)"
log "backup done ($(( $(date +%s) - START ))s)"
