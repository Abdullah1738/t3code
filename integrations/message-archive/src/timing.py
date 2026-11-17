"""Per-pass timings, shared with fetch workers without recording message contents."""
import contextlib
import contextvars
import functools
import sqlite3
import threading
import time

import common

CURRENT = contextvars.ContextVar("sync_timing", default=None)


class Pass:
    def __init__(self, source):
        self.source = source
        self.started = time.monotonic()
        self.last_activity = self.started
        self.lock = threading.Lock()
        self.phases = {}
        self.thread_phases = {}
        self.rows = 0
        self.lock_hold_secs = 0.0
        self.slowest = {"sql": None, "ms": 0.0, "rows": 0}

    @contextlib.contextmanager
    def phase(self, name):
        # Count the union of intervals: parallel fetches and nested helpers are wall time,
        # not a sum of worker time that can exceed the entire pass.
        with self.lock:
            p = self.phases.setdefault(name, [0, 0.0, 0.0])
            if p[0] == 0:
                p[1] = time.monotonic()
            p[0] += 1
            thread = threading.get_ident()
            self.thread_phases.setdefault(thread, []).append(name)
        try:
            yield
        finally:
            with self.lock:
                stack = self.thread_phases[thread]
                stack.pop()
                if not stack:
                    del self.thread_phases[thread]
                p[0] -= 1
                if p[0] == 0:
                    p[2] += time.monotonic() - p[1]

    def thread_phase(self, thread):
        with self.lock:
            stack = self.thread_phases.get(thread, ())
            return stack[-1] if stack else None

    def active_phase(self):
        # Called by the daemon watchdog; phase sections never perform I/O under this mutex.
        with self.lock:
            return next((name for name in ("parse", "fetch", "db_read", "db_write", "lock_wait")
                         if self.phases.get(name, [0])[0]), "sync")

    def held(self, seconds):
        with self.lock:
            self.lock_hold_secs = max(self.lock_hold_secs, seconds)

    def statement(self, sql, seconds, rows, returned):
        with self.lock:
            self.rows += returned
            if seconds * 1000 >= self.slowest["ms"]:
                self.slowest = {"sql": " ".join(sql.split()), "ms": seconds * 1000, "rows": rows}

    def summary(self):
        with self.lock:
            slow = dict(self.slowest, ms=round(self.slowest["ms"], 3))
            return {"secs": round(time.monotonic() - self.started, 3),
                    **{name + "_secs": round(self.phases.get(name, [0, 0, 0])[2], 3)
                       for name in ("lock_wait", "fetch", "parse", "db_read", "db_write")},
                    "lock_hold_secs": round(self.lock_hold_secs, 3),
                    "rows_read": self.rows, "slow_sql": slow}


@contextlib.contextmanager
def phase(name):
    metrics = CURRENT.get()
    if metrics is None:
        yield
    else:
        with metrics.phase(name):
            yield


def log(message):
    common.log(message)
    metrics = CURRENT.get()
    if metrics:
        metrics.last_activity = time.monotonic()


def timed(name):
    def decorate(fn):
        @functools.wraps(fn)
        def run(*args, **kwargs):
            with phase(name):
                return fn(*args, **kwargs)
        return run
    return decorate


def worker(fn):
    """Capture this pass before submitting a callable to a thread pool."""
    metrics = CURRENT.get()

    @functools.wraps(fn)
    def run(*args, **kwargs):
        token = CURRENT.set(metrics)
        try:
            return fn(*args, **kwargs)
        finally:
            CURRENT.reset(token)
    return run


@contextlib.contextmanager
def write_lock(lock, timeout=None):
    start = time.monotonic()
    with phase("lock_wait"):
        lock.acquire() if timeout is None else lock.acquire(timeout=timeout)
    acquired = time.monotonic()
    waited = acquired - start
    try:
        if waited > 60:
            metrics = CURRENT.get()
            common.log(f"{metrics.source if metrics else 'archive'}: lock wait {waited:.1f}s")
        with phase("db_write"):
            yield
    finally:
        metrics = CURRENT.get()
        if metrics:
            metrics.held(time.monotonic() - acquired)
        lock.release()


class Cursor(sqlite3.Cursor):
    def execute(self, sql, parameters=()):
        self.sql = sql
        self.seconds = 0.0
        self.rows = 0
        return self._call(super().execute, sql, parameters)

    def _call(self, fn, *args, count=None):
        metrics = CURRENT.get()
        if metrics is None:
            return fn(*args)
        started = time.monotonic()
        rows = 0
        try:
            name = self.connection.phase
            if name is None:
                name = "db_read" if self.sql.lstrip().upper().startswith(("SELECT", "EXPLAIN", "PRAGMA")) else "db_write"
            with phase(name):
                result = fn(*args)
            if count:
                rows = count(result)
            return result
        finally:
            self.seconds += time.monotonic() - started
            self.rows += rows
            # Only newly returned rows count toward the pass total. The slowest statement
            # includes execute AND fetch/iteration time, excluding time spent by its caller.
            metrics.statement(self.sql, self.seconds, self.rows, rows)

    def fetchone(self):
        return self._call(super().fetchone, count=lambda row: int(row is not None))

    def fetchmany(self, size=None):
        args = () if size is None else (size,)
        return self._call(super().fetchmany, *args, count=len)

    def fetchall(self):
        return self._call(super().fetchall, count=len)

    def __next__(self):
        return self._call(super().__next__, count=lambda row: 1)


class Connection(sqlite3.Connection):
    phase = None

    def cursor(self, factory=Cursor):
        return super().cursor(factory)

    def execute(self, sql, parameters=()):
        return self.cursor().execute(sql, parameters)


class SourceConnection(Connection):
    phase = "fetch"
