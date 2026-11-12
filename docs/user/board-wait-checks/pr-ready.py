#!/usr/bin/env python3
"""Wait check: a pull request leaves draft.

Park a card whose PR is still a draft with:

    card_wait  script: "pr-ready"
               args:   {"pr": "https://github.com/acme/app/pull/12"}
               note:   "author to mark the PR ready"

Without `pr` it uses the card's only pull request link. When the PR is marked
ready the card's reviewer is woken for a review from the first step.

It makes no network call: the board hands every check a reading of the pull
requests the card points at (`facts.prs`), and this only looks at that.
"""

import json
import sys


def answer(card, **fields):
    print(json.dumps({"kanban": {"wait": {"card": card, **fields}}}), flush=True)


def number(url):
    return url.rstrip("/").split("/")[-1]


def same(a, b):
    return a.rstrip("/").lower() == b.rstrip("/").lower()


for item in json.load(sys.stdin):
    card = item["card"]["number"]
    links = [link["url"] for link in item["card"]["links"] if link["kind"] == "pr"]
    pr = item["args"].get("pr") or (links[0] if len(links) == 1 else None)
    if not pr:
        answer(card, result="fail", reason='args needs "pr": the card has no single PR link')
        continue
    reading = next(
        (entry for entry in item["facts"]["prs"] if same(entry["url"], pr)),
        None,
    )
    if reading is None:
        # Nobody could read the PR this pass. Unknown is not done: hold.
        answer(card, result="hold", status=f"PR #{number(pr)}: no reading yet")
    elif reading["state"] == "draft":
        answer(card, result="hold", status=f"PR #{number(pr)} is still a draft")
    elif reading["state"] == "open":
        answer(
            card,
            result="wake",
            to="review",
            restart=True,
            note=f"PR #{number(pr)} was marked ready for review",
        )
    else:
        # Merged or closed while it was a draft: the evaluator decides what the card does now.
        answer(
            card,
            result="wake",
            to="evaluator",
            note=f"PR #{number(pr)} was {reading['state']} while this waited for it to leave draft",
        )
