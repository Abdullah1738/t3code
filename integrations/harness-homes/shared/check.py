#!/usr/bin/env python3
"""Check shared MCP endpoints, including a read from Flighty's database."""
import json
import re
import sys
import time
from functools import wraps
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import generate_homes as gh
import toollog
from opencode import SHARED_IDS
from runtime_paths import validate_inbody, validate_plist


def logged_probe(fn):
    @wraps(fn)
    def run(url, name):
        started = time.perf_counter()
        ok = False
        tag = None
        try:
            result = fn(url, name)
            ok = True
            return result
        except Exception as exc:
            tag = 'mcp.timeout' if isinstance(exc, TimeoutError) or isinstance(getattr(exc, 'reason', None), TimeoutError) else 'mcp.start_failed'
            raise
        finally:
            toollog.emit('mcp', 'perf' if ok else 'error', 'mcp.probe', ok=ok,
                         duration_ms=(time.perf_counter() - started) * 1000,
                         ids={'home': 'shared', 'serverId': name}, error_tag=tag,
                         props={'toolCount': len(result) if ok else 0})
    return run


@logged_probe
def probe(url, name):
    def rpc(method, params, request_id=None):
        message = {"jsonrpc": "2.0", "method": method, "params": params}
        if request_id is not None:
            message["id"] = request_id
        data = json.dumps(message).encode()
        request = urllib.request.Request(url, data=data, headers={
            "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2024-11-05"})
        # Loopback must stay loopback even in shells with proxy env variables.
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
            if request_id is None:
                return None
            result = json.load(response)
        if "error" in result:
            raise RuntimeError(f"{name}: {method} returned an MCP error: {result['error']}")
        return result["result"]

    init = rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                              "clientInfo": {"name": "shared-mcp-check", "version": "1"}}, 1)
    if init["serverInfo"]["name"] != name:
        raise RuntimeError(f"{name}: wrong MCP server on {url}")
    rpc("notifications/initialized", {})
    names = sorted(t["name"] for t in rpc("tools/list", {}, 2)["tools"])
    if not names:
        raise RuntimeError(f"{name}: empty tool list")
    if name == "flighty":
        result = rpc("tools/call", {"name": "search_airports", "arguments": {"query": "DXB"}}, 3)
        text = "\n".join(item.get("text", "") for item in result.get("content", []) if item.get("type") == "text")
        if result.get("isError") or re.search(r"\b(error|failed|failure|unable to|cannot|could not|can't|exception)\b", text, re.IGNORECASE):
            raise RuntimeError(text or "search_airports returned isError: true")
    return names


def main():
    failed = False
    for server in gh.load_manifest()["mcpServers"]:
        if server["id"] not in SHARED_IDS:
            continue
        try:
            interpreter = validate_plist(Path.home() / 'Library/LaunchAgents' /
                f"com.ardud.shared-mcp-{server['id']}.plist", require_interpreter=True)
            if server['id'] == 'inbody':
                validate_inbody(interpreter)
            names = probe(server["url"], server["id"])
            print(f"OK {server['id']} {server['url']} ({len(names)} tools)")
        except Exception as exc:
            print(f"FAIL {server['id']}: {type(exc).__name__}: {exc}", file=sys.stderr)
            if server["id"] == "flighty" and "unable to open database file" in str(exc).lower():
                binary = Path.home() / ".local/share/shared-mcp-flighty/python/bin/python3.12"
                print(f"FAIL flighty: cannot read the Flighty database; grant Full Disk Access to {binary}", file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
