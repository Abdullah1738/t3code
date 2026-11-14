#!/usr/bin/env python3

import contextlib as _log_context
import sys as _log_sys
from pathlib import Path as _LogPath
try:
    _log_sys.path.insert(0, str(_LogPath(__file__).resolve().parents[2]))
    import toollog as _tl
except Exception:
    _tl = None
with (_tl.run('took', _log_sys.argv[1:], name='cli.run')
      if _tl is not None and __name__ == '__main__' else _log_context.nullcontext()) as _took_log:
    # Confirm a dose: ./took.py [YYYY-MM-DD] all|name[=2mg][:L|R]... (also test:R=100mg)
    # Skip a dose:     ./took.py [YYYY-MM-DD] skip <name>... [--note "text"]   (writes moved.json, never taken.json)
    import json, os, sys, datetime as dt, re
    from decimal import Decimal
    import importlib.util
    D = os.path.dirname(os.path.abspath(__file__)); p = os.path.join(D,"taken.json")
    spec = importlib.util.spec_from_file_location("meds_check", os.path.join(D, "check.py"))
    mc = importlib.util.module_from_spec(spec); spec.loader.exec_module(mc)
    now = mc.now
    a = sys.argv[1:]; day = str((now - dt.timedelta(hours=5)).date())  # before 5am counts as previous day
    if a and a[0][:2] == "20": day, a = a[0], a[1:]
    MEDS = ["dutasteride", "tadalafil", "arimidex", "reta", "test"]
    USAGE = ("usage: took.py [YYYY-MM-DD] <name[=NUMBERmg|mcg|iu][:L|R]...|all> | skip <name>... [--note text] | "
             "snooze <name|all> [--until HH:MM | --until YYYY-MM-DDTHH:MM | --days N] | "
             "unsnooze <name|all> | snoozed")
    def atomic_write(name, value):
        path = os.path.join(D, name); tmp = path + ".tmp"
        with open(tmp, "w") as f: json.dump(value, f, indent=1)
        os.replace(tmp, path)
    def parse_dose(token):
        amount = None
        if "=" in token:
            m = re.fullmatch(r"([a-z]+)(?::([LR](?:-VG|-SQ)?))?=(\d+(?:\.\d*)?|\.\d+)(mg|mcg|iu)(?::([LR](?:-VG|-SQ)?))?", token, re.I)
            if not m or (m[2] and m[5]): sys.exit("invalid dose: " + token + "\n" + USAGE)
            name, site = m[1].lower(), m[2] or m[5]
            amt = format(Decimal(m[3]), "f")
            if "." in amt: amt = amt.rstrip("0").rstrip(".")
            amount = (amt, m[4].lower())
            if name not in MEDS: sys.exit(USAGE)
        else:
            parts = token.split(":", 1)
            name, site = parts[0].lower(), parts[1] if len(parts) == 2 else None
        if site is not None:
            site = site.upper().replace("-VG", "").replace("-SQ", "")
            if site not in ("L", "R"): sys.exit("site must be L or R: " + token + "\n" + USAGE)
        return name, site, amount
    def scheduled(name, date, taken):
        for label in mc.due(date):
            if mc.key(label) == name: return label, None
        for label, due_date in mc.carried(date, taken):
            if mc.key(label) == name: return label, due_date
        # A retry/correction on the same day must retain the carry's schedule after it was closed.
        if name in taken.get(str(date), []):
            before = dict(taken, **{str(date): [n for n in taken[str(date)] if n != name]})
            for label, due_date in mc.carried(date, before):
                if mc.key(label) == name: return label, due_date
        return None, None
    def record_amounts(day, taken, amounts):
        try:
            with open(os.path.join(D, "doses.json")) as f: doses = json.load(f)
        except FileNotFoundError:
            doses = {}
        except (OSError, ValueError) as e:
            sys.exit("could not read doses.json: " + str(e))
        flags = []
        changed = False
        for name, (amt, unit) in amounts.items():
            label, due_date = scheduled(name, dt.date.fromisoformat(day), taken)
            match = re.search(r"([\d.]+)\s*(mg|mcg|iu)", label, re.I) if label else None
            if match and (Decimal(amt), unit) == (Decimal(match[1]), match[2].lower()):
                if name in doses.get(day, {}):
                    current = doses[day][name]
                    previous = re.match(r"\s*([\d.]+)\s*(mg|iu|mcg)", current, re.I) if isinstance(current, str) else None
                    if not previous or (Decimal(previous[1]), previous[2].lower()) != (Decimal(amt), unit):
                        doses[day][name] = amt + unit + " (actual)"
                        changed = True
                continue
            actual = amt + unit
            carried = due_date.strftime("%a %-d %b") if due_date else None
            if match:
                sched = match[1] + match[2].lower()
                note = "actual, not the scheduled " + sched + ("; carried from " + carried if carried else "")
                reason = "differs from the scheduled " + sched + (" (from " + carried + ")" if carried else "")
            else:
                note, reason = "actual, not scheduled", "is not scheduled"
            value = actual + " (" + note + ")"
            if doses.get(day, {}).get(name) == value: continue
            doses.setdefault(day, {})[name] = value
            changed = True
            flags.append("flag: %s %s %s; logged as %s" % (name.capitalize(), actual, reason, actual))
        if changed: atomic_write("doses.json", doses)
        return flags
    def write_snoozes(active):
        atomic_write("snooze.json", active)
    def prune_snoozes():
        active = mc.active_snoozes()
        if active != mc.load("snooze.json", {}): write_snoozes(active)
    def show_snoozed():
        active = mc.active_snoozes()
        if active:
            print("snoozed: " + ", ".join(name + " until " + dt.datetime.fromisoformat(until).astimezone(mc.DUBAI).strftime("%a %-d %b %H:%M")
                                         for name, until in sorted(active.items())))
        else: print("snoozed: nothing")
    def snooze_command(args):
        command = args[0].lower()
        if command == "snoozed":
            if len(args) != 1: sys.exit(USAGE)
            show_snoozed(); raise SystemExit(0)
        if len(args) < 2 or not args[1].strip(): sys.exit(USAGE)
        name = mc.key(args[1])
        if name not in MEDS + ["all"]: sys.exit("unknown med: " + args[1] + "\n" + USAGE)
        if command == "unsnooze":
            if len(args) != 2: sys.exit(USAGE)
            active = mc.active_snoozes()
            if name == "all": active.clear()
            else:
                # A named resume must also work after a blanket pause.
                until = active.pop("all", None)
                if until:
                    for med in MEDS:
                        if med != name and (med not in active or dt.datetime.fromisoformat(active[med]) < dt.datetime.fromisoformat(until)):
                            active[med] = until
                active.pop(name, None)
            write_snoozes(active)
            print("unsnoozed:", name)
        else:
            until = dt.datetime.combine(now.date() + dt.timedelta(days=1), dt.time(5), mc.DUBAI)
            if len(args) != 2:
                if len(args) != 4: sys.exit(USAGE)
                option, value = args[2:]
                try:
                    if option == "--days":
                        days = int(value)
                        if days <= 0: raise ValueError("days must be positive")
                        until = now + dt.timedelta(days=days)
                    elif option == "--until":
                        if len(value) == 5:
                            clock = dt.datetime.strptime(value, "%H:%M").time()
                            until = dt.datetime.combine(now.date(), clock, mc.DUBAI)
                            if until <= now: until += dt.timedelta(days=1)
                        else:
                            until = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M").replace(tzinfo=mc.DUBAI)
                    else: sys.exit(USAGE)
                    if until <= now: raise ValueError("until must be in the future")
                except (ValueError, OverflowError) as e: sys.exit(str(e) + "\n" + USAGE)
            active = mc.active_snoozes(); active[name] = until.isoformat()
            write_snoozes(active)
            mc.outcome_action("snooze", day, MEDS if name == "all" else [name],
                              mc.load("taken.json", {}))
            show_snoozed()
        raise SystemExit(0)
    def show_open(day, t):
        # carry-forward: a missed dose confirmed later is logged on the day actually taken (above) and that clears
        # the carry in check.py, so it isn't nagged again or counted twice. Show what is still open.
        try:
            left = mc.outstanding(dt.date.fromisoformat(day), t)
            print("still open for", day + ":", ", ".join(left) if left else "nothing")
            if mc.active_snoozes(): show_snoozed()
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
            if x not in MEDS: sys.exit("unknown med: " + x + "\n" + USAGE)
        mp = os.path.join(D, "moved.json")
        moved = json.load(open(mp)) if os.path.exists(mp) else {}
        m = moved.setdefault(day, {}); skips = m.setdefault("skip", [])
        for x in names:
            if x not in [s.lower() for s in skips]: skips.append(x.capitalize())
        if note is not None: m["note"] = note
        tmp = mp + ".tmp"
        with open(tmp, "w") as f: json.dump(moved, f, indent=1)
        os.replace(tmp, mp)
        prune_snoozes()
        print("skipped %s: %s" % (day, ", ".join(x.capitalize() for x in names)))
        show_open(day, json.load(open(p)) if os.path.exists(p) else {})
        raise SystemExit(0)
    if a and a[0].lower() in ("snooze", "unsnooze", "snoozed"): snooze_command(a)
    if a and a[0].lower() == "skip": skip(day, a[1:])
    t = json.load(open(p)) if os.path.exists(p) else {}
    sites, amounts, names = {}, {}, []
    for token in a:
        name, site, amount = parse_dose(token)
        names.append(name)
        if site: sites["test"] = site
        if amount: amounts[name] = amount
    if names == ["all"]: names = MEDS
    if not names or any(x not in MEDS for x in names): sys.exit(USAGE)
    closes = [(label, date) for label, date in mc.carried(dt.date.fromisoformat(day), t) if mc.key(label) in names]
    flags = record_amounts(day, t, amounts) if amounts else []
    before_taken = dict(t)
    t[day] = sorted(set(t.get(day, []) + names)); json.dump(t, open(p,"w"), indent=1); print(day, t[day])
    mc.outcome_action("resolve", dt.date.fromisoformat(day), names, before_taken,
                      getattr(_took_log, 'run_id', None))
    for flag in flags: print(flag)
    for label, date in closes: print("closes %s from %s" % (label, date.strftime("%a %-d %b")))
    prune_snoozes()
    if sites:
        sp = os.path.join(D, "sites.json"); st = json.load(open(sp)) if os.path.exists(sp) else {}
        st.setdefault(day, {}).update(sites); json.dump(st, open(sp, "w"), indent=1)
        import subprocess
        r = subprocess.run(["/usr/bin/python3", os.path.expanduser("~/health-data/abdullah/hlog.py"), "site", "log", sites["test"], day,
                            "--source", "took.py"], capture_output=True, text=True)
        print("site", day, sites["test"], (r.stdout.strip() or r.stderr.strip()[-200:]))
    show_open(day, t)
