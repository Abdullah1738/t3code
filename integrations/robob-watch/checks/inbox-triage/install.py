#!/usr/bin/python3
"""Install this check's source and register its definition, preserving private state."""
import argparse
import contextlib
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
AUTH_PRODUCERS = Path.home() / '.local/share/app-api-cli'
PRODUCER_FILES = ('inbox_auth.py', 'careem_account_auth.py', 'commerce_journal.py')
SOURCE_FILES = ('triage.py', 'fastpath.py', 'expected_auth.py', 'check.sh', 'install.py', 'test_triage.py', 'test_owner_go.py', 'test_urgent.py', 'test_fastpath.py', 'test_mail_retry.py', 'test_install.py', 'test_lock.py', 'README.md', 'settings.template.json', 'noise.template.json', 'prefs.template.md')


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
    producers = source.parents[2] / 'app-api-cli'
    if any(not (AUTH_PRODUCERS / name).is_file()
           or (AUTH_PRODUCERS / name).read_bytes() != (producers / name).read_bytes()
           for name in PRODUCER_FILES):
        raise RuntimeError('Install the matching app-api-cli auth producers before enabling inbox-triage-fastpath')
    os.umask(0o077)
    live.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)
    # Keep the inode: replacing a held lock file would admit a concurrent check.
    fast_live = live.parent / 'inbox-triage-fastpath'
    fast_live.mkdir(parents=True, exist_ok=True)
    with contextlib.ExitStack() as stack:
        locks = [stack.enter_context((directory / 'check.lock').open('a')) for directory in (live, fast_live)]
        previous_handler = signal.getsignal(signal.SIGALRM)
        def timed_out(*_):
            raise TimeoutError('check still running after 65s; deployment not started')
        signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(65)
        try:
            for lock in locks:
                fcntl.flock(lock, fcntl.LOCK_EX)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous_handler)
        for name in SOURCE_FILES:
            for destination in (live, fast_live):
                atomic_copy(source / name, destination / name, name == 'check.sh')
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
    fast = json.loads((source / 'watcher.fastpath.json').read_text())
    fast_live = live.parent / fast['id']
    fast_live.mkdir(parents=True, exist_ok=True)
    fast_old = fast_live / 'watcher.json'
    if fast_old.exists():
        previous = json.loads(fast_old.read_text())
        for field in ('paused', 'created_by_session'):
            if field in previous:
                fast[field] = previous[field]
    else:
        fast['paused'] = definition.get('paused', False) if not resume else False
    command = [cli, 'add', '--json', '-', '--no-prime']
    if fast_old.exists():
        command.append('--replace')
    subprocess.run(command, input=json.dumps(fast), text=True, check=True, env=environment, timeout=20)


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    install()
