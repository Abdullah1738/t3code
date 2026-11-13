#!/bin/bash
# error.sh: subiquity error-command. The install failed. Save everything to the stick, stay reachable for a
# while, then restart and try again. After three failures in a row the pause between tries becomes a day, so
# a broken disk is not hammered and the box can still be reached over SSH.
# shellcheck source=common.sh
. /cdrom/offbox/installer/common.sh
exec >> "$RUN/late.log" 2>&1
set -x
touch "$RUN/holding"
logvol_mount || true
n=0
if logvol_mounted; then
  [ -s "$LOGMNT/fail-count" ] && n=$(tr -cd 0-9 < "$LOGMNT/fail-count")
  n=$(( ${n:-0} + 1 ))
  echo "$n" > "$LOGMNT/fail-count"
fi
stage install-failed "subiquity reported a failed install (failure $n in a row)"
inventory
sync_logs
if [ "$n" -ge 3 ]; then
  hold_then_reboot "$(cfgval long_hold_seconds 86400)" "install failed $n times"
else
  hold_then_reboot "$(cfgval error_hold_seconds 600)" "install failed"
fi
