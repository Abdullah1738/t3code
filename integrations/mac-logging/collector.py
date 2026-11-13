#!/usr/bin/python3
"""Read-only Mac evidence collector with bounded disk diagnostics."""
from collections import Counter
import datetime as dt
import json
import math
import fcntl
import os
import plistlib
import tempfile
from pathlib import Path
import re
import subprocess
import time
from jobs import (read_state, save_state, state_path, directory_inventory,
                  SourceFailure, source_error, stderr_line, permission_denied, deadline_call)
from rollup import rollup
from toollog import emit, private_dir

REPORT_DIRS = [Path('/Library/Logs/DiagnosticReports'), Path('/Library/Logs/DiagnosticReports/Retired'),
               Path.home() / 'Library/Logs/DiagnosticReports']


UNIFIED_WINDOW_S = 3600
UNIFIED_CHUNK_S = 900
UNIFIED_BUDGET_S = 135


class ReportFailure(Exception):
    def __init__(self, cause, counts):
        self.cause = cause
        self.counts = counts


def report_header(path):
    with path.open('rb') as stream:
        header = stream.readline(4096).decode('utf-8', errors='replace')
    if '\ufffd' in header:
        raise ValueError('undecodable report header')
    return header


def report(path, since, until, deadline):
    counts = Counter()
    st = deadline_call(deadline, path.stat)
    if not since < st.st_mtime <= until:
        return counts
    kind = 'panic' if path.suffix == '.panic' else 'hang' if path.suffix in ('.hang', '.spin', '.shutdownStall') else 'app_crash'
    # Parse only the small .ips header. Stack traces, exception messages, and
    # process arguments never enter either the state or the shared log.
    process = re.split(r'[_-]\d{4}-?\d{2}', path.stem)[0]
    if path.suffix == '.ips':
        header = deadline_call(deadline, report_header, path)
        meta = json.loads(header)
        if not isinstance(meta, dict):
            raise ValueError('invalid report header')
        process = meta.get('app_name') or meta.get('name') or process
        bug = str(meta.get('bug_type', ''))
        if bug == '210':
            kind, process = 'panic', 'kernel'
        elif bug in ('109', '309'):
            kind = 'app_crash'
        else:
            # Stackshots, Jetsam and resource diagnostics are not proof
            # that the system hung or an application crashed.
            return counts
    if kind == 'panic':
        process = 'kernel'
    # Whitelist process-name characters; a diagnostic filename is untrusted.
    if not re.fullmatch(r'[A-Za-z0-9_. +()-]{1,100}', process):
        process = 'unknown'
    counts[kind, process] += 1
    return counts


def reports(root, since, until, deadline=None, completed=None, stats=None):
    counts = Counter()
    stats = {} if stats is None else stats
    completed = set() if completed is None else completed
    try:
        try:
            deadline_call(deadline, root.stat)
        except FileNotFoundError:
            return counts
        paths = iter(deadline_call(deadline, root.iterdir))
        while True:
            try:
                path = deadline_call(deadline, next, paths)
            except StopIteration:
                break
            if path.name in completed or path.suffix not in ('.panic', '.ips', '.crash', '.hang', '.spin', '.shutdownStall'):
                continue
            try:
                observed = report(path, since, until, deadline)
            except FileNotFoundError:
                observed = Counter()
            except SourceFailure:
                # A deadline leaves this file pending for the next run.
                raise
            except Exception:
                stats['unreadableCount'] = stats.get('unreadableCount', 0)+1
                observed = Counter()
            counts.update(observed)
            completed.add(path.name)
    except Exception as exc:
        raise ReportFailure(exc, counts) from None
    return counts


def unified(since, until, run=subprocess.run, timeout=60):
    if timeout <= 0:
        raise SourceFailure('timeout', 'collector budget exhausted')
    since = max(since, until-UNIFIED_WINDOW_S)
    def stamp(value):
        return dt.datetime.fromtimestamp(value, dt.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    result = run(['/usr/bin/log', 'show', '--style', 'json', '--timezone', 'UTC',
                  '--start', stamp(since), '--end', stamp(until+1), '--predicate',
                  'eventMessage CONTAINS "=== system boot" OR (process == "kernel" AND eventMessage CONTAINS "PMU") OR (process == "watchdogd" AND eventMessage CONTAINS "unresponsive")'],
                 capture_output=True, text=True, timeout=min(60, timeout),
                 env={**os.environ, 'LC_ALL': 'C'})
    if result.returncode:
        message = stderr_line(getattr(result, 'stderr', ''))
        raise SourceFailure('permission' if permission_denied(message) else 'exit',
                            message or 'log show exited unsuccessfully', result.returncode)
    counts = Counter()
    try:
        rows = json.loads(result.stdout or '[]')
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError('invalid log shape')
    except (TypeError, ValueError):
        raise SourceFailure('parse', 'invalid unified log data', result.returncode) from None
    for row in rows:
        timestamp = row.get('timestamp')
        try:
            at = dt.datetime.fromisoformat(re.sub(r'([+-]\d{2})(\d{2})$', r'\1:\2', timestamp.replace('Z', '+00:00')))
        except (AttributeError, TypeError, ValueError):
            raise SourceFailure('parse', 'invalid unified log data', result.returncode) from None
        if at.tzinfo is None:
            at = at.replace(tzinfo=dt.timezone.utc)
        if not since < at.timestamp() <= until:
            continue
        message = row.get('eventMessage', '')
        if not isinstance(message, str):
            raise SourceFailure('parse', 'invalid unified log data', result.returncode)
        if '=== system boot' in message:
            # Preserve boot time and collapse duplicate markers at that instant.
            counts['restart', 'kernel', at.timestamp()] = 1
        elif 'wdog' in message.lower() or 'unresponsive' in message.lower():
            counts['hang', 'system'] += 1
    return counts


def crash_observations(counts):
    for key, count in counts.items():
        kind, process = key[:2]
        props = dict(resourceKind=kind, process=process, count=count)
        if len(key) == 3:
            props['observedAt'] = key[2]
        emit('crashes', 'event', 'crash.observed', ok=True, props=props)


def collect(now=None, roots=None, log_reader=None, deadline=None):
    started = time.monotonic()
    deadline = min(started+165, deadline) if deadline is not None else started+165
    now = time.time() if now is None else now
    state = read_state('crashes')
    counts, errors = Counter(), 0
    report_roots = list(REPORT_DIRS if roots is None else roots)
    for i, root in enumerate(report_roots):
        key = 'reports%d' % i
        source_started = time.monotonic()
        pending = state.get(key+'Pending') or dict(since=state.get(key, now-3600), until=now, done=[])
        completed = set(pending['done'])
        stats = dict(unreadableCount=0)
        try:
            # Leave later sources a chance to run, but never outlive the
            # collector's absolute deadline. Unified uses whatever remains.
            source_deadline = min(deadline, source_started+10)
            if source_started >= source_deadline:
                raise SourceFailure('timeout', 'collector budget exhausted')
            observed = reports(root, pending['since'], pending['until'], source_deadline, completed, stats)
            counts.update(observed)
            state[key] = pending['until']
            state.pop(key+'Pending', None)
            emit('crashes', 'event', 'crash.source', ok=True,
                 props=dict(source=str(root), elapsedMs=(time.monotonic()-source_started)*1000,
                            partial=bool(stats['unreadableCount']), **stats))
        except Exception as exc:
            if isinstance(exc, ReportFailure):
                counts.update(exc.counts)
                exc = exc.cause
            pending['done'] = sorted(completed)
            state[key+'Pending'] = pending
            errors += 1
            source_error('crashes', 'crash.source', root, source_started, exc,
                         {'partial': bool(completed), **stats})
    crash_observations(counts)
    save_state('crashes', state)
    source_started = time.monotonic()
    since = state.get('unified', now-3600)
    window = state.get('unifiedRetry') or dict(windowStart=max(since, now-UNIFIED_WINDOW_S),
                                             windowEnd=now, skippedS=max(0, now-UNIFIED_WINDOW_S-since))
    window = dict(window, windowS=window['windowEnd']-window['windowStart'])
    window.update(chunks=math.ceil(max(0, window['windowS'])/UNIFIED_CHUNK_S), chunksDone=0)
    cursor = window['windowStart']
    unified_deadline = min(deadline, source_started+UNIFIED_BUDGET_S)
    try:
        if time.monotonic() >= unified_deadline:
            raise SourceFailure('timeout', 'collector budget exhausted')
        while cursor < window['windowEnd']:
            end = min(cursor+UNIFIED_CHUNK_S, window['windowEnd'])
            remaining = min(60, unified_deadline-time.monotonic())
            if remaining <= 0:
                raise SourceFailure('timeout', 'unified log budget exhausted')
            if log_reader is None:
                observed = deadline_call(unified_deadline, unified, cursor, end, timeout=remaining)
            else:
                observed = deadline_call(unified_deadline, log_reader, cursor, end)
            counts.update(observed)
            crash_observations(observed)
            cursor = end
            state['unified'] = cursor
            window['chunksDone'] += 1
            # The gap remains pending until the source result reports it.
            state['unifiedRetry'] = dict(windowStart=cursor, windowEnd=window['windowEnd'],
                                         skippedS=window['skippedS'])
            save_state('crashes', state)
        state['unified'] = window['windowEnd']
        state.pop('unifiedRetry', None)
        emit('crashes', 'event', 'crash.source', ok=True,
             props=dict(source='unified', elapsedMs=(time.monotonic()-source_started)*1000, **window))
    except Exception as exc:
        errors += 1
        state['unifiedRetry'] = dict(windowStart=cursor, windowEnd=window['windowEnd'],
                                     skippedS=window['skippedS'])
        source_error('crashes', 'crash.source', 'unified', source_started, exc, window)
        state['unifiedRetry']['skippedS'] = 0
    emit('crashes', 'error' if errors else 'perf', 'crash.collect', ok=not errors,
         duration_ms=(time.monotonic()-started)*1000,
         props={'count': sum(counts.values()), 'sourceErrors': errors, **window},
         error_tag='crash.source_unavailable' if errors else None)
    save_state('crashes', state)
    utc = dt.datetime.fromtimestamp(now, dt.timezone.utc)
    day = (utc.date()-dt.timedelta(days=1)).isoformat()
    if (utc.hour > 0 or utc.minute >= 5) and state.get('rollupDay') != day:
        try:
            deadline_call(deadline, rollup, day)
            state['rollupDay'] = day
            save_state('crashes', state)
            emit('rollup', 'event', 'log.rollup', ok=True)
        except Exception:
            emit('rollup', 'error', 'log.rollup', ok=False, error_tag='rollup.failed')
    return not errors


def elapsed_seconds(value):
    days, _, clock = value.rpartition('-')
    parts = [int(p) for p in clock.split(':')]
    if len(parts) not in (2, 3):
        raise ValueError('invalid etime')
    return int(days or 0)*86400 + sum(n*60**i for i, n in enumerate(reversed(parts)))


def daemon_state(run):
    props = dict(storagekitdStat=None, diskarbitrationdPid=None,
                 diskarbitrationdUptimeS=None, diskarbitrationdStat=None)
    try:
        result = run(['/bin/ps', '-axo', 'pid,etime,stat,comm'], capture_output=True,
                     text=True, timeout=3)
        if result.returncode:
            return props
        for line in result.stdout.splitlines():
            fields = line.split(None, 3)
            if len(fields) != 4:
                continue
            pid, uptime, stat, command = fields
            name = Path(command).name
            if name in ('storagekitd', 'diskarbitrationd'):
                props.update({name+'Pid': int(pid), name+'UptimeS': elapsed_seconds(uptime),
                              name+'Stat': stat})
    except Exception:
        pass
    return props


def alive(pid, run=subprocess.run):
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        # A stale PID marker can outlive a reboot or an interrupted collector.
        # Do not let PID reuse by an unrelated process disable probes forever.
        result = run(['/bin/ps', '-p', str(pid), '-o', 'comm='],
                     capture_output=True, text=True, timeout=5)
        return result.returncode == 0 and Path(result.stdout.strip()).name == 'diskutil'
    except ProcessLookupError:
        return False
    except (PermissionError, OSError, subprocess.TimeoutExpired):
        return True


def stop_child(child):
    # A kernel-stuck child may not acknowledge SIGKILL. Bound reaping too and
    # retain its PID marker so subsequent hourly runs cannot accumulate children.
    try:
        child.kill()
    except ProcessLookupError:
        pass
    try:
        child.communicate(timeout=5)
        return True
    except subprocess.TimeoutExpired:
        for stream in (child.stdout, child.stderr):
            if stream is not None:
                stream.close()
        return False


def sample_child(pid, root, run):
    props = {'blockedIn': 'unknown'}
    fd, name = tempfile.mkstemp(prefix='diskutil-', suffix='.sample', dir=root)
    os.close(fd)
    props['samplePath'] = name
    try:
        run(['/usr/bin/sample', str(pid), '2', '-file', name],
            capture_output=True, timeout=15)
        with open(name) as stream:
            for line in stream:
                match = re.search(r'^\s*[+!:| ]*\d+\s+.*?(SKHelperClient|SKManager|DiskArbitration|DASession)', line)
                if match:
                    props['blockedIn'] = match[1]
                    break
    except Exception:
        pass
    return props


def notify(text, key, run):
    env = dict(os.environ)
    env.pop('BUN_INSPECT', None)
    result = run(['/Users/ardud/.bun/bin/bun',
                  '/Users/ardud/.local/share/telegram-bridge/src/cli.ts', 'notify',
                  '--source', 'Mac Upkeep', '--severity', 'attention', '--text',
                  text,
                  '--key', key], capture_output=True, timeout=20, env=env)
    return result.returncode == 0


def alert(props, run, advance=True):
    state = read_state('disk-tooling-alert')
    pid = props.get('storagekitdPid')
    if not advance and pid is None:
        # Missing daemon metadata on a skipped probe is not a recovery signal.
        pid = state.get('pid')
    key = 'mac-upkeep:diskutil-hang:%s' % pid
    count = state.get('consecutiveTimeouts', 0) if state.get('pid') == pid else 0
    if advance:
        count = count + 1 if props['timedOut'] else 0
    state.update(pid=pid, consecutiveTimeouts=count)
    if count >= 2 and state.get('alertedKey') != key:
        if state.get('pendingKey') != key:
            uptime = props.get('storagekitdUptimeS')
            up = 'unknown' if uptime is None else '%.1fh' % (uptime/3600)
            state.update(pendingKey=key, pendingText=
                         "diskutil is hanging: storagekitd (pid %s, up %s) isn't answering. "
                         "First run: sudo killall storagekitd. If diskutil list still times out "
                         "after 10 s, run: sudo kill -9 %s." %
                         (pid if pid is not None else 'unknown', up,
                          pid if pid is not None else '<pid>'))
        # A timeout may occur after durable queueing. The bridge requires the
        # same key AND text on retry, even though daemon uptime has increased.
        save_state('disk-tooling-alert', state)
        try:
            sent = notify(state['pendingText'], key, run)
        except Exception:
            sent = False
        emit('disk', 'event' if sent else 'error', 'disk.tooling_alert', ok=sent,
             error_tag=None if sent else 'disk.notify_failed')
        if sent:
            state['alertedKey'] = key
    save_state('disk-tooling-alert', state)


def disk_tooling_probe(run=subprocess.run, popen=subprocess.Popen, is_alive=alive):
    props = dict(timedOut=False, exitCode=None, diskCount=None)
    ok, duration = False, None
    try:
        marker = state_path('disk-tooling-pid')
        props.update(daemon_state(run))
        with (marker.parent / 'disk-tooling.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                props['skipped'] = 'previous-probe-still-running'
                return props
            control = time.monotonic()
            try:
                result = run(['/usr/bin/hdiutil', 'info'], capture_output=True, timeout=10)
                props['hdiutilOk'] = result.returncode == 0
            except Exception:
                props['hdiutilOk'] = False
            props['hdiutilMs'] = (time.monotonic()-control)*1000
            samples = marker.parent / 'diskutil-samples'
            private_dir(samples)
            for path in samples.glob('diskutil-*.sample'):
                if path.stat().st_mtime < time.time()-7*86400:
                    path.unlink()
            previous = read_state('disk-tooling-pid').get('pid')
            if is_alive(previous):
                props['skipped'] = 'previous-probe-still-running'
                # Skips do not advance the timeout streak, but a failed alert
                # must still retry if the previous child could not be reaped.
                alert(props, run, advance=False)
                return props
            child = popen(['/usr/sbin/diskutil', 'list', '-plist'],
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            reaped = False
            start = time.monotonic()
            try:
                save_state('disk-tooling-pid', {'pid': child.pid})
                try:
                    output, _ = child.communicate(timeout=20)
                    reaped = True
                    props['exitCode'] = child.returncode
                    if child.returncode == 0:
                        disks = plistlib.loads(output).get('WholeDisks')
                        if isinstance(disks, list):
                            props['diskCount'] = len(disks)
                            ok = True
                except subprocess.TimeoutExpired:
                    # durationMs measures diskutil's deadline, excluding sampling
                    # and reaping; hdiutil has its own independent duration.
                    duration = (time.monotonic()-start)*1000
                    props['timedOut'] = True
                    props.update(sample_child(child.pid, samples, run))
                except Exception:
                    props['probeError'] = True
            finally:
                if duration is None:
                    duration = (time.monotonic()-start)*1000
                if not reaped:
                    reaped = stop_child(child)
                    props['exitCode'] = child.returncode
                if reaped:
                    marker.unlink(missing_ok=True)
            alert(props, run)
    except Exception:
        props['probeError'] = True
    finally:
        skipped = 'skipped' in props
        emit('disk', 'event' if skipped or ok else 'error', 'disk.tooling_probe',
             ok=None if skipped else ok, duration_ms=duration, props=props,
             error_tag='disk.probe_failed' if not skipped and not ok else None)
    return props


def main():
    deadline = time.monotonic()+290
    try:
        collect(deadline=deadline)
    except Exception:
        emit('crashes', 'error', 'crash.collect', ok=False, error_tag='crash.collect_failed')
    disk_tooling_probe()
    try:
        directory_inventory(deadline=deadline)
    except Exception:
        emit('disk', 'error', 'disk.inventory', ok=False, error_tag='disk.inventory_failed')


if __name__ == '__main__':
    main()
