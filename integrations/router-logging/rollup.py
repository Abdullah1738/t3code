import argparse
from collections import Counter, defaultdict
import datetime as dt
import json
import math
import os
from pathlib import Path
import tempfile
from toollog import directory


def percentiles(values):
    if not values:
        return None
    values.sort()
    return dict(p50=values[math.ceil(len(values) * .50) - 1], p95=values[math.ceil(len(values) * .95) - 1], max=values[-1])


def metric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def rollup(day, root=None):
    day = dt.date.fromisoformat(day).isoformat()
    root = Path(root) if root is not None else directory()
    counts, kinds, tags = Counter(), Counter(), Counter()
    times, samples = defaultdict(list), {}
    proxy = {}
    ok = failed = total = malformed = 0
    source = root / (day + '.ndjson')
    if source.exists():
        with source.open() as lines:
            for line in lines:
                try:
                    row = json.loads(line)
                    if row.get('tool') != '9router' or row.get('kind') not in ('event', 'perf', 'error') or not isinstance(row.get('name'), str):
                        raise ValueError('invalid line')
                    if row['name'] == 'proxy.request':
                        props = row.get('props', {})
                        key = (props.get('model', 'unknown'), props.get('route', 'unknown'), props.get('stream'))
                        if not isinstance(key[0], str) or not isinstance(key[1], str) or not isinstance(key[2], bool):
                            raise ValueError('invalid proxy dimensions')
                    total += 1
                    counts[row['name']] += 1
                    kinds[row['kind']] += 1
                    ok += row.get('ok') is True
                    failed += row.get('ok') is False
                    ms = row.get('durationMs')
                    if isinstance(ms, (int, float)) and math.isfinite(ms) and ms >= 0:
                        times[row['name']].append(ms)
                    tag = row.get('error', {}).get('tag')
                    if tag:
                        tags[tag] += 1
                        samples.setdefault(tag, row.get('ids', {}))
                    if row['name'] == 'proxy.request':
                        group = proxy.setdefault(key, dict(count=0, aborted=0, durations=[], ttfb=[], errors=Counter(), samples={}))
                        group['count'] += 1
                        group['aborted'] += props.get('client') == 'aborted'
                        if metric(ms):
                            group['durations'].append(ms)
                        if metric(props.get('ttfbMs')):
                            group['ttfb'].append(props['ttfbMs'])
                        if tag:
                            group['errors'][tag] += 1
                            group['samples'].setdefault(tag, row.get('ids', {}).get('req'))
                except (ValueError, TypeError, AttributeError):
                    malformed += 1
    durations = {}
    for name, values in times.items():
        values.sort()
        durations[name] = {'p50': values[math.ceil(len(values) * .50) - 1], 'p95': values[math.ceil(len(values) * .95) - 1], 'max': values[-1]}
    measured = ok + failed
    result = dict(day=day, total=total, malformed=malformed, countsByName=dict(counts), countsByKind=dict(kinds), okRate=ok / measured if measured else None, errorRate=kinds['error'] / total if total else None, failedRate=failed / measured if measured else None, durationMs=durations, topErrors=[dict(tag=tag, count=count, sampleIds=samples[tag]) for tag, count in tags.most_common(20)])
    result['proxy'] = []
    for (model, route, stream), group in sorted(proxy.items()):
        result['proxy'].append(dict(
            model=model, route=route, stream=stream, count=group['count'],
            clientAbortRate=group['aborted'] / group['count'],
            durationMs=percentiles(group['durations']),
            ttfbMs=percentiles(group['ttfb']),
            topErrors=[dict(tag=tag, count=count, sampleReq=group['samples'][tag]) for tag, count in group['errors'].most_common(20)],
        ))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    fd, tmp = tempfile.mkstemp(prefix='.rollup-', dir=root)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(result, out, separators=(',', ':'))
            out.write('\n')
        os.replace(tmp, root / ('rollup-' + day + '.json'))
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--day', default=(dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat())
    args = p.parse_args()
    print(json.dumps(rollup(args.day)))

if __name__ == '__main__':
    main()
