"""Local evidence for detached queue clients; diagnostics must never change their lifetime."""
from __future__ import annotations

import atexit
import contextlib
import contextvars
import ctypes
import json
import os
import signal
import sys
import traceback

from . import common

PREFIX = 'bg_queue '
_ACTIVE = contextvars.ContextVar('queue_lifecycle', default=None)


def record(run_id, event, reason, **details):
    with contextlib.suppress(Exception):
        if sys.platform == 'darwin':
            with contextlib.suppress(AttributeError, OSError):
                # PPID 1 does not mean the client has shed the launching app's macOS responsibility.
                details['responsible_pid'] = ctypes.CDLL(None).responsibility_get_pid_responsible_for_pid(os.getpid())
        line = PREFIX + json.dumps(dict(run_id=run_id, event=event, reason=reason,
                                        pid=os.getpid(), ppid=os.getppid(), pgid=os.getpgid(0),
                                        sid=os.getsid(0), at=common.now(), **details), separators=(',', ':'))
        for output in (common.say, common.log):
            with contextlib.suppress(Exception):
                output(line)


def note(run_id, event, reason, **details):
    active = _ACTIVE.get()
    if active is not None and active[0] == run_id:
        active[1]['reason'] = reason
    record(run_id, event, reason, **details)


def _message(error):
    try:
        # SyntaxError's formatter includes source text; its msg and location are sufficient evidence.
        if isinstance(error, SyntaxError):
            return f'{error.msg} ({error.filename}, line {error.lineno})'
        return str(error)
    except Exception as failure:
        return f'<message unavailable: {type(failure).__name__}>'


def _traceback(error):
    # Source lines can contain private command/env literals. Keep frame locations, never locals or source.
    parts, seen = [], set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        frames = ''.join(f'  File "{frame.filename}", line {frame.lineno}, in {frame.name}\n'
                         for frame in traceback.StackSummary.extract(traceback.walk_tb(error.__traceback__), lookup_lines=False))
        parts.append(f'Traceback (most recent call last):\n{frames}{type(error).__name__}: {_message(error)}\n')
        error = error.__cause__ or (error.__context__ if not error.__suppress_context__ else None)
    return '\nCaused by:\n'.join(parts)


def _error_record(run_id, event, reason, error):
    with contextlib.suppress(Exception):
        details = dict(message=_message(error))
        try:
            details['traceback'] = _traceback(error)
        except Exception as failure:
            details['traceback_error'] = type(failure).__name__
        record(run_id, event, reason, **details)


def received(run_id, signum):
    record(run_id, 'signal', signal.Signals(signum).name)
    active = _ACTIVE.get()
    if active is not None and active[0] == run_id:
        active[1]['reason'] = signal.Signals(signum).name
        active[1]['signalName'] = signal.Signals(signum).name


def failed(run_id, error):
    details = {'errorClass': type(error).__name__}
    active = _ACTIVE.get()
    if active is not None and active[0] == run_id and active[1].get('signalName'):
        details['signalName'] = active[1]['signalName']
    with contextlib.suppress(Exception):
        if getattr(error, 'queue_expired', False):
            details['queueExpired'] = True
    reason = 'queue_limit' if details.get('queueExpired') else details.get('signalName', details['errorClass'])
    if active is not None and active[0] == run_id and active[1]['reason'] not in (
            'caller_lookup_failure', 'row_no_longer_pending', 'handoff_rejected', 'source_gone'):
        active[1]['reason'] = reason
    if active is not None or os.environ.get('OFFBOX_BACKGROUND_RUN'):
        _error_record(run_id, 'queue_failed', reason, error)
    return details


@contextlib.contextmanager
def client(run_id):
    result = dict(reason='returned', exit_code=None)
    token = _ACTIVE.set((run_id, result))
    record(run_id, 'start', 'fresh_exec')

    def exited():
        record(run_id, 'end', 'atexit', previous_reason=result['reason'], exit_code=result['exit_code'])

    atexit.register(exited)
    try:
        yield result
    except BaseException as error:
        if result['reason'] == 'returned':
            result['reason'] = type(error).__name__
        if isinstance(error, SystemExit):
            result['exit_code'] = error.code
        _error_record(run_id, 'exception', result['reason'], error)
        raise
    finally:
        record(run_id, 'end', **result)
        _ACTIVE.reset(token)


def last_end(run_id):
    path = common.LOGS_DIR / f'{run_id}.client.log'
    try:
        latest = end = None
        # A 24h queue can put the latest start arbitrarily far behind an old child's delayed atexit.
        # Stream the log so a truncated tail cannot make that old end look like the current child's end.
        with path.open(errors='replace') as stream:
            for line in stream:
                if PREFIX not in line:
                    continue
                try:
                    item = json.loads(line.split(PREFIX, 1)[1])
                except ValueError:
                    continue
                if not isinstance(item, dict) or item.get('run_id') != run_id:
                    continue
                if item.get('event') == 'start':
                    latest, end = item, None
                elif item.get('event') == 'end' and (latest is None or item.get('pid') == latest.get('pid')):
                    end = item
        if end is not None:
            reason = end.get('previous_reason') if end.get('reason') == 'atexit' else end.get('reason')
            return f"client end: {reason} (pid {end.get('pid')}, exit {end.get('exit_code')})"
    except OSError:
        pass
    return 'client log ends with no end record (killed without warning, e.g. SIGKILL)'
