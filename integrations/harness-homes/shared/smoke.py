#!/usr/bin/env python3
"""Run with Flighty's venv Python; starts only temporary servers, never launchd."""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client
from mcp.server.fastmcp import FastMCP

from check import probe
from serve import configure, offload_sync_tools

HERE = Path(__file__).resolve().parent
FLIGHTY = Path.home() / ".local/share/flighty-mcp"
PYTHONS = {"flighty": FLIGHTY / ".venv/bin/python",
           "inbody": Path("/Volumes/ExternalSSD/inbody-api-mcp/.venv/bin/python")}


async def client_tools(url):
    async with streamablehttp_client(url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return sorted((t.model_dump(mode="json") for t in (await session.list_tools()).tools), key=lambda t: t["name"])


def rss_tree(pid):
    rows = {}
    for line in subprocess.check_output(["ps", "-axo", "pid,ppid,rss"], text=True).splitlines()[1:]:
        child, parent, rss = map(int, line.split())
        rows[child] = (parent, rss)
    owned = {pid}
    while True:
        added = {child for child, (parent, _) in rows.items() if parent in owned} - owned
        if not added:
            break
        owned |= added
    return {"processes": len(owned), "rssMiB": round(sum(rows[p][1] for p in owned if p in rows) / 1024, 2)}


async def stdio(name):
    command, args, cwd = {
        "flighty": ("/opt/homebrew/bin/uv", ["--directory", str(FLIGHTY), "run", "--no-sync", "--offline", "--quiet", "main.py"], None),
        "inbody": (str(Path.home() / "bin/inbody-mcp"), [], None),
        "cua-driver": (str(Path.home() / ".local/bin/cua-driver"), ["mcp"], None),
    }[name]
    started = time.monotonic()
    with tempfile.TemporaryFile(mode="w+") as log:
        async with stdio_client(StdioServerParameters(command=command, args=args, cwd=cwd), errlog=log) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                names = sorted((t.model_dump(mode="json") for t in (await session.list_tools()).tools), key=lambda t: t["name"])
                # stdio_client owns its direct child and reaps it on context exit.
                children = subprocess.check_output(["ps", "-axo", "pid,ppid"], text=True).splitlines()[1:]
                pids = [int(p) for line in children for p, pp in [line.split()] if int(pp) == os.getpid()]
                trees = [rss_tree(pid) for pid in pids if pid != os.getpid()]
                # ps itself has exited; ignore its absent/zero RSS entry.
                measurement = {"processes": sum(t["processes"] for t in trees if t["rssMiB"]),
                               "rssMiB": round(sum(t["rssMiB"] for t in trees), 2)}
                measurement["startupSeconds"] = round(time.monotonic() - started, 3)
                print(json.dumps({"server": name, "transport": "stdio", "tools": len(names), **measurement}), flush=True)
                return names


async def http(name, expected):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    url = f"http://127.0.0.1:{port}/mcp"
    started = time.monotonic()
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen([str(PYTHONS[name]), str(HERE / "serve.py"), name, "--port", str(port)],
                                   stdout=log, stderr=log)
        try:
            deadline = started + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"{name} HTTP exited with {process.returncode}")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"{name} HTTP startup")
                    await asyncio.sleep(0.05)
            startup = time.monotonic() - started
            lists = await asyncio.wait_for(asyncio.gather(*(client_tools(url) for _ in range(2))), timeout=30)
            assert lists == [expected, expected], f"{name}: stdio/HTTP tool contracts differ"
            assert await asyncio.to_thread(probe, url, name) == [t["name"] for t in expected]
            print(json.dumps({"server": name, "transport": "http", "clients": 2, "tools": len(expected),
                              "port": port, "startupSeconds": round(startup, 3), **rss_tree(process.pid)}), flush=True)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


async def main():
    for name in ("flighty", "inbody", "cua-driver"):
        expected = await asyncio.wait_for(stdio(name), timeout=45)
        if name in PYTHONS:
            await http(name, expected)
    await asyncio.wait_for(responsiveness(), timeout=15)
    print("PASS concurrent HTTP clients match complete stdio tool contracts; blocking-tool isolation passes; temporary processes reaped")


def fixture(port):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    released = Event()
    mcp = FastMCP("shared-mcp-fixture")

    @mcp.tool()
    def blocking() -> str:
        print("BLOCKING_STARTED", flush=True)
        released.wait()
        return "released"

    @mcp.tool()
    async def release() -> str:
        released.set()
        return "ok"

    with ThreadPoolExecutor(max_workers=1) as executor:
        offload_sync_tools(mcp, executor)
        configure(mcp, port).run(transport="streamable-http")


async def responsiveness():
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    url = f"http://127.0.0.1:{port}/mcp"
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--fixture", str(port)],
                                   stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            deadline = time.monotonic() + 5
            while True:
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise RuntimeError("fixture startup failed")
                    await asyncio.sleep(0.05)
            async with streamablehttp_client(url) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    call = asyncio.create_task(session.call_tool("blocking", {}))
                    try:
                        assert await asyncio.to_thread(process.stdout.readline) == "BLOCKING_STARTED\n"
                        # Client 2 must initialize, list and release while client 1
                        # is blocked. Success depends on ordering, not latency.
                        async with streamablehttp_client(url) as (read2, write2, _):
                            async with ClientSession(read2, write2) as second:
                                await second.initialize()
                                assert len((await second.list_tools()).tools) == 2
                                assert not (await second.call_tool("release", {})).isError
                        assert not (await call).isError
                    finally:
                        if not call.done():
                            call.cancel()
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            process.stdout.close()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        fixture(int(sys.argv[2]))
    else:
        asyncio.run(main())
