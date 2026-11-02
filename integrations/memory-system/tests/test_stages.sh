#!/bin/bash
# Regression tests for scripts/stage_lib.sh and scripts/memory_stall_watch.sh.
# Reproduces the 2026-09-30 stall: one hung stage must not block another,
# deadlines must kill the whole tree, stale locks must be recovered, and a
# capture stall must produce exactly one alert per episode.
# Runs in a scratch MEMORY_ROOT; touches no real data. Usage: bash tests/test_stages.sh
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d "${TMPDIR:-/tmp}/stagetest.XXXXXX")
export MEMORY_ROOT="$T"
mkdir -p "$T/logs/state" "$T/scripts"
cp "$HERE/scripts/stage_lib.sh" "$HERE/scripts/memory_stall_watch.sh" "$T/scripts/"
FAIL=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; FAIL=1; }

# stage runner used by the tests: name deadline cmd...
cat > "$T/scripts/stage.sh" <<'EOF'
#!/bin/bash
set -u
STAGE_LOG="$MEMORY_ROOT/logs/test.log"
STAGE_GRACE=2 STAGE_POLL=1
. "$MEMORY_ROOT/scripts/stage_lib.sh"
name=$1 d=$2; shift 2
stage_begin "$name" "$d" || exit 0
stage_run "$d" "$@"
stage_end $?
EOF
S="$T/scripts/stage.sh"
js() { sed -n "s/.*\"$2\": \"*\([a-z0-9]*\)\"*.*/\1/p" "$T/logs/$1_last.json" 2>/dev/null | head -1; }
field() { tr ',' '\n' < "$T/logs/$1_last.json" | sed -n "s/.*\"$2\": \"*\([a-z0-9]*\)\"*.*/\1/p"; }

# 1. a hung extract stage does not block capture
bash "$S" extract 30 sleep 31.7 &
EXT=$!
sleep 2
bash "$S" capture 10 true
[ "$(field capture state)" = ok ] && pass "capture runs while extract is hung" || fail "capture blocked by extract"
[ -s "$T/logs/state/capture.last_ok" ] && pass "capture.last_ok marker written" || fail "no capture.last_ok"

# 2. a second runner of the same stage skips while the first is live
bash "$S" extract 30 true
grep -q "\[extract\] skip: pid" "$T/logs/test.log" && pass "same-stage overlap skipped" || fail "overlap not skipped"
kill "$EXT" 2>/dev/null; wait "$EXT" 2>/dev/null
pkill -f "sleep 31.7" 2>/dev/null

# 3. deadline kills the whole process tree (child and grandchild) with rc 124
rm -rf "$T/logs/state/extract.lock"
t0=$(date +%s)
bash "$S" hang 3 bash -c 'sleep 301.3 & sleep 301.3; wait'
el=$(( $(date +%s) - t0 ))
[ "$(field hang state)" = timeout ] && [ "$(field hang rc)" = 124 ] && pass "deadline -> timeout rc=124" || fail "deadline state $(field hang state) rc $(field hang rc)"
[ "$el" -lt 15 ] && pass "deadline enforced (${el}s)" || fail "deadline took ${el}s"
pgrep -f "sleep 301.3" >/dev/null && fail "orphaned grandchild left running" || pass "no orphaned children"
[ ! -d "$T/logs/state/hang.lock" ] && pass "lock released after timeout" || fail "lock left after timeout"
[ ! -s "$T/logs/state/hang.last_ok" ] && pass "timeout does not advance last_ok" || fail "timeout advanced last_ok"

# 4. stale lock with a dead holder is recovered
mkdir -p "$T/logs/state/capture.lock"
echo 999999 > "$T/logs/state/capture.lock/pid"; echo 1 > "$T/logs/state/capture.lock/started"; echo x > "$T/logs/state/capture.lock/cmd"
bash "$S" capture 10 true
grep -q "holder 999999 is gone" "$T/logs/test.log" && [ "$(field capture state)" = ok ] && pass "dead-holder lock recovered" || fail "dead-holder lock not recovered"

# 5. live holder older than deadline+120 s is killed and the lock taken over
bash -c 'exec -a stale-holder-proc sleep 600' &
H=$!
sleep 1
mkdir -p "$T/logs/state/capture.lock"
echo $H > "$T/logs/state/capture.lock/pid"; echo $(( $(date +%s) - 1000 )) > "$T/logs/state/capture.lock/started"
echo "stale-holder-proc" > "$T/logs/state/capture.lock/cmd"
bash "$S" capture 10 true
sleep 1
kill -0 $H 2>/dev/null && { fail "over-deadline holder not killed"; kill -9 $H; } || pass "over-deadline holder killed"
[ "$(field capture state)" = ok ] && pass "lock taken over after stale holder" || fail "lock not taken over"
wait $H 2>/dev/null

# 6. pid reuse: pid alive but a different command -> treated as stale, not killed
sleep 600 &
R=$!
mkdir -p "$T/logs/state/capture.lock"
echo $R > "$T/logs/state/capture.lock/pid"; echo $(date +%s) > "$T/logs/state/capture.lock/started"
echo "memory_capture_tick.sh" > "$T/logs/state/capture.lock/cmd"
bash "$S" capture 10 true
kill -0 $R 2>/dev/null && pass "reused pid not killed" || fail "reused pid was killed"
[ "$(field capture state)" = ok ] && pass "reused-pid lock recovered" || fail "reused-pid lock not recovered"
kill $R 2>/dev/null; wait $R 2>/dev/null

# 7. stall watcher: one alert per episode, reset on recovery
FAKE="$T/fake_bun.sh"
cat > "$FAKE" <<EOF
#!/bin/bash
echo "\$*" >> "$T/notify.log"
EOF
chmod +x "$FAKE"
export MEMORY_TG_BUN="$FAKE" MEMORY_TG_CLI=cli.ts MEMORY_STALL_SECS=3600
echo $(( $(date +%s) - 7200 )) > "$T/logs/state/capture.last_ok"
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
n=$(grep -c "memory-capture-stall" "$T/notify.log" 2>/dev/null || echo 0)
[ "$n" = 1 ] && pass "stall alert sent once (3 checks)" || fail "stall alerts sent: $n"
grep -q -- "--severity error" "$T/notify.log" && pass "stall alert severity error" || fail "wrong severity"
date +%s > "$T/logs/state/capture.last_ok"
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
[ ! -f "$T/logs/state/capture.stall_alerted" ] && pass "episode closed on recovery" || fail "episode not closed"
echo $(( $(date +%s) - 9000 )) > "$T/logs/state/capture.last_ok"
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
n=$(grep -c "memory-capture-stall" "$T/notify.log")
[ "$n" = 2 ] && pass "new stall episode alerts again" || fail "second episode alerts: $n"
# fresh capture -> no alert
date +%s > "$T/logs/state/capture.last_ok"
: > "$T/notify.log"
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
[ ! -s "$T/notify.log" ] && pass "no alert when capture fresh" || fail "alert while fresh"
# a lock left behind by a killed watcher must not suppress alerts forever
rm -f "$T/logs/state/capture.stall_alerted"
echo $(( $(date +%s) - 8000 )) > "$T/logs/state/capture.last_ok"
mkdir -p "$T/logs/state/stall_watch.lock"
touch -t "$(date -r $(( $(date +%s) - 900 )) +%Y%m%d%H%M.%S)" "$T/logs/state/stall_watch.lock"
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
grep -q "memory-capture-stall" "$T/notify.log" && pass "stale stall_watch.lock recovered" || fail "stale stall_watch.lock blocks alerts"
# a fresh lock (another watcher sending right now) is respected
: > "$T/notify.log"; rm -f "$T/logs/state/capture.stall_alerted"
mkdir -p "$T/logs/state/stall_watch.lock"
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
[ ! -s "$T/notify.log" ] && pass "fresh stall_watch.lock respected" || fail "fresh lock ignored"
rmdir "$T/logs/state/stall_watch.lock"
# failing notifier: not marked alerted, retried next tick
printf '#!/bin/bash\nexit 3\n' > "$FAKE"
echo $(( $(date +%s) - 9999 )) > "$T/logs/state/capture.last_ok"
bash "$T/scripts/memory_stall_watch.sh" >/dev/null
[ ! -f "$T/logs/state/capture.stall_alerted" ] && pass "failed send is retried later" || fail "failed send marked as alerted"

# 8. capture tick: a failing Claude stage makes the aggregate capture status failed,
#    and the other stages still run (driven through the real tick script with stub python)
TICK="$T/tick"
mkdir -p "$TICK/scripts" "$TICK/src" "$TICK/logs/state"
cp "$HERE/scripts/stage_lib.sh" "$HERE/scripts/memory_stall_watch.sh" "$HERE/scripts/memory_capture_tick.sh" "$TICK/scripts/"
printf '#!/bin/bash\nexit 0\n' > "$TICK/scripts/memory_stall_watch.sh"
cat > "$TICK/fakepy" <<'PYEOF'
#!/bin/bash
case "$2" in
  *sync_claude.py) echo claude >> "$MEMORY_ROOT/ran.log"; exit 3 ;;
  *) echo "$2" >> "$MEMORY_ROOT/ran.log"; exit 0 ;;
esac
PYEOF
chmod +x "$TICK/fakepy"
sed "s#PY=/opt/homebrew/bin/python3#PY=$TICK/fakepy#; s#ROOT=\"\$HOME/.local/share/memory-system\"#ROOT=\"$TICK\"#" "$TICK/scripts/memory_capture_tick.sh" > "$TICK/scripts/tick.sh"
mkdir -p "$T/logs/state"
MEMORY_ROOT="$TICK" bash "$TICK/scripts/tick.sh" >/dev/null 2>&1
grep -q "claude capture failed rc=3" "$TICK/logs/capture-$(date +%Y%m%d).log" && pass "failing claude stage is logged" || fail "claude failure not logged"
grep -q "sync_codex.py" "$MEMORY_ROOT/ran.log" 2>/dev/null || grep -q "sync_codex.py" "$TICK/ran.log" && pass "codex stage still runs after claude fails" || fail "codex skipped after claude failed"
grep -q "sync_thread_identity.py" "$TICK/ran.log" && pass "identity stage runs" || fail "identity stage did not run"
[ "$(sed -n 's/.*"state": "\([a-z]*\)".*/\1/p' "$TICK/logs/capture_last.json")" = failed ] && pass "aggregate capture status is failed" || fail "aggregate status not failed: $(cat "$TICK/logs/capture_last.json" 2>/dev/null)"

rm -rf "$T"
[ "$FAIL" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit $FAIL
