"""One bounded bridge attempt in a detached child."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from overload_io import load, save


def attempt(payload, receipt, sender=subprocess.run):
    notice = load(payload, {})
    with receipt.with_suffix('.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if load(receipt, {}).get('key') == notice['key']:
            return
        result = sender(['/Users/ardud/.bun/bin/bun',
            '/Users/ardud/.local/share/telegram-bridge/src/cli.ts', 'notify',
            '--source', 'Mac overload', '--severity', notice['severity'],
            '--text='+notice['text'], '--key='+notice['key']],
            env=dict(os.environ, BUN_INSPECT=''), timeout=20, check=True,
            capture_output=True, text=True)
        response = json.loads(result.stdout)
        if not re.fullmatch(r'notify:[a-f0-9]{64}', response.get('id', '')):
            raise ValueError('bridge did not accept notification')
        save(receipt, dict(key=notice['key'], id=response['id']))


if __name__ == '__main__':
    try:
        attempt(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, ValueError, subprocess.SubprocessError):
        sys.exit(1)
