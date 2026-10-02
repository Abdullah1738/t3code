#!/usr/bin/env python3
"""One-off: apply Abdullah's janitor-digest decisions (2026-09-26).

Drop = retire (is_active=0). Where a winning fact covers the same subject, set
superseded_by_id -> winner and valid_until -> winner.valid_from. Where there is
no canonical winner (stale one-off snapshot, bad guess with no replacement), just
retire with superseded_by_id=NULL. Keep facts are left untouched.

Logged to consolidation.db apply_runs/apply_log for rollback.
"""
import sqlite3, time, sys

MEM = "data/memory.db"; CON = "data/consolidation.db"

# (drop_id, winner_id_or_None, note)
DECISIONS = [
    (685771, None,  "stale main-dev deploy snapshot A"),
    (685895, None,  "stale main-dev deploy snapshot B"),
    (722102, 724425,"edge-api#134 review note A -> 724425 approved"),
    (722103, 724425,"edge-api#134 review note B -> 724425 approved"),
    (684971, 685094,"older USD spot-fill pricing rule -> 685094"),
    (14687,  15780, "Juno coin type guess 1337 -> 15780 real 8133"),
    (15596,  15780, "Juno Zcash guess -> 15780 real 8133"),
    (53391,  15780, "Juno BIP44 1337 guess -> 15780 real 8133"),
    (109472, 113180,"orchestrator tick default -> 113180 deployed 30s"),
    # 112330 HELD: 'prefers frequent commits' is TRUE (confirmed in the other
    # thread) and no other active fact states commit cadence. Dropping it would
    # leave a gap. Left active.
    (667243, None,  "Abdullah compliance-kyc PR author profile (drop)"),
    (678094, None,  "pelican test prompt (not a real preference)"),
]

def connect(p, ro=False):
    uri = f"file:{p}?mode=ro" if ro else p
    c = sqlite3.connect(uri, uri=ro, isolation_level=None, timeout=5.0)
    c.execute("PRAGMA busy_timeout=60000")
    return c

def retry_write(fn, tries=40):
    for i in range(tries):
        try: return fn()
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower() or "busy" in str(e).lower():
                time.sleep(min(2.0, 0.05*(1.5**i))); continue
            raise
    raise RuntimeError("lock retries exhausted")

def main():
    dry = "--apply" not in sys.argv
    mem = connect(MEM); con = connect(CON)
    now = int(time.time())

    # sanity: all drops currently active
    for did, win, note in DECISIONS:
        r = mem.execute("select is_active from semantic_facts where id=?", (did,)).fetchone()
        if not r: print(f"  !! drop {did} not found"); return
        if r[0] != 1: print(f"  !! drop {did} already inactive"); return
        if win:
            w = mem.execute("select is_active, valid_from from semantic_facts where id=?", (win,)).fetchone()
            if not w or w[0] != 1: print(f"  !! winner {win} not active"); return

    print(f"applying {len(DECISIONS)} drops" + (" (DRY RUN)" if dry else ""))
    if dry:
        for did, win, note in DECISIONS:
            print(f"  drop {did} -> superseded_by {win}  ({note})")
        return

    def mkrun():
        con.execute("BEGIN IMMEDIATE")
        cur = con.execute("insert into apply_runs(started_at,note) values (?,?)",
                          (now, f"janitor decisions 2026-09-26: {len(DECISIONS)} drops"))
        rid = cur.lastrowid; con.execute("COMMIT"); return rid
    rid = retry_write(mkrun)

    for did, win, note in DECISIONS:
        prev = mem.execute("select is_active, superseded_by_id, valid_until from semantic_facts where id=?", (did,)).fetchone()
        if win:
            wvf = mem.execute("select valid_from from semantic_facts where id=?", (win,)).fetchone()[0]
            new_sup, new_vu = win, wvf
        else:
            new_sup, new_vu = None, prev[2]  # keep prior valid_until
        def w():
            mem.execute("BEGIN IMMEDIATE")
            mem.execute("update semantic_facts set is_active=0, superseded_by_id=?, valid_until=? where id=?",
                        (new_sup, new_vu, did))
            mem.execute("COMMIT")
        retry_write(w)
        def lg():
            con.execute("BEGIN IMMEDIATE")
            con.execute("insert or replace into apply_log(run_id,fact_id,action,prev_is_active,prev_superseded_by,prev_valid_until) values (?,?,?,?,?,?)",
                        (rid, did, "janitor_decision_drop", prev[0], prev[1], prev[2]))
            con.execute("COMMIT")
        retry_write(lg)
        print(f"  dropped {did} -> {new_sup}")

    def fin():
        con.execute("BEGIN IMMEDIATE")
        con.execute("update apply_runs set finished_at=? where id=?", (int(time.time()), rid)); con.execute("COMMIT")
    retry_write(fin)
    print(f"DONE run_id={rid}")

if __name__ == "__main__":
    main()
