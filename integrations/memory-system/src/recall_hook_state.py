"""Small, private session latches for short-lived native recall adapters."""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from recall_note import bounded_note


class Store:
    def __init__(self, path: str, ttl_days: float = 14):
        directory = Path(path).parent
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.fchmod(fd, 0o600)
        os.close(fd)
        self.db = sqlite3.connect(path, timeout=0.1, isolation_level=None)
        self.db.execute("PRAGMA busy_timeout=100")
        # Keep legacy tables untouched; old detached workers cannot write this schema.
        self.db.execute("CREATE TABLE IF NOT EXISTS check_sessions (key TEXT PRIMARY KEY, state TEXT NOT NULL)")

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def get(self, key: str) -> dict:
        row = self.db.execute("SELECT state FROM check_sessions WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else {
            "first": False, "fresh": False, "task": "", "generation": 0,
            "compact": 0, "compact_checked": 0, "compact_pending": False,
            "notes": [], "note_generation": None,
        }

    def save(self, key: str, state: dict):
        self.db.execute("INSERT INTO check_sessions VALUES (?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state",
                        (key, json.dumps(state)))

    def claim_first(self, key: str, task: str, eligible: bool) -> int | None:
        with self.transaction():
            state = self.get(key)
            state["generation"] += 1
            state["task"] = task[:3000]
            # Keep an allowed pre-tool note until a context-capable event consumes it.
            state["note_generation"] = state["generation"] if state.get("notes") else None
            claimed = not state["first"]
            state["first"] = True
            self.save(key, state)
            return state["generation"] if claimed and eligible else None

    def compact_start(self, key: str):
        with self.transaction():
            state = self.get(key)
            if not state["compact_pending"] or state["compact_checked"] == state["compact"]:
                state["compact"] += 1
            state["compact_pending"] = True
            state["first"] = True
            state["notes"], state["note_generation"] = [], None
            self.save(key, state)

    def claim_compact(self, key: str, completed: bool = False) -> tuple[int, int, str] | None:
        with self.transaction():
            state = self.get(key)
            if completed and not state["compact_pending"]:
                state["compact"] += 1
                state["compact_pending"] = True
            if not state["compact_pending"] or state["compact_checked"] == state["compact"]:
                return None
            state["compact_checked"] = state["compact"]
            # Keep pending until another PreCompact starts a new generation.
            self.save(key, state)
            return state["compact"], state["generation"], state["task"]

    def remember(self, key: str, generation: int, note: str):
        note = bounded_note(note)
        if not note:
            return
        with self.transaction():
            state = self.get(key)
            if state["generation"] != generation:
                return
            notes = state.get("notes", []) if state["note_generation"] == generation else []
            if note not in notes:
                combined = bounded_note("\n\n".join(notes + [note]))
                # Prefer the current action if older context fills the budget.
                notes = notes + [note] if combined else [note]
            state["notes"], state["note_generation"] = notes, generation
            self.save(key, state)

    def consume(self, key: str) -> str | None:
        with self.transaction():
            state = self.get(key)
            note = "\n\n".join(state.get("notes", [])) if state["note_generation"] == state["generation"] else None
            state["notes"], state["note_generation"] = [], None
            self.save(key, state)
            return bounded_note(note)

    def close(self):
        self.db.close()
