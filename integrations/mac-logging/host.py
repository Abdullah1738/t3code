#!/usr/bin/python3
"""Independent no-fork host telemetry; tick returns data and the writer logs it."""
from collections import Counter
import fcntl
import os
from pathlib import Path
import re
import select
import signal
import socket
import threading
import time

from overload_io import Dispatcher
from host_native import Native
from host_signal import socket_path
from spawn_sample import Monitor, SpawnSampler
from toollog import emit, host_fields

COUNTERS = ('pageins', 'pageouts', 'swapins', 'swapouts')
WRITE_LOCK = threading.Lock()


class StateMonitor:
    def __init__(self, native, clock=time.monotonic, interval=30):
        self.native, self.clock, self.interval = native, clock, interval
        self.latest = None
        self.enabled = True

    def snapshot(self):
        # Publish whole immutable snapshots. The main loop never joins or waits
        # for the worker, including when a kernel proc_pidinfo call gets stuck.
        latest = self.latest
        age = max(0, self.clock()-latest[0]) if latest else None
        available = latest is not None and age <= self.interval+2
        props = dict(statesEnabled=self.enabled, statesAvailable=available, stateAgeS=age)
        if available:
            props.update(latest[1])
        return props

    def loop(self, stop):
        while not stop.is_set():
            started = self.clock()
            try:
                props = self.native.states(self.native.pids())
            except (OSError, ValueError, AttributeError):
                self.latest = None
            else:
                # Discard counts from slow passes and disable the walk. A stuck
                # syscall can pin this one daemon thread, never the vitals loop.
                if props.get('stateScanTimedOut') or self.clock()-started >= 2:
                    self.enabled = False
                    self.latest = None
                    return
                self.latest = (self.clock(), props)
            stop.wait(max(0, self.interval-(self.clock()-started)))


class Sampler:
    def __init__(self, native=None, clock=time.monotonic, states=None):
        self.native = native or Native()
        self.clock = clock
        self.previous = None
        self.states = states

    def tick(self):
        started = self.clock()
        props = dict(ncpu=os.cpu_count() or 1)
        errors = []
        def read(key, fn):
            try:
                return fn()
            except (OSError, ValueError, AttributeError):
                errors.append(key)
                return None
        props['load'] = read('load', lambda: list(os.getloadavg()))
        swap = read('swap', self.native.swap)
        props.update(swap or dict.fromkeys(('swapTotalBytes', 'swapUsedBytes', 'swapAvailableBytes')))
        for key, name in (('memoryPressure', 'vm.memory_pressure'),
                          ('memorystatusLevel', 'kern.memorystatus_level'),
                          ('pressureLevel', 'kern.memorystatus_vm_pressure_level')):
            props[key] = read(key, lambda: self.native.sysctl(name).value)
        vm = read('vm', self.native.vm)
        if vm is not None:
            props.update(vm)
            for key in COUNTERS:
                props[key+'Delta'] = (vm[key]-self.previous[1][key]
                    if self.previous and vm[key] >= self.previous[1][key] else None)
            props['windowS'] = started-self.previous[0] if self.previous else None
            self.previous = (started, vm)
        pids = read('processes', self.native.pids)
        props['processCount'] = len(pids) if pids is not None else None
        props.update(self.states.snapshot() if self.states else
                     dict(statesEnabled=False, statesAvailable=False, stateAgeS=None))
        props['errors'] = errors
        return props


def python_label(argv, *, scripts_only=False):
    def script(value):
        name = Path(value).name
        return 'python:'+name if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}\.py', name) else 'python'

    # CPython short options can be bundled; c/m/W/X consume the remainder of
    # their token or the next argv entry. Never reinterpret program arguments.
    args = iter(argv[1:])
    for arg in args:
        if arg == '--':
            return script(next(args, ''))
        if arg == '-':
            return 'python'
        if not arg.startswith('-'):
            return script(arg)
        if arg.startswith('--check-hash-based-pycs'):
            if arg == '--check-hash-based-pycs':
                policy = next(args, '')
            elif arg.startswith('--check-hash-based-pycs='):
                policy = arg.split('=', 1)[1]
            else:
                return 'python'
            if policy not in ('default', 'always', 'never'):
                return 'python'
            continue
        if arg.startswith('--'):
            return 'python'
        options = arg[1:]
        for index, option in enumerate(options):
            if option == 'c' or option in ('h', '?', 'V'):
                return 'python'
            if option in ('m', 'W', 'X'):
                value = options[index+1:] or next(args, '')
                if option == 'm':
                    if scripts_only:
                        return 'python'
                    return 'python:'+value if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}', value) else 'python'
                if not value:
                    return 'python'
                break
            if option not in 'bBdEiIOPqRsSuvx':
                return 'python'
    return 'python'


def families(native, clock=time.monotonic):
    started = clock()
    counts = Counter()
    pids = native.pids()
    skipped = argv_reads = 0
    partial = False
    for pid in pids:
        if clock()-started >= 2:
            partial = True
            break
        try:
            name = native.name(pid)
        except OSError:
            skipped += 1
            continue
        if name.lower().startswith('python'):
            name = 'python'
            if argv_reads < 256 and clock()-started < 1:
                argv_reads += 1
                try:
                    name = python_label(native.argv(pid))
                except (OSError, ValueError, UnicodeError):
                    pass
        counts[name] += 1
    return dict(families=[dict(name=name, count=count) for name, count in sorted(counts.items())],
                processCount=len(pids), processesRead=sum(counts.values()),
                processesSkipped=skipped, partial=partial or skipped > 0)


def write_sample(name, props, duration_ms=None):
    # Both host threads share a process. Avoid making their nonblocking file
    # locks contend when the 30- and 60-second schedules coincide.
    if name == 'host.overload':
        # The I/O worker must never hold the heartbeat's in-process lock.
        # emit uses a nonblocking file lock and failed transitions are retried.
        return emit('host', 'event', name, ok=True, props=props, duration_ms=duration_ms)
    with WRITE_LOCK:
        return emit('host', 'event', name, ok=not bool(props.get('errors')),
                    props=props, duration_ms=duration_ms)


def family_loop(native, stop, interval=60, writer=write_sample, overload=None):
    while not stop.is_set():
        started = time.monotonic()
        try:
            props = families(native)
        except (OSError, ValueError, AttributeError):
            props = dict(errors=['processes'], partial=True)
        if overload is not None:
            overload.latest_families = host_fields(props, 'host.families_lite').get('families', [])
        writer('host.families_lite', props, (time.monotonic()-started)*1000)
        stop.wait(max(0, interval-(time.monotonic()-started)))


def serve(sampler, server, stop, interval=30, duration=None, writer=write_sample, overload=None, spawn=None):
    started = time.monotonic()
    next_tick = started
    next_spawn = started+60
    end = started+duration if duration is not None else float('inf')
    trigger = None
    while not stop.is_set():
        now = time.monotonic()
        if spawn is not None and now >= next_spawn:
            context = spawn.report()
            writer('host.spawn_sample', context, context['wallMs'])
            if overload is not None:
                overload.latest_spawn = context
            next_spawn = now+60
        if now >= next_tick or trigger:
            before = time.monotonic()
            props = sampler.tick()
            if trigger:
                props['trigger'] = trigger
            writer('host.vitals', props, (time.monotonic()-before)*1000)
            if overload is not None:
                overload.tick(props, time.time())
            if now >= next_tick:
                next_tick = now+interval
            trigger = None
        if now >= end:
            return
        ready, _, _ = select.select([server], [], [], max(0, min(next_tick, next_spawn if spawn else end, end)-time.monotonic()))
        if ready:
            # Coalesce queued timeouts so a sender burst cannot starve ticks.
            for _ in range(64):
                try:
                    message = server.recv(64)
                except BlockingIOError:
                    break
                if message == b'cpu.timeout':
                    trigger = 'cpu.timeout'


def run(duration=None):
    path = socket_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.with_suffix('.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
            path.unlink(missing_ok=True)
            server.bind(str(path))
            os.chmod(path, 0o600)
            server.setblocking(False)
            stop = threading.Event()
            for signum in (signal.SIGTERM, signal.SIGINT):
                signal.signal(signum, lambda *_: stop.set())
            overload = Dispatcher(write_sample)
            overload.thread.start()
            states = StateMonitor(Native())
            threading.Thread(target=states.loop, args=(stop,), daemon=True).start()
            threading.Thread(target=family_loop, args=(Native(), stop), kwargs=dict(overload=overload), daemon=True).start()
            spawn = Monitor(SpawnSampler(Native()))
            threading.Thread(target=spawn.loop, args=(stop,), daemon=True).start()
            try:
                serve(Sampler(states=states), server, stop, duration=duration, overload=overload, spawn=spawn)
            finally:
                stop.set()
                path.unlink(missing_ok=True)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--duration', type=float)
    run(parser.parse_args().duration)
