#!/usr/bin/env python3
"""Apply memory-janitor review decisions from a JSON file.

The janitor opens an OpenChamber review session each day it has questions. The
review agent drafts a decisions file, Abdullah approves or amends it, and this
script applies it to memory.db. Every change is logged to consolidation.db
(apply_runs / apply_log / janitor_conf_log) so a run can be rolled back.

JSON shape (every list is optional; omitted facts are left alone):
  {
    "review": "2026-09-28",          # optional; marks the review applied
    "note": "janitor review 2026-09-28",
    "drops":     [{"id": 722102, "winner": 724425, "why": "dup of approved fact"},
                  {"id": 685771, "winner": null,   "why": "stale deploy snapshot"}],
    "resurrect": [{"id": 94907,  "why": "still true, canonical was lost"}],
    "retire":    [{"id": 94910,  "why": "dead-end, obsolete; stays retired"}],
    "relink":    [{"id": 94911,  "winner": 724425, "why": "point at live canonical"}],
    "keep":      [{"id": 727405, "why": "confirmed preference"}]
  }

Actions
- drops:     active fact -> retired. winner (active) sets superseded_by_id and
             valid_until = winner.valid_from; null = retired with no replacement.
- resurrect: dead-end (inactive) fact -> active again; clears superseded_by_id
             and valid_until.
- retire:    dead-end fact stays inactive; its dangling superseded_by_id is
             cleared so the janitor stops asking about it.
- relink:    dead-end fact stays inactive; superseded_by_id -> winner (active).
- keep:      low-confidence profile/preference confirmed; confidence raised to
             KEEP_CONF so the janitor stops asking about it.

Guardrails
- Drops of preference/decision/constraint/profile facts are refused unless
  --allow-preference-drop is passed (Abdullah must have ruled on them).
- Validation runs before anything is written; any error aborts the run.

Run from the memory-system dir:
  .venv/bin/python src/apply_decisions.py decisions.json            # dry run
  .venv/bin/python src/apply_decisions.py decisions.json --apply
  .venv/bin/python src/apply_decisions.py --rollback RUN_ID         # undo a run
  .venv/bin/python src/apply_decisions.py --close-review [--status closed]
"""
import argparse, json, os, sqlite3, sys, time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM = os.path.join(BASE, "data", "memory.db")
CON = os.path.join(BASE, "data", "consolidation.db")
REVIEW_STATE = os.path.join(BASE, "logs", "janitor-review", "state.json")

GUARD_TYPES = ("preference", "decision", "constraint", "profile")
KEEP_CONF = 0.6
ACTIONS = ("drops", "resurrect", "retire", "relink", "keep")
LOG_ACTION = {"drops": "janitor_decision_drop", "resurrect": "janitor_resurrect",
              "retire": "janitor_retire_deadend", "relink": "janitor_relink_decision",
              "keep": "janitor_keep"}


def connect(p, ro=False):
    uri = f"file:{p}?mode=ro" if ro else p
    c = sqlite3.connect(uri, uri=ro, isolation_level=None, timeout=5.0)
    c.execute("PRAGMA busy_timeout=60000")
    return c


def retry_write(fn, tries=40):
    for i in range(tries):
        try:
            return fn()
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() or "busy" in str(e).lower():
                time.sleep(min(2.0, 0.05 * (1.5 ** i)))
                continue
            raise
    raise RuntimeError("lock retries exhausted")


def tx(db, fn):
    def run():
        db.execute("BEGIN IMMEDIATE")
        try:
            out = fn()
            db.execute("COMMIT")
            return out
        except Exception:
            db.execute("ROLLBACK")
            raise
    return retry_write(run)


def ensure_conf_log(con):
    con.execute("""create table if not exists janitor_conf_log(
        run_id integer not null, fact_id integer not null, prev_confidence real,
        primary key(run_id, fact_id))""")


def update_review_state(**fields):
    if not os.path.exists(REVIEW_STATE):
        return
    st = json.load(open(REVIEW_STATE))
    st.update(fields)
    tmp = REVIEW_STATE + ".tmp"
    json.dump(st, open(tmp, "w"), indent=2)
    os.replace(tmp, REVIEW_STATE)


def fact(mem, fid):
    r = mem.execute("""select id, is_active, fact_type, statement, superseded_by_id,
                              valid_until, supersedes_id, confidence, valid_from
                       from semantic_facts where id=?""", (fid,)).fetchone()
    if not r:
        return None
    k = ("id", "is_active", "fact_type", "statement", "superseded_by_id",
         "valid_until", "supersedes_id", "confidence", "valid_from")
    return dict(zip(k, r))


def validate(mem, spec, allow_pref):
    errors, guarded, seen = [], [], {}
    for act in ACTIONS:
        for d in spec.get(act, []) or []:
            fid = d.get("id")
            if not isinstance(fid, int):
                errors.append(f"{act}: bad id {fid!r}"); continue
            if fid in seen:
                errors.append(f"{fid} appears in both {seen[fid]} and {act}"); continue
            seen[fid] = act
            f = fact(mem, fid)
            if not f:
                errors.append(f"{act} {fid}: not found"); continue
            win = d.get("winner")
            if act in ("drops", "keep") and f["is_active"] != 1:
                errors.append(f"{act} {fid}: not active")
            if act in ("resurrect", "retire", "relink") and f["is_active"] != 0:
                errors.append(f"{act} {fid}: already active")
            if act == "relink" and not win:
                errors.append(f"relink {fid}: winner required")
            if win is not None:
                if win == fid:
                    errors.append(f"{act} {fid}: winner is itself")
                w = fact(mem, win)
                if not w or w["is_active"] != 1:
                    errors.append(f"{act} {fid}: winner {win} not active")
            if act == "drops" and f["fact_type"] in GUARD_TYPES and not allow_pref:
                guarded.append(f"{fid} [{f['fact_type']}] {f['statement'][:80]}")
    return errors, guarded


def cmd_apply(args):
    spec = json.load(open(args.decisions))
    note = spec.get("note", f"janitor review {time.strftime('%Y-%m-%d')}")
    counts = {a: len(spec.get(a, []) or []) for a in ACTIONS}
    total = sum(counts.values())
    if not total:
        print("no decisions in file")
        if args.apply and spec.get("review"):
            update_review_state(status="applied", applied_at=int(time.time()), run_id=None)
        return 0

    mem = connect(MEM, ro=not args.apply); con = connect(CON)
    errors, guarded = validate(mem, spec, args.allow_preference_drop)
    if errors:
        print("ERRORS - fix before applying:")
        for e in errors: print("  " + e)
        return 2
    if guarded:
        print("GUARDED drops (preference/decision/constraint/profile). Only pass "
              "--allow-preference-drop if Abdullah ruled on each one:")
        for g in guarded: print("  " + g)
        if args.apply:
            return 3

    summary = ", ".join(f"{n} {a}" for a, n in counts.items() if n)
    print(f"{summary}" + ("" if args.apply else " (DRY RUN)"))
    for act in ACTIONS:
        for d in spec.get(act, []) or []:
            f = fact(mem, d["id"])
            extra = f" -> {d['winner']}" if d.get("winner") else ""
            print(f"  {act:9} {d['id']}{extra} [{f['fact_type']}] {f['statement'][:90]}"
                  f"  ({d.get('why', '')})")
    if not args.apply:
        print("\nre-run with --apply to write.")
        return 0

    ensure_conf_log(con)
    now = int(time.time())
    rid = tx(con, lambda: con.execute(
        "insert into apply_runs(started_at,note) values (?,?)",
        (now, f"{note}: {summary}")).lastrowid)

    for act in ACTIONS:
        for d in spec.get(act, []) or []:
            fid, win = d["id"], d.get("winner")
            prev = fact(mem, fid)
            if act == "drops":
                vu = fact(mem, win)["valid_from"] if win else prev["valid_until"]
                sql, params = ("update semantic_facts set is_active=0, superseded_by_id=?, valid_until=? where id=?",
                               (win, vu, fid))
            elif act == "resurrect":
                sql, params = ("update semantic_facts set is_active=1, superseded_by_id=null, valid_until=null where id=?",
                               (fid,))
            elif act == "retire":
                sql, params = ("update semantic_facts set superseded_by_id=null where id=?", (fid,))
            elif act == "relink":
                sql, params = ("update semantic_facts set superseded_by_id=? where id=?", (win, fid))
            else:  # keep
                sql, params = ("update semantic_facts set confidence=max(coalesce(confidence,0),?) where id=?",
                               (KEEP_CONF, fid))
            tx(mem, lambda: mem.execute(sql, params))

            def log():
                con.execute("""insert or replace into apply_log(run_id,fact_id,action,prev_is_active,
                               prev_superseded_by,prev_valid_until,prev_supersedes) values (?,?,?,?,?,?,?)""",
                            (rid, fid, LOG_ACTION[act], prev["is_active"], prev["superseded_by_id"],
                             prev["valid_until"], prev["supersedes_id"]))
                if act == "keep":
                    con.execute("insert or replace into janitor_conf_log(run_id,fact_id,prev_confidence) values (?,?,?)",
                                (rid, fid, prev["confidence"]))
            tx(con, log)

    tx(con, lambda: con.execute("update apply_runs set finished_at=? where id=?", (int(time.time()), rid)))
    if spec.get("review"):
        update_review_state(status="applied", applied_at=int(time.time()), run_id=rid)
    print(f"DONE run_id={rid} ({summary})")
    return 0


def cmd_rollback(run_id):
    mem = connect(MEM); con = connect(CON)
    ensure_conf_log(con)
    run = con.execute("select note, rolled_back_at from apply_runs where id=?", (run_id,)).fetchone()
    if not run:
        print(f"run {run_id} not found"); return 2
    if run[1]:
        print(f"run {run_id} already rolled back"); return 2
    rows = con.execute("""select fact_id, action, prev_is_active, prev_superseded_by, prev_valid_until,
                                 prev_supersedes from apply_log where run_id=?""", (run_id,)).fetchall()
    if not rows or not all(r[1] in LOG_ACTION.values() for r in rows):
        print(f"run {run_id} is not a janitor decisions run; use consolidate.py rollback"); return 2
    conf = dict(con.execute("select fact_id, prev_confidence from janitor_conf_log where run_id=?",
                            (run_id,)).fetchall())
    for fid, act, pa, ps, pv, psup in rows:
        if act == "janitor_decision_drop" and psup is None:
            # older drop rows did not record supersedes_id; leave it untouched
            q, p = ("update semantic_facts set is_active=?, superseded_by_id=?, valid_until=? where id=?",
                    (pa, ps, pv, fid))
        else:
            q, p = ("update semantic_facts set is_active=?, superseded_by_id=?, valid_until=?, supersedes_id=? where id=?",
                    (pa, ps, pv, psup, fid))
        tx(mem, lambda: mem.execute(q, p))
        if fid in conf:
            tx(mem, lambda: mem.execute("update semantic_facts set confidence=? where id=?", (conf[fid], fid)))
    tx(con, lambda: con.execute("update apply_runs set rolled_back_at=? where id=?", (int(time.time()), run_id)))
    print(f"rolled back run {run_id}: {len(rows)} facts restored")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("decisions", nargs="?", help="decisions JSON file")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--allow-preference-drop", action="store_true",
                    help="permit dropping preference/decision/constraint/profile facts")
    ap.add_argument("--rollback", type=int, metavar="RUN_ID")
    ap.add_argument("--close-review", action="store_true",
                    help="mark the pending janitor review closed without applying anything")
    args = ap.parse_args()

    if args.rollback:
        return cmd_rollback(args.rollback)
    if args.close_review:
        update_review_state(status="closed", closed_at=int(time.time()))
        print("review closed"); return 0
    if not args.decisions:
        ap.error("decisions file required")
    return cmd_apply(args)


if __name__ == "__main__":
    sys.exit(main() or 0)
