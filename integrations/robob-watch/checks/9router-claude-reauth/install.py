#!/usr/bin/python3
"""Install reviewed code only; leave watcher registration, journals and leases intact."""
import argparse
import fcntl
import os
from pathlib import Path
import signal
import tempfile

SOURCE = Path(__file__).resolve().parent
LIVE = Path.home() / '.local/share/robob-watch/watchers/9router-claude-reauth'
SOURCE_FILES = ('check.sh', 'supervisor.mjs', 'supervisor.test.mjs', 'lease.mjs', 'README.md', 'install.py')


def install(source=SOURCE, live=LIVE):
    if not (live / 'watcher.json').is_file():
        raise FileNotFoundError('existing watcher required; registration is a separate operation')
    # Validate the entire allowlist before changing any installed code.
    files = [(name, (source / name).read_bytes()) for name in SOURCE_FILES]
    os.umask(0o077)
    # Match check.sh's flock/lockf lock and preserve its permanent inode.
    with (live / 'supervisor.lock').open('a') as lock:
        previous = signal.getsignal(signal.SIGALRM)

        def timed_out(*_):
            raise TimeoutError('check still running after 65s; deployment not started')

        signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(65)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
        for name, contents in files:
            fd, tmp = tempfile.mkstemp(prefix='.install-', dir=live)
            try:
                with os.fdopen(fd, 'wb') as handle:
                    handle.write(contents)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(tmp, 0o700 if name == 'check.sh' else 0o600)
                os.replace(tmp, live / name)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    install()
