"""Fence replay producers against a runner attempt that has been replaced or acknowledged."""
from contextlib import contextmanager
from functools import wraps
import json
import os
from pathlib import Path
import sqlite3

_depth = 0


@contextmanager
def admission():
    global _depth
    attempt = os.environ.get("WATCH_ATTEMPT")
    if not attempt or _depth:
        yield True
        return
    wdir = Path(os.environ["WATCH_DIR"])
    with sqlite3.connect((wdir.parent.parent / "relay-lock.sqlite").as_uri() + "?mode=rw", uri=True, timeout=15) as lock:
        lock.execute("BEGIN IMMEDIATE")
        try:
            admitted = json.loads((wdir / "state.json").read_text()).get("admitted_run") or {}
        except (OSError, ValueError):
            admitted = {}
        allowed = (admitted.get("run") == os.environ.get("WATCH_RUN")
                   and admitted.get("attempt") == attempt and not admitted.get("accepted"))
        if allowed:
            _depth += 1
        try:
            yield allowed
        finally:
            if allowed:
                _depth -= 1


def admitted_check(fn):
    @wraps(fn)
    def guarded(*args, **kwargs):
        with admission() as allowed:
            if allowed:
                return fn(*args, **kwargs)
    return guarded
