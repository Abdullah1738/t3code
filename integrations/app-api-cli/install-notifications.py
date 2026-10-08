"""Install the read-only phone notification journal's restartable LaunchAgent."""
from pathlib import Path
import plistlib
import subprocess
import os

home = Path.home()
label = 'com.ardud.delivery-notifications'
state = home / '.local/state/order-tracker'
state.mkdir(parents=True, exist_ok=True, mode=0o700)
plist = home / 'Library/LaunchAgents' / (label + '.plist')
data = {'Label': label, 'ProgramArguments': ['/usr/bin/python3', str(home / '.local/share/app-api-cli/delivery_store.py')],
        'RunAtLoad': True, 'StartInterval': 15, 'ProcessType': 'Standard',
        'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/Users/ardud/.local/bin:/usr/bin:/bin'},
        'StandardOutPath': str(state / 'collector.log'), 'StandardErrorPath': str(state / 'collector-error.log')}
plist.write_bytes(plistlib.dumps(data))
domain = f'gui/{os.getuid()}'
subprocess.run(['launchctl', 'bootout', domain + '/' + label], capture_output=True)
subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
print(label)
