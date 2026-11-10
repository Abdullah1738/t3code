"""Shared start-rate accounting. Reservations include uncertain sends, not just successes."""

from __future__ import annotations

import email.utils
import json
import os
import re
import sqlite3

from .common import IDLE_STOP_S, OffboxError, db, event, iso, now

WINDOWS = ((60, "MINUTE", 25), (3600, "HOUR", 180), (86400, "DAY", 760))


class CapacityError(OffboxError):
    """No remote capacity yet; the command has not started."""


def setting(name: str, default: int, minimum: int = 1, maximum: int = 86400) -> int:
    try:
        return max(minimum, min(maximum, int(os.environ.get(name, default))))
    except ValueError:
        return default


def schema(con, *, import_legacy=True):
    # Compatibility for callers with their own connection (including older test fixtures).
    from .common import ensure_schema
    ensure_schema(con)
    if not import_legacy:
        return
    # Older clients may still emit a legacy start event. Read first and only take the writer
    # when there is new history to import, rather than scanning/reinserting a whole day on every call.
    from .common import write
    marker = con.execute("SELECT v FROM kv WHERE k='legacy_start_rowid'").fetchone()
    after = int(marker[0]) if marker else 0
    rows = con.execute("SELECT rowid,ts,kind,box_id FROM events WHERE rowid>? AND ts>? "
                       "AND kind IN ('lease_new','lease_resume','base_save','template_build_start')",
                       (after, now()-86400)).fetchall()
    if not rows:
        return
    with write(con):
        for rowid, ts, kind, box in rows:
            con.execute("INSERT OR IGNORE INTO start_requests(ts,operation,box_id,outcome,legacy_event) "
                        "SELECT ?,?,?,'legacy',? WHERE NOT EXISTS (SELECT 1 FROM start_requests "
                        "WHERE legacy_event IS NULL AND box_id=? AND ts BETWEEN ? AND ?)",
                        (ts, kind, box, rowid, box, ts-1800, ts+1))
        con.execute("INSERT INTO kv VALUES ('legacy_start_rowid',?,?) ON CONFLICT(k) DO UPDATE "
                    "SET v=CAST(MAX(CAST(v AS INTEGER),CAST(excluded.v AS INTEGER)) AS TEXT),ts=excluded.ts",
                    (str(rows[-1][0]), now()))


def snapshot(con=None) -> dict:
    if con is None:
        con = db()
        try:
            return snapshot(con)
        finally:
            con.close()
    schema(con, import_legacy=False)
    t = now()
    counts = []
    retry = t
    for seconds, name, default in WINDOWS:
        cap = setting("OFFBOX_STARTS_PER_" + name, default, maximum=default)
        n = con.execute("SELECT COUNT(*) FROM start_requests WHERE ts>?", (t-seconds,)).fetchone()[0]
        counts.append({"window": seconds, "used": n, "cap": cap})
        if n >= cap:
            row = con.execute("SELECT ts FROM start_requests WHERE ts>? ORDER BY ts LIMIT 1 OFFSET ?",
                              (t-seconds, n-cap)).fetchone()
            retry = max(retry, row[0]+seconds)
    row = con.execute("SELECT v FROM kv WHERE k='boat_start_cooldown'").fetchone()
    cooldown = json.loads(row[0]) if row else {}
    retry = max(retry, cooldown.get("until", 0))
    return {"counts": counts, "retry_at": retry, "blocked": retry > t, "cooldown": cooldown}


def check(con=None) -> None:
    s = snapshot(con)
    if s["blocked"]:
        counts = ", ".join(f"{w['used']}/{w['cap']} in {w['window']}s" for w in s["counts"])
        raise CapacityError(f"boat start limit reached; next local start allowance {iso(s['retry_at'])} "
                            f"({counts}). Waiting runs can still use an already-running box.")


def reserve(operation: str, box_id: str | None) -> int:
    con = db()
    schema(con)
    # Serialize count + reservation across every concurrent CLI process.
    con.execute("BEGIN IMMEDIATE")
    try:
        # Use the same windows without schema setup inside this transaction.
        t = now()
        row = con.execute("SELECT v FROM kv WHERE k='boat_start_cooldown'").fetchone()
        if row and json.loads(row[0]).get("until", 0) > t:
            raise CapacityError("boat start limit reached; shared 429 cooldown is active")
        for seconds, name, default in WINDOWS:
            cap = setting("OFFBOX_STARTS_PER_" + name, default, maximum=default)
            n = con.execute("SELECT COUNT(*) FROM start_requests WHERE ts>?", (t-seconds,)).fetchone()[0]
            if n >= cap:
                raise CapacityError(f"boat start limit reached; local {name.lower()} budget {n}/{cap}")
        cur = con.execute("INSERT INTO start_requests(ts,operation,box_id) VALUES (?,?,?)", (t, operation, box_id))
        con.commit()
        return cur.lastrowid
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def complete(request_id: int, outcome: str, box_id: str | None = None) -> None:
    con = db()
    con.execute("UPDATE start_requests SET outcome=?,box_id=COALESCE(?,box_id) WHERE id=?",
                (outcome, box_id, request_id))
    con.commit()
    con.close()


def retry_seconds(headers, payload: dict) -> float:
    values = []
    ra = (headers or {}).get("Retry-After")
    if ra:
        try:
            values.append(float(ra))
        except ValueError:
            try:
                values.append(email.utils.parsedate_to_datetime(ra).timestamp()-now())
            except (ValueError, TypeError):
                pass
    err = payload.get("error") or {}
    if not isinstance(err, dict):
        err = {}
    for obj in (payload, err, payload.get("details") or {}, err.get("details") or {}):
        if not isinstance(obj, dict):
            continue
        for key in ("retryAfterSeconds", "retryAfter", "retry_after"):
            try:
                values.append(float(obj[key]))
            except (KeyError, ValueError, TypeError):
                pass
        for key in ("resetAt", "retryAt"):
            if obj.get(key):
                from .common import iso_ts
                ts = iso_ts(str(obj[key]))
                if ts:
                    values.append(ts-now())
    text = str(payload).lower()
    m = re.search(r"retry (?:after|in)\s+(\d+)\s*(?:s|seconds)", text)
    if m:
        values.append(float(m[1]))
    default = 3600 if "day" in text or "hour" in text else 60
    return min(86400, max([1] + values)) if values else default


def cooldown(headers, payload: dict) -> CapacityError:
    con = db()
    schema(con)
    t = now()
    until = t + retry_seconds(headers, payload)
    con.execute("BEGIN IMMEDIATE")
    try:
        row = con.execute("SELECT v FROM kv WHERE k='boat_start_cooldown'").fetchone()
        if row:
            until = max(until, json.loads(row[0]).get("until", 0))
        con.execute("INSERT OR REPLACE INTO kv VALUES ('boat_start_cooldown',?,?)",
                    (json.dumps({"until": until}), t))
        last = con.execute("SELECT ts FROM kv WHERE k='boat_start_alert'").fetchone()
        notify = last is None or t-last[0] >= 6*3600
        if notify:
            # Claim before sending, including failed sends: at most one attempt per six hours.
            con.execute("INSERT OR REPLACE INTO kv VALUES ('boat_start_alert','true',?)", (t,))
        con.commit()
    finally:
        con.close()
    msg = f"boat start limit reached (429); shared cooldown until {iso(until)}. Heavy commands stay remote."
    if notify:
        from .identity import telegram
        telegram(msg, f"offbox-start-limit-{int(t)}", severity="attention")
    return CapacityError(msg)


# Idle box stop per size (seconds). Big boxes cost the most per idle minute; a resume is ~6-10 s.
IDLE_BY_SIZE = {"xlarge": 5 * 60, "large": 10 * 60, "default": 10 * 60, "small": 10 * 60}


def starts_plentiful(snap: dict | None = None) -> bool:
    """True while hour and day start budgets are both under half used and no cooldown is active."""
    s = snap or snapshot()
    return not s["blocked"] and all(w["used"] < w["cap"] / 2 for w in s["counts"][1:])


def idle_seconds(size: str | None = None, snap: dict | None = None, docker: bool = False) -> int:
    """How long an idle box stays up. Short while starts are plentiful; longer as the start budget tightens.

    Boxes that ran Docker recently keep the old 20 min: their stop archives images and the next boot reloads them."""
    s = snap or snapshot()
    day = s["counts"][-1]
    if s["blocked"] or day["used"] >= day["cap"] * 0.75:
        return 3600
    if docker or not starts_plentiful(s):
        return IDLE_STOP_S
    return IDLE_BY_SIZE.get(size or "", IDLE_BY_SIZE["large"])


# Per-size boat supply outage ("supply for size X is over, try later"). Temporary: boat restored xlarge within the
# hour on 31 Oct, so this is a cooldown, not a lease or box mark.
SUPPLY_KV = "boat_supply_out"


def supply_cooldown_s() -> int:
    return setting("OFFBOX_SUPPLY_COOLDOWN_SECONDS", 600, minimum=60, maximum=3600)


def _supply_map(con) -> dict:
    row = con.execute("SELECT v FROM kv WHERE k=?", (SUPPLY_KV,)).fetchone()
    try:
        return json.loads(row[0]) if row else {}
    except ValueError:
        return {}


def supply_out(size: str, box_id: str | None, msg: str) -> None:
    con = db()
    try:
        t = now()
        con.execute("BEGIN IMMEDIATE")
        m = {k: v for k, v in _supply_map(con).items() if (v.get("until") or 0) > t}
        old = m.get(size) or {}
        # The first outage's "since" survives repeated refusals while the cooldown is still running.
        m[size] = {"until": t + supply_cooldown_s(), "since": old.get("since") or t, "box": box_id, "msg": msg[:300]}
        con.execute("INSERT OR REPLACE INTO kv VALUES (?,?,?)", (SUPPLY_KV, json.dumps(m), t))
        con.commit()
        event(con, box_id, "supply_out", f"{size}: {msg[:200]}")
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


def supply_status() -> dict:
    """Active per-size outages: {size: {"until", "since", "box", "msg"}}."""
    con = db()
    try:
        t = now()
        return {k: v for k, v in _supply_map(con).items() if (v.get("until") or 0) > t}
    finally:
        con.close()


def supply_until(size: str | None) -> float | None:
    if not size:
        return None
    return (supply_status().get(size) or {}).get("until")
