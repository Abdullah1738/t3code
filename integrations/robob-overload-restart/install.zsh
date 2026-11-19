#!/bin/zsh -f
set -euo pipefail
source_dir=${0:A:h}
install_dir=${ROBOB_OVERLOAD_HOME:-$HOME/.local/share/robob-overload-restart}
state_dir=${ROBOB_OVERLOAD_STATE:-$HOME/.local/state/robob-overload-restart}
plist_dir=${ROBOB_OVERLOAD_PLIST_DIR:-$HOME/Library/LaunchAgents}
control_dir=$source_dir/../../apps/server/src/ardud/control
mkdir -p "$install_dir/control" "$state_dir" "$plist_dir"
for name in robob-overload-restart.py open-robob-clean.zsh launchd-entry.zsh health-probe.mjs; do
  cp "$source_dir/$name" "$install_dir/$name"
done
# Copy current fork dependencies to internal storage, not the obsolete board-artifact snapshot.
for name in client.mjs deep-health.mjs; do
  cp "$control_dir/$name" "$install_dir/control/$name"
done
chmod 700 "$install_dir/launchd-entry.zsh" "$install_dir/open-robob-clean.zsh"
# Installation is deliberately inert, including when the caller forgot the disabled marker.
touch "$state_dir/disabled"
/usr/bin/python3 -I - "$source_dir" "$install_dir" "$state_dir" "$plist_dir" <<'PY'
import plistlib
from pathlib import Path
import sys
source, install, state, plists = map(Path, sys.argv[1:])
text = (source / 'com.ardud.robob-overload-restart.plist.template').read_text()
import html
text = text.replace('@INSTALL@', html.escape(str(install))).replace('@STATE@', html.escape(str(state)))
value = plistlib.loads(text.encode())
with (plists / 'com.ardud.robob-overload-restart.plist').open('wb') as handle:
    plistlib.dump(value, handle)
PY
print -r -- "Installed disabled; no LaunchAgent loaded. After the README prerequisites and Abdullah's go:"
print -r -- "launchctl bootstrap gui/$(id -u) ${(q)plist_dir}/com.ardud.robob-overload-restart.plist"
