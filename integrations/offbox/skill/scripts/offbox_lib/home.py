"""The home offbox server next to Boat: is it usable for this run, and what to do when it is not.

Rules (owner, 12 Nov 2026):
- Home marked up: the run goes home. If the server cannot be reached before the run is accepted (no command
  started there yet), this one run goes to Boat instead and the failure is recorded for the health monitor.
- An answering server that is starting is waited for up to 600 s, keeping its box and queue place.
- After the run was accepted there is no failover, ever: it would run twice. The client reconnects (runs.follow).
- Home marked down by the monitor: new runs probe live before routing. Alert recovery still needs three good checks.
- Person-box work (OFFBOX_THREAD=person:<name>) never goes to Boat: it fails fast with EXIT_HOME_DOWN.
With no home server configured none of this code does anything."""

from __future__ import annotations

import contextlib
import contextvars
import fcntl
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

from .health_reachability import tcp_connects, timed_out, slow_probe_seconds, slow_down_seconds

import toollog

from . import common
from .common import EXIT_HOME_DOWN, EXIT_INFRA, OffboxError, log, say

from .startup_health import START_WAIT_S, starting_phase, wait_seconds

PROBE_TIMEOUT_S = 3.0
HOME_START_WAIT_S = START_WAIT_S
PRE_START = contextvars.ContextVar("home_pre_start", default=None)
WAIT_BUDGET = contextvars.ContextVar("home_wait_budget", default=None)
FAILOVER_ENV = "OFFBOX_FAILOVER"      # set in the re-executed process: why this run is on Boat ("unreachable: ...")
RETURNED_HOME_ENV = "OFFBOX_RETURNED_HOME"
ROUTING_ENV = "OFFBOX_ROUTING_LINES"
FAILBACK_PROBE_S = 30
MAX_FAILURE_LINES = 200
RECENT_FAILURE_S = 180
RUN_ID_ENV = "OFFBOX_PREFLIGHT_RUN"
INVOCATION_RUN = contextvars.ContextVar("home_invocation_run", default="")
QUEUE_WAIT = contextvars.ContextVar("home_queue_wait", default=0.0)
BOAT_SELECTED = contextvars.ContextVar("home_boat_selected", default=False)
WAIT_STARTED = None
PROBE_FACTS = contextvars.ContextVar("home_probe_facts", default=None)


@contextlib.contextmanager
def run_identity():
    token = INVOCATION_RUN.set(os.environ.get("OFFBOX_BACKGROUND_RUN") or os.environ.get(RUN_ID_ENV)
                               or (common.new_id("run") if may_fail_over() else ""))
    queue_token = QUEUE_WAIT.set(0.0)
    selected_token = BOAT_SELECTED.set(False)
    try:
        yield
    finally:
        BOAT_SELECTED.reset(selected_token)
        QUEUE_WAIT.reset(queue_token)
        INVOCATION_RUN.reset(token)


def invocation_run():
    return os.environ.get("OFFBOX_BACKGROUND_RUN") or INVOCATION_RUN.get() or os.environ.get(RUN_ID_ENV, "")


def take_invocation_run():
    background = os.environ.get("OFFBOX_BACKGROUND_RUN")
    if background:
        return background
    candidate = INVOCATION_RUN.get() or os.environ.get(RUN_ID_ENV, "")
    INVOCATION_RUN.set("")
    os.environ.pop(RUN_ID_ENV, None)
    return candidate


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
            and not os.environ.get(RETURNED_HOME_ENV) and not base_needs_home(explicit_base))


def health_url() -> str | None:
    c = common.home_config()
    return c["url"].rstrip("/") + "/health" if c else None


def probe(timeout: float = PROBE_TIMEOUT_S, *, wait: bool = True) -> str | None:
    with toollog.span("health", "home.probe", tag="home_probe") as data:
        with wait_budget():
            result = _probe(timeout) if wait else _probe(min(5, timeout), wait=False)
        data["ok"] = result is None
        return result


class StartWaitFailed(OffboxError):
    """The server explicitly refused the request before executing it."""
    def __init__(self, reason, run_id="", box=None):
        super().__init__(reason, outage=True, run_id=run_id, box=box)


@contextlib.contextmanager
def pre_start(run_id):
    token = PRE_START.set(run_id)
    try:
        yield
    finally:
        PRE_START.reset(token)


@contextlib.contextmanager
def wait_budget(deadline=None):
    budget = WAIT_BUDGET.get()
    if budget is not None:
        if deadline is not None:
            budget["end"] = deadline if budget["end"] is None else min(deadline, budget["end"])
        yield
        return
    token = WAIT_BUDGET.set({"end": deadline})
    try:
        yield
    finally:
        WAIT_BUDGET.reset(token)


def wait_budget_end():
    budget = WAIT_BUDGET.get()
    return budget["end"] if budget is not None else None


def wait_deadline(seconds, *, clock=None):
    end = (clock or time.monotonic)() + seconds
    budget = WAIT_BUDGET.get()
    if budget is not None:
        # Named-base outages and startup refusals are one wait, even across allocation retries.
        budget["end"] = end if budget["end"] is None else min(end, budget["end"])
        return budget["end"]
    return end


def error_phase(error):
    if getattr(error, "status", None) != 503 or getattr(error, "api_code", "") not in (
            "server_not_ready", "server_starting"):
        return None
    return starting_phase({"message": error.message, "starting": getattr(error, "starting", False),
                           "phase": getattr(error, "phase", None)})


def begin_transient(clock=None, began=None):
    budget = WAIT_BUDGET.get()
    if budget is not None:
        budget.setdefault("transient_since", began if began is not None else (clock or time.monotonic)())


def note_home_answer(clock=None, *, ready=True):
    budget = WAIT_BUDGET.get()
    if budget is not None:
        budget["last_answer"] = (clock or time.monotonic)()
        if ready:
            budget.pop("transient_since", None)
        budget.pop("slow_end", None)
        budget.pop("slow_anchor", None)


def slow_deadline(clock, fallback_end=None):
    budget = WAIT_BUDGET.get()
    start = clock()
    answers = []
    if budget.get("last_answer") is not None:
        answers.append(budget["last_answer"])
    monitor = common.home_state()
    last_ok = monitor.get("last_answer") or monitor.get("last_ok")
    if type(last_ok) in (float, int) and last_ok > 0:
        answers.append(start - max(0, time.time() - last_ok))
    anchor = max(answers) if answers else budget.get("slow_anchor", start)
    if not answers and fallback_end is not None:
        anchor = min(anchor, fallback_end - slow_down_seconds())
    previous = budget.get("slow_anchor")
    if previous is None or anchor > previous:
        budget.update(slow_anchor=anchor, slow_end=anchor + slow_down_seconds())
    return budget["slow_end"]


def wait_while_starting(reason, run_id="", *, checkpoint="probe", box=None,
                        clock=None, sleep=None, read=None, deadline=None):
    clock, sleep, read = clock or time.monotonic, sleep or time.sleep, read or _health
    if WAIT_BUDGET.get() is None:
        with wait_budget():
            return wait_while_starting(reason, run_id, checkpoint=checkpoint, box=box,
                                       clock=clock, sleep=sleep, read=read, deadline=deadline)
    phase = reason if isinstance(reason, str) else starting_phase(reason)
    slow = phase == "slow"
    start = clock()
    begin_transient(clock)
    episode_end = WAIT_BUDGET.get()["transient_since"] + wait_seconds()
    slow_cap = deadline if slow else None
    startup_cap = None if slow else deadline

    def end_for_mode():
        if slow:
            end = slow_deadline(clock, slow_cap)
            inherited = wait_budget_end()
            return min(end, inherited, episode_end) if inherited is not None else min(end, episode_end)
        end = wait_deadline(wait_seconds(), clock=clock)
        return min(end, startup_cap, episode_end) if startup_cap is not None else min(end, episode_end)

    if not slow:
        note_home_answer(clock, ready=False)
    end = end_for_mode()
    limit = slow_down_seconds() if slow else wait_seconds()
    label = "slow to answer" if slow else "starting"
    say(f"home offbox server is {label} ({phase}); waiting up to {limit:g} s, "
        + (f"keeping {box} and the queue place" if box else "keeping the queue place"))
    outcome = "failover"
    from . import prepare
    with prepare.pause_for_home_start():
        try:
            while True:
                left = end - clock()
                if left <= 0:
                    bound = wait_seconds() if clock() >= episode_end else limit
                    return f"home still {'slow' if slow else 'starting'} after {bound:g} s ({phase})"
                sleep(min(5, left))
                data = read(min(slow_probe_seconds() if slow else PROBE_TIMEOUT_S, max(.001, end - clock())))
                if isinstance(data, dict) and data.get("ok") is True:
                    note_home_answer(clock)
                    outcome = "ready"
                    return None
                next_phase = starting_phase(data)
                if next_phase:
                    note_home_answer(clock, ready=False)
                    slow_cap = None
                    if slow:
                        say(f"home offbox server is starting ({next_phase}); waiting up to {wait_seconds():g} s")
                    slow, phase, limit = False, next_phase, wait_seconds()
                    end = end_for_mode()
                elif timed_out(data) and tcp_connects(health_url() or ""):
                    slow, phase, limit = True, "slow", slow_down_seconds()
                    end = end_for_mode()
                else:
                    return _health_reason(data)
        finally:
            toollog.emit("backend", "backend.start_wait", duration_ms=(clock()-start)*1000,
                         ids={"run": run_id, "box": box},
                         props={"phase": phase, "class": "slow" if slow else "starting",
                                "checkpoint": checkpoint, "outcome": outcome})



def _health_reason(data):
    if isinstance(data, str):
        return data
    why = "; ".join(str(x) for x in (data.get("reasons") or [])[:2]) if isinstance(data, dict) else ""
    return f"server says it cannot take runs ({why or 'not ready'})"


def _probe(timeout: float = PROBE_TIMEOUT_S, *, wait: bool = True) -> str | None:
    start = time.monotonic()
    data = _health(timeout) if wait else _health(timeout, bounded=True)
    if timed_out(data) or starting_phase(data):
        begin_transient(began=start)
    classification = "good" if isinstance(data, dict) and data.get("ok") is True else "hard"
    reachable = tcp_connects(health_url() or "") if wait and timed_out(data) else None
    if reachable:
        classification = "slow"
        elapsed = (time.monotonic() - start) * 1000
        say(f"home offbox server is slow to answer ({elapsed:.0f} ms); waiting up to "
            f"{slow_probe_seconds():g} s instead of moving to Boat")
        data = _health(slow_probe_seconds())
        if isinstance(data, dict) and data.get("ok") is True:
            classification = "good"
        elif not timed_out(data):
            classification = "hard"
    phase = starting_phase(data)
    if isinstance(data, dict) and (data.get("ok") is True or phase):
        note_home_answer(ready=data.get("ok") is True)
    if phase:
        classification = "starting"
    PROBE_FACTS.set({"class": classification, "tcp": reachable, "ms": round((time.monotonic()-start)*1000, 1)})
    if wait and (phase or classification == "slow"):
        result = wait_while_starting(phase or "slow", invocation_run(),
                                    checkpoint="person" if common.person() else "probe",
                                    deadline=start + slow_down_seconds() if classification == "slow" else None)
        if result is None:
            PROBE_FACTS.set({"class": "good", "ms": round((time.monotonic()-start)*1000, 1)})
        return result
    return None if isinstance(data, dict) and data.get("ok") is True else _health_reason(data)


def _health(timeout: float = PROBE_TIMEOUT_S, *, bounded=False):
    """One GET /health (no token): its JSON body or a short transport failure reason."""
    url = health_url()
    if not url:
        return "no home server configured"
    try:
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        if bounded:
            from . import api
            scope = api.RequestScope(timeout, network_timeout=True)
            with scope.active(), scope.request():
                with api._open(request, timeout=timeout) as response:
                    d = json.loads(api._read_response(response, scope.end) or b"{}")
        else:
            with urllib.request.urlopen(request, timeout=timeout) as r:
                d = json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return f"health answered HTTP {e.code}"
    except (OSError, ValueError, OffboxError) as e:
        kind = type(getattr(e, "reason", e)).__name__
        return f"no answer ({kind})"
    return d


def slow_read_reachable(deadline=None):
    from home_monitor import tailnet_facts
    url = health_url() or ""
    def remaining(limit):
        return limit if deadline is None else max(0, min(limit, deadline - time.monotonic()))
    if remaining(PROBE_TIMEOUT_S) <= 0:
        return True
    if not tcp_connects(url, timeout=remaining(PROBE_TIMEOUT_S)):
        return False
    if remaining(5) <= 0:
        return True
    if tailnet_facts(url, timeout=remaining(5)).get("peer_online") is False:
        return False
    if remaining(PROBE_TIMEOUT_S) <= 0:
        return True
    data = _health(remaining(PROBE_TIMEOUT_S))
    expected = common.home_state().get("boot_id")
    if isinstance(data, dict):
        actual = data.get("boot_id")
        if expected and actual and expected != actual:
            return False
        if data.get("ok") is not True and not starting_phase(data):
            return False
        note_home_answer(ready=False)
    elif not timed_out(data):
        return False
    return True


def recover_slow_read(error, read, *, box, deadline=None):
    """Retry a timed-out box observation in place; no allocation send is repeated here."""
    from . import api, allocation, prepare
    if not active():
        raise error
    queue = allocation._QUEUE.get()
    if queue is not None:
        QUEUE_WAIT.set(queue.get("queue_wait_s", max(0, queue['wait'] - (queue['end'] - time.monotonic()))))
    if not timed_out(error):
        raise error
    if WAIT_BUDGET.get() is None:
        with wait_budget():
            return recover_slow_read(error, read, box=box, deadline=deadline)
    began = time.monotonic()
    begin_transient(began=began)
    caller_ends = [end for end in (deadline, api._DEADLINE) if end is not None]
    caller_end = min(caller_ends, default=None)
    home_ends = [WAIT_BUDGET.get()["transient_since"] + wait_seconds()]
    if wait_budget_end() is not None:
        home_ends.append(wait_budget_end())
    home_end = min(home_ends)

    def check_caller():
        allocation.check_queue()
        if caller_end is not None and time.time() >= caller_end:
            raise api.BudgetExpired(f"client deadline passed while reading {box}; nothing ran")

    def check_bounds():
        check_caller()
        if time.monotonic() >= home_end:
            raise StartWaitFailed("home still slow after its inherited wait limit (box-read)", invocation_run(), box)

    def remaining(*, silence=True):
        ends = [home_end]
        if silence:
            ends.append(slow_deadline(time.monotonic, began + slow_down_seconds()))
        if caller_end is not None:
            ends.append(time.monotonic() + max(0, caller_end - time.time()))
        queue_left = allocation.queue_left()
        if queue_left is not None:
            ends.append(time.monotonic() + queue_left)
        return max(0, min(ends) - time.monotonic())

    def reachable():
        check_bounds()
        good = slow_read_reachable(deadline=time.monotonic() + remaining(silence=False))
        check_bounds()
        return good

    if not reachable():
        raise error

    say(f"home box {box} is slow to answer; waiting up to {slow_probe_seconds():g} s, keeping the box and queue place")
    result = {}
    def retry(timeout):
        check_bounds()
        timeout = min(timeout, remaining())
        if timeout <= 0:
            return "no answer (TimeoutError)"
        try:
            queue_left = allocation.queue_left()
            ends = [end for end in (caller_end, time.time() + max(0, home_end - time.monotonic()),
                                    time.time() + queue_left if queue_left is not None else None)
                    if end is not None]
            with pre_start(invocation_run()), api.RequestScope(timeout, parent=api._REQUEST_SCOPE.get(), network_timeout=True,
                                                               caller_deadline=min(ends, default=None)).active():
                result['box'] = read(time.time() + timeout)
            check_bounds()
            return {"ok": True}
        except (StartWaitFailed, api.BudgetExpired):
            check_bounds()
            raise
        except api.NetworkError as next_error:
            check_bounds()
            if not timed_out(next_error) or not reachable():
                raise
            return "no answer (TimeoutError)"

    def sleep(seconds):
        time.sleep(min(seconds, remaining()))
        check_bounds()

    caller_bounds = [home_end]
    if caller_end is not None:
        caller_bounds.append(time.monotonic() + max(0, caller_end - time.time()))
    queue_left = allocation.queue_left()
    if queue_left is not None:
        caller_bounds.append(time.monotonic() + queue_left)
    budget = WAIT_BUDGET.get()
    enclosing_end = budget["end"]
    try:
        with wait_budget(min(caller_bounds)), prepare.pause_for_home_start():
            first = retry(slow_probe_seconds())
            if isinstance(first, dict) and first.get("ok") is True:
                return result['box']
            why = wait_while_starting("slow", invocation_run(), checkpoint="box-read", box=box, read=retry,
                                       deadline=began + slow_down_seconds(), sleep=sleep)
            check_bounds()
            if why:
                raise StartWaitFailed(why, invocation_run(), box)
            return result['box']
    finally:
        budget["end"] = enclosing_end


def failure_class(reason):
    return "slow" if "home still slow" in reason else "starting" if "home still starting" in reason else "hard"


def record_failure(reason: str, run_id: str = "", *, base: str | None = None, base_kept: bool = False, classification: str | None = None) -> None:
    """One line for the health monitor: a run could not reach home before it was accepted."""
    try:
        common.HOME_FAILURES.parent.mkdir(parents=True, exist_ok=True)
        with common.HOME_FAILURES.with_suffix(".lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                lines = common.HOME_FAILURES.read_text().splitlines()[-(MAX_FAILURE_LINES - 1):]
            except OSError:
                lines = []
            monitor = common.home_state()
            classification = classification or failure_class(reason)
            lines.append(json.dumps({"class": classification, "monitor_last_check": monitor.get("last_check"),
                                     "monitor_last_outcome": monitor.get("last_outcome"), "queue_wait_s": round(QUEUE_WAIT.get(), 1), "ts": time.time(), "reason": reason[:300], "run": run_id,
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


def preflight_reason() -> str | None:
    from . import api
    if WAIT_BUDGET.get() is None:
        with wait_budget():
            return preflight_reason()
    began = time.monotonic()
    recent = recent_failure()
    PROBE_FACTS.set(None)
    why = probe()
    health_ok = why is None
    if why and (PROBE_FACTS.get() or {}).get("tcp") is False:
        return why
    auth_began = time.monotonic()
    if recent or health_ok or (why or "").startswith("no answer"):
        # /health can stay green while authenticated allocation reads stop answering.
        with pre_start(invocation_run()):
            why = api.probe_backend("server", PROBE_TIMEOUT_S)
            if timed_out(why):
                begin_transient(began=auth_began)
            if why and health_ok and not why.startswith("home still starting after "):
                timeout = PROBE_TIMEOUT_S
                if timed_out(why) and tcp_connects(health_url() or ""):
                    timeout = slow_probe_seconds()
                    elapsed = (time.monotonic() - began) * 1000
                    say(f"home offbox server is slow to answer ({elapsed:.0f} ms); waiting up to "
                        f"{timeout:g} s instead of moving to Boat")
                why = api.probe_backend("server", timeout)
    if why and timed_out(why) and tcp_connects(health_url() or ""):
        def read_api(timeout):
            with pre_start(invocation_run()):
                reason = api.probe_backend("server", timeout)
            return reason if reason else {"ok": True}
        why = wait_while_starting("slow", invocation_run(), read=read_api,
                                  deadline=auth_began + slow_down_seconds())
        PROBE_FACTS.set({"class": "slow" if why else "good"})
    if why is None:
        note_home_answer()
    if why and why.startswith("home still starting after "):
        raise StartWaitFailed(why, invocation_run())
    return why


def before_run(argv: list[str], *, explicit_base: str | None = None) -> None:
    wait_for_base = active() and common.person() is None and base_needs_home(explicit_base)
    if not may_fail_over(explicit_base) and not wait_for_base:
        return
    monitor = common.home_state()
    why = preflight_reason()
    if not why and monitor.get("state") == "home_down":
        say(f"home offbox server answered again ({(PROBE_FACTS.get() or {}).get('ms', 0):g} ms) "
            "while the monitor still says down; staying home")
    if why:
        if wait_for_base:
            raise OffboxError(f"home offbox server not reachable ({why})", outage=True)
        fail_over(why, argv, invocation_run(), explicit_base=explicit_base)


def person_gate() -> None:
    """Person-box work with a home server configured: stop at once when home is down. Never Boat."""
    who = common.person()
    if not who or common.home_config() is None or common.backend_pinned() is not None:
        return
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
    run_id = run_id or invocation_run()
    if os.environ.get(RETURNED_HOME_ENV):
        return False
    if common.person() is not None:
        raise OffboxError("person work waits on home; nothing was sent to Boat", code=EXIT_HOME_DOWN)
    failover_decision('boat', 'unreachable', explicit_base, run_id)
    record_failure(reason, run_id, base=explicit_base, base_kept=explicit_base is not None)
    if api.probe_backend("boat", PROBE_TIMEOUT_S):
        say("Boat's API is unavailable too; keeping this run on home")
        return False
    if run_id:
        with contextlib.closing(common.db()) as con:
            con.execute("DELETE FROM prune_holds WHERE run_id=?", (run_id,))
    queued = os.environ.get(BACKGROUND_RUN_ENV)
    if queued:
        _forward_background(queued)
    elapsed = max(0, time.monotonic() - WAIT_STARTED)*1000 if WAIT_STARTED is not None else 0
    toollog.emit("backend", "backend.failover", duration_ms=elapsed, ok=True, ids={"run": run_id},
                 props={"from": "home", "to": "boat", "reason": "unreachable", "waitMs": elapsed})
    monitor = common.home_state()
    classification = failure_class(reason)
    routing_line(f"home offbox server not reachable ({reason[:160]}); this run goes to Boat instead "
        f"class={classification} run={run_id or '-'} monitor_last_check={monitor.get('last_check')} "
        f"monitor_last_outcome={monitor.get('last_outcome')}", run_id)
    log(f"failover to boat: {reason[:300]}")
    env = dict(os.environ, OFFBOX_BACKEND="boat")
    env[FAILOVER_ENV] = reason[:200]
    # Only an unregistered preflight ID can cross backends. Registered foreground attempts keep their own receipt.
    with contextlib.closing(common.db()) as con:
        registered = con.execute("SELECT 1 FROM runs WHERE run_id=?", (run_id,)).fetchone() is not None
    if queued or not registered:
        env[RUN_ID_ENV] = run_id
    else:
        env.pop(RUN_ID_ENV, None)
    if queued:
        from .runs import forward_background
        forward_background(env)
    sys.stdout.flush()
    sys.stderr.flush()
    os.execve(sys.executable, [sys.executable, os.path.realpath(sys.argv[0]), *argv], env)


def _forward_background(run_id: str, source_backend="server", target_backend="boat") -> None:
    """Publish a queued ID at its destination before retiring the source; followers use status/error to route."""
    # Opposite transfers share this lock so neither can hold one DB writer while waiting for the other.
    with common.file_lock("backend-handoff", timeout=30):
        _forward_queued(run_id, source_backend, target_backend)


def _forward_queued(run_id, source_backend, target_backend):
    source = common.db() if source_backend == "server" and target_backend == "boat" else sqlite3.connect(
        common.db_path_for(source_backend), isolation_level=None)
    source.row_factory = sqlite3.Row
    target = None
    try:
        common.ensure_schema(source)
        with common.write(source):
            row = source.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
            if not row or row['status'] != 'starting' or row['box_id'] or row['process_id']:
                raise OffboxError(f'{run_id}: refusing failover after a possible start', started=True)
            target = sqlite3.connect(common.db_path_for(target_backend), isolation_level=None)
            target.row_factory = sqlite3.Row
            common.ensure_schema(target)
            names = list(row.keys())
            with common.write(target):
                previous = target.execute('SELECT * FROM runs WHERE run_id=?', (run_id,)).fetchone()
                if previous:
                    if (previous['status'] != 'forwarded' or previous['error'] != source_backend
                            or previous['box_id'] or previous['process_id']):
                        raise OffboxError(f'{run_id}: refusing failover after a possible start', started=True)
                    target.execute('DELETE FROM runs WHERE run_id=?', (run_id,))
                target.execute('INSERT INTO runs (' + ','.join(names) + ') VALUES (' + ','.join('?' for _ in names) + ')', tuple(row))
                target.execute("INSERT OR REPLACE INTO kv(k,v) VALUES (?, '1')", ('start_claim:' + run_id,))
                if target_backend == "boat":
                    target.execute("INSERT OR REPLACE INTO kv(k,v) VALUES (?, '1')", ('failover_queue:' + run_id,))
            source.execute("UPDATE runs SET status='forwarded',error=?,end_at=? WHERE run_id=?",
                           (target_backend, common.now(), run_id))
    finally:
        source.close()
        if target is not None:
            target.close()


def failed_over() -> bool:
    return (common.backend() == "boat" and bool(os.environ.get(FAILOVER_ENV))
            and not common.person() and not os.environ.get(RETURNED_HOME_ENV))


def unlimited_queue():
    return failed_over() or (active() and bool(os.environ.get(RETURNED_HOME_ENV)))


def failback_probe_seconds():
    from . import capacity
    return capacity.setting("OFFBOX_FAILBACK_PROBE_S", FAILBACK_PROBE_S, minimum=1, maximum=3600)


class FailbackReady(BaseException):
    # Unwind every pool lock/queue scope before exec, without settling an unstarted run as a failure.
    def __init__(self, run_id, waited, state):
        self.run_id, self.waited, self.state = run_id, waited, state


def flush_routing(run_id):
    lines = list(dict.fromkeys(json.loads(os.environ.get(ROUTING_ENV, "[]"))))
    if not run_id or not lines:
        return
    path = common.LOGS_DIR / f"{run_id}.client.log"
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(errors="replace") if path.exists() else ""
    header = "\n".join(lines) + "\n"
    # The predecessor can still be appending its handoff prints when the replacement Runner starts.
    if existing.startswith(header):
        return
    body = [line for line in existing.splitlines() if line not in lines]
    updated = "\n".join([*lines, *body]) + "\n"
    if updated != existing:
        # Keep the inode: a detached client's append-only stderr still points at this file.
        with open(path, "r+" if path.exists() else "w", opener=lambda p, f: os.open(p, f, 0o600)) as output:
            output.write(updated)
            output.truncate()


def routing_line(message, run_id):
    line = f"offbox: {message}"
    lines = json.loads(os.environ.get(ROUTING_ENV, "[]"))
    lines.append(line)
    os.environ[ROUTING_ENV] = json.dumps(lines)
    say(message)
    flush_routing(run_id)


def fail_back(ready, argv):
    from .runs import BACKGROUND_RUN_ENV, forward_background
    run_id, waited, state = ready.run_id, ready.waited, ready.state
    reason = os.environ.get(FAILOVER_ENV, "")
    _forward_background(run_id, "boat", "server")
    routing_line(f"home offbox server is back; this run leaves the Boat queue "
                 f"(waited {int(waited)} s, #{state.get('place')} of {state.get('waiting')}) and goes back to home", run_id)
    toollog.emit("backend", "backend.failback", duration_ms=waited*1000, ids={"run": run_id},
                 props={"from": "boat", "to": "home", "position": state.get("place"), "reason": reason[:200]})
    env = dict(os.environ, OFFBOX_BACKEND="server")
    env.pop(FAILOVER_ENV, None)
    env[RETURNED_HOME_ENV] = reason or "home recovered"
    env[RUN_ID_ENV] = run_id
    if os.environ.get(BACKGROUND_RUN_ENV):
        forward_background(env, backend="server")
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
