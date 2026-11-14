#!/usr/bin/python3
"""Daily, checkpointed read-only inventory using the hourly scanner's cache."""
import copy
import os
from pathlib import Path
import signal
import subprocess
import time

import jobs
from toollog import emit

BUDGET_S = 90*60
SLOW_ROOTS = ('wt', 't3code-wt', 'board-wt', 'coord-wt')


class PassStopped(BaseException):
    pass


class BackgroundDu:
    def __init__(self, stop, wall_deadline, lock_fd):
        self.stop = stop
        self.wall_deadline = wall_deadline
        self.lock_fd = lock_fd

    def __call__(self, command, **kwargs):
        if self.stop():
            raise PassStopped()
        timeout = min(kwargs.pop('timeout'), max(0, self.wall_deadline-time.time()))
        if timeout <= 0:
            raise PassStopped()
        # Own the process group, including the exec wrappers. Inherit the flock
        # so even SIGKILL of Python cannot let hourly du overlap a surviving du.
        # 14 Nov diag: utility 0.014–1.239 s; -b 0.019–2.624 s (warm-cache
        # samples, no reproduced stall). Do not apply Darwin's -b I/O policy.
        command = ['/usr/bin/nice', '-n', '10', '/usr/sbin/taskpolicy', '-c', 'utility', *command]
        process = subprocess.Popen(command, start_new_session=True,
                                   pass_fds=(self.lock_fd,), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=kwargs.get('text', False),
                                   env=kwargs.get('env'))
        # Reserve bounded cleanup inside the wall budget, including after wake.
        deadline = min(time.monotonic()+timeout,
                       time.monotonic()+max(0, self.wall_deadline-time.time()-1))
        stdout = stderr = ''
        try:
            while True:
                remaining = min(deadline-time.monotonic(), self.wall_deadline-time.time())
                if self.stop() or remaining <= 0:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    stdout, stderr = process.communicate(timeout=min(1, remaining))
                    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
                except subprocess.TimeoutExpired as pending:
                    stdout, stderr = pending.stdout or stdout, pending.stderr or stderr
                    continue
        except BaseException as exc:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                stdout, stderr = process.communicate(timeout=min(1, max(0, self.wall_deadline-time.time())))
            except subprocess.TimeoutExpired as pending:
                stdout, stderr = pending.stdout or stdout, pending.stderr or stderr
                # Kernel I/O can outlive SIGKILL. Do not wait beyond the pass;
                # the surviving child retains the flock until it actually exits.
                for stream in (process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()
            if isinstance(exc, subprocess.TimeoutExpired):
                # Shared parsing retains only complete stdout rows, never a
                # killed child's unterminated row or an invented zero.
                exc.stdout, exc.stderr = stdout, stderr
            raise


def run_pass(paths=None, run=None, budget=BUDGET_S, stopped=lambda: False):
    started, wall_started = time.monotonic(), time.time()
    deadline, wall_deadline = started+budget, wall_started+budget
    measured = partial = bytes_measured = 0
    metrics = dict(timeouts=0, secondsInTimeouts=0, childrenDescended=set(), partsMeasured=0)
    roots = list(jobs.DIRECTORY_ROOTS if paths is None else paths)
    priorities = {str(Path('/Volumes/ExternalSSD')/name): i for i, name in enumerate(SLOW_ROOTS)}
    roots.sort(key=lambda p: (priorities.get(str(p), len(priorities)), str(p)))
    with jobs.inventory_lock() as lock_fd:
        if lock_fd is False:
            emit('disk', 'event', 'disk.deep.end', props=dict(duMode='links', skipReason='lock_held',
                 timeouts=0, secondsInTimeouts=0, childrenDescended=0, partsMeasured=0,
                 spawnPolicy='nice-10-utility'))
            return
        state = jobs.read_state('disk-inventory')
        cursor = state.get('deepNextRoot')
        if cursor in [str(path) for path in roots]:
            index = next(i for i, path in enumerate(roots) if str(path) == cursor)
            roots = roots[index:]+roots[:index]
        child_state, migrated = jobs.inventory_child_state(state, roots)
        state.update(duMode='links', childState=child_state)
        for field in ('sizes', 'children', 'partials', 'attemptedAt'):
            if not isinstance(state.get(field), dict):
                state[field] = {}
        if migrated:
            state.update(sizes={}, children={}, partials={})
        listings = {str(path): ([], False) for path in roots}
        for path in roots:
            if stopped() or time.time() >= wall_deadline or time.monotonic() >= deadline:
                break
            key = str(path)
            jobs.inventory_clean_cache(child_state[key], time.time())
            listings[key] = jobs.inventory_listing(path, min(deadline, time.monotonic()+2,
                time.monotonic()+max(0, wall_deadline-time.time())))
        stop_reason = 'done'

        def remaining():
            return sum(sum(jobs.inventory_needs_measurement(cache.get(key), time.time()) for key in
                           ({e.path for e in entries} if listed else set(cache)))
                       for root, (entries, listed) in listings.items() for cache in [child_state[root]])

        def store_root(key, total, status, children):
            if children or not status['partial']:
                state['sizes'][key] = total
            else:
                state['sizes'].pop(key, None)
            state['children'][key] = children
            if status['partial']:
                state['partials'][key] = status
            else:
                state['partials'].pop(key, None)

        # Mark every listed root before spending the pass on the first farm.
        # Advancing the global timestamp must not make an untouched stale root
        # look complete to disk_sample after a budget stop or kill.
        for path in roots:
            key = str(path)
            jobs.inventory_clean_cache(child_state[key], time.time())
            entries, listed = listings[key]
            if listed:
                present = {e.path for e in entries}
                for child in set(child_state[key])-present:
                    child_state[key].pop(child)
            store_root(key, *jobs.inventory_status(child_state[key], entries, listed, time.time()))
        state['sourceErrors'] = len(state['partials'])
        jobs.save_state('disk-inventory', state)
        initial = copy.deepcopy(child_state)

        def props():
            return dict(duMode='links', durationMs=max(0, (time.time()-wall_started)*1000),
                        childrenMeasured=measured, childrenPartial=partial,
                        childrenRemaining=remaining(), bytesMeasured=bytes_measured, stopReason=stop_reason,
                        rootsPartial=sum(not listed for entries, listed in listings.values()),
                        timeouts=metrics['timeouts'], secondsInTimeouts=metrics['secondsInTimeouts'],
                        childrenDescended=len(metrics['childrenDescended']), partsMeasured=metrics['partsMeasured'],
                        spawnPolicy='nice-10-utility')

        emit('disk', 'event', 'disk.deep.start', props=props())
        runner = run if run is not None else BackgroundDu(stopped, wall_deadline, lock_fd)
        attempted = {str(path): set() for path in roots}
        single_paths = {str(path): set() for path in roots}
        part_work = {str(path): {} for path in roots}
        queue = list(roots)
        try:
            while queue:
                path = queue.pop(0)
                key = str(path)
                if stopped():
                    stop_reason = 'killed'
                    break
                if time.monotonic() >= deadline or time.time() >= wall_deadline:
                    stop_reason = 'budget'
                    break
                entries, listed = listings[key]
                state['deepNextRoot'] = str(queue[0]) if queue else str(roots[0])

                def checkpoint(total, status, children):
                    nonlocal measured, partial, bytes_measured
                    # Derive run counters from timestamps changed in this pass;
                    # persisted root totals still include every retained child.
                    changed = [v for root, cache in child_state.items() for child, v in cache.items()
                               if v != initial.get(root, {}).get(child)]
                    values = [v for v in changed if jobs.number(v.get('bytes')) and jobs.number(v.get('at'))
                              and (v['at'] >= wall_started or isinstance(v.get('parts'), dict)
                                   and v.get('partial') is False and v.get('attemptedAt', 0) >= wall_started)]
                    measured = len(values)
                    partial = sum(v.get('partial') is not False for v in changed)
                    bytes_measured = sum(v['bytes'] for v in values)
                    store_root(key, total, status, children)
                    state['attemptedAt'][key] = time.time()
                    state['at'] = time.time()
                    state['sourceErrors'] = len(state['partials'])
                    jobs.save_state('disk-inventory', state)
                    if stopped() or time.time() >= wall_deadline:
                        raise PassStopped()

                result = jobs.big_root_inventory(path, runner, deadline, child_state[key],
                                                 listings[key], deep=True, checkpoint=checkpoint,
                                                 attempted=attempted[key], max_batches=4, turn_seconds=60,
                                                 single_paths=single_paths[key], metrics=metrics,
                                                 part_work=part_work[key])
                checkpoint(*result)
                # Yield after 60 s or four cheap batches; an expensive parts
                # command is capped at 600 s across this child for the pass.
                if any(e.path not in attempted[key] and jobs.inventory_needs_measurement(
                        child_state[key].get(e.path), time.time()) for e in entries):
                    queue.append(path)
                if not queue:
                    # Daily passes start near the previous pass's timestamps.
                    # Work that was fresh on the first turn may now be stale.
                    for root in roots:
                        for child, value in child_state[str(root)].items():
                            if (isinstance(value.get('parts'), dict) and value.get('partial') is False
                                    and jobs.inventory_needs_measurement(value, time.time())):
                                attempted[str(root)].discard(child)
                    queue = [root for root in roots if any(e.path not in attempted[str(root)]
                        and jobs.inventory_needs_measurement(child_state[str(root)].get(e.path), time.time())
                        for e in listings[str(root)][0])]
        except PassStopped:
            stop_reason = 'killed' if stopped() else 'budget'
        except Exception as exc:
            stop_reason = 'killed'
            jobs.source_error('disk', 'disk.inventory.source', 'deep-pass', started, exc)
            raise
        except BaseException:
            stop_reason = 'killed'
            raise
        finally:
            for path in roots:
                key = str(path)
                if key not in listings:
                    continue
                cache = child_state[key]
                entries, listed = listings[key]
                # A root skipped early in the pass can cross its freshness
                # boundary while another root is running. Recheck all roots.
                store_root(key, *jobs.inventory_status(cache, entries, listed, time.time()))
                complete = sum(not jobs.inventory_needs_measurement(cache.get(e.path), time.time()) for e in entries)
                ages = [max(0, time.time()-v['at']) for v in cache.values() if jobs.number(v.get('at'))]
                emit('disk', 'event', 'disk.deep.root', props=dict(duMode='links', source=key,
                     completedCount=complete, partial=not listed or complete != len(entries),
                     failedCount=len(entries)-complete, ageS=max(ages, default=0),
                     childrenWithPartsInProgress=sum(isinstance(v.get('parts'), dict)
                         and v.get('partial') is not False for v in cache.values())))
            state['sourceErrors'] = len(state['partials'])
            state['at'] = time.time()
            jobs.save_state('disk-inventory', state)
            if stop_reason == 'done' and (time.monotonic() >= deadline or time.time() >= wall_deadline):
                stop_reason = 'budget'
            emit('disk', 'perf', 'disk.deep.end', duration_ms=(time.monotonic()-started)*1000, props=props())


def main():
    killed = [False]
    def stop(signum, frame):
        killed[0] = True
    handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        run_pass(stopped=lambda: killed[0])
    except Exception as exc:
        jobs.source_error('disk', 'disk.inventory.source', 'deep-pass', time.monotonic(), exc)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


if __name__ == '__main__':
    main()
