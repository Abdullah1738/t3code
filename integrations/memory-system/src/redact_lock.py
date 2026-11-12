"""Cross-process fence for capture, backup, recall requests and maintenance."""
import contextlib
import fcntl
import os
from pathlib import Path
import subprocess
import sys


def lock_path(root=None):
    return Path(root or os.environ.get('MEMORY_ROOT') or Path(__file__).resolve().parents[1]) / 'logs/state/redaction.flock'


@contextlib.contextmanager
def fence(root=None, *, exclusive=False, blocking=True):
    path = lock_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as f:
        operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        fcntl.flock(f, operation | (0 if blocking else fcntl.LOCK_NB))
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


if __name__ == '__main__':
    with fence():
        env = dict(os.environ, RECALL_FENCED='1')
        sys.exit(subprocess.run(sys.argv[1:], env=env).returncode)
