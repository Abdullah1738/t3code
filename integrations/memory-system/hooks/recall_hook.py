#!/opt/homebrew/bin/python3
"""Thin Claude/Codex adapters for the shared recall decision engine."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from recall_hook_state import Store
from recall_note import bounded_note

SKIP_PREFIXES = ("# AGENTS.md instructions", "<environment_context>", "<user_instructions>",
                 "[Compressed conversation section]", "<shell id=", "<system-update>", "<skill_content",
                 "<recall>", "<subagent sessionID=", "<dcp-system-reminder>",
                 "You are a subagent spawned by another session", "This session is being continued",
                 'You are the worker for a card on the "', 'You are the reviewer for a card on the "',
                 'You are an evaluator on the "', "[coord]", "[crw]", "[Watcher event from robob-watch")


def state_path():
    return os.environ.get("RECALL_HOOK_STATE", os.path.expanduser("~/.local/state/recall-hooks/state.db"))


def log(entry):
    try:
        path = Path(os.environ.get("RECALL_HOOK_LOG", str(Path(state_path()).parent / "hook.log")))
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "a") as out:
            out.write(json.dumps({"ts": int(time.time()), **entry}) + "\n")
    except OSError:
        pass


def config():
    value = {}
    try:
        with open(os.environ.get("RECALL_PLUGIN_CONFIG", os.path.expanduser("~/.config/opencode/recall.json"))) as f:
            value = json.load(f)
        if not isinstance(value, dict):
            return {"mode": "off"}
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        return {"mode": "off"}
    return {"mode": "on", "url": "http://127.0.0.1:18765", "only_dirs": [], **value}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def control_origin(url):
    try:
        p = urllib.parse.urlsplit(url)
        if (p.scheme != "http" or p.hostname not in ("localhost", "127.0.0.1", "::1") or
                p.username is not None or p.password is not None or p.port == 0 or
                p.path not in ("", "/") or p.query or p.fragment or any(ord(c) <= 32 for c in url)):
            return None
        return url.rstrip("/")
    except (TypeError, ValueError):
        return None


def request(url, *, body=None, headers=None, timeout=0.3):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({})).open(req, timeout=timeout) as response:
        data = response.read(1048577)
        if len(data) > 1048576:
            raise ValueError("oversize response")
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError("invalid response")
        return value


def resolve(harness, event, timeout=0.3):
    native = event.get("session_id")
    if not isinstance(native, str) or not native or len(native) > 200:
        return None
    params = {"nativeId": native, "driver": "claudeAgent" if harness == "claude" else "codex"}
    agent = event.get("agent_id")
    if harness == "claude" and agent:
        params["agentId"] = agent
    elif harness == "codex":
        params["nativeId"] = agent or os.environ.get("CODEX_THREAD_ID") or native
    instance = os.environ.get("ROBOB_PROVIDER_INSTANCE_ID")
    if instance:
        params["instance"] = instance
    token, url = os.environ.get("T3_CONTROL_TOKEN"), os.environ.get("T3_CONTROL_URL")
    stored = {}
    if not (token and url):
        try:
            with open(os.environ.get("T3_CONTROL_TOKEN_FILE", os.path.expanduser("~/.robob/components/harness-hooks.json"))) as f:
                stored = json.load(f)
        except FileNotFoundError:
            pass
    token = token or stored.get("token")
    origin = control_origin(url or stored.get("url") or "http://127.0.0.1:3773")
    if not token or not origin:
        return None
    try:
        identity = request(origin + "/api/ardud/control/identity/resolve?" + urllib.parse.urlencode(params),
                           headers={"Authorization": "Bearer " + token}, timeout=timeout).get("identity")
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            return None
        raise
    if (not isinstance(identity, dict) or identity.get("resolution") != "resolved" or
            not all(isinstance(identity.get(k), str) and identity[k] for k in
                    ("robobThreadId", "rootThreadId", "executionKind", "driver", "providerInstanceId")) or
            identity["driver"] != params["driver"] or instance and identity["providerInstanceId"] != instance):
        return None
    return {**identity, "_native": params["nativeId"], "_agent": params.get("agentId")}


def native_key(harness, event):
    native = event.get("session_id")
    if not isinstance(native, str) or not native or len(native) > 200:
        return None
    parts = [harness, os.environ.get("ROBOB_PROVIDER_INSTANCE_ID"), native, event.get("agent_id"),
             os.environ.get("CODEX_THREAD_ID") if harness == "codex" else None]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()


def first_transcript(event):
    """Missing/large/ambiguous transcript is not proof that this is a new session."""
    try:
        with open(event.get("transcript_path"), "rb") as f:
            data = f.read(131073)
        if len(data) > 131072:
            return False
    except (TypeError, OSError):
        return False
    users = 0
    for line in data.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            return False
        value = entry.get("payload") if isinstance(entry.get("payload"), dict) else entry
        message = value.get("message") if isinstance(value.get("message"), dict) else value
        kind, role = value.get("type"), message.get("role")
        if kind in ("compacted", "context_compacted", "compaction", "assistant") or role == "assistant":
            return False
        if kind == "user" or role == "user":
            users += 1
    return users <= 1


def wrapped(note):
    return note if note.startswith("<recall>\n") and note.endswith("\n</recall>") else "<recall>\n" + note + "\n</recall>"


def cited(sources):
    return isinstance(sources, list) and any(
        isinstance(s, str) and bool(s.strip()) or isinstance(s, dict) and any(
            isinstance(s.get(k), str) and bool(s[k].strip()) for k in ("citation", "source", "session_id"))
        for s in sources)


def output(name, result=None, note=None):
    specific = {"hookEventName": name}
    if name == "PreToolUse" and result and result.get("decision") == "deny" and result.get("reason") and cited(result.get("sources")):
        # Same native deny envelope as integrations/harness-hooks/src/codex.py.
        specific.update(permissionDecision="deny", permissionDecisionReason=result["reason"])
    note = bounded_note(note)
    if note:
        specific["additionalContext"] = wrapped(note)
    if len(specific) > 1:
        print(json.dumps({"hookSpecificOutput": specific}), flush=True)


def handle(harness, event):
    started = time.monotonic()
    name = event.get("hook_event_name")
    if name not in ("UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "SessionStart"):
        return
    cfg = config()
    if cfg.get("mode") not in ("on", "observe"):
        return
    cwd = str(event.get("cwd") or "")
    dirs = cfg.get("only_dirs")
    if isinstance(dirs, list) and dirs and not any(isinstance(d, str) and d and (cwd == d or cwd.startswith(d.rstrip("/") + "/")) for d in dirs):
        return
    if name == "PreToolUse":
        from recall_local import preflight, local_note
        tool = str(event.get("tool_name") or "")
        try:
            rules, conflict = preflight(tool, event.get("tool_input"), cwd,
                                        session_id=event.get("agent_id") or event.get("session_id"))
        except Exception:
            rules, conflict = [], None
        note = local_note(rules)
        entry = {"trigger": "tool", "tool": tool, "decision": conflict.get("decision", "deny") if conflict else "allow",
             "local_decision": "hard-deny" if conflict else "candidate" if rules else "no-candidate",
             "routed": False, "reason": "hard-rule" if conflict else "matching-rule" if rules else "no-matching-rule",
             "note": bool(note), "sources": (conflict or note or {}).get("sources", []),
             "ms": (time.monotonic() - started) * 1000}
        if conflict and conflict.get('classifier') == 'message-facts':
            entry.update(local_decision='message-facts', routed=conflict.get('routed', False),
                         reason=conflict.get('reason', 'fact-check'), note=bool(conflict.get('note')),
                         p=conflict.get('p'), cost=conflict.get('cost', 0))
        log(entry)
        if conflict or note or not rules:
            # Local decisions otherwise never reach the engine's decision log.
            try:
                path = Path(os.environ.get("RECALL_DECISION_LOG", str(Path.home() / ".local/share/memory-system/logs/recall-decisions.jsonl")))
                path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "a") as out:
                    out.write(json.dumps({**entry, "at": int(time.time()), "classifier": "local-hook", "latency_ms": entry["ms"]}) + "\n")
            except OSError:
                pass
        if conflict:
            if cfg["mode"] == "on":
                output(name, result=conflict, note=conflict.get("note"))
            return
        if note:
            if cfg["mode"] == "on":
                output(name, note=note['note'])
            return
        if not rules:
            return
    key = native_key(harness, event)
    if not key:
        return
    db = Store(state_path())
    try:
        if name == "PreCompact":
            # Multiple compactions in one turn get distinct tokens after the matching completion.
            db.compact_start(key)
            return
        if name == "SessionStart" and event.get("source") != "compact":
            with db.transaction():
                state = db.get(key)
                state["fresh"] = event.get("source") == "startup" and not state["first"]
                if event.get("source") in ("resume", "fork"):
                    state["first"] = True
                db.save(key, state)
            return
        if name == "PostCompact":
            # Codex 0.166.0 drops PostCompact additionalContext; defer to a context-injecting event.
            if not db.get(key)["compact_pending"]:
                db.compact_start(key)
            return
        budget = 1.3 if name == "PreToolUse" else 0.5
        left = lambda: max(0.001, budget - (time.monotonic() - started))
        prompt = event.get("prompt") if isinstance(event.get("prompt"), str) else ""
        generation = db.get(key)["generation"]
        claim = None
        if name == "UserPromptSubmit":
            state = db.get(key)
            eligible = bool(prompt.strip()) and not prompt.lstrip().startswith(SKIP_PREFIXES) and not event.get("agent_id") and (state["fresh"] or first_transcript(event))
            generation = db.claim_first(key, prompt, eligible)
            if generation is not None:
                claim = ("first_prompt", "first", prompt)
        compact = db.claim_compact(key, completed=name == "SessionStart")
        if compact:
            token, compact_generation, task = compact
            claim = ("compaction", str(token), task)
            generation = compact_generation
        tool = str(event.get("tool_name") or "")
        arguments = event.get("tool_input")
        tool_check = name == "PreToolUse"
        if not claim and not tool_check:
            if cfg["mode"] == "on" and (name != "PreToolUse" or harness == "claude"):
                output(name, note=db.consume(key))
            return
        try:
            identity = resolve(harness, event, timeout=min(0.3, left()))
        except Exception:
            identity = None
        if not identity and not tool_check:
            return
        if identity and claim and claim[0] == "first_prompt" and identity["executionKind"] != "top-level":
            claim = None
        origin = control_origin(cfg.get("url"))
        if not origin:
            return
        if identity:
            common = {"session_id": identity["robobThreadId"], "parent_id": identity.get("parentThreadId"),
                      "caller_thread": identity["robobThreadId"], "caller_native": identity["_native"],
                      "caller_driver": identity["driver"], "caller_agent": identity["_agent"], "cwd": cwd}
        else:
            # Standalone native sessions still enforce cwd-scoped standing rules.
            # No guessed caller identity: the engine must fail closed for transcript history.
            common = {"session_id": event["session_id"], "cwd": cwd}
            claim = None
        result = None
        checks = []
        if claim:
            checks.append({"trigger": claim[0], "token": claim[1], "compaction_id": claim[1] if claim[0] == "compaction" else None,
                           "request_id": key + ":" + claim[0] + ":" + claim[1], "prompt": claim[2]})
        if tool_check:
            call = str(event.get("tool_use_id") or event.get("tool_call_id") or hashlib.sha256(
                json.dumps([tool, arguments, event.get("turn_id"), event.get("prompt_id")], sort_keys=True).encode()).hexdigest()[:24])
            # A pending compaction must never consume the outward action's check budget.
            checks.insert(0, {"trigger": "tool", "tool": tool, "arguments": arguments if isinstance(arguments, dict) else {"input": arguments},
                              "request_id": key + ":tool:" + call, "tool_call_id": call})
        for body in checks:
            if left() <= 0.01:
                break
            result = request(origin + "/api/check", body={**common, **body}, timeout=min(2.8 if body["trigger"] == "tool" else 0.45, left()))
            if result.get("decision") not in ("allow", "deny") or not isinstance(result.get("sources"), list):
                result = None
                continue
            note = result.get("note")
            if isinstance(note, str) and note and cfg["mode"] == "on":
                try:
                    db.remember(key, generation if generation is not None else db.get(key)["generation"], note)
                except Exception:
                    # Durable note delivery is optional; an already cited denial is not.
                    pass
            log({"trigger": body["trigger"], "tool": tool, "decision": result["decision"],
                 "sources": result["sources"] if result["decision"] == "deny" else [],
                 "p": result.get("p"), "cost": result.get("cost"), "ms": int((time.monotonic() - started) * 1000),
                 "recall_ran": result.get("recall_ran"), "note": bool(note)})
            if body["trigger"] == "tool" and result["decision"] == "deny" and result.get("reason") and cited(result["sources"]):
                if config().get("mode") == "on":
                    try:
                        pending = db.consume(key)
                    except Exception:
                        pending = None
                    output(name, result=result, note=pending)
                return
        if config().get("mode") == "on":
            if name == "PreToolUse" and result and result.get("decision") == "deny":
                output(name, result=result, note=db.consume(key))
            elif name in ("UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SessionStart") or name == "PreToolUse" and harness == "claude":
                output(name, note=db.consume(key))
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--harness", choices=("claude", "codex"), required=True)
    args = parser.parse_args()
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            return
        def expired(_signum, _frame):
            raise TimeoutError("recall deadline")
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, 1.5 if event.get("hook_event_name") == "PreToolUse" else 0.5)
        try:
            handle(args.harness, event)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
    except Exception as exc:
        log({"event": "adapter-error", "error": type(exc).__name__})


if __name__ == "__main__":
    main()
