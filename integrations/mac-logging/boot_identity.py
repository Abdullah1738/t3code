"""Boot identity shared by emitters and persisted CPU baselines."""
import datetime as dt
from functools import lru_cache
import os
import re
import subprocess


def parse(text):
    match = re.search(r'\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)', text)
    if not match or not 0 <= int(match[2]) < 1000000:
        raise ValueError('invalid kern.boottime')
    epoch = int(match[1])+int(match[2])/1000000
    return dict(bootEpoch=epoch, bootTime=dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat().replace('+00:00', 'Z'))


@lru_cache(maxsize=1)
def identity():
    try:
        result = subprocess.run(['/usr/sbin/sysctl', '-n', 'kern.boottime'], capture_output=True,
                                text=True, timeout=2,
                                env={k: v for k, v in os.environ.items() if k != 'BUN_INSPECT'})
        return parse(result.stdout) if result.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
