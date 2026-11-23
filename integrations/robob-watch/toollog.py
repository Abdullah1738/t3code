"""Best-effort, allowlisted health tool logs. Python 3.9, stdlib only."""
import contextlib
import argparse
import functools
import hashlib
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
TRIGGERS = {'schedule', 'manual', 'chained', 'retry', 'unknown'}
COMMANDS = {
    'food': 'search log quick meal-log log-order del flag add-food show-food recipe-new recipe-add recipe-show meal-save pantry today week phase checkin meals-count',
    'hlog': 'import summary weekly monthly labs site feel conflicts',
    'whoop': 'status sync authurl serve', 'cards': 'morning nutrition mark-sent', 'took': 'confirm skip',
    'validate': 'validate', 'rollup': 'rollup',
}
CONFLICTS = {'status', 'amount', 'time', 'missing_in_new_export', 'backdated_in_new_export',
             'time_offset_systematic', 'not_taken_in_export', 'taken_not_confirmed_in_meds_nag',
             'probable_duplicate_log', 'other'}
TAGS = {'exit_nonzero', 'invalid_arguments', 'food_not_resolved', 'not_authorized', 'reauth_needed', 'timeout',
        'subprocess_failed', 'renderer_failed', 'headless_chrome', 'database_error',
        'io_error', 'interrupted', 'internal_error', 'validate_failed', 'cap_reached'}
# Static CLI outcomes; never derive these values from exception or user text.
FOOD_EXIT_REASONS = {
    'food_not_found', 'food_ambiguous', 'food_needs_data', 'food_exists',
    'meal_not_found', 'recipe_not_found', 'source_required',
    'order_fetch_failed', 'order_no_items', 'order_unmatched',
    'order_bad_exclude', 'order_bad_portion', 'refused_duplicate',
    'bad_flag', 'bad_arguments', 'help',
}
ARGUMENT_REASONS = {'bad_arguments', 'unknown_subcommand', 'missing_required', 'bad_value'}
WHOOP_EXIT_REASONS = {'completed', 'sync_failed', 'not_authorized', 'reauth_needed',
                      'login_expired', 'backfill_failed', 'setup_failed', 'auth_failed',
                      'serve_failed', 'report_failed'}
WHOOP_AUTH_REASONS = {'token_missing', 'refresh_rejected', 'refresh_network', 'api_401', 'auth_failed'}
CLI_EXIT_REASONS = FOOD_EXIT_REASONS | ARGUMENT_REASONS | WHOOP_EXIT_REASONS | WHOOP_AUTH_REASONS
UNMARKED_MEANING = (
    'Distinct (run ID, kind) obligations from card.render (including failed renders), '
    'nag.sent, or food.warning with no matching delivery.result in this UTC day file; '
    'rows without a valid run ID count separately. This does not establish whether a send occurred.'
)
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
SYNC_PHASES = ('refreshMs', 'sleep.fetchMs', 'recovery.fetchMs', 'cycle.fetchMs', 'body.fetchMs', 'writeMs')
ENDPOINT_SCHEMA = {'fetchMs': int, 'httpStatus': 'status', 'rawCount': int, 'keptCount': int, 'fetchComplete': bool,
                   'scoreStates': {k: int for k in ('SCORED', 'PENDING_SCORE', 'UNSCORABLE', 'OTHER')},
                   'newestRecordEnd': 'iso', 'newestScoredRecordEnd': 'iso', 'tokenExpiresInS': 'seconds'}
AUTH_SCHEMA = {'refreshRetried': bool, 'refreshOutcome': {'refreshed', 'retried_refreshed', 'reauth_needed', 'error'},
               'authStage': {'token_load', 'token_refresh', 'api_fetch'},
               'authSource': {'keychain', 'file', 'env'}, 'refreshHttpStatus': 'status',
               'apiHttpStatus': 'status', 'oauthError': 'oauth_code', 'attempt': int, 'retried': bool}
SCHEMAS = {
    'food.order_log': {'vertical': {'food', 'nownow', 'minutes', 'main', 'supermall'},
        'outcome': {'logged', 'partial', 'fetch_failed', 'no_items', 'unmatched', 'bad_exclude', 'bad_portion', 'duplicate'},
        'lines': int, 'unmatched': int, 'options_not_counted': int, 'fetch_ms': int},
    'food.warning': {'warning': {'no_time', 'macro_drift', 'unverified', 'assumed', 'option_not_counted', 'partial'}, 'count': int},
    'cli.run': {'command': set(COMMANDS), 'subcommand': set(' '.join(COMMANDS.values()).split()) | {'unknown', 'none', 'help'},
                'failCount': int, 'failedCheckIds': 'check_ids',
                'reason': CLI_EXIT_REASONS, 'candidateCount': int, 'queryLen': int,
                'argc': int, 'rejected': 'rejected', **AUTH_SCHEMA},
    'watcher.run': {'trigger': 'trigger', 'scheduledAt': 'optional_iso',
                    'startLagMs': 'lag_ms', 'hostLoad1m': 'load'},
    'sync.run': {'offsetFallbacks': int, 'offsetSamples': 'offset_samples', 'reauthPending': bool, 'reminderSent': bool, 'hoursSinceLastSuccess': 'hours',
        'reauthPendingSinceDay': 'day', 'trigger': 'trigger', 'refreshMs': int, 'writeMs': int, 'hostLoad1m': 'load', 'sleepCount': int, 'recoveryCount': int, 'cycleCount': int,
        'lastScoredSleep': 'iso', 'bodyCount': int, 'tokenRefreshed': bool, 'notScoredYet': bool, 'reason': WHOOP_AUTH_REASONS, **AUTH_SCHEMA,
        **{k: ENDPOINT_SCHEMA for k in ('sleep', 'recovery', 'cycle', 'body')}},
    'sync.gap': {'count': int, 'lastSleepEnd': 'iso', 'lastRecoveryEnd': 'iso', 'gapHours': 'seconds'},
    'card.render': {'kind': {'morning', 'nutrition'}, 'runIdRef': 'run'},
    'delivery.result': {'kind': {'card', 'nag', 'warning'}, 'ok': bool, 'errorTag': TAGS | {'none'}, 'runIdRef': 'run', 'source': {'auto', 'manual'}},
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
        if spec == 'trigger':
            out[key] = value if isinstance(value, str) and value in TRIGGERS else 'unknown'
        elif isinstance(spec, dict) and isinstance(value, dict):
            out[key] = _fields(spec, value)
        elif spec == 'run' and valid_run(value):
            out[key] = value
        elif spec == 'iso':
            out[key] = iso_stamp(value)
        elif spec == 'optional_iso' and iso_stamp(value) is not None:
            out[key] = iso_stamp(value)
        elif spec == 'lag_ms' and (value is None or type(value) in (int, float)
                                   and math.isfinite(value)):
            out[key] = value
        elif spec == 'day' and isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            try:
                out[key] = dt.date.fromisoformat(value).isoformat()
            except ValueError:
                pass
        elif spec == 'hours' and (value is None or type(value) in (int, float)
                                  and math.isfinite(value) and value >= 0):
            out[key] = value
        elif spec == 'load' and type(value) in (int, float) and math.isfinite(value) and value >= 0:
            out[key] = round(value, 1)
        elif spec == 'oauth_code' and key in props:
            out[key] = (value if value is None or isinstance(value, str) and re.fullmatch(r'[a-z_]{1,40}', value)
                        else '<redacted>')
        elif spec == 'status' and key in ('refreshHttpStatus', 'apiHttpStatus') and key not in props:
            continue
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
        elif spec == 'rejected' and isinstance(value, (list, tuple)):
            out[key] = rejected_names(value, props.get('reason'))
        elif spec == 'offset_samples' and isinstance(value, (list, tuple)):
            out[key] = list(dict.fromkeys(v for v in value if isinstance(v, str)))[:3]
        elif spec == 'check_ids' and isinstance(value, (list, tuple)):
            out[key] = sorted({v for v in value if isinstance(v, str) and v in VALIDATE_CHECK_IDS})
        elif spec is bool and type(value) is bool:
            out[key] = value
        elif spec is int and type(value) is int and 0 <= value <= 10**9:
            out[key] = value
        elif isinstance(spec, set) and isinstance(value, str) and value in spec:
            out[key] = value
    return out



def rejected_names(values, reason=None):
    names = set()
    for value in values:
        if not isinstance(value, str):
            continue
        # Values attached with '=' are never part of a flag name.
        flag = value.partition('=')[0]
        if re.fullmatch(r'--[A-Za-z][A-Za-z0-9-]{0,63}', flag):
            names.add(flag)
        elif reason == 'unknown_subcommand' and re.fullmatch(r'[a-z][a-z0-9-]{0,30}', value):
            names.add(value)
        else:
            names.add('<redacted>')
    return sorted(names)[:32]


def argument_failure(span, reason, rejected=(), argc=0):
    if span is not None:
        names = rejected_names(rejected, reason)
        span.props.update(reason=reason, rejected=names, argc=getattr(span, 'argc', argc), stage='parse')
        if span.component == 'food':
            span.props.setdefault('queryLen', 0)
        span.rejected = names


class LoggedArgumentParser(argparse.ArgumentParser):
    """Read argument structure; argparse keeps ownership of output and exit status."""
    def __init__(self, *args, log_span=None, **kwargs):
        self.log_span = log_span
        self._failure = None
        self._extras = []
        self._option = None
        self._input_args = []
        self._argc = 0
        super().__init__(*args, **kwargs)

    def add_subparsers(self, **kwargs):
        kwargs.setdefault('parser_class', functools.partial(type(self), log_span=self.log_span))
        return super().add_subparsers(**kwargs)

    def _check_value(self, action, value):
        try:
            return super()._check_value(action, value)
        except argparse.ArgumentError:
            self._failure = (('unknown_subcommand', [value]) if (isinstance(action, argparse._SubParsersAction) or action.dest in {'cmd', 'kind'})
                             else ('bad_value', action.option_strings or ['<redacted>']))
            raise

    def _get_value(self, action, arg_string):
        try:
            return super()._get_value(action, arg_string)
        except argparse.ArgumentError:
            self._failure = ('bad_value', action.option_strings or ['<redacted>'])
            raise

    def _match_argument(self, action, pattern):
        try:
            return super()._match_argument(action, pattern)
        except argparse.ArgumentError:
            self._failure = ('missing_required', action.option_strings)
            raise

    def _parse_optional(self, arg_string):
        self._option = arg_string
        return super()._parse_optional(arg_string)

    def parse_known_args(self, args=None, namespace=None):
        self._input_args = list(sys.argv[1:] if args is None else args)
        self._argc = len(self._input_args)
        parsed, self._extras = super().parse_known_args(self._input_args, namespace)
        if self.log_span is not None:
            command = self.log_span.props.get('command')
            if getattr(parsed, 'cmd', None) in COMMANDS.get(command, '').split():
                self.log_span.props['subcommand'] = parsed.cmd
        return parsed, self._extras

    def error(self, message):
        if self._failure is not None:
            reason, names = self._failure
        elif message.startswith(('the following arguments are required:', 'one of the arguments ')):
            reason = 'missing_required'
            required = message.partition(':')[2].replace(',', ' ').split() if ':' in message else message.split()
            names = [flag for action in self._actions for flag in action.option_strings if flag in required]
        elif message.startswith('ambiguous option:'):
            reason, names = 'bad_arguments', [self._option]
        else:
            reason = 'bad_arguments'
            # Only option-shaped extras before '--'; positional text is never inspected.
            args = self._input_args
            before = args[:args.index('--')] if '--' in args else args
            names = [word.partition('=')[0] for word in self._extras
                     if word in before and word.startswith('-')]
            if not names and self._extras:
                names = ['<redacted>']
            if not names:
                for action in self._actions:
                    if message.startswith('argument ' + str(argparse._get_action_name(action)) + ':'):
                        names = action.option_strings or ['<redacted>']
                        break
        argument_failure(self.log_span, reason, names, getattr(self, '_argc', 0))
        super().error(message)

    def exit(self, status=0, message=None):
        if self.log_span is not None and 'reason' not in self.log_span.props:
            if status == 0:
                self.log_span.props['reason'] = 'help'
            else:
                argument_failure(self.log_span, 'bad_arguments', argc=getattr(self, '_argc', 0))
        super().exit(status, message)


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
            row['error']['rejected'] = rejected_names(rejected, clean.get('reason'))
    return (json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n').encode()


def _retention(root, today):
    cutoff = today - dt.timedelta(days=30)
    for path in (root / 'receipts').glob('????-??-??.ndjson'):
        try:
            if dt.date.fromisoformat(path.stem) < cutoff:
                path.unlink()
        except (ValueError, OSError):
            pass
    for path in root.iterdir():
        name = path.name
        day = name.removeprefix('rollup-').removeprefix('.cap-').removesuffix('.ndjson').removesuffix('.json')
        try:
            if dt.date.fromisoformat(day) < cutoff and name in (day + '.ndjson', 'rollup-' + day + '.json', '.cap-' + day):
                path.unlink()
        except (ValueError, OSError):
            pass


def _repair_tail(fd):
    # Called under the exclusive log lock: an interrupted row must not absorb the next one.
    size = os.fstat(fd).st_size
    if size and os.pread(fd, 1, size - 1) != b'\n':
        end = size
        while end:
            start = max(0, end - 4096)
            block = os.pread(fd, end - start, start)
            if len(block) != end - start:
                raise OSError('incomplete log tail read')
            newline = block.rfind(b'\n')
            if newline >= 0:
                end = start + newline + 1
                break
            end = start
        os.ftruncate(fd, end)
        size = end
    return size


def _append_row(fd, row):
    size = os.fstat(fd).st_size
    complete = False
    try:
        complete = os.write(fd, row) == len(row)
        return complete
    finally:
        # Keep complete rows intact on short writes, exceptions and interruptions.
        if not complete:
            os.ftruncate(fd, size)


def emit(component, name, kind='event', duration_ms=None, ok=None, props=None, tag=None, run_id=None, rejected=None, _now=None):
    """Return whether the requested row was fully appended; logging never raises."""
    try:
        if component not in COMPONENTS or name not in SCHEMAS or kind not in ('event', 'perf', 'error'):
            return False
        now = _now or utcnow()
        root = log_dir()
        if root is None:
            return False
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        root.chmod(0o700)
        path = root / (now.date().isoformat() + '.ndjson')
        fd = os.open(str(path), os.O_RDWR | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.fchmod(fd, 0o600)
            # Never wait for another writer, and never lock across tool work.
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            size = _repair_tail(fd)
            if size == 0:
                _retention(root, now.date())
            if size >= CAP_BYTES:
                try:
                    marker = os.open(str(root / ('.cap-' + now.date().isoformat())), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                except FileExistsError:
                    pass
                else:
                    os.close(marker)
                    if not _append_row(fd, _line(component, 'log.cap', 'error', None, False, {}, 'cap_reached', None, now)):
                        return False
                if kind != 'error':
                    return False
            row = _line(component, name, kind, duration_ms, ok, props, tag, run_id, now, rejected)
            return _append_row(fd, row)
        finally:
            os.close(fd)
    except BaseException:
        return False


class Span:
    def __init__(self, component, name, props=None, trigger=None):
        self.component, self.name = component, name
        self.props = props if props is not None else {}
        if name in ('watcher.run', 'sync.run'):
            self.props['trigger'] = trigger
        self.ok, self.tag, self.run_id, self.start = True, None, None, None
        self.rejected = []
        self.render_at = None

    def __enter__(self):
        try:
            self.start = time.monotonic()
            if self.name == 'watcher.run':
                scheduled = iso_stamp(self.props.get('scheduledAt'))
                if 'scheduledAt' not in self.props and self.props.get('trigger') in ('schedule', 'retry'):
                    scheduled = iso_stamp(os.environ.get('HEALTH_TOOLLOG_SCHEDULED_AT'))
                if scheduled is not None:
                    self.props['scheduledAt'] = scheduled
                self.props['startLagMs'] = ((utcnow() - dt.datetime.fromisoformat(
                    scheduled.replace('Z', '+00:00'))).total_seconds() * 1000
                    if scheduled is not None else None)
            if self.name in ('watcher.run', 'sync.run'):
                # Missing load support must not suppress the span or its outcome.
                try:
                    self.props['hostLoad1m'] = round(os.getloadavg()[0], 1)
                except (AttributeError, OSError):
                    pass
            if self.name == 'card.render':
                # A render spanning midnight and all its sidecars share this obligation day.
                self.render_at = utcnow()
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
                    self.tag = ('food_not_resolved' if self.component == 'food' and self.name == 'cli.run'
                                and isinstance(exc, SystemExit)
                                and self.props.get('reason') in ('food_not_found', 'food_ambiguous')
                                else error_tag(exc, self.name == 'card.render'))
                self.props['exceptionClass'] = type(exc).__name__
                self.props['exitCode'] = ((int(exc.code) % 256 if isinstance(exc.code, int) else 1)
                                          if isinstance(exc, SystemExit) else
                                          130 if isinstance(exc, KeyboardInterrupt) else 1)
                if tb is not None:
                    while tb.tb_next is not None:
                        tb = tb.tb_next
                    self.props.setdefault('stage', tb.tb_frame.f_code.co_name)
            emit(self.component, self.name, 'perf' if self.ok else 'error',
                 (time.monotonic() - self.start) * 1000, self.ok, self.props, self.tag, self.run_id, rejected=self.rejected, _now=self.render_at)
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


def trigger(default='manual'):
    value = os.environ.get('HEALTH_TOOLLOG_TRIGGER', default)
    return value if isinstance(value, str) and value in TRIGGERS else 'unknown'


def run(component, argv=None, name='cli.run', trigger=None):
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
        span = Span(component, name, props, trigger=trigger)
        span.argc = len(args)
        return span
    except BaseException:
        return contextlib.nullcontext()


def snoozed(component, count, state, now):
    """Record count changes and a Dubai-day heartbeat; caller persists its state."""
    try:
        if component not in {'meds-nag', 'gym-nudge', 'nutrition-nudge'} or type(count) is not int or not 0 <= count <= 10**9:
            return False
        day = now.astimezone(dt.timezone(dt.timedelta(hours=4))).date().isoformat()
        marker = {'day': day, 'count': count}
        if state.get('_toollogSnoozed') == marker:
            return False
        if not emit(component, 'nag.snoozed', props={'count': count}):
            return False
        state['_toollogSnoozed'] = marker
        return True
    except BaseException:
        return False


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


def write_card_sidecars(paths, run_id, render_at=None):
    """Bind each returned PNG's bytes to one member of a render, without captions or paths."""
    if not valid_run(run_id) or not paths:
        return
    ids = [uuid.uuid4().hex for _ in paths]
    created = (render_at or utcnow()).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    for raw, card_id in zip(paths, ids):
        path = Path(raw)
        metadata = {'version': 1, 'runId': run_id, 'kind': 'card', 'createdAt': created,
                    'cardId': card_id, 'cardIds': ids,
                    'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        target = path.with_name(path.name + '.delivery.json')
        temp = target.with_name('.' + uuid.uuid4().hex + '.delivery.json')
        fd = os.open(str(temp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as fh:
            json.dump(metadata, fh, separators=(',', ':'))
            fh.write('\n')
        os.replace(str(temp), str(target))


@contextlib.contextmanager
def _delivery_lock(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(str(root / '.delivery.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        # Shared with manual acknowledgements; hold only for receipt/log I/O, never a send.
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _delivery_unlocked(root, kind, run_id, ok, tag, component, source, now):
    target = root / (now.date().isoformat() + '.ndjson')
    try:
        with target.open() as fh:
            prior = None
            for line in fh:
                try:
                    row = json.loads(line)
                    props = row.get('props', {})
                    if (row.get('name') == 'delivery.result' and props.get('runIdRef') == run_id
                            and props.get('kind') == kind):
                        prior = props.get('ok')
                except (ValueError, AttributeError):
                    continue
            # A retry may correct a failure; replay/manual+auto cannot duplicate a result
            # or downgrade accepted media to failed because a second send was rejected.
            if prior is True or prior is False and not ok:
                return True
    except FileNotFoundError:
        pass
    # emit's day and timestamp must agree with the render's UTC day for delayed intake.
    # The acceptance time stays in the private receipt spool, not in user-facing text.
    return emit(component, 'delivery.result', ok=ok, props={'kind': kind, 'ok': ok,
                'errorTag': 'none' if ok else (tag if tag in TAGS else 'internal_error'),
                'runIdRef': run_id, 'source': source}, _now=now)


def delivery(kind, run_id, ok=True, tag=None, component='cards'):
    try:
        root = log_dir()
        if root is None or not valid_run(run_id) or kind not in {'card', 'nag', 'warning'} or type(ok) is not bool:
            return False
        with _delivery_lock(root):
            now = utcnow()
            # Route late manual acknowledgements to the same day as their obligation/auto receipt.
            for path in sorted(root.glob('????-??-??.ndjson'), reverse=True):
                found = False
                with path.open() as fh:
                    for line in fh:
                        try:
                            row = json.loads(line)
                            obligation = {'card': 'card.render', 'nag': 'nag.sent', 'warning': 'food.warning'}[kind]
                            if ((row.get('name') == obligation and row.get('ids', {}).get('run') == run_id)
                                    or (row.get('name') == 'delivery.result' and row.get('props', {}).get('runIdRef') == run_id
                                        and row.get('props', {}).get('kind') == kind)):
                                now = dt.datetime.combine(dt.date.fromisoformat(path.stem), now.timetz())
                                found = True
                                break
                        except (ValueError, AttributeError, TypeError):
                            continue
                if found:
                    break
            return _delivery_unlocked(root, kind, run_id, ok, tag, component, 'manual', now)
    except BaseException:
        return False


_RECEIPT_KEYS = {'version', 'runId', 'kind', 'createdAt', 'cardId', 'cardIds', 'sha256',
                 'ok', 'errorTag', 'acceptedAt'}


def _receipt(value, day):
    if not isinstance(value, dict) or set(value) != _RECEIPT_KEYS:
        return None
    created, accepted = iso_stamp(value['createdAt']), iso_stamp(value['acceptedAt'])
    ids = value['cardIds']
    if (type(value['version']) is not int or value['version'] != 1 or value['kind'] != 'card'
            or not valid_run(value['runId']) or not valid_run(value['cardId'])
            or not isinstance(ids, list) or not 1 <= len(ids) <= 128
            or not all(valid_run(i) for i in ids) or len(set(ids)) != len(ids)
            or value['cardId'] not in ids or not created or created[:10] != day or not accepted
            or dt.datetime.fromisoformat(accepted.replace('Z', '+00:00')) < dt.datetime.fromisoformat(created.replace('Z', '+00:00'))
            or type(value['ok']) is not bool
            or not isinstance(value['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['sha256'])
            or value['errorTag'] not in ( {'none'} if value['ok'] else TAGS)):
        return None
    return {**value, 'createdAt': created, 'acceptedAt': accepted}


def intake_receipts(day):
    """Import bridge-only terminal file outcomes; incomplete renders stay unmarked."""
    try:
        day = dt.date.fromisoformat(day).isoformat()
        root = log_dir()
        if root is None:
            return
        path = root / 'receipts' / (day + '.ndjson')
        if not path.exists():
            return True
        with _delivery_lock(root):
            groups = {}
            with path.open() as fh:
                for line in fh:
                    try:
                        receipt = _receipt(json.loads(line), day)
                        if receipt is None:
                            continue
                        key = (receipt['runId'], receipt['kind'])
                        manifest = (receipt['createdAt'], tuple(receipt['cardIds']))
                        group = groups.setdefault(key, {'manifest': manifest, 'files': {}, 'invalid': False})
                        if group['manifest'] != manifest:
                            group['invalid'] = True
                            continue
                        old = group['files'].get(receipt['cardId'])
                        if old and old['sha256'] != receipt['sha256']:
                            group['invalid'] = True
                        # Provider acceptance wins over a failed duplicate/retry, regardless of append order.
                        if not old or old['ok'] is not True:
                            group['files'][receipt['cardId']] = receipt
                    except (ValueError, TypeError, AttributeError):
                        continue
            for (run_id, kind), group in groups.items():
                if group['invalid']:
                    continue
                files = group['files']
                failures = [r for r in files.values() if not r['ok']]
                complete = set(files) == set(group['manifest'][1])
                if not failures and not complete:
                    continue
                stamp = dt.datetime.fromisoformat(group['manifest'][0].replace('Z', '+00:00'))
                if not _delivery_unlocked(root, kind, run_id, not failures,
                                          failures[0]['errorTag'] if failures else None, 'cards', 'auto', stamp):
                    return False
            return True
    except BaseException:
        # Receipts stay durable on disk: lock/write/cap failures can be retried by the next rollup.
        return False


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


def _cadence_times(runs):
    # A partially upgraded component must not count untagged/chained runs as ticks.
    tagged_day = any(tagged for _, tagged, _ in runs)
    return sorted(stamp for stamp, _, value in runs
                  if value == 'schedule' or not tagged_day)


def _late_ticks(cadence, interval):
    # Without a phase, only observed run-to-run gaps establish a late tick.
    return [b for a, b in zip(cadence, cadence[1:])
            if interval is not None and (b - a).total_seconds() > 1.25 * interval]


def _same_time_skips(late_times):
    ticks = sorted((stamp, component) for component, stamps in late_times.items() for stamp in stamps)
    counts, window = Counter(), Counter()
    left = right = 0
    for stamp, component in ticks:
        while right < len(ticks) and (ticks[right][0] - stamp).total_seconds() <= 120:
            window[ticks[right][1]] += 1
            right += 1
        while (stamp - ticks[left][0]).total_seconds() > 120:
            old = ticks[left][1]
            window[old] -= 1
            if not window[old]:
                del window[old]
            left += 1
        if len(window) >= 2:
            counts[component] += 1
    return counts


def _run_summary(runs, start, end, interval=None):
    timestamps = sorted(stamp for stamp, _, _ in runs)
    by_trigger = Counter(value for _, _, value in runs)
    cadence = _cadence_times(runs)
    # Day boundaries measure outages, but must not skew the observed cadence.
    observed = [(b - a).total_seconds() for a, b in zip(cadence, cadence[1:]) if b > a]
    median = statistics.median(observed) if observed else None
    threshold = 3 * interval if interval is not None else 3 * median if median is not None else None
    points = [start] + cadence + [end]
    gaps = [(a, (b - a).total_seconds()) for a, b in zip(points, points[1:])]
    late = _late_ticks(cadence, interval)
    result = {'runs': len(timestamps), 'runsByTrigger': dict(sorted(by_trigger.items())),
              'firstRunTs': timestamps[0].isoformat().replace('+00:00', 'Z') if timestamps else None,
              'lastRunTs': timestamps[-1].isoformat().replace('+00:00', 'Z') if timestamps else None,
              'medianGapSeconds': median, 'maxGapSeconds': max(seconds for _, seconds in gaps),
              'p95GapSeconds': _percentile(sorted(observed), .95) if observed else None,
              'lateRuns': len(late),
              'lateRunsByHour': dict(sorted(Counter(stamp.strftime('%H') for stamp in late).items())),
              'sameTimeSkips': 0,
              'gapThresholdSeconds': threshold,
              'gapsOver': [{'startTs': stamp.isoformat().replace('+00:00', 'Z'), 'seconds': seconds}
                           for stamp, seconds in sorted(gaps, key=lambda gap: -gap[1])
                           if threshold is not None and seconds > threshold][:10]}
    if interval is not None:
        # The config has no phase/history: these are elapsed-day count estimates.
        result['expectedRuns'] = math.floor((end - start).total_seconds() / interval)
        result['missedRuns'] = max(0, result['expectedRuns'] - len(cadence))
    return result


def _repeat_bursts(timestamps):
    # Count disjoint qualifying windows, not every overlapping triple in a retry loop.
    stamps = sorted(timestamps)
    count, left, right = 0, 0, 0
    while left < len(stamps):
        right = max(right, left)
        while right < len(stamps) and (stamps[right] - stamps[left]).total_seconds() <= 5:
            right += 1
        if right - left >= 3:
            count += 1
            left = right
        else:
            left += 1
    return count


def rollup(day=None):
    try:
        now = utcnow()
        day = dt.date.fromisoformat(day) if day else now.date() - dt.timedelta(days=1)
        started_ns = time.time_ns()
        if intake_receipts(day.isoformat()) is False:
            return None
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
        rejected_top, diagnostics, burst_times = defaultdict(Counter), defaultdict(set), defaultdict(list)
        malformed = 0
        zero_sleep, last_scored = 0, None
        auth_failures, whoop_runs = Counter(), []
        pending_reauth, pending_since = 0, None
        sync_phases, slow_syncs = defaultdict(list), 0
        food_errors, delivered, expected = Counter(), {}, set()
        receipt_sources = {}
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
                    props = _props(r['name'], r.get('props') or {})
                    pending = (r['name'] == 'sync.run' and r.get('component') == 'whoop-sync'
                               and r.get('ok') is False and props.get('reason') == 'refresh_rejected'
                               and props.get('reauthPending') is True)
                    if type(r.get('ok')) is bool and not pending:
                        outcomes['ok' if r['ok'] else 'error'] += 1
                    if pending:
                        pending_reauth += 1
                        stamp = iso_stamp(r.get('ts'))
                        since = props.get('reauthPendingSinceDay') or (stamp[:10] if stamp else None)
                        if since:
                            pending_since = min(pending_since or since, since)
                    component = r.get('component')
                    if r['name'] in ('watcher.run', 'sync.run') and component in COMPONENTS:
                        stamp = iso_stamp(r.get('ts'))
                        if stamp:
                            timestamp = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                            if start <= timestamp < day_end and timestamp <= end:
                                run_times[component].append((timestamp, 'trigger' in (r.get('props') or {}), props['trigger']))
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
                    if r['name'] == 'sync.run' and component == 'whoop-sync':
                        duration = r.get('durationMs')
                        if type(duration) in (int, float) and math.isfinite(duration) and duration > 15000:
                            slow_syncs += 1
                        for phase in SYNC_PHASES:
                            endpoint, _, field = phase.partition('.')
                            value = props.get(endpoint, {}).get(field) if field else props.get(phase)
                            if type(value) is int:
                                sync_phases[phase].append(value)
                        if r.get('ok') is False and props.get('authStage') and props.get('reason') in WHOOP_AUTH_REASONS:
                            auth_failures[(props['authStage'], props['reason'])] += 1
                        stamp = iso_stamp(r.get('ts'))
                        if stamp and type(r.get('ok')) is bool:
                            timestamp = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                            if start <= timestamp < day_end:
                                whoop_runs.append((timestamp, len(whoop_runs), r['ok']))
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
                        key = (props['runIdRef'], props.get('kind'))
                        delivered[key] = props['ok']
                        receipt_sources[key] = props.get('source', 'manual')
                    value = r.get('durationMs')
                    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                        durations[r['name']].append(value)
                    tag = r.get('error', {}).get('tag')
                    if tag in TAGS and not pending:
                        cause = (tag, props.get('reason'))
                        diagnostics[cause].add((props.get('exceptionClass'), props.get('exitCode')))
                        rejected_top[cause].update(props.get('rejected', rejected_names(
                            r.get('error', {}).get('rejected', []), props.get('reason'))))
                        stamp = iso_stamp(r.get('ts'))
                        if r['name'] == 'cli.run' and r.get('ok') is False and stamp and props.get('command'):
                            timestamp = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
                            if start <= timestamp < day_end:
                                burst_times[(props['command'], props.get('subcommand'), props.get('reason'))].append(timestamp)
                        tags[cause] += 1
                        candidate = r.get('ids', {}).get('run')
                        if isinstance(candidate, str) and len(candidate) == 32 and all(c in '0123456789abcdef' for c in candidate):
                            samples.setdefault(cause, candidate)
                except (ValueError, TypeError, AttributeError):
                    malformed += 1
        consecutive, max_consecutive = 0, 0
        for _, _, ok in sorted(whoop_runs):
            consecutive = 0 if ok else consecutive + 1
            max_consecutive = max(max_consecutive, consecutive)
        total = sum(names.values())
        rated = sum(outcomes.values())
        shared_skips = _same_time_skips({component: _late_ticks(_cadence_times(runs), intervals.get(component))
                                        for component, runs in run_times.items()})
        result = {'day': day.isoformat(), 'tool': 'health', 'total': total, 'malformedCount': malformed,
                  'countsByName': dict(names), 'countsByKind': dict(kinds), 'okCount': outcomes['ok'],
                  'errorCount': outcomes['error'], 'okRate': outcomes['ok'] / rated if rated else None,
                  'errorRate': outcomes['error'] / rated if rated else None,
                  'errorKindRate': kinds['error'] / total if total else None,
                  'durationMs': {}, 'topErrors': [],
                  'components': {component: _run_summary(run_times[component], start, end, intervals.get(component))
                                 for component in sorted(set(run_times) | set(intervals))},
                  'whoop': {'pendingReauthRuns': pending_reauth, 'reauthPendingSinceDay': pending_since,
                            'lastScoredSleep': last_scored, 'zeroSleepRuns': zero_sleep,
                            'syncPhaseMs': {phase: {'p50': _percentile(sorted(sync_phases[phase]), .5) if sync_phases[phase] else None,
                                                   'p95': _percentile(sorted(sync_phases[phase]), .95) if sync_phases[phase] else None,
                                                   'max': max(sync_phases[phase]) if sync_phases[phase] else None}
                                            for phase in SYNC_PHASES},
                            'slowSyncs': slow_syncs,
                            'authFailures': [{'authStage': stage, 'reason': reason, 'count': count}
                                             for (stage, reason), count in sorted(auth_failures.items())],
                            'consecutiveFailures': max_consecutive},
                  'food': {'errorsBySubcommand': dict(food_errors)},
                  'nag': {'firstNagToTookSeconds': {
                      'median': statistics.median(nag_latency) if nag_latency else None,
                      'p95': _percentile(sorted(nag_latency), .95) if nag_latency else None,
                      'samples': len(nag_latency)}, 'openSlotsByDay': open_slots},
                  'delivery': {'sent': sum(v is True for v in delivered.values()),
                               'failed': sum(v is False for v in delivered.values()),
                               # Missing same-day receipts, not a count of failed sends.
                               'unmarked': len(expected - set(delivered)),
                               'unmarkedMeaning': UNMARKED_MEANING,
                               'autoReceipts': sum(v == 'auto' for v in receipt_sources.values()),
                               'manualReceipts': sum(v == 'manual' for v in receipt_sources.values())}}
        for name, values in durations.items():
            values.sort()
            result['durationMs'][name] = {'p50': _percentile(values, .5), 'p95': _percentile(values, .95), 'max': values[-1]}
        for component, summary in result['components'].items():
            summary['sameTimeSkips'] = shared_skips[component]
        result['repeatBurst'] = sum(_repeat_bursts(values) for values in burst_times.values())
        result['topErrors'] = []
        for cause, count in tags.most_common(20):
            detail = diagnostics[cause]
            result['topErrors'].append({'tag': cause[0], 'reason': cause[1], 'count': count,
                'sampleId': samples.get(cause),
                'exceptionClass': next(iter(detail))[0] if len(detail) == 1 else None,
                'exitCode': next(iter(detail))[1] if len(detail) == 1 else None,
                'rejected': [{'name': name, 'count': n} for name, n in
                             sorted(rejected_top[cause].items(), key=lambda item: (-item[1], item[0]))[:3]]})
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        root.chmod(0o700)
        target = root / ('rollup-' + day.isoformat() + '.json')
        temp = root / ('.rollup-' + uuid.uuid4().hex)
        fd = os.open(str(temp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as fh:
            json.dump(result, fh, separators=(',', ':'), allow_nan=False)
            fh.write('\n')
        os.replace(str(temp), str(target))
        # A receipt appended during this rollup must trigger another intake.
        os.utime(str(target), ns=(started_ns, started_ns))
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
        # File sends arrive after the render, sometimes after midnight or an earlier rollup.
        # Stat only the bounded retained spool; unchanged receipts need no repeated scan.
        for receipt in (root / 'receipts').glob('????-??-??.ndjson'):
            receipt_day = dt.date.fromisoformat(receipt.stem)
            target = root / ('rollup-' + receipt.stem + '.json')
            source = root / (receipt.stem + '.ndjson')
            if (0 <= (now.date() - receipt_day).days <= 30
                    and (not target.exists() or receipt.stat().st_mtime_ns > target.stat().st_mtime_ns
                         or source.exists() and source.stat().st_mtime_ns > target.stat().st_mtime_ns)):
                rollup(receipt.stem)
        target = root / ('rollup-' + day.isoformat() + '.json')
        source = root / (day.isoformat() + '.ndjson')
        if ((now.hour, now.minute) >= (0, 5)
                and (not target.exists() or source.exists() and source.stat().st_mtime_ns > target.stat().st_mtime_ns)):
            rollup(day.isoformat())
    except BaseException:
        pass
