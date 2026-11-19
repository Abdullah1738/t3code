"""Pre-command SSH connectivity recovery while the runner owns the box guard."""
from __future__ import annotations

import contextlib
import contextvars
import datetime as dt
import re
import socket
import subprocess
import time

from .common import OffboxError, log, say

_PRE_START = contextvars.ContextVar('ssh_pre_start', default=False)
_RECOVERY = contextvars.ContextVar('ssh_recovery', default=None)
PROBE_EVERY_S = 10
PROGRESS_EVERY_S = 60
CONNECT_FAILURE = re.compile(
    r"(?:^|\n)(?:ssh: )?connect to host [^\n]+(?:Operation timed out|Connection timed out|"
    r"Connection refused|No route to host|Network is unreachable)|"
    r"(?:^|\n)(?:ssh: )?Could not resolve hostname [^\n]+|"
    r"(?:^|\n)Connection closed by [^\n]+ port \d+|"
    r"(?:^|\n)Connection timed out during banner exchange|"
    r"(?:^|\n)Connection to [^\n]+ port \d+ timed out|"
    r"(?:^|\n)kex_exchange_identification:", re.I)


def tailnet(timeout=2):
    # Keep the monitor's BackendState + Self.Online rule and its bounded CLI lookup.
    from home_monitor import tailnet_facts
    return tailnet_facts(timeout=timeout)


def tailnet_down(facts):
    return not facts['up'] and facts['detail'] != 'tailscale CLI not found'


class SshUnreachable(OffboxError):
    def __init__(self, box, message, *, reason=None):
        super().__init__(message, box=box)
        self.reason = reason or ('tailnet_down' if tailnet_down(tailnet()) else 'box_ssh_unreachable')
        self.waited_s = None


def classify(box, code, stderr, *, rsync=False):
    text = stderr.decode(errors='replace') if isinstance(stderr, bytes) else stderr
    if code not in ((12, 255) if rsync else (255,)):
        return
    if any(s in text.lower() for s in ('permission denied', 'host key', 'host identification', 'offending ')):
        return
    if CONNECT_FAILURE.search(text):
        raise SshUnreachable(box, f"{'rsync' if rsync else 'ssh'} {box} failed ({code}): {text[-600:]}")


@contextlib.contextmanager
def pre_start(*, enabled=True):
    token = _PRE_START.set(enabled)
    try:
        yield
    finally:
        _PRE_START.reset(token)


def checking_pre_start():
    return _PRE_START.get()


@contextlib.contextmanager
def recovery(*, enabled):
    state = {'enabled': enabled, 'waiter': None}
    token = _RECOVERY.set(state)
    try:
        with pre_start(enabled=enabled):
            yield
    finally:
        _RECOVERY.reset(token)


def wait_for_connection(error, *, attempt_s=0):
    from . import api, outage, prepare
    state = _RECOVERY.get()
    if state is None or not state['enabled']:
        raise error
    if state['waiter'] is None:
        state['waiter'] = Wait(outage.window_seconds())
    began = time.monotonic()
    try:
        with prepare.pause_for_home_start(extra_seconds=attempt_s):
            return state['waiter'].until_reachable(error)
    finally:
        if api._DEADLINE is not None:
            api._DEADLINE += time.monotonic() - began + attempt_s


def retry_readiness(operation):
    while True:
        began = time.monotonic()
        try:
            return operation()
        except SshUnreachable as error:
            if not wait_for_connection(error, attempt_s=time.monotonic() - began):
                raise


def control_state(error):
    """A confirmed stopped box needs resume rather than an SSH outage wait."""
    from . import api, home
    if error.reason == 'tailnet_down':
        return None
    try:
        with api.budget(5):
            return (api.get(error.box) or {}).get('state')
    except home.StartWaitFailed:
        raise
    except (OffboxError, OSError, subprocess.TimeoutExpired):
        return None


def reachable(box, timeout):
    from . import ssh_sync
    end = time.monotonic() + timeout
    facts = tailnet(timeout=min(2, timeout))
    if tailnet_down(facts):
        return False, 'tailnet_down'
    try:
        config = ssh_sync.cfg_path(box).read_text()
    except OSError:
        return False, 'box_ssh_unreachable'
    host = re.search(r'^\s*HostName\s+(\S+)', config, re.M | re.I)
    port = re.search(r'^\s*Port\s+(\d+)', config, re.M | re.I)
    if not host or not port:
        return False, 'box_ssh_unreachable'
    ports = [int(port[1])]
    home_ports = re.search(r'^# offbox-home-ports (\d+) (\d+)$', config, re.M)
    if home_ports:
        ports = [int(p) for p in home_ports.groups()]
    selected = ssh_sync._HOME_PORTS.get(box)
    if selected and selected[0] == config:
        ports.insert(0, selected[1])
    for candidate in dict.fromkeys(ports):
        left = end - time.monotonic()
        if left <= 0:
            break
        try:
            socket.create_connection((host[1].strip('[]'), candidate), timeout=min(2, left)).close()
            if selected and selected[1] != candidate:
                # Retry the authenticated port selection; TCP reachability never changes a host-key pin.
                ssh_sync._HOME_PORTS.pop(box, None)
            return True, 'box_ssh_unreachable'
        except OSError:
            pass
    return False, 'box_ssh_unreachable'


class Wait:
    def __init__(self, seconds):
        self.start = time.monotonic()
        self.end = self.start + seconds
        self.since = dt.datetime.now(dt.timezone.utc).strftime('%H:%MZ')
        self.next_say = self.next_probe = self.start

    def until_reachable(self, error):
        log(f'ssh_unreachable box={error.box} reason={error.reason} waited={int(time.monotonic()-self.start)}s phase=start')
        while True:
            t = time.monotonic()
            left = max(0, self.end - t)
            if left <= 0:
                error.waited_s = time.monotonic() - self.start
                why = 'Mac tailnet is down' if error.reason == 'tailnet_down' else 'box SSH endpoint is unreachable'
                error.args = (f'{error.box}: nothing ran; {why}; waited {int(error.waited_s)}s; a plain remote retry is safe',)
                log(f'ssh_unreachable box={error.box} reason={error.reason} waited={int(error.waited_s)}s outcome=gave_up')
                return False
            if t >= self.next_say:
                why = f'Mac tailnet down since {self.since}' if error.reason == 'tailnet_down' else 'box SSH endpoint unreachable'
                say(f"can't reach {error.box} over SSH ({why}); nothing has started; holding the box and waiting up to {int(left)}s")
                self.next_say = t + PROGRESS_EVERY_S
            if t < self.next_probe:
                time.sleep(min(self.next_probe - t, left))
                continue
            # Also pace retries when TCP connects but the SSH handshake still fails.
            self.next_probe = t + PROBE_EVERY_S
            ok, reason = reachable(error.box, min(5, left))
            if ok:
                log(f'ssh_unreachable box={error.box} reason={error.reason} waited={int(time.monotonic()-self.start)}s outcome=retried')
                say(f'SSH to {error.box} is reachable again; retrying preparation on the same box')
                return True
            error.reason = reason
