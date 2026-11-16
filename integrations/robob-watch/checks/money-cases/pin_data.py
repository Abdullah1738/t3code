"""Keep Downloaded support verified through FileProvider's reported state."""
from pathlib import Path
import re
import subprocess
import sys
import time

from data_io import dataless_files

PIN = 'com.apple.fileprovider.pinned#PX'


def _pinned(data, timeout):
    result = subprocess.run(['fileproviderctl', 'evaluate', str(data)], capture_output=True,
                            text=True, timeout=timeout, check=True)
    return re.search(r'\bisKeepDownloaded\s*=\s*1\s*;', result.stdout) is not None


def pin_data_dir(data):
    if sys.platform != 'darwin':
        return 'pin failed: Keep Downloaded requires macOS'
    try:
        data = Path(data)
        if _pinned(data, 2):
            return 'already pinned'
        subprocess.run(['xattr', '-w', PIN, '1', str(data)], capture_output=True,
                       text=True, timeout=2, check=True)
        end = time.monotonic() + 8
        while time.monotonic() < end:
            if _pinned(data, max(0.001, min(2, end - time.monotonic()))):
                return 'pinned'
            remaining = end - time.monotonic()
            if remaining > 0:
                time.sleep(min(0.2, remaining))
        return 'pin failed: FileProvider did not confirm Keep Downloaded'
    except (OSError, subprocess.SubprocessError) as exc:
        return f'pin failed: {type(exc).__name__}'


def pin_status(data):
    if sys.platform != 'darwin':
        return 'pin failed: Keep Downloaded requires macOS'
    try:
        pinned = _pinned(data, 3)
        return f'{"pinned" if pinned else "not pinned"}; dataless {dataless_files(Path(data))}'
    except (OSError, subprocess.SubprocessError) as exc:
        return f'pin failed: {type(exc).__name__}'
