"""Best-effort, allowlisted health tool logs. Python 3.9, stdlib only."""
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
import re
import sys
import statistics
from pathlib import Path
import time
import uuid
from collections import Counter, defaultdict

CAP_BYTES = 50 * 1024 * 1024
EXPECTED_PATH = Path(__file__).with_name('toollog_expected.json')
COMPONENTS = {'food', 'hlog', 'validate', 'whoop', 'cards', 'took', 'whoop-sync',
              'meds-nag', 'nutrition-checkin', 'nutrition-nudge', 'forge-workouts', 'gym-nudge', 'rollup'}
COMMANDS = {
    'food': 'search log quick meal-log log-order del flag add-food show-food recipe-new recipe-add recipe-show meal-save pantry today week phase checkin meals-count',
    'hlog': 'import summary weekly monthly labs site feel conflicts',
    'whoop': 'status sync authurl serve', 'cards': 'morning nutrition mark-sent', 'took': 'confirm skip',
    'validate': 'validate', 'rollup': 'rollup',
}
CONFLICTS = {'status', 'amount', 'time', 'missing_in_new_export', 'backdated_in_new_export',
             'time_offset_systematic', 'not_taken_in_export', 'taken_not_confirmed_in_meds_nag',
             'probable_duplicate_log', 'other'}
TAGS = {'exit_nonzero', 'invalid_arguments', 'not_authorized', 'reauth_needed', 'timeout',
        'subprocess_failed', 'renderer_failed', 'headless_chrome', 'database_error',
        'io_error', 'interrupted', 'internal_error', 'validate_failed', 'cap_reached'}
# Static check-site IDs, never row identities, dates, labels, or source filenames.
VALIDATE_CHECK_IDS = {
    'regimen.header_count', 'regimen.columns', 'regimen.row_count', 'regimen.row_present',
    'regimen.row_values', 'regimen.month_keys', 'regimen.month_sum', 'regimen.extra_columns',
    'regimen.compound_count', 'meds_nag.taken_rows', 'meds_nag.override',
    'canonical.taken_values', 'canonical.source_present', 'canonical.link',
    'canonical.month_sum', 'canonical.historical_amount', 'labs.page_count',
    'labs.result_count', 'labs.value_present', 'labs.marker_present', 'labs.unit_present',
    'labs.value_parse', 'labs.flag_present', 'labs.reference_present', 'labs.known_value',
    'labs.headline_unit', 'body.row_count', 'body.row_values', 'subjective.row_present',
    'subjective.source_present', 'sites.row_present',
}
# Error metadata is shared by spans. Exit codes describe the wrapped command
# escaping this span (not a failing subprocess's returncode). Historical rows
# without these fields remain valid. Exception text and traceback paths stay out.
ERROR_SCHEMA = {'exceptionClass': 'identifier', 'exitCode': 'exit_code', 'stage': 'function'}
ENDPOINT_SCHEMA = {'httpStatus': 'status', 'rawCount': int, 'keptCount': int, 'fetchComplete': bool,
                   'scoreStates': {k: int for k in ('SCORED', 'PENDING_SCORE', 'UNSCORABLE', 'OTHER')},
                   'newestRecordEnd': 'iso', 'newestScoredRecordEnd': 'iso', 'tokenExpiresInS': 'seconds'}
SCHEMAS = {
    'food.order_log': {'vertical': {'food', 'nownow', 'minutes', 'main', 'supermall'},
        'outcome': {'logged', 'partial', 'fetch_failed', 'no_items', 'unmatched', 'bad_exclude', 'bad_portion', 'duplicate'},
        'lines': int, 'unmatched': int, 'options_not_counted': int, 'fetch_ms': int},
    'food.warning': {'warning': {'no_time', 'macro_drift', 'unverified', 'assumed', 'option_not_counted', 'partial'}, 'count': int},
    'cli.run': {'command': set(COMMANDS), 'subcommand': set(' '.join(COMMANDS.values()).split()) | {'unknown', 'none', 'help'},
                'failCount': int, 'failedCheckIds': 'check_ids'},
    'watcher.run': {}, 'sync.run': {'sleepCount': int, 'recoveryCount': int, 'cycleCount': int,
        'lastScoredSleep': 'iso', 'bodyCount': int, 'tokenRefreshed': bool, 'notScoredYet': bool,
        **{k: ENDPOINT_SCHEMA for k in ('sleep', 'recovery', 'cycle', 'body')}},
    'sync.gap': {'count': int, 'lastSleepEnd': 'iso', 'lastRecoveryEnd': 'iso', 'gapHours': 'seconds'},
    'card.render': {'kind': {'morning', 'nutrition'}, 'runIdRef': 'run'},
    'delivery.result': {'kind': {'card', 'nag', 'warning'}, 'ok': bool, 'errorTag': TAGS | {'none'}, 'runIdRef': 'run'},
    'brief.fresh': {'fresh': bool}, 'nag.sent': {'count': int}, 'nag.snoozed': {'count': int},
    'nag.stopped': {'count': int}, 'nag.folded': {'count': int}, 'validate.conflicts': {'conflictKind': CONFLICTS, 'count': int},
    'nag.resolved': {'slotKind': {'morning', 'evening', 'weekly', 'other'}, 'nagCount': int,
                     'firstNagToTookSeconds': int, 'snoozeCount': int, 'lateMinutes': int},
    'nag.day_end': {'slotsDue': int, 'slotsTaken': int, 'slotsOpen': int, 'nagsSent': int},
    'log.cap': {}, 'rollup.run': {},
}
for _span_name in ('cli.run', 'watcher.run', 'sync.run', 'card.render', 'rollup.run'):
    SCHEMAS[_span_name].update(ERROR_SCHEMA)


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def log_dir():
    # Keep the established override; test markers must never select the live fallback.
    override = os.environ.get('HEALTH_TOOLLOG_DIR')
    if override:
        return Path(override)
    if ('HEALTH_VAULT_TEST_COPY' in os.environ or 'PYTEST_CURRENT_TEST' in os.environ
            or 'unittest' in sys.modules):
        return None
    return Path.home() / '.robob/logs/tools/health'


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


def valid_run(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value) is not None


def iso_stamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)', value):
        return None
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')
    except ValueError:
        return None


def _props(name, props):
    return _fields(SCHEMAS[name], props)


def _fields(schema, props):
    out = {}
    for key, spec in schema.items():
        value = props.get(key)
        if isinstance(spec, dict) and isinstance(value, dict):
            out[key] = _fields(spec, value)
        elif spec == 'run' and valid_run(value):
            out[key] = value
        elif spec == 'iso':
            out[key] = iso_stamp(value)
        elif spec == 'status' and (value is None or type(value) is int and 100 <= value <= 599):
            out[key] = value
        elif spec == 'seconds' and (value is None or type(value) in (int, float) and math.isfinite(value) and -10**9 <= value <= 10**9):
            out[key] = value
        elif spec in ('identifier', 'function') and isinstance(value, str):
            if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', value) or (
                    spec == 'function' and value in {'<module>', '<lambda>', '<listcomp>', '<dictcomp>', '<setcomp>', '<genexpr>'}):
                out[key] = value
        elif spec == 'exit_code' and type(value) is int and 0 <= value <= 255:
            out[key] = value
        elif spec == 'check_ids' and isinstance(value, (list, tuple)):
            out[key] = sorted({v for v in value if isinstance(v, str) and v in VALIDATE_CHECK_IDS})
        elif spec is bool and type(value) is bool:
            out[key] = value
        elif spec is int and type(value) is int and 0 <= value <= 10**9:
            out[key] = value
        elif isinstance(spec, set) and isinstance(value, str) and value in spec:
            out[key] = value
    return out


def _line(component, name, kind, duration_ms, ok, props, tag, run_id, now, rejected=None):
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
        if tag == 'invalid_arguments' and isinstance(rejected, (list, tuple)):
            row['error']['rejected'] = sorted({v for v in rejected if isinstance(v, str) and re.fullmatch(r'--?[A-Za-z][A-Za-z0-9-]{0,63}', v)})[:32]
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


def emit(component, name, kind='event', duration_ms=None, ok=None, props=None, tag=None, run_id=None, rejected=None):
    try:
        if component not in COMPONENTS or name not in SCHEMAS or kind not in ('event', 'perf', 'error'):
            return
        now = utcnow()
        root = log_dir()
        if root is None:
            return
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
            os.write(fd, _line(component, name, kind, duration_ms, ok, props, tag, run_id, now, rejected))
        finally:
            os.close(fd)
    except BaseException:
        pass


class Span:
    def __init__(self, component, name, props=None):
        self.component, self.name = component, name
        self.props = props if props is not None else {}
        self.ok, self.tag, self.run_id, self.start = True, None, None, None
        self.rejected = []

    def __enter__(self):
        try:
            self.start = time.monotonic()
            self.run_id = os.environ.get('HEALTH_TOOLLOG_RUN') if self.name == 'watcher.run' else None
            if not valid_run(self.run_id):
                self.run_id = uuid.uuid4().hex
        except BaseException:
            pass
        return self

    def __exit__(self, typ, exc, tb):
        try:
            if exc is not None and not (isinstance(exc, SystemExit) and exc.code in (None, 0)):
                self.ok = False
                if not (self.tag == 'validate_failed' and self.component == 'validate'
                        and isinstance(exc, SystemExit) and exc.code == 1):
                    self.tag = error_tag(exc, self.name == 'card.render')
                self.props['exceptionClass'] = type(exc).__name__
                self.props['exitCode'] = ((int(exc.code) % 256 if isinstance(exc.code, int) else 1)
                                          if isinstance(exc, SystemExit) else
                                          130 if isinstance(exc, KeyboardInterrupt) else 1)
                if tb is not None:
                    while tb.tb_next is not None:
                        tb = tb.tb_next
                    self.props['stage'] = tb.tb_frame.f_code.co_name
            emit(self.component, self.name, 'perf' if self.ok else 'error',
                 (time.monotonic() - self.start) * 1000, self.ok, self.props, self.tag, self.run_id, rejected=self.rejected)
        except BaseException:
            pass
        return False

    def validate_failure(self, check_id):
        try:
            if self.component == 'validate' and check_id in VALIDATE_CHECK_IDS:
                self.props['failCount'] += 1
                self.props['failedCheckIds'] = sorted(set(self.props['failedCheckIds']) | {check_id})
        except BaseException:
            pass


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
        props = {'command': component, 'subcommand': sub} if name == 'cli.run' else {}
        if component == 'validate' and name == 'cli.run':
            props.update(failCount=0, failedCheckIds=[])
        return Span(component, name, props)
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


_MISSING = object()

def sync_gap(latest, recovery=_MISSING):
    try:
        ends = [iso_stamp(latest), iso_stamp(recovery)]
        gaps = [(utcnow() - dt.datetime.fromisoformat(v.replace('Z', '+00:00'))).total_seconds() / 3600 for v in ends if v]
        if ends[0] is None or (recovery is not _MISSING and ends[1] is None) or any(g > 36 for g in gaps):
            emit('whoop-sync', 'sync.gap', props={'count': 1, 'lastSleepEnd': ends[0],
                 'lastRecoveryEnd': ends[1], 'gapHours': max(gaps) if gaps else None})
    except BaseException:
        pass


def delivery(kind, run_id, ok=True, tag=None, component='cards'):
    try:
        emit(component, 'delivery.result', ok=ok, props={'kind': kind, 'ok': ok,
             'errorTag': 'none' if ok else (tag if tag in TAGS else 'internal_error'), 'runIdRef': run_id})
    except BaseException:
        pass


def _percentile(values, fraction):
    return values[max(0, math.ceil(len(values) * fraction) - 1)]


def _expected_intervals():
    try:
        expected = json.loads(EXPECTED_PATH.read_text()).get('expected', {})
        return {k: v for k, v in expected.items() if k in COMPONENTS
                and type(v) in (int, float) and 0 < v <= 10**9 and math.isfinite(v)
                and math.isfinite(86400 / v)}
    except (OSError, ValueError, TypeError, AttributeError, OverflowError):
        return {}


def _run_summary(timestamps, start, end, interval=None):
    timestamps = sorted(timestamps)
    # Day boundaries measure outages, but must not skew the observed cadence.
    observed = [(b - a).total_seconds() for a, b in zip(timestamps, timestamps[1:]) if b > a]
    median = statistics.median(observed) if observed else None
    points = [start] + timestamps + [end]
    gaps = [(a, (b - a).total_seconds()) for a, b in zip(points, points[1:])]
    result = {'runs': len(timestamps),
              'firstRunTs': timestamps[0].isoformat().replace('+00:00', 'Z') if timestamps else None,
              'lastRunTs': timestamps[-1].isoformat().replace('+00:00', 'Z') if timestamps else None,
              'medianGapSeconds': median, 'maxGapSeconds': max(seconds for _, seconds in gaps),
              'gapsOver': [{'startTs': stamp.isoformat().replace('+00:00', 'Z'), 'seconds': seconds}
                           for stamp, seconds in sorted(gaps, key=lambda gap: -gap[1])
                           if median is not None and seconds > 3 * median][:10]}
    if interval is not None:
        # The config has no phase/history: these are elapsed-day count estimates.
        result['expectedRuns'] = math.floor((end - start).total_seconds() / interval)
        result['missedRuns'] = max(0, result['expectedRuns'] - len(timestamps))
    return result


def rollup(day=None):
    try:
        now = utcnow()
        day = dt.date.fromisoformat(day) if day else now.date() - dt.timedelta(days=1)
        start = dt.datetime.combine(day, dt.time(), tzinfo=dt.timezone.utc)
        day_end = start + dt.timedelta(days=1)
        end = max(start, min(now, day_end))
        intervals, run_times = _expected_intervals(), defaultdict(list)
        root = log_dir()
        if root is None:
            return
        source = root / (day.isoformat() + '.ndjson')
        names, kinds, outcomes, tags = Counter(), Counter(), Counter(), Counter()
        durations, samples = defaultdict(list), {}
        malformed = 0
        zero_sleep, last_scored = 0, None
        food_errors, delivered, expected = Counter(), {}, set()
        nag_latency, open_slots = [], {}
        try:
            source_file = source.open()
        except FileNotFoundError:
            source_file = contextlib.nullcontext(())
        with source_file as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                    if r.get('tool') != 'health' or r.get('name') not in SCHEMAS or r.get('kind') not in ('event', 'perf', 'error'):
                        raise ValueError()
                    names[r['name']] += 1
                    kinds[r['kind']] += 1
                    if type(r.get('ok')) is bool:
                        outcomes['ok' if r['ok'] else 'error'] += 1
                    props = _props(r['name'], r.get('props') or {})
                    component = r.get('component')
                    if r['name'] in ('watcher.run', 'sync.run') and component in COMPONENTS:
                        stamp = iso_stamp(r.get('ts'))
                        if stamp:
                            timestamp = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                            if start <= timestamp < day_end and timestamp <= end:
                                run_times[component].append(timestamp)
                    origin = r.get('ids', {}).get('run')
                    if r['name'] == 'nag.resolved' and 'firstNagToTookSeconds' in props:
                        nag_latency.append(props['firstNagToTookSeconds'])
                    if r['name'] == 'nag.day_end' and 'slotsOpen' in props:
                        stamp = iso_stamp(r.get('ts'))
                        if stamp:
                            # day_end is emitted on the first run after Dubai midnight.
                            dubai = dt.timezone(dt.timedelta(hours=4))
                            ended = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone(dubai).date() - dt.timedelta(days=1)
                            open_slots[str(ended)] = props['slotsOpen']
                    if r['name'] == 'sync.run':
                        saved = props.get('lastScoredSleep')
                        if saved:
                            last_scored = max(last_scored or saved, saved)
                        endpoint = props.get('sleep', {})
                        if (endpoint.get('fetchComplete') is True and endpoint.get('httpStatus') == 200
                                and endpoint.get('rawCount') == 0):
                            zero_sleep += 1
                        elif 'sleep' not in props and r.get('ok') is True and props.get('sleepCount') == 0:
                            zero_sleep += 1
                        stamp = endpoint.get('newestScoredRecordEnd')
                        if endpoint.get('scoreStates', {}).get('SCORED', 0) and stamp:
                            last_scored = max(last_scored or stamp, stamp)
                    if r.get('component') == 'food' and r['name'] == 'cli.run' and r.get('ok') is False:
                        food_errors[props.get('subcommand', 'none')] += 1
                    obligation = ('card' if r['name'] == 'card.render' else
                                  'nag' if r['name'] == 'nag.sent' else 'warning' if r['name'] == 'food.warning' else None)
                    if obligation:
                        expected.add((origin if valid_run(origin) else 'legacy-%d' % sum(names.values()), obligation))
                    if r['name'] == 'delivery.result' and valid_run(props.get('runIdRef')) and type(props.get('ok')) is bool:
                        delivered[(props['runIdRef'], props.get('kind'))] = props['ok']
                    value = r.get('durationMs')
                    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                        durations[r['name']].append(value)
                    tag = r.get('error', {}).get('tag')
                    if tag in TAGS:
                        cause = (tag, props.get('exceptionClass'), props.get('exitCode'))
                        tags[cause] += 1
                        candidate = r.get('ids', {}).get('run')
                        if isinstance(candidate, str) and len(candidate) == 32 and all(c in '0123456789abcdef' for c in candidate):
                            samples.setdefault(cause, candidate)
                except (ValueError, TypeError, AttributeError):
                    malformed += 1
        total = sum(names.values())
        rated = sum(outcomes.values())
        result = {'day': day.isoformat(), 'tool': 'health', 'total': total, 'malformedCount': malformed,
                  'countsByName': dict(names), 'countsByKind': dict(kinds), 'okCount': outcomes['ok'],
                  'errorCount': outcomes['error'], 'okRate': outcomes['ok'] / rated if rated else None,
                  'errorRate': outcomes['error'] / rated if rated else None,
                  'errorKindRate': kinds['error'] / total if total else None,
                  'durationMs': {}, 'topErrors': [],
                  'components': {component: _run_summary(run_times[component], start, end, intervals.get(component))
                                 for component in sorted(set(run_times) | set(intervals))},
                  'whoop': {'lastScoredSleep': last_scored, 'zeroSleepRuns': zero_sleep},
                  'food': {'errorsBySubcommand': dict(food_errors)},
                  'nag': {'firstNagToTookSeconds': {
                      'median': statistics.median(nag_latency) if nag_latency else None,
                      'p95': _percentile(sorted(nag_latency), .95) if nag_latency else None,
                      'samples': len(nag_latency)}, 'openSlotsByDay': open_slots},
                  'delivery': {'sent': sum(v is True for v in delivered.values()),
                               'failed': sum(v is False for v in delivered.values()),
                               'unmarked': len(expected - set(delivered))}}
        for name, values in durations.items():
            values.sort()
            result['durationMs'][name] = {'p50': _percentile(values, .5), 'p95': _percentile(values, .95), 'max': values[-1]}
        result['topErrors'] = [{'tag': cause[0], 'count': count, 'sampleId': samples.get(cause),
                                'exceptionClass': cause[1], 'exitCode': cause[2]}
                               for cause, count in tags.most_common(20)]
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
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
        root = log_dir()
        if root is None:
            return
        if (now.hour, now.minute) >= (0, 5) and not (root / ('rollup-' + day.isoformat() + '.json')).exists():
            rollup(day.isoformat())
    except BaseException:
        pass
