"""Local, bounded, fail-open tool logging. Callers supply metadata, never raw output."""
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import re
import uuid

RUN_ID = uuid.uuid4().hex

CAP_BYTES = 50 * 1024 * 1024
# Explicit schema: unknown keys and nested payloads cannot enter a log by accident.
NUMBERS = set('internalFreeGb externalFreeGb baseline count bytes files snapshotAgeS resticExitCode exitCode found killed ageS autoFixed needsOwner critical high moderate medium low unknown skipped sourceErrors reports inventoryAgeS'.split())
NUMBERS.update('diskCount storagekitdPid storagekitdUptimeS diskarbitrationdPid diskarbitrationdUptimeS hdiutilMs'.split())
NUMBERS.update('elapsedMs deniedCount inventorySourceErrors'.split())
NUMBERS.update(('unreadableCount', 'turn', 'cachedCount'))
NUMBERS.update(('deltaGb', 'deltaWindowS', 'purgeableGb', 'localSnapshotCount'))
NUMBERS.update(('lockAgeS', 'lockPid', 'completedCount', 'failedCount',
                'windowStart', 'windowEnd', 'windowS', 'skippedS', 'chunks', 'chunksDone', 'observedAt'))
NUMBERS.update(('lockHolderPpid', 'lockHolderStartedAgoS', 'lastGoodSnapshotAgeS',
                'backup.skipped_runs.memory', 'backup.skipped_runs.health', 'backup.skipped_runs.other',
                'backup.ok_runs.memory', 'backup.ok_runs.health', 'backup.ok_runs.other'))
for prefix in ('internal', 'external'):
    NUMBERS.update(prefix+field for field in ('FreeGbDelta', 'PurgeableGb', 'LocalSnapshotCount'))
    NUMBERS.add(prefix+'DeltaWindowS')
SKIP_REASONS = {'lock_held', 'stale_lock', 'no_repo_access', 'password_unavailable', 'source_missing', 'dry_run', 'other', 'load_deferred', 'boot_grace'}
NUMBERS.update(('loadPerCore', 'lastSuccessAgeS', 'deferredCount'))
BACKUP_PROGRAMS = {'bash', 'zsh', 'sh', 'python', 'python3', 'restic', 'launchd',
                   'Robob', 'codex', 'claude', 'opencode', 'node', 'sleep', 'unknown'}
BACKUP_ARGS = {'memory_backup.sh', 'health_backup.sh', 'backup_control.py', 'redact_lock.py',
               'run_limited.py', 'install.zsh', 'install-jobs.zsh', 'deploy.zsh',
               'backup', 'snapshots', 'forget', 'prune',
               '-c', '-f', '-l', '-lc', '-u', '-m', '[redacted]'}
BOOLEANS = {'timedOut', 'hdiutilOk', 'probeError', 'partial', 'inventoryStale', 'inventoryComplete'}
NULLABLE = {'exitCode', 'diskCount', 'storagekitdPid', 'storagekitdUptimeS', 'storagekitdStat',
            'diskarbitrationdPid', 'diskarbitrationdUptimeS', 'diskarbitrationdStat'}
NULLABLE.add('inventoryAgeS')
NULLABLE.update(('internalFreeGbDelta', 'externalFreeGbDelta'))
NULLABLE.update(('lastGoodSnapshotAgeS', 'lockHolderCmd', 'lockHolderPpid', 'lockHolderStartedAgoS'))
NULLABLE.update(('deltaFromTs', 'deltaWindowS', 'purgeableGb', 'localSnapshotCount'))
for prefix in ('internal', 'external'):
    NULLABLE.update((prefix+'DeltaFromTs', prefix+'DeltaWindowS'))
TEXT = set('target resourceKind process package fromVersion toVersion source operation runId threadId snapshotId resourceId'.split())
for i in range(1, 6):
    TEXT.add('grower%dPath' % i)
    NUMBERS.add('grower%dDeltaGb' % i)
    TEXT.add('grower%dName' % i)
    NUMBERS.add('grower%dBytes' % i)
for i in range(1, 4):
    TEXT.add('topMover%dPath' % i)
    NUMBERS.add('topMover%dGbDelta' % i)
PROBE_ERRORS = {prefix+field for prefix in ('internal', 'external')
                for field in ('PurgeableError', 'SnapshotError')}
TEXT.update('blockedIn samplePath skipped storagekitdStat diskarbitrationdStat'.split())
TEXT.add('failure')
ATOM = re.compile(r'^[A-Za-z0-9_.:@/+ ()-]{1,180}$')
SECRET = re.compile(r'(?i)(bearer |password|secret|token[=: ]|cookie|otp[=: ]|sk-[a-z0-9]|\b(?:\d[ -]?){13,19}\b)')


def backup_command(value):
    # Closed vocabulary: even an innocuous-looking argv token can be a secret.
    if not isinstance(value, str):
        return False
    parts = value.split(' ')
    return (1 <= len(parts) <= 2 and parts[0] in BACKUP_PROGRAMS and
            (len(parts) == 1 or parts[1] in BACKUP_ARGS))


def directory():
    return Path(os.environ.get('TOOLLOG_DIR', str(Path.home() / '.robob/logs/tools/mac')))


def process_fields(values):
    result = []
    for proc in values[:10]:
        if not isinstance(proc, dict):
            continue
        if any(type(proc.get(k)) is not int or proc[k] < 0 for k in ('pid', 'ppid', 'ageS')):
            continue
        if not all(isinstance(proc.get(k), str) for k in ('stat', 'comm', 'args')):
            continue
        clean = {k: proc[k] for k in ('pid', 'ppid', 'ageS')}
        for key, limit in (('stat', 16), ('comm', 300), ('args', 300)):
            value = proc[key][:limit]
            clean[key] = '[redacted]' if SECRET.search(value) else ''.join(
                c if c.isprintable() else ' ' for c in value)
        result.append(clean)
    return result


def safe_fields(values, event=None):
    result = {}
    for key, value in (values or {}).items():
        if event == 'proc.disk_wait' and key == 'procs' and isinstance(value, list):
            result[key] = process_fields(value)
        elif event == 'proc.disk_wait' and key == 'stuckUnmount' and type(value) is bool:
            result[key] = value
        elif event == 'proc.disk_wait' and key == 'mountPoint' and isinstance(value, str):
            result[key] = '[redacted]' if SECRET.search(value) else ''.join(
                c if c.isprintable() else ' ' for c in value[:300])
        elif key == 'lockHolderCmd' and backup_command(value):
            result[key] = value
        elif key in ('trigger', 'lockHolderTrigger') and value in ('launchd', 'manual', 'installer', 'unknown', 'agent'):
            if key != 'trigger' or value != 'agent':
                result[key] = value
        elif key == 'lastGoodSnapshotError' and value in ('password_unavailable', 'timeout', 'exit', 'parse', 'unavailable', 'no_snapshots'):
            result[key] = value
        elif key in PROBE_ERRORS and value in ('timeout', 'exit', 'parse', 'unsupported', 'unavailable', 'busy'):
            result[key] = value
        elif key in ('deltaUnavailable', 'internalDeltaUnavailable', 'externalDeltaUnavailable') and value in (
                'corrupt_state', 'missing_state', 'unreadable_state', 'no_previous_numeric',
                'invalid_timestamp', 'current_unavailable'):
            result[key] = value
        elif key == 'volume' and value in ('internal', 'external'):
            result[key] = value
        elif key in ('previousTs', 'sampleTs', 'deltaFromTs', 'internalDeltaFromTs', 'externalDeltaFromTs') and isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value):
            result[key] = value
        elif key == 'skipReason' and isinstance(value, str) and value in SKIP_REASONS:
            result[key] = value
        elif key in NULLABLE and value is None:
            result[key] = None
        elif key in BOOLEANS and type(value) is bool:
            result[key] = value
        elif key in NUMBERS and type(value) in (int, float) and math.isfinite(value):
            result[key] = value
        elif key in TEXT and isinstance(value, str) and ATOM.fullmatch(value) and not SECRET.search(value):
            result[key] = value
    return result


def record(component, kind, name, now, duration_ms=None, ok=None, ids=None, props=None, error_tag=None, error_message=None):
    if kind not in ('event', 'perf', 'error') or not re.fullmatch(r'[a-z][a-z0-9_.-]{0,79}', name):
        raise ValueError('invalid event')
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', component):
        raise ValueError('invalid component')
    row = dict(ts=now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), tool='mac',
               component=component, kind=kind, name=name)
    if type(duration_ms) in (int, float) and math.isfinite(duration_ms) and duration_ms >= 0:
        row['durationMs'] = round(duration_ms, 3)
    if type(ok) is bool:
        row['ok'] = ok
    for key, value in [('ids', {'runId': RUN_ID, **(ids or {})}), ('props', props)]:
        clean = safe_fields(value, name if key == 'props' else None)
        if clean:
            row[key] = clean
    if error_tag and re.fullmatch(r'[a-z][a-z0-9_.-]{0,79}', error_tag):
        message = error_tag
        # Only source adapters opt in with stderr or filesystem errors. Never
        # accept command stdout, report contents or arbitrary exception text.
        if name in ('disk.inventory.source', 'crash.source') and isinstance(error_message, str):
            lines = error_message.strip().splitlines()
            if lines:
                message = '[redacted]' if SECRET.search(lines[0]) else lines[0][:300]
        row['error'] = dict(tag=error_tag, message=message)
    return row


def private_dir(root):
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)


def append(fd, row):
    os.write(fd, (json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n').encode())


def emit(component, kind, name, *, duration_ms=None, ok=None, ids=None, props=None, error_tag=None, error_message=None, now=None):
    try:
        now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
        row = record(component, kind, name, now, duration_ms, ok, ids, props, error_tag, error_message)
        root = directory()
        private_dir(root)
        day = now.date().isoformat()
        fd = os.open(root / (day + '.ndjson'), os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            # Never wait behind another writer, and never hold a lock across job work.
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.fchmod(fd, 0o600)
            marker = root / ('.retained-' + day)
            if not marker.exists():
                cutoff = now.date() - dt.timedelta(days=30)
                for p in root.iterdir():
                    match = re.fullmatch(r'(?:rollup-|\.retained-|\.capped-)?(\d{4}-\d{2}-\d{2})(?:\.ndjson|\.json)?', p.name)
                    if match and dt.date.fromisoformat(match[1]) < cutoff:
                        p.unlink(missing_ok=True)
                marker.touch(mode=0o600)
            if os.fstat(fd).st_size >= CAP_BYTES:
                cap = root / ('.capped-' + day)
                try:
                    capfd = os.open(cap, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                except FileExistsError:
                    pass
                else:
                    os.close(capfd)
                    append(fd, record('logger', 'error', 'log.cap', now, ok=False, error_tag='log.cap'))
                if kind != 'error':
                    return
            append(fd, row)
        finally:
            os.close(fd)
    except Exception:
        pass
