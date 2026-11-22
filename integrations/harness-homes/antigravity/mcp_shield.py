#!/opt/homebrew/bin/python3
"""Keep one broken MCP server from failing a whole Antigravity session.

The Antigravity runtime ends the session ("MCP load failed for X") when any
configured server fails `initialize`. Every manifest server therefore runs
behind this stdio proxy. It forwards everything to the real server (a stdio
command or a streamable-HTTP URL). When the real server cannot be started,
cannot be reached or rejects us, the shield still answers `initialize`, lists
no tools and answers calls with a tool error, so the session keeps working
without that server.

Stdlib only. Secrets never appear in arguments: an HTTP bearer token is read
from the login Keychain by service name (`--bearer-keychain`).

  mcp_shield.py --name dia -- /path/node server.js
  mcp_shield.py --name recall --url http://127.0.0.1:18765/mcp
  mcp_shield.py --name betterstack --url https://mcp.betterstack.com --bearer-keychain betterstack-mcp
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

DEFAULT_PROTOCOL = "2025-06-18"
DRAIN_SECONDS = 30.0  # open requests may finish after the client closes stdin
_out_lock = threading.Lock()


def log(name: str, event: str, **fields) -> None:
    """Metadata only (no payloads, no secrets)."""
    try:
        path = os.environ.get("MCP_SHIELD_LOG") or os.path.expanduser(
            "~/.local/share/harness-homes/logs/mcp-shield.log")
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(json.dumps({"ts": round(time.time(), 3), "server": name, "event": event, **fields}) + "\n")
    except OSError:
        pass


def emit(message) -> None:
    data = json.dumps(message, separators=(",", ":"))
    with _out_lock:
        sys.stdout.write(data + "\n")
        sys.stdout.flush()


def emit_raw(line: str) -> None:
    with _out_lock:
        sys.stdout.write(line if line.endswith("\n") else line + "\n")
        sys.stdout.flush()


class Degraded:
    """Answers for a server that is not available."""

    def __init__(self, name: str, reason: str):
        self.name, self.reason = name, reason

    def note(self) -> str:
        return f"The {self.name} MCP server is unavailable ({self.reason})."

    def initialize_result(self, request: dict) -> dict:
        params = request.get("params") if isinstance(request.get("params"), dict) else {}
        version = params.get("protocolVersion") if isinstance(params.get("protocolVersion"), str) else DEFAULT_PROTOCOL
        return {"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": f"{self.name}-unavailable", "version": "0"},
                "instructions": self.note()}

    def answer(self, message: dict) -> None:
        if "id" not in message or not isinstance(message.get("method"), str):
            return  # notifications and stray responses
        method, mid = message["method"], message["id"]
        if method == "initialize":
            emit({"jsonrpc": "2.0", "id": mid, "result": self.initialize_result(message)})
        elif method == "ping":
            emit({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "tools/list":
            emit({"jsonrpc": "2.0", "id": mid, "result": {"tools": []}})
        elif method == "tools/call":
            emit({"jsonrpc": "2.0", "id": mid, "result": {
                "content": [{"type": "text", "text": self.note()}], "isError": True}})
        elif method in ("resources/list", "resources/templates/list", "prompts/list"):
            key = {"resources/list": "resources", "resources/templates/list": "resourceTemplates",
                   "prompts/list": "prompts"}[method]
            emit({"jsonrpc": "2.0", "id": mid, "result": {key: []}})
        else:
            emit({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": self.note()}})


def downstream_messages():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            yield line, json.loads(line)
        except ValueError:
            continue


# ---------- stdio upstream ----------

def run_stdio(name: str, command: list[str], init_timeout: float) -> int:
    try:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=sys.stderr, text=True, bufsize=1)
    except OSError as error:
        log(name, "spawn-failed", error=type(error).__name__)
        return serve_degraded(Degraded(name, f"could not start: {type(error).__name__}"))

    state = {"degraded": None}
    pending: dict = {}
    pending_lock = threading.Lock()
    init_waiters: dict = {}

    def pump_upstream():
        for line in proc.stdout:
            text = line.strip()
            if not text:
                continue
            try:
                message = json.loads(text)
            except ValueError:
                continue  # never pass log noise to the client
            mid = message.get("id") if isinstance(message, dict) else None
            if mid is not None and "method" not in message:
                waiter = init_waiters.pop(json.dumps(mid), None)
                if waiter is not None:
                    waiter["message"] = message
                    waiter["event"].set()
                    continue
                with pending_lock:
                    pending.pop(json.dumps(mid), None)
            emit(message)
        # Upstream ended: answer what is still open, then degrade.
        code = proc.poll()
        reason = f"server exited ({code})" if code is not None else "server closed its output"
        state["degraded"] = Degraded(name, reason)
        log(name, "upstream-ended", code=code)
        for waiter in list(init_waiters.values()):
            waiter["event"].set()
        with pending_lock:
            open_requests = list(pending.values())
            pending.clear()
        for request in open_requests:
            state["degraded"].answer(request)

    pump = threading.Thread(target=pump_upstream, daemon=True)
    pump.start()

    def send(line: str) -> bool:
        try:
            proc.stdin.write(line + "\n")
            proc.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    for line, message in downstream_messages():
        if not isinstance(message, dict):
            continue
        degraded = state["degraded"]
        if degraded is not None:
            degraded.answer(message)
            continue
        if message.get("method") == "initialize" and "id" in message:
            waiter = {"event": threading.Event(), "message": None}
            init_waiters[json.dumps(message["id"])] = waiter
            started = time.monotonic()
            if not send(line) or not waiter["event"].wait(init_timeout) or waiter["message"] is None:
                init_waiters.pop(json.dumps(message["id"]), None)
                reason = "did not answer initialize" if state["degraded"] is None else state["degraded"].reason
                state["degraded"] = Degraded(name, reason)
                log(name, "init-failed", reason=reason, ms=round((time.monotonic() - started) * 1000))
                state["degraded"].answer(message)
                try:
                    proc.kill()
                except OSError:
                    pass
                continue
            reply = waiter["message"]
            if "error" in reply:
                state["degraded"] = Degraded(name, "initialize was refused")
                log(name, "init-refused")
                state["degraded"].answer(message)
                continue
            log(name, "init-ok", ms=round((time.monotonic() - started) * 1000))
            emit(reply)
            continue
        if "id" in message and isinstance(message.get("method"), str):
            with pending_lock:
                pending[json.dumps(message["id"])] = message
        if not send(line):
            state["degraded"] = state["degraded"] or Degraded(name, "server input closed")
            with pending_lock:
                pending.pop(json.dumps(message.get("id")), None)
            state["degraded"].answer(message)
    # Client closed its side: let the server finish open requests, then stop it.
    try:
        proc.stdin.close()
    except OSError:
        pass
    pump.join(DRAIN_SECONDS)
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        try:
            proc.kill()
        except OSError:
            pass
    return 0


# ---------- streamable HTTP upstream ----------

def keychain_secret(service: str) -> str | None:
    try:
        out = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", service,
                              "-a", os.environ.get("USER", "ardud"), "-w"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = out.stdout.strip()
    return value if out.returncode == 0 and value else None


class HttpUpstream:
    def __init__(self, name: str, url: str, bearer: str | None, timeout: float):
        self.name, self.url, self.bearer, self.timeout = name, url, bearer, timeout
        self.session_id: str | None = None
        self.protocol: str | None = None
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def headers(self) -> dict:
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.bearer:
            h["Authorization"] = "Bearer " + self.bearer
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        if self.protocol:
            h["MCP-Protocol-Version"] = self.protocol
        return h

    def post(self, message, timeout: float) -> list:
        request = urllib.request.Request(self.url, data=json.dumps(message).encode(), headers=self.headers(),
                                         method="POST")
        with self.opener.open(request, timeout=timeout) as response:
            session = response.headers.get("Mcp-Session-Id")
            if session:
                self.session_id = session
            kind = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if response.status == 202:
                return []
            if kind == "text/event-stream":
                return self._read_sse(response, message)
            body = response.read()
            if not body.strip():
                return []
            value = json.loads(body)
            return value if isinstance(value, list) else [value]

    @staticmethod
    def _read_sse(response, message) -> list:
        wanted = message.get("id") if isinstance(message, dict) else None
        out, data = [], []
        for raw in response:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line.startswith("data:"):
                data.append(line[5:].lstrip())
            elif line == "" and data:
                try:
                    value = json.loads("\n".join(data))
                except ValueError:
                    value = None
                data = []
                if value is not None:
                    out.append(value)
                    if isinstance(value, dict) and value.get("id") == wanted and "method" not in value:
                        break
        return out


def run_http(name: str, url: str, bearer_service: str | None, init_timeout: float, call_timeout: float) -> int:
    bearer = None
    if bearer_service:
        bearer = keychain_secret(bearer_service)
        if not bearer:
            log(name, "no-token", service=bearer_service)
            return serve_degraded(Degraded(name, f"no API token in Keychain item {bearer_service}"))
    upstream = HttpUpstream(name, url, bearer, call_timeout)
    state = {"degraded": None, "init": None}

    def forward(message, timeout):
        try:
            replies = upstream.post(message, timeout)
        except urllib.error.HTTPError as error:
            if error.code == 404 and upstream.session_id and state["init"] is not None:
                # The server dropped our session: start a new one once, then retry.
                upstream.session_id = None
                upstream.post(state["init"], init_timeout)
                upstream.post({"jsonrpc": "2.0", "method": "notifications/initialized"}, init_timeout)
                replies = upstream.post(message, timeout)
            else:
                raise
        for reply in replies:
            emit(reply)

    def handle(message):
        try:
            forward(message, call_timeout)
        except Exception as error:  # noqa: BLE001 - every failure becomes a tool error
            log(name, "call-failed", error=type(error).__name__)
            if "id" in message and isinstance(message.get("method"), str):
                Degraded(name, f"request failed: {type(error).__name__}").answer(message)

    workers: list[threading.Thread] = []
    for _, message in downstream_messages():
        if not isinstance(message, dict):
            continue
        if state["degraded"] is not None:
            state["degraded"].answer(message)
            continue
        if message.get("method") == "initialize" and "id" in message:
            started = time.monotonic()
            try:
                replies = upstream.post(message, init_timeout)
                reply = next((r for r in replies if isinstance(r, dict) and r.get("id") == message["id"]), None)
                if reply is None or "error" in reply:
                    raise ValueError("initialize refused")
                result = reply.get("result") if isinstance(reply.get("result"), dict) else {}
                upstream.protocol = result.get("protocolVersion") if isinstance(result.get("protocolVersion"), str) else None
                state["init"] = message
                log(name, "init-ok", ms=round((time.monotonic() - started) * 1000))
                emit(reply)
            except urllib.error.HTTPError as error:
                reason = "unauthorized" if error.code in (401, 403) else f"HTTP {error.code}"
                state["degraded"] = Degraded(name, reason)
                log(name, "init-failed", reason=reason)
                state["degraded"].answer(message)
            except Exception as error:  # noqa: BLE001
                reason = f"unreachable: {type(error).__name__}"
                state["degraded"] = Degraded(name, reason)
                log(name, "init-failed", reason=reason)
                state["degraded"].answer(message)
            continue
        if "id" in message and isinstance(message.get("method"), str):
            worker = threading.Thread(target=handle, args=(message,), daemon=True)
            worker.start()
            workers = [w for w in workers if w.is_alive()] + [worker]
        else:
            try:
                upstream.post(message, init_timeout)
            except Exception:  # noqa: BLE001 - notifications are best effort
                pass
    deadline = time.monotonic() + DRAIN_SECONDS
    for worker in workers:
        worker.join(max(0.0, deadline - time.monotonic()))
    return 0


def serve_degraded(degraded: Degraded) -> int:
    for _, message in downstream_messages():
        if isinstance(message, dict):
            degraded.answer(message)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--name", required=True)
    parser.add_argument("--url")
    parser.add_argument("--bearer-keychain")
    parser.add_argument("--init-timeout", type=float, default=20.0)
    parser.add_argument("--call-timeout", type=float, default=660.0)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if bool(args.url) == bool(command):
        parser.error("give exactly one of --url or -- <command>")
    if args.url:
        return run_http(args.name, args.url, args.bearer_keychain, args.init_timeout, args.call_timeout)
    return run_stdio(args.name, command, args.init_timeout)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
