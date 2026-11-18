#!/usr/bin/env python3
"""Keep the configured person box and its loopback tunnels reachable. Never allocate."""
from __future__ import annotations

from contextlib import contextmanager, redirect_stderr, redirect_stdout
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request


TUNNELS = ('runner', 'callback', 'router', 'livez')
LEASE_TIMEOUT_SECONDS = 12


def livez_reason(value):
    return value if isinstance(value, str) and value in ('no_worker', 'not_ready', 'heartbeat_stale', 'shutting_down') else 'unknown'


def log_event(event, **fields):
    timestamp = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    print(json.dumps({'timestamp': timestamp, 'event': event, **fields}), flush=True)


@contextmanager
def quiet_offbox(stderr_fd=None):
    # The shared SSH builder inherits file descriptors; redirect those too, without changing its arguments.
    sys.stdout.flush()
    sys.stderr.flush()
    with open(os.devnull, 'w') as sink:
        saved = [(fd, os.dup(fd)) for fd in (1, 2)]
        try:
            for fd, _ in saved:
                os.dup2(stderr_fd if fd == 2 and stderr_fd is not None else sink.fileno(), fd)
            with redirect_stdout(sink), redirect_stderr(sink):
                yield
        finally:
            for fd, original in saved:
                os.dup2(original, fd)
                os.close(original)


class ReadinessError(RuntimeError):
    def __init__(self, target, status, exception_class='HTTPError', phase=None):
        super().__init__('runner_readiness_failed')
        self.target, self.status, self.exception_class = target, status, exception_class
        self.phase = phase or ('runner-paused' if target == 'runner' else target + '-http')


def error_fields(error):
    if isinstance(error, ReadinessError):
        return {'status': error.status, 'exception_class': error.exception_class, 'phase': error.phase}
    return {'status': error.code if isinstance(error, urllib.error.HTTPError) else None,
            'exception_class': type(error).__name__ if error is not None else None}


class TunnelStderr:
    def __init__(self, fd):
        self.tail = b''
        self.lock = threading.Lock()
        def drain():
            with os.fdopen(fd, 'rb', buffering=0) as stream:
                while chunk := stream.read(4096):
                    with self.lock:
                        self.tail = (self.tail + chunk)[-2048:]
        self.thread = threading.Thread(target=drain, daemon=True)
        self.thread.start()

    def fields(self):
        self.thread.join(timeout=1)
        with self.lock:
            tail = self.tail.lower()
        # SSH can echo remote paths, addresses or credentials. Only fixed diagnostic phrases leave memory.
        vocabulary = {b'connection refused': 'connection-refused', b'connection timed out': 'connection-timeout',
                      b'connection reset': 'connection-reset', b'broken pipe': 'broken-pipe',
                      b'remote port forwarding failed': 'remote-forward-failed', b'address already in use': 'address-in-use',
                      b'permission denied': 'permission-denied', b'host key verification failed': 'host-key-failed'}
        return {'stderr_bytes': len(tail), 'stderr_tail': [code for phrase, code in vocabulary.items() if phrase in tail]}


def capture_tunnel(operation):
    read_fd, write_fd = os.pipe()
    diagnostic = TunnelStderr(read_fd)
    try:
        with quiet_offbox(stderr_fd=write_fd):
            child = operation()
        child.moni_stderr = diagnostic
        return child
    finally:
        os.close(write_fd)


def router_ports(config):
    ports = (config.get('boxRouterPort', 19465), config.get('macRouterPort', 20128),
             config.get('boxLivezPort', 19466), config.get('macLivezPort', 20129))
    if any(type(port) is not int or not 1024 <= port <= 65535 for port in ports):
        raise RuntimeError('invalid_router_port')
    if ports[0] == ports[2]:
        raise RuntimeError('invalid_router_port')
    return ports[:2]


def livez_ports(config):
    router_ports(config)
    return config.get('boxLivezPort', 19466), config.get('macLivezPort', 20129)


class Supervisor:
    def __init__(self, config, deps, clock=time.monotonic, sleep=time.sleep, failure_limit=3):
        if type(failure_limit) is not int or failure_limit < 1:
            raise ValueError('invalid_readiness_failure_limit')
        self.config, self.deps = config, deps
        self.clock, self.sleep = clock, sleep
        self.failure_limit, self.failures = failure_limit, 0
        self._children = {}
        self.next_lease_refresh, self.lease_failures = 0, 0

    @property
    def children(self):
        return [self._children[name] for name in TUNNELS if name in self._children]

    def log(self, event, check, target, started, error=None, torn_down=(), failures=None, latency_ms=None, **fields):
        log_event(event, check=check, probe='POST /lease' if check == 'runner-lease' else check,
                  target=target, **error_fields(error),
                  latency_ms=round((self.clock() - started) * 1000) if latency_ms is None else latency_ms,
                  consecutive_failures=self.failures if failures is None else failures,
                  torn_down=list(torn_down), **fields)

    def stop_tunnels(self, names=TUNNELS):
        stopped = []
        for name in names:
            child = self._children.pop(name, None)
            if child is None:
                continue
            if child.poll() is None:
                try:
                    child.terminate()
                    stopped.append(name)
                except ProcessLookupError:
                    pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            diagnostic = getattr(child, 'moni_stderr', None)
            self.log('moni-supervisor-ssh-exit', 'ssh-child', name, self.clock(),
                     exit_code=child.poll(), **(diagnostic.fields() if diagnostic else {}))
        return stopped

    def deactivate(self):
        started = self.clock()
        try:
            self.deps.pause()
        finally:
            stopped = self.stop_tunnels()
            self.failures = 0
            self.log('moni-supervisor-inactive', 'backend-active', 'configured-backend', started,
                     torn_down=stopped)

    def start_missing_tunnels(self):
        box, created = self.config['boxId'], []
        for name in TUNNELS:
            if name in self._children:
                continue
            started = self.clock()
            try:
                self._children[name] = (self.deps.router_tunnel(box) if name == 'router'
                                        else self.deps.livez_tunnel(box) if name == 'livez'
                                        else self.deps.tunnel(box, name == 'callback'))
                created.append(name)
            except BaseException as error:
                stopped = self.stop_tunnels(created)
                self.log('moni-supervisor-error', 'ssh-start', name, started, error, stopped)
                raise

    def remove_dead_tunnels(self):
        dead = False
        for name, child in list(self._children.items()):
            code = child.poll()
            if code is not None:
                dead = True
                del self._children[name]
                self.log('moni-supervisor-reconnect', 'ssh-child', name, self.clock(),
                         ChildProcessError(), exit_code=code,
                         **(child.moni_stderr.fields() if hasattr(child, 'moni_stderr') else {}))
        return dead

    def connect(self):
        if not self.deps.active():
            self.deactivate()
            return False
        self.remove_dead_tunnels()
        if not self._children:
            box = self.config['boxId']
            for check, operation in (('box-ensure', self.deps.ensure), ('ssh-setup', self.deps.setup),
                                     ('runner-service', self.deps.runner_ready)):
                started = self.clock()
                try:
                    operation(box)
                except BaseException as error:
                    self.log('moni-supervisor-error', check, 'bound-person-box', started, error)
                    raise
        self.start_missing_tunnels()
        if self.remove_dead_tunnels():
            return False
        started = self.clock()
        try:
            self.deps.both_ready()
        except Exception as error:
            self.failures += 1
            latency_ms = round((self.clock() - started) * 1000)
            target = error.target if isinstance(error, ReadinessError) else 'runner'
            self.log('moni-supervisor-readiness-error', 'runner-lease', target, started, error, latency_ms=latency_ms)
            if not self.deps.active():
                self.deactivate()
            elif self.failures % self.failure_limit == 0:
                phase = (error.phase if isinstance(error, ReadinessError)
                         else 'ssh-transport' if isinstance(error, ConnectionRefusedError) else 'runner-http')
                repair = phase == 'ssh-transport'
                repair_target = target
                if target in ('router', 'callback') and phase != 'ssh-transport':
                    # Compare the Mac endpoint before blaming its healthy SSH process.
                    direct_started = self.clock()
                    direct_ready = self.deps.direct_ready(target)
                    self.log('moni-supervisor-direct-probe', 'direct-http', target, direct_started,
                             ready=direct_ready)
                    repair = direct_ready
                    if target == 'router':
                        # Model unreadiness is not evidence of a broken forward. Only a refused box TCP port is.
                        repair_target = 'livez'
                        repair = direct_ready and self.deps.livez_refused()
                    if not direct_ready:
                        self.log('moni-supervisor-router-slow' if target == 'router' else 'moni-supervisor-callback-unready',
                                 'direct-http', target, started, error, latency_ms=latency_ms,
                                 **({'reason': livez_reason(getattr(self.deps, 'direct_router_reason', None))} if target == 'router' else {}))
                if repair:
                    stopped = self.stop_tunnels((repair_target,))
                    self.log('moni-supervisor-reconnect', 'runner-lease', repair_target, started, error, stopped,
                             latency_ms=latency_ms)
                    self.start_missing_tunnels()
            return False
        if not self.deps.active():
            self.deactivate()
            return False
        if self.remove_dead_tunnels():
            return False
        self.failures = 0
        return True

    def refresh_lease(self):
        if self.clock() < self.next_lease_refresh:
            return
        started = self.clock()
        try:
            self.deps.refresh_lease()
        except Exception as error:
            self.lease_failures += 1
            self.next_lease_refresh = self.clock() + 60
            self.log('moni-supervisor-maintenance-error', 'offbox-lease', 'bound-person-box', started,
                     error, failures=self.lease_failures)
        else:
            self.lease_failures = 0
            self.next_lease_refresh = self.clock() + 300

    def tick(self):
        ready = self.connect()
        if self._children and self.deps.active():
            self.refresh_lease()
        return ready

    def run(self):
        backoff = 1
        try:
            while True:
                started = self.clock()
                try:
                    self.tick()
                    backoff = 1
                    self.sleep(5)
                except Exception as error:
                    self.log('moni-supervisor-error', 'supervisor-cycle', 'bound-person-box', started, error)
                    self.sleep(backoff)
                    backoff = min(backoff * 2, 60)
        finally:
            started = self.clock()
            stopped = self.stop_tunnels()
            self.log('moni-supervisor-stopped', 'shutdown', 'supervisor', started, torn_down=stopped)


class OffboxDeps:
    def __init__(self, config, bridge_config, scripts):
        self.config, self.bridge_config = config, Path(bridge_config)
        router_ports(config)
        # Resolve the same person identity as offbox-person. No pool selection, sync or fallback.
        os.environ['OFFBOX_THREAD'] = 'person:moni'
        os.environ['OFFBOX_BACKEND'] = 'server'
        os.chdir(Path.home() / '.local/share/offbox-person/moni')
        sys.path.insert(0, str(Path(scripts).resolve()))
        with quiet_offbox():
            from offbox_lib import allocation, api, common, home, lease, ssh_sync
        self.api, self.common, self.home, self.lease, self.ssh_sync = api, common, home, lease, ssh_sync
        self.allocation = allocation
        if api.BACKEND != 'server' or common.token_owner() != 'moni':
            raise RuntimeError('person_backend_required')

    def active(self):
        try:
            entry = json.loads(self.bridge_config.read_text())['chatBackends']['moni']
            return entry['kind'] == 'remote-box' and entry['boxId'] == self.config['boxId'] and entry['epoch'] == self.config['epoch']
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def ensure(self, box):
        with quiet_offbox():
            self.ensure_box(box)

    def ensure_box(self, box):
        if not box.startswith('bx_'):
            raise RuntimeError('invalid_box')
        self.home.person_gate()
        with self.common.db() as con:
            if self.common.box_owner(con, box) != 'moni':
                raise RuntimeError('box_owner_mismatch')
            self.common.require_mine(con, box)
            state = self.api.get(box)
            if not state or state.get('owner') != 'moni':
                raise RuntimeError('box_missing_or_wrong_owner')
            pending = con.execute('SELECT 1 FROM kv WHERE k=?', (f'resume_unanswered:{box}',)).fetchone()
            if pending:
                self.lease._resume_confirmed(con, box, 1800, None, pending=True)
                state = self.api.wait_state(box, self.api.LIVE_STATES, timeout=60)
            elif state['state'] in self.api.STOPPED_STATES:
                # Existing offbox confirmation reconciles a lost resume response on this exact id.
                self.lease._resume_confirmed(con, box, 1800, None)
                state = self.api.wait_state(box, self.api.LIVE_STATES, timeout=60)
            elif state['state'] in self.api.STARTING_STATES:
                # An acknowledged resume can still be booting; another POST starts another worker.
                state = self.api.wait_state(box, self.api.LIVE_STATES, timeout=60)
            if not state or state.get('owner') != 'moni' or state['state'] not in self.api.LIVE_STATES:
                raise RuntimeError('box_not_ready')
            self.allocation.clear_resume(con, box)

    def setup(self, box):
        with quiet_offbox():
            self.ssh_sync.setup(box)

    def runner_ready(self, box):
        command = ('systemctl --user start moni-box-runner && '
                   'test -f ~/person/agent/config.json && '
                   'systemctl --user is-active --quiet moni-box-runner')
        with quiet_offbox():
            subprocess.run(self.ssh_sync.ssh_base(box) + [box, command], check=True, timeout=30,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def tunnel(self, box, reverse):
        remote = self.config['boxCallbackPort'] if reverse else self.config['boxRunnerPort']
        local = self.config['callbackPort'] if reverse else int(self.config['url'].rsplit(':', 1)[1])
        return capture_tunnel(lambda: self.ssh_sync.tunnel(box, remote, local, reverse))

    def router_tunnel(self, box):
        box_port, mac_port = router_ports(self.config)
        # SSH runs on the Mac; -R binds only the box loopback and targets only this Mac loopback port.
        return capture_tunnel(lambda: self.ssh_sync.tunnel(box, box_port, mac_port, True))

    def livez_tunnel(self, box):
        box_port, mac_port = livez_ports(self.config)
        return capture_tunnel(lambda: self.ssh_sync.tunnel(box, box_port, mac_port, True))

    def livez_refused(self):
        port, _ = livez_ports(self.config)
        # A failed SSH command or a TCP timeout is inconclusive, not permission to tear down a healthy child.
        probe = ('import errno,socket,sys; s=socket.socket(); s.settimeout(1.5); '
                 f'code=s.connect_ex(("127.0.0.1",{port})); s.close(); sys.exit(42 if code==errno.ECONNREFUSED else 0)')
        try:
            with quiet_offbox():
                result = subprocess.run(self.ssh_sync.ssh_base(self.config['boxId']) +
                                        [self.config['boxId'], 'python3 -c ' + shlex.quote(probe)],
                                        timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return result.returncode == 42
        except (OSError, subprocess.TimeoutExpired):
            return False

    def post(self, base, token_file, path, body):
        token = Path(token_file).read_text().strip()
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=LEASE_TIMEOUT_SECONDS if path == '/lease' else 5) as response:
            return json.load(response)

    def refresh_lease(self):
        with quiet_offbox():
            self.lease.touch(self.config['boxId'])
            if not self.lease.ensure_ttl(self.config['boxId'], 1800):
                raise RuntimeError('offbox_lease_refresh_failed')

    def both_ready(self):
        # Readiness is reported separately; a valid call renews authority even while dependencies are slow.
        try:
            result = self.post(self.config['url'], self.config['tokenFile'], '/lease',
                               {'epoch': self.config['epoch'], 'boxId': self.config['boxId']})
        except urllib.error.HTTPError as error:
            target = 'runner'
            try:
                if error.code == 503:
                    body = json.loads(error.read(4096))
                    if isinstance(body, dict) and isinstance(body.get('error'), str):
                        target = {'Router unavailable': 'router', 'Callback unavailable': 'callback'}.get(body['error'], 'runner')
            except (ValueError, OSError):
                pass
            finally:
                error.close()
            raise ReadinessError(target, error.code) from None
        except urllib.error.URLError as error:
            refused = isinstance(error.reason, ConnectionRefusedError)
            raise ReadinessError('runner', None, type(error.reason).__name__, 'ssh-transport' if refused else 'runner-http') from None
        except TimeoutError:
            raise ReadinessError('runner', None, 'TimeoutError', 'runner-http') from None
        if result.get('boxId') != self.config['boxId'] or result.get('epoch') != self.config['epoch']:
            raise ReadinessError('runner', 200, 'ReadinessError')
        for target in ('router', 'callback'):
            if result.get(target + 'Ready') is False:
                raise ReadinessError(target, 200, 'DependencyUnavailable')

    def direct_ready(self, target):
        if target == 'router':
            self.direct_router_reason = 'unknown'
        try:
            if target == 'router':
                _, port = livez_ports(self.config)
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/livez', timeout=1.5) as response:
                    body = json.loads(response.read(4096))
                    return response.status == 200 and isinstance(body, dict) and body.get('ready') is True
            if target == 'callback':
                result = self.post(f"http://127.0.0.1:{self.config['callbackPort']}", self.config['callbackTokenFile'],
                                   '/ready', {'epoch': self.config['epoch']})
                return result.get('epoch') == self.config['epoch']
        except urllib.error.HTTPError as error:
            try:
                if target == 'router' and error.code == 503:
                    body = json.loads(error.read(4096))
                    self.direct_router_reason = livez_reason(body.get('reason') if isinstance(body, dict) else None)
            except (OSError, ValueError):
                pass
            finally:
                error.close()
            return False
        except (OSError, ValueError, urllib.error.URLError):
            return False
        return False

    def pause(self):
        try:
            self.post(self.config['url'], self.config['tokenFile'], '/pause', {})
        except Exception:
            pass  # A box without a bridge lease pauses itself after 20 seconds.


def main():
    import argparse
    class Parser(argparse.ArgumentParser):
        def error(self, message):
            raise ValueError('invalid_arguments')
    parser = Parser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--bridge-config')
    parser.add_argument('--offbox-scripts', required=True)
    parser.add_argument('--ensure-only', action='store_true')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    config = config.get('chatBackends', {}).get('moni', config)
    deps = OffboxDeps(config, args.bridge_config or args.config, args.offbox_scripts)
    if args.ensure_only:
        deps.ensure(config['boxId'])
        deps.setup(config['boxId'])
        return
    supervisor = Supervisor(config, deps)
    supervisor.run()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (Exception, SystemExit) as error:
        if isinstance(error, SystemExit) and error.code in (None, 0):
            raise
        log_event('moni-supervisor-fatal', check='startup', probe='startup', target='supervisor',
                  **error_fields(error), latency_ms=0, consecutive_failures=0, torn_down=[])
        raise SystemExit(1) from None
