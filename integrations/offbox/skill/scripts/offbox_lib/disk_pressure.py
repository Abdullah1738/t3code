"""Home disk failures stay sticky until a write or an explicit disk measurement proves recovery."""
import json
import os
import time
from . import common


def is_full(message):
    text = str(message).lower()
    return any(s in text for s in ('database or disk is full', 'disk i/o error', 'no space left on device', 'enospc'))


def path():
    return common.SERVER_CFG.with_name('home-disk-pressure.json')


def remember(full):
    try:
        p = path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + f'.{os.getpid()}.tmp')
        tmp.write_text(json.dumps({'full': bool(full), 'at': time.time()}) + '\n')
        os.replace(tmp, p)
    except OSError:
        pass


def failure():
    try:
        value = json.loads(path().read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def pending():
    return failure().get('full') is True


def health_reason(data):
    disk = data.get('disk') or {}
    if data.get('disk_full') or disk.get('disk_full') or disk.get('level') in ('full', 'unknown'):
        return 'home server out of disk' if disk.get('level') != 'unknown' else 'home disk measurement unavailable'
    recorded = failure()
    if recorded.get('full'):
        sampled = disk.get('sampled_at')
        written = disk.get('written_at')
        if (data.get('ok') is True and disk.get('level') == 'ok' and disk.get('write_ok') is True
                and isinstance(sampled, (int, float)) and isinstance(written, (int, float))
                and min(sampled, written) > recorded.get('at', float('inf'))):
            remember(False)
        else:
            return 'home server out of disk; awaiting disk recovery'
    return None


def refusal(message, details=None):
    disk = (details or {}).get('disk') or {}
    row = next((r for r in disk.get('filesystems', []) if r.get('level') in ('full', 'low')), None)
    if row:
        return f"low on disk ({row['free_bytes'] / 1024**3:.1f} GiB on {row['filesystem']})"
    return f'low on disk ({message})'
