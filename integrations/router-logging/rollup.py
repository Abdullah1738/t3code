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


def interval_total(intervals):
    end, total = None, 0
    for start, stop in sorted(intervals):
        if end is None or start > end:
            total += stop - start
        elif stop > end:
            total += stop - end
        end = max(end or stop, stop)
    return round(total, 3)


def rollup(day, root=None):
    day = dt.date.fromisoformat(day).isoformat()
    root = Path(root) if root is not None else directory()
    counts, kinds, tags = Counter(), Counter(), Counter()
    times, samples = defaultdict(list), {}
    proxy = {}
    locks, lock_accounts = {}, Counter()
    unlocks = 0
    supervisor = dict(unresponsive=0, crawling=0, memoryHigh=0, killed=0,
                      exitedBySignal=Counter(), exitedByCode=Counter(), killedByReason=Counter())
    heartbeat_observations = {}
    day_start = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), dt.timezone.utc).timestamp() * 1000
    day_end = day_start + 86400000
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
                    if row['name'] == 'account.lock':
                        props = row.get('props', {})
                        dims = tuple(props.get(k, 'unknown') for k in ('provider', 'model', 'cause'))
                        if not all(isinstance(v, str) for v in dims):
                            raise ValueError('invalid lock dimensions')
                    total += 1
                    counts[row['name']] += 1
                    if row.get('component') == 'supervisor':
                        name = row['name']
                        props = row.get('props') if isinstance(row.get('props'), dict) else {}
                        counter = {'worker.unresponsive': 'unresponsive', 'worker.crawling': 'crawling',
                                   'worker.memory_high': 'memoryHigh', 'worker.killed': 'killed'}.get(name)
                        if counter:
                            supervisor[counter] += 1
                        if name == 'worker.exited':
                            signal = props.get('signal')
                            signals = {'SIGKILL', 'SIGTERM', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGQUIT', 'SIGILL', 'SIGTRAP'}
                            supervisor['exitedBySignal'][signal if isinstance(signal, str) and signal in signals else 'none' if signal is None else 'other'] += 1
                            code = props.get('code')
                            if type(code) is int:
                                supervisor['exitedByCode'][str(code)] += 1
                        if name == 'worker.killed':
                            reason = props.get('reason')
                            supervisor['killedByReason'][reason if isinstance(reason, str) and reason in {'memory', 'unresponsive', 'startup_failure', 'drain_timeout'} else 'other'] += 1
                        since = props.get('missingSince')
                        try:
                            at = dt.datetime.fromisoformat(row.get('ts', '').replace('Z', '+00:00'))
                            stop = at.timestamp() * 1000 if at.tzinfo is not None else None
                        except (ValueError, TypeError):
                            stop = None
                        if metric(since) and stop is not None and since <= stop:
                            ids = row.get('ids') if isinstance(row.get('ids'), dict) else {}
                            identity = tuple(v if isinstance(v, str) else 'unknown' for v in (ids.get('supervisor'), ids.get('worker')))
                            key = (*identity, since)
                            observation = heartbeat_observations.setdefault(key, dict(last=stop, terminal=None))
                            observation['last'] = max(observation['last'], stop)
                            if name in {'worker.recovered', 'worker.killed', 'worker.exited'}:
                                observation['terminal'] = min(observation['terminal'] or stop, stop)
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
                    if row['name'] in ('account.lock', 'account.unlock'):
                        props = row.get('props', {})
                        if row['name'] == 'account.unlock':
                            unlocks += 1
                        else:
                            group = locks.setdefault(dims, dict(count=0, durations=[]))
                            group['count'] += 1
                            if metric(props.get('lockMs')):
                                group['durations'].append(props['lockMs'])
                            account = row.get('ids', {}).get('account')
                            if isinstance(account, str) and len(account) == 16 and all(c in '0123456789abcdef' for c in account):
                                lock_accounts[account] += 1
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
    result['locks'] = dict(
        count=sum(g['count'] for g in locks.values()), unlocks=unlocks,
        byProviderModelCause=[dict(provider=p, model=m, cause=c, count=g['count'], lockMs=percentiles(g['durations'])) for (p, m, c), g in sorted(locks.items())],
        topAccounts=[dict(account=a, count=n) for a, n in lock_accounts.most_common(5)],
    )
    heartbeat_intervals, open_heartbeat = [], set()
    for (primary, worker, since), observation in heartbeat_observations.items():
        start = max(day_start, since)
        end = min(day_end, observation['terminal'] or observation['last'])
        if start < end:
            heartbeat_intervals.append((start, end))
            if observation['terminal'] is None:
                open_heartbeat.add((primary, worker))
    result['supervisor'] = {**supervisor, 'noHeartbeatMs': interval_total(heartbeat_intervals),
                            'openNoHeartbeatWorkers': len(open_heartbeat)}
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
