#!/usr/bin/python3
"""Shell adapters. All instrumentation, including measurement, fails open."""
import json
import datetime as dt
from contextlib import contextmanager
import errno
import fcntl
import math
import os
import plistlib
import re
import signal
import shlex
from pathlib import Path
import sys
import subprocess
import tempfile
import time
from toollog import emit, directory, private_dir, SKIP_REASONS, BACKUP_PROGRAMS, BACKUP_ARGS, BACKUP_STAGES


def state_path(name):
    root = directory() / 'state'
    private_dir(root)
    return root / (name + '.json')


def read_state(name, with_reason=False):
    reason = None
    try:
        value = json.loads(state_path(name).read_text())
        if not isinstance(value, dict):
            value, reason = {}, 'corrupt_state'
    except FileNotFoundError:
        value, reason = {}, 'missing_state'
    except (ValueError, UnicodeError):
        value, reason = {}, 'corrupt_state'
    except Exception:
        value, reason = {}, 'unreadable_state'
    return (value, reason) if with_reason else value


def save_state(name, value):
    path = state_path(name)
    fd, tmp = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


DIRECTORY_ROOTS = [Path.home() / '.local/share', Path.home() / '.robob',
                   Path.home() / 'Library/Caches', Path.home() / '.cache',
                   *[Path('/Volumes/ExternalSSD') / name for name in
                     ('wt', 't3code-wt', 'board-wt', 'coord-wt', 'caches', 'crpko-devops/tmp', 'memory-system-backup', 'memory-system-data', 'memory-system-data-v2')]]
BIG_ROOTS = set(DIRECTORY_ROOTS)


class SourceFailure(Exception):
    def __init__(self, failure, message, exit_code=None):
        super().__init__(message)
        self.failure = failure
        self.message = message
        self.exit_code = exit_code


def deadline_call(deadline, operation, *args, **kwargs):
    if deadline is None:
        return operation(*args, **kwargs)
    started = time.monotonic()
    remaining = deadline-started
    if remaining <= 0:
        raise SourceFailure('timeout', 'collector budget exhausted')

    def expired(signum, frame):
        raise SourceFailure('timeout', 'collector I/O budget exhausted')

    # This is a single-threaded macOS LaunchAgent. Alarm only the I/O call,
    # never the counter/checkpoint updates that follow a completed report.
    handler = signal.signal(signal.SIGALRM, expired)
    previous = signal.setitimer(signal.ITIMER_REAL, remaining)
    try:
        result = operation(*args, **kwargs)
        if time.monotonic() > deadline:
            raise SourceFailure('timeout', 'collector I/O budget exhausted')
        return result
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, handler)
        if previous[0]:
            signal.setitimer(signal.ITIMER_REAL,
                             max(0.000001, previous[0]-(time.monotonic()-started)), previous[1])


def stderr_line(value):
    if isinstance(value, bytes):
        value = value.decode(errors='replace')
    lines = (value or '').strip().splitlines()
    return lines[0][:300] if lines else ''


def permission_denied(value):
    return bool(re.search(r'operation not permitted|permission denied', value, re.I))


def source_error(component, name, source, started, exc, props=None):
    failure, code, message = 'exit', None, 'source read failed (%s)' % type(exc).__name__
    if isinstance(exc, SourceFailure):
        failure, code, message = exc.failure, exc.exit_code, exc.message
    elif isinstance(exc, subprocess.TimeoutExpired):
        failure, message = 'timeout', stderr_line(exc.stderr) or 'source command timed out'
    elif isinstance(exc, OSError):
        failure = 'permission' if exc.errno in (errno.EACCES, errno.EPERM) else 'exit'
        message = str(exc)
    emit(component, 'error', name, ok=False,
         props=dict(source=str(source), failure=failure, exitCode=code,
                    elapsedMs=max(0, (time.monotonic()-started)*1000), **(props or {})),
         error_tag=component+'.source_unavailable', error_message=message)
    return failure


def confirmed_absent(path, exc):
    if exc.filename is None or str(exc.filename) != str(path):
        return False
    try:
        resolved = Path(path).resolve()
        # A missing backing mount is unavailable storage, not evidence that a
        # tracked file/root was deleted. Resolve also covers home-dir symlinks.
        if resolved.is_relative_to('/Volumes') and len(resolved.parts) >= 3:
            return Path('/Volumes', resolved.parts[2]).is_mount()
        return True
    except (OSError, RuntimeError):
        return False


def du_total(path, run, timeout):
    # Child entries are cached/refreshed independently. Count every hardlink
    # consistently in both single and batched scans; cross-argument inode
    # deduplication would assign bytes to a different child on each scan.
    # These logical link-occurrence sums can exceed physical use (pnpm stores,
    # git clone --local) and are an upper bound, not freeable space.
    if timeout <= 0:
        raise SourceFailure('timeout', 'directory inventory overall budget exhausted')
    result = run(['/usr/bin/du', '-skl', str(path)], capture_output=True, text=True,
                 timeout=timeout, env={**os.environ, 'LC_ALL': 'C'})
    stderr = getattr(result, 'stderr', '') or ''
    denied = sum(permission_denied(line) for line in stderr.splitlines())
    other_errors = any(line.strip() and not permission_denied(line) for line in stderr.splitlines())
    message = stderr_line(stderr)
    if other_errors or result.returncode and (result.returncode != 1 or not denied):
        failure = 'permission' if not result.stdout.strip() and denied else 'exit'
        raise SourceFailure(failure, message or 'du exited without a total', result.returncode)
    # Match the requested root, not an arbitrary number printed by du.
    for line in result.stdout.splitlines():
        fields = line.split('\t', 1)
        if len(fields) == 2 and fields[1] == str(path):
            if not fields[0].isdigit():
                raise SourceFailure('parse', message or 'invalid du total', result.returncode)
            return int(fields[0])*1024, denied, result.returncode
    failure = 'permission' if denied else 'missing-total' if not result.stdout.strip() or '\t' in result.stdout else 'parse'
    raise SourceFailure(failure, message or 'du did not print a root total', result.returncode)


def inventory_listing(path, deadline, source_failures=None):
    entries, listed = [], False
    started = time.monotonic()
    try:
        with deadline_call(deadline, os.scandir, path) as listing:
            deadline_call(deadline, entries.extend, listing)
        listed = True
    except (OSError, SourceFailure) as exc:
        failure = source_error('disk', 'disk.inventory.source', path, started, exc)
        if source_failures is not None:
            source_failures.add(failure)
    return entries, listed


INVENTORY_FRESH_S = 24*3600


@contextmanager
def inventory_lock():
    # Never unlink a flock file: another process may already have it open.
    path = state_path('disk-inventory').with_suffix('.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        else:
            yield fd
    finally:
        os.close(fd)


def inventory_needs_measurement(value, now):
    return (not isinstance(value, dict) or not number(value.get('bytes'))
            or not number(value.get('at')) or value['at'] > now
            or now-value['at'] >= INVENTORY_FRESH_S
            or value.get('partial') is not False or bool(value.get('limited')))


def inventory_refresh_entries(entries, cache, now):
    eligible = []
    for entry in entries:
        value = cache.get(entry.path, {})
        if (isinstance(value, dict) and number(value.get('bytes')) and number(value.get('at'))
                and now-value['at'] >= INVENTORY_FRESH_S
                and not value.get('limited')):
            eligible.append(entry)
    return sorted(eligible, key=lambda entry: (
        bool(cache[entry.path].get('slow')), cache[entry.path]['at'], entry.path))


def inventory_clean_cache(cache, now):
    for key, value in list(cache.items()):
        if not isinstance(value, dict):
            cache.pop(key)
            continue
        attempted = value.get('attemptedAt', 0)
        value['attemptedAt'] = attempted if number(attempted) and attempted <= now else 0
        if not number(value.get('bytes')) or not number(value.get('at')) or value['at'] > now:
            cache[key] = {k: value[k] for k in ('attemptedAt', 'slow', 'limited', 'partial') if k in value}


def inventory_child_state(previous, roots):
    # Pre-links entries deduplicated across batch arguments. Never mix those
    # totals with independent per-child link-occurrence measurements.
    old = previous.get('childState', {})
    old = old if isinstance(old, dict) else {}
    migrated = previous.get('duMode') != 'links' and bool(previous.get('sizes') or any(old.values()))
    return {str(path): (old[str(path)] if not migrated and isinstance(old.get(str(path)), dict) else {})
            for path in roots}, migrated


def inventory_status(cache, entries, listed, now, completed=0, failures=0):
    children = {key: value['bytes'] for key, value in cache.items() if number(value.get('bytes'))}
    cached = [value for value in cache.values() if 'bytes' in value and value['at'] < now]
    missing = len({entry.path for entry in entries}-set(children))
    denied = sum(value['deniedCount'] if number(value.get('deniedCount'))
                 else int(value.get('partial') is not False) for value in cache.values())
    return sum(children.values()), dict(partial=bool(not listed or failures or missing or denied
                     or any(v.get('partial') is not False or v.get('limited') for v in cache.values())
                     or any(now-v['at'] >= INVENTORY_FRESH_S for v in cached)),
        failedCount=failures+int(bool(missing) and not failures), completedCount=completed,
        deniedCount=denied, cachedCount=len(cached), unmeasuredCount=missing,
        limitedCount=sum(bool(v.get('limited')) for v in cache.values()),
        ageS=max((now-value['at'] for value in cached), default=0)), children


def big_root_inventory(path, run, deadline, cache=None, listing=None, pending_only=False, refresh_only=False,
                       deep=False, checkpoint=None, attempted=None, max_batches=None, single_paths=None,
                       source_failures=None):
    cache = {} if cache is None else cache
    single_paths = set() if single_paths is None else single_paths
    now = time.time()
    # Shared with the separate deep pass: each immediate-child key has bytes,
    # at, attemptedAt and partial. Optional isDirectory/deniedCount preserve
    # directory attribution and permission diagnostics;
    # slow/limited record only this hourly scanner's 15/60 s timeout policy.
    inventory_clean_cache(cache, now)
    entries, listed = (inventory_listing(path, deadline) if source_failures is None else
                       inventory_listing(path, deadline, source_failures)) if listing is None else listing
    present = {entry.path for entry in entries}
    if listed:
        for key in set(cache)-present:
            cache.pop(key)
    completed, failures = 0, int(not listed)
    kinds = {}
    def kind(entry):
        if entry.path not in kinds:
            try:
                kinds[entry.path] = deadline_call(deadline, entry.is_dir, follow_symlinks=False)
            except (OSError, SourceFailure):
                kinds[entry.path] = None
        return kinds[entry.path]

    def priority(entry):
        old = cache.get(entry.path, {})
        return ('bytes' in old, old.get('attemptedAt', 0), kind(entry) is True, entry.path)
    entries = sorted(entries, key=priority)
    pending = [e for e in entries if 'bytes' not in cache.get(e.path, {})]
    refresh = inventory_refresh_entries(entries, cache, now)
    selected = refresh if refresh_only else pending if pending_only else pending+refresh
    if deep:
        selected = sorted((e for e in entries if inventory_needs_measurement(cache.get(e.path), now)
                           and (attempted is None or e.path not in attempted)),
                          key=lambda e: (cache.get(e.path, {}).get('at', 0),
                                         cache.get(e.path, {}).get('attemptedAt', 0), e.path))
    else:
        selected = [entry for entry in selected if not cache.get(entry.path, {}).get('limited')]
    batches = 0
    while selected and time.monotonic() < deadline:
        first = selected[0]
        old = cache.get(first.path, {})
        allowance = 600 if deep else 60 if old.get('slow') else 15
        timeout = min(allowance, deadline-time.monotonic())
        # Limited children were excluded from the entire selection, including
        # later batch positions, until a measured replacement clears the hint.
        # Many-child roots use the same per-link accounting as du_total,
        # with bounded argv, rotating the first unfinished
        # child after a timeout instead of rescanning du -d 1's fixed prefix.
        batch, argv_bytes = [], 0
        for entry in selected[:128] if len(entries) >= 128 and not old.get('slow') and not old.get('limited') and first.path not in single_paths else selected[:1]:
            if deep and batch and (entry.path in single_paths or cache.get(entry.path, {}).get('slow') or cache.get(entry.path, {}).get('limited')):
                break
            length = len(os.fsencode(entry.path))+1
            if batch and argv_bytes+length > 32768:
                break
            batch.append(entry)
            argv_bytes += length
        selected = selected[len(batch):]
        paths = {entry.path: entry for entry in batch}
        started = time.monotonic()
        done = set()
        uncertain = rejected = False
        try:
            if len(batch) == 1:
                size, denied, code = du_total(Path(first.path), run, timeout)
                values = [(first.path, size)]
            else:
                command = ['/usr/bin/du', '-skl', *paths]
                try:
                    result = run(command, capture_output=True, text=True, timeout=timeout,
                                 env={**os.environ, 'LC_ALL': 'C'})
                    output, stderr, code = result.stdout, result.stderr, result.returncode
                except subprocess.TimeoutExpired as exc:
                    output, stderr, code = exc.stdout or '', exc.stderr or '', None
                if isinstance(output, bytes):
                    output = output.decode('utf-8', errors='replace')
                if isinstance(stderr, bytes):
                    stderr = stderr.decode('utf-8', errors='replace')
                uncertain = bool((stderr or '').strip())
                denied = sum(permission_denied(line) for line in (stderr or '').splitlines())
                other_errors = any(line.strip() and not permission_denied(line)
                                   for line in (stderr or '').splitlines())
                # Hourly keeps #26's bounded whole-batch rejection on failure;
                # only the deep pass has the budget to isolate bad children.
                if code is not None and (deep and other_errors or code != 0 and (code != 1 or not denied or other_errors)):
                    raise SourceFailure('exit', stderr_line(stderr) or 'du exited unsuccessfully', code)
                values = []
                for line in output.splitlines(keepends=True):
                    fields = line.rstrip('\n').split('\t', 1)
                    # A killed process may leave an unfinished final row.
                    if line.endswith('\n') and len(fields) == 2 and fields[0].isdigit() and fields[1] in paths:
                        values.append((fields[1], int(fields[0])*1024))
            for key, size in values:
                if key in done:
                    continue
                entry = paths[key]
                partial = bool(denied or uncertain or kind(entry) is None)
                hints = {k: cache[key][k] for k in ('slow', 'limited') if partial and k in cache.get(key, {})}
                cache[key] = dict(bytes=size, at=time.time(), attemptedAt=time.time(), partial=partial,
                                  deniedCount=denied if key == values[0][0] else 0, isDirectory=kind(entry), **hints)
                done.add(key)
                completed += 1
                emit('disk', 'event', 'disk.inventory.source', ok=True,
                     props=dict(source=key, bytes=size, partial=partial, deniedCount=denied,
                                exitCode=code, elapsedMs=(time.monotonic()-started)*1000))
            if len(done) != len(batch):
                raise SourceFailure('timeout' if code is None else 'missing-total',
                                    'source command timed out' if code is None else 'du did not print a child total', code)
        except Exception as exc:
            failures += 1
            rejected = bool(deep and len(batch) > 1 and isinstance(exc, SourceFailure) and exc.failure == 'exit')
            if rejected:
                # Unattributable diagnostics must not hide healthy peers day
                # after day. Retry each member singly within the same budget.
                single_paths.update(paths)
            unfinished = next((e for e in batch if e.path not in done), first)
            value = cache.setdefault(unfinished.path, {})
            # Only a full allowance establishes slow/limited. A truncated
            # attempt still rotates, but gets its full allowance next time.
            value['attemptedAt'] = now
            value['partial'] = True
            if isinstance(exc, subprocess.TimeoutExpired) or isinstance(exc, SourceFailure) and exc.failure == 'timeout':
                if not deep and timeout+0.000001 >= allowance:
                    value['slow'] = True
                    if allowance == 60:
                        value['limited'] = True
            failure = source_error('disk', 'disk.inventory.source', unfinished.path, started, exc)
            if source_failures is not None:
                source_failures.add(failure)
        finally:
            if attempted is not None:
                attempted.update(done)
                unfinished = next((e for e in batch if e.path not in done), None)
                if unfinished is not None and not rejected:
                    attempted.add(unfinished.path)
            if checkpoint:
                checkpoint(*inventory_status(cache, entries, listed, time.time(), completed, failures))
        batches += 1
        if max_batches is not None and batches >= max_batches:
            break
        if deep and len(batch) > 1 and len(done) != len(batch):
            # Rows before the interrupted child are complete. Give the untouched
            # suffix a turn in this pass rather than dropping the whole batch.
            unfinished = [e for e in batch if e.path not in done]
            if unfinished:
                selected = (unfinished if rejected else unfinished[1:])+selected
    return inventory_status(cache, entries, listed, time.time(), completed, failures)


def directory_inventory(paths=None, run=subprocess.run, deadline=None):
    started = time.monotonic()
    with inventory_lock() as acquired:
        if acquired is not False:
            def locked_run(command, **kwargs):
                return run(command, pass_fds=(acquired,), **kwargs)
            return _directory_inventory(paths, locked_run, deadline)
        previous = read_state('disk-inventory')
        roots = list(DIRECTORY_ROOTS if paths is None else paths)
        sizes, partials = previous.get('sizes', {}), previous.get('partials', {})
        emit('disk', 'perf', 'disk.inventory', duration_ms=(time.monotonic()-started)*1000,
             props=dict(duMode=previous.get('duMode'), skipReason='deep_pass_running',
                        count=len(sizes), bytes=sum(sizes.values()),
                        rootsComplete=sum(str(p) in sizes and str(p) not in partials for p in roots),
                        rootsPartial=sum(str(p) not in sizes or str(p) in partials for p in roots)))


def _directory_inventory(paths=None, run=subprocess.run, deadline=None):
    started = time.monotonic()
    deadline = min(started+210, deadline) if deadline is not None else started+210
    previous = read_state('disk-inventory')
    attempts = previous.get('attemptedAt', {})
    attempts = dict(attempts) if isinstance(attempts, dict) else {}
    roots = list(DIRECTORY_ROOTS if paths is None else paths)
    source_failures = {str(path): set() for path in roots}
    child_state, migrated = inventory_child_state(previous, roots)
    old_sizes = previous.get('sizes', {})
    old_sizes = old_sizes if isinstance(old_sizes, dict) else {}
    sizes, partials, children, listings, flags = {}, {}, {}, {}, {}
    now = time.time()
    for path in roots:
        key = str(path)
        value = attempts.get(key, previous.get('at',0) if key in old_sizes else 0)
        attempts[key] = value if number(value) and value <= now else 0
        child_state[key] = child_state.get(key) if isinstance(child_state.get(key), dict) else {}
        try:
            # Listing/stat have their own shares too: a blocked mount must
            # leave time for healthy roots before any du work starts.
            source_deadline = min(deadline, time.monotonic()+2)
            deadline_call(source_deadline, path.stat)
            listings[key] = inventory_listing(path, source_deadline, source_failures[key])
        except FileNotFoundError as exc:
            if confirmed_absent(path, exc):
                sizes[key], children[key], listings[key], child_state[key] = 0, {}, ([], True), {}
            else:
                listings[key] = ([], False)
                source_failures[key].add(source_error('disk', 'disk.inventory.source', path, started, exc))
        except Exception as exc:
            listings[key] = ([], False)
            source_failures[key].add(source_error('disk', 'disk.inventory.source', path, started, exc))
    roots.sort(key=lambda p: (attempts[str(p)], len(listings[str(p)][0])))
    turn = 0
    def scan(path, stop, pending_only=False, refresh_only=False):
        nonlocal turn
        key = str(path)
        turn += 1
        emit('disk', 'event', 'disk.inventory.turn', props=dict(source=key, turn=turn))
        total, status, measured = big_root_inventory(path, run, stop, child_state[key], listings[key], pending_only, refresh_only,
                                                     source_failures=source_failures[key])
        flags[key], children[key] = status, measured
        if measured or not status['partial']:
            sizes[key] = total
        return status
    # Every root gets a short discovery share before slow roots can spend a
    # full turn. Files precede directories; small roots can finish immediately.
    for path in roots:
        share = min(2, max(0, (deadline-time.monotonic())/max(1,len(roots))))
        scan(path, min(deadline, time.monotonic()+share))
    # Reserve a quarter for refreshing old good children; missing children get
    # the rest. Neither a fresh prefix nor a huge root can monopolize discovery.
    fill_deadline = time.monotonic()+max(0,deadline-time.monotonic())*.75
    def fill(stop_at):
        for path in sorted(roots, key=lambda p:attempts[str(p)]):
            key = str(path)
            if any('bytes' not in child_state[key].get(e.path,{}) and not child_state[key].get(e.path,{}).get('limited')
                   for e in listings[key][0]):
                # Leave room for cached metadata/order setup so a selected slow
                # child can receive the full 60 s, still inside the shared cap.
                stop = min(stop_at,time.monotonic()+61)
                if time.monotonic() < stop:
                    available = stop-time.monotonic()
                    scan(path,stop,True)
                    if available+0.000001 >= 15:
                        attempts[key] = now
    fill(fill_deadline)
    refresh_roots = [(path, inventory_refresh_entries(listings[str(path)][0], child_state[str(path)], now))
                     for path in roots]
    refresh_roots = [(path, entries) for path, entries in refresh_roots if entries]
    refresh_roots.sort(key=lambda item: (
        bool(child_state[str(item[0])][item[1][0].path].get('slow')),
        child_state[str(item[0])][item[1][0].path]['at'], len(item[1])))
    for index, (path, entries) in enumerate(refresh_roots):
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            break
        allowance = 60 if child_state[str(path)][entries[0].path].get('slow') else 15
        # Leave a full command plus setup when it fits; a large warm root
        # cannot consume every peer's refresh share just because it is older.
        share = min(61, max(allowance+1, remaining/(len(refresh_roots)-index)))
        scan(path, min(deadline, time.monotonic()+share), refresh_only=True)
    # Return unused refresh capacity to discovery on cold or cheap roots.
    fill(deadline)
    errors = 0
    for path in roots:
        key = str(path)
        status = flags[key]
        if migrated:
            status['partial'] = True
        if status['partial']:
            partials[key] = status
        if status['failedCount'] or status['unmeasuredCount']:
            errors += 1
            source_error('disk','disk.inventory.source',path,started,
                         SourceFailure('partial','directory total is incomplete'),
                         dict(status, **({'bytes': sizes[key]} if key in sizes else {})))
        else:
            emit('disk','event','disk.inventory.source',ok=True,props=dict(source=key,bytes=sizes[key],**status))
    save_state('disk-inventory',dict(previous, at=time.time(),duMode='links',sizes=sizes,partials=partials,children=children,
        sourceErrors=errors,attemptedAt=attempts,childState=child_state))
    cached = [v for cache in child_state.values() for v in cache.values() if 'bytes' in v]
    scan_ms = (time.monotonic()-started)*1000
    denied_roots = {key for key, failures in source_failures.items() if 'permission' in failures}
    denied_roots.update(key for key, cache in child_state.items()
                        if any(number(v.get('deniedCount')) and v['deniedCount'] > 0 for v in cache.values()))
    emit('disk','error' if errors else 'perf','disk.inventory',ok=not errors,
         duration_ms=scan_ms,
         props=dict(duMode='links',count=len(sizes),sourceErrors=errors,rootsComplete=len(roots)-len(partials),
                    rootsOk=len(roots)-len(partials),rootsTimeout=sum('timeout' in v for v in source_failures.values()),
                    rootsDenied=len(denied_roots),scanMs=scan_ms,
                    rootsPartial=len(partials),childrenCached=len(cached),
                    oldestChildAgeS=max((max(0,now-v['at']) for v in cached),default=0)),
         error_tag='disk.inventory_failed' if errors else None)

def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def storage_value(output, snapshot=False):
    if snapshot:
        lines = output.decode('utf-8').splitlines()
        if not lines or not lines[0].startswith('Snapshots for '):
            raise ValueError('invalid snapshot list')
        snapshots = [line.strip() for line in lines[1:] if line.strip()]
        if any(not re.fullmatch(r'com\.apple\.TimeMachine\.\d{4}-\d{2}-\d{2}-\d{6}(?:\.local)?', line)
               for line in snapshots):
            raise ValueError('invalid snapshot list')
        return len(snapshots)
    info = plistlib.loads(output)
    for key in ('PurgeableSpace', 'PurgeableSize'):
        if key in info:
            if not number(info[key]):
                raise ValueError('invalid purgeable size')
            return round(info[key] / 1024**3, 3)
    return None


def storage_probes(volumes, sample_started, popen=subprocess.Popen):
    props, children = {}, []
    started = time.monotonic()
    slow = started-sample_started > 8
    try:
        # Children inherit this flock. Even an unkillable kernel wait keeps the
        # next guard from accumulating more probes, without PID-reuse hazards.
        with (state_path('disk').parent / 'disk-space-probes.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {'internalPurgeableError': 'busy', 'externalPurgeableError': 'busy'}
            if slow:
                return {}
            # Reserve time for kill/close; no communicate/wait may extend the cap.
            deadline = min(started + 4.8, sample_started + 8)
            for prefix, volume in zip(('internal', 'external'), volumes):
                for snapshot in (False, True):
                    field = prefix + ('LocalSnapshotCount' if snapshot else 'PurgeableGb')
                    error = prefix + ('SnapshotError' if snapshot else 'PurgeableError')
                    if time.monotonic() >= deadline:
                        props[error] = 'timeout'
                        slow = True
                        continue
                    command = (['/usr/bin/tmutil', 'listlocalsnapshots', '/' if prefix == 'internal' else str(volume)]
                               if snapshot else ['/usr/sbin/diskutil', 'info', '-plist', str(volume)])
                    output = tempfile.TemporaryFile()
                    try:
                        child = popen(command, stdout=output, stderr=subprocess.DEVNULL,
                                      start_new_session=True, pass_fds=(lock.fileno(),),
                                      env={**os.environ, 'LC_ALL': 'C'})
                    except OSError:
                        output.close()
                        props[error] = 'unavailable'
                        continue
                    children.append((child, output, field, error, snapshot))
            pending = list(children)
            while pending:
                for entry in list(pending):
                    child, output, field, error, snapshot = entry
                    code = child.poll()
                    if code is None:
                        continue
                    pending.remove(entry)
                    if code:
                        props[error] = 'exit'
                        continue
                    try:
                        output.seek(0)
                        value = storage_value(output.read(65537), snapshot)
                        if value is None:
                            props[error] = 'unsupported'
                        else:
                            props[field] = value
                    except Exception:
                        props[error] = 'parse'
                if not pending:
                    break
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    slow = True
                    for _, _, _, error, _ in pending:
                        props[error] = 'timeout'
                    break
                time.sleep(min(0.01, remaining))
    except Exception:
        # Optional instrumentation must never prevent free-space samples.
        pass
    finally:
        for child, output, _, _, _ in children:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except OSError:
                    pass
                child.poll()
            output.close()
        if time.monotonic()-sample_started > 8:
            slow = True
            props = {key: value for key, value in props.items() if key.endswith('Error')}
        if slow:
            emit('disk', 'event', 'disk.probe_slow', props={'elapsedMs': (time.monotonic()-started)*1000})
    return props


def sample_time(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        return None


def legacy_free_baseline(sampled_at):
    # The pre-delta schema saved only sizes. Bound this one-time migration to
    # two log tails; never replay the full log or recover corrupt state silently.
    free, stamps = {}, {}
    for day in (sampled_at.date(), sampled_at.date()-dt.timedelta(days=1)):
        try:
            with (directory()/(day.isoformat()+'.ndjson')).open('rb') as stream:
                stream.seek(0, os.SEEK_END)
                stream.seek(max(0, stream.tell()-1024*1024))
                lines = stream.read(1024*1024).splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            try:
                row = json.loads(line)
                at = sample_time(row.get('ts'))
                if row.get('name') != 'disk.sample' or at is None or at > sampled_at.timestamp():
                    continue
                values = row.get('props', {})
                for key in ('internalFreeGb', 'externalFreeGb'):
                    if key not in free and number(values.get(key)):
                        free[key], stamps[key] = values[key], row['ts']
            except (ValueError, TypeError, AttributeError, UnicodeError):
                continue
    return free, stamps


def drop_inventory(inventory, volume, now):
    at = inventory.get('at')
    fresh = number(at) and 0 <= now-at <= 7200
    sizes = inventory.get('sizes', {})
    sizes = sizes if isinstance(sizes, dict) else {}
    partials = inventory.get('partials', {})
    partials = partials if isinstance(partials, dict) else {}
    children = inventory.get('children', {})
    children = children if isinstance(children, dict) else {}
    child_state = inventory.get('childState', {})
    child_state = child_state if isinstance(child_state, dict) else {}
    candidates, parent_entries = {}, {}
    roots = [p for p in DIRECTORY_ROOTS
             if p.is_relative_to('/Volumes/ExternalSSD') == (volume == 'external')]
    complete = bool(fresh and roots and inventory.get('sourceErrors') == 0 and not partials)
    for root in roots:
        key = str(root)
        parent_complete = bool(fresh and number(sizes.get(key)) and key not in partials)
        if not parent_complete:
            complete = False
        if root not in BIG_ROOTS:
            if fresh and key not in partials and number(sizes.get(key)):
                candidates[key] = sizes[key]
            continue
        measured, states = children.get(key, {}), child_state.get(key, {})
        if (key not in children or key not in child_state
                or not isinstance(measured, dict) or not isinstance(states, dict)):
            complete = False
            continue
        for path, size in measured.items():
            state = states.get(path, {})
            valid = (fresh and isinstance(path, str) and Path(path).parent == root and number(size)
                     and isinstance(state, dict) and type(state.get('isDirectory')) is bool
                     and state.get('partial') is False and number(state.get('at'))
                     and 0 <= now-state['at'] <= 7200)
            if not valid:
                complete = parent_complete = False
            elif state['isDirectory']:
                candidates[path] = size
        if parent_complete:
            # Keep all entry names: a previous file at this path is not proof
            # of absence, even though files are excluded from directory growers.
            parent_entries[key] = list(measured)
    return dict(at=at if fresh else None, sizes=candidates, complete=complete,
                parentEntries=parent_entries, duMode=inventory.get('duMode'))


def disk_sample(watch_dir, temp_dir, volumes=('/System/Volumes/Data', '/Volumes/ExternalSSD'), paths=None):
    started = time.monotonic()
    sampled_at = dt.datetime.now(dt.timezone.utc)
    stamp = sampled_at.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    previous, state_reason = read_state('disk', with_reason=True)
    if previous and (not any(key in previous for key in ('sizes', 'free'))
                     or any(key in previous and not isinstance(previous[key], dict)
                            for key in ('sizes', 'free', 'freeTs', 'freeInventory'))):
        previous, state_reason = {}, 'corrupt_state'
    old_free = previous.get('free', {})
    old_free = dict(old_free) if isinstance(old_free, dict) else {}
    free_ts = previous.get('freeTs', {})
    free_ts = dict(free_ts) if isinstance(free_ts, dict) else {}
    if isinstance(previous.get('sizes'), dict) and ('free' not in previous or 'freeTs' not in previous):
        if any(key not in old_free for key in ('internalFreeGb', 'externalFreeGb')):
            recovered, stamps = legacy_free_baseline(sampled_at)
            for key, value in recovered.items():
                if key not in old_free:
                    old_free[key], free_ts[key] = value, stamps[key]
    free_inventory = previous.get('freeInventory', {})
    free_inventory = dict(free_inventory) if isinstance(free_inventory, dict) else {}
    props, errors = {}, 0
    for prefix, volume in zip(('internal', 'external'), volumes):
        key = prefix+'FreeGb'
        try:
            st = os.statvfs(volume)
            props[key] = round(st.f_bavail * st.f_frsize / 1024**3, 3)
        except OSError:
            errors += 1
        old_value = old_free.get(key)
        from_ts = free_ts.get(key, previous.get('ts'))
        if number(old_value) and key not in free_ts:
            free_ts[key] = from_ts
        at = sample_time(from_ts)
        if at is not None:
            try:
                from_ts = dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            except (ValueError, OverflowError, OSError):
                at = None
        reason = state_reason or ('no_previous_numeric' if not number(old_value) else
                                 'invalid_timestamp' if at is None or at > sampled_at.timestamp() else
                                 'current_unavailable' if key not in props else None)
        props[key+'Delta'] = round(props[key]-old_value, 3) if reason is None else None
        props[prefix+'DeltaFromTs'] = from_ts if reason is None else None
        props[prefix+'DeltaWindowS'] = round(sampled_at.timestamp()-at, 3) if reason is None else None
        if reason:
            props[prefix+'DeltaUnavailable'] = reason
            props.setdefault('deltaUnavailable', reason)
        if prefix == 'internal' or props['deltaFromTs'] is None:
            props['deltaFromTs'] = props[prefix+'DeltaFromTs']
            props['deltaWindowS'] = props[prefix+'DeltaWindowS']
    home = Path.home()
    # stat only: never open live databases, traverse private content or run du in the guard.
    paths = paths if paths is not None else [
        home / '.robob/userdata/statev2.sqlite', home / '.robob/userdata/statev2.sqlite-wal',
        home / '.local/share/opencode/opencode.db', home / '.local/share/opencode/opencode.db-wal',
        home / '.local/share/memory-system/data/memory.db', home / '.local/share/memory-system/data/memory.db-wal',
        home / '.local/share/memory-system/data/opencode_raw.db',
        home / '.local/share/memory-system/data/opencode_raw.db-wal']
    sizes = {}
    for path in paths:
        try:
            sizes[str(path)] = Path(path).stat().st_size
        except FileNotFoundError as exc:
            if confirmed_absent(path, exc):
                sizes[str(path)] = 0
            else:
                errors += 1
        except OSError:
            errors += 1
    try:
        sizes[str(temp_dir)] = int((Path(watch_dir) / 'tmp_kb').read_text()) * 1024
    except (ValueError, OSError):
        pass
    inventory = read_state('disk-inventory')
    props.update(inventorySourceErrors=inventory.get('sourceErrors', 0),
                 inventoryAgeS=None, inventoryStale=True)
    if number(inventory.get('at')):
        props['inventoryAgeS'] = max(0, time.time()-inventory['at'])
        props['inventoryStale'] = props['inventoryAgeS'] > 7200 or inventory['at'] > time.time()
        cached = inventory.get('sizes', {})
        if isinstance(cached, dict):
            sizes.update({path: size for path, size in cached.items() if number(size)})
    old_sizes = previous.get('sizes', {})
    if not isinstance(old_sizes, dict):
        old_sizes = {}
    partials = inventory.get('partials', {})
    # Older samples store coverage flags under inventoryPartials.
    old_partials = previous.get('partials', previous.get('inventoryPartials', {}))
    uncertain = set(partials if isinstance(partials, dict) else {}) | set(old_partials if isinstance(old_partials, dict) else {})
    # A sample can miss the inventory's one-run transition flag. Carry the
    # accounting mode in both baselines instead of comparing unlike totals.
    mode = inventory.get('duMode')
    if mode not in (None, 'links') or mode != previous.get('inventoryDuMode'):
        uncertain.update(map(str, DIRECTORY_ROOTS))
        cached_sizes = inventory.get('sizes', {})
        if isinstance(cached_sizes, dict):
            uncertain.update(cached_sizes)
    deltas = [(path, size-old_sizes[path]) for path, size in sizes.items()
              if path in old_sizes and number(old_sizes[path]) and path not in uncertain]
    growers = sorted(((path, delta) for path, delta in deltas if delta > 0), key=lambda x: x[1], reverse=True)[:5]
    for i, (path, delta) in enumerate(growers, 1):
        props['grower%dPath' % i] = path
        props['grower%dDeltaGb' % i] = round(delta / 1024**3, 6)
    movers = []
    if (not props['inventoryStale'] and number(previous.get('inventoryAt'))
            and 0 <= time.time()-previous['inventoryAt'] <= 7200):
        tracked = {str(path) for path in paths} | {str(path) for path in DIRECTORY_ROOTS} | {str(temp_dir)}
        movers = sorted(((path, delta) for path, delta in deltas if delta and path in tracked),
                        key=lambda item: (-abs(item[1]), item[0]))[:3]
        if movers:
            props.update(topMover1Path=movers[0][0], topMover1GbDelta=round(movers[0][1]/1024**3, 6))
    props.update(count=len(growers), baseline=int(not old_sizes), sourceErrors=errors)
    props.update(storage_probes(volumes, started))
    emit('disk', 'error' if errors else 'perf', 'disk.sample', duration_ms=(time.monotonic()-started)*1000,
         ok=not errors, props=props, error_tag='disk.source_unavailable' if errors else None, now=sampled_at)
    for prefix in ('internal', 'external'):
        key = prefix+'FreeGb'
        current_inventory = drop_inventory(inventory, prefix, sampled_at.timestamp())
        if (props.get(key+'Delta') or 0) < -10:
            before = free_inventory.get(key, {})
            before = before if isinstance(before, dict) else {}
            before_at, after_at = before.get('at'), current_inventory['at']
            comparable = (number(before_at) and number(after_at)
                          and 0 <= sampled_at.timestamp()-before_at <= 7200 and before_at < after_at
                          and current_inventory['duMode'] in (None, 'links')
                          and before.get('duMode') == current_inventory['duMode'])
            before_sizes = before.get('sizes', {})
            before_sizes = before_sizes if isinstance(before_sizes, dict) else {}
            parent_entries = before.get('parentEntries', {})
            parent_entries = parent_entries if isinstance(parent_entries, dict) else {}
            growth = []
            growth_complete = bool(comparable)
            if comparable:
                for path, size in current_inventory['sizes'].items():
                    old_size = before_sizes.get(path)
                    entries = parent_entries.get(str(Path(path).parent))
                    if path not in before_sizes and isinstance(entries, list) and path not in entries:
                        old_size = 0
                    if not number(old_size):
                        growth_complete = False
                    elif size > old_size:
                        growth.append((path, size-old_size))
            growth = sorted(growth, key=lambda item: (-item[1], item[0]))[:5]
            drop = dict(volume=prefix, deltaGb=props[key+'Delta'], windowS=props[prefix+'DeltaWindowS'],
                        deltaFromTs=props[prefix+'DeltaFromTs'],
                        purgeableGb=props.get(prefix+'PurgeableGb'),
                        localSnapshotCount=props.get(prefix+'LocalSnapshotCount'),
                        inventoryComplete=bool(growth_complete and before.get('complete') is True
                                               and current_inventory['complete']))
            for i, (path, size) in enumerate(growth, 1):
                drop['grower%dName' % i] = path
                drop['grower%dBytes' % i] = size
            emit('disk', 'event', 'disk.drop', props=drop, now=sampled_at)
        if key in props:
            old_free[key], free_ts[key] = props[key], stamp
            free_inventory[key] = current_inventory
    if any(abs(props[key+'Delta'] or 0) >= 20 for key in ('internalFreeGb', 'externalFreeGb')):
        swing = {key: props[key] for key in ('internalFreeGbDelta', 'externalFreeGbDelta')}
        swing.update(previousTs=props['deltaFromTs'], sampleTs=stamp)
        for prefix in ('internal', 'external'):
            for field in ('DeltaFromTs', 'DeltaWindowS'):
                swing[prefix+field] = props[prefix+field]
        for i, (path, delta) in enumerate(movers, 1):
            swing['topMover%dPath' % i] = path
            swing['topMover%dGbDelta' % i] = round(delta/1024**3, 6)
        emit('disk', 'event', 'disk.swing', props=swing, now=sampled_at)
    save_state('disk', dict(sizes=sizes, ts=stamp,
                           free=old_free, freeTs=free_ts, freeInventory=free_inventory,
                           partials=inventory.get('partials', {}), inventoryDuMode=mode,
                           inventoryAt=inventory.get('at') if not props['inventoryStale'] else None))


def backup_restic_exit(executable, exit_code, output):
    # nice and the timeout wrapper can fail before restic starts. Their status
    # still controls the job, but is not evidence of a restic exit.
    if int(exit_code) == 0:
        return '0'
    if not Path(executable).is_file() or not os.access(executable, os.X_OK):
        return ''
    if int(exit_code) in (126, 127) or re.search(
            r'(?m)^(?:[^\n]*[/])?nice:|^(?:FileNotFoundError|PermissionError|OSError):'
            r'|^Traceback \(most recent call last\):'
            r'|^(?:usage: )?(?:[^\n]*[/])?run_limited\.py(?:\s|: error:)', output):
        return ''
    return str(int(exit_code))


def backup_reason(stage, restic_rc, output):
    # Inspect errors locally; only a fixed enum crosses into the log.
    if str(restic_rc) == '12' or re.search(r'password command failed|unable to (?:read|get) (?:the )?password|wrong password|no key found', output, re.I):
        return 'password_unavailable'
    if stage == 'repo' or str(restic_rc) == '10' or (stage == 'restic' and re.search(
            r'\b(?:unable to|failed to|cannot) (?:open|read|load) (?:the )?(?:config(?:uration)? file|repository)\b',
            output, re.I)):
        return 'no_repo_access'
    if stage == 'vault':
        return 'source_missing'
    if stage == 'replica' and 'not found; waiting for owner export' in output:
        return 'source_missing'
    return 'other'


def backup_snapshot_time(value):
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?'
                         r'(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)', value)
    if not match:
        raise ValueError('invalid snapshot time')
    # Go's RFC3339Nano uses 1–9 fraction digits; Python 3.9 accepts only 3 or 6.
    fraction = '.'+match[2][:6].ljust(6, '0') if match[2] else ''
    zone = '+00:00' if match[3] == 'Z' else match[3]
    return dt.datetime.fromisoformat(match[1]+fraction+zone).timestamp()


def backup_snapshot_age(target):
    try:
        if target not in ('memory', 'health'):
            return None, 'unavailable'
        env = dict(os.environ)
        # Admission skips happen before the memory shell exports RESTIC_*.
        # Read only the two known Keychain entries, never a caller's command/file.
        # The guard gives this entire logger six seconds, including ps and startup.
        if not env.get('RESTIC_PASSWORD'):
            command = ['/usr/bin/security', 'find-generic-password', '-s', 'restic-'+target+'-backup']
            if target == 'health':
                command += ['-a', 'ardud']
            password = subprocess.run(command + ['-w'], capture_output=True, text=True,
                                      stdin=subprocess.DEVNULL, timeout=1)
            if password.returncode or not password.stdout.strip():
                return None, 'password_unavailable'
            env['RESTIC_PASSWORD'] = password.stdout.rstrip('\r\n')
        for key in ('RESTIC_PASSWORD_COMMAND', 'RESTIC_PASSWORD_FILE'):
            env.pop(key, None)
        if not env.get('RESTIC_REPOSITORY'):
            env['RESTIC_REPOSITORY'] = (str(Path(os.environ.get('MEMORY_BACKUP_REPO_ROOT',
                '/Volumes/ExternalSSD/memory-system-backup/restic'))/'live') if target == 'memory'
                else str(Path.home()/'.local/share/health-backup/restic'))
        tag = {'memory': 'memory-live', 'health': 'health-data'}[target]
        result = subprocess.run([os.environ.get('MAC_LOG_RESTIC', '/opt/homebrew/bin/restic'),
                                 '--no-lock', 'snapshots', '--host', 'ardud-mac', '--tag', tag,
                                 '--latest', '1', '--json'], env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=3)
        if result.returncode:
            return None, 'exit'
        snapshots = json.loads(result.stdout)
        if not isinstance(snapshots, list):
            return None, 'parse'
        if not snapshots:
            return None, 'no_snapshots'
        return max(0, time.time()-max(backup_snapshot_time(s['time']) for s in snapshots)), None
    except subprocess.TimeoutExpired:
        return None, 'timeout'
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return None, 'parse'
    except Exception:
        return None, 'unavailable'


def backup_processes(pids):
    processes = {}
    deadline = time.monotonic()+0.8
    pending = list(pids)
    # Read only the holder and caller ancestry; never emit the raw ps output.
    while pending and len(processes) < 16:
        pid = pending.pop(0)
        if pid <= 1 or pid in processes or time.monotonic() >= deadline:
            continue
        try:
            result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'ppid=,etime=,tty=,command='],
                                    capture_output=True, text=True, timeout=deadline-time.monotonic(),
                                    env={**os.environ, 'LC_ALL': 'C'})
            if result.returncode:
                continue
            parent, elapsed, tty, command = result.stdout.strip().split(None, 3)
            parts = shlex.split(command)
            days, _, clock = elapsed.rpartition('-')
            seconds = 0
            for value in clock.split(':'):
                seconds = seconds*60+int(value)
            seconds += int(days or 0)*86400
            processes[pid] = dict(ppid=int(parent), age=seconds, tty=tty, args=parts)
            pending.append(int(parent))
        except Exception:
            continue
    return processes


def backup_origin(pid, processes):
    manual = agent = launched = False
    for _ in range(16):
        process = processes.get(pid)
        if not process:
            break
        args = process['args']
        names = [Path(arg).name for arg in args[:4]]
        if any(name in ('install.zsh', 'install-jobs.zsh', 'deploy.zsh') for name in names):
            return 'installer'
        agent |= bool(names and names[0] in ('Robob', 'codex', 'claude', 'opencode'))
        manual |= process['tty'] not in ('?', '??', '-')
        launched |= process['ppid'] == 1
        pid = process['ppid']
    return 'agent' if agent else 'manual' if manual else 'launchd' if launched else 'unknown'


def backup_lock(lock_path, now):
    props = dict(lockHolderCmd=None, lockHolderPpid=None, lockHolderStartedAgoS=None,
                 lockHolderTrigger='unknown')
    try:
        lock = Path(lock_path)
        props['lockAgeS'] = max(0, int(now-lock.stat().st_mtime))
        holder = (lock/'pid').read_text().strip()
        holder = int(holder) if re.fullmatch(r'[0-9]{1,10}', holder) else 0
        # Darwin/Linux pid_t is signed 32-bit; corrupt metadata must not drop the log.
        props['lockPid'] = holder if 0 < holder <= 2**31-1 else 0
    except (OSError, ValueError):
        props.setdefault('lockPid', 0)
    gone = False
    if props['lockPid'] > 0:
        try:
            os.kill(props['lockPid'], 0)
        except ProcessLookupError:
            gone = True
        except (OSError, OverflowError):
            pass
    return props, gone


def backup_holder(props, processes):
    holder = props.get('lockPid', 0)
    process = processes.get(holder)
    if process:
        args = process['args']
        program = Path(args[0]).name if args else 'unknown'
        if re.fullmatch(r'python3(?:\.\d+)?', program):
            program = 'python3'
        if program not in BACKUP_PROGRAMS:
            program = 'unknown'
        command = program
        if len(args) > 1:
            arg = Path(args[1]).name
            command += ' '+(arg if arg in BACKUP_ARGS else '[redacted]')
        props.update(lockHolderCmd=command, lockHolderPpid=process['ppid'],
                     lockHolderStartedAgoS=process['age'], lockHolderTrigger=backup_origin(holder, processes))


def backup_status():
    try:
        # Independent of the backup's repository/staging overrides. The MAC_LOG
        # override, like MAC_LOG_RESTIC, is for isolated diagnostic fixtures.
        path = Path(os.environ.get('MAC_LOG_MEMORY_STATUS',
                    str(Path.home()/'.local/share/memory-system/logs/backup_last.json')))
        with path.open('rb') as stream:
            if os.fstat(stream.fileno()).st_size > 65536:
                return {}
            value = json.loads(stream.read(65536))
        if not isinstance(value, dict):
            return {}
        result = {key: value.get(key) for key in ('ts', 'ok', 'stage', 'last_success_ts')}
        for key in ('ts', 'last_success_ts'):
            stamp = result[key]
            if type(stamp) not in (int, float) or not math.isfinite(stamp) or stamp <= 0:
                result[key] = None
        stage = result['stage']
        result['stage'] = stage if isinstance(stage, str) and stage in BACKUP_STAGES and stage != 'unknown' else 'other'
        return result
    except Exception:
        return {}


def backup_run(target, start, restic_rc, exit_code, snapshot_at, summary, skip_reason='', lock_path='',
               load_per_core='', last_success_age_s='', deferred_count='', failed_stage=''):
    now = time.time()
    if target not in ('health', 'memory', 'other'):
        return
    try:
        summary = json.loads(summary)
    except ValueError:
        summary = {}
    if not isinstance(summary, dict):
        summary = {}
    status = backup_status() if target == 'memory' else {}
    ran = str(restic_rc) not in ('', '-1')
    if not ran and not skip_reason and int(exit_code) == 0:
        skip_reason = 'other'
    if skip_reason and skip_reason not in SKIP_REASONS:
        skip_reason = 'other'
    # fail() passes backup_reason's result through the legacy skip argument.
    # Only admission/lock reasons prove work was skipped when the job failed.
    fail_reason = None
    if int(exit_code) != 0 and skip_reason not in ('lock_held', 'stale_lock', 'load_deferred', 'boot_grace'):
        fail_reason = skip_reason if skip_reason in ('other', 'password_unavailable', 'no_repo_access', 'source_missing') else None
        skip_reason = ''
    props = dict(target=target, exitCode=int(exit_code), skipped=int(bool(skip_reason)))
    for key, value in [('loadPerCore', load_per_core), ('lastSuccessAgeS', last_success_age_s),
                       ('deferredCount', deferred_count)]:
        try:
            if type(value) is bool:
                continue
            parsed = float(value) if key == 'loadPerCore' else int(str(value))
            if math.isfinite(parsed) and parsed >= 0:
                props[key] = round(parsed, 2) if key == 'loadPerCore' else parsed
        except (ValueError, TypeError, OverflowError):
            pass
    if skip_reason == 'lock_held':
        lock_props, gone = backup_lock(lock_path, now)
        props.update(lock_props)
        if gone:
            skip_reason = 'stale_lock'
    processes = backup_processes([props.get('lockPid', 0), os.getppid()])
    origin = backup_origin(os.getppid(), processes)
    if origin == 'unknown' and os.environ.get('XPC_SERVICE_NAME') == 'com.abdullah.'+target+'-backup':
        origin = 'launchd'
    props['trigger'] = 'unknown' if origin == 'agent' else origin
    backup_holder(props, processes)
    if ran:
        props['resticExitCode'] = int(restic_rc)
    ok = int(exit_code) == 0
    tag = None if ok else 'backup.failed'
    if skip_reason:
        props['skipReason'] = skip_reason
        ok, tag = False, 'backup.skipped_' + skip_reason
        if skip_reason == 'lock_held':
            # An unreadable age cannot prove that this is a healthy skip.
            ok = int(exit_code) == 0 and 'lockAgeS' in props and props['lockAgeS'] < 7200
            tag = (None if ok else 'backup.skip_stale_lock' if props.get('lockAgeS', -1) >= 7200
                   else 'backup.skipped_lock_held')
        elif skip_reason in ('load_deferred', 'boot_grace') and int(exit_code) == 0:
            ok, tag = True, None
    elif not ok:
        stage = failed_stage if target == 'health' and failed_stage else 'unknown'
        if target == 'memory' and status.get('ok') is False and status.get('ts') is not None and status['ts'] >= float(start):
            stage = status['stage']
        stage = stage if isinstance(stage, str) and stage in BACKUP_STAGES else 'other'
        props.update(failedStage=stage, failReason=fail_reason or backup_reason(stage, restic_rc, ''))
        tag = 'backup.failed_'+stage
    # Only counters are copied from restic's summary, never paths/errors or command output.
    for key, source in [('bytes', 'total_bytes_processed'), ('files', 'total_files_processed')]:
        if type(summary.get(source)) is int:
            props[key] = summary[source]
    age, snapshot_error = backup_snapshot_age(target)
    if age is not None:
        props['lastGoodSnapshotSource'] = 'restic'
    elif snapshot_error and status.get('last_success_ts') is not None and status['last_success_ts'] <= now:
        age = now-status['last_success_ts']
        props['lastGoodSnapshotSource'] = 'status_file'
    props['lastGoodSnapshotAgeS'] = age
    if snapshot_error:
        props['lastGoodSnapshotError'] = snapshot_error
    if age is not None:
        props['snapshotAgeS'] = age
    elif number(float(snapshot_at)) and float(snapshot_at) > 0:
        props['snapshotAgeS'] = max(0, now-float(snapshot_at))
    emit('backup', 'perf' if ok else 'error', 'backup.run',
         duration_ms=max(0, (now-float(start))*1000), ok=ok, props=props, error_tag=tag)


def main(argv):
    try:
        if argv[0] == 'disk':
            disk_sample(*argv[1:3])
        elif argv[0] == 'alert':
            ok = argv[1] == '0'
            emit('disk', 'event' if ok else 'error', 'disk.alert', ok=ok,
                 props={'exitCode': int(argv[1])}, error_tag=None if ok else 'disk.alert_failed')
        elif argv[0] == 'backup':
            backup_run(*argv[1:6], sys.stdin.read(16384), *argv[6:12])
        elif argv[0] == 'backup-reason':
            print(backup_reason(*argv[1:3], sys.stdin.read(16384)))
        elif argv[0] == 'backup-restic-exit':
            print(backup_restic_exit(*argv[1:3], sys.stdin.read(16384)))
    except Exception:
        pass


if __name__ == '__main__':
    main(sys.argv[1:])
