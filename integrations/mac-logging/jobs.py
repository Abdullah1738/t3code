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
from toollog import emit, directory, private_dir


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


DIRECTORY_ROOTS = [Path.home() / 'Library/Caches', Path.home() / '.cache',
                   Path.home() / '.local/share', Path.home() / '.robob',
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


def source_error(component, name, source, started, exc):
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
                    elapsedMs=max(0, (time.monotonic()-started)*1000)),
         error_tag=component+'.source_unavailable', error_message=message)


def directory_inventory(paths=None, run=subprocess.run):
    started = time.monotonic()
    deadline = started + 300
    sizes, errors = {}, 0
    partials = {}
    for path in DIRECTORY_ROOTS if paths is None else paths:
        source_started = time.monotonic()
        try:
            path.stat()
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise SourceFailure('timeout', 'directory inventory overall budget exhausted')
            result = run(['/usr/bin/du', '-sk', str(path)], capture_output=True, text=True,
                         timeout=min(60, remaining), env={**os.environ, 'LC_ALL': 'C'})
            stderr = getattr(result, 'stderr', '') or ''
            denied = sum(permission_denied(line) for line in stderr.splitlines())
            other_errors = any(line.strip() and not permission_denied(line) for line in stderr.splitlines())
            message = stderr_line(stderr)
            if result.returncode and (result.returncode != 1 or not denied or other_errors):
                failure = 'permission' if not result.stdout.strip() and denied else 'exit'
                raise SourceFailure(failure, message or 'du exited without a total', result.returncode)
            # Match the requested root, not an arbitrary number printed by du.
            total = None
            for line in result.stdout.splitlines():
                fields = line.split('\t', 1)
                if len(fields) == 2 and fields[1] == str(path):
                    if not fields[0].isdigit():
                        raise SourceFailure('parse', message or 'invalid du total', result.returncode)
                    total = int(fields[0])*1024
            if total is None:
                failure = 'permission' if denied else 'missing-total' if not result.stdout.strip() or '\t' in result.stdout else 'parse'
                raise SourceFailure(failure, message or 'du did not print a root total', result.returncode)
            sizes[str(path)] = total
            if result.returncode:
                partials[str(path)] = dict(partial=True, deniedCount=denied)
                emit('disk', 'event', 'disk.inventory.source', ok=True,
                     props=dict(source=str(path), partial=True, deniedCount=denied,
                                bytes=total, exitCode=result.returncode,
                                elapsedMs=(time.monotonic()-source_started)*1000))
        except FileNotFoundError as exc:
            if exc.filename == str(path):
                continue
            errors += 1
            source_error('disk', 'disk.inventory.source', path, source_started, exc)
        except Exception as exc:
            errors += 1
            source_error('disk', 'disk.inventory.source', path, source_started, exc)
    save_state('disk-inventory', dict(at=time.time(), sizes=sizes, partials=partials, sourceErrors=errors))
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
    previous = read_state('disk').get('sizes', {})
    growers = sorted(((path, size - previous[path]) for path, size in sizes.items() if path in previous and size > previous[path]), key=lambda x: x[1], reverse=True)[:5]
    for i, (path, delta) in enumerate(growers, 1):
        props['grower%dPath' % i] = path
        props['grower%dDeltaGb' % i] = round(delta / 1024**3, 6)
    props.update(count=len(growers), baseline=int(not previous), sourceErrors=errors)
    emit('disk', 'error' if errors else 'perf', 'disk.sample', duration_ms=(time.monotonic()-started)*1000,
         ok=not errors, props=props, error_tag='disk.source_unavailable' if errors else None)
    save_state('disk', dict(sizes=sizes))


def backup_run(target, start, restic_rc, exit_code, snapshot_at, summary):
    now = time.time()
    previous = read_state('backup-' + target)
    last = float(snapshot_at) if float(snapshot_at) > 0 else previous.get('snapshotAt')
    if last:
        save_state('backup-' + target, dict(snapshotAt=last))
    try:
        summary = json.loads(summary)
    except ValueError:
        summary = {}
    props = dict(target=target, resticExitCode=int(restic_rc), exitCode=int(exit_code), skipped=int(int(restic_rc) == -1 and int(exit_code) == 0))
    # Only counters are copied from restic's summary, never paths/errors or command output.
    for key, source in [('bytes', 'total_bytes_processed'), ('files', 'total_files_processed')]:
        if type(summary.get(source)) is int:
            props[key] = summary[source]
    if last:
        props['snapshotAgeS'] = max(0, now-last)
    emit('backup', 'error' if int(exit_code) else 'perf', 'backup.run',
         duration_ms=max(0, (now-float(start))*1000), ok=int(exit_code)==0, props=props,
         error_tag='backup.failed' if int(exit_code) else None)


def main(argv):
    try:
        if argv[0] == 'disk':
            disk_sample(*argv[1:3])
        elif argv[0] == 'alert':
            ok = argv[1] == '0'
            emit('disk', 'event' if ok else 'error', 'disk.alert', ok=ok,
                 props={'exitCode': int(argv[1])}, error_tag=None if ok else 'disk.alert_failed')
        elif argv[0] == 'backup':
            backup_run(*argv[1:6], sys.stdin.read(16384))
    except Exception:
        pass


if __name__ == '__main__':
    main(sys.argv[1:])
