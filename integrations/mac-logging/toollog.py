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
TEXT = set('target resourceKind process package fromVersion toVersion source operation runId threadId snapshotId resourceId'.split())
for i in range(1, 6):
    TEXT.add('grower%dPath' % i)
    NUMBERS.add('grower%dDeltaGb' % i)
ATOM = re.compile(r'^[A-Za-z0-9_.:@/+ ()-]{1,180}$')
SECRET = re.compile(r'(?i)(bearer |password|secret|token[=: ]|cookie|otp[=: ]|sk-[a-z0-9]|\b(?:\d[ -]?){13,19}\b)')


def directory():
    return Path(os.environ.get('TOOLLOG_DIR', str(Path.home() / '.robob/logs/tools/mac')))


def safe_fields(values):
    result = {}
    for key, value in (values or {}).items():
        if key in NUMBERS and type(value) in (int, float) and math.isfinite(value):
            result[key] = value
        elif key in TEXT and isinstance(value, str) and ATOM.fullmatch(value) and not SECRET.search(value):
            result[key] = value
    return result


def record(component, kind, name, now, duration_ms=None, ok=None, ids=None, props=None, error_tag=None):
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
        clean = safe_fields(value)
        if clean:
            row[key] = clean
    if error_tag and re.fullmatch(r'[a-z][a-z0-9_.-]{0,79}', error_tag):
        # Stable messages only; exception text and subprocess output may contain credentials.
        row['error'] = dict(tag=error_tag, message=error_tag)
    return row


def private_dir(root):
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(root, 0o700)


def append(fd, row):
    os.write(fd, (json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n').encode())


def emit(component, kind, name, *, duration_ms=None, ok=None, ids=None, props=None, error_tag=None, now=None):
    try:
        now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
        row = record(component, kind, name, now, duration_ms, ok, ids, props, error_tag)
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
