"""Bounded, best-effort request metrics for the loopback MCP services."""
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
try:
    import toollog
except Exception:
    toollog = None
finally:
    sys.path.pop(0)

METHODS = frozenset(("initialize", "ping", "tools/list", "tools/call",
                     "notifications/initialized", "notifications/cancelled",
                     "resources/list", "resources/read", "resources/templates/list",
                     "resources/subscribe", "resources/unsubscribe", "prompts/list",
                     "prompts/get", "logging/setLevel", "completion/complete"))


def emit_request(server, tools, body, status, duration_ms, load):
    if toollog is None:
        return
    props = {"method": "unknown", "status": status}
    try:
        rpc = json.loads(body)
        if isinstance(rpc, dict):
            method = rpc.get("method")
            props["method"] = method if isinstance(method, str) and method in METHODS else "unknown"
            params = rpc.get("params")
            tool = params.get("name") if isinstance(params, dict) else None
            if method == "tools/call" and isinstance(tool, str) and tool in tools:
                props["toolName"] = tool
    except (ValueError, UnicodeError, RecursionError):
        pass
    if load is not None:
        props.update(zip(("load1", "load5", "load15"), load))
    toollog.emit("shared-mcp", "perf", "mcp.request", ids={"serverId": server},
                 props=props, duration_ms=duration_ms, ok=status < 400)


class RequestLogMiddleware:
    def __init__(self, app, server, tools, writer=emit_request):
        self.app, self.server, self.tools, self.writer = app, server, tools, writer
        # A stuck disk must neither block the event loop nor accumulate bodies.
        self.pending = queue.Queue(maxsize=64)
        self.closed = threading.Event()
        self.worker = threading.Thread(target=self._write, name="mcp-request-log", daemon=True)
        try:
            self.worker.start()
        except Exception:
            self.closed.set()

    def _write(self):
        while not self.closed.is_set() or not self.pending.empty():
            try:
                item = self.pending.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                self.writer(self.server, self.tools, *item)
            except Exception:
                pass
            finally:
                self.pending.task_done()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            try:
                await self.app(scope, receive, send)
            finally:
                if scope["type"] == "lifespan":
                    self.closed.set()
            return
        started = time.perf_counter()
        body = bytearray()
        oversized = False
        status = 500

        async def read():
            nonlocal oversized
            message = await receive()
            if message["type"] == "http.request" and not oversized:
                chunk = message.get("body", b"")
                if len(body) + len(chunk) <= 65536:
                    body.extend(chunk)
                else:
                    # Large/invalid requests still get timing and status, but
                    # never leave an unbounded copy waiting on the log writer.
                    body.clear()
                    oversized = True
            return message

        async def write(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
            await send(message)

        try:
            await self.app(scope, read, write)
        finally:
            try:
                duration = (time.perf_counter() - started) * 1000
                load = os.getloadavg() if duration > 1000 else None
                self.pending.put_nowait((bytes(body), status, duration, load))
            except Exception:
                pass
