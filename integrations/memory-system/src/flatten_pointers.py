#!/usr/bin/env python3
"""Pointer-flattening pass (post-consolidation cosmetic).

Facts retired as duplicates point superseded_by_id at a canonical. Some
canonicals were themselves superseded, so a fact's pointer chain is >1 hop.
This pass collapses each multi-hop chain so superseded_by_id points directly
at the terminal ACTIVE fact. It never changes is_active, valid_until, or the
terminal's own pointers.

Safety:
- Only touches semantic_facts.superseded_by_id for facts whose terminal
  differs from the immediate target (true multi-hop).
- Skips facts whose chain dead-ends on an inactive fact with no successor.
- Cycle-safe: visited-set; any cycle is skipped and reported.
- Logged into consolidation.db apply_log (run_id = new apply_runs row) for
  rollback; mirrors consolidate.py's log shape.
- Busy-retry safe: BEGIN IMMEDIATE + exponential backoff, small batches.

Usage:
  python3 src/flatten_pointers.py --dry-run
  python3 src/flatten_pointers.py --apply --batch 500
"""
import argparse, os, sqlite3, sys, time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM = os.path.join(BASE, "data", "memory.db")
CON = os.path.join(BASE, "data", "consolidation.db")


def connect(path, timeout=5.0):
    c = sqlite3.connect(path, timeout=timeout, isolation_level=None)
    c.execute("PRAGMA busy_timeout=60000")
    c.execute("PRAGMA journal_mode=WAL")
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
    raise RuntimeError("could not acquire write lock after retries")


def terminal(mem, start_id):
    """Walk superseded_by_id chain from start_id. Return (terminal_id, hops, status).
    status: 'active' terminal, 'deadend' (inactive, no succ), 'cycle'."""
    seen = set()
    cur = start_id
    hops = 0
    while cur is not None:
        if cur in seen:
            return None, hops, "cycle"
        seen.add(cur)
        row = mem.execute("select is_active, superseded_by_id from semantic_facts where id=?",
                          (cur,)).fetchone()
        if row is None:
            return None, hops, "deadend"
        is_active, nxt = row
        if nxt is None:
            return cur, hops, ("active" if is_active == 1 else "deadend")
        cur = nxt
        hops += 1
    return None, hops, "deadend"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="perform writes (default dry-run)")
    ap.add_argument("--batch", type=int, default=500)
    ap.add_argument("--pause", type=float, default=0.02)
    args = ap.parse_args()

    mem = connect(MEM)
    con = connect(CON)

    # All retired dups whose immediate target is itself superseded or inactive.
    multi = mem.execute(
        """select f.id, f.superseded_by_id
           from semantic_facts f
           join semantic_facts c on c.id = f.superseded_by_id
           where f.superseded_by_id is not null
             and (c.superseded_by_id is not null or c.is_active = 0)"""
    ).fetchall()

    moves = []     # (fact_id, old_target, terminal_id, hops)
    deadend = []   # (fact_id, old_target)
    cycles = []
    for fid, tgt in multi:
        term, hops, status = terminal(mem, tgt)
        if status == "active" and term is not None and term != tgt:
            moves.append((fid, tgt, term, hops))
        elif status == "cycle":
            cycles.append((fid, tgt))
        else:
            deadend.append((fid, tgt))

    print(f"multi-hop facts: {len(multi)}")
    print(f"  to flatten (active terminal, != immediate): {len(moves)}")
    print(f"  dead-end (inactive terminal, skipped):      {len(deadend)}")
    print(f"  cycles (skipped):                            {len(cycles)}")
    if moves:
        from collections import Counter
        hc = Counter(h for *_x, h in moves)
        print("  hop-count histogram:", dict(sorted(hc.items())))

    if not args.apply:
        print("\nDRY RUN - no writes. Re-run with --apply.")
        return

    if not moves:
        print("nothing to do.")
        return

    # Log run
    def mk_run():
        con.execute("BEGIN IMMEDIATE")
        cur = con.execute(
            "insert into apply_runs(started_at, note) values (?, ?)",
            (int(time.time()), f"pointer-flatten: {len(moves)} facts"))
        rid = cur.lastrowid
        con.execute("COMMIT")
        return rid
    run_id = retry_write(mk_run)
    print(f"\napply_run id={run_id}")

    done = 0
    for i in range(0, len(moves), args.batch):
        chunk = moves[i:i + args.batch]

        def work():
            mem.execute("BEGIN IMMEDIATE")
            for fid, tgt, term, _h in chunk:
                mem.execute(
                    "update semantic_facts set superseded_by_id=? where id=? and superseded_by_id=?",
                    (term, fid, tgt))
            mem.execute("COMMIT")
        retry_write(work)

        def logw():
            con.execute("BEGIN IMMEDIATE")
            for fid, tgt, term, _h in chunk:
                # action 'flatten_pointer'; prev_superseded_by = old target
                con.execute(
                    "insert or replace into apply_log(run_id, fact_id, action, prev_superseded_by)"
                    " values (?,?,?,?)",
                    (run_id, fid, "flatten_pointer", tgt))
            con.execute("COMMIT")
        retry_write(logw)

        done += len(chunk)
        print(f"  {done}/{len(moves)}")
        time.sleep(args.pause)

    def fin():
        con.execute("BEGIN IMMEDIATE")
        con.execute("update apply_runs set finished_at=? where id=?", (int(time.time()), run_id))
        con.execute("COMMIT")
    retry_write(fin)

    # Verify: no remaining multi-hop among moved ids
    verify = mem.execute(
        """select count(*) from semantic_facts f
           join semantic_facts c on c.id=f.superseded_by_id
           where f.superseded_by_id is not null
             and (c.superseded_by_id is not null or c.is_active=0)"""
    ).fetchone()[0]
    print(f"\nDONE run_id={run_id} flattened={done}. Remaining multi-hop: {verify} "
          f"(expected ~{len(deadend)} dead-end + {len(cycles)} cycles).")
    if deadend:
        print("dead-end fact ids:", [d[0] for d in deadend][:20])
    if cycles:
        print("cycle fact ids:", [c[0] for c in cycles][:20])


if __name__ == "__main__":
    main()
