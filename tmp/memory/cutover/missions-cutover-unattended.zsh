#!/bin/zsh
# Runs missions-cutover.zsh --go with nobody watching, meant for a tmux session
# so closing Robob (and the thread that started it) doesn't stop it:
#
#   tmux -L cutover new-session -d -s missions-cutover "zsh <this file> --dmg <dmg>"
#   tmux -L cutover attach -t missions-cutover      # watch it (Ctrl-b d to leave)
#
# It waits 90 s first (cancel with: tmux -L cutover kill-session -t missions-cutover),
# keeps the Mac awake, answers the installer's questions itself
# (ROBOB_UNATTENDED=1: stragglers are stopped after a few minutes, threads are
# resumed once the server answers reads steadily), and sends one Telegram:
# back up, or where it stopped.
set -uo pipefail
HERE=${0:A:h}
DMG=""
while (( $# )); do
  case $1 in
    --dmg) DMG=$2; shift 2 ;;
    *) print -u2 "unknown argument: $1"; exit 2 ;;
  esac
done
[[ -f $DMG ]] || { print -u2 "no DMG at '$DMG'"; exit 2; }

LOG=$HOME/.robob/cutover-$(date +%Y%m%d-%H%M%S).log
unset BUN_INSPECT
notify() {   # notify <severity> <key> <text>
  local i
  for i in 1 2 3 4 5 6; do
    /Users/ardud/.bun/bin/bun /Users/ardud/.local/share/telegram-bridge/src/cli.ts notify \
      --source "Missions cutover" --severity $1 --key "$2" --text "$3" >/dev/null 2>&1 && return 0
    sleep 30
  done
  osascript -e "display notification \"$3\" with title \"Missions cutover\"" >/dev/null 2>&1 || true
}

print "Missions cutover, unattended. Log: $LOG"
print "Starting in 90 s. To cancel: tmux -L cutover kill-session -t missions-cutover"
sleep 90
source "${0:A:h}/../../../integrations/robob-guard/scripts/install-hold.zsh"
robob_hold_begin missions-cutover-unattended || exit $?
START=$SECONDS
ROBOB_UNATTENDED=1 caffeinate -is zsh $HERE/missions-cutover.zsh --dmg $DMG --go 2>&1 | tee $LOG
rc=${pipestatus[1]}
mins=$(( (SECONDS - START) / 60 ))
backup=$(ls -dt $HOME/.robob/cutover-backup-* 2>/dev/null | head -1)
version=$(defaults read /Applications/Robob.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || print unknown)

if (( rc == 0 )); then
  notify attention "missions-cutover:$(date +%Y%m%d):up" \
"Robob is back up on $version after $mins min. The crpko mission exists and the Crpko master is its master. Next: send the master text B from CUTOVER-MESSAGE.md, then come back to the Missions build coordinator for the follow-up steps. Log: $LOG"
else
  last=$(grep -E '^== |FAILED|failed|stopped' $LOG | tail -3 | tr '\n' ' ')
  notify error "missions-cutover:$(date +%Y%m%d):failed" \
"The cutover stopped after $mins min (exit $rc). Installed now: $version. Last lines: $last Log: $LOG. Undo if needed: zsh $HERE/missions-rollback.zsh --backup ${backup:-<backup dir>} (dry run first)."
fi
print "Done (exit $rc). This window can be closed."
exit $rc
