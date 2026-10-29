#!/usr/bin/env python3
"""Checks the out/<D>-recovery-sent marker in cards.py main(). Rendering and WHOOP reads are mocked;
no live health.db or PNG is touched. cards.py is loaded from a temp copy so its pending flag stays in temp."""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = Path(os.environ.get("CARDS_PY", HERE.parent.parent.parent.parent / "tmp/robob-board/morning-brief/health-data/abdullah/cards/cards.py"))
_scratch = Path(tempfile.mkdtemp())
(_scratch / "cards.py").write_text(SRC.read_text())
spec = importlib.util.spec_from_file_location("cards", _scratch / "cards.py")
cards = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cards)

D = "2026-10-28"

# cards.py only sets pending_flag when the brief date is today (Dubai). Freeze its clock to the fixture day
# so the held-flag assertion holds on any real date.
from datetime import datetime as _real_datetime


class _FrozenDatetime(_real_datetime):
    @classmethod
    def now(cls, tz=None):
        return _real_datetime(2026, 10, 28, 12, 0, tzinfo=tz)


cards.datetime = _FrozenDatetime
ready = {"stale": False, "rec_ok": True, "cur": {"sleep_date": D}, "prev": {}, "prev_ok": False,
         "ycyc": None, "hrv30": None, "rhr30": None}
stale = dict(ready, stale=True)
sleep_only = dict(ready, rec_ok=False)  # scored sleep, recovery still pending


def run(wd, tmp, extra_argv=()):
    cards.whoop = lambda d: wd
    cards.card_recovery = lambda d, out: str(out)
    cards.card_body = lambda d, out, take=None: str(out)
    cards.brief = lambda wd: {"fresh": wd is not None and not wd["stale"] and wd["rec_ok"]}
    (tmp / "out").mkdir(parents=True, exist_ok=True)
    sys.argv = ["cards.py", "morning", "--date", D, "--out", str(tmp / "out"), *extra_argv]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        cards.main()
    return json.loads(buf.getvalue())


def case(fn):
    with tempfile.TemporaryDirectory() as t:
        return fn(Path(t))


results = []
# Fresh and scored: recovery returned, marker written.
def c_fresh(tmp):
    res = run(ready, tmp)
    return len(res["cards"]) == 2 and (tmp / "out" / f"{D}-recovery-sent").exists()
results.append(("fresh scored recovery -> card returned, marker written", case(c_fresh)))

# Stale sleep: no recovery card, no marker.
def c_stale(tmp):
    res = run(stale, tmp)
    return "stale_cards" in res and not (tmp / "out" / f"{D}-recovery-sent").exists()
results.append(("stale sleep -> no marker", case(c_stale)))

# Scored sleep but recovery pending (rec_ok False): must NOT mark, must hold recovery.
def c_pending(tmp):
    res = run(sleep_only, tmp)
    return "stale_cards" in res and not (tmp / "out" / f"{D}-recovery-sent").exists() and res.get("pending_flag") is True
results.append(("scored sleep, recovery pending -> no marker, held", case(c_pending)))

# Marker already present (standalone sent earlier): a later brief omits the recovery card.
def c_already(tmp):
    (tmp / "out").mkdir(parents=True, exist_ok=True)
    (tmp / "out" / f"{D}-recovery-sent").touch()
    res = run(ready, tmp)
    return res["cards"] and len(res["cards"]) == 1 and res.get("recovery_already_sent") is True
results.append(("marker exists -> later brief returns no second recovery card", case(c_already)))

failed = [n for n, ok in results if not ok]
for n, ok in results:
    print(("PASS " if ok else "FAIL ") + n)
print(f"cards.py marker: {len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
