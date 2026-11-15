#!/usr/bin/python3
"""Read-only per-process CPU deltas, independent of top and memory probes."""
import fcntl
import os
import re
import subprocess
import time

from cpu_labels import family, script_hint
from jobs import read_state, save_state, state_path
from toollog import emit, finite_number

PS = ['/bin/ps', '-axo', 'pid=,ppid=,time=,rss=,state=,lstart=,etime=,comm=']


class ProbeError(Exception):
    pass


def seconds(value):
    if not re.fullmatch(r'(?:\d+-)?\d+(?::[0-5]\d){1,2}(?:\.\d+)?', value):
        raise ProbeError('parse')
    days, _, clock = value.rpartition('-')
    return int(days or 0)*86400 + sum(float(part)*60**i for i, part in enumerate(reversed(clock.split(':'))))


def parse_ps(text):
    rows = []
    seen = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split(None, 11)
        if len(parts) != 12:
            raise ProbeError('parse')
        try:
            pid, ppid, rss = int(parts[0]), int(parts[1]), int(parts[3])
            start = ' '.join(parts[5:10])
            time.strptime(start, '%a %b %d %H:%M:%S %Y')
            if min(pid, ppid, rss) < 0 or pid in seen or not re.fullmatch(r'[A-Za-z+<>-]{1,16}', parts[4]):
                raise ValueError()
            seconds(parts[10])
            rows.append(dict(pid=pid, ppid=ppid, cpuS=seconds(parts[2]), rssMb=rss/1024,
                             state=parts[4], start=start, etime=parts[10], family=family(parts[11])))
            seen.add(pid)
        except (ValueError, OverflowError):
            raise ProbeError('parse')
    if not rows:
        raise ProbeError('parse')
    return rows


def command(argv, run, timeout=30):
    env = {**os.environ, 'LC_ALL': 'C'}
    env.pop('BUN_INSPECT', None)
    try:
        result = run(argv, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise ProbeError('timeout')
    except OSError:
        raise ProbeError('unavailable')
    except UnicodeError:
        raise ProbeError('parse')
    if result.returncode:
        raise ProbeError('exit')
    return result.stdout


def deltas(rows, previous, now):
    at = previous.get('at')
    window = now-at if finite_number(at) else 0
    valid = 0 < window <= 3600
    old = previous.get('processes')
    old = old if isinstance(old, dict) else {}
    groups, top = {}, []
    total = 0
    for proc in rows:
        prior = old.get(str(proc['pid']))
        prior = prior if isinstance(prior, dict) else {}
        same = (valid and prior.get('start') == proc['start']
                and finite_number(prior.get('cpuS')) and 0 <= prior['cpuS'] <= proc['cpuS'])
        used = proc['cpuS']-prior['cpuS'] if same else 0
        pct = used/window*100 if valid else 0
        total += used
        group = groups.setdefault(proc['family'], dict(family=proc['family'], count=0, cpuPct=0, rssMb=0))
        group['count'] += 1
        group['cpuPct'] += pct
        group['rssMb'] += proc['rssMb']
        if valid:
            top.append(dict(pid=proc['pid'], ppid=proc['ppid'], family=proc['family'], hint=None,
                            cpuS=round(used, 3), cpuPct=round(pct, 3), rssMb=round(proc['rssMb'], 2), etime=proc['etime']))
    groups = sorted(groups.values(), key=lambda p: (-p['cpuPct'], p['family']))[:15]
    for group in groups:
        group.update(cpuPct=round(group['cpuPct'], 3), rssMb=round(group['rssMb'], 2))
    props = dict(baseline=not valid, windowS=round(window, 3) if valid else None,
                 cpuS=round(total, 3) if valid else None,
                 totalCpuPct=round(total/window*100, 3) if valid else None,
                 processCount=len(rows), runnable=sum(p['state'].startswith('R') for p in rows),
                 uninterruptible=sum(p['state'].startswith('U') for p in rows), families=groups,
                 top=sorted(top, key=lambda p: (-p['cpuPct'], p['pid']))[:20])
    state = dict(at=now, processes={str(p['pid']): dict(start=p['start'], cpuS=p['cpuS']) for p in rows})
    return props, state


def hints(top, rows, run):
    selected = {p['pid']: p for p in top if p['family'] in ('node', 'bun', 'python')}
    if not selected:
        return None
    starts = {p['pid']: p['start'] for p in rows}
    try:
        text = command(['/bin/ps', '-ww', '-p', ','.join(str(pid) for pid in selected),
                        '-o', 'pid=,lstart=,args='], run, timeout=5)
        for line in text.splitlines():
            parts = line.split(None, 6)
            if len(parts) != 7 or not parts[0].isdigit():
                raise ProbeError('parse')
            pid = int(parts[0])
            # The optional argv read must not label a replacement process.
            if pid in selected and ' '.join(parts[1:6]) == starts[pid]:
                selected[pid]['hint'] = script_hint(parts[6])
    except (ImportError, OSError):
        return 'unavailable'
    except ProbeError as exc:
        return str(exc)
    return None


def sample(run=subprocess.run, clock=time.monotonic):
    started = clock()
    try:
        with state_path('cpu').with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None
            rows = parse_ps(command(PS, run))
            observed = clock()
            props, state = deltas(rows, read_state('cpu'), observed)
            try:
                props['load'] = list(os.getloadavg())
            except OSError:
                props['load'] = None
            props['ncpu'] = os.cpu_count()
            props['hintError'] = hints(props['top'], rows, run)
            save_state('cpu', state)
            duration = (clock()-started)*1000
            emit('cpu', 'event', 'cpu.sample', ok=True, duration_ms=duration, props=props)
            return props
    except (ProbeError, OSError) as exc:
        failure = str(exc) if isinstance(exc, ProbeError) else 'unavailable'
        props = dict(failure=failure)
        emit('cpu', 'error', 'cpu.sample', ok=False, duration_ms=(clock()-started)*1000,
             props=props, error_tag='cpu.'+failure)
        return props


if __name__ == '__main__':
    sample()
