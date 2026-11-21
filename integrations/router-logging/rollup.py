import argparse
from collections import Counter, defaultdict
import datetime as dt
import json
import ipaddress
import math
import os
import re
from pathlib import Path
import tempfile
from toollog import directory, safe_target, token, CONNECTION_ERRNOS, SYSCALLS
from volume import REASONS, integer
from listener_rollup import windows as listener_windows
from pool_rollup import summarize as pool_summary
from observer import gap_summary, measured, observed


def percentiles(values):
    if not values:
        return None
    values.sort()
    return dict(p50=values[math.ceil(len(values) * .50) - 1], p95=values[math.ceil(len(values) * .95) - 1], max=values[-1])


def metric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def proxy_key_id(value):
    if isinstance(value, str) and (value in ('none', 'unknown', 'lookup_failed')
                                  or re.fullmatch(r'(?:[a-f0-9]{16}|unreg:[a-f0-9]{12})', value)):
        return value
    return 'unknown'


def socket_listener(props):
    address = props.get('localAddress')
    try:
        address = str(ipaddress.ip_address(address)) if isinstance(address, str) and len(address) <= 64 else None
    except ValueError:
        address = None
    port = props.get('localPort')
    port = port if type(port) is int and 0 < port <= 65535 else None
    syscall = props.get('syscall')
    syscall = syscall if isinstance(syscall, str) and syscall in SYSCALLS else None
    return address, port, syscall


def caller_breakdown(groups, dimension):
    return [dict(**{dimension: value}, **g, clientAbortRate=g['aborted'] / g['count'])
            for value, g in sorted(groups.items())]


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


@measured('history_scan_parse')
def rollup(day, root=None, now=None):
    day = dt.date.fromisoformat(day).isoformat()
    generated = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    next_day = dt.datetime.combine(dt.date.fromisoformat(day) + dt.timedelta(days=1), dt.time(), dt.timezone.utc)
    root = Path(root) if root is not None else directory()
    counts, kinds, tags = Counter(), Counter(), Counter()
    pool_rows = []
    times, samples = defaultdict(list), {}
    targets = defaultdict(Counter)
    target_components = defaultdict(Counter)
    inbound_sockets = Counter()
    inbound_components = defaultdict(Counter)
    proxy = {}
    models = defaultdict(lambda: dict(count=0, aborted=0))
    clients = defaultdict(lambda: dict(count=0, aborted=0))
    keys = defaultdict(lambda: dict(count=0, aborted=0))
    other_products = defaultdict(lambda: dict(count=0, aborted=0))
    providers = defaultdict(lambda: dict(count=0, aborted=0, statuses=Counter()))
    provider_tokens, model_tokens = defaultdict(Counter), defaultdict(Counter)
    upstream_codes = Counter()
    attempts = Counter()
    abort_ttfb = []
    locks, lock_accounts = {}, Counter()
    distinct, account_distinct = set(), defaultdict(set)
    unlocks = 0
    supervisor = dict(unresponsive=0, crawling=0, memoryHigh=0, killed=0,
                      starts=0, stopping=0, exits=0, reloads=0, workerForks=0, restartScheduled=0,
                      deploy=Counter(), stopsBySignal=Counter(), stopsByInitiator=Counter(), exitCodes=Counter(),
                      pendingWorkerOutcomes=0,
                      exitedBySignal=Counter(), exitedByCode=Counter(), killedByReason=Counter())
    heartbeat_observations = {}
    health_hours, health_late = {}, defaultdict(list)
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
                    if row['name'] in ('pool.exhausted', 'pool.recovered'):
                        pool_rows.append(row)
                    if row['name'] in ('health.request.late', 'supervisor.health_probe'):
                        props = row.get('props') if isinstance(row.get('props'), dict) else {}
                        at = dt.datetime.fromisoformat(row.get('ts', '').replace('Z', '+00:00'))
                        if at.tzinfo is None:
                            raise ValueError('health timestamp needs timezone')
                        at = at.astimezone(dt.timezone.utc)
                        if at.date().isoformat() == day:
                            hour = at.replace(minute=0, second=0, microsecond=0).isoformat().replace('+00:00', 'Z')
                            group = health_hours.setdefault(hour, dict(late=[], probes=[]))
                            if row['name'] == 'health.request.late' and metric(props.get('acceptToHandlerMs')):
                                group['late'].append(props['acceptToHandlerMs'])
                                probe = props.get('probe')
                                if isinstance(probe, str) and re.fullmatch('[a-f0-9]{8}', probe):
                                    health_late[probe].append((at, props))
                            elif row['name'] == 'supervisor.health_probe' and metric(props.get('totalMs')) and props['totalMs'] > 5000:
                                group['probes'].append((at, props))
                    if row.get('component') == 'supervisor':
                        name = row['name']
                        props = row.get('props') if isinstance(row.get('props'), dict) else {}
                        counter = {'worker.unresponsive': 'unresponsive', 'worker.crawling': 'crawling',
                                   'worker.memory_high': 'memoryHigh', 'worker.killed': 'killed',
                                   'supervisor.start': 'starts', 'supervisor.stopping': 'stopping',
                                   'supervisor.exit': 'exits', 'supervisor.reload': 'reloads',
                                   'worker.forked': 'workerForks', 'supervisor.restart_scheduled': 'restartScheduled'}.get(name)
                        if counter:
                            supervisor[counter] += 1
                        if name in ('deploy.bootout', 'deploy.bootstrap', 'deploy.reload', 'deploy.result'):
                            supervisor['deploy'][name] += 1
                        if name == 'supervisor.stopping':
                            for field, key in (('signal', 'stopsBySignal'), ('initiator', 'stopsByInitiator')):
                                value = props.get(field)
                                supervisor[key][value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', value) else 'unknown'] += 1
                        if name == 'supervisor.exit':
                            code = props.get('code')
                            supervisor['exitCodes'][str(code) if type(code) is int else 'unknown'] += 1
                            pending = props.get('pendingWorkers')
                            if isinstance(pending, list):
                                supervisor['pendingWorkerOutcomes'] += len(pending)
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
                    inbound = row.get('component') == 'proxy' and row['name'] == 'client.socket_closed'
                    tag = None if inbound else row.get('error', {}).get('tag')
                    if inbound and row['kind'] == 'error':
                        props = row.get('props', {})
                        code = props.get('code') or row.get('error', {}).get('tag')
                        if isinstance(code, str) and code in CONNECTION_ERRNOS:
                            address, port, syscall = socket_listener(props)
                            component = 'proxy'
                            # Peer ports are ephemeral: keep them in event rows, not rollup dimensions.
                            inbound_sockets[(component, code, address, port, syscall)] += 1
                            inbound_components[component]['count'] += 1
                            inbound_components[component]['unknownEndpointCount'] += address is None or port is None
                    if tag:
                        props = row.get('props', {})
                        count = props.get('count', 1) if tag in CONNECTION_ERRNOS else 1
                        count = count if type(count) is int and 0 < count <= 9007199254740991 else 1
                        tags[tag] += count
                        if tag in CONNECTION_ERRNOS:
                            target = safe_target(props.get('target')) or 'unknown'
                            component = token(row.get('component')) or 'unknown'
                            targets[tag][(component, target)] += count
                            target_components[component]['count'] += count
                            target_components[component]['unknownTargetCount'] += count if target == 'unknown' else 0
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
                        provider = props.get('provider')
                        provider = provider if isinstance(provider, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', provider) else 'unknown'
                        served = providers[provider]
                        served['count'] += 1
                        served['aborted'] += aborted
                        status = props.get('status')
                        served['statuses'][str(status) if type(status) is int and 100 <= status <= 599 else 'unknown'] += 1
                        usage = props.get('usage')
                        if isinstance(usage, dict):
                            for field in ('in', 'out', 'reasoning', 'cacheRead', 'cacheWrite'):
                                value = usage.get(field)
                                if metric(value):
                                    provider_tokens[provider][field] += value
                                    model_tokens[(provider, key[0])][field] += value
                        upstream_code = props.get('upstreamCode')
                        if isinstance(upstream_code, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', upstream_code):
                            upstream_codes[upstream_code] += 1
                        model = models[key[0]]
                        model['count'] += 1
                        model['aborted'] += aborted
                        client = props.get('client')
                        if client not in ('claude-code', 'codex', 'opencode', 'ai-sdk', 'curl', 'node', 'python', 'browser', 'other'):
                            client = 'unknown'
                        key_id = proxy_key_id(props.get('keyId'))
                        for group_identity in (clients[client], keys[key_id]):
                            group_identity['count'] += 1
                            group_identity['aborted'] += aborted
                        if client == 'other':
                            product = props.get('uaProduct', '')
                            product = product if isinstance(product, str) and re.fullmatch(r'[a-z0-9._-]{0,24}', product) else ''
                            other_products[product]['count'] += 1
                            other_products[product]['aborted'] += aborted
                        attempt_count = props.get('attempts')
                        if isinstance(attempt_count, int) and not isinstance(attempt_count, bool) and attempt_count >= 0:
                            attempts[attempt_count] += 1
                        if aborted:
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
    result['pools'] = pool_summary(day, root, generated, pool_rows)
    for error in result['topErrors']:
        if error['tag'] in CONNECTION_ERRNOS:
            error['byTarget'] = [dict(component=component, target=target, count=count)
                                 for (component, target), count in targets[error['tag']].most_common()]
    result['connectionTargetsByComponent'] = [dict(component=component, **group,
        unknownTargetShare=group['unknownTargetCount'] / group['count'])
        for component, group in sorted(target_components.items())]
    result['inboundSockets'] = dict(
        count=sum(inbound_sockets.values()),
        byListener=[dict(component=component, code=code, localAddress=address, localPort=port, syscall=syscall, count=count)
                    for (component, code, address, port, syscall), count in inbound_sockets.most_common()],
        byComponent=[dict(component=component, **group,
                          unknownEndpointShare=group['unknownEndpointCount'] / group['count'])
                     for component, group in sorted(inbound_components.items())],
    )
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
        byModel=caller_breakdown(models, 'model'),
        byClient=caller_breakdown(clients, 'client'),
        byKeyId=caller_breakdown(keys, 'keyId'),
        byProvider=caller_breakdown(providers, 'provider'),
        tokensByProvider=[dict(provider=p, usage=dict(u)) for p, u in sorted(provider_tokens.items())],
        tokensByProviderModel=[dict(provider=p, model=m, usage=dict(u)) for (p, m), u in sorted(model_tokens.items())],
        upstreamCodeCounts=dict(sorted(upstream_codes.items())),
        otherByUaProduct=caller_breakdown(other_products, 'uaProduct'),
        unregisteredRequests=sum(g['count'] for k, g in keys.items() if k.startswith('unreg:')),
        distinctUnregisteredKeys=sum(k.startswith('unreg:') for k in keys),
        lookupFailedRequests=keys.get('lookup_failed', {}).get('count', 0),
        abortsByClient={k: g['aborted'] for k, g in sorted(clients.items()) if g['aborted']},
        abortsByKeyId={k: g['aborted'] for k, g in sorted(keys.items()) if g['aborted']},
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
    adjacent_days, probe_ids = set(), set()
    for group in health_hours.values():
        for at, props in group['probes']:
            if isinstance(props.get('probe'), str):
                probe_ids.add(props['probe'])
            for offset in (-300, 300):
                neighbor = (at + dt.timedelta(seconds=offset)).date().isoformat()
                if neighbor != day:
                    adjacent_days.add(neighbor)
    # Late handlers and completed probes can land on opposite sides of UTC
    # midnight. Adjacent files contribute joins only, never this day's counts.
    for neighbor in sorted(adjacent_days):
        try:
            with (root / (neighbor + '.ndjson')).open() as lines:
                for line in lines:
                    if 'health.request.late' not in line:
                        continue
                    try:
                        row = json.loads(line)
                        props = row.get('props', {})
                        probe = props.get('probe')
                        if (row.get('tool') != '9router' or row.get('name') != 'health.request.late'
                                or row.get('kind') != 'perf' or not isinstance(probe, str) or probe not in probe_ids
                                or not metric(props.get('acceptToHandlerMs'))):
                            continue
                        at = dt.datetime.fromisoformat(row.get('ts', '').replace('Z', '+00:00'))
                        if at.tzinfo is not None:
                            health_late[probe].append((at.astimezone(dt.timezone.utc), props))
                    except (ValueError, TypeError, AttributeError):
                        continue
        except FileNotFoundError:
            pass
    result['healthByHour'] = []
    for hour, group in sorted(health_hours.items()):
        probes = []
        for at, props in group['probes']:
            probe = props.get('probe')
            candidates = health_late.get(probe, []) if isinstance(probe, str) else []
            # Correlate by the probe's bounded ID, never by nearest traffic alone.
            # A timed-out probe can reach the handler after its timeout row.
            candidates = [(abs((late_at - at).total_seconds()), late) for late_at, late in candidates
                          if abs((late_at - at).total_seconds()) <= 300]
            late = min(candidates, key=lambda item: item[0])[1] if candidates else {}
            probes.append(dict(ts=at.isoformat().replace('+00:00', 'Z'),
                **{key: props.get(key) if metric(props.get(key)) else None for key in (
                    'totalMs', 'maxLagMsSinceLast', 'lagMs', 'hbAgeMs', 'loopDelayP99Ms', 'loopDelayMaxMs', 'loopDelayWindowMs')},
                **{key: late.get(key) if metric(late.get(key)) else None for key in (
                    'acceptToHandlerMs', 'idleMs', 'loopLagAtAcceptMs')}))
        result['healthByHour'].append(dict(hour=hour, lateRows=len(group['late']),
            acceptToHandlerMs=percentiles(group['late']), probesOver5s=len(probes),
            probesWithLateRow=sum(p['acceptToHandlerMs'] is not None for p in probes), probes=probes))
    observations = []
    result['listener'] = listener_windows(day, root, generated, observations)
    result.update(gap_summary(observations, day, generated))
    result['coverage'] = dict(
        healthByHour='Threshold events only; healthy probes use supervisor.health_probe_summary.',
        healthProbeSummaryRows=counts['supervisor.health_probe_summary'],
        pools='Recorded exhaustion episodes only; empty does not mean no pools or continuous observer coverage.',
        observerGaps='Measured spans only; legacy ticks without start/end diagnostics cannot be reconstructed.')
    drops = Counter()
    for writer in volume_writers.values():
        drops.update(writer)
    result['droppedLines'] = sum(drops.values()) if volume_writers else None
    result['dropsByReason'] = dict(sorted(drops.items()))
    result['volumeWriters'] = len(volume_writers)
    write_report(root, day, result)
    return result


@measured('rollup_write')
def write_report(root, day, result):
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


@observed(name='rollup.phases')
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--day', default=(dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)).isoformat())
    args = p.parse_args()
    print(json.dumps(rollup(args.day)))

if __name__ == '__main__':
    main()
