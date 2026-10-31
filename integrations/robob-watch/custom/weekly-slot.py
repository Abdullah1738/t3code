#!/usr/bin/env python3
# weekly-slot.py STATEFILE WEEKDAY(0=Mon) HH:MM [HH:MM ...] -- TEXT
# Prints "<slot> TEXT" once per slot per week once the slot time has passed (Asia/Dubai), within 6h.
import sys, json, os, datetime
from zoneinfo import ZoneInfo
a = sys.argv[1:]; i = a.index('--')
state, wd, slots, text = a[0], int(a[1]), a[2:i], ' '.join(a[i+1:])
now = datetime.datetime.now(ZoneInfo('Asia/Dubai'))
try: done = json.load(open(state))
except Exception: done = {}
if now.weekday() != wd: sys.exit(0)
out = []
for s in slots:
    h, m = map(int, s.split(':'))
    t = now.replace(hour=h, minute=m, second=0, microsecond=0)
    key = f"{now.date()}T{s}"
    if t <= now < t + datetime.timedelta(hours=6) and key not in done:
        done[key] = now.isoformat(); out.append(s)
if out:
    # only report the latest slot passed (avoid double fire after sleep)
    for s in out: pass
    os.makedirs(os.path.dirname(state), exist_ok=True)
    json.dump(done, open(state, 'w'))
    print(f"{out[-1]} {text}")
