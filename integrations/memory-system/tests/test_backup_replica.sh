#!/bin/bash
# Regression test for the 2026-09-30..10-02 frozen-replica incident:
# sqlite3_rsync exited 0 without updating the memory.db replica and every
# backup "succeeded" for two days. memory_backup.sh must now fail at the
# replica stage when the replica doesn't reach the live high-water mark.
# Runs in a scratch HOME; touches no real data. Usage: bash tests/test_backup_replica.sh
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SQLITE=/opt/homebrew/opt/sqlite/bin/sqlite3
PYTHON=/opt/homebrew/bin/python3
RESTIC=/opt/homebrew/bin/restic
TOP=$(mktemp -d "${TMPDIR:-/tmp}/backuptest.XXXXXX") || exit 1
trap 'rm -rf "$TOP"' EXIT
# Stand-in uses SQLite's backup API. No executable or database from the live
# install is read. The original no-op and high-water-mark regressions remain.
REAL_RSYNC="$TOP/sqlite3_rsync"
cat > "$REAL_RSYNC" <<'SH'
#!/bin/bash
src="${@: -2:1}"; dst="${@: -1}"
/opt/homebrew/opt/sqlite/bin/sqlite3 "$src" ".backup '$dst'"
SH
chmod +x "$REAL_RSYNC"
FAIL=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

setup() { # fake-or-real sqlite3_rsync
  T=$(mktemp -d "$TOP/case.XXXXXX")
  R="$T/.local/share/memory-system"
  mkdir -p "$R/data" "$R/bin" "$R/logs" "$R/scripts" "$R/src" "$R/schema" "$R/sql" "$T/stage" "$T/repo/live"
  touch "$R/HANDOFF.md"
  echo x > "$T/repo/live/config"
  cp "$HERE/scripts/memory_backup.sh" "$R/scripts/"
  # the live install ships src/ (incl. the transcript manifest tool) next to the script
  cp "$HERE/src/transcript_backup_manifest.py" "$HERE/src/transcript_roots.py" "$HERE/src/run_limited.py" "$R/src/"
  # Never invoke the Dropbox API in this test, even when restic succeeds.
  printf 'print("{\\"test\\": true}")\n' > "$R/src/dropbox_mirror.py"
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
  env -i PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin HOME="$T" XDG_DATA_HOME="$T/.local/share" \
    ROBOB_STATE_DB="${1:-$T/no-robob.sqlite}" \
    ROBOB_HARNESS_HOMES="$T/.robob/harness-homes" \
    MEMORY_BACKUP_STAGE="$T/stage" MEMORY_BACKUP_REPO_ROOT="$T/repo" \
    MEMORY_BACKUP_REPLICA_TIMEOUT_S="${MEMORY_BACKUP_REPLICA_TIMEOUT_S:-5400}" \
    MEMORY_BACKUP_PASSWORD_COMMAND='printf fixture-password' MEMORY_BACKUP_CACHE_DIR="$T/cache" \
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

# A stalled sync must fail the run, release the lock and not leave its process.
setup fake
cat > "$R/bin/sqlite3_rsync" <<'SH'
#!/bin/bash
echo "$$" > "$HOME/sync-pid"
exec /bin/sleep 120
SH
rc=0
MEMORY_BACKUP_REPLICA_TIMEOUT_S=3 run || rc=$?
[ "$rc" -ne 0 ] && [ "$(st)" = "replica False" ] && grep -q 'sqlite3_rsync timed out after 3 s' "$R/logs/backup_last.json" \
  && pass "stalled sync fails at replica with timeout status" || fail "stalled sync did not report timeout: rc=$rc $(cat "$R/logs/backup_last.json")"
grep -q 'sqlite3_rsync timed out after 3 s' "$R"/logs/backup-*.log \
  && pass "stalled sync timeout logged" || fail "stalled sync timeout not logged: $(cat "$R"/logs/backup-*.log)"
[ ! -e "$R/logs/backup.lock" ] && pass "stalled sync releases lock" || fail "stalled sync left lock"
if [ -s "$T/sync-pid" ] && ! kill -0 "$(cat "$T/sync-pid")" 2>/dev/null; then
  pass "stalled sync process exited"
else
  fail "stalled sync process still alive or did not start"
fi
rm -rf "$T"

# 2. SQLite backup stand-in -> replica stage passes (then fake repo fails).
if [ -x "$REAL_RSYNC" ]; then
  setup real
  run
  "$SQLITE" "$R/data/memory.db" "INSERT INTO episodic_events VALUES (3,$(date +%s));"
  run
  [ "$(st)" = "restic False" ] && pass "SQLite sync passes replica+verify" || fail "SQLite sync gave: $(st) $(cat "$R/logs/backup_last.json")"
  grep -q 'replica memory.db try1: elapsed_s=[0-9]' "$R"/logs/backup-*.log \
    && pass "replica duration logged" || fail "replica duration missing from log"
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
  run "$T/robob.sqlite"
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

# 6. Exercise the real restic snapshot, not merely the manifest helper. All
# sources, credentials, repos, cache, mirror and restored output are fixtures.
setup fake
rm "$T/repo/live/config"
RESTIC_PASSWORD=fixture-password RESTIC_CACHE_DIR="$T/cache" "$RESTIC" -r "$T/repo/live" init >/dev/null || exit 1
H="$T/.robob/harness-homes"
# Historical runs placed a manifest outside the current snapshot-manifest dir.
# It must not be copied back as a stale second manifest.
mkdir -p "$R/data/backup-manifests" "$T/stage/files/data/backup-manifests"
echo old > "$R/data/backup-manifests/older.json"
echo old > "$T/stage/files/data/backup-manifests/older.json"
mkdir -p "$H/claude/projects/proj/session/subagents" "$H/codex/sessions/2026" \
  "$H/codex/archived_sessions/old" "$H/codex-cu/sessions/2026" \
  "$H/claude/projects/proj/auth.json" "$T/outside" \
  "$T/stage/files/transcripts/codex-cu/archived_sessions/missing/auth.json" \
  "$T/stage/files/transcripts/unrecognized"
printf 'claude main\n' > "$H/claude/projects/proj/session.jsonl"
printf 'claude child\n' > "$H/claude/projects/proj/session/subagents/agent.jsonl"
printf 'codex\n' > "$H/codex/sessions/2026/session.jsonl"
printf 'archive\n' > "$H/codex/archived_sessions/old/old.jsonl"
printf 'codex-cu\n' > "$H/codex-cu/sessions/2026/session.jsonl"
printf 'source secret\n' > "$H/claude/projects/proj/.credentials.json"
printf 'source database\n' > "$H/codex/sessions/2026/state.sqlite3"
printf 'source secret\n' > "$H/claude/projects/proj/auth.json/nested-secret"
printf 'old secret\n' > "$T/stage/files/transcripts/codex-cu/archived_sessions/missing/.credentials.json"
printf 'old db\n' > "$T/stage/files/transcripts/codex-cu/archived_sessions/missing/state.sqlite-wal"
printf 'nested secret\n' > "$T/stage/files/transcripts/codex-cu/archived_sessions/missing/auth.json/secret"
printf 'old but safe transcript\n' > "$T/stage/files/transcripts/codex-cu/archived_sessions/missing/keep.jsonl"
printf 'other stale secret\n' > "$T/stage/files/transcripts/unrecognized/private.key"
printf 'outside untouched\n' > "$T/outside/auth.json"
ln -s "$T/outside" "$T/stage/files/transcripts/unrecognized/outside-link"
ln -s "$T/outside/auth.json" "$H/claude/projects/proj/credential-link"
ln -s "$T/outside" "$H/codex/sessions/2026/outside-dir"
mkfifo "$H/codex/sessions/2026/source-pipe"
run
[ "$(st)" = "done True" ] && pass "first transcript backup completes" \
  || fail "first transcript backup: $(st) $(cat "$R/logs/backup_last.json")"
[ "$(cat "$T/outside/auth.json")" = 'outside untouched' ] \
  && pass "symlink target not touched" || fail "symlink target was modified"
RESTIC_PASSWORD=fixture-password RESTIC_CACHE_DIR="$T/cache" "$RESTIC" -r "$T/repo/live" \
  restore latest --target "$T/restore" >/dev/null || fail "cannot restore test snapshot"
SNAPROOT="$T/restore$T/stage"
if "$PYTHON" - "$HERE/src" "$SNAPROOT" "$R/data/backup-manifests" <<'PY'
import glob, hashlib, json, os, sys
sys.path.insert(0, sys.argv[1])
import transcript_backup_manifest as tbm
root, published = sys.argv[2:]
tree = os.path.join(root, 'files', 'transcripts')
snapshots = glob.glob(os.path.join(root, 'files', 'transcript-manifest', '*.json'))
local = glob.glob(os.path.join(published, '*.json'))
assert len(snapshots) == 1, snapshots
assert not os.path.exists(os.path.join(root, 'files', 'data', 'backup-manifests'))
current = [p for p in local if os.path.basename(p) == os.path.basename(snapshots[0])]
assert len(current) == 1, local
with open(snapshots[0], 'rb') as f: contents = f.read()
with open(current[0], 'rb') as f: assert contents == f.read()
manifest = json.loads(contents)
assert not tbm.verify(manifest, tree), tbm.verify(manifest, tree)
expected = {
    'claude/projects/proj/session.jsonl': b'claude main\n',
    'claude/projects/proj/session/subagents/agent.jsonl': b'claude child\n',
    'codex/sessions/2026/session.jsonl': b'codex\n',
    'codex/archived_sessions/old/old.jsonl': b'archive\n',
    'codex-cu/sessions/2026/session.jsonl': b'codex-cu\n',
    'codex-cu/archived_sessions/missing/keep.jsonl': b'old but safe transcript\n',
}
listed = {item['path']: item for item in manifest['files']}
assert set(listed) == set(expected), (set(listed), set(expected))
for path, content in expected.items():
    with open(os.path.join(tree, path), 'rb') as f: assert f.read() == content
    assert listed[path]['size'] == len(content)
    assert listed[path]['sha256'] == hashlib.sha256(content).hexdigest()
for directory, dirs, files in os.walk(tree):
    for name in dirs + files:
        assert not tbm.excluded(name), (directory, name)
        assert not os.path.islink(os.path.join(directory, name)), (directory, name)
PY
then pass "restored snapshot contains exact verified manifest and no forbidden transcripts"
else fail "restored snapshot or manifest mismatch"; fi

# A vanished source root retains safe historical transcripts but cannot retain
# excluded entries, even if they were injected into the persistent replica.
rm -rf "$H/codex/archived_sessions"
mkdir -p "$T/stage/files/transcripts/codex/archived_sessions/old/settings.local.json"
printf 'old nested secret\n' > "$T/stage/files/transcripts/codex/archived_sessions/old/settings.local.json/x"
printf 'old secret\n' > "$T/stage/files/transcripts/codex/archived_sessions/old/auth.json"
run
[ "$(st)" = "done True" ] && pass "backup completes after a transcript source vanishes" || fail "vanished source gave: $(st)"
mkdir "$T/restore-second"
RESTIC_PASSWORD=fixture-password RESTIC_CACHE_DIR="$T/cache" "$RESTIC" -r "$T/repo/live" \
  restore latest --target "$T/restore-second" >/dev/null || fail "cannot restore second snapshot"
SECOND="$T/restore-second$T/stage"
if "$PYTHON" - "$HERE/src" "$SECOND" "$R/data/backup-manifests" <<'PY'
import glob, json, os, sys
sys.path.insert(0, sys.argv[1])
import transcript_backup_manifest as tbm
root, published = sys.argv[2:]
tree = os.path.join(root, 'files', 'transcripts')
snapshots = glob.glob(os.path.join(root, 'files', 'transcript-manifest', '*.json'))
assert len(snapshots) == 1, snapshots
with open(snapshots[0], 'rb') as f: contents = f.read()
with open(os.path.join(published, os.path.basename(snapshots[0])), 'rb') as f: assert f.read() == contents
manifest = json.loads(contents)
assert not tbm.verify(manifest, tree), tbm.verify(manifest, tree)
assert 'codex/archived_sessions/old/old.jsonl' in {f['path'] for f in manifest['files']}
for directory, dirs, files in os.walk(tree):
    for name in dirs + files:
        assert not tbm.excluded(name), (directory, name)
        assert not os.path.islink(os.path.join(directory, name)), (directory, name)
PY
then pass "vanished-root snapshot keeps safe transcripts but excludes injected secrets"
else fail "vanished-root snapshot or manifest mismatch"; fi
# A special file in an unsynced root must fail before restic or local manifest
# publication. Compare snapshot and manifest counts around this failed run.
before=$(RESTIC_PASSWORD=fixture-password RESTIC_CACHE_DIR="$T/cache" "$RESTIC" -r "$T/repo/live" snapshots --json | "$PYTHON" -c 'import json,sys; print(len(json.load(sys.stdin)))')
manifests_before=$(ls "$R/data/backup-manifests/"*.json | wc -l | tr -d ' ')
mkfifo "$T/stage/files/transcripts/unrecognized/pipe"
run
[ "$(st)" = "files False" ] && pass "unsafe stage fails closed before snapshot" || fail "unsafe stage gave: $(st)"
after=$(RESTIC_PASSWORD=fixture-password RESTIC_CACHE_DIR="$T/cache" "$RESTIC" -r "$T/repo/live" snapshots --json | "$PYTHON" -c 'import json,sys; print(len(json.load(sys.stdin)))')
[ "$before" = "$after" ] && [ "$(ls "$R/data/backup-manifests/"*.json | wc -l | tr -d ' ')" = "$manifests_before" ] \
  && pass "failed run created no snapshot or manifest" || fail "failed run published backup or manifest"
rm -rf "$T"

# Failed restic snapshots must not become local reaper manifests either.
setup fake
mkdir -p "$T/.robob/harness-homes/codex/sessions"
echo session > "$T/.robob/harness-homes/codex/sessions/first.jsonl"
run
[ "$(st)" = "restic False" ] && [ -z "$(ls -A "$R/data/backup-manifests" 2>/dev/null)" ] \
  && pass "failed restic backup publishes no manifest" || fail "failed restic backup published a manifest"
rm -rf "$T"

# A local restic snapshot alone is not enough for the reaper: mirroring must
# have completed before the manifest is visible under data/backup-manifests.
setup fake
rm "$T/repo/live/config"
RESTIC_PASSWORD=fixture-password RESTIC_CACHE_DIR="$T/cache" "$RESTIC" -r "$T/repo/live" init >/dev/null || exit 1
echo 'raise SystemExit(1)' > "$R/src/dropbox_mirror.py"
run
[ "$(st)" = "dropbox False" ] && [ -z "$(ls -A "$R/data/backup-manifests" 2>/dev/null)" ] \
  && pass "failed mirror publishes no manifest" || fail "failed mirror published a manifest"
rm -rf "$T"

# If the local manifest destination is not writable as a directory, the run
# must fail even after snapshot and mirror; it must not silently claim success.
setup fake
rm "$T/repo/live/config"
RESTIC_PASSWORD=fixture-password RESTIC_CACHE_DIR="$T/cache" "$RESTIC" -r "$T/repo/live" init >/dev/null || exit 1
echo blocked > "$R/data/backup-manifests"
run
[ "$(st)" = "files False" ] && grep -q 'transcript manifest publish' "$R/logs/backup_last.json" \
  && pass "manifest publication failure is reported" || fail "manifest publication failure was ignored: $(st)"
rm -rf "$T"
exit $FAIL
