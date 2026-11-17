# Source before the first quit; zshexit coexists with an installer's EXIT cleanup.
robob_hold_begin() {
  local helper=$HOME/.local/bin/robob-install-hold
  if [[ ! -x $helper ]]; then
    print -u2 'WARNING: robob-install-hold missing; Robob guard may reopen mid-install.'
    return 0
  fi
  if [[ -n ${ROBOB_INSTALL_HOLD_BY:-} && -n ${ROBOB_INSTALL_HOLD_PID:-} ]] \
    && "$helper" beat --by "$ROBOB_INSTALL_HOLD_BY" --pid "$ROBOB_INSTALL_HOLD_PID"; then
    return 0
  fi
  "$helper" start --by "$1" --pid $$ || return $?
  export ROBOB_INSTALL_HOLD_BY=$1 ROBOB_INSTALL_HOLD_PID=$$
  autoload -Uz add-zsh-hook
  add-zsh-hook zshexit robob_hold_end
}
robob_hold_end() {
  "$HOME/.local/bin/robob-install-hold" stop --by "$ROBOB_INSTALL_HOLD_BY" --pid "$ROBOB_INSTALL_HOLD_PID" || true
}

robob_quit_reason() {
  /usr/bin/python3 -I "${${(%):-%x}:A:h}/../quit_reason.py" --initiator installer --reason "$1"
}

robob_hold_health() {
  local response
  response=$("$@") || return 1
  print -r -- "$response" | /usr/bin/python3 -c '
import json, sys
try:
    health = json.load(sys.stdin)
    healthy = isinstance(health, dict) and health.get("ok") is True and health.get("status") == "healthy"
except (ValueError, TypeError):
    healthy = False
sys.exit(0 if healthy else 1)
'
}

# An unsuccessful attempt still owns recovery until healthy JSON confirms it.
robob_hold_wait_for_repair() {
  print -u2 'Recovery needs manual repair. Keeping the install heartbeat alive until Robob is healthy.'
  print -u2 'Keep this installer running; repair the files, then reopen Robob.'
  until robob_hold_health "$@" >/dev/null 2>&1; do
    sleep 30
  done
}
