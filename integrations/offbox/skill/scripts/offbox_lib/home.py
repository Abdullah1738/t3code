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

import toollog

from . import common
from .common import EXIT_HOME_DOWN, EXIT_INFRA, OffboxError, log, say

PROBE_TIMEOUT_S = 3.0
FAILOVER_ENV = "OFFBOX_FAILOVER"      # set in the re-executed process: why this run is on Boat ("unreachable: ...")
MAX_FAILURE_LINES = 200
RECENT_FAILURE_S = 180
WAIT_STARTED = None


def active() -> bool:
    """This process sends its work to the home server."""
    return common.backend() == "server"


def base_needs_home(explicit_base: str | None) -> bool:
    from . import base_catalog
    return bool(explicit_base and not any(r['name'] == explicit_base for r in base_catalog.rows('boat')))


def base_down_error(base: str, reason: str) -> OffboxError:
    return OffboxError(f"saved base '{base}' lives on the home offbox server, which is down ({reason}); "
                      "runs that name a base wait for it. Nothing ran and nothing was sent to Boat. "
                      "Retry when home is back, or drop --base to run on the repo template.", code=EXIT_HOME_DOWN)


def failover_decision(decision: str, reason: str, base: str | None = None, run_id: str = '') -> None:
    toollog.emit('home', 'home.failover_decision', ids={'run': run_id},
                 props={'decision': decision, 'base': base, 'reason': reason})


def may_fail_over(explicit_base: str | None = None) -> bool:
    """The home server was picked automatically for ordinary work: Boat may take this run instead."""
    return (active() and common.backend_pinned() is None and common.person() is None
            and not base_needs_home(explicit_base))


def health_url() -> str | None:
    c = common.home_config()
    return c["url"].rstrip("/") + "/health" if c else None


def probe(timeout: float = PROBE_TIMEOUT_S) -> str | None:
    with toollog.span("health", "home.probe", tag="home_probe") as data:
        result = _probe(timeout)
        data["ok"] = result is None
        return result


def _probe(timeout: float = PROBE_TIMEOUT_S) -> str | None:
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


def record_failure(reason: str, run_id: str = "", *, base: str | None = None, base_kept: bool = False) -> None:
    """One line for the health monitor: a run could not reach home before it was accepted."""
    try:
        common.HOME_FAILURES.parent.mkdir(parents=True, exist_ok=True)
        try:
            lines = common.HOME_FAILURES.read_text().splitlines()[-(MAX_FAILURE_LINES - 1):]
        except OSError:
            lines = []
        lines.append(json.dumps({"ts": time.time(), "reason": reason[:300], "run": run_id,
                                 "base": base, "base_kept": base_kept}))
        tmp = common.HOME_FAILURES.with_name(common.HOME_FAILURES.name + f".{os.getpid()}.tmp")
        tmp.write_text("\n".join(lines) + "\n")
        os.replace(tmp, common.HOME_FAILURES)
    except OSError as e:
        log(f"home failure not recorded: {e}")


def recent_failure() -> bool:
    try:
        lines = common.HOME_FAILURES.read_text().splitlines()[-MAX_FAILURE_LINES:]
    except OSError:
        return False
    for line in reversed(lines):
        try:
            item = json.loads(line)
            age = time.time() - float(item["ts"])
            reason = str(item["reason"]).lower()
        except (ValueError, TypeError, KeyError):
            continue
        if 0 <= age <= RECENT_FAILURE_S and any(word in reason for word in (
                "no answer", "unreachable", "timed out", "timeouterror", "deadline passed", "connection refused",
                "authenticated api did not answer")):
            return True
    return False


def before_run(argv: list[str], *, explicit_base: str | None = None) -> None:
    if not may_fail_over(explicit_base):
        return
    from . import api
    recent = recent_failure()
    why = None if recent else probe()
    health_ok = not recent and why is None
    if recent or health_ok or (why or "").startswith("no answer"):
        # /health can stay green while authenticated allocation reads stop answering.
        why = api.probe_backend("server", PROBE_TIMEOUT_S)
        if why and health_ok:
            why = api.probe_backend("server", PROBE_TIMEOUT_S)
    if why:
        fail_over(why, argv, explicit_base=explicit_base)


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
        failover_decision('wait_person', 'home_down')
        raise OffboxError(f"the home offbox server is down ({why}); {who}'s tasks wait until it is back. "
                          "Nothing ran and nothing was sent to Boat", code=EXIT_HOME_DOWN)


def unreachable(e: OffboxError) -> bool:
    """An error that means the server could not be reached (or is not ready), raised before anything started."""
    return bool(getattr(e, "outage", False)) and not e.started and e.code == EXIT_INFRA


def network_failure(error: OffboxError) -> bool:
    from . import api
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if isinstance(error, api.NetworkError):
            return True
        if getattr(error, "status", None) is not None:
            return False
        error = error.__cause__
    return False


def fail_over(reason: str, argv: list[str], run_id: str = "", *, explicit_base: str | None = None) -> bool:
    """Exec onto an answering Boat, or return False to keep waiting on home. Only before command start."""
    from . import api
    from .runs import BACKGROUND_RUN_ENV
    run_id = run_id or os.environ.get(BACKGROUND_RUN_ENV, '')
    failover_decision('boat', 'unreachable', explicit_base, run_id)
    record_failure(reason, run_id, base=explicit_base, base_kept=explicit_base is not None)
    if api.probe_backend("boat", PROBE_TIMEOUT_S):
        say("Boat's API is unavailable too; keeping this run on home")
        return False
    queued = os.environ.get(BACKGROUND_RUN_ENV)
    if queued:
        _forward_background(queued)
    elapsed = max(0, time.monotonic() - WAIT_STARTED)*1000 if WAIT_STARTED is not None else 0
    toollog.emit("backend", "backend.failover", duration_ms=elapsed, ok=True, ids={"run": run_id},
                 props={"from": "home", "to": "boat", "reason": "unreachable", "waitMs": elapsed})
    say(f"home offbox server not reachable ({reason[:160]}); this run goes to Boat instead")
    log(f"failover to boat: {reason[:300]}")
    env = dict(os.environ, OFFBOX_BACKEND="boat")
    env[FAILOVER_ENV] = reason[:200]
    if queued:
        from .runs import forward_background
        forward_background(env)
    sys.stdout.flush()
    sys.stderr.flush()
    os.execve(sys.executable, [sys.executable, os.path.realpath(sys.argv[0]), *argv], env)


def _forward_background(run_id: str) -> None:
    """Publish the same queued ID on Boat before retiring its home row; existing waiters can follow the handoff."""
    source = common.db()
    target = None
    try:
        row = source.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
        if not row or row['status'] != 'starting' or row['box_id'] or row['process_id']:
            raise OffboxError(f'{run_id}: refusing failover after a possible start', started=True)
        target = sqlite3.connect(common.db_path_for('boat'), isolation_level=None)
        common.ensure_schema(target)
        names = list(row.keys())
        with common.write(target):
            target.execute('INSERT INTO runs (' + ','.join(names) + ') VALUES (' + ','.join('?' for _ in names) + ')', tuple(row))
            target.execute("INSERT INTO kv(k,v) VALUES (?, '1')", ('start_claim:' + run_id,))
        source.execute("UPDATE runs SET status='forwarded',error='boat',end_at=? WHERE run_id=? "
                       "AND status='starting' AND box_id IS NULL AND process_id IS NULL", (common.now(), run_id))
    finally:
        source.close()
        if target is not None:
            target.close()


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
