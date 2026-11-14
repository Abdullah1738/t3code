#!/usr/bin/python3
"""Daily aggregation; only the bounded shared fields reach the output."""
import argparse
from collections import Counter, defaultdict
import datetime as dt
import json
import math
import os
from pathlib import Path
import tempfile
from toollog import directory, private_dir, safe_fields, finite_number


def rollup(day, root=None):
    day = dt.date.fromisoformat(day).isoformat()
    root = Path(root) if root else directory()
    names, kinds, durations, tags, samples = Counter(), Counter(), defaultdict(list), Counter(), {}
    disk = dict(probes=0, timeouts=0, maxDurationMs=None, latestBlockedIn=None)
    inventory = dict(scans=0, rootsOk=0, rootsPartial=0, rootsTimeout=0, rootsDenied=0, scanMs=0)
    backup = {key: dict.fromkeys(('memory', 'health', 'other'), 0)
              for key in ('skipped_runs', 'ok_runs', 'failed_runs')}
    latest_blocked_at = ''
    waits = dict(runs=0, maxStuckForS=None, latestStuckUnmountMountPoint=None, busyRuns=0, topBusyComms=[])
    busy_comms = Counter()
    latest_unmount_at = ''
    total = oks = failed = outcomes = malformed = 0
    source = root / (day + '.ndjson')
    if source.exists():
        with source.open() as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                    if row.get('tool') != 'mac' or row.get('kind') not in ('event', 'perf', 'error'):
                        raise ValueError()
                    name, kind = row['name'], row['kind']
                    names[name] += 1
                    kinds[kind] += 1
                    total += 1
                    if type(row.get('ok')) is bool:
                        outcomes += 1
                        oks += row['ok']
                        failed += not row['ok']
                    if name == 'backup.run':
                        props = row.get('props', {})
                        target = props.get('target')
                        if target in ('memory', 'health', 'other'):
                            if props.get('skipped') == 1:
                                backup['skipped_runs'][target] += 1
                            elif props.get('skipped') == 0 and row.get('ok') is True:
                                backup['ok_runs'][target] += 1
                            elif props.get('skipped') == 0 and row.get('ok') is False:
                                backup['failed_runs'][target] += 1
                    value = row.get('durationMs')
                    if finite_number(value) and value >= 0:
                        durations[name].append(value)
                    if name == 'disk.tooling_probe':
                        props = row.get('props', {})
                        if not props.get('skipped'):
                            disk['probes'] += 1
                            disk['timeouts'] += props.get('timedOut') is True
                            if finite_number(value) and value >= 0:
                                disk['maxDurationMs'] = max(disk['maxDurationMs'] or 0, value)
                        blocked = props.get('blockedIn')
                        stamp = row.get('ts', '')
                        if blocked in ('SKHelperClient', 'SKManager', 'DiskArbitration', 'DASession', 'unknown') and stamp >= latest_blocked_at:
                            disk['latestBlockedIn'], latest_blocked_at = blocked, stamp
                    if name == 'disk.inventory' and not row.get('props', {}).get('skipReason'):
                        inventory['scans'] += 1
                        props = safe_fields(row.get('props'))
                        for key in ('rootsOk', 'rootsPartial', 'rootsTimeout', 'rootsDenied', 'scanMs'):
                            value = props.get(key)
                            if type(value) in (int, float) and value >= 0:
                                inventory[key] += value
                    if name == 'proc.disk_wait':
                        raw = row.get('props', {})
                        props = safe_fields(raw, name)
                        # Legacy ageS measured uptime, not a stuck duration. Keep
                        # its maximum separate so old days remain readable.
                        for proc in raw.get('procs', []):
                            age = proc.get('ageS') if isinstance(proc, dict) and 'processAgeS' not in proc else None
                            if type(age) is int and age >= 0:
                                waits['legacyMaxProcessAgeS'] = max(waits.get('legacyMaxProcessAgeS', 0), age)
                        count = props.get('count', 0)
                        if count > 0:
                            waits['runs'] += 1
                        for proc in props.get('procs', []):
                            waits['maxStuckForS'] = max(waits['maxStuckForS'] or 0, proc['stuckForS'])
                        if props.get('busyCount', 0) > 0:
                            waits['busyRuns'] += 1
                        busy_comms.update(p['comm'] for p in props.get('busy', []))
                        mount = props.get('mountPoint')
                        stamp = row.get('ts', '')
                        if props.get('stuckUnmount') and mount and stamp >= latest_unmount_at:
                            waits['latestStuckUnmountMountPoint'], latest_unmount_at = mount, stamp
                    tag = row.get('error', {}).get('tag')
                    if tag:
                        tags[tag] += 1
                        samples.setdefault(tag, safe_fields(row.get('ids')))
                except (ValueError, TypeError, KeyError, AttributeError):
                    malformed += 1
    waits['topBusyComms'] = [dict(comm=comm, count=count) for comm, count in busy_comms.most_common(5)]
    stats = {}
    for name, values in durations.items():
        values.sort()
        stats[name] = {key: values[max(0, math.ceil(len(values) * pct) - 1)] for key, pct in [('p50', .5), ('p95', .95), ('max', 1)]}
    result = dict(day=day, tool='mac', backup=backup, diskTooling=disk, diskWait=waits, diskInventory=inventory, total=total, countsByName=dict(names), countsByKind=dict(kinds),
                  outcomes=outcomes, okRate=oks / outcomes if outcomes else None,
                  errorRate=kinds['error'] / total if total else None,
                  failedRate=failed / outcomes if outcomes else None, durationMs=stats, malformed=malformed,
                  topErrors=[dict(tag=t, count=c, sampleIds=samples[t]) for t, c in tags.most_common(20)])
    private_dir(root)
    fd, temp = tempfile.mkstemp(prefix='.rollup-', dir=root)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(result, stream, separators=(',', ':'))
        os.replace(temp, root / ('rollup-' + day + '.json'))
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--day', default=(dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat())
    args = parser.parse_args()
    print(json.dumps(rollup(args.day), indent=2))


if __name__ == '__main__':
    main()
