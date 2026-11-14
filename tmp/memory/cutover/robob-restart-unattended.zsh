#!/bin/zsh
# Reinstall Robob from tmux after a 60-second cancellation window. The SSD
# move, if requested, runs while Robob is closed, before the statev2 clone;
# --also runs after the clone. --ping and --restart-opencode work as before.
# Run from Terminal.app, not from Robob/OpenCode. This does not grant install
# approval; use it only for an approved release window.

# This function uses the current USERDATA and STAMP. In source-only tests,
# BROOT may select a different backup parent, but never bypasses device checks.
clone_state() {
  emulate -L zsh
  local data root src_device root_device backup_device f device
  local -a files
  [[ -n ${USERDATA:-} && -n ${STAMP:-} && -d $USERDATA ]] || {
    print -u2 -- "cannot clone: userdata is missing or inaccessible: ${USERDATA:-<unset>}"
    return 1
  }
  data=${USERDATA:A}
  root=${data:h}
  if [[ ${_ROBOB_RESTART_SOURCE_TEST_MODE:-0} == 1 && -n ${BROOT:-} ]]; then
    root=${BROOT:A}
  fi
  [[ -d $root ]] || { print -u2 -- "backup parent is missing: $root"; return 1; }
  src_device=$(stat -L -f %d "$data") || return 1
  root_device=$(stat -L -f %d "$root") || return 1
  if [[ -z $src_device || $src_device != $root_device ]]; then
    print -u2 -- "refusing cross-device DB clone: clone would cross disks: $data ($src_device) -> $root ($root_device)"
    return 1
  fi
  [[ -f $data/statev2.sqlite ]] || { print -u2 -- "missing DB: $data/statev2.sqlite"; return 1; }
  files=(statev2.sqlite)
  for f in statev2.sqlite-wal statev2.sqlite-shm; do
    [[ -e $data/$f || -L $data/$f ]] && files+=($f)
  done
  # A file can itself be a symlink or mount; check all inputs before any cp.
  for f in $files; do
    [[ -f $data/$f ]] || { print -u2 -- "invalid DB file: $data/$f"; return 1; }
    device=$(stat -L -f %d "$data/$f") || return 1
    if [[ -z $device || $device != $root_device ]]; then
      print -u2 -- "refusing cross-device DB clone: clone would cross disks: $data/$f ($device) -> $root ($root_device)"
      return 1
    fi
  done
  BACKUP=$root/restart-backup-$STAMP
  mkdir -m 700 "$BACKUP" || return 1
  backup_device=$(stat -L -f %d "$BACKUP") || return 1
  if [[ -z $backup_device || $src_device != $backup_device ]]; then
    print -u2 -- "refusing cross-device DB clone: clone would cross disks: $data ($src_device) -> $BACKUP ($backup_device)"
    return 1
  fi
  for f in $files; do
    device=$(stat -L -f %d "$data/$f") || return 1
    if [[ -z $device || $device != $backup_device ]]; then
      print -u2 -- "refusing cross-device DB clone: clone would cross disks: $data/$f ($device) -> $BACKUP ($backup_device)"
      return 1
    fi
    cp -c "$data/$f" "$BACKUP/$f" || return 1
  done
  [[ $(head -c 15 "$BACKUP/statev2.sqlite") == 'SQLite format 3' ]] || {
    print -u2 -- 'DB clone header is wrong'
    return 1
  }
  print -r -- "   ok  statev2 cloned to $BACKUP"
}

# Public test entry as well as the production hook. Its arguments are literal
# paths/commands, not a generated shell fragment. It never sleeps or installs.
restart_hook() {
  emulate -L zsh
  (( $# == 4 )) || { print -u2 -- 'restart_hook needs userdata, stamp, move script, and also command'; return 2; }
  local USERDATA=$1 STAMP=$2 MOVE_TO_SSD=$3 ALSO=$4 BACKUP rc key
  local _ROBOB_RESTART_SOURCE_TEST_MODE=${_ROBOB_RESTART_SOURCE_TEST_MODE:-0}
  if [[ -n $MOVE_TO_SSD ]]; then
    # SSDMOVE_* is reserved by the mover for its own tests. Do not let an
    # inherited override redirect a production move.
    (
      if [[ $_ROBOB_RESTART_SOURCE_TEST_MODE != 1 ]]; then
        for key in ${(k)parameters[(I)SSDMOVE_*]}; do unset "$key"; done
      fi
      zsh "$MOVE_TO_SSD"
    )
    rc=$?
    if (( rc == 70 )); then
      print -u2 -- 'SSD move could not restore its files; leaving Robob stopped.'
      return 70
    elif (( rc != 0 )); then
      print -u2 -- "SSD move skipped/failed (exit $rc); continuing with the current userdata."
    fi
  fi
  # A move must never leave the installer reopening Robob onto a broken link.
  if [[ ! -d $USERDATA ]]; then
    # A source missing after the move cannot be put back by this installer.
    # Do not reopen Robob onto an absent or dangling data directory.
    print -u2 -- "userdata is missing after the SSD step: $USERDATA; leave Robob stopped"
    return 70
  fi
  clone_state || return $?
  if [[ -n $ALSO ]]; then
    zsh -e -c "$ALSO"
    return $?
  fi
  return 0
}

# The installer's --before-launch sources this file in a fresh zsh. No normal
# installer setup is evaluated in either explicit hook or source-only mode.
if [[ ${1:-} == --_hook ]]; then
  [[ $ZSH_EVAL_CONTEXT == *:file && $# == 5 ]] || {
    print -u2 -- 'internal hook must be sourced with four arguments'
    return 2
  }
  shift
  typeset _ROBOB_RESTART_SOURCE_TEST_MODE=0
  restart_hook "$@"
  return $?
fi
if [[ ${SSDMOVE_INSTALLER_SOURCE_ONLY:-0} == 1 ]]; then
  [[ $ZSH_EVAL_CONTEXT == *:file ]] || { print -u2 -- 'source-only mode must be sourced'; exit 2; }
  typeset -g _ROBOB_RESTART_SOURCE_TEST_MODE=1
  return 0
fi
if [[ $ZSH_EVAL_CONTEXT == *:file ]]; then
  print -u2 -- 'source with SSDMOVE_INSTALLER_SOURCE_ONLY=1 for tests'
  return 2
fi

set -uo pipefail
umask 077
_ROBOB_RESTART_SOURCE_TEST_MODE=0
SCRIPT=${0:A}
INSTALLER=/Volumes/ExternalSSD/t3code-fork/tmp/memory/cutover/install-robob-resume.zsh
DMG="" PING="" ALSO="" MOVE_TO_SSD=""
EXTRA=()
while (( $# )); do
  case $1 in
    --dmg|--ping|--also|--move-to-ssd)
      (( $# >= 2 )) && [[ -n $2 ]] || { print -u2 -- "$1 needs a value"; exit 2; }
      case $1 in
        --dmg) DMG=$2 ;;
        --ping) PING=$2 ;;
        --also) ALSO=$2 ;;
        --move-to-ssd) MOVE_TO_SSD=$2 ;;
      esac
      shift 2 ;;
    --restart-opencode) EXTRA+=(--restart-opencode); shift ;;
    *) print -u2 -- "unknown argument: $1"; exit 2 ;;
  esac
done

# The test mode only exercises this preflight and cannot reach the wait or
# install. Outside it, inherited USERDATA/BROOT never configure the run.
if [[ ${SSDMOVE_INSTALLER_TEST_ONLY:-0} == 1 ]]; then
  [[ -n ${USERDATA:-} ]] || { print -u2 -- 'test mode needs USERDATA'; exit 2; }
else
  USERDATA=$HOME/.robob/userdata
fi
if [[ -L $USERDATA && ! -d $USERDATA ]]; then
  print -u2 -- "Robob state is on the SSD and the SSD isn't mounted, or the userdata symlink target is otherwise inaccessible: $USERDATA"
  exit 2
fi
[[ -d $USERDATA ]] || { print -u2 -- "userdata directory is missing: $USERDATA"; exit 2; }
if [[ ${SSDMOVE_INSTALLER_TEST_ONLY:-0} == 1 ]]; then
  print -r -- 'test-only preflight: no wait or install'
  exit 0
fi
[[ -f $DMG ]] || { print -u2 -- "no DMG at '$DMG'"; exit 2; }

STAMP=$(date +%Y%m%d-%H%M%S)
LOG=$HOME/.robob/restart-$STAMP.log
T3CTL=/Volumes/ExternalSSD/t3code-fork/apps/server/src/ardud/control/t3ctl.mjs
unset BUN_INSPECT

notify() {
  local i
  for i in 1 2 3 4 5 6; do
    /Users/ardud/.bun/bin/bun /Users/ardud/.local/share/telegram-bridge/src/cli.ts notify \
      --source 'Robob restart' --severity "$1" --key "$2" --text "$3" >/dev/null 2>&1 && return 0
    sleep 30
  done
  osascript -e "display notification \"$3\" with title \"Robob restart\"" >/dev/null 2>&1 || true
}

ping_thread() {
  [[ -n $PING ]] || return 0
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    node "$T3CTL" send "$PING" "$1" --mode queue >/dev/null 2>&1 && return 0
    sleep 30
  done
  return 1
}

# ${(q)...} preserves spaces, quotes, shell metacharacters and empty strings
# across the installer's zsh -c boundary. --also remains intentional shell code.
HOOK="source ${(q)SCRIPT} --_hook ${(q)USERDATA} ${(q)STAMP} ${(q)MOVE_TO_SSD} ${(q)ALSO}"
print -r -- "Robob restart, unattended. Log: $LOG"
print -r -- 'Starting in 60 s. To cancel: tmux -L restart kill-session -t robob-restart'
sleep 60
source "${0:A:h}/../../../integrations/robob-guard/scripts/install-hold.zsh"
robob_hold_begin robob-restart-unattended || exit $?
START=$SECONDS
ROBOB_UNATTENDED=1 caffeinate -is zsh "$INSTALLER" --dmg "$DMG" "${EXTRA[@]}" --before-launch "$HOOK" 2>&1 | tee "$LOG"
rc=${pipestatus[1]}
mins=$(( (SECONDS - START) / 60 ))
version=$(defaults read /Applications/Robob.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || print unknown)
# USERDATA may have moved during the hook; never report the pre-move parent.
BACKUP=${${USERDATA:A}:h}/restart-backup-$STAMP

if (( rc == 0 )); then
  ping_thread "Robob is back up on $version after $mins min (restart log $LOG, DB clone $BACKUP). Check that every lane and its subagents resumed." \
    || print -r -- "could not queue the ping on $PING"
  notify attention "robob-restart:$STAMP:up" "Robob is back up on $version after $mins min. The coordinator is checking the cutover and resumes. Log: $LOG. DB clone: $BACKUP"
elif (( rc == 70 )); then
  last=$(grep -E 'FAILED|failed|Left stopped|no live' "$LOG" | tail -4 | tr '\n' ' ')
  notify error "robob-restart:$STAMP:db-unsafe" "Robob restart: a DB step failed and could not put its files back. Robob is left closed on purpose; don't open it until the files are fixed. Check OpenCode and reader status separately. $last Log: $LOG"
  robob_hold_wait_for_repair node "$T3CTL" health
else
  last=$(grep -E '^== |FAILED|failed|stopped' "$LOG" | tail -3 | tr '\n' ' ')
  ping_thread "The Robob restart stopped after $mins min (exit $rc). Installed: $version. Last lines: $last Log: $LOG" || true
  notify error "robob-restart:$STAMP:failed" "The Robob restart stopped after $mins min (exit $rc). Installed now: $version. Last lines: $last Log: $LOG. DB clone: $BACKUP"
fi
print -r -- "Done (exit $rc). This window can be closed."
exit $rc
