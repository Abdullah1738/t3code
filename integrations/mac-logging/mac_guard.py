#!/usr/bin/python3
"""Thirty-second resource backstop. All destructive decisions require birth identity."""
import argparse
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import errno as errno_codes
import fcntl
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# Helper subprocesses use -I; load only the reviewed siblings beside this file.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from cpu import PS, ProbeError, command, failure_details, deltas, parse_ps, seconds, cpu_ticks, runnable_threads, spike
from cpu_labels import command_label
from memory import STATS, parse_top, parse_swap, ProbeError as MemoryError
from toollog import emit

# Signal-5 carve-out never overrides these exemptions, regardless of owner state.
MEMORY_EXEMPT = {
    'providers': ('claude', 'codex', 'opencode', 'gemini', 'cursor-agent', 'grok', 'antigravity'),
    'system_names': ('launchd', 'WindowServer', 'kernel_task', 'tailscaled', 'sshd'),
    'system_paths': ('/System/', '/usr/libexec/', '/usr/sbin/', '/sbin/'),
    'app_path': '/Applications/Robob.app/',
    'service_labels': ('com.ardud.opencode-service',),
}
# Owner #142 q2: these bundle identities never qualify for the slow GUI rule.
GUI_NEVER_QUIT = {
    'company.thebrowser.dia', 'com.apple.MobileSMS', 'com.ardud.robob',
    'com.apple.finder', 'com.apple.Terminal', 'com.googlecode.iterm2',
    'com.mitchellh.ghostty', 'dev.warp.Warp-Stable', 'dev.warp.Warp',
    'dev.warp.Warp-Preview',
}
SLOW_LEAK_GIB = 8
SLOW_LEAK_GIB_HOUR = 1
SLOW_LEAK_SECONDS = 1800
OVERLOAD_SCRIPT = Path.home() / '.local/share/robob-overload-restart/robob-overload-restart.py'
OVERLOAD_STATE = Path(os.environ.get('ROBOB_OVERLOAD_STATE', str(Path.home()/'.local/state/robob-overload-restart')))
WORKER = ('codex', 'gpt-6.1-sol')
WORKER_HTTP_TIMEOUT = 45
WORKER_HELPER_TIMEOUT = 50
STRAIN_WORKER_INTERVAL = 600
LOAD_ONLY_WORKER_DELAY = 600
WORKER_SKIP_LOG_INTERVAL = 60
STATE = Path.home() / '.local/state/mac-guard'
EVIDENCE = Path.home() / '.robob/board-artifacts/mac-guard'
T3CTL = str(Path.home() / '.local/bin/t3ctl')
TMUX = '/opt/homebrew/bin/tmux'
JOBS = re.compile(r'^(?:xcodebuild|SWBBuildService|XCBBuildService|clang(?:\+\+)?|swift-frontend|agent-browser-darwin-arm64|test[\w-]*|vitest|jest|pytest|Simulator|qemu[\w-]*|Docker|docker|colima)$')
BUILD = re.compile(r'^(?:xcodebuild|SWBBuildService|XCBBuildService|clang(?:\+\+)?|swift-frontend)$')


def script_job(p):
    if Path(p['comm']).name not in ('node', 'bun', 'python', 'python3', 'bash', 'zsh', 'sh'):
        return False
    return bool(re.search(r'(?:^|[/\s])(?:build|test|run-build|run-test)(?:[-_.][\w.-]+)?(?:\s|$)', p.get('args', '')))


def iso(now):
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def json_object(raw):
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('expected JSON object')
    return value


def worker_thread_id(request_id):
    return 'ardud-control:thread:'+request_id


class WorkerControlError(ProbeError):
    def __init__(self, failure, durationS=None, status=None):
        super().__init__(failure)
        self.failure, self.durationS, self.status = failure, durationS, status


def worker_failure(exc):
    if isinstance(exc, WorkerControlError):
        return exc.failure
    if isinstance(exc, (TimeoutError, socket.timeout, subprocess.TimeoutExpired)):
        return 'timeout'
    if isinstance(exc, urllib.error.URLError):
        return 'timeout' if isinstance(exc.reason, (TimeoutError, socket.timeout)) else 'unavailable'
    return 'bad_response' if isinstance(exc, (ValueError, KeyError, TypeError)) else 'unavailable'


def worker_control(request, opener=urllib.request.urlopen, metrics=None):
    # Match t3ctl's credential precedence. The parent bounds this helper's whole
    # lifetime, including HTTP response reads, and never logs credentials.
    url, token = os.environ.get('T3_CONTROL_URL'), os.environ.get('T3_CONTROL_TOKEN')
    named = os.environ.get('T3_CONTROL_TOKEN_FILE')
    paths = [Path(named)] if named else [Path.home()/'.robob/components/t3ctl.json', Path.home()/'.robob/ardud-control.json']
    for path in paths:
        if url and token:
            break
        try:
            if path.stat().st_mode & 0o077:
                raise ValueError('control credential permissions')
            config = json_object(path.read_text())
        except FileNotFoundError:
            if named:
                raise
            continue
        url, token = url or config.get('url'), token or config.get('token')
        break
    if not isinstance(url, str) or not isinstance(token, str) or not url or not token:
        raise ValueError('control unavailable')
    body = request.get('body')
    req = urllib.request.Request(url.rstrip('/')+'/api/ardud/control'+request['path'],
              data=json.dumps(body).encode() if body is not None else None, method=request['method'],
              headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    started = time.monotonic()
    try:
        with opener(req, timeout=WORKER_HTTP_TIMEOUT) as response:
            value = json_object(response.read(2_000_000).decode())
    except urllib.error.HTTPError as exc:
        try:
            value = json_object(exc.read(2_000_000).decode())
        except ValueError:
            value = {}
        if (request['method'] == 'GET' and exc.code == 404
                and isinstance(value.get('error'), dict) and value['error'].get('code') == 'not_found'):
            return dict(missing=True)
        raise WorkerControlError('http_status', status=exc.code) from None
    finally:
        if metrics is not None:
            metrics['durationS'] = time.monotonic()-started
    if value.get('ok') is False:
        raise WorkerControlError('bad_response')
    return value


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix('.new')
    with tmp.open('w') as out:
        os.chmod(tmp, 0o600)
        json.dump(value, out, indent=1, allow_nan=False)
    tmp.replace(path)


def chain(p, rows):
    result, seen = [], {p['pid']}
    while p['ppid'] in rows and p['ppid'] not in seen:
        p = rows[p['ppid']]
        seen.add(p['pid'])
        result.append(p)
    return result


def provider(p):
    # Inspect executable/script words, never prompt text or incidental mentions.
    try:
        words = shlex.split(p.get('args', p['comm']))
    except ValueError:
        return True  # unreadable argv cannot authorize intervention
    name = Path(p['comm']).name.lower()
    names = MEMORY_EXEMPT['providers']
    if name in names or any(name.startswith(n+'-') for n in ('codex', 'claude', 'opencode')):
        return True
    if name not in ('node', 'bun', 'npx', 'bash', 'zsh', 'sh', 'python', 'python3'):
        return False
    if len(words) < 2:
        return True  # an unidentified interpreter is not a safe victim
    for word in words:
        if word in ('-c', '-e', '--eval', '--prompt', '-p'):
            # A shell wrapper may itself be a session launcher.
            return True
        if re.search(r'(?:^|[/@])(?:claude(?:-code)?|codex|opencode|gemini(?:-cli)?|cursor-agent|grok|antigravity)(?:$|[/.-])', word, re.I):
            return True
    return False


def system(p):
    return (Path(p['comm']).name in MEMORY_EXEMPT['system_names']
            or p['comm'].startswith(MEMORY_EXEMPT['system_paths']))


def robob(p, rows):
    if provider(p):
        return False
    if p['comm'].startswith(MEMORY_EXEMPT['app_path']):
        return True
    # App helpers and the node server belong to R; builds spawned below a
    # provider do not become part of the app's memory total.
    server_args = '--bootstrap-fd' in p.get('args', '').split()
    if server_args and Path(p['comm']).name in ('node', 'bun') and any(
            a['comm'].startswith(MEMORY_EXEMPT['app_path']) for a in chain(p, rows)):
        return not any(provider(a) for a in chain(p, rows) if not a['comm'].startswith(MEMORY_EXEMPT['app_path']))
    return False


def robob_ancestor(p, rows):
    # chain() is nearest-parent first; provider jobs do not inherit app protection.
    for ancestor in chain(p, rows):
        if provider(ancestor):
            return None
        if robob(ancestor, rows):
            return ancestor
    return None


def robob_descendant(p, rows):
    return robob_ancestor(p, rows) is not None


def label(p, rows):
    return next((q['label'] for q in [p]+chain(p, rows) if q.get('label')), None)


def exempt(p, rows, system_gui=False):
    if any(re.search(r'(?:^|[/\s])offbox(?:\.py)?(?:\s|$)', q.get('args', '')) for q in [p]+chain(p, rows)):
        return True
    if (label(p, rows) in MEMORY_EXEMPT['service_labels'] or p.get('sessionWrapper')
            or p['pid'] == os.getpid() or (system(p) and not system_gui) or provider(p) or robob(p, rows)):
        return True
    # Interpreter wrappers above a provider must never be killed as a tree root.
    return False


def protected(p, rows, *, renice=False):
    return (exempt(p, rows) or bool(label(p, rows)) or 'cua-driver' in p['comm']
            or not renice and robob_descendant(p, rows))


def gui(p):
    return '.app/' in p['comm'] and p['comm'].startswith('/') and not JOBS.fullmatch(Path(p['comm']).name)


def app_info(comm):
    executable = Path(comm)
    # Only a bundle's main executable can authorize quitting an application.
    # A helper, XPC service or system daemon never inherits this exception.
    bundle = executable.parent.parent.parent
    if bundle.suffix != '.app' or executable.parent != bundle/'Contents/MacOS':
        return None
    if any(parent.suffix == '.app' for parent in bundle.parents):
        return None
    with (bundle/'Contents/Info.plist').open('rb') as stream:
        info = plistlib.loads(stream.read(262144))
    bid = info.get('CFBundleIdentifier')
    if (info.get('CFBundleExecutable') != executable.name or info.get('CFBundlePackageType') != 'APPL'
            or info.get('LSUIElement') or info.get('LSBackgroundOnly')
            or not isinstance(bid, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]+', bid)):
        return None
    return dict(app=str(bundle), bundleId=bid)


def quit_gui(pid, api=None):
    """Send the normal Quit AppleEvent to a kernel PID, without launching an app."""
    import ctypes as c
    class Desc(c.Structure):
        _fields_ = [('type', c.c_uint32), ('data', c.c_void_p)]
    api = api or c.CDLL('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
    if isinstance(api, c.CDLL):
        api.AECreateDesc.argtypes = [c.c_uint32, c.c_void_p, c.c_long, c.POINTER(Desc)]
        api.AECreateAppleEvent.argtypes = [c.c_uint32, c.c_uint32, c.POINTER(Desc), c.c_int16, c.c_int32, c.POINTER(Desc)]
        api.AESendMessage.argtypes = [c.POINTER(Desc), c.POINTER(Desc), c.c_int32, c.c_int32]
        api.AEDisposeDesc.argtypes = [c.POINTER(Desc)]
    target, event, reply = Desc(), Desc(), Desc()
    def checked(code):
        if code:
            raise OSError(code, 'Quit AppleEvent failed')
    try:
        process = c.c_int32(pid)
        checked(api.AECreateDesc(int.from_bytes(b'kpid', 'big'), c.byref(process), c.sizeof(process), c.byref(target)))
        checked(api.AECreateAppleEvent(int.from_bytes(b'aevt', 'big'), int.from_bytes(b'quit', 'big'),
                                     c.byref(target), -1, 0, c.byref(event)))
        # No reply; allow interaction so unsaved-work prompts retain normal Quit semantics.
        checked(api.AESendMessage(c.byref(event), c.byref(reply), 0x01 | 0x20, 60))
    finally:
        for desc in (reply, event, target):
            if desc.type:
                api.AEDisposeDesc(c.byref(desc))


def qf_install_hold(run=subprocess.run, now=None):
    now = time.time() if now is None else now
    try:
        result = run([TMUX, '-L', 'qf-install', 'list-panes', '-a', '-F',
                      '#{session_name} #{pane_dead} #{pane_current_command} #{session_activity}'],
                     capture_output=True, text=True, timeout=5)
        # tmux reports an absent server as exit 1. Other failures cannot prove safety.
        if result.returncode == 1 and re.search(r'^(?:no server running on|error connecting to .* \(No such file or directory\))', result.stderr.strip()):
            return None
        if result.returncode:
            return 'qf-install probe exit %s' % result.returncode
        for line in result.stdout.splitlines():
            fields = line.split()
            if not fields:
                continue
            if not re.fullmatch(r'install\d*', fields[0]):
                continue
            if len(fields) != 4 or fields[1] not in ('0', '1'):
                return 'qf-install unreadable pane'
            name, dead, command, activity = fields
            if dead == '1':
                continue
            if not activity.isdigit():
                return 'qf-install unreadable activity'
            if Path(command).name.lstrip('-') not in ('sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh') or now-int(activity) <= 1800:
                return 'qf-install active '+name
        return None
    except (OSError, subprocess.SubprocessError):
        return 'qf-install probe failed'


def overload_checks(path=None):
    """Called in a deadline-bounded subprocess, so imports/helpers cannot stall the loop."""
    path = OVERLOAD_SCRIPT if path is None else Path(path)
    if not path.is_file() or not (path.parent/'launchd-entry.zsh').is_file():
        return dict(unavailable='installed watchdog missing')
    if (OVERLOAD_STATE/'disabled').exists():
        return dict(unavailable='disabled')
    detail = qf_install_hold()
    if detail:
        return dict(install=True, detail=detail)
    spec = importlib.util.spec_from_file_location('mac_guard_overload', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    pid, started = module.server_started()
    return dict(pid=pid, started=started, hold=module.hold_live(),
                restart=module.tmux_session('restart', 'robob-restart'),
                install=module.tmux_session('install', 'robob-install'), building=module.building())


class Host:
    def __init__(self, run=subprocess.run):
        self.run = run
        self.owner_cache = {}

    def cmd(self, argv, timeout=10):
        return command(argv, self.run, timeout)

    def identity(self, p):
        return self.identity_recheck(p)['same']

    def identity_recheck(self, p):
        try:
            raw = self.cmd(['/bin/ps', '-ww', '-p', str(p['pid']), '-o', 'lstart=,comm='], 2).strip()
            parts = raw.split(None, 5)
            same = len(parts) == 6 and ' '.join(parts[:5]) == p['start'] and parts[5] == p['comm']
            if not same or not p.get('args'):
                return dict(same=False)
            args = self.cmd(['/bin/ps', '-ww', '-p', str(p['pid']), '-o', 'lstart=,args='], 2).strip().split(None, 5)
            return dict(same=(len(args) == 6 and ' '.join(args[:5]) == p['start']
                    and hashlib.sha256(args[5].encode()).hexdigest() == p.get('argsHash', hashlib.sha256(p['args'].encode()).hexdigest())))
        except (ProbeError, OSError) as exc:
            if isinstance(exc, ProbeError) and exc.rc == 1 and not exc.stderr:
                return dict(same=False, result='gone', errno=errno_codes.ESRCH)
            return dict(same=False, **failure_details(exc, 'ps'))

    def same_birth(self, p):
        try:
            start = self.cmd(['/bin/ps', '-p', str(p['pid']), '-o', 'lstart='], 2).strip()
            return start == p['start']
        except ProbeError as exc:
            return False if str(exc) == 'exit' else None

    def signal(self, p, sig):
        os.kill(p['pid'], sig)

    def soften(self, p):
        # Renice is bounded in a helper; Darwin background mode can starve lock holders.
        stages = {name:dict(result='skipped', reason='prior-stage-failed')
                  for name in ('identityRead', 'getpriority', 'renice', 'identityRecheck', 'readBack')}
        outcome = dict(stages=stages)

        def finish(stage, value):
            value = {k:v for k,v in value.items() if v is not None}
            if value.get('result') == 'error' and not any(type(value.get(k)) is int for k in ('errno', 'rc')):
                value['errno'] = errno_codes.EIO
            stages[stage] = value
            return dict(outcome, stage=stage, **value)

        def identify(stage):
            identity = self.identity_recheck(p)
            if identity['same']:
                stages[stage] = dict(result='sent', same=True)
                return None
            result = identity.get('result', 'identity-changed')
            return finish(stage, dict(identity, result=result, reason=identity.get('reason', result)))

        changed = identify('identityRead')
        if changed:
            return changed
        try:
            outcome['niceBefore'] = os.getpriority(os.PRIO_PROCESS, p['pid'])
        except OSError as exc:
            return finish('getpriority', failure_details(exc, 'getpriority'))
        stages['getpriority'] = dict(result='sent')
        if outcome['niceBefore'] >= 10:
            outcome['niceAfter'] = outcome['niceBefore']
            return finish('renice', dict(result='skipped', reason='already-nice'))
        try:
            self.cmd(['/usr/bin/renice', '20', '-p', str(p['pid'])], 2)
        except (ProbeError, OSError) as exc:
            failure = failure_details(exc, 'renice')
            if re.search(r'no such process', failure.get('stderr', ''), re.I):
                identify('identityRecheck')
                identity = stages['identityRecheck']
                if not identity['same'] and identity.get('result') != 'error':
                    failure.update(result='gone', errno=errno_codes.ESRCH)
            return finish('renice', failure)
        stages['renice'] = dict(result='sent', rc=0)
        changed = identify('identityRecheck')
        if changed:
            return changed
        try:
            outcome['niceAfter'] = os.getpriority(os.PRIO_PROCESS, p['pid'])
        except OSError as exc:
            return finish('readBack', failure_details(exc, 'getpriority'))
        if outcome['niceAfter'] != 20:
            return finish('readBack', dict(result='error', errno=errno_codes.EIO, reason='nice-readback-mismatch'))
        return finish('readBack', dict(result='sent'))

    def app_info(self, p):
        try:
            return json.loads(self.cmd(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--app-info', p['comm']], 3))
        except (ProbeError, ValueError):
            return None

    def quit_app(self, p):
        request = {k: p[k] for k in ('pid', 'start', 'comm', 'argsHash', 'bundleId')}
        request['stateDir'] = str(p['guardState'])
        self.cmd(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--quit-gui', json.dumps(request)], 10)

    def ssd_blocked(self):
        return (Path.home()/'.local/state/mac-upkeep/ssd-launchd-read-blocked').exists()

    def notify(self, key, text):
        self.cmd([str(Path.home()/'.bun/bin/bun'), str(Path.home()/'.local/share/telegram-bridge/src/cli.ts'),
                  'notify', '--source', 'Mac guard', '--severity', 'attention', '--text', text, '--key', key])

    def overload(self):
        return json_object(self.cmd(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--restart-check'], 20))

    def restart(self, log, stamp):
        entry = OVERLOAD_SCRIPT.parent/'launchd-entry.zsh'
        if not OVERLOAD_SCRIPT.is_file() or not entry.is_file() or (OVERLOAD_STATE/'disabled').exists():
            raise ProbeError('installed watchdog missing or disabled')
        # Use a different session: robob-restart would make limits() refuse its own caller.
        # tmux may retain an older environment. Bind entry and receipt storage
        # to the same installed copy that preflight checked.
        cmd = 'export ROBOB_OVERLOAD_HOME=%s ROBOB_OVERLOAD_STATE=%s; /bin/zsh -f %s restart %s > %s 2>&1; rc=$?; /usr/bin/printf "%%s" "$rc" > %s' % (
            shlex.quote(str(OVERLOAD_SCRIPT.parent)), shlex.quote(str(OVERLOAD_STATE)),
            shlex.quote(str(entry)), shlex.quote(stamp), shlex.quote(str(log)), shlex.quote(str(log.with_suffix('.exit'))))
        self.cmd([TMUX, '-L', 'restart', 'new-session', '-d', '-s', 'mac-guard-restart',
                  '/bin/zsh -f -c '+shlex.quote(cmd)], 20)

    def restart_result(self, pending):
        receipt = read_json(OVERLOAD_STATE/('result-'+pending['stamp']+'.json'))
        if receipt.get('ok') is False:
            return receipt
        try:
            code = int(Path(pending['log']).with_suffix('.exit').read_text())
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            return dict(ok=False, reason='unreadable watchdog exit')
        # A success receipt precedes logging and notification in the watchdog;
        # its process can still fail after writing it.
        if receipt.get('ok') is True:
            return dict(ok=False, reason='watchdog exit %s after success receipt' % code) if code else receipt
        return dict(ok=False, reason='watchdog exit %s without result' % code)

    def worker_status(self, tid):
        value = json_object(self.cmd([T3CTL, 'status', tid], 5))
        value = value.get('thread', value)
        if not isinstance(value, dict):
            raise ValueError('unreadable thread')
        return value

    def worker_send(self, tid, text, request_id=None):
        self.cmd([T3CTL, 'send', tid, text]+(['--request-id', request_id] if request_id else []), 5)

    def worker_request(self, method, path, body=None):
        self.worker_duration = None
        try:
            result = self.run(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--worker-control'],
                              input=json.dumps(dict(method=method, path=path, body=body)), capture_output=True,
                              text=True, timeout=WORKER_HELPER_TIMEOUT, env={k: v for k, v in os.environ.items() if k != 'BUN_INSPECT'})
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise WorkerControlError(worker_failure(exc)) from None
        value = json_object(result.stdout)
        self.worker_duration = value.pop('_durationS', None)
        if result.returncode:
            raise WorkerControlError(value.get('failure', 'unavailable'), self.worker_duration, value.get('status'))
        return value

    def worker_lookup(self, request_id):
        value = self.worker_request('GET', '/threads/'+urllib.parse.quote(worker_thread_id(request_id), safe=''))
        if value.get('missing') is True:
            return None
        thread = value.get('thread', value)
        if not isinstance(thread, dict) or thread.get('threadId') != worker_thread_id(request_id):
            raise ValueError('unreadable launch correlation')
        return thread['threadId']

    def worker_initial(self, launch):
        tid = worker_thread_id(launch['clientRequestId'])
        path = '/threads/'+urllib.parse.quote(tid, safe='')
        value = self.worker_request('GET', path+'/messages?role=user&limit=1000')
        messages = value.get('messages')
        if value.get('threadId') != tid or not isinstance(messages, list):
            raise ValueError('unreadable initial message history')
        for message in messages:
            if not isinstance(message, dict):
                raise ValueError('unreadable initial message')
            if message.get('messageId') != tid:
                continue
            if (message.get('role') != 'user' or message.get('text') != launch['prompt'].strip()
                    or not isinstance(message.get('runId'), str) or not message['runId']):
                raise ValueError('unconfirmed initial message')
            return tid
        if type(value.get('total')) is not int or value['total'] != len(messages):
            raise ValueError('incomplete initial message history')
        return None

    def worker_resume(self, launch):
        # Reuse the server's original initial-message receipt: the timed-out
        # launch can still commit after our history snapshot. A new send ID
        # would accept a second run in that race.
        path = '/threads/'+urllib.parse.quote(worker_thread_id(launch['clientRequestId']), safe='')+'/resume-launch'
        return self._worker_launch(launch, path)

    def worker_create(self, launch):
        return self._worker_launch(launch, '/threads')

    def _worker_launch(self, launch, path):
        value = self.worker_request('POST', path, launch)
        tid = worker_thread_id(launch['clientRequestId'])
        if (value.get('threadId') != tid or value.get('messageId') != tid
                or not isinstance(value.get('runId'), str) or not value['runId']):
            raise ValueError('unexpected launch correlation')
        return value['threadId']

    def ownership(self, p, rows, now):
        # A cycle has one shared five-second owner-resolution budget. Unresolved
        # work is softened only; unknown never authorizes ending a live build.
        ident = (p['pid'], p['start'])
        cached = self.owner_cache.get(ident)
        if cached and cached[1]['state'] != 'ended' and now-cached[0] < 120:
            return cached[1]
        if time.monotonic() > self.owner_deadline:
            return dict(state='unknown', bound=bool(cached and cached[1].get('bound')))
        bindings = {}
        try:
            source = Path(__file__).resolve().parents[1]/'dev-resource-janitor/skill/scripts'
            if not source.is_dir():
                source = Path.home()/'.config/opencode/skills/dev-resource-janitor/scripts'
            sys.path.insert(0, str(source))
            try:
                from leftover_processes import native_binding
            finally:
                sys.path.pop(0)
            bindings = next((b for q in [p]+chain(p, rows) if (b := native_binding(q['pid']))), {})
            tids = {bindings[k] for k in ('T3_THREAD_ID', 'T3CODE_THREAD_ID', 'ROBOB_THREAD_ID') if k in bindings}
            if len(tids) > 1:
                raise ValueError('conflicting owners')
            tid = next(iter(tids), None)
            if tid:
                value = self.worker_status(tid)
            else:
                key = next((k for k in ('CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID') if k in bindings), None)
                value = json_object(self.cmd([T3CTL, 'native', bindings[key], '--view', 'owner'], 3)) if key else {}
                value = value.get('thread', value)
                if not isinstance(value, dict):
                    raise ValueError('unreadable owner')
                tid = value.get('threadId')
            ended = (value.get('state') == 'idle' and value.get('status') in ('completed', 'failed', 'cancelled', 'interrupted')
                     and value.get('activeRunId') is None and value.get('pendingRequests') == []
                     and (value.get('settled') is True or value.get('archived') is True))
            result = dict(state='ended' if ended else 'live' if tid else 'unknown', threadId=tid)
        except (ProbeError, ImportError, OSError, ValueError, KeyError, TypeError):
            result = dict(state='unknown')
        result['bound'] = bool(bindings)
        self.owner_cache[ident] = (now, result)
        return result

    def build(self, p, rows, now):
        # Worktree paths are evidence, never a pattern used to kill processes.
        text = ' '.join(q.get('args', '') for q in [p]+chain(p, rows))
        for root in re.findall(r'/Volumes/ExternalSSD/(?:t3code-wt|t3code-fork)/[^\s\"\x27]+', text):
            path = Path(root)
            for parent in [path]+list(path.parents):
                state = parent/'tmp/build/state'
                if (state/'pid').is_file():
                    try:
                        pid = int((state/'pid').read_text().strip())
                        if pid not in {q['pid'] for q in [p]+chain(p, rows)}:
                            continue
                        logs = list((parent/'tmp/build').glob('*.log')) + list((parent/'tmp/build/logs').glob('*.log'))
                        newest = max((log.stat().st_mtime for log in logs), default=now)
                        return dict(detached=True, stale=now-newest > 1800, root=pid)
                    except (OSError, ValueError):
                        return dict(detached=True, stale=False)
        return dict(detached=False, stale=False)

    def collect(self, cycle):
        raw = self.cmd(PS, 20)
        rows = parse_ps(raw)
        # cpu.PS deliberately omits argv. This separate read is identity-qualified
        # and is needed to exempt node/bun provider wrappers before any action.
        args = {}
        try:
            for line in self.cmd(['/bin/ps', '-axww', '-o', 'pid=,lstart=,args='], 5).splitlines():
                parts = line.split(None, 6)
                if len(parts) == 7 and parts[0].isdigit():
                    args[int(parts[0])] = (' '.join(parts[1:6]), parts[6])
        except ProbeError:
            pass
        labels = {}
        try:
            for line in self.cmd(['/bin/launchctl', 'list'], 2).splitlines():
                parts = line.split()
                if len(parts) == 3 and parts[0].isdigit() and parts[2].startswith(('com.abdullah.', 'com.ardud.', 'local.ardud.')):
                    labels[int(parts[0])] = parts[2]
        except ProbeError:
            # Without a service inventory only memory-exempt alerts are safe.
            labels = {p['pid']: 'unknown-service-inventory' for p in rows}
        for p in rows:
            p['label'] = labels.get(p['pid'])
            value = args.get(p['pid'])
            p['args'] = value[1] if value and value[0] == p['start'] else ''
        snapshot = dict(rows=rows, load=list(os.getloadavg()), ncpu=os.cpu_count() or 1, errors=[])
        for key, argv, parser, timeout in (
            # A top-20 limit can hide every member of a >24 GiB Robob tree.
            # One bounded footprint read covers the tree; evidence keeps top 20.
            ('top', ['/usr/bin/top', '-l', '1', '-o', 'mem', '-stats', STATS], parse_top, 10),
            ('pressure', ['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level'], lambda s: int(s.strip()), 2),
            ('swap', ['/usr/sbin/sysctl', '-n', 'vm.swapusage'], parse_swap, 2)):
            try:
                observed_at = time.time()
                snapshot[key] = parser(self.cmd(argv, timeout))
                if key == 'top':
                    snapshot['footprintObservedAt'] = observed_at
            except (ProbeError, MemoryError, ValueError) as exc:
                snapshot[key] = None
                snapshot['errors'].append(dict(probe=key, failure=str(exc)))
        if cycle % 2 == 0:
            try:
                # Nonzero health verdicts still carry useful lag JSON.
                result = self.run([T3CTL, 'health', '--deep', '--json'], capture_output=True, text=True,
                                  timeout=10, env={k: v for k, v in os.environ.items() if k != 'BUN_INSPECT'})
                health = json_object(result.stdout)
                snapshot['lag'] = health_lag(health)
            except subprocess.TimeoutExpired:
                snapshot['lag'] = 11
                snapshot['errors'].append(dict(probe='health', failure='timeout'))
            except (OSError, ValueError, TypeError):
                snapshot['lag'] = None
                snapshot['errors'].append(dict(probe='health', failure='unavailable'))
        try:
            snapshot['ticks'] = cpu_ticks()
        except ProbeError:
            snapshot['ticks'] = None
        self.owner_deadline = time.monotonic()+5
        live_ids = {(p['pid'], p['start']) for p in rows}
        self.owner_cache = {k: v for k, v in self.owner_cache.items() if k in live_ids}
        return snapshot

    def diagnostic(self, path):
        # One captured child, not synchronous stack postprocessing in the guard.
        subprocess.Popen(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--diagnostic', str(path)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)


def health_lag(health):
    lag = health.get('lag') or {}
    if not isinstance(lag, dict):
        raise ValueError('unreadable lag')
    values = [lag.get(k) for k in ('maxMs', 'latestMs', 'p99Ms', 'ms', 'worstMs', 'latestDelayMs')]
    return max((v/1000 for v in values if type(v) in (int, float)), default=None)


class Guard:
    def __init__(self, host=None, state=STATE, evidence=EVIDENCE, dry=None, logger=emit, clock=time.time, worker_submit=None):
        self.host = host or Host()
        self.state, self.evidence = Path(state), Path(evidence)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.saved = read_json(self.state/'state.json')
        self.worker = read_json(self.state/'worker.json')
        self.dry = os.environ.get('MAC_GUARD_DRY_RUN') == '1' if dry is None else dry
        self.logger = logger
        self.clock = clock
        if self.dry:
            self.saved, self.worker = {}, {}
        self.history, self.previous = {}, {}
        self.slow_history = {(p['pid'], p['start']): deque(p['history'], maxlen=241)
                             for p in self.saved.get('slowHistory', [])}
        self.gui_jobs = {(p['pid'], p['start']): p for p in self.saved.get('guiJobs', [])}
        self.slow_incidents = set()
        self.strain, self.streak, self.calm, self.cycle = bool(self.saved.get('strain')), 0, 0, 0
        self.lag = None
        self.since = (self.saved.get('strainSince') or self.saved.get('lastSample') or self.clock()) if self.strain else None
        self.first_action = None
        self.hogs = {(p['pid'], p['start']): dict(stage=p['stage'], at=p['at'], confirmed=bool(p.get('confirmed')))
                     for p in self.saved.get('hogs', [])}
        self.pending = self.saved.get('pending', [])
        self.stopped = self.saved.get('stopped', [])
        self.restore_due = self.saved.get('restoreDue', [])
        self.actions = deque(maxlen=300)
        self.minute = None
        self.diag_streak = 0
        self.diag_episode = False
        self.incidents = set()
        self.restart_incident = None
        # The executor only runs bounded helper subprocesses, never guard state
        # changes. One in-flight request keeps reconcile and POST serialized.
        self.worker_executor = ThreadPoolExecutor(max_workers=1) if worker_submit is None else None
        self.worker_submit = worker_submit or self.worker_executor.submit
        self.worker_job = None

    @property
    def muted(self):
        return self.dry or (self.state/'paused').exists()

    def log(self, name, **props):
        self.logger('mac-guard', 'error' if name == 'error' else 'event', 'macguard.'+name,
                    props=props, now=dt.datetime.fromtimestamp(self.now, dt.timezone.utc))

    def save(self):
        if self.dry:
            return
        self.saved['notifications'] = {k: v for k, v in self.saved.get('notifications', {}).items() if self.now-v < 86400}
        def private_proc(p):
            return dict(p, args=command_label(p.get('args', '')))
        pending = [dict(e, proc=private_proc(e['proc'])) for e in self.pending]
        self.saved.update(pending=pending, stopped=[private_proc(p) for p in self.stopped],
                          slowHistory=[dict(pid=pid, start=start, history=list(h)) for (pid, start), h in self.slow_history.items()],
                          guiJobs=list(self.gui_jobs.values()),
                          hogs=[dict(pid=pid, start=start, **v) for (pid, start), v in self.hogs.items()],
                          restoreDue=self.restore_due, lastSample=self.now, strain=self.strain, strainSince=self.since)
        write_json(self.state/'state.json', self.saved)

    def snapshot(self, summary):
        path = self.evidence/(iso(self.now)+'-%04d' % self.cycle)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        value = dict(self.sample, summary=summary, actions=list(self.actions),
                     history={str(pid): list(h) for (pid, _), h in self.history.items() if pid in self.rows},
                     slowHistory={str(pid): list(h) for (pid, _), h in self.slow_history.items() if pid in self.rows},
                     cpuTop30=self.cpu_top[:30], rZeroFamilies=self.r_zero)
        if value.get('top') is not None:
            value['top'] = sorted(value['top'], key=lambda p: -p['memMb'])[:20]
        # Raw environments never enter evidence; argv is redacted before disk.
        value['rows'] = [dict(p, args=command_label(p.get('args', ''))) for p in self.rows.values()]
        write_json(path/'snapshot.json', value)
        return path

    def notify(self, key, text):
        sent = self.saved.setdefault('notifications', {})
        if self.muted or key in sent:
            return
        # Reserve first: an ambiguous queue response must not duplicate a notify.
        sent[key] = self.now
        self.save()
        try:
            self.host.notify(key, text)
            result = 'queued'
        except (ProbeError, OSError):
            result = 'unknown'
        self.log('notify', key=key, result=result)

    def action(self, p, cls, action):
        current = self.rows.get(p['pid'])
        matched = current and current['start'] == p['start'] and current['comm'] == p['comm']
        if matched:
            # Saved argv is redacted. Classify fresh argv, but verify the hash
            # captured when this action was authorized across daemon restarts.
            p = dict(current, argsHash=p.get('argsHash', current.get('argsHash')))
        allowed = cls not in ('A', 'B', 'C') or self.strain or action == 'CONT'
        result, errno = ('cancelled_strain_clear' if not allowed else 'would_'+action if self.muted else 'skipped_identity'), None
        details = {}
        stop_intent, prior_stage = False, None
        gui_job = self.gui_jobs.get((p['pid'], p['start']))
        gui_ok = (cls == 'G' and gui_job and gui_job['phase'] == 'force'
                  and self.gui_force_growth(p, gui_job) and self.gui_allowed(p, gui_job))
        ancestor = robob_ancestor(p, self.rows)
        if cls == 'G':
            safe = gui_ok
        elif cls == 'D' or action == 'CONT':
            safe = not exempt(p, self.rows)
        else:
            safe = not protected(p, self.rows, renice=action == 'renice')
        if ancestor and action != 'renice':
            safe = False
        if allowed and not safe:
            result = 'cancelled_gui_authorization' if cls == 'G' and not ancestor else 'cancelled_protection'
        elif not matched:
            result = 'skipped_identity'
        if (allowed and not self.muted and p['pid'] in self.rows and self.rows[p['pid']]['start'] == p['start']
                and safe
                and not p['state'].startswith('?') and self.host.identity(p) and not self.muted):
            try:
                if action == 'STOP':
                    # A daemon crash after SIGSTOP must leave enough durable
                    # intent to resume this exact process and retain its grace.
                    ident = (p['pid'], p['start'])
                    prior_stage = self.hogs.get(ident)
                    if not any((q['pid'], q['start']) == ident for q in self.stopped):
                        self.stopped.append(dict(p))
                    self.hogs[ident] = dict(stage=2, at=max(self.now, self.clock()), confirmed=False)
                    stop_intent = True
                    self.save()
                if action == 'renice':
                    details = self.host.soften(p)
                    result, errno = details['result'], details.get('errno')
                else:
                    self.host.signal(p, getattr(signal, 'SIG'+action))
                    if action == 'STOP':
                        self.hogs[ident].update(confirmed=True, at=max(self.now, self.clock()))
                    result = 'sent'
            except (ProbeError, OSError) as exc:
                details = failure_details(exc, action)
                result, errno = details['result'], details['errno']
                if stop_intent:
                    self.stopped = [q for q in self.stopped if (q['pid'], q['start']) != ident]
                    if prior_stage is None:
                        self.hogs.pop(ident, None)
                    else:
                        self.hogs[ident] = prior_stage
                    self.save()
        value = dict(pid=p['pid'], start=p['start'], comm=p['comm'], args=command_label(p.get('args', '')),
                     action=action, result=result, errno=errno, actionClass=cls, owner=p.get('owner', {}).get('state', 'unknown'),
                     cpuDelta=p.get('cpuDelta', 0), footprintGiB=p.get('footprintGiB'), label=label(p, self.rows))
        value.update({k:details[k] for k in ('stages', 'stage', 'reason', 'rc', 'niceBefore', 'niceAfter') if k in details})
        if ancestor:
            value.update(protectedBy='robob-descendant', protectedAncestor={k: ancestor[k] for k in ('pid', 'start', 'comm')})
        if action == 'renice' and result == 'error':
            value.setdefault('stage', 'renice')
            if errno is None:
                if type(value.get('rc')) is int:
                    value.pop('errno')
                else:
                    value['errno'] = errno_codes.EIO
        if cls == 'G':
            value.update(step='force-quit', **{k: p.get(k) for k in ('app', 'bundleId', 'growthGiBHour', 'footprintSeries')})
        self.actions.append(value)
        self.log('action', **value)
        performed = (result == 'sent' or details.get('stages', {}).get('renice', {}).get('result') == 'sent'
                     or action == 'renice' and result == 'skipped' and details.get('reason') == 'already-nice'
                     or self.dry and allowed and safe and matched)
        if performed:
            if cls == 'G' and action == 'KILL' and gui_job:
                gui_job['phase'] = 'complete'
            if self.strain and self.first_action is None:
                self.first_action = self.now
            if not self.restore_due:
                self.restore_due.append(self.now+120)
            if action == 'STOP' and self.dry:
                self.stopped.append(dict(p))
                self.hogs[(p['pid'], p['start'])] = dict(stage=2, at=self.now, confirmed=True)
        return performed

    def slow_sample(self, p, footprint):
        ident = (p['pid'], p['start'])
        if not footprint:
            return False
        # Track plausible holders; history size is bounded independently of uptime.
        if p['footprintGiB'] < 4 and ident not in self.slow_history:
            return False
        hist = self.slow_history.setdefault(ident, deque(maxlen=241))
        while hist and (hist[0]['at'] < self.now-7200 or hist[-1]['at'] >= self.now):
            hist.popleft()
        hist.append(dict(at=self.now, footprintGiB=p['footprintGiB']))
        old = next((v for v in reversed(hist) if self.now-v['at'] >= SLOW_LEAK_SECONDS), None)
        p['growthGiBHour'] = (p['footprintGiB']-old['footprintGiB'])*3600/(self.now-old['at']) if old else 0
        p['footprintSeries'] = list(hist)
        return bool(old and p['footprintGiB'] > SLOW_LEAK_GIB and p['growthGiBHour'] > SLOW_LEAK_GIB_HOUR)

    def gui_allowed(self, p, job=None):
        info = self.host.app_info(p) if gui(p) else None
        if not info:
            return False
        p.update(info)
        if info['bundleId'] in GUI_NEVER_QUIT:
            return False
        # Activity Monitor is a main GUI executable in /System/Applications.
        # No other /System path, app helper or daemon gets this exception.
        system_gui = p['comm'].startswith('/System/Applications/') and Path(p['comm']).name not in MEMORY_EXEMPT['system_names']
        if protected(p, self.rows) and (not system_gui or exempt(p, self.rows, system_gui=True) or label(p, self.rows)):
            return False
        return not job or info['bundleId'] == job['bundleId'] and info['app'] == job['app']

    def gui_log(self, p, step, result, evidence=None):
        value = {k: p.get(k) for k in ('pid', 'start', 'comm', 'app', 'bundleId', 'footprintGiB', 'footprintSeries', 'growthGiBHour')}
        value.update(action=step, step=step, actionClass='G', result=result, evidence=evidence)
        self.actions.append(value)
        self.log('action', **value)

    def gui_force_growth(self, p, job):
        hist = self.slow_history.get((p['pid'], p['start']), [])
        footprint = p.get('footprintGiB')
        if footprint is None:
            return False
        return (self.now >= job['at']+120 and len(hist) >= 2
                and 0 <= self.now-hist[-1]['at'] <= 60 and hist[-2]['at'] >= job['at']
                and footprint > max(SLOW_LEAK_GIB, job['footprintGiB'], hist[-2]['footprintGiB'])
                and p.get('growthGiBHour', 0) > SLOW_LEAK_GIB_HOUR)

    def slow_actions(self, leaks):
        current = {(p['pid'], p['start']) for p in leaks}
        pending = {(e['proc']['pid'], e['proc']['start']) for e in self.pending}
        for ident, job in list(self.gui_jobs.items()):
            p = self.rows.get(ident[0])
            if not p or p['start'] != ident[1]:
                if self.host.same_birth(job) is not False:
                    continue
                self.gui_log(job, 'appgone', 'gone', job['evidence'])
                self.gui_jobs.pop(ident)
                continue
            if job['phase'] == 'force' and ident not in pending:
                # A crash may preserve TERM intent without delivery. Re-run
                # the full growth/identity checks, then start a fresh KILL grace.
                job['phase'] = 'waiting'
            if job['phase'] != 'waiting' or self.now < job['at']+120 or self.muted and not self.dry:
                continue
            if p.get('footprintGiB') is None:
                continue  # top failed: wait for current footprint evidence
            if (ident in current and self.gui_force_growth(p, job) and self.gui_allowed(p, job)
                    and not p['state'].startswith('?') and self.host.identity(p) and (not self.muted or self.dry)):
                job['phase'] = 'force'
                self.save()
                self.terminate([p], 'G')
                self.worker_needed(Path(job['evidence']), 'slow GUI leak: force-quit pid '+str(p['pid']), urgent=True)
            else:
                self.gui_log(p, 'force-quit', 'cancelled_not_growing_or_protected', job['evidence'])
            self.save()
        for p in leaks:
            ident = (p['pid'], p['start'])
            if ident in self.slow_incidents or ident in pending:
                continue
            allowed = self.gui_allowed(p)
            path = self.snapshot('slow footprint leak pid '+str(p['pid']))
            kind = 'gui' if allowed else 'protected' if protected(p, self.rows) or gui(p) else 'hog'
            self.log('slow_leak', pid=p['pid'], start=p['start'], comm=p['comm'],
                     footprintGiB=p['footprintGiB'], growthGiBHour=p['growthGiBHour'],
                     footprintSeries=p['footprintSeries'], bundleId=p.get('bundleId'), memoryClass=kind,
                     action='quit' if allowed else 'protected_alert' if kind == 'protected' else 'ladder', evidence=str(path))
            if allowed and ident not in self.gui_jobs:
                job = {k: p.get(k) for k in ('pid', 'start', 'comm', 'app', 'bundleId', 'footprintGiB', 'growthGiBHour', 'footprintSeries')}
                job.update(at=self.now, phase='unknown', evidence=str(path))
                if self.dry:
                    job['phase'] = 'waiting'
                    self.gui_jobs[ident] = job
                    self.gui_log(p, 'quit', 'would_quit', str(path))
                elif not self.muted and self.host.identity(p) and not self.muted:
                    # Ambiguous Quit never authorizes force-quit after a crash.
                    self.gui_jobs[ident] = job
                    self.save()
                    try:
                        p['guardState'] = str(self.state)
                        self.host.quit_app(p)
                        job['phase'] = 'waiting'
                        job['at'] = max(self.now, self.clock())
                        self.gui_log(p, 'quit', 'sent', str(path))
                        self.restore_due.append(job['at']+120)
                    except (ProbeError, OSError) as exc:
                        self.gui_log(p, 'quit', 'unknown', str(path))
                        self.log('error', probe='gui_quit', failure=type(exc).__name__, errno=getattr(exc, 'errno', None), evidence=str(path))
                    self.save()
            text = 'mac-guard slow leak: %s pid %s at %.2f GiB, growing %.2f GiB/h (%s)' % (
                p['comm'], p['pid'], p['footprintGiB'], p['growthGiBHour'], kind)
            self.notify('mac-guard:slow-leak:%s:%s' % (p.get('bundleId') or label(p, self.rows) or p['comm'], iso(self.now)[:8]), text)
            self.worker_needed(path, text+'; report evidence and actions on Mac Upkeep board', urgent=True)
        if not self.muted or self.dry:
            self.slow_incidents = current

    def terminate(self, processes, cls):
        sent = []
        for p in processes:
            if self.action(p, cls, 'TERM'):
                self.pending.append(dict(proc=dict(p), due=max(self.now, self.clock())+10, actionClass=cls))
                sent.append(p['pid'])
        return sent

    def drain(self, now):
        self.now = now
        self.cancel_calm_kills()
        remaining = []
        for entry in self.pending:
            if entry['due'] > now or self.muted and not self.dry:
                remaining.append(entry)
                continue
            # identity() is a fresh ps read, also required for delayed SIGKILL.
            killed = self.action(entry['proc'], entry['actionClass'], 'KILL')
            if entry.get('notice'):
                notice = entry['notice']
                gone = killed or self.host.same_birth(entry['proc']) is False
                text = notice['text'].replace('TERMINATION_RESULT', 'killed' if gone else 'termination unconfirmed for')
                self.notify(notice['key'], text)
                self.worker_needed(Path(notice['evidence']), 'memory runaway: '+text, urgent=notice['urgent'])
        self.pending = remaining
        self.save()

    def cancel_calm_kills(self):
        if self.strain:
            return
        remaining = []
        for entry in self.pending:
            if entry['actionClass'] in ('A', 'B', 'C'):
                p = entry['proc']
                self.log('action', pid=p['pid'], start=p['start'], comm=p['comm'],
                         args=command_label(p.get('args', '')), actionClass=entry['actionClass'],
                         action='KILL', result='cancelled_strain_clear', owner=p.get('owner', {}).get('state', 'unknown'),
                         cpuDelta=p.get('cpuDelta', 0), footprintGiB=p.get('footprintGiB'))
            else:
                remaining.append(entry)
        if len(remaining) != len(self.pending):
            self.pending = remaining
            self.save()

    def worker_launch_step(self, launch, path, reconcile, operation=None):
        if self.muted:
            return
        if self.worker_job is None:
            operation = operation or ('worker_lookup' if reconcile else 'worker_create')
            def request():
                started = time.monotonic()
                try:
                    if operation == 'worker_lookup':
                        value = self.host.worker_lookup(launch['clientRequestId'])
                    elif operation == 'worker_initial':
                        value = self.host.worker_initial(launch)
                    elif operation == 'worker_resume':
                        value = self.host.worker_resume(launch)
                    else:
                        value = self.host.worker_create(launch)
                    return dict(value=value, durationS=getattr(self.host, 'worker_duration', None) or time.monotonic()-started)
                except (ProbeError, OSError, ValueError, KeyError, TypeError) as exc:
                    return dict(failure=worker_failure(exc),
                                durationS=getattr(exc, 'durationS', None) or getattr(self.host, 'worker_duration', None) or time.monotonic()-started,
                                status=getattr(exc, 'status', None))
            self.worker_job = dict(requestId=launch['clientRequestId'], operation=operation,
                                   future=self.worker_submit(request))
        job = self.worker_job
        if job['requestId'] != launch['clientRequestId'] or not job['future'].done():
            return
        result = job['future'].result()
        self.worker_job = None
        failure = result.get('failure')
        self.log(job['operation'], result='failed' if failure else 'missing' if result['value'] is None else 'found',
                 durationS=result['durationS'], failure=failure, errno=result.get('status'))
        if failure:
            self.log('error', probe=job['operation'], failure=failure,
                     durationS=result['durationS'], errno=result.get('status'))
            return
        if job['operation'] == 'worker_lookup':
            return self.worker_launch_step(launch, path, reconcile=result['value'] is not None,
                                           operation='worker_initial' if result['value'] is not None else 'worker_create')
        if job['operation'] == 'worker_initial' and result['value'] is None:
            return self.worker_launch_step(launch, path, reconcile=True, operation='worker_resume')
        self.log('worker_spawned', threadId=result['value'], evidence=str(path),
                 result='sent' if job['operation'] == 'worker_create' else 'adopted')
        return result['value']

    def launch_worker(self, path, reconcile=False):
        if self.muted:
            return
        if self.worker_job is None and self.now < self.worker.get('nextReconcileAt', 0):
            return
        self.worker['nextReconcileAt'] = self.now+30
        self.worker['evidence'] = str(path)
        write_json(self.state/'worker.json', self.worker)
        tid = self.worker_launch_step(self.worker['launch'], path, reconcile)
        if tid:
            self.worker = dict(threadId=tid, startedAt=self.worker['startedAt'])
            write_json(self.state/'worker.json', self.worker)
        return tid

    def worker_skipped(self, reason, signals, path):
        last = self.saved.get('workerSkippedAt')
        if last is not None and 0 <= self.now-last < WORKER_SKIP_LOG_INTERVAL:
            return
        self.saved['workerSkippedAt'] = self.now
        self.log('worker_skipped', reason=reason, signals=signals, evidence=str(path))
        self.save()

    def record_strain_worker(self, signals, path):
        # Reserve before send: a timeout can still have delivered the steer.
        self.saved['strainWorker'] = dict(signals=sorted(set(signals)), at=self.now, evidence=str(path))
        self.save()

    def worker_needed(self, path, summary, urgent=False, delivery=None, signals=None, allow_launch=True):
        if signals is not None:
            if not signals:
                self.worker_skipped('empty_signals', signals, path)
                return
            last = self.saved.get('strainWorker')
            if last and not set(signals)-set(last['signals']):
                if 0 <= self.now-last['at'] < STRAIN_WORKER_INTERVAL:
                    self.worker_skipped('unchanged', signals, path)
                    return
                summary += '; still ongoing'
        if self.muted:
            self.log('worker_steered' if self.worker.get('threadId') else 'worker_spawned',
                     result='would_act', evidence=str(path), summary=summary)
            return
        if self.worker.get('launchUnknown'):
            if not self.launch_worker(path, reconcile=True):
                return
        tid = self.worker.get('threadId')
        if tid:
            try:
                value = self.host.worker_status(tid)
            except (ProbeError, OSError, ValueError):
                self.log('error', probe='worker_status', failure='unavailable', threadId=tid)
                return  # unknown cannot authorize a duplicate worker
            ended = (value.get('state') == 'idle' and value.get('status') in ('completed', 'failed', 'cancelled', 'interrupted')
                     and not value.get('activeRunId') and not value.get('pendingRequests'))
            if not ended:
                if self.muted:
                    return
                if signals is not None:
                    self.record_strain_worker(signals, path)
                try:
                    if delivery is not None:
                        delivery['threadId'] = tid
                        self.save()
                        self.host.worker_send(tid, str(path)+'\n'+summary, delivery['requestId'])
                    else:
                        self.host.worker_send(tid, str(path)+'\n'+summary)
                    self.log('worker_steered', threadId=tid, evidence=str(path))
                    return True
                except (ProbeError, OSError):
                    self.log('error', probe='worker_send', failure='unavailable')
                return
            self.worker.pop('threadId', None)
            self.worker['endedAt'] = self.now
            write_json(self.state/'worker.json', self.worker)
        if not allow_launch:
            if signals is not None:
                self.worker_skipped('load_only_wait', signals, path)
            return
        if self.worker_job is not None:
            return
        if not urgent and self.now-self.worker.get('endedAt', 0) < 1200:
            return
        if self.muted:
            return
        template = Path(__file__).with_name('mac_guard_worker_prompt.md').read_text()
        launch = dict(clientRequestId='mac-guard-'+uuid.uuid4().hex, title='CRITICAL: Robob starved '+iso(self.now),
                      directory='/Volumes/ExternalSSD/t3code-fork', providerInstanceId=WORKER[0], model=WORKER[1],
                      options=[dict(id='reasoningEffort', value='xhigh'), dict(id='serviceTier', value='default')],
                      runtimeMode='full-access', prompt=template.replace('{{EVIDENCE}}', str(path)).replace('{{SUMMARY}}', summary))
        self.worker = dict(launchUnknown=True, launch=launch, startedAt=self.now)
        if delivery is not None:
            delivery.update(launch=launch, startedAt=self.now)
            self.save()
        write_json(self.state/'worker.json', self.worker)
        if signals is not None:
            self.record_strain_worker(signals, path)
        return self.launch_worker(path)

    def queue_restart_responder(self, path, reason, urgent):
        self.saved['restartResponder'] = dict(evidence=str(path), summary='Robob restart skipped: '+reason,
                                              urgent=urgent, requestId='mac-guard-restart-'+uuid.uuid4().hex)
        self.save()

    def deliver_restart_responder(self):
        return self.deliver_responder('restartResponder')

    def deliver_strain_clears(self):
        for key in [k for k in self.saved if k.startswith('strainClearResponder:')]:
            report = self.saved[key]
            if self.muted or self.now < report.get('nextAttemptAt', 0):
                continue
            if (self.worker.get('launchUnknown')
                    and report['threadId'] == worker_thread_id(self.worker['launch']['clientRequestId'])):
                continue  # the original safety message must be accepted first
            try:
                value = self.host.worker_status(report['threadId'])
            except (ProbeError, OSError, ValueError):
                report['nextAttemptAt'] = self.now+30
                self.save()
                self.log('error', probe='worker_status', failure='unavailable', threadId=report['threadId'])
                continue
            ended = (value.get('state') == 'idle' and value.get('status') in ('completed', 'failed', 'cancelled', 'interrupted')
                     and not value.get('activeRunId') and not value.get('pendingRequests'))
            if ended:
                self.saved.pop(key)
                self.save()
            else:
                # The existing responder path retries the same send identity;
                # a lost ack never selects a different worker or creates one.
                self.deliver_responder(key)

    def deliver_responder(self, key):
        report = self.saved.get(key)
        if not report or self.muted or self.now < report.get('nextAttemptAt', 0):
            return
        report['nextAttemptAt'] = self.now+30
        self.save()
        # A lost acknowledgment may belong to a worker that has since ended.
        # Replay its original operation, without selecting a new worker.
        try:
            if report.get('launch'):
                launch = report['launch']
                if self.worker.get('threadId') != worker_thread_id(launch['clientRequestId']):
                    adopt = (self.worker.get('launch', {}).get('clientRequestId') == launch['clientRequestId']
                             or not self.worker.get('threadId') and not self.worker.get('launchUnknown'))
                    if adopt:
                        if not self.worker.get('launchUnknown'):
                            self.worker = dict(launchUnknown=True, launch=launch, startedAt=report['startedAt'])
                            write_json(self.state/'worker.json', self.worker)
                        tid = self.launch_worker(Path(report['evidence']), reconcile=True)
                    else:
                        tid = self.worker_launch_step(launch, Path(report['evidence']), reconcile=True)
                    if not tid:
                        return
                    if adopt:
                        self.worker = dict(threadId=tid, startedAt=report['startedAt'])
                        write_json(self.state/'worker.json', self.worker)
                delivered = True
            elif report.get('threadId'):
                if self.muted:
                    return
                self.host.worker_send(report['threadId'], report['evidence']+'\n'+report['summary'], report['requestId'])
                self.log('worker_steered', threadId=report['threadId'], evidence=report['evidence'])
                delivered = True
            else:
                delivered = self.worker_needed(Path(report['evidence']), report['summary'], urgent=report['urgent'],
                                               delivery=report)
        except (ProbeError, OSError, ValueError, KeyError):
            self.log('error', probe=key, failure='unavailable')
            return
        if delivered:
            self.saved.pop(key)
            self.save()
        return bool(delivered)

    def memory_event(self, p, kind, action):
        self.log('memory_runaway', pid=p['pid'], start=p['start'], comm=p['comm'], label=label(p, self.rows),
                 footprintGiB=p['footprintGiB'], compressedGiB=p.get('compressedGiB'), growthGiBMin=p['growthGiBMin'],
                 history=list(self.history[(p['pid'], p['start'])]), memoryClass=kind, action=action)

    def robob_restart(self, procs, total):
        p = max(procs, key=lambda q: q.get('footprintGiB', 0))
        path = self.snapshot('Robob memory runaway')
        reason = 'dry_run' if self.dry else 'paused' if self.muted else None
        detail = None
        unavailable = False
        if not reason and self.host.ssd_blocked():
            reason = 'ssd_read_blocked'
        if not reason and self.now-self.saved.get('lastRestartAt', 0) < 3600:
            reason = 'memory_restart_cooldown'
        if not reason:
            try:
                checks = self.host.overload()
                detail = checks.get('detail')
                if checks.get('unavailable'):
                    reason, detail, unavailable = 'restart_unavailable', checks['unavailable'], True
                elif checks.get('hold'):
                    reason = 'install_hold'
                elif checks.get('restart') or checks.get('install'):
                    reason = 'tmux_session'
                elif checks.get('building'):
                    reason = 'release_build'
                elif not checks.get('started') or not checks.get('pid'):
                    reason = 'server_start_unavailable'
                elif self.now-checks['started'] < 600:
                    reason = 'server_uptime_under_10m'
                elif checks['pid'] not in self.rows or not self.host.identity(self.rows[checks['pid']]):
                    reason = 'server_identity_changed'
            except (ProbeError, OSError, ValueError, TypeError, AttributeError) as exc:
                reason, detail, unavailable = 'restart_unavailable', str(exc), True
        log = path/'restart.log'
        if not reason and self.muted:
            reason = 'dry_run' if self.dry else 'paused'
        if unavailable or not reason:
            self.saved['lastRestartAt'] = self.now
            self.saved.pop('lastRestartFailure', None)
            if unavailable:
                self.saved['lastRestartFailure'] = detail
                self.queue_restart_responder(path, detail, urgent=True)
            else:
                self.save()
        if not reason:
            stamp = uuid.uuid4().hex
            self.saved['restartPending'] = dict(stamp=stamp, log=str(log), evidence=str(path))
            self.save()
            try:
                self.host.restart(log, stamp)
                self.restore_due.append(self.now+120)
            except (ProbeError, OSError) as exc:
                reason, detail = 'restart_launch_unknown', str(exc)
                self.saved['lastRestartFailure'] = detail
                self.saved['restartPending']['alerted'] = True
                self.queue_restart_responder(path, detail, urgent=True)
        self.memory_event(p, 'robob', 'protected_alert' if reason else 'restart')
        self.log('robob_restart', result='skipped' if reason else 'launched', reason=reason,
                 pid=p['pid'], footprintGiB=p.get('footprintGiB'), growthGiBMin=p.get('growthGiBMin'),
                 treeGiB=total, tmuxSession='mac-guard-restart', log=str(log), evidence=str(path), detail=detail)
        if reason == 'memory_restart_cooldown' and self.saved.get('lastRestartFailure'):
            return
        # The watchdog reports its result. Do not announce a restart before it
        # has accepted the request, or alert on each cycle while it is running.
        if not reason or reason == 'memory_restart_cooldown' and self.saved.get('restartPending'):
            return
        hour = iso(self.now)[:11]
        self.notify('mac-guard:robob-restart:'+hour,
                    'mac-guard %s Robob: %s at %.1f GiB (tree %.1f GiB), growing %.1f GiB/min%s' %
                    ('restart skipped for' if reason else 'restarting', p['comm'], p.get('footprintGiB', 0), total,
                     p.get('growthGiBMin', 0), '; '+reason+(': '+detail if detail else '') if reason else ''))
        if reason:
            incident = (p['pid'], p['start'], reason)
            if unavailable or reason == 'restart_launch_unknown':
                self.deliver_restart_responder()
            else:
                self.worker_needed(path, 'Robob restart skipped: '+reason, urgent=incident != self.restart_incident)
            self.restart_incident = incident

    def check_restart_result(self):
        if self.muted:
            return
        self.deliver_restart_responder()
        pending = self.saved.get('restartPending')
        if not pending:
            return
        try:
            result = self.host.restart_result(pending)
        except (ProbeError, OSError, ValueError) as exc:
            result = dict(ok=False, reason=str(exc))
        if result is None:
            return
        self.saved.pop('restartPending')
        reason = result.get('reason') or 'watchdog refused restart'
        if not result.get('ok'):
            self.saved['lastRestartFailure'] = reason
            if not pending.get('alerted'):
                # Persist the delivery obligation with removal of restartPending.
                self.queue_restart_responder(Path(pending['evidence']), reason, urgent=True)
        self.save()
        self.log('robob_restart', result='finished' if result.get('ok') else 'skipped',
                 reason=None if result.get('ok') else 'watchdog_refused', detail=reason if not result.get('ok') else None,
                 log=pending['log'], evidence=pending['evidence'])
        if not result.get('ok') and not pending.get('alerted'):
            self.notify('mac-guard:robob-restart-refused:'+iso(self.saved['lastRestartAt'])[:11],
                        'mac-guard restart skipped for Robob: '+reason)
            self.deliver_restart_responder()

    def diagnostic_trigger(self, ticks):
        # Two independent minute windows, with birth-qualified CPU deltas. No
        # kill decision consumes this diagnostic or process-R-at-zero counts.
        if self.minute is None:
            self.minute = dict(at=self.now, ticks=ticks, rows=list(self.rows.values()))
            return
        elapsed = self.now-self.minute['at']
        if elapsed < 60:
            return
        old = self.minute
        self.minute = dict(at=self.now, ticks=ticks, rows=list(self.rows.values()))
        valid = 60 <= elapsed <= 90 and ticks and old['ticks']
        idle = None
        if valid:
            diffs = [b-a for a, b in zip(old['ticks'], ticks)]
            valid = min(diffs) >= 0 and sum(diffs) > 0
            if valid:
                idle = diffs[2]*100/sum(diffs)
        severe = self.lag is not None and self.lag > 5
        trigger = valid and ((self.sample['load'][0] >= 100 and idle >= 30 and len(self.runnable) >= 64) or severe)
        self.diag_streak = self.diag_streak+1 if trigger else 0
        if not trigger:
            self.diag_episode = False
        if self.diag_streak >= 2 and not self.diag_episode:
            self.diag_episode = True
            before = {p['pid']: p for p in old['rows']}
            progress = [dict(pid=p['pid'], start=p['start'], beforeState=before[p['pid']]['state'],
                             state=p['state'], cpuS=p['cpuS']-before[p['pid']]['cpuS'], windowS=elapsed)
                        for p in self.rows.values() if p['pid'] in before and before[p['pid']]['start'] == p['start']
                        and (p['state'].startswith('R') or before[p['pid']]['state'].startswith('R'))]
            path = self.snapshot('runnable/idle diagnostic, never a kill rule')
            write_json(path/'progress60.json', dict(progress=progress, idlePct=idle))
            self.log('diagnostic', evidence=str(path), idlePct=idle, result='would_capture' if self.muted else 'capture')
            if not self.muted:
                self.host.diagnostic(path)

    def tick(self, sample, now):
        self.now, self.sample = now, sample
        last_observation = self.saved.get('lastObservationAt', self.saved.get('lastSample', now))
        # Only a completed classification can carry continuity forward. An
        # interrupted tick's intermediate saves leave the timer invalidated.
        load_only_since = self.saved.pop('loadOnlySince', None)
        if not 0 <= now-last_observation <= 60:
            load_only_since = None
        self.saved['lastObservationAt'] = now
        self.cycle += 1
        # Reconcile even after strain clears: a pending launch still owns its ID.
        if self.worker.get('launchUnknown'):
            self.launch_worker(Path(self.worker.get('evidence', self.evidence)), reconcile=True)
        if self.previous.get('at') and not 0 < now-self.previous['at'] <= 60:
            self.streak = self.calm = 0
        self.rows = {p['pid']: dict(p) for p in sample['rows']}
        for proc in list(self.rows.values()):
            proc['argsHash'] = hashlib.sha256(proc.get('args', '').encode()).hexdigest()
            if provider(proc):
                for ancestor in chain(proc, self.rows):
                    ancestor['sessionWrapper'] = True
        if 'lag' in sample:
            self.lag = sample['lag']
        for error in sample.get('errors', []):
            self.log('error', **error)
        props, self.previous = deltas(list(self.rows.values()), self.previous, now, top_limit=len(self.rows))
        self.cpu_top = sorted(props['top'], key=lambda p: -p['cpuPct'])
        cpus = {p['pid']: p['cpuPct'] for p in props['top']}
        top = {p['pid']: p for p in sample.get('top') or []}
        current = set()
        new_incidents = set()
        memory, robobs, memory4, slow = [], [], set(), []
        signals = []
        for p in self.rows.values():
            ident = (p['pid'], p['start'])
            current.add(ident)
            hist = self.history.setdefault(ident, deque(maxlen=10))
            p['cpuDelta'] = cpus.get(p['pid'], 0)
            footprint = top.get(p['pid'])
            if footprint:
                p.update(footprintGiB=footprint['memMb']/1024, compressedGiB=footprint['cmprsMb']/1024,
                         footprintObservedAt=sample.get('footprintObservedAt', now))
            p['growthGiBMin'] = 0
            # Two intervals means three observations, never a single 30s jump.
            if (len(hist) >= 2 and hist[-1]['footprintGiB'] is not None
                    and 55 <= now-hist[-2]['at'] <= 90 and footprint):
                old = hist[-2]
                if old['footprintGiB'] is not None:
                    p['growthGiBMin'] = (p['footprintGiB']-old['footprintGiB'])*60/(now-old['at'])
            prior = hist[-1] if hist else {}
            if (sample.get('pressure') == 2 and footprint and p['footprintGiB'] > 4
                    and prior.get('footprintGiB') is not None and p['footprintGiB'] > prior['footprintGiB']
                    and not protected(p, self.rows)):
                memory4.add(p['pid'])
            if footprint and (p['footprintGiB'] >= 48 or p['footprintGiB'] >= 16 and p['growthGiBMin'] >= 1):
                memory.append(p)
            hist.append(dict(at=now, cpuS=p['cpuS'], footprintGiB=p.get('footprintGiB')))
            if self.slow_sample(p, footprint):
                slow.append(p)
            if robob(p, self.rows):
                robobs.append(p)
        self.history = {k: v for k, v in self.history.items() if k in current}
        # Missing samples retain the window. A positively observed new birth
        # resets it; absent holders expire after two hours.
        self.slow_history = {k: v for k, v in self.slow_history.items() if v and v[-1]['at'] >= now-7200
                             and (k[0] not in self.rows or self.rows[k[0]]['start'] == k[1])}
        self.hogs = {k: v for k, v in self.hogs.items() if k in current}
        if sample['load'][0] >= 4*sample['ncpu']:
            signals.append(1)
        if self.lag is not None and self.lag > 5:
            signals.append(2)
        if sample['load'][0] >= 2*sample['ncpu']:
            for p in self.rows.values():
                hist = self.history[(p['pid'], p['start'])]
                stalled = (p['state'].startswith('R') and len(hist) >= 3
                           and 60 <= now-hist[-3]['at'] <= 90 and p['cpuS'] == hist[-3]['cpuS'])
                if not stalled:
                    continue
                live_agent = False
                if provider(p):
                    p['owner'] = self.host.ownership(p, self.rows, now)
                    live_agent = p['owner']['state'] == 'live'
                if robob(p, self.rows) or live_agent:
                    signals.append(3)
                    break
        if sample.get('top') is not None and (sample.get('pressure') == 4 or memory4):
            signals.append(4)
        tree_total = sum(p.get('footprintGiB', 0) for p in robobs)
        robob_trip = sample.get('top') is not None and (tree_total >= 24 or any(p in memory for p in robobs))
        if memory:
            signals.append(5)
        self.check_restart_result()
        if robob_trip:
            signals.append(6)
        slow_offenders = {p['pid'] for p in slow if not protected(p, self.rows) and not gui(p)}
        slow_strain = bool(slow_offenders) or (not memory and not robob_trip
                       and any(self.gui_allowed(p) for p in slow if gui(p)))
        if slow_strain:
            signals.append(7)
        self.runnable = [p for p in self.rows.values() if p['state'].startswith('R')]
        self.r_zero = dict(Counter(p['family'] for p in self.runnable if p['cpuDelta'] == 0))
        self.streak = self.streak+1 if signals else 0
        self.calm = 0 if signals else self.calm+1
        if not self.strain and (self.streak >= 2 or memory or robob_trip or slow_strain):
            self.strain, self.since = True, now
            self.saved.pop('strainWorker', None)
            self.log('strain_start', signals=signals)
        if self.strain and self.calm >= 10:
            self.strain = False
            self.first_action = None
            self.log('strain_clear', durationS=now-self.since, signals=[])
            path = self.snapshot('strain ended after %.0f seconds' % (now-self.since))
            # A clear only wraps up an existing worker; it never starts one.
            tid = self.worker.get('threadId')
            if not tid and self.worker.get('launchUnknown'):
                tid = worker_thread_id(self.worker['launch']['clientRequestId'])
            if tid:
                request_id = 'mac-guard-strain-clear-'+uuid.uuid4().hex
                self.saved['strainClearResponder:'+request_id] = dict(threadId=tid, evidence=str(path),
                    summary='strain ended; duration %.0f seconds' % (now-self.since), requestId=request_id)
            self.save()
            self.saved.pop('strainWorker', None)
            self.hogs = {}
        self.deliver_strain_clears()
        self.cancel_calm_kills()
        if not self.strain and self.stopped:
            remaining = []
            for p in self.stopped:
                if p['pid'] in self.rows and self.rows[p['pid']]['start'] == p['start']:
                    fresh = dict(self.rows[p['pid']], argsHash=p['argsHash'])
                    if not self.action(fresh, 'B', 'CONT'):
                        remaining.append(p)
            if not self.muted:
                self.stopped = remaining
            self.hogs = {}
        if robob_trip:
            self.robob_restart(robobs, tree_total)
        else:
            self.restart_incident = None
        pending_ids = {(e['proc']['pid'], e['proc']['start']) for e in self.pending}
        for p in memory:
            incident = (p['pid'], p['start'])
            new_incidents.add(incident)
            if robob(p, self.rows) or incident in pending_ids:
                continue
            kind = 'protected' if exempt(p, self.rows) or robob_descendant(p, self.rows) else 'carve-out'
            self.memory_event(p, kind, 'protected_alert' if kind == 'protected' else 'TERM')
            path = self.snapshot('memory runaway pid %s' % p['pid'])
            name = label(p, self.rows) or p['comm']
            key = 'mac-guard:memrunaway:%s:%s' % (name, iso(now)[:8])
            text = 'mac-guard %s %s pid %s (%s) at %.1f GiB, growing %.1f GiB/min' % (
                'protected alert for' if kind == 'protected' else 'TERMINATION_RESULT', p['comm'], p['pid'], label(p, self.rows),
                p['footprintGiB'], p['growthGiBMin'])
            if kind != 'protected' and self.terminate([p], 'D'):
                # Notifications/worker startup must not delay the ten-second KILL.
                self.pending[-1]['notice'] = dict(key=key, text=text, evidence=str(path), urgent=incident not in self.incidents)
            else:
                self.notify(key, text.replace('TERMINATION_RESULT', 'termination failed for'))
                self.worker_needed(path, '%s memory runaway pid %s' % (kind, p['pid']), urgent=incident not in self.incidents)
        self.incidents = new_incidents
        # Fast runaways take priority over bundle probes and slow-leak worker calls.
        if not memory and not robob_trip:
            self.slow_actions(slow)
        offenders = self.cpu_actions(memory4 | slow_offenders) if self.strain else 0
        load_only = (self.strain and signals == [1] and self.lag is not None and self.lag <= 5
                     and sample.get('pressure') is not None and sample['pressure'] < 4
                     and not memory and not robob_trip and not slow_strain and not offenders)
        if load_only:
            self.saved['loadOnlySince'] = load_only_since if load_only_since is not None else now
        if self.strain and not memory and not robob_trip and (not offenders or now-(self.first_action if self.first_action is not None else self.since) >= 180):
            path = self.snapshot('strain persists' if offenders else 'strain without an identified offender')
            if signals:
                summary = 'strain: signals %s; load %s; lag %s s; pressure %s' % (signals, sample['load'], self.lag, sample.get('pressure'))
                self.worker_needed(path, summary, signals=signals,
                                   allow_launch=not load_only or now-self.saved['loadOnlySince'] >= LOAD_ONLY_WORKER_DELAY)
            else:
                self.worker_skipped('empty_signals', signals, path)
        self.diagnostic_trigger(sample.get('ticks'))
        largest = max((p for p in self.rows.values() if 'footprintGiB' in p), key=lambda p: p['footprintGiB'], default={})
        summary = dict(load=sample['load'], rCount=len(self.runnable), rZeroCount=sum(self.r_zero.values()),
                       lagS=self.lag, pressure=sample.get('pressure'), swap=sample.get('swap'),
                       largest={k: largest.get(k) for k in ('pid', 'comm', 'footprintGiB', 'growthGiBMin')},
                       treeGiB=tree_total, strain=self.strain, signals=signals, cycleMs=sample.get('cycleMs', 0))
        if self.strain or self.cycle % 10 == 0:
            self.log('sample', **summary)
        if self.restore_due and now >= self.restore_due[0]:
            self.log('restore', **summary)
            self.restore_due = [at for at in self.restore_due if at > now]
        self.saved['status'] = summary
        self.save()
        return summary

    def cpu_actions(self, memory4):
        offenders = 0
        browsers = [p for p in self.rows.values() if Path(p['comm']).name == 'agent-browser-darwin-arm64']
        stopped_ids = {(p['pid'], p['start']) for p in self.stopped}
        handled = {(e['proc']['pid'], e['proc']['start']) for e in self.pending}
        for p in sorted(self.rows.values(), key=lambda p: len(chain(p, self.rows))):
            ident = (p['pid'], p['start'])
            if ident in handled or protected(p, self.rows, renice=True) or p['state'].startswith('?'):
                continue
            ancestors = chain(p, self.rows)
            browser = p in browsers
            job = bool(JOBS.fullmatch(Path(p['comm']).name)) or script_job(p)
            if not job and p.get('cpuDelta', 0) <= 100 and p['pid'] not in memory4 and ident not in self.hogs:
                continue
            if robob_descendant(p, self.rows):
                offenders += 1
                if ident not in self.hogs and self.action(p, 'B', 'renice'):
                    self.hogs[ident] = dict(stage=1, at=self.now)
                continue
            build = next((b for q in [p]+ancestors if (b := self.host.build(q, self.rows, self.now))), {}) if job else {}
            owner = self.host.ownership(p, self.rows, self.now)
            agent_work = job or owner.get('bound') or any(provider(q) for q in ancestors)
            p['owner'] = owner
            subtree = ([q for q in self.rows.values() if q['pid'] == p['pid'] or any(a['pid'] == p['pid'] for a in chain(q, self.rows))] if job else [p])
            stalled = all((q['pid'], q['start']) not in stopped_ids and len(self.history[(q['pid'], q['start'])]) >= 3
                          and 60 <= self.now-self.history[(q['pid'], q['start'])][-3]['at'] <= 90
                          and q['cpuS'] == self.history[(q['pid'], q['start'])][-3]['cpuS'] for q in subtree)
            orphan = any(q['ppid'] == 1 and (Path(q['comm']).name in ('python', 'python3', 'node', 'bun', 'bash', 'zsh', 'sh')
                         or JOBS.fullmatch(Path(q['comm']).name)) for q in [p]+ancestors)
            build_job = any(BUILD.fullmatch(Path(q['comm']).name) or script_job(q) for q in [p]+ancestors)
            build_root = self.rows.get(build.get('root', p['pid']))
            stale_build = (build.get('detached') and build.get('stale')
                           and build_root is not None and build_root['ppid'] == 1)
            stuck = job and not browser and stalled and (stale_build or owner['state'] == 'ended'
                       or orphan and not build_job and not build.get('detached'))
            leak = p in browsers and len(browsers) > 10 and p['ppid'] == 1 and seconds(p['etime']) > 3600
            if not gui(p) and (stuck or leak):
                # Never terminate an ancestor whose death would end a provider.
                # Eligible children are visited separately instead.
                if any(exempt(q, self.rows) for q in subtree):
                    continue
                targets = [q for q in subtree if not protected(q, self.rows) and not gui(q)]
                if stuck:
                    # TERM the selected root first; descendants that survive it
                    # are individually birth-checked at the ten-second deadline.
                    if self.action(p, 'A', 'TERM'):
                        due = max(self.now, self.clock())+10
                        self.pending.extend(dict(proc=dict(q), due=due, actionClass='A') for q in targets)
                else:
                    self.terminate([p], 'C')
                handled.update((q['pid'], q['start']) for q in targets)
                offenders += 1
                continue
            stage = self.hogs.get(ident)
            if stage and stage['stage'] == 2 and not self.dry:
                if not p['state'].startswith('T'):
                    # An unsent intent or external CONT cannot justify killing
                    # an idle survivor. A fresh offender must climb again.
                    stage = self.hogs[ident] = dict(stage=1, at=self.now)
                elif not stage.get('confirmed'):
                    # Delivery was interrupted/ambiguous. Start the full grace
                    # when a birth-matched ps row first proves suspension.
                    stage.update(confirmed=True, at=self.now)
            if p.get('cpuDelta', 0) <= 100 and p['pid'] not in memory4 and (stage is None or stage['stage'] != 2):
                continue
            offenders += 1
            if stage is None:
                if self.action(p, 'B', 'renice'):
                    self.hogs[ident] = dict(stage=1, at=self.now)
            elif gui(p) or owner['state'] == 'live' or agent_work and owner['state'] != 'ended':
                continue  # live or unknown build ownership permits softening only
            elif stage['stage'] == 1:
                self.action(p, 'B', 'STOP')
            elif self.now-stage['at'] >= 180:
                self.terminate([p], 'B')
        return offenders


def capture_diagnostic(path, host=None):
    host = host or Host()
    results = {}
    threads = None
    for name, argv, timeout in (
        ('threads', ['/bin/ps', '-axM'], 10),
        ('spindump', ['/usr/sbin/spindump', '-notarget', '5', '10', '-file', str(path/'spindump.txt')], 60),
        ('powermetrics', ['/usr/bin/powermetrics', '--samplers', 'cpu_power', '-n', '1'], 10)):
        try:
            output = host.cmd(argv, timeout)
            if name == 'threads':
                threads = output
            (path/(name+'-command.txt' if name == 'spindump' else name+'.txt')).write_text(output)
            results[name] = 'captured'
        except ProbeError as exc:
            results[name] = str(exc)  # no sudo; preserve unavailable QoS/core evidence honestly
    if threads:
        packet = read_json(path/'snapshot.json')
        rows = packet.get('rows', [])
        try:
            results['runnableThreadsByFamily'] = runnable_threads(threads, rows)
            props = dict(load=packet.get('load'), ncpu=packet.get('ncpu'), top=packet.get('cpuTop30', []))
            def cached_run(argv, **kw):
                return subprocess.CompletedProcess(argv, 0, threads) if argv == ['/bin/ps', '-axM'] else host.run(argv, **kw)
            write_json(path/'cpu-spike.json', spike(props, rows, cached_run))
        except (ProbeError, KeyError, ValueError):
            results['cpuSpike'] = 'unavailable'
    write_json(path/'diagnostic.json', results)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart-check', action='store_true')
    parser.add_argument('--diagnostic', type=Path)
    parser.add_argument('--app-info')
    parser.add_argument('--quit-gui')
    parser.add_argument('--worker-control', action='store_true')
    args = parser.parse_args()
    if args.app_info:
        print(json.dumps(app_info(args.app_info)))
        return
    if args.quit_gui:
        request = json_object(args.quit_gui)
        request['args'] = 'identity verified by hash'
        info = app_info(request['comm'])
        if (not info or info['bundleId'] != request['bundleId'] or info['bundleId'] in GUI_NEVER_QUIT
                or not Host().identity(request) or (Path(request['stateDir'])/'paused').exists()
                or os.environ.get('MAC_GUARD_DRY_RUN') == '1'):
            raise SystemExit(1)
        quit_gui(request['pid'])
        return
    if args.restart_check:
        print(json.dumps(overload_checks()))
        return
    if args.diagnostic:
        capture_diagnostic(args.diagnostic)
        return
    if args.worker_control:
        metrics = {}
        try:
            value = worker_control(json_object(sys.stdin.read()), metrics=metrics)
            print(json.dumps(dict(value, _durationS=metrics.get('durationS'))))
        except (ProbeError, OSError, ValueError) as exc:
            print(json.dumps(dict(failure=worker_failure(exc), status=getattr(exc, 'status', None),
                                  _durationS=metrics.get('durationS'))))
            raise SystemExit(1)
        return
    guard = Guard()
    from guard_reclaim import Reclaimer
    reclaimer = Reclaimer(guard)
    with (guard.state/'guard.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deadline = time.monotonic()
        while True:
            started = time.monotonic()
            try:
                # Consume the no-fork onset before ps/top, which can fail under load.
                reclaimer.tick(time.time())
            except (ProbeError, OSError, ValueError) as exc:
                guard.now = time.time()
                guard.log('error', probe='reclaim', failure=type(exc).__name__)
            try:
                sample = guard.host.collect(guard.cycle)
                sample['cycleMs'] = (time.monotonic()-started)*1000
                guard.tick(sample, time.time())
                if any(e['due'] <= time.time() for e in guard.pending):
                    guard.drain(time.time())
                if time.monotonic()-started > 30:
                    guard.log('error', probe='cycle', failure='overrun', cycleMs=(time.monotonic()-started)*1000)
            except (ProbeError, OSError, ValueError) as exc:
                guard.now = time.time()
                guard.log('error', probe='cycle', failure=type(exc).__name__)
            deadline = max(deadline+30, time.monotonic())
            while time.monotonic() < deadline:
                due = min((e['due'] for e in guard.pending), default=time.time()+30) if not guard.muted else time.time()+30
                time.sleep(max(.1, min(deadline-time.monotonic(), max(.1, due-time.time()))))
                if guard.pending and not guard.muted and time.time() >= due:
                    guard.drain(time.time())


if __name__ == '__main__':
    main()
