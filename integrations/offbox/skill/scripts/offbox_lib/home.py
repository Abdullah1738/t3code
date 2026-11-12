"""The home offbox server next to Boat: is it usable for this run, and what to do when it is not.

Rules (owner, 12 Nov 2026):
- Home marked up: the run goes home. If the server cannot be reached before the run is accepted (no command
  started there yet), this one run goes to Boat instead and the failure is recorded for the health monitor.
- After the run was accepted there is no failover, ever: it would run twice. The client reconnects (runs.follow).
- Home marked down by the monitor: new runs go straight to Boat. It comes back by itself after three good checks.
- Person-box work (OFFBOX_THREAD=person:<name>) never goes to Boat: it fails fast with EXIT_HOME_DOWN.
With no home server configured none of this code does anything."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

from . import common
from .common import EXIT_HOME_DOWN, EXIT_INFRA, OffboxError, log, say

PROBE_TIMEOUT_S = 3.0
FAILOVER_ENV = "OFFBOX_FAILOVER"      # set in the re-executed process: why this run is on Boat ("unreachable: ...")
MAX_FAILURE_LINES = 200


def active() -> bool:
    """This process sends its work to the home server."""
    return common.backend() == "server"


def may_fail_over() -> bool:
    """The home server was picked automatically for ordinary work: Boat may take this run instead."""
    return active() and common.backend_pinned() is None and common.person() is None


def health_url() -> str | None:
    c = common.home_config()
    return c["url"].rstrip("/") + "/health" if c else None


def probe(timeout: float = PROBE_TIMEOUT_S) -> str | None:
    """One GET /health (no token). None = the server takes runs; else a short reason why not."""
    url = health_url()
    if not url:
        return "no home server configured"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}),
                                    timeout=timeout) as r:
            d = json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return f"health answered HTTP {e.code}"
    except (OSError, ValueError) as e:
        return f"no answer ({type(e).__name__})"
    if not isinstance(d, dict) or not d.get("ok"):
        why = "; ".join(str(x) for x in (d.get("reasons") or [])[:2]) if isinstance(d, dict) else ""
        return f"server says it cannot take runs ({why or 'not ready'})"
    return None


def record_failure(reason: str, run_id: str = "") -> None:
    """One line for the health monitor: a run could not reach home before it was accepted."""
    try:
        common.HOME_FAILURES.parent.mkdir(parents=True, exist_ok=True)
        try:
            lines = common.HOME_FAILURES.read_text().splitlines()[-(MAX_FAILURE_LINES - 1):]
        except OSError:
            lines = []
        lines.append(json.dumps({"ts": time.time(), "reason": reason[:300], "run": run_id}))
        tmp = common.HOME_FAILURES.with_name(common.HOME_FAILURES.name + f".{os.getpid()}.tmp")
        tmp.write_text("\n".join(lines) + "\n")
        os.replace(tmp, common.HOME_FAILURES)
    except OSError as e:
        log(f"home failure not recorded: {e}")


def person_gate() -> None:
    """Person-box work with a home server configured: stop at once when home is down. Never Boat."""
    who = common.person()
    if not who or common.home_config() is None or common.backend_pinned() is not None:
        return
    st = common.home_state()
    why = None
    if st.get("state") == "home_down":
        why = st.get("reason") or "marked down by the health monitor"
    else:
        why = probe()
    if why:
        raise OffboxError(f"the home offbox server is down ({why}); {who}'s tasks wait until it is back. "
                          "Nothing ran and nothing was sent to Boat", code=EXIT_HOME_DOWN)


def unreachable(e: OffboxError) -> bool:
    """An error that means the server could not be reached (or is not ready), raised before anything started."""
    return bool(getattr(e, "outage", False)) and not e.started and e.code == EXIT_INFRA


def fail_over(reason: str, argv: list[str], run_id: str = "") -> None:
    """Send this one run to Boat: record why, say so once, and start over as a Boat process. Does not return.
    Only called while nothing has started on the home server."""
    record_failure(reason, run_id)
    say(f"home offbox server not reachable ({reason[:160]}); this run goes to Boat instead")
    log(f"failover to boat: {reason[:300]}")
    env = dict(os.environ, OFFBOX_BACKEND="boat")
    env[FAILOVER_ENV] = reason[:200]
    sys.stdout.flush()
    sys.stderr.flush()
    os.execve(sys.executable, [sys.executable, os.path.realpath(sys.argv[0]), *argv], env)


def only_on_home(table: str, where: str, args: tuple) -> bool:
    """True when this run is on Boat as the standby and the saved base or template it would use exists only in
    the home server's records. Read-only; never True on a Boat-only install."""
    if table not in ("bases", "templates") or not on_standby():
        return False
    path = common.db_path_for("server")
    if not path.exists():
        return False
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        try:
            return con.execute(f"SELECT 1 FROM {table} WHERE {where}", args).fetchone() is not None
        finally:
            con.close()
    except sqlite3.Error:
        return False


def on_standby() -> bool:
    """On Boat because home is configured but down or unreachable (as opposed to a Boat-only install)."""
    return bool(os.environ.get(FAILOVER_ENV)) or common.standby()
