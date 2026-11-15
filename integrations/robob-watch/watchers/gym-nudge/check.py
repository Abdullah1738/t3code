#!/usr/bin/env python3

import contextlib as _log_context
import sys as _log_sys
from pathlib import Path as _LogPath
try:
    _log_sys.path.insert(0, str(_LogPath(__file__).resolve().parents[2]))
    import toollog as _tl
except Exception:
    _tl = None
with (_tl.run('gym-nudge', _log_sys.argv[1:], name='watcher.run', trigger=_tl.trigger())
      if _tl is not None and __name__ == '__main__' else _log_context.nullcontext()) as _watch_log:
    # Big gym nudge: Mon-Fri 19:30, Sat/Sun 19:00 Dubai (gym closes 22:30 weekdays / 22:00 weekends;
    # full session needs 2h + 30m travel + 30m getting ready). Skips if a Forge workout is already logged today.
    import json, os, datetime as dt, tempfile, re
    from zoneinfo import ZoneInfo
    D = os.environ.get("WATCH_DIR", os.path.dirname(os.path.abspath(__file__)))
    now = dt.datetime.now(ZoneInfo("Asia/Dubai")); today = str(now.date())
    lf = os.path.join(D, "last_fired")
    stamp_error = None
    try:
        raw = open(lf).read()
    except FileNotFoundError:
        raw = ""
    except OSError as exc:
        raw, stamp_error = "", exc
    last, _, metadata = raw.partition("\n")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw.strip()):
        last, metadata = raw.strip(), ""
    try:
        log_state = json.loads(metadata) if metadata else {}
        if not isinstance(log_state, dict): log_state = {}
    except ValueError:
        log_state = {}
    def write_stamp(value):
        # Keep the firing date separate from diagnostic metadata, including legacy one-line stamps.
        tmp = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=D, prefix=".last_fired-", delete=False) as fh:
                tmp = fh.name
                fh.write(value + "\n" + json.dumps(log_state))
            os.replace(tmp, lf)
        finally:
            if tmp is not None and os.path.exists(tmp): os.unlink(tmp)
    def log_snoozed():
        try:
            if _tl is not None and _tl.snoozed('gym-nudge', 0, log_state, now):
                write_stamp(last.strip())
        except Exception:
            pass
    wkend = now.weekday() >= 5
    start = dt.time(19, 0) if wkend else dt.time(19, 30)
    close = "22:00" if wkend else "22:30"
    if not (start <= now.time() < dt.time(21, 0)):
        log_snoozed()
        raise SystemExit(0)
    if stamp_error is not None:
        raise stamp_error
    if last.strip() == today:
        log_snoozed()
        raise SystemExit(0)
    p = os.path.expanduser("~/Library/Mobile Documents/iCloud~com~abdullah1738~forgeworkout/Documents/latest.json")
    try:
        d = json.load(open(p)); w = d.get("payload", d).get("workouts", [])
        if any(x.get("localDate") == today for x in w):
            log_snoozed()
            write_stamp(today)
            if _tl is not None: _tl.emit('gym-nudge', 'nag.stopped', props={'count': 0})
            raise SystemExit(0)
    except SystemExit: raise
    except Exception: pass  # can't read Forge: nudge anyway
    log_snoozed()
    write_stamp(today)
    print(f"Gym nudge {today} {now:%a %H:%M}: no workout logged today; gym closes {close}, leave by ~{'20:00' if wkend else '20:30'} at the latest for a full session.")
    if _tl is not None: _tl.emit('gym-nudge', 'nag.sent', props={'count': 1}, run_id=getattr(_watch_log, 'run_id', None))
