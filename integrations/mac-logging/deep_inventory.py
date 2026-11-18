#!/usr/bin/python3
"""Daily, checkpointed read-only inventory using the hourly scanner's cache."""
import copy
import os
from pathlib import Path
import signal
import statistics
import subprocess
import time

import jobs
from toollog import emit

BUDGET_S = 90*60
# Hourly inventory holds the lock for minutes and drifts onto 03:30; skipping
# the daily deep pass then loses the whole day.
DEEP_LOCK_WAIT_S = 15*60
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
        command = ['/usr/bin/nice', '-n', '10', '/usr/sbin/taskpolicy', '-c', 'utility',
                   '-d', 'throttle', *command]
        process = subprocess.Popen(command, start_new_session=True,
                                   pass_fds=(self.lock_fd,), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=kwargs.get('text', False),
                                   env=kwargs.get('env'))
        # Reserve bounded cleanup inside the wall budget, including after wake.
        command_started = time.monotonic()
        deadline = min(command_started+timeout,
                       command_started+max(0, self.wall_deadline-time.time()-1))
        stdout = stderr = ''
        try:
            while True:
                remaining = min(deadline-time.monotonic(), self.wall_deadline-time.time())
                if self.stop() or remaining <= 0:
                    # Report the actual probe cutoff before cleanup. The
                    # shared scanner must not classify a budget/stop-truncated
                    # ordinary child as slow from the nominal timeout.
                    effective = max(0, min(deadline-command_started, time.monotonic()-command_started))
                    raise subprocess.TimeoutExpired(command, effective)
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
    measured = partial = bytes_measured = 0
    metrics = dict(timeouts=0, secondsInTimeouts=0, probeTimeouts=0, secondsInProbeTimeouts=0, probeAllowances=[], childrenDescended=set(), partsMeasured=0)
    metrics.update(cpuSecondsDu=0, wallSecondsDu=0, firstAttempts=0, firstAttemptTimeouts=0, secondsWasted=0)
    load_start = os.getloadavg()[0]
    load_end = load_max = load_start

    def sample_load():
        nonlocal load_end, load_max
        load_end = os.getloadavg()[0]
        load_max = max(load_max, load_end)

    def contention_props():
        return dict(loadAvg1Start=load_start, loadAvg1End=load_end, loadAvg1Max=load_max,
                    **{key: metrics[key] for key in ('cpuSecondsDu', 'wallSecondsDu',
                       'firstAttempts', 'firstAttemptTimeouts', 'secondsWasted')})
    roots = list(jobs.DIRECTORY_ROOTS if paths is None else paths)
    priorities = {str(Path('/Volumes/ExternalSSD')/name): i for i, name in enumerate(SLOW_ROOTS)}
    roots.sort(key=lambda p: (priorities.get(str(p), len(priorities)), str(p)))
    lock_wait_started = None

    def waiting():
        nonlocal lock_wait_started
        lock_wait_started = time.monotonic()

    with jobs.inventory_lock(wait_s=DEEP_LOCK_WAIT_S, stopped=stopped, on_wait=waiting) as lock_fd:
        lock_wait_ms = (max(0, (time.monotonic()-lock_wait_started)*1000)
                        if lock_wait_started is not None else 0)
        if lock_wait_ms > 0:
            emit('disk', 'event', 'disk.deep.lock_wait', props=dict(
                waitedMs=lock_wait_ms, acquired=lock_fd is not False))
        killed = stopped()
        if lock_fd is False or killed:
            reason = dict(stopReason='killed') if killed else dict(skipReason='lock_held')
            if not killed:
                jobs.inventory_skipped_logs(roots, jobs.read_state('disk-inventory'), 'lock_held')
            emit('disk', 'event', 'disk.deep.end', props=dict(duMode='links', lockWaitMs=lock_wait_ms, **reason,
                 timeouts=0, secondsInTimeouts=0, probeTimeouts=0, secondsInProbeTimeouts=0,
                 probeAllowanceMedianS=0, childrenDescended=0, partsMeasured=0,
                 spawnPolicy='nice-10-utility-io-throttle', **contention_props()))
            return
        started, wall_started = time.monotonic(), time.time()
        deadline, wall_deadline = started+budget, wall_started+budget
        state = jobs.read_state('disk-inventory')
        cursor = state.get('deepNextRoot')
        if cursor in [str(path) for path in roots]:
            index = next(i for i, path in enumerate(roots) if str(path) == cursor)
            roots = roots[index:]+roots[:index]
        child_state, migrated = jobs.inventory_child_state(state, roots)
        inventory_logs = {str(path): jobs.InventoryLog(path, child_state[str(path)]) for path in roots}
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
            for value in child_state[key].values():
                jobs.inventory_migrate_probe(value)
            listings[key] = jobs.inventory_listing(path, min(deadline, time.monotonic()+2,
                time.monotonic()+max(0, wall_deadline-time.time())))
        stop_reason = 'done'

        def remaining():
            return sum(sum(jobs.inventory_needs_measurement(cache.get(key), time.time(), root=root) for key in
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
            store_root(key, *jobs.inventory_status(child_state[key], entries, listed, time.time(), root=path))
        state['sourceErrors'] = len(state['partials'])
        jobs.save_state('disk-inventory', state)
        initial = copy.deepcopy(child_state)

        def props():
            return dict(duMode='links', durationMs=max(0, (time.time()-wall_started)*1000), lockWaitMs=lock_wait_ms,
                        childrenMeasured=measured, childrenPartial=partial,
                        childrenRemaining=remaining(), bytesMeasured=bytes_measured, stopReason=stop_reason,
                        rootsPartial=sum(not listed for entries, listed in listings.values()),
                        timeouts=metrics['timeouts'], secondsInTimeouts=metrics['secondsInTimeouts'],
                        probeTimeouts=metrics['probeTimeouts'], secondsInProbeTimeouts=metrics['secondsInProbeTimeouts'],
                        probeAllowanceMedianS=statistics.median(metrics['probeAllowances']) if metrics['probeAllowances'] else 0,
                        childrenDescended=len(metrics['childrenDescended']), partsMeasured=metrics['partsMeasured'],
                        spawnPolicy='nice-10-utility-io-throttle', partsFreshnessS=jobs.INVENTORY_PARTS_FRESH_S,
                        **contention_props())

        emit('disk', 'event', 'disk.deep.start', props=props())
        runner = run if run is not None else BackgroundDu(stopped, wall_deadline, lock_fd)
        attempted = {str(path): set() for path in roots}
        single_paths = {str(path): set() for path in roots}
        part_work = {str(path): {} for path in roots}
        probe_retries = {str(path): set() for path in roots}
        def needs_work(root, entry):
            return (entry.path not in attempted[root]
                    and jobs.inventory_due(child_state[root].get(entry.path), time.time(), wall_deadline, root=root))

        def healthy_pending():
            return any(needs_work(root, entry)
                       and not jobs.inventory_has_timeout(child_state[root].get(entry.path, {}))
                       and not jobs.inventory_has_parts(child_state[root].get(entry.path, {}))
                       for root, (entries, listed) in listings.items() for entry in entries)
        queue = list(roots)
        try:
            if paths is None:
                from disk_budgets import deep_refresh, load_budgets
                # Extra targets share this pass's lock and wall/monotonic budget.
                try:
                    deep_refresh(load_budgets(), state, runner,
                                 min(deadline, time.monotonic()+max(0, wall_deadline-time.time())), stopped)
                except Exception:
                    emit('disk', 'error', 'disk.budget.failed', ok=False, error_tag='disk.budget_failed')
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
                    sample_load()
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

                scan_started = time.monotonic()
                try:
                    result = jobs.big_root_inventory(path, runner, deadline, child_state[key],
                                                     listings[key], deep=True, checkpoint=checkpoint,
                                                     attempted=attempted[key], max_batches=4, turn_seconds=60,
                                                     single_paths=single_paths[key], metrics=metrics,
                                                     part_work=part_work[key], due_at=wall_deadline,
                                                     probe_retries=probe_retries[key],
                                                     # Each root gets one early part attempt; a
                                                     # second waits for ordinary work in every root.
                                                     descend=lambda: not part_work[key] or not healthy_pending(),
                                                     inventory_log=inventory_logs[key])
                finally:
                    inventory_logs[key].elapsed_ms += max(0, (time.monotonic()-scan_started)*1000)
                checkpoint(*result)
                # Yield after 60 s or four cheap batches; an expensive parts
                # command is capped at 600 s across this child for the pass.
                if any(needs_work(key, e) for e in entries):
                    queue.append(path)
                if not queue:
                    # Daily passes start near the previous pass's timestamps.
                    # Work that was fresh on the first turn may now be stale.
                    for root in roots:
                        for child, value in child_state[str(root)].items():
                            work = part_work[str(root)].get(child, {})
                            if (jobs.inventory_has_parts(value) and work.get('completed')
                                    and work['seconds'] < jobs.DEEP_CHILD_CAP_S
                                    and any(part not in work['attempted'] and jobs.inventory_needs_measurement(
                                        saved, time.time(), jobs.INVENTORY_PARTS_FRESH_S)
                                        for part, saved in value['parts'].items())):
                                attempted[str(root)].discard(child)
                    queue = [root for root in roots if any(needs_work(str(root), e)
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
                total, status, children = jobs.inventory_status(cache, entries, listed, time.time(), root=path)
                store_root(key, total, status, children)
                inventory_logs[key].root_event(cache, total, status)
                complete = sum(not jobs.inventory_needs_measurement(cache.get(e.path), time.time(), root=path) for e in entries)
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
            sample_load()
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
