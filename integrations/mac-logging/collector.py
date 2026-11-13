#!/usr/bin/python3
"""Read-only Mac crash evidence collector; persists only cursors and counts."""
from collections import Counter
import datetime as dt
import json
from pathlib import Path
import re
import subprocess
import time
from jobs import read_state, save_state, directory_inventory
from rollup import rollup
from toollog import emit

REPORT_DIRS = [Path('/Library/Logs/DiagnosticReports'), Path('/Library/Logs/DiagnosticReports/Retired'),
               Path.home() / 'Library/Logs/DiagnosticReports']


def reports(root, since, until):
    counts = Counter()
    if not root.exists():
        return counts
    for path in root.iterdir():
        if path.suffix not in ('.panic', '.ips', '.crash', '.hang', '.spin', '.shutdownStall'):
            continue
        st = path.stat()
        if not since < st.st_mtime <= until:
            continue
        kind = 'panic' if path.suffix == '.panic' else 'hang' if path.suffix in ('.hang', '.spin', '.shutdownStall') else 'app_crash'
        # Parse only the small .ips header. Stack traces, exception messages, and
        # process arguments never enter either the state or the shared log.
        process = re.split(r'[_-]\d{4}-?\d{2}', path.stem)[0]
        if path.suffix == '.ips':
            with path.open() as stream:
                header = stream.readline(4096)
            try:
                meta = json.loads(header)
                process = meta.get('app_name') or meta.get('name') or process
                bug = str(meta.get('bug_type', ''))
                if bug == '210':
                    kind, process = 'panic', 'kernel'
                elif bug in ('109', '309'):
                    kind = 'app_crash'
                else:
                    # Stackshots, Jetsam and resource diagnostics are not proof
                    # that the system hung or an application crashed.
                    continue
            except ValueError:
                continue
        if kind == 'panic':
            process = 'kernel'
        # Whitelist process-name characters; a diagnostic filename is untrusted.
        if not re.fullmatch(r'[A-Za-z0-9_. +()-]{1,100}', process):
            process = 'unknown'
        counts[kind, process] += 1
    return counts


def unified(since, until, run=subprocess.run):
    def stamp(value):
        return dt.datetime.fromtimestamp(value, dt.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    result = run(['/usr/bin/log', 'show', '--style', 'json', '--timezone', 'UTC',
                  '--start', stamp(since), '--end', stamp(until+1), '--predicate',
                  'eventMessage CONTAINS "=== system boot" OR (process == "kernel" AND eventMessage CONTAINS "PMU") OR (process == "watchdogd" AND eventMessage CONTAINS "unresponsive")'],
                 capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('unified unavailable')
    counts = Counter()
    for row in json.loads(result.stdout or '[]'):
        timestamp = row.get('timestamp')
        if timestamp:
            at = dt.datetime.fromisoformat(re.sub(r'([+-]\d{2})(\d{2})$', r'\1:\2', timestamp.replace('Z', '+00:00')))
            if at.tzinfo is None:
                at = at.replace(tzinfo=dt.timezone.utc)
            if not since < at.timestamp() <= until:
                continue
        message = row.get('eventMessage', '')
        if '=== system boot' in message:
            counts['restart', 'kernel'] += 1
        elif 'wdog' in message.lower() or 'unresponsive' in message.lower():
            counts['hang', 'system'] += 1
    return counts


def collect(now=None, roots=None, log_reader=unified):
    started = time.monotonic()
    now = time.time() if now is None else now
    state = read_state('crashes')
    counts, errors = Counter(), 0
    for i, root in enumerate(REPORT_DIRS if roots is None else roots):
        key = 'reports%d' % i
        try:
            counts.update(reports(root, state.get(key, now-3600), now))
            state[key] = now
        except Exception:
            errors += 1
    try:
        counts.update(log_reader(state.get('unified', now-3600), now))
        state['unified'] = now
    except Exception:
        errors += 1
    for (kind, process), count in counts.items():
        emit('crashes', 'event', 'crash.observed', ok=True,
             props={'resourceKind': kind, 'process': process, 'count': count})
    emit('crashes', 'error' if errors else 'perf', 'crash.collect', ok=not errors,
         duration_ms=(time.monotonic()-started)*1000,
         props={'count': sum(counts.values()), 'sourceErrors': errors},
         error_tag='crash.source_unavailable' if errors else None)
    save_state('crashes', state)
    utc = dt.datetime.fromtimestamp(now, dt.timezone.utc)
    day = (utc.date()-dt.timedelta(days=1)).isoformat()
    if (utc.hour > 0 or utc.minute >= 5) and state.get('rollupDay') != day:
        try:
            rollup(day)
            state['rollupDay'] = day
            save_state('crashes', state)
            emit('rollup', 'event', 'log.rollup', ok=True)
        except Exception:
            emit('rollup', 'error', 'log.rollup', ok=False, error_tag='rollup.failed')
    return not errors


def main():
    try:
        directory_inventory()
    except Exception:
        emit('disk', 'error', 'disk.inventory', ok=False, error_tag='disk.inventory_failed')
    try:
        collect()
    except Exception:
        emit('crashes', 'error', 'crash.collect', ok=False, error_tag='crash.collect_failed')


if __name__ == '__main__':
    main()
