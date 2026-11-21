"""Complete owner evidence snapshots, refreshed outside the check's deadline."""
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import charges
import data_io
from state_json import write_json

MAX_AGE = 30 * 60
REFRESH_BUDGET = 90
REQUEST_TIMEOUT = 45
VERSION = 1


def snapshot(data, cache_reset=None):
    try:
        obj = json.loads(data_io.read_text(Path(data) / 'owner-snapshot.json'))
        if type(obj.get('version')) is not int or obj['version'] != VERSION:
            raise ValueError()
        since, asof = charges.owner_time(obj['since']), charges.owner_time(obj['as_of'])
        if since > asof or not isinstance(obj['threads'], dict) or not isinstance(obj['rows'], list):
            raise ValueError()
        for tid, thread in obj['threads'].items():
            if not isinstance(tid, str) or thread['threadId'] != tid or not isinstance(thread['title'], str):
                raise ValueError()
            charges.owner_time(thread['updatedAt'])
        for row in obj['rows']:
            if not isinstance(row, list) or len(row) != 3 or not all(isinstance(v, str) for v in row):
                raise ValueError()
            if not since <= charges.owner_time(row[0]) <= asof:
                raise ValueError()
        return obj
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        if cache_reset is not None:
            cache_reset()
        return None


def _completed_stats(data):
    try:
        obj = json.loads(data_io.read_text(Path(data) / 'owner-refresh.json'))
        result = {key: obj[key] for key in ('owner_refresh_ms', 'owner_refresh_at',
                                          'owner_refresh_timeouts', 'owner_list_window_s')
                  if type(obj.get(key)) in (int, float) and math.isfinite(obj[key]) and obj[key] >= 0}
        if obj.get('owner_refresh_result') in ('ok', 'incomplete', 'list_failed', 'error', 'not_read'):
            result['owner_refresh_result'] = obj['owner_refresh_result']
        return result
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def diagnostic_deadline(budget):
    parent = data_io.current_scope()
    end = time.time() + budget
    return min(end, parent['deadline']) if parent is not None else end


def refresh_stats(data, *, lock_fd=None):
    end = diagnostic_deadline(.1)
    try:
        with data_io.scope(end), charges.within(end, charges.Lookup('out of time')):
            return _refresh_stats(data, lock_fd)
    except (charges.Lookup, data_io.DataUnavailable):
        if lock_fd is not None:
            # A launcher must not replace a journal it could not inspect.
            raise
        return {}


def _refresh_stats(data, lock_fd):
    fd = lock_fd
    try:
        if fd is None:
            fd = take_lock(data, create=False)
        result = _completed_stats(data)
        # The inherited flock outlives the launcher. An idle lock with a newer
        # attempt and no completion also covers import errors, os._exit and signals.
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, 4096)
        if not raw:
            return result  # A newly created lock has no attempt yet.
        try:
            attempt = json.loads(raw)['started_at']
            if type(attempt) not in (int, float) or not math.isfinite(attempt):
                raise ValueError()
        except (ValueError, TypeError, KeyError):
            attempt = os.fstat(fd).st_mtime
        if attempt > result.get('owner_refresh_at', 0):
            return {'owner_refresh_at': attempt, 'owner_refresh_result': 'error',
                    'owner_refresh_ms': max(0, round((time.time() - attempt) * 1000)),
                    'owner_refresh_timeouts': 0}
        return result
    except OSError:
        if lock_fd is not None:
            raise
        return _completed_stats(data)
    except ValueError:
        return _completed_stats(data)
    finally:
        if fd is not None and lock_fd is None:
            os.close(fd)


def save_status(data, values):
    # Diagnostics get a small slice of the caller's remaining budget, including
    # a launch failure that must not turn into an unbounded cache write.
    end = diagnostic_deadline(.1)
    try:
        with data_io.scope(end), charges.within(end, charges.Lookup('out of time')):
            write_json(Path(data) / 'owner-refresh.json', values)
        return True
    except (charges.Lookup, OSError, data_io.DataUnavailable):
        return False


def cached_texts(since, until, deadline=None, stats=None, cache_path=None, cache_reset=None):
    data = Path(cache_path).parent if cache_path is not None else Path(os.environ.get(
        'MONEY_CASES_DIR', '~/Documents/assistant/money-cases')).expanduser()
    stop = min(time.time() + charges.OWNER_BUDGET, deadline) if deadline is not None else time.time() + charges.OWNER_BUDGET
    with charges.within(stop, charges.Lookup('Robob control: lookup over time')):
        obj = snapshot(data, cache_reset)
        if stats is not None:
            stats.update(refresh_stats(data), owner_source='cache', owner_result='cache_missing')
        if obj is None:
            raise charges.Lookup('Robob control: owner cache missing or incomplete')
        age = time.time() - charges.owner_time(obj['as_of']).timestamp()
        if stats is not None:
            stats['owner_cache_age_s'] = max(0, round(age))
            stats['owner_cache_size'] = len(obj['threads'])
        if age < 0 or age > MAX_AGE:
            if stats is not None:
                stats['owner_result'] = 'cache_stale'
            raise charges.Lookup('Robob control: owner read stale')
        if charges.owner_time(obj['since']) > since:
            raise charges.Lookup('Robob control: owner cache missing or incomplete')
        if stats is not None:
            stats['owner_result'] = 'ok'
        return [tuple(row) for row in obj['rows'] if since <= charges.owner_time(row[0]) <= until]


def take_lock(data, *, create=True):
    path = Path(data) / 'owner-refresh.lock'
    if create:
        data_io.materialize_io(lambda: path.parent.mkdir(parents=True, exist_ok=True), path.parent)
    flags = os.O_RDWR | os.O_CREAT if create else os.O_RDONLY
    fd = data_io.materialize_io(lambda: os.open(path, flags | os.O_NOFOLLOW, 0o600), path)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def mark_lock(fd, pid):
    # The pid and age are diagnostic; flock is authoritative even if a PID is
    # reused. A crash releases the kernel lock without unlink/reclaim races.
    os.lseek(fd, 0, os.SEEK_SET)
    payload = json.dumps({'pid': pid, 'started_at': time.time()}).encode()
    written = os.write(fd, payload)
    if written != len(payload):
        raise OSError('incomplete refresh journal write')
    # Write before trimming: interruption cannot erase the previous journal and
    # leave an empty inode indistinguishable from the first launch.
    os.ftruncate(fd, written)


def launch(data, since, *, stats=None):
    if os.environ.get('MONEY_CASES_REFRESH_DISABLED') == '1':
        return 'skipped'
    started = time.time()
    end = diagnostic_deadline(.5)
    fd = None
    try:
        with data_io.scope(end), charges.within(end, charges.Lookup('out of time')):
            try:
                fd = take_lock(data)
            except BlockingIOError:
                if stats is not None:
                    stats.update(refresh_stats(data))
                return 'busy'
            previous = refresh_stats(data, lock_fd=fd)
            if stats is not None:
                stats.update(previous)
            if previous.get('owner_refresh_result') == 'error':
                # Retain an early child's failure while the next attempt runs.
                if not save_status(data, previous):
                    return 'error'
            mark_lock(fd, os.getpid())
            # Before spawning, journal the attempt under the inherited lock.
            # The child records its own PID on entry; no parent write races it.
            subprocess.Popen([sys.executable, '-I', '-B', str(Path(__file__).resolve()),
                             '--data', str(data), '--since', since.isoformat(), '--lock-fd', str(fd)],
                             pass_fds=(fd,), start_new_session=True, close_fds=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return 'started'
    except (charges.Lookup, OSError, data_io.DataUnavailable):
        failure = {'owner_refresh_result': 'error', 'owner_refresh_at': time.time(),
                   'owner_refresh_ms': max(0, round((time.time() - started) * 1000)),
                   'owner_refresh_timeouts': 0}
        save_status(data, failure)
        if stats is not None:
            stats.update(failure)
        return 'error'
    finally:
        if fd is not None:
            os.close(fd)


def refresh(data, since, *, budget=REFRESH_BUDGET, lock_fd=None):
    data = Path(data)
    try:
        fd = take_lock(data) if lock_fd is None else lock_fd
    except BlockingIOError:
        return 'busy'
    started = time.monotonic()
    stats = {}
    result = 'error'
    end = time.time() + min(budget, REFRESH_BUDGET)
    try:
        os.set_inheritable(fd, False)
        mark_lock(fd, os.getpid())
        with data_io.scope(end), charges.within(end, charges.Lookup('Robob control: lookup over time')):
            until = dt.datetime.now(dt.timezone.utc)
            prior = snapshot(data)
            state, list_since = None, None
            if prior is not None:
                asof = charges.owner_time(prior['as_of'])
                if since <= asof <= until and charges.owner_time(prior['since']) <= since:
                    state = prior['threads']
                    list_since = asof - dt.timedelta(minutes=2)
            threads = {}
            rows = charges.live_owner_texts(since, until, stats=stats,
                cache_path=data / 'owner-texts.json', budget=max(.001, end - time.time() - 1),
                request_timeout=REQUEST_TIMEOUT, thread_state=state, list_since=list_since,
                thread_capture=threads)
            # Publication must succeed too; a completed API read alone is not a
            # successful refresh when atomic replacement times out or fails.
            write_json(data / 'owner-snapshot.json', {'version': VERSION, 'since': since.isoformat(),
                       'as_of': until.isoformat(), 'threads': threads, 'rows': rows})
            result = 'ok'
    except (charges.Lookup, OSError, ValueError, data_io.DataUnavailable):
        result = stats.get('owner_result', 'error')
        if result == 'ok':
            result = 'error'
    finally:
        try:
            # A failed refresh never touches the last complete snapshot or its age.
            with charges.within(time.time() + max(.001, end - time.time()), charges.Lookup('out of time')):
                write_json(data / 'owner-refresh.json', {
                    'owner_refresh_ms': round((time.monotonic() - started) * 1000),
                    'owner_refresh_at': time.time(), 'owner_refresh_result': result,
                    'owner_refresh_timeouts': stats.get('owner_timeouts', 0),
                    'owner_list_window_s': round(stats.get('owner_list_window_s', 0)),
                    'owner_source': stats.get('owner_source', 'live')})
        except (charges.Lookup, OSError, data_io.DataUnavailable):
            pass
        os.close(fd)
    return result


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--since', required=True)
    parser.add_argument('--lock-fd', type=int)
    args = parser.parse_args()
    return 0 if refresh(args.data, charges.owner_time(args.since), lock_fd=args.lock_fd) in ('ok', 'busy') else 1


if __name__ == '__main__':
    os.umask(0o077)
    raise SystemExit(main())
