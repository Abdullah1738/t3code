#!/usr/bin/env python3
"""Render today's nutrition totals without writing to the nutrition database."""

import json
import math
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote


FOOD = "/Users/ardud/health-data/abdullah/nutrition/food.py"
NUTRITION_DB = Path("/Users/ardud/health-data/abdullah/nutrition/nutrition.db")
METRICS = (
    ("kcal", "kcal", ""),
    ("protein_g", "P", "g"),
    ("carbs_g", "C", "g"),
    ("fat_g", "F", "g"),
)


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("nutrition values must be finite numbers")
    return value


def display(value):
    value = number(value)
    return str(int(value)) if value == int(value) else str(value)


def read_only_uri_path(path):
    return quote(str(path), safe="/") + "?mode=ro"


def read_today():
    fixture = os.environ.get("ROBOB_WIDGETS_MACROS_FIXTURE")
    if fixture:
        return json.loads(Path(fixture).read_text(encoding="utf-8"))

    # nlib.connect prepends "file:" and sets uri=True. Quote the path before
    # appending the mode so SQLite cannot mistake a path character for a URI
    # parameter. Its schema setup runs but cannot write in mode=ro. In WAL
    # mode SQLite may still update the -shm coordination sidecar.
    env = dict(os.environ, NUTRITION_DB=read_only_uri_path(NUTRITION_DB),
               PYTHONDONTWRITEBYTECODE="1")
    env.pop("NUTRITION_NOW", None)
    result = subprocess.run(
        ["/usr/bin/python3", FOOD, "today", "--json"],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
        env=env,
    )
    return json.loads(result.stdout)


def render(data):
    total = data["total"]
    if not isinstance(total, dict):
        raise ValueError("nutrition total must be an object")
    totals = {key: number(total[key]) for key, _, _ in METRICS}
    target = data.get("target")
    remaining = data.get("remaining")
    target = {} if target is None else target
    remaining = {} if remaining is None else remaining
    if not isinstance(target, dict) or not isinstance(remaining, dict):
        raise ValueError("nutrition target and remaining must be objects")

    rings = []
    totals_only = []
    targeted = set()
    for key, label, unit in METRICS:
        goal = target.get(key)
        if goal is not None and number(goal) > 0:
            rings.append({"label": label, "value": totals[key], "max": goal, "unit": unit})
            targeted.add(key)
        else:
            suffix = unit if unit else "kcal"
            totals_only.append({"label": label, "value": f"{display(totals[key])} {suffix}"})

    blocks = []
    if rings:
        blocks.append({"type": "rings", "items": rings})
    if "kcal" in targeted:
        stat = {"type": "stat", "label": "Left", "value": f"{display(remaining['kcal'])} kcal"}
        parts = [f"{label} {display(remaining[key])}" for key, label, _ in METRICS[1:]
                 if key in targeted]
        if parts:
            stat["delta"] = " · ".join(parts) + " left"
        blocks.append(stat)
    if totals_only:
        blocks.append({"type": "list", "rows": totals_only})
    return {"blocks": blocks}


def main():
    try:
        print(json.dumps(render(read_today()), ensure_ascii=False, allow_nan=False))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(f"macros source failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
