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
import stat
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


def read_state(name):
    try:
        value = json.loads(state_path(name).read_text())
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


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


DIRECTORY_ROOTS = [Path.home() / 'Library/Caches', Path.home() / '.cache',
                   Path.home() / '.local/share', Path.home() / '.robob',
                   *[Path('/Volumes/ExternalSSD') / name for name in
                     ('wt', 't3code-wt', 'board-wt', 'coord-wt', 'caches', 'crpko-devops/tmp', 'memory-system-backup', 'memory-system-data', 'memory-system-data-v2')]]
SPLIT_ROOTS = (Path.home() / '.local/share', Path.home() / '.robob')


class SourceFailure(Exception):
    def __init__(self, failure, message, exit_code=None):
        super().__init__(message)
        self.failure = failure
        self.message = message
        self.exit_code = exit_code


def stderr_line(value):
    if isinstance(value, bytes):
        value = value.decode(errors='replace')
    lines = (value or '').strip().splitlines()
    return lines[0][:300] if lines else ''


def permission_denied(value):
    return bool(re.search(r'operation not permitted|permission denied', value, re.I))


def source_error(component, name, source, started, exc, **props):
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
                    elapsedMs=max(0, (time.monotonic()-started)*1000), **props),
         error_tag=component+'.source_unavailable', error_message=message)
    return failure


def du_bytes(path, deadline, cap, run):
    remaining = deadline-time.monotonic()
    if remaining <= 0:
        raise SourceFailure('timeout', 'directory inventory budget exhausted')
    result = run(['/usr/bin/du', '-sk', str(path)], capture_output=True, text=True,
                 timeout=min(cap, remaining), env={**os.environ, 'LC_ALL': 'C'})
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


def mapping(value):
    return value if isinstance(value, dict) else {}


def cache_entry(value, now):
    value = mapping(value)
    if (type(value.get('bytes')) is int and value['bytes'] >= 0
            and type(value.get('at')) in (int, float) and 0 <= value['at'] <= now):
        return {**value, 'ageS': now-value['at']}
    return {}


def attempt_time(value):
    return value if type(value) in (int, float) and 0 <= value <= time.time() else 0


def child_inventory(root, previous, deadline, run):
    now = time.time()
    previous = mapping(previous)
    children, failures, denied_count = {}, [], 0
    entries = sorted(root.iterdir(), key=lambda p: (attempt_time(mapping(previous.get(p.name)).get('attemptedAt')), p.name))
    for path in entries:
        started = time.monotonic()
        old = cache_entry(previous.get(path.name), now)
        attempted = started < deadline
        try:
            if not attempted:
                raise SourceFailure('timeout', 'directory inventory budget exhausted')
            st = path.lstat()
            if stat.S_ISDIR(st.st_mode):
                size, denied, code = du_bytes(path, deadline, 20, run)
            else:
                # Allocated bytes match du, including sparse DBs, without opening
                # a database or following a symlink into another inventory root.
                size, denied, code = st.st_blocks*512, 0, 0
            children[path.name] = dict(bytes=size, at=now, ageS=0, attemptedAt=now,
                                       partial=bool(denied), deniedCount=denied)
            denied_count += denied
            if denied:
                emit('disk', 'event', 'disk.inventory.source', ok=True,
                     props=dict(source=str(root), child=path.name, partial=True,
                                bytes=size, deniedCount=denied, exitCode=code,
                                elapsedMs=(time.monotonic()-started)*1000))
        except FileNotFoundError:
            # A child removed since listdir is absent, not a failed measurement.
            continue
        except Exception as exc:
            children[path.name] = {**old, 'attemptedAt': now if attempted else attempt_time(mapping(previous.get(path.name)).get('attemptedAt'))}
            failure = source_error('disk', 'disk.inventory.source', root, started, exc,
                                   child=path.name, cached=bool(old), **({'ageS': old['ageS']} if old else {}))
            failures.append(failure)
    complete = not failures and not any(c.get('partial') for c in children.values())
    return children, failures, denied_count, complete


def directory_inventory(paths=None, run=subprocess.run, split_roots=None):
    started = time.monotonic()
    deadline = started + 300
    sizes, errors = {}, 0
    partials = {}
    previous = mapping(read_state('disk-inventory'))
    attempts = dict(mapping(previous.get('attemptedAt')))
    children = dict(mapping(previous.get('children')))
    split = set(SPLIT_ROOTS if split_roots is None else split_roots)
    mix = dict(rootsOk=0, rootsPartial=0, rootsTimeout=0, rootsDenied=0)
    roots = sorted(DIRECTORY_ROOTS if paths is None else paths, key=lambda p: attempt_time(attempts.get(str(p))))
    for path in roots:
        source_started = time.monotonic()
        failures = []
        denied = 0
        try:
            path.stat()
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise SourceFailure('timeout', 'directory inventory overall budget exhausted')
            attempts[str(path)] = time.time()
            if path in split:
                measured, failures, denied, complete = child_inventory(path, children.get(str(path)), min(deadline, source_started+60), run)
                children[str(path)] = measured
                known = [child for child in measured.values() if 'bytes' in child]
                if known or complete:
                    sizes[str(path)] = sum(child['bytes'] for child in known)
                errors += len(failures)
                if not complete:
                    partials[str(path)] = dict(partial=True, deniedCount=denied,
                                               ageS=max((child['ageS'] for child in known), default=0))
                    mix['rootsPartial'] += 1
            else:
                total, denied, code = du_bytes(path, deadline, 60, run)
                sizes[str(path)] = total
                complete = not denied
                if denied:
                    emit('disk', 'event', 'disk.inventory.source', ok=True,
                         props=dict(source=str(path), partial=True, deniedCount=denied,
                                    bytes=total, exitCode=code,
                                    elapsedMs=(time.monotonic()-source_started)*1000))
                    mix['rootsPartial'] += 1
            if denied:
                partials.setdefault(str(path), dict(partial=True))['deniedCount'] = denied
            mix['rootsOk'] += complete
        except FileNotFoundError as exc:
            if exc.filename == str(path):
                continue
            errors += 1
            failures.append(source_error('disk', 'disk.inventory.source', path, source_started, exc))
        except Exception as exc:
            errors += 1
            failures.append(source_error('disk', 'disk.inventory.source', path, source_started, exc))
        mix['rootsTimeout'] += 'timeout' in failures
        mix['rootsDenied'] += bool(denied or 'permission' in failures)
    now = time.time()
    for root, entries in children.items():
        for name, value in mapping(entries).items():
            fresh = cache_entry(value, now)
            if fresh:
                entries[name] = fresh
    save_state('disk-inventory', dict(at=time.time(), sizes=sizes, partials=partials,
                                    sourceErrors=errors, children=children, attemptedAt=attempts))
    mix['scanMs'] = (time.monotonic()-started)*1000
    emit('disk', 'error' if errors else 'perf', 'disk.inventory', ok=not errors,
         duration_ms=mix['scanMs'], props=dict(count=len(sizes), sourceErrors=errors, **mix),
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


def disk_sample(watch_dir, temp_dir, volumes=('/System/Volumes/Data', '/Volumes/ExternalSSD'), paths=None):
    started = time.monotonic()
    sampled_at = dt.datetime.now(dt.timezone.utc)
    stamp = sampled_at.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    previous = read_state('disk')
    props, errors = {}, 0
    for key, volume in zip(('internalFreeGb', 'externalFreeGb'), volumes):
        try:
            st = os.statvfs(volume)
            props[key] = round(st.f_bavail * st.f_frsize / 1024**3, 3)
        except OSError:
            errors += 1
        old_free = previous.get('free', {})
        old_value = old_free.get(key) if isinstance(old_free, dict) else None
        props[key+'Delta'] = round(props[key]-old_value, 3) if key in props and number(old_value) else None
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
        except FileNotFoundError:
            pass
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
    deltas = [(path, size-old_sizes[path]) for path, size in sizes.items()
              if path in old_sizes and number(old_sizes[path])]
    growers = sorted(((path, delta) for path, delta in deltas if delta > 0), key=lambda x: x[1], reverse=True)[:5]
    for i, (path, delta) in enumerate(growers, 1):
        props['grower%dPath' % i] = path
        props['grower%dDeltaGb' % i] = round(delta / 1024**3, 6)
    movers = []
    if (not props['inventoryStale'] and number(previous.get('inventoryAt'))
            and 0 <= time.time()-previous['inventoryAt'] <= 7200):
        tracked = {str(path) for path in paths} | {str(path) for path in DIRECTORY_ROOTS} | {str(temp_dir)}
        partials = inventory.get('partials', {})
        old_partials = previous.get('inventoryPartials', {})
        uncertain = set(partials if isinstance(partials, dict) else {}) | set(old_partials if isinstance(old_partials, dict) else {})
        movers = sorted(((path, delta) for path, delta in deltas if delta and path in tracked and path not in uncertain),
                        key=lambda item: (-abs(item[1]), item[0]))[:3]
        if movers:
            props.update(topMover1Path=movers[0][0], topMover1GbDelta=round(movers[0][1]/1024**3, 6))
    props.update(count=len(growers), baseline=int(not old_sizes), sourceErrors=errors)
    props.update(storage_probes(volumes, started))
    emit('disk', 'error' if errors else 'perf', 'disk.sample', duration_ms=(time.monotonic()-started)*1000,
         ok=not errors, props=props, error_tag='disk.source_unavailable' if errors else None, now=sampled_at)
    if any(abs(props[key+'Delta'] or 0) >= 20 for key in ('internalFreeGb', 'externalFreeGb')):
        swing = {key: props[key] for key in ('internalFreeGbDelta', 'externalFreeGbDelta')}
        swing.update(previousTs=previous.get('ts'), sampleTs=stamp)
        for i, (path, delta) in enumerate(movers, 1):
            swing['topMover%dPath' % i] = path
            swing['topMover%dGbDelta' % i] = round(delta/1024**3, 6)
        emit('disk', 'event', 'disk.swing', props=swing, now=sampled_at)
    save_state('disk', dict(sizes=sizes, ts=stamp,
                           free={key: props[key] for key in ('internalFreeGb', 'externalFreeGb') if key in props},
                           inventoryPartials=inventory.get('partials', {}),
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
