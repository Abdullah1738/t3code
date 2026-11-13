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
    try:
        with fence():
            env = dict(os.environ, RECALL_FENCED='1')
            # The backup guard's flock must survive this intermediate wrapper.
            lock_fd = os.environ.get('MEMORY_BACKUP_LOCK_FD')
            inherited = (int(lock_fd),) if lock_fd is not None else ()
            result = subprocess.run(sys.argv[1:], env=env, pass_fds=inherited).returncode
    except Exception:
        if os.environ.get('MEMORY_BACKUP_GUARDED') == '1':
            try:
                import time
                from backup_control import log_skip
                log_skip(time.time(), 'other', lock_path().parents[1]/'backup.lock', 1)
            except Exception:
                pass
        raise
    sys.exit(result)
