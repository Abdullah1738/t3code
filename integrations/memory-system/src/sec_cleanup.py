#!/usr/bin/env python3
"""One-time conservative cleanup: retire crypto-security memory facts that read
as operational attack detail or red-team methodology, per Abdullah 2026-09-26.

Why: these facts pattern-match as harmful to Claude models and trigger refusals
when surfaced by recall. We retire (is_active=0) the operational/methodology
subset; we KEEP pure defensive/summary facts (a vuln existed, root cause at a
high level, that it was fixed) — those don't read as instructions.

Classification is by the judge model (glm-5.3-flash via inferhub) with a STRICT
prompt: flag ONLY operational attack detail / step-by-step exploit or PoC
methodology / how-to-exploit framing. Everything else stays. Conservative by
construction: when unsure, keep.

Retired facts are logged to consolidation.db apply_runs/apply_log (action
'sec_cleanup_retire') for rollback. Raw session history is untouched.

Run from the memory-system dir:
  .venv/bin/python src/sec_cleanup.py            # dry run: classify + report only
  .venv/bin/python src/sec_cleanup.py --apply    # retire the flagged subset
"""
import argparse, json, os, sqlite3, sys, threading, time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM = os.path.join(BASE, "data", "memory.db")
CON = os.path.join(BASE, "data", "consolidation.db")
KEY_FILE = os.path.expanduser("~/.config/opencode/inferhub")
BASE_URL = "https://api.inferhub.dev/v1"

# Broad candidate net (we then classify conservatively). Crypto-security cluster.
CAND_WHERE = """
  is_active=1 AND (
    lower(statement) like '%exploit%' OR lower(statement) like '%redteam%'
    OR lower(statement) like '%red team%' OR lower(statement) like '%red-team%'
    OR lower(statement) like '%vuln%' OR lower(statement) like '%reentranc%'
    OR lower(statement) like '%flash loan%' OR lower(statement) like '%attack vector%'
    OR lower(statement) like '%oracle manipulat%' OR lower(statement) like '%price manipulat%'
    OR lower(statement) like '%sandwich%' OR lower(statement) like '%frontrun%'
    OR lower(statement) like '%front-run%' OR lower(statement) like '%drain%'
    OR (lower(statement) like '%contract%' AND (lower(statement) like '%hack%' OR lower(statement) like '%attack%'))
    OR lower(statement) like '%proving exploitab%' OR lower(statement) like '%poc%' OR lower(statement) like '%proof of concept%'
  )
"""

JUDGE = """You are classifying memory facts from a user's own security-research history.
The user does authorized smart-contract security work. We are removing facts whose
TEXT describes how an exploit/attack WORKS or how to EXECUTE it, because that text
reads as attack guidance to an AI assistant that later surfaces it.

Flag a fact YES if its text primarily:
- explains the MECHANISM of an exploit step-by-step (how the attack works: the call
  sequence, the manipulation, the rounding/underflow/reentrancy trick as a how-to), or
- gives attack / PoC methodology, construction, call sequences, payloads, or
  red-team operational process / target-discovery for attacking contracts, or
- walks through an exploit's execution (swaps, mints, drains, crafted inputs).

Do NOT flag (answer NO) facts that ONLY:
- state THAT a vulnerability existed and was found / fixed / closed / mitigated, with
  no how-it-works detail (a pure outcome/defensive summary), or
- mention a CVE / severity / audit outcome / that a review or postmortem happened, or
- describe defensive design, hardening, or review with no exploit mechanics.

When unsure, answer NO. Be conservative, but if it reads as 'how the exploit works'
or 'how to do it', that is YES.

Facts (numbered):
{facts}

Return ONLY JSON: {{"flag": [list of numbers that are YES], "reasons": {{"<num>": "<<=10 words>"}} }}"""


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
                time.sleep(min(2.0, 0.05 * (1.5 ** i))); continue
            raise
    raise RuntimeError("lock retries exhausted")


_tls = threading.local()

def call_judge(key, facts_batch, tries=4):
    """facts_batch: list of (idx, statement). Returns (set flagged idx, reasons dict)."""
    lines = [f"[{i}] {s}" for i, s in facts_batch]
    body = {"model": "glm-5.3-flash",
            "messages": [{"role": "user", "content": JUDGE.replace("{facts}", "\n".join(lines))}],
            "response_format": {"type": "json_object"}, "temperature": 0.0,
            "reasoning": {"enabled": False}}
    for a in range(tries):
        try:
            req = urllib.request.Request(BASE_URL.rstrip("/") + "/chat/completions",
                data=json.dumps(body).encode(),
                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.loads(r.read())
            txt = d["choices"][0]["message"].get("content", "")
            # strip markdown fences
            t = txt.strip()
            if t.startswith("```"):
                t = t.split("```", 2)[1]
                if t.lstrip().startswith("json"):
                    t = t.lstrip()[4:]
                t = t.rsplit("```", 1)[0]
            obj = json.loads(t)
            return set(int(x) for x in obj.get("flag", [])), obj.get("reasons", {})
        except Exception as e:
            if a == tries - 1:
                print(f"  judge error (batch of {len(facts_batch)}): {e}", file=sys.stderr)
                return set(), {}
            time.sleep(1.5 * (a + 1))
    return set(), {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--workers", type=int, default=64)
    ap.add_argument("--batch", type=int, default=20)
    args = ap.parse_args()

    mem = connect(MEM); con = connect(CON)
    key = open(KEY_FILE).read().strip()

    rows = mem.execute(f"select id, statement, fact_type from semantic_facts where {CAND_WHERE} order by id").fetchall()
    print(f"candidate security-cluster facts: {len(rows)}")

    # batch
    batches = []
    for i in range(0, len(rows), args.batch):
        chunk = rows[i:i + args.batch]
        batches.append([(j, s) for j, (_id, s, _t) in enumerate(chunk, start=0)])  # placeholder idx
    # rebuild batches carrying fact id
    batches = []
    for i in range(0, len(rows), args.batch):
        chunk = rows[i:i + args.batch]
        # local indices 1..n within the batch for the prompt
        batches.append({"ids": [c[0] for c in chunk],
                        "lines": [(k + 1, c[1]) for k, c in enumerate(chunk)]})

    flagged_ids = set()
    reasons = {}
    done = [0]
    def work(b):
        fl, rs = call_judge(key, b["lines"])
        ids = b["ids"]
        for local_idx in fl:
            if 1 <= local_idx <= len(ids):
                flagged_ids.add(ids[local_idx - 1])
                if str(local_idx) in rs:
                    reasons[ids[local_idx - 1]] = rs[str(local_idx)]
        done[0] += 1
        if done[0] % 10 == 0:
            print(f"  judged {done[0]}/{len(batches)} batches, flagged {len(flagged_ids)} so far")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, batches))

    by_type = {}
    id2type = {r[0]: r[2] for r in rows}
    for fid in flagged_ids:
        by_type[id2type[fid]] = by_type.get(id2type[fid], 0) + 1

    print(f"\nFLAGGED for retirement (operational/methodology): {len(flagged_ids)} / {len(rows)}")
    print("  by type:", by_type)
    print("  kept (defensive/summary/ambiguous):", len(rows) - len(flagged_ids))
    print("\nsample flagged:")
    for fid in list(flagged_ids)[:15]:
        st = next(r[1] for r in rows if r[0] == fid)
        print(f"  [{fid}] {st[:100]}  -- {reasons.get(fid,'')}")

    if not args.apply:
        print("\nDRY RUN - re-run with --apply to retire the flagged subset.")
        return

    if not flagged_ids:
        print("nothing flagged; nothing to do.")
        return

    now = int(time.time())
    def mkrun():
        con.execute("BEGIN IMMEDIATE")
        cur = con.execute("insert into apply_runs(started_at,note) values (?,?)",
                          (now, f"sec_cleanup retire {len(flagged_ids)} operational/methodology facts"))
        rid = cur.lastrowid; con.execute("COMMIT"); return rid
    rid = retry_write(mkrun)

    flist = sorted(flagged_ids)
    for i in range(0, len(flist), 500):
        chunk = flist[i:i + 500]
        def w():
            mem.execute("BEGIN IMMEDIATE")
            for fid in chunk:
                prev = mem.execute("select is_active, superseded_by_id, valid_until from semantic_facts where id=?", (fid,)).fetchone()
                mem.execute("update semantic_facts set is_active=0 where id=?", (fid,))
                def lg(prev=prev, fid=fid):
                    con.execute("BEGIN IMMEDIATE")
                    con.execute("insert or replace into apply_log(run_id,fact_id,action,prev_is_active,prev_superseded_by,prev_valid_until) values (?,?,?,?,?,?)",
                                (rid, fid, "sec_cleanup_retire", prev[0], prev[1], prev[2]))
                    con.execute("COMMIT")
                retry_write(lg)
            mem.execute("COMMIT")
        retry_write(w)
        print(f"  retired {min(i+500, len(flist))}/{len(flist)}")
        time.sleep(0.05)

    def fin():
        con.execute("BEGIN IMMEDIATE")
        con.execute("update apply_runs set finished_at=? where id=?", (int(time.time()), rid)); con.execute("COMMIT")
    retry_write(fin)
    print(f"DONE run_id={rid} retired {len(flist)} facts (raw session history untouched)")


if __name__ == "__main__":
    main()
