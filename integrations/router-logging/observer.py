"""Sparse observer diagnostics; nested phase durations exclude their children."""
import contextlib
import contextvars
import ctypes
import datetime as dt
import functools
import math
import os
import re
import subprocess
import sys
import time

from toollog import emit, trimmed_stderr

JOB = 'com.ardud.9router-log-poll'
FIELDS = {'history_scan_parse': 'historyScanParseMs', 'rollup_write': 'rollupWriteMs',
          'state_save': 'stateSaveMs', 'lock_wait': 'lockWaitMs',
          'listener_history': 'listenerHistoryMs', 'pool_history': 'poolHistoryMs',
          'history_refresh': 'historyRefreshMs', 'launchctl': 'launchctlMs',
          'tcp': 'tcpMs', 'providers_fetch': 'providersFetchMs',
          'usage_fetch': 'usageFetchMs', 'stats_fetch': 'statsFetchMs',
          'snapshot': 'snapshotMs', 'log_write': 'logWriteMs'}
_active = contextvars.ContextVar('observer_timing', default=None)


def continuous_clock():
    if hasattr(time, 'CLOCK_BOOTTIME'):
        return lambda: time.clock_gettime(time.CLOCK_BOOTTIME) * 1000
    if sys.platform == 'darwin':
        try:
            library = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
            class Timebase(ctypes.Structure):
                _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
            base = Timebase()
            if library.mach_timebase_info(ctypes.byref(base)) == 0 and base.denom:
                library.mach_continuous_time.restype = ctypes.c_uint64
                return lambda: library.mach_continuous_time() * base.numer / base.denom / 1000000
        except (OSError, AttributeError):
            pass
    return lambda: None


_continuous = continuous_clock()


def clock_sample():
    try:
        continuous = _continuous()
    except (OSError, ValueError):
        continuous = None
    return dict(wallMs=time.time() * 1000, monotonicMs=time.monotonic() * 1000,
                continuousMs=continuous, pid=os.getpid())


def iso(value):
    return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def launchctl_print(job, timeout=5):
    try:
        result = subprocess.run(['launchctl', 'print', job], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, errors='replace', timeout=timeout)
        output = dict(launchctlExit=result.returncode, launchctlStderr=trimmed_stderr(result.stderr))
        for key in ('state', 'pid'):
            match = re.search(r'^\s*' + key + r' = ([^\n]+)', result.stdout, re.M)
            if match:
                value = match[1].strip()
                if key == 'pid' and value.isdecimal():
                    output['jobPid'] = int(value)
                elif key == 'state' and re.fullmatch(r'[a-z -]{1,40}', value):
                    output['jobState'] = value.replace(' ', '_')
        if result.returncode == 113:
            output['jobState'] = 'absent'
        return output
    except subprocess.TimeoutExpired as error:
        stderr = error.stderr
        if isinstance(stderr, bytes):
            stderr = stderr.decode('utf-8', errors='replace')
        return dict(launchctlExit='timeout', launchctlStderr=trimmed_stderr(stderr))
    except OSError as error:
        return dict(launchctlExit='oserror', launchctlStderr=trimmed_stderr(str(error)))


def job_snapshot():
    try:
        result = launchctl_print(f'gui/{os.getuid()}/{JOB}', timeout=.5)
        return dict(jobState=result.get('jobState', 'unknown'), jobPid=result.get('jobPid', 0),
                    jobExit=result['launchctlExit'])
    except Exception:
        # Diagnostics must not prevent listener checks or mask a poll failure.
        return dict(jobState='unknown', jobPid=0, jobExit='snapshot_error')


def launchctl_cause(props):
    value = props.get('launchctlExit')
    if type(value) is int or value in ('timeout', 'oserror'):
        return 'launchctl_unknown:' + str(value)
    return 'other'


GAP_NAMES = {'observer.gap', 'guard.tick_late', 'poll.phases', 'rollup.phases', 'pool.endpoint.get'}


def gap_summary(rows, day, generated):
    floor = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), dt.timezone.utc).timestamp() * 1000
    ceiling = min(floor + 86400000, generated.timestamp() * 1000)
    groups = {'pollGaps': [], 'guardGaps': []}
    seen = set()
    for row in sorted(rows, key=lambda row: str(row.get('ts', ''))):
        if row.get('name') not in GAP_NAMES or row.get('component') not in ('guard', 'poller', 'pool-alerts'):
            continue
        props = row.get('props', {})
        if not isinstance(props, dict):
            continue
        try:
            start = props.get('startedAtMs')
            end = props.get('finishedAtMs')
            if start is None or end is None:
                parsed = [dt.datetime.fromisoformat(props[key].replace('Z', '+00:00')) for key in ('start', 'end')]
                if any(value.tzinfo is None for value in parsed):
                    continue
                start, end = [value.timestamp() * 1000 for value in parsed]
            if not all(type(value) in (int, float) and math.isfinite(value) for value in (start, end)):
                continue
            if end - start <= 120000 or end > generated.timestamp() * 1000:
                continue
            duration = row.get('durationMs', 0)
            wall_gap = props.get('wallGapMs', 0)
            if row['name'] != 'observer.gap' and not any(type(value) in (int, float) and value > 120000 for value in (duration, wall_gap)):
                continue
            overlap = max(0, min(ceiling, end) - max(floor, start))
            if not overlap:
                continue
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
            continue
        component = row.get('component')
        identity = (row.get('name'), component, start, end)
        if identity in seen:
            continue
        seen.add(identity)
        phase_name = props.get('phase')
        if row.get('name') == 'pool.endpoint.get':
            phase_name = 'pool_fetch'
        cause = props.get('cause')
        if cause not in ('sleep_gap', 'agent_not_running', 'other'):
            cause = 'tick_blocked:' + phase_name if phase_name in (*FIELDS, 'pool_fetch') else 'other'
        bucket = groups['guardGaps' if component == 'guard' else 'pollGaps']
        bucket.append(dict(number=len(bucket) + 1, start=iso(start), end=iso(end),
                           cause=cause, component=component, durationMs=round(overlap, 3)))
    return groups


def gap(previous, current, cadence_ms=15000):
    if not isinstance(previous, dict):
        return None
    for sample in (previous, current):
        if not all(type(sample.get(key)) in (int, float) and math.isfinite(sample[key]) for key in ('wallMs', 'monotonicMs')):
            return None
    wall = current['wallMs'] - previous['wallMs']
    mono = current['monotonicMs'] - previous['monotonicMs']
    if max(wall, mono) <= cadence_ms + 120000 or wall < 0:
        return None
    suspend = 0
    before, after = previous.get('continuousMs'), current.get('continuousMs')
    if all(type(value) in (int, float) and math.isfinite(value) for value in (before, after)) and mono >= 0:
        suspend = max(0, after - before - mono)
    cause = 'other'
    if previous.get('jobState') in ('stopped', 'absent'):
        cause = 'agent_not_running'
    elif current.get('pid') == previous.get('pid') and suspend > 120000:
        # A suspend-aware clock avoids calling a wall-clock adjustment sleep.
        cause = 'sleep_gap'
    return dict(start=iso(previous['wallMs']), end=iso(current['wallMs']), cause=cause,
                wallGapMs=wall, monotonicGapMs=mono, sleepGapMs=suspend,
                pid=current.get('pid', 0), previousPid=previous.get('pid', 0),
                jobStateStart=previous.get('jobState', 'unknown'), jobStateEnd=current.get('jobState', 'unknown'),
                jobPidStart=previous.get('jobPid', 0), jobPidEnd=current.get('jobPid', 0),
                jobExitStart=previous.get('jobExit', 'unknown'), jobExitEnd=current.get('jobExit', 'unknown'))


@contextlib.contextmanager
def phase(name):
    timing = _active.get()
    if timing is None:
        yield
        return
    frame = [time.monotonic(), 0]
    timing.stack.append(frame)
    try:
        yield
    finally:
        elapsed = (time.monotonic() - frame[0]) * 1000
        timing.values[name] += max(0, elapsed - frame[1])
        timing.stack.pop()
        if timing.stack:
            timing.stack[-1][1] += elapsed


def measured(name):
    def decorate(function):
        @functools.wraps(function)
        def run(*args, **kwargs):
            with phase(name):
                return function(*args, **kwargs)
        return run
    return decorate


class Timings:
    def __init__(self, component='poller', name='poll.phases', threshold_ms=30000, start=None):
        self.component, self.name, self.threshold = component, name, threshold_ms
        self.start = start
        self.stack, self.values = [], {name: 0 for name in FIELDS}

    def __enter__(self):
        self.start = self.start or dict(clock_sample(), **job_snapshot())
        self.token = _active.set(self)
        return self

    def __exit__(self, *_):
        _active.reset(self.token)
        self.end = dict(clock_sample(), **job_snapshot())
        elapsed = max(0, self.end['monotonicMs'] - self.start['monotonicMs'])
        wall = self.end['wallMs'] - self.start['wallMs']
        missing = gap(self.start, self.end, cadence_ms=0)
        slowest = max(self.values, key=self.values.get)
        if max(self.values.values()) <= self.threshold and max(elapsed, wall) <= 120000:
            return
        props = dict(start=iso(self.start['wallMs']), end=iso(self.end['wallMs']),
                     startedAtMs=self.start['wallMs'], finishedAtMs=self.end['wallMs'],
                     monotonicStartMs=self.start['monotonicMs'], monotonicEndMs=self.end['monotonicMs'],
                     wallGapMs=wall, monotonicGapMs=elapsed,
                     sleepGapMs=missing['sleepGapMs'] if missing else 0,
                     phase=slowest if self.values[slowest] > self.threshold else 'other',
                     cause='tick_blocked:' + slowest if self.values[slowest] > self.threshold else 'other',
                     pid=self.start['pid'], ppid=os.getppid())
        if missing and missing['cause'] == 'sleep_gap':
            props['cause'] = 'sleep_gap'
        for key in ('jobState', 'jobPid', 'jobExit'):
            props[key + 'Start'] = self.start.get(key, 'unknown')
            props[key + 'End'] = self.end.get(key, 'unknown')
        props.update({field: round(self.values[name], 3) for name, field in FIELDS.items()})
        emit(self.component, self.name, kind='perf', durationMs=elapsed, props=props)


def observed(component='poller', name='poll.phases'):
    def decorate(function):
        @functools.wraps(function)
        def run(*args, **kwargs):
            with Timings(component, name):
                return function(*args, **kwargs)
        return run
    return decorate
