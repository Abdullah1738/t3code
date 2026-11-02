"""Turn-scoped, process-safe storage for the native recall hooks."""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path


def new_turn(turn: str, task: str, now: float, previous: str = "", provisional: bool = False,
             retired_turns: list[str] | None = None, adoption_blocked: bool = False) -> dict:
    return {
        "turn": turn, "generation": uuid.uuid4().hex, "task": task[:6000], "previous": previous[-1200:],
        "started": now, "calls": 0, "last_event": None, "last_step": 0,
        "last_check": 0, "checks": 0, "backoff": 1, "seen_tools": [],
        "seen_steps": [], "seen_errors": [], "errors": [], "activity": [],
        "cited": [], "inflight": None, "prompt_checked": False, "prompt_inflight": None,
        "provisional": provisional, "retired_turns": (retired_turns or [])[-1000:],
        "adoption_blocked": adoption_blocked,
    }


class Store:
    def __init__(self, path: str, ttl_days: float = 14):
        directory = Path(path).parent
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Create private from the start, even under a permissive umask.
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        self.path = path
        self.ttl = max(1.0, float(ttl_days)) * 86400
        self.db = sqlite3.connect(path, timeout=3, isolation_level=None)
        self.db.execute("PRAGMA busy_timeout=3000")
        self.db.execute("PRAGMA secure_delete=ON")
        try:
            self.db.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                key TEXT PRIMARY KEY, state TEXT NOT NULL, updated REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notes (
                key TEXT NOT NULL, note TEXT NOT NULL, created REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS notes_key ON notes(key, created);
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, key TEXT NOT NULL, turn TEXT NOT NULL,
                body TEXT NOT NULL, created REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mailbox (
                key TEXT NOT NULL, turn TEXT NOT NULL, note TEXT NOT NULL,
                created REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seeds (
                key TEXT PRIMARY KEY, task TEXT NOT NULL, created REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS prompt_guards (
                native_key TEXT PRIMARY KEY, generation TEXT NOT NULL
            );
            """)
        except BaseException:
            self.db.close()
            raise

    @contextmanager
    def transaction(self):
        # SQLite serializes read/modify/write for all concurrent hook processes.
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def prune(self, now: float):
        cutoff = now - self.ttl
        for table in ("jobs", "mailbox"):
            self.db.execute(f"DELETE FROM {table} WHERE key IN (SELECT key FROM sessions WHERE updated < ?)",
                            (cutoff,))
        for table, column in (("sessions", "updated"), ("notes", "created"),
                              ("jobs", "created"), ("mailbox", "created"), ("seeds", "created")):
            self.db.execute(f"DELETE FROM {table} WHERE {column} < ?", (cutoff,))

    def get(self, key: str) -> dict | None:
        row = self.db.execute("SELECT state FROM sessions WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, key: str, state: dict, now: float):
        self.db.execute("INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET "
                        "state=excluded.state, updated=excluded.updated",
                        (key, json.dumps(state), now))

    def guard_prompt(self, native_key: str, generation: str):
        self.db.execute("INSERT INTO prompt_guards VALUES (?, ?) ON CONFLICT(native_key) "
                        "DO UPDATE SET generation=excluded.generation", (native_key, generation))

    def prompt_guarded(self, native_key: str | None) -> bool:
        return bool(native_key and self.db.execute(
            "SELECT 1 FROM prompt_guards WHERE native_key=?", (native_key,)).fetchone())

    def prompt_is_current(self, native_key: str, generation: str) -> bool:
        return bool(self.db.execute("SELECT 1 FROM prompt_guards WHERE native_key=? AND generation=?",
                                    (native_key, generation)).fetchone())

    def release_prompt(self, native_key: str, generation: str):
        self.db.execute("DELETE FROM prompt_guards WHERE native_key=? AND generation=?", (native_key, generation))

    def discard_turn(self, key: str, state: dict):
        # Jobs contain the same excerpts as the session, and may be waiting for a worker.
        self.db.execute("DELETE FROM jobs WHERE key=?", (key,))
        self.db.execute("DELETE FROM mailbox WHERE key=?", (key,))
        state["activity"] = []
        state["errors"] = []
        state["seen_errors"] = []
        state["inflight"] = state["prompt_inflight"] = None

    def end_turn(self, native_key: str, turn: str | None, now: float):
        rows = self.db.execute("SELECT key, state FROM sessions WHERE json_extract(state, '$._native_key')=?",
                               (native_key,)).fetchall()
        for key, encoded in rows:
            state = json.loads(encoded)
            # A guard is a newer prompt still resolving. An identified old turn
            # can be scrubbed without invalidating that pending prompt, but an
            # anonymous end cannot distinguish old from new.
            if not turn and self.prompt_guarded(native_key):
                continue
            if turn and state.get("turn") != turn:
                continue
            self.discard_turn(key, state)
            state["invalidated"] = True
            self.save(key, state, now)

    def invalidate_prompt(self, native_key: str, generation: str, now: float, except_key: str | None = None):
        # A failed older lookup must not invalidate a newer successful prompt.
        if not self.prompt_is_current(native_key, generation):
            return
        rows = self.db.execute("SELECT key, state FROM sessions WHERE json_extract(state, '$._native_key')=?",
                               (native_key,)).fetchall()
        for key, encoded in rows:
            if key == except_key:
                continue
            state = json.loads(encoded)
            state["invalidated"] = True
            self.discard_turn(key, state)
            self.save(key, state, now)

    def recent(self, key: str, limit: int = 4) -> list[str]:
        rows = self.db.execute("SELECT note FROM notes WHERE key=? ORDER BY rowid DESC LIMIT ?",
                               (key, limit)).fetchall()
        return [row[0] for row in reversed(rows)]

    def parent_recent(self, identity: dict) -> list[str]:
        if not identity.get("parentThreadId"):
            return []
        rows = self.db.execute(
            "SELECT note FROM notes WHERE json_extract(key, '$[0]')=? AND "
            "json_extract(key, '$[1]')=? AND json_extract(key, '$[2]')=? ORDER BY rowid DESC LIMIT 2",
            (identity["driver"], identity["providerInstanceId"], identity["parentThreadId"]),
        ).fetchall()
        return [row[0] for row in reversed(rows)]

    def seed(self, key: str, task: dict, now: float):
        self.db.execute("INSERT INTO seeds VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET "
                        "task=excluded.task, created=excluded.created", (key, json.dumps(task), now))

    def take_seed(self, key: str) -> dict | None:
        row = self.db.execute("SELECT task FROM seeds WHERE key=?", (key,)).fetchone()
        if row:
            self.db.execute("DELETE FROM seeds WHERE key=?", (key,))
        return json.loads(row[0]) if row else None

    def get_seed(self, key: str) -> dict | None:
        row = self.db.execute("SELECT task FROM seeds WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def adopt_turn(self, key: str, state: dict, turn: str) -> bool:
        if not state.get("provisional") or state.get("adoption_blocked") or turn in state.get("retired_turns", []):
            return False
        old = state["turn"]
        # Workers and queued notes must follow the same logical turn atomically.
        self.db.execute("UPDATE jobs SET turn=? WHERE key=? AND turn=?", (turn, key, old))
        self.db.execute("UPDATE mailbox SET turn=? WHERE key=? AND turn=?", (turn, key, old))
        state["turn"], state["provisional"] = turn, False
        return True

    def remember(self, key: str, state: dict, result: dict, now: float):
        note = result.get("note")
        if not isinstance(note, str) or not note.strip():
            return None
        self.db.execute("INSERT INTO notes VALUES (?, ?, ?)", (key, note, now))
        sources = result.get("sources")
        cited = list(state.get("cited", []))
        if isinstance(sources, list):
            for source in sources:
                if isinstance(source, dict) and isinstance(source.get("session_id"), str):
                    if source["session_id"] not in cited:
                        cited.append(source["session_id"])
        state["cited"] = cited[-100:]
        return note

    def enqueue(self, key: str, state: dict, body: dict, now: float) -> str:
        job = uuid.uuid4().hex
        state["inflight"] = job
        self.db.execute("INSERT INTO jobs VALUES (?, ?, ?, ?, ?)",
                        (job, key, state["turn"], json.dumps(body), now))
        return job

    def job(self, job: str):
        row = self.db.execute("SELECT key, turn, body FROM jobs WHERE id=?", (job,)).fetchone()
        return (row[0], row[1], json.loads(row[2])) if row else None

    def finish(self, job: str, result: dict | None, now: float, mode: str, max_backoff: int):
        row = self.job(job)
        if not row:
            return
        key, turn, _ = row
        self.db.execute("DELETE FROM jobs WHERE id=?", (job,))
        state = self.get(key)
        if not state or state["turn"] != turn or state.get("inflight") != job:
            return
        state["inflight"] = None
        if state.get("invalidated") or self.prompt_guarded(state.get("_native_key")):
            self.save(key, state, now)
            return
        if result is not None:
            note = self.remember(key, state, result, now)
            state["backoff"] = 1 if note else min(state["backoff"] * 2, max_backoff)
            if note and mode == "on":
                self.db.execute("INSERT INTO mailbox VALUES (?, ?, ?, ?)", (key, turn, note, now))
        self.save(key, state, now)

    def consume(self, key: str, turn: str, mode: str) -> str | None:
        # A different turn can never inherit an older job's result.
        self.db.execute("DELETE FROM mailbox WHERE key=? AND turn<>?", (key, turn))
        rows = self.db.execute("SELECT rowid, note FROM mailbox WHERE key=? AND turn=? ORDER BY rowid",
                               (key, turn)).fetchall()
        if not rows:
            return None
        self.db.execute("DELETE FROM mailbox WHERE rowid=?", (rows[0][0],))
        return rows[0][1] if mode == "on" else None

    def close(self):
        self.db.close()
