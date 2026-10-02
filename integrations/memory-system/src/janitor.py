#!/usr/bin/env python3
"""Memory janitor: daily scan for issues, autofix safe ones, triage the rest.

Checks (per Abdullah's scope, 2026-09-26):
  1. Orphaned / dead-end facts    - retired dups pointing at an inactive fact
                                    with no active canonical (like the emoji
                                    case). Autofix: re-link to an active dup
                                    sibling's canonical when one exists.
  2. Contradiction sweeps         - active facts joined by a 'contradict'
                                    evidence edge (or a contradicts relation
                                    never applied). Always a QUESTION.
  3. Coverage / janitor gaps      - active facts missing an embedding vector;
                                    unjudged clusters; residual multi-hop
                                    superseded_by_id chains. Autofix: re-embed
                                    (via Memory.embed_new_facts), flatten.
  4. Low-confidence profile facts - active profile/preference facts with
                                    confidence below threshold. QUESTION.

Policy (Abdullah): autofix what is clearly safe, ask on genuine conflict or
ambiguity. Daily cadence. Questions open a review session (OpenChamber, or a
Robob thread when MEMORY_BACKEND=robob, see backend.py): an agent researches each
item, drafts decisions for src/apply_decisions.py and waits for Abdullah to
approve or amend. Only one review is open at a time. Telegram digest is the
fallback if the review can't be opened.

Run:
  .venv/bin/python -u src/janitor.py            # scan + autofix + print report
  .venv/bin/python -u src/janitor.py --notify   # also open the review session if questions
  .venv/bin/python -u src/janitor.py --dry-run  # scan only, no writes
"""
import argparse, json, os, re, sqlite3, subprocess, sys, time
from collections import Counter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM = os.path.join(BASE, "data", "memory.db")
CON = os.path.join(BASE, "data", "consolidation.db")
VEC = os.path.join(BASE, "data", "fact_vectors.db")
REPORT = os.path.join(BASE, "logs", "janitor_last.json")

CONF_THRESHOLD = 0.5          # profile/preference facts strictly below this -> question
CONTRADICT_LOOKBACK_D = 2     # only surface contradictions from the last N days
CONTRADICT_MAX = 10           # cap contradictions per digest (rest go to report)
MAX_Q = 25                    # cap questions in one digest

TG_CLI = "/Users/ardud/.local/share/telegram-bridge/src/cli.ts"
BUN = "/Users/ardud/.bun/bin/bun"

sys.path.insert(0, os.path.join(BASE, "src"))
import backend  # noqa: E402

# Questions go to a review session (OpenChamber session or Robob thread)
# instead of a Telegram digest. Telegram is only the fallback when that fails.
OC_URL = os.environ.get("OPENCHAMBER_URL", "http://127.0.0.1:57123")
OC_PROJECT = "path_L1VzZXJzL2FyZHVk"          # /Users/ardud
REVIEW_TASK_NAME = "Memory janitor review"
REVIEW_MODEL = ("opus", "claude-opus-5-5", "xhigh")
REVIEW_PROJECT_DIR = os.path.expanduser("~")       # same project as the OpenChamber task
REVIEW_PROMPT = os.path.join(BASE, "src", "janitor_review_prompt.md")
REVIEW_DIR = os.path.join(BASE, "logs", "janitor-review")
REVIEW_STATE = os.path.join(REVIEW_DIR, "state.json")
REVIEW_STALE_S = 7 * 86400    # a pending review older than this is replaced

SEC_RE = re.compile(r"exploit|vulnerab|double-spend|drain|attacker|\bPoC\b|redteam|red-team|"
                    r"front-run|flash-loan|infinite-mint|\bhack", re.I)
# Git head / deploy-chain state (Abdullah 2026-09-28: these change constantly,
# are fetched live, and are never worth a janitor question).
SHA_RE = re.compile(r"\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b", re.I)
HEAD_STATE_RE = re.compile(
    r"\bhead\b|\bsha\b|main-dev|\bbranch|deploy(ment)? chain|\bchain for\b|ci run|"
    r"release run|workflow run|watcher|\bis at\b|\bsits at\b|still at|advanced|"
    r"^as of\b|merged? at|exact head|tip of", re.I)
STMT_LEN = 220        # show statements up to this many chars before truncating
TG_MSG_MAX = 3800     # stay under Telegram's 4096 limit per message


def trunc(s, n=STMT_LEN):
    """Truncate at a word boundary with an ellipsis; never cut mid-word."""
    s = (s or "").strip()
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0]
    return cut.rstrip(".,;:") + "…"


def connect(path, ro=True):
    uri = f"file:{path}?mode=ro" if ro else path
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
    raise RuntimeError("write lock retries exhausted")


# ---------- checks ----------

def find_orphans(mem):
    """Retired facts whose superseded_by_id dead-ends on an inactive fact with
    no successor. Return list of dicts with a re-link candidate if a dup sibling
    points at an active canonical for the same subject+predicate."""
    rows = mem.execute(
        """select f.id, f.superseded_by_id, f.subject, f.predicate, f.object, f.statement
           from semantic_facts f
           join semantic_facts c on c.id = f.superseded_by_id
           where f.superseded_by_id is not null
             and c.is_active = 0 and c.superseded_by_id is null"""
    ).fetchall()
    out = []
    for fid, tgt, subj, pred, obj, stmt in rows:
        # find an active canonical among facts sharing the dup group target chain
        # strategy: active fact with same subject+predicate, prefer newest
        cand = mem.execute(
            """select id from semantic_facts
               where is_active=1 and superseded_by_id is null
                 and subject=? and predicate=?
               order by valid_from desc limit 1""",
            (subj, pred)).fetchone()
        out.append({"id": fid, "target": tgt, "subject": subj, "predicate": pred,
                    "object": obj, "statement": stmt,
                    "relink": cand[0] if cand else None})
    return out


def find_multihop(mem):
    rows = mem.execute(
        """select f.id from semantic_facts f
           join semantic_facts c on c.id=f.superseded_by_id
           where f.superseded_by_id is not null
             and (c.superseded_by_id is not null)"""
    ).fetchall()
    return [r[0] for r in rows]


def find_contradictions(mem):
    """Active-active contradict edges. These are genuine conflicts -> question."""
    since = int(time.time()) - CONTRADICT_LOOKBACK_D * 86400
    rows = mem.execute(
        """select e.source_fact_id, e.target_fact_id, a.statement, b.statement, a.valid_from
           from evidence_edges e
           join semantic_facts a on a.id=e.source_fact_id
           join semantic_facts b on b.id=e.target_fact_id
           where e.edge_type='contradict'
             and a.is_active=1 and b.is_active=1
             and a.valid_from >= ?""",
        (since,)).fetchall()
    seen = set()
    out = []
    for a, b, sa, sb, vf in rows:
        key = tuple(sorted((a, b)))
        if key in seen:
            continue
        seen.add(key)
        out.append({"a": a, "b": b, "a_stmt": sa, "b_stmt": sb})
    return out


def find_missing_embeddings(mem):
    """Active facts with no vector in fact_vectors.db."""
    vec = connect(VEC)
    vec.execute("PRAGMA busy_timeout=60000")
    have = {r[0] for r in vec.execute("select fact_id from fact_vec")}
    active = {r[0] for r in mem.execute("select id from semantic_facts where is_active=1")}
    vec.close()
    return sorted(active - have)


def find_unjudged_clusters(con):
    try:
        total = con.execute("select count(distinct cluster_id) from clusters").fetchone()[0]
        judged = con.execute("select count(*) from cluster_judgments").fetchone()[0]
    except sqlite3.OperationalError:
        return 0, 0
    return total, judged


def find_low_conf_profile(mem):
    rows = mem.execute(
        """select id, fact_type, subject, predicate, object, statement, confidence
           from semantic_facts
           where is_active=1 and fact_type in ('profile','preference')
             and confidence < ?""",
        (CONF_THRESHOLD,)).fetchall()
    return [{"id": r[0], "type": r[1], "subject": r[2], "predicate": r[3],
             "object": r[4], "statement": r[5], "confidence": r[6]} for r in rows]


# ---------- autofix ----------

def find_sec_retired(con):
    """Fact ids retired by the 2026-09-26 security cleanup (sec_cleanup.py)."""
    try:
        return {r[0] for r in con.execute(
            "select fact_id from apply_log where action='sec_cleanup_retire'")}
    except sqlite3.Error:
        return set()


def is_security_deadend(o, sec_ids):
    """Dead-end left behind by the security cleanup, or about exploit work.
    Abdullah decided (2026-09-26) memory keeps no crypto-security facts, and
    these statements trip Claude's content filter in the review session, so
    they are retired automatically instead of being asked about."""
    return o["target"] in sec_ids or bool(SEC_RE.search(o["statement"] or ""))


def is_head_state(stmt):
    """Point-in-time git head / deploy-chain snapshot. The janitor never asks
    about these: dead-ends get their pointer cleared, conflicts and
    low-confidence ones are skipped (the facts themselves stay as they are)."""
    stmt = stmt or ""
    return bool(SHA_RE.search(stmt) and HEAD_STATE_RE.search(stmt))


def autofix_relink(mem, con, relinks, run_note, action="janitor_relink"):
    """Point orphaned facts at an active canonical (their superseded_by_id).
    A relink of None clears the dangling pointer (fact stays retired)."""
    if not relinks:
        return 0
    def mk_run():
        con.execute("BEGIN IMMEDIATE")
        cur = con.execute("insert into apply_runs(started_at,note) values (?,?)",
                          (int(time.time()), run_note))
        rid = cur.lastrowid
        con.execute("COMMIT")
        return rid
    rid = retry_write(mk_run)
    def work():
        mem.execute("BEGIN IMMEDIATE")
        for o in relinks:
            mem.execute("update semantic_facts set superseded_by_id=? where id=?",
                        (o["relink"], o["id"]))
        mem.execute("COMMIT")
    retry_write(work)
    def logw():
        con.execute("BEGIN IMMEDIATE")
        for o in relinks:
            con.execute("insert or replace into apply_log(run_id,fact_id,action,prev_superseded_by) values (?,?,?,?)",
                        (rid, o["id"], action, o["target"]))
        con.execute("update apply_runs set finished_at=? where id=?", (int(time.time()), rid))
        con.execute("COMMIT")
    retry_write(logw)
    return len(relinks)


def autofix_embed(count_missing):
    """Re-embed missing facts via the retrieval Memory (loads model)."""
    if count_missing == 0:
        return 0
    sys.path.insert(0, os.path.join(BASE, "src"))
    try:
        from memory_retrieval import Memory
    except Exception as e:
        print(f"  embed autofix unavailable: {e}")
        return -1
    m = Memory(preload=True)
    total = 0
    while True:
        n = m.embed_new_facts(512)  # batch; embed_new_facts takes a LIMIT
        if not n:
            break
        total += n
    return total


# ---------- notify ----------

def send_digest(questions, fixes, stats):
    if not questions:
        return None
    header = "Memory janitor: needs your call"
    body = []
    for i, q in enumerate(questions[:MAX_Q], 1):
        body.append(f"{i}. {q}")
    if len(questions) > MAX_Q:
        body.append(f"... +{len(questions)-MAX_Q} more (see janitor_last.json)")
    if fixes:
        body.append("")
        body.append("Auto-fixed: " + "; ".join(fixes))

    # Chunk into messages that stay under Telegram's limit. Split on question
    # boundaries so no question is cut across messages.
    import hashlib
    datekey = time.strftime("%Y%m%d")
    # Content-hash the day's questions so a content change is a NEW logical
    # notification (the bridge rejects reusing a key with different text).
    dayhash = hashlib.sha1("|".join(questions).encode()).hexdigest()[:8]
    base = f"memory-janitor:{datekey}:{dayhash}"
    messages = []
    cur = header + "\n\n"
    for line in body:
        if len(cur) + len(line) + 1 > TG_MSG_MAX and cur.strip() != header:
            messages.append(cur.rstrip())
            cur = ""
        cur += line + "\n"
    if cur.strip():
        messages.append(cur.rstrip())

    ok = True
    for idx, text in enumerate(messages):
        key = base + (f":{idx}" if idx else "")
        try:
            r = subprocess.run(
                [BUN, TG_CLI, "notify", "--source", "Memory janitor",
                 "--severity", "attention", "--text", text, "--key", key],
                capture_output=True, text=True, timeout=60)
            if r.returncode != 0:
                print(f"  notify chunk {idx} failed: {r.stderr[:200]}")
                ok = False
        except Exception as e:
            print(f"  notify failed: {e}")
            ok = False
    return ok


# ---------- review session ----------

def fact_row(mem, fid):
    r = mem.execute(
        """select id, fact_type, subject, predicate, object, statement, confidence,
                  is_active, superseded_by_id, source_event_id,
                  datetime(valid_from,'unixepoch'), datetime(valid_until,'unixepoch')
           from semantic_facts where id=?""", (fid,)).fetchone()
    if not r:
        return {"id": fid, "missing": True}
    k = ("id", "fact_type", "subject", "predicate", "object", "statement", "confidence",
         "is_active", "superseded_by_id", "source_event_id", "valid_from", "valid_until")
    return dict(zip(k, r))


def build_review_items(mem, dead_ends, conflicts, lowc):
    items = []
    for o in dead_ends:
        items.append({"kind": "dead_end", "id": o["id"], "fact": fact_row(mem, o["id"]),
                      "retired_target": fact_row(mem, o["target"])})
    for c in conflicts:
        items.append({"kind": "conflict", "id": c["a"], "a": fact_row(mem, c["a"]),
                      "b": fact_row(mem, c["b"])})
    for f in lowc:
        items.append({"kind": "low_conf", "id": f["id"], "fact": fact_row(mem, f["id"])})
    return items


def oc_request(method, path, body=None, timeout=30):
    import urllib.request
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(OC_URL + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def ensure_review_task():
    """Make sure the (disabled, manual-run only) OpenChamber task exists and its
    prompt matches src/janitor_review_prompt.md. Returns the task id."""
    prompt = open(REVIEW_PROMPT).read().strip()
    tasks = oc_request("GET", f"/api/projects/{OC_PROJECT}/scheduled-tasks").get("tasks", [])
    task = next((t for t in tasks if t.get("name") == REVIEW_TASK_NAME), None)
    want = {
        "name": REVIEW_TASK_NAME,
        "enabled": False,  # never fires on its own; the janitor runs it on demand
        "schedule": {"kind": "cron", "cron": "0 9 * * *", "timezone": "Asia/Dubai"},
        "execution": {"prompt": prompt, "providerID": REVIEW_MODEL[0],
                      "modelID": REVIEW_MODEL[1], "variant": REVIEW_MODEL[2],
                      "permissionAutoAccept": True},
    }
    if task:
        ex = task.get("execution") or {}
        same = (ex.get("prompt", "").strip() == prompt and ex.get("modelID") == REVIEW_MODEL[1]
                and ex.get("variant") == REVIEW_MODEL[2] and ex.get("permissionAutoAccept") is True
                and task.get("enabled") is False)
        if same:
            return task["id"]
        want["id"] = task["id"]
    res = oc_request("PUT", f"/api/projects/{OC_PROJECT}/scheduled-tasks", {"task": want})
    return res["task"]["id"]


def open_robob_review():
    """Start the review as a Robob thread. Returns (thread id, native session id)."""
    prompt = open(REVIEW_PROMPT).read().strip()
    body = {"title": REVIEW_TASK_NAME, "prompt": prompt, "directory": REVIEW_PROJECT_DIR,
            "model": f"{REVIEW_MODEL[0]}/{REVIEW_MODEL[1]}", "variant": REVIEW_MODEL[2],
            "runtimeMode": "full-access", "origin": "automation",
            "clientRequestId": "memory-janitor-review:" + time.strftime("%Y-%m-%d")}
    code, res = backend.control("POST", "/threads", body, timeout=120)
    if code not in (200, 201) or not isinstance(res, dict) or not res.get("threadId"):
        raise RuntimeError(f"create thread: HTTP {code} {backend._err(res)}")
    native = None
    try:
        c2, detail = backend.control("GET", "/threads/" + backend.q(res["threadId"]))
        if c2 == 200:
            native = (detail.get("thread") or {}).get("nativeSessionId")
    except Exception:
        pass
    return res["threadId"], native


def open_review(report, items):
    """Write the review snapshot and start the review session.
    Returns (ok, message). ok=False means the caller should fall back."""
    os.makedirs(REVIEW_DIR, exist_ok=True)
    now = int(time.time())
    st = {}
    if os.path.exists(REVIEW_STATE):
        try:
            st = json.load(open(REVIEW_STATE))
        except Exception:
            st = {}
    if st.get("status") == "pending" and now - st.get("created_at", 0) < REVIEW_STALE_S:
        return True, f"review {st.get('review')} still pending (session {st.get('session_id')}); not opening another"

    review = time.strftime("%Y-%m-%d")
    snap = os.path.join(REVIEW_DIR, f"{review}.json")
    with open(snap, "w") as fh:
        json.dump({"review": review, "date": report["date"], "stats": report["stats"],
                   "fixes": report["fixes"], "items": items}, fh, indent=2)
    new_state = {"review": review, "file": snap, "items": len(items), "created_at": now,
                 "status": "pending", "session_id": None,
                 "previous": {k: st.get(k) for k in ("review", "status", "session_id")} if st else None}
    try:
        if backend.is_robob():
            # session_id keeps meaning "where the review runs": the Robob thread id here
            new_state["backend"] = "robob"
            new_state["session_id"], new_state["native_session_id"] = open_robob_review()
        else:
            tid = ensure_review_task()
            new_state["task_id"] = tid
            res = oc_request("POST", f"/api/projects/{OC_PROJECT}/scheduled-tasks/{tid}/run", {}, timeout=120)
            new_state["session_id"] = res.get("sessionId")
    except Exception as e:
        new_state["status"] = "failed"
        new_state["error"] = str(e)[:300]
        ok, msg = False, f"FAILED ({e})"
    else:
        ok, msg = True, f"session {new_state['session_id']} ({len(items)} items)"
    tmp = REVIEW_STATE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(new_state, fh, indent=2)
    os.replace(tmp, REVIEW_STATE)
    return ok, msg


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--notify", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # autofix_relink / flatten write semantic_facts, so mem must be writable
    # unless this is a dry run (read-only open made the 2026-09-27 run crash)
    mem = connect(MEM, ro=args.dry_run)
    con = connect(CON, ro=False)
    conw = con  # consolidation.db writable for apply_log

    report = {"ts": int(time.time()), "date": time.strftime("%Y-%m-%d %H:%M:%S"),
              "fixes": [], "questions": [], "stats": {}}

    # 1. Orphans
    orphans = find_orphans(mem)
    relinkable = [o for o in orphans if o["relink"]]
    true_orphans = [o for o in orphans if not o["relink"]]
    sec_ids = find_sec_retired(con)
    sec_orphans = [o for o in true_orphans if is_security_deadend(o, sec_ids)]
    true_orphans = [o for o in true_orphans if not is_security_deadend(o, sec_ids)]
    report["stats"]["orphans"] = len(orphans)
    report["stats"]["security_deadends"] = len(sec_orphans)
    if relinkable and not args.dry_run:
        n = autofix_relink(mem, conw, relinkable, f"janitor relink {len(relinkable)} orphans")
        report["fixes"].append(f"re-linked {n} orphaned facts to active canonicals")
    if sec_orphans and not args.dry_run:
        clear = [dict(o, relink=None) for o in sec_orphans]
        n = autofix_relink(mem, conw, clear, f"janitor retire {len(clear)} security dead-ends",
                           action="janitor_sec_retire")
        report["fixes"].append(f"retired {n} security-work dead-ends (no crypto-security facts in memory)")
    head_orphans = [o for o in true_orphans if is_head_state(o["statement"])]
    true_orphans = [o for o in true_orphans if not is_head_state(o["statement"])]
    report["stats"]["head_state_deadends"] = len(head_orphans)
    if head_orphans and not args.dry_run:
        clear = [dict(o, relink=None) for o in head_orphans]
        n = autofix_relink(mem, conw, clear, f"janitor retire {len(clear)} head-state dead-ends",
                           action="janitor_head_retire")
        report["fixes"].append(f"retired {n} git head/deploy-state dead-ends (fetched live, not asked)")
    for o in true_orphans:
        report["questions"].append(
            f"Dead-end: '{trunc(o['statement'])}' ({o['subject']}) retired but no active canonical. Resurrect or drop? [fact {o['id']}]")

    # 2. Contradictions
    contras = find_contradictions(mem)
    head_contras = [c for c in contras if is_head_state(c["a_stmt"]) or is_head_state(c["b_stmt"])]
    contras = [c for c in contras if c not in head_contras]
    report["stats"]["head_state_conflicts_skipped"] = len(head_contras)
    report["stats"]["contradictions"] = len(contras)
    # Only surface a capped sample of genuine, recent conflicts. The full set
    # lives in the report; the consolidation judge owns semantic resolution.
    for c in contras[:CONTRADICT_MAX]:
        report["questions"].append(
            f"Conflict (both active):\n  A [{c['a']}] {trunc(c['a_stmt'])}\n  B [{c['b']}] {trunc(c['b_stmt'])}\n  Which wins?")
    if len(contras) > CONTRADICT_MAX:
        report["fixes"].append(
            f"{len(contras)-CONTRADICT_MAX} further active-contradiction pairs logged to janitor_last.json (judge backlog)")

    # 3. Coverage gaps
    missing_emb = find_missing_embeddings(mem)
    report["stats"]["missing_embeddings"] = len(missing_emb)
    multihop = find_multihop(mem)
    report["stats"]["multihop"] = len(multihop)
    total_cl, judged_cl = find_unjudged_clusters(con)
    report["stats"]["clusters_unjudged"] = max(0, total_cl - judged_cl)
    if not args.dry_run:
        if multihop:
            # flatten via the same terminal logic as flatten_pointers
            relinks = []
            for fid in multihop:
                cur, seen, hops = fid, set(), 0
                term = None
                while cur is not None and cur not in seen and hops < 20:
                    seen.add(cur)
                    r = mem.execute("select is_active, superseded_by_id from semantic_facts where id=?", (cur,)).fetchone()
                    if not r:
                        break
                    if r[1] is None:
                        term = cur if r[0] == 1 else None
                        break
                    cur = r[1]; hops += 1
                if term and term != fid:
                    relinks.append({"id": fid, "relink": term,
                                    "target": mem.execute("select superseded_by_id from semantic_facts where id=?", (fid,)).fetchone()[0]})
            if relinks:
                n = autofix_relink(mem, conw, relinks, f"janitor flatten {len(relinks)}")
                report["fixes"].append(f"flattened {n} multi-hop pointers")
        if missing_emb:
            n = autofix_embed(len(missing_emb))
            if n and n > 0:
                report["fixes"].append(f"embedded {n} facts missing vectors")

    # 4. Low-confidence profile/preference
    lowc = find_low_conf_profile(mem)
    head_lowc = [f for f in lowc if is_head_state(f["statement"])]
    lowc = [f for f in lowc if not is_head_state(f["statement"])]
    report["stats"]["head_state_lowconf_skipped"] = len(head_lowc)
    report["stats"]["low_conf_profile"] = len(lowc)
    for f in lowc:
        report["questions"].append(
            f"Low-confidence {f['type']} (conf {f['confidence']:.2f}): {trunc(f['statement'])}  Keep? [fact {f['id']}]")

    # report
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w") as fh:
        json.dump(report, fh, indent=2)

    print(f"[{report['date']}] janitor scan")
    for k, v in report["stats"].items():
        print(f"  {k}: {v}")
    print(f"  FIXES ({len(report['fixes'])}):")
    for x in report["fixes"]:
        print(f"    - {x}")
    print(f"  QUESTIONS ({len(report['questions'])}):")
    for q in report["questions"][:MAX_Q]:
        print(f"    ? {q}")
    if len(report["questions"]) > MAX_Q:
        print(f"    ... +{len(report['questions'])-MAX_Q} more")

    if args.notify and report["questions"]:
        items = build_review_items(mem, true_orphans, contras[:CONTRADICT_MAX], lowc)
        ok, msg = open_review(report, items)
        print(f"  {'robob' if backend.is_robob() else 'openchamber'} review: {msg}")
        if not ok:
            ok = send_digest(report["questions"], report["fixes"], report["stats"])
            print(f"  telegram digest (fallback): {'sent' if ok else 'FAILED'}")

    mem.close(); con.close()


if __name__ == "__main__":
    main()
