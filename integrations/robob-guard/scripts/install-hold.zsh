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

# Status 70 means files could not be restored. Keep the installer and its
# heartbeat alive while the operator repairs them and reopens a healthy app.
robob_hold_wait_for_repair() {
  print -u2 'Recovery needs manual repair. Keeping the install heartbeat alive until Robob is healthy.'
  print -u2 'Keep this installer running; repair the files, then reopen Robob.'
  until "$@" >/dev/null 2>&1; do
    sleep 30
  done
}
