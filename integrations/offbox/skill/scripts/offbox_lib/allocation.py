"""Serialize machine-start sends, not pool selection or bring-up, and retain unanswered starts."""
from __future__ import annotations

import contextlib
import contextvars
import hashlib

from .common import OffboxError, db, file_lock

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
def guard(box_id=None, recover_create=False):
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
                                  "WHERE l.repo_key=? AND l.box_id<>? LIMIT 1", (key, box_id or "")).fetchone()
        if (unknown and not recover_create) or pending:
            raise Unresolved("a previous machine start is unanswered; nothing ran. Reconcile it before retrying")
        yield
    finally:
        _HELD.reset(token)
        lock.__exit__(None, None, None)
