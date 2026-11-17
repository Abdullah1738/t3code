"""Shared writer for requested authentication evidence; never stores a code."""
from email.utils import parseaddr
import contextlib
import errno
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time


# Load by path: commerce callers have their own, incompatible bare `toollog` module.
_helpers = Path(__file__).resolve().parents[2] / 'helpers'
if not (_helpers / 'toollog.py').is_file():
    _helpers = Path.home() / '.local/share/robob-watch/helpers'
if (_helpers / 'toollog.py').is_file():
    _spec = importlib.util.spec_from_file_location('inbox_data_toollog', _helpers / 'toollog.py')
    _log = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_log)
    tool_log = _log.tool_log
else:
    def tool_log(*_args, **_kwargs):
        pass


RETRY_DELAYS = (0.25, 0.5, 1.0)
TRANSIENT_ERRNOS = {errno.EDEADLK: 'EDEADLK', errno.EAGAIN: 'EAGAIN',
                    errno.ETIMEDOUT: 'ETIMEDOUT', errno.EINTR: 'EINTR'}
RETRY_BUDGET_SECONDS = 6.0
_budget_lock = threading.Lock()
_budget_used = 0.0
_active_waits = {}


def reset_retry_budget():
    global _budget_used
    with _budget_lock:
        _budget_used = 0.0
        _active_waits.clear()


def charge_wait(seconds):
    global _budget_used
    with _budget_lock:
        _budget_used += max(0, seconds)


@contextlib.contextmanager
def account_wait():
    global _budget_used
    token = object()
    with _budget_lock:
        _active_waits[token] = time.monotonic()
    try:
        yield
    finally:
        with _budget_lock:
            _budget_used += max(0, time.monotonic() - _active_waits.pop(token))


def wait_used():
    # Caller holds _budget_lock. Still-blocked collector reads count before retry admission.
    now = time.monotonic()
    return _budget_used + sum(max(0, now - started) for started in _active_waits.values())


def backoff(seconds):
    global _budget_used
    with _budget_lock:
        if wait_used() + seconds >= RETRY_BUDGET_SECONDS:
            return False
        _budget_used += seconds
    started = time.monotonic()
    time.sleep(seconds)
    charge_wait(time.monotonic() - started - seconds)
    with _budget_lock:
        return wait_used() < RETRY_BUDGET_SECONDS


def is_dataless(path):
    try:
        return bool(getattr(os.stat(path), 'st_flags', 0) & 0x40000000)
    except OSError:
        return False


def errno_name(number):
    # Linux's reverse map chooses EDEADLOCK; use the same names in logs on both hosts.
    return TRANSIENT_ERRNOS.get(number, errno.errorcode.get(number, 'UNKNOWN'))


def retry_file(path, action, *, event='data_read', failure_event=None):
    started, dataless, last_errno = time.monotonic(), False, None
    for attempt in range(1, len(RETRY_DELAYS) + 2):
        error = None
        with account_wait():
            try:
                result = action()
            except OSError as failure:
                # Optional files keep their callers' existing defaults.
                if isinstance(failure, FileNotFoundError) and event == 'data_read':
                    raise
                error = failure
                dataless = is_dataless(path) or dataless
        if error is not None:
            last_errno = error.errno
            # The kernel call itself cannot be interrupted here; only further retries are bounded.
            if (last_errno in TRANSIENT_ERRNOS and attempt <= len(RETRY_DELAYS)
                    and backoff(RETRY_DELAYS[attempt - 1])):
                continue
            name = errno_name(last_errno)
            file_event(failure_event or event + '.failed', path, name, attempt, started, dataless, False)
            raise OSError(last_errno, f'{path}: {name} attempts={attempt} dataless={str(dataless).lower()}') from error
        if attempt > 1:
            file_event(event + '.retried', path, errno_name(last_errno),
                       attempt, started, dataless, True)
        return result


def file_event(name, path, code, attempts, started, dataless, ok):
    tool_log({'component': 'triage', 'kind': 'event' if ok else 'error', 'name': name, 'ok': ok,
              'ids': {'watcher': os.environ.get('WATCH_ID') or
                      ('inbox-triage-fastpath' if Path(os.environ.get('WATCH_DIR', '')).name == 'inbox-triage-fastpath'
                       else 'inbox-triage'), 'run': os.environ.get('WATCH_RUN', '')},
              'props': {'path': str(Path(path).absolute()), 'errnoCode': code, 'attempts': attempts,
                        'ms': round((time.monotonic() - started) * 1000), 'dataless': dataless}})


def read_bytes(path):
    return retry_file(path, path.read_bytes)


def record(senders, account=None, *, data=None):
    data = Path(data) if data is not None else Path.home() / 'Documents/assistant/inbox-triage'
    retry_file(data, lambda: data.mkdir(parents=True, exist_ok=True, mode=0o700), event='data_write')
    lock_path = data / 'inflight-actions.lock'
    with retry_file(lock_path, lambda: lock_path.open('a'), event='data_write') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = data / 'inflight-actions.json'
        now = time.time()
        try:
            actions = json.loads(read_bytes(path))
        except FileNotFoundError:
            actions = []
        actions = [a for a in actions if 0 <= now - a['at'] < 600]
        for sender in senders:
            sender = str(sender).strip()
            sender = (parseaddr(sender)[1] if '@' in sender else sender).casefold()
            actions.append({'sender': sender, 'account': account, 'at': now})
        def write():
            fd, name = tempfile.mkstemp(prefix='.inflight-', dir=data)
            try:
                with os.fdopen(fd, 'w') as stream:
                    json.dump(actions, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(name, path)
            finally:
                if os.path.exists(name):
                    os.unlink(name)
        retry_file(path, write, event='data_write')
