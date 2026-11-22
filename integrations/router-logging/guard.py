"""Independent launchd/listener recovery; never needs a response from 9router."""
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

from host import Sampler
from toollog import directory, emit
from observer import Timings, clock_sample, gap, job_snapshot, launchctl_cause, launchctl_print, measured, phase

LABEL = 'com.abdullah.9router-fork'
FRESH_MS = 300000


def iso(milliseconds):
    return dt.datetime.fromtimestamp(milliseconds / 1000, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def fresh(marker, now):
    started = marker.get('startedAtMs') if isinstance(marker, dict) else None
    return (marker.get('status') == 'running' and type(started) in (int, float)
            and 0 <= now - started < FRESH_MS) if isinstance(marker, dict) else False


def recent_failure(marker, now):
    if not isinstance(marker, dict) or marker.get('status') != 'failed':
        return False
    started = marker.get('startedAtMs')
    finished = marker.get('finishedAtMs', started)
    # The transaction covers its start through five minutes after completion.
    return (all(type(value) in (int, float) and math.isfinite(value) for value in (started, finished))
            and started <= finished and started <= now < finished + FRESH_MS)


class Guard:
    def __init__(self, state=None, event=None, action=None, notify=None, save=None):
        self.state = state or {}
        self.event = event or (lambda name, **props: emit('guard', name, props=props))
        self.action = action or (lambda action: False)
        self.notify = notify or (lambda text, key: False)
        self.save = save or (lambda state: None)

    def step(self, now, job, listener, marker=None, lock_age_ms=None, observation=None, host=None):
        state = self.state
        host = host if host is not None else Sampler()()
        # Retry an undelivered recovery with the same bridge deduplication key.
        recovery = state.get('recovery')
        if recovery and self.notify(recovery['text'], recovery['key']):
            del state['recovery']
        failed = listener in ('refused', 'unreachable')
        if job == 'unknown':
            if not state.get('jobUnknown') or (not failed and 'unknownSinceMs' not in state):
                props = dict(state=job, listener=listener, host=host, hostStart=host)
                props.update(observation or {})
                if not failed:
                    state['unknownSinceMs'] = now
                    state['unknownHost'] = host
                    state['unknownCause'] = launchctl_cause(observation or {})
                    props['unknownSince'] = iso(now)
                self.event('listener.state_unknown', **props)
            state['jobUnknown'] = True
        else:
            state.pop('jobUnknown', None)
        if (job != 'unknown' or failed) and 'unknownSinceMs' in state:
            since = state.pop('unknownSinceMs')
            self.event('listener.state_resolved', unknownSince=iso(since), unknownMs=max(0, now - since),
                       state=job, listener=listener, cause=state.pop('unknownCause', 'other'),
                       host=host, hostStart=state.pop('unknownHost', {}), hostEnd=host)
        # A persisted window from the old guard may have no TCP evidence.
        # Close that uncertainty before starting a newly observed refusal.
        if (failed and 'downSinceMs' in state and 'downListener' not in state
                and state.get('cause') not in ('listener_refused', 'listener_unreachable')):
            since = state['downSinceMs']
            self.event('listener.up', downSince=iso(since), downMs=max(0, now - since),
                       cause=state['cause'], listener=listener, downListener='unknown', action=state.get('lastAction', 'none'),
                       host=host, hostStart=state.get('downHost', {}), hostEnd=host)
            for key in ('downSinceMs', 'downHost', 'cause', 'alerted', 'refusedSinceMs', 'nextActionMs', 'attempts', 'lastAction'):
                state.pop(key, None)
        if not failed:
            if 'downSinceMs' in state:
                since = state['downSinceMs']
                elapsed = max(0, now - since)
                self.event('listener.up', downSince=iso(since), downMs=elapsed,
                           cause=state['cause'], listener=listener, downListener=state.get('downListener', 'unknown'),
                           action=state.get('lastAction', 'none'), host=host, hostStart=state.get('downHost', {}), hostEnd=host)
                if state.get('alerted'):
                    state['recovery'] = dict(text=f'9router recovered after {round(elapsed / 1000)} s; action {state.get("lastAction", "none")}',
                                             key=f'9router-down:{iso(since)}:recovered')
                for key in ('downSinceMs', 'downHost', 'downListener', 'cause', 'alerted', 'refusedSinceMs', 'nextActionMs', 'attempts', 'lastAction'):
                    state.pop(key, None)
                self.save(state)
                if state.get('recovery') and self.notify(state['recovery']['text'], state['recovery']['key']):
                    del state['recovery']
            self.save(state)
            return
        if 'downSinceMs' not in state:
            cause = 'listener_' + listener
            if recent_failure(marker, now):
                cause = 'deploy_failed'
            state.update(downHost=host, downSinceMs=now, downListener=listener, cause=cause, alerted=False, attempts=0, nextActionMs=now)
            self.save(state)
            self.event('listener.down', downSince=iso(now), cause=cause, state=job, listener=listener, host=host, hostStart=host)
        if listener == 'refused':
            state.setdefault('refusedSinceMs', now)
        else:
            state.pop('refusedSinceMs', None)
        expired_lock = lock_age_ms is not None and lock_age_ms >= FRESH_MS
        if (expired_lock or not fresh(marker, now)) and now >= state.get('nextActionMs', 0):
            action = ('bootstrap' if job == 'absent' and listener == 'refused' else
                      'kickstart' if job == 'loaded' and now - state.get('refusedSinceMs', now) >= 60000 else None)
            if action:
                # A competing deploy may acquire its lock after the observation.
                # None means deferred; do not consume its retry budget.
                result = self.action(action)
                if result is not None:
                    state['lastAction'] = action
                    state['attempts'] += 1
                    state['nextActionMs'] = now + min(300000, 15000 * 2 ** min(state['attempts'] - 1, 5))
                    self.event('guard.action', action=action, state='succeeded' if result else 'failed', attempt=state['attempts'])
        if now - state['downSinceMs'] >= 120000 and not state.get('alerted'):
            text = f'9router down since {iso(state["downSinceMs"])}; cause {state["cause"]}; action {state.get("lastAction", "none")}'
            if self.notify(text, f'9router-down:{iso(state["downSinceMs"])}'):
                state['alerted'] = True
        self.save(state)


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


@measured('state_save')
def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.guard-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Runtime:
    def __init__(self, clock=None):
        self.clock = clock or (lambda: time.time() * 1000)
        self.domain = f'gui/{os.getuid()}'
        self.job = f'{self.domain}/{LABEL}'
        self.plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
        self.marker = Path(os.environ.get('ROUTER_DEPLOY_MARKER', Path.home() / '.local/state/9router/deploy.json'))
        self.state_file = Path.home() / '.local/state/9router/guard.json'

    def command(self, args):
        try:
            return subprocess.run(['launchctl', *args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, timeout=5).returncode
        except (OSError, subprocess.TimeoutExpired):
            return -1

    def observe(self):
        with phase('launchctl'):
            self.observation = launchctl_print(self.job)
        code = self.observation['launchctlExit']
        job = 'loaded' if code == 0 else 'absent' if code == 113 else 'unknown'
        return job, self.probe()

    @measured('tcp')
    def probe(self):
        try:
            with socket.create_connection(('127.0.0.1', 20128), timeout=.5):
                listener = 'open'
        except ConnectionRefusedError:
            listener = 'refused'
        except OSError:
            listener = 'unreachable'
        return listener

    def notify(self, text, key):
        env = dict(os.environ)
        env.pop('BUN_INSPECT', None)
        try:
            result = subprocess.run([str(Path.home() / '.bun/bin/bun'), str(Path.home() / '.local/share/telegram-bridge/src/cli.ts'),
                                     'notify', '--source', '9router guard', '--severity', 'attention', '--text', text, '--key', key],
                                    env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
            ok = result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            ok = False
        emit('guard', 'guard.alert', ok=ok, props=dict(state='sent' if ok else 'failed'))
        return ok

    def lock_age_ms(self):
        lock = Path(str(self.marker) + '.lock')
        # owner.json is written at acquisition; marker updates touch the directory.
        for path in (lock / 'owner.json', lock):
            try:
                return max(0, self.clock() - path.stat().st_mtime * 1000)
            except FileNotFoundError:
                pass
        return None

    @contextlib.contextmanager
    def coordinate(self):
        self.marker.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with Path(str(self.marker) + '.coord').open('a') as gate:
            os.chmod(gate.name, 0o600)
            with phase('lock_wait'):
                fcntl.flock(gate, fcntl.LOCK_EX)
            yield

    def claim(self, lock, repair):
        overridden = False
        if lock.exists():
            observed = lock.stat()
            age = self.lock_age_ms()
            owner = read_json(lock / 'owner.json')
            dead = False
            if type(owner.get('pid')) is int and owner['pid'] > 0:
                try:
                    os.kill(owner['pid'], 0)
                except ProcessLookupError:
                    dead = True
                except (OSError, OverflowError):
                    pass
            overridden = repair and age is not None and age >= FRESH_MS
            if overridden or (dead and not fresh(read_json(self.marker), self.clock())):
                retired = lock.with_name(lock.name + '.retired-' + uuid.uuid4().hex)
                try:
                    lock.rename(retired)
                except FileNotFoundError:
                    return None, False
                else:
                    moved = retired.stat()
                    if (moved.st_dev, moved.st_ino) != (observed.st_dev, observed.st_ino) or read_json(retired / 'owner.json') != owner:
                        # Older installers may not participate in the coordinator.
                        # Preserve a replacement acquisition and defer this tick.
                        try:
                            retired.rename(lock)
                        except OSError:
                            pass
                        return None, False
                    if overridden:
                        pid = owner.get('pid')
                        emit('guard', 'guard.lock_override', props=dict(
                            ownerPid=pid if type(pid) is int and pid > 0 else 'unknown', lockAgeMs=round(age)))
                    for name in ('owner.json', 'marker.json'):
                        (retired / name).unlink(missing_ok=True)
                    with contextlib.suppress(OSError):
                        retired.rmdir()
        try:
            lock.mkdir(mode=0o700)
        except FileExistsError:
            return None, False
        owner = dict(pid=os.getpid(), script='9router-guard', acquisitionId=uuid.uuid4().hex)
        write_json(lock / 'owner.json', owner)
        return owner, overridden

    @contextlib.contextmanager
    def slot(self, repair=False):
        lock = Path(str(self.marker) + '.lock')
        with self.coordinate():
            owner, overridden = self.claim(lock, repair)
        if owner is None:
            yield False
            return
        try:
            marker = read_json(self.marker)
            ours = marker.get('pid') == os.getpid() and marker.get('script') == '9router-guard'
            yield overridden or ours or not fresh(marker, self.clock())
        finally:
            with self.coordinate():
                if read_json(lock / 'owner.json') == owner:
                    (lock / 'owner.json').unlink()
                    lock.rmdir()

    def act(self, action):
        with self.slot(repair=True) as allowed:
            if not allowed:
                return None
            job, listener = self.observe()
            if listener != 'refused' or job != ('absent' if action == 'bootstrap' else 'loaded'):
                return None
            now = self.clock()
            marker = dict(startedAtMs=now, pid=os.getpid(), script='9router-guard', status='running',
                          releaseDir=str(Path.home() / 'tmp/9router/.releases/current'),
                          stopReason='listener_recovery', action=action)
            write_json(self.marker, marker)
            emit('supervisor', 'deploy.' + ('reload' if action == 'kickstart' else 'bootstrap'),
                 props=dict(**marker, ppid=os.getppid(), initiator='9router-guard'))
            args = ['bootstrap', self.domain, str(self.plist)] if action == 'bootstrap' else ['kickstart', '-k', self.job]
            code = self.command(args)
            if code != 0:
                write_json(self.marker, dict(marker, status='failed', finishedAtMs=self.clock(), lastErrorCode=code))
            emit('supervisor', 'deploy.result', ok=code == 0,
                 props=dict(initiator='9router-guard', action=action, exitCode=code, outcome='command_completed' if code == 0 else 'failed'))
            return code == 0

    def settle(self, job, listener):
        # Use the deploy lock even for cleanup; a new installer can otherwise
        # replace the marker between reading our PID and unlinking the file.
        with self.slot() as allowed:
            if not allowed:
                return
            marker = read_json(self.marker)
            if marker.get('pid') != os.getpid() or marker.get('script') != '9router-guard':
                return
            if job == 'loaded' and listener == 'open':
                self.marker.unlink(missing_ok=True)
            elif marker.get('status') == 'running':
                write_json(self.marker, dict(marker, status='failed', finishedAtMs=self.clock(), lastErrorCode=-1))


def serve():
    runtime = Runtime()
    runtime.state_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with runtime.state_file.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        os.chmod(lock.name, 0o600)
        guard = Guard(state=read_json(runtime.state_file), action=runtime.act, notify=runtime.notify,
                      save=lambda state: write_json(runtime.state_file, state))
        stopping = False
        def stop(*_):
            nonlocal stopping
            stopping = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        poll = None
        pool_alerts = None
        next_poll = 0
        try:
            while not stopping:
                start = time.monotonic()
                sampler = Sampler()
                sample = dict(clock_sample(), **job_snapshot(), host=sampler())
                missing = gap(guard.state.get('observerTick'), sample)
                if missing:
                    emit('guard', 'observer.gap', kind='perf', props=missing)
                with Timings('guard', 'guard.tick_late', threshold_ms=120000, start=sample, sampler=sampler) as timing:
                    try:
                        job, listener = runtime.observe()
                        runtime.settle(job, listener)
                        guard.step(time.time() * 1000, job, listener, read_json(runtime.marker), runtime.lock_age_ms(), runtime.observation, sample['host'])
                    except Exception:
                        emit('guard', 'guard.error', kind='error', error=dict(tag='tick_failed'))
                    guard.state['observerTick'] = sample
                    with contextlib.suppress(OSError):
                        guard.save(guard.state)
                guard.state['observerTick'] = timing.end
                if pool_alerts is None or pool_alerts.poll() is not None:
                    # Delivery can block on several historical bridge retries.
                    # Its own process keeps listener repair on the 15 s cadence.
                    pool_alerts = subprocess.Popen([sys.executable, '-I', str(Path(__file__).with_name('run.py')), 'pool-alerts'],
                                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if poll is not None and poll.poll() is not None:
                    poll = None
                if start >= next_poll and poll is None:
                    # HTTP snapshots and rollups can take longer than the listener cadence.
                    poll = subprocess.Popen([sys.executable, '-I', str(Path(__file__).with_name('run.py')), 'poll'],
                                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    next_poll = start + 300
                while not stopping and time.monotonic() - start < 15:
                    time.sleep(max(0, min(.5, 15 - (time.monotonic() - start))))
        finally:
            guard.state['observerTick'] = dict(clock_sample(), host=guard.state.get('observerTick', {}).get('host', {}), jobState='stopped', jobPid=os.getpid(), jobExit=0)
            with contextlib.suppress(OSError):
                guard.save(guard.state)
            for child in (pool_alerts, poll):
                if child is None or child.poll() is not None:
                    continue
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
