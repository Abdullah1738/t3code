"""Read-only HTTP snapshots. Never calls provider tests, refresh, reset or OAuth."""
from collections import Counter, defaultdict
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.request
from host import Sampler
from host_rollup import timestamp as host_timestamp
from rollup import rollup
from listener_rollup import timestamp, windows as listener_windows
from toollog import directory, emit
from observer import GAP_NAMES, gap_summary, measured, observed, phase, poll_host

BASE = 'http://127.0.0.1:20128'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None

class Router:
    def __init__(self, data=None, component='poller', event_name='endpoint.get'):
        self.component, self.event_name = component, event_name
        root = Path(data) if data else Path.home() / '.9router'
        machine = (root / 'machine-id').read_text().strip()
        secret = (root / 'auth/cli-secret').read_text().strip()
        if not machine or not secret:
            raise ValueError('auth unavailable')
        self.auth = hashlib.sha256((machine + '9r-cli-auth' + secret).encode()).hexdigest()[:16]
        self.opener = urllib.request.build_opener(NoRedirect())

    def get(self, route):
        # Exact allowlist prevents accidentally polling a mutating GET endpoint.
        if route not in ('/api/providers', '/api/usage/logs', '/api/usage/stats?period=today', '/api/monitoring/pools'):
            raise ValueError('route not allowed')
        start = time.monotonic()
        wall_start = time.time() * 1000
        host_sampler = Sampler() if self.component == 'pool-alerts' else None
        host_start = host_sampler() if host_sampler else None
        status = 0
        ok = False
        error_tag = None
        try:
            request = urllib.request.Request(BASE + route, method='GET', headers={'x-9r-cli-token': self.auth, 'accept': 'application/json'})
            with self.opener.open(request, timeout=8) as response:
                status = response.status
                raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise ValueError('response too large')
                result = json.loads(raw)
                ok = True
                return result
        except Exception as error:
            if isinstance(error, urllib.error.HTTPError):
                status = error.code
                error_tag = 'http_' + str(status)
            else:
                error_tag = 'request_failed'
            raise
        finally:
            duration = (time.monotonic() - start) * 1000
            props = dict(endpoint=route.split('?')[0], status=status, startedAtMs=wall_start, finishedAtMs=time.time() * 1000)
            if host_sampler and duration > 120000:
                host_end = host_sampler()
                props.update(host=host_end, hostStart=host_start, hostEnd=host_end)
            emit(self.component, self.event_name, kind='perf', ok=ok,
                 durationMs=duration, props=props,
                 **({'error': {'tag': error_tag}} if error_tag else {}))


def locked(value, now):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value > now.timestamp() * 1000
    if isinstance(value, str):
        try:
            return dt.datetime.fromisoformat(value.replace('Z', '+00:00')) > now
        except (ValueError, TypeError):
            return False
    return False


@measured('snapshot')
def snapshot(providers, logs, previous, now):
    connections = providers['connections']
    if not isinstance(connections, list) or not isinstance(logs, list) or any(not isinstance(c, dict) or not isinstance(c.get('id'), str) for c in connections):
        raise ValueError('invalid snapshot')
    labels = defaultdict(set)
    for c in connections:
        for label in (c.get('name'), c.get('email'), c['id'][:8]):
            if label:
                labels['|'.join(p.strip() for p in str(label).split('|'))].add(c['id'])
        state = c.get('testStatus')
        state = state if state in ('active', 'expired', 'error', 'disabled', 'limited', 'rate_limited', 'locked', 'unknown') else 'unknown'
        emit('poller', 'account.health', ok=True, ids={'account': c['id']}, props=dict(enabled=c.get('isActive') is True, state=state, locked=any(locked(v, now) for k, v in c.items() if k.startswith('modelLock_')), limited=locked(c.get('rateLimitedUntil'), now), reloginNeeded=bool(c.get('reauthRequiredAt'))))
        for key, value in c.items():
            if not (key.startswith('modelLock_') or key == 'rateLimitedUntil') or not locked(value, now):
                continue
            # Only canonical ISO deadlines leave this endpoint; never carry a raw value.
            try:
                if isinstance(value, bool):
                    continue
                deadline = dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc) if isinstance(value, (int, float)) else dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
                until = deadline.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            except (ValueError, TypeError, AttributeError, OverflowError, OSError):
                continue
            account_wide = key in ('modelLock___all', 'rateLimitedUntil')
            model = 'account-wide' if account_wide else key[len('modelLock_'):]
            metadata = c.get('modelLockCause_' + key[len('modelLock_'):], {}) if key.startswith('modelLock_') else {}
            cause = metadata.get('cause') if isinstance(metadata, dict) and metadata.get('until') == value else None
            cause = cause if cause in ('quota', 'rate_limit', 'overloaded', 'auth', 'monthly_usage', 'other') else 'other'
            emit('poller', 'account.locked', ok=True, ids={'account': c['id']}, props=dict(provider=c.get('provider', 'unknown'), model=model, scope='account' if account_wide else 'model', cause=cause, until=until))
    current = Counter()
    counts = Counter()
    unresolved = 0
    for line in logs:
        if not isinstance(line, str):
            raise ValueError('invalid log row')
        fingerprint = hashlib.sha256(line.encode()).hexdigest()
        current[fingerprint] += 1
        if current[fingerprint] <= previous.get(fingerprint, 0):
            continue
        parts = [p.strip() for p in line.split('|')]
        if len(parts) < 7:
            unresolved += 1
            continue
        status = re.fullmatch(r'(?:FAILED\s+)?([45]\d{2})', parts[-1])
        if not status:
            continue
        account = '|'.join(parts[3:-3]).strip()
        matches = labels.get(account, set())
        if len(matches) != 1:
            unresolved += 1
        connection = next(iter(matches)) if len(matches) == 1 else 'unresolved'
        counts[(connection, parts[1], int(status[1]))] += 1
    for (account, model, status), count in counts.items():
        emit('poller', 'usage.errors', kind='error', ok=False, error={'tag': 'http_' + str(status)}, ids={'account': account}, props=dict(model=model, status=status, count=count, fourxx=count if status < 500 else 0, fivexx=count if status >= 500 else 0))
    # Full snapshots without overlap cannot prove that all intervening requests survived.
    complete = unresolved == 0 and (len(logs) < 200 or bool(set(previous) & set(current)))
    emit('poller', 'usage.coverage', kind='event' if complete else 'error', ok=complete, props={'count': len(logs), 'complete': complete}, **({} if complete else {'error': {'tag': 'bounded_snapshot'}}))
    return dict(current)


@measured('state_save')
def save_state(path, state):
    fd, tmp = tempfile.mkstemp(prefix='.poll-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(state, out)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def rollup_complete(path):
    try:
        return json.loads(path.read_text()).get('complete') is True
    except (OSError, ValueError, AttributeError):
        return False


def late_gap_days(root, days, now, state):
    # Only new bytes can contain late completions; keep the cursor across poll children.
    history_names = (*GAP_NAMES, 'poll.complete')
    prior = state.get('gapSources', {})
    if not isinstance(prior, dict):
        prior = {}
    sources, changed = {}, set()
    for path in root.glob('????-??-??.ndjson'):
        old = prior.get(path.name, {})
        if not isinstance(old, dict):
            old = {}
        try:
            source = path.open('rb')
        except FileNotFoundError:
            continue
        with source:
            info = os.fstat(source.fileno())
            identity = [info.st_dev, info.st_ino]
            offset = old.get('offset', 0)
            append = (old.get('identity') == identity and type(offset) is int and 0 <= offset <= info.st_size
                      and (offset < info.st_size or old.get('mtime') == info.st_mtime_ns))
            old_days = old.get('days', [])
            touched = set(day for day in old_days if isinstance(day, str)) & set(days) if isinstance(old_days, list) else set()
            if not append:
                changed.update(touched)
                touched = set()
                offset = 0
            source.seek(offset)
            while line := source.readline():
                row = None
                try:
                    if not line.endswith(b'\n') or any(name.encode() in line for name in history_names):
                        row = json.loads(line)
                except (ValueError, UnicodeError):
                    if not line.endswith(b'\n'):
                        break
                if isinstance(row, dict) and row.get('tool') == '9router' and isinstance(row.get('name'), str) and row['name'] in history_names:
                    recorded = timestamp(row.get('ts'))
                    if recorded is not None and recorded > now.timestamp() * 1000:
                        break
                    props = row.get('props') if isinstance(row.get('props'), dict) else {}
                    sample = host_timestamp(props.get('hostAtMs')) if row['name'] == 'poll.complete' else None
                    for day in days:
                        if (sample is not None and sample <= now and sample.date().isoformat() == day
                                or any(gap_summary([row], day, now).values())):
                            changed.add(day)
                            touched.add(day)
                offset = source.tell()
            sources[path.name] = dict(identity=identity, offset=offset, mtime=info.st_mtime_ns, days=sorted(touched))
    for name in prior.keys() - sources.keys():
        old_days = prior[name].get('days', []) if isinstance(prior[name], dict) else []
        if isinstance(old_days, list):
            changed.update(day for day in old_days if isinstance(day, str) and day in days)
    state['gapSources'] = sources
    return changed


@measured('history_refresh')
def refresh_listener_rollups(root, now, state):
    # Daily counters are final, but a recovery can close an older listener window.
    reports = {}
    for report in root.glob('rollup-????-??-??.json'):
        day = report.stem.removeprefix('rollup-')
        if day >= now.date().isoformat():
            continue
        try:
            dt.date.fromisoformat(day)
            previous = json.loads(report.read_text()).get('listener', {})
            pending = any(row.get('end') is None for row in
                          [*previous.get('windows', []), *previous.get('unknownWindows', [])])
            reports[day] = previous, pending
        except (OSError, ValueError, AttributeError, TypeError):
            continue
    late = late_gap_days(root, reports, now, state)
    for day, (previous, pending) in reports.items():
        if day in late or pending and listener_windows(day, root, now) != previous:
            rollup(day, root, now=now)


@observed()
def poll(get=None, root=None, now=None):
    start = time.monotonic()
    root = Path(root) if root is not None else directory()
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
        state_path = root / '.poll-state.json'
        try:
            state = json.loads(state_path.read_text())
        except FileNotFoundError:
            state = {}
        yesterday = (now.date() - dt.timedelta(days=1)).isoformat()
        if (now.hour > 0 or now.minute >= 5) and (state.get('finalizedDay') != yesterday or not rollup_complete(root / ('rollup-' + yesterday + '.json'))):
            rollup_start = time.monotonic()
            rollup(yesterday, root, now=now)
            rollup_ms = (time.monotonic() - rollup_start) * 1000
            state['finalizedDay'] = yesterday
            save_state(state_path, state)
            emit('poller', 'log.rollup', kind='perf', ok=True, durationMs=rollup_ms)
        hour = now.strftime('%Y-%m-%dT%H')
        if state.get('rollupHour') != hour:
            rollup_start = time.monotonic()
            rollup(now.date().isoformat(), root, now=now)
            rollup_ms = (time.monotonic() - rollup_start) * 1000
            state['rollupHour'] = hour
            save_state(state_path, state)
            emit('poller', 'log.rollup', kind='perf', ok=True, durationMs=rollup_ms)
        refresh_listener_rollups(root, now, state)
        get = get or Router().get
        with phase('providers_fetch'):
            providers = get('/api/providers')
        with phase('usage_fetch'):
            logs = get('/api/usage/logs')
        seen = snapshot(providers, logs, state.get('seen', {}), now)
        state['seen'] = seen
        save_state(state_path, state)
        if state.get('spendHour') != hour:
            # This endpoint supplies today's cumulative cost, not hourly buckets.
            # Keep the real per-connection cost as an hourly snapshot; never call it hourly spend.
            with phase('stats_fetch'):
                stats = get('/api/usage/stats?period=today')
            costs = defaultdict(float)
            for row in stats['byAccount'].values():
                cost = row.get('cost')
                if isinstance(row.get('connectionId'), str) and isinstance(cost, (int, float)) and cost >= 0:
                    costs[row['connectionId']] += cost
            for connection, cost in costs.items():
                emit('poller', 'spend.snapshot', ids={'account': connection}, props={'cost': cost, 'hour': hour, 'source': 'cumulative_today'})
            emit('poller', 'spend.unavailable', props={'tag': 'no_hourly_cost_endpoint'})
            state['spendHour'] = hour
            save_state(state_path, state)
        emit('poller', 'poll.complete', props=poll_host(), kind='perf', ok=True, durationMs=(time.monotonic() - start) * 1000)
        return 0
    except Exception as error:
        tag = 'http_' + str(error.code) if isinstance(error, urllib.error.HTTPError) else 'poll_failed'
        emit('poller', 'poll.complete', props=poll_host(), kind='error', ok=False, durationMs=(time.monotonic() - start) * 1000, error={'tag': tag})
        return 1

if __name__ == '__main__':
    raise SystemExit(poll())
