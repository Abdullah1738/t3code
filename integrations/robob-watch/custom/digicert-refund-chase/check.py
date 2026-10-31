#!/usr/bin/python3
# DigiCert refund chase: fires REPLY on a real (non-auto) DigiCert email, else CHASE on weekdays every ~22h.
import json, os, subprocess, sys, datetime as dt
from zoneinfo import ZoneInfo
W = os.environ.get("WATCH_DIR", ".")
P = lambda n: os.path.join(W, n)
def load(n, d):
    try: return json.load(open(P(n)))
    except Exception: return d
def save(n, v): json.dump(v, open(P(n), "w"))
st = load("chase.json", {"seen": [], "replied": False, "last_chase": None, "chases": 1})
try:
    out = subprocess.run(["/Users/ardud/.local/bin/mailsearch", "-a", "icloud", "--json", "-n", "40",
                          "from:digicert.com after:2026/10/12"], capture_output=True, text=True, timeout=45)
    d = json.loads(out.stdout)
except Exception as e:
    print(f"mailsearch failed: {e}", file=sys.stderr); sys.exit(1)
if not d.get("status", {}).get("icloud", {}).get("ok"):
    print("mailsearch icloud not ok", file=sys.stderr); sys.exit(1)
AUTO = ("no-reply@digicert.com", "updates@digicert.com", "noreply@digicert.com")
new_real = []
for h in d.get("hits", []):
    mid = h.get("message_id") or f'{h["folder"]}:{h["uid"]}'
    if mid in st["seen"]: continue
    st["seen"].append(mid)
    frm = (h.get("from") or "").lower(); subj = h.get("subject") or ""
    if any(a in frm for a in AUTO) or "available services" in subj.lower() or "auto-reply" in frm:
        continue
    new_real.append(h)
now = dt.datetime.now(ZoneInfo("Asia/Dubai"))
msg = None
if new_real:
    st["replied"] = True
    lines = [f'{h["date"]} | {h["from"]} | {h["subject"]} | read: mailsearch read icloud \'{h["folder"]}\' {h["uid"]}' for h in new_real]
    msg = "REPLY from DigiCert (stop chasing):\n" + "\n".join(lines)
elif not st["replied"]:
    last = dt.datetime.fromisoformat(st["last_chase"]) if st["last_chase"] else None
    if now.weekday() < 5 and 16 <= now.hour < 21 and (last is None or (now - last).total_seconds() >= 22 * 3600):
        st["chases"] += 1; st["last_chase"] = now.isoformat()
        since = f"last follow-up {last:%a %d %b}" if last else "no follow-up yet"
        msg = (f"CHASE #{st['chases']} due ({now:%a %d %b %H:%M} Dubai). No human reply from DigiCert since "
               f"13 Oct; {since}. Send the next follow-up per context.")
save("chase.json", st)
if msg: print(msg)
