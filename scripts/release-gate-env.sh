#!/usr/bin/env bash
# Source before the gate, or run: bash scripts/release-gate-env.sh <command> [args...].
release_gate_prepare() {
  local python sqlite
  python=$(type -P python3) || { echo GATE_PYTHON_MISSING >&2; return 127; }
  "$python" -c 'import sqlite3' || return $?

  if ! type -P sqlite3 >/dev/null 2>&1; then
    if [[ $(uname -s) != Linux ]] || ! command -v apt-get >/dev/null 2>&1; then
      echo GATE_SQLITE_MISSING >&2
      return 127
    fi
    local -a elevate=()
    if [[ $(id -u) != 0 ]]; then
      command -v sudo >/dev/null 2>&1 || { echo GATE_SUDO_MISSING >&2; return 127; }
      elevate=(sudo -n)
    fi
    "${elevate[@]}" apt-get update || return $?
    "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y sqlite3 || return $?
  fi
  sqlite=$(type -P sqlite3) || return 127
  "$sqlite" :memory: 'SELECT 1;' || return $?
  export HARNESS_TEST_PYTHON="$python"
  printf 'GATE_SQLITE %s\n' "$sqlite"
  "$sqlite" --version || return $?
  printf 'GATE_HARNESS_TEST_PYTHON %s\n' "$HARNESS_TEST_PYTHON"
  "$HARNESS_TEST_PYTHON" --version
}

if release_gate_prepare; then
  unset -f release_gate_prepare
else
  gate_setup_rc=$?
  unset -f release_gate_prepare
  return "$gate_setup_rc" 2>/dev/null || exit "$gate_setup_rc"
fi

if [[ ${BASH_SOURCE[0]} == "$0" && $# -gt 0 ]]; then
  exec "$@"
fi
true
