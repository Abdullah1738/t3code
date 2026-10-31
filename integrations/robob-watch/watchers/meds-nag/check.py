#!/usr/bin/env python3
# Nags owner hourly (09:00-23:45 Dubai) about meds due today until confirmed.
# Confirm with: ./took.py [YYYY-MM-DD] all|name...   (state in taken.json)
import json, os, datetime as dt
from zoneinfo import ZoneInfo
D = os.environ.get("WATCH_DIR", os.path.dirname(os.path.abspath(__file__)))
now = dt.datetime.now(ZoneInfo("Asia/Dubai"))
today = now.date()
def due(d):
    items = ["Dutasteride 0.5mg", "Tadalafil 5mg"]
    # Arimidex: q3d until cruise; cruise taper from Oct 23 (q5d x2wk, then weekly w/ Mon pin x2, then stop)
    CRUISE = dt.date(2026,10,23)
    if dt.date(2026,10,7) <= d < CRUISE and (d - dt.date(2026,10,7)).days % 3 == 0:
        items.append("Arimidex 0.5mg (half pill)")
    if d in (dt.date(2026,10,27), dt.date(2026,11,1), dt.date(2026,11,9), dt.date(2026,11,16)):
        items.append("Arimidex 0.5mg (half pill, cruise taper)")
    if d.weekday() == 3: items.append("Reta 3mg")
    if d.weekday() in (0,4): items.append("Test E 250mg" if d < CRUISE else "Test E 100mg = 0.4ml (cruise)")
    # one-off moves: moved.json {"YYYY-MM-DD": {"add": [...], "skip": [...]}}
    try: m = json.load(open(os.path.join(D,"moved.json"))).get(str(d), {})
    except Exception: m = {}
    items = [i for i in items if i.split()[0].lower() not in [x.lower() for x in m.get("skip", [])]]
    items += [x for x in m.get("add", []) if x not in items]
    return items
# Carry-forward (owner rule 2026-10-17): a missed dose of these meds is NOT skipped. It stays in the nag
# as "<dose> (from Fri 16 Oct)" on following days until confirmed, and is dropped once that med's next
# scheduled dose is due (never stacks two doses; the schedule itself is never shifted).
# Other meds (daily pills) stay skip-on-miss. A carried dose counts as taken when its name is in
# taken.json on its due date or any later day up to now (took.py logs it on the day actually taken).
CARRY_FORWARD = {"test", "arimidex", "reta"}
CARRY_SINCE = dt.date(2026,10,16)  # earliest due date that can carry
def key(i): return i.split()[0].lower()
def carried(d, taken):
    """[(label, due_date)] carry-forward doses due before d, not yet confirmed, whose next dose isn't due by d."""
    out, due_today = [], {key(i) for i in due(d)}
    for k in sorted(CARRY_FORWARD - due_today):
        x = d - dt.timedelta(days=1)
        while x >= max(CARRY_SINCE, d - dt.timedelta(days=14)):
            hit = [i for i in due(x) if key(i) == k]
            if hit:
                done = any(k in [t.lower() for t in taken.get(str(x + dt.timedelta(days=n)), [])] for n in range((d - x).days + 1))
                if not done: out.append((hit[0], x))
                break
            x -= dt.timedelta(days=1)
    return out
def outstanding(d, taken):
    """Nag list for day d: today's unconfirmed doses + carried-over missed carry-forward doses."""
    tk = [t.lower() for t in taken.get(str(d), [])]
    left = [i for i in due(d) if key(i) not in tk]
    left += ["%s (from %s, missed)" % (lab, x.strftime("%a %-d %b")) for lab, x in carried(d, taken)]
    return left
def load(p, default):
    try: return json.load(open(os.path.join(D,p)))
    except Exception: return default
import sqlite3, subprocess, time
def awake():
    # Mac in use in last 15 min, or owner sent an iMessage (not to Moni chat 45, where robob also sends) in last 20 min
    try:
        o = subprocess.run(["ioreg","-c","IOHIDSystem"],capture_output=True,text=True,timeout=5).stdout
        idle = int(o.split('"HIDIdleTime" = ')[1].split()[0]) / 1e9
        if idle < 900: return True
    except Exception: pass
    try:
        c = sqlite3.connect("file:" + os.path.expanduser("~/Library/Messages/chat.db") + "?mode=ro", uri=True, timeout=3)
        cut = (time.time() - 978307200 - 1200) * 1e9
        n = c.execute("select count(*) from message m join chat_message_join j on j.message_id=m.rowid where m.is_from_me=1 and m.date>? and j.chat_id!=45", (cut,)).fetchone()[0]
        if n: return True
    except Exception: pass
    return False
def main():
  taken = load("taken.json", {})
  st = load("nagstate.json", {})
  if 9 <= now.hour <= 23: day = today
  elif now.hour < 5 and awake(): day = today - dt.timedelta(days=1)  # late night: keep nagging about yesterday while he's up
  else: raise SystemExit(0)
  left = outstanding(day, taken)
  if not left: raise SystemExit(0)
  last = st.get("last")
  gap = 3600 if now.hour >= 9 else 1800
  if last and (now - dt.datetime.fromisoformat(last)).total_seconds() < gap: raise SystemExit(0)
  st["last"] = now.isoformat(); json.dump(st, open(os.path.join(D,"nagstate.json"),"w"))
  def site_hint():
      # last Test E pin side: health.db (hlog.py) first, then sites.json
      last = None
      try:
          c = sqlite3.connect("file:" + os.path.expanduser("~/health-data/abdullah/health.db") + "?mode=ro", uri=True, timeout=3)
          r = c.execute("select date, site from injection_sites where compound='Testosterone Enanthate' order by date desc, id desc limit 1").fetchone()
          if r: last = (r[0], r[1][0])
      except Exception: pass
      for d, m in load("sites.json", {}).items():
          if "test" in m and (last is None or d > last[0]): last = (d, m["test"])
      if not last: return " (log which side you pin, e.g. test:L)"
      nxt = "R" if last[1] == "L" else "L"
      return " (pin %s VG, last was %s on %s)" % ({"L": "left", "R": "right"}[nxt], {"L": "left", "R": "right"}[last[1]], last[0])
  left = [i + site_hint() if i.lower().startswith("test") else i for i in left]
  print("💊 Meds check: still need to take " + ", ".join(left) + ". Text me when done and I'll stop.")
if __name__ == "__main__": main()
