#!/usr/bin/env python3
"""Wait check: a local file's sha256 reaches a given value.

Register it on a board as a script named file-sha256 (manual trigger is
enough; the board runs it for the cards that wait on it). Park a card with:

    card_wait on:"script" script:"file-sha256"
              args:{"path":"/abs/path","sha256":"<64 hex>"} note:"Install to land"

`path` must be absolute; ~ is not expanded. `sha256` may be a non-empty list
of hashes (any match wakes). Comparison ignores case. `to` in args picks
work, review, evaluator or none; left out, the board chooses who acts next.

No network or writes: it reads the file and reports only its basename and
hash, never its contents or full path. Missing files keep holding.
"""

import hashlib
import json
import os
import re
import sys


def answer(card, **fields):
    print(json.dumps({"kanban": {"wait": {"card": card, **fields}}}), flush=True)


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    try:
        items = json.load(sys.stdin)
    except (ValueError, OSError) as error:
        print(f"Couldn't read stdin: {type(error).__name__}", file=sys.stderr)
        return 1
    if not isinstance(items, list):
        print("stdin must be a JSON array", file=sys.stderr)
        return 1

    # Cache failures too: an install cannot change the answer between cards.
    seen = {}
    for index, item in enumerate(items):
        card = item.get("card") if isinstance(item, dict) else None
        number = card.get("number") if isinstance(card, dict) else None
        if type(number) is not int or number <= 0:
            print(f"Skipping item {index}: needs a card number", file=sys.stderr)
            continue
        args = item.get("args") or {}
        if not isinstance(args, dict):
            answer(number, result="fail", reason="args must be an object")
            continue
        path = args.get("path")
        if not isinstance(path, str) or not os.path.isabs(path):
            answer(number, result="fail", reason='args needs an absolute "path"')
            continue
        wanted = args.get("sha256")
        hashes = [wanted] if isinstance(wanted, str) else wanted
        if not isinstance(hashes, list) or not hashes or not all(
            isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{64}", value)
            for value in hashes
        ):
            answer(
                number, result="fail",
                reason='args needs "sha256": 64 hex chars (or a list)',
            )
            continue
        if "to" in args and args["to"] not in ("work", "review", "evaluator", "none"):
            answer(number, result="fail", reason='args "to" must be work, review, evaluator or none')
            continue

        basename = os.path.basename(path)
        if path not in seen:
            try:
                seen[path] = file_sha256(path)
            except (OSError, ValueError) as error:
                seen[path] = error
        actual = seen[path]
        if isinstance(actual, FileNotFoundError):
            answer(number, result="hold", status=f"{basename} is missing")
        elif isinstance(actual, Exception):
            answer(number, result="fail", reason=f"Couldn't read {basename}: {type(actual).__name__}")
        elif actual.lower() in [value.lower() for value in hashes]:
            wake = {"result": "wake", "note": f"{basename} sha256 is {actual[:12]}… (matches)"}
            if "to" in args:
                wake["to"] = args["to"]
            answer(number, **wake)
        else:
            waiting = f"one of {len(hashes)}" if isinstance(wanted, list) else f"{hashes[0][:12].lower()}…"
            answer(number, result="hold", status=f"{basename} sha256 is {actual[:12]}…, waiting for {waiting}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
