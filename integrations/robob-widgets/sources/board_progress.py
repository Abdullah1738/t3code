#!/usr/bin/env python3
"""Render progress for a Robob board, optionally limited to one goal."""

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request


STAGES = (
    ("todo", "Todo"),
    ("working", "Working"),
    ("needs_review", "Needs review"),
    ("in_review", "In review"),
    ("completed", "Completed"),
    ("deployed", "Deployed"),
    ("verified", "Verified"),
    ("needs_owner", "Needs owner"),
)
DONE = {"completed", "deployed", "verified"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_board(board):
    fixture = os.environ.get("ROBOB_WIDGETS_BOARD_FIXTURE")
    if fixture:
        return json.loads(Path(fixture).read_text(encoding="utf-8"))

    credentials = json.loads((Path.home() / ".robob/components/t3ctl.json").read_text(encoding="utf-8"))
    base = urllib.parse.urlsplit(credentials["url"])
    if (base.scheme not in {"http", "https"} or base.hostname not in {"127.0.0.1", "::1"}
            or base.username is not None or base.password is not None
            or base.path not in {"", "/"} or base.query or base.fragment):
        raise ValueError("Robob URL must be a local origin")
    token = credentials["token"]
    if not isinstance(token, str) or not token:
        raise ValueError("Robob token is missing")
    url = urllib.parse.urlunsplit((base.scheme, base.netloc,
                                   "/api/ardud/kanban/boards/" + urllib.parse.quote(board, safe=""),
                                   "", ""))
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token,
                                                   "Accept": "application/json"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        return json.load(response)


def render(data, board, goal=None):
    info = data["board"]
    cards = data["cards"]
    if not isinstance(info, dict) or board not in (info.get("id"), info.get("slug")):
        raise ValueError("response does not match the requested board")
    if not isinstance(cards, list):
        raise ValueError("board cards must be an array")
    if goal is not None:
        goals = data["goals"]
        if not isinstance(goals, list) or not any(isinstance(g, dict) and g.get("id") == goal for g in goals):
            raise ValueError("goal not found on the board")

    counts = Counter()
    for card in cards:
        if not isinstance(card, dict):
            raise ValueError("board card must be an object")
        if goal is not None and "goalId" not in card:
            raise ValueError("board card is missing a goal")
        if goal is not None and card.get("goalId") != goal:
            continue
        stage, priority = card["stage"], card["priority"]
        if not isinstance(stage, str) or not stage or type(priority) is not int or not 1 <= priority <= 5:
            raise ValueError("invalid board stage or priority")
        if priority != 5:
            counts[stage] += 1

    known = dict(STAGES)
    rows = [{"label": label, "value": str(counts[stage])} for stage, label in STAGES]
    rows.extend({"label": stage.replace("_", " ").capitalize(), "value": str(counts[stage])}
                for stage in sorted(counts.keys() - known.keys()))
    return {"blocks": [
        {"type": "progress", "label": "Done", "value": sum(counts[s] for s in DONE),
         "max": sum(counts.values())},
        {"type": "list", "rows": rows},
    ]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("board", help="board slug or ID")
    parser.add_argument("--goal", help="limit to this goal ID")
    args = parser.parse_args()
    try:
        print(json.dumps(render(read_board(args.board), args.board, args.goal), allow_nan=False))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"board progress source failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
