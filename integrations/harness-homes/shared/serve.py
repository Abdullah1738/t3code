#!/usr/bin/env python3
"""Expose the installed Flighty/InBody FastMCP instance over loopback HTTP."""
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import contextvars
from functools import partial, wraps
import importlib
import os
import site
import subprocess
import sys
from pathlib import Path


def configure(mcp, port, server=None):
    mcp.settings.host = "127.0.0.1"
    mcp.settings.port = port
    mcp.settings.stateless_http = True
    mcp.settings.json_response = True
    mcp.settings.log_level = "WARNING"
    if server is not None:
        from request_log import RequestLogMiddleware
        factory = mcp.streamable_http_app
        tools = frozenset(tool.name for tool in mcp._tool_manager.list_tools())

        def logged_app():
            app = factory()
            app.add_middleware(RequestLogMiddleware, server=server, tools=tools)
            return app

        mcp.streamable_http_app = logged_app
    return mcp


def keychain_value(service):
    result = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", service, "-a", "ardud", "-w"],
        capture_output=True, text=True, timeout=10, check=False)
    return result.stdout.rstrip("\n") if result.returncode == 0 else ""


def offload_sync_tools(mcp, executor):
    def offloaded(fn):
        @wraps(fn)
        async def run(*args, **kwargs):
            call = partial(contextvars.copy_context().run, fn, *args, **kwargs)
            return await asyncio.get_running_loop().run_in_executor(executor, call)
        return run

    # MCP SDK 1.x runs synchronous callbacks on the HTTP event loop. Adapt only
    # execution, retaining the registered schemas/metadata. One worker keeps the
    # cached InBody login serialized, including after a caller cancels its wait.
    for tool in mcp._tool_manager.list_tools():
        if not tool.is_async:
            tool.fn = offloaded(tool.fn)
            tool.is_async = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("server", choices=("flighty", "inbody"))
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    if not 0 < args.port < 65536:
        parser.error("port must be between 1 and 65535")
    if args.server == "flighty":
        source = Path.home() / ".local/share/flighty-mcp"
        site_dirs = sorted(path for path in source.glob(".venv/lib/python3.*/site-packages") if path.is_dir())
        if len(site_dirs) != 1:
            raise SystemExit(f"flighty: expected exactly one venv site-packages directory under {source / '.venv/lib'}; found {len(site_dirs)}")
        site.addsitedir(str(site_dirs[0]))
        sys.path.insert(0, str(source))
        mcp = importlib.import_module("main").mcp
    else:
        # Match ~/bin/inbody-mcp without writing credentials to argv or disk.
        for key, service in (("INBODY_LOGIN_ID", "inbody-login-id"),
                             ("INBODY_LOGIN_PW", "inbody-password"),
                             ("INBODY_COUNTRY_CODE", "inbody-country")):
            os.environ[key] = keychain_value(service)
        os.environ["INBODY_COUNTRY_CODE"] = os.environ["INBODY_COUNTRY_CODE"] or "AE"
        if not os.environ["INBODY_LOGIN_ID"] or not os.environ["INBODY_LOGIN_PW"]:
            raise SystemExit("inbody: credentials missing from Keychain")
        # The upstream client logs account and token fragments at INFO on login.
        import logging
        logging.getLogger("inbody_api_mcp.client").setLevel(logging.WARNING)
        mcp = importlib.import_module("inbody_api_mcp.server").mcp
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="mcp-tools") as executor:
        offload_sync_tools(mcp, executor)
        configure(mcp, args.port, args.server).run(transport="streamable-http")


if __name__ == "__main__":
    main()
