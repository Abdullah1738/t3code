#!/usr/bin/python3
"""Read-only Mac evidence collector with bounded disk diagnostics."""
from collections import Counter
import datetime as dt
from decimal import Decimal, ROUND_FLOOR, ROUND_CEILING
import json
import math
import fcntl
import os
import plistlib
import tempfile
from pathlib import Path
import re
import signal
import subprocess
import time
import uuid
from jobs import (read_state, save_state, state_path, directory_inventory,
                  SourceFailure, source_error, stderr_line, permission_denied, deadline_call)
from rollup import rollup
from logwindow import (row_timestamp, query_bound, boot_times, boot_boundaries, boot_skip, boot_second)
from status import CADENCES
from toollog import directory, emit, private_dir, safe_fields, finite_number
from homebrew import check as homebrew_integrity

REPORT_DIRS = [Path('/Library/Logs/DiagnosticReports'), Path('/Library/Logs/DiagnosticReports/Retired'),
               Path.home() / 'Library/Logs/DiagnosticReports']


def missing_day(now=None):
    try:
        utc = dt.datetime.now(dt.timezone.utc) if now is None else now.astimezone(dt.timezone.utc)
        day = utc.date()
        state = read_state('missing-day')
        if state.get('reportedDay') == day.isoformat():
            return
        since = min(dt.date.fromisoformat(row['since']) for row in CADENCES.values())
        missing = [date.isoformat() for date in (day - dt.timedelta(days=1), day)
                   if date >= since and not (directory() / (date.isoformat() + '.ndjson')).exists()]
        if state.get('pendingDay') == day.isoformat():
            missing = sorted(set(missing + state.get('missingDates', [])))
        if missing:
            # emit can create an empty file before a busy lock drops the append.
            # Retain what was missing so the next check still retries it.
            state.update(pendingDay=day.isoformat(), missingDates=missing)
            save_state('missing-day', state)
            if emit('collector', 'error', 'log.missing_day', now=utc, ok=False,
                    props={'source': ' and '.join(missing), 'count': len(missing)}, error_tag='log.missing_day'):
                state['reportedDay'] = day.isoformat()
                state.pop('pendingDay', None)
                state.pop('missingDates', None)
                save_state('missing-day', state)
    except Exception:
        pass


# launchd's hourly interval also accrues runtime, sleep and coalescing drift.
UNIFIED_WINDOW_S = 5400
UNIFIED_CHUNK_S = 900
UNIFIED_FIRST_CHUNK_S = 60
UNIFIED_CALL_S = 60
UNIFIED_TARGET_S = 10
UNIFIED_BUDGET_S = 135
UNIFIED_FRESH_RESERVE_S = 60


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


def unified_command(command, capture_output=True, text=True, timeout=60, env=None):
    # subprocess.run kills only its direct child and can wait indefinitely on
    # inherited pipes or an unkillable process. Reserve time to reap the group.
    end = time.monotonic()+min(UNIFIED_CALL_S, timeout)
    reserve = min(1, max(0, timeout)/10)
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=text, env=env, start_new_session=True)
    try:
        output, error = child.communicate(timeout=max(0, end-time.monotonic()-reserve))
        return subprocess.CompletedProcess(command, child.returncode, output, error)
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=max(0, end-time.monotonic()))
        except subprocess.TimeoutExpired:
            # A kernel-stuck process cannot be reaped on demand. Never let its
            # wait or inherited pipes hold the rest of the collector hostage.
            pass
        finally:
            for stream in (child.stdout, child.stderr):
                if stream is not None:
                    stream.close()
        raise


def next_unified_chunk(size, elapsed, model=None):
    model = dict(model or {})
    spent = model.get('spent', 0)+elapsed
    previous = model.get('previous')
    limit = model.get('limit', UNIFIED_CHUNK_S)
    if previous and abs(size-previous[0]) > .000001:
        delta = size-previous[0]
        rate = max(0, (elapsed-previous[1])/delta)
        previous_rate = model.get('rate')
        # A rising marginal cost invalidates the affine model. Keep that
        # evidence for the run, even when later windows have the same size.
        if (delta > 0 and previous_rate is not None and rate > previous_rate*1.5 and
                elapsed-previous[1]-previous_rate*delta > 1):
            model['nonlinear'] = True
        model['rate'] = rate
        overhead = max(0, elapsed-rate*size)
        limit = UNIFIED_WINDOW_S if (rate*UNIFIED_WINDOW_S <= 1 or
                    overhead >= rate*UNIFIED_CHUNK_S) else UNIFIED_CHUNK_S
        if model.get('nonlinear'):
            limit = UNIFIED_CHUNK_S
        work_budget = max(0, min(max(UNIFIED_TARGET_S, overhead),
                                UNIFIED_CALL_S-1-overhead))
        size_next = max(UNIFIED_FIRST_CHUNK_S, min(limit, work_budget/max(.001, rate)))
        # Startup can hide curvature in two tiny probes. Sample the nominal
        # window before a large jump when the model leaves room for four calls.
        # Expensive startup may only afford three calls to clear the ceiling.
        # Flat or decreasing tiny-query timings can be startup noise too;
        # they do not establish that a full-window query is cheap.
        if (max(size, previous[0]) < UNIFIED_CHUNK_S and
                spent+2*overhead+rate*UNIFIED_WINDOW_S <= UNIFIED_BUDGET_S):
            size_next = min(size_next, UNIFIED_CHUNK_S)
    elif previous:
        size_next = max(UNIFIED_FIRST_CHUNK_S, min(limit,
                        size*max(UNIFIED_TARGET_S, previous[1])/max(.001, elapsed)))
    else:
        size_next = min(limit, max(UNIFIED_FIRST_CHUNK_S, size*2))
    model.update(previous=(size, elapsed), limit=limit, spent=spent)
    return size_next, model


class UnifiedCounts(Counter):
    def __init__(self):
        super().__init__()
        self.stats = {}


def unified_rows(output, partial=False):
    if isinstance(output, bytes):
        output = output.decode('utf-8', errors='replace')
    if not partial:
        rows = json.loads(output or '[]')
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError('invalid log shape')
        return rows
    # A timed-out JSON array has no closing bracket. Decode complete objects
    # from its prefix; the unfinished tail is never evidence.
    decoder, rows = json.JSONDecoder(), []
    text = (output or '').lstrip()
    if not text.startswith('['):
        return rows
    text = text[1:]
    while text:
        text = text.lstrip(' \r\n\t,')
        try:
            row, end = decoder.raw_decode(text)
        except ValueError:
            break
        if isinstance(row, dict):
            rows.append(row)
        text = text[end:]
    return rows


def row_stats(rows, since, until, partial=False):
    stats = dict(partialRows=len(rows)) if partial else {}
    for row in rows:
        at = row_timestamp(row.get('timestamp'))
        if at is None:
            stats['unparsedRows'] = stats.get('unparsedRows', 0)+1
        elif not Decimal(str(since)) < at <= Decimal(str(until)):
            stats['outsideRows'] = stats.get('outsideRows', 0)+1
            stats['outsideFirst'] = min(stats.get('outsideFirst', float(at)), float(at))
            stats['outsideLast'] = max(stats.get('outsideLast', float(at)), float(at))
    return stats


def unified(since, until, run=unified_command, timeout=60):
    if timeout <= 0:
        raise SourceFailure('timeout', 'collector budget exhausted')
    since = max(since, until-UNIFIED_WINDOW_S)
    try:
        result = run(['/usr/bin/log', 'show', '--style', 'json', '--timezone', 'UTC',
                      '--start', query_bound(Decimal(str(since)), ROUND_FLOOR),
                      '--end', query_bound(Decimal(str(until)), ROUND_CEILING), '--predicate',
                      '(type == timesyncEvent AND eventMessage CONTAINS "=== system boot") OR (process == "kernel" AND eventMessage CONTAINS "PMU") OR (process == "watchdogd" AND eventMessage CONTAINS "unresponsive")'],
                     capture_output=True, text=True, timeout=min(UNIFIED_CALL_S, timeout),
                     env={**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC'})
    except subprocess.TimeoutExpired as exc:
        rows = unified_rows(exc.output, partial=True)
        exc.stats = row_stats(rows, since, until, partial=True)
        raise
    if result.returncode:
        message = stderr_line(getattr(result, 'stderr', ''))
        exc = SourceFailure('permission' if permission_denied(message) else 'exit',
                            message or 'log show exited unsuccessfully', result.returncode)
        exc.stats = row_stats(unified_rows(result.stdout, partial=True), since, until, partial=True)
        raise exc
    counts = UnifiedCounts()
    try:
        rows = unified_rows(result.stdout)
        counts.stats = row_stats(rows, since, until)
    except (AttributeError, TypeError, ValueError):
        raise SourceFailure('parse', 'invalid unified log data', result.returncode) from None
    for row in rows:
        at = row_timestamp(row.get('timestamp'))
        if at is None or not Decimal(str(since)) < at <= Decimal(str(until)):
            continue
        message = row.get('eventMessage', '')
        if not isinstance(message, str):
            raise SourceFailure('parse', 'invalid unified log data', result.returncode)
        if '=== system boot' in message:
            # Preserve boot time and collapse duplicate markers at that instant.
            counts['restart', 'kernel', float(at)] = 1
        elif 'wdog' in message.lower() or 'unresponsive' in message.lower():
            counts['hang', 'system'] += 1
    return counts



def merge_unified_stats(target, stats):
    for key, value in stats.items():
        choose = min if key == 'outsideFirst' else max if key == 'outsideLast' else lambda a,b: a+b
        target[key] = choose(target[key], value) if key in target else value


def queue_unified_observations(state, counts):
    when = dt.datetime.now(dt.timezone.utc).isoformat()
    for key, count in counts.items():
        props = dict(resourceKind=key[0], process=key[1], count=count)
        if len(key) == 3:
            props['observedAt'] = key[2]
        state.setdefault('unifiedOutbox', []).append(dict(id=uuid.uuid4().hex, at=when, props=props))


def queue_unified_gap(state, start, end, reason):
    state.setdefault('unifiedOutbox', []).append(dict(id=uuid.uuid4().hex,
        at=dt.datetime.now(dt.timezone.utc).isoformat(), name='crash.source', ok=False,
        props=dict(source='unified', windowStart=start, windowEnd=end,
                   skippedS=end-start, partial=True, reason=reason)))


def flush_unified_observations(state):
    pending = list(state.get('unifiedOutbox', []))
    for row in pending:
        if not emit('crashes', 'event', row.get('name', 'crash.observed'), ok=row.get('ok', True), props=row['props'],
                    now=dt.datetime.fromisoformat(row['at']), dedup_id=row['id']):
            return False
    if pending:
        state.pop('unifiedOutbox', None)
        save_state('crashes', state)
    return True


def failed_boot_second(state, start, end, boots, stats, failed=True):
    boot = boot_second(start, end, boots)
    if boot is None:
        return False
    attempts = state.setdefault('unifiedBootAttempts', {})
    key = str(boot)
    if failed:
        attempts[key] = attempts.get(key, 0)+1
        save_state('crashes', state)
    if attempts.get(key, 0) < 3:
        return False
    # A frozen fractional end can split this second into several pending pieces.
    # Keep its terminal count so retiring one piece cannot permit another call.
    stats['bootSecondUnreadableS'] = stats.get('bootSecondUnreadableS', 0)+end-start
    queue_unified_gap(state, start, end, 'bootSecondUnreadable')
    return True


def retry_window(cursor, window):
    return dict(windowStart=cursor, windowEnd=window['windowEnd'], skippedS=window['skippedS'],
                **{k: window[k] for k in ('bootUnresolvedS', 'bootSecondUnreadableS') if window.get(k)})


def read_unified_piece(reader, deadline, start, end, timeout):
    invoked = False
    def read():
        nonlocal invoked
        invoked = True
        return unified(start, end, timeout=timeout) if reader is None else reader(start, end)
    try:
        return deadline_call(deadline, read)
    except Exception as exc:
        exc.unified_started = invoked
        raise


def retry_boot_pieces(state, now, boot_info, deadline, reader, stats):
    boots = boot_boundaries(boot_info)
    errors, skipped = 0, 0
    counts = Counter()
    flush_unified_observations(state)
    pending = []
    deferred_skips = list(state.get('unifiedBootSkips', []))
    for start, end in state.get('unifiedBootPending', []):
        floor = now-UNIFIED_WINDOW_S
        if start < floor:
            omitted = max(0, min(floor, end)-start)
            deferred_skips.append(dict(windowStart=start, windowEnd=start+omitted,
                                       skippedS=omitted, reason='lag_ceiling'))
        if max(start, floor) < end:
            points = [max(start, floor)]+[b for b in boots if max(start, floor) < b < end]+[end]
            pending.extend([a, b] for a, b in zip(points, points[1:]))
    for gap in deferred_skips:
        gap.setdefault('id', uuid.uuid4().hex)
        gap.setdefault('at', dt.datetime.now(dt.timezone.utc).isoformat())
    state['unifiedBootPending'] = pending
    state['unifiedBootSkips'] = deferred_skips
    save_state('crashes', state)
    for gap in deferred_skips:
        # Clipping is durable before any log command. Keep unreported skips
        # separately so interruption during retry I/O cannot report them twice.
        if emit('crashes', 'event', 'crash.unified.skip', ok=True,
                props={k:v for k,v in gap.items() if k not in ('id', 'at')}, dedup_id=gap['id'],
                now=dt.datetime.fromisoformat(gap['at'])):
            skipped += gap['skippedS']
            state['unifiedBootSkips'] = state['unifiedBootSkips'][1:]
            save_state('crashes', state)
        else:
            break
    index = 0
    while index < len(pending):
        cursor, stop = pending[index]
        until = min(stop, cursor+UNIFIED_CHUNK_S)
        began = time.monotonic()
        if boot_skip(cursor, until, boot_info):
            stats['bootUnresolvedS'] = stats.get('bootUnresolvedS', 0)+until-cursor
            skipped += until-cursor
            errors += 1
            queue_unified_gap(state, cursor, until, 'bootUnresolved')
            if until == stop:
                pending.pop(index)
            else:
                pending[index][0] = until
            if pending:
                state['unifiedBootPending'] = pending
            else:
                state.pop('unifiedBootPending', None)
            save_state('crashes', state)
            flush_unified_observations(state)
            continue
        if failed_boot_second(state, cursor, until, boot_info, stats, failed=False):
            skipped += until-cursor
            errors += 1
            pending.pop(index)
            state['unifiedBootPending'] = pending
            save_state('crashes', state)
            flush_unified_observations(state)
            continue
        try:
            remaining = min(10 if boot_second(cursor, until, boot_info) is not None else UNIFIED_CALL_S, deadline-began)
            if remaining <= 0:
                raise SourceFailure('timeout', 'unified log budget exhausted')
            result = read_unified_piece(reader, deadline, cursor, until, remaining)
        except Exception as exc:
            merge_unified_stats(stats, getattr(exc, 'stats', {}))
            source_error('crashes', 'crash.source', 'unified', began, exc,
                         dict(windowStart=cursor, windowEnd=stop, partial=True,
                              **getattr(exc, 'stats', {})))
            errors += 1
            if getattr(exc, 'unified_started', False) and failed_boot_second(state, cursor, until, boot_info, stats):
                skipped += until-cursor
                pending.pop(index)
            else:
                index += 1
        else:
            boot = boot_second(cursor, until, boot_info)
            if boot is not None:
                state.get('unifiedBootAttempts', {}).pop(str(boot), None)
            merge_unified_stats(stats, getattr(result, 'stats', {}))
            queue_unified_observations(state, result)
            counts.update(result)
            if until == stop:
                pending.pop(index)
            else:
                pending[index][0] = until
        if pending:
            state['unifiedBootPending'] = pending
        else:
            state.pop('unifiedBootPending', None)
        save_state('crashes', state)
        flush_unified_observations(state)
    if not pending:
        state.pop('unifiedBootPending', None)
    if not state.get('unifiedBootSkips'):
        state.pop('unifiedBootSkips', None)
    return counts, errors, skipped


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
    if 'unifiedBootAttempts' in state:
        state['unifiedBootAttempts'] = {key: value for key, value in state['unifiedBootAttempts'].items()
                                        if float(key)+1 > now-UNIFIED_WINDOW_S}
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
    def fresh_window(cursor):
        return dict(windowStart=max(cursor, now-UNIFIED_WINDOW_S), windowEnd=now,
                    skippedS=max(0, now-UNIFIED_WINDOW_S-cursor))

    window = state.get('unifiedRetry') or fresh_window(since)
    # Frozen retries must obey the same moving ceiling as fresh windows.
    # Otherwise one slow historical suffix can pin the reader forever.
    floor = now-UNIFIED_WINDOW_S
    if window['windowStart'] < floor:
        skipped_before = window['skippedS']
        window = dict(window, windowStart=floor, windowEnd=max(floor, window['windowEnd']),
                      skippedS=skipped_before+floor-window['windowStart'])
    unified_deadline = min(deadline, source_started+UNIFIED_BUDGET_S)
    skipped = 0
    stop_reason = 'done'
    chunk_size = UNIFIED_FIRST_CHUNK_S
    cost_model = None
    stats = dict(**{k:window[k] for k in ('bootUnresolvedS', 'bootSecondUnreadableS') if window.get(k)})
    retired_boot_skips = {}
    def lag():
        frontier = min([state.get('unified', since)]+[a for a, _ in state.get('unifiedBootPending', [])])
        return max(0, now+time.monotonic()-started-frontier)

    cursor = window['windowStart']
    try:
        boot_seconds = boot_times(now-UNIFIED_WINDOW_S, now, deadline=unified_deadline) if log_reader is None else []
        boots = boot_boundaries(boot_seconds)
        # Historical holes get at most the unreserved share. Fresh coverage
        # must still have one full call even when several holes keep timing out.
        retry_deadline = unified_deadline
        if since < now:
            retry_deadline = max(time.monotonic(), unified_deadline-UNIFIED_FRESH_RESERVE_S)
        observed, failed, omitted = retry_boot_pieces(state, now, boot_seconds, retry_deadline, log_reader, stats)
        counts.update(observed)
        errors += failed
        skipped += omitted
        while True:
            window = dict(window, windowS=window['windowEnd']-window['windowStart'])
            window.update(chunks=math.ceil(max(0, window['windowS'])/chunk_size), chunksDone=0,
                          skipReason='bootSecondUnreadable' if window.get('bootSecondUnreadableS') else 'bootUnresolved' if window.get('bootUnresolvedS') else 'lag_ceiling' if window['skippedS'] else None)
            cursor = window['windowStart']
            if cursor > state.get('unified', since):
                emit('crashes', 'event', 'crash.unified.skip', ok=True,
                     props=dict(windowStart=state.get('unified', since), windowEnd=cursor,
                                skippedS=cursor-state.get('unified', since), reason='lag_ceiling'))
                state['unified'] = cursor
                state['unifiedRetry'] = retry_window(cursor, window)
                save_state('crashes', state)
            while cursor < window['windowEnd']:
                end = min(cursor+chunk_size, window['windowEnd'])
                end = min([end]+[b for b in boots if cursor < b < end])
                window['chunks'] = window['chunksDone']+math.ceil((window['windowEnd']-cursor)/chunk_size)
                if boot_skip(cursor, end, boot_seconds):
                    stats['bootUnresolvedS'] = stats.get('bootUnresolvedS', 0)+end-cursor
                    window['skippedS'] += end-cursor
                    window['bootUnresolvedS'] = window.get('bootUnresolvedS', 0)+end-cursor
                    window['skipReason'] = 'bootUnresolved'
                    errors += 1
                    queue_unified_gap(state, cursor, end, 'bootUnresolved')
                    cursor = end
                    state['unified'] = cursor
                    state['unifiedRetry'] = retry_window(cursor, window)
                    save_state('crashes', state)
                    flush_unified_observations(state)
                    continue
                if failed_boot_second(state, cursor, end, boot_seconds, stats, failed=False):
                    errors += 1
                    window['skippedS'] += end-cursor
                    window['bootSecondUnreadableS'] = window.get('bootSecondUnreadableS', 0)+end-cursor
                    window['skipReason'] = 'bootSecondUnreadable'
                    cursor = end
                    state['unified'] = cursor
                    state['unifiedRetry'] = retry_window(cursor, window)
                    save_state('crashes', state)
                    flush_unified_observations(state)
                    continue
                call_cap = 10 if boot_second(cursor, end, boot_seconds) is not None else UNIFIED_CALL_S
                remaining = min(call_cap, unified_deadline-time.monotonic())
                if remaining <= 0:
                    stop_reason = 'deadline'
                    raise SourceFailure('timeout', 'unified log budget exhausted')
                chunk_started = time.monotonic()
                chunk = dict(chunk=window['chunksDone']+1, windowStart=cursor,
                             windowEnd=end, windowS=end-cursor, timeoutS=remaining)
                emit('crashes', 'event', 'crash.unified.chunk', ok=None,
                     props=dict(chunk, outcome='start', elapsedMs=0))
                try:
                    observed = read_unified_piece(log_reader, unified_deadline, cursor, end, remaining)
                except Exception as exc:
                    merge_unified_stats(stats, getattr(exc, 'stats', {}))
                    timed_out = isinstance(exc, subprocess.TimeoutExpired) or (
                        isinstance(exc, SourceFailure) and exc.failure == 'timeout')
                    stop_reason = ('deadline' if remaining < call_cap or time.monotonic() >= unified_deadline else 'timeout') if timed_out else (
                        exc.failure if isinstance(exc, SourceFailure) else 'error')
                    emit('crashes', 'error', 'crash.unified.chunk', ok=False,
                         props=dict(chunk, outcome=stop_reason,
                                    elapsedMs=(time.monotonic()-chunk_started)*1000))
                    if getattr(exc, 'unified_started', False) and failed_boot_second(state, cursor, end, boot_seconds, stats):
                        errors += 1
                        window['skippedS'] += end-cursor
                        window['bootSecondUnreadableS'] = window.get('bootSecondUnreadableS', 0)+end-cursor
                        window['skipReason'] = 'bootSecondUnreadable'
                        cursor = end
                        state['unified'] = cursor
                        state['unifiedRetry'] = retry_window(cursor, window)
                        save_state('crashes', state)
                        flush_unified_observations(state)
                        continue
                    later_boots = [b for b in boots if cursor < b < window['windowEnd']]
                    if not later_boots and window['windowEnd'] < now and any(window['windowEnd'] <= b <= now for b in boots):
                        later_boots = [window['windowEnd']]
                    if later_boots:
                        boundary = min(later_boots)
                        state.setdefault('unifiedBootPending', []).append([cursor, boundary])
                        errors += 1
                        source_error('crashes', 'crash.source', 'unified', chunk_started, exc,
                                     dict(chunk, partial=True, **getattr(exc, 'stats', {})))
                        cursor = boundary
                        state['unified'] = cursor
                        state['unifiedRetry'] = retry_window(cursor, window)
                        save_state('crashes', state)
                        continue
                    raise
                boot = boot_second(cursor, end, boot_seconds)
                if boot is not None:
                    state.get('unifiedBootAttempts', {}).pop(str(boot), None)
                merge_unified_stats(stats, getattr(observed, 'stats', {}))
                elapsed = time.monotonic()-chunk_started
                emit('crashes', 'event', 'crash.unified.chunk', ok=True,
                     props=dict(chunk, outcome='done', elapsedMs=elapsed*1000, **getattr(observed, 'stats', {})))
                chunk_size, cost_model = next_unified_chunk(end-cursor, elapsed, cost_model)
                counts.update(observed)
                queue_unified_observations(state, observed)
                cursor = end
                state['unified'] = cursor
                window['chunksDone'] += 1
                # Keep the gap pending until the source result reports it,
                # including an interruption after the last chunk checkpoint.
                state['unifiedRetry'] = retry_window(cursor, window)
                save_state('crashes', state)
                flush_unified_observations(state)
            state['unified'] = window['windowEnd']
            state.pop('unifiedRetry', None)
            emit('crashes', 'event', 'crash.source', ok=True,
                 props=dict({**window, **stats}, source='unified', elapsedMs=(time.monotonic()-source_started)*1000,
                            lagS=lag(), stopReason='done', partial=bool(state.get('unifiedBootPending') or state.get('unifiedOutbox') or stats.get('bootUnresolvedS') or stats.get('bootSecondUnreadableS'))))
            skipped += window['skippedS']
            # Persist the reported gap's retirement before a fresh command can
            # be interrupted; otherwise the next run would report it again.
            save_state('crashes', state)
            if cursor >= now:
                break
            # A retry owns a frozen end, but finishing it must not waste the
            # rest of this run's share. Apply the cap again to the fresh window.
            for key in ('bootUnresolvedS', 'bootSecondUnreadableS'):
                retired_boot_skips[key] = retired_boot_skips.get(key, 0)+stats.get(key, 0)
            stats = {}
            window = fresh_window(cursor)
    except Exception as exc:
        errors += 1
        state['unifiedRetry'] = retry_window(cursor, window)
        source_error('crashes', 'crash.source', 'unified', source_started, exc,
                     dict({**window, **stats}, lagS=lag(), stopReason=stop_reason, partial=True))
        skipped += window['skippedS']
        state['unifiedRetry']['skippedS'] = 0
        for key in ('bootUnresolvedS', 'bootSecondUnreadableS'):
            state['unifiedRetry'].pop(key, None)
    window = dict(window, skippedS=skipped, lagS=lag(), stopReason=stop_reason,
                  skipReason='bootSecondUnreadable' if stats.get('bootSecondUnreadableS') or retired_boot_skips.get('bootSecondUnreadableS') else 'bootUnresolved' if stats.get('bootUnresolvedS') or retired_boot_skips.get('bootUnresolvedS') else 'lag_ceiling' if skipped else None)
    emit('crashes', 'error' if errors else 'perf', 'crash.collect', ok=not errors,
         duration_ms=(time.monotonic()-started)*1000,
         props={'count': sum(counts.values()), 'sourceErrors': errors, **window},
         error_tag='crash.source_unavailable' if errors else None)
    save_state('crashes', state)
    utc = dt.datetime.fromtimestamp(now, dt.timezone.utc)
    day = (utc.date()-dt.timedelta(days=1)).isoformat()
    if (utc.hour > 0 or utc.minute >= 5) and state.get('rollupDay') != day:
        try:
            deadline_call(deadline, rollup, day, publish=True, now=utc)
            state['rollupDay'] = day
            save_state('crashes', state)
        except Exception:
            emit('rollup', 'error', 'log.rollup', ok=False, error_tag='rollup.failed')
    return not errors


def elapsed_seconds(value):
    if not re.fullmatch(r'(?:\d+-\d{2}:|\d+:)?\d{2}:[0-5]\d', value):
        raise ValueError('invalid etime')
    days, _, clock = value.rpartition('-')
    parts = [int(p) for p in clock.split(':')]
    if len(parts) not in (2, 3):
        raise ValueError('invalid etime')
    return int(days or 0)*86400 + sum(n*60**i for i, n in enumerate(reversed(parts)))


def process_snapshot(run, timeout=10):
    result = run(['/bin/ps', '-axo', 'pid,ppid,etime,stat,comm,args'],
                 capture_output=True, text=True, timeout=timeout,
                 env={**os.environ, 'LC_ALL': 'C'})
    if result.returncode:
        raise SourceFailure('exit', 'ps exited unsuccessfully', result.returncode)
    lines = result.stdout.splitlines()
    if not lines or not re.fullmatch(r'\s*PID\s+PPID\s+ELAPSED\s+STAT\s+COMM\s+ARGS\s*', lines[0]):
        raise SourceFailure('parse', 'invalid ps header')
    # macOS comm is a fixed-width column and may contain spaces. Splitting
    # the whole row on whitespace would move part of comm into args.
    comm_at, args_at = lines[0].index('COMM'), lines[0].index('ARGS')
    procs = []
    for line in lines[1:]:
        if not line.strip():
            continue
        try:
            pid, ppid, age, stat = line[:comm_at].split()
            proc = dict(pid=int(pid), ppid=int(ppid), processAgeS=elapsed_seconds(age),
                        stat=stat, comm=line[comm_at:args_at].strip(),
                        args=line[args_at:].strip())
            if proc['pid'] <= 0 or proc['ppid'] < 0 or not proc['comm']:
                raise ValueError()
        except ValueError:
            raise SourceFailure('parse', 'invalid ps row') from None
        procs.append(proc)
    return procs


def unmount_point(proc):
    if proc['comm'] not in ('umount', '/sbin/umount'):
        return None
    # ps does not quote paths containing spaces. Strip only leading options
    # and keep the remaining mount pathname intact, without statting it.
    fields = proc['args'].split(None, 1)
    rest = fields[1] if len(fields) == 2 else ''
    all_mounts = False
    while rest.startswith('-'):
        fields = rest.split(None, 1)
        option, rest = fields[0], fields[1] if len(fields) == 2 else ''
        if option == '--':
            break
        for i, flag in enumerate(option[1:], 1):
            if flag in 'aA':
                all_mounts = True
            if flag in 'ht':
                # getopt accepts both -ft nfs and -ftnfs. Everything after
                # the operand-taking flag belongs to its value.
                if not option[i+1:]:
                    fields = rest.split(None, 1)
                    rest = fields[1] if len(fields) == 2 else ''
                break
    return None if all_mounts else rest[:300] or None



def process_starts(pids, run, timeout=10):
    result = run(['/bin/ps', '-p', ','.join(str(pid) for pid in pids),
                  '-o', 'pid=,lstart='], capture_output=True, text=True, timeout=timeout,
                 env={**os.environ, 'LC_ALL': 'C', 'TZ': 'UTC'})
    if result.returncode:
        raise SourceFailure('exit', 'ps start lookup failed', result.returncode)
    starts = {}
    for line in result.stdout.splitlines():
        fields = line.split(None, 1)
        if len(fields) != 2:
            continue
        try:
            at = dt.datetime.strptime(fields[1], '%a %b %d %H:%M:%S %Y')
            starts[int(fields[0])] = int(at.replace(tzinfo=dt.timezone.utc).timestamp())
        except ValueError:
            continue
    return starts


DISK_WAIT_SAMPLES = 6


def cpu_seconds(value):
    if not re.fullmatch(r'(?:\d+-)?\d+(?::[0-5]\d){1,2}(?:\.\d+)?', value):
        raise ValueError('invalid CPU time')
    days, _, clock = value.rpartition('-')
    parts = clock.split(':')
    if days and len(parts) != 3:
        raise ValueError('invalid CPU time')
    return int(days or 0)*86400 + sum(float(n)*60**i for i, n in enumerate(reversed(parts)))


def process_sample(pids, run, timeout):
    result = run(['/bin/ps', '-p', ','.join(str(pid) for pid in pids),
                  '-o', 'pid=,stat=,time='], capture_output=True, text=True, timeout=timeout,
                 env={**os.environ, 'LC_ALL': 'C'})
    # ps exits 1 when none of the selected processes remain.
    if result.returncode and not (result.returncode == 1 and not result.stdout.strip()):
        raise SourceFailure('exit', 'ps sample failed', result.returncode)
    samples = {}
    for line in result.stdout.splitlines():
        try:
            pid, stat, cpu = line.split()
            pid = int(pid)
            if pid not in pids or not re.fullmatch(r'[A-Za-z+<>-]{1,16}', stat):
                raise ValueError()
            samples[pid] = dict(stat=stat, cpuTime=cpu, cpu=cpu_seconds(cpu))
        except ValueError:
            raise SourceFailure('parse', 'invalid ps sample') from None
    return samples


def sample_disk_wait(candidates, run, deadline, sample_count=DISK_WAIT_SAMPLES):
    observations = {p['pid']: [] for p in candidates}
    count = 0
    starts = {}
    for i in range(sample_count):
        if not observations:
            break
        remaining = deadline-time.monotonic()
        if i:
            if remaining <= 1:
                break
            time.sleep(1)
            remaining = deadline-time.monotonic()
        if remaining <= 0:
            break
        try:
            sample = process_sample(observations, run, min(10, remaining))
        except subprocess.TimeoutExpired:
            # A deadline-limited call may expire after enough valid samples.
            # Other failures still invalidate the observation in the caller.
            if time.monotonic() >= deadline:
                break
            raise
        count += 1
        # Once a PID disappears, never re-admit it during this observation.
        observations = {pid: rows+[sample[pid]] for pid, rows in observations.items() if pid in sample}
        # Capture identity after the first CPU sample, before follow-ups can
        # consume the budget needed to preserve an existing stuck duration.
        if i == 0 and observations:
            remaining = deadline-time.monotonic()
            if remaining > 0:
                starts = process_starts(observations, run, min(10, remaining))
    return observations, count, starts


def clone_wait_paths(proc):
    # ps arguments are not shell input. A quote may be a literal filename
    # character, so shell parsing must not suppress a known clone command.
    args = proc['args'].split()
    command = proc['comm'].rsplit('/', 1)[-1]
    clone = command == 'clonefile'
    operands = args[1:]
    if command == 'cp':
        for index, arg in enumerate(args[1:], 1):
            if arg == '--':
                operands = args[index+1:]
                break
            if not arg.startswith('-'):
                operands = args[index:]
                break
            clone |= 'c' in arg[1:] and not arg.startswith('--')
    paths = list(dict.fromkeys(operands if clone else (arg for arg in args[1:] if arg.startswith('/'))))
    return clone, paths


def exact_wait_paths(proc):
    if any(char in proc['args'] for char in "'\"\\"):
        return set()
    args = proc['args'].split()
    # A bare word after an absolute token may be part of an unquoted path.
    # Omit that ambiguous operand rather than group unrelated files by prefix.
    return {arg for index, arg in enumerate(args[1:], 1) if arg.startswith('/') and
            (index == len(args)-1 or args[index+1].startswith(('/', '-')))}


def clone_wait_alerts(procs, snapshot, starts, run, deadline):
    root = state_path('clone-wait-alert').parent
    with (root / 'clone-wait-alert.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        alive = {str(p['pid']) for p in snapshot}
        state = {pid: entry for pid, entry in read_state('clone-wait-alert').items() if pid in alive}
        # Several waiters for one pathname are one incident. A clone PID is
        # preferred as its identity when it also belongs to that group.
        groups = {}
        for proc in procs:
            identity = ('path', proc['_incidentPath']) if proc['_incidentPath'] else ('pid', proc['pid'])
            groups.setdefault(identity, []).append(proc)
        for group in groups.values():
            group.sort(key=lambda p: (p['reason'] != 'clone', p['pid']))
            existing = [state[str(p['pid'])] for p in group
                if state.get(str(p['pid']), {}).get('start') == starts[p['pid']]]
            sent_entry = next((entry for entry in existing if entry.get('sent')), None)
            if sent_entry:
                for member in group:
                    state[str(member['pid'])] = dict(sent_entry, start=starts[member['pid']])
                save_state('clone-wait-alert', state)
                continue
            proc = group[0]
            pid = str(proc['pid'])
            entry = existing[0] if existing else None
            if entry is None:
                path = safe_fields(dict(procs=[proc]), 'disk.clone_wedge')['procs'][0]['path']
                key = 'mac-upkeep:clone-wait:%s:%s' % (pid, starts[proc['pid']])
                entry = dict(start=starts[proc['pid']], key=key, sent=False,
                    text='APFS clone/path I/O wait: pid %s, %s. This may be progressing; compare CPU time and iostat, then collect spindump. Avoid more clones or pathname probes.' % (pid, path))
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                break
            # Queueing can succeed before notify returns. Persist every
            # survivor's retry identity before that interruption window.
            for member in group:
                state[str(member['pid'])] = dict(entry, start=starts[member['pid']], sent=False)
            save_state('clone-wait-alert', state)
            try:
                sent = notify(entry['text'], entry['key'], run, timeout=min(20, remaining))
            except Exception:
                sent = False
            emit('disk', 'event' if sent else 'error', 'disk.clone_wedge_alert', ok=sent,
                 error_tag=None if sent else 'disk.notify_failed')
            for member in group:
                state[str(member['pid'])] = dict(entry, start=starts[member['pid']], sent=sent)
            save_state('clone-wait-alert', state)


def clone_wait(snapshot, run, deadline):
    deadline = min(deadline, time.monotonic()+20)
    props = dict(count=0, procs=[], sampleCount=0, sampling='full')
    try:
        selected, by_path = {}, {}
        for proc in snapshot:
            if 'U' not in proc['stat'] or proc['comm'] in ('umount', '/sbin/umount'):
                continue
            clone, paths = clone_wait_paths(proc)
            exact = exact_wait_paths(proc)
            selected[proc['pid']] = (proc, clone, paths, exact)
            for path in paths:
                if path in exact:
                    by_path.setdefault(path, set()).add(proc['pid'])
        shared = {path: pids for path, pids in by_path.items() if len(pids) >= 2}
        candidates = [p for p, clone, paths, exact in selected.values()
                      if clone or any(p['pid'] in shared.get(path, ()) for path in paths)]
        if candidates:
            observations, count, starts = sample_disk_wait(candidates, run, deadline, sample_count=3)
            props.update(sampleCount=count, sampling='full' if count == 3 else 'partial')
            if count != 3:
                raise SourceFailure('timeout', 'incomplete clone observation')
            # Revalidate identity after sampling rather than attributing a
            # recycled PID's CPU or wait channel to its predecessor.
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise SourceFailure('timeout', 'clone observation budget exhausted')
            ends = process_starts(observations, run, min(5, remaining)) if observations else {}
            valid = {pid: rows for pid, rows in observations.items()
                     if pid in starts and starts[pid] == ends.get(pid)}
            waiting = {pid for pid, rows in valid.items() if all('U' in r['stat'] for r in rows)}
            shared = {path: pids & waiting for path, pids in shared.items() if len(pids & waiting) >= 2}
            procs = []
            for proc in candidates:
                pid = proc['pid']
                if pid not in waiting:
                    continue
                _, clone, paths, exact = selected[pid]
                matched = [path for path in paths if pid in shared.get(path, ())]
                if not clone and not matched:
                    continue
                procs.append(dict(pid=pid, path=(matched[0] if matched else paths[-1] if paths else ''),
                    _incidentPath=matched[0] if matched else paths[-1] if paths and paths[-1] in exact else None,
                    reason='clone' if clone else 'shared_path', processAgeS=proc['processAgeS'],
                    wchan='-', cpuDeltaS=max(0, valid[pid][-1]['cpu']-valid[pid][0]['cpu'])))
            if procs:
                remaining = deadline-time.monotonic()
                if remaining <= 0:
                    raise SourceFailure('timeout', 'clone observation budget exhausted')
                channels = run(['/bin/ps', '-p', ','.join(str(p['pid']) for p in procs), '-o', 'pid=,wchan='],
                               capture_output=True, text=True, timeout=min(5, remaining))
                for line in channels.stdout.splitlines() if channels.returncode == 0 else []:
                    fields = line.split()
                    if len(fields) == 2:
                        for proc in procs:
                            if fields[0] == str(proc['pid']):
                                proc['wchan'] = fields[1]
            props.update(count=len(procs), procs=procs[:10])
            props = safe_fields(props, 'disk.clone_wedge')
            emit('disk', 'event', 'disk.clone_wedge', ok=True, props=props)
            clone_wait_alerts(procs, snapshot, starts, run, deadline)
            return
    except Exception as exc:
        props.update(failure='timeout' if isinstance(exc, subprocess.TimeoutExpired) else (
            exc.failure if isinstance(exc, SourceFailure) else 'unavailable'), sampling='partial')
        emit('disk', 'error', 'disk.clone_wedge', ok=False, props=props, error_tag='disk.clone_probe_failed')
        return
    emit('disk', 'event', 'disk.clone_wedge', ok=True, props=props)


def stuck_durations(procs, observations, starts, now):
    previous = read_state('disk-wait-stuck')
    state = {}
    for proc in procs:
        pid = proc['pid']
        rows = observations[pid]
        first = now
        if pid in starts:
            entry = previous.get(str(pid), {})
            if not isinstance(entry, dict):
                entry = {}
            try:
                # CPU progress between hourly observations also breaks a stall.
                if (entry.get('start') == starts[pid] and
                        cpu_seconds(entry.get('cpu', '')) == rows[0]['cpu'] and
                        finite_number(entry.get('firstStuckAt')) and 0 <= entry['firstStuckAt'] <= now):
                    first = entry['firstStuckAt']
            except (TypeError, ValueError):
                pass
            state[str(pid)] = dict(start=starts[pid], firstStuckAt=first, cpu=rows[-1]['cpuTime'])
        proc['stuckForS'] = max(0, int(now-first))
        if proc['comm'] in ('umount', '/sbin/umount'):
            proc['stuckForS'] = max(proc['stuckForS'], proc['processAgeS'])
    save_state('disk-wait-stuck', state)


def disk_wait_alerts(procs, all_pids, starts, run, deadline):
    candidates = [p for p in procs if p['stuckForS'] >= 21600 or
                  (p['comm'] in ('umount', '/sbin/umount') and p['stuckForS'] >= 1800)]
    if not candidates:
        return
    root = state_path('disk-wait-alert').parent
    with (root / 'disk-wait-alert.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = read_state('disk-wait-alert')
        # Keep sent incidents even across non-U observations, until the process
        # exits. lstart distinguishes reuse of a PID, without clock rounding.
        state = {pid: entry for pid, entry in state.items() if pid in all_pids}
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            return
        for proc in candidates:
            pid = str(proc['pid'])
            if proc['pid'] not in starts:
                continue
            key = 'mac-upkeep:disk-wait:%s:%s' % (pid, starts[proc['pid']])
            entry = state.get(pid, {})
            if entry.get('key') != key:
                mount = unmount_point(proc)
                text = '%s (pid %s) has been stuck in disk wait for at least %.1fh%s. lsof and diskutil may hang; a reboot clears a stuck umount.' % (
                    proc['comm'], pid, proc['stuckForS']/3600,
                    ', unmounting '+mount if mount else '')
                entry = dict(key=key, text=text, sent=False)
                state[pid] = entry
            if entry.get('sent'):
                continue
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                break
            # Persist the exact text before notify: a timeout can happen after
            # queueing, and the bridge requires identical text on retry.
            save_state('disk-wait-alert', state)
            try:
                sent = notify(entry['text'], key, run, timeout=min(20, remaining))
            except Exception:
                sent = False
            emit('proc', 'event' if sent else 'error', 'proc.disk_wait_alert', ok=sent,
                 error_tag=None if sent else 'proc.notify_failed')
            entry['sent'] = sent
            save_state('disk-wait-alert', state)


def disk_wait(run=subprocess.run, deadline=None):
    deadline = min(time.monotonic()+45, deadline) if deadline is not None else time.monotonic()+45
    props = dict(count=0, procs=[], stuckUnmount=False, busyCount=0, busy=[],
                 sampleCount=0, sampling='partial')
    try:
        remaining = deadline-time.monotonic()
        if remaining <= 0:
            raise SourceFailure('timeout', 'collector budget exhausted')
        snapshot = process_snapshot(run, min(10, remaining))
        clone_wait(snapshot, run, deadline)
        candidates = sorted((p for p in snapshot if 'U' in p['stat'] and p['processAgeS'] >= 600),
                            key=lambda p: (-p['processAgeS'], p['pid']))
        observations, count, starts = sample_disk_wait(candidates, run, deadline)
        props.update(sampleCount=count, sampling='full' if count == DISK_WAIT_SAMPLES or not candidates else 'partial')
        procs, busy = [], []
        for proc in candidates:
            rows = observations.get(proc['pid'])
            if not rows:
                continue
            stats = [r['stat'] for r in rows]
            if count >= 3 and all('U' in stat for stat in stats) and rows[0]['cpu'] == rows[-1]['cpu']:
                procs.append(dict(proc, args=proc['args'][:300], samples=stats, cpuTime=rows[-1]['cpuTime']))
            else:
                # Every candidate was in U in the full snapshot, including
                # those that recovered before the first CPU sample.
                busy.append(dict(pid=proc['pid'], comm=proc['comm'], processAgeS=proc['processAgeS'],
                                 statSamples=stats, cpuDeltaS=max(0, rows[-1]['cpu']-rows[0]['cpu'])))
        stuck_durations(procs, observations, starts, time.time())
        procs.sort(key=lambda p: (-p['stuckForS'], -p['processAgeS'], p['pid']))
        props.update(count=len(procs), procs=procs[:10], busyCount=len(busy), busy=busy[:10])
        unmounts = [p for p in procs if p['comm'] in ('umount', '/sbin/umount')]
        if unmounts:
            props['stuckUnmount'] = True
            mount = unmount_point(unmounts[0])
            if mount:
                props['mountPoint'] = mount
    except Exception as exc:
        # An unobserved interval cannot extend a later stuck duration.
        try:
            save_state('disk-wait-stuck', {})
        except Exception:
            pass
        props['failure'] = 'timeout' if isinstance(exc, subprocess.TimeoutExpired) else (
            exc.failure if isinstance(exc, SourceFailure) else 'unavailable')
        emit('proc', 'error', 'proc.disk_wait', ok=False, props=props, error_tag='proc.ps_failed')
        return props
    emit('proc', 'event', 'proc.disk_wait', ok=True, props=props)
    try:
        disk_wait_alerts(procs, {str(p['pid']) for p in snapshot}, starts, run, deadline)
    except Exception:
        emit('proc', 'error', 'proc.disk_wait_alert', ok=False, error_tag='proc.alert_failed')
    return props


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


def notify(text, key, run, timeout=20):
    env = dict(os.environ)
    env.pop('BUN_INSPECT', None)
    result = run(['/Users/ardud/.bun/bin/bun',
                  '/Users/ardud/.local/share/telegram-bridge/src/cli.ts', 'notify',
                  '--source', 'Mac Upkeep', '--severity', 'attention', '--text',
                  text,
                  '--key', key], capture_output=True, timeout=timeout, env=env)
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
    # Check before any job can create today's file and hide its absence.
    missing_day()
    homebrew_integrity(lambda text, key: notify(text, key, subprocess.run))
    deadline = time.monotonic()+290
    from boot import check
    check()
    try:
        collect(deadline=deadline)
    except Exception:
        emit('crashes', 'error', 'crash.collect', ok=False, error_tag='crash.collect_failed')
    disk_wait(deadline=deadline)
    disk_tooling_probe()
    try:
        directory_inventory(deadline=deadline)
    except Exception:
        emit('disk', 'error', 'disk.inventory', ok=False, error_tag='disk.inventory_failed')
    try:
        from disk_budgets import sample
        sample()
    except Exception:
        emit('disk', 'error', 'disk.budget.failed', ok=False, error_tag='disk.budget_failed')


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['--tailnet']:
        from tailnet import check
        missing_day()
        check()
    else:
        main()
