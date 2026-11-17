"""Protection decisions and audit envelopes shared by the client and boatd."""
from __future__ import annotations

import contextvars
import json
import os
import re
import socket
import subprocess
import sys
from functools import wraps

CALLER = contextvars.ContextVar('offbox_caller', default=None)


def redact_parent_argv(argv):
    parent = [os.path.basename(str(argv[0]))] if argv else []
    parent += [v.split('=', 1)[0] if re.fullmatch(r'--?[a-zA-Z][a-zA-Z0-9-]*(=.*)?', v)
               else '<redacted>' for v in map(str, argv[1:64])]
    return parent


def caller(actor=None, **fields):
    current = CALLER.get()
    if current is None:
        ppid = os.getppid()
        argv = []
        if actor is None or actor.startswith(('client:', 'home-repair/')):
            try:
                argv = subprocess.run(['ps', '-ww', '-p', str(ppid), '-o', 'args='], capture_output=True,
                                      text=True, timeout=1).stdout.strip().split()
            except (OSError, subprocess.SubprocessError):
                pass
        # Parent prompts and shell programs can contain credentials. Keep the executable and flag names only.
        parent = redact_parent_argv(argv)
        current = dict(actor='client:' + (sys.argv[1] if len(sys.argv) > 1 else 'command'),
                       pid=os.getpid(), parent_pid=ppid, parent_argv=parent[:64], host=socket.gethostname(),
                       thread_id=next((os.environ[k] for k in ('T3_THREAD_ID', 'ROBOB_THREAD_ID',
                                      'T3CODE_THREAD_ID') if os.environ.get(k)), None),
                       run_id=os.environ.get('OFFBOX_BACKGROUND_RUN'), holder=None)
    return {**current, **({'actor': actor} if actor else {}), **fields}


def blocked(snapshot, *, holder=None, automatic=True, override=False, reuse=False):
    """Unknown liveness is protection, never evidence that a lease is available."""
    if override and not automatic and not reuse:
        return None
    pin = snapshot.get('pin') or {}
    if pin.get('active') and (automatic or not holder or pin.get('holder') != holder or not reuse):
        return f"pinned by {pin.get('holder') or 'unknown holder'} until {pin.get('until') or 'explicit unpin'}"
    holds = snapshot.get('holds') or []
    if holds:
        return 'held by ' + ', '.join(f"{h.get('holder') or 'unknown holder'} (run {h.get('run_id') or '?'}, "
                                     f"{h.get('state') or 'liveness unknown'})" for h in holds)
    return None


def envelope(action, reason, snapshot, *, actor=None, **fields):
    return dict(version=1, action=action, reason=reason, caller=caller(actor, **fields), protection=snapshot)


def header():
    return {'X-Offbox-Caller': json.dumps(caller(), ensure_ascii=True, separators=(',', ':'))}


def actor(name):
    def decorate(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            token = CALLER.set(caller(name))
            try:
                return fn(*args, **kwargs)
            finally:
                CALLER.reset(token)
        return wrapped
    return decorate


def reasoned(fn):
    @wraps(fn)
    def wrapped(con, box_id, reason, *args, **kwargs):
        token = CALLER.set(caller(reason=reason))
        try:
            return fn(con, box_id, reason, *args, **kwargs)
        finally:
            CALLER.reset(token)
    return wrapped


def bind(fn):
    context = caller()
    @wraps(fn)
    def wrapped(*args, **kwargs):
        token = CALLER.set(context)
        try:
            return fn(*args, **kwargs)
        finally:
            CALLER.reset(token)
    return wrapped


def request_caller(supplied, owner, peer):
    # Old clients have no caller metadata. Do not attribute their actions to boatd's own PID or parent.
    result = dict(actor='client:api', pid=None, parent_pid=None, parent_argv=[], host=None,
                  thread_id=None, run_id=None, holder=None, override=False)
    for name in ('actor', 'host', 'thread_id', 'run_id', 'holder', 'reason'):
        value = supplied.get(name)
        if isinstance(value, str):
            result[name] = value[:256]
    for name in ('pid', 'parent_pid'):
        if type(supplied.get(name)) is int:
            result[name] = supplied[name]
    parent = supplied.get('parent_argv')
    if isinstance(parent, list):
        result['parent_argv'] = redact_parent_argv([str(v)[:128] for v in parent[:64]])
    result.update(override=supplied.get('override') is True, authenticated_owner=owner, peer=peer,
                  server_pid=os.getpid(), server_host=socket.gethostname())
    return result


if __name__ == '__main__':
    import argparse
    from pathlib import Path
    parser = argparse.ArgumentParser()
    parser.add_argument('--actor')
    parser.add_argument('--reason')
    parser.add_argument('--check')
    args = parser.parse_args()
    if args.check:
        try:
            snapshot = json.loads(Path(args.check).read_text())
            if (snapshot.get('ok') is not True or type(snapshot.get('pin', {}).get('active')) is not bool
                    or not isinstance(snapshot.get('holds'), list)):
                raise ValueError('protection unavailable')
            reason = blocked(snapshot)
        except (OSError, ValueError, TypeError, AttributeError):
            reason = 'protection unavailable'
        if reason:
            print(reason, file=sys.stderr)
            sys.exit(1)
    else:
        print(json.dumps(caller(args.actor, reason=args.reason)))
