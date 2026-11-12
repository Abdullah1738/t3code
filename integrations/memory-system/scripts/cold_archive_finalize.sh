#!/bin/bash
# One-shot finalizer for the Codex/Hermes cold archive (moved to Dropbox 2026-09-29).
#
# 1. restic check --read-data of the local cold-archive repo (SSD)
# 2. every file to delete is in the snapshot with the same size
# 3. mirror the repo to Dropbox /Backups/memory-system/cold-archive and verify
#    every file by Dropbox content_hash (src/dropbox_mirror.py)
# 4. delete the raw Codex/Hermes session data and the local repo copy
# Usage: cold_archive_finalize.sh [--dry-run]
set -uo pipefail

ROOT="$HOME/.local/share/memory-system"
if [ "${RECALL_FENCED:-}" != 1 ]; then
  exec /opt/homebrew/bin/python3 "$ROOT/src/redact_lock.py" /bin/bash "$0" "$@"
fi
LOGS="$ROOT/logs"
STATUS="$LOGS/cold_finalize.json"
LOG="$LOGS/cold_finalize.log"
LOCK="$LOGS/cold_finalize.lock"
MIRROR="$ROOT/src/dropbox_mirror.py"
DROPBOX_DEST="/Backups/memory-system/cold-archive"
export RESTIC_REPOSITORY="/Volumes/ExternalSSD/memory-system-backup/restic/cold-archive"
export RESTIC_PASSWORD_COMMAND="security find-generic-password -s restic-memory-backup -w"
export RESTIC_CACHE_DIR=/Volumes/ExternalSSD/.restic-cache
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
BUN=/Users/ardud/.bun/bin/bun
TG=/Users/ardud/.local/share/telegram-bridge/src/cli.ts
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

SSD=/Volumes/ExternalSSD
CODEX=$SSD/codex
HERMES=$SSD/migrated/hermes
# Everything below must be inside the snapshot before it is removed.
TARGETS=(
  "$SSD/codex-migration-archive"
  "$SSD/memory-system-data/codex_raw.db"
  "$CODEX/sessions" "$CODEX/archived_sessions"
  "$CODEX/logs_2.sqlite" "$CODEX/logs_2.sqlite-wal" "$CODEX/logs_2.sqlite-shm"
  "$CODEX/state_5.sqlite" "$CODEX/state_5.sqlite-wal" "$CODEX/state_5.sqlite-shm"
  "$CODEX/state.db" "$CODEX/history.jsonl" "$CODEX/session_index.jsonl" "$CODEX/shell_snapshots"
  "$HERMES/state.db" "$HERMES/state.db-wal" "$HERMES/state.db-shm" "$HERMES/state.db.pre-codex-import"
  "$HERMES/sessions" "$HERMES/response_store.db" "$HERMES/response_store.db-wal" "$HERMES/response_store.db-shm"
  "$HERMES/kanban.db" "$HERMES/kanban.db-wal" "$HERMES/kanban.db-shm"
  "$HERMES/verification_evidence.db" "$HERMES/projects.db"
)

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
status() { # state message
  python3 -c 'import json,sys,time; json.dump({"ts":int(time.time()),"state":sys.argv[1],"message":sys.argv[2]},open(sys.argv[3]+".tmp","w"))' "$1" "$2" "$STATUS" \
    && mv "$STATUS.tmp" "$STATUS"
}
notify() { # severity text key
  "$BUN" "$TG" notify --source "Memory cold archive" --severity "$1" --text "$2" --key "$3" >> "$LOG" 2>&1 || true
}
fail() { log "FAIL: $1"; status failed "$1"; notify error "Cold archive finalize stopped: $1. Nothing more was deleted." "memory-cold-finalize:fail:$(date +%F):$(echo "$1" | shasum | cut -c1-8)"; exit 1; }

if [ -f "$STATUS" ] && grep -q '"state": "done"' "$STATUS" && [ ! -d "$RESTIC_REPOSITORY" ]; then exit 0; fi
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
[ -d "$SSD" ] || { status waiting "external SSD not mounted"; exit 0; }

# 1. full local repo read check
restic check --read-data >> "$LOG" 2>&1 || fail "restic check --read-data failed"
SNAP=$(restic snapshots --json --tag codex-hermes-cold latest 2>>"$LOG" | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["id"])') || fail "no cold snapshot"
log "restic check ok, snapshot $SNAP"

# 2. every file under the targets is in the snapshot with the same size
LS=$SSD/.cold_finalize_ls.json
restic ls --json "$SNAP" > "$LS" 2>>"$LOG" || fail "restic ls failed"
python3 - "$LS" "${TARGETS[@]}" >> "$LOG" 2>&1 <<'PY' || fail "snapshot does not cover every file to delete"
import json, os, sys
snap = {}
for line in open(sys.argv[1]):
    d = json.loads(line)
    if d.get("struct_type") == "node" and d.get("type") == "file":
        snap[d["path"]] = d.get("size", 0)
bad, n, total = [], 0, 0
def check(p):
    global n, total
    if os.path.islink(p):
        return
    size = os.path.getsize(p)
    # WAL/SHM side files change size while closed apps idle; content is in the main db
    if p.endswith(("-shm", "-wal")) and p in snap:
        n += 1; return
    if snap.get(p) != size:
        bad.append((p, size, snap.get(p)))
    n += 1; total += size
for t in sys.argv[2:]:
    if not os.path.lexists(t):
        continue
    if os.path.isdir(t) and not os.path.islink(t):
        for dp, dn, fn in os.walk(t):
            for f in fn:
                check(os.path.join(dp, f))
    else:
        check(t)
print(f"verify: {n} files, {total} bytes, {len(bad)} not covered")
for b in bad[:20]:
    print("  not covered:", b)
sys.exit(1 if bad else 0)
PY
log "snapshot covers all targets"

# 3. Dropbox copy, verified by content_hash for every repo file
mout=$(python3 "$MIRROR" "$RESTIC_REPOSITORY" "$DROPBOX_DEST" --delete 2>&1)
log "dropbox mirror: $(printf '%s' "$mout" | tail -1)"
python3 "$MIRROR" "$RESTIC_REPOSITORY" "$DROPBOX_DEST" --verify-only --delete >> "$LOG" 2>&1 \
  || fail "Dropbox copy does not match the local repo"
log "dropbox copy verified"

if [ $DRY = 1 ]; then echo "dry-run: would delete:"; printf '  %s\n' "${TARGETS[@]}"; exit 0; fi

# 4. delete raw data
freed_before=$(df -k "$SSD" | awk 'NR==2{print $4}')
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] || [ -L "$t" ] || continue
  chmod -R u+w "$t" 2>/dev/null
  rm -rf "$t" || fail "rm failed on $t"
  log "deleted $t"
done
rm -f "$ROOT/data/codex_raw.db" "$SSD/memory-system-data/codex_raw.db-journal" "$LS"
freed_after=$(df -k "$SSD" | awk 'NR==2{print $4}')
gb=$(( (freed_after - freed_before) / 1048576 ))

# 5. drop the local copy of the repo (Dropbox keeps it)
rm -rf "$RESTIC_REPOSITORY" && log "deleted local repo $RESTIC_REPOSITORY"

status done "deleted Codex/Hermes raw data and local repo (${gb} GB freed on SSD); archive is in Dropbox $DROPBOX_DEST, snapshot ${SNAP:0:8}"
notify info "Codex/Hermes raw sessions are now only in Dropbox (restic repo $DROPBOX_DEST, snapshot ${SNAP:0:8}). Deleted local copies, ${gb} GB freed." "memory-cold-finalize:dropbox-done"
log "done"
