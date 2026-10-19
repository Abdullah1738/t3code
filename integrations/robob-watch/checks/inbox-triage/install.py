#!/usr/bin/python3
"""Install this check's source and register its definition, preserving private state."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parent
LIVE = Path.home() / '.local/share/robob-watch/watchers/inbox-triage'
DATA = Path.home() / 'Documents/assistant/inbox-triage'
SOURCE_FILES = ('triage.py', 'check.sh', 'install.py', 'test_triage.py', 'test_mail_retry.py', 'test_install.py', 'test_lock.py', 'README.md', 'settings.template.json', 'noise.template.json', 'prefs.template.md')


def atomic_copy(source, destination, executable=False):
    fd, tmp = tempfile.mkstemp(prefix='.install-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(source.read_bytes())
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o700 if executable else 0o600)
        os.replace(tmp, destination)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def install(source=SOURCE, live=LIVE, data=DATA, cli='robob-watch'):
    os.umask(0o077)
    live.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)
    # Keep the inode: replacing a held lock file would admit a concurrent check.
    with (live / 'check.lock').open('a') as lock:
        previous_handler = signal.getsignal(signal.SIGALRM)
        def timed_out(*_):
            raise TimeoutError('check still running after 65s; deployment not started')
        signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(65)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous_handler)
        for name in SOURCE_FILES:
            atomic_copy(source / name, live / name, name == 'check.sh')
        for name in ('settings', 'noise', 'prefs'):
            suffix = 'md' if name == 'prefs' else 'json'
            target = data / f'{name}.{suffix}'
            # Exclusive creation: never overwrite personal rules, even on redeploy.
            try:
                with target.open('xb') as f:
                    f.write((source / f'{name}.template.{suffix}').read_bytes())
            except FileExistsError:
                pass
        definition = json.loads((source / 'watcher.json').read_text())
        existing = live / 'watcher.json'
        if existing.exists():
            old = json.loads(existing.read_text())
            for field in ('paused', 'created_by_session'):
                if field in old:
                    definition[field] = old[field]
        resume = not definition.get('paused')
        # Publish paused while holding the check lock; activate after release.
        definition['paused'] = True
        environment = dict(os.environ)
        environment.pop('BUN_INSPECT', None)
        command = [cli, 'add', '--json', '-', '--no-prime']
        if existing.exists():
            command.append('--replace')
        subprocess.run(command, input=json.dumps(definition), text=True, check=True, env=environment, timeout=20)
    # Re-arm after releasing the lock; registration may have met a busy check.
    if resume:
        subprocess.run([cli, 'resume', definition['id']], check=True, env=environment, timeout=20)


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    install()
