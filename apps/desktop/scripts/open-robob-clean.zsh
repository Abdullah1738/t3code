#!/bin/zsh -f
# Open Robob (or the app given) with a clean environment.
#
#   zsh open-robob-clean.zsh [APP]     # APP defaults to /Applications/Robob.app
#
# `open` hands the caller's environment to the app, and Robob passes it on to
# everything it starts. Run from an agent's shell or tmux, that leaks the
# agent's OPENCODE_SESSION_ID (the offbox monitor then charges Robob's CPU to
# that thread), TMUX, OFFBOX_GATE and OPENCODE_SERVER_PASSWORD. So the app gets
# only what a Finder launch has, plus the login shell's PATH: Robob reads that
# PATH itself at start but gives up after 5 s, and under load `zsh -ilc` takes
# longer than that. The PATH read is capped at OPEN_CLEAN_SHELL_WAIT seconds
# (default 30); past that the app opens with the system PATH and Robob's own
# read still applies.
set -euo pipefail
APP=${1:-/Applications/Robob.app}
[[ -d $APP ]] || { print -u2 "no app at $APP"; exit 2; }
U=${USER:-$(/usr/bin/id -un)}
BASE=/usr/bin:/bin:/usr/sbin:/sbin
TMP=$(/usr/bin/getconf DARWIN_USER_TEMP_DIR)
WAIT=${OPEN_CLEAN_SHELL_WAIT:-30}
OUT_FILE=$(/usr/bin/mktemp ${TMP}open-robob-path.XXXXXX)
( cd / && exec /usr/bin/env -i HOME=$HOME USER=$U LOGNAME=$U SHELL=/bin/zsh TMPDIR=$TMP PATH=$BASE \
    /bin/zsh -ilc 'print -r -- "__ROBOB_PATH__${PATH}__ROBOB_END__"' </dev/null >$OUT_FILE 2>/dev/null ) &
SHELL_PID=$!
for i in {1..$(( WAIT * 2 ))}; do
  kill -0 $SHELL_PID 2>/dev/null || break
  sleep 0.5
done
if kill -0 $SHELL_PID 2>/dev/null; then
  kill -9 $SHELL_PID 2>/dev/null || true
  print -u2 "open-robob-clean: login shell PATH took over ${WAIT}s; opening with the system PATH"
fi
wait $SHELL_PID 2>/dev/null || true
OUT=$(<$OUT_FILE)
rm -f $OUT_FILE
LOGIN_PATH=$BASE
if [[ $OUT == *__ROBOB_PATH__/*__ROBOB_END__* ]]; then
  LOGIN_PATH=${${OUT##*__ROBOB_PATH__}%%__ROBOB_END__*}
fi
exec /usr/bin/env -i HOME=$HOME USER=$U LOGNAME=$U SHELL=/bin/zsh TMPDIR=$TMP PATH=$LOGIN_PATH \
  /usr/bin/open $APP
