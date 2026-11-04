#!/bin/zsh
# robob-watch check for the hourly dev janitor (watcher id: dev-janitor).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
S="$HOME/.config/opencode/skills/dev-resource-janitor/scripts/dev_janitor.py"
PY=/opt/homebrew/bin/python3

# The tmpdir prune is separate from the resource janitor and can also outlast the check deadline.
TP="${S:h}/tmpdir_prune.py"
TL="$HOME/.local/share/dev-janitor/tmpdir-prune"
mkdir -p "$TL"
if [[ -s "$TL/rc" && "$(<"$TL/rc")" != 0 ]]; then
  echo "dev-janitor: tmpdir prune exited $(<"$TL/rc"): $(tail -c 300 "$TL/err" | tr '\n' ' ')"
fi
if ! { [[ -f "$TL/pid" ]] && kill -0 "$(<"$TL/pid")" 2>/dev/null; }; then
  rm -f "$TL/rc"
  ( "$PY" "$TP" apply > "$TL/out" 2> "$TL/err"; echo $? > "$TL/rc"; rm -f "$TL/pid" ) </dev/null >/dev/null 2>&1 &!
  echo $! > "$TL/pid"
fi

# This only starts a detached, single-flight cycle and reports the previous failure. The worker calls apply(),
# which takes a fresh snapshot before each action, outside robob-watch's 60-second check budget.
"$PY" "${S:h}/janitor_watch.py" check
