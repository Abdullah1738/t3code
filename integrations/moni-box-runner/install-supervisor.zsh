#!/bin/zsh
set -euo pipefail
HERE=${0:A:h}
ROOT=$HOME/.local/share/moni-box-runner
CONFIG=${1:-$HOME/.config/spectrum-bridge/config.json}
SCRIPTS=${2:-$HOME/.config/opencode/skills/remote-compute/scripts}
mkdir -p "$ROOT" "$HOME/Library/LaunchAgents"
cp "$HERE/supervisor.py" "$ROOT/supervisor.py"
chmod 700 "$ROOT"
/usr/bin/python3 -I - "$ROOT" "$CONFIG" "$SCRIPTS" <<'PYPLIST'
import pathlib, plistlib, sys
root, config, scripts = sys.argv[1:]
data = {'Label': 'com.abdullah.moni-box-supervisor', 'ProgramArguments': ['/usr/bin/python3', '-I', root + '/supervisor.py', '--config', config, '--offbox-scripts', scripts],
        'RunAtLoad': True, 'KeepAlive': True, 'ProcessType': 'Standard',
        'StandardOutPath': root + '/supervisor.log', 'StandardErrorPath': root + '/supervisor-error.log'}
path = pathlib.Path.home() / 'Library/LaunchAgents/com.abdullah.moni-box-supervisor.plist'
path.write_bytes(plistlib.dumps(data))
PYPLIST
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.abdullah.moni-box-supervisor.plist"
