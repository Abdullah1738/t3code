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
  # the live install ships src/ (incl. the transcript manifest tool) next to the script
  cp "$HERE/src/transcript_backup_manifest.py" "$HERE/src/transcript_roots.py" "$R/src/"
  old=$(( $(date +%s) - 3 * 86400 ))
  "$SQLITE" "$R/data/memory.db" "PRAGMA journal_mode=wal;
    CREATE TABLE episodic_events(id INTEGER PRIMARY KEY, timestamp INTEGER);
    INSERT INTO episodic_events VALUES (1,$old),(2,$old);" >/dev/null
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
    MEMORY_BACKUP_MIN_FREE_GB=0 /bin/bash "$R/scripts/memory_backup.sh" >/dev/null 2>&1
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

# 3. 2026-10-04 incident: a row inserted *after* the sync with an old timestamp
# (sync_opencode_v2 reprojection keeps the message's original time) made the
# post-sync "replica >= live max(id) older than a day" check fail with
# "memory.db replica behind live: 0" on every run. A fresh-enough replica must pass.
if [ -x "$REAL_RSYNC" ]; then
  setup real
  rm "$R/bin/sqlite3_rsync"
  cat > "$R/bin/sqlite3_rsync" <<EOF
#!/bin/bash
"$REAL_RSYNC" "\$@" || exit \$?
case "\${@: -1}" in */memory.db)
  "$SQLITE" "$R/data/memory.db" "INSERT INTO episodic_events(timestamp) VALUES (\$(( \$(date +%s) - 2 * 86400 )))" ;;
esac
EOF
  chmod +x "$R/bin/sqlite3_rsync"
  run
  [ "$(st)" = "restic False" ] && pass "late old-timestamp insert doesn't fail verify" \
    || fail "late insert gave: $(st) $(cat "$R/logs/backup_last.json")"
  rm -rf "$T"
fi

# 4. Robob state: only the small tables are dumped to robob-state.sql (the full
# ~70 GB replica added GBs to restic every run); an old full replica is removed.
if [ -x "$REAL_RSYNC" ]; then
  setup real
  "$SQLITE" "$T/robob.sqlite" "PRAGMA journal_mode=wal;
    CREATE TABLE scheduled_tasks(id TEXT PRIMARY KEY, name TEXT); INSERT INTO scheduled_tasks VALUES ('a','it''s 7');
    CREATE TABLE ardud_board_rows(id TEXT); INSERT INTO ardud_board_rows VALUES ('b');
    CREATE TABLE ardud_mission_events(id TEXT); INSERT INTO ardud_mission_events VALUES ('m');
    CREATE TABLE orchestration_v2_events(x); INSERT INTO orchestration_v2_events VALUES ('big');" >/dev/null
  echo old > "$T/stage/robob-state.sqlite"; echo old > "$T/stage/robob-state.sqlite-wal"
  ROBOB_STATE_DB="$T/robob.sqlite" run
  [ "$(st)" = "restic False" ] && pass "robob state dump passes" || fail "robob gave: $(st) $(cat "$R/logs/backup_last.json")"
  [ "$("$SQLITE" :memory: ".read $T/stage/robob-state.sql" 'SELECT name FROM scheduled_tasks')" = "it's 7" ] \
    && pass "robob state dump restores" || fail "robob state dump missing or unreadable"
  grep -q orchestration_v2_events "$T/stage/robob-state.sql" \
    && fail "robob dump includes the event log" || pass "robob dump skips the event log"
  ls "$T"/stage/robob-state.sqlite* >/dev/null 2>&1 \
    && fail "old full robob replica kept" || pass "old full robob replica removed"
  [ "$("$SQLITE" :memory: ".read $T/stage/robob-state.sql" 'SELECT id FROM ardud_mission_events')" = "m" ] \
    && pass "retired mission tables backed up" || fail "ardud_mission_events not in the robob dump"
  grep -q "robob-state.sql: 3 tables.*missing:.* projection_projects" "$R"/logs/backup-*.log \
    && pass "missing robob tables logged" || fail "robob log: $(grep robob "$R"/logs/backup-*.log)"
  rm -rf "$T"
fi

# 5. a lock left by a dead run is removed (and logged); a live run's lock is kept
setup fake
mkdir "$R/logs/backup.lock"
true & dead=$!; wait $dead
echo $dead > "$R/logs/backup.lock/pid"
run
grep -q "removing stale backup.lock (holder $dead is gone)" "$R"/logs/backup-*.log \
  && pass "dead holder's lock removed" || fail "dead holder lock: $(cat "$R"/logs/backup-*.log)"
[ "$(st)" = "restic False" ] && pass "run proceeds after stale lock" || fail "after stale lock: $(st)"
bash -c 'sleep 30; :' memory_backup.sh & live=$!
mkdir "$R/logs/backup.lock"; echo $live > "$R/logs/backup.lock/pid"
run
grep -q "skip: backup $live still running" "$R"/logs/backup-*.log \
  && pass "live holder skipped" || fail "live holder not skipped"
kill -0 $live 2>/dev/null && [ -d "$R/logs/backup.lock" ] \
  && pass "live holder not killed, lock kept" || fail "live holder disturbed"
kill $live; wait $live 2>/dev/null
rm -rf "$T"
exit $FAIL
