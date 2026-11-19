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


def refresh_stats(data):
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


def take_lock(data):
    path = Path(data) / 'owner-refresh.lock'
    data_io.materialize_io(lambda: path.parent.mkdir(parents=True, exist_ok=True), path.parent)
    fd = data_io.materialize_io(lambda: os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), path)
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
    os.ftruncate(fd, 0)
    os.write(fd, json.dumps({'pid': pid, 'started_at': time.time()}).encode())


def launch(data, since):
    if os.environ.get('MONEY_CASES_REFRESH_DISABLED') == '1':
        return 'skipped'
    try:
        fd = take_lock(data)
    except BlockingIOError:
        return 'busy'
    try:
        # Pass the held lock into the child: simultaneous checks cannot spawn
        # duplicate refreshes during the gap before Python starts.
        proc = subprocess.Popen([sys.executable, '-I', '-B', str(Path(__file__).resolve()),
                                 '--data', str(data), '--since', since.isoformat(), '--lock-fd', str(fd)],
                                pass_fds=(fd,), start_new_session=True, close_fds=True,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        mark_lock(fd, proc.pid)
        return 'started'
    finally:
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
            try:
                rows = charges.live_owner_texts(since, until, stats=stats,
                    cache_path=data / 'owner-texts.json', budget=max(.001, end - time.time() - 1),
                    request_timeout=REQUEST_TIMEOUT, thread_state=state, list_since=list_since,
                    thread_capture=threads)
                # Publication is one atomic replace, only after every selected
                # thread and both list filters completed with provenance checked.
                write_json(data / 'owner-snapshot.json', {'version': VERSION, 'since': since.isoformat(),
                           'as_of': until.isoformat(), 'threads': threads, 'rows': rows})
                result = 'ok'
            except charges.Lookup:
                result = stats.get('owner_result', 'error')
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
                    'owner_refresh_at': round(time.time()), 'owner_refresh_result': result,
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
