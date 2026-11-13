#!/usr/bin/env python3
"""Check the shared servers with a real MCP initialize and tools/list."""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import generate_homes as gh
from opencode import SHARED_IDS


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
            raise RuntimeError(f"{name}: {method} returned an MCP error")
        return result["result"]

    init = rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                              "clientInfo": {"name": "shared-mcp-check", "version": "1"}}, 1)
    if init["serverInfo"]["name"] != name:
        raise RuntimeError(f"{name}: wrong MCP server on {url}")
    rpc("notifications/initialized", {})
    names = sorted(t["name"] for t in rpc("tools/list", {}, 2)["tools"])
    if not names:
        raise RuntimeError(f"{name}: empty tool list")
    return names


def main():
    failed = False
    for server in gh.load_manifest()["mcpServers"]:
        if server["id"] not in SHARED_IDS:
            continue
        try:
            names = probe(server["url"], server["id"])
            print(f"OK {server['id']} {server['url']} ({len(names)} tools)")
        except Exception as exc:
            print(f"FAIL {server['id']}: {type(exc).__name__}: {exc}", file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
