#!/usr/bin/env python3
"""forge-workouts check: print one line per newly finished Forge workout.

Cheap gate: if latest.json's mtime+size are unchanged since the last full scan
and nothing is pending, exit silently without parsing the 3.5 MB file.

A workout counts as finished when status == "completed" and its last change
is 2+ minutes old (the phone rewrites latest.json ~15s after edits), or when it
is still "active" but untouched for 45+ minutes with at least one completed set
(left open by mistake). Fired ids are kept in seen.json so nothing fires twice;
the first run seeds seen.json with every existing *completed* workout (an
in-progress one at seed time still fires when it finishes).
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.expanduser("~/health-data/abdullah/workout-logs"))
from report import LATEST, last_change_ms, load_doc  # noqa: E402

WATCH_DIR = os.environ.get("WATCH_DIR", os.path.dirname(os.path.abspath(__file__)))
SEEN = os.path.join(WATCH_DIR, "seen.json")
GATE = os.path.join(WATCH_DIR, "gate.json")
SETTLE_COMPLETED_MS = 2 * 60 * 1000
SETTLE_ACTIVE_MS = 45 * 60 * 1000


def save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)


def main():
    st = os.stat(LATEST)
    sig = [st.st_mtime_ns, st.st_size]
    gate = json.load(open(GATE)) if os.path.exists(GATE) else {}
    now = time.time() * 1000
    if gate.get("sig") == sig and not gate.get("pending"):
        return
    # pending workouts need a re-check once their settle time has passed
    if gate.get("sig") == sig and gate.get("recheck_after", 0) > now:
        return

    doc = load_doc(attempts=20)
    workouts = doc["payload"]["workouts"]
    first_run = not os.path.exists(SEEN)
    seen = set() if first_run else set(json.load(open(SEEN)))
    if first_run:
        save(SEEN, sorted(w["id"] for w in workouts if w.get("status") != "active"))
        save(GATE, {"sig": sig, "pending": [], "recheck_after": 0})
        return

    events, pending, recheck = [], [], 0
    for w in sorted(workouts, key=lambda w: w["startedAtMs"]):
        if w["id"] in seen or w.get("origin") != "app":
            continue
        sets = [s for e in w.get("exercises", []) for s in e.get("sets", []) if s.get("completedAtMs")]
        changed = last_change_ms(w)
        if w.get("status") == "completed":
            ready_at = changed + SETTLE_COMPLETED_MS
            how = "finished"
        elif w.get("status") == "active" and sets:
            ready_at = changed + SETTLE_ACTIVE_MS
            how = "never finished in app, idle 45+ min"
        else:
            if w.get("status") not in ("active",):  # discarded/other: never report
                seen.add(w["id"])
            continue
        if not sets:  # finished empty workout
            seen.add(w["id"])
            continue
        if now < ready_at:
            pending.append(w["id"])
            recheck = ready_at if not recheck else min(recheck, ready_at)
            continue
        n_ex = len([e for e in w["exercises"] if e.get("sets")])
        events.append(f"New Forge workout ({how}): id={w['id']} date={w['localDate']} "
                      f"title=\"{w.get('title')}\" exercises={n_ex} sets={len(sets)}")
        seen.add(w["id"])

    save(SEEN, sorted(seen))
    save(GATE, {"sig": sig, "pending": pending, "recheck_after": recheck})
    if events:
        print("\n".join(events))


if __name__ == "__main__":
    main()
