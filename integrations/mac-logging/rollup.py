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
from toollog import directory, private_dir, safe_fields


def rollup(day, root=None):
    day = dt.date.fromisoformat(day).isoformat()
    root = Path(root) if root else directory()
    names, kinds, durations, tags, samples = Counter(), Counter(), defaultdict(list), Counter(), {}
    disk = dict(probes=0, timeouts=0, maxDurationMs=None, latestBlockedIn=None)
    inventory = dict(scans=0, rootsOk=0, rootsPartial=0, rootsTimeout=0, rootsDenied=0, scanMs=0)
    latest_blocked_at = ''
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
                    value = row.get('durationMs')
                    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                        durations[name].append(value)
                    if name == 'disk.tooling_probe':
                        props = row.get('props', {})
                        if not props.get('skipped'):
                            disk['probes'] += 1
                            disk['timeouts'] += props.get('timedOut') is True
                            if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                                disk['maxDurationMs'] = max(disk['maxDurationMs'] or 0, value)
                        blocked = props.get('blockedIn')
                        stamp = row.get('ts', '')
                        if blocked in ('SKHelperClient', 'SKManager', 'DiskArbitration', 'DASession', 'unknown') and stamp >= latest_blocked_at:
                            disk['latestBlockedIn'], latest_blocked_at = blocked, stamp
                    if name == 'disk.inventory':
                        inventory['scans'] += 1
                        props = safe_fields(row.get('props'))
                        for key in ('rootsOk', 'rootsPartial', 'rootsTimeout', 'rootsDenied', 'scanMs'):
                            value = props.get(key)
                            if type(value) in (int, float) and value >= 0:
                                inventory[key] += value
                    tag = row.get('error', {}).get('tag')
                    if tag:
                        tags[tag] += 1
                        samples.setdefault(tag, safe_fields(row.get('ids')))
                except (ValueError, TypeError, KeyError, AttributeError):
                    malformed += 1
    stats = {}
    for name, values in durations.items():
        values.sort()
        stats[name] = {key: values[max(0, math.ceil(len(values) * pct) - 1)] for key, pct in [('p50', .5), ('p95', .95), ('max', 1)]}
    result = dict(day=day, tool='mac', diskTooling=disk, diskInventory=inventory, total=total, countsByName=dict(names), countsByKind=dict(kinds),
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
