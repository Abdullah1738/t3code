"""Wrapper evidence is diagnostic only; it never decides whether a run passed or stopped."""
from pathlib import Path
import re
import shlex
import subprocess

PREFIX = 'offbox evidence '

# This runs inside runs.BOUNDED_PROCESS: a wedged receipt filesystem cannot hold up a step or signal handler.
WRITER = r'''
import os, sys, time
from pathlib import Path
path = Path.home() / '.offbox/exit' / (os.environ.get('OFFBOX_RUN_ID', '') + '.trace')
line = ' '.join(sys.argv[1:])
if line.startswith('begin '):
    line += ' epoch=' + str(time.time_ns())
if line.startswith('signal=') and 'step=' not in line:
    step = '0'
    try:
        for entry in path.read_text().splitlines():
            if entry.startswith(('begin ', 'wrapper ')):
                step = '0'
            for field in entry.split():
                if field.startswith('step='):
                    step = field[5:]
    except OSError:
        pass
    line += ' step=' + step
print('offbox evidence ' + line, file=sys.stderr, flush=True)
if os.environ.get('OFFBOX_RUN_ID'):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a') as stream:
            stream.write(line + '\n')
    except OSError:
        pass
'''


def shell(supervisor):
    return ('__offbox_evidence() {\npython3 - "$@" <<\'OFFBOX_EVIDENCE\'\n' + supervisor
            + f"\nbounded(['python3', '-c', {WRITER!r}, *sys.argv[1:]], 2, relay=True)\n"
            + 'OFFBOX_EVIDENCE\n}\n')


def describe(text, planned=0):
    from .runs import COMMAND_STARTED_MARKER, STEP_RETRY
    completed, started, signal, instrumented = {}, 0, '', False
    for line in text.splitlines():
        if line.startswith(COMMAND_STARTED_MARKER) or STEP_RETRY.fullmatch(line):
            completed, started, signal, instrumented = {}, 0, '', False
        if line.startswith(PREFIX):
            line = line[len(PREFIX):]
        elif not re.match(r'(begin |start |end |signal=|wrapper )', line):
            match = re.search(r'offbox step (\d+) rc=(-?\d+): ', line)
            if match:
                completed[int(match[1])] = int(match[2])
            continue
        fields = dict(re.findall(r'(\w+)=([^ ]+)', line))
        if any(key in fields and not re.fullmatch(r'-?\d+', fields[key]) for key in ('step', 'rc', 'planned')):
            continue
        required = ('planned',) if line.startswith('begin ') else ('step', 'rc') if line.startswith('end ') else ('step',) if line.startswith('start ') else ()
        if any(key not in fields for key in required):
            continue
        if line.startswith('wrapper '):
            completed, started, signal, instrumented = {}, 0, '', False
        if line.startswith('begin '):
            completed, started, signal, instrumented = {}, 0, '', True
            planned = int(fields.get('planned', '0'))
        if line.startswith('start '):
            started = int(fields.get('step', '0'))
        if line.startswith('end '):
            completed[int(fields['step'])] = int(fields['rc'])
        if 'signal' in fields:
            signal = fields['signal']
            started = int(fields.get('step', started))
    results = ', '.join(f'step {n} rc={rc}' for n, rc in sorted(completed.items()))
    last = max(completed, default=0)
    gaps = [n for n in range(1, last) if n not in completed]
    if signal:
        where = f'caught {signal}' + (f' at step {started}' if started else ' before step 1')
    elif instrumented and started > last:
        where = f'wrapper vanished during step {started} (no end marker)'
    elif instrumented and planned > last:
        where = f'wrapper vanished before step {last + 1}'
    elif instrumented and planned and not gaps:
        where = 'wrapper vanished after all step results'
    elif instrumented and gaps:
        where = 'wrapper vanished with incomplete step evidence'
    elif completed:
        missing = next(n for n in range(1, last + 2) if n not in completed)
        where = f'no result for step {missing}; legacy log cannot show whether it started'
    else:
        return ''
    if gaps:
        where += '; missing end markers for ' + ', '.join(f'step {n}' for n in gaps)
    return (results + '; ' if results else '') + where


def current_begin(text):
    from .runs import COMMAND_STARTED_MARKER, STEP_RETRY
    begin = ""
    for line in text.splitlines():
        if line.startswith(COMMAND_STARTED_MARKER) or STEP_RETRY.fullmatch(line):
            begin = ""
        line = line.removeprefix(PREFIX)
        if line.startswith("wrapper "):
            begin = ""
        if line.startswith("begin "):
            begin = line
    return begin


def report(row, log_path=None, *, until=None, receipt_code=None):
    from .common import say, now, OffboxError
    from . import ssh_sync
    row = dict(row)
    if receipt_code is not None or row.get('exit_code') is not None or row.get('known_exit_code') is not None:
        return
    path = Path(log_path) if log_path else Path(row['log_path']) if row.get('log_path') else None
    try:
        text = path.read_text(errors='replace') if path else ''
    except OSError:
        text = ''
    budget = 3 if until is None else min(3, max(0, until - now()))
    if budget and row.get('box_id') and PREFIX in text:
        # Legacy runs have no trace; do not add a futile network read to their waits.
        remote = shlex.quote(row['run_id'] + '.trace')
        try:
            result = ssh_sync.ssh(row['box_id'], 'cat "$HOME/.offbox/exit/"' + remote, timeout=budget)
            if result.returncode == 0 and result.stdout:
                remote_text = result.stdout.decode(errors='replace')
                # A retry may be queued but not yet have reached its wrapper. Do not resurrect its predecessor.
                if current_begin(text) and current_begin(text) == current_begin(remote_text):
                    local_notes = [line.removeprefix(PREFIX) for line in text.splitlines() if line.startswith(PREFIX)]
                    remote_notes = iter(remote_text.splitlines())
                    # The streamed note precedes its file write. A failed write can leave disk behind the log.
                    if all(any(note == remote for remote in remote_notes) for note in local_notes):
                        from .runs import STEP_RESULT
                        local_tail = text.rsplit(PREFIX + current_begin(text), 1)[-1]
                        # A failed evidence writer can still be followed by the ordinary step result line.
                        results = [line for line in local_tail.splitlines() if STEP_RESULT.search(line)]
                        text = remote_text + '\n' + '\n'.join(results)
        except (OSError, subprocess.TimeoutExpired, OffboxError):
            pass
    detail = describe(text, int(row.get('step_count') or 0))
    if detail:
        say('exit unknown: ' + detail + '; no exit receipt')
