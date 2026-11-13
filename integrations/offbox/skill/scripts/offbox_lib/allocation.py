"""Serialize machine-start sends, not pool selection or bring-up, and retain unanswered starts."""
from __future__ import annotations

import contextlib
import contextvars
import hashlib
import os
import time

from .common import BOX_WEDGED_NOTE, OffboxError, db, file_lock, now, say, write

UNANSWERED = ('uncertain', 'reserved', 'http_502', 'http_504', 'http_520', 'http_524')


def clear_resume(con, box_id):
    from . import capacity
    capacity.schema(con)
    with write(con):
        con.execute("DELETE FROM kv WHERE k IN (?,?,?)", (f"resume_unanswered:{box_id}", f"resume_provision:{box_id}", f"resume_sender:{box_id}"))
        con.execute("UPDATE start_requests SET outcome='settled' WHERE box_id=? AND operation='resume' "
                    "AND outcome IN (?,?,?,?,?,?)", (box_id, *UNANSWERED))


def recover_resumes(con, key):
    """Import pre-marker unanswered resumes during rollout; settled/quarantined boxes never re-enter the pool."""
    from . import capacity
    capacity.schema(con)
    with write(con):
        rows = con.execute("SELECT l.box_id, s.ts FROM leases l JOIN start_requests s ON s.box_id=l.box_id "
                           "WHERE l.repo_key=? AND l.state IN ('running','stopped') AND s.operation='resume' "
                           "AND COALESCE(l.note,'') NOT LIKE ? "
                           "AND s.ts>? AND s.outcome IN (?,?,?,?,?,?) "
                           "AND s.id=(SELECT MAX(t.id) FROM start_requests t WHERE t.box_id=l.box_id "
                           "AND t.operation='resume')", (key, BOX_WEDGED_NOTE + '%', now() - 900, *UNANSWERED)).fetchall()
        seconds = capacity.setting('OFFBOX_RESUME_PROVISION_SECONDS', 300, minimum=1, maximum=900)
        for row in rows:
            con.execute("INSERT OR IGNORE INTO kv VALUES (?,?,?)", (f"resume_unanswered:{row['box_id']}", '', row['ts']))
            con.execute("INSERT OR IGNORE INTO kv VALUES (?,?,?)",
                        (f"resume_provision:{row['box_id']}", str(row['ts'] + seconds), row['ts']))


_SCOPE = contextvars.ContextVar("allocation_scope", default=None)
_HELD = contextvars.ContextVar("allocation_held", default=False)
_QUEUE = contextvars.ContextVar("allocation_queue", default=None)
LOCK_TAKE_S = 30


class Busy(OffboxError):
    """Ordinary start contention; pool callers return to their queue outside the readiness budget."""
    def __init__(self, message):
        super().__init__(message, code=92)


@contextlib.contextmanager
def queue():
    from . import pool, outage
    if _QUEUE.get() is not None:
        yield _QUEUE.get()
        return
    wait = pool.wait_seconds()
    left = outage.allocation_left()
    if left is not None:
        wait = min(wait, left)
    state = {'end': pool.time.monotonic() + wait, 'wait': wait, 'said': False}
    token = _QUEUE.set(state)
    try:
        yield state
    finally:
        _QUEUE.reset(token)


def queue_left():
    state = _QUEUE.get()
    # Zero means one immediate selection attempt, with no queueing (existing CLI behavior).
    if state is None or state['wait'] == 0:
        return None
    from . import pool
    return max(0, state['end'] - pool.time.monotonic())


def check_queue():
    if queue_left() == 0:
        from .pool import PoolBusyError
        raise PoolBusyError("allocation queue timed out; nothing ran")


def resume_inflight(con, box_id):
    marker = con.execute("SELECT ts FROM kv WHERE k=?", (f"resume_unanswered:{box_id}",)).fetchone()
    if not marker:
        return False
    sender = con.execute("SELECT v FROM kv WHERE k=?", (f"resume_sender:{box_id}",)).fetchone()
    if sender:
        if not sender[0]:
            return False  # the send returned to its caller; the retained request now needs reconciliation
        from .misc import _pid_started_at
        try:
            pid = int(sender[0])
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except (PermissionError, TypeError, ValueError, OverflowError):
            began = None
        else:
            began = _pid_started_at(pid)
        if began is not None:
            # A PID may belong to a new client after a crash/reboot. That process cannot own this earlier send.
            return began <= marker['ts']
        # An unreadable process identity is only an in-flight hint inside the normal provisioning grace.
    # Older clients do not record a sender. Give their request its existing provisioning window before recovery.
    from . import capacity
    bound = capacity.setting('OFFBOX_RESUME_PROVISION_SECONDS', 300, minimum=1, maximum=900)
    return now() - marker['ts'] < bound


def abandoned_resumes(con, key, box_id=None):
    rows = con.execute("SELECT l.box_id FROM leases l JOIN kv k ON k.k='resume_unanswered:' || l.box_id "
                       "WHERE l.repo_key=? AND l.state IN ('running','stopped') AND l.box_id<>? "
                       "AND COALESCE(l.note,'') NOT LIKE ?",
                       (key, box_id or '', BOX_WEDGED_NOTE + '%')).fetchall()
    return [r for r in rows if not resume_inflight(con, r['box_id'])]


class Unresolved(OffboxError):
    """A previous machine start needs reconciliation before another one can be sent."""


class Fenced(Unresolved):
    """A sibling's unresolved start prevented this caller from sending anything."""


def in_queue():
    return _QUEUE.get() is not None


@contextlib.contextmanager
def scope(key):
    token = _SCOPE.set(key)
    try:
        yield
    finally:
        _SCOPE.reset(token)


def key_for(box_id=None):
    if _SCOPE.get():
        return _SCOPE.get()
    with contextlib.closing(db()) as con:
        row = con.execute("SELECT repo_key FROM leases WHERE box_id=?", (box_id,)).fetchone()
    return row[0] if row else "box:" + (box_id or "unpooled")


def in_scope():
    return _SCOPE.get() is not None


@contextlib.contextmanager
def guard(box_id=None, recover_create=False, reconcile=False):
    check_queue()
    if _HELD.get():
        yield
        return
    key = key_for(box_id)
    name = "allocation-" + hashlib.sha256(key.encode()).hexdigest()[:20]
    from . import pool
    queued = _QUEUE.get()
    wait = queued['wait'] if queued else pool.wait_seconds()
    end = queued['end'] if queued else time.monotonic() + wait
    said = False
    while True:
        try:
            # Pooled attempts yield immediately, releasing their box/readiness guards before queueing again.
            # Direct allocation callers wait here; they have no pool loop to return to.
            take = 0 if queued else min(LOCK_TAKE_S, max(0, end - time.monotonic()))
            lock = file_lock(name, timeout=take)
            lock.__enter__()
            break
        except OffboxError as e:
            if not (queued['said'] if queued else said):
                say(f"waiting: another caller is starting a box for {key}")
                said = True
                if queued:
                    queued['said'] = True
            if (pool.time.monotonic() if queued else time.monotonic()) >= end:
                raise pool.PoolBusyError(f"repository pool busy for {key}: allocation queue timed out; nothing ran") from e
            if queued:
                raise Busy(f"another caller is starting a box for {key}") from e
    try:
        check_queue()
        if not queued and (wait > 0 or said) and time.monotonic() >= end:
            raise pool.PoolBusyError(f"repository pool busy for {key}: allocation queue timed out; nothing ran")
    except BaseException:
        lock.__exit__(None, None, None)
        raise
    token = _HELD.set(True)
    try:
        with contextlib.closing(db()) as con:
            unknown = con.execute("SELECT 1 FROM kv WHERE k=?", ("create_unanswered:" + key,)).fetchone()
            pending = abandoned_resumes(con, key, box_id)
        if (unknown and not recover_create) or (pending and not reconcile):
            raise Fenced("a previous machine start is unanswered; nothing ran. Reconcile it before retrying")
        yield
    finally:
        _HELD.reset(token)
        lock.__exit__(None, None, None)
