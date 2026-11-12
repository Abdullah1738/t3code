"""Recover a replica without replacing the last checked copy prematurely."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def log(message):
    print(time.strftime('%F %T') + ' ' + message, flush=True)


def ensure_idle(paths):
    existing = [str(p) for p in paths if p.exists()]
    if not existing:
        return
    result = subprocess.run(['/usr/sbin/lsof', '-nP', '-Fpc', '--', *existing],
                            capture_output=True, text=True, timeout=15)
    if result.stdout.strip():
        raise RuntimeError('replica held open: ' + result.stdout.strip().replace('\n', ' '))
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise RuntimeError('cannot establish replica holders: ' + result.stderr.strip())


def sidecars(path):
    return [Path(str(path) + suffix) for suffix in ('-wal', '-shm')]


class ReplicaLimit(Exception):
    pass


def replicate(src, dst, rsync, sqlite, runner, seconds, hwm_sql='', hwm_min=''):
    started = time.monotonic()
    marker = dst.parent / '.catchup-needed'
    pending = Path(str(dst) + '.next')
    wal = sidecars(dst)[0]
    wal_size = wal.stat().st_size if wal.exists() else 0
    reasons = []
    if wal_size > float(os.environ.get('MEMORY_BACKUP_REPLICA_WAL_MAX_GB', 2)) * 1024**3:
        reasons.append(f'wal {wal_size / 1024**3:.3f} GB')
    if marker.exists():
        reasons.append('catchup marker')
    if dst.exists() and time.time() - dst.stat().st_mtime > float(os.environ.get('MEMORY_BACKUP_FRESH_COPY_AGE_S', 172800)):
        reasons.append('age')
    try:
        limited = [sys.executable, str(runner), '--seconds', str(seconds), '--background',
                   '--load-aware', '--max-seconds-under-load',
                   os.environ.get('MEMORY_BACKUP_MAX_SECONDS_UNDER_LOAD', '10800'), '--']
        def execute(command):
            result = subprocess.run([*limited, *map(str, command)], capture_output=True, text=True)
            if result.stderr:
                print(result.stderr, end='')
            elapsed = time.monotonic() - started
            if result.returncode in (124, 125):
                marker.touch()
                size = sum(p.stat().st_size for p in (wal, sidecars(pending)[0]) if p.exists())
                detail = ('killed at cap' if result.returncode == 124 else
                          'child survived kill: ' + result.stderr[-600:])
                log(f'replica {dst.name}: {detail} after {elapsed:.0f}s, WAL {size / 1024**3:.3f} GB')
                if result.returncode == 124:
                    log(f'{Path(command[0]).name} timed out after {seconds:g} s')
                raise ReplicaLimit(result.returncode)
            if result.returncode:
                raise RuntimeError(f'rc={result.returncode} elapsed_s={elapsed:.0f} {(result.stderr or result.stdout)[-600:]}')
            return result


        # Check .next too: an rc=125 survivor may still own that file.
        ensure_idle([dst, *sidecars(dst), pending, *sidecars(pending)])
        target = dst
        if reasons:
            if shutil.disk_usage(dst.parent).free >= src.stat().st_size:
                for path in [pending, *sidecars(pending)]:
                    path.unlink(missing_ok=True)
                target = pending
            else:
                log(f'replica {dst.name}: insufficient space to reseed; checkpointing committed WAL before normal sync')
                checkpoint = execute([sqlite, '-bail', dst, 'PRAGMA wal_checkpoint(TRUNCATE);'])
                if not checkpoint.stdout.strip().startswith('0|'):
                    raise RuntimeError('cannot checkpoint old replica: ' + checkpoint.stdout)
                ensure_idle([dst, *sidecars(dst)])
                if wal.exists() and wal.stat().st_size:
                    raise RuntimeError('old replica WAL remains after checkpoint; leaving it intact')
                for path in sidecars(dst):
                    path.unlink(missing_ok=True)
        result = execute([rsync, '-v', src, target])
        if result.stdout:
            print(result.stdout, end='')
        if target == pending:
            check = execute([sqlite, '-bail', pending, 'PRAGMA quick_check;'])
            if check.returncode or check.stdout.strip() != 'ok':
                raise RuntimeError(f'new replica quick_check failed: {check.stdout} {check.stderr}')
            if hwm_sql:
                check = execute([sqlite, '-readonly', pending, hwm_sql])
                if check.returncode or not check.stdout.strip().isdigit() or int(check.stdout) < int(hwm_min):
                    raise RuntimeError('new replica did not reach source high-water mark: ' + check.stdout + check.stderr)
            # Close/checkpoint the fresh file before moving only its main DB.
            check = execute([sqlite, '-bail', pending, 'PRAGMA journal_mode=DELETE;'])
            if check.returncode or check.stdout.strip().lower() != 'delete':
                raise RuntimeError('cannot finalize new replica: ' + check.stdout + check.stderr)
            ensure_idle([dst, *sidecars(dst), pending, *sidecars(pending)])
            for path in sidecars(dst):
                path.unlink(missing_ok=True)
            os.replace(pending, dst)
            log(f'replica {dst.name}: reseeded (reason: {" | ".join(reasons)}), elapsed {time.monotonic() - started:.0f} s')
        return 0
    except ReplicaLimit as exc:
        return exc.args[0]
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        log(f'replica {dst.name}: {exc}')
        return 1


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for name in ('src', 'dst', 'rsync', 'sqlite', 'runner'):
        p.add_argument(name, type=Path)
    p.add_argument('seconds', type=float)
    p.add_argument('--hwm-sql', default='')
    p.add_argument('--hwm-min', default='')
    sys.exit(replicate(**vars(p.parse_args())))
