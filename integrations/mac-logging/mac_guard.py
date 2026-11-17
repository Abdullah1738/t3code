#!/usr/bin/python3
"""Thirty-second resource backstop. All destructive decisions require birth identity."""
import argparse
from collections import Counter, deque
import datetime as dt
import fcntl
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

# Helper subprocesses use -I; load only the reviewed siblings beside this file.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from cpu import PS, ProbeError, command, deltas, parse_ps, seconds, cpu_ticks, runnable_threads, spike
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
OVERLOAD_SCRIPT = Path.home() / '.robob/board-artifacts/main-thread-overload-20261113/overload-restart/robob-overload-restart.py'
WORKER = ('codex', 'gpt-6.1-sol')
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


def worker_control(request, opener=urllib.request.urlopen):
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
    try:
        with opener(req, timeout=8) as response:
            value = json_object(response.read(2_000_000).decode())
    except urllib.error.HTTPError as exc:
        value = json_object(exc.read(2_000_000).decode())
        if (request['method'] == 'GET' and exc.code == 404
                and isinstance(value.get('error'), dict) and value['error'].get('code') == 'not_found'):
            return dict(missing=True)
        raise ProbeError('worker_control_http') from None
    if value.get('ok') is False:
        raise ProbeError('worker_control_response')
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


def label(p, rows):
    return next((q['label'] for q in [p]+chain(p, rows) if q.get('label')), None)


def exempt(p, rows):
    if (label(p, rows) in MEMORY_EXEMPT['service_labels'] or p.get('sessionWrapper')
            or p['pid'] == os.getpid() or system(p) or provider(p) or robob(p, rows)):
        return True
    # Interpreter wrappers above a provider must never be killed as a tree root.
    return False


def protected(p, rows):
    return exempt(p, rows) or bool(label(p, rows)) or 'cua-driver' in p['comm']


def gui(p):
    return '.app/' in p['comm'] and p['comm'].startswith('/Applications/') and not JOBS.fullmatch(Path(p['comm']).name)


def overload_checks(path=OVERLOAD_SCRIPT):
    """Called in a deadline-bounded subprocess, so imports/helpers cannot stall the loop."""
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
        try:
            raw = self.cmd(['/bin/ps', '-ww', '-p', str(p['pid']), '-o', 'lstart=,comm='], 2).strip()
            parts = raw.split(None, 5)
            same = len(parts) == 6 and ' '.join(parts[:5]) == p['start'] and parts[5] == p['comm']
            if not same or not p.get('args'):
                return False
            args = self.cmd(['/bin/ps', '-ww', '-p', str(p['pid']), '-o', 'lstart=,args='], 2).strip().split(None, 5)
            return (len(args) == 6 and ' '.join(args[:5]) == p['start']
                    and hashlib.sha256(args[5].encode()).hexdigest() == p.get('argsHash', hashlib.sha256(p['args'].encode()).hexdigest()))
        except ProbeError:
            return False

    def same_birth(self, p):
        try:
            start = self.cmd(['/bin/ps', '-p', str(p['pid']), '-o', 'lstart='], 2).strip()
            return start == p['start']
        except ProbeError as exc:
            return False if str(exc) == 'exit' else None

    def signal(self, p, sig):
        os.kill(p['pid'], sig)

    def soften(self, p):
        self.cmd(['/usr/bin/renice', '20', '-p', str(p['pid'])], 2)
        # Revalidate between commands too.
        if self.identity(p):
            self.cmd(['/usr/bin/taskpolicy', '-b', '-p', str(p['pid'])], 2)

    def notify(self, key, text):
        self.cmd([str(Path.home()/'.bun/bin/bun'), str(Path.home()/'.local/share/telegram-bridge/src/cli.ts'),
                  'notify', '--source', 'Mac guard', '--severity', 'attention', '--text', text, '--key', key])

    def overload(self):
        return json_object(self.cmd(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--restart-check'], 20))

    def restart(self, log):
        cmd = '/usr/bin/python3 -I %s restart 2>&1 | /usr/bin/tee -a %s' % (shlex.quote(str(OVERLOAD_SCRIPT)), shlex.quote(str(log)))
        self.cmd([TMUX, '-L', 'restart', 'new-session', '-d', '-s', 'robob-restart', cmd], 20)

    def worker_status(self, tid):
        value = json_object(self.cmd([T3CTL, 'status', tid], 5))
        value = value.get('thread', value)
        if not isinstance(value, dict):
            raise ValueError('unreadable thread')
        return value

    def worker_send(self, tid, text):
        self.cmd([T3CTL, 'send', tid, text], 5)

    def worker_request(self, method, path, body=None):
        try:
            result = self.run(['/usr/bin/python3', '-I', str(Path(__file__).resolve()), '--worker-control'],
                              input=json.dumps(dict(method=method, path=path, body=body)), capture_output=True,
                              text=True, timeout=10, env={k: v for k, v in os.environ.items() if k != 'BUN_INSPECT'})
        except (subprocess.TimeoutExpired, OSError):
            raise ProbeError('worker_control_unavailable') from None
        if result.returncode:
            raise ProbeError('worker_control_unavailable')
        return json_object(result.stdout)

    def worker_lookup(self, request_id):
        value = self.worker_request('GET', '/threads/'+urllib.parse.quote(worker_thread_id(request_id), safe=''))
        if value.get('missing') is True:
            return None
        thread = value.get('thread', value)
        if not isinstance(thread, dict) or thread.get('threadId') != worker_thread_id(request_id):
            raise ValueError('unreadable launch correlation')
        return thread['threadId']

    def worker_create(self, launch):
        value = self.worker_request('POST', '/threads', launch)
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
        comms = {int(line.split(None, 1)[0]): line.split(None, 11)[11].strip().strip('()')
                 for line in raw.splitlines() if len(line.split(None, 11)) == 12 and line.split()[0].isdigit()}
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
            p.update(comm=comms.get(p['pid'], ''), label=labels.get(p['pid']))
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
                snapshot[key] = parser(self.cmd(argv, timeout))
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
    def __init__(self, host=None, state=STATE, evidence=EVIDENCE, dry=None, logger=emit, clock=time.time):
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
                          hogs=[dict(pid=pid, start=start, **v) for (pid, start), v in self.hogs.items()],
                          restoreDue=self.restore_due, lastSample=self.now, strain=self.strain, strainSince=self.since)
        write_json(self.state/'state.json', self.saved)

    def snapshot(self, summary):
        path = self.evidence/(iso(self.now)+'-%04d' % self.cycle)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        value = dict(self.sample, summary=summary, actions=list(self.actions),
                     history={str(pid): list(h) for (pid, _), h in self.history.items() if pid in self.rows},
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
        if current and current['start'] == p['start'] and current['comm'] == p['comm']:
            # Saved argv is redacted. Classify fresh argv, but verify the hash
            # captured when this action was authorized across daemon restarts.
            p = dict(p, args=current.get('args', ''), sessionWrapper=current.get('sessionWrapper', False))
        allowed = cls not in ('A', 'B', 'C') or self.strain or action == 'CONT'
        result, errno = ('cancelled_strain_clear' if not allowed else 'would_'+action if self.muted else 'skipped_identity'), None
        stop_intent, prior_stage = False, None
        if (allowed and not self.muted and p['pid'] in self.rows and self.rows[p['pid']]['start'] == p['start']
                and not exempt(p, self.rows) and not p['state'].startswith('?') and self.host.identity(p) and not self.muted):
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
                    self.host.soften(p)
                else:
                    self.host.signal(p, getattr(signal, 'SIG'+action))
                    if action == 'STOP':
                        self.hogs[ident].update(confirmed=True, at=max(self.now, self.clock()))
                result = 'sent'
            except (ProbeError, OSError) as exc:
                result, errno = 'error', getattr(exc, 'errno', None)
                if stop_intent:
                    self.stopped = [q for q in self.stopped if (q['pid'], q['start']) != ident]
                    if prior_stage is None:
                        self.hogs.pop(ident, None)
                    else:
                        self.hogs[ident] = prior_stage
                    self.save()
        value = dict(pid=p['pid'], start=p['start'], comm=p['comm'], args=command_label(p.get('args', '')),
                     action=action, result=result, errno=errno, actionClass=cls, owner=p.get('owner', {}).get('state', 'unknown'),
                     cpuDelta=p.get('cpuDelta', 0), footprintGiB=p.get('footprintGiB'))
        self.actions.append(value)
        self.log('action', **value)
        performed = result == 'sent' or self.dry and allowed
        if performed:
            if self.strain and self.first_action is None:
                self.first_action = self.now
            if not self.restore_due:
                self.restore_due.append(self.now+120)
            if action == 'STOP' and self.dry:
                self.stopped.append(dict(p))
                self.hogs[(p['pid'], p['start'])] = dict(stage=2, at=self.now, confirmed=True)
        return performed

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

    def launch_worker(self, path, adopted=False):
        if self.muted:
            return
        self.worker['nextReconcileAt'] = self.now+30
        write_json(self.state/'worker.json', self.worker)
        try:
            tid = self.host.worker_create(self.worker['launch'])
            self.worker = dict(threadId=tid, startedAt=self.worker['startedAt'])
            write_json(self.state/'worker.json', self.worker)
            self.log('worker_spawned', threadId=tid, evidence=str(path), result='adopted' if adopted else 'sent')
            return tid
        except (ProbeError, OSError, ValueError, KeyError):
            self.log('error', probe='worker_create', failure='unknown')

    def worker_needed(self, path, summary, urgent=False):
        if self.muted:
            self.log('worker_steered' if self.worker.get('threadId') else 'worker_spawned',
                     result='would_act', evidence=str(path), summary=summary)
            return
        if self.worker.get('launchUnknown'):
            if self.now < self.worker.get('nextReconcileAt', 0):
                return
            self.worker['nextReconcileAt'] = self.now+30
            write_json(self.state/'worker.json', self.worker)
            try:
                tid = self.host.worker_lookup(self.worker['launch']['clientRequestId'])
            except (ProbeError, OSError, ValueError, KeyError):
                self.log('error', probe='worker_reconcile', failure='unavailable')
                return
            if self.muted:
                return
            # Thread creation precedes initial-message acceptance. Replay the
            # same command even for a found thread, and retain the full safety
            # prompt until the server confirms its durable initial run. The
            # shared command/message IDs also deduplicate a late first request.
            if not self.launch_worker(path, adopted=tid is not None):
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
                try:
                    self.host.worker_send(tid, str(path)+'\n'+summary)
                    self.log('worker_steered', threadId=tid, evidence=str(path))
                except (ProbeError, OSError):
                    self.log('error', probe='worker_send', failure='unavailable')
                return
            self.worker.pop('threadId', None)
            self.worker['endedAt'] = self.now
            write_json(self.state/'worker.json', self.worker)
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
        write_json(self.state/'worker.json', self.worker)
        self.launch_worker(path)

    def memory_event(self, p, kind, action):
        self.log('memory_runaway', pid=p['pid'], start=p['start'], comm=p['comm'], label=label(p, self.rows),
                 footprintGiB=p['footprintGiB'], compressedGiB=p.get('compressedGiB'), growthGiBMin=p['growthGiBMin'],
                 history=list(self.history[(p['pid'], p['start'])]), memoryClass=kind, action=action)

    def robob_restart(self, procs, total):
        p = max(procs, key=lambda q: q.get('footprintGiB', 0))
        path = self.snapshot('Robob memory runaway')
        reason = 'dry_run' if self.dry else 'paused' if self.muted else None
        if not reason and self.now-self.saved.get('lastRestartAt', 0) < 3600:
            reason = 'memory_restart_cooldown'
        if not reason:
            try:
                checks = self.host.overload()
                if checks.get('hold'):
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
            except (ProbeError, OSError, ValueError, TypeError, AttributeError):
                reason = 'restart_unavailable'
        log = OVERLOAD_SCRIPT.parent/('restart-memory-'+iso(self.now)+'.log')
        if not reason and self.muted:
            reason = 'dry_run' if self.dry else 'paused'
        if not reason:
            self.saved['lastRestartAt'] = self.now
            self.save()
            try:
                self.host.restart(log)
                self.restore_due.append(self.now+120)
            except (ProbeError, OSError):
                reason = 'restart_launch_unknown'
        self.memory_event(p, 'robob', 'protected_alert' if reason else 'restart')
        self.log('robob_restart', result='skipped' if reason else 'launched', reason=reason,
                 pid=p['pid'], footprintGiB=p.get('footprintGiB'), growthGiBMin=p.get('growthGiBMin'),
                 treeGiB=total, tmuxSession='robob-restart', log=str(log), evidence=str(path))
        hour = iso(self.now)[:11]
        self.notify('mac-guard:robob-restart:'+hour,
                    'mac-guard %s Robob: %s at %.1f GiB (tree %.1f GiB), growing %.1f GiB/min%s' %
                    ('restart skipped for' if reason else 'restarting', p['comm'], p.get('footprintGiB', 0), total,
                     p.get('growthGiBMin', 0), '; '+reason if reason else ''))
        if reason:
            incident = (p['pid'], p['start'], reason)
            self.worker_needed(path, 'Robob restart skipped: '+reason, urgent=incident != self.restart_incident)
            self.restart_incident = incident

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
        self.cycle += 1
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
        memory, robobs, memory4 = [], [], set()
        signals = []
        for p in self.rows.values():
            ident = (p['pid'], p['start'])
            current.add(ident)
            hist = self.history.setdefault(ident, deque(maxlen=10))
            p['cpuDelta'] = cpus.get(p['pid'], 0)
            footprint = top.get(p['pid'])
            if footprint:
                p.update(footprintGiB=footprint['memMb']/1024, compressedGiB=footprint['cmprsMb']/1024)
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
            if robob(p, self.rows):
                robobs.append(p)
        self.history = {k: v for k, v in self.history.items() if k in current}
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
        if robob_trip:
            signals.append(6)
        self.streak = self.streak+1 if signals else 0
        self.calm = 0 if signals else self.calm+1
        if not self.strain and (self.streak >= 2 or memory or robob_trip):
            self.strain, self.since = True, now
            self.log('strain_start', signals=signals)
        if self.strain and self.calm >= 10:
            self.strain = False
            self.first_action = None
            self.log('strain_clear', durationS=now-self.since, signals=[])
            self.hogs = {}
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
        self.runnable = [p for p in self.rows.values() if p['state'].startswith('R')]
        self.r_zero = dict(Counter(p['family'] for p in self.runnable if p['cpuDelta'] == 0))
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
            kind = 'protected' if exempt(p, self.rows) else 'carve-out'
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
        offenders = self.cpu_actions(memory4) if self.strain else 0
        if self.strain and not memory and not robob_trip and (not offenders or now-(self.first_action if self.first_action is not None else self.since) >= 180):
            path = self.snapshot('strain persists' if offenders else 'strain without an identified offender')
            self.worker_needed(path, 'strain: signals '+str(signals))
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
            if ident in handled or protected(p, self.rows) or p['state'].startswith('?'):
                continue
            ancestors = chain(p, self.rows)
            browser = p in browsers
            job = bool(JOBS.fullmatch(Path(p['comm']).name)) or script_job(p)
            if not job and p.get('cpuDelta', 0) <= 100 and p['pid'] not in memory4 and ident not in self.hogs:
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
    parser.add_argument('--worker-control', action='store_true')
    args = parser.parse_args()
    if args.restart_check:
        print(json.dumps(overload_checks()))
        return
    if args.diagnostic:
        capture_diagnostic(args.diagnostic)
        return
    if args.worker_control:
        try:
            print(json.dumps(worker_control(json_object(sys.stdin.read()))))
        except (ProbeError, OSError, ValueError):
            raise SystemExit(1)
        return
    guard = Guard()
    with (guard.state/'guard.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        deadline = time.monotonic()
        while True:
            started = time.monotonic()
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
