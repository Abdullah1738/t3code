"""Turn-scoped, process-safe storage for the native recall hooks."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
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
            CREATE TABLE IF NOT EXISTS child_generations (
                key_hash TEXT PRIMARY KEY, generation INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS job_generations (
                job TEXT PRIMARY KEY, generation INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mailbox_generations (
                mailbox_rowid INTEGER PRIMARY KEY, generation INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS seed_owners (
                seed_key TEXT PRIMARY KEY, owner_key TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated);
            CREATE INDEX IF NOT EXISTS notes_created ON notes(created);
            CREATE INDEX IF NOT EXISTS jobs_key ON jobs(key);
            CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created);
            CREATE INDEX IF NOT EXISTS mailbox_key ON mailbox(key);
            CREATE INDEX IF NOT EXISTS mailbox_created ON mailbox(created);
            CREATE INDEX IF NOT EXISTS seeds_created ON seeds(created);
            CREATE INDEX IF NOT EXISTS seed_owners_owner ON seed_owners(owner_key);
            CREATE TRIGGER IF NOT EXISTS jobs_generation_delete AFTER DELETE ON jobs BEGIN
                DELETE FROM job_generations WHERE job=OLD.id;
            END;
            CREATE TRIGGER IF NOT EXISTS mailbox_generation_delete AFTER DELETE ON mailbox BEGIN
                DELETE FROM mailbox_generations WHERE mailbox_rowid=OLD.rowid;
            END;
            CREATE TRIGGER IF NOT EXISTS seed_owner_delete AFTER DELETE ON seeds BEGIN
                DELETE FROM seed_owners WHERE seed_key=OLD.key;
            END;
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
        if not self.db.in_transaction:
            with self.transaction():
                self.prune(now)
            return
        cutoff = now - self.ttl
        # Keep an expired session until all of its dependants have been swept;
        # otherwise a fresh job for an expired key could outlive the key itself.
        for table in ("jobs", "mailbox", "notes"):
            self.db.execute(
                f"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} "
                "WHERE created < ? OR key IN (SELECT key FROM sessions WHERE updated < ?) "
                "ORDER BY rowid LIMIT 200)", (cutoff, cutoff))
        self.db.execute(
            "DELETE FROM seeds WHERE rowid IN (SELECT s.rowid FROM seeds s "
            "LEFT JOIN seed_owners o ON o.seed_key=s.key WHERE s.created < ? OR "
            "s.key IN (SELECT key FROM sessions WHERE updated < ?) OR "
            "o.owner_key IN (SELECT key FROM sessions WHERE updated < ?) "
            "ORDER BY s.rowid LIMIT 200)", (cutoff, cutoff, cutoff))
        self.db.execute(
            "DELETE FROM sessions WHERE rowid IN (SELECT s.rowid FROM sessions s WHERE s.updated < ? "
            "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.key=s.key) "
            "AND NOT EXISTS (SELECT 1 FROM mailbox m WHERE m.key=s.key) "
            "AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.key=s.key) "
            "AND NOT EXISTS (SELECT 1 FROM seeds seed WHERE seed.key=s.key) "
            "AND NOT EXISTS (SELECT 1 FROM seed_owners o WHERE o.owner_key=s.key) "
            "ORDER BY s.rowid LIMIT 200)", (cutoff,))

    @staticmethod
    def _key_hash(key: str) -> str:
        return hashlib.sha256(key.encode("utf-8", "surrogatepass")).hexdigest()

    def _current_generation(self, key: str, state: dict) -> int | None:
        generation = state.get("execution_generation", 0)
        if type(generation) is not int or generation < 0:
            return None
        row = self.db.execute("SELECT generation FROM child_generations WHERE key_hash=?",
                              (self._key_hash(key),)).fetchone()
        if (row[0] if row else 0) != generation:
            return None
        return generation

    def get(self, key: str) -> dict | None:
        row = self.db.execute("SELECT state FROM sessions WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, key: str, state: dict, now: float):
        if not self.db.in_transaction:
            with self.transaction():
                self.save(key, state, now)
            return
        if self._current_generation(key, state) is None:
            raise ValueError("stale execution generation")
        self.db.execute("INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET "
                        "state=excluded.state, updated=excluded.updated",
                        (key, json.dumps(state), now))

    def start_child(self, key: str, native: str, turn: str | None, now: float,
                    seed: dict | None = None, seed_key: str | None = None,
                    pending_key: str | None = None) -> dict:
        if not self.db.in_transaction:
            with self.transaction():
                return self.start_child(key, native, turn, now, seed, seed_key, pending_key)
        key_hash = self._key_hash(key)
        self.db.execute("INSERT INTO child_generations VALUES (?, 1) ON CONFLICT(key_hash) "
                        "DO UPDATE SET generation=generation+1", (key_hash,))
        generation = self.db.execute("SELECT generation FROM child_generations WHERE key_hash=?",
                                     (key_hash,)).fetchone()[0]
        self.db.execute("DELETE FROM jobs WHERE key=?", (key,))
        self.db.execute("DELETE FROM mailbox WHERE key=?", (key,))
        self.db.execute("DELETE FROM seeds WHERE key IN "
                        "(SELECT seed_key FROM seed_owners WHERE owner_key=?)", (key,))
        if seed_key:
            # Also drop an older unresolved seed written without an instance.
            try:
                identity = json.loads(seed_key)
            except (TypeError, ValueError):
                identity = None
            if isinstance(identity, list) and len(identity) == 4:
                pending_identity = "pending:" + json.dumps(
                    [identity[0], "", identity[2], identity[3]], separators=(",", ":"))
                self.db.execute("DELETE FROM seeds WHERE key=?", (pending_identity,))
        target_seed = seed_key or key
        self.db.execute("DELETE FROM seeds WHERE key IN (?, ?, ?)", (key, target_seed, pending_key))
        if seed is not None:
            self.seed(target_seed, seed, now, owner_key=key)
        state = new_turn(turn or ("seed:" + uuid.uuid4().hex), "", now, provisional=not bool(turn))
        state["_native_key"] = native
        state["execution_generation"] = generation
        self.save(key, state, now)
        return state

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
        if not self.db.in_transaction:
            with self.transaction():
                self.discard_turn(key, state)
            return
        if self._current_generation(key, state) is None:
            return
        # Jobs contain the same excerpts as the session, and may be waiting for a worker.
        self.db.execute("DELETE FROM jobs WHERE key=?", (key,))
        self.db.execute("DELETE FROM mailbox WHERE key=?", (key,))
        state["activity"] = []
        state["errors"] = []
        state["seen_errors"] = []
        state["inflight"] = state["prompt_inflight"] = None

    def end_turn(self, native_key: str, turn: str | None, now: float):
        if not self.db.in_transaction:
            with self.transaction():
                self.end_turn(native_key, turn, now)
            return
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
                if (not state.get("provisional") or state.get("adoption_blocked") or
                    turn in state.get("retired_turns", []) or self.prompt_guarded(native_key)):
                    continue
                state["ended_turn"] = turn
            self.discard_turn(key, state)
            state["invalidated"] = True
            self.save(key, state, now)

    def invalidate_prompt(self, native_key: str, generation: str, now: float, except_key: str | None = None):
        if not self.db.in_transaction:
            with self.transaction():
                self.invalidate_prompt(native_key, generation, now, except_key)
            return
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

    def seed(self, key: str, task: dict, now: float, owner_key: str | None = None):
        if not self.db.in_transaction:
            with self.transaction():
                self.seed(key, task, now, owner_key)
            return
        self.db.execute("INSERT INTO seeds VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET "
                        "task=excluded.task, created=excluded.created", (key, json.dumps(task), now))
        if owner_key is not None:
            self.db.execute("INSERT INTO seed_owners VALUES (?, ?) ON CONFLICT(seed_key) "
                            "DO UPDATE SET owner_key=excluded.owner_key", (key, owner_key))

    def take_seed(self, key: str) -> dict | None:
        row = self.db.execute("SELECT task FROM seeds WHERE key=?", (key,)).fetchone()
        if row:
            self.db.execute("DELETE FROM seeds WHERE key=?", (key,))
        return json.loads(row[0]) if row else None

    def get_seed(self, key: str) -> dict | None:
        row = self.db.execute("SELECT task FROM seeds WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def drop_seeds_for_native(self, harness: str, session: str | None, agent: str | None, turn: str | None):
        if not session or not agent:
            return
        rows = self.db.execute("SELECT key,task FROM seeds").fetchall()
        for key, payload in rows:
            try:
                identity = json.loads(key.removeprefix("pending:"))
                seed = json.loads(payload)
            except (TypeError, ValueError):
                continue
            if (isinstance(identity, list) and len(identity) == 4 and
                identity[0] == harness and identity[2] == session and identity[3] == agent and
                (not turn or seed.get("turn") == turn)):
                self.db.execute("DELETE FROM seeds WHERE key=?", (key,))

    def adopt_turn(self, key: str, state: dict, turn: str) -> bool:
        if not self.db.in_transaction:
            with self.transaction():
                return self.adopt_turn(key, state, turn)
        if self._current_generation(key, state) is None:
            return False
        if not state.get("provisional") or state.get("adoption_blocked") or turn in state.get("retired_turns", []):
            return False
        old = state["turn"]
        # Workers and queued notes must follow the same logical turn atomically.
        self.db.execute("UPDATE jobs SET turn=? WHERE key=? AND turn=?", (turn, key, old))
        self.db.execute("UPDATE mailbox SET turn=? WHERE key=? AND turn=?", (turn, key, old))
        state["turn"], state["provisional"] = turn, False
        return True

    def remember(self, key: str, state: dict, result: dict, now: float):
        if not self.db.in_transaction:
            with self.transaction():
                return self.remember(key, state, result, now)
        if self._current_generation(key, state) is None:
            return None
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
        if not self.db.in_transaction:
            with self.transaction():
                return self.enqueue(key, state, body, now)
        generation = self._current_generation(key, state)
        if generation is None:
            raise ValueError("stale execution generation")
        job = uuid.uuid4().hex
        inflight = "prompt_inflight" if body.get("mode") == "prompt" else "inflight"
        state[inflight] = job
        self.db.execute("INSERT INTO jobs VALUES (?, ?, ?, ?, ?)",
                        (job, key, state["turn"], json.dumps(body), now))
        self.db.execute("INSERT INTO job_generations VALUES (?, ?)", (job, generation))
        return job

    def job(self, job: str):
        row = self.db.execute("SELECT key, turn, body FROM jobs WHERE id=?", (job,)).fetchone()
        return (row[0], row[1], json.loads(row[2])) if row else None

    def _job_current(self, job: str, row: tuple, state: dict | None) -> bool:
        key, turn, body = row
        if not state or state.get("turn") != turn:
            return False
        generation = self._current_generation(key, state)
        saved = self.db.execute("SELECT generation FROM job_generations WHERE job=?", (job,)).fetchone()
        job_generation = saved[0] if saved else 0
        inflight = "prompt_inflight" if body.get("mode") == "prompt" else "inflight"
        return (generation is not None and generation == job_generation and state.get(inflight) == job and
                not state.get("invalidated") and not self.prompt_guarded(state.get("_native_key")))

    def job_is_current(self, job: str) -> bool:
        if not self.db.in_transaction:
            with self.transaction():
                return self.job_is_current(job)
        row = self.job(job)
        return bool(row and self._job_current(job, row, self.get(row[0])))

    def finish(self, job: str, result: dict | None, now: float, mode: str, max_backoff: int):
        if not self.db.in_transaction:
            with self.transaction():
                return self.finish(job, result, now, mode, max_backoff)
        row = self.job(job)
        if not row:
            return
        key, turn, body = row
        saved = self.db.execute("SELECT generation FROM job_generations WHERE job=?", (job,)).fetchone()
        job_generation = saved[0] if saved else 0
        state = self.get(key)
        current = self._job_current(job, row, state)
        self.db.execute("DELETE FROM jobs WHERE id=?", (job,))
        if not state:
            return
        inflight = "prompt_inflight" if body.get("mode") == "prompt" else "inflight"
        if not current:
            # Clear the old job's marker only when it still belongs to this
            # execution; a late worker must not mutate its replacement.
            if (state.get(inflight) == job and self._current_generation(key, state) == job_generation and
                state.get("turn") == turn):
                state[inflight] = None
                self.save(key, state, now)
            return
        state[inflight] = None
        if result is not None and mode != "off":
            note = self.remember(key, state, result, now)
            if inflight == "inflight":
                state["backoff"] = 1 if note else min(state["backoff"] * 2, max_backoff)
            if note and mode == "on":
                cursor = self.db.execute("INSERT INTO mailbox VALUES (?, ?, ?, ?)", (key, turn, note, now))
                self.db.execute("INSERT INTO mailbox_generations VALUES (?, ?)",
                                (cursor.lastrowid, self._current_generation(key, state)))
        self.save(key, state, now)

    def consume(self, key: str, turn: str, mode: str) -> str | None:
        if not self.db.in_transaction:
            with self.transaction():
                return self.consume(key, turn, mode)
        state = self.get(key)
        generation = self._current_generation(key, state) if state else None
        if generation is None or state.get("invalidated"):
            return None
        if generation and state.get("turn") != turn:
            return None
        # Legacy untagged entries are generation zero. They remain usable for
        # existing top-level sessions, but never for a restarted child.
        self.db.execute("DELETE FROM mailbox WHERE key=? AND (turn<>? OR "
                        "COALESCE((SELECT generation FROM mailbox_generations "
                        "WHERE mailbox_rowid=mailbox.rowid), 0)<>?)", (key, turn, generation))
        rows = self.db.execute("SELECT rowid, note FROM mailbox WHERE key=? AND turn=? ORDER BY rowid",
                               (key, turn)).fetchall()
        if not rows:
            return None
        self.db.execute("DELETE FROM mailbox WHERE rowid=?", (rows[0][0],))
        return rows[0][1] if mode == "on" else None

    def close(self):
        self.db.close()
