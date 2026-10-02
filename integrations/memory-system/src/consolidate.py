#!/usr/bin/env python3
"""Fact consolidation: kNN candidate pairs + LLM judge. See CONSOLIDATION_PLAN.md.

All outputs go to the sidecar data/consolidation.db. memory.db is only read here;
applying decisions is a separate, explicit step.

  .venv/bin/python -u src/consolidate.py candidates [--threshold 0.85] [--k 20]
  .venv/bin/python -u src/consolidate.py judge [--limit N] [--workers 16] [--max-cost 200]
  .venv/bin/python -u src/consolidate.py stats
"""
import argparse
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM_DB = os.environ.get("MEMORY_DB") or os.path.join(ROOT, "data", "memory.db")
VEC_DB = os.path.join(ROOT, "data", "fact_vectors.db")
CON_DB = os.environ.get("CONSOLIDATION_DB") or os.path.join(ROOT, "data", "consolidation.db")
DIM = 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS cand_pairs (
    a INTEGER NOT NULL,          -- older fact id (by valid_from, then id)
    b INTEGER NOT NULL,          -- newer fact id
    sim REAL NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_cand_sim ON cand_pairs(sim);
CREATE TABLE IF NOT EXISTS judgments (
    a INTEGER NOT NULL,
    b INTEGER NOT NULL,
    label TEXT NOT NULL,         -- duplicate|supersedes|refines|contradicts|compatible|unrelated
    reason TEXT,
    judge TEXT NOT NULL,         -- model name or 'rule'
    judged_at INTEGER NOT NULL,
    PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS idx_judg_label ON judgments(label);
CREATE TABLE IF NOT EXISTS judge_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER, finished_at INTEGER,
    pairs INTEGER, calls INTEGER, errors INTEGER,
    prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""


def con_db():
    c = sqlite3.connect(CON_DB, timeout=60)
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript(SCHEMA)
    return c


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)


# ---------------------------------------------------------------- candidates

def load_vectors():
    v = ro(VEC_DB)
    ids, blobs = [], []
    for fid, blob in v.execute("SELECT fact_id, vec FROM fact_vec ORDER BY fact_id"):
        ids.append(fid)
        blobs.append(blob)
    ids = np.asarray(ids, dtype=np.int64)
    X = np.frombuffer(b"".join(blobs), dtype=np.float16).reshape(len(ids), DIM)
    return ids, X


def load_order(ids):
    """valid_from per fact, for ordering pairs older->newer."""
    m = ro(MEM_DB)
    vf = {}
    q = "SELECT id, valid_from FROM semantic_facts WHERE id BETWEEN ? AND ?"
    lo, hi = int(ids.min()), int(ids.max())
    step = 200_000
    for s in range(lo, hi + 1, step):
        for fid, t in m.execute(q, (s, s + step - 1)):
            vf[fid] = t or 0
    return vf


def cmd_candidates(args):
    t0 = time.time()
    ids, X16 = load_vectors()
    n = len(ids)
    print(f"vectors={n} load={time.time()-t0:.1f}s", flush=True)
    X = X16.astype(np.float32) if args.device == "cpu" else None
    vf = load_order(ids)
    k = args.k
    th = args.threshold
    bs = args.block
    pairs = {}
    t1 = time.time()

    def add(i, j, sim):
        ki, kj = (vf.get(i, 0), i), (vf.get(j, 0), j)
        a, b = (i, j) if ki <= kj else (j, i)
        if (a, b) not in pairs or pairs[(a, b)] < sim:
            pairs[(a, b)] = sim

    if args.device != "cpu":
        import torch
        dev = torch.device(args.device)
        Xt = torch.from_numpy(np.ascontiguousarray(X16)).to(dev)   # fp16 on GPU
        kk = min(k + 1, n)
        for s in range(0, n, bs):
            e = min(n, s + bs)
            S = Xt[s:e] @ Xt.T
            vals, idx = torch.topk(S, kk, dim=1)
            vals = vals.float().cpu().numpy()
            idx = idx.cpu().numpy()
            for r in range(e - s):
                gi = int(ids[s + r])
                for v_, cj in zip(vals[r], idx[r]):
                    if v_ < th:
                        break
                    if cj == s + r:
                        continue
                    add(gi, int(ids[cj]), float(v_))
            if (s // bs) % 50 == 0:
                print(f"  {e}/{n} pairs={len(pairs)} {time.time()-t1:.0f}s", flush=True)
        n_iter = 0
    else:
        n_iter = n
    for s in range(0, n_iter, bs):
        e = min(n, s + bs)
        S = X[s:e] @ X.T                       # (b, n)
        rows = np.arange(e - s)
        S[rows, s + rows] = -1.0               # drop self
        # threshold first (cheap), then keep the top-k hits per row
        r_all, c_all = np.nonzero(S >= th)
        sims_all = S[r_all, c_all]
        hits = []
        if len(r_all):
            order = np.lexsort((-sims_all, r_all))       # by row, then sim desc
            r_all, c_all, sims_all = r_all[order], c_all[order], sims_all[order]
            starts = np.r_[0, np.flatnonzero(np.diff(r_all)) + 1]
            rank = np.arange(len(r_all)) - np.repeat(starts, np.diff(np.r_[starts, len(r_all)]))
            keep = rank < k
            hits = zip(r_all[keep].tolist(), c_all[keep].tolist(), sims_all[keep].tolist())
        for ri, cj, sim in hits:
            i = ids[s + ri]
            j = ids[cj]
            ki, kj = (vf.get(int(i), 0), int(i)), (vf.get(int(j), 0), int(j))
            a, b = (int(i), int(j)) if ki <= kj else (int(j), int(i))
            if (a, b) not in pairs or pairs[(a, b)] < sim:
                pairs[(a, b)] = sim
        if (s // bs) % 20 == 0:
            el = time.time() - t1
            print(f"  {e}/{n} pairs={len(pairs)} {el:.0f}s", flush=True)
    c = con_db()
    now = int(time.time())
    c.executemany(
        "INSERT INTO cand_pairs(a,b,sim,created_at) VALUES (?,?,?,?) "
        "ON CONFLICT(a,b) DO UPDATE SET sim=excluded.sim",
        [(a, b, s_, now) for (a, b), s_ in pairs.items()])
    c.execute("INSERT OR REPLACE INTO meta VALUES ('candidates', ?)",
              (json.dumps({"n": n, "threshold": th, "k": k, "pairs": len(pairs), "at": now}),))
    c.commit()
    print(f"DONE pairs={len(pairs)} secs={time.time()-t0:.0f}", flush=True)


# ---------------------------------------------------------------- judge

JUDGE_PROMPT = """You consolidate a long-term memory of facts extracted from one person's (Abdullah's) AI coding sessions.
For each numbered pair, fact A was recorded EARLIER than fact B. Classify the relation:

- duplicate: same fact, same meaning, just worded differently (B adds nothing important).
- supersedes: same slot/topic but B replaces A: a changed value, moved path, new version, reversed or updated decision, a problem later solved differently. A is no longer current.
- refines: same fact, B adds meaningful detail or scope to A (or vice versa); both remain true.
- contradicts: they conflict and it is unclear that B replaces A (e.g. different contexts, or equal standing).
- compatible: related topic but independent facts; both are true at once (e.g. two different preferences, two projects).
- unrelated: not about the same thing.

Be strict: only use supersedes when B clearly makes A outdated for the same subject. Different projects, repos, services, or environments with similar wording are compatible, not supersedes.

Return JSON: {"results": [{"i": <pair number>, "label": "<label>", "reason": "<max 15 words>"}]} with one entry per pair."""


def fetch_facts(m, fids):
    out = {}
    fids = list(fids)
    for s in range(0, len(fids), 500):
        chunk = fids[s:s + 500]
        q = ("SELECT id, fact_type, subject, predicate, object, statement, valid_from "
             f"FROM semantic_facts WHERE id IN ({','.join('?'*len(chunk))})")
        for r in m.execute(q, chunk):
            out[r[0]] = r
    return out


def fmt_fact(f):
    ts = time.strftime("%Y-%m-%d", time.gmtime(f[6] or 0))
    return f"[{f[1]}, {ts}] {f[5][:600]}"


def call_llm(base, key, model, prompt_text, no_reasoning=False):
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": JUDGE_PROMPT},
                     {"role": "user", "content": prompt_text}],
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
    }
    if no_reasoning:
        payload["reasoning"] = {"enabled": False}
    body = json.dumps(payload).encode()
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=body,
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read())
    u = d.get("usage") or {}
    pt, ct = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
    cost = (u.get("cost_details") or {}).get("upstream_inference_cost")
    if cost is None:
        cost = (pt * 0.125 + ct * 0.5) / 1e6
    txt = d["choices"][0]["message"]["content"]
    return json.loads(txt), pt, ct, float(cost)


def total_spend():
    """Cumulative spend: extractor + judge (shared $ budget)."""
    tot = 0.0
    try:
        m = ro(MEM_DB)
        tot += m.execute("SELECT COALESCE(SUM(cost_usd),0) FROM extraction_runs").fetchone()[0]
    except Exception:
        pass
    c = con_db()
    tot += c.execute("SELECT COALESCE(SUM(cost_usd),0) FROM judge_runs").fetchone()[0]
    try:
        tot += c.execute("SELECT COALESCE(SUM(cost_usd),0) FROM profile_runs").fetchone()[0]
    except sqlite3.OperationalError:
        pass
    return tot


LABELS = {"duplicate", "supersedes", "refines", "contradicts", "compatible", "unrelated"}


def cmd_judge(args):
    key = open(os.path.expanduser("~/.config/opencode/inferhub")).read().strip()
    c = con_db()
    q = ("SELECT p.a, p.b, p.sim FROM cand_pairs p LEFT JOIN judgments j ON j.a=p.a AND j.b=p.b "
         "WHERE j.a IS NULL AND p.sim >= ? AND p.sim < ? ORDER BY p.sim DESC")
    todo = c.execute(q, (args.min_sim, args.max_sim)).fetchall()
    if args.sample:
        import random
        random.seed(args.seed)
        todo = random.sample(todo, min(args.sample, len(todo)))
    if args.limit:
        todo = todo[:args.limit]
    print(f"pending pairs={len(todo)}", flush=True)
    if not todo:
        return
    m = ro(MEM_DB)
    facts = fetch_facts(m, {x for p in todo for x in p[:2]})
    todo = [p for p in todo if p[0] in facts and p[1] in facts]
    batches = [todo[i:i + args.batch] for i in range(0, len(todo), args.batch)]
    spent0 = total_spend()
    run_id = c.execute("INSERT INTO judge_runs(started_at,pairs,calls,errors,prompt_tokens,"
                       "completion_tokens,cost_usd) VALUES (?,0,0,0,0,0,0)",
                       (int(time.time()),)).lastrowid
    c.commit()
    stats = {"pairs": 0, "calls": 0, "errors": 0, "pt": 0, "ct": 0, "cost": 0.0}

    def work(batch):
        lines = []
        for n_, (a, b, sim) in enumerate(batch, 1):
            lines.append(f"{n_}. A: {fmt_fact(facts[a])}\n   B: {fmt_fact(facts[b])}")
        for attempt in range(3):
            try:
                res, pt, ct, cost = call_llm(args.base_url, key, args.model, "\n\n".join(lines),
                                             args.no_reasoning)
                return batch, res, pt, ct, cost
            except Exception as e:  # noqa
                err = e
                time.sleep(2 * (attempt + 1))
        return batch, {"error": str(err)}, 0, 0, 0.0

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = []
        for bt in batches:
            futs.append(ex.submit(work, bt))
        for f in as_completed(futs):
            batch, res, pt, ct, cost = f.result()
            stats["calls"] += 1
            stats["pt"] += pt
            stats["ct"] += ct
            stats["cost"] += cost
            rows = []
            if "error" in res:
                stats["errors"] += 1
            else:
                for r in res.get("results", []):
                    try:
                        i = int(r["i"]) - 1
                        lab = str(r["label"]).strip().lower()
                    except Exception:
                        continue
                    if 0 <= i < len(batch) and lab in LABELS:
                        a, b, _ = batch[i]
                        rows.append((a, b, lab, str(r.get("reason", ""))[:300], args.model,
                                     int(time.time())))
            c.executemany("INSERT OR REPLACE INTO judgments VALUES (?,?,?,?,?,?)", rows)
            stats["pairs"] += len(rows)
            c.execute("UPDATE judge_runs SET pairs=?,calls=?,errors=?,prompt_tokens=?,"
                      "completion_tokens=?,cost_usd=?,finished_at=? WHERE id=?",
                      (stats["pairs"], stats["calls"], stats["errors"], stats["pt"], stats["ct"],
                       stats["cost"], int(time.time()), run_id))
            c.commit()
            if stats["calls"] % 50 == 0:
                print(f"  calls={stats['calls']}/{len(batches)} pairs={stats['pairs']} "
                      f"err={stats['errors']} cost=${stats['cost']:.2f}", flush=True)
            if spent0 + stats["cost"] >= args.max_cost:
                print(f"COST CAP reached total=${spent0+stats['cost']:.2f}", flush=True)
                ex.shutdown(wait=False, cancel_futures=True)
                break
    print(f"DONE pairs={stats['pairs']} calls={stats['calls']} err={stats['errors']} "
          f"cost=${stats['cost']:.3f}", flush=True)


# ---------------------------------------------------------------- clusters

CLUSTER_SCHEMA = """
CREATE TABLE IF NOT EXISTS clusters (
    cluster_id INTEGER NOT NULL,
    fact_id INTEGER NOT NULL,
    threshold REAL NOT NULL,     -- edge threshold at which this cluster was cut
    PRIMARY KEY (cluster_id, fact_id)
);
CREATE INDEX IF NOT EXISTS idx_clusters_fact ON clusters(fact_id);
CREATE TABLE IF NOT EXISTS cluster_judgments (
    cluster_id INTEGER PRIMARY KEY,
    result TEXT NOT NULL,        -- raw JSON from the judge
    judge TEXT NOT NULL,
    judged_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relations (
    a INTEGER NOT NULL,          -- older / first fact
    b INTEGER NOT NULL,          -- newer / second fact
    rel TEXT NOT NULL,           -- duplicate|supersedes|contradicts
    reason TEXT,
    cluster_id INTEGER,
    PRIMARY KEY (a, b, rel)
);
"""


def _components(nodes, edges):
    parent = {n: n for n in nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b, _ in edges:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    comps = {}
    for n in nodes:
        comps.setdefault(find(n), []).append(n)
    return list(comps.values())


def split_cluster(nodes, edges, th, max_size, step=0.01):
    """Connected components at threshold th; oversize ones are re-cut at th+step."""
    es = [e for e in edges if e[2] >= th]
    out = []
    for comp in _components(nodes, es):
        if len(comp) < 2:
            continue
        if len(comp) <= max_size:
            out.append((th, comp))
            continue
        if th >= 0.995:
            # near-identical facts that still form a huge component: judge them in
            # chunks (ids are roughly chronological) instead of dropping the tail
            comp = sorted(comp)
            for i in range(0, len(comp), max_size):
                part = comp[i:i + max_size]
                if len(part) >= 2:
                    out.append((th, part))
            continue
        cs = set(comp)
        sub = [e for e in es if e[0] in cs and e[1] in cs]
        out.extend(split_cluster(comp, sub, round(th + step, 4), max_size, step))
    return out


def cmd_clusters(args):
    c = con_db()
    c.executescript(CLUSTER_SCHEMA)
    judged = c.execute("SELECT COUNT(*) FROM cluster_judgments").fetchone()[0]
    if judged and not args.force:
        # cluster ids are renumbered on every run, so judgments would point at the wrong clusters
        sys.exit(f"refusing: {judged} clusters already judged (use --force to rebuild and discard them)")
    if judged:
        c.execute("DELETE FROM cluster_judgments")
    edges = c.execute("SELECT a, b, sim FROM cand_pairs WHERE sim >= ?", (args.threshold,)).fetchall()
    nodes = sorted({x for e in edges for x in e[:2]})
    t0 = time.time()
    res = split_cluster(nodes, edges, args.threshold, args.max_size)
    c.execute("DELETE FROM clusters")
    rows = []
    for cid, (th, comp) in enumerate(res, 1):
        rows.extend((cid, f, th) for f in comp)
    c.executemany("INSERT INTO clusters VALUES (?,?,?)", rows)
    c.commit()
    sizes = sorted((len(comp) for _, comp in res), reverse=True)
    import collections
    hist = collections.Counter(min(s, 20) for s in sizes)
    print(f"edges={len(edges)} nodes={len(nodes)} clusters={len(res)} facts_in_clusters={len(rows)} "
          f"largest={sizes[:5]} secs={time.time()-t0:.1f}")
    print("size hist (20 = 20+):", dict(sorted(hist.items())))


CLUSTER_PROMPT = """You consolidate a long-term memory of facts extracted from one person's (Abdullah's) AI coding sessions.
You get a group of similar facts, numbered in chronological order (1 = oldest). Find only these relations:

- duplicates: facts that state the same thing (paraphrases; small added detail is fine). Give each duplicate set as a list of numbers.
- supersedes: a later fact makes an earlier one outdated for the SAME subject: a changed value, moved path, new version, reversed or updated decision, a problem later solved differently. Pair [old, new].
- contradicts: two facts conflict and it is unclear that the later one replaces the earlier (e.g. same day, equal standing). Pair [x, y].

Be strict. Facts about different projects, repos, services, environments, or files are NOT duplicates and do NOT supersede each other, even with similar wording. A fact that only adds detail does not supersede. Omit facts with no relation.

Return JSON: {"duplicates": [[n, n, ...], ...], "supersedes": [[old, new, "<reason, max 12 words>"], ...], "contradicts": [[x, y, "<reason, max 12 words>"], ...]}"""


def cmd_judge_clusters(args):
    key = open(os.path.expanduser("~/.config/opencode/inferhub")).read().strip()
    c = con_db()
    c.executescript(CLUSTER_SCHEMA)
    todo = [r[0] for r in c.execute(
        "SELECT DISTINCT cl.cluster_id FROM clusters cl LEFT JOIN cluster_judgments j "
        "ON j.cluster_id = cl.cluster_id WHERE j.cluster_id IS NULL ORDER BY cl.cluster_id")]
    if args.sample:
        import random
        random.seed(args.seed)
        todo = random.sample(todo, min(args.sample, len(todo)))
    if args.limit:
        todo = todo[:args.limit]
    members = {}
    for cid in todo:
        members[cid] = [r[0] for r in c.execute("SELECT fact_id FROM clusters WHERE cluster_id=?", (cid,))]
    m = ro(MEM_DB)
    facts = fetch_facts(m, {f for v in members.values() for f in v})
    print(f"pending clusters={len(todo)} facts={len(facts)}", flush=True)
    if not todo:
        return
    spent0 = total_spend()
    run_id = c.execute("INSERT INTO judge_runs(started_at,pairs,calls,errors,prompt_tokens,"
                       "completion_tokens,cost_usd) VALUES (?,0,0,0,0,0,0)",
                       (int(time.time()),)).lastrowid
    c.commit()
    stats = {"clusters": 0, "calls": 0, "errors": 0, "pt": 0, "ct": 0, "cost": 0.0}

    # Token-bucket rate limiter: cap outgoing HTTP requests to stay under the
    # provider's per-account RPM (inferhub = 2000 req/min). Retries multiply the
    # request rate, so throttle every actual request, not just worker starts.
    rpm = max(1, int(args.max_rpm))
    interval = 60.0 / rpm
    rl_lock = threading.Lock()
    rl_next = [0.0]

    def throttle():
        with rl_lock:
            now = time.monotonic()
            wait = rl_next[0] - now
            start = now if rl_next[0] <= now else rl_next[0]
            rl_next[0] = start + interval
        if wait > 0:
            time.sleep(wait)

    def work(cid):
        fl = [facts[f] for f in members[cid] if f in facts]
        fl.sort(key=lambda r: ((r[6] or 0), r[0]))
        lines = [f"{i}. {fmt_fact(r)}" for i, r in enumerate(fl, 1)]
        err = None
        for attempt in range(3):
            try:
                throttle()
                body = {
                    "model": args.model,
                    "messages": [{"role": "system", "content": CLUSTER_PROMPT},
                                 {"role": "user", "content": "\n".join(lines)}],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.0,
                }
                if args.no_reasoning:
                    body["reasoning"] = {"enabled": False}
                req = urllib.request.Request(
                    args.base_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    d = json.loads(r.read())
                u = d.get("usage") or {}
                pt, ct = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
                cost = (u.get("cost_details") or {}).get("upstream_inference_cost")
                if cost is None:
                    cost = (pt * 0.125 + ct * 0.5) / 1e6
                res = json.loads(d["choices"][0]["message"]["content"])
                return cid, fl, res, pt, ct, float(cost)
            except Exception as e:  # noqa
                err = e
                time.sleep(2 * (attempt + 1))
        return cid, fl, {"error": str(err)}, 0, 0, 0.0

    def to_rows(cid, fl, res):
        n = len(fl)
        ok = lambda x: isinstance(x, int) and 1 <= x <= n  # noqa
        rows = []
        for grp in res.get("duplicates") or []:
            g = sorted({x for x in grp if ok(x)}) if isinstance(grp, list) else []
            for x in g[:-1]:
                # link every member to the newest member of the set
                rows.append((fl[x - 1][0], fl[g[-1] - 1][0], "duplicate", None, cid))
        for key_, rel in (("supersedes", "supersedes"), ("contradicts", "contradicts")):
            for it in res.get(key_) or []:
                if not isinstance(it, list) or len(it) < 2 or not ok(it[0]) or not ok(it[1]):
                    continue
                x, y = it[0], it[1]
                if x == y:
                    continue
                if rel == "supersedes" and x > y:
                    x, y = y, x  # older first
                why = str(it[2])[:200] if len(it) > 2 else None
                rows.append((fl[x - 1][0], fl[y - 1][0], rel, why, cid))
        return rows

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(work, cid) for cid in todo]
        for f in as_completed(futs):
            cid, fl, res, pt, ct, cost = f.result()
            stats["calls"] += 1
            stats["pt"] += pt
            stats["ct"] += ct
            stats["cost"] += cost
            if "error" in res:
                stats["errors"] += 1
            else:
                c.execute("INSERT OR REPLACE INTO cluster_judgments VALUES (?,?,?,?)",
                          (cid, json.dumps(res), args.model, int(time.time())))
                c.executemany("INSERT OR IGNORE INTO relations VALUES (?,?,?,?,?)", to_rows(cid, fl, res))
                stats["clusters"] += 1
            c.execute("UPDATE judge_runs SET pairs=?,calls=?,errors=?,prompt_tokens=?,"
                      "completion_tokens=?,cost_usd=?,finished_at=? WHERE id=?",
                      (stats["clusters"], stats["calls"], stats["errors"], stats["pt"], stats["ct"],
                       stats["cost"], int(time.time()), run_id))
            c.commit()
            if stats["calls"] % 200 == 0:
                print(f"  calls={stats['calls']}/{len(todo)} err={stats['errors']} "
                      f"cost=${stats['cost']:.2f}", flush=True)
            if spent0 + stats["cost"] >= args.max_cost:
                print(f"COST CAP reached total=${spent0+stats['cost']:.2f}", flush=True)
                ex.shutdown(wait=False, cancel_futures=True)
                break
    print(f"DONE clusters={stats['clusters']} calls={stats['calls']} err={stats['errors']} "
          f"pt={stats['pt']} ct={stats['ct']} cost=${stats['cost']:.4f}", flush=True)


# ---------------------------------------------------------------- apply / rollback

APPLY_SCHEMA = """
CREATE TABLE IF NOT EXISTS apply_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER, finished_at INTEGER, note TEXT,
    retired_dup INTEGER, retired_sup INTEGER, edges INTEGER, rolled_back_at INTEGER
);
-- previous values of every fact we touch, so a run can be undone exactly
CREATE TABLE IF NOT EXISTS apply_log (
    run_id INTEGER NOT NULL,
    fact_id INTEGER NOT NULL,
    action TEXT NOT NULL,            -- retire_dup|retire_sup|mark_supersedes
    prev_is_active INTEGER, prev_superseded_by INTEGER, prev_valid_until INTEGER,
    prev_supersedes INTEGER,
    PRIMARY KEY (run_id, fact_id, action)
);
CREATE TABLE IF NOT EXISTS apply_edges (
    run_id INTEGER NOT NULL, edge_id INTEGER NOT NULL, PRIMARY KEY (run_id, edge_id)
);
CREATE TABLE IF NOT EXISTS applied_relations (
    a INTEGER NOT NULL, b INTEGER NOT NULL, rel TEXT NOT NULL, run_id INTEGER NOT NULL,
    PRIMARY KEY (a, b, rel)
);
"""


def _dup_sets(rel_rows):
    """Union duplicate links into sets. Returns {fact: frozenset(members)}."""
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b in rel_rows:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    groups = {}
    for x in list(parent):
        groups.setdefault(find(x), set()).add(x)
    out = {}
    for g in groups.values():
        fg = frozenset(g)
        for x in g:
            out[x] = fg
    return out


def plan_apply(c, m):
    """Turn pending relations into concrete fact updates. Pure: no writes."""
    pend = c.execute(
        "SELECT r.a, r.b, r.rel, r.reason FROM relations r LEFT JOIN applied_relations ar "
        "ON ar.a=r.a AND ar.b=r.b AND ar.rel=r.rel WHERE ar.a IS NULL").fetchall()
    ids = {x for r in pend for x in r[:2]}
    info = {}
    idl = list(ids)
    for s in range(0, len(idl), 500):
        ch = idl[s:s + 500]
        for r in m.execute("SELECT id, valid_from, is_active, superseded_by_id, valid_until, supersedes_id "
                           f"FROM semantic_facts WHERE id IN ({','.join('?'*len(ch))})", ch):
            info[r[0]] = r
    pend = [r for r in pend if r[0] in info and r[1] in info]
    key = lambda f: ((info[f][1] or 0), f)  # noqa: E731
    dsets = _dup_sets([(a, b) for a, b, rel, _ in pend if rel == "duplicate"])
    retire_dup = {}      # fact -> canonical (newest member of its duplicate set)
    for fs in set(dsets.values()):
        canon = max(fs, key=key)
        for f in fs:
            if f != canon:
                retire_dup[f] = canon
    retire_sup = {}      # old fact -> (new fact, valid_until)
    mark_sup = {}        # new fact -> old fact (first one wins)
    skipped = 0
    for a, b, rel, _ in pend:
        if rel != "supersedes":
            continue
        sa, sb = dsets.get(a, frozenset([a])), dsets.get(b, frozenset([b]))
        if sa == sb or key(a) >= key(b):
            skipped += 1   # judge said duplicate and supersedes, or order is wrong
            continue
        tb = info[b][1] or 0
        new = max(sb, key=key)     # canonical of the newer side
        for f in sa:
            if f in sb or key(f) >= key(b):
                continue
            prev = retire_sup.get(f)
            if prev is None or key(prev[0]) < key(new):
                retire_sup[f] = (new, tb)
        mark_sup.setdefault(new, a)
    edges = []           # (source, target, type)
    for a, b, rel, _ in pend:
        if rel == "duplicate":
            edges.append((a, b, "support"))
        elif rel == "supersedes" and a in retire_sup:
            edges.append((b, a, "supersede"))
        elif rel == "contradicts":
            edges.append((a, b, "contradict"))
    # a fact retired by supersession wins over a duplicate retirement
    for f in list(retire_dup):
        if f in retire_sup:
            del retire_dup[f]
    return pend, info, retire_dup, retire_sup, mark_sup, edges, skipped


def cmd_apply(args):
    c = con_db()
    c.executescript(CLUSTER_SCHEMA)
    c.executescript(APPLY_SCHEMA)
    m = ro(MEM_DB)
    pend, info, retire_dup, retire_sup, mark_sup, edges, skipped = plan_apply(c, m)
    m.close()
    print(f"pending relations={len(pend)} retire_dup={len(retire_dup)} retire_sup={len(retire_sup)} "
          f"mark_supersedes={len(mark_sup)} edges={len(edges)} skipped_sup={skipped}", flush=True)
    if args.dry_run or not pend:
        return
    run_id = c.execute("INSERT INTO apply_runs(started_at,note) VALUES (?,?)",
                       (int(time.time()), args.note)).lastrowid
    c.commit()
    w = sqlite3.connect(MEM_DB, timeout=120)
    w.execute("PRAGMA busy_timeout=120000")
    now = int(time.time())
    ops = []
    for f, canon in retire_dup.items():
        ops.append(("retire_dup", f, canon, None))
    for f, (new, tb) in retire_sup.items():
        ops.append(("retire_sup", f, new, tb))
    for new, old in mark_sup.items():
        ops.append(("mark_supersedes", new, old, None))
    done = 0
    B = args.batch
    for s in range(0, len(ops), B):
        chunk = ops[s:s + B]
        for attempt in range(20):
            try:
                w.execute("BEGIN IMMEDIATE")
                logs = []
                for action, f, other, tb in chunk:
                    r = w.execute("SELECT is_active, superseded_by_id, valid_until, supersedes_id "
                                  "FROM semantic_facts WHERE id=?", (f,)).fetchone()
                    if r is None:
                        continue
                    logs.append((run_id, f, action, r[0], r[1], r[2], r[3]))
                    if action == "retire_dup":
                        w.execute("UPDATE semantic_facts SET is_active=0, superseded_by_id=? WHERE id=?",
                                  (other, f))
                    elif action == "retire_sup":
                        w.execute("UPDATE semantic_facts SET is_active=0, superseded_by_id=?, "
                                  "valid_until=? WHERE id=?", (other, tb, f))
                    else:
                        if r[3] is None:
                            w.execute("UPDATE semantic_facts SET supersedes_id=? WHERE id=?", (other, f))
                # undo log is durable before the memory.db commit
                c.executemany("INSERT OR IGNORE INTO apply_log VALUES (?,?,?,?,?,?,?)", logs)
                c.commit()
                w.execute("COMMIT")
                break
            except sqlite3.OperationalError as e:
                try:
                    w.execute("ROLLBACK")
                except sqlite3.OperationalError:
                    pass
                if "locked" not in str(e) and "busy" not in str(e):
                    raise
                time.sleep(1 + attempt)
        else:
            raise SystemExit(f"could not get write lock after retries at op {s}")
        done += len(chunk)
        if (s // B) % 20 == 0:
            print(f"  facts {done}/{len(ops)}", flush=True)
        time.sleep(args.pause)
    # evidence edges
    ne = 0
    for s in range(0, len(edges), B):
        chunk = edges[s:s + B]
        w.execute("BEGIN IMMEDIATE")
        ids_ = []
        for src, tgt, et in chunk:
            cur = w.execute("INSERT OR IGNORE INTO evidence_edges(source_fact_id,target_fact_id,edge_type,"
                            "confidence,created_at) VALUES (?,?,?,?,?)", (src, tgt, et, 0.9, now))
            if cur.rowcount:
                ids_.append((run_id, cur.lastrowid))
        w.execute("COMMIT")
        c.executemany("INSERT OR IGNORE INTO apply_edges VALUES (?,?)", ids_)
        c.commit()
        ne += len(ids_)
        time.sleep(args.pause)
    c.executemany("INSERT OR IGNORE INTO applied_relations VALUES (?,?,?,?)",
                  [(a, b, rel, run_id) for a, b, rel, _ in pend])
    c.execute("UPDATE apply_runs SET finished_at=?, retired_dup=?, retired_sup=?, edges=? WHERE id=?",
              (int(time.time()), len(retire_dup), len(retire_sup), ne, run_id))
    c.commit()
    print(f"DONE run={run_id} retired_dup={len(retire_dup)} retired_sup={len(retire_sup)} "
          f"marked={len(mark_sup)} edges={ne}", flush=True)


def cmd_rollback(args):
    c = con_db()
    c.executescript(APPLY_SCHEMA)
    run_id = args.run
    logs = c.execute("SELECT fact_id, action, prev_is_active, prev_superseded_by, prev_valid_until, "
                     "prev_supersedes FROM apply_log WHERE run_id=? ORDER BY rowid DESC",
                     (run_id,)).fetchall()  # newest first, so the oldest prev values win
    eids = [r[0] for r in c.execute("SELECT edge_id FROM apply_edges WHERE run_id=?", (run_id,))]
    w = sqlite3.connect(MEM_DB, timeout=120)
    w.execute("PRAGMA busy_timeout=120000")
    B = 500
    for s in range(0, len(logs), B):
        w.execute("BEGIN IMMEDIATE")
        for f, action, pa, psb, pvu, psup in logs[s:s + B]:
            w.execute("UPDATE semantic_facts SET is_active=?, superseded_by_id=?, valid_until=?, "
                      "supersedes_id=? WHERE id=?", (pa, psb, pvu, psup, f))
        w.execute("COMMIT")
    for s in range(0, len(eids), B):
        ch = eids[s:s + B]
        w.execute("BEGIN IMMEDIATE")
        w.execute(f"DELETE FROM evidence_edges WHERE id IN ({','.join('?'*len(ch))})", ch)
        w.execute("COMMIT")
    c.execute("DELETE FROM applied_relations WHERE run_id=?", (run_id,))
    c.execute("UPDATE apply_runs SET rolled_back_at=? WHERE id=?", (int(time.time()), run_id))
    c.commit()
    print(f"rolled back run={run_id} facts={len(logs)} edges={len(eids)}")


def cmd_stats(args):
    c = con_db()
    print("cand_pairs", c.execute("SELECT COUNT(*) FROM cand_pairs").fetchone())
    for lo, hi in [(0.95, 1.01), (0.92, 0.95), (0.90, 0.92), (0.88, 0.90), (0.85, 0.88)]:
        print(f"  sim [{lo},{hi})", c.execute(
            "SELECT COUNT(*) FROM cand_pairs WHERE sim>=? AND sim<?", (lo, hi)).fetchone()[0])
    print("judgments by label:")
    for r in c.execute("SELECT label, COUNT(*) FROM judgments GROUP BY 1 ORDER BY 2 DESC"):
        print("  ", r)
    print("judge cost", c.execute("SELECT COALESCE(SUM(cost_usd),0) FROM judge_runs").fetchone())


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("candidates")
    p.add_argument("--threshold", type=float, default=0.85)
    p.add_argument("--k", type=int, default=20)
    p.add_argument("--block", type=int, default=512)
    p.add_argument("--device", default="cpu", help="cpu | mps (torch topk on GPU)")
    p = sp.add_parser("judge")
    p.add_argument("--model", default="glm-5.3-flash")
    p.add_argument("--base-url", default="https://api.inferhub.dev/v1")
    p.add_argument("--batch", type=int, default=10)
    p.add_argument("--workers", type=int, default=16)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--sample", type=int, default=0)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--min-sim", type=float, default=0.85)
    p.add_argument("--max-sim", type=float, default=1.01)
    p.add_argument("--max-cost", type=float, default=200.0)
    p.add_argument("--no-reasoning", action="store_true",
                   help="send reasoning.enabled=false (about 3x fewer completion tokens)")
    p = sp.add_parser("clusters")
    p.add_argument("--threshold", type=float, default=0.85)
    p.add_argument("--max-size", type=int, default=12)
    p.add_argument("--force", action="store_true")
    p = sp.add_parser("judge-clusters")
    p.add_argument("--model", default="glm-5.3-flash")
    p.add_argument("--base-url", default="https://api.inferhub.dev/v1")
    p.add_argument("--workers", type=int, default=16)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--sample", type=int, default=0)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--max-cost", type=float, default=200.0)
    p.add_argument("--max-rpm", type=int, default=1800,
                   help="max outgoing HTTP requests/min (provider account cap)")
    p.add_argument("--no-reasoning", action="store_true")
    p = sp.add_parser("apply")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--batch", type=int, default=500)
    p.add_argument("--pause", type=float, default=0.05, help="seconds between write batches")
    p.add_argument("--note", default="")
    p = sp.add_parser("rollback")
    p.add_argument("--run", type=int, required=True)
    sp.add_parser("stats")
    args = ap.parse_args()
    {"candidates": cmd_candidates, "judge": cmd_judge, "stats": cmd_stats,
     "clusters": cmd_clusters, "judge-clusters": cmd_judge_clusters,
     "apply": cmd_apply, "rollback": cmd_rollback}[args.cmd](args)


if __name__ == "__main__":
    main()
