"""Best-effort, allowlisted health tool logs. Python 3.9, stdlib only."""
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import time
import uuid
from collections import Counter, defaultdict

CAP_BYTES = 50 * 1024 * 1024
COMPONENTS = {'food', 'hlog', 'validate', 'whoop', 'cards', 'took', 'whoop-sync',
              'meds-nag', 'nutrition-checkin', 'nutrition-nudge', 'forge-workouts', 'gym-nudge', 'rollup'}
COMMANDS = {
    'food': 'search log quick meal-log del flag add-food show-food recipe-new recipe-add recipe-show meal-save pantry today week phase checkin meals-count',
    'hlog': 'import summary weekly monthly labs site feel conflicts',
    'whoop': 'status sync authurl serve', 'cards': 'morning nutrition', 'took': 'confirm skip',
    'validate': 'validate', 'rollup': 'rollup',
}
CONFLICTS = {'status', 'amount', 'time', 'missing_in_new_export', 'backdated_in_new_export',
             'time_offset_systematic', 'not_taken_in_export', 'taken_not_confirmed_in_meds_nag',
             'probable_duplicate_log', 'other'}
TAGS = {'exit_nonzero', 'invalid_arguments', 'not_authorized', 'reauth_needed', 'timeout',
        'subprocess_failed', 'renderer_failed', 'headless_chrome', 'database_error',
        'io_error', 'interrupted', 'internal_error', 'cap_reached'}
SCHEMAS = {
    'food.warning': {'warning': {'no_time', 'macro_drift'}, 'count': int},
    'cli.run': {'command': set(COMMANDS), 'subcommand': set(' '.join(COMMANDS.values()).split()) | {'unknown', 'help'}},
    'watcher.run': {}, 'sync.run': {'sleepCount': int, 'recoveryCount': int, 'cycleCount': int,
        'bodyCount': int, 'tokenRefreshed': bool, 'notScoredYet': bool},
    'sync.gap': {'count': int}, 'card.render': {'kind': {'morning', 'nutrition'}},
    'brief.fresh': {'fresh': bool}, 'nag.sent': {'count': int}, 'nag.snoozed': {'count': int},
    'nag.stopped': {'count': int}, 'nag.folded': {'count': int},
    'validate.conflicts': {'conflictKind': CONFLICTS, 'count': int},
    'log.cap': {}, 'rollup.run': {},
}


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def log_dir():
    # Override is for isolated tests; callers never pass payload-derived paths.
    return Path(os.environ.get('HEALTH_TOOLLOG_DIR') or Path.home() / '.robob/logs/tools/health')


def error_tag(exc, renderer=False):
    if isinstance(exc, SystemExit):
        return 'invalid_arguments' if exc.code == 2 else 'exit_nonzero'
    if isinstance(exc, KeyboardInterrupt):
        return 'interrupted'
    name = type(exc).__name__
    if renderer and name in ('CalledProcessError', 'TimeoutExpired'):
        command = getattr(exc, 'cmd', ())
        words = command if isinstance(command, (list, tuple)) else [command]
        if any('chrome' in os.path.basename(str(word)).lower() or
               'chromium' in os.path.basename(str(word)).lower() for word in words[:1]):
            return 'headless_chrome'
    return {'NotAuthorized': 'not_authorized', 'ReauthNeeded': 'reauth_needed',
            'TimeoutExpired': 'timeout', 'TimeoutError': 'timeout',
            'CalledProcessError': 'renderer_failed' if renderer else 'subprocess_failed',
            'OperationalError': 'database_error', 'DatabaseError': 'database_error'}.get(
                name, 'io_error' if isinstance(exc, OSError) else 'internal_error')


def _props(name, props):
    out = {}
    for key, spec in SCHEMAS[name].items():
        value = props.get(key)
        if spec is bool and type(value) is bool:
            out[key] = value
        elif spec is int and type(value) is int and 0 <= value <= 10**9:
            out[key] = value
        elif isinstance(spec, set) and isinstance(value, str) and value in spec:
            out[key] = value
    return out


def _line(component, name, kind, duration_ms, ok, props, tag, run_id, now):
    row = {'ts': now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
           'tool': 'health', 'component': component, 'kind': kind, 'name': name}
    if type(duration_ms) in (int, float) and math.isfinite(duration_ms) and duration_ms >= 0:
        row['durationMs'] = round(duration_ms, 3)
    if type(ok) is bool:
        row['ok'] = ok
    clean = _props(name, props or {})
    if clean:
        row['props'] = clean
    if isinstance(run_id, str) and len(run_id) == 32 and all(c in '0123456789abcdef' for c in run_id):
        row['ids'] = {'run': run_id}
    if tag in TAGS:
        # Exception text can contain foods, doses, API bodies or credentials.
        row['error'] = {'tag': tag, 'message': tag.replace('_', ' ')}
    return (json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n').encode()


def _retention(root, today):
    cutoff = today - dt.timedelta(days=30)
    for path in root.iterdir():
        name = path.name
        day = name.removeprefix('rollup-').removeprefix('.cap-').removesuffix('.ndjson').removesuffix('.json')
        try:
            if dt.date.fromisoformat(day) < cutoff and name in (day + '.ndjson', 'rollup-' + day + '.json', '.cap-' + day):
                path.unlink()
        except (ValueError, OSError):
            pass


def emit(component, name, kind='event', duration_ms=None, ok=None, props=None, tag=None, run_id=None):
    try:
        if component not in COMPONENTS or name not in SCHEMAS or kind not in ('event', 'perf', 'error'):
            return
        now = utcnow()
        root = log_dir()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        root.chmod(0o700)
        path = root / (now.date().isoformat() + '.ndjson')
        fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.fchmod(fd, 0o600)
            # Never wait for another writer, and never lock across tool work.
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            size = os.fstat(fd).st_size
            if size == 0:
                _retention(root, now.date())
            if size >= CAP_BYTES:
                try:
                    marker = os.open(str(root / ('.cap-' + now.date().isoformat())), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                except FileExistsError:
                    pass
                else:
                    os.close(marker)
                    os.write(fd, _line(component, 'log.cap', 'error', None, False, {}, 'cap_reached', None, now))
                if kind != 'error':
                    return
            os.write(fd, _line(component, name, kind, duration_ms, ok, props, tag, run_id, now))
        finally:
            os.close(fd)
    except BaseException:
        pass


class Span:
    def __init__(self, component, name, props=None):
        self.component, self.name = component, name
        self.props = props if props is not None else {}
        self.ok, self.tag, self.run_id, self.start = True, None, None, None

    def __enter__(self):
        try:
            self.start = time.monotonic()
            self.run_id = uuid.uuid4().hex
        except BaseException:
            pass
        return self

    def __exit__(self, typ, exc, tb):
        try:
            if exc is not None and not (isinstance(exc, SystemExit) and exc.code in (None, 0)):
                self.ok = False
                self.tag = error_tag(exc, self.name == 'card.render')
            emit(self.component, self.name, 'perf' if self.ok else 'error',
                 (time.monotonic() - self.start) * 1000, self.ok, self.props, self.tag, self.run_id)
        except BaseException:
            pass
        return False


def run(component, argv=None, name='cli.run'):
    try:
        args = list(argv or [])
        sub = args[0] if args else ('status' if component == 'whoop' else component)
        if component == 'took':
            sub = 'skip' if 'skip' in args[:2] else 'confirm'
        elif sub in ('--help', '-h'):
            sub = 'help'
        allowed = COMMANDS.get(component, '').split() + ['help']
        sub = sub if sub in allowed else 'unknown'
        return Span(component, name, {'command': component, 'subcommand': sub} if name == 'cli.run' else {})
    except BaseException:
        return contextlib.nullcontext()


def conflicts(rows):
    try:
        counts = Counter()
        for kind, count in rows:
            counts[kind if kind in CONFLICTS else 'other'] += count
        if not counts:
            counts['other'] = 0
        for kind, count in sorted(counts.items()):
            emit('validate', 'validate.conflicts', props={'conflictKind': kind, 'count': count})
    except BaseException:
        pass


def sync_gap(latest):
    try:
        stamp = dt.datetime.fromisoformat(latest.replace('Z', '+00:00')) if latest else None
        if stamp is None or utcnow() - stamp > dt.timedelta(hours=36):
            emit('whoop-sync', 'sync.gap', props={'count': 1})
    except BaseException:
        pass


def _percentile(values, fraction):
    return values[max(0, math.ceil(len(values) * fraction) - 1)]


def rollup(day=None):
    try:
        day = dt.date.fromisoformat(day) if day else utcnow().date() - dt.timedelta(days=1)
        root = log_dir()
        source = root / (day.isoformat() + '.ndjson')
        names, kinds, outcomes, tags = Counter(), Counter(), Counter(), Counter()
        durations, samples = defaultdict(list), {}
        malformed = 0
        with source.open() as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                    if r.get('tool') != 'health' or r.get('name') not in SCHEMAS or r.get('kind') not in ('event', 'perf', 'error'):
                        raise ValueError()
                    names[r['name']] += 1
                    kinds[r['kind']] += 1
                    if type(r.get('ok')) is bool:
                        outcomes['ok' if r['ok'] else 'error'] += 1
                    value = r.get('durationMs')
                    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                        durations[r['name']].append(value)
                    tag = r.get('error', {}).get('tag')
                    if tag in TAGS:
                        tags[tag] += 1
                        candidate = r.get('ids', {}).get('run')
                        if isinstance(candidate, str) and len(candidate) == 32 and all(c in '0123456789abcdef' for c in candidate):
                            samples.setdefault(tag, candidate)
                except (ValueError, TypeError, AttributeError):
                    malformed += 1
        total = sum(names.values())
        rated = sum(outcomes.values())
        result = {'day': day.isoformat(), 'tool': 'health', 'total': total, 'malformedCount': malformed,
                  'countsByName': dict(names), 'countsByKind': dict(kinds), 'okCount': outcomes['ok'],
                  'errorCount': outcomes['error'], 'okRate': outcomes['ok'] / rated if rated else None,
                  'errorRate': outcomes['error'] / rated if rated else None,
                  'errorKindRate': kinds['error'] / total if total else None,
                  'durationMs': {}, 'topErrors': []}
        for name, values in durations.items():
            values.sort()
            result['durationMs'][name] = {'p50': _percentile(values, .5), 'p95': _percentile(values, .95), 'max': values[-1]}
        result['topErrors'] = [{'tag': tag, 'count': count, 'sampleId': samples.get(tag)} for tag, count in tags.most_common(20)]
        root.chmod(0o700)
        target = root / ('rollup-' + day.isoformat() + '.json')
        temp = root / ('.rollup-' + uuid.uuid4().hex)
        fd = os.open(str(temp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as fh:
            json.dump(result, fh, separators=(',', ':'), allow_nan=False)
            fh.write('\n')
        os.replace(str(temp), str(target))
        return result
    except BaseException:
        return None


def rollup_previous():
    try:
        now = utcnow()
        day = now.date() - dt.timedelta(days=1)
        if (now.hour, now.minute) >= (0, 5) and not (log_dir() / ('rollup-' + day.isoformat() + '.json')).exists():
            rollup(day.isoformat())
    except BaseException:
        pass
