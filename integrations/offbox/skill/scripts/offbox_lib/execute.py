"""Owner-checked commands over the selected backend's control API."""

from __future__ import annotations

import contextlib
import json
import shlex
import sqlite3
import sys
import time

import toollog

from . import api, common, lease
from .identity import require_proven


def command(a, me: dict) -> int:
    started = time.monotonic()
    backend = "home" if api.BACKEND == "server" else "boat"
    args = list(a.cmd)
    box_id = args.pop(0) if args and args[0].startswith("bx_") else None
    shell = args[0] if len(args) == 1 else shlex.join(args)
    timeout = max(1, min(600, a.timeout))
    code, error_class = common.EXIT_INFRA, None
    metadata = {}
    try:
        require_proven(me, "exec")
        if not shell:
            raise common.OffboxError("usage: offbox exec [box_id] [opts] -- <command...>", code=2)
        with contextlib.closing(common.db()) as con:
            if not box_id:
                row = lease.find_lease(con, me["owner"], me["repo_root"])
                if not row:
                    raise common.OffboxError("no lease for this thread + repo (run `offbox run -- true` to create one)", code=2)
                box_id = row["box_id"]
            common.require_mine(con, box_id)
            if common.box_owner(con, box_id) is None:
                raise common.OffboxError(f"no local record for {box_id} on the {backend} backend; nothing was sent", code=2)
        result = api.cmd_sync(box_id, shell, timeout=timeout, cwd=a.cwd)
        if isinstance(result, dict):
            metadata = api.command_metadata(result)
        if (not isinstance(result, dict) or type(result.get("exitCode")) is not int
                or not 0 <= result["exitCode"] <= 255
                or any(not isinstance(result.get(stream, ""), str) for stream in ("stdout", "stderr"))):
            raise common.OffboxError(f"invalid command result from the {backend} backend")
        if a.json:
            print(json.dumps(result, indent=1))
        else:
            sys.stdout.write(result.get("stdout", ""))
            sys.stderr.write(result.get("stderr", ""))
        code = result["exitCode"]
        if code:
            error_class = "RemoteExit"
    except common.OffboxError as error:
        code, error_class = error.code, type(error).__name__
        if isinstance(error, api.ApiError):
            metadata = api.command_metadata(error.data)
        if isinstance(error, api.ApiError) and error.status == 408 and error.api_code == "command_timeout":
            data = error.data if isinstance(error.data, dict) else {}
            pid, queue_ms, run_ms = (metadata.get(key) for key in ("pid", "queueMs", "runMs"))
            if run_ms is not None and run_ms > 0:
                outcome = "stopped"
                outcome_line = (f"it started and was stopped after {run_ms / 1000:.1f}s; any side effects up to then "
                                "may have happened, and it will not run again.")
            elif queue_ms is not None:
                outcome = "never_started"
                outcome_line = "it never started; the server cancelled it and it will not run later."
            else:
                outcome = "cancelled_old_server"
                outcome_line = ("the server cancels timed-out commands, so it will not run later; "
                                f"check with offbox ssh {box_id} if a partial run matters.")
            if a.json:
                envelope = {**data, "offbox": {
                    "code": "command_timeout", "box": box_id, "timeoutSeconds": timeout, "pid": pid,
                    "queueMs": int(queue_ms) if queue_ms is not None else None,
                    "runMs": int(run_ms) if run_ms is not None else None,
                    "killed": metadata.get("killed"), "outcome": outcome,
                }}
                common.out(json.dumps(envelope, indent=1))
            else:
                for stream, target in (("stdout", sys.stdout), ("stderr", sys.stderr)):
                    value = data.get(stream, "")
                    if isinstance(value, str):
                        target.write(value)
            timings = []
            if queue_ms is not None:
                timings.append(f"waited {queue_ms / 1000:.1f}s in the server's run queue")
            if run_ms is not None:
                timings.append(f"ran {run_ms / 1000:.1f}s")
            if timings:
                if metadata.get("killed"):
                    timings.append("killed")
                detail = (f"server command {pid}: " if pid is not None else "") + ", ".join(timings)
            else:
                detail = (f"server command {pid}" if pid is not None else
                          "the server sent no command id or timings: the home server is older than the exec queue fix")
            common.say(f"offbox exec: command ran past --timeout {timeout}s on {box_id} "
                       f"({detail}); nothing fell back locally")
            if queue_ms is not None and queue_ms >= timeout * 500:
                common.say("offbox exec: the command was waiting behind other runs on the home server, not running; "
                           f"retry, or use offbox ssh {box_id} '<cmd>' for a quick read.")
            common.say(f"offbox exec: {outcome_line}")
        elif isinstance(error, api.ApiError) and error.status == 404:
            common.say(f"box not found on the {backend} backend: {box_id}; exec has no local fallback")
        else:
            suffix = "; exec has no local fallback" if code == common.EXIT_INFRA else ""
            common.say(str(error) + suffix)
    except sqlite3.Error as error:
        code, error_class = common.local_error(error).code, type(error).__name__
        common.say(str(common.local_error(error)))
    except KeyboardInterrupt:
        code, error_class = 130, "KeyboardInterrupt"
    except Exception as error:  # API/transport failures must not log an exception body that could echo the command.
        error_class = type(error).__name__
        common.say(f"exec failed on the {backend} backend ({error_class}); exec has no local fallback")
    finally:
        props = {"backend": backend, "exitCode": code, "timeoutSeconds": timeout, "commandLength": len(shell)}
        props.update(metadata)
        if error_class:
            props["errorClass"] = error_class
        toollog.emit("cli", "exec.error" if error_class else "exec.done", kind="error" if error_class else "event",
                     duration_ms=(time.monotonic() - started) * 1000, ok=code == 0,
                     ids={"box": box_id, "owner": me.get("owner"), "thread": me.get("thread")},
                     props=props, tag=error_class)
    return code
