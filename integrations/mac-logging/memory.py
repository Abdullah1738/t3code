#!/usr/bin/python3
"""Five-minute, read-only memory observations; no process arguments are collected."""
import datetime as dt
import fcntl
import math
import os
from pathlib import Path
import re
import subprocess
import time

from jobs import read_state, save_state, state_path
from toollog import emit, memory_command

WATCHED = ('fseventsd', 'WindowServer', 'Finder', 'Robob', 'codex', 'opencode')
COUNTED = ('cua-driver', 'node', 'claude', 'codex', 'python')
COOLDOWN = 6 * 3600
CARD = 'Mac Upkeep #38 (fseventsd: #36)'
STATS = 'pid,command,mem,cmprs,cpu'


class ProbeError(Exception):
    pass


def number(value):
    match = re.fullmatch(r'(\d+(?:\.\d+)?)([BKMGTP]?)[+-]?', value.strip(), re.I)
    if not match:
        raise ProbeError('parse')
    # top's MEM is the footprint, already including CMPRS. Do not add it twice.
    return round(float(match[1]) * {'': 1/1024**2, 'B': 1/1024**2,
                 'K': 1/1024, 'M': 1, 'G': 1024, 'T': 1024**2,
                 'P': 1024**3}[match[2].upper()], 6)


def parse_swap(text):
    fields = dict(re.findall(r'\b(total|used)\s*=\s*([\d.]+[KMGT]?)', text, re.I))
    try:
        return dict(totalMb=number(fields['total']), usedMb=number(fields['used']))
    except KeyError:
        raise ProbeError('parse')


def parse_vm(text):
    page_size = re.search(r'page size of (\d+) bytes', text)
    if not page_size:
        raise ProbeError('parse')
    labels = {'Pages free': 'freePages', 'Pages active': 'activePages',
              'Pages inactive': 'inactivePages', 'Pages wired down': 'wiredPages',
              'Pages speculative': 'speculativePages', 'Pages purgeable': 'purgeablePages',
              'Pages occupied by compressor': 'compressorPages',
              'Swapins': 'swapins', 'Swapouts': 'swapouts'}
    values = dict((label.strip('"'), int(value)) for label, value in
                  re.findall(r'^([^:\n]+):\s*(\d+)\.?\s*$', text, re.M))
    if not labels.keys() <= values.keys():
        raise ProbeError('parse')
    return dict(pageSize=int(page_size[1]), **{key: values[label] for label, key in labels.items()})


def parse_top(text):
    if not re.search(r'^PID\s+COMMAND\s+MEM\s+CMPRS\s+%CPU\s*$', text, re.M):
        raise ProbeError('parse')
    rows = []
    for line in text.splitlines():
        if not re.match(r'^\d+\s', line):
            continue
        fields = line.split()
        try:
            cpu = float(fields[-1])
            if not math.isfinite(cpu) or cpu < 0:
                raise ValueError()
            rows.append(dict(pid=int(fields[0]), command=memory_command(' '.join(fields[1:-3])),
                             memMb=number(fields[-3]), cmprsMb=number(fields[-2]), cpu=cpu))
        except (ValueError, IndexError):
            raise ProbeError('parse')
    return rows


def parse_ps(text):
    rows = []
    for line in text.splitlines():
        parts = line.split(None, 3)
        if not parts:
            continue
        if len(parts) != 4 or not re.fullmatch(r'\d+(?:-\d+)?(?::\d+){1,2}', parts[2]):
            raise ProbeError('parse')
        try:
            rows.append(dict(pid=int(parts[0]), ppid=int(parts[1]), etime=parts[2],
                             command=Path(parts[3]).name))
        except ValueError:
            raise ProbeError('parse')
    if not rows:
        raise ProbeError('parse')
    return rows


def parse_io(text):
    if not re.search(r'KB/t\s+tps\s+MB/s', text):
        raise ProbeError('parse')
    rows = re.findall(r'^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$', text, re.M)
    if len(rows) != 2:
        raise ProbeError('parse')
    return dict(tps=float(rows[1][1]), mbPerS=float(rows[1][2]))


def pressure_free(text):
    match = re.search(r'System-wide memory free percentage:\s*(\d+)%', text)
    if not match or not 0 <= int(match[1]) <= 100:
        raise ProbeError('parse')
    return int(match[1])


def command(argv, run):
    env = {**os.environ, 'LC_ALL': 'C'}
    env.pop('BUN_INSPECT', None)
    try:
        result = run(argv, capture_output=True, text=True, timeout=10, env=env)
    except subprocess.TimeoutExpired:
        raise ProbeError('timeout')
    except OSError:
        raise ProbeError('unavailable')
    if result.returncode:
        raise ProbeError('exit')
    return result.stdout


def probe(argv, parser, run):
    try:
        return parser(command(argv, run)), None
    except (ProbeError, ValueError, UnicodeError) as exc:
        return None, str(exc) if isinstance(exc, ProbeError) else 'parse'


def swap_deltas(vm, boot, previous, now):
    result = dict(swapinsDelta=None, swapoutsDelta=None, deltaWindowS=None, deltaError=None)
    if vm is None or boot is None:
        result['deltaError'] = 'unavailable'
        return result
    previous = previous if isinstance(previous, dict) else {}
    old = previous.get('vm')
    old = old if isinstance(old, dict) else {}
    valid = (previous.get('boot') == boot and type(previous.get('at')) in (int, float)
             and 0 < now - previous['at'] <= 3600
             and all(type(old.get(k)) is int and vm[k] >= old[k] for k in ('swapins', 'swapouts')))
    if valid:
        result.update(swapinsDelta=vm['swapins']-old['swapins'],
                      swapoutsDelta=vm['swapouts']-old['swapouts'], deltaWindowS=now-previous['at'])
    else:
        result['deltaError'] = 'baseline'
    return result


def counted(rows):
    counts = {name: dict(command=name, count=0, ppid1Count=0) for name in COUNTED}
    for row in rows:
        name = row['command']
        if name.lower() in ('python', 'python3'):
            name = 'python'
        if name in counts:
            counts[name]['count'] += 1
            counts[name]['ppid1Count'] += int(row['ppid'] == 1)
    return list(counts.values())


def collect(run, previous, now):
    props = {}
    probes = (
        ('swap', ['/usr/sbin/sysctl', '-n', 'vm.swapusage'], parse_swap),
        ('vm', ['/usr/bin/vm_stat'], parse_vm),
        ('pressure', ['/usr/sbin/sysctl', '-n', 'vm.memory_pressure'], lambda s: int(s.strip())),
        ('freePercent', ['/usr/bin/memory_pressure', '-Q'], pressure_free),
        ('boot', ['/usr/sbin/sysctl', '-n', 'kern.boottime'],
         lambda s: int(re.search(r'\bsec\s*=\s*(\d+)', s)[1]) if re.search(r'\bsec\s*=\s*(\d+)', s) else None),
        ('top', ['/usr/bin/top', '-l', '1', '-o', 'mem', '-n', '15', '-stats', STATS], parse_top),
        ('processes', ['/bin/ps', '-axo', 'pid=,ppid=,etime=,comm='], parse_ps),
        ('io', ['/usr/sbin/iostat', '-d', '-c', '2', '-w', '1', 'disk0'], parse_io),
    )
    for key, argv, parser in probes:
        props[key], error = probe(argv, parser, run)
        if props[key] is None and error is None:
            error = 'parse'
        props[key+'Error'] = error
    try:
        props['load'] = list(os.getloadavg())
        props['loadError'] = None
    except OSError:
        props.update(load=None, loadError='unavailable')
    props.update(swap_deltas(props['vm'], props['boot'], previous, now))
    baseline = dict(vm=props['vm'], boot=props['boot'], at=now) if props['vm'] is not None and props['boot'] is not None else previous
    if props['vm'] is not None:
        props['vm'] = {k: v for k, v in props['vm'].items() if k not in ('swapins', 'swapouts')}
    rows = props.pop('processes')
    props['countsError'] = props.pop('processesError')
    props['counts'] = counted(rows) if rows is not None else None
    props['processCount'] = len(rows) if rows is not None else None
    props['ppid1Count'] = sum(p['ppid'] == 1 for p in rows) if rows is not None else None
    # ps supplies elapsed time and exact names, never args. A single filtered top
    # measures watched PIDs omitted from the first snapshot, including compression.
    props['watched'] = None
    props['watchedError'] = props['countsError']
    if rows is not None:
        watched = [p for p in rows if p['command'] in WATCHED]
        props['watchedOmitted'] = max(0, len(watched)-512)
        watched = watched[:512]
        observed = {p['pid']: p for p in props['top'] or []}
        missing = [p['pid'] for p in watched if p['pid'] not in observed]
        error = None
        if missing:
            argv = ['/usr/bin/top', '-l', '1', '-n', str(len(missing)), '-stats', STATS]
            for pid in missing:
                argv.extend(('-pid', str(pid)))
            extra, error = probe(argv, parse_top, run)
            observed.update((p['pid'], p) for p in extra or [])
        props['watchedError'] = error
        props['watched'] = [dict(pid=p['pid'], command=p['command'], etime=p['etime'],
            **({k: observed[p['pid']][k] for k in ('memMb', 'cmprsMb', 'cpu')}
               if p['pid'] in observed else dict(memMb=None, cmprsMb=None, cpu=None)),
            error=None if p['pid'] in observed else error or 'gone') for p in watched]
    return props, baseline


def pressure_streak(props, state, now):
    pressure, free = props.get('pressure'), props.get('freePercent')
    critical = (pressure is not None and pressure >= 2) or (free is not None and free < 15)
    previous = state.get('pressure')
    previous = previous if isinstance(previous, dict) else {}
    consecutive = previous.get('consecutive', 0)
    consecutive = consecutive if type(consecutive) is int else 0
    at = previous.get('at')
    # A failed observation or a missed cadence breaks consecutive evidence.
    recent = type(at) in (int, float) and 0 < now-at <= 600
    streak = min(2, consecutive+1) if critical and recent else int(critical)
    state['pressure'] = dict(at=now, consecutive=streak)
    props['criticalSamples'] = streak


def alert_reasons(props):
    reasons = {}
    swap = props.get('swap')
    if swap and swap['usedMb'] > 16 * 1024:
        reasons['swap'] = 'Swap %.1f/%.1f GB (over 16 GB)' % (swap['usedMb']/1024, swap['totalMb']/1024)
    if props.get('criticalSamples', 0) >= 2:
        reasons['pressure'] = 'Critical memory pressure in two consecutive samples'
    holders = {p['pid']: p for p in (props.get('top') or []) + (props.get('watched') or []) if p.get('memMb') is not None}
    ordered = sorted(holders.values(), key=lambda p: p['memMb'], reverse=True)
    if ordered and ordered[0]['memMb'] > 8 * 1024:
        reasons['footprint'] = '%s %.1f GB' % (ordered[0]['command'], ordered[0]['memMb']/1024)
    fsevents = [p for p in ordered if p['command'] == 'fseventsd' and p['memMb'] > 4 * 1024]
    if fsevents:
        reasons['fseventsd'] = 'fseventsd %.1f GB' % (fsevents[0]['memMb']/1024)
    top3 = ', '.join('%s %.1f GB' % (memory_command(p['command']), p['memMb']/1024) for p in ordered[:3]) or 'unavailable'
    return {reason: '%s; top: %s.\n%s' % (text, top3, CARD) for reason, text in reasons.items()}


def alerts(props, state, now, run):
    if not isinstance(state.get('alerts'), dict):
        state['alerts'] = {}
    entries = state['alerts']
    for reason, text in alert_reasons(props).items():
        entry = entries.get(reason, {})
        entry = entry if isinstance(entry, dict) else {}
        if type(entry.get('at')) in (int, float) and now - entry['at'] < COOLDOWN:
            continue
        # Retain the exact text/key before sending: a timeout may have queued it.
        pending = entry.get('pending')
        if not pending:
            stamp = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime('%Y%m%d:%H%M%S')
            pending = dict(key='mac-memory:%s:%s' % (reason, stamp), text=text)
        entries[reason] = dict(entry, pending=pending)
        save_state('memory', state)
        error = None
        try:
            command(['/Users/ardud/.bun/bin/bun', '/Users/ardud/.local/share/telegram-bridge/src/cli.ts',
                     'notify', '--source', 'Mac memory', '--severity', 'attention',
                     '--text', pending['text'], '--key', pending['key']], run)
        except ProbeError as exc:
            error = str(exc)
        emit('memory', 'error' if error else 'event', 'memory.alert', ok=error is None,
             props=dict(reason=reason, notifyError=error), error_tag='memory.notify_'+error if error else None)
        if error is None:
            entries[reason] = dict(at=now)
            save_state('memory', state)


def sample(run=subprocess.run, now=None, notify=True):
    started = time.monotonic()
    now = time.time() if now is None else now
    # Independent of inventory's lock. Also protects read/modify/write alert and
    # delta state if a manual diagnostic overlaps launchd.
    with state_path('memory').with_suffix('.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = read_state('memory')
        props, baseline = collect(run, state.get('baseline', {}), now)
        state['baseline'] = baseline
        pressure_streak(props, state, now)
        save_state('memory', state)
        errors = bool(props.get('watchedOmitted')) or any(value for key, value in props.items() if key.endswith('Error') and key != 'deltaError')
        emit('memory', 'error' if errors else 'event', 'memory.sample', ok=not errors,
             duration_ms=(time.monotonic()-started)*1000, props=props,
             error_tag='memory.partial' if errors else None)
        if notify:
            alerts(props, state, now, run)
        return props


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-alert', action='store_true', help='Sample only; do not notify Telegram')
    args = parser.parse_args()
    sample(notify=not args.no_alert)
