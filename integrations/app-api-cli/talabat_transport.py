"""Process-shared Talabat pacing and short-lived, projected catalog cache.

Only catalog projections and request timing live here; never headers or captures.
SQLite transactions coordinate independent CLI processes, including retries.
"""
import contextlib
import email.utils
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

from native import NativeError


class SharedState:
    def __init__(self, path=None):
        self.path = Path(path or Path.home()/'.cache/app-api-cli/talabat.sqlite3')
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS bucket (name TEXT PRIMARY KEY, tokens REAL, updated REAL, blocked REAL);
                CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, expires REAL);
                CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, expires REAL, value TEXT);
            ''')
        os.chmod(self.path, 0o600)

    def connect(self):
        return sqlite3.connect(self.path, timeout=2, isolation_level=None)

    @staticmethod
    def remaining(deadline):
        left = deadline - time.monotonic()
        if left <= 0:
            raise NativeError('SEARCH_DEADLINE', 'Talabat deadline reached; coverage is partial.')
        return left

    def pause(self, delay, deadline):
        if delay >= self.remaining(deadline):
            raise NativeError('RATE_LIMITED_OR_DEADLINE', 'Shared Talabat pacing/backoff exceeds the remaining search budget.')
        time.sleep(delay)

    @contextlib.contextmanager
    def slot(self, product, deadline):
        # Small bursts, six in-flight requests across ALL processes. Product
        # searches have a separate stricter bucket and also consume the global one.
        ident = os.urandom(16).hex()
        lanes = [('all', 6.0, 2.0)] + ([('products', 2.5, 1.0)] if product else [])
        while True:
            self.remaining(deadline)
            with self.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                now = time.time()
                db.execute('DELETE FROM leases WHERE expires <= ?', (now,))
                waits, values = [], []
                for name, rate, capacity in lanes:
                    row = db.execute('SELECT tokens,updated,blocked FROM bucket WHERE name=?', (name,)).fetchone()
                    tokens, updated, blocked = row or (capacity, now, 0)
                    tokens = min(capacity, tokens + max(0, now-updated)*rate)
                    waits += [max(0, blocked-now), max(0, (1-tokens)/rate)]
                    values.append((name, tokens, now, blocked))
                if db.execute('SELECT COUNT(*) FROM leases').fetchone()[0] >= 6:
                    waits.append(.05)
                wait = max(waits)
                if wait <= 0:
                    for name, tokens, updated, blocked in values:
                        db.execute('INSERT OR REPLACE INTO bucket VALUES (?,?,?,?)', (name,tokens-1,updated,blocked))
                    # Crash/kill-safe lease expires at the caller's network deadline.
                    db.execute('INSERT INTO leases VALUES (?,?)', (ident, now+self.remaining(deadline)+1))
                db.commit()
            if wait <= 0:
                break
            if wait >= self.remaining(deadline):
                raise NativeError('RATE_LIMITED_OR_DEADLINE', 'Shared Talabat backoff exceeds the remaining search budget.')
            self.pause(min(wait, .1), deadline)
        try:
            yield
        finally:
            with self.connect() as db:
                db.execute('DELETE FROM leases WHERE id=?', (ident,))

    def backoff(self, retry_after, attempt=0):
        try:
            delay = float(retry_after)
        except (ValueError, TypeError):
            try:
                delay = email.utils.parsedate_to_datetime(retry_after).timestamp()-time.time()
            except (ValueError, TypeError, OverflowError):
                delay = 2 ** (attempt+1)
        # Honor the upstream value in full, even when the current CLI must return.
        delay = max(0, delay)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT blocked FROM bucket WHERE name="all"').fetchone()
            blocked = max(row[0] if row else 0, time.time()+delay)
            db.execute('INSERT INTO bucket VALUES ("all",0,?,?) ON CONFLICT(name) DO UPDATE SET tokens=0,updated=excluded.updated,blocked=excluded.blocked', (time.time(),blocked))
            db.commit()
        return delay

    def get(self, key):
        with self.connect() as db:
            row = db.execute('SELECT value FROM cache WHERE key=? AND expires>?', (key,time.time())).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, key, value, ttl):
        with self.connect() as db:
            db.execute('DELETE FROM cache WHERE expires<=?', (time.time(),))
            db.execute('INSERT OR REPLACE INTO cache VALUES (?,?,?)', (key,time.time()+ttl,json.dumps(value)))

    def cached(self, key, ttl, fetch, deadline):
        # Per-key flock gives single-flight across threads/processes, released on
        # process death. Network work never holds a database transaction.
        import fcntl
        value = self.get(key)
        if value is not None:
            return value
        lockdir = self.path.parent/'talabat-locks'
        lockdir.mkdir(exist_ok=True, mode=0o700)
        with (lockdir/hashlib.sha256(key.encode()).hexdigest()).open('a') as lock:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    self.pause(.025, deadline)
            try:
                value = self.get(key)
                if value is None:
                    value = fetch()
                    self.put(key, value, ttl)
                return value
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
