"""Consume host.overload transitions; never infer overload from host counters."""
import ctypes as c
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid

from cpu_labels import command_label, bounded_detail
from cpu import ProbeError, failure_details

INTERVAL = 1200
FRESH = 180
MIN_FREED_MB = 1024
NEVER = ['offbox wait/_bg-queue holders and descendants', 'Robob app/server',
         'provider sessions and their wrappers', 'OpenCode service', 'macOS system processes',
         'Dia', 'Messages', 'host-vitals sampler and mac-guard', 'unknown process identity or ancestry']
LOG_KEYS = set('cpuPct cpuBasis passId step result reason trigger phase onset ts durationS conditions evidence pid ppid start comm args family ancestors rssBeforeMb rssAfterMb freedRssMb janitor gui renice before after swapUsedBytes swapTotalBytes pressureLevel workerStarted workerDelivered threadId partial errors observedAt completedAt niceBefore niceAfter count returncode'.split())
LOG_KEYS.update('stages stage identityRead identityRecheck getpriority setpriority readBack taskpolicy same errno rc stderr strerror'.split())
LOG_KEYS.update(('report', 'problems', 'phaseMs'))


def log_fields(value, depth=0):
    if depth > 8:
        return None
    if isinstance(value, dict):
        result = {}
        for k, v in value.items():
            if k not in LOG_KEYS:
                continue
            if k == 'phaseMs':
                from toollog import safe_fields
                result[k] = safe_fields({'phase_ms':v}, 'janitor.run').get('phase_ms', {})
            elif k == 'problems':
                result[k] = [bounded_detail(str(p)) for p in v[:5]] if isinstance(v, list) else []
            elif k in ('reason', 'stderr', 'strerror') and isinstance(v, str):
                result[k] = bounded_detail(v)
            else:
                result[k] = log_fields(v, depth+1)
        return result
    if isinstance(value, (list, tuple)):
        return [log_fields(v, depth+1) for v in value[:128]]
    if isinstance(value, str):
        return command_label(value)
    if value is None or type(value) in (int, bool):
        return value
    if type(value) is float and abs(value) < float('inf'):
        return value
    return None


def timestamp(value):
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError, TypeError):
        return 0


def transition_order(row):
    props = row.get('props', {})
    if not isinstance(props, dict):
        return (0, 0)
    onset = timestamp(props.get('onset'))
    duration = props.get('durationS')
    phase = props.get('phase')
    rank = {'onset':1, 'peak':2, 'end':3}.get(phase, 0)
    if (not onset or not rank or type(duration) not in (int, float)
            or not math.isfinite(duration) or duration < 0):
        return (0, 0)
    # A retried outbox entry receives a fresh write timestamp. Its logical
    # transition time does not move; an end wins a tie over a peak/onset.
    return (onset+duration, rank)


def latest_rows(root, now, limit=4*1024*1024):
    """Bound disk work even when another sampler floods the day file."""
    result = {}
    for day in (now-86400, now):
        name = dt.datetime.fromtimestamp(day, dt.timezone.utc).date().isoformat()+'.ndjson'
        try:
            with (root/name).open('rb') as stream:
                stream.seek(0, 2)
                size = stream.tell()
                stream.seek(max(0, size-limit))
                if size > limit:
                    stream.readline()
                data = stream.read(limit)
        except FileNotFoundError:
            continue
        for line in data.splitlines():
            try:
                row = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(row, dict):
                continue
            key = row.get('name')
            if key not in ('host.overload', 'host.vitals', 'host.families_lite', 'host.spawn_sample'):
                continue
            prior = result.get(key, {})
            order = transition_order(row) if key == 'host.overload' else (timestamp(row.get('ts')), 0)
            old_order = transition_order(prior) if key == 'host.overload' else (timestamp(prior.get('ts')), 0)
            if 0 < order[0] <= now+5 and order >= old_order:
                result[key] = row
    return result


def words(p):
    try:
        return shlex.split(p.get('args', ''))
    except ValueError:
        return []


def heavy(p):
    argv = words(p)
    if not argv:
        return None
    name = Path(p['comm']).name.lower()
    interpreted = bool(re.fullmatch(r'(?:node|bun|python(?:3(?:\.\d+)?)?|vp|npx)', name))
    # Only executable/script slots are examined, never later prompt arguments.
    command = argv[1:] if interpreted else argv
    if name.startswith('python'):
        from host import python_label
        if python_label(argv) in ('python:unittest', 'python:pytest'):
            return 'python-tests'
        while command and command[0] in ('-I', '-B', '-u', '-E', '-s'):
            command = command[1:]
        if command[:2] in (['-m', 'unittest'], ['-m', 'pytest']):
            return 'python-tests'
        if command and Path(command[0]).name in ('pytest', 'py.test'):
            return 'python-tests'
        if command and '/mac-logging/' in command[0] and command[0].endswith('.py'):
            return 'mac-upkeep'
        if command and re.fullmatch(r'test_[\w.-]+\.py', Path(command[0]).name):
            return 'python-tests'
        return None
    if name in ('node', 'bun'):
        while command and command[0].startswith('-'):
            flag = command.pop(0)
            if re.fullmatch(r'--(?:max-old-space-size|max_old_space_size|stack-size)=\d+', flag):
                continue
            if flag in ('--max-old-space-size', '--max_old_space_size', '--stack-size') and command and command[0].isdigit():
                command.pop(0)
                continue
            if flag == '--':
                break
            return None
    if not command:
        return None
    tool = Path(command[0]).name
    tail = command[1:]
    if tool in ('vitest', 'vitest.mjs', 'jest', 'jest.js', 'pytest', 'py.test', 'tsc', 'tsc.js', 'webpack.js', 'electron-builder', 'esbuild', 'webpack', 'rustc', 'xcodebuild',
                'SWBBuildService', 'XCBBuildService', 'clang', 'clang++', 'swift-frontend'):
        return tool
    if interpreted and re.fullmatch(r'(?:build|test)(?:-[a-z0-9-]+)?\.(?:ts|js|mjs|cjs)', tool):
        return 'local-build-test-script'
    if name == 'vp' and argv[1:2] == ['test']:
        return 'vp-test'
    if name == 'vp' and argv[1:2] == ['run'] and argv[2:3] in (['build'], ['test'], ['typecheck']):
        return 'vp-'+argv[2]
    if tool in ('vite', 'vite.js', 'vp', 'next') and 'build' in tail[:2]:
        return tool+'-build'
    if name == 'vp' and 'build' in argv[1:3]:
        return 'vp-build'
    if tool in ('cargo', 'go') and tail and tail[0] in ('build', 'test', 'check', 'clippy', 'rustc'):
        return tool+'-'+tail[0]
    # npm's electron-builder entrypoint is cli.js, not electron-builder.
    if tool in ('cli.js', 'cli.cjs') and '/electron-builder/' in command[0]:
        return 'electron-builder'
    return None


def census_family(p, rows, guard, now):
    from mac_guard import provider
    argv = words(p)
    parent = rows.get(p.get('ppid'))
    shell = Path(p['comm']).name in ('zsh', 'bash')
    body = next((argv[i+1] for i,arg in enumerate(argv[:-1]) if arg in ('-c', '-lc', '-ic')), '')
    spin = re.search(r'(?:^|[;\s])read\s+(?=[^;\n]*\s?-t\s*\d)(?=[^;\n]*<\s*/dev/zero(?:\s|;|$))', body)
    if shell and parent and provider(parent) and spin:
        prior = getattr(guard, 'previous', {})
        old = prior.get('processes', {}).get(str(p['pid']), {})
        at = prior.get('at', 0)
        birth = time.strftime('%a %b %d %H:%M:%S %Y', time.localtime(p['start'][0]))
        same = ' '.join(birth.split()) == ' '.join(str(old.get('start', '')).split())
        if same and 0 < now-at <= 60 and p['cpuS'] >= old.get('cpuS', float('inf')):
            pct, basis = (p['cpuS']-old['cpuS'])*100/(now-at), 'recent'
        else:
            age = now-p['start'][0]-p['start'][1]/1000000
            pct, basis = (p['cpuS']*100/age if age > 0 else 0), 'lifetime'
        p.update(cpuPct=pct, cpuBasis=basis)
        return 'busy-wait tool shell' if pct >= 25 else 'tool shell reading /dev/zero'
    return heavy(p) or p.get('family')


def protection(p, rows, guard):
    lineage = [p]+guard_chain(p, rows)
    if any(re.search(r'(?:^|[/\s])offbox(?:\.py)?(?:\s|$)', q.get('args', '')) for q in lineage):
        return 'offbox-holder-or-work'
    if p.get('uid') != os.getuid() or p['pid'] <= 1:
        return 'system-or-foreign-user'
    if not p.get('args') or not p.get('comm') or not p.get('start'):
        return 'unknown-identity'
    # Builds below a provider are eligible; providers themselves and shell
    # session wrappers stay protected. Never propagate protection to all builds.
    if any('/mac-logging/' in arg and Path(arg).name in ('host.py', 'mac_guard.py', 'guard_reclaim.py') for arg in words(p)):
        return 'guard-or-host-sampler'
    if guard(p, rows):
        return 'protected'
    if any(q.get('sessionWrapper') for q in [p]):
        return 'session-wrapper'
    if '.app/' in p['comm'] and not heavy(p):
        return 'gui'
    last = lineage[-1]
    if last['pid'] != 1 and last.get('ppid') != 1:
        return 'unknown-ancestry'
    if any(not q.get('args') or not q.get('comm') for q in lineage if q['pid'] != 1):
        return 'unknown-ancestor'
    return None


def guard_chain(p, rows):
    seen, chain = {p['pid']}, []
    while p['ppid'] in rows and p['ppid'] not in seen:
        p = rows[p['ppid']]
        seen.add(p['pid'])
        chain.append(p)
    return chain


class Darwin:
    """Small libproc census and birth-checked setpriority; no ps/taskpolicy forks."""
    def __init__(self):
        from host_native import Native
        self.native = Native()
        self.native.proc.proc_pidpath.argtypes = (c.c_int, c.c_void_p, c.c_uint32)
        self.native.proc.proc_pidpath.restype = c.c_int

    def row(self, pid):
        from host_native import BsdInfo
        bsd = self.native.info(pid, 3, BsdInfo)
        buf = c.create_string_buffer(4096)
        c.set_errno(0)
        n = self.native.proc.proc_pidpath(pid, buf, len(buf))
        if n <= 0:
            number = c.get_errno()
            raise OSError(number or None, os.strerror(number) if number else 'path unavailable')
        if bsd.pid != pid or n <= 0 or n >= len(buf):
            raise OSError('identity unavailable')
        args = shlex.join(self.native.argv(pid))
        task = self.native.task(pid)
        again = self.native.bsd(pid)
        if again['start'] != (bsd.startSec, bsd.startUsec):
            raise OSError('birth changed')
        return dict(pid=pid, ppid=bsd.ppid, start=[bsd.startSec, bsd.startUsec], uid=bsd.uid,
                    comm=os.fsdecode(buf.value), args=args, rssMb=task['rssBytes']/1048576,
                    cpuS=task['cpuNs']/1e9, nice=bsd.nice, family=Path(os.fsdecode(buf.value)).name)

    def census(self, budget=2):
        deadline = time.monotonic()+budget
        rows, errors = {}, []
        pids = self.native.pids(deadline=deadline)
        for pid in pids:
            if time.monotonic() >= deadline:
                errors.append('census-budget')
                break
            try:
                rows[pid] = self.row(pid)
            except (OSError, ValueError, UnicodeError):
                errors.append('identity-unavailable')
        return rows, dict(partial=bool(errors), count=len(rows), errors=sorted(set(errors)))

    def rss(self, rows):
        result = {}
        deadline = time.monotonic()+2
        for pid, p in rows.items():
            if time.monotonic() >= deadline:
                break
            try:
                birth = self.native.bsd(pid)['start']
                if list(birth) == p['start']:
                    result[pid] = self.native.task(pid)['rssBytes']/1048576
            except OSError:
                # Only a confirmed absent PID counts as reclaimed; permission
                # failures and unreadable counters remain unknown.
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    result[pid] = 0
                except OSError:
                    pass
        return result

    def soften(self, p):
        stages = {name:dict(result='skipped', reason='prior-stage-failed')
                  for name in ('identityRead', 'getpriority', 'setpriority', 'readBack')}
        outcome = dict(stages=stages)
        operations = (
            ('identityRead', lambda:self.row(p['pid'])),
            ('getpriority', lambda:os.getpriority(os.PRIO_PROCESS, p['pid'])),
            # Absolute nice 10: repeated passes never ratchet a job to 20.
            ('setpriority', lambda:os.setpriority(os.PRIO_PROCESS, p['pid'], max(10, outcome['niceBefore']))),
            ('readBack', lambda:os.getpriority(os.PRIO_PROCESS, p['pid'])))
        for stage, operation in operations:
            try:
                value = operation()
            except (OSError, ValueError) as exc:
                failure = failure_details(exc, stage)
                stages[stage] = failure
                return dict(outcome, stage=stage, **failure)
            stages[stage] = dict(result='sent')
            if stage == 'identityRead':
                same = all(value[k] == p[k] for k in ('start', 'comm', 'args', 'ppid', 'uid'))
                stages[stage]['same'] = same
                if not same:
                    stages[stage]['result'] = 'identity-changed'
                    return dict(outcome, result='identity-changed')
            elif stage == 'getpriority':
                outcome['niceBefore'] = value
            elif stage == 'readBack':
                outcome['niceAfter'] = value
        return dict(outcome, result='sent')


def janitor_report(path, started):
    try:
        with path.open('rb') as stream:
            raw = stream.read(1024*1024+1)
        if len(raw) > 1024*1024:
            return dict(report='missing')
        report = json.loads(raw)
        if not isinstance(report, dict):
            return dict(report='missing')
    except (OSError, ValueError, UnicodeError):
        return dict(report='missing')
    observed = report.get('ts')
    if type(observed) not in (int, float) or not math.isfinite(observed) or observed < started:
        return dict(report='stale')
    processes = report.get('processes', {})
    processes = processes if isinstance(processes, dict) else {}
    problems = processes.get('problems', [])
    problems = list(problems) if isinstance(problems, list) else []
    summary = processes.get('mcp_summary', {})
    reason = summary.get('reason') if isinstance(summary, dict) else None
    if reason and reason not in problems:
        problems.append(reason)
    value = log_fields(dict(problems=problems, phaseMs=report.get('phase_ms', {})))
    return dict(value, report='fresh', **(dict(result='inventory-unavailable') if problems else {}))


def run_janitor(run=subprocess.run, home=None, clock=time.time):
    home = Path(home or Path.home())
    scripts = Path(os.environ.get('DEV_JANITOR_SCRIPT_DIR', str(home/'.config/opencode/skills/dev-resource-janitor/scripts')))
    log_dir = Path(os.environ.get('DEV_JANITOR_LOG_DIR', str(home/'.local/share/dev-janitor')))
    state = Path(os.environ.get('DEV_JANITOR_WATCH_STATE', str(log_dir/'hourly')))
    env = {k:v for k,v in os.environ.items() if k != 'BUN_INSPECT'}
    # Match janitor_watch.sh defaults; an explicit disable remains respected.
    for key in ('DEV_JANITOR_REAP_AGENT_BROWSER', 'DEV_JANITOR_STOP_XCODE_BUILDS'):
        env.setdefault(key, '1')
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state/'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return dict(result='already-running')
        # Use the installed normal worker and the SAME hourly lock. Calling
        # `check` would detach an unbounded worker and bypass our 120s bound.
        started = clock()
        try:
            result = run([env.get('DEV_JANITOR_PYTHON', '/opt/homebrew/bin/python3'),
                          str(scripts/'janitor_watch.py'), 'worker', str(lock.fileno())],
                         pass_fds=(lock.fileno(),), timeout=120, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env=env)
            outcome = dict(result='completed' if result.returncode == 0 else 'failed', returncode=result.returncode)
        except subprocess.TimeoutExpired:
            outcome = dict(result='timeout')
        except OSError:
            outcome = dict(result='unavailable')
        report = janitor_report(log_dir/'last.json', started)
        if outcome['result'] == 'timeout':
            report.pop('result', None)
        return dict(outcome, **report)


class Reclaimer:
    def __init__(self, guard, root=None, native=None, janitor=run_janitor):
        self.guard = guard
        self.root = Path(root or os.environ.get('TOOLLOG_DIR', str(Path.home()/'.robob/logs/tools/mac')))
        self.native = native
        self.janitor = janitor
        self.path = guard.state/'reclaim.json'
        self.last_worker_started = False
        from mac_guard import read_json
        self.state = read_json(self.path)

    def save(self):
        from mac_guard import write_json
        if not self.guard.dry:
            write_json(self.path, self.state)

    def log(self, **props):
        g = self.guard
        props = log_fields(props)
        g.logger('mac-guard', 'event', 'guard.reclaim', props=props,
                 now=dt.datetime.fromtimestamp(g.now, dt.timezone.utc))
        if not g.dry:
            with (g.state/'guard.log').open('a') as stream:
                os.chmod(g.state/'guard.log', 0o600)
                stream.write(json.dumps(dict(ts=g.now, **props))+'\n')

    def tick(self, now, latest=None):
        g = self.guard
        g.now = now
        latest = latest if latest is not None else latest_rows(self.root, now)
        for key in sorted(k for k in g.saved if k.startswith('overloadResponder:'))[:1]:
            self.deliver(key)
        vitals = latest.get('host.vitals', {})
        pending = self.state.get('pendingSummary')
        if pending and timestamp(vitals.get('ts')) > pending['completedAt']:
            self.log(**dict(pending, after=vitals.get('props', {}), result='next-vitals'))
            self.state.pop('pendingSummary')
            self.save()
        event = latest.get('host.overload', {})
        props = event.get('props', {})
        phase, onset = props.get('phase'), props.get('onset')
        at = transition_order(event)[0]
        if phase == 'end' and 0 < at <= now+5 and timestamp(onset) > self.state.get('closedOnset', 0):
            self.state['closedOnset'] = timestamp(onset)
            self.save()
        if (timestamp(onset) <= self.state.get('closedOnset', 0)
                or not timestamp(onset) or timestamp(onset) > at or phase not in ('onset', 'peak')
                or not 0 <= now-at <= FRESH):
            return
        key = (onset, at, phase)
        if list(key) == self.state.get('seen'):
            return
        last = self.state.get('lastAt')
        reason = None
        if g.muted:
            reason = 'paused-or-dry'
        elif last is not None and now-last < INTERVAL:
            reason = 'rate-limit'
        elif phase == 'peak' and (now-timestamp(onset) < INTERVAL or self.state.get('onset') != onset
                                 or self.state.get('freedRssMb', 0) >= MIN_FREED_MB):
            reason = 'peak-ineligible'
        if reason:
            self.log(step='decision', trigger=props, result=reason)
            # A peak may arrive before 20 minutes from the guard's delayed
            # onset pass. Keep it retryable; the sampler may emit no newer peak.
            if not g.muted and not (phase == 'peak' and reason == 'rate-limit'):
                self.state['seen'] = list(key)
                self.save()
            return
        # Reserve before running anything; a crash cannot repeat a janitor pass.
        self.state.update(lastAt=now, onset=onset, seen=list(key), freedRssMb=0)
        self.save()
        self.run(event, latest)

    def run(self, event, latest):
        g = self.guard
        pass_id = 'overload-'+str(int(g.now))
        path = g.evidence/pass_id
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        from mac_guard import write_json, protected
        steps = {}
        census = dict(janitorAudit=str(Path.home()/'.local/share/dev-janitor/audit.jsonl'), trigger=event, families=latest.get('host.families_lite'),
                      spawn=latest.get('host.spawn_sample'), vitals=latest.get('host.vitals'), neverTouch=NEVER,
                      steps=steps, processes=[], censusErrors=[])
        native = self.native
        try:
            native = native or Darwin()
            rows, info = native.census()
            census['census'] = info
        except (OSError, ValueError):
            rows = {}
            census['censusErrors'].append('native-census-unavailable')
        for p in rows.values():
            family = census_family(p, rows, g, g.clock())
            census['processes'].append(dict(p, args=command_label(p['args']),
                reason=protection(p, rows, protected), family=family))
        def rss(selected=None):
            try:
                return native.rss(rows if selected is None else selected) if native else {}
            except (OSError, ValueError):
                census['censusErrors'].append('rss-unavailable')
                return {}
        vitals_row = latest.get('host.vitals', {})
        def vitals():
            nonlocal vitals_row
            try:
                current = latest_rows(self.root, g.clock()).get('host.vitals', {})
                if timestamp(current.get('ts')) >= timestamp(vitals_row.get('ts')):
                    vitals_row = current
            except (OSError, ValueError):
                census['censusErrors'].append('vitals-unavailable')
            props = vitals_row.get('props', {})
            return dict(observedAt=vitals_row.get('ts'),
                        **{k:props.get(k) for k in ('swapUsedBytes', 'swapTotalBytes', 'pressureLevel')})
        def rung(step, action):
            host_before = vitals()
            before = rss()
            try:
                value = action()
            except (ProbeError, OSError, ValueError, subprocess.SubprocessError) as exc:
                value = dict(result=type(exc).__name__)
            after = rss()
            measured = {pid for pid in before if pid in after}
            freed = sum(max(0, before[pid]-after[pid]) for pid in measured)
            evidence = [dict(pid=pid, start=rows[pid]['start'], args=command_label(rows[pid]['args']),
                             family=rows[pid]['family'], rssBeforeMb=before[pid], rssAfterMb=after[pid])
                        for pid in measured if before[pid] != after[pid]]
            steps[step] = dict(value, freedRssMb=freed, partial=len(measured) != len(rows), processes=evidence,
                               before=host_before, after=vitals())
            self.log(passId=pass_id, step=step, evidence=str(path), **{k:v for k,v in steps[step].items() if k != 'processes'})
            for p in evidence:
                self.log(passId=pass_id, step=step, result='rss-observation', **p)
        rung('janitor', lambda: dict(result='paused') if g.muted else self.janitor())
        def gui_rule():
            # Use only the existing, freshly observed footprint history. This
            # cannot turn an RSS-only census into a GUI-leak authorization.
            g.now = g.clock()
            if not hasattr(g, 'rows'):
                return dict(result='footprint-history-unavailable')
            leaks = [p for p in g.rows.values() if 0 <= g.now-p.get('footprintObservedAt', 0) <= 60
                     and p.get('footprintGiB', 0) > 8
                     and p.get('growthGiBHour', 0) > 1 and '.app/' in p['comm']]
            prior = list(g.actions)
            g.slow_actions(leaks)
            for action in g.actions:
                if action not in prior:
                    self.log(passId=pass_id, step='gui', **{k:v for k,v in action.items() if k != 'step'})
            return dict(result='existing-gui-rule', count=len(leaks))
        rung('gui', gui_rule)
        def renice():
            deadline = time.monotonic()+3
            count = 0
            for p in rows.values():
                family = heavy(p)
                if not family:
                    continue
                reason = protection(p, rows, protected)
                result = dict(result='kept', reason=reason)
                if not reason:
                    if g.muted:
                        result = dict(result='paused')
                    elif time.monotonic() >= deadline:
                        result = dict(result='budget')
                    else:
                        try:
                            result = native.soften(p)
                        except (OSError, ValueError) as exc:
                            result = dict(stage='soften', **failure_details(exc, 'soften'))
                        count += (result['result'] == 'sent'
                                  or result.get('stages', {}).get('setpriority', {}).get('result') == 'sent')
                after = rss({p['pid']:p}).get(p['pid']) if result.get('result') == 'sent' else p['rssMb']
                self.log(passId=pass_id, step='renice', pid=p['pid'], start=p['start'],
                         args=p['args'], family=family, rssBeforeMb=p['rssMb'], rssAfterMb=after,
                         ancestors=[{k:q.get(k) for k in ('pid', 'ppid', 'start', 'comm', 'args')} for q in guard_chain(p, rows)], **result)
            return dict(result='completed' if count else 'nothing-to-do', count=count)
        rung('renice', renice)
        write_json(path/'census.json', census)
        report_key = 'overloadResponder:'+pass_id
        g.saved[report_key] = dict(evidence=str(path), urgent=True,
            summary='host.overload census: '+str(path/'census.json')+'; never-touch: '+', '.join(NEVER),
            requestId='mac-guard-overload-'+uuid.uuid4().hex)
        g.save()
        delivered = self.deliver(report_key)
        write_json(path/'census.json', census)
        summary = dict(passId=pass_id, step='summary', trigger=event.get('props', {}), evidence=str(path),
                       freedRssMb={key:steps[key]['freedRssMb'] for key in steps},
                       before=latest.get('host.vitals', {}).get('props', {}), after=None,
                       workerStarted=delivered and self.last_worker_started,
                       workerDelivered=delivered, threadId=g.worker.get('threadId'), completedAt=g.clock())
        self.state.update(freedRssMb=sum(step['freedRssMb'] for step in steps.values()), pendingSummary=summary)
        self.save()
        self.log(**summary, result='awaiting-next-vitals')

    def deliver(self, key):
        g = self.guard
        report = g.saved.get(key)
        if not report:
            return False
        delivered = g.deliver_responder(key)
        self.last_worker_started = bool(delivered and report.get('launch'))
        pending = self.state.get('pendingSummary')
        if delivered and pending and pending['passId'] == key.split(':', 1)[1]:
            pending.update(workerDelivered=True, workerStarted=self.last_worker_started, threadId=g.worker.get('threadId'))
            self.save()
        self.log(passId=key.split(':', 1)[1], step='worker', evidence=report['evidence'],
                 workerDelivered=bool(delivered), workerStarted=self.last_worker_started, threadId=g.worker.get('threadId'),
                 result='delivered' if delivered else 'pending')
        return bool(delivered)
