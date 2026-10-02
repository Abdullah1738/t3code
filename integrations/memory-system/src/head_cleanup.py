#!/usr/bin/env python3
"""One-time cleanup: retire memory facts that snapshot git/deploy state.

Abdullah, 2026-09-28: memory should not track branch heads, SHAs or
deploy-chain state. They change too often and must be fetched live from the
repo/CI. Facts like "main-dev head is at 3c09bdbc" or "deploy chain for SHA
4d08dd2 verified" go stale within hours and then mislead recall.

Candidates: active facts with a SHA-like token and head/branch/deploy wording.
The judge (glm-5.3-flash via inferhub) keeps anything where the SHA is
incidental to a durable rule, workflow, decision or root cause. When unsure,
keep.

Dry run writes the flagged set to logs/head_cleanup_flagged.json; --apply
retires exactly that set (no re-judging), logged to consolidation.db
apply_runs/apply_log (action 'head_cleanup_retire'). Undo with
`consolidate.py rollback --run <id>`. Raw session history is untouched.

Run from the memory-system dir:
  .venv/bin/python src/head_cleanup.py            # classify, write flagged file
  .venv/bin/python src/head_cleanup.py --apply    # retire the flagged file's set
"""
import argparse, json, os, re, sqlite3, sys, threading, time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM = os.path.join(BASE, "data", "memory.db")
CON = os.path.join(BASE, "data", "consolidation.db")
OUT = os.path.join(BASE, "logs", "head_cleanup_flagged.json")
KEY_FILE = os.path.expanduser("~/.config/opencode/inferhub")
BASE_URL = "https://api.inferhub.dev/v1"
ACTION = "head_cleanup_retire"
KEEP_TYPES = ("constraint", "workflow", "preference")

# SHA-like: 7-40 hex chars with at least one letter and one digit
SHA_RE = re.compile(r"\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b", re.I)
STATE_RE = re.compile(
    r"\bhead\b|\bsha\b|main-dev|\bbranch|deploy(ment)? chain|\bchain for\b|ci run|"
    r"release run|workflow run|watcher|\bis at\b|\bsits at\b|still at|advanced|"
    r"^as of\b|\bcommit\b|merged? at|exact head|tip of|pinned",
    re.I)

JUDGE = """You are cleaning a user's long-term memory of AI-agent work.
The user decided memory must NOT track git branch heads, commit SHAs, PR heads,
deploy-chain or CI/release-run state, because these change constantly and must
always be fetched live from the repo or CI.

Flag a fact YES if its main content is point-in-time repo/deploy state, e.g.:
- which SHA a branch, HEAD, PR or environment is at / advanced to / still at
- that a deploy chain, CI run, release run or watcher tick for a SHA passed,
  failed, is pending or was verified
- an approval or status tied to an exact head ("may merge at exact head X")
- "as of commit X the state was ..." snapshots

Answer NO (keep) if the fact is durable and the SHA is incidental, e.g.:
- a standing rule, workflow or constraint (even one about checking heads live
  or pinning HEAD)
- a solved problem: root cause and fix, even if it names the fixing commit
- an architecture or product decision, a preference, a profile fact
- a release version or tag that is a permanent identifier

When unsure, answer NO.

Facts (numbered):
{facts}

Return ONLY JSON: {"flag": [list of numbers that are YES], "reasons": {"<num>": "<=10 words"}}"""


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
            for c in getattr(fn, "conns", ()):
                if c.in_transaction:
                    c.execute("ROLLBACK")
            if "locked" in str(e).lower() or "busy" in str(e).lower():
                time.sleep(min(2.0, 0.05 * (1.5 ** i))); continue
            raise
    raise RuntimeError("lock retries exhausted")


def call_judge(key, lines, tries=4):
    """lines: list of (idx, statement). Returns (flagged idx set, reasons, ok)."""
    body = {"model": "glm-5.3-flash",
            "messages": [{"role": "user", "content": JUDGE.replace(
                "{facts}", "\n".join(f"[{i}] {s}" for i, s in lines))}],
            "response_format": {"type": "json_object"}, "temperature": 0.0,
            "reasoning": {"enabled": False}}
    for a in range(tries):
        try:
            req = urllib.request.Request(BASE_URL + "/chat/completions",
                data=json.dumps(body).encode(),
                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.loads(r.read())
            t = (d["choices"][0]["message"].get("content") or "").strip()
            if t.startswith("```"):
                t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
                t = re.sub(r"\s*```\s*$", "", t)
            obj = json.loads(t)
            return {int(x) for x in obj.get("flag", [])}, obj.get("reasons", {}), True
        except Exception as e:
            if a == tries - 1:
                print(f"  judge error (batch of {len(lines)}): {e}", file=sys.stderr)
                return set(), {}, False
            time.sleep(1.5 * (a + 1))
    return set(), {}, False


def candidates(mem):
    rows = mem.execute("select id, statement, fact_type from semantic_facts "
                       "where is_active=1 order by id").fetchall()
    return [r for r in rows if SHA_RE.search(r[1] or "") and STATE_RE.search(r[1] or "")]


def classify(args):
    mem = connect(MEM, ro=True)
    key = open(KEY_FILE).read().strip()
    rows = candidates(mem)
    print(f"candidate facts: {len(rows)}")
    batches = [{"ids": [c[0] for c in rows[i:i + args.batch]],
                "lines": [(k + 1, c[1]) for k, c in enumerate(rows[i:i + args.batch])]}
               for i in range(0, len(rows), args.batch)]
    flagged, reasons, failed = set(), {}, [0]
    lock = threading.Lock()
    done = [0]

    def work(b):
        fl, rs, ok = call_judge(key, b["lines"])
        with lock:
            if not ok:
                failed[0] += 1
            for i in fl:
                if 1 <= i <= len(b["ids"]):
                    fid = b["ids"][i - 1]
                    flagged.add(fid)
                    reasons[fid] = rs.get(str(i), "") if isinstance(rs, dict) else ""
            done[0] += 1
            if done[0] % 100 == 0:
                print(f"  judged {done[0]}/{len(batches)} batches, flagged {len(flagged)}")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        list(ex.map(work, batches))

    info = {r[0]: (r[1], r[2]) for r in rows}
    by_type = {}
    for fid in flagged:
        by_type[info[fid][1]] = by_type.get(info[fid][1], 0) + 1
    out = {"ts": int(time.time()), "candidates": len(rows), "failed_batches": failed[0],
           "flagged": [{"id": f, "type": info[f][1], "statement": info[f][0],
                        "why": reasons.get(f, "")} for f in sorted(flagged)]}
    with open(OUT, "w") as fh:
        json.dump(out, fh, indent=1)
    print(f"\nflagged {len(flagged)} / {len(rows)}; failed batches {failed[0]}")
    print("  by type:", by_type)
    print(f"  written to {OUT}")


def apply(args):
    data = json.load(open(OUT))
    # rules/processes stay even if the judge flagged them (the extractor exempts them too)
    ids = sorted(int(f["id"]) for f in data["flagged"] if f.get("type") not in KEEP_TYPES)
    mem = connect(MEM); con = connect(CON)
    live = {r[0] for r in mem.execute(
        f"select id from semantic_facts where is_active=1 and id in ({','.join(map(str, ids))})")} if ids else set()
    ids = [i for i in ids if i in live]
    if not ids:
        print("nothing to retire"); return

    def mkrun():
        con.execute("BEGIN IMMEDIATE")
        rid = con.execute("insert into apply_runs(started_at,note) values (?,?)",
                          (int(time.time()), f"head_cleanup retire {len(ids)} git/deploy state snapshots")).lastrowid
        con.execute("COMMIT"); return rid
    rid = retry_write(mkrun)

    total = 0
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]

        def w():
            # read prev state under the memory.db write lock, commit the log
            # first, then retire only rows that are still active
            mem.execute("BEGIN IMMEDIATE")
            prev = mem.execute(
                f"select id, is_active, superseded_by_id, valid_until, supersedes_id from semantic_facts "
                f"where is_active=1 and id in ({','.join(map(str, chunk))})").fetchall()
            con.execute("BEGIN IMMEDIATE")
            con.executemany("insert or replace into apply_log(run_id,fact_id,action,prev_is_active,"
                            "prev_superseded_by,prev_valid_until,prev_supersedes) values (?,?,?,?,?,?,?)",
                            [(rid, r[0], ACTION) + tuple(r[1:]) for r in prev])
            con.execute("COMMIT")
            mem.executemany("update semantic_facts set is_active=0 where id=? and is_active=1",
                            [(r[0],) for r in prev])
            mem.execute("COMMIT")
            return len(prev)
        w.conns = (con, mem)
        total += retry_write(w)
        print(f"  retired {total} (through {min(i + 500, len(ids))}/{len(ids)})")

    def fin():
        con.execute("BEGIN IMMEDIATE")
        con.execute("update apply_runs set finished_at=? where id=?", (int(time.time()), rid))
        con.execute("COMMIT")
    retry_write(fin)
    print(f"DONE run_id={rid} retired {total} facts")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--workers", type=int, default=64)
    ap.add_argument("--batch", type=int, default=20)
    args = ap.parse_args()
    apply(args) if args.apply else classify(args)


if __name__ == "__main__":
    main()
