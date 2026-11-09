"""Short SQLite writer waits and cooperative capture deadlines."""

import contextlib
import sqlite3
import time


class Exhausted(TimeoutError):
    pass


class Budget:
    def __init__(self, seconds=0, *, clock=None):
        self.clock = clock or time.monotonic
        self.end = self.clock() + seconds if seconds else None

    def left(self):
        return max(0, self.end - self.clock()) if self.end is not None else float("inf")

    def expired(self):
        return self.left() <= 0

    def check(self):
        if self.expired():
            raise Exhausted("capture budget exhausted")

    def install(self, con):
        con.set_progress_handler(lambda: int(self.expired()), 1000)

    @contextlib.contextmanager
    def sql(self, con):
        self.check()
        self.install(con)
        try:
            yield
        except sqlite3.OperationalError as exc:
            if "interrupt" in str(exc).lower() and self.expired():
                raise Exhausted("capture SQL budget exhausted") from exc
            raise
        finally:
            con.set_progress_handler(None, 0)


def setup_writer(con, budget=None):
    con.execute("PRAGMA busy_timeout=100")
    con.execute("PRAGMA wal_autocheckpoint=0")
    # The migrated cold journal must observe REPLACE's implicit deletion too.
    con.execute("PRAGMA recursive_triggers=ON")
    if hasattr(con, "setconfig") and hasattr(sqlite3, "SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE"):
        con.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, True)
    if budget is not None:
        budget.install(con)
    return con


def with_retry(db, fn, tries=20, *, budget=None):
    """Keep existing zero-argument callbacks; never spend minutes waiting for a writer."""
    waiting = Budget(2)
    for i in range(tries):
        if budget is not None:
            budget.check()
        try:
            if db.in_transaction:
                db.commit()
            db.execute("BEGIN IMMEDIATE")
            result = fn()
            if budget is not None:
                budget.check()
            db.commit()
            return result
        except BaseException as exc:
            # An expired SQL progress handler must not interrupt the rollback too.
            db.set_progress_handler(None, 0)
            try:
                if db.in_transaction:
                    db.rollback()
            finally:
                if budget is not None:
                    budget.install(db)
            if budget is not None and budget.expired():
                raise Exhausted("capture budget exhausted") from exc
            if not isinstance(exc, sqlite3.OperationalError) or not any(
                    word in str(exc).lower() for word in ("locked", "busy")):
                raise
            if waiting.expired() or i + 1 >= tries:
                raise
            delay = min(0.1, waiting.left(), budget.left() if budget is not None else 0.1)
            time.sleep(delay)
    raise RuntimeError("database busy after retries")


def checkpoint(con):
    """Never wait for a reader; leave pinned WAL frames for a later tick."""
    if con.in_transaction:
        return None
    con.set_progress_handler(None, 0)
    con.execute("PRAGMA busy_timeout=0")
    try:
        result = con.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
        if result and result[0] == 0 and result[1] == result[2]:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        return result
    except sqlite3.Error:
        return None
    finally:
        con.execute("PRAGMA busy_timeout=100")
