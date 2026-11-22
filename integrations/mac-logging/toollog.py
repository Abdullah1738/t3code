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
VOLUME_THREAD_ID = re.compile(r'(?:thread:project:[^\s:]+:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')

CAP_BYTES = 50 * 1024 * 1024
# Explicit schema: unknown keys and nested payloads cannot enter a log by accident.
NUMBERS = set('internalFreeGb externalFreeGb baseline count bytes files snapshotAgeS resticExitCode exitCode found killed ageS autoFixed needsOwner critical high moderate medium low unknown skipped sourceErrors reports inventoryAgeS'.split())
NUMBERS.update('diskCount storagekitdPid storagekitdUptimeS diskarbitrationdPid diskarbitrationdUptimeS hdiutilMs'.split())
NUMBERS.update('elapsedMs deniedCount partialChildCount inventorySourceErrors'.split())
NUMBERS.update('rootsOk rootsTimeout rootsDenied scanMs'.split())
NUMBERS.update(('unreadableCount', 'turn', 'cachedCount', 'rootsComplete', 'rootsPartial',
                'childrenCached', 'oldestChildAgeS', 'unmeasuredCount', 'limitedCount', 'lagS'))
NUMBERS.update(('outsideRows', 'outsideFirst', 'outsideLast', 'unparsedRows'))
NUMBERS.update(('deltaGb', 'deltaWindowS', 'purgeableGb', 'localSnapshotCount'))
NUMBERS.update(('freeGb', 'floorGb', 'lowForS'))
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
NUMBERS.update(('timedOutCount', 'backedOffCount', 'estimatedCount', 'rootsCompleteWithDenied'))
for i in range(1, 4):
    NUMBERS.add('slowest%dMs' % i)
NUMBERS.update(('lockWaitMs', 'waitedMs'))
NUMBERS.update(('probeTimeouts', 'secondsInProbeTimeouts', 'probeAllowanceMedianS', 'allowanceS'))
NUMBERS.update(('cpuS', 'loadAvg1Start', 'loadAvg1End', 'loadAvg1Max', 'cpuSecondsDu',
                'wallSecondsDu', 'firstAttempts', 'firstAttemptTimeouts', 'secondsWasted'))
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
BOOLEANS.update(('completeWithDenied', 'estimate'))
BOOLEANS.update(('cached', 'acquired'))
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
    NUMBERS.add('topMover%dGb' % i)
PROBE_ERRORS = {prefix+field for prefix in ('internal', 'external')
                for field in ('PurgeableError', 'SnapshotError')}
TEXT.update('blockedIn samplePath skipped storagekitdStat diskarbitrationdStat'.split())
TEXT.add('failure')
TEXT.add('child')
TEXT.add('spawnPolicy')
TEXT.update('slowest%dPath' % i for i in range(1, 4))
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
        if values.get('reason') in ('swap', 'pressure', 'footprint', 'fseventsd', 'fseventsd_growth', 'growth'):
            result['reason'] = values['reason']
        if values.get('notifyError') is None or values.get('notifyError') in MEMORY_ERRORS:
            result['notifyError'] = values.get('notifyError')
        for key in ('pid', 'footprintGiB', 'growthGiBHour'):
            if values.get(key) is None or finite_number(values[key]) and values[key] >= 0:
                result[key] = values.get(key)
        if isinstance(values.get('command'), str):
            result['command'] = memory_command(values['command'])
        for key in ('escalation', 'fallback'):
            if type(values.get(key)) is bool:
                result[key] = values[key]
        return result
    numbers = {'pageSize', 'freePages', 'activePages', 'inactivePages', 'wiredPages',
               'speculativePages', 'purgeablePages', 'compressorPages', 'totalMb', 'usedMb',
               'mbPerS', 'tps', 'pid', 'memMb', 'cmprsMb', 'count', 'ppid1Count',
               'growthSamples', 'growthWindowS', 'growthMbPerHour'}

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
            elif key == 'start' and isinstance(item, str) and re.fullmatch(
                    r'[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}', item):
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
        elif key in ('top', 'watched', 'counts', 'fallback', 'growth') and (value is None or isinstance(value, list)):
            keys = ('command', 'count', 'ppid1Count') if key == 'counts' else ('pid', 'command', 'memMb', 'cmprsMb')
            if key == 'watched':
                keys += ('etime', 'error')
            if key != 'counts':
                keys += ('start',)
            if key == 'fallback':
                keys += ('error',)
            if key == 'growth':
                keys += ('growthSamples', 'growthWindowS', 'growthMbPerHour')
            result[key] = None if value is None else [row(p, keys) for p in value[:{'top': 15, 'watched': 512, 'counts': 5, 'fallback': 3, 'growth': 527}[key]]]
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
               'userPct', 'sysPct', 'nicePct', 'idlePct', 'kernelTaskPct', 'kernelTaskWindowS',
               'unattributedCpuPct', 'spawned', 'exited', 'uid', 'perMinute',
               'childCpuPct', 'childReadable', 'childUnreadable', 'childUncertainParents',
               'lostParents', 'unattributedAfterChildrenPct', 'observedSpawnsLowerBound',
               'observedSpawnsPerMinuteLowerBound'}

    def number(value):
        return finite_number(value) and 0 <= value <= 1e15

    def label(value, limit, encoded=False):
        def bounded(text):
            text = ''.join(c if c.isprintable() else ' ' for c in text)[:limit]
            # Records serialize with ensure_ascii: one Unicode character can
            # cost up to twelve bytes, so bound the encoded label too.
            while encoded and len(json.dumps(text))-2 > limit:
                text = text[:-1]
            return text
        if not isinstance(value, str):
            return None
        if isinstance(value, SystemFamily) and '/' not in value and not SECRET_LABEL.search(value):
            return bounded(str(value))
        try:
            value = janitor_redact(value)
        except (ImportError, OSError):
            return None
        if SECRET.search(value) or '/Users/' in value or '/home/' in value or value.startswith(('/', '~')):
            return '[redacted]'
        return bounded(value)

    for key, value in (values or {}).items():
        if key in numeric and (value is None or number(value)):
            result[key] = value
        elif key == 'baseline' and type(value) is bool:
            result[key] = value
        elif key == 'badLine':
            result[key] = label(value, 200)
        elif key == 'kernelTaskTime' and isinstance(value, str) and re.fullmatch(r'[0-9:.\-]{1,32}', value):
            result[key] = value
        elif key == 'kernelTaskSkipped' and value == 'rate':
            result[key] = value
        elif key in ('failure', 'hintError', 'systemCpuError', 'commandError', 'threadError', 'kernelTaskError') and (value is None or value in MEMORY_ERRORS):
            result[key] = value
        elif key == 'load' and (value is None or isinstance(value, list)):
            result[key] = None if value is None else [n for n in value[:3] if number(n)]
        elif key in ('top', 'families', 'spawnedFamilies', 'runnableThreadsByFamily', 'childCpu',
                     'childCpuFamilies', 'childCoverage', 'observedSpawnsByParent') and isinstance(value, list):
            result[key] = []
            for proc in value[:{'top': 20, 'families': 15, 'spawnedFamilies': 8, 'runnableThreadsByFamily': 8,
                               'childCpu': 10, 'childCpuFamilies': 10, 'childCoverage': 64,
                               'observedSpawnsByParent': 10}[key]]:
                if not isinstance(proc, dict):
                    continue
                keys = (('pid', 'ppid', 'family', 'parentFamily', 'state', 'hint', 'cpuS', 'cpuPct', 'rssMb', 'etime', 'cmd', 'parentCmd')
                        if key == 'top' else ('family', 'count', 'cpuPct', 'parentFamily')
                        if key == 'spawnedFamilies' else ('family', 'count')
                        if key == 'runnableThreadsByFamily' else ('pid', 'ppid', 'family', 'parentFamily', 'cpuPct')
                        if key == 'childCpu' else ('family', 'parentFamily', 'cpuPct')
                        if key == 'childCpuFamilies' else ('uid', 'reason', 'count')
                        if key == 'childCoverage' else ('pid', 'family', 'count', 'perMinute')
                        if key == 'observedSpawnsByParent' else ('family', 'count', 'cpuPct', 'rssMb'))
                clean = {}
                for field in keys:
                    item = proc.get(field)
                    if field in numeric and number(item):
                        clean[field] = item
                    elif field == 'reason' and item in ('permission', 'exited', 'identity', 'unavailable', 'timeout'):
                        clean[field] = item
                    elif field in ('family', 'parentFamily', 'hint'):
                        clean[field] = label(item, 72 if field == 'hint' else 64,
                                             encoded=key in ('childCpu', 'childCpuFamilies'))
                    elif field in ('cmd', 'parentCmd') and field in proc:
                        clean[field] = command_label(item) if isinstance(item, str) else None
                    elif field == 'state' and isinstance(item, str) and re.fullmatch(r'[A-Za-z?+<>-]{1,16}', item):
                        clean[field] = item
                    elif field == 'etime' and isinstance(item, str) and re.fullmatch(r'\d+(?:-\d+)?(?::\d+){1,2}', item):
                        clean[field] = item[:32]
                result[key].append(clean)
    return result


def u_text(value, limit):
    if not isinstance(value, str):
        return None
    if SECRET.search(value):
        return '[redacted]'
    return ''.join(c if c.isprintable() else ' ' for c in value)[:limit]


def u_episode_fields(values):
    if not isinstance(values, dict):
        return {}
    if any(not finite_number(values.get(k)) or not 0 <= values[k] <= 1e15
           for k in ('start', 'lastSeen', 'peakCount')):
        return {}
    end = values.get('end')
    if end is not None and (not finite_number(end) or not values['lastSeen'] <= end <= 1e15):
        return {}
    if values['start'] > values['lastSeen']:
        return {}
    result = {k: values[k] for k in ('start', 'lastSeen', 'peakCount')}
    result['end'] = end
    result['emptySamples'] = min(3, max(0, values.get('emptySamples', 0))) if type(values.get('emptySamples')) is int else 0
    volumes, comms = values.get('volumes', []), values.get('topComms', [])
    result['volumes'] = [u_text(v, 128) for v in volumes[:15] if isinstance(v, str)] if isinstance(volumes, list) else []
    result['topComms'] = []
    for proc in comms[:10] if isinstance(comms, list) else []:
        if (isinstance(proc, dict) and isinstance(proc.get('comm'), str)
                and type(proc.get('count')) is int and proc['count'] >= 0):
            result['topComms'].append(dict(comm=u_text(proc['comm'], 80), count=proc['count']))
    return result


def u_sample_fields(values):
    if not isinstance(values, dict):
        return {}
    result = {}
    if values.get('failure') in ('timeout', 'exit', 'parse', 'unavailable'):
        result['failure'] = values['failure']
    for key in ('count', 'lsofStuck'):
        if type(values.get(key)) is int and values[key] >= 0:
            result[key] = values[key]
    comms = values.get('byComm')
    if isinstance(comms, dict):
        result['byComm'] = {}
        for comm, n in sorted(((c, n) for c, n in comms.items() if isinstance(c, str) and type(n) is int and n >= 0),
                              key=lambda p: (-p[1], p[0]))[:50]:
            label = u_text(comm, 80)
            result['byComm'][label] = result['byComm'].get(label, 0)+n
    procs = values.get('procs')
    if isinstance(procs, list):
        result['procs'] = []
        for proc in procs[:15]:
            if not isinstance(proc, dict):
                continue
            if any(not finite_number(proc.get(k)) or proc[k] < 0 for k in ('pid', 'ppid', 'ageS', 'cpuS')):
                continue
            if any(type(proc[k]) is not int for k in ('pid', 'ppid')):
                continue
            clean = {k: proc[k] for k in ('pid', 'ppid', 'ageS', 'cpuS')}
            for key, limit in (('parentComm', 80), ('parentArgs', 200), ('stat', 16),
                               ('comm', 80), ('args', 200), ('volume', 128)):
                clean[key] = u_text(proc.get(key), limit)
            result['procs'].append(clean)
    callers = values.get('lsofCallers')
    if isinstance(callers, list):
        result['lsofCallers'] = []
        for caller in callers[:5]:
            if (isinstance(caller, dict) and all(type(caller.get(k)) is int and caller[k] >= 0 for k in ('parentPid', 'n'))):
                result['lsofCallers'].append(dict(parentPid=caller['parentPid'], n=caller['n'],
                                                 parentArgs=u_text(caller.get('parentArgs'), 200)))
    if isinstance(values.get('episode'), dict):
        result['episode'] = u_episode_fields(values['episode'])
    return result


def host_fields(values, event):
    numbers = set(('ncpu processCount swapTotalBytes swapUsedBytes swapAvailableBytes '
        'memoryPressure memorystatusLevel pressureLevel pageSize freePages activePages '
        'inactivePages compressedPages pageins pageouts swapins swapouts pageinsDelta '
        'pageoutsDelta swapinsDelta swapoutsDelta windowS runnable uninterruptible '
        'runnableThreads stateProcessesRead stateProcessesSkipped stateScanMs '
        'processesRead processesSkipped stateAgeS familiesOmitted processesOmitted').split())
    result = {}
    omitted_families = omitted_processes = 0
    for key, value in (values or {}).items():
        if key in numbers and (value is None or finite_number(value) and value >= 0):
            result[key] = value
        elif key in ('partial', 'stateScanPartial', 'stateScanTimedOut', 'statesEnabled', 'statesAvailable') and type(value) is bool:
            result[key] = value
        elif key == 'trigger' and value == 'cpu.timeout':
            result[key] = value
        elif key == 'load' and (value is None or isinstance(value, list) and len(value) == 3
                               and all(finite_number(v) and v >= 0 for v in value)):
            result[key] = value
        elif key == 'errors' and isinstance(value, list):
            result[key] = [v for v in value if v in ('load', 'swap', 'vm', 'processes',
                'states', 'memoryPressure', 'memorystatusLevel', 'pressureLevel')]
        elif key == 'families' and event == 'host.families_lite' and isinstance(value, list):
            counts = {}
            omitted_families = max(0, len(value)-512)
            omitted_processes = sum(row['count'] for row in value[512:]
                if isinstance(row, dict) and type(row.get('count')) is int and row['count'] >= 0)
            for row in value[:512]:
                if not isinstance(row, dict) or type(row.get('count')) is not int or row['count'] < 0:
                    continue
                name = row.get('name')
                if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.: +()-]{1,96}', name) or SECRET.search(name):
                    name = '[redacted]'
                counts[name] = counts.get(name, 0)+row['count']
            result[key] = [dict(name=name, count=count) for name, count in sorted(counts.items())]
    if omitted_families:
        result.update(partial=True, familiesOmitted=omitted_families, processesOmitted=omitted_processes)
    return result


def safe_fields(values, event=None):
    if event == 'host.overload':
        result = host_fields(values, 'host.families_lite')
        for key in ('phase', 'onset', 'conditions', 'durationS', 'notified'):
            value = (values or {}).get(key)
            if key == 'phase' and value in ('onset', 'peak', 'end'):
                result[key] = value
            elif key == 'onset' and isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT[0-9:.]+Z', value):
                result[key] = value
            elif key == 'conditions' and isinstance(value, list):
                result[key] = [v for v in value if v in ('swap', 'pressure', 'load', 'self-lag')]
            elif key == 'durationS' and finite_number(value) and value >= 0:
                result[key] = value
            elif key == 'notified' and type(value) is bool:
                result[key] = value
        result['peak'] = host_fields((values or {}).get('peak', {}), 'host.families_lite')
        for key in ('swapUsedBytes', 'swapTotalBytes'):
            if finite_number(result.get(key)):
                result[key.replace('Bytes', 'Mb')] = result[key]/2**20
        return result
    if event in ('host.vitals', 'host.families_lite'):
        return host_fields(values, event)
    if event == 'scan.volume_crawl':
        result = {}
        for key, value in (values or {}).items():
            if key in ('pid', 'ppid', 'argvOmitted') and type(value) is int and 0 <= value <= 2147483647:
                result[key] = value
            elif key in ('elapsedS', 'cpuPct') and (value is None or finite_number(value) and value >= 0):
                result[key] = value
            elif key in ('cwd', 'threadId') and (value is None or isinstance(value, str)):
                limit = 512 if key == 'threadId' else 2048
                if value is None or (len(json.dumps(value)) <= limit
                        and (key != 'threadId' or VOLUME_THREAD_ID.fullmatch(value))):
                    result[key] = value
                else:
                    result[key] = None
                    result['stringsOmitted'] = result.get('stringsOmitted', 0)+1
            elif key == 'argv' and isinstance(value, list):
                paths, size, omitted = [], 0, 0
                for path in value:
                    if not isinstance(path, str):
                        continue
                    encoded = len(json.dumps(path)) + 1
                    if encoded > 2048 or size+encoded > 6000:
                        omitted += 1
                    else:
                        paths.append(path)
                        size += encoded
                result[key] = paths
                if omitted:
                    result['argvOmitted'] = omitted
            elif key == 'parentChain' and isinstance(value, list):
                result[key] = [dict(pid=p['pid'], name=(p['name'] if len(json.dumps(p['name'])) <= 128 else '[omitted]'))
                               for p in value[:4] if isinstance(p, dict) and type(p.get('pid')) is int
                               and 0 <= p['pid'] <= 2147483647 and isinstance(p.get('name'), str)]
        return result
    if event and event.startswith('tailnet.'):
        result = {}
        for key, value in (values or {}).items():
            if key == 'backendState' and value in ('Running', 'Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'Starting', 'NoState', 'Unknown'):
                result[key] = value
            elif key in ('statusError', 'extensionError', 'homeProbeError', 'selfHttpsError') and value in (None, 'timeout', 'exit', 'parse', 'unavailable'):
                result[key] = value
            elif key in ('up', 'selfOnline', 'timedOut', 'homeReachable', 'confirmedDown', 'selfHttpsReachable') and (value is None or type(value) is bool):
                result[key] = value
            elif key in ('tailscaleIPsCount', 'exitCode', 'extensionPid', 'notUpChecks') and (value is None or type(value) is int):
                result[key] = value
            elif key in ('outcome', 'cliOutcome') and value in ('up', 'down', 'unknown'):
                result[key] = value
            elif key in ('cliMs', 'statusDurationMs', 'loadAvg1', 'outageStart') and (value is None or finite_number(value) and value >= 0):
                result[key] = value
            elif key == 'confirmedBy' and value in (None, 'home_tcp', 'peer_tcp', 'self_https'):
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
    if event == 'proc.u_parse':
        result = {}
        if isinstance(values, dict):
            if type(values.get('skippedRows')) is int and values['skippedRows'] >= 0:
                result['skippedRows'] = values['skippedRows']
            if isinstance(values.get('firstBadRow'), str):
                result['firstBadRow'] = u_text(values['firstBadRow'], 200)
        return result
    if event == 'proc.u_sample':
        return u_sample_fields(values)
    if event == 'proc.u_episode':
        return u_episode_fields(values)
    if event in ('cpu.sample', 'cpu.spike'):
        return cpu_fields(values)
    if event in ('disk.budget', 'disk.budget.over'):
        result = {}
        for key, value in (values or {}).items():
            if key in ('sizeGb', 'budgetGb', 'overBy', 'sizeAgeS') and (
                    value is None or finite_number(value) and value >= 0):
                result[key] = value
            elif key == 'path' and isinstance(value, str) and value.startswith('/') and not SECRET.search(value):
                result[key] = ''.join(c for c in value[:1024] if c.isprintable())
            elif key == 'owner' and isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,63}', value):
                result[key] = value
            elif key == 'source' and value in ('inventory', 'deep', 'stale'):
                result[key] = value
            elif key == 'status' and value in ('ok', 'stale', 'unmeasured', 'missing', 'symlink', 'unavailable'):
                result[key] = value
        return result
    if event == 'disk.ssd_read_probe':
        result = {}
        for key, value in (values or {}).items():
            if key in ('statMs', 'readMs', 'loadavg1') and (value is None or finite_number(value) and value >= 0):
                result[key] = value
            elif key == 'sandboxdThreads' and (value is None or type(value) is int and value >= 0):
                result[key] = value
            elif key == 'nice' and type(value) is int and -20 <= value <= 20:
                result[key] = value
            elif key == 'stuckPrior' and type(value) is bool:
                result[key] = value
            elif key == 'outcome' and value in ('ok', 'slow', 'timeout', 'error'):
                result[key] = value
            elif key == 'errno' and (value is None or isinstance(value, str) and re.fullmatch(r'E[A-Z0-9]{1,30}', value)):
                result[key] = value
            elif key == 'processType' and value in ('Standard', 'Background', 'Interactive', 'Adaptive', 'unknown'):
                result[key] = value
        return result
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
        if key in ('roots', 'secondsByRoot') and event in ('disk.inventory', 'disk.deep.end') and isinstance(value, dict):
            result[key] = {}
            for path, fields in list(value.items())[:13]:
                if not isinstance(path, str) or not ATOM.fullmatch(path) or SECRET.search(path):
                    continue
                if key == 'secondsByRoot' and type(fields) in (int, float) and math.isfinite(fields) and fields >= 0:
                    result[key][path] = fields
                elif key == 'roots' and isinstance(fields, dict):
                    allowed = {'deniedCount', 'timedOutCount', 'backedOffCount', 'estimatedCount', 'completeWithDenied'}
                    allowed.update('slowest%d%s' % (i, suffix) for i in range(1,4) for suffix in ('Path', 'Ms'))
                    result[key][path] = safe_fields({k:v for k,v in fields.items() if k in allowed})
        elif key == 'lockHolderCmd' and backup_command(value):
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
        elif event == 'disk.low_cleared' and key == 'reason' and value == 'emergency_recovery':
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
    if name == 'scan.volume_crawl':
        paths = row.get('props', {}).get('argv', [])
        while len((json.dumps(row, separators=(',', ':'), allow_nan=False)+'\n').encode()) > 8192 and len(paths) > 1:
            paths.pop()
            row['props']['argvOmitted'] = row['props'].get('argvOmitted', 0)+1
        if len((json.dumps(row, separators=(',', ':'), allow_nan=False)+'\n').encode()) > 8192:
            row['props'] = {k: v for k, v in row.get('props', {}).items()
                            if k in ('pid', 'ppid', 'elapsedS', 'cpuPct')}
            row['props']['detailOmitted'] = True
    if name in ('cpu.sample', 'cpu.spike'):
        # Leave room for 240 spike lines and the other jobs in the daily file.
        limit = 7000 if name == 'cpu.sample' else 8192
        while len((json.dumps(row, separators=(',', ':'), allow_nan=False)+'\n').encode()) > limit:
            props = row['props']
            key = next((k for k in ('top', 'families', 'spawnedFamilies', 'runnableThreadsByFamily',
                                    'childCoverage', 'observedSpawnsByParent',
                                    'childCpuFamilies', 'childCpu') if props.get(k)), None)
            if not props.get(key):
                break
            props[key].pop()
            props[key+'Omitted'] = props.get(key+'Omitted', 0)+1
    if name in ('proc.u_sample', 'proc.u_episode'):
        # At most 23.6 MB/day even when every minute has a wedge and Unicode argv.
        while len((json.dumps(row, separators=(',', ':'), allow_nan=False)+'\n').encode()) > 16384:
            props = row['props']
            # Keep one process row ahead of optional aggregate detail, so a
            # once-daily umount marker always corresponds to a written row.
            key = 'procs' if len(props.get('procs', [])) > 1 else next(
                (k for k in ('byComm', 'lsofCallers') if props.get(k)), None)
            target = props
            if key is None:
                target = props.get('episode', props)
                key = next((k for k in ('volumes', 'topComms') if target.get(k)), None)
            if key is None:
                key = 'procs' if props.get('procs') else None
                target = props
            if key is None:
                break
            if isinstance(target[key], dict):
                target[key].pop(next(reversed(target[key])))
            else:
                target[key].pop()
            target[key+'Omitted'] = target.get(key+'Omitted', 0)+1
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
                # Preserve the bounded host heartbeat through a noisy day's cap.
                host_sample = name in ('host.vitals', 'host.families_lite', 'host.overload')
                if kind != 'error' and not coverage_gap and not host_sample:
                    return
            append(fd, row)
            return True
        finally:
            os.close(fd)
    except Exception:
        return False
