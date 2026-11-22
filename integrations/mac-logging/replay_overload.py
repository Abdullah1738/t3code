"""Streaming legacy telemetry adapter and reproducible overload replay."""
import argparse
from collections import Counter
import csv
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from overload import evaluate, iso, HOLD, number


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def legacy(row):
    if row.get('name') not in ('memory.sample', 'cpu.sample'):
        return None
    p = row.get('props', {})
    # Each emitted sample attempted these probes. Absence, null, a partial
    # object, or an error must invalidate its cache entry, never reuse success.
    load = p.get('load')
    v = dict(load=list(load) if not p.get('loadError') and isinstance(load, (list, tuple))
             and len(load) == 3 and all(number(x) for x in load) else None)
    if 'ncpu' in p:
        v['ncpu'] = p['ncpu']
    if row['name'] == 'memory.sample':
        pressure = p.get('pressureLevel')
        v['pressureLevel'] = pressure if not p.get('pressureLevelError') and number(pressure) else None
        swap = p.get('swap')
        for source, dest in (('usedMb', 'swapUsedBytes'), ('totalMb', 'swapTotalBytes')):
            value = swap.get(source) if isinstance(swap, dict) and not p.get('swapError') else None
            v[dest] = value*2**20 if number(value) else None
        vm = p.get('vm')
        free = vm.get('freePages') if isinstance(vm, dict) else None
        v['freePages'] = free if not p.get('vmError') and number(free) else None
    return timestamp(row['ts']), v


def day_rows(paths):
    for path in paths:
        with path.open() as stream:
            for line in stream:
                try:
                    value = legacy(json.loads(line))
                except (ValueError, KeyError):
                    continue
                if value:
                    yield value


def csv_rows(path):
    with path.open() as stream:
        for row in csv.DictReader(stream):
            values = dict.fromkeys(('load', 'swapUsedBytes', 'swapTotalBytes', 'freePages', 'pressureLevel'))
            for src, dst, scale in (('load1Max', 'load', 1), ('swapUsedMb', 'swapUsedBytes', 2**20),
                    ('swapTotalMb', 'swapTotalBytes', 2**20), ('freePages', 'freePages', 1),
                    ('pressureLevel', 'pressureLevel', 1)):
                if row.get(src):
                    v = float(row[src])*scale
                    values[dst] = [v, v, v] if dst == 'load' else v
            values['ncpu'] = 16
            yield timestamp(row['bucket']), values


def replay(rows, finish=None):
    state, transitions, cache = {}, [], {}
    tick = None
    count = 0
    def step(at):
        nonlocal state
        # Old sampling cadence is not starvation. Self-lag needs real host ticks.
        values = {k: v for k, (seen, v) in cache.items() if k == 'ncpu' or at-seen <= 360}
        state, actions = evaluate(state, values, at)
        for action in actions:
            transitions.append(dict(at=iso(at), **action['event']))
    for at, values in rows:
        if tick is None:
            tick = at
        if at < tick-30:
            continue
        while tick < at:
            step(tick)
            tick += 30
        cache.update({k: (at, v) for k, v in values.items()})
        count += 1
    if tick is not None:
        end = finish if finish is not None else max(t[0] for t in cache.values())
        while tick <= end:
            step(tick)
            tick += 30
    onsets = [r for r in transitions if r['phase'] == 'onset']
    return dict(rows=count, onsets=onsets,
                countByDay=dict(sorted(Counter(r['at'][:10] for r in onsets).items())),
                notifiedByDay=dict(sorted(Counter(r['at'][:10] for r in onsets if r['notified']).items())),
                transitions=transitions)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--logs', type=Path, required=True)
    parser.add_argument('--timeline', type=Path, required=True)
    parser.add_argument('--pressure', type=Path, required=True)
    parser.add_argument('--swap-hold', type=int, default=HOLD['swap'])
    parser.add_argument('--pressure-hold', type=int, default=HOLD['pressure'])
    args = parser.parse_args()
    HOLD.update(swap=args.swap_hold, pressure=args.pressure_hold)
    paths = [args.logs/('2026-11-%d.ndjson' % d) for d in range(15, 21)]
    result = dict(dayFiles=replay(day_rows(paths)), timeline=replay(csv_rows(args.timeline)))
    pressure = json.loads(args.pressure.read_text())
    result['pressure'] = {k: pressure[k] for k in ('period', 'groups', 'globalPauseCandidates')}
    active = False
    intervals = []
    for row in result['dayFiles']['transitions']:
        if row['phase'] == 'onset':
            start = timestamp(row['at'])
            active = True
        elif row['phase'] == 'end':
            intervals.append((start, timestamp(row['at'])))
            active = False
    if active:
        intervals.append((start, float('inf')))
    covered = [row for row in pressure['windows'] if any(a <= timestamp(row['start']) <= b for a,b in intervals)]
    result['pressure']['coveredWindows'] = len(covered)
    result['pressure']['totalWindows'] = len(pressure['windows'])
    result['pressure']['coveredStallMs'] = sum(row['stallMs'] for row in covered)
    result['sources'] = {str(p): digest(p) for p in paths+[args.timeline, args.pressure]}
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
