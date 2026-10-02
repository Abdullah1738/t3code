#!/usr/bin/env python3
"""Compile a compact user profile ("User as Code", rendered as markdown) from memory.

Map-reduce over:
  * semantic_facts whose subject/statement is about the user (active only), and
  * the user's own messages that mention personal details (passport, airline, ...).

map:    chunks of ~40K chars -> LLM extracts durable profile items per category
reduce: per category, LLM merges items (dedupe, newer wins on conflict, drop transient)
render: data/profile.md (read by memory_mcp.memory_profile) + data/profile.json

Costs are recorded in consolidation.db profile_runs and count against the shared budget.
Usage: .venv/bin/python -u src/profile_compiler.py [--workers 12] [--max-cost 200] [--dry-run]
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from consolidation_norm import norm_subject, norm_text  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEM_DB = os.environ.get("MEMORY_DB", os.path.join(ROOT, "data", "memory.db"))
CON_DB = os.environ.get("CONSOLIDATION_DB", os.path.join(ROOT, "data", "consolidation.db"))
OUT_MD = os.path.join(ROOT, "data", "profile.md")
OUT_JSON = os.path.join(ROOT, "data", "profile.json")
BASE = "https://api.surplusintelligence.ai/v1"

CATEGORIES = [
    ("identity", "Identity and personal details (name, handles, location, nationality, documents like passport, "
                 "contact details, family, health/diet, travel and airline/loyalty status)"),
    ("communication", "Communication and writing style (tone, emojis, formatting, how outward-facing text "
                      "must read, review comment style)"),
    ("working_rules", "Standing working rules and constraints for agents (git/commit rules, what never to do, "
                      "approval requirements, security rules, tool restrictions)"),
    ("engineering", "Engineering preferences and philosophy (build approach, testing, architecture taste, "
                    "languages, code style)"),
    ("environment", "Machine, accounts and tooling environment (OS, paths, drives, CLIs, models/providers, "
                    "agents in use, notification channels)"),
    ("projects", "Projects and roles (what each project is, the user's role, key repos/paths, status)"),
    ("other", "Other durable personal preferences (UI/design taste, food, hobbies, anything else stable)"),
]
CAT_KEYS = [c for c, _ in CATEGORIES]

PERSONAL_TERMS = ["passport", "airline", "emirates", "skywards", "frequent flyer", "allergy", "my address",
                  "my phone", "my name", "nationality", "visa", "date of birth", "birthday", "london", "gym",
                  "my email", "my wife", "my family", "i live", "my flight", "i am from", "i'm from", "resident"]

MAP_PROMPT = """You build a durable profile of one person ("the user", named Abdullah) from notes extracted
from his conversations with AI coding agents. You receive a chunk of dated notes.

Keep ONLY information that stays true across sessions and would help a new agent serve him without asking:
identity and personal details, communication style, standing rules, engineering preferences, environment,
projects and roles, stable personal preferences.

NEVER pick up as personal facts:
- Crypto wallet addresses of any chain (Solana base58, EVM 0x..., Tron T..., Bitcoin, Monero, Zcash t-/z-addresses, etc.). They are all project test wallets, never his own.
- Phone numbers seen in app testing (e.g. +91 98765 43210). They are test placeholders, not his.

Drop: one-off task state, bug details, what an agent did in one session, temporary plans, anything about
other people's code unless it is the user's standing rule. Do not invent anything.
working_rules and engineering are for GENERAL rules that apply across his work. A rule that only applies
to one project, repo or service goes under projects, prefixed with the project name. Keep exact values
(names, numbers, paths, account ids, document details) verbatim when they are the user's own durable data.

Categories:
{cats}

Return JSON: {{"items": [{{"category": "<key>", "statement": "<one concise sentence>", "date": "YYYY-MM-DD"}}]}}
Use the date of the latest note supporting the item. Return {{"items": []}} if nothing qualifies."""

REDUCE_PROMPT = """You merge profile items about one person (the user, Abdullah) for the category:
"{cat}".

Items are dated. Rules:
- Merge duplicates and paraphrases into one clear statement.
- When items conflict, the NEWER one wins; drop the older one. If the change itself matters (e.g. a rule
  that was reversed), state the current rule only.
- Drop anything transient, session-specific or trivial. Keep exact durable values verbatim.
- Order by importance to an agent working for him. At most {cap} items.
- Plain sentences, no emojis, no marketing tone.

Return JSON: {{"items": [{{"statement": "...", "since": "YYYY-MM-DD"}}]}} where since is the date of the
newest supporting item."""

TIER_PROMPT = """You triage profile items about one person (the user, Abdullah) for the category "{cat}".
Every AI agent working for him will get the profile. Assign each numbered item one tier:

- core: needed in almost every session (name, how to address him, timezone/location, top communication
  and working rules, his main roles). Be strict: at most {core_cap} core items in this category.
- extended: durable and useful, but only for some tasks (accounts, handles, project details, tooling).
- sensitive: private personal data an agent should see only when a task needs it: health, medication,
  body metrics, family members, relationships, pets' medical details, payment cards, phone numbers,
  device identifiers, IP addresses, KYC/verification status, document numbers.
- drop: probably NOT his own durable data: test/placeholder values (e.g. +91 98765 43210), other people's
  identities or accounts, test wallets from app testing, one-off task state, or claims that are doubtful.

Also give "short": the item rewritten in at most 200 characters, keeping exact values that matter.
Return JSON: {{"items": [{{"i": <n>, "tier": "core|extended|sensitive|drop", "short": "...", "why": "<few words>"}}]}}
Cover every item exactly once."""

TIERS = ("core", "extended", "sensitive", "drop")
CORE_CAPS = {"identity": 6, "communication": 10, "working_rules": 12, "engineering": 6, "environment": 5,
             "projects": 6, "other": 3}

USER_RE = re.compile(r"^\s*(the user|user|abdullah)('s)?\b", re.I)


def ro(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)
    return con


def con_db():
    c = sqlite3.connect(CON_DB, timeout=60, check_same_thread=False)
    c.execute("""CREATE TABLE IF NOT EXISTS profile_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, finished_at INTEGER, stage TEXT,
        calls INTEGER, errors INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL)""")
    c.commit()
    return c


def total_spend():
    tot = ro(MEM_DB).execute("SELECT COALESCE(SUM(cost_usd),0) FROM extraction_runs").fetchone()[0]
    c = con_db()
    for t in ("judge_runs", "profile_runs"):
        try:
            tot += c.execute(f"SELECT COALESCE(SUM(cost_usd),0) FROM {t}").fetchone()[0]
        except sqlite3.OperationalError:
            pass
    return tot


def call_llm(key, model, system, user, no_reasoning):
    payload = {"model": model, "temperature": 0.0, "response_format": {"type": "json_object"},
               "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if no_reasoning:
        payload["reasoning"] = {"enabled": False}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(payload).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.loads(r.read())
            u = d.get("usage") or {}
            pt, ct = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
            cost = (u.get("cost_details") or {}).get("upstream_inference_cost")
            if cost is None:
                cost = (pt * 0.125 + ct * 0.5) / 1e6
            return json.loads(d["choices"][0]["message"]["content"]), pt, ct, float(cost)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"llm failed: {last}")


def day(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts or 0))


def collect_facts():
    m = ro(MEM_DB)
    seen, out = set(), []
    for fid, t, subj, st, vf in m.execute(
            "SELECT id, fact_type, subject, statement, valid_from FROM semantic_facts "
            "WHERE is_active=1 AND fact_type != 'solved_problem' ORDER BY valid_from, id"):
        subj, st = subj or "", st or ""
        if not (norm_subject(subj) == "user" or USER_RE.match(subj) or USER_RE.match(st)):
            continue
        k = norm_text(st)
        if k in seen:
            continue
        seen.add(k)
        out.append((vf or 0, f"[{day(vf)}, {t}] {st[:500]}"))
    return out


def collect_personal_messages(window=500):
    m = ro(MEM_DB)
    out, seen = [], set()
    for term in PERSONAL_TERMS:
        rows = m.execute(
            "SELECT e.id, e.timestamp, e.content FROM episodic_fts f JOIN episodic_events e ON e.id=f.rowid "
            "WHERE episodic_fts MATCH ? AND e.speaker='user' AND e.content_type='text' LIMIT 300",
            ('"' + term + '"',)).fetchall()
        for eid, ts, content in rows:
            if eid in seen or not content:
                continue
            seen.add(eid)
            low = content.lower()
            i = low.find(term)
            s = content[max(0, i - window): i + window] if i >= 0 else content[:2 * window]
            ts_s = ts if isinstance(ts, (int, float)) else 0
            date = day(ts_s) if ts_s else str(ts)[:10]
            out.append((ts_s or 0, f"[{date}, user message] {' '.join(s.split())}"))
    return out


def chunks(lines, max_chars=40000):
    cur, n = [], 0
    for _, ln in lines:
        if n + len(ln) > max_chars and cur:
            yield "\n".join(cur)
            cur, n = [], 0
        cur.append(ln)
        n += len(ln) + 1
    if cur:
        yield "\n".join(cur)


class Run:
    def __init__(self, stage):
        self.c = con_db()
        self.id = self.c.execute("INSERT INTO profile_runs(started_at,stage,calls,errors,prompt_tokens,"
                                 "completion_tokens,cost_usd) VALUES(?,?,0,0,0,0,0)",
                                 (int(time.time()), stage)).lastrowid
        self.c.commit()
        self.calls = self.errors = self.pt = self.ct = 0
        self.cost = 0.0
        self.lock = threading.Lock()

    def add(self, pt, ct, cost, err=False):
        with self.lock:
            self._add(pt, ct, cost, err)

    def _add(self, pt, ct, cost, err):
        self.calls += 1
        self.errors += int(err)
        self.pt += pt
        self.ct += ct
        self.cost += cost
        self.c.execute("UPDATE profile_runs SET calls=?,errors=?,prompt_tokens=?,completion_tokens=?,cost_usd=?,"
                       "finished_at=? WHERE id=?",
                       (self.calls, self.errors, self.pt, self.ct, self.cost, int(time.time()), self.id))
        self.c.commit()


def run_map(key, model, docs, workers, budget_left):
    cats = "\n".join(f"- {k}: {d}" for k, d in CATEGORIES)
    system = MAP_PROMPT.format(cats=cats)
    run = Run("map")
    items = []

    def work(doc):
        return call_llm(key, model, system, doc, no_reasoning=True)

    with cf.ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(work, d) for d in docs]
        for i, f in enumerate(cf.as_completed(futs), 1):
            try:
                res, pt, ct, cost = f.result()
                run.add(pt, ct, cost)
                for it in res.get("items") or []:
                    if isinstance(it, dict) and it.get("category") in CAT_KEYS and it.get("statement"):
                        items.append({"category": it["category"], "statement": str(it["statement"]).strip(),
                                      "date": str(it.get("date") or "")[:10]})
            except Exception as e:  # noqa: BLE001
                run.add(0, 0, 0.0, err=True)
                print("map error:", e, flush=True)
            if i % 20 == 0:
                print(f"  map {i}/{len(docs)} items={len(items)} cost=${run.cost:.3f}", flush=True)
            if run.cost > budget_left:
                print("budget reached, stopping map", flush=True)
                for f2 in futs:
                    f2.cancel()
                break
    print(f"map done: calls={run.calls} errors={run.errors} items={len(items)} cost=${run.cost:.3f}", flush=True)
    return items


def reduce_items(key, model, cat, desc, items, cap, run, batch_chars=25000):
    """Hierarchical reduce: merge in batches until a single batch fits.

    Intermediate rounds run without reasoning and in parallel; only the final
    single-batch round uses reasoning. A failed batch carries its input
    forward instead of being dropped."""
    cur = sorted(items, key=lambda x: x.get("date") or "")
    rounds = 0
    force_single = False
    while True:
        lines = [f"[{it.get('date') or '?'}] {it['statement']}" for it in cur]
        batches, b, n = [], [], 0
        for ln in lines:
            if not force_single and n + len(ln) > batch_chars and b:
                batches.append(b)
                b, n = [], 0
            b.append(ln)
            n += len(ln) + 1
        if b:
            batches.append(b)
        final = len(batches) == 1
        # Intermediate batches share the budget so the total shrinks toward one batch.
        per_batch = cap if final else max(cap // 2, (cap * 2) // len(batches))
        system = REDUCE_PROMPT.format(cat=f"{cat}: {desc}", cap=per_batch)
        def work(bl):
            try:
                res, pt, ct, cost = call_llm(key, model, system, "\n".join(bl), no_reasoning=not final)
                run.add(pt, ct, cost)
                out = []
                for it in res.get("items") or []:
                    if isinstance(it, dict) and it.get("statement"):
                        out.append({"statement": str(it["statement"]).strip(),
                                    "date": str(it.get("since") or "")[:10]})
                return out
            except Exception as e:  # noqa: BLE001
                run.add(0, 0, 0.0, err=True)
                print(f"reduce error {cat} (round {rounds}, final={final}):", e, flush=True)
                if final:
                    try:  # retry the final merge once without reasoning
                        res, pt, ct, cost = call_llm(key, model, system, "\n".join(bl), no_reasoning=True)
                        run.add(pt, ct, cost)
                        return [{"statement": str(it["statement"]).strip(),
                                 "date": str(it.get("since") or "")[:10]}
                                for it in res.get("items") or []
                                if isinstance(it, dict) and it.get("statement")]
                    except Exception as e2:  # noqa: BLE001
                        run.add(0, 0, 0.0, err=True)
                        print(f"reduce final retry failed {cat}:", e2, flush=True)
                        return []
                # keep the batch's input so nothing is lost
                out = []
                for ln in bl:
                    d, _, s = ln.partition("] ")
                    out.append({"statement": s, "date": d.lstrip("[").replace("?", "")})
                return out
        with cf.ThreadPoolExecutor(min(8, len(batches))) as ex:
            nxt = [it for res in ex.map(work, batches) for it in res]
        print(f"  {cat} round {rounds}: batches={len(batches)} in={len(cur)} out={len(nxt)}", flush=True)
        rounds += 1
        shrank = len(nxt) < 0.85 * len(cur)
        cur = sorted(nxt, key=lambda x: x.get("date") or "")
        if final:
            return cur[:cap] if len(cur) > cap else cur
        # Not converging (long items keep us above one batch): merge everything
        # in one final call instead of looping.
        if not shrank or rounds >= 4:
            force_single = True


def tier_items(key, model, cat, items, run):
    """Label each reduced item core/extended/sensitive/drop and add a short form."""
    lines = [f"{i+1}. [{it.get('date') or '?'}] {it['statement']}" for i, it in enumerate(items)]
    system = TIER_PROMPT.format(cat=cat, core_cap=CORE_CAPS.get(cat, 5))
    for no_reasoning in (False, True):
        try:
            out, pt, ct, cost = call_llm(key, model, system, "\n".join(lines), no_reasoning)
            run.add(pt, ct, cost)
            break
        except Exception as e:  # noqa: BLE001
            run.add(0, 0, 0.0, err=True)
            print(f"  tier {cat} failed (reasoning={not no_reasoning}): {e}", flush=True)
            out = None
    got = {}
    for r in (out or {}).get("items", []):
        try:
            i = int(r["i"]) - 1
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= i < len(items) and r.get("tier") in TIERS:
            got[i] = r
    res = []
    for i, it in enumerate(items):
        r = got.get(i, {})
        # unlabeled items default to extended (never silently promoted or dropped)
        res.append({**it, "tier": r.get("tier", "extended"), "short": (r.get("short") or it["statement"])[:300],
                    "why": r.get("why", "unlabeled")})
    return res


TITLES = {"identity": "Identity and personal", "communication": "Communication style",
          "working_rules": "Working rules", "engineering": "Engineering preferences",
          "environment": "Environment and tooling", "projects": "Projects", "other": "Other preferences"}


OVERRIDES = os.path.join(ROOT, "data", "profile_overrides.json")
_SECRET_RE = re.compile(
    r"(?i)((?:api|app|access|secret|private|auth)[ _-]?key|secret|token|password|passwd|bearer)"
    r"([^.;\n]{0,60}?)\b([A-Za-z0-9_\-]{20,})\b")


def redact(s):
    """Mask credential-looking values that the extractor copied out of sessions."""
    def sub(m):
        val = m.group(3)
        if re.fullmatch(r"[A-Z][A-Z0-9_]+", val) and "_" in val:  # env var / secret NAME, not a value
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}[REDACTED]"
    return _SECRET_RE.sub(sub, s)


# Wallet / contract addresses and app-testing phone numbers are never Abdullah's
# own data (his call 2026-09-25: all wallets were project test wallets). Drop on sight.
ADDR_RE = re.compile(
    r"(0x[0-9a-fA-F]{40}|"                       # EVM
    r"\bT[1-9A-HJ-NP-Za-km-z]{33}\b|"            # Tron
    r"(?:bc1|tb1)[023456789acdefghjklmnpqrstuvwxyz]{8,87}|"  # Bitcoin bech32
    r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b)")         # Solana / BTC-legacy base58
WALLET_CTX_RE = re.compile(r"(?i)wallet|solana|tron|bitcoin|metamask|phantom|usdt|usdc|"
                           r"address (is|for|:)|account is")
TEST_PHONE_RE = re.compile(r"(98765 43210|\+91 ?98765)")

def _is_walletish(text):
    # an address-shaped token alone is not enough (contract addresses in project work
    # are legit content); drop only when the statement is about a wallet/account
    return TEST_PHONE_RE.search(text) or bool(WALLET_CTX_RE.search(text) and ADDR_RE.search(text))

def apply_overrides(profile):
    """data/profile_overrides.json: {"drop_contains": [...], "sensitive_contains": [...]} (manual review).
    Also auto-drops wallet addresses and test phone numbers (Abdullah 2026-09-25)."""
    ov = json.load(open(OVERRIDES)) if os.path.exists(OVERRIDES) else {}
    for its in profile.values():
        for it in its:
            for rep in ov.get("replace", []):
                if rep["contains"] in it["statement"]:
                    it["statement"] = it["short"] = rep["statement"]
                    it["why"] = "manual rewrite"
            text = it["statement"]
            if _is_walletish(text):
                it["tier"], it["why"] = "drop", "auto: wallet address / test contact data is never his"
            elif any(p in text for p in ov.get("drop_contains", [])):
                it["tier"], it["why"] = "drop", "manual override"
            elif any(p in text for p in ov.get("sensitive_contains", [])) and it.get("tier") != "drop":
                it["tier"], it["why"] = "sensitive", "manual override"
    return profile


def render_tier(profile, tiers, title, note, short=False):
    out = [f"# {title} (compiled {time.strftime('%Y-%m-%d')})", "", note, ""]
    for k in CAT_KEYS:
        its = [it for it in (profile.get(k) or []) if it.get("tier", "extended") in tiers]
        if not its:
            continue
        out.append(f"## {TITLES[k]}")
        for it in its:
            out.append(f"- {redact(it['short'] if short else it['statement'])}")
        out.append("")
    return "\n".join(out)


def write_tiered(profile):
    """profile_core.md (always-on), profile.md (core+extended), profile_sensitive.md, profile_dropped.md."""
    d = os.path.dirname(OUT_MD)
    profile = apply_overrides(profile)
    files = {
        "profile_core.md": render_tier(profile, ("core",), "User profile: Abdullah (core)",
                                       "Always-relevant facts. Call memory_profile(section='full') for more.",
                                       short=True),
        "profile.md": render_tier(profile, ("core", "extended"), "User profile: Abdullah",
                                  "Compiled from past sessions. Newer facts override older ones. Verify "
                                  "specifics before acting on them if they look stale."),
        "profile_sensitive.md": render_tier(profile, ("sensitive",), "User profile: sensitive details",
                                            "Private. Use only when the current task needs it; never repeat "
                                            "outside this conversation."),
        "profile_dropped.md": render_tier(profile, ("drop",), "Dropped profile items (review)",
                                          "Items the triage judged wrong, test data or not durable."),
    }
    for name, md in files.items():
        with open(os.path.join(d, name), "w") as fh:
            fh.write(md)
        print(f"wrote data/{name} ({len(md)} chars)", flush=True)


def render(profile):
    titles = {"identity": "Identity and personal", "communication": "Communication style",
              "working_rules": "Working rules", "engineering": "Engineering preferences",
              "environment": "Environment and tooling", "projects": "Projects", "other": "Other preferences"}
    out = [f"# User profile: Abdullah (compiled {time.strftime('%Y-%m-%d')})", "",
           "Compiled from past sessions. Newer facts override older ones. Verify specifics before acting "
           "on them if they look stale.", ""]
    for k in CAT_KEYS:
        its = profile.get(k) or []
        if not its:
            continue
        out.append(f"## {titles[k]}")
        for it in its:
            since = f" (since {it['date']})" if it.get("date") else ""
            out.append(f"- {it['statement']}{since}")
        out.append("")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="glm-5.3-flash")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--max-cost", type=float, default=200.0, help="cumulative cap shared with extraction")
    ap.add_argument("--chunk-chars", type=int, default=40000)
    ap.add_argument("--limit-chunks", type=int, default=0, help="testing: only map the first N chunks")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--items-cache", default=os.path.join(ROOT, "data", "profile_items.json"))
    ap.add_argument("--reuse-items", action="store_true", help="skip map, reuse cached items")
    ap.add_argument("--tier-only", action="store_true", help="only re-run tiering on data/profile.json")
    ap.add_argument("--render-only", action="store_true",
                    help="re-render md files from tiered data/profile.json (applies overrides + redaction, no LLM)")
    args = ap.parse_args()

    if args.render_only:
        write_tiered(json.load(open(OUT_JSON))["profile"])
        return

    spent = total_spend()
    left = args.max_cost - spent
    print(f"spent so far ${spent:.2f}, budget left ${left:.2f}", flush=True)
    if left <= 0:
        sys.exit("budget exhausted")
    key = open(os.path.expanduser("~/.config/opencode/surplus-token")).read().strip()

    if args.tier_only:
        profile = json.load(open(OUT_JSON))["profile"]
        run_tiers(key, args.model, profile)
        return

    if args.reuse_items and os.path.exists(args.items_cache):
        items = json.load(open(args.items_cache))
    else:
        t0 = time.time()
        facts = collect_facts()
        msgs = collect_personal_messages()
        print(f"collected facts={len(facts)} personal_msgs={len(msgs)} in {time.time()-t0:.0f}s", flush=True)
        docs = list(chunks(sorted(msgs) + facts, args.chunk_chars))
        if args.limit_chunks:
            docs = docs[:args.limit_chunks]
        total_chars = sum(len(d) for d in docs)
        print(f"chunks={len(docs)} chars={total_chars:,} (~{total_chars/4/1e6:.1f}M tokens)", flush=True)
        if args.dry_run:
            return
        items = run_map(key, args.model, docs, args.workers, left)
        with open(args.items_cache, "w") as fh:
            json.dump(items, fh)

    by = {k: [] for k in CAT_KEYS}
    for it in items:
        by[it["category"]].append(it)
    print("items per category:", {k: len(v) for k, v in by.items()}, flush=True)
    caps = {"identity": 40, "communication": 25, "working_rules": 40, "engineering": 30,
            "environment": 35, "projects": 30, "other": 20}
    run = Run("reduce")
    profile = {}
    with cf.ThreadPoolExecutor(len(CAT_KEYS)) as ex:
        futs = {ex.submit(reduce_items, key, args.model, k, d, by[k], caps[k], run): k
                for k, d in CATEGORIES if by[k]}
        for f in cf.as_completed(futs):
            profile[futs[f]] = f.result()
            print(f"  reduced {futs[f]}: {len(profile[futs[f]])} items", flush=True)
    print(f"reduce done: calls={run.calls} errors={run.errors} cost=${run.cost:.3f}", flush=True)

    with open(OUT_JSON, "w") as fh:
        json.dump({"compiled_at": int(time.time()), "profile": profile}, fh, indent=1)
    run_tiers(key, args.model, profile)


def run_tiers(key, model, profile):
    run = Run("tier")
    with cf.ThreadPoolExecutor(len(CAT_KEYS)) as ex:
        futs = {ex.submit(tier_items, key, model, k, profile[k], run): k for k in CAT_KEYS if profile.get(k)}
        for f in cf.as_completed(futs):
            profile[futs[f]] = f.result()
    counts = {k: {t: sum(1 for it in v if it.get("tier") == t) for t in TIERS} for k, v in profile.items()}
    print(f"tier done: calls={run.calls} errors={run.errors} cost=${run.cost:.3f} {counts}", flush=True)
    with open(OUT_JSON, "w") as fh:
        json.dump({"compiled_at": int(time.time()), "profile": profile}, fh, indent=1)
    write_tiered(profile)


if __name__ == "__main__":
    main()
