#!/usr/bin/env python3
"""Antigravity hooks.json adapter for the shared guard engine.

The Antigravity ACP runtime runs `hooks.json` commands with a JSON payload on
stdin and reads one JSON object from stdout. Only PreToolUse decisions are
honoured (`{"decision": "allow" | "deny", "reason": ...}`); a hook that exits
non-zero, prints invalid JSON or times out DENIES the tool, so this adapter
always prints a decision and never raises.

  antigravity.py --event pre    PreToolUse: {toolCall: {name, args}, stepIdx, conversationId, workspacePaths}
  antigravity.py --event post   PostToolUse: {stepIdx, error, conversationId} (no tool name)
  antigravity.py --event stop   session end

Shell calls arrive as `run_command` ({CommandLine, Cwd}); MCP calls carry
{ServerName, ToolName, Arguments}. Both are mapped to the Claude-shaped event
the engine already understands (`Bash`, `mcp__<server>__<tool>`). The ACP
conversationId is the native session id Robob resolves with driver
`antigravity`. Rewrites (updatedInput, masked output) cannot be applied by
this runtime and are dropped.
"""
import json
import sys

SHELL_TOOLS = {"run_command"}
ALLOW = {"decision": "allow"}


def _say(value):
    sys.stdout.write(json.dumps(value))
    sys.stdout.flush()


def _call_id(payload):
    conversation, step = payload.get("conversationId"), payload.get("stepIdx")
    if not isinstance(conversation, str) or not conversation or type(step) is not int:
        return None
    return f"agy:{conversation}:{step}"


def _cwd(payload, args):
    cwd = args.get("Cwd") if isinstance(args, dict) else None
    if isinstance(cwd, str) and cwd:
        return cwd
    paths = payload.get("workspacePaths")
    return paths[0] if isinstance(paths, list) and paths and isinstance(paths[0], str) else None


def map_pre(payload):
    """Return a Claude-shaped PreToolUse event, or None when no guard applies."""
    call = payload.get("toolCall")
    if not isinstance(call, dict):
        return None
    name, args = call.get("name"), call.get("args")
    if not isinstance(name, str) or not isinstance(args, dict):
        return None
    event = {"hook_event_name": "PreToolUse", "session_id": payload.get("conversationId"),
             "tool_use_id": _call_id(payload), "cwd": _cwd(payload, args)}
    server, tool = args.get("ServerName"), args.get("ToolName")
    if isinstance(server, str) and server and isinstance(tool, str) and tool:
        arguments = args.get("Arguments")
        event.update(tool_name=f"mcp__{server}__{tool}",
                     tool_input=arguments if isinstance(arguments, dict) else {})
        return event
    if name in SHELL_TOOLS:
        command = args.get("CommandLine")
        if not isinstance(command, str) or not command:
            return None
        tool_input = {"command": command}
        if event["cwd"]:
            tool_input["cwd"] = event["cwd"]
        event.update(tool_name="Bash", tool_input=tool_input)
        return event
    return None


def pre(payload):
    event = map_pre(payload)
    if event is None:
        return ALLOW
    import engine
    try:
        result = engine.decide(event, "antigravity")
    except Exception as error:  # noqa: BLE001 - engine failures follow the native adapters
        engine.log_event_error("antigravity", "PreToolUse", "adapter-error", type(error).__name__)
        if engine.desktop_lease.matches(event.get("tool_name")):
            return {"decision": "deny", "reason": engine.desktop_lease.UNAVAILABLE}
        return ALLOW
    if result.get("decision") == "deny":
        return {"decision": "deny", "reason": result.get("reason") or "Denied by a Robob guard."}
    return ALLOW


def post(payload):
    """End a desktop lease call the PreToolUse hook admitted (the payload has no tool name)."""
    call_id = _call_id(payload)
    if call_id is None:
        return {}
    import engine
    try:
        pending = engine.desktop_lease._pending_update(engine._state(), payload.get("conversationId"))
        if call_id not in pending:
            return {}
        failed = isinstance(payload.get("error"), str) and payload["error"] != ""
        # Only calls that needed a lease are pending, so any mutating CUA name routes to finish().
        engine.decide({"hook_event_name": "PostToolUseFailure" if failed else "PostToolUse",
                       "session_id": payload.get("conversationId"), "tool_use_id": call_id,
                       "tool_name": "mcp__cua-driver__antigravity_call", "tool_input": {}}, "antigravity")
    except Exception as error:  # noqa: BLE001
        engine.log_event_error("antigravity", "PostToolUse", "adapter-error", type(error).__name__)
    return {}


def stop(payload):
    import engine
    try:
        engine.decide({"hook_event_name": "SessionEnd", "session_id": payload.get("conversationId")}, "antigravity")
    except Exception as error:  # noqa: BLE001
        engine.log_event_error("antigravity", "SessionEnd", "adapter-error", type(error).__name__)
    return {}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    kind = argv[1] if len(argv) == 2 and argv[0] == "--event" else "pre"
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("invalid-event")
    except Exception:  # noqa: BLE001
        _say(ALLOW if kind == "pre" else {})
        return
    try:
        _say({"pre": pre, "post": post, "stop": stop}.get(kind, pre)(payload))
    except Exception:  # noqa: BLE001 - an exception here would deny every tool call
        _say(ALLOW if kind == "pre" else {})


if __name__ == "__main__":
    main()
