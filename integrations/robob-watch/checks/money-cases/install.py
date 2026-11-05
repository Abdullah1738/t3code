#!/usr/bin/python3
"""Install the money-cases check and CLI and register its watcher, keeping case data and ping state."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parent
LIVE = Path.home() / '.local/share/robob-watch/watchers/money-cases'
DATA = Path.home() / 'Documents/assistant/money-cases'
BIN = Path.home() / '.local/bin/money-cases'
SOURCE_FILES = ('cases.py', 'charges.py', 'check.sh', 'install.py', 'test_cases.py', 'test_charges.py',
                'test_install.py', 'README.md')
EXECUTABLE = ('cases.py', 'check.sh', 'install.py')


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


def check_link(link):
    if (link.exists() or link.is_symlink()) and not link.is_symlink():
        raise FileExistsError(f'{link} exists and is not a symlink; leaving it alone')


def link_cli(target, link):
    if link.is_symlink() and os.readlink(link) == str(target):
        return
    check_link(link)
    link.parent.mkdir(parents=True, exist_ok=True)
    tmp = link.with_name('.' + link.name + '.tmp')
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    tmp.symlink_to(target)
    os.replace(tmp, link)


def write_intent(path, paused):
    fd, tmp = tempfile.mkstemp(prefix='.install-', dir=path.parent)
    with os.fdopen(fd, 'w') as f:
        json.dump({'paused': paused}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def take_lock(handle, message):
    previous_handler = signal.getsignal(signal.SIGALRM)

    def timed_out(*_):
        raise TimeoutError(message)
    signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(65)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)


def install(source=SOURCE, live=LIVE, data=DATA, link=BIN, cli='robob-watch'):
    os.umask(0o077)
    check_link(link)
    live.mkdir(parents=True, exist_ok=True)
    data.mkdir(parents=True, exist_ok=True)
    # One installer at a time, through the resume: a second one must not read or delete the first one's intent.
    with (live / 'install.lock').open('a') as install_lock:
        take_lock(install_lock, 'another install still running after 65s; deployment not started')
        # Keep the inode: replacing a held lock file would admit a concurrent check.
        with (live / 'check.lock').open('a') as lock:
            take_lock(lock, 'check still running after 65s; deployment not started')
            for name in SOURCE_FILES:
                atomic_copy(source / name, live / name, name in EXECUTABLE)
            helper = source / 'robob_readonly.py'
            if not helper.exists():
                helper = source.parents[1] / 'helpers/robob_readonly.py'
            atomic_copy(helper, live / 'robob_readonly.py')
            link_cli(live / 'cases.py', link)
            definition = json.loads((source / 'watcher.json').read_text())
            existing = live / 'watcher.json'
            old = json.loads(existing.read_text()) if existing.exists() else {}
            if 'created_by_session' in old:
                definition['created_by_session'] = old['created_by_session']
            # The watcher is published paused and resumed afterwards. Until that resume lands, the owner's own
            # pause state lives in this file, so a failed resume isn't mistaken for his pause on the next run.
            intent = live / '.install-paused'
            if intent.exists():
                paused = json.loads(intent.read_text())['paused']
            else:
                paused = bool(old.get('paused'))
            write_intent(intent, paused)
            definition['paused'] = True
            environment = dict(os.environ)
            environment.pop('BUN_INSPECT', None)
            command = [cli, 'add', '--json', '-', '--no-prime']
            if existing.exists():
                command.append('--replace')
            subprocess.run(command, input=json.dumps(definition), text=True, check=True, env=environment,
                           timeout=20)
        if not paused:
            subprocess.run([cli, 'resume', definition['id']], check=True, env=environment, timeout=20)
        intent.unlink()


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    install()
