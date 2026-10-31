#!/usr/bin/env python3
# Big gym nudge: Mon-Fri 19:30, Sat/Sun 19:00 Dubai (gym closes 22:30 weekdays / 22:00 weekends;
# full session needs 2h + 30m travel + 30m getting ready). Skips if a Forge workout is already logged today.
import json, os, datetime as dt
from zoneinfo import ZoneInfo
D = os.environ.get("WATCH_DIR", os.path.dirname(os.path.abspath(__file__)))
now = dt.datetime.now(ZoneInfo("Asia/Dubai")); today = str(now.date())
wkend = now.weekday() >= 5
start = dt.time(19, 0) if wkend else dt.time(19, 30)
close = "22:00" if wkend else "22:30"
if not (start <= now.time() < dt.time(21, 0)): raise SystemExit(0)
lf = os.path.join(D, "last_fired")
if os.path.exists(lf) and open(lf).read().strip() == today: raise SystemExit(0)
p = os.path.expanduser("~/Library/Mobile Documents/iCloud~com~abdullah1738~forgeworkout/Documents/latest.json")
try:
    d = json.load(open(p)); w = d.get("payload", d).get("workouts", [])
    if any(x.get("localDate") == today for x in w):
        open(lf, "w").write(today); raise SystemExit(0)
except SystemExit: raise
except Exception: pass  # can't read Forge: nudge anyway
open(lf, "w").write(today)
print(f"Gym nudge {today} {now:%a %H:%M}: no workout logged today; gym closes {close}, leave by ~{'20:00' if wkend else '20:30'} at the latest for a full session.")
