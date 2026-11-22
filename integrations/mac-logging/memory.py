#!/usr/bin/python3
"""Five-minute, read-only memory observations; no process arguments are collected."""
import datetime as dt
import fcntl
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
ESCALATION_GAP = 30 * 60
CARD = 'Mac Upkeep #38 (fseventsd: #36)'
STATS = 'pid,command,mem,cmprs'


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
    if not re.search(r'^PID\s+COMMAND\s+MEM\s+CMPRS\s*$', text, re.M):
        raise ProbeError('parse')
    rows = []
    for line in text.splitlines():
        if not re.match(r'^\d+\s', line):
            continue
        fields = line.split()
        try:
            rows.append(dict(pid=int(fields[0]), command=memory_command(' '.join(fields[1:-2])),
                             memMb=number(fields[-2]), cmprsMb=number(fields[-1])))
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
            detail = parts[3].split(None, 5)
            start = ' '.join(detail[:5]) if len(detail) == 6 and re.fullmatch(
                r'[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}', ' '.join(detail[:5])) else None
            row = dict(pid=int(parts[0]), ppid=int(parts[1]), etime=parts[2],
                       command=Path(detail[5] if start else parts[3]).name)
            if start:
                row['start'] = start
            rows.append(row)
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


def command(argv, run, timeout=10):
    env = {**os.environ, 'LC_ALL': 'C'}
    env.pop('BUN_INSPECT', None)
    try:
        result = run(argv, capture_output=True, text=True, timeout=timeout, env=env)
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
        ('pressureLevel', ['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level'], lambda s: int(s.strip())),
        ('freePercent', ['/usr/bin/memory_pressure', '-Q'], pressure_free),
        ('boot', ['/usr/sbin/sysctl', '-n', 'kern.boottime'],
         lambda s: int(re.search(r'\bsec\s*=\s*(\d+)', s)[1]) if re.search(r'\bsec\s*=\s*(\d+)', s) else None),
        ('top', ['/usr/bin/top', '-l', '1', '-o', 'mem', '-stats', STATS], parse_top),
        ('processes', ['/bin/ps', '-axo', 'pid=,ppid=,etime=,lstart=,comm='], parse_ps),
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
    # One full top snapshot supplies both sets. ps adds exact names and elapsed
    # time without argv, so truncated COMMAND labels cannot hide watched PIDs.
    snapshot = props['top']
    identities = {p['pid']: p for p in rows or []}
    for p in snapshot or []:
        identity = identities.get(p['pid'], {})
        p.update({k: identity[k] for k in ('start', 'etime') if k in identity})
    props['fallback'] = []
    if props['topError'] == 'timeout' and props['boot'] == previous.get('boot'):
        # Recheck birth before and after the footprint probe: a reused PID must
        # not inherit the previous holder's alarm or growth history.
        for old in (previous.get('holders') or [])[:3]:
            p = identities.get(old.get('pid'), {}) if rows is not None else old
            if not p.get('start') or p['start'] != old.get('start'):
                continue
            observed = dict(pid=p['pid'], command=p.get('command', '[redacted]'), start=p['start'],
                            memMb=None, cmprsMb=None, error=None)
            if p.get('etime'):
                observed['etime'] = p['etime']
            try:
                if rows is None:
                    birth = ' '.join(command(['/bin/ps', '-p', str(p['pid']), '-o', 'lstart='], run, 5).split())
                    if birth != p['start']:
                        raise ProbeError('gone')
                text = command(['/usr/bin/footprint', '-p', str(p['pid']), '--noCategories', '-f', 'bytes'], run, 5)
                match = re.search(r'^\s*phys_footprint:\s*(\d+)\s+B\s*$', text, re.M)
                if not match:
                    raise ProbeError('parse')
                birth = ' '.join(command(['/bin/ps', '-p', str(p['pid']), '-o', 'lstart='], run, 5).split())
                if birth != p['start']:
                    raise ProbeError('gone')
                observed['memMb'] = int(match[1])/1024**2
            except ProbeError as exc:
                observed['error'] = str(exc)
            props['fallback'].append(observed)
    if snapshot is not None:
        baseline = dict(baseline, holders=[dict(p) for p in snapshot[:3]])
    elif previous.get('holders'):
        baseline = dict(baseline, holders=previous['holders'])
    # Decisions need the full snapshot; toollog bounds the displayed top list.
    props['top'] = snapshot
    props['watched'] = None
    props['watchedError'] = props['countsError'] or props['topError']
    if rows is not None:
        watched = [p for p in rows if p['command'] in WATCHED]
        props['watchedOmitted'] = max(0, len(watched)-512)
        watched = watched[:512]
        observed = {p['pid']: p for p in snapshot or []}
        props['watched'] = [dict(pid=p['pid'], command=p['command'], etime=p['etime'],
            **({'start': p['start']} if p.get('start') else {}),
            **({k: observed[p['pid']][k] for k in ('memMb', 'cmprsMb')}
               if p['pid'] in observed else dict(memMb=None, cmprsMb=None)),
            error=None if p['pid'] in observed else props['topError'] or 'gone') for p in watched]
    return props, baseline


def pressure_streak(props, state, now):
    pressure, free = props.get('pressureLevel'), props.get('freePercent')
    critical = (pressure == 4) or (free is not None and free < 15)
    # New state key discards streaks built from the old raw counter.
    state.pop('pressure', None)
    previous = state.get('pressureLevel')
    previous = previous if isinstance(previous, dict) else {}
    consecutive = previous.get('consecutive', 0)
    consecutive = consecutive if type(consecutive) is int else 0
    at = previous.get('at')
    # A failed observation or a missed cadence breaks consecutive evidence.
    recent = type(at) in (int, float) and 0 < now-at <= 600
    streak = min(2, consecutive+1) if critical and recent else int(critical)
    state['pressureLevel'] = dict(at=now, consecutive=streak)
    props['criticalSamples'] = streak


def elapsed_seconds(value):
    days, _, clock = value.rpartition('-')
    parts = [int(part) for part in clock.split(':')]
    seconds = sum(part * 60**i for i, part in enumerate(reversed(parts)))
    return int(days or 0)*86400 + seconds


def growth_history(procs, previous, boot, now, threshold, gap=False, require_start=False):
    previous = previous if isinstance(previous, dict) else {}
    current, candidates = {}, []
    for proc in procs:
        if proc.get('memMb') is None or boot is None or require_start and not proc.get('start'):
            continue
        pid = str(proc['pid'])
        old = previous.get(pid)
        old = old if isinstance(old, dict) else {}
        age = elapsed_seconds(proc['etime']) if proc.get('etime') else None
        if not proc.get('start') and age is None:
            continue
        interval = now-old['at'] if type(old.get('at')) in (int, float) else 0
        same_birth = (proc['start'] == old.get('start') if proc.get('start') else
                      type(age) is int and type(old.get('ageS')) is int
                      and age > old['ageS'] and abs(age-old['ageS']-interval) <= 10)
        valid = (0 < interval <= (1200 if old.get('gap') else 600) and old.get('boot') == boot and same_birth
                 and type(old.get('memMb')) in (int, float))
        rate = max(0, (proc['memMb']-old['memMb'])*3600/interval) if valid else None
        growing = rate is not None and rate > threshold
        count = old.get('consecutive', 0)
        count = count if type(count) is int and 0 <= count <= 1000 else 0
        streak = min(1000, count+1) if growing else 0
        since = old.get('since') if growing and count else now-interval
        since = since if type(since) in (int, float) and since <= now-interval else now-interval
        window = now-since if growing else 0
        current[pid] = dict(at=now, boot=boot, start=proc.get('start'), ageS=age, memMb=proc['memMb'],
                            consecutive=streak, since=since if growing else now, gap=False)
        candidates.append(dict(proc, growthSamples=streak, growthWindowS=window, growthMbPerHour=rate))
    if gap:
        for pid, old in previous.items():
            if pid not in current and old.get('boot') == boot and 0 < now-old.get('at', now) <= 1200:
                current[pid] = dict(old, gap=True)
    return current, candidates


def holders(props):
    return list({p['pid']: p for p in (props.get('top') or [])+(props.get('watched') or [])+
                 (props.get('fallback') or []) if p.get('memMb') is not None}.values())


def fseventsd_growth(props, state, now):
    procs = [p for p in holders(props) if p['command'] == 'fseventsd']
    current, candidates = growth_history(procs, state.get('fseventsdGrowth'), props.get('boot'), now, 100,
                                        gap=props.get('topError') == 'timeout' or props.get('countsError') == 'timeout')
    state['fseventsdGrowth'] = current
    best = max(candidates, key=lambda p: (p['growthSamples'], p['growthMbPerHour'] or 0)) if candidates else {}
    props.update(fseventsdGrowthSamples=min(3, best.get('growthSamples', 0)), fseventsdGrowthPid=best.get('pid'),
                 fseventsdGrowthWindowS=best.get('growthWindowS', 0), fseventsdGrowthMbPerHour=best.get('growthMbPerHour'))


def process_growth(props, state, now):
    current, candidates = growth_history(holders(props), state.get('processGrowth'), props.get('boot'), now, 1024,
                                        gap=props.get('topError') == 'timeout' or props.get('countsError') == 'timeout', require_start=True)
    state['processGrowth'] = current
    props['growth'] = candidates


def alert_reasons(props):
    reasons = {}
    swap = props.get('swap')
    if swap and swap['usedMb'] > 16 * 1024:
        reasons['swap'] = 'Swap %.1f/%.1f GB (over 16 GB)' % (swap['usedMb']/1024, swap['totalMb']/1024)
    if props.get('criticalSamples', 0) >= 2:
        reasons['pressure'] = 'Critical memory pressure in two consecutive samples'
    ordered = sorted(holders(props), key=lambda p: p['memMb'], reverse=True)
    if ordered and ordered[0]['memMb'] > 8 * 1024:
        reasons['footprint'] = '%s %.1f GB' % (ordered[0]['command'], ordered[0]['memMb']/1024)
    fsevents = [p for p in ordered if p['command'] == 'fseventsd' and p['memMb'] > 2 * 1024]
    if fsevents:
        reasons['fseventsd'] = 'fseventsd %.1f GB' % (fsevents[0]['memMb']/1024)
    if props.get('fseventsdGrowthSamples', 0) >= 3 and props.get('fseventsdGrowthWindowS', 0) >= 900:
        reasons['fseventsd_growth'] = 'fseventsd growing %.0f MiB/h for %.0f min' % (
            props['fseventsdGrowthMbPerHour'], props['fseventsdGrowthWindowS']/60)
    if growth_candidates(props):
        reasons['growth'] = 'Sustained process growth over 1 GiB/h for 30 minutes'
    return reasons


def growth_candidates(props):
    return [p for p in props.get('growth') or [] if p['memMb'] >= 4*1024
            and p['growthSamples'] >= 3 and p['growthWindowS'] >= 1800]


def holder_key(proc, boot):
    if proc.get('start') and boot is not None:
        return '%s:%s:%s' % (boot, proc['pid'], proc['start'])
    return None


def alert_detail(props, reason, entry):
    ordered = sorted(holders(props), key=lambda p: p['memMb'], reverse=True)
    candidates = (growth_candidates(props) if reason == 'growth' else
                  [p for p in ordered if p['memMb'] > 8*1024] if reason == 'footprint' else
                  [p for p in ordered if p['command'] == 'fseventsd' and p['memMb'] > 2*1024] if reason == 'fseventsd' else
                  [p for p in ordered if p['pid'] == props.get('fseventsdGrowthPid')] if reason == 'fseventsd_growth' else ordered)
    prior = entry.get('holders', {})
    prior = prior if isinstance(prior, dict) else {}
    escalations = [p for p in candidates if holder_key(p, props.get('boot')) is not None and (
        holder_key(p, props.get('boot')) not in prior or
        p['memMb']-prior[holder_key(p, props.get('boot'))]['memMb'] >= 4096)]
    proc = (escalations or candidates or [{}])[0]
    escalation = bool(escalations) and reason in ('footprint', 'growth')
    if reason == 'swap':
        escalation = (props.get('swap') is not None and type(entry.get('usedMb')) in (int, float)
                      and props['swap']['usedMb']-entry['usedMb'] >= 4096)
    rates = {p['pid']: p.get('growthMbPerHour') for p in props.get('growth') or []}
    rate = rates.get(proc.get('pid'))
    if reason == 'fseventsd_growth':
        rate = props.get('fseventsdGrowthMbPerHour')
    detail = dict(pid=proc.get('pid'), command=proc.get('command'), footprintGiB=proc.get('memMb', 0)/1024 if proc else None,
                  growthGiBHour=rate/1024 if rate is not None else None, escalation=escalation and type(entry.get('at')) in (int, float),
                  fallback=any(p['pid'] == proc.get('pid') and p.get('memMb') is not None for p in props.get('fallback') or []))
    measured = dict(boot=props.get('boot'), holder=dict(proc), holders=candidates,
                    usedMb=(props.get('swap') or {}).get('usedMb'))
    return detail, measured


def alert_text(props, reason, detail):
    holder = '%s pid %s: %.1f GB (+%s GB/h)' % (
        memory_command(detail['command']), detail['pid'], detail['footprintGiB'],
        '%.1f' % detail['growthGiBHour'] if detail['growthGiBHour'] is not None else '?') if detail['pid'] else 'top holder unavailable'
    swap = (props.get('swap') or {}).get('usedMb')
    vm = props.get('vm') or {}
    compressor = vm.get('compressorPages', 0)*vm.get('pageSize', 0)/1024**3 if vm else None
    suffix = ' (escalation)' if detail['escalation'] else ''
    fs = '; %.0f MiB/h' % props['fseventsdGrowthMbPerHour'] if reason == 'fseventsd_growth' else ''
    return '%s%s: %s%s.\nSwap %s GB; compressor %s GB. %s' % (
        reason, suffix, holder, fs, '%.1f' % (swap/1024) if swap is not None else '?',
        '%.1f' % compressor if compressor is not None else '?', CARD)


def alerts(props, state, now, run):
    if not isinstance(state.get('alerts'), dict):
        state['alerts'] = {}
    entries = state['alerts']
    reasons = alert_reasons(props)
    for reason in dict.fromkeys(list(reasons)+[k for k, v in entries.items() if isinstance(v, dict) and v.get('pending')]):
        entry = entries.get(reason, {})
        entry = entry if isinstance(entry, dict) else {}
        detail, measurement = alert_detail(props, reason, entry)
        # Retain the exact text/key before sending: a timeout may have queued it.
        pending = entry.get('pending')
        if not pending:
            age = now-entry['at'] if type(entry.get('at')) in (int, float) else None
            # Old six-hour receipts have no baseline. Seed without re-alerting
            # so an upgrade doesn't turn a steady holder into an escalation.
            if age is not None and age < COOLDOWN and reason in ('footprint', 'growth', 'swap') and 'holders' not in entry:
                history = {holder_key(p, measurement['boot']): dict(memMb=p['memMb'], at=now)
                           for p in measurement['holders'] if holder_key(p, measurement['boot'])}
                entry.update(holders=history, usedMb=measurement['usedMb'])
                entries[reason] = entry
                save_state('memory', state)
                continue
            if age is not None and (age < ESCALATION_GAP or age < COOLDOWN and not detail['escalation']):
                continue
            stamp = dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime('%Y%m%d:%H%M%S')
            pending = dict(key='mac-memory:%s:%s' % (reason, stamp), text=alert_text(props, reason, detail),
                           detail=detail, measurement=measurement)
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
             props=dict(reason=reason, notifyError=error, **pending.get('detail', detail)), error_tag='memory.notify_'+error if error else None)
        if error is None:
            measured = pending.get('measurement', measurement)
            qualifying = {holder_key(p, measured['boot']) for p in measured.get('holders', [measured['holder']])}
            history = {k: v for k, v in entry.get('holders', {}).items()
                       if k in qualifying or now-v.get('at', 0) <= COOLDOWN}
            selected = holder_key(measured['holder'], measured['boot'])
            # An initial alarm also establishes baselines for its other steady
            # holders; they must not become a new incident thirty minutes later.
            for p in measured.get('holders', [measured['holder']]):
                key = holder_key(p, measured['boot'])
                if key and (key not in history or key == selected):
                    history[key] = dict(memMb=p['memMb'], at=now)
            entries[reason] = dict(at=now, holders=dict(list(history.items())[-512:]), usedMb=measured['usedMb'])
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
        fseventsd_growth(props, state, now)
        process_growth(props, state, now)
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
