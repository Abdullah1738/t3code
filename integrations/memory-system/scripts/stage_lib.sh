#!/bin/bash
# Shared runner for memory pipeline stages (capture, extract, health).
#
# Every stage gets its own lock, a hard deadline on its child process and a
# status marker, so a hang in one stage (model outage, syspolicyd stalling a
# python launch, a slow opencode.db) can never block another stage.
# Written in bash on purpose: /bin/bash is a system binary and keeps running
# when Homebrew binaries hang at launch (see macos-syspolicyd-hang skill).
#
# Usage (from a stage script):
#   . "$(dirname "$0")/stage_lib.sh"
#   stage_begin capture 1200 || exit 0      # lock; 0 = got it, 1 = skip
#   stage_run 1200 python3 -u src/x.py      # rc 124 on deadline
#   stage_end $?                            # writes logs/<name>_last.json
#
# Files:
#   logs/state/<name>.lock/{pid,started,cmd}   lock (mkdir, atomic)
#   logs/state/<name>.last_ok                  epoch the last ok run ended
#   logs/state/<name>.last_ok_start            epoch the last ok run started
#   logs/<name>_last.json                      last run status (state, rc, secs)

STAGE_ROOT="${MEMORY_ROOT:-$HOME/.local/share/memory-system}"
STAGE_LOGS="$STAGE_ROOT/logs"
STAGE_STATE="$STAGE_LOGS/state"
STAGE_POLL="${STAGE_POLL:-2}"
STAGE_GRACE="${STAGE_GRACE:-15}"
mkdir -p "$STAGE_STATE"

stage_now() { date +%s; }

stage_log() {
  echo "$(date '+%F %T') [$STAGE_NAME] $*" >> "${STAGE_LOG:-/dev/stderr}"
}

# pids of a process and all its descendants, children first
stage_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do stage_tree "$c"; done
  echo "$1"
}

stage_kill() {  # signal pid...
  local sig=$1; shift
  [ $# -gt 0 ] && kill -"$sig" "$@" 2>/dev/null
  return 0
}

stage_write_status() {  # state rc
  local st=$1 rc=${2:-} now last_ok tmp
  now=$(stage_now)
  if [ "$st" = ok ]; then
    echo "$now" > "$STAGE_STATE/$STAGE_NAME.last_ok"
    echo "$STAGE_STARTED" > "$STAGE_STATE/$STAGE_NAME.last_ok_start"
  fi
  last_ok=$(cat "$STAGE_STATE/$STAGE_NAME.last_ok" 2>/dev/null || echo 0)
  tmp="$STAGE_LOGS/${STAGE_NAME}_last.json.tmp.$$"
  printf '{"stage": "%s", "state": "%s", "rc": %s, "pid": %s, "started": %s, "ended": %s, "secs": %s, "last_ok_ts": %s}\n' \
    "$STAGE_NAME" "$st" "${rc:-null}" "$$" "$STAGE_STARTED" \
    "$([ "$st" = running ] && echo null || echo "$now")" \
    "$((now - STAGE_STARTED))" "${last_ok:-0}" > "$tmp"
  mv -f "$tmp" "$STAGE_LOGS/${STAGE_NAME}_last.json"
}

# Take the stage lock. Recovers a stale lock when the holder is gone, is not a
# stage process any more (pid reuse) or has outlived deadline + 120 s.
stage_begin() {  # name deadline_secs
  STAGE_NAME=$1
  STAGE_DEADLINE=$2
  STAGE_LOCK="$STAGE_STATE/$STAGE_NAME.lock"
  STAGE_STARTED=$(stage_now)
  local holder started cmd age mt
  if ! mkdir "$STAGE_LOCK" 2>/dev/null; then
    holder=$(cat "$STAGE_LOCK/pid" 2>/dev/null)
    started=$(cat "$STAGE_LOCK/started" 2>/dev/null)
    cmd=$(cat "$STAGE_LOCK/cmd" 2>/dev/null)
    if [ -z "$holder" ]; then
      # another runner may be between mkdir and writing its pid
      mt=$(stat -f %m "$STAGE_LOCK" 2>/dev/null || echo 0)
      if [ $((STAGE_STARTED - mt)) -lt 60 ]; then
        stage_log "skip: lock being taken"
        return 1
      fi
      started=$mt
    fi
    age=$((STAGE_STARTED - ${started:-0}))
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null \
        && ps -o command= -p "$holder" 2>/dev/null | grep -qF -- "$cmd"; then
      if [ "$age" -le $((STAGE_DEADLINE + 120)) ]; then
        stage_log "skip: pid $holder running for ${age}s"
        return 1
      fi
      stage_log "stale lock: pid $holder running ${age}s > deadline ${STAGE_DEADLINE}s; killing it"
      # shellcheck disable=SC2046
      stage_kill KILL $(stage_tree "$holder")
    else
      stage_log "stale lock: holder ${holder:-?} is gone (age ${age}s); recovering"
    fi
    rm -rf "$STAGE_LOCK"
    if ! mkdir "$STAGE_LOCK" 2>/dev/null; then
      stage_log "skip: lost lock race"
      return 1
    fi
  fi
  echo "$STAGE_STARTED" > "$STAGE_LOCK/started"
  echo "$0" > "$STAGE_LOCK/cmd"
  echo $$ > "$STAGE_LOCK/pid"
  trap 'stage_on_exit' EXIT
  trap 'stage_on_signal' TERM INT HUP
  stage_write_status running
  return 0
}

STAGE_CHILD=""
STAGE_ENDED=0

stage_on_signal() {
  stage_log "runner got a signal; stopping child ${STAGE_CHILD:-none}"
  if [ -n "$STAGE_CHILD" ]; then
    # shellcheck disable=SC2046
    stage_kill KILL $(stage_tree "$STAGE_CHILD")
  fi
  [ "$STAGE_ENDED" = 1 ] || stage_end 143
  exit 143
}

stage_on_exit() {
  [ "$STAGE_ENDED" = 1 ] || stage_end 1
  # only drop the lock if it is still ours
  [ "$(cat "$STAGE_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$STAGE_LOCK"
}

# Run a command with a hard deadline. On expiry: SIGTERM the whole process
# tree, wait STAGE_GRACE s, then SIGKILL. Returns the child's rc, 124 on timeout.
stage_run() {  # deadline cmd...
  local deadline=$1 t0 tree i
  shift
  "$@" &
  STAGE_CHILD=$!
  t0=$(stage_now)
  while kill -0 "$STAGE_CHILD" 2>/dev/null; do
    if [ $(( $(stage_now) - t0 )) -ge "$deadline" ]; then
      stage_log "TIMEOUT after ${deadline}s, killing pid $STAGE_CHILD: $*"
      tree=$(stage_tree "$STAGE_CHILD")
      # shellcheck disable=SC2086
      stage_kill TERM $tree
      for ((i = 0; i < STAGE_GRACE; i++)); do
        kill -0 "$STAGE_CHILD" 2>/dev/null || break
        sleep 1
      done
      # shellcheck disable=SC2086
      stage_kill KILL $tree $(stage_tree "$STAGE_CHILD")
      wait "$STAGE_CHILD" 2>/dev/null
      STAGE_CHILD=""
      return 124
    fi
    sleep "$STAGE_POLL"
  done
  wait "$STAGE_CHILD"
  i=$?
  STAGE_CHILD=""
  return $i
}

stage_end() {  # rc
  local rc=$1 st=ok
  [ "$rc" = 0 ] || st=failed
  [ "$rc" = 124 ] && st=timeout
  STAGE_ENDED=1
  stage_write_status "$st" "$rc"
  stage_log "end: $st rc=$rc ($(( $(stage_now) - STAGE_STARTED ))s)"
}
