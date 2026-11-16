"""Local, bounded, fail-open tool logging. Callers supply metadata, never raw output."""
import datetime as dt
import fcntl
import json
import ipaddress
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
NUMBERS.update('elapsedMs deniedCount partialChildCount inventorySourceErrors'.split())
NUMBERS.update('rootsOk rootsTimeout rootsDenied scanMs'.split())
NUMBERS.update(('unreadableCount', 'turn', 'cachedCount', 'rootsComplete', 'rootsPartial',
                'childrenCached', 'oldestChildAgeS', 'unmeasuredCount', 'limitedCount', 'lagS'))
NUMBERS.update(('deltaGb', 'deltaWindowS', 'purgeableGb', 'localSnapshotCount'))
NUMBERS.update(('lockAgeS', 'lockPid', 'completedCount', 'failedCount',
                'windowStart', 'windowEnd', 'windowS', 'skippedS', 'chunks', 'chunksDone', 'observedAt'))
NUMBERS.update(('lockHolderPpid', 'lockHolderStartedAgoS', 'lastGoodSnapshotAgeS',
                'backup.skipped_runs.memory', 'backup.skipped_runs.health', 'backup.skipped_runs.other',
                'backup.ok_runs.memory', 'backup.ok_runs.health', 'backup.ok_runs.other',
                'backup.failed_runs.memory', 'backup.failed_runs.health', 'backup.failed_runs.other'))
for prefix in ('internal', 'external'):
    NUMBERS.update(prefix+field for field in ('FreeGbDelta', 'PurgeableGb', 'LocalSnapshotCount'))
    NUMBERS.add(prefix+'DeltaWindowS')
SKIP_REASONS = {'deep_pass_running', 'lock_held', 'stale_lock', 'no_repo_access', 'password_unavailable', 'source_missing', 'dry_run', 'other', 'load_deferred', 'boot_grace'}
BACKUP_STAGES = {'admission', 'stage', 'repo', 'disk', 'replica', 'verify', 'files',
                 'restic', 'prune', 'vault', 'dropbox', 'manifest', 'unknown', 'other'}
FAILURE_STAGES = {'admission', 'stage', 'repo', 'disk', 'replica', 'verify', 'files',
                  'restic', 'prune', 'dropbox', 'manifest', 'unknown'}
NUMBERS.update(('durationMs', 'childrenMeasured', 'childrenPartial', 'childrenRemaining', 'bytesMeasured'))
NUMBERS.update(('probeTimeouts', 'secondsInProbeTimeouts', 'probeAllowanceMedianS', 'allowanceS'))
NUMBERS.update(('timeouts', 'secondsInTimeouts', 'childrenDescended', 'partsMeasured',
                'childrenWithPartsInProgress', 'partsDone', 'partsTotal', 'partsFreshnessS'))
NUMBERS.update(('loadPerCore', 'lastSuccessAgeS', 'deferredCount'))
NUMBERS.update(('sentBytes', 'dbBytes', 'stageAgeS'))
BACKUP_PROGRAMS = {'bash', 'zsh', 'sh', 'python', 'python3', 'restic', 'launchd',
                   'Robob', 'codex', 'claude', 'opencode', 'node', 'sleep', 'unknown'}
BACKUP_ARGS = {'memory_backup.sh', 'health_backup.sh', 'backup_control.py', 'redact_lock.py',
               'run_limited.py', 'install.zsh', 'install-jobs.zsh', 'deploy.zsh',
               'backup', 'snapshots', 'forget', 'prune',
               '-c', '-f', '-l', '-lc', '-u', '-m', '[redacted]'}
BOOLEANS = {'timedOut', 'hdiutilOk', 'probeError', 'partial', 'inventoryStale', 'inventoryComplete'}
BOOLEANS.add('cached')
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
TEXT.add('child')
TEXT.add('spawnPolicy')
TEXT.update(('root', 'slowestChildPath'))
NUMBERS.add('slowestChildMs')
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


def process_fields(values, busy=False):
    result = []
    numeric = ('pid', 'processAgeS', 'cpuDeltaS') if busy else ('pid', 'ppid', 'processAgeS', 'stuckForS')
    texts = ('comm',) if busy else ('stat', 'comm', 'args', 'cpuTime')
    sample_key = 'statSamples' if busy else 'samples'
    for proc in values[:10]:
        if not isinstance(proc, dict):
            continue
        if any(not finite_number(proc.get(k)) or proc[k] < 0 for k in numeric):
            continue
        if any(type(proc[k]) is not int for k in numeric if k != 'cpuDeltaS'):
            continue
        if not all(isinstance(proc.get(k), str) for k in texts):
            continue
        samples = proc.get(sample_key)
        if not isinstance(samples, list) or not all(isinstance(v, str) and re.fullmatch(r'[A-Za-z+<>-]{1,16}', v) for v in samples):
            continue
        if not busy and not re.fullmatch(r'(?:\d+-)?\d+(?::[0-5]\d){1,2}(?:\.\d+)?', proc['cpuTime']):
            continue
        clean = {k: proc[k] for k in numeric}
        clean[sample_key] = samples[:6]
        for key in texts:
            value = proc[key][:16 if key == 'stat' else 64 if key == 'cpuTime' else 300]
            clean[key] = '[redacted]' if SECRET.search(value) else ''.join(
                c if c.isprintable() else ' ' for c in value)
        result.append(clean)
    return result


def finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        # Untrusted JSON integers can exceed the float range used by isfinite.
        return False


def disk_wait_fields(values):
    result = {}
    for key, value in (values or {}).items():
        if key in ('count', 'busyCount', 'sampleCount') and type(value) is int and value >= 0:
            result[key] = min(value, 6) if key == 'sampleCount' else value
        elif key in ('procs', 'busy') and isinstance(value, list):
            result[key] = process_fields(value, busy=key == 'busy')
        elif key == 'stuckUnmount' and type(value) is bool:
            result[key] = value
        elif key == 'sampling' and value in ('full', 'partial'):
            result[key] = value
        elif key == 'failure' and value in ('timeout', 'exit', 'parse', 'unavailable'):
            result[key] = value
        elif key == 'mountPoint' and isinstance(value, str):
            result[key] = '[redacted]' if SECRET.search(value) else ''.join(
                c if c.isprintable() else ' ' for c in value[:300])
    return result


MEMORY_ERRORS = {'timeout', 'unavailable', 'exit', 'parse', 'baseline', 'gone'}


def memory_command(value):
    # top's command column is a name, never argv; reject paths and secret shapes.
    if not isinstance(value, str) or '/' in value or SECRET.search(value):
        return '[redacted]'
    return ''.join(c if c.isprintable() else ' ' for c in value[:40])


def memory_fields(values, event):
    result = {}
    if not isinstance(values, dict):
        return result
    if event == 'memory.alert':
        if values.get('reason') in ('swap', 'pressure', 'footprint', 'fseventsd', 'fseventsd_growth'):
            result['reason'] = values['reason']
        if values.get('notifyError') is None or values.get('notifyError') in MEMORY_ERRORS:
            result['notifyError'] = values.get('notifyError')
        return result
    numbers = {'pageSize', 'freePages', 'activePages', 'inactivePages', 'wiredPages',
               'speculativePages', 'purgeablePages', 'compressorPages', 'totalMb', 'usedMb',
               'mbPerS', 'tps', 'pid', 'memMb', 'cmprsMb', 'count', 'ppid1Count'}

    def numeric(value):
        return finite_number(value) and value >= 0

    def row(value, keys):
        if not isinstance(value, dict):
            return {}
        clean = {}
        for key in keys:
            item = value.get(key)
            if key in numbers and (item is None or numeric(item)):
                clean[key] = item
            elif key == 'command' and isinstance(item, str):
                clean[key] = memory_command(item)
            elif key == 'etime' and isinstance(item, str) and re.fullmatch(r'\d+(?:-\d+)?(?::\d+){1,2}', item):
                clean[key] = item
            elif key == 'error' and (item is None or item in MEMORY_ERRORS):
                clean[key] = item
        return clean

    for key, value in values.items():
        if key in ('swap', 'vm', 'io'):
            keys = {'swap': ('totalMb', 'usedMb'), 'io': ('tps', 'mbPerS'),
                    'vm': ('pageSize', 'freePages', 'activePages', 'inactivePages',
                           'wiredPages', 'speculativePages', 'purgeablePages', 'compressorPages')}[key]
            result[key] = None if value is None else row(value, keys)
        elif key in ('top', 'watched', 'counts') and (value is None or isinstance(value, list)):
            keys = ('command', 'count', 'ppid1Count') if key == 'counts' else ('pid', 'command', 'memMb', 'cmprsMb')
            if key == 'watched':
                keys += ('etime', 'error')
            result[key] = None if value is None else [row(p, keys) for p in value[:{'top': 15, 'watched': 512, 'counts': 5}[key]]]
        elif key == 'load' and (value is None or isinstance(value, list)):
            result[key] = None if value is None else [n for n in value[:3] if numeric(n)]
        elif key in ('pressure', 'pressureLevel', 'freePercent', 'boot', 'swapinsDelta', 'swapoutsDelta',
                     'deltaWindowS', 'processCount', 'ppid1Count', 'watchedOmitted', 'criticalSamples', 'fseventsdGrowthSamples',
                     'fseventsdGrowthPid', 'fseventsdGrowthWindowS', 'fseventsdGrowthMbPerHour') and (value is None or numeric(value)):
            result[key] = value
        elif key in {n+'Error' for n in ('swap', 'vm', 'pressure', 'pressureLevel', 'freePercent', 'boot',
                                       'top', 'counts', 'io', 'load', 'delta', 'watched')}:
            if value is None or (isinstance(value, str) and value in MEMORY_ERRORS):
                result[key] = value
    return result


def cpu_fields(values):
    from cpu_labels import janitor_redact, SystemFamily, SECRET_LABEL, command_label
    result = {}
    numeric = {'windowS', 'cpuS', 'totalCpuPct', 'ncpu', 'processCount', 'runnable',
               'uninterruptible', 'pid', 'ppid', 'count', 'cpuPct', 'rssMb',
               'skippedLines', 'badLines', 'lines', 'exiting', 'systemCpuPct',
               'userPct', 'sysPct', 'unattributedCpuPct', 'spawned', 'exited'}

    def number(value):
        return finite_number(value) and 0 <= value <= 1e15

    def label(value, limit):
        if not isinstance(value, str):
            return None
        if isinstance(value, SystemFamily) and '/' not in value and not SECRET_LABEL.search(value):
            return str(value)[:limit]
        try:
            value = janitor_redact(value)
        except (ImportError, OSError):
            return None
        if SECRET.search(value) or '/Users/' in value or '/home/' in value or value.startswith(('/', '~')):
            return '[redacted]'
        return ''.join(c if c.isprintable() else ' ' for c in value)[:limit]

    for key, value in (values or {}).items():
        if key in numeric and (value is None or number(value)):
            result[key] = value
        elif key == 'baseline' and type(value) is bool:
            result[key] = value
        elif key == 'badLine':
            result[key] = label(value, 200)
        elif key in ('failure', 'hintError', 'systemCpuError', 'commandError', 'threadError') and (value is None or value in MEMORY_ERRORS):
            result[key] = value
        elif key == 'load' and (value is None or isinstance(value, list)):
            result[key] = None if value is None else [n for n in value[:3] if number(n)]
        elif key in ('top', 'families', 'spawnedFamilies', 'runnableThreadsByFamily') and isinstance(value, list):
            result[key] = []
            for proc in value[:{'top': 20, 'families': 15, 'spawnedFamilies': 8, 'runnableThreadsByFamily': 8}[key]]:
                if not isinstance(proc, dict):
                    continue
                keys = (('pid', 'ppid', 'family', 'parentFamily', 'state', 'hint', 'cpuS', 'cpuPct', 'rssMb', 'etime', 'cmd', 'parentCmd')
                        if key == 'top' else ('family', 'count', 'cpuPct', 'parentFamily')
                        if key == 'spawnedFamilies' else ('family', 'count')
                        if key == 'runnableThreadsByFamily' else ('family', 'count', 'cpuPct', 'rssMb'))
                clean = {}
                for field in keys:
                    item = proc.get(field)
                    if field in numeric and number(item):
                        clean[field] = item
                    elif field in ('family', 'parentFamily', 'hint'):
                        clean[field] = label(item, 72 if field == 'hint' else 64)
                    elif field in ('cmd', 'parentCmd') and field in proc:
                        clean[field] = command_label(item) if isinstance(item, str) else None
                    elif field == 'state' and isinstance(item, str) and re.fullmatch(r'[A-Za-z?+<>-]{1,16}', item):
                        clean[field] = item
                    elif field == 'etime' and isinstance(item, str) and re.fullmatch(r'\d+(?:-\d+)?(?::\d+){1,2}', item):
                        clean[field] = item[:32]
                result[key].append(clean)
    return result


def safe_fields(values, event=None):
    if event and event.startswith('tailnet.'):
        result = {}
        for key, value in (values or {}).items():
            if key == 'backendState' and value in ('Running', 'Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'Starting', 'NoState', 'Unknown'):
                result[key] = value
            elif key in ('statusError', 'extensionError', 'homeProbeError') and value in (None, 'timeout', 'exit', 'parse', 'unavailable'):
                result[key] = value
            elif key in ('up', 'selfOnline', 'timedOut', 'homeReachable', 'confirmedDown') and (value is None or type(value) is bool):
                result[key] = value
            elif key in ('tailscaleIPsCount', 'exitCode', 'extensionPid', 'notUpChecks') and (value is None or type(value) is int):
                result[key] = value
            elif key in ('outcome', 'cliOutcome') and value in ('up', 'down', 'unknown'):
                result[key] = value
            elif key in ('cliMs', 'outageStart') and (value is None or finite_number(value) and value >= 0):
                result[key] = value
            elif key == 'suppressed' and type(value) is int and value >= 0:
                result[key] = value
            elif key == 'confirmProbes' and isinstance(value, dict):
                result[key] = {}
                for host, probe in list(value.items())[:2]:
                    if not isinstance(host, str):
                        continue
                    try:
                        address = ipaddress.ip_address(host)
                    except ValueError:
                        continue
                    if address not in ipaddress.ip_network('100.64.0.0/10'):
                        continue
                    if (not isinstance(probe, dict) or type(probe.get('ok')) is not bool
                            or probe.get('error') not in (None, 'timeout', 'exit', 'unavailable')
                            or not finite_number(probe.get('ms')) or probe['ms'] < 0
                            or type(probe.get('port')) is not int or not 1 <= probe['port'] <= 65535):
                        continue
                    result[key][host] = {k: probe[k] for k in ('port', 'ok', 'error', 'ms')}
            elif key == 'extensionPids' and (value is None or isinstance(value, str) and re.fullmatch(r'[0-9 ]{1,180}', value)):
                result[key] = value
        return result
    if event in ('cpu.sample', 'cpu.spike'):
        return cpu_fields(values)
    if event == 'disk.clone_wedge':
        result = {k: v for k, v in disk_wait_fields(values).items()
                  if k in ('count', 'sampleCount', 'sampling', 'failure')}
        if isinstance((values or {}).get('procs'), list):
            result['procs'] = []
            for proc in values['procs'][:10]:
                if not isinstance(proc, dict) or proc.get('reason') not in ('clone', 'shared_path'):
                    continue
                if any(type(proc.get(k)) is not int or proc[k] < 0 for k in ('pid', 'processAgeS')):
                    continue
                cpu = proc.get('cpuDeltaS')
                if not finite_number(cpu) or cpu < 0:
                    continue
                if not all(isinstance(proc.get(k), str) for k in ('path', 'wchan')):
                    continue
                clean = {k: proc[k] for k in ('pid', 'processAgeS', 'cpuDeltaS', 'reason')}
                for key in ('path', 'wchan'):
                    value = proc[key][:300 if key == 'path' else 64]
                    clean[key] = '[redacted]' if SECRET.search(value) else ''.join(c if c.isprintable() else ' ' for c in value)
                result['procs'].append(clean)
        return result
    if event == 'proc.disk_wait':
        return disk_wait_fields(values)
    if event in ('memory.sample', 'memory.alert'):
        return memory_fields(values, event)
    result = {}
    for key, value in (values or {}).items():
        if key == 'lockHolderCmd' and backup_command(value):
            result[key] = value
        elif key in ('trigger', 'lockHolderTrigger') and value in ('launchd', 'manual', 'installer', 'unknown', 'agent'):
            if key != 'trigger' or value != 'agent':
                result[key] = value
        elif key == 'lastGoodSnapshotError' and value in ('password_unavailable', 'timeout', 'exit', 'parse', 'unavailable', 'no_snapshots'):
            result[key] = value
        elif key == 'lastGoodSnapshotSource' and value in ('restic', 'status_file'):
            result[key] = value
        elif key == 'failedStage' and isinstance(value, str) and value in BACKUP_STAGES:
            result[key] = value
        elif event == 'backup.run' and key == 'failureStage' and isinstance(value, str):
            result[key] = value if value in FAILURE_STAGES else 'unknown'
        elif key == 'failReason' and value in ('password_unavailable', 'no_repo_access', 'source_missing', 'other'):
            result[key] = value
        elif event in ('crash.collect', 'crash.source', 'crash.unified.chunk') and key in ('stopReason', 'outcome') and value in (
                'start', 'done', 'deadline', 'timeout', 'permission', 'exit', 'parse', 'error'):
            result[key] = value
        elif event in ('crash.collect', 'crash.source', 'crash.unified.skip') and key in ('skipReason', 'reason') and value == 'lag_ceiling':
            result[key] = value
        elif event == 'crash.unified.chunk' and key in ('chunk', 'timeoutS') and type(value) in (int, float) and math.isfinite(value) and value >= 0:
            result[key] = value
        elif key == 'stopReason' and value in ('done', 'budget', 'killed'):
            result[key] = value
        elif key == 'duMode' and value == 'links':
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
        elif key in NUMBERS and finite_number(value):
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
    if finite_number(duration_ms) and duration_ms >= 0:
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
    if name in ('cpu.sample', 'cpu.spike'):
        # Leave room for 240 spike lines and the other jobs in the daily file.
        limit = 7000 if name == 'cpu.sample' else 8192
        while len((json.dumps(row, separators=(',', ':'), allow_nan=False)+'\n').encode()) > limit:
            props = row['props']
            key = next((k for k in ('top', 'families', 'spawnedFamilies', 'runnableThreadsByFamily') if props.get(k)), None)
            if not props.get(key):
                break
            props[key].pop()
            props[key+'Omitted'] = props.get(key+'Omitted', 0)+1
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
                # A coverage gap must survive the cap before its checkpoint
                # retires it. Ordinary crash summaries remain capped.
                coverage_gap = (component == 'crashes' and name in (
                    'crash.unified.skip', 'crash.source', 'crash.collect') and
                    row.get('props', {}).get('skippedS', 0) > 0)
                if kind != 'error' and not coverage_gap:
                    return
            append(fd, row)
            return True
        finally:
            os.close(fd)
    except Exception:
        return False
