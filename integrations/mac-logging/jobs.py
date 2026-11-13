#!/usr/bin/python3
"""Shell adapters. All instrumentation, including measurement, fails open."""
import json
import datetime as dt
import errno
import fcntl
import math
import os
import plistlib
import re
import signal
from pathlib import Path
import sys
import subprocess
import tempfile
import time
from toollog import emit, directory, private_dir, SKIP_REASONS


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


BIG_ROOTS = {Path.home() / '.local/share', Path.home() / '.robob'}
DIRECTORY_ROOTS = [Path.home() / '.local/share', Path.home() / '.robob',
                   Path.home() / 'Library/Caches', Path.home() / '.cache',
                   *[Path('/Volumes/ExternalSSD') / name for name in
                     ('wt', 't3code-wt', 'board-wt', 'coord-wt', 'caches', 'crpko-devops/tmp', 'memory-system-backup', 'memory-system-data', 'memory-system-data-v2')]]


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
    if timeout <= 0:
        raise SourceFailure('timeout', 'directory inventory overall budget exhausted')
    result = run(['/usr/bin/du', '-sk', str(path)], capture_output=True, text=True,
                 timeout=timeout, env={**os.environ, 'LC_ALL': 'C'})
    stderr = getattr(result, 'stderr', '') or ''
    denied = sum(permission_denied(line) for line in stderr.splitlines())
    other_errors = any(line.strip() and not permission_denied(line) for line in stderr.splitlines())
    message = stderr_line(stderr)
    if result.returncode and (result.returncode != 1 or not denied or other_errors):
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


def big_root_inventory(path, run, deadline, cache=None):
    total, completed, failed, denied = 0, 0, 0, 0
    children = {}
    cache = {} if cache is None else cache
    now = time.time()
    for key, value in list(cache.items()):
        if not isinstance(value, dict):
            cache.pop(key)
            continue
        attempted = value.get('attemptedAt', 0)
        value['attemptedAt'] = attempted if number(attempted) and attempted <= now else 0
        if not number(value.get('bytes')) or not number(value.get('at')) or value['at'] > now:
            cache[key] = dict(attemptedAt=value['attemptedAt'])
    # A slow subtree must not discard every other child's completed total.
    scan_started = time.monotonic()
    entries, listed = [], False
    try:
        with deadline_call(deadline, os.scandir, path) as listing:
            deadline_call(deadline, entries.extend, listing)
        listed = True
    except (OSError, SourceFailure) as exc:
        failed += 1
        source_error('disk', 'disk.inventory.source', path, scan_started, exc)
    if listed:
        present = {entry.path for entry in entries}
        for key in set(cache)-present:
            cache.pop(key)
    entries.sort(key=lambda entry: cache.get(entry.path, {}).get('attemptedAt', 0))
    for turn, entry in enumerate(entries):
        child = Path(entry.path)
        started = time.monotonic()
        if started >= deadline:
            failed += 1
            break
        old = cache.get(str(child), {})
        timeout = min(15, deadline-started)
        try:
            size, unreadable, code = du_total(child, run, timeout)
            is_directory = entry.is_dir(follow_symlinks=False)
            completed += 1
            denied += unreadable
            cache[str(child)] = dict(bytes=size, at=now, attemptedAt=now,
                                     partial=bool(unreadable), isDirectory=is_directory)
            children[str(child)] = size
            emit('disk', 'event', 'disk.inventory.source', ok=True,
                 props=dict(source=str(child), bytes=size, partial=bool(unreadable),
                            deniedCount=unreadable, exitCode=code,
                            elapsedMs=(time.monotonic()-started)*1000))
        except Exception as exc:
            failed += 1
            # A shortened timeout must not spend this child's next full turn.
            attempted_at = now if turn == 0 or timeout >= 15 else old.get('attemptedAt', 0)
            if old:
                old['attemptedAt'] = attempted_at
            else:
                # Attempts need to rotate even before the first total.
                cache[str(child)] = dict(attemptedAt=attempted_at)
            source_error('disk', 'disk.inventory.source', child, started, exc)
        if time.monotonic() >= deadline:
            # Name the root as incomplete without enumerating an unbounded
            # remainder. The child error identifies the subtree that stalled.
            failed += 1
            break
    total = sum(value['bytes'] for value in cache.values() if 'bytes' in value)
    cached = [value for value in cache.values() if 'bytes' in value and value['at'] < now]
    return total, dict(partial=bool(failed or denied), failedCount=failed,
                      completedCount=completed, deniedCount=denied, cachedCount=len(cached),
                      ageS=max((now-value['at'] for value in cached), default=0)), children


def directory_inventory(paths=None, run=subprocess.run, deadline=None):
    started = time.monotonic()
    deadline = min(started + 210, deadline) if deadline is not None else started + 210
    sizes, errors, partials, children = {}, 0, {}, {}
    previous = read_state('disk-inventory')
    attempts = previous.get('attemptedAt', {})
    attempts = dict(attempts) if isinstance(attempts, dict) else {}
    child_state = previous.get('childState', {})
    child_state = child_state if isinstance(child_state, dict) else {}
    old_sizes = previous.get('sizes', {})
    old_sizes = old_sizes if isinstance(old_sizes, dict) else {}
    now = time.time()
    roots = list(DIRECTORY_ROOTS if paths is None else paths)
    for path in roots:
        key = str(path)
        # Migrate installed state, which has sizes but no attempt timestamps.
        value = attempts.get(key, previous.get('at', 0) if key in old_sizes else 0)
        attempts[key] = value if number(value) and value <= now else 0
    roots.sort(key=lambda path: attempts[str(path)])
    turn_budget = min(60, max(0, deadline-started))
    for turn, path in enumerate(roots, 1):
        source_started = time.monotonic()
        try:
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise SourceFailure('timeout', 'directory inventory overall budget exhausted')
            # Full failed attempts rotate; shortened timeouts keep priority.
            if turn == 1 or remaining >= turn_budget:
                attempts[str(path)] = time.time()
            emit('disk', 'event', 'disk.inventory.turn',
                 props=dict(source=str(path), turn=turn))
            deadline_call(deadline, path.stat)
            if path in BIG_ROOTS:
                cache = child_state.setdefault(str(path), {})
                if not isinstance(cache, dict):
                    cache = child_state[str(path)] = {}
                total, flags, measured = big_root_inventory(path, run, min(deadline, source_started+60), cache)
                children[str(path)] = measured
                if flags['completedCount'] or flags['cachedCount'] or not flags['failedCount']:
                    sizes[str(path)] = total
                if flags['partial']:
                    partials[str(path)] = flags
                props = dict(bytes=total, **flags)
                if flags['failedCount']:
                    errors += 1
                    source_error('disk', 'disk.inventory.source', path, source_started,
                                 SourceFailure('partial', 'directory total is incomplete'), props)
                else:
                    attempts[str(path)] = time.time()
                    emit('disk', 'event', 'disk.inventory.source', ok=True,
                         props=dict(source=str(path), elapsedMs=(time.monotonic()-source_started)*1000, **props))
                continue
            total, denied, code = du_total(path, run, min(60, deadline-time.monotonic()))
            sizes[str(path)] = total
            attempts[str(path)] = time.time()
            if code:
                partials[str(path)] = dict(partial=True, deniedCount=denied)
                emit('disk', 'event', 'disk.inventory.source', ok=True,
                     props=dict(source=str(path), partial=True, deniedCount=denied,
                                bytes=total, exitCode=code,
                                elapsedMs=(time.monotonic()-source_started)*1000))
        except FileNotFoundError as exc:
            if confirmed_absent(path, exc):
                sizes[str(path)] = 0
                attempts[str(path)] = time.time()
                continue
            errors += 1
            source_error('disk', 'disk.inventory.source', path, source_started, exc)
        except Exception as exc:
            errors += 1
            source_error('disk', 'disk.inventory.source', path, source_started, exc)
    save_state('disk-inventory', dict(at=time.time(), sizes=sizes, partials=partials,
                                    children=children, sourceErrors=errors, attemptedAt=attempts,
                                    childState=child_state))
    emit('disk', 'error' if errors else 'perf', 'disk.inventory', ok=not errors,
         duration_ms=(time.monotonic()-started)*1000, props={'count': len(sizes), 'sourceErrors': errors},
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
    candidates = {}
    roots = [p for p in DIRECTORY_ROOTS
             if p.is_relative_to('/Volumes/ExternalSSD') == (volume == 'external')]
    complete = bool(fresh and roots and inventory.get('sourceErrors') == 0 and not partials)
    for root in roots:
        key = str(root)
        if not number(sizes.get(key)) or key in partials:
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
                complete = False
            elif state['isDirectory']:
                candidates[path] = size
    return dict(at=at if fresh else None, sizes=candidates, complete=complete)


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
                          and 0 <= sampled_at.timestamp()-before_at <= 7200 and before_at < after_at)
            before_sizes = before.get('sizes', {})
            before_sizes = before_sizes if isinstance(before_sizes, dict) else {}
            growth = sorted(((path, size-before_sizes[path]) for path, size in current_inventory['sizes'].items()
                             if comparable and number(before_sizes.get(path)) and size > before_sizes[path]),
                            key=lambda item: (-item[1], item[0]))[:5]
            drop = dict(volume=prefix, deltaGb=props[key+'Delta'], windowS=props[prefix+'DeltaWindowS'],
                        deltaFromTs=props[prefix+'DeltaFromTs'],
                        purgeableGb=props.get(prefix+'PurgeableGb'),
                        localSnapshotCount=props.get(prefix+'LocalSnapshotCount'),
                        inventoryComplete=bool(comparable and before.get('complete') is True
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
                           partials=inventory.get('partials', {}),
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


def backup_snapshot_age(target, snapshot_at):
    if float(snapshot_at) > 0:
        return max(0, time.time()-float(snapshot_at))
    # Never run a password command, read a password file or open an interactive
    # prompt for instrumentation. A caller-supplied password allows a bounded,
    # lock-free read; otherwise the age is unknown, not a cached success time.
    if not os.environ.get('RESTIC_PASSWORD') or not os.environ.get('RESTIC_REPOSITORY'):
        return None
    env = dict(os.environ)
    for key in ('RESTIC_PASSWORD_COMMAND', 'RESTIC_PASSWORD_FILE'):
        env.pop(key, None)
    tag = {'memory': 'memory-live', 'health': 'health-data'}[target]
    result = subprocess.run([os.environ.get('MAC_LOG_RESTIC', '/opt/homebrew/bin/restic'),
                             '--no-lock', 'snapshots', '--host', 'ardud-mac', '--tag', tag,
                             '--latest', '1', '--json'], env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=5)
    if result.returncode:
        return None
    import datetime as dt
    snapshots = json.loads(result.stdout)
    newest = max(dt.datetime.fromisoformat(s['time'].replace('Z', '+00:00')).timestamp() for s in snapshots)
    return max(0, time.time()-newest)


def backup_run(target, start, restic_rc, exit_code, snapshot_at, summary, skip_reason='', lock_path=''):
    now = time.time()
    if target not in ('health', 'memory', 'other'):
        return
    try:
        summary = json.loads(summary)
    except ValueError:
        summary = {}
    ran = str(restic_rc) not in ('', '-1')
    if not ran and not skip_reason:
        skip_reason = 'other'
    if skip_reason and skip_reason not in SKIP_REASONS:
        skip_reason = 'other'
    props = dict(target=target, exitCode=int(exit_code), skipped=int(bool(skip_reason)))
    if ran:
        props['resticExitCode'] = int(restic_rc)
    ok = int(exit_code) == 0
    tag = None if ok else 'backup.failed'
    if skip_reason:
        props['skipReason'] = skip_reason
        ok, tag = False, 'backup.skipped_' + skip_reason
        if skip_reason == 'lock_held':
            try:
                lock = Path(lock_path)
                props['lockAgeS'] = max(0, int(now-lock.stat().st_mtime))
                holder = (lock/'pid').read_text().strip()
                props['lockPid'] = int(holder) if re.fullmatch(r'[0-9]{1,10}', holder) else 0
            except (OSError, ValueError):
                props.setdefault('lockPid', 0)
            # An unreadable age cannot prove that this is a healthy skip.
            ok = int(exit_code) == 0 and 'lockAgeS' in props and props['lockAgeS'] < 7200
            tag = (None if ok else 'backup.skip_stale_lock' if props.get('lockAgeS', -1) >= 7200
                   else 'backup.skipped_lock_held')
    # Only counters are copied from restic's summary, never paths/errors or command output.
    for key, source in [('bytes', 'total_bytes_processed'), ('files', 'total_files_processed')]:
        if type(summary.get(source)) is int:
            props[key] = summary[source]
    try:
        age = backup_snapshot_age(target, snapshot_at)
        if age is not None:
            props['snapshotAgeS'] = age
    except Exception:
        pass
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
            backup_run(*argv[1:6], sys.stdin.read(16384), *argv[6:8])
        elif argv[0] == 'backup-reason':
            print(backup_reason(*argv[1:3], sys.stdin.read(16384)))
        elif argv[0] == 'backup-restic-exit':
            print(backup_restic_exit(*argv[1:3], sys.stdin.read(16384)))
    except Exception:
        pass


if __name__ == '__main__':
    main(sys.argv[1:])
