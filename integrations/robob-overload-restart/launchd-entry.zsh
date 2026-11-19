#!/bin/zsh -f
set -u
unset BUN_INSPECT BUN_INSPECT_BRK BUN_INSPECT_WAIT
cd /
root=${ROBOB_OVERLOAD_HOME:-${0:A:h}}
# Keep zsh alive as the launchd responsible process for Python and Node's file access.
/usr/bin/python3 -I "$root/robob-overload-restart.py" "${@:-check}"
exit $?
