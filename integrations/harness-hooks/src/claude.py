#!/usr/bin/env python3
"""Claude Code command-hook adapter."""
import json
import os
from pathlib import Path
import shlex
import sys

import engine


def session_start():
    """Only session-wide, non-identity state belongs in CLAUDE_ENV_FILE."""
    env_file = os.environ.get("CLAUDE_ENV_FILE")
    if not env_file:
        return
    home = Path.home()
    offbox = os.environ.get("HARNESS_HOOKS_OFFBOX_BLOCKERS", str(home / ".config/opencode/skills/remote-compute/scripts/blockers"))
    coord = os.environ.get("HARNESS_HOOKS_COORD_BLOCKERS", str(home / ".local/share/harness-hooks/coord-blockers"))
    with open(env_file, "a", encoding="utf-8") as f:
        f.write("export PATH=" + shlex.quote(offbox + ":" + coord) + ':"$PATH"\n')
        f.write("export OFFBOX_GATE=1\nexport ROBOB_HARNESS=claude\n")


def response(event, result):
    kind = event.get("hook_event_name")
    if kind != "PreToolUse" or (result["decision"] != "deny" and "updatedInput" not in result["context"]):
        return None
    specific = {"hookEventName": kind}
    if kind == "PreToolUse":
        if result["decision"] == "deny":
            specific.update(permissionDecision="deny", permissionDecisionReason=result["reason"])
        elif "updatedInput" in result["context"]:
            specific.update(permissionDecision="allow", updatedInput=result["context"]["updatedInput"])
    return {"hookSpecificOutput": specific}


def main():
    event = {}
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            raise ValueError("invalid-event")
        # The generic shell MCP matcher can overlap an unknown CUA tool name.
        # The desktop-specific matcher owns admission in that case.
        if sys.argv[1:] == ["--shell-mcp"] and engine.desktop_lease.matches(event.get("tool_name")):
            return
        if event.get("hook_event_name") == "SessionStart":
            try:
                session_start()
            except OSError:
                engine.log_event_error("claude", "SessionStart", "session-export-error", "session-export-error")
                return
        result = engine.decide(event, "claude")
        output = response(event, result)
        if output is not None:
            print(json.dumps(output))
    except Exception as error:
        engine.log_event_error("claude", None, "adapter-error", type(error).__name__)
        if isinstance(event, dict) and event.get("hook_event_name") == "PreToolUse" and engine.desktop_lease.matches(event.get("tool_name")):
            print(json.dumps(response(event, {"decision": "deny", "reason": engine.desktop_lease.UNAVAILABLE, "context": {}})))


if __name__ == "__main__":
    main()
