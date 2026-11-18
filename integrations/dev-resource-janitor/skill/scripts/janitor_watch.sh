#!/bin/zsh
# robob-watch check for the hourly dev janitor (watcher id: dev-janitor).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
S="${DEV_JANITOR_SCRIPT_DIR:-${0:A:h}}"
PY="${DEV_JANITOR_PYTHON:-/opt/homebrew/bin/python3}"
LOG_DIR="${DEV_JANITOR_LOG_DIR:-$HOME/.local/share/dev-janitor}"
# robob-watch passes no per-watcher env. The hourly run closes orphaned agent-browser daemons and stops stalled
# Xcode build trees under the owner's 16 Nov standing authority (#85, #87, #91 q1); the module defaults stay off
# for manual and test runs.
export DEV_JANITOR_REAP_AGENT_BROWSER="${DEV_JANITOR_REAP_AGENT_BROWSER:-1}"
export DEV_JANITOR_STOP_XCODE_BUILDS="${DEV_JANITOR_STOP_XCODE_BUILDS:-1}"
mkdir -p "$LOG_DIR"
# robob-watch forwards stdout to iMessage. Keep all check output local, including subprocess diagnostics.
exec >/dev/null 2>>"$LOG_DIR/watch.err"

# The tmpdir prune is separate from the resource janitor and can also outlast the check deadline.
TP="$S/tmpdir_prune.py"
TL="$LOG_DIR/tmpdir-prune"
mkdir -p "$TL"
if [[ -s "$TL/rc" && "$(<"$TL/rc")" != 0 ]]; then
  "$PY" "$S/janitor_watch.py" alert tmpdir_prune "dev-janitor: tmpdir prune exited $(<"$TL/rc"): $(tail -c 300 "$TL/err" | tr '\n' ' ')"
fi
if ! { [[ -f "$TL/pid" ]] && kill -0 "$(<"$TL/pid")" 2>/dev/null; }; then
  rm -f "$TL/rc"
  ( "$PY" "$TP" apply > "$TL/out" 2> "$TL/err"; echo $? > "$TL/rc"; rm -f "$TL/pid" ) </dev/null >/dev/null 2>&1 &!
  echo $! > "$TL/pid"
fi

# This only starts a detached, single-flight cycle and alerts the previous failure. The worker calls apply(),
# which takes a fresh snapshot before each action, outside robob-watch's 60-second check budget.
"$PY" "$S/janitor_watch.py" check
