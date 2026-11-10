"""Serialize machine-start sends, not pool selection or bring-up, and retain unanswered starts."""
from __future__ import annotations

import contextlib
import contextvars
import hashlib

from .common import OffboxError, db, file_lock, now, write

UNANSWERED = ('uncertain', 'reserved', 'http_502', 'http_504', 'http_520', 'http_524')


def clear_resume(con, box_id):
    from . import capacity
    capacity.schema(con)
    with write(con):
        con.execute("DELETE FROM kv WHERE k IN (?,?)", (f"resume_unanswered:{box_id}", f"resume_provision:{box_id}"))
        con.execute("UPDATE start_requests SET outcome='settled' WHERE box_id=? AND operation='resume' "
                    "AND outcome IN (?,?,?,?,?,?)", (box_id, *UNANSWERED))


def recover_resumes(con, key):
    """Import pre-marker unanswered resumes during rollout; settled/quarantined boxes never re-enter the pool."""
    from . import capacity
    capacity.schema(con)
    with write(con):
        rows = con.execute("SELECT l.box_id, s.ts FROM leases l JOIN start_requests s ON s.box_id=l.box_id "
                           "WHERE l.repo_key=? AND l.state IN ('running','stopped') AND s.operation='resume' "
                           "AND s.ts>? AND s.outcome IN (?,?,?,?,?,?) "
                           "AND s.id=(SELECT MAX(t.id) FROM start_requests t WHERE t.box_id=l.box_id "
                           "AND t.operation='resume')", (key, now() - 900, *UNANSWERED)).fetchall()
        seconds = capacity.setting('OFFBOX_RESUME_PROVISION_SECONDS', 300, minimum=1, maximum=900)
        for row in rows:
            con.execute("INSERT OR IGNORE INTO kv VALUES (?,?,?)", (f"resume_unanswered:{row['box_id']}", '', row['ts']))
            con.execute("INSERT OR IGNORE INTO kv VALUES (?,?,?)",
                        (f"resume_provision:{row['box_id']}", str(row['ts'] + seconds), row['ts']))


_SCOPE = contextvars.ContextVar("allocation_scope", default=None)
_HELD = contextvars.ContextVar("allocation_held", default=False)


class Unresolved(OffboxError):
    """A previous machine start needs reconciliation before another one can be sent."""


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
    if _HELD.get():
        yield
        return
    key = key_for(box_id)
    name = "allocation-" + hashlib.sha256(key.encode()).hexdigest()[:20]
    try:
        lock = file_lock(name, timeout=0)
        lock.__enter__()
    except OffboxError as e:
        raise Unresolved("another caller is starting a machine for this repository; nothing ran. Retry later") from e
    token = _HELD.set(True)
    try:
        with contextlib.closing(db()) as con:
            unknown = con.execute("SELECT 1 FROM kv WHERE k=?", ("create_unanswered:" + key,)).fetchone()
            pending = con.execute("SELECT l.box_id FROM leases l JOIN kv k "
                                  "ON k.k='resume_unanswered:' || l.box_id "
                                  "WHERE l.repo_key=? AND l.state IN ('running','stopped') "
                                  "AND l.box_id<>? LIMIT 1", (key, box_id or "")).fetchone()
        if (unknown and not recover_create) or (pending and not reconcile):
            raise Unresolved("a previous machine start is unanswered; nothing ran. Reconcile it before retrying")
        yield
    finally:
        _HELD.reset(token)
        lock.__exit__(None, None, None)
