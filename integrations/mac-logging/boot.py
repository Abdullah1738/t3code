"""Once-per-boot observations from the sources verified in Mac Upkeep #92."""
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time
from boot_identity import identity
from jobs import read_state, save_state, state_path, deadline_call, SourceFailure
from toollog import directory, emit, finite_number

UTC = dt.timezone.utc
REPORT_DIRS = [Path('/Library/Logs/DiagnosticReports'), Path('/Library/Logs/DiagnosticReports/Retired'),
               Path.home() / 'Library/Logs/DiagnosticReports']


def iso(epoch):
    return dt.datetime.fromtimestamp(epoch, UTC).isoformat().replace('+00:00', 'Z')


def epoch(text):
    text = re.sub(r'\s*([+-]\d{2}):?(\d{2})$', r'\1:\2', text.replace('Z', '+00:00'))
    text = re.sub(r'\.(\d+)', lambda m: '.'+m[1][:6].ljust(6, '0'), text)
    at = dt.datetime.fromisoformat(text)
    if at.tzinfo is None:
        raise ValueError('missing timezone')
    return at.timestamp()


def command(argv, run, timeout=5):
    result = run(argv, capture_output=True, text=True, timeout=timeout,
                 env={**{k: v for k, v in os.environ.items() if k != 'BUN_INSPECT'}, 'LC_ALL': 'C'})
    if result.returncode:
        raise OSError('command failed')
    return result.stdout


def parse_last(text, boot):
    rows = []
    for line in text.splitlines():
        match = re.match(r'(reboot|shutdown)\s+time\s+(.+?)\s*$', line)
        if match:
            at = time.mktime(time.strptime(match[2], '%a %b %d %Y %H:%M'))
            rows.append((match[1], at))
    # last prints only minutes. Match the target boot, never today's newer boot
    # when replaying historical evidence. The next reboot bounds its shutdown.
    target = next((i for i, row in enumerate(rows) if row[0] == 'reboot' and 0 <= boot-row[1] < 60), None)
    if target is None:
        return None, None
    older = rows[target+1:]
    previous = next((at for kind, at in older if kind == 'reboot'), None)
    shutdown = bool(older and older[0][0] == 'shutdown' and older[0][1] <= boot)
    return shutdown, previous


def parse_reset(text):
    faults = re.search(r'^[ \t]*Boot faults:[ \t]*(.*?)[ \t\r]*$', text, re.M)
    count = re.search(r'^[ \t]*Boot failure count:[ \t]*(\d+)[ \t\r]*$', text, re.M)
    if not count:
        raise ValueError('invalid ResetCounter fields')
    raw = faults[1] if faults and re.fullmatch(r'[A-Za-z0-9_ ,.-]{0,256}', faults[1]) else None
    return dict(raw=raw, bootFailureCount=int(count[1]))


def diagnostics(boot, roots=REPORT_DIRS, read=None):
    def read_header(path):
        with path.open() as stream:
            return stream.read(16384)
    read = read or read_header
    reset, panic, stalls, jetsam, errors = [], [], [], [], []
    for root in roots:
        try:
            paths = list(root.iterdir())
        except FileNotFoundError:
            continue
        except OSError:
            errors.append('directory_unreadable')
            continue
        for path in paths:
            if not (path.name.startswith(('ResetCounter-', 'JetsamEvent-')) or path.suffix in ('.panic', '.ips', '.shutdownStall')):
                continue
            try:
                at = path.stat().st_mtime
                header = None
                # Report timestamps survive copying/retiring files; panic files
                # without a JSON header use filesystem time as a fallback.
                if path.suffix in ('.diag', '.ips'):
                    if not boot-7200 <= at <= boot+600:
                        # Old report mtimes can change in Retired; date in the
                        # basename still permits the bounded header read.
                        local_day = dt.datetime.fromtimestamp(boot).strftime('%Y-%m-%d')
                        if local_day not in path.name:
                            continue
                    text = read(path)
                    header = json.loads(text.splitlines()[0])
                    at = epoch(header['timestamp'])
                if path.name.startswith('ResetCounter-') and boot <= at <= boot+180:
                    parsed = parse_reset(text)
                    reset.append((at, path, parsed))
                    if parsed['raw'] is None:
                        errors.append('reset_faults_unavailable')
                if abs(at-boot) <= 600 and (path.suffix == '.panic' or header and str(header.get('bug_type')) == '210'):
                    panic.append((at, str(path)))
                if path.suffix == '.shutdownStall':
                    # Native decoding/retirement can update mtime. The report's
                    # local timestamp remains in its generated basename.
                    named = re.match(r'shutdown_stall_(\d{4}-\d{2}-\d{2}-\d{6})_', path.name)
                    if named:
                        at = time.mktime(time.strptime(named[1], '%Y-%m-%d-%H%M%S'))
                    if abs(at-boot) <= 600:
                        stalls.append((at, str(path)))
                if boot-7200 <= at <= boot and path.name.startswith('JetsamEvent-'):
                    jetsam.append((at, str(path)))
            except (OSError, ValueError, KeyError, TypeError, IndexError):
                errors.append('reset_unreadable' if path.name.startswith('ResetCounter-') else 'report_unreadable')
    latest = max(reset, key=lambda r: r[0]) if reset else None
    return dict(bootFaults=latest[2] if latest else None,
                panic=dict(present=bool(panic), path=max(panic)[1] if panic else None),
                shutdownStall=dict(present=bool(stalls), path=max(stalls)[1] if stalls else None),
                jetsamReportsLast2h=dict(count=len(jetsam), newestPath=max(jetsam)[1] if jetsam else None)), dict(
                    bootFaults=dict(read='ResetCounter', path=str(latest[1]) if latest else None,
                                    error=','.join(sorted(set(errors))) or (None if latest else 'missing')),
                    panic=dict(read='DiagnosticReports', error=','.join(sorted(set(errors))) or None),
                    shutdownStall=dict(read='DiagnosticReports filename/mtime', error=','.join(sorted(set(errors))) or None),
                    jetsamReportsLast2h=dict(read='DiagnosticReports', error=','.join(sorted(set(errors))) or None))


def previous_samples(boot, root, previous=None):
    last = sample = previous_epoch = sample_epoch = None
    previous_at = float('-inf')
    sources = {}
    day = dt.datetime.fromtimestamp(boot, UTC).date()
    # Stream at most one capped (50 MiB) file per retained day under the caller's
    # five-second budget. A late first run must still find pre-boot rows near
    # the beginning of today's file rather than accidentally using yesterday.
    for offset in range(31):
        path = root/((day-dt.timedelta(days=offset)).isoformat()+'.ndjson')
        try:
            with path.open('rb') as stream:
                consumed = 0
                while consumed < 51*1024*1024:
                    line = stream.readline(65536)
                    if not line:
                        break
                    consumed += len(line)
                    try:
                        row = json.loads(line)
                        at = epoch(row['ts'])
                        if row.get('tool') != 'mac' or at >= boot:
                            continue
                        props = row.get('props', {})
                        old_boot = row.get('bootEpoch', props.get('boot') if row.get('name') == 'memory.sample' else None)
                        if finite_number(old_boot) and old_boot < boot and at > previous_at:
                            previous_epoch, previous_at = old_boot, at
                        if last is None or at > last:
                            last = at
                            sources['lastRow'] = str(path)
                        if row.get('name') in ('cpu.sample', 'memory.sample') and (sample is None or at > sample):
                            sample = at
                            sample_epoch = old_boot if finite_number(old_boot) and old_boot < boot else None
                            sources['lastSample'] = str(path)
                    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
                        continue
                if consumed >= 51*1024*1024:
                    sources['error'] = 'size_limit'
        except FileNotFoundError:
            continue
        except OSError:
            sources['error'] = 'unreadable'
            continue
        if last is not None and sample is not None and previous_epoch is not None:
            break
    if previous and previous < boot and (previous_epoch is None or previous > previous_epoch):
        previous_epoch = previous
    sample_boot = sample_epoch if sample_epoch is not None else previous_epoch
    uptime = sample-sample_boot if sample is not None and sample_boot is not None and sample >= sample_boot else None
    return dict(previousBootTime=iso(previous_epoch) if previous_epoch is not None else None,
                uptimeAtPreviousSample=round(uptime, 3) if uptime is not None else None,
                lastSampleGapS=round(boot-last, 3) if last is not None else None), sources


def unified(boot, run):
    from collector import unified_command
    start, end = (dt.datetime.fromtimestamp(at, UTC).strftime('%Y-%m-%d %H:%M:%S')
                  for at in (math.ceil(boot), math.floor(boot)+180))
    text = command(['/usr/bin/log', 'show', '--style', 'ndjson', '--timezone', 'UTC',
                    '--start', start, '--end', end, '--predicate',
                    'eventMessage CONTAINS[c] "Previous shutdown cause" OR process == "DumpPanic"'],
                   unified_command if run is subprocess.run else run, timeout=15)
    cause, dump, dropped = None, None, 0
    for line in text.splitlines():
        if not line.startswith('{'):
            continue
        row = json.loads(line)
        at = epoch(row['timestamp'])
        if not boot <= at <= boot+180:
            dropped += 1
            continue
        msg = row.get('eventMessage', '')
        match = re.search(r'Previous shutdown cause:\s*(-?\d+)', msg, re.I)
        if match:
            cause = dict(code=int(match[1]), meaning='unmapped')
        if 'no paniclog data' in msg or 'all zeros' in msg:
            dump = 'no_paniclog_data'
    return cause, dict(read='unified', windowStart=start, windowEnd=end, droppedRows=dropped, dumpPanic=dump)


def collect(boot, roots=REPORT_DIRS, root=None, run=subprocess.run, previous=None):
    from shutdown_evidence import shutdown_context, parse_shutdown, kernel_reasons, stall_interval
    try:
        props, sources = deadline_call(time.monotonic()+5, diagnostics, boot, roots)
    except (OSError, SourceFailure):
        props = dict(bootFaults=None, panic=dict(present=False, path=None),
                     shutdownStall=dict(present=False, path=None),
                     jetsamReportsLast2h=dict(count=0, newestPath=None))
        sources = {key: dict(read='DiagnosticReports', error='unavailable') for key in props}
    stall = props['shutdownStall']
    stall.update(sampleStart=None, sampleEnd=None)
    if stall['present']:
        try:
            stall.update(deadline_call(time.monotonic()+20, stall_interval, stall['path'], run))
            sources['shutdownStall'].update(sampleRead='spindump -i', sampleError=None)
        except (OSError, ValueError, SourceFailure, subprocess.TimeoutExpired):
            sources['shutdownStall'].update(sampleRead='spindump -i', sampleError='unavailable')
    try:
        context, context_source = shutdown_context(boot, run)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        context, context_source = parse_shutdown('', boot)
        context_source['error'] = 'unavailable'
    props.update(context, shutdownReason=None, bootReason=None)
    sources.update(shutdownRequest={k: v for k, v in context_source.items() if k != 'verdict'},
                   forcedWatchdogTimeout=dict(context_source))
    try:
        props.update(kernel_reasons(boot, run))
        reason_source = dict(read='sysctl same kern.boottime', error=None)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        reason_source = dict(read='sysctl same kern.boottime', error='unavailable_or_different_boot')
    for key in ('shutdownReason', 'bootReason'):
        sources[key] = dict(reason_source)
        if props[key] is None:
            sources[key]['error'] = sources[key]['error'] or 'missing'
    try:
        prior, sample_source = deadline_call(time.monotonic()+5, previous_samples, boot, root or directory(), previous)
    except (OSError, SourceFailure):
        prior = dict(previousBootTime=iso(previous) if previous else None,
                     uptimeAtPreviousSample=None, lastSampleGapS=None)
        sample_source = dict(error='unavailable')
    props.update(prior, bootTime=iso(boot), clean=False, shutdownCause=None)
    sources.update(bootTime=dict(read='kern.boottime'),
                   previousBootTime=dict(read='ndjson'), uptimeAtPreviousSample=dict(read='ndjson'),
                   lastSampleGapS=dict(read='ndjson', **sample_source))
    shutdown = None
    try:
        shutdown, _ = parse_last(command(['/usr/bin/last', '-n', '64', '-y', 'reboot', 'shutdown'], run), boot)
        sources['clean'] = dict(read='last reboot shutdown', error=None if shutdown is not None else 'boot_not_found')
        # Minute-resolution last dates are evidence, not the exact previous epoch.
        sources['clean']['shutdownRecord'] = shutdown
    except (OSError, ValueError, subprocess.TimeoutExpired):
        sources['clean'] = dict(read='last reboot shutdown', error='unavailable')
    try:
        props['shutdownCause'], sources['shutdownCause'] = unified(boot, run)
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        sources['shutdownCause'] = dict(read='unified', error='unavailable')
    # #92 proved no numeric mapping on this Mac. Preserve any raw code without
    # silently importing Intel meanings. Positive fault/panic evidence wins.
    faults = props['bootFaults']
    abnormal = props['panic']['present'] or props['forcedWatchdogTimeout'] is True or bool(faults and (
        faults['bootFailureCount'] > 0 or re.search(r'btn_rst|btn_seq_reset|crash|panic', faults['raw'] or '', re.I)))
    props['clean'] = shutdown is True and not abnormal
    props['shutdownRecord'] = shutdown
    sources['shutdownRecord'] = dict(sources['clean'])
    sources['clean']['abnormalEvidence'] = bool(abnormal)
    props['source'] = sources
    return props


def alert_text(props):
    if props['clean'] and props.get('shutdownStall', {}).get('present'):
        request = props.get('shutdownRequest') or {}
        return '%s requested by %s at %s, shutdown stalled.' % (
            request.get('operation') or 'restart/shutdown',
            request.get('senderName') or request.get('senderBundle') or 'unknown process',
            request.get('requestedAt') or 'unknown time')
    faults = props['bootFaults']
    cause = faults['raw'] if faults and faults['raw'] else 'panic' if props['panic']['present'] else 'unknown cause'
    if faults and faults['bootFailureCount'] > 0:
        cause += ' (boot failure count %d)' % faults['bootFailureCount']
    if props['shutdownCause']:
        cause += ' (shutdown cause %s)' % props['shutdownCause']['code']
    gap = props['lastSampleGapS']
    return 'Unclean boot %s; %s; logging gap %s (freeze duration unknown).' % (
        props['bootTime'], cause, 'unknown' if gap is None else '%.1fs' % gap)


RECOVERY_BYTES = 1024*1024


def log_size(path):
    try:
        return path.stat().st_size
    except FileNotFoundError:
        return 0


def recovered(path, boot_time, offset):
    try:
        with path.open('rb') as stream:
            # Log truncation/replacement invalidates an older byte position.
            if offset > os.fstat(stream.fileno()).st_size:
                offset = 0
            stream.seek(offset)
            consumed = 0
            while consumed < RECOVERY_BYTES:
                # Complete each bounded line before checkpointing its offset,
                # so the byte budget cannot split a small boot marker in two.
                line = stream.readline(65536)
                if not line:
                    return False, stream.tell(), True
                consumed += len(line)
                try:
                    row = json.loads(line)
                    if (row.get('tool') == 'mac' and row.get('name') == 'boot.observed'
                            and row.get('props', {}).get('bootTime') == boot_time):
                        return True, stream.tell(), True
                except (ValueError, AttributeError):
                    continue
            return False, stream.tell(), False
    except FileNotFoundError:
        return False, 0, True


def observation_done(state):
    return state.get('emitted') and state.get('alerted') and state.get('rollupDone')


def finish_observation(state, checkpoint, run, notify, now, collect_fn=None):
    if 'props' not in state:
        if now < state['bootEpoch']+600:
            return
        props = (collect_fn or collect)(state['bootEpoch'], run=run,
                                       previous=state.get('previousBootEpoch'))
        # These sysctls cannot be recovered from a later boot. Other evidence
        # is collected only after the full panic-file window has closed.
        for key, value in state.get('kernelReasons', {}).items():
            if value is not None:
                props[key] = value
                props['source'][key] = dict(read='sysctl same kern.boottime', error=None)
        props['observedAt'] = now
        state.update(props=props,
                     alerted=props['clean'] and not props.get('shutdownStall', {}).get('present'))
        checkpoint()
    if not state.get('emitted'):
        path = directory()/(dt.datetime.fromtimestamp(state['eventAt'], UTC).date().isoformat()+'.ndjson')
        found = False
        if state.get('appendAttempted', True):
            # Recover an append completed before its state checkpoint.
            # Older pending states start at zero and make bounded progress.
            found, offset, complete = deadline_call(time.monotonic()+5, recovered, path,
                state['props']['bootTime'], state.get('recoveryOffset', 0))
            # A recovered marker and its consumed cursor commit together;
            # saving only the cursor could skip that marker after a crash.
            state.update(recoveryOffset=offset, emitted=found)
            checkpoint()
            if not complete:
                return
        if not found:
            # Record the earliest possible append position before calling
            # emit: a crash/uncertain write only needs to scan this tail.
            state.update(appendAttempted=True,
                         recoveryOffset=deadline_call(time.monotonic()+5, log_size, path))
            checkpoint()
            if not emit('boot', 'event', 'boot.observed', props=state['props'], ok=True,
                        now=dt.datetime.fromtimestamp(state['eventAt'], UTC)):
                return
        state['emitted'] = True
        checkpoint()
    if not state.get('alerted'):
        if notify is None:
            from collector import notify as send
        else:
            send = notify
        key = 'mac-boot:%.6f' % state['bootEpoch']
        try:
            sent = send(alert_text(state['props']), key, run, timeout=10)
        except Exception:
            sent = False
        state['alerted'] = bool(sent)
        checkpoint()
        emit('boot', 'event' if sent else 'error', 'boot.alert', ok=bool(sent),
             error_tag=None if sent else 'boot.notify_failed')
    if not state.get('rollupDone'):
        event_day = dt.datetime.fromtimestamp(state['eventAt'], UTC).date()
        if event_day < dt.datetime.fromtimestamp(now, UTC).date():
            from rollup import rollup
            try:
                deadline_call(time.monotonic()+5, rollup, event_day.isoformat(), publish=True,
                              now=dt.datetime.fromtimestamp(now, UTC))
            except Exception:
                emit('rollup', 'error', 'log.rollup', ok=False, error_tag='rollup.failed')
                return
        state['rollupDone'] = True
        checkpoint()


def observe(now=None, run=subprocess.run, boot=None, collect_fn=None, notify=None):
    boot_id = identity() if boot is None else dict(bootEpoch=boot)
    if not boot_id:
        return
    boot = boot_id['bootEpoch']
    now = time.time() if now is None else now
    with state_path('boot').with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = read_state('boot')
        if state.get('bootEpoch') != boot:
            previous = state.get('bootEpoch')
            pending = state.pop('pending', [])
            if state and not observation_done(state):
                pending.append(state)
            # Persist identity before querying evidence or waiting: this boot
            # may reset again before its ten-minute panic window closes.
            state = dict(bootEpoch=boot, previousBootEpoch=previous, emitted=False,
                         eventAt=boot, appendAttempted=False, pending=pending)
            save_state('boot', state)

        def checkpoint():
            save_state('boot', state)

        if 'props' not in state and 'kernelReasons' not in state and now < boot+600:
            from shutdown_evidence import kernel_reasons
            try:
                state['kernelReasons'] = kernel_reasons(boot, run)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                state['kernelReasons'] = {}
            checkpoint()

        pending = state.get('pending', [])
        if pending:
            # Bound backlog work to one record per invocation. A bridge outage
            # must neither discard earlier boots nor delay today's observation.
            record = pending[0]
            try:
                finish_observation(record, checkpoint, run, notify, now, collect_fn)
            except (OSError, SourceFailure):
                emit('boot', 'error', 'boot.collect', ok=False, error_tag='boot.collect_failed')
            if observation_done(record):
                pending.pop(0)
                checkpoint()
        finish_observation(state, checkpoint, run, notify, now, collect_fn)
        return state.get('props')


def check():
    try:
        observe()
    except Exception:
        emit('boot', 'error', 'boot.collect', ok=False, error_tag='boot.collect_failed')
