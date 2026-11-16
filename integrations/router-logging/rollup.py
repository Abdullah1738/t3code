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
    locks, lock_accounts = {}, Counter()
    distinct, account_distinct = set(), defaultdict(set)
    unlocks = 0
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
    result['locks'] = dict(
        count=sum(g['count'] for g in locks.values()), distinct=len(distinct), unlocks=unlocks,
        byProviderModelCause=[dict(provider=p, model=m, cause=c, count=g['count'], distinct=len(g['distinct']), capped=g['capped'], upstreamResetMs=percentiles(g['resets']), lockMs=percentiles(g['durations'])) for (p, m, c), g in sorted(locks.items())],
        topAccounts=[dict(account=a, count=n, distinct=len(account_distinct[a])) for a, n in lock_accounts.most_common(5)],
    )
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
