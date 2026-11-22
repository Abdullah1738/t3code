"""Durable transition outbox. Only the I/O thread touches disk or spawns."""
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading

from overload import evaluate
from spawn_schema import fields as spawn_fields


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def load(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def launch(path, receipt):
    return subprocess.Popen([sys.executable, str(Path(__file__).with_name('overload_notify.py')),
        str(path), str(receipt)], start_new_session=True, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
        env=dict(os.environ, BUN_INSPECT=''))


class Dispatcher:
    def __init__(self, writer, directory=None, launcher=launch):
        self.directory = Path(directory or Path.home()/'.local/state/mac-overload')
        self.path = self.directory/'state.json'
        # Startup is outside the sampling loop. Do not silently reset dedupe.
        self.durable = load(self.path, dict(state={}, outbox=[]))
        self.state = self.durable['state']
        self.writer, self.launcher = writer, launcher
        self.queue = queue.SimpleQueue()
        self.child = None
        self.latest_families = []
        self.latest_spawn = None
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def tick(self, props, now):
        self.state, actions = evaluate(self.state, dict(props, families=self.latest_families), now)
        for action in actions:
            action['event']['spawn'] = spawn_fields(self.latest_spawn)
        self.queue.put((self.state, actions))

    def process(self, state, actions):
        self.durable['state'] = state
        self.durable['outbox'].extend(dict(action, logged=False) for action in actions)
        # State and actions commit together so remembering onset cannot lose
        # its pending alert. The worker keeps failed writes for the next tick.
        save(self.path, self.durable)
        remaining = []
        for entry in self.durable['outbox']:
            if not entry['logged']:
                entry['logged'] = bool(self.writer('host.overload', entry['event']))
            notice = entry.get('notify')
            accepted = False
            if notice:
                digest = hashlib.sha256(notice['key'].encode()).hexdigest()
                receipt = self.directory/(digest+'.accepted.json')
                accepted = load(receipt, {}).get('key') == notice['key']
            if not entry['logged'] or notice and not accepted:
                remaining.append(entry)
        self.durable['outbox'] = remaining
        save(self.path, self.durable)
        if self.child is not None and self.child.poll() is None:
            return
        self.child = None
        for entry in remaining:
            notice = entry.get('notify')
            if notice:
                digest = hashlib.sha256(notice['key'].encode()).hexdigest()
                payload = self.directory/(digest+'.pending.json')
                receipt = self.directory/(digest+'.accepted.json')
                if load(receipt, {}).get('key') == notice['key']:
                    continue
                save(payload, notice)
                self.child = self.launcher(payload, receipt)
                break

    def loop(self):
        while True:
            state, actions = self.queue.get()
            try:
                self.process(state, actions)
            except (OSError, ValueError, subprocess.SubprocessError):
                # Actions already entered the in-memory outbox before any I/O.
                # A later tick retries it; a failed persist never sends.
                continue
