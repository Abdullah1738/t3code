"""Wait out boat.dev API outages before a run starts, and remember since when boat has been down.

Only the pre-start path uses this: nothing has started, so waiting is safe. Runs already going keep reattaching
(runs.follow), and no pool or box lock is held while waiting (the caller has already released them).
"""

from __future__ import annotations

import time
import contextlib

from . import api, capacity
from .common import EXIT_INFRA, OffboxError, db, iso, kv_get, kv_set, log, now, say

WAIT_DEFAULT_S = 600
WAIT_MAX_S = 1800
PROBE_EVERY_S = 15
PROGRESS_EVERY_S = 60
CAPACITY_RETRY_S = 30
KEY = "boat_outage"
SAME_OUTAGE_S = 300   # a "seen" older than this means the outage is over (or nobody has looked since)
_ROUND_DEADLINE: float | None = None


@contextlib.contextmanager
def allocation_budget(seconds: float):
    """Bound the next allocation round without restricting SSH/bring-up after a start was accepted."""
    global _ROUND_DEADLINE
    previous = _ROUND_DEADLINE
    _ROUND_DEADLINE = time.monotonic() + max(0, seconds)
    try:
        yield
    finally:
        _ROUND_DEADLINE = previous


def allocation_left() -> float | None:
    return None if _ROUND_DEADLINE is None else max(0, _ROUND_DEADLINE - time.monotonic())


@contextlib.contextmanager
def accepted_machine():
    global _ROUND_DEADLINE
    previous = _ROUND_DEADLINE
    _ROUND_DEADLINE = None
    try:
        yield
    finally:
        _ROUND_DEADLINE = previous


def window_seconds() -> int:
    return capacity.setting("OFFBOX_OUTAGE_WAIT_SECONDS", WAIT_DEFAULT_S, minimum=0, maximum=WAIT_MAX_S)


def reason_of(e) -> str:
    return f"HTTP {e.status}" if getattr(e, "status", None) else "no answer"


def note_down(reason: str) -> float:
    """Record that boat is down and return since when. Every offbox process shares the record."""
    con = db()
    prev = kv_get(con, KEY) or {}
    seen = prev.get("seen") or 0
    since = prev.get("since") if prev.get("since") and now() - seen < SAME_OUTAGE_S else now()
    kv_set(con, KEY, {"since": since, "seen": now(), "reason": reason})
    return since


def note_up() -> None:
    con = db()
    prev = kv_get(con, KEY)
    if not prev:
        return
    con.execute("DELETE FROM kv WHERE k=?", (KEY,))
    con.commit()
    log(f"boat_outage over: down since {iso(prev.get('since'))} ({prev.get('reason')})")


def current() -> dict | None:
    return kv_get(db(), KEY, max_age=SAME_OUTAGE_S)


def wait_until_up(reason: str, budget_s: float) -> bool:
    """Probe boat until it answers or `budget_s` is spent. True when it is back."""
    since = note_down(reason)
    say(f"boat.dev API is down ({reason} since {iso(since)[-5:]}); nothing has started. Waiting up to "
        f"{int(budget_s)}s for it to come back. Use a tool timeout above {int(budget_s)}s or run this in a "
        "background shell.")
    start = time.monotonic()
    last_say = None
    while True:
        left = budget_s - (time.monotonic() - start)
        if left <= 0:
            return False
        time.sleep(min(PROBE_EVERY_S, left))
        left = budget_s - (time.monotonic() - start)
        if left <= 0:
            return False
        why = api.probe(timeout=min(PROBE_EVERY_S, left))
        if why is None:
            note_up()
            say(f"boat.dev is back after {int(now() - since)}s; retrying")
            return True
        note_down(why)
        left = budget_s - (time.monotonic() - start)
        if last_say is None or time.monotonic() - last_say >= PROGRESS_EVERY_S:
            last_say = time.monotonic()
            say(f"still waiting for boat.dev: down {int(now() - since)}s ({why}), {int(max(0, left))}s left")


def down_error(e, waited_s: float) -> OffboxError:
    reason = reason_of(e)
    since = note_down(reason)
    return OffboxError(f"boat.dev is down ({reason} since {iso(since)[-5:]}, waited {int(waited_s)}s); nothing ran. "
                       f"Retry once it is back (offbox status shows it). Last error: {e}",
                       code=EXIT_INFRA, outage=True)


def wait_for_capacity(start: float, since: float, last_say: float | None, budget_s: float):
    """The API answers during a machine outage, so retry acquisition rather than probing /limits."""
    t = time.monotonic()
    if last_say is None or t - last_say >= PROGRESS_EVERY_S:
        last_say = t
        say(f"boat is out of machine capacity (since {iso(since)[-5:]}, waited {int(t - start)}s); retrying")
    left = budget_s - (time.monotonic() - start)
    if left <= 0:
        return False, last_say
    time.sleep(min(CAPACITY_RETRY_S, left))
    return time.monotonic() - start < budget_s, last_say
