import argparse
from collections import Counter, defaultdict
import datetime as dt
import json
import math
import os
from pathlib import Path
import tempfile
from toollog import directory
from volume import REASONS, integer


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


def lock_identity(row, fallback):
    props = row.get('props', {})
    account = row.get('ids', {}).get('account')
    try:
        until = dt.datetime.fromisoformat(props['until'].replace('Z', '+00:00'))
        identity = (account, props.get('provider'), props.get('model'))
        if until.tzinfo is None or not all(isinstance(value, str) and value.strip() and value.strip().lower() != 'unknown' for value in identity):
            return fallback
        minute = until.astimezone(dt.timezone.utc).replace(second=0, microsecond=0).isoformat()
        return (*identity, minute)
    except (KeyError, ValueError, TypeError, AttributeError):
        # Legacy rows without an identity cannot safely be deduplicated.
        return fallback


def rollup(day, root=None, now=None):
    day = dt.date.fromisoformat(day).isoformat()
    generated = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    next_day = dt.datetime.combine(dt.date.fromisoformat(day) + dt.timedelta(days=1), dt.time(), dt.timezone.utc)
    root = Path(root) if root is not None else directory()
    counts, kinds, tags = Counter(), Counter(), Counter()
    times, samples = defaultdict(list), {}
    proxy = {}
    models = defaultdict(lambda: dict(count=0, aborted=0))
    abort_clients, abort_keys, attempts = Counter(), Counter(), Counter()
    abort_ttfb = []
    locks, lock_accounts = {}, Counter()
    distinct, account_distinct = set(), defaultdict(set)
    unlocks = 0
    supervisor = dict(unresponsive=0, crawling=0, memoryHigh=0, killed=0,
                      exitedBySignal=Counter(), exitedByCode=Counter(), killedByReason=Counter())
    heartbeat_observations = {}
    day_start = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), dt.timezone.utc).timestamp() * 1000
    day_end = day_start + 86400000
    volume_writers = {}
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
                            group = locks.setdefault(dims, dict(count=0, durations=[], distinct=set(), capped=0, resets=[]))
                            group['count'] += 1
                            identity = lock_identity(row, total)
                            distinct.add(identity)
                            group['distinct'].add(identity)
                            group['capped'] += props.get('capped') is True
                            if metric(props.get('upstreamResetMs')):
                                group['resets'].append(props['upstreamResetMs'])
                            if metric(props.get('lockMs')):
                                group['durations'].append(props['lockMs'])
                            account = row.get('ids', {}).get('account')
                            if isinstance(account, str) and len(account) == 16 and all(c in '0123456789abcdef' for c in account):
                                lock_accounts[account] += 1
                                account_distinct[account].add(identity)
                    if row['name'] == 'log.volume':
                        writer = row.get('ids', {}).get('writer')
                        props = row.get('props', {})
                        drops = props.get('droppedByReason')
                        if (isinstance(writer, str) and len(writer) == 16 and all(c in '0123456789abcdef' for c in writer)
                                and isinstance(drops, dict) and all(k in REASONS and integer(v) for k,v in drops.items())
                                and integer(props.get('droppedLines')) and props['droppedLines'] == sum(drops.values())):
                            previous = volume_writers.setdefault(writer, Counter())
                            for reason,count in drops.items():
                                previous[reason] = max(previous[reason], count)
                    if row['name'] == 'proxy.request':
                        group = proxy.setdefault(key, dict(count=0, aborted=0, durations=[], ttfb=[], errors=Counter(), samples={}))
                        group['count'] += 1
                        aborted = props.get('status') == 499 or props.get('clientState', props.get('client')) == 'aborted'
                        group['aborted'] += aborted
                        model = models[key[0]]
                        model['count'] += 1
                        model['aborted'] += aborted
                        attempt_count = props.get('attempts')
                        if isinstance(attempt_count, int) and not isinstance(attempt_count, bool) and attempt_count >= 0:
                            attempts[attempt_count] += 1
                        if aborted:
                            client = props.get('client', 'unknown')
                            abort_clients[client if client in ('claude-code', 'codex', 'curl', 'node', 'python', 'browser', 'other') else 'unknown'] += 1
                            key_id = props.get('keyId', 'unknown')
                            if not isinstance(key_id, str) or not (key_id in ('none', 'unknown') or len(key_id) == 16 and all(c in '0123456789abcdef' for c in key_id)):
                                key_id = 'unknown'
                            abort_keys[key_id] += 1
                            if metric(props.get('ttfbMs')):
                                abort_ttfb.append(props['ttfbMs'])
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
    result.update(generatedAt=generated.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), complete=generated >= next_day)
    result['proxy'] = []
    for (model, route, stream), group in sorted(proxy.items()):
        result['proxy'].append(dict(
            model=model, route=route, stream=stream, count=group['count'],
            clientAbortRate=group['aborted'] / group['count'],
            durationMs=percentiles(group['durations']),
            ttfbMs=percentiles(group['ttfb']),
            topErrors=[dict(tag=tag, count=count, sampleReq=group['samples'][tag]) for tag, count in group['errors'].most_common(20)],
        ))
    result['proxySummary'] = dict(
        byModel=[dict(model=m, **g, clientAbortRate=g['aborted'] / g['count']) for m, g in sorted(models.items())],
        abortsByClient=dict(sorted(abort_clients.items())), abortsByKeyId=dict(sorted(abort_keys.items())),
        attemptsHistogram={str(n): count for n, count in sorted(attempts.items())},
        abortTtfbMs=percentiles(abort_ttfb),
    )
    result['locks'] = dict(
        count=sum(g['count'] for g in locks.values()), distinct=len(distinct), unlocks=unlocks,
        byProviderModelCause=[dict(provider=p, model=m, cause=c, count=g['count'], distinct=len(g['distinct']), capped=g['capped'], upstreamResetMs=percentiles(g['resets']), lockMs=percentiles(g['durations'])) for (p, m, c), g in sorted(locks.items())],
        topAccounts=[dict(account=a, count=n, distinct=len(account_distinct[a])) for a, n in lock_accounts.most_common(5)],
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
    drops = Counter()
    for writer in volume_writers.values():
        drops.update(writer)
    result['droppedLines'] = sum(drops.values()) if volume_writers else None
    result['dropsByReason'] = dict(sorted(drops.items()))
    result['volumeWriters'] = len(volume_writers)
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
