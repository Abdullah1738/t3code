"""Wrapper evidence is diagnostic only; it never decides whether a run passed or stopped."""
from pathlib import Path
import offbox_protocol as protocol
import shlex
import subprocess

PREFIX = protocol.PREFIX

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
nonce = os.environ.get('OFFBOX_PROTOCOL_NONCE', '')
if nonce:
    line += ' [n=' + nonce + ']'
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


def describe(text, planned=0, identity=None, *, trace=False):
    identity = identity or protocol.Protocol()
    completed, started, signal, instrumented = {}, 0, '', False
    for marker in identity.scan(text, trace=trace):
        kind, fields = marker.kind, marker.fields
        if kind in ('command_started', 'retry', 'wrapper', 'begin'):
            completed, started, signal, instrumented = {}, 0, '', False
        if kind == 'begin':
            instrumented = True
            planned = fields['planned']
        elif kind == 'start':
            started = fields['step']
        elif kind in ('end', 'step'):
            completed[fields['step']] = fields['rc']
        elif kind == 'signal':
            signal = fields['signal']
            started = fields.get('step', started)
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


def current_begin(text, identity=None, *, trace=False):
    identity = identity or protocol.Protocol()
    begin = ""
    for marker in identity.scan(text, trace=trace):
        if marker.kind in ('command_started', 'retry', 'wrapper'):
            begin = ""
        if marker.kind == 'begin':
            begin = marker.line
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
    identity = protocol.for_run(row, path)
    budget = 3 if until is None else min(3, max(0, until - now()))
    if budget and row.get('box_id') and any(m.kind == 'begin' for m in identity.scan(text)):
        # Legacy runs have no trace; do not add a futile network read to their waits.
        remote = shlex.quote(row['run_id'] + '.trace')
        try:
            result = ssh_sync.ssh(row['box_id'], 'cat "$HOME/.offbox/exit/"' + remote, timeout=budget)
            if result.returncode == 0 and result.stdout:
                remote_text = result.stdout.decode(errors='replace')
                # A retry may be queued but not yet have reached its wrapper. Do not resurrect its predecessor.
                if current_begin(text, identity) and current_begin(text, identity) == current_begin(remote_text, identity, trace=True):
                    local_notes = [m.line for m in identity.scan(text) if m.kind not in ('command_started', 'retry', 'step')]
                    remote_notes = iter(remote_text.splitlines())
                    # The streamed note precedes its file write. A failed write can leave disk behind the log.
                    if all(any(note == remote for remote in remote_notes) for note in local_notes):
                        local_tail = text.rsplit(PREFIX + current_begin(text, identity), 1)[-1]
                        # A failed evidence writer can still be followed by the ordinary step result line.
                        results = [m.line for m in identity.scan(local_tail) if m.kind == 'step']
                        text = '\n'.join(PREFIX + line for line in remote_text.split('\n')) + '\n' + '\n'.join(results)
        except (OSError, subprocess.TimeoutExpired, OffboxError):
            pass
    detail = describe(text, int(row.get('step_count') or 0), identity)
    if detail:
        say('exit unknown: ' + detail + '; no exit receipt')
