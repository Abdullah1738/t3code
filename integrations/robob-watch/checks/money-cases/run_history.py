"""Bounded, metadata-only check history in the watcher directory."""
from collections import Counter
from contextlib import contextmanager
from contextvars import ContextVar
import datetime as dt
import json
import functools
import fcntl
import math
import os
from pathlib import Path
import re
import stat
import signal
import time

from charges import within, toollog as orders_log

MAX_BYTES = 2 * 1024 * 1024
MAX_ROW_BYTES = 16 * 1024
APPEND_BUDGET = 0.04
APPEND_ERRORS = 0
_ACTIVE = ContextVar('money_cases_run_history', default=None)
PHASES = {'reconcile', 'follow', 'attention', 'build_write', 'merchants', 'order_charges', 'payments',
          'questions', 'refunds', 'owner_threads', 'msgs', 'history', 'receipt', 'lookups', 'order_screen',
          'census', 'loads', 'writes', 'locks', 'untimed', 'none'}
# Exception text can contain a message body or command stderr. Only retain known
# diagnostic grammar; unknown details never enter the history, even after redaction.
SOURCE_PREFIX = r'(?:(?:his threads|receipt|orders|merchant history|refund mail|noon orders|careem orders): )*'
ERROR = re.compile(
    SOURCE_PREFIX +
    r'(?:Robob control: (?:message provenance unavailable; server update required|credentials unavailable|'
    r'request failed or timed out|invalid response|owner cache save failed|incomplete thread list|'
    r'invalid thread list|invalid thread count|invalid thread|missing thread id|invalid message list|'
    r'invalid message count|incomplete message list|lookup over time|invalid message|invalid message timestamp|'
    r'message id unavailable; server update required|thread updatedAt unavailable; server update required|'
    r'owner read incomplete \(\d{1,6} of \d{1,6} threads\); continuing next check)|'
    r'out of time(?: saving pings)?(?:; the rest next check)?|lookup unavailable(?: or incomplete)?|'
    r'(?:receipt scan|merchant history) incomplete: (?:read|search) limit reached|'
    r'card-status merchant dead unavailable or invalid; merchant cases unchanged|'
    r'card owners: settings unreadable|msgs: (?:unreadable search output|timed out))')


def safe_error(error):
    if not isinstance(error, str):
        return 'unclassified error (details omitted)'
    if error in {'msgs: lookup failed (details omitted)', 'Robob control: error (details omitted)',
                 'unclassified error (details omitted)'}:
        return error
    # Strip question identities; grouping is by failure, not by private book row.
    error = re.sub(r'^q-[a-f0-9]+: ', '', error[:4096])
    # Case slugs are book keys, not message text; group them by failure.
    error = re.sub(r'^(refund mail|receipt|merchant history) [a-z0-9][a-z0-9-]{0,80}: ', r'\1: ', error)
    timeout = re.fullmatch(
        r'(' + SOURCE_PREFIX + r")msgs: Command '\[.*\]' timed out after \d+(?:\.\d+)? seconds", error)
    if timeout:
        error = timeout[1] + 'msgs: timed out'
    # An incomplete owner read may end in another safe control error.
    parts = error.split('continuing next check: ', 1)
    if len(parts) == 2:
        error = parts[0] + 'continuing next check: ' + safe_error(parts[1])
        if ERROR.fullmatch(parts[0] + 'continuing next check'):
            return error if len(error) <= 300 else parts[0] + 'continuing next check'
    if ERROR.fullmatch(error):
        return error[:300]
    if re.search(r'\bmsgs (?:exit -?\d{1,3}:|show:)', error):
        return 'msgs: lookup failed (details omitted)'
    if 'Robob control:' in error:
        return 'Robob control: error (details omitted)'
    return 'unclassified error (details omitted)'


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def run_row(values):
    row = {key: value for key, value in values.items() if numeric(value)}
    # Numeric-only fields cannot contain message text, even when new timing
    # counters are added. Structured receipt counters are projected explicitly.
    for key in ('msgs_by_kind', 'receipt_result'):
        value = values.get(key)
        if isinstance(value, dict):
            row[key] = {k: ({n: v for n, v in val.items() if n in {'count', 'ms'} and numeric(v)} if isinstance(val, dict) else val)
                        for k, val in value.items() if k in {'receipt', 'order', 'refund', 'history', 'other',
                                                                         'found', 'none', 'out_of_time', 'error'}
                        and (numeric(val) or isinstance(val, dict))}
    if isinstance(values.get('marketplace_refresh'), dict):
        row['marketplace_refresh'] = orders_log.marketplace_refresh_fields(values['marketplace_refresh'])
    row['at'] = values['at']
    row['exit'] = values.get('exit') if type(values.get('exit')) is int else None
    row['slowest'] = values.get('slowest') if values.get('slowest') in PHASES else 'unknown'
    row['owner_result'] = values.get('owner_result') if values.get('owner_result') in {
        'ok', 'incomplete', 'list_failed', 'not_read'} else 'not_read'
    row.setdefault('owner_timeouts', 0)
    row.setdefault('owner_threads_fetched', 0)
    row['question_errors'] = [safe_error(e) for e in values.get('question_errors', [])[:10]]
    if values.get('stop_reason') in {'out_of_budget', 'pings_save_timeout', 'data_unavailable', 'check_busy', 'error'}:
        row['stop_reason'] = values['stop_reason']
    if values.get('skipped') is True:
        row['skipped'] = True
        row['skip_phase'] = values.get('skip_phase') if values.get('skip_phase') in PHASES else 'unknown'
    for key in ('skip_file', 'skip_last_file'):
        value = values.get(key)
        if isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9_.-]{1,128}', value):
            row[key] = value
    for key in ('skip_reason', 'skip_last_reason'):
        if values.get(key) in {'edeadlk', 'deadline'}:
            row[key] = values[key]
    if values.get('dataless_files', 0) is None:
        row['dataless_files'] = None
    value = values.get('dataless_error')
    if isinstance(value, str) and re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]{0,80} errno=(?:None|-?\d{1,6})', value):
        row['dataless_error'] = value
    return row


class AppendTimeout(Exception):
    pass


def repair_tail(fd, size):
    if not size or os.pread(fd, 1, size - 1) == b'\n':
        return size
    # A killed or short append must not swallow the next complete record. Our
    # own rows are bounded, so recovery needs only one tail read under the lock.
    start = max(0, size - MAX_ROW_BYTES)
    tail = os.pread(fd, size - start, start)
    newline = tail.rfind(b'\n')
    if newline < 0 and start:
        raise OSError('history tail exceeds row bound')
    size = start + newline + 1 if newline >= 0 else 0
    os.ftruncate(fd, size)
    return size


def append(wd, values):
    """No retries or fsync: at most 40 ms of best-effort local diagnostics."""
    global APPEND_ERRORS
    started = time.monotonic()
    try:
        # Leave enclosing deadlines to their caller, rather than swallowing them.
        remaining = signal.getitimer(signal.ITIMER_REAL)[0]
        if remaining and remaining <= APPEND_BUDGET:
            raise TimeoutError('caller deadline')
        with within(time.time() + APPEND_BUDGET, AppendTimeout('history append deadline')):
            row = run_row(values)
            row['history_append_errors'] = APPEND_ERRORS
            payload = (json.dumps(row, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n').encode()
            if len(payload) > MAX_ROW_BYTES:
                raise ValueError('history row exceeds bound')
            path = Path(wd) / 'runs.jsonl'
            flags = os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NONBLOCK | os.O_NOFOLLOW
            # Separate inode survives rotation. Busy checks and post-check appends
            # can overlap, so check.lock alone cannot protect history generations.
            lock = os.open(Path(wd) / 'runs.lock', flags, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fd = os.open(path, flags, 0o600)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode):
                        raise OSError('history is not a regular file')
                    size = repair_tail(fd, info.st_size)
                    if size + len(payload) > MAX_BYTES:
                        os.close(fd)
                        fd = None
                        os.replace(path, path.with_name('runs.jsonl.1'))
                        fd = os.open(path, flags, 0o600)
                    if os.write(fd, payload) != len(payload):
                        raise OSError('short history write')
                finally:
                    if fd is not None:
                        os.close(fd)
            finally:
                os.close(lock)
        return True
    except Exception as exc:
        if getattr(exc, '_money_cases_timeout', False) and not isinstance(exc, AppendTimeout):
            raise
        APPEND_ERRORS += 1
        values['history_append_errors'] = APPEND_ERRORS
        # Preserve a count in runner stderr even when no history line can be written.
        # This shares the 50 ms ceiling and never includes the exception text.
        remaining = .048 - (time.monotonic() - started)
        if remaining > 0 and not signal.getitimer(signal.ITIMER_REAL)[0]:
            try:
                with within(time.time() + remaining, TimeoutError('history diagnostic deadline')):
                    os.write(2, f'money-cases: history append errors={APPEND_ERRORS}\n'.encode())
            except Exception:
                pass
        return False


@contextmanager
def recording(wd):
    active = _ACTIVE.get()
    if active is not None:
        yield active
        return
    started = time.monotonic()
    row = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'owner_result': 'not_read'}
    token = _ACTIVE.set(row)
    try:
        yield row
        row.setdefault('exit', 0)
    except BaseException as exc:
        if type(exc).__name__ == 'DataUnavailable':
            record_skip(row, exc)
        else:
            row['stop_reason'] = 'check_busy' if type(exc).__name__ == 'CheckBusy' else 'error'
            row['exit'] = 75 if type(exc).__name__ == 'CheckBusy' else None
        raise
    finally:
        _ACTIVE.reset(token)
        row.update(row.pop('stats', {}))
        row.setdefault('total_s', round(time.monotonic() - started, 3))
        append(wd, row)


def record_skip(row, error, exit_code=0):
    row.update(exit=exit_code, skipped=True, skip_file=error.path.name, skip_reason=error.reason,
               skip_phase=row.get('slowest', 'loads'), stop_reason='data_unavailable', stats=error.stats,
               edeadlk_retries=error.stats.get('edeadlk_retries', 0), edeadlk_ms=error.stats.get('edeadlk_ms', 0),
               eintr_retries=error.stats.get('eintr_retries', 0))


def current():
    return _ACTIVE.get()


def record_check(fn):
    @functools.wraps(fn)
    def wrapped(wd, *args, **kwargs):
        with recording(wd):
            return fn(wd, *args, **kwargs)
    return wrapped


def since_time(value, now):
    match = re.fullmatch(r'(\d+(?:\.\d+)?)([smhd])', value)
    if match:
        return now - dt.timedelta(seconds=float(match[1]) * {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[match[2]])
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('--since needs a duration (24h) or an ISO time with timezone')
    return parsed


def percentile(values, percent):
    if not values:
        return None
    rank = (len(values) - 1) * percent
    lo, hi = math.floor(rank), math.ceil(rank)
    return round(values[lo] + (values[hi] - values[lo]) * (rank - lo), 3)


@contextmanager
def snapshot_lock(wd):
    try:
        fd = os.open(Path(wd) / 'runs.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        yield
        return
    try:
        # Snapshot both generations together: a rotation between the two reads
        # would otherwise omit the just-rotated generation from a read-back.
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def summary(wd, since='24h', now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    cutoff = since_time(since, now)
    rows, invalid = [], 0
    with snapshot_lock(wd):
        for name in ('runs.jsonl.1', 'runs.jsonl'):
            try:
                with (Path(wd) / name).open() as handle:
                    for line in handle:
                        try:
                            row = json.loads(line)
                            at = dt.datetime.fromisoformat(row['at'].replace('Z', '+00:00'))
                            errors = row.get('question_errors', [])
                            if at.tzinfo is None or not numeric(row.get('total_s')) or not isinstance(errors, list) \
                                    or not all(isinstance(e, str) for e in errors):
                                raise ValueError('invalid run')
                            if cutoff <= at <= now:
                                rows.append(run_row(row))
                        except (ValueError, TypeError, KeyError, AttributeError):
                            invalid += 1
            except FileNotFoundError:
                pass
    rows.sort(key=lambda row: dt.datetime.fromisoformat(row['at'].replace('Z', '+00:00')))
    totals = sorted(row['total_s'] for row in rows)
    errors = Counter(e for row in rows for e in row.get('question_errors', []))
    return {'since': cutoff.isoformat(), 'run_count': len(rows),
            'over_40_count': sum(row['total_s'] > 40 for row in rows),
            'total_s': {'p50': percentile(totals, .5), 'p95': percentile(totals, .95),
                        'max': max(totals) if totals else None},
            'slow_runs': [{key: row.get(key) for key in ('at', 'total_s', 'slowest')}
                          for row in rows if row['total_s'] > 40],
            'marketplace_refresh': next((row['marketplace_refresh'] for row in reversed(rows)
                                         if 'marketplace_refresh' in row), {}),
            'owner_results': dict(sorted(Counter(row.get('owner_result', 'not_read') for row in rows).items())),
            'question_errors': dict(sorted(errors.items())), 'invalid_lines': invalid}


def format_summary(result):
    totals = result['total_s']
    lines = [f"Runs: {result['run_count']}; over 40 s: {result['over_40_count']}",
             f"Total seconds: p50={totals['p50']} p95={totals['p95']} max={totals['max']}",
             'Owner results: ' + (', '.join(f'{key}={n}' for key, n in result['owner_results'].items()) or 'none'),
             'Question errors: ' + ('none' if not result['question_errors'] else '')]
    refresh = result.get('marketplace_refresh', {})
    age = refresh.get('snapshot_age_s')
    lines[0] += f"; marketplace snapshot age: {str(age) + ' s' if age is not None else 'unknown'}; last refresh: {refresh.get('last_result') or 'unknown'}"
    lines += [f'  {n}x {error}' for error, n in result['question_errors'].items()]
    lines += [f"  {row['at']}: {row['total_s']} s, slowest={row['slowest']}" for row in result['slow_runs']]
    if result['invalid_lines']:
        lines.append(f"Invalid history lines skipped: {result['invalid_lines']}")
    return '\n'.join(lines)
