"""One owner-approved snapshot. Logs metadata only, never database contents."""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote, urlsplit, urlunsplit
import urllib.request
import urllib.error

import statev2_guard


class Refused(Exception):
    pass


def read_card(card, board=None):
    from engine import _control

    base, token = _control()
    if not token:
        raise Refused("control credential unavailable")
    parts = urlsplit(base)
    # Missions has its own read-scoped HTTP router beside /control.
    ref = f"{board}:{card.lstrip('#')}" if board and not card.startswith("card-") else card
    url = urlunsplit((parts.scheme, parts.netloc, "/api/ardud/kanban/cards/" + quote(ref, safe=""), "", ""))
    request = urllib.request.Request(url, headers={"Accept": "application/json", "Authorization": "Bearer " + token})
    # Do not forward the component credential to a redirected endpoint.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=5) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        error.close()
        raise
    if not isinstance(value, dict) or not isinstance(value.get("card"), dict):
        raise Refused("control card response invalid")
    return value["card"]


def approval(card, ask_id, now):
    asks = card.get("asks")
    ask = next((a for a in asks if isinstance(a, dict) and a.get("id") == ask_id), None) if isinstance(asks, list) else None
    if ask is None:
        raise Refused("ask not found")
    answer = ask.get("answer")
    if not isinstance(answer, dict) or not isinstance(answer.get("by"), dict) or answer["by"].get("_tag") != "owner":
        raise Refused("answer is not from owner")
    approved = answer.get("verdict") == "approve"
    if answer.get("verdict") == "picked":
        selected = answer.get("optionIds", [])
        options = ask.get("options")
        options = options if isinstance(options, list) else []
        approved = (isinstance(selected, list) and len(selected) == 1 and isinstance(selected[0], str) and
                    (re.search("approve", selected[0], re.I) is not None or
                     any(isinstance(o, dict) and o.get("id") == selected[0] and
                         isinstance(o.get("label"), str) and re.search("approve", o["label"], re.I)
                         for o in options)))
    if not approved:
        raise Refused("answer does not approve")
    try:
        at = datetime.fromisoformat(answer["at"].replace("Z", "+00:00"))
        if at.tzinfo is None or not timedelta(0) <= now - at < timedelta(hours=24):
            raise ValueError
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        raise Refused("owner approval is not within 24 hours") from None
    text = " ".join(ask.get(key, "") for key in ("text", "title") if isinstance(ask.get(key), str))
    if not re.search(r"\b(copy|clone|snapshot|vacuum)\b", text, re.I):
        raise Refused("ask does not mention a database copy")


def claim(state, card, ask, db):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    state.chmod(0o700)
    path = state / "live-db-snapshots.jsonl"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "r+", encoding="utf-8") as log:
        fcntl.flock(log, fcntl.LOCK_EX)
        key = {"card": card, "ask": ask, "db": str(db)}
        try:
            if any(all(json.loads(line).get(k) == v for k, v in key.items()) for line in log):
                raise Refused("approval already used for this database")
        except (ValueError, AttributeError):
            raise Refused("snapshot use log invalid") from None
        # Consume before touching the source. A crash or failed copy must never
        # produce a second live read under the same owner answer.
        log.write(json.dumps({**key, "at": datetime.now(timezone.utc).isoformat()}) + "\n")
        log.flush()
        os.fsync(log.fileno())


def copy_database(source, destination):
    try:
        connection = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        # APFS clone is only a fallback for failure to open, never for backup
        # failure after the source has been opened.
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(source) + suffix)
            if not suffix or path.exists():
                subprocess.run(["/bin/cp", "-c", str(path), str(destination) + suffix],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "apfs-clone"
    try:
        with closing(sqlite3.connect(destination)) as target:
            connection.backup(target)
    finally:
        connection.close()
    return "sqlite-backup"


def audit(state, row):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(state / "decisions.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as log:
        log.write(json.dumps({"ts": datetime.now(timezone.utc).isoformat(), "event": "live-db-snapshot", **row}) + "\n")


def snapshot(args):
    started = time.monotonic()
    state = Path.home() / ".local/state/harness-hooks"
    row = {"card": args.card, "ask": args.ask, "db": args.db, "check": "refused", "bytes": 0}
    try:
        if not Path(args.db).is_absolute():
            raise Refused("database path must be absolute")
        db = Path(args.db).resolve()
        row["db"] = str(db)
        if db not in statev2_guard.protected_databases():
            raise Refused("database is not protected")
        try:
            card = read_card(args.card, args.board)
        except Exception:
            raise Refused("control API unavailable or card unreadable") from None
        if not isinstance(card.get("id"), str) or not card["id"]:
            raise Refused("control card identity invalid")
        approval(card, args.ask, datetime.now(timezone.utc))
        row["card"] = card["id"]
        claim(state, card["id"], args.ask, db)
        parent = Path(args.out_parent or os.environ.get("TMPDIR") or tempfile.gettempdir()).resolve()
        if args.out_parent:
            parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if parent.stat().st_mode & 0o777 != 0o700:
                raise Refused("output parent must be private (mode 0700)")
        directory = Path(tempfile.mkdtemp(prefix="live-db-snapshot-", dir=parent))
        directory.chmod(0o700)
        destination = directory / db.name
        row["method"] = copy_database(db, destination)
        row["bytes"] = sum(p.stat().st_size for p in directory.iterdir())
        row["check"] = "allowed"
        return {"path": str(destination), "bytes": row["bytes"], "method": row["method"]}
    except Refused as error:
        row["check"] = str(error)
        raise
    except Exception:
        row["check"] = "snapshot failed"
        raise Refused("snapshot failed") from None
    finally:
        row["ms"] = round((time.monotonic() - started) * 1000, 3)
        audit(state, row)


def main(argv=None):
    parser = argparse.ArgumentParser()
    for name in ("card", "ask", "db"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--board")
    parser.add_argument("--out-parent")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(snapshot(args)))
        return 0
    except (Refused, OSError) as error:
        print(str(error) if isinstance(error, Refused) else "snapshot audit unavailable", file=sys.stderr)
        return 1
