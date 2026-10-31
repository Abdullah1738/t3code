"""boat.dev HTTP API client (stdlib). The key is read from Keychain at runtime and never printed or stored."""

from __future__ import annotations

import contextlib
import json
import re
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .common import OffboxError, EXIT_INFRA, log
from . import capacity

API = os.environ.get("OFFBOX_BOAT_API", "https://boat.dev/api/v1")
_KEY: str | None = None
LIVE_STATES = ("ready", "idle", "running")
STARTING_STATES = ("init", "provisioning", "provisioned", "cloning")
STOPPED_STATES = ("archived",)
REDACT_KEYS = ("url", "desktopUrl", "viewerUrl", "signedUrl")


def _key() -> str:
    global _KEY
    if _KEY is None:
        p = subprocess.run(["security", "find-generic-password", "-s", "boat-api", "-a", "ardud", "-w"],
                           capture_output=True, text=True)
        k = p.stdout.strip()
        if p.returncode != 0 or not k:
            raise OffboxError("boat API key missing from Keychain (boat-api/ardud)")
        _KEY = k
    return _KEY


def redact(obj):
    if isinstance(obj, dict):
        return {k: ("<redacted>" if k in REDACT_KEYS else redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


# Cloudflare answers these when it gets no response from boat's origin. The NOT_DELIVERED ones fail before the
# request reaches boat, while 520/524 may have reached it.
CF_OUTAGE = {520: "origin returned an unknown error", 521: "origin refused the connection",
             522: "origin connection timed out", 523: "origin unreachable", 524: "origin timed out",
             525: "origin SSL handshake failed", 526: "origin SSL certificate invalid"}
CF_NOT_DELIVERED = (521, 522, 523, 525, 526)


class ApiError(OffboxError):
    def __init__(self, status: int, code: str, message: str, retryable: bool = False):
        if status in CF_OUTAGE and not message:
            message = f"Cloudflare could not reach boat.dev ({CF_OUTAGE[status]})"
        super().__init__(f"boat API {status} {code}: {message}", EXIT_INFRA, outage=status in CF_OUTAGE)
        self.status, self.api_code, self.retryable = status, code, retryable


CONNECT_RETRIES = 5
_PRE_DELIVERY = re.compile(r"^connect (EADDRNOTAVAIL|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EADDRINUSE)\b")


def _never_delivered(status: int, code: str, msg: str) -> bool:
    if status in CF_NOT_DELIVERED:
        return True
    return status in (502, 503) and code == "sandbox_direct_failed" and bool(_PRE_DELIVERY.match(msg or ""))


# A time budget for a bounded maintenance pass (the reaper's upkeep). While set, every request's timeout is capped
# to the time left and retries stop once it is spent, so the pass cannot outrun its caller's limit.
_DEADLINE: float | None = None


@contextlib.contextmanager
def budget(seconds: float):
    """Nested budgets never extend the outer one: the earlier deadline wins."""
    global _DEADLINE
    prev = _DEADLINE
    mine = time.time() + seconds
    _DEADLINE = mine if prev is None else min(prev, mine)
    try:
        yield
    finally:
        _DEADLINE = prev


def left() -> float | None:
    return None if _DEADLINE is None else _DEADLINE - time.time()


def _room(pause: float) -> bool:
    """True when a retry that sleeps `pause` seconds still fits the budget (always True without one)."""
    return _DEADLINE is None or _DEADLINE - time.time() > pause + 1.0


def _in_deadline(deadline: float | None, pause: float) -> bool:
    """True when a retry that sleeps `pause` seconds still ends before the caller's absolute `deadline`."""
    return deadline is None or deadline - time.time() > pause


def _check_deadline(deadline: float, method: str, path: str) -> None:
    if time.time() >= deadline:
        raise OffboxError(f"deadline passed before {method} {path}")


def call(method: str, path: str, body=None, headers: dict | None = None, timeout: float = 60,
         retries: int = 2, ok404: bool = False, connect_retries: int | None = None, deadline: float | None = None):
    """JSON request. Retries only idempotent-safe failures (network, 5xx on GET/DELETE, explicit retryable).
    `deadline` (time.time()-style) caps every attempt, the retry pauses and the connect retries; past it the call
    raises OffboxError without sending. `connect_retries=0` disables the not-delivered connect retries."""
    if _DEADLINE is not None:
        retries = 0
    if deadline is not None:
        _check_deadline(deadline, method, path)
    max_connect = CONNECT_RETRIES if connect_retries is None else connect_retries
    url = API + path
    h = {"Authorization": "Bearer " + _key(), "Content-Type": "application/json", "Accept": "application/json"}
    h.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    is_start = method == "POST" and (path == "/sandboxes" or path.endswith(("/fork", "/resume")))
    attempt = 0
    while True:
        attempt += 1
        req_timeout = timeout
        if _DEADLINE is not None:
            # Recomputed on every attempt: a slow failure plus the retry pause has used part of the budget.
            room = _DEADLINE - time.time()
            if room <= 0:
                raise OffboxError(f"boat API budget spent before {method} {path}")
            req_timeout = min(timeout, max(1.0, room))
        if deadline is not None:
            _check_deadline(deadline, method, path)
            req_timeout = min(req_timeout, max(1.0, deadline - time.time()))
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        request_id = capacity.reserve(path.rsplit("/", 1)[-1],
                                      path.split("/")[2] if path != "/sandboxes" else None) if is_start else None
        if _DEADLINE is not None:
            # capacity.reserve may wait on SQLite (BEGIN IMMEDIATE, 30 s busy timeout): recompute what is left now,
            # and never send a request whose budget is already gone.
            room = _DEADLINE - time.time()
            if room <= 0:
                if request_id:
                    capacity.complete(request_id, "not_sent")
                raise OffboxError(f"boat API budget spent before sending {method} {path}")
            req_timeout = min(timeout, max(1.0, room))
        try:
            with urllib.request.urlopen(req, timeout=req_timeout) as r:
                raw = r.read()
                result = json.loads(raw) if raw.strip() else {}
                if request_id:
                    capacity.complete(request_id, "accepted", (result.get("sandbox") or {}).get("id"))
                return result
        except urllib.error.HTTPError as e:
            try:
                d = json.load(e)
            except Exception:  # noqa: BLE001
                d = {}
            err = d.get("error") if isinstance(d.get("error"), dict) else {}
            code = d.get("code") or err.get("code") or f"http_{e.code}"
            msg = d.get("message") or err.get("message") or ""
            if request_id:
                capacity.complete(request_id, f"http_{e.code}")
            if e.code == 429 and is_start:
                # A start-limit denial is never retried by this process or its siblings.
                raise capacity.cooldown(e.headers, d)
            retryable = bool((err.get("details") or {}).get("retryable")) or code in (
                "sandbox_starting", "boat_starting", "idempotency_in_progress", "ssh_host_key_unavailable",
                "rate_limited") or msg == "sandbox_restoring"
            if e.code == 404 and ok404:
                return None
            safe_method = method in ("GET", "DELETE", "PATCH") or "Idempotency-Key" in h
            # A start is never resent on a Cloudflare not-delivered answer, not even under the generic retry below:
            # each send reserves a start slot (create/fork carry an Idempotency-Key, so safe_method is true there).
            start_not_delivered = is_start and e.code in CF_NOT_DELIVERED
            if attempt <= retries and (retryable or (e.code >= 500 and safe_method)) and not start_not_delivered \
                    and _room(1.5 * attempt) and _in_deadline(deadline, 1.5 * attempt):
                time.sleep(1.5 * attempt)
                continue
            # boat's proxy failed to *connect* to the sandbox host, so the request never
            # reached the box: safe to retry even for non-idempotent POSTs (e.g. 2026-10-14
            # "502 sandbox_direct_failed: connect EADDRNOTAVAIL", ~7% of calls for an hour).
            if _never_delivered(e.code, code, msg) and not start_not_delivered \
                    and attempt <= max(retries, max_connect) \
                    and _room(min(2.0 * attempt, 8)) and _in_deadline(deadline, min(2.0 * attempt, 8)):
                log(f"api {method} {path} -> {e.code} {code} {msg[:120]} (not delivered; retry {attempt})")
                time.sleep(min(2.0 * attempt, 8))
                continue
            log(f"api {method} {path} -> {e.code} {code} {msg[:200]}")
            raise ApiError(e.code, code, msg, retryable)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if request_id:
                capacity.complete(request_id, "uncertain")
            safe_method = method in ("GET", "DELETE", "PATCH") or "Idempotency-Key" in h
            if attempt <= retries and safe_method and _room(1.5 * attempt) and _in_deadline(deadline, 1.5 * attempt):
                time.sleep(1.5 * attempt)
                continue
            if deadline is not None and time.time() >= deadline:
                # Still a network failure (boat silent): keep the outage classification the caller's clock needs.
                raise OffboxError(f"deadline passed during {method} {path}: {e}", outage=True)
            log(f"api {method} {path} -> network {e}")
            raise OffboxError(f"boat API unreachable ({method} {path}): {e}", outage=True)


def probe(timeout: float = 15) -> str | None:
    """One cheap GET to see whether boat answers. None = it answers; else why not. No connect retries: each
    would add sends and sleeps, so a probe would outrun its interval."""
    try:
        call("GET", "/limits", timeout=timeout, retries=0, connect_retries=0)
        return None
    except ApiError as e:
        return None if not e.outage else f"HTTP {e.status}"
    except OffboxError:
        return "no answer"


class StreamDeadline(OffboxError):
    """The caller's absolute deadline passed while reading a stream (possibly during silence or keepalives)."""


def _shut_at(r, deadline: float, fired: threading.Event) -> threading.Timer | None:
    """Shut the stream's socket down at `deadline`. A read blocked in recv (silence, or a partial line trickling in a
    byte at a time) wakes at once; the socket's own timeout restarts on every byte, so it cannot bound a read.
    shutdown, not close: closing a socket does not wake a recv already blocked on it."""
    sock = getattr(getattr(getattr(r, "fp", None), "raw", None), "_sock", None)
    if sock is None:
        return None

    def fire():
        fired.set()
        try:
            # The base method: SSLSocket.shutdown would also drop the SSL object under the blocked reader.
            socket.socket.shutdown(sock, socket.SHUT_RDWR)
        except OSError:
            pass
    t = threading.Timer(max(0.0, deadline - time.time()), fire)
    t.daemon = True
    t.start()
    return t


def stream(path: str, timeout: float = 120, deadline: float | None = None):
    """Open an ndjson stream; yields dicts. Caller handles reconnects. `deadline` is absolute (time.time()): the
    socket is shut at that moment (see _shut_at) and every line is checked against it, so no read, keepalive or
    partial line outlives it; the stream then raises StreamDeadline."""
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + _key(),
                                                      "Accept": "application/x-ndjson"})
    if deadline is not None:
        _check_deadline(deadline, "GET", path)
        timeout = max(0.5, min(timeout, deadline - time.time()))
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        try:
            d = json.load(e)
        except Exception:  # noqa: BLE001
            d = {}
        raise ApiError(e.code, d.get("code") or f"http_{e.code}", d.get("message") or "")
    fired = threading.Event()

    def expired() -> bool:
        return fired.is_set() or (deadline is not None and time.time() >= deadline)
    dog = _shut_at(r, deadline, fired) if deadline is not None else None
    try:
        with r:
            for line in r:
                if expired():
                    raise StreamDeadline(f"deadline passed while reading {path}")
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
                if expired():
                    raise StreamDeadline(f"deadline passed while reading {path}")
    except StreamDeadline:
        raise
    except Exception as e:  # noqa: BLE001
        # A read cut off at the deadline ends in whatever the transport makes of a shut socket (IncompleteRead, an
        # SSL or OS error): past the deadline that is the deadline, not a broken stream.
        if deadline is not None and expired():
            raise StreamDeadline(f"deadline passed while reading {path}") from e
        raise
    finally:
        if dog:
            dog.cancel()
    if deadline is not None and expired():
        raise StreamDeadline(f"deadline passed while reading {path}")


# ---------------------------------------------------------------- sandboxes

def get(box_id: str) -> dict | None:
    d = call("GET", f"/sandboxes/{box_id}", ok404=True)
    return None if d is None else d.get("sandbox")


def list_boxes(state: str | None = None) -> list[dict]:
    out, cursor = [], None
    while True:
        qs = {"limit": 200}
        if state:
            qs["state"] = state
        if cursor:
            qs["cursor"] = cursor
        d = call("GET", "/sandboxes?" + urllib.parse.urlencode(qs))
        out += d.get("sandboxes") or []
        pi = d.get("pageInfo") or {}
        if not pi.get("hasMore") or not pi.get("nextCursor"):
            return out
        cursor = pi["nextCursor"]


def create(size: str, ttl: int, name: str, idem: str, saved: str | None = None) -> dict:
    body = {"type": size, "ttlSeconds": ttl, "noEnv": True, "name": name[:120]}
    if saved:
        body["from"] = saved
    d = call("POST", "/sandboxes", body, {"Idempotency-Key": idem}, retries=4)
    return d["sandbox"]


# boat deletes a stopped box's data 14 days after it stopped (resume/fork then answer 409
# snapshot_data_expired). A saved snapshot is kept until deleted, and the plan includes a number of them.
DATA_GONE = ("snapshot_data_expired", "snapshot_not_found")


def data_gone(e: ApiError) -> bool:
    return e.api_code in DATA_GONE or e.status == 404


def saved_list() -> tuple[list[dict], dict]:
    d = call("GET", "/saved-snapshots") or {}
    return d.get("snapshots") or [], d.get("allowance") or {}


def saved_get(name: str) -> dict | None:
    d = call("GET", f"/saved-snapshots/{urllib.parse.quote(name)}", ok404=True)
    return None if d is None else d.get("snapshot")


def save(box_id: str, name: str) -> dict:
    """Saving under an existing name replaces that snapshot once the new one is ready."""
    d = call("POST", "/saved-snapshots", {"sandboxId": box_id, "name": name}) or {}
    return d.get("snapshot") or {}


def delete_saved(name: str) -> None:
    call("DELETE", f"/saved-snapshots/{urllib.parse.quote(name)}", ok404=True)


def fork(src: str, ttl: int, idem: str, size: str | None = None) -> dict:
    body = {"ttlSeconds": ttl, "noEnv": True}
    if size:
        body["type"] = size
    d = call("POST", f"/sandboxes/{src}/fork", body, {"Idempotency-Key": idem}, retries=4)
    return d.get("sandbox") or {"id": d.get("id")}


def resume(box_id: str, ttl: int, size: str | None = None) -> dict:
    body = {"ttlSeconds": ttl}
    if size:
        body["type"] = size
    try:
        return call("POST", f"/sandboxes/{box_id}/resume", body, retries=0)
    except ApiError as e:
        if e.api_code in ("sandbox_resuming",):
            return {}
        raise


def stop(box_id: str) -> dict:
    return call("POST", f"/sandboxes/{box_id}/stop", {}, retries=1)


def delete(box_id: str) -> dict:
    return call("DELETE", f"/sandboxes/{box_id}", headers={"X-Ascii-Confirm-Delete": box_id}, ok404=True) or {}


def rename(box_id: str, name: str) -> None:
    call("PATCH", f"/sandboxes/{box_id}", {"name": name[:120]})


def set_ttl(box_id: str, ttl: int) -> dict:
    return call("PATCH", f"/sandboxes/{box_id}", {"ttlSeconds": ttl}).get("sandbox") or {}


def usage(box_id: str, since: str | None = None) -> dict | None:
    qs = "?" + urllib.parse.urlencode({"since": since}) if since else ""
    return call("GET", f"/sandboxes/{box_id}/usage{qs}", ok404=True)


def limits() -> dict:
    return call("GET", "/limits")


def sshkey(box_id: str, pubkey: str) -> dict:
    return call("POST", f"/sandboxes/{box_id}/sshkey", {"key": pubkey}, retries=6)


def latest_snapshot(box_id: str) -> dict | None:
    d = call("GET", f"/sandboxes/{box_id}/snapshots/latest", ok404=True) or {}
    return d.get("snapshot")


def wait_state(box_id: str, want: tuple, timeout: float = 600, poll: float = 0.7) -> dict:
    if _DEADLINE is not None:
        timeout = max(0.0, min(timeout, _DEADLINE - time.time()))
    deadline = time.time() + timeout
    while True:
        s = get(box_id)
        if s is None:
            raise OffboxError(f"box {box_id} disappeared")
        st = s.get("state")
        if st in want:
            return s
        if st in ("error", "cancelled"):
            raise OffboxError(f"box {box_id} went to {st}: {s.get('error')}")
        if time.time() > deadline:
            raise OffboxError(f"box {box_id} stuck in {st} after {int(timeout)}s")
        time.sleep(poll)


# ---------------------------------------------------------------- commands

def cmd_sync(box_id: str, command: str, timeout: int = 60, cwd: str | None = None) -> dict:
    body = {"command": command, "timeoutSeconds": max(1, min(600, timeout))}
    if cwd:
        body["cwd"] = cwd
    return call("POST", f"/sandboxes/{box_id}/commands", body, timeout=timeout + 30, retries=0)


def cmd_start(box_id: str, command: str, cwd: str | None = None) -> dict:
    body = {"command": command, "detached": True}
    if cwd:
        body["cwd"] = cwd
    return call("POST", f"/sandboxes/{box_id}/commands", body, retries=0)


def cmd_status(box_id: str, pid: int, timeout: float = 60, retries: int = 2,
               deadline: float | None = None) -> dict | None:
    return call("GET", f"/sandboxes/{box_id}/commands/{pid}?tailBytes=4096", timeout=timeout, retries=retries,
                ok404=True, connect_retries=0 if deadline is not None else None, deadline=deadline)


def cmd_kill(box_id: str, pid: int) -> dict | None:
    return call("DELETE", f"/sandboxes/{box_id}/commands/{pid}", ok404=True, retries=1)


def cmd_attach(box_id: str, pid: int, out_off: int = 0, err_off: int = 0, timeout: float = 90,
               deadline: float | None = None):
    # `timeout` is the socket read timeout: a quiet stream returns control to follow() after at most this long.
    # `deadline` (absolute) additionally ends the stream the moment it passes, even while lines keep arriving.
    return stream(f"/sandboxes/{box_id}/commands/{pid}/stream?stdoutOffset={out_off}&stderrOffset={err_off}",
                  timeout=timeout, deadline=deadline)


def history_logs(box_id: str, command_id: str, which: str, offset: int = 0) -> dict:
    qs = urllib.parse.urlencode({"stream": which, "offset": offset})
    return call("GET", f"/sandboxes/{box_id}/command-history/{command_id}/logs?{qs}")


def history_get(box_id: str, command_id: str) -> dict:
    return call("GET", f"/sandboxes/{box_id}/command-history/{command_id}")
