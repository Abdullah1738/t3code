#!/usr/bin/python3
"""Read-only per-process CPU deltas, independent of top and memory probes."""
import fcntl
import ctypes
import datetime as dt
import errno
from collections import Counter
import os
import re
import subprocess
import time

from cpu_labels import family, script_hint, command_label
from jobs import read_state, save_state, state_path
from toollog import emit, finite_number, cpu_fields
from volume_crawls import volume_crawls

# Keep comm last: Darwin truncates it when another column follows, changing
# established CPU families and disabling interpreter hints.
PS = ['/bin/ps', '-ww', '-axo', 'pid=,ppid=,time=,rss=,state=,lstart=,etime=,uid=,comm=']
SPIKES_PER_DAY = 240


class ProbeError(Exception):
    pass


class RusageInfoV1(ctypes.Structure):
    # ABI from sys/resource.h; the child counters include reaped descendants.
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        'user', 'system', 'pkg_idle_wkups', 'interrupt_wkups', 'pageins',
        'wired_size', 'resident_size', 'phys_footprint', 'start', 'exit',
        'child_user', 'child_system', 'child_pkg_idle_wkups',
        'child_interrupt_wkups', 'child_pageins', 'child_elapsed')]


def rusage_reader(lib=None):
    lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True) if lib is None else lib
    lib.proc_pid_rusage.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_void_p)
    lib.proc_pid_rusage.restype = ctypes.c_int
    base = (ctypes.c_uint32 * 2)()
    if lib.mach_timebase_info(ctypes.byref(base)) or not base[1]:
        raise ProbeError('unavailable')
    scale = base[0] / base[1] / 1e9
    lib.mach_absolute_time.restype = ctypes.c_uint64
    inventory_started = lib.mach_absolute_time()

    def read(pid):
        usage = RusageInfoV1()
        if lib.proc_pid_rusage(pid, 1, ctypes.byref(usage)):
            raise OSError(ctypes.get_errno(), 'rusage')
        # This reader is created before ps. A later process start cannot belong
        # to that inventory; in particular, never baseline a reused PID's zero
        # counters against the previous occupant's historical CPU.
        if usage.start > inventory_started:
            raise OSError(errno.ESTALE, 'identity')
        return dict(start=usage.start, ownS=(usage.user+usage.system)*scale,
                    childS=(usage.child_user+usage.child_system)*scale)
    return read


def child_snapshot(rows, reader=None, clock=time.monotonic):
    counts = Counter()
    readings = {}
    deadline = clock()+30
    try:
        reader = rusage_reader() if reader is None else reader
    except (OSError, AttributeError, ProbeError):
        reader = None
    # Read ancestors first: after a child read succeeds its parent could reap
    # it, transferring the same lifetime into a later parent read.
    by_pid = {p['pid']: p for p in rows}
    def depth(proc):
        seen = {proc['pid']}
        while proc['ppid'] in by_pid and proc['ppid'] not in seen:
            seen.add(proc['ppid'])
            proc = by_pid[proc['ppid']]
        return len(seen)
    for proc in sorted(rows, key=lambda p: (depth(p), p['pid'])):
        reason = 'unavailable'
        if proc['state'].startswith('?'):
            reason = 'exited'
        elif reader and clock() < deadline:
            try:
                readings[str(proc['pid'])] = dict(reader(proc['pid']), ppid=proc['ppid'],
                    uid=proc['uid'], family=proc['family'], psStart=proc['start'], cpuS=proc['cpuS'])
                continue
            except OSError as exc:
                reason = ('identity' if exc.errno == errno.ESTALE else
                          'permission' if exc.errno in (errno.EPERM, errno.EACCES) else
                          'exited' if exc.errno in (errno.ESRCH, errno.ENOENT) else 'unavailable')
        elif reader:
            reason = 'timeout'
        counts[(proc['uid'], reason)] += 1
    return readings, dict(childReadable=len(readings), childUnreadable=len(rows)-len(readings),
        childCoverage=[dict(uid=uid, reason=reason, count=n)
                       for (uid, reason), n in sorted(counts.items())])


def child_cpu(rows, readings, previous, props):
    old = previous.get('childReadings', {})
    old = old if isinstance(old, dict) else {}
    old = {pid: p for pid, p in old.items() if isinstance(p, dict)
           and type(p.get('start')) is int and isinstance(p.get('psStart'), str)
           and all(finite_number(p.get(k)) and p[k] >= 0 for k in ('ownS', 'childS'))}
    by_pid = {str(p['pid']): p for p in rows}
    old_processes = previous.get('processes', {})
    old_processes = old_processes if isinstance(old_processes, dict) else {}
    exiting = previous.get('exitingProcesses', {})
    if isinstance(exiting, dict):
        old_processes = {**old_processes, **exiting}
    prior_parents = {str(p.get('ppid')) for p in old_processes.values() if isinstance(p, dict)}
    prior_parents.update(pid for pid, p in old.items() if isinstance(p, dict) and p.get('childS', 0) > 0)
    lost = sum(pid in prior_parents and (pid not in by_pid or
               by_pid[pid]['start'] != prior.get('start'))
               for pid, prior in old_processes.items() if isinstance(prior, dict))
    result = dict(childCpu=[], childCpuFamilies=[], childCpuPct=None, lostParents=lost, childUncertainParents=0)
    if props['baseline'] or not old or not readings:
        return result
    total = 0
    def disappeared(child_pid):
        return (child_pid not in by_pid or
                by_pid[child_pid]['start'] != old_processes[child_pid].get('start'))

    def transferred(child_pid, parent_pid):
        seen = set()
        while child_pid != parent_pid:
            if (child_pid in seen or not isinstance(old_processes.get(child_pid), dict)
                    or not disappeared(child_pid)):
                return False
            seen.add(child_pid)
            child_pid = str(old_processes[child_pid].get('ppid'))
        return True

    order = {pid: i for i, pid in enumerate(readings)}
    # A vanished grandchild may have been adopted by launchd before reaping.
    # Its final parent is unknowable from snapshots. Do not credit launchd's
    # rollup when this could transfer already-counted CPU from another subtree.
    def may_have_exited(pid):
        return (disappeared(pid) or pid not in readings or
                pid in old and old[pid]['start'] != readings[pid]['start'])

    orphan_transfer = any(isinstance(p, dict) and may_have_exited(pid)
                          and str(p.get('ppid')) in old_processes
                          and isinstance(old_processes[str(p.get('ppid'))], dict)
                          and may_have_exited(str(p.get('ppid')))
                          for pid, p in old_processes.items())

    for pid, current in readings.items():
        prior = old.get(pid)
        if (not isinstance(prior, dict) or prior.get('start') != current['start']
                or prior.get('psStart') != current['psStart']):
            continue
        raw = current['childS']-prior['childS']
        if raw <= 0:
            continue
        if pid == '1' and orphan_transfer:
            result['childUncertainParents'] += 1
            continue
        # Reaping transfers the child's lifetime counters, including work that
        # previous samples already saw. Remove each disappeared descendant's
        # old own and already-reaped CPU; living descendants' old CPU was not
        # transferred and must not be subtracted.
        departed = [child_pid for child_pid, child in old_processes.items()
                    if child_pid != pid and isinstance(child, dict) and transferred(child_pid, pid)]
        ambiguous = any(str(child.get('ppid')) == pid and child_pid in by_pid
                        and (child_pid not in readings or order[child_pid] < order[pid]
                             or readings[child_pid]['start'] != old.get(child_pid, {}).get('start'))
                        for child_pid, child in old_processes.items()
                        if isinstance(child, dict))
        if ambiguous or any(child_pid not in old for child_pid in departed):
            result['childUncertainParents'] += 1
            continue
        historical = sum(old[child_pid]['ownS']+old[child_pid]['childS'] for child_pid in departed)
        used = max(0, raw-historical)
        total += used
        if used:
            proc = by_pid[pid]
            result['childCpu'].append(dict(pid=int(pid), ppid=proc['ppid'],
                family='orphaned-exited' if pid == '1' else proc['family'],
                parentFamily=parent_family(proc, {p['pid']: p for p in rows}),
                cpuPct=round(used/props['windowS']*100, 3)))
    result['childCpu'].sort(key=lambda p: (-p['cpuPct'], p['pid']))
    families = Counter()
    for proc in result['childCpu']:
        families[(proc['family'], proc['parentFamily'])] += proc['cpuPct']
    result['childCpuFamilies'] = [dict(family=f, parentFamily=p, cpuPct=round(n, 3))
                                  for (f, p), n in families.most_common(10)]
    result['childCpu'] = result['childCpu'][:10]
    result['childCpuPct'] = round(total/props['windowS']*100, 3)
    if 'unattributedCpuPct' in props:
        result['unattributedAfterChildrenPct'] = round(max(0, props['unattributedCpuPct']-result['childCpuPct']), 3)
    return result


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
    return dict(systemCpuPct=round(busy, 3), userPct=round(user*scale, 3),
                sysPct=round(system*scale, 3), nicePct=round(nice*scale, 3), idlePct=round(idle*scale, 3),
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
    parents = Counter((p['ppid'], parent_family(p, by_pid)) for p in spawned)
    return dict(spawned=len(spawned), exited=exited, spawnedFamilies=families,
                observedSpawnsLowerBound=len(spawned),
                observedSpawnsPerMinuteLowerBound=round(len(spawned)*60/props['windowS'], 3),
                observedSpawnsByParent=[dict(pid=pid, family=f, count=n,
                    perMinute=round(n*60/props['windowS'], 3))
                    for (pid, f), n in parents.most_common(10)])


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
    args_column = None
    tool_column = None
    for line in text.splitlines():
        if line.split() in (['SCAN_ARGV'], ['SCAN_TOOL', 'SCAN_ARGV']):
            args_column = line.index('SCAN_ARGV')
            tool_column = line.index('SCAN_TOOL') if 'SCAN_TOOL' in line else None
            continue
        if not line.strip():
            continue
        total += 1
        try:
            args = line[args_column:].strip() if args_column is not None else ''
            metadata_end = tool_column if tool_column is not None else args_column
            parts = (line[:metadata_end] if metadata_end is not None else line).split(None, 12)
            if len(parts) != 13:
                raise ValueError()
            pid, ppid, rss, uid = int(parts[0]), int(parts[1]), int(parts[3]), int(parts[11])
            start = ' '.join(parts[5:10])
            time.strptime(start, '%a %b %d %H:%M:%S %Y')
            if min(pid, ppid, rss, uid) < 0 or pid in seen or not re.fullmatch(r'[A-Za-z?+<>-]{1,16}', parts[4]):
                raise ValueError()
            seconds(parts[10])
            comm = parts[12].strip()
            if comm.startswith('(') and comm.endswith(')'):
                comm = comm[1:-1]
            rows.append(dict(pid=pid, ppid=ppid, uid=uid, cpuS=seconds(parts[2]), rssMb=rss/1024,
                             state=parts[4], start=start, etime=parts[10], elapsedS=seconds(parts[10]), family=family(comm),
                             comm=comm, args=args,
                             tool=line[tool_column:args_column].strip() if tool_column is not None else os.path.basename(comm)))
            seen.add(pid)
        except (ValueError, OverflowError, ProbeError):
            bad += 1
            if first_bad is None:
                # Reuse the logger's janitor redaction before truncation. Never
                # expose raw process identifiers or home paths in diagnostics.
                tail = (line[:args_column] if args_column is not None else line).split(None, 2)
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


def deltas(rows, previous, now, top_limit=20):
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
    # Keep the denominator positive even for back-to-back invocations under
    # a millisecond. Rounding it to zero breaks child and spawn-rate deltas.
    props = dict(baseline=not valid, windowS=window if valid else None,
                 cpuS=round(total, 3) if valid else None,
                 totalCpuPct=round(total/window*100, 3) if valid else None,
                 processCount=len(rows), runnable=sum(p['state'].startswith('R') for p in rows),
                 uninterruptible=sum(p['state'].startswith('U') for p in rows), families=groups,
                 exiting=sum(p['state'].startswith('?') for p in rows),
                 top=sorted(top, key=lambda p: (-p['cpuPct'], p['pid']))[:top_limit],
                 kernelTaskPct=None)
    # Exiting rows have reset CPU counters; don't seed a later delta from zero.
    state = dict(at=now, identities={str(p['pid']): p['start'] for p in rows},
                 exitingProcesses={str(p['pid']): dict(start=p['start'], ppid=p['ppid'])
                                   for p in rows if p['state'].startswith('?')},
                 processes={str(p['pid']): dict(start=p['start'], cpuS=p['cpuS'], ppid=p['ppid'])
                                    for p in rows if not p['state'].startswith('?')})
    return props, state


def spike(props, rows, run, kernel_read=True):
    keys = ('load', 'ncpu', 'systemCpuPct', 'unattributedCpuPct', 'systemCpuError', 'spawnedFamilies',
            'userPct', 'sysPct', 'nicePct', 'idlePct', 'kernelTaskPct', 'runnable', 'uninterruptible',
            'childCpu', 'childCpuFamilies', 'childCpuPct', 'childReadable', 'childUnreadable', 'childCoverage',
            'childUncertainParents', 'lostParents', 'unattributedAfterChildrenPct',
            'observedSpawnsLowerBound', 'observedSpawnsPerMinuteLowerBound', 'observedSpawnsByParent')
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
    result['kernelTaskPct'] = None
    if kernel_read:
        try:
            result.update(kernel_task(command(['/usr/bin/top', '-l', '2', '-s', '1', '-pid', '0',
                                              '-stats', 'pid,cpu,time'], run, timeout=5)))
        except ProbeError as exc:
            result['kernelTaskError'] = str(exc)
    else:
        result['kernelTaskSkipped'] = 'rate'
    return result


def kernel_task(text):
    frames = []
    for line in text.splitlines():
        parts = line.split()
        if parts and parts[0] == '0':
            if len(parts) != 3:
                raise ProbeError('parse')
            try:
                pct = float(parts[1])
                seconds(parts[2])
            except (ValueError, OverflowError):
                raise ProbeError('parse')
            if not finite_number(pct) or pct < 0 or len(parts[2]) > 32:
                raise ProbeError('parse')
            frames.append(dict(kernelTaskPct=pct, kernelTaskTime=parts[2], kernelTaskWindowS=1))
    if len(frames) != 2:
        raise ProbeError('parse')
    return frames[1]


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


def sample(run=subprocess.run, clock=time.monotonic, ticks_read=cpu_ticks, spike_threshold=None,
           children_read=child_snapshot, reader_factory=None):
    started = clock()
    diagnostics = {}
    try:
        with state_path('cpu').with_suffix('.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None
            try:
                reader = (rusage_reader if reader_factory is None else reader_factory)()
            except (OSError, AttributeError, ProbeError):
                reader = False
            rows = parse_ps(command(PS, run), diagnostics)
            # Apple's Python 3.9 monotonic epoch is per process, unlike Unix time.
            observed = time.time()
            previous = read_state('cpu')
            props, state = deltas(rows, previous, observed)
            props.update(churn(rows, previous, props))
            props.update(diagnostics)
            volume_crawls(rows, previous, observed, run)
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
            readings, coverage = children_read(rows, reader=reader)
            props.update(coverage)
            props.update(child_cpu(rows, readings, previous, props))
            state['childReadings'] = readings
            props['hintError'] = hints(props['top'], rows, run)
            observed_at = dt.datetime.fromtimestamp(observed, dt.timezone.utc)
            day = observed_at.date().isoformat()
            count = previous.get('spikeCount', 0) if previous.get('spikeDay') == day else 0
            count = count if type(count) is int and count >= 0 else 0
            threshold = props['ncpu']*2 if spike_threshold is None else spike_threshold
            last_kernel = previous.get('kernelTaskAt')
            if finite_number(last_kernel) and last_kernel >= 0:
                # Persist wall time across launchd invocations. A clock rollback
                # starts a fresh cooldown instead of retrying top on every spike.
                state['kernelTaskAt'] = min(last_kernel, observed)
            snapshot = None
            if props['load'] and props['load'][0] > threshold and count < SPIKES_PER_DAY:
                take_kernel = ('kernelTaskAt' not in state or observed-state['kernelTaskAt'] >= 300)
                if take_kernel:
                    # Failed attempts also consume the expensive-read allowance.
                    state['kernelTaskAt'] = observed
                snapshot = spike(props, rows, run, kernel_read=take_kernel)
                props.update({k: v for k, v in snapshot.items() if k.startswith('kernelTask')})
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


def main():
    try:
        from disk_low import check as check_disk_floor
        check_disk_floor()
    except Exception:
        emit('disk', 'error', 'disk.floor_check', ok=False,
             error_tag='disk.floor_check_failed')
    try:
        from u_sample import sample as sample_u
        sample_u()
    except Exception:
        emit('proc', 'error', 'proc.u_sample', ok=False,
             props=dict(failure='unavailable'), error_tag='proc.u_unavailable')
    sample()


if __name__ == '__main__':
    main()
