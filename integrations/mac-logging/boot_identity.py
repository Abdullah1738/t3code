"""Boot identity shared by emitters and persisted CPU baselines."""
import datetime as dt
from functools import lru_cache
import subprocess
from logwindow import current_boottime, parse_boottime


def parse(text):
    epoch = parse_boottime(text)
    return dict(bootEpoch=epoch, bootTime=dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat().replace('+00:00', 'Z'))


@lru_cache(maxsize=1)
def identity():
    try:
        epoch = current_boottime()
        return dict(bootEpoch=epoch, bootTime=dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat().replace('+00:00', 'Z'))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
