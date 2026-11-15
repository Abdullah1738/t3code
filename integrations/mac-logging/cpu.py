#!/usr/bin/python3
"""Read-only per-process CPU deltas, independent of top and memory probes."""
import fcntl
import ctypes
import datetime as dt
from collections import Counter
import os
import re
import subprocess
import time

from cpu_labels import family, script_hint, command_label
from jobs import read_state, save_state, state_path
from toollog import emit, finite_number, cpu_fields

PS = ['/bin/ps', '-axo', 'pid=,ppid=,time=,rss=,state=,lstart=,etime=,comm=']
SPIKES_PER_DAY = 240


class ProbeError(Exception):
    pass


def host_ticks(host_statistics, host):
    ticks = (ctypes.c_uint * 4)()
    count = ctypes.c_uint(4)
    code = host_statistics(host, 3, ticks, ctypes.byref(count))
    if code or count.value != 4:
        raise ProbeError('unavailable')
    return list(ticks)


def cpu_ticks(lib=None):
    try:
        lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib') if lib is None else lib
        lib.mach_host_self.restype = ctypes.c_uint
        lib.host_statistics.argtypes = (ctypes.c_uint, ctypes.c_int, ctypes.c_void_p,
                                       ctypes.POINTER(ctypes.c_uint))
        lib.host_statistics.restype = ctypes.c_int
        lib.mach_port_deallocate.argtypes = (ctypes.c_uint, ctypes.c_uint)
        host = lib.mach_host_self()
        try:
            return host_ticks(lib.host_statistics, host)
        finally:
            # mach_host_self returns a send right, including in long-lived tests.
            task = ctypes.c_uint.in_dll(lib, 'mach_task_self_').value
            lib.mach_port_deallocate(task, host)
    except (OSError, AttributeError, ValueError):
        raise ProbeError('unavailable')


def system_cpu(ticks, previous, props, ncpu):
    old = previous.get('ticks')
    if props['baseline'] or old is None:
        return {}
    if (not isinstance(old, list) or len(old) != 4
            or any(type(n) is not int or not 0 <= n < 2**32 for n in old)):
        return dict(systemCpuError='baseline')
    # natural_t counters wrap at 32 bits. Reject resets instead of treating a
    # reboot/corrupt counter as years of busy CPU in a one-minute window.
    delta = [(new-prior) % 2**32 for new, prior in zip(ticks, old)]
    if not sum(delta) or any(n > 2**31 for n in delta):
        return dict(systemCpuError='baseline')
    scale = ncpu*100/sum(delta)
    user, system, idle, nice = delta
    busy = (user+system+nice)*scale
    return dict(systemCpuPct=round(busy, 3), userPct=round((user+nice)*scale, 3),
                sysPct=round(system*scale, 3),
                unattributedCpuPct=round(max(0, busy-props['totalCpuPct']), 3))


def parent_family(proc, by_pid):
    if proc['ppid'] == 1:
        return 'launchd'
    parent = by_pid.get(proc['ppid'])
    return parent['family'] if parent else None


def churn(rows, previous, props):
    if props['baseline']:
        return {}
    old = previous.get('processes', {})
    old = old if isinstance(old, dict) else {}
    identities = previous.get('identities')
    if isinstance(identities, dict):
        old = {pid: dict(start=start) for pid, start in identities.items()}
    current = {str(p['pid']): p for p in rows}
    spawned = [p for pid, p in current.items()
               if not isinstance(old.get(pid), dict) or old[pid].get('start') != p['start']]
    exited = sum(pid not in current or not isinstance(prior, dict)
                 or prior.get('start') != current[pid]['start'] for pid, prior in old.items())
    by_pid = {p['pid']: p for p in rows}
    groups = {}
    for proc in spawned:
        group = groups.setdefault(proc['family'], dict(count=0, cpuPct=0, parents=Counter()))
        group['count'] += 1
        # Only lifetime CPU of a process born within this window is attributable.
        born = time.mktime(time.strptime(proc['start'], '%a %b %d %H:%M:%S %Y'))
        if previous['at'] <= born <= previous['at']+props['windowS']:
            group['cpuPct'] += proc['cpuS']/props['windowS']*100
        group['parents'][parent_family(proc, by_pid)] += 1
    families = [dict(family=name, count=g['count'], cpuPct=round(g['cpuPct'], 3),
                     parentFamily=g['parents'].most_common(1)[0][0])
                for name, g in sorted(groups.items(), key=lambda item: (-item[1]['count'], item[0]))[:8]]
    # max(live PID) is not an allocation cursor after a wrap: long-lived high
    # PIDs masked a real 200-process burst on this Mac. Do not emit pidAdvance.
    return dict(spawned=len(spawned), exited=exited, spawnedFamilies=families)


def seconds(value):
    if not re.fullmatch(r'(?:\d+-)?\d+(?::[0-5]\d){1,2}(?:\.\d+)?', value):
        raise ProbeError('parse')
    days, _, clock = value.rpartition('-')
    return int(days or 0)*86400 + sum(float(part)*60**i for i, part in enumerate(reversed(clock.split(':'))))


def parse_ps(text, diagnostics=None):
    diagnostics = diagnostics if diagnostics is not None else {}
    rows = []
    seen = set()
    total = bad = 0
    first_bad = None
    for line in text.splitlines():
        if not line.strip():
            continue
        total += 1
        try:
            parts = line.split(None, 11)
            if len(parts) != 12:
                raise ValueError()
            pid, ppid, rss = int(parts[0]), int(parts[1]), int(parts[3])
            start = ' '.join(parts[5:10])
            time.strptime(start, '%a %b %d %H:%M:%S %Y')
            if min(pid, ppid, rss) < 0 or pid in seen or not re.fullmatch(r'[A-Za-z?+<>-]{1,16}', parts[4]):
                raise ValueError()
            seconds(parts[10])
            comm = parts[11]
            if comm.startswith('(') and comm.endswith(')'):
                comm = comm[1:-1]
            rows.append(dict(pid=pid, ppid=ppid, cpuS=seconds(parts[2]), rssMb=rss/1024,
                             state=parts[4], start=start, etime=parts[10], family=family(comm)))
            seen.add(pid)
        except (ValueError, OverflowError, ProbeError):
            bad += 1
            if first_bad is None:
                # Reuse the logger's janitor redaction before truncation. Never
                # expose raw process identifiers or home paths in diagnostics.
                tail = line.split(None, 2)
                first_bad = cpu_fields(dict(badLine='PID PPID '+(tail[2] if len(tail) == 3 else '[incomplete]'))).get('badLine')
    diagnostics.update(skippedLines=bad)
    if not rows or bad*10 > total:
        diagnostics.update(badLine=first_bad, badLines=bad, lines=total)
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
    by_pid = {p['pid']: p for p in rows}
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
                            parentFamily=parent_family(proc, by_pid), state=proc['state'],
                            cpuS=round(used, 3), cpuPct=round(pct, 3), rssMb=round(proc['rssMb'], 2), etime=proc['etime']))
    groups = sorted(groups.values(), key=lambda p: (-p['cpuPct'], p['family']))[:15]
    for group in groups:
        group.update(cpuPct=round(group['cpuPct'], 3), rssMb=round(group['rssMb'], 2))
    props = dict(baseline=not valid, windowS=round(window, 3) if valid else None,
                 cpuS=round(total, 3) if valid else None,
                 totalCpuPct=round(total/window*100, 3) if valid else None,
                 processCount=len(rows), runnable=sum(p['state'].startswith('R') for p in rows),
                 uninterruptible=sum(p['state'].startswith('U') for p in rows), families=groups,
                 exiting=sum(p['state'].startswith('?') for p in rows),
                 top=sorted(top, key=lambda p: (-p['cpuPct'], p['pid']))[:20])
    # Exiting rows have reset CPU counters; don't seed a later delta from zero.
    state = dict(at=now, identities={str(p['pid']): p['start'] for p in rows},
                 processes={str(p['pid']): dict(start=p['start'], cpuS=p['cpuS'])
                                    for p in rows if not p['state'].startswith('?')})
    return props, state


def spike(props, rows, run):
    keys = ('load', 'ncpu', 'systemCpuPct', 'unattributedCpuPct', 'systemCpuError', 'spawnedFamilies')
    result = {k: props[k] for k in keys if k in props}
    fields = ('pid', 'ppid', 'family', 'parentFamily', 'state', 'cpuPct', 'rssMb', 'etime')
    result['top'] = [{k: p[k] for k in fields} for p in props['top'][:15]]
    pids = sorted({p[k] for p in result['top'] for k in ('pid', 'ppid') if p[k] > 0})
    starts = {p['pid']: p['start'] for p in rows}
    commands = {}
    if pids:
        try:
            text = command(['/bin/ps', '-ww', '-o', 'pid=,lstart=,args=', '-p', ','.join(map(str, pids))], run, timeout=5)
            for line in text.splitlines():
                parts = line.split(None, 6)
                if (len(parts) == 7 and parts[0].isdigit() and int(parts[0]) in pids
                        and ' '.join(parts[1:6]) == starts.get(int(parts[0]))):
                    commands[int(parts[0])] = command_label(parts[6])
        except ProbeError as exc:
            result['commandError'] = str(exc)
    for p in result['top']:
        p.update(cmd=commands.get(p['pid']), parentCmd=commands.get(p['ppid']))
    try:
        result['runnableThreadsByFamily'] = runnable_threads(command(['/bin/ps', '-axM'], run, timeout=2), rows)
    except ProbeError as exc:
        result['threadError'] = str(exc)
    return result


def runnable_threads(text, rows):
    families = {p['pid']: p['family'] for p in rows}
    counts = Counter()
    parsed = 0
    for line in text.splitlines()[1:]:
        parts = line.split()
        # Darwin -M always emits its thread layout, regardless of -o. The
        # first thread has USER/TTY columns; continuation rows omit both.
        offset = 0 if parts and parts[0].isdigit() else 1
        state_index = 2 if offset == 0 else 4
        if len(parts) <= state_index or not parts[offset].isdigit():
            continue
        pid, state = int(parts[offset]), parts[state_index]
        if not re.fullmatch(r'[A-Za-z?+<>-]{1,16}', state):
            continue
        parsed += 1
        if state.startswith('R'):
            counts[families.get(pid, 'unknown')] += 1
    if not parsed:
        raise ProbeError('parse')
    return [dict(family=f, count=n) for f, n in counts.most_common(8)]


def hints(top, rows, run):
    live = {p['pid'] for p in rows if not p['state'].startswith('?')}
    selected = {p['pid']: p for p in top if p['pid'] in live and p['family'] in ('node', 'bun', 'python')}
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


def sample(run=subprocess.run, clock=time.monotonic, ticks_read=cpu_ticks, spike_threshold=None):
    started = clock()
    diagnostics = {}
    try:
        with state_path('cpu').with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None
            rows = parse_ps(command(PS, run), diagnostics)
            # Apple's Python 3.9 monotonic epoch is per process, unlike Unix time.
            observed = time.time()
            previous = read_state('cpu')
            props, state = deltas(rows, previous, observed)
            props.update(churn(rows, previous, props))
            props.update(diagnostics)
            try:
                props['load'] = list(os.getloadavg())
            except OSError:
                props['load'] = None
            props['ncpu'] = os.cpu_count() or 1
            try:
                ticks = ticks_read()
                props.update(system_cpu(ticks, previous, props, props['ncpu']))
                state['ticks'] = ticks
            except (ProbeError, OSError, ValueError, TypeError, ctypes.ArgumentError):
                props['systemCpuError'] = 'unavailable'
            props['hintError'] = hints(props['top'], rows, run)
            observed_at = dt.datetime.fromtimestamp(observed, dt.timezone.utc)
            day = observed_at.date().isoformat()
            count = previous.get('spikeCount', 0) if previous.get('spikeDay') == day else 0
            count = count if type(count) is int and count >= 0 else 0
            threshold = props['ncpu']*2 if spike_threshold is None else spike_threshold
            snapshot = (spike(props, rows, run) if props['load'] and props['load'][0] > threshold
                        and count < SPIKES_PER_DAY else None)
            # Reserve before emitting, under the sampler lock: a failed logger
            # write may cost a slot but cannot cause a duplicate over the cap.
            state.update(spikeDay=day, spikeCount=count+(snapshot is not None))
            save_state('cpu', state)
            duration = (clock()-started)*1000
            emit('cpu', 'event', 'cpu.sample', ok=True, duration_ms=duration, props=props, now=observed_at)
            if snapshot is not None:
                emit('cpu', 'event', 'cpu.spike', ok=True, duration_ms=duration, props=snapshot, now=observed_at)
            return props
    except (ProbeError, OSError) as exc:
        failure = str(exc) if isinstance(exc, ProbeError) else 'unavailable'
        props = dict(diagnostics, failure=failure)
        emit('cpu', 'error', 'cpu.sample', ok=False, duration_ms=(clock()-started)*1000,
             props=props, error_tag='cpu.'+failure)
        return props


if __name__ == '__main__':
    sample()
