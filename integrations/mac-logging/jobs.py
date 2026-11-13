#!/usr/bin/python3
"""Shell adapters. All instrumentation, including measurement, fails open."""
import json
import errno
import os
import re
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
        return json.loads(state_path(name).read_text())
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


def big_root_inventory(path, run, deadline):
    total, completed, failed, denied = 0, 0, 0, 0
    children = {}
    # A slow subtree must not discard every other child's completed total.
    scan_started = time.monotonic()
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                child = Path(entry.path)
                started = time.monotonic()
                try:
                    size, unreadable, code = du_total(child, run, min(15, deadline-started))
                    total += size
                    completed += 1
                    denied += unreadable
                    children[str(child)] = size
                    emit('disk', 'event', 'disk.inventory.source', ok=True,
                         props=dict(source=str(child), bytes=size, partial=bool(unreadable),
                                    deniedCount=unreadable, exitCode=code,
                                    elapsedMs=(time.monotonic()-started)*1000))
                except Exception as exc:
                    failed += 1
                    source_error('disk', 'disk.inventory.source', child, started, exc)
                if time.monotonic() >= deadline:
                    # Name the root as incomplete without enumerating an unbounded
                    # remainder. The child error identifies the subtree that stalled.
                    failed += 1
                    break
    except OSError as exc:
        failed += 1
        source_error('disk', 'disk.inventory.source', path, scan_started, exc)
    return total, dict(partial=bool(failed or denied), failedCount=failed,
                      completedCount=completed, deniedCount=denied), children


def directory_inventory(paths=None, run=subprocess.run, deadline=None):
    started = time.monotonic()
    deadline = min(started + 210, deadline) if deadline is not None else started + 210
    sizes, errors, partials, children = {}, 0, {}, {}
    for path in DIRECTORY_ROOTS if paths is None else paths:
        source_started = time.monotonic()
        try:
            path.stat()
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise SourceFailure('timeout', 'directory inventory overall budget exhausted')
            if path in BIG_ROOTS:
                total, flags, measured = big_root_inventory(path, run, min(deadline, source_started+60))
                children[str(path)] = measured
                if flags['completedCount'] or not flags['failedCount']:
                    sizes[str(path)] = total
                if flags['partial']:
                    partials[str(path)] = flags
                props = dict(bytes=total, **flags)
                if flags['failedCount']:
                    errors += 1
                    source_error('disk', 'disk.inventory.source', path, source_started,
                                 SourceFailure('partial', 'directory total is incomplete'), props)
                else:
                    emit('disk', 'event', 'disk.inventory.source', ok=True,
                         props=dict(source=str(path), elapsedMs=(time.monotonic()-source_started)*1000, **props))
                continue
            total, denied, code = du_total(path, run, min(60, remaining))
            sizes[str(path)] = total
            if code:
                partials[str(path)] = dict(partial=True, deniedCount=denied)
                emit('disk', 'event', 'disk.inventory.source', ok=True,
                     props=dict(source=str(path), partial=True, deniedCount=denied,
                                bytes=total, exitCode=code,
                                elapsedMs=(time.monotonic()-source_started)*1000))
        except FileNotFoundError as exc:
            if exc.filename == str(path):
                continue
            errors += 1
            source_error('disk', 'disk.inventory.source', path, source_started, exc)
        except Exception as exc:
            errors += 1
            source_error('disk', 'disk.inventory.source', path, source_started, exc)
    save_state('disk-inventory', dict(at=time.time(), sizes=sizes, partials=partials,
                                    children=children, sourceErrors=errors))
    emit('disk', 'error' if errors else 'perf', 'disk.inventory', ok=not errors,
         duration_ms=(time.monotonic()-started)*1000, props={'count': len(sizes), 'sourceErrors': errors},
         error_tag='disk.inventory_failed' if errors else None)


def disk_sample(watch_dir, temp_dir, volumes=('/System/Volumes/Data', '/Volumes/ExternalSSD'), paths=None):
    started = time.monotonic()
    props, errors = {}, 0
    for key, volume in zip(('internalFreeGb', 'externalFreeGb'), volumes):
        try:
            st = os.statvfs(volume)
            props[key] = round(st.f_bavail * st.f_frsize / 1024**3, 3)
        except OSError:
            errors += 1
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
    if inventory.get('at'):
        props['inventoryAgeS'] = max(0, time.time()-inventory['at'])
        props['inventoryStale'] = props['inventoryAgeS'] > 7200
        sizes.update(inventory.get('sizes', {}))
    previous_state = read_state('disk')
    previous = previous_state.get('sizes', {})
    incomplete = set(inventory.get('partials', {})) | set(previous_state.get('partials', {}))
    growers = sorted(((path, size - previous[path]) for path, size in sizes.items() if path in previous and path not in incomplete and size > previous[path]), key=lambda x: x[1], reverse=True)[:5]
    for i, (path, delta) in enumerate(growers, 1):
        props['grower%dPath' % i] = path
        props['grower%dDeltaGb' % i] = round(delta / 1024**3, 6)
    props.update(count=len(growers), baseline=int(not previous), sourceErrors=errors)
    emit('disk', 'error' if errors else 'perf', 'disk.sample', duration_ms=(time.monotonic()-started)*1000,
         ok=not errors, props=props, error_tag='disk.source_unavailable' if errors else None)
    save_state('disk', dict(sizes=sizes, partials=inventory.get('partials', {})))


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
