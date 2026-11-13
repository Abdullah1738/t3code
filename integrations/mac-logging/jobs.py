#!/usr/bin/python3
"""Shell adapters. All instrumentation, including measurement, fails open."""
import json
import os
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


def directory_inventory(paths=None, run=subprocess.run):
    started = time.monotonic()
    sizes, errors = {}, 0
    for path in DIRECTORY_ROOTS if paths is None else paths:
        if not path.exists():
            continue
        try:
            result = run(['/usr/bin/du', '-sk', str(path)], capture_output=True, text=True, timeout=15)
            if result.returncode:
                raise OSError('directory measurement failed')
            sizes[str(path)] = int(result.stdout.split()[0]) * 1024
        except Exception:
            errors += 1
    save_state('disk-inventory', dict(at=time.time(), sizes=sizes, sourceErrors=errors))
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
        except OSError:
            pass
    try:
        sizes[str(temp_dir)] = int((Path(watch_dir) / 'tmp_kb').read_text()) * 1024
    except (ValueError, OSError):
        pass
    inventory = read_state('disk-inventory')
    if inventory.get('at'):
        props['inventoryAgeS'] = max(0, time.time()-inventory['at'])
        sizes.update(inventory.get('sizes', {}))
        errors += inventory.get('sourceErrors', 0) + int(props['inventoryAgeS'] > 7200)
    else:
        errors += 1
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
