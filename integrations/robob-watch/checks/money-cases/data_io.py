"""Deadline-bounded materialization of iCloud books and their lock files."""
from contextlib import contextmanager, nullcontext
import contextvars
import errno
import os
from pathlib import Path
import signal
import stat
import subprocess
import time
import threading

SF_DATALESS = 0x40000000
_SCOPE = contextvars.ContextVar('money_cases_data_io', default=None)


class DataUnavailable(BaseException):
    # Cache/reset and partial-progress handlers must never turn an unreadable book
    # into an empty book and commit over it.
    def __init__(self, path, reason='edeadlk'):
        self.path = Path(path)
        self.reason = reason
        state = _SCOPE.get()
        self.stats = state['stats'] if state and state['stats'] is not None else {}
        super().__init__(f'data file unavailable ({reason}): {self.path.name}')


@contextmanager
def scope(deadline, stats=None):
    parent = _SCOPE.get()
    if parent is not None:
        deadline = min(deadline, parent['deadline'])
        stats = stats if stats is not None else parent['stats']
    token = _SCOPE.set({'deadline': deadline, 'stats': stats, 'failed': False})
    try:
        yield
    finally:
        _SCOPE.reset(token)


def current_scope():
    return _SCOPE.get()


def materialize_io(fn, path, deadline=None):
    state = _SCOPE.get()
    end = deadline if deadline is not None else time.time() + 40
    if state is not None:
        end = min(end, state['deadline'])
        if state['failed']:
            raise DataUnavailable(path, state['failure_reason'])
    alarm = signal.getitimer(signal.ITIMER_REAL)[0] if threading.current_thread() is threading.main_thread() else 0
    alarm_end = time.time() + alarm if alarm else None
    # Preserve an earlier caller's timeout behavior on the first attempt.
    # A tiny scheduling tolerance avoids replacing an effectively identical timer.
    caller_bounds_initial = alarm_end is not None and alarm_end <= end + 0.005
    initial_timeout = DataUnavailable(path, 'deadline')
    initial_timer = nullcontext() if caller_bounds_initial else _within(end, initial_timeout)
    stats = state['stats'] if state else None
    started = None
    retries = 0
    eintr_retries = 0
    first_interrupt = None

    def attempt():
        nonlocal eintr_retries, first_interrupt
        while True:
            if first_interrupt is not None and time.time() >= end:
                raise first_interrupt
            try:
                return fn()
            except OSError as exc:
                if not isinstance(exc, InterruptedError) and exc.errno != errno.EINTR:
                    raise
                if first_interrupt is None:
                    first_interrupt = exc
                if eintr_retries >= 3 or time.time() >= end:
                    raise first_interrupt
                eintr_retries += 1
                if stats is not None:
                    stats['eintr_retries'] = stats.get('eintr_retries', 0) + 1

    try:
        if time.time() >= end:
            raise DataUnavailable(path, 'deadline')
        try:
            with initial_timer:
                return attempt()
        except OSError as exc:
            if exc.errno != errno.EDEADLK:
                raise
        started = time.monotonic()
        # Unwind before the phase timer can enter its partial-progress/save handler.
        if alarm_end is not None:
            end = min(end, alarm_end - 0.01)
        if time.time() >= end:
            raise DataUnavailable(path)
        with _within(end, DataUnavailable(path)):
            try:
                subprocess.run(['brctl', 'download', str(path)], timeout=min(2, end - time.time()),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except (OSError, subprocess.TimeoutExpired):
                pass
            while True:
                delay = (0.2, 0.5, 1, 2)[min(retries, 3)]
                if end - time.time() <= delay:
                    raise DataUnavailable(path)
                time.sleep(delay)
                if time.time() >= end:
                    raise DataUnavailable(path)
                retries += 1
                if stats is not None:
                    stats['edeadlk_retries'] = stats.get('edeadlk_retries', 0) + 1
                try:
                    return attempt()
                except OSError as exc:
                    if exc.errno != errno.EDEADLK:
                        raise

    except DataUnavailable as exc:
        # Our timer also bounds immediate EINTR retries. Expiring there must
        # preserve the interruption; a caller's timer and EDEADLK keep their aborts.
        if exc is initial_timeout and first_interrupt is not None:
            raise first_interrupt
        if state is not None:
            state['failed'] = True
            state['failure_reason'] = exc.reason
        raise
    finally:
        if started is not None and stats is not None:
            stats['edeadlk_ms'] = stats.get('edeadlk_ms', 0) + round((time.monotonic() - started) * 1000)


def read_text(path):
    return materialize_io(path.read_text, path)


def dataless_files(data):
    parent = _SCOPE.get()
    stats = parent['stats'] if parent else None
    # A diagnostic census must neither spend the check's budget nor latch its
    # failed-save guard. Nested scopes share counters but isolate that guard.
    end = min(time.time() + 0.1, parent['deadline']) if parent else time.time() + 0.1
    try:
        with scope(end, stats), _within(end, DataUnavailable(data, 'deadline')):
            count = _dataless_files(data)
    except (OSError, DataUnavailable) as exc:
        if stats is not None:
            stats['dataless_files'] = None
            stats['dataless_error'] = f'{type(exc).__name__} errno={getattr(exc, "errno", None)}'
        return None
    if stats is not None:
        stats['dataless_files'] = count
    return count


def _dataless_files(data):
    # Metadata only: scandir doesn't stat entries, and each entry gets exactly one stat.
    count = 0
    try:
        entries = materialize_io(lambda: list(os.scandir(data)), data)
    except FileNotFoundError:
        return 0
    for entry in entries:
        try:
            info = materialize_io(lambda: os.stat(entry.path, follow_symlinks=False), entry.path)
        except FileNotFoundError:
            # Atomic writers can rename their temporary entries after scandir.
            continue
        if not stat.S_ISDIR(info.st_mode):
            count += bool(getattr(info, 'st_flags', 0) & SF_DATALESS)
        else:
            count += _dataless_files(Path(entry.path))
    return count


@contextmanager
def _within(deadline, error):
    # Check/refresh processes own their main-thread alarm. Library cache readers
    # may run on worker threads; they must never install or change that alarm.
    if threading.current_thread() is not threading.main_thread():
        yield
        if time.time() >= deadline:
            raise error
        return
    previous = signal.getitimer(signal.ITIMER_REAL)
    handler = signal.getsignal(signal.SIGALRM)
    started = time.monotonic()

    def expired(*_):
        raise error
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.000001, deadline - time.time()))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0]:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, previous[0] - (time.monotonic() - started)), previous[1])
