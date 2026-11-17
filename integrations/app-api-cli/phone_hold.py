"""Phone priority-hold status through ph's public CLI."""
import json
import os
import subprocess

PH_BIN = os.environ.get('PH_BIN', '/opt/homebrew/bin/ph')


def status():
    error = None
    try:
        result = subprocess.run([PH_BIN, 'hold', 'status', '--json'], timeout=15,
                                capture_output=True, text=True,
                                env={k: v for k, v in os.environ.items()
                                     if not k.startswith('BUN_INSPECT')})
        if result.returncode:
            error = 'ph exited {}'.format(result.returncode)
        else:
            value = json.loads(result.stdout)
            if isinstance(value, dict) and isinstance(value.get('present'), bool):
                return value
            error = 'invalid ph status'
    except subprocess.TimeoutExpired:
        error = 'ph timed out'
    except (OSError, ValueError, UnicodeError) as exc:
        error = type(exc).__name__
    return {'present': True, 'error': error, 'age_s': None, 'stale_in_s': None,
            'holder_alive': None, 'agent_comm': None}


def held():
    return status()['present']
