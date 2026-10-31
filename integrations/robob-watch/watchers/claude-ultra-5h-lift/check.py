#!/usr/bin/env python3
"""Fire once per Ultra account when its 5-hour limit is lifted.
Signals: (a) /api/oauth/usage shows no five_hour window AND no limits[] entry of kind
"session"; (b) an Anthropic email to that address mentioning the 5-hour limit (local msgs
archive). Tokens are read from 9router's DB and never printed."""
import json, os, sqlite3, subprocess, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

W = os.environ.get("WATCH_DIR") or os.path.dirname(os.path.abspath(__file__))
ACC = json.load(open(os.path.join(W, "accounts.json")))
SP = os.path.join(W, "lift-state.json")
DB = "file:/Users/ardud/.9router/db/data.sqlite?mode=ro"
UA = "claude-cli/2.1.0 (external, cli)"

def load():
    try: return json.load(open(SP))
    except Exception: return None

def tokens():
    db = sqlite3.connect(DB, uri=True, timeout=10)
    rows = db.execute("select id, name, data from providerConnections where provider='claude' and isActive=1").fetchall()
    return {r[0]: json.loads(r[2]).get("accessToken") for r in rows}

def usage(tok):
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
        "Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return json.loads(r.read())
    except urllib.error.HTTPError as e: return {"_err": e.code}
    except Exception as e: return {"_err": type(e).__name__}

def api_status(u):
    if not isinstance(u, dict) or "_err" in u: return "unknown", f"api error {u.get('_err') if isinstance(u, dict) else '?'}"
    fh = u.get("five_hour")
    has_sess = any(isinstance(l, dict) and l.get("kind") == "session" for l in (u.get("limits") or []))
    if fh is None or not has_sess:
        return "lifted", "usage API: " + ("five_hour window gone" if fh is None else "session limit gone from limits[]")
    if isinstance(fh, dict) and (fh.get("unlimited") or fh.get("is_unlimited")):
        return "lifted", "usage API: five_hour marked unlimited"
    return "limited", f"usage API: five_hour {fh.get('utilization') if isinstance(fh, dict) else fh}%"

def mail_hits():
    q = ('in:email from:anthropic.com newer_than:14d -"secure link" -receipt '
         '("5-hour" OR "five-hour" OR "5 hour" OR "five hour" OR "session limit" OR "usage limit")')
    try:
        out = subprocess.run(["/Users/ardud/.local/bin/msgs", "search", q, "--json", "--limit", "100"],
                             capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return {}
    hits = {}
    for line in out.splitlines():
        try: m = json.loads(line)
        except Exception: continue
        for a in ACC:
            subj = (m.get("subject") or "").lower()
            # the 30 Oct "Your Max 20x plan is now Ultra" rename notice only announces the rollout; skip it
            if "is now ultra" in subj:
                continue
            if a["email"].lower() in (m.get("recipients") or "").lower():
                hits.setdefault(a["email"], f'email {m.get("date")}: {m.get("subject")}')
    return hits

def main():
    st = load(); prime = st is None
    st = st or {"lifted": {}, "fail_runs": 0}
    try: toks = tokens()
    except Exception: toks = {}
    todo = [a for a in ACC if a["email"] not in st["lifted"]]
    with ThreadPoolExecutor(8) as ex:
        res = dict(zip([a["email"] for a in todo],
                       ex.map(lambda a: usage(toks[a["conn"]]) if toks.get(a["conn"]) else {"_err": "no token"}, todo)))
    mail = mail_hits()
    new, errs = [], 0
    for a in todo:
        e = a["email"]; s, why = api_status(res[e])
        if s == "unknown": errs += 1
        if s != "lifted" and e in mail: s, why = "lifted", mail[e]
        if s == "lifted":
            st["lifted"][e] = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "why": why, "primed": prime}
            new.append((e, why))
    st["fail_runs"] = st["fail_runs"] + 1 if todo and errs == len(todo) else 0
    st["last"] = {a["email"]: api_status(res[a["email"]])[0] for a in todo}
    st["snap"] = {a["email"]: {"five_hour": res[a["email"]].get("five_hour"),
                  "session": [l for l in (res[a["email"]].get("limits") or []) if isinstance(l, dict) and l.get("kind") == "session"]}
                  for a in todo if "_err" not in res[a["email"]]}
    json.dump(st, open(SP + ".tmp", "w"), indent=1); os.replace(SP + ".tmp", SP)
    if prime: return 0
    n, m = len(st["lifted"]), len(ACC)
    for e, why in new:
        print(f"5hr limit now lifted on {e} ({why}); {n} of {m} Ultra accounts done")
    if new and n == m: print("ALL Ultra accounts lifted: remove this watcher (robob-watch remove claude-ultra-5h-lift).")
    if st["fail_runs"] >= 6:
        print("usage API failing for every account for 1h+", file=sys.stderr); return 1
    return 0

if __name__ == "__main__": sys.exit(main())
