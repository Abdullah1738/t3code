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
import resource
import signal
import statistics
import stat
import shlex
from pathlib import Path
import sys
import subprocess
import tempfile
import time
from types import SimpleNamespace
from toollog import emit, directory, private_dir, finite_number, SKIP_REASONS, BACKUP_PROGRAMS, BACKUP_ARGS, BACKUP_STAGES


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
DEEP_ROOTS = {str(Path('/Volumes/ExternalSSD')/name) for name in
              ('wt', 't3code-wt', 'board-wt', 'coord-wt', 'crpko-devops/tmp')}


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
         props={**dict(source=str(source), failure=failure, exitCode=code,
                    elapsedMs=max(0, (time.monotonic()-started)*1000)), **(props or {})},
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


def inventory_du(run, command, measurement, **kwargs):
    started = time.monotonic()
    cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
    try:
        return run(command, **kwargs)
    finally:
        used = resource.getrusage(resource.RUSAGE_CHILDREN)
        measurement.update(allowanceS=kwargs['timeout'],
            elapsedMs=max(0, time.monotonic()-started)*1000,
            cpuS=max(0, used.ru_utime+used.ru_stime-cpu.ru_utime-cpu.ru_stime))


def du_total(path, run, timeout, measurement=None):
    # Child entries are cached/refreshed independently. Count every hardlink
    # consistently in both single and batched scans; cross-argument inode
    # deduplication would assign bytes to a different child on each scan.
    # These logical link-occurrence sums can exceed physical use (pnpm stores,
    # git clone --local) and are an upper bound, not freeable space.
    if timeout <= 0:
        raise SourceFailure('timeout', 'directory inventory overall budget exhausted')
    deadline = time.monotonic()+timeout
    runner = run if measurement is None else lambda command, **kw: inventory_du(run, command, measurement, **kw)
    result = runner(['/usr/bin/du', '-skl', str(path)], capture_output=True, text=True,
                 timeout=timeout, env={**os.environ, 'LC_ALL': 'C'})
    stderr = getattr(result, 'stderr', '') or ''
    denied = sum(permission_denied(line) for line in stderr.splitlines())
    other_errors = any(line.strip() and not permission_denied(line) for line in stderr.splitlines())
    message = stderr_line(stderr)
    if other_errors or result.returncode and (result.returncode != 1 or not denied):
        if inventory_vanished(path, deadline):
            raise SourceFailure('vanished', 'child vanished during inventory', result.returncode)
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
    exc = SourceFailure(failure, message or 'du did not print a root total', result.returncode)
    exc.denied_only = bool(denied and not other_errors)
    raise exc


class InventoryListing(tuple):
    def __new__(cls, entries, listed, failure=None):
        result = super().__new__(cls, (entries, listed))
        result.failure = failure
        return result


def inventory_listing(path, deadline, source_failures=None):
    entries, listed = [], False
    failure = None
    started = time.monotonic()
    try:
        with deadline_call(deadline, os.scandir, path) as listing:
            deadline_call(deadline, entries.extend, listing)
        listed = True
    except (OSError, SourceFailure) as exc:
        failure = exc
        tag = source_error('disk', 'disk.inventory.source', path, started, exc)
        if source_failures is not None:
            source_failures.add(tag)
    return InventoryListing(entries, listed, failure)


INVENTORY_FRESH_S = 24*3600
# A ~7,000 s sweep needs at least two daily 90-minute passes. Only these
# deep-owned roots retain ordinary totals for 48 h; ageS stays their real age.
INVENTORY_DEEP_FRESH_S = 48*3600
# A capped child can need three nightly passes; expiring its saved parts
# after one night would restart that same prefix forever.
INVENTORY_PARTS_FRESH_S = 3*24*3600
DEEP_PROBE_S = 15
# b54e6df2 lost 2,902 s to 15/30 s probes on a busy night.
DEEP_FIRST_S = 60
DEEP_PROBE_MAX_S = 120
DEEP_CHILD_CAP_S = 600


def inventory_vanished(path, deadline):
    try:
        deadline_call(min(deadline, time.monotonic()+2), os.lstat, path)
    except FileNotFoundError as exc:
        return confirmed_absent(path, exc)
    except (OSError, SourceFailure):
        pass
    return False


def inventory_du_errors(paths, stderr, deadline):
    denied, vanished, failed, unknown = {}, set(), set(), False
    for line in stderr.splitlines():
        if not line.strip():
            continue
        matches = [p for p in paths if line.startswith('du: '+p+': ')
                   or line.startswith('du: '+p+'/')]
        if not matches:
            unknown = True
            continue
        path = max(matches, key=len)
        if permission_denied(line):
            denied[path] = denied.get(path, 0)+1
        elif 'No such file or directory' in line and inventory_vanished(path, deadline):
            vanished.add(path)
        else:
            failed.add(path)
    return denied, vanished, failed, unknown


def inventory_has_timeout(value):
    return bool(value.get('timeouts') or value.get('limited')
                or value.get('slow') and not value.get('probeTimeouts'))


def inventory_has_parts(value):
    return isinstance(value.get('parts'), dict) and value.get('isDirectory') is not False


def inventory_migrate_probe(value):
    # Old cache entries did not distinguish 15 s probes from real timeouts.
    # A recorded allowance makes this conversion one-time, even after a kill.
    if (value.get('timeouts') and 'lastTimeoutS' not in value
            and not inventory_has_parts(value)):
        value['probeTimeouts'] = value.get('probeTimeouts', 0)+value.pop('timeouts')
        value['lastProbeS'] = DEEP_PROBE_S
        value['lastTimeoutS'] = DEEP_PROBE_S


def inventory_probe_allowance(value, successful_ms):
    elapsed = value.get('elapsedMs')
    allowance = 1.5*elapsed/1000 if number(elapsed) else DEEP_FIRST_S
    if number(value.get('lastProbeS')):
        allowance = max(allowance, 2*value['lastProbeS'])
    return min(DEEP_CHILD_CAP_S, DEEP_PROBE_MAX_S, max(DEEP_PROBE_S, allowance))


def inventory_deep_owned(value, now):
    last = value.get('lastTimeoutAt')
    return (value.get('denied') or number(value.get('nextAttemptAt')) or inventory_has_parts(value)
            or number(last) and now-last < INVENTORY_FRESH_S)


def inventory_backed_off(value, now):
    retry = value.get('nextAttemptAt')
    return number(retry) and retry > now


def inventory_timeout(value):
    value['timeouts'] = value.get('timeouts', 0)+1
    value['leafTimeouts'] = value.get('leafTimeouts', 0)+1
    value['lastTimeoutAt'] = time.time()
    # Keep #41's probe/descent history separate: only full leaf failures
    # receive #33's daily exponential backoff; parents keep making parts progress.
    value['nextAttemptAt'] = time.time()+86400*2**min(value['leafTimeouts']-1, 3)


def inventory_diagnostics(cache, now):
    cache = {k:v for k,v in cache.items() if isinstance(v, dict)} if isinstance(cache, dict) else {}
    leaves = [part for value in cache.values() for part in
              (value['parts'].values() if inventory_has_parts(value) else [value])]
    props = dict(deniedCount=sum(v['deniedCount'] for v in cache.values() if number(v.get('deniedCount'))),
                 timedOutCount=sum(inventory_has_timeout(v) for v in leaves),
                 backedOffCount=sum(inventory_backed_off(v, now) for v in leaves),
                 estimatedCount=sum(bool(v.get('estimate')) for v in cache.values()))
    def elapsed(value):
        return value.get('lastAttemptMs', value.get('elapsedMs', 0))
    slowest = sorted(cache.items(), key=lambda item: elapsed(item[1]), reverse=True)[:3]
    for i, (path, value) in enumerate(slowest, 1):
        props['slowest%dPath' % i] = path
        props['slowest%dMs' % i] = elapsed(value)
    return props


@contextmanager
def inventory_lock(wait_s=0, stopped=lambda: False, on_wait=lambda: None):
    # Never unlink a flock file: another process may already have it open.
    path = state_path('disk-inventory').with_suffix('.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.monotonic()+max(0, wait_s)
        waiting = acquired = False
        while True:
            if wait_s > 0 and stopped():
                break
            if waiting and time.monotonic() >= deadline:
                break
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except BlockingIOError:
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    break
                if not waiting:
                    # Let callers measure contention without counting an uncontended open.
                    on_wait()
                    waiting = True
                time.sleep(min(2, remaining))
        yield fd if acquired else False
    finally:
        os.close(fd)


def inventory_freshness_s(value, root=None):
    if isinstance(value, dict) and inventory_has_parts(value):
        return INVENTORY_PARTS_FRESH_S
    return INVENTORY_DEEP_FRESH_S if str(root) in DEEP_ROOTS else INVENTORY_FRESH_S


def inventory_needs_measurement(value, now, freshness_s=None, root=None):
    if freshness_s is None:
        freshness_s = inventory_freshness_s(value, root)
    return (not isinstance(value, dict) or not number(value.get('bytes'))
            or not number(value.get('at')) or value['at'] > now
            or now-value['at'] >= freshness_s
            or value.get('partial') is not False or bool(value.get('limited')))


def inventory_due(value, now, due_at=None, root=None):
    if isinstance(value, dict) and inventory_backed_off(value, now):
        return False
    # Refresh ordinary children before they expire during a long parts turn.
    # Parts retain their separate checkpoint/expiry policy.
    when = now if isinstance(value, dict) and inventory_has_parts(value) else max(now, due_at or now)
    return inventory_needs_measurement(value, when, root=root)


def inventory_refresh_entries(entries, cache, now, root=None):
    eligible = []
    for entry in entries:
        value = cache.get(entry.path, {})
        if (isinstance(value, dict) and number(value.get('bytes')) and number(value.get('at'))
                and now-value['at'] >= inventory_freshness_s(value, root)
                and not value.get('limited') and not inventory_deep_owned(value, now)):
            eligible.append(entry)
    return sorted(eligible, key=lambda entry: (
        bool(cache[entry.path].get('slow')), cache[entry.path]['at'], entry.path))


def inventory_expire_parts(value, now):
    if not inventory_has_parts(value):
        return
    parts = value['parts']
    value['partsDone'] = sum(not inventory_needs_measurement(v, now, INVENTORY_PARTS_FRESH_S)
                             for v in parts.values())
    if (inventory_needs_measurement(value, now)
            or value.get('partsTotal', len(parts)) != len(parts)
            or any(inventory_needs_measurement(v, now, INVENTORY_PARTS_FRESH_S) for v in parts.values())):
        value['partial'] = True
        value.pop('bytes', None)
        value.pop('at', None)


def inventory_clean_cache(cache, now):
    for key, value in list(cache.items()):
        if not isinstance(value, dict):
            cache.pop(key)
            continue
        attempted = value.get('attemptedAt', 0)
        value['attemptedAt'] = attempted if number(attempted) and attempted <= now else 0
        if value.get('isDirectory') is False:
            # Earlier scans left an empty decomposition on timed-out files.
            # Those are ordinary measurements, with the ordinary freshness.
            for field in ('parts', 'partsDone', 'partsTotal'):
                value.pop(field, None)
        for field in ('timeouts', 'leafTimeouts', 'lastTimeoutAt', 'nextAttemptAt', 'elapsedMs', 'lastAttemptMs',
                      'probeTimeouts', 'lastProbeS', 'lastTimeoutS'):
            if field in value and not number(value[field]):
                value.pop(field)
        if 'parts' in value and not isinstance(value['parts'], dict):
            value.pop('parts')
        if not number(value.get('bytes')) or not number(value.get('at')) or value['at'] > now:
            cache[key] = {k: value[k] for k in ('attemptedAt', 'slow', 'limited', 'partial',
                'timeouts', 'leafTimeouts', 'lastTimeoutAt', 'nextAttemptAt', 'parts', 'partsDone', 'partsTotal',
                'elapsedMs', 'lastAttemptMs', 'isDirectory', 'probeTimeouts', 'lastProbeS', 'lastTimeoutS') if k in value}
        if isinstance(cache[key].get('parts'), dict):
            parts = cache[key]['parts']
            expected_parts = set(parts)
            inventory_clean_cache(parts, now)
            # Losing an invalid part cannot establish a complete, empty parent.
            if expected_parts-set(parts):
                cache[key]['partial'] = True
            inventory_expire_parts(cache[key], now)


def inventory_child_state(previous, roots):
    # Pre-links entries deduplicated across batch arguments. Never mix those
    # totals with independent per-child link-occurrence measurements.
    old = previous.get('childState', {})
    old = old if isinstance(old, dict) else {}
    migrated = previous.get('duMode') != 'links' and bool(previous.get('sizes') or any(old.values()))
    return {str(path): (old[str(path)] if not migrated and isinstance(old.get(str(path)), dict) else {})
            for path in roots}, migrated


def inventory_status(cache, entries, listed, now, completed=0, failures=0, freshness_s=None, root=None):
    for value in cache.values():
        inventory_expire_parts(value, now)
    children = {key: value['bytes'] for key, value in cache.items() if number(value.get('bytes'))}
    cached = [value for value in cache.values() if 'bytes' in value and value['at'] < now]
    missing = len({entry.path for entry in entries}-set(children))
    denied = sum(value['deniedCount'] for value in cache.values()
                 if number(value.get('deniedCount')) and value['deniedCount'] > 0)
    partial_children = sum(not number(value.get('deniedCount')) and value.get('partial') is not False
                           for value in cache.values())
    incomplete = bool(not listed or failures or missing or partial_children
                     or any(v.get('partial') is not False or v.get('limited') for v in cache.values())
                     or any(inventory_needs_measurement(v, now, freshness_s, root=root) for v in cached))
    return sum(children.values()), dict(partial=bool(incomplete or denied),
        completeWithDenied=bool(not incomplete and denied),
        failedCount=failures+int(bool(missing) and not failures), completedCount=completed,
        deniedCount=denied, partialChildCount=partial_children, cachedCount=len(cached), unmeasuredCount=missing,
        limitedCount=sum(bool(v.get('limited')) for v in cache.values()),
        ageS=max((now-value['at'] for value in cached), default=0),
        **{k:v for k,v in inventory_diagnostics(cache, now).items() if k != 'deniedCount'}), children


class InventoryLog:
    def __init__(self, root, cache=None):
        self.previous_sizes = {}
        pending = list((cache or {}).items())
        while pending:
            key, value = pending.pop()
            if not isinstance(value, dict):
                continue
            if number(value.get('bytes')):
                self.previous_sizes[key] = value['bytes']
            if isinstance(value.get('parts'), dict):
                pending.extend(value['parts'].items())
        self.root = str(root)
        self.measured = set()
        self.elapsed_ms = 0
        self.slowest_ms = 0
        self.slowest_path = None

    def timing(self, key, elapsed_ms):
        if self.slowest_path is None or elapsed_ms > self.slowest_ms:
            self.slowest_ms, self.slowest_path = elapsed_ms, key

    def child(self, key, size, previous, elapsed_ms, partial=False, denied=0, code=0, measurement=None, vanished=False):
        # Diagnostics are never sampled, including legacy ok=true partial rows.
        # Batch timing is amortized: du does not report individual durations.
        try:
            if str(Path(key).parent) == self.root:
                self.measured.add(key)
            self.timing(key, elapsed_ms)
            # Expiry/decomposition can discard bytes before the refresh ends.
            old = self.previous_sizes.get(key, previous.get('bytes') if isinstance(previous, dict) else None)
            changed = (abs(size-old) >= 1024**3 or abs(size-old)*5 >= old) if number(old) and old > 0 else (
                size > 0 if old == 0 else size >= 1024**3)
            if measurement is not None or partial or denied or vanished or changed or elapsed_ms >= 10000:
                emit('disk', 'event', 'disk.inventory.source', ok=True,
                     props={**dict(source=key, bytes=size, partial=partial, deniedCount=denied,
                                exitCode=code, elapsedMs=elapsed_ms), **(measurement or {})})
        except Exception:
            pass

    def root_event(self, cache, total, status, skip_reason=None):
        try:
            props = dict(root=self.root, source=self.root, childrenMeasured=len(self.measured),
                         childrenCached=sum(number(v.get('bytes')) for v in cache.values()),
                         childrenPartial=sum(v.get('partial') is not False or bool(v.get('limited'))
                                             for v in cache.values()),
                         unmeasuredCount=status['unmeasuredCount'], partial=status['partial'],
                         deniedCount=status['deniedCount'], partialChildCount=status['partialChildCount'],
                         elapsedMs=self.elapsed_ms, slowestChildMs=self.slowest_ms)
            props.update(inventory_diagnostics(cache, time.time()),
                         completeWithDenied=status.get('completeWithDenied', False))
            if skip_reason is not None:
                props['skipReason'] = skip_reason
            if self.slowest_path is not None:
                props['slowestChildPath'] = self.slowest_path
            if any(number(v.get('bytes')) for v in cache.values()) or not status['partial']:
                props['bytes'] = total
            emit('disk', 'event', 'disk.inventory.root', props=props)
        except Exception:
            pass


def inventory_skipped_logs(roots, previous, reason):
    now = time.time()
    child_state, migrated = inventory_child_state(previous, roots)
    old_sizes = previous.get('sizes', {})
    old_partials = previous.get('partials', {})
    sizes, flags = {}, {str(root): dict(partial=True) for root in roots}
    for root in roots:
        try:
            key = str(root)
            cache = child_state[key]
            # Cleanup can discard bad measurements after a clock rollback;
            # their child keys must still count as expected, unmeasured work.
            entries = [SimpleNamespace(path=path) for path in cache]
            inventory_clean_cache(cache, now)
            # A saved complete listing can be reused while locked, but its
            # children must still be fresh now. Never scan or persist here.
            listed = (not migrated and key in old_sizes and (key not in old_partials or old_partials[key].get('completeWithDenied'))
                      and (bool(cache) or old_sizes[key] == 0))
            total, status, children = inventory_status(cache, entries, listed, now, root=root)
            flags[key] = status
            if children or not status['partial']:
                sizes[key] = total
            InventoryLog(root, cache).root_event(cache, total, status, reason)
        except Exception:
            pass
    return sizes, flags


def big_root_inventory(path, run, deadline, cache=None, listing=None, pending_only=False, refresh_only=False,
                       deep=False, checkpoint=None, attempted=None, max_batches=None, single_paths=None,
                       parts_mode=False, metrics=None, turn_seconds=None, part_work=None,
                       due_at=None, descend=True, inventory_log=None, source_failures=None, probe_retries=None,
                       full_leaf_budget=False):
    cache = {} if cache is None else cache
    inventory_log = inventory_log if inventory_log is not None else InventoryLog(path, cache)
    single_paths = set() if single_paths is None else single_paths
    part_work = {} if part_work is None else part_work
    probe_retries = set() if probe_retries is None else probe_retries
    now = time.time()
    freshness_s = INVENTORY_PARTS_FRESH_S if parts_mode else None
    turn_started = time.monotonic()
    # Shared with the separate deep pass: each immediate-child key has bytes,
    # at, attemptedAt and partial. Optional isDirectory/deniedCount preserve
    # directory attribution and permission diagnostics;
    # slow/limited record only this hourly scanner's 15/60 s timeout policy.
    inventory_clean_cache(cache, now)
    if deep and not parts_mode:
        for value in cache.values():
            inventory_migrate_probe(value)
    entries, listed = (inventory_listing(path, deadline) if source_failures is None else
                       inventory_listing(path, deadline, source_failures)) if listing is None else listing
    present = {entry.path for entry in entries}
    if listed:
        for key in set(cache)-present:
            cache.pop(key)
    successful_ms = {key: v['elapsedMs'] for key, v in cache.items()
                     if number(v.get('elapsedMs')) and not inventory_has_parts(v)}
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
    refresh = inventory_refresh_entries(entries, cache, now, root=path)
    selected = refresh if refresh_only else pending if pending_only else pending+refresh
    def can_descend():
        return descend() if callable(descend) else descend
    allow_descent = can_descend()
    if deep:
        selected = sorted((e for e in entries if (inventory_needs_measurement(cache.get(e.path), now, freshness_s)
                               if parts_mode else inventory_due(cache.get(e.path), now, due_at, root=path))
                           and (attempted is None or e.path not in attempted)
                           and not inventory_backed_off(cache.get(e.path, {}), now)
                           and (allow_descent or not (inventory_has_timeout(cache.get(e.path, {}))
                                               or inventory_has_parts(cache.get(e.path, {}))))),
                          key=lambda e: (inventory_has_timeout(cache.get(e.path, {})),
                                         'bytes' in cache.get(e.path, {}),
                                         bool(cache.get(e.path, {}).get('attemptedAt', 0)),
                                         cache.get(e.path, {}).get('at', 0),
                                         cache.get(e.path, {}).get('elapsedMs', 0),
                                         cache.get(e.path, {}).get('attemptedAt', 0), e.path))
    else:
        selected = [entry for entry in selected if not cache.get(entry.path, {}).get('limited')
                    and not inventory_deep_owned(cache.get(entry.path, {}), now)]
    def part_cost_ms(value):
        elapsed = value.get('elapsedMs')
        return elapsed if number(elapsed) else statistics.median(successful_ms.values()) if successful_ms else 0
    batches = 0
    while selected and time.monotonic() < deadline:
        first = selected[0]
        old = cache.get(first.path, {})
        if deep and not parts_mode and (inventory_has_timeout(old) or 'parts' in old):
            if not can_descend():
                selected = selected[1:]
                continue
            more = inventory_parts(first, run, deadline, cache, checkpoint, entries, listed, metrics, part_work, inventory_log)
            if attempted is not None and not more:
                attempted.add(first.path)
            selected = selected[1:]
            batches += 1
            if (max_batches is not None and batches >= max_batches
                    or turn_seconds is not None and time.monotonic()-turn_started >= turn_seconds):
                break
            continue
        allowance = (DEEP_CHILD_CAP_S if parts_mode else inventory_probe_allowance(old, list(successful_ms.values()))
                     if deep else 60 if old.get('slow') else 15)
        timeout = min(allowance, deadline-time.monotonic())
        if parts_mode:
            cost_ms = part_cost_ms(old)
            # After one 350 s part, a sibling cannot fit the 250 s left in
            # the nightly child cap. Leave it pending instead of killing it.
            if cost_ms > timeout*1000:
                if attempted is not None:
                    attempted.add(first.path)
                selected = selected[1:]
                continue
        # Limited children were excluded from the entire selection, including
        # later batch positions, until a measured replacement clears the hint.
        # Many-child roots use the same per-link accounting as du_total,
        # with bounded argv, rotating the first unfinished
        # child after a timeout instead of rescanning du -d 1's fixed prefix.
        batch, argv_bytes, batch_cost_ms = [], 0, 0
        batch_timeout = min(60, DEEP_PROBE_MAX_S, DEEP_CHILD_CAP_S, deadline-time.monotonic())
        for entry in selected[:128] if len(entries) >= 128 and not inventory_has_timeout(old) and first.path not in single_paths and not (deep and old.get('lastProbeS')) else selected[:1]:
            if deep and batch and (entry.path in single_paths or cache.get(entry.path, {}).get('lastProbeS') or inventory_has_timeout(cache.get(entry.path, {})) or 'parts' in cache.get(entry.path, {})):
                break
            cost_ms = part_cost_ms(cache.get(entry.path, {})) if deep else 0
            # A 60 s batch must not recreate short probes for ordinary worktrees.
            # Learn one cost before batching; reserve 2x estimated work within
            # the batch deadline. This estimate never sizes a child's allowance.
            batch_limit_ms = batch_timeout*1000/2 if deep and not parts_mode else timeout*1000
            if batch and deep and (not cost_ms or batch_cost_ms+cost_ms > batch_limit_ms):
                break
            length = len(os.fsencode(entry.path))+1
            if batch and argv_bytes+length > 32768:
                break
            batch.append(entry)
            argv_bytes += length
            batch_cost_ms += cost_ms
        selected = selected[len(batch):]
        if deep and not parts_mode and len(batch) > 1:
            timeout = batch_timeout
        if deep and not parts_mode and len(batch) == 1 and metrics is not None:
            metrics.setdefault('probeAllowances', []).append(timeout)
        paths = {entry.path: entry for entry in batch}
        started = time.monotonic()
        measurement = {}
        first_attempt = deep and not parts_mode and len(batch) == 1 and not number(old.get('elapsedMs'))
        if first_attempt and metrics is not None:
            metrics['firstAttempts'] = metrics.get('firstAttempts', 0)+1
        done = set()
        uncertain = rejected = retry_probe = False
        effective = timeout
        denied_by_path, vanished, bad_paths = {}, set(), set()
        try:
            if len(batch) == 1:
                size, denied, code = du_total(Path(first.path), run, timeout, measurement if deep else None)
                values = [(first.path, size)]
                denied_by_path = {first.path: denied} if denied else {}
            else:
                command = ['/usr/bin/du', '-skl', *paths]
                try:
                    runner = (lambda command, **kw: inventory_du(run, command, measurement, **kw)) if deep else run
                    result = runner(command, capture_output=True, text=True, timeout=timeout,
                                 env={**os.environ, 'LC_ALL': 'C'})
                    output, stderr, code = result.stdout, result.stderr, result.returncode
                except subprocess.TimeoutExpired as exc:
                    output, stderr, code = exc.stdout or '', exc.stderr or '', None
                    effective = exc.timeout
                if isinstance(output, bytes):
                    output = output.decode('utf-8', errors='replace')
                if isinstance(stderr, bytes):
                    stderr = stderr.decode('utf-8', errors='replace')
                denied_by_path, vanished, bad_paths, uncertain = inventory_du_errors(paths, stderr or '', deadline)
                denied = sum(permission_denied(line) for line in (stderr or '').splitlines())
                other_errors = any(line.strip() and not permission_denied(line)
                                   for line in (stderr or '').splitlines())
                # Unknown diagnostics stay conservative. Exact argv/subpath
                # matches let healthy sibling totals survive a nonzero exit.
                if code is not None and (code not in (0, 1) or uncertain and
                        (deep or code != 0 and (not denied or other_errors))):
                    raise SourceFailure('exit', stderr_line(stderr) or 'du exited unsuccessfully', code)
                values = []
                for line in output.splitlines(keepends=True):
                    fields = line.rstrip('\n').split('\t', 1)
                    # A killed process may leave an unfinished final row.
                    if line.endswith('\n') and len(fields) == 2 and fields[0].isdigit() and fields[1] in paths:
                        values.append((fields[1], int(fields[0])*1024))
                values += [(key, 0) for key in vanished if key not in {p for p, _ in values}]
                if code is not None:
                    values += [(key, 0) for key in denied_by_path if key not in {p for p, _ in values}]
            for key, size in values:
                if key in done or key in bad_paths:
                    continue
                entry = paths[key]
                child_denied = denied_by_path.get(key, 0)
                partial = bool(uncertain or kind(entry) is None and key not in vanished)
                hints = {k: cache[key][k] for k in ('slow', 'limited') if partial and k in cache.get(key, {})}
                hints.update({k: cache[key][k] for k in ('timeouts', 'lastTimeoutAt', 'lastTimeoutS', 'probeTimeouts', 'elapsedMs') if k in cache.get(key, {})})
                previous_value = cache.get(key, {})
                elapsed_ms = (time.monotonic()-started)*1000/len(batch)
                if not partial and code is not None:
                    hints['elapsedMs'] = elapsed_ms
                    if deep:
                        successful_ms[key] = elapsed_ms
                elif partial and 'lastProbeS' in previous_value:
                    hints['lastProbeS'] = previous_value['lastProbeS']
                cache[key] = dict(bytes=size, at=time.time(), attemptedAt=time.time(), partial=partial,
                                  deniedCount=child_denied if not uncertain else denied if key == values[0][0] else 0,
                                  denied=bool(child_denied), estimate=bool(child_denied), vanished=key in vanished,
                                  isDirectory=kind(entry), lastAttemptMs=elapsed_ms, **hints)
                done.add(key)
                completed += 1
                if child_denied:
                    failure = source_error('disk', 'disk.inventory.source', key, started,
                        SourceFailure('permission' if child_denied else 'partial', 'du returned an incomplete total', code),
                        props=dict(bytes=size, deniedCount=child_denied, estimate=bool(child_denied),
                                   **(measurement if len(batch) == 1 else {})))
                    if source_failures is not None:
                        source_failures.add(failure)
                    inventory_log.timing(key, elapsed_ms)
                    if str(Path(key).parent) == inventory_log.root:
                        inventory_log.measured.add(key)
                else:
                    inventory_log.child(key, size, previous_value, elapsed_ms, partial=partial,
                                        denied=cache[key]['deniedCount'], code=code,
                                        measurement=measurement if deep and len(batch) == 1 else None,
                                        vanished=key in vanished)
            if code is None and len(done) == len(batch):
                # Complete rows remain valid, even if du hangs after printing
                # its last total. The command timeout still spent the budget.
                if metrics is not None:
                    metrics['timeouts'] += 1
                    metrics['secondsInTimeouts'] += time.monotonic()-started
                    metrics['secondsWasted'] = metrics.get('secondsWasted', 0)+measurement.get('elapsedMs', 0)/1000
                source_error('disk', 'disk.inventory.source', path, started,
                    SourceFailure('timeout', 'source command timed out'), props={**measurement, 'allowanceS': effective})
            if len(done) != len(batch):
                raise SourceFailure('timeout' if code is None else 'missing-total',
                                    'source command timed out' if code is None else 'du did not print a child total', code)
            if deep and len(batch) > 1 and code is not None:
                emit('disk', 'event', 'disk.inventory.source', ok=True,
                     props=dict(source=str(path), completedCount=len(done), partial=bool(denied or uncertain),
                                deniedCount=denied, exitCode=code, **measurement))
        except Exception as exc:
            terminal = len(batch) == 1 and isinstance(exc, SourceFailure) and (
                exc.failure == 'vanished' or exc.failure == 'permission' and getattr(exc, 'denied_only', False))
            failures += int(not terminal)
            timed_out = isinstance(exc, subprocess.TimeoutExpired) or isinstance(exc, SourceFailure) and exc.failure == 'timeout'
            rejected = bool(deep and len(batch) > 1 and isinstance(exc, SourceFailure) and exc.failure in ('exit', 'timeout'))
            if rejected:
                # Unattributable diagnostics must not hide healthy peers day
                # after day. Retry each member singly within the same budget.
                single_paths.update(paths)
            unfinished = next((e for e in batch if e.path not in done), first)
            value = cache.setdefault(unfinished.path, {})
            # Only a full allowance establishes slow/limited. A truncated
            # attempt still rotates, but gets its full allowance next time.
            value['attemptedAt'] = time.time()
            value['partial'] = True
            # Admission uses elapsedMs from completed scans. Cleanup after a
            # timeout can exceed the next allowance, so keep it diagnostic only.
            value['lastAttemptMs'] = (time.monotonic()-started)*1000
            if terminal:
                value.clear()
                value.update(bytes=0, at=time.time(), attemptedAt=time.time(), partial=False,
                             denied=exc.failure == 'permission', deniedCount=int(exc.failure == 'permission'),
                             estimate=exc.failure == 'permission', vanished=exc.failure == 'vanished',
                             lastAttemptMs=(time.monotonic()-started)*1000)
                done.add(unfinished.path)
                completed += 1
                if str(Path(unfinished.path).parent) == inventory_log.root:
                    inventory_log.measured.add(unfinished.path)
            if timed_out:
                if deep:
                    # Batch deadlines and probes cut short by the pass budget
                    # do not establish that this child needs decomposition.
                    effective = exc.timeout if isinstance(exc, subprocess.TimeoutExpired) else effective
                    required = timeout if parts_mode and full_leaf_budget and batches == 0 else allowance
                    full = number(effective) and effective+0.000001 >= required
                    short_probe = (len(batch) == 1 and not parts_mode and full
                                   and number(old.get('elapsedMs')) and effective < 60)
                    if short_probe:
                        value['probeTimeouts'] = value.get('probeTimeouts', 0)+1
                        value['lastProbeS'] = max(value.get('lastProbeS', 0), effective)
                        if full:
                            value['lastTimeoutAt'] = time.time()
                        value['lastTimeoutS'] = effective
                        retry_probe = first.path not in probe_retries
                        probe_retries.add(first.path)
                    elif len(batch) == 1 and full:
                        if parts_mode:
                            inventory_timeout(value)
                        else:
                            value['timeouts'] = value.get('timeouts', 0)+1
                            value['lastTimeoutAt'] = time.time()
                        value['lastTimeoutS'] = effective
                    if short_probe and metrics is not None:
                        metrics['probeTimeouts'] = metrics.get('probeTimeouts', 0)+1
                        metrics['secondsInProbeTimeouts'] = metrics.get('secondsInProbeTimeouts', 0)+time.monotonic()-started
                    if first_attempt and full and metrics is not None:
                        metrics['firstAttemptTimeouts'] = metrics.get('firstAttemptTimeouts', 0)+1
                    if metrics is not None and (full or len(batch) > 1 or parts_mode):
                        metrics['timeouts'] += 1
                        metrics['secondsInTimeouts'] += time.monotonic()-started
                    if metrics is not None:
                        metrics['secondsWasted'] = metrics.get('secondsWasted', 0)+measurement.get('elapsedMs', 0)/1000
                if not deep and timeout+0.000001 >= allowance:
                    value['slow'] = True
                    if allowance == 60:
                        value['limited'] = True
            inventory_log.timing(unfinished.path, max(0, (time.monotonic()-started)*1000))
            failure = source_error('disk', 'disk.inventory.source', unfinished.path, started, exc,
                props={**measurement, 'deniedCount': value.get('deniedCount', 0),
                       'estimate': value.get('estimate', False), **({'allowanceS': effective if deep else timeout} if timed_out else {})})
            if source_failures is not None:
                source_failures.add(failure)
        finally:
            if deep and metrics is not None:
                metrics['cpuSecondsDu'] = metrics.get('cpuSecondsDu', 0)+measurement.get('cpuS', 0)
                metrics['wallSecondsDu'] = metrics.get('wallSecondsDu', 0)+measurement.get('elapsedMs', 0)/1000
            if attempted is not None:
                attempted.update(done)
                unfinished = next((e for e in batch if e.path not in done), None)
                if (unfinished is not None and not rejected and not retry_probe
                        and not (deep and not parts_mode and len(batch) == 1
                                 and inventory_has_timeout(cache.get(unfinished.path, {})))):
                    attempted.add(unfinished.path)
            if checkpoint:
                checkpoint(*inventory_status(cache, entries, listed, time.time(), completed, failures, freshness_s, root=path))
        batches += 1
        if max_batches is not None and batches >= max_batches:
            break
        if deep and len(batch) > 1 and len(done) != len(batch):
            # Rows before the interrupted child are complete. Give the untouched
            # suffix a turn in this pass rather than dropping the whole batch.
            unfinished = [e for e in batch if e.path not in done]
            if unfinished:
                if rejected:
                    # Isolate untouched peers before another batch can hide
                    # them. Only confirmed child timeouts move to parts.
                    retry = [e for e in unfinished if not inventory_has_timeout(cache.get(e.path, {}))]
                    descended = [e for e in unfinished if inventory_has_timeout(cache.get(e.path, {}))]
                    selected = retry+selected+descended
                else:
                    selected = unfinished[1:]+selected
        elif deep and len(batch) == 1 and not parts_mode and (retry_probe or inventory_has_timeout(cache.get(first.path, {}))) and first.path not in done:
            if attempted is not None:
                attempted.discard(first.path)
            selected.append(first)
        if turn_seconds is not None and time.monotonic()-turn_started >= turn_seconds:
            break
    return inventory_status(cache, entries, listed, time.time(), completed, failures, freshness_s, root=path)


def inventory_parts(entry, run, deadline, cache, checkpoint, entries, listed, metrics, part_work, inventory_log=None):
    inventory_log = inventory_log if inventory_log is not None else InventoryLog(Path(entry.path).parent, cache)
    value = cache[entry.path]
    if inventory_backed_off(value, time.time()):
        return False
    previous_value = dict(value)
    value.update(partial=True, attemptedAt=time.time())
    # A previous whole-child measurement must not masquerade as the sum of an
    # unfinished decomposition, even when the process dies at the next command.
    value.pop('bytes', None)
    value.pop('at', None)
    parts = value.setdefault('parts', {})
    value.setdefault('partsDone', 0)
    value.setdefault('partsTotal', len(parts))
    work = part_work.setdefault(entry.path, dict(attempted=set(), seconds=0, singles=set()))
    work['completed'] = False
    if work['seconds'] >= DEEP_CHILD_CAP_S:
        return False
    child_deadline = time.monotonic()+DEEP_CHILD_CAP_S-work['seconds']
    full_leaf_budget = work['seconds'] == 0 and deadline >= child_deadline
    deadline = min(deadline, child_deadline)
    started = time.monotonic()
    try:
        own = deadline_call(deadline, os.lstat, entry.path)
    except Exception as exc:
        if isinstance(exc, FileNotFoundError) and confirmed_absent(entry.path, exc):
            value.clear()
            value.update(bytes=0, at=time.time(), attemptedAt=time.time(), partial=False, vanished=True)
        elif isinstance(exc, PermissionError):
            value.clear()
            value.update(bytes=0, at=time.time(), attemptedAt=time.time(), partial=False,
                         denied=True, deniedCount=1, estimate=True)
        value['lastAttemptMs'] = (time.monotonic()-started)*1000
        inventory_log.timing(entry.path, max(0, (time.monotonic()-started)*1000))
        source_error('disk', 'disk.inventory.source', entry.path, started, exc)
        if checkpoint:
            checkpoint(*inventory_status(cache, entries, listed, time.time(), root=Path(entry.path).parent))
        return False
    if not stat.S_ISDIR(own.st_mode):
        value['isDirectory'] = False
        for field in ('parts', 'partsDone', 'partsTotal'):
            value.pop(field, None)
        timeout = max(0, deadline-time.monotonic())
        measurement = {}
        try:
            total, denied, code = du_total(Path(entry.path), run, timeout, measurement)
            value.update(bytes=total, at=time.time(), partial=False, isDirectory=False, deniedCount=denied,
                         elapsedMs=(time.monotonic()-started)*1000,
                         denied=bool(denied), estimate=bool(denied))
            inventory_log.child(entry.path, total, previous_value, (time.monotonic()-started)*1000,
                                denied=denied, code=code, measurement=measurement)
            value.pop('nextAttemptAt', None)
            value.pop('leafTimeouts', None)
            value.pop('limited', None)
            value.pop('slow', None)
            for field in ('parts', 'partsDone', 'partsTotal'):
                value.pop(field, None)
        except Exception as exc:
            if isinstance(exc, SourceFailure) and (exc.failure == 'vanished' or getattr(exc, 'denied_only', False)):
                value.clear()
                value.update(bytes=0, at=time.time(), attemptedAt=time.time(), partial=False,
                             denied=exc.failure == 'permission', deniedCount=int(exc.failure == 'permission'),
                             estimate=exc.failure == 'permission', vanished=exc.failure == 'vanished',
                             isDirectory=False)
            if isinstance(exc, subprocess.TimeoutExpired):
                if exc.timeout+0.000001 >= (timeout if full_leaf_budget else DEEP_CHILD_CAP_S):
                    inventory_timeout(value)
                value['lastTimeoutS'] = exc.timeout
                if metrics is not None:
                    metrics['timeouts'] += 1
                    metrics['secondsInTimeouts'] += time.monotonic()-started
                    metrics['secondsWasted'] = metrics.get('secondsWasted', 0)+measurement.get('elapsedMs', 0)/1000
            source_error('disk', 'disk.inventory.source', entry.path, started, exc,
                props={**measurement, **({'allowanceS': exc.timeout} if isinstance(exc, subprocess.TimeoutExpired) else {})})
        finally:
            if metrics is not None:
                metrics['cpuSecondsDu'] = metrics.get('cpuSecondsDu', 0)+measurement.get('cpuS', 0)
                metrics['wallSecondsDu'] = metrics.get('wallSecondsDu', 0)+measurement.get('elapsedMs', 0)/1000
        value['lastAttemptMs'] = (time.monotonic()-started)*1000
        inventory_log.timing(entry.path, value['lastAttemptMs'])
        if checkpoint:
            checkpoint(*inventory_status(cache, entries, listed, time.time(), root=Path(entry.path).parent))
        return False
    listing = inventory_listing(entry.path, min(deadline, time.monotonic()+2))
    part_entries, part_listed = listing
    failure = getattr(listing, 'failure', None)
    if isinstance(failure, PermissionError) or (isinstance(failure, FileNotFoundError)
                                               and confirmed_absent(entry.path, failure)):
        denied = isinstance(failure, PermissionError)
        value.clear()
        value.update(bytes=0, at=time.time(), attemptedAt=time.time(), partial=False,
                     denied=denied, deniedCount=int(denied), estimate=denied, vanished=not denied,
                     isDirectory=True, lastAttemptMs=(time.monotonic()-started)*1000)
        if checkpoint:
            checkpoint(*inventory_status(cache, entries, listed, time.time(), root=Path(entry.path).parent))
        return False
    inventory_log.timing(entry.path, max(0, (time.monotonic()-started)*1000))
    if part_listed:
        present = {part.path for part in part_entries}
        for key in set(parts)-present:
            parts.pop(key)
    value.update(partsTotal=len(part_entries), partsDone=0)
    if metrics is not None:
        metrics['childrenDescended'].add(entry.path)

    def save_parts(total=None, status=None, children=None):
        value['partsDone'] = sum(not inventory_needs_measurement(parts.get(p.path), time.time(), INVENTORY_PARTS_FRESH_S)
                                 for p in part_entries)
        emit('disk', 'event', 'disk.deep.parts', props=dict(source=entry.path,
             partsDone=value['partsDone'], partsTotal=value['partsTotal'], partial=value['partial'],
             partsFreshnessS=INVENTORY_PARTS_FRESH_S))
        if checkpoint:
            checkpoint(*inventory_status(cache, entries, listed, time.time(), root=Path(entry.path).parent))

    save_parts()
    if not part_listed:
        return False
    before = {key: v.get('at') for key, v in parts.items()}
    try:
        big_root_inventory(Path(entry.path), run, deadline, parts, (part_entries, True),
            deep=True, checkpoint=save_parts, max_batches=1, parts_mode=True, metrics=metrics,
            attempted=work['attempted'], single_paths=work['singles'], inventory_log=inventory_log,
            full_leaf_budget=full_leaf_budget)
    finally:
        work['seconds'] += time.monotonic()-started
        value['lastAttemptMs'] = work['seconds']*1000
        inventory_log.timing(entry.path, value['lastAttemptMs'])
        if metrics is not None:
            metrics['partsMeasured'] += sum(v.get('at') != before.get(key) and number(v.get('at'))
                                            for key, v in parts.items())
    save_parts()
    if value['partsDone'] != value['partsTotal']:
        return (work['seconds'] < DEEP_CHILD_CAP_S and any(p.path not in work['attempted']
                and not inventory_backed_off(parts.get(p.path, {}), time.time())
                and inventory_needs_measurement(parts.get(p.path), time.time(), INVENTORY_PARTS_FRESH_S)
                for p in part_entries))
    try:
        total = sum(v['bytes'] for v in parts.values()) + ((own.st_blocks*512+1023)//1024)*1024
        value.update(bytes=total, at=min((v['at'] for v in parts.values()), default=time.time()),
                     partial=False, isDirectory=True, elapsedMs=work['seconds']*1000,
                     deniedCount=sum(v.get('deniedCount', 0) for v in parts.values()),
                     denied=any(v.get('denied') for v in parts.values()),
                     estimate=any(v.get('estimate') for v in parts.values()))
        # Aggregation can expire this total during sibling work before the
        # scheduler sees it; retain the completion milestone for requeueing.
        work['completed'] = True
        inventory_log.child(entry.path, total, previous_value, work['seconds']*1000)
        value.pop('limited', None)
        value.pop('slow', None)
    except Exception as exc:
        source_error('disk', 'disk.inventory.source', entry.path, time.monotonic(), exc)
    save_parts()
    return False


def disk_throttle(command):
    # Disk policy only: background scheduling (-b) can stall at high load.
    return (['/usr/sbin/taskpolicy', '-d', 'throttle', *command]
            if sys.platform == 'darwin' else command)


def directory_inventory(paths=None, run=subprocess.run, deadline=None):
    started = time.monotonic()
    with inventory_lock() as acquired:
        if acquired is not False:
            def locked_run(command, **kwargs):
                return run(disk_throttle(command), pass_fds=(acquired,), **kwargs)
            return _directory_inventory(paths, locked_run, deadline)
        previous = read_state('disk-inventory')
        roots = list(DIRECTORY_ROOTS if paths is None else paths)
        sizes, flags = inventory_skipped_logs(roots, previous, 'deep_pass_running')
        root_props = {str(p): flags[str(p)] for p in roots}
        with_denied = sum(bool(v.get('completeWithDenied')) for v in flags.values())
        emit('disk', 'perf', 'disk.inventory', duration_ms=(time.monotonic()-started)*1000,
             props=dict(duMode=previous.get('duMode'), skipReason='deep_pass_running',
                        count=len(sizes), bytes=sum(sizes.values()),
                        rootsComplete=sum(not flags[str(p)]['partial'] for p in roots)+with_denied,
                        rootsCompleteWithDenied=with_denied, roots=root_props,
                        rootsPartial=sum(flags[str(p)]['partial'] for p in roots)-with_denied))


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
    inventory_logs = {str(path): InventoryLog(path, child_state[str(path)]) for path in roots}
    def scan(path, stop, pending_only=False, refresh_only=False):
        key = str(path)
        scan_started = time.monotonic()
        try:
            total, status, measured = big_root_inventory(path, run, stop, child_state[key], listings[key],
                pending_only, refresh_only, inventory_log=inventory_logs[key], source_failures=source_failures[key])
        finally:
            inventory_logs[key].elapsed_ms += max(0, (time.monotonic()-scan_started)*1000)
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
                   and not inventory_deep_owned(child_state[key].get(e.path,{}), time.time())
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
    refresh_roots = [(path, inventory_refresh_entries(listings[str(path)][0], child_state[str(path)], now, root=path))
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
    root_props = {}
    for path in roots:
        key = str(path)
        status = flags[key]
        # A cached parent may expire while a peer uses its scan allowance.
        # Rebuild the derived totals from current freshness before persisting.
        total, status, measured = inventory_status(child_state[key], *listings[key], time.time(),
                                                  status['completedCount'], status['failedCount'], root=path)
        children[key] = measured
        root_props[key] = dict(inventory_diagnostics(child_state[key], time.time()),
                               completeWithDenied=status['completeWithDenied'])
        if measured or not status['partial']:
            sizes[key] = total
        else:
            sizes.pop(key, None)
        if migrated:
            status['partial'] = True
        if status['partial']:
            partials[key] = status
        if status['failedCount'] or status['unmeasuredCount']:
            errors += 1
            source_error('disk','disk.inventory.source',path,started,
                         SourceFailure('partial','directory total is incomplete'),
                         dict(status, **({'bytes': sizes[key]} if key in sizes else {})))
        elif status['partial']:
            emit('disk','event','disk.inventory.source',ok=True,props=dict(source=key,bytes=sizes[key],**status))
        inventory_logs[key].root_event(child_state[key], total, status)
    save_state('disk-inventory',dict(previous, at=time.time(),duMode='links',sizes=sizes,partials=partials,children=children,
        sourceErrors=errors,attemptedAt=attempts,childState=child_state))
    cached = [v for cache in child_state.values() for v in cache.values() if 'bytes' in v]
    scan_ms = (time.monotonic()-started)*1000
    denied_roots = {key for key, failures in source_failures.items() if 'permission' in failures}
    for key, cache in child_state.items():
        pending = list(cache.values())
        while pending:
            value = pending.pop()
            if not isinstance(value, dict):
                continue
            if number(value.get('deniedCount')) and value['deniedCount'] > 0:
                denied_roots.add(key)
                break
            if isinstance(value.get('parts'), dict):
                pending.extend(value['parts'].values())
    with_denied = sum(v['completeWithDenied'] for v in root_props.values())
    emit('disk','error' if errors else 'perf','disk.inventory',ok=not errors,
         duration_ms=scan_ms,
         props=dict(duMode='links',count=len(sizes),sourceErrors=errors,rootsComplete=len(roots)-len(partials)+with_denied,
                    rootsCompleteWithDenied=with_denied, roots=root_props,
                    rootsOk=len(roots)-len(partials),rootsTimeout=sum('timeout' in v for v in source_failures.values()),
                    rootsDenied=len(denied_roots),scanMs=scan_ms,
                    rootsPartial=len(partials)-with_denied,childrenCached=len(cached),
                    oldestChildAgeS=max((max(0,now-v['at']) for v in cached),default=0)),
         error_tag='disk.inventory_failed' if errors else None)

def number(value):
    return finite_number(value) and value >= 0


def storage_value(output, snapshot=False):
    if snapshot:
        lines = output.decode('utf-8').splitlines()
        if not lines or not lines[0].startswith('Snapshots for '):
            raise ValueError('invalid snapshot list')
        snapshots = [line.strip() for line in lines[1:] if line.strip()]
        if any(not re.fullmatch(r'com\.apple\.TimeMachine\.\d{4}-\d{2}-\d{2}-\d{6}(?:\.local)?(?: \(dataless\))?', line)
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
                     and not state.get('estimate') and not state.get('denied') and not state.get('deniedCount')
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
            if not finite_number(stamp) or stamp <= 0:
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
