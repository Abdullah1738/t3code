"""Sparse observer diagnostics; nested phase durations exclude their children."""
import contextlib
import contextvars
import ctypes
import datetime as dt
import functools
import json
import math
import os
import re
import resource
import subprocess
import sys
import time

from host import Sampler, clean_host, poll_props
from toollog import emit, trimmed_stderr
from causes import PHASES, RESOURCE_FIELDS, BYTE_PHASES, BYTE_FIELDS, WAIT_FIELDS, SUBSTEPS, SUBSTEP_FIELDS, TIMEOUT_FIELDS, gap_info, launchctl_info, phase_cause, positive

JOB = 'com.ardud.9router-log-poll'
FIELDS = {name: field for name, field in PHASES.items() if name != 'pool_fetch'}
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
                continuousMs=continuous, cpuMs=time.process_time() * 1000, pid=os.getpid())


def progress(name):
    descriptor = os.environ.get('ROUTER_POLL_PROGRESS_FD')
    if descriptor is not None:
        try:
            descriptor = int(descriptor)
            os.set_blocking(descriptor, False)
            os.write(descriptor, (name + '\n').encode('ascii'))
        except (OSError, ValueError):
            pass


def progress_clock():
    # Python 3.9's macOS monotonic() origin is process-relative. clock_gettime
    # keeps poll-child timestamps comparable to its long-lived guard's clock.
    return time.clock_gettime(time.CLOCK_MONOTONIC)


def finished_progress(timing, name, step=None):
    if 'ROUTER_POLL_PROGRESS_FD' not in os.environ:
        return
    # Cumulative snapshots recover earlier writes dropped by a full pipe.
    data = dict(p=name)
    if step is None:
        data.update(ms=round(timing.values[name], 3), cpu=round(timing.cpu[name], 3))
        data.update({key: timing.resources[name][suffix]
                     for key, suffix in zip(('ib', 'mf', 'iv', 'v'), RESOURCE_FIELDS)})
    else:
        data.update(s=step, ms=math.floor(timing.substeps[name][step][0] * 1000) / 1000,
                    cpu=math.floor(timing.substeps[name][step][1] * 1000) / 1000)
    if name in timing.bytes:
        data.update(bh=timing.bytes[name]['BytesHashed'], bp=timing.bytes[name]['BytesParsed'])
    progress('=' + json.dumps(data, separators=(',', ':'), allow_nan=False))


def phase_progress(name):
    if 'ROUTER_POLL_PROGRESS_FD' not in os.environ:
        return
    # Timestamp and legacy name share one atomic FD write. The name stays last
    # so an old guard still sees the current phase after ignoring the JSON line.
    progress('=' + json.dumps(dict(p=name, at=round(progress_clock() * 1000, 3)),
                              separators=(',', ':')) + '\n' + name)


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
    return launchctl_info(props)['cause']


GAP_NAMES = {'observer.gap', 'guard.tick_late', 'poll.phases', 'rollup.phases', 'pool.endpoint.get', 'poll.timeout'}


def gap_bounds(props):
    if not isinstance(props, dict):
        return None
    try:
        start, end = props.get('startedAtMs'), props.get('finishedAtMs')
        if start is None or end is None:
            parsed = [dt.datetime.fromisoformat(props[key].replace('Z', '+00:00')) for key in ('start', 'end')]
            if any(value.tzinfo is None for value in parsed):
                return None
            start, end = [value.timestamp() * 1000 for value in parsed]
        if all(type(value) in (int, float) and math.isfinite(value) for value in (start, end)):
            return start, end
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        pass
    return None


def gap_summary(rows, day, generated):
    floor = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(), dt.timezone.utc).timestamp() * 1000
    ceiling = min(floor + 86400000, generated.timestamp() * 1000)
    groups = {'pollGaps': [], 'guardGaps': []}
    seen = set()
    for row in sorted(rows, key=lambda row: str(row.get('ts', ''))):
        if row.get('name') not in GAP_NAMES or row.get('component') not in ('guard', 'poller', 'pool-alerts'):
            continue
        props = row.get('props', {})
        bounds = gap_bounds(props)
        if bounds is None:
            continue
        start, end = bounds
        try:
            if end - start <= 120000 or end > generated.timestamp() * 1000:
                continue
            duration = row.get('durationMs', 0)
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
        timing_props = dict(props, poolFetchMs=duration) if row.get('name') == 'pool.endpoint.get' else props
        # Attribute the full span before clipping its duration to this UTC day.
        elapsed = max(end - start, duration if positive(duration) else 0)
        explanation = gap_info(timing_props, props.get('phase'), duration_ms=elapsed)
        if row.get('name') == 'poll.timeout':
            active, wall = props.get('phase'), props.get('wallMs')
            # Before active-remainder metrics, timeout rows only recorded the
            # child's phase and total wall/CPU time. Keep that legacy evidence.
            if 'activePhaseMs' not in props and isinstance(active, str) and active in PHASES and positive(wall):
                explanation = dict(phase=active, phaseMs=wall,
                                   cause=phase_cause(active, wall, props.get('cpuMs'), props))
            explanation['timedOut'] = True
            if explanation['cause'].startswith(('tick_starved:', 'tick_blocked:', 'tick_io:')):
                explanation.update(causeEvidenceField='poll.timeout', causeEvidenceValue=explanation['phaseMs'])
        if explanation.get('causeEvidenceField') == 'poolFetchMs':
            explanation['causeEvidenceField'] = 'durationMs'
        bucket = groups['guardGaps' if component == 'guard' else 'pollGaps']
        hosts = {key: clean_host(props.get(key)) for key in ('hostStart', 'hostEnd')}
        hosts = {key: value for key, value in hosts.items() if value}
        for key in hosts.copy():
            at = props.get(key + 'AtMs')
            if type(at) in (int, float) and math.isfinite(at):
                hosts[key + 'AtMs'] = at
        if 'l1' in hosts.get('hostStart', {}):
            hosts['load1Start'] = hosts['hostStart']['l1']
        counters = {key: value for key, value in props.items()
                    if key in WAIT_FIELDS and type(value) is int and value >= 0}
        counters.update({key: value for key, value in props.items()
                         if key in SUBSTEP_FIELDS and (value == 0 or positive(value))})
        counters.update({key: value for key, value in props.items()
                         if key in TIMEOUT_FIELDS and type(value) in (int, float) and (value == 0 or positive(value))})
        if row.get('name') == 'poll.timeout':
            counters.update({key: props[key] for key in ('wallMs', 'cpuMs')
                             if type(props.get(key)) in (int, float) and (props[key] == 0 or positive(props[key]))})
            host = clean_host(props.get('host'))
            if host:
                hosts['host'] = host
                if type(props.get('hostAtMs')) in (int, float) and positive(props['hostAtMs']):
                    hosts['hostAtMs'] = props['hostAtMs']
        bucket.append(dict(**hosts, **counters, number=len(bucket) + 1, start=iso(start), end=iso(end),
                           **explanation, component=component, durationMs=round(overlap, 3)))
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
    # Continuous and monotonic clocks are comparable only within the same guard.
    if current.get('pid') != previous.get('pid'):
        suspend = 0
    hosts = {}
    for key, sample in (('hostStart', previous), ('hostEnd', current)):
        if sample.get('host'):
            hosts[key] = sample['host']
            hosts[key + 'AtMs'] = sample.get('hostAtMs', sample['wallMs'])
    result = dict(**hosts, host=current.get('host', {}), hostAtMs=current.get('hostAtMs', current['wallMs']),
                start=iso(previous['wallMs']), end=iso(current['wallMs']),
                wallGapMs=wall, monotonicGapMs=mono, sleepGapMs=suspend,
                pid=current.get('pid', 0), previousPid=previous.get('pid', 0),
                jobStateStart=previous.get('jobState', 'unknown'), jobStateEnd=current.get('jobState', 'unknown'),
                jobPidStart=previous.get('jobPid', 0), jobPidEnd=current.get('jobPid', 0),
                jobExitStart=previous.get('jobExit', 'unknown'), jobExitEnd=current.get('jobExit', 'unknown'))
    return dict(result, **gap_info(result))


@contextlib.contextmanager
def phase(name):
    timing = _active.get()
    if timing is None or name not in timing.values:
        yield
        return
    try:
        started = time.monotonic()
        cpu_started = time.process_time()
        usage_started = resource.getrusage(resource.RUSAGE_SELF)
    except Exception:
        yield
        return
    frame = [started, 0, cpu_started, 0, name, usage_started, dict.fromkeys(RESOURCE_FIELDS, 0)]
    timing.stack.append(frame)
    phase_progress(name)
    try:
        yield
    finally:
        try:
            elapsed = (time.monotonic() - frame[0]) * 1000
            cpu = (time.process_time() - frame[2]) * 1000
            usage = resource.getrusage(resource.RUSAGE_SELF)
            timing.values[name] += max(0, elapsed - frame[1])
            timing.cpu[name] += max(0, cpu - frame[3])
            for suffix, attribute in RESOURCE_FIELDS.items():
                delta = max(0, getattr(usage, attribute) - getattr(frame[5], attribute))
                timing.resources[name][suffix] += max(0, delta - frame[6][suffix])
                if len(timing.stack) > 1:
                    timing.stack[-2][6][suffix] += delta
            if len(timing.stack) > 1:
                timing.stack[-2][1] += elapsed
                timing.stack[-2][3] += cpu
            timing.last_phase = name
            finished_progress(timing, name)
        except Exception:
            pass
        finally:
            timing.stack.pop()
            phase_progress(timing.stack[-1][4] if timing.stack else 'none')


def measured(name):
    def decorate(function):
        @functools.wraps(function)
        def run(*args, **kwargs):
            with phase(name):
                if name in BYTE_PHASES:
                    with substep('BuildReport'):
                        return function(*args, **kwargs)
                return function(*args, **kwargs)
        return run
    return decorate


@contextlib.contextmanager
def substep(name):
    timing = _active.get()
    if timing is None or name not in SUBSTEPS or not timing.stack or timing.stack[-1][4] not in BYTE_PHASES:
        yield
        return
    parent = timing.stack[-1]
    started, cpu_started = time.monotonic(), time.process_time()
    child_wall, child_cpu = parent[1], parent[3]
    frame = [parent, 0, 0]
    timing.steps.append(frame)
    try:
        yield
    finally:
        # Exclude both nested phases and nested substeps. A checkpoint save
        # inside a parse loop belongs only to SaveState; listener work belongs
        # only to its own phase, even inside history's BuildReport span.
        wall = max(0, (time.monotonic() - started) * 1000 - (parent[1] - child_wall) - frame[1])
        cpu = max(0, (time.process_time() - cpu_started) * 1000 - (parent[3] - child_cpu) - frame[2])
        timing.substeps[parent[4]][name][0] += wall
        timing.substeps[parent[4]][name][1] += cpu
        finished_progress(timing, parent[4], name)
        timing.steps.pop()
        if timing.steps and timing.steps[-1][0] is parent:
            timing.steps[-1][1] += wall + frame[1]
            timing.steps[-1][2] += cpu + frame[2]


def submeasured(name):
    def decorate(function):
        @functools.wraps(function)
        def run(*args, **kwargs):
            with substep(name):
                return function(*args, **kwargs)
        return run
    return decorate


def count_bytes(suffix, count):
    timing = _active.get()
    if timing is not None and timing.stack:
        name = timing.stack[-1][4]
        if name in timing.bytes:
            timing.bytes[name][suffix] += count


class Timings:
    def __init__(self, component='poller', name='poll.phases', threshold_ms=30000, start=None, sampler=None):
        self.component, self.name, self.threshold = component, name, threshold_ms
        self.start = start
        self.sampler = sampler or Sampler()
        self.stack, self.values = [], {name: 0 for name in FIELDS}
        self.last_phase = 'none'
        self.cpu = {name: 0 for name in FIELDS}
        self.resources = {name: dict.fromkeys(RESOURCE_FIELDS, 0) for name in FIELDS}
        self.bytes = {name: dict.fromkeys(BYTE_FIELDS, 0) for name in BYTE_PHASES}
        self.steps = []
        self.substeps = {name: {step: [0, 0] for step in SUBSTEPS} for name in BYTE_PHASES}

    def __enter__(self):
        self.token = _active.set(self)
        try:
            self.cpu_start = time.process_time()
            self.start = self.start or clock_sample()
        except Exception:
            self.start = {}
            return self
        with phase('observer_snapshot_start'):
            if not self.start.get('host'):
                self.start['host'] = self.sample_host()
            self.start.setdefault('hostAtMs', self.start['wallMs'])
            try:
                self.start.update(job_snapshot())
            except Exception:
                self.start.update(jobState='unknown', jobExit='snapshot_error', jobPid=0)
        return self

    def __exit__(self, *_):
        self.end = dict(self.start)
        try:
            self.finish()
        except Exception:
            # A diagnostic must neither break the guard nor replace its failure.
            pass
        finally:
            _active.reset(self.token)

    def finish(self):
        if not self.start:
            return
        open_phase = self.stack[-1][4] if self.stack else 'none'
        # This launchctl snapshot used to run after the recorded end clock.
        with phase('post_end_diag'):
            try:
                end_job = job_snapshot()
            except Exception:
                end_job = dict(jobState='unknown', jobExit='snapshot_error', jobPid=0)
        self.end = dict(clock_sample(), **end_job)
        self.end['host'] = self.start.get('host', {})
        self.end['hostAtMs'] = self.start['hostAtMs']
        elapsed = max(0, self.end['monotonicMs'] - self.start['monotonicMs'])
        wall = self.end['wallMs'] - self.start['wallMs']
        if max(elapsed, wall) <= self.threshold:
            return
        with phase('post_end_diag'):
            end_host = self.sample_host()
            self.end = dict(clock_sample(), **end_job)
            self.end.update(host=end_host, hostAtMs=self.end['wallMs'])
        elapsed = max(0, self.end['monotonicMs'] - self.start['monotonicMs'])
        wall = self.end['wallMs'] - self.start['wallMs']
        missing = gap(self.start, self.end, cadence_ms=0)
        slowest = max(self.values, key=self.values.get)
        props = dict(host=self.end['host'], hostStart=self.start.get('host', {}), hostEnd=self.end['host'], start=iso(self.start['wallMs']), end=iso(self.end['wallMs']),
                     hostAtMs=self.end['hostAtMs'], hostStartAtMs=self.start['hostAtMs'], hostEndAtMs=self.end['hostAtMs'],
                     startedAtMs=self.start['wallMs'], finishedAtMs=self.end['wallMs'],
                     monotonicStartMs=self.start['monotonicMs'], monotonicEndMs=self.end['monotonicMs'],
                     wallGapMs=wall, monotonicGapMs=elapsed,
                     sleepGapMs=missing['sleepGapMs'] if missing else 0,
                     phase=slowest if self.values[slowest] > 0 else 'none',
                     openPhase=open_phase, lastPhase=self.last_phase,
                     cpuMs=max(0, (time.process_time() - self.cpu_start) * 1000),
                     pid=self.start['pid'], ppid=os.getppid())
        for key in ('jobState', 'jobPid', 'jobExit'):
            props[key + 'Start'] = self.start.get(key, 'unknown')
            props[key + 'End'] = self.end.get(key, 'unknown')
        props.update({field: round(self.values[name], 3) for name, field in FIELDS.items()})
        props.update({field[:-2] + 'CpuMs': round(self.cpu[name], 3) for name, field in FIELDS.items()})
        props.update({FIELDS[name][:-2] + suffix: value
                      for name, counters in self.resources.items() for suffix, value in counters.items()})
        props.update({FIELDS[name][:-2] + suffix: value
                      for name, counters in self.bytes.items() for suffix, value in counters.items()})
        props.update({FIELDS[name][:-2] + step + suffix: math.floor(values[index] * 1000) / 1000
                      for name, steps in self.substeps.items() for step, values in steps.items()
                      for index, suffix in enumerate(('Ms', 'CpuMs'))})
        props.update(gap_info(props))
        emit(self.component, self.name, kind='perf', durationMs=elapsed, props=props)

    def sample_host(self):
        try:
            return self.sampler()
        except Exception:
            return {'e': 'error'}


def poll_host():
    timing = _active.get()
    if timing is None:
        return {}
    start = timing.start if isinstance(timing.start, dict) else {}
    at_ms = start.get('hostAtMs')
    if type(at_ms) not in (int, float) or not (at_ms == 0 or positive(at_ms)):
        return {'host': {'e': 'error'}}
    return poll_props(start.get('host', {}), at_ms)


def observed(component='poller', name='poll.phases'):
    def decorate(function):
        @functools.wraps(function)
        def run(*args, **kwargs):
            with Timings(component, name):
                return function(*args, **kwargs)
        return run
    return decorate
