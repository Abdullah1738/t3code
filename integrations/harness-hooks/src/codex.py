#!/usr/bin/env python3
"""Codex command-hook adapter; shell PATH comes from its generated home."""
import json
import sys

import engine


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
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            raise ValueError("invalid-event")
        output = response(event, engine.decide(event, "codex"))
        if output is not None:
            print(json.dumps(output))
    except Exception as error:
        engine.log_event_error("codex", None, "adapter-error", type(error).__name__)


if __name__ == "__main__":
    main()
