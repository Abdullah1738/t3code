#!/usr/bin/env python3
"""Wait check: a Linear issue reaches a state.

Register it on a board as a script (manual trigger is enough; the board runs
it for the cards that wait on it). Park a card with:

    card_wait  script: "linear-state"
               args:   {"issue": "ENG-123", "state": "Done"}
               note:   "ENG-123 to reach Done"

`state` may be a list (["Done", "Canceled"]). `to` in args picks who is woken;
left out, it is whoever acts next on the card.

It reads Linear through the `linctl` CLI, which uses the owner's own login
(~/.linctl.yaml). There is no token in this file and none in the board.
"""

import json
import subprocess
import sys


def answer(card, **fields):
    print(json.dumps({"kanban": {"wait": {"card": card, **fields}}}), flush=True)


def issue_state(issue):
    """The issue's state name, or raises with why it couldn't be read."""
    run = subprocess.run(
        ["linctl", "issue", "get", issue, "--json"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if run.returncode != 0:
        raise RuntimeError((run.stderr or run.stdout).strip()[:160] or "linctl failed")
    state = (json.loads(run.stdout).get("state") or {}).get("name")
    if not state:
        raise RuntimeError("linctl gave no state")
    return state


# One read per issue, however many cards wait on it.
seen = {}

for item in json.load(sys.stdin):
    card = item["card"]["number"]
    args = item["args"]
    issue = args.get("issue")
    wanted = args.get("state")
    wanted = [wanted] if isinstance(wanted, str) else (wanted or [])
    if not issue or not wanted:
        answer(card, result="fail", reason='args needs "issue" and "state"')
        continue
    try:
        if issue not in seen:
            seen[issue] = issue_state(issue)
    except Exception as error:  # a failed read holds the card and shows why
        answer(card, result="fail", reason=f"Couldn't read {issue}: {error}")
        continue
    state = seen[issue]
    if state.lower() in [name.lower() for name in wanted]:
        wake = {"result": "wake", "note": f"{issue} is {state}"}
        if args.get("to"):
            wake["to"] = args["to"]
        answer(card, **wake)
    else:
        answer(card, result="hold", status=f"{issue} is {state}")
