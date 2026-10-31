#!/usr/bin/env python3
# Confirm a dose:  ./took.py [YYYY-MM-DD] all|name[:L|R]...   (writes taken.json)
# Skip a dose:     ./took.py [YYYY-MM-DD] skip <name>... [--note "text"]   (writes moved.json, never taken.json)
import json, os, sys, datetime as dt
from zoneinfo import ZoneInfo
D = os.path.dirname(os.path.abspath(__file__)); p = os.path.join(D,"taken.json")
a = sys.argv[1:]; n = dt.datetime.now(ZoneInfo("Asia/Dubai")); day = str((n - dt.timedelta(hours=5)).date())  # before 5am counts as previous day
if a and a[0][:2] == "20": day, a = a[0], a[1:]
MEDS = ["dutasteride", "tadalafil", "arimidex", "reta", "test"]
def show_open(day, t):
    # carry-forward: a missed dose confirmed later is logged on the day actually taken (above) and that clears
    # the carry in check.py, so it isn't nagged again or counted twice. Show what is still open.
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("meds_check", os.path.join(D, "check.py"))
        mc = importlib.util.module_from_spec(spec); spec.loader.exec_module(mc)
        left = mc.outstanding(dt.date.fromisoformat(day), t)
        print("still open for", day + ":", ", ".join(left) if left else "nothing")
    except Exception as e:
        print("(could not compute outstanding:", e, ")")
def skip(day, a):
    # moved.json is the one-off schedule override check.py reads; a skip never touches taken.json
    note = None
    if "--note" in a:
        i = a.index("--note")
        if i + 1 >= len(a): sys.exit("--note needs text")
        note = a[i + 1]; a = a[:i] + a[i + 2:]
    names = [x.lower() for x in a]
    if not names: sys.exit("usage: took.py [YYYY-MM-DD] skip <name>... [--note \"text\"]")
    if "all" in names: sys.exit("skip names one med at a time")
    for x in names:
        if x not in MEDS: sys.exit("unknown med: " + x)
    mp = os.path.join(D, "moved.json")
    moved = json.load(open(mp)) if os.path.exists(mp) else {}
    m = moved.setdefault(day, {}); skips = m.setdefault("skip", [])
    for x in names:
        if x not in [s.lower() for s in skips]: skips.append(x.capitalize())
    if note is not None: m["note"] = note
    tmp = mp + ".tmp"
    with open(tmp, "w") as f: json.dump(moved, f, indent=1)
    os.replace(tmp, mp)
    print("skipped %s: %s" % (day, ", ".join(x.capitalize() for x in names)))
    show_open(day, json.load(open(p)) if os.path.exists(p) else {})
    raise SystemExit(0)
if a and a[0].lower() == "skip": skip(day, a[1:])
t = json.load(open(p)) if os.path.exists(p) else {}
# optional injection site: test:L / test:R (also all:L)
sites = {}
for i, x in enumerate(a):
    if ":" in x:
        n, s = x.split(":", 1); s = s.upper().replace("-VG", "")
        if s not in ("L", "R"): sys.exit("site must be L or R: " + x)
        a[i] = n; sites["test"] = s
names = ["dutasteride","tadalafil","arimidex","reta","test"] if [x.lower() for x in a] == ["all"] else [x.lower() for x in a]
t[day] = sorted(set(t.get(day, []) + names)); json.dump(t, open(p,"w"), indent=1); print(day, t[day])
if sites:
    sp = os.path.join(D, "sites.json"); st = json.load(open(sp)) if os.path.exists(sp) else {}
    st.setdefault(day, {}).update(sites); json.dump(st, open(sp, "w"), indent=1)
    import subprocess
    r = subprocess.run(["/usr/bin/python3", os.path.expanduser("~/health-data/abdullah/hlog.py"), "site", "log", sites["test"], day,
                        "--source", "took.py"], capture_output=True, text=True)
    print("site", day, sites["test"] + "-VG", (r.stdout.strip() or r.stderr.strip()[-200:]))
show_open(day, t)
