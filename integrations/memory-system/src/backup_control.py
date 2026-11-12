"""Single-flight and host-load admission for the backup job."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

LAUNCH_INTERVAL_S = 14400  # StartInterval in com.abdullah.memory-backup.plist


def load_per_core():
    override = os.environ.get('MEMORY_BACKUP_LOAD_OVERRIDE')
    if override is not None:
        return float(override)
    cores = int(subprocess.check_output(['/usr/sbin/sysctl', '-n', 'hw.ncpu']))
    return os.getloadavg()[0] / cores


def uptime():
    if 'MEMORY_BACKUP_UPTIME_OVERRIDE' in os.environ:
        return float(os.environ['MEMORY_BACKUP_UPTIME_OVERRIDE'])
    import re
    boot = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.boottime'], text=True)
    return time.time() - int(re.search(r'sec = (\d+)', boot)[1])


def defer(status):
    previous = json.loads(status.read_text()) if status.exists() else {}
    now = int(time.time())
    success = previous.get('last_success_ts')
    # No known success is already overdue; never defer the initial backup.
    if not success or now - success + LAUNCH_INTERVAL_S >= float(os.environ.get('MEMORY_BACKUP_MAX_DEFER_S', 86400)):
        print('deferral bypassed: backup deadline cannot wait for next launch', flush=True)
        return False
    load = load_per_core()
    reason = ('boot grace' if uptime() < float(os.environ.get('MEMORY_BACKUP_BOOT_GRACE_S', 3600))
              else f'load {load:.1f}/core' if load >= float(os.environ.get('MEMORY_BACKUP_DEFER_LOAD', 1))
              else '')
    if not reason:
        return False
    previous.update(last_deferred_ts=now, deferred_count=previous.get('deferred_count', 0) + 1,
                    deferred_reason=reason)
    temporary = status.with_suffix('.tmp')
    temporary.write_text(json.dumps(previous, indent=1))
    temporary.replace(status)
    print(f'deferred: {reason}', flush=True)
    return True


def guard(lock, command):
    lock.parent.mkdir(parents=True, exist_ok=True)
    def record(message):
        print(message, flush=True)
        with (lock.parent / time.strftime('backup-%Y%m.log')).open('a') as log:
            log.write(time.strftime('%F %T') + ' ' + message + '\n')
    # flock closes the mkdir-to-pid race and serializes stale-lock recovery.
    with Path(str(lock) + '.flock').open('a') as fence:
        try:
            fcntl.flock(fence, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            record('already running')
            return 0
        pidfile = lock / 'pid'
        holder = None
        try:
            holder = int(pidfile.read_text())
            if holder <= 0:
                raise ValueError('invalid lock holder')
            os.kill(holder, 0)
        except (FileNotFoundError, ValueError, ProcessLookupError):
            pass
        except PermissionError:
            record('already running (holder inaccessible)')
            return 0
        else:
            identity = subprocess.run(['/bin/ps', '-p', str(holder), '-o', 'command='],
                                      capture_output=True, text=True, timeout=5)
            if identity.returncode not in (0, 1) or identity.stderr.strip():
                raise RuntimeError('cannot identify backup lock holder')
            if 'memory_backup.sh' in identity.stdout:
                record(f'already running: skip: backup {holder} still running')
                return 0
        if lock.exists():
            record(f'removing stale backup.lock (holder {holder or "?"} is gone)')
        lock.mkdir(exist_ok=True)
        pidfile.write_text(str(os.getpid()))
        os.utime(lock, None)
        try:
            import run_limited
            os.environ.update(MEMORY_BACKUP_GUARDED='1', MEMORY_BACKUP_LOCK_FD=str(fence.fileno()))
            # Heavy steps own their caps. Reuse their verified signal/tree
            # cleanup here without imposing another whole-backup deadline.
            return run_limited.run(command, float('inf'), pass_fds=(fence.fileno(),))
        finally:
            pidfile.unlink(missing_ok=True)
            lock.rmdir()


if __name__ == '__main__':
    if sys.argv[1] == 'defer':
        sys.exit(10 if defer(Path(sys.argv[2])) else 0)
    sys.exit(guard(Path(sys.argv[2]), sys.argv[3:]))
