#!/opt/homebrew/bin/python3
"""Claude/Codex hook entry point. Stdout is reserved for hook JSON."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from recall_hook_state import Store, new_turn

DEFAULTS = {
    "mode": "on", "url": "http://127.0.0.1:18765", "wait_ms": 5000, "timeout_ms": 12000,
    "only_dirs": [], "work": True, "work_subagents": True,
    "work_first_steps": 8, "work_first_ms": 90000, "work_every_steps": 8,
    "work_min_ms": 150000, "work_error_ms": 90000, "work_max_backoff": 8,
    "work_max_checks": 8, "note_ttl_days": 14,
}
SKIP_PREFIXES = ("[Compressed conversation section]", "<shell id=", "<system-update>",
                 "<skill_content", "<recall>", "<subagent sessionID=", "<dcp-system-reminder>",
                 "This session is being continued from a previous conversation")


def state_path() -> str:
    return os.environ.get("RECALL_HOOK_STATE", os.path.expanduser("~/.local/state/recall-hooks/state.db"))


def log_error(where: str, error: Exception):
    # Exception details can contain request URLs, user content or credentials.
    try:
        path = Path(os.environ.get("RECALL_HOOK_LOG", str(Path(state_path()).parent / "hook.log")))
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as out:
            out.write(f"{int(time.time())} {where}: {type(error).__name__}\n")
    except Exception:
        pass


def config() -> dict:
    path = os.environ.get("RECALL_PLUGIN_CONFIG", os.path.expanduser("~/.config/opencode/recall.json"))
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
        return {**DEFAULTS, **value} if isinstance(value, dict) else dict(DEFAULTS)
    except FileNotFoundError:
        return dict(DEFAULTS)
    except (ValueError, OSError) as exc:
        log_error("config", exc)
        return {**DEFAULTS, "mode": "off"}


def post(url: str, body: dict, timeout: float) -> dict:
    def expired(_signum, _frame):
        raise TimeoutError("recall deadline")

    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    try:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            value = json.load(response)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
    if not isinstance(value, dict):
        raise ValueError("invalid response")
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def control_origin(url: str) -> str | None:
    """Credentials are only sent to an explicit, loopback HTTP origin."""
    try:
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1") or
            parsed.username is not None or parsed.password is not None or parsed.port == 0 or
            parsed.path not in ("", "/") or parsed.query or parsed.fragment or
            any(ord(c) <= 32 or ord(c) == 127 for c in url)):
            return None
        return url.rstrip("/")
    except (TypeError, ValueError):
        return None


def resolve(harness: str, event: dict) -> dict | None:
    """C1 resolves a Claude (session, agent), or Codex concrete thread."""
    session = event.get("session_id")
    agent = event.get("agent_id")
    if not isinstance(session, str) or not session or len(session) > 200:
        return None
    native = session
    params = {"nativeId": native, "driver": "claudeAgent" if harness == "claude" else "codex"}
    if harness == "claude" and isinstance(agent, str) and agent:
        params["agentId"] = agent
    elif harness == "codex" and isinstance(agent, str) and agent:
        # Codex's hook session_id is shared; agent_id is the concrete thread.
        params["nativeId"] = agent
    elif harness == "codex" and os.environ.get("CODEX_THREAD_ID"):
        params["nativeId"] = os.environ["CODEX_THREAD_ID"]
    instance = os.environ.get("ROBOB_PROVIDER_INSTANCE_ID")
    if instance:
        params["instance"] = instance
    token_path = os.environ.get("T3_CONTROL_TOKEN_FILE", os.path.expanduser("~/.robob/components/harness-hooks.json"))
    token = os.environ.get("T3_CONTROL_TOKEN")
    url = os.environ.get("T3_CONTROL_URL")
    stored = {}
    if not (token and url):
        try:
            with open(token_path, encoding="utf-8") as f:
                stored = json.load(f)
        except FileNotFoundError:
            stored = {}
        token = token or stored.get("token")
    if not token:
        return None
    url = control_origin(url or stored.get("url") or "http://127.0.0.1:3773")
    if not url:
        return None
    req = urllib.request.Request(url + "/api/ardud/control/identity/resolve?" +
                                 urllib.parse.urlencode(params),
                                 headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({})).open(req, timeout=0.8) as response:
            identity = json.load(response).get("identity")
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            return None
        raise
    if not isinstance(identity, dict) or identity.get("resolution") != "resolved":
        return None
    if not all(isinstance(identity.get(k), str) and identity[k] for k in
               ("robobThreadId", "rootThreadId", "executionKind", "driver", "providerInstanceId")):
        return None
    if identity["driver"] != params["driver"]:
        return None
    if instance and identity["providerInstanceId"] != instance:
        return None
    identity["_native"] = params["nativeId"]
    identity["_agent"] = params.get("agentId")
    return identity


def key_of(identity: dict) -> str:
    return json.dumps([identity["driver"], identity["providerInstanceId"],
                       identity["robobThreadId"], identity.get("_agent")], separators=(",", ":"))


def seed_key(harness: str, event: dict, instance: str) -> str:
    return json.dumps([harness, instance, event.get("session_id"), event.get("agent_id")],
                      separators=(",", ":"))


def pending_seed_key(harness: str, event: dict) -> str:
    return "pending:" + seed_key(harness, event, os.environ.get("ROBOB_PROVIDER_INSTANCE_ID") or "")


def transcript_offset(path: str | None) -> int | None:
    try:
        return os.stat(path).st_size if isinstance(path, str) else None
    except OSError:
        return None


def native_key(harness: str, event: dict) -> str | None:
    session, agent = event.get("session_id"), event.get("agent_id")
    if not isinstance(session, str) or not session or len(session) > 200:
        return None
    if agent is not None and (not isinstance(agent, str) or len(agent) > 200):
        return None
    # Codex sometimes carries its concrete native thread in the environment.
    # Keep the original session as well: two sessions must never share a guard.
    thread = os.environ.get("CODEX_THREAD_ID") if harness == "codex" and not agent else None
    return json.dumps([harness, os.environ.get("ROBOB_PROVIDER_INSTANCE_ID") or "",
                       session, agent or None, thread or None], separators=(",", ":"))


def body_base(identity: dict, event: dict, cfg: dict) -> dict:
    return {
        "session_id": identity["robobThreadId"], "parent_id": identity.get("parentThreadId"),
        "caller_thread": identity["robobThreadId"], "caller_native": identity["_native"],
        "caller_driver": identity["driver"], "caller_agent": identity.get("_agent"),
        "cwd": event.get("cwd") or "", "timeout": min(12, max(0.1, float(cfg["timeout_ms"]) / 1000)),
    }


def text(value) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))


def result_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        inner = next((value[k] for k in ("value", "text", "output") if value.get(k) is not None), None)
        if isinstance(inner, str):
            return inner
        if isinstance(inner, list):
            return "\n".join(x if isinstance(x, str) else x.get("text", "")
                             if isinstance(x, dict) and isinstance(x.get("text"), str) else "" for x in inner)
        if inner is not None:
            value = inner
    return js_head(text(value), 4000)


def js_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def js_head(value: str, length: int) -> str:
    return value.encode("utf-16-le", "surrogatepass")[:length * 2].decode("utf-16-le", "surrogatepass")


def js_tail(value: str, length: int) -> str:
    return value.encode("utf-16-le", "surrogatepass")[-length * 2:].decode("utf-16-le", "surrogatepass")


def squash(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def clip(value: str, length: int) -> str:
    return value if js_length(value) <= length else js_head(value, length) + "…"


QUIET_TOOLS = re.compile(r"(^|[_.-])(read|grep|glob|list|ls|search|fetch|view|skill|todo)", re.I)
STRONG_ERR = re.compile(r"Traceback \(most recent call last\)|^\s*(?:error|fatal|panic)\b[\s:\[]|"
                        r"command not found|No such file or directory|Permission denied|Connection refused|"
                        r"ECONNREFUSED|ETIMEDOUT|AssertionError|Unhandled exception", re.I | re.M)
EXIT_RE = re.compile(r"\b(?:exit code|exit status|exited with code|returned non-zero exit status):? ([1-9]\d*)", re.I)
NO_MATCH_OK = re.compile(r'(^|[|;&(]\s*|\bxargs\s+|"command":\s*")(grep|egrep|fgrep|rg|ag|diff|cmp|test|\[)\b')


def looks_failed(result: str, command: str) -> bool:
    sample = js_head(result, 400) + "\n" + js_tail(result, 1500)
    if STRONG_ERR.search(sample) or re.search(r"\bFAILED\b", sample):
        return True
    match = EXIT_RE.search(sample)
    return bool(match and not (match.group(1) == "1" and NO_MATCH_OK.search(command)))


def append_activity(state: dict, lines: list[str]):
    retained = []
    size = 0
    prior = [line for item in state["activity"] for line in item.split("\n")]
    for line in reversed(prior + lines):
        length = js_length(line)
        if size + length > 6000:
            break
        retained.append(line)
        size += length + 1
    state["activity"] = list(reversed(retained))


def should_skip_prompt(prompt: str) -> bool:
    if not prompt.strip() or prompt.lstrip().startswith(SKIP_PREFIXES):
        return True
    # Use the server's exact ack, slash, automation and boilerplate rules.
    import recall_ask
    return recall_ask.should_skip(prompt) is not None


def turn_id(harness: str, event: dict) -> str | None:
    value = event.get("prompt_id") if harness == "claude" else event.get("turn_id")
    return value if isinstance(value, str) and value else None


def transcript_task(harness: str, path: str | None, agent_id: str,
                    session_id: str | None = None, child_path: str | None = None,
                    parent_path: str | None = None, after_offset: int | None = None) -> str | None:
    """Only use an unambiguous authored task; the on-disk transcript can lag."""
    try:
        with open(path, "rb") as file:
            file.seek(0, os.SEEK_END)
            size = file.tell()
            file.seek(min(size, after_offset) if after_offset is not None else max(0, size - 1_000_000))
            records = file.read().decode("utf-8", "replace").splitlines()
    except (OSError, TypeError):
        records = []
    matches = []
    for line in records:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if harness == "claude" and entry.get("type") == "assistant":
            message = entry.get("message") or {}
            for block in message.get("content", []) if isinstance(message, dict) else []:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                args = block.get("input") or {}
                if isinstance(args, dict):
                    if block.get("name") in ("Agent", "Task") and args.get("resume") == agent_id and isinstance(args.get("prompt"), str):
                        matches.append(args["prompt"])
                    elif block.get("name") == "SendMessage" and args.get("to") == agent_id and isinstance(args.get("message"), str):
                        matches.append(args["message"])
        elif harness == "codex":
            payload = entry.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            if payload.get("type") == "event_msg" and isinstance(payload.get("payload"), dict):
                payload = payload["payload"]
            if payload.get("type") in ("user_message", "task_started") and isinstance(payload.get("message"), str):
                matches.append(payload["message"])
            elif payload.get("type") == "message" and payload.get("role") == "user":
                chunks = payload.get("content") or []
                value = "\n".join(x.get("text", "") for x in chunks if isinstance(x, dict))
                if value:
                    matches.append(value)
    clean = [value for value in matches if value.strip() and not value.lstrip().startswith(SKIP_PREFIXES)]
    # Choosing the latest of multiple candidates could silently assign another task.
    if clean:
        return clean[0][:6000] if len(set(clean)) == 1 else None
    if (after_offset is not None or harness != "claude" or not isinstance(session_id, str) or
        not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", session_id) or
        not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", agent_id)):
        return None
    candidates = []
    for value in (child_path, path, parent_path):
        if not isinstance(value, str) or not value:
            continue
        candidate = Path(value)
        if candidate.name == f"agent-{agent_id}.jsonl":
            candidates.append(candidate)
        elif candidate.name == f"{session_id}.jsonl":
            candidates.append(candidate.with_suffix("") / "subagents" / f"agent-{agent_id}.jsonl")
    for candidate in dict.fromkeys(candidates):
        try:
            with candidate.open("rb") as file:
                # The first message, not the tail, identifies a fresh child task.
                records = file.read(1_000_000).decode("utf-8", "replace").splitlines()
        except OSError:
            continue
        for line in records:
            try:
                entry = json.loads(line)
            except ValueError:
                return None
            if entry.get("type") not in ("user", "assistant"):
                continue
            message = entry.get("message") or {}
            if (entry.get("type") != "user" or entry.get("agentId") != agent_id or
                entry.get("sessionId") != session_id or entry.get("isSidechain") is not True or
                "parentUuid" not in entry or entry["parentUuid"] is not None or not isinstance(message, dict) or
                message.get("role") != "user"):
                return None
            content = message.get("content")
            if isinstance(content, list) and content and all(
                    isinstance(block, dict) and block.get("type") == "text" and
                    isinstance(block.get("text"), str) for block in content):
                content = "\n".join(block["text"] for block in content)
            if isinstance(content, str) and content.strip() and not content.lstrip().startswith(SKIP_PREFIXES):
                return content[:6000]
            return None
    return None


def fallback_prompt_id(event: dict, prompt: str) -> str:
    # Without a native ID, a transcript cursor disambiguates repeated prompts.
    path = event.get("transcript_path")
    try:
        stat = os.stat(path) if isinstance(path, str) else None
        cursor = (stat.st_dev, stat.st_ino, stat.st_size) if stat else None
    except OSError:
        cursor = None
    digest = hashlib.sha256(json.dumps([cursor, prompt], ensure_ascii=False).encode()).hexdigest()
    return "prompt:" + digest


def next_turn(state: dict | None, tid: str, task: str, now: float, provisional: bool) -> dict:
    retired = list(state.get("retired_turns", [])) if state else []
    if state and state.get("turn"):
        retired.append(state["turn"])
    if state and state.get("ended_turn"):
        retired.append(state["ended_turn"])
    # An unseen ID from an unresolved preceding turn is indistinguishable from
    # this turn's first ID, so do not guess until a later explicit prompt ID.
    blocked = bool(provisional and state and state.get("provisional"))
    result = new_turn(tid, task, now, state.get("task", "") if state else "", provisional,
                      list(dict.fromkeys(retired)), blocked)
    if state and "execution_generation" in state:
        result["execution_generation"] = state["execution_generation"]
    return result


def wrapped(note: str) -> str:
    note = note.strip()
    if note.startswith("<recall>") and note.endswith("</recall>"):
        return note
    return "<recall>\n" + note + "\n</recall>"


def output(event: str, note: str | None):
    if note and event in ("UserPromptSubmit", "PostToolUse", "PostToolUseFailure"):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event,
                                                "additionalContext": wrapped(note)}}), flush=True)


def add_activity(state: dict, event: dict, now: float):
    tool_id = event.get("tool_use_id") or event.get("tool_call_id")
    if tool_id and tool_id in state["seen_tools"]:
        return
    if tool_id:
        state["seen_tools"] = (state["seen_tools"] + [tool_id])[-1000:]
    step = event.get("assistant_message_id") or event.get("model_request_id")
    if step:
        if step not in state["seen_steps"]:
            state["calls"] += 1
            state["seen_steps"] = (state["seen_steps"] + [step])[-1000:]
    elif state["last_event"] is None or now - state["last_event"] >= 2:
        # Approximate parallel tool batches; Codex PreModelRequest can replace this later.
        state["calls"] += 1
    state["last_event"] = now
    name = str(event.get("tool_name") or "tool")[:100]
    name = "tool" if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", name) else name
    raw_input = event.get("tool_input")
    inp = js_head(text(raw_input), 2000) if raw_input is not None else ""
    value = next((event[k] for k in ("tool_response", "tool_result", "error") if event.get(k) is not None), None)
    result = result_text(value)
    failure = (event.get("hook_event_name") == "PostToolUseFailure" or event.get("is_error") is True or
               isinstance(value, dict) and value.get("type") == "error" or
               not QUIET_TOOLS.search(name) and looks_failed(result, inp))
    lines = [f"call {name}: {clip(squash(js_head(inp, 600)), 240)}"]
    if failure:
        err = clip(f"{name}: {clip(squash(js_head(result, 300)), 200)} … {squash(js_tail(result, 500))}", 700)
        normalized = re.sub(r"\d+", "#", re.sub(r"(?:0x)?[0-9a-f]{8,}", "#", squash(js_tail(result, 300)), flags=re.I))
        sig = hashlib.sha256((name + "|" + normalized).encode("utf-8", "surrogatepass")).hexdigest()
        state["errors"] = (state["errors"] + [[sig, err]])[-100:]
        lines.append("FAILED " + err)
    else:
        lines.append(f"result {name}: {clip(squash(js_head(result, 400)), 160)}")
    append_activity(state, lines)


def prepare_work(state: dict, cfg: dict, now: float) -> bool:
    if state.get("inflight") or state["checks"] >= int(cfg["work_max_checks"]):
        return False
    if not state["activity"] or not state["task"]:
        return False
    if not state["checks"]:
        return state["calls"] >= int(cfg["work_first_steps"]) and (now - state["started"]) * 1000 >= float(cfg["work_first_ms"])
    steps = state["calls"] - state["last_step"]
    elapsed = (now - state["last_check"]) * 1000
    regular = steps >= int(cfg["work_every_steps"]) and elapsed >= float(cfg["work_min_ms"]) * state["backoff"]
    new_error = any(sig not in state["seen_errors"] for sig, _ in state["errors"])
    early = steps >= 2 and new_error and elapsed >= float(cfg["work_error_ms"]) * state["backoff"]
    return regular or early


def launch(job: str, kind: str = "work"):
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker", job],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     close_fds=True, start_new_session=True)


def worker(job: str):
    cfg = config()
    db = Store(state_path(), cfg["note_ttl_days"])
    try:
        with db.transaction():
            row = db.job(job)
            if row and not db.job_is_current(job):
                db.finish(job, None, time.time(), cfg["mode"], int(cfg["work_max_backoff"]))
                return
        if not row:
            return
        _, _, body = row
        try:
            result = post(os.environ.get("RECALL_INJECT_URL", cfg["url"].rstrip("/") + "/api/inject"),
                          body, body["timeout"])
        except Exception as exc:
            log_error("work", exc)
            result = None
        current = config()
        with db.transaction():
            db.finish(job, result if current["mode"] != "off" else None,
                      time.time(), current["mode"], int(cfg["work_max_backoff"]))
    finally:
        db.close()


def handle(harness: str, event: dict):
    cfg = config()
    name = event.get("hook_event_name")
    # Cleanup is traffic-driven, including disabled and filtered hook calls.
    if os.path.exists(state_path()):
        db = Store(state_path(), cfg["note_ttl_days"])
        try:
            with db.transaction():
                db.prune(time.time())
        finally:
            db.close()
    if name not in ("UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SubagentStart",
                    "Stop", "SubagentStop", "SessionEnd"):
        return
    native = native_key(harness, event)
    if name in ("Stop", "SubagentStop", "SessionEnd"):
        # Cleanup still runs if recall was disabled mid-turn, without creating a new database.
        if not native or not os.path.exists(state_path()):
            return
        db = Store(state_path(), cfg["note_ttl_days"])
        try:
            with db.transaction():
                if name == "SubagentStop":
                    db.drop_seeds_for_native(harness, event.get("session_id"), event.get("agent_id"),
                                             turn_id(harness, event))
                now = time.time()
                db.prune(now)
                db.end_turn(native, turn_id(harness, event), now)
        finally:
            db.close()
        return
    if name == "PostToolUseFailure" and harness != "claude":
        return
    cwd = event.get("cwd") or ""
    dirs = cfg.get("only_dirs")
    enabled = (cfg["mode"] in ("on", "observe") and not (
        isinstance(dirs, list) and dirs and not any(isinstance(d, str) and d and cwd.startswith(d) for d in dirs)))
    if not enabled:
        if name in ("UserPromptSubmit", "SubagentStart") and native and os.path.exists(state_path()):
            # Even a suppressed prompt or child start is a turn boundary. Quarantine its old
            # state and supersede any earlier identity lookup without network I/O.
            db = Store(state_path(), cfg["note_ttl_days"])
            try:
                with db.transaction():
                    generation = uuid.uuid4().hex
                    db.guard_prompt(native, generation)
                    db.prune(time.time())
                    if event.get("agent_id"):
                        db.drop_seeds_for_native(harness, event.get("session_id"), event.get("agent_id"), None)
                    db.invalidate_prompt(native, generation, time.time())
            finally:
                db.close()
        return
    child_id = event.get("agent_id")
    seed = None
    if (name == "SubagentStart" and cfg["work"] and cfg["work_subagents"] and
        isinstance(child_id, str) and child_id and isinstance(event.get("session_id"), str) and event["session_id"]):
        seed = {"path": event.get("transcript_path"), "child_path": event.get("agent_transcript_path"),
                "started": time.time(), "turn": turn_id(harness, event),
                "resume_offset": transcript_offset(event.get("transcript_path"))}
        db = Store(state_path(), cfg["note_ttl_days"])
        try:
            with db.transaction():
                # Quarantine any existing execution before a slow or failed
                # identity lookup can expose its mailbox to the next hook.
                generation = uuid.uuid4().hex
                db.guard_prompt(native, generation)
                db.invalidate_prompt(native, generation, seed["started"])
                db.seed(pending_seed_key(harness, event), seed, seed["started"])
        finally:
            db.close()
    identity_event = event
    if not native:
        return
    prompt_generation = uuid.uuid4().hex if name == "UserPromptSubmit" else None
    if prompt_generation:
        db = Store(state_path(), cfg["note_ttl_days"])
        try:
            with db.transaction():
                # Commit the guard before the network lookup so tool hooks and
                # workers cannot deliver an older turn while it is pending.
                db.guard_prompt(native, prompt_generation)
        finally:
            db.close()
    try:
        identity = resolve(harness, identity_event)
    except Exception:
        if prompt_generation:
            db = Store(state_path(), cfg["note_ttl_days"])
            try:
                with db.transaction():
                    db.invalidate_prompt(native, prompt_generation, time.time())
            finally:
                db.close()
        raise
    if not identity:
        if prompt_generation:
            db = Store(state_path(), cfg["note_ttl_days"])
            try:
                with db.transaction():
                    db.invalidate_prompt(native, prompt_generation, time.time())
            finally:
                db.close()
        return
    is_child = identity["executionKind"] != "top-level"
    if is_child and not (cfg["work"] and cfg["work_subagents"]):
        return
    db = Store(state_path(), cfg["note_ttl_days"])
    key = key_of(identity)
    now = time.time()
    pending, pending_generation, job, prompt_job = None, None, None, None
    try:
        if name == "SubagentStart":
            if seed and is_child:
                # Start is the execution boundary, even when prompt_id is reused.
                # A late old tool event may nudge this generation's cadence or
                # activity; lineage exclusion still covers the whole tree.
                with db.transaction():
                    if not db.prompt_is_current(native, generation):
                        return
                    old = db.get(key)
                    skey = seed_key(harness, event, identity["providerInstanceId"])
                    started = db.start_child(key, native, turn_id(harness, event), now, seed=seed,
                                             seed_key=skey, pending_key=pending_seed_key(harness, event))
                    seed["restarted"] = old is not None or started["execution_generation"] > 1
                    db.seed(skey, seed, now, owner_key=key)
                    db.release_prompt(native, generation)
            return
        with db.transaction():
            db.prune(now)
            if prompt_generation:
                if not db.prompt_is_current(native, prompt_generation):
                    return
                db.invalidate_prompt(native, prompt_generation, now, except_key=key)
            elif db.prompt_guarded(native):
                # A start may have preceded its canonical identity projection.
                # Recover it when identity becomes available, still atomically.
                pending_start = db.get_seed(pending_seed_key(harness, event)) if is_child else None
                if not pending_start:
                    return
                current_guard = db.db.execute("SELECT generation FROM prompt_guards WHERE native_key=?", (native,)).fetchone()
                if not current_guard:
                    return
                old = db.get(key)
                skey = seed_key(harness, event, identity["providerInstanceId"])
                started = db.start_child(key, native, pending_start.get("turn"), pending_start["started"],
                                         seed=pending_start, seed_key=skey,
                                         pending_key=pending_seed_key(harness, event))
                pending_start["restarted"] = old is not None or started["execution_generation"] > 1
                db.seed(skey, pending_start, now, owner_key=key)
                db.release_prompt(native, current_guard[0])
            state = db.get(key)
            if state and state.get("_native_key") != native:
                # Existing pre-guard state cannot be safely bound retroactively.
                if name != "UserPromptSubmit":
                    return
                db.discard_turn(key, state)
                state = None
            if is_child and state and state.get("invalidated") and name != "UserPromptSubmit":
                return
            if is_child:
                skey = seed_key(harness, event, identity["providerInstanceId"])
                pending_seed = db.take_seed(pending_seed_key(harness, event))
                seed = db.get_seed(skey)
                if pending_seed and (not seed or pending_seed["started"] > seed["started"]):
                    seed = pending_seed
                    db.seed(skey, seed, now)
                tid = turn_id(harness, event)
                if seed and not state:
                    if seed.get("turn") and tid and seed["turn"] != tid:
                        return
                    state = new_turn(tid or ("seed:" + str(child_id)), "", seed.get("started", now),
                                     provisional=not bool(tid))
                    state["_native_key"] = native
                if state and not state["task"]:
                    seed = seed or {}
                    offset = seed.get("resume_offset") if seed.get("restarted") else None
                    task = None if seed.get("restarted") and offset is None else transcript_task(
                        harness, event.get("transcript_path") or seed.get("path"),
                        str(child_id or ""), event.get("session_id"),
                        event.get("agent_transcript_path") or seed.get("child_path"),
                        seed.get("path"), offset)
                    if task:
                        state["task"] = task
                        db.take_seed(skey)
            if state and state.get("invalidated") and name != "UserPromptSubmit":
                return
            tid = turn_id(harness, event)
            if name == "UserPromptSubmit":
                prompt = event.get("prompt")
                skipped = not isinstance(prompt, str) or should_skip_prompt(prompt)
                if not tid:
                    tid = fallback_prompt_id(event, prompt if isinstance(prompt, str) else "")
                    provisional = True
                else:
                    provisional = False
                if skipped:
                    if state:
                        db.discard_turn(key, state)
                    state = next_turn(state, tid, "", now, provisional)
                    state["_native_key"] = native
                    db.save(key, state, now)
                    db.release_prompt(native, prompt_generation)
                    return
                if not state or state.get("invalidated") or state["turn"] != tid or state["task"] != prompt[:6000]:
                    if state:
                        db.discard_turn(key, state)
                    state = next_turn(state, tid, prompt, now, provisional)
                state["_native_key"] = native
                if is_child:
                    db.save(key, state, now)
                    db.release_prompt(native, prompt_generation)
                    return
                if not db.prompt_guarded(native):
                    pending = db.consume(key, tid, cfg["mode"])
                    if pending:
                        pending_generation = (state.get("generation"), state.get("execution_generation", 0))
                if not state["prompt_checked"]:
                    state["prompt_checked"] = True
                    prompt_body = {**body_base(identity, event, cfg), "mode": "prompt", "prompt": prompt,
                                   "context": state["previous"], "known": db.recent(key), "already": state["cited"][-100:]}
                    prompt_job = db.enqueue(key, state, prompt_body, now)
                state_generation = state.get("generation")
                db.save(key, state, now)
                db.release_prompt(native, prompt_generation)
            else:
                if not state:
                    return
                # Native versions may omit the prompt/turn ID on tool events;
                # use the saved active turn until another prompt replaces it.
                if not is_child and tid and state["turn"] != tid:
                    if not db.adopt_turn(key, state, tid):
                        return
                pending = db.consume(key, state["turn"], cfg["mode"])
                if pending:
                    pending_generation = (state.get("generation"), state.get("execution_generation", 0))
                if cfg["work"]:
                    add_activity(state, event, now)
                    if state.get("inflight"):
                        stale = db.db.execute("SELECT created FROM jobs WHERE id=?", (state["inflight"],)).fetchone()
                        if not stale or now - stale[0] > 30:
                            state["inflight"] = None
                    if prepare_work(state, cfg, now):
                        state["checks"] += 1
                        state["last_step"], state["last_check"] = state["calls"], now
                        state["seen_errors"] = list(dict.fromkeys(state["seen_errors"] + [x[0] for x in state["errors"]]))[-300:]
                        activity = "\n".join(state["activity"]).strip()
                        known = db.parent_recent(identity) + db.recent(key)
                        work_body = {**body_base(identity, event, cfg), "mode": "work", "prompt": state["task"],
                                     "activity": activity, "errors": [x[1] for x in state["errors"][-3:]],
                                     "known": known, "already": state["cited"][-100:]}
                        job = db.enqueue(key, state, work_body, now)
                db.save(key, state, now)
        if job:
            try:
                launch(job)
            except Exception as exc:
                log_error("launch", exc)
                with db.transaction():
                    db.finish(job, None, time.time(), cfg["mode"], int(cfg["work_max_backoff"]))
        if prompt_job:
            try:
                launch(prompt_job, "prompt")
                deadline = time.monotonic() + min(12.5, max(0, float(cfg["wait_ms"]) / 1000))
                while time.monotonic() < deadline:
                    with db.transaction():
                        current = db.get(key)
                        if (not current or current.get("generation") != state_generation or
                            current.get("invalidated") or db.prompt_guarded(native)):
                            break
                        if current.get("prompt_inflight") != prompt_job:
                            note = db.consume(key, current["turn"], config()["mode"])
                            if note:
                                pending_generation = (current.get("generation"), current.get("execution_generation", 0))
                            pending = "\n".join(x for x in (pending, note) if x)
                            break
                    time.sleep(min(0.02, max(0, deadline - time.monotonic())))
            except Exception as exc:
                log_error("prompt-launch", exc)
                with db.transaction():
                    db.db.execute("DELETE FROM jobs WHERE id=?", (prompt_job,))
                    current = db.get(key)
                    if current and current.get("prompt_inflight") == prompt_job:
                        current["prompt_inflight"] = None
                        db.save(key, current, time.time())
        if pending:
            # The same lock protects the boundary and the final write: consuming
            # a note does not reserve delivery across a newer execution.
            with db.transaction():
                current = db.get(key)
                latest = config()
                dirs = latest.get("only_dirs")
                allowed = not (isinstance(dirs, list) and dirs and
                               not any(isinstance(d, str) and d and cwd.startswith(d) for d in dirs))
                if (current and not current.get("invalidated") and not db.prompt_guarded(native)
                    and current.get("_native_key") == native and latest["mode"] == "on" and allowed
                    and pending_generation == (current.get("generation"), current.get("execution_generation", 0))
                    and db._current_generation(key, current) == pending_generation[1]):
                    output(name, pending)
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--harness", choices=("claude", "codex"))
    parser.add_argument("--worker")
    args = parser.parse_args()
    try:
        if args.worker:
            worker(args.worker)
        elif args.harness:
            value = json.load(sys.stdin)
            if isinstance(value, dict):
                handle(args.harness, value)
    except Exception as exc:
        log_error("hook", exc)


if __name__ == "__main__":
    main()
