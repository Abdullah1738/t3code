#!/bin/bash
# Regression test for the 2026-09-30..10-02 frozen-replica incident:
# sqlite3_rsync exited 0 without updating the memory.db replica and every
# backup "succeeded" for two days. memory_backup.sh must now fail at the
# replica stage when the replica doesn't reach the live high-water mark.
# Runs in a scratch HOME; touches no real data. Usage: bash tests/test_backup_replica.sh
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SQLITE=/opt/homebrew/opt/sqlite/bin/sqlite3
REAL_RSYNC="$HOME/.local/share/memory-system/bin/sqlite3_rsync"
FAIL=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

setup() { # fake-or-real sqlite3_rsync
  T=$(mktemp -d "${TMPDIR:-/tmp}/backuptest.XXXXXX")
  R="$T/.local/share/memory-system"
  mkdir -p "$R/data" "$R/bin" "$R/logs" "$R/scripts" "$R/src" "$R/schema" "$R/sql" "$T/stage" "$T/repo/live"
  touch "$R/HANDOFF.md"
  echo x > "$T/repo/live/config"
  cp "$HERE/scripts/memory_backup.sh" "$R/scripts/"
  old=$(( $(date +%s) - 3 * 86400 ))
  "$SQLITE" "$R/data/memory.db" "PRAGMA journal_mode=wal;
    CREATE TABLE episodic_events(id INTEGER PRIMARY KEY, timestamp INTEGER);
    INSERT INTO episodic_events VALUES (1,$old),(2,$old);" >/dev/null
  "$SQLITE" "$R/data/agent_notes.db" "CREATE TABLE n(x);"
  if [ "$1" = fake ]; then
    # silent no-op on later runs: exit 0 and leave the replica untouched
    printf '#!/bin/bash\n[ -f "${@: -1}" ] || cp "${@: -2:1}" "${@: -1}"\nexit 0\n' > "$R/bin/sqlite3_rsync"
    chmod +x "$R/bin/sqlite3_rsync"
  else
    ln -s "$REAL_RSYNC" "$R/bin/sqlite3_rsync"
  fi
}
run() {
  HOME="$T" MEMORY_BACKUP_STAGE="$T/stage" MEMORY_BACKUP_REPO_ROOT="$T/repo" \
    MEMORY_BACKUP_MIN_FREE_GB=0 bash "$R/scripts/memory_backup.sh" >/dev/null 2>&1
}
st() { /opt/homebrew/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["stage"], d["ok"])' "$R/logs/backup_last.json"; }

# 1. sync silently does nothing -> fail at replica, not "ok"
setup fake
run   # first run seeds the replica (copy) then dies at restic (fake repo)
"$SQLITE" "$R/data/memory.db" "INSERT INTO episodic_events VALUES (3,$(date +%s));"
run
[ "$(st)" = "replica False" ] && pass "no-op sqlite3_rsync fails at replica stage" || fail "no-op sync gave: $(st)"
grep -q "replica not updated by sqlite3_rsync: replica=2 live>=3" "$R/logs/backup_last.json" \
  && pass "message names replica/live marks" || fail "message: $(cat "$R/logs/backup_last.json")"
[ "$(grep -c 'behind after sync' "$R"/logs/backup-*.log)" = 1 ] && pass "retried once before failing" || fail "retry count"
rm -rf "$T"

# 2. real sqlite3_rsync -> replica stage passes (run then stops at fake restic repo)
if [ -x "$REAL_RSYNC" ]; then
  setup real
  run
  "$SQLITE" "$R/data/memory.db" "INSERT INTO episodic_events VALUES (3,$(date +%s));"
  run
  [ "$(st)" = "restic False" ] && pass "real sync passes replica+verify" || fail "real sync gave: $(st) $(cat "$R/logs/backup_last.json")"
  [ "$("$SQLITE" -readonly "$T/stage/memory.db" 'SELECT max(id) FROM episodic_events')" = 3 ] \
    && pass "replica caught up" || fail "replica not caught up"
  rm -rf "$T"
fi
exit $FAIL
