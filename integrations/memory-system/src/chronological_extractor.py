#!/usr/bin/env python3
"""Chronological batch fact extractor.

Streams the full episodic corpus in chronological order (codex -> hermes ->
opencode, each internally by timestamp), packs consecutive in-session events
into windows, and calls a cheap configurable flash model to extract durable
facts (decision, preference, constraint, solved_problem, profile, workflow).

Design notes:
- No sampling: every text event >= MIN_CHARS is considered.
- Heuristic pre-filters cut noise before any LLM call.
- Window-level idempotency keys make restarts safe.
- All sqlite access happens on the main thread; workers only do HTTP.
- Cost cap stops the run gracefully.

Config via CLI flags or env (EXTRACT_MODEL, EXTRACT_BASE_URL).
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

DB_PATH = os.path.expanduser("~/.local/share/memory-system/data/memory.db")
DEFAULT_BASE_URL = "https://api.inferhub.dev/v1"
DEFAULT_KEY_FILE = os.path.expanduser("~/.config/opencode/inferhub")
DEFAULT_MODEL = "glm-5.3-flash"
SOURCES = ["codex", "hermes", "opencode"]

MIN_CHARS = 25
MAX_EVENT_CHARS = 20000      # skip giant dumps entirely
EVENT_HEAD_CHARS = 3000      # per-event cap inside a window payload
WINDOW_EVENTS = 60
WINDOW_CHARS = 24000         # ~6K input tokens
FACTS_PER_WINDOW_CAP = 15

# assistant messages are only sent to the LLM when they carry decision-like
# signal or are long enough to plausibly contain rationale
SIGNAL_RE = re.compile(
    r"\b(decid(e|ed|es|ing|ion)|we('| wi)ll use|let's use|going forward|"
    r"from now on|don'?t\b|do not|never\b|always\b|prefer(s|red|rence)?|"
    r"remember|note that|approved?|ship(ping| it)?|merge[sd]?\b|deploy(s|ed|ing)?|"
    r"migrat(e|ed|ing|ion)|switch(ed)? to|instead of|rather than|root cause|"
    r"fixed by|workaround|the (issue|problem|bug) (was|is)|turns out|"
    r"passport|airline|status (code|level)|frequent fly|"
    r"agreed|the plan is|architecture|convention|policy|rule)\b",
    re.IGNORECASE,
)
NOISE_RE = re.compile(
    r"^(ok(ay)?|continue|yes|no|yeah|yep|nope|thanks|thank you|hi|hello|hey|"
    r"sure|done|gtg|brb|lol|nice|cool|great|perfect|sounds good|"
    r"please continue|go ahead|proceed)[.!]?$",
    re.IGNORECASE,
)

SYSTEM_PROMPT = (
    "You extract durable memory facts from AI-agent conversation logs.\n"
    "Return ONLY JSON: {\"facts\": [...]}. Each fact:\n"
    "{\"fact_type\": one of decision|preference|constraint|solved_problem|profile|workflow,\n"
    " \"subject\": short entity the fact is about,\n"
    " \"predicate\": short relation phrase,\n"
    " \"object\": short value/target,\n"
    " \"statement\": ONE self-contained sentence, understandable without the conversation,\n"
    " \"confidence\": 0.0-1.0,\n"
    " \"event_indices\": [integers referencing the [n] line numbers that support it]}\n"
    "Types: decision = a choice made or approved; preference = user's style/likes/dislikes;\n"
    "constraint = standing rule (never/always/must); solved_problem = issue + root cause + fix;\n"
    "profile = durable facts about the user (identity, documents, accounts, travel, contact,\n"
    "airline/status, personal details); workflow = repeatable process the user follows.\n"
    "Rules: only durable facts useful weeks later; skip ephemeral task chatter, code dumps,\n"
    "tool output, greetings. Deduplicate within the window. At most "
    + str(FACTS_PER_WINDOW_CAP) + " facts. If none, return {\"facts\": []}.\n"
    "Do NOT record crypto-security content: no facts about smart-contract exploits,\n"
    "vulnerabilities, red-team work, PoC/attack methodology, or exploit postmortems.\n"
    "If a window is about that work, record only the non-security engineering context\n"
    "(e.g. which repo, deploy/architecture decisions) and omit the security specifics.\n"
    "Do NOT record point-in-time repo or deploy state: which SHA a branch, HEAD, PR or\n"
    "environment is at, deploy-chain / CI-run / release-run / watcher status for a SHA,\n"
    "or approvals tied to an exact head. These change constantly and are always fetched\n"
    "live. Keep the durable part (the rule, decision or root cause) and leave the SHA out."
)

# Post-filter for the prompt rule above: a statement with a commit-like SHA and
# live-state wording is a snapshot, not a durable fact (Abdullah, 2026-09-28).
SHA_RE = re.compile(r"\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b", re.I)
# Only strong live-state wording; weaker hints ("at head X", "ci run") are left
# to the prompt rule because they also appear in durable root causes.
HEAD_STATE_RE = re.compile(
    r"\bhead (is|was|now|still|moved|advanced)\b|\b(sits|still) at\b|"
    r"advanced (to|from)|deploy(ment)? chain|\bchain for\b|"
    r"watcher (tick|state|sees)|exact (candidate at )?head|main-dev (sha|head)",
    re.I)


def is_head_snapshot(stmt, ftype):
    # rules/processes that mention heads (e.g. "re-verify the live PR head") and
    # root causes that name the commit they were found at are worth keeping
    if ftype in ("constraint", "workflow", "preference", "solved_problem"):
        return False
    return bool(SHA_RE.search(stmt) and HEAD_STATE_RE.search(stmt))


def norm_statement(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


CON_DB = os.path.expanduser("~/.local/share/memory-system/data/consolidation.db")


def month_start_epoch(now=None):
    t = time.localtime(now if now is not None else time.time())
    return int(time.mktime((t.tm_year, t.tm_mon, 1, 0, 0, 0, 0, 0, -1)))


def month_spend(mem_db, now=None):
    """Current-calendar-month spend across extraction, judge and profile runs."""
    since = month_start_epoch(now)
    tot = mem_db.execute(
        "SELECT COALESCE(SUM(cost_usd),0) FROM extraction_runs WHERE created_at>=?",
        (since,)).fetchone()[0]
    if os.path.exists(CON_DB):
        c = sqlite3.connect(CON_DB, timeout=60)
        try:
            for t in ("judge_runs", "profile_runs"):
                try:
                    tot += c.execute(
                        "SELECT COALESCE(SUM(cost_usd),0) FROM {} WHERE started_at>=?"
                        .format(t), (since,)).fetchone()[0]
                except sqlite3.OperationalError:
                    pass
        finally:
            c.close()
    return tot


def window_key(source, session_id, first_id, last_id):
    raw = "{}|{}|{}|{}".format(source, session_id, first_id, last_id)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class Extractor:
    def __init__(self, args):
        self.args = args
        self.db = sqlite3.connect(DB_PATH, timeout=600)
        self.db.execute("PRAGMA busy_timeout=600000")
        self._ensure_tables()
        self.known = set()
        for (s,) in self.db.execute("SELECT statement FROM semantic_facts"):
            self.known.add(norm_statement(s))
        if getattr(args, "retry_failed", False) and not args.dry_run:
            qs = ",".join("?" * len(args.sources))
            n = self.db.execute(
                "DELETE FROM extraction_runs WHERE source IN ({}) AND facts_in=0 "
                "AND (cost_usd IS NULL OR cost_usd=0)".format(qs),
                tuple(args.sources)).rowcount
            self.db.commit()
            print("retry-failed: forgot {:,} errored windows".format(n), flush=True)
        self.total_cost = self._cost_so_far()
        self.stats = dict(windows=0, events=0, facts_in=0, stored=0, dupes=0,
                          bad_json=0, api_err=0, skipped=0, head_filtered=0)

    def _ensure_tables(self):
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS extraction_runs(
              window_key TEXT PRIMARY KEY,
              source TEXT, session_id TEXT,
              first_event_id INTEGER, last_event_id INTEGER,
              n_events INTEGER, n_chars INTEGER,
              facts_in INTEGER, facts_stored INTEGER, dupes INTEGER,
              cost_usd REAL, model TEXT, created_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_extraction_runs_source
              ON extraction_runs(source, session_id);
            CREATE TABLE IF NOT EXISTS extraction_sessions(
              source TEXT, session_id TEXT, first_ts INTEGER,
              PRIMARY KEY(source, session_id)
            );
            """
        )
        self.db.commit()

    def _cost_so_far(self):
        """Spend the --max-cost cap is compared against.

        cumulative (default, historical backfill): lifetime extraction_runs.
        monthly (ongoing tick): current local calendar month across
        extraction_runs + judge_runs + profile_runs (consolidation.db).
        """
        if getattr(self.args, "budget_mode", "cumulative") != "monthly":
            row = self.db.execute("SELECT SUM(cost_usd) FROM extraction_runs").fetchone()
            return row[0] or 0.0
        return month_spend(self.db)

    # ---------------- event streaming (main thread) ----------------
    def sessions(self, source):
        cached = self.db.execute(
            "SELECT COUNT(*) FROM extraction_sessions WHERE source=?",
            (source,)).fetchone()[0]
        # codex is frozen and its scan is expensive; live sources are refreshed
        # each run so sessions added by the continuous importer get picked up
        if cached and self.args.changed_since and source == "opencode":
            # incremental tick: only sessions the sync touched recently that
            # are not cached yet. The full scan below reads every opencode row
            # (millions) and took 5-10 min per tick on a cold page cache.
            self.db.execute(
                "INSERT OR IGNORE INTO extraction_sessions "
                "SELECT source, session_id, MIN(timestamp) FROM episodic_events "
                "WHERE source=? AND session_id IN ("
                "  SELECT s.session_id FROM opencode_sync_sessions s "
                "  WHERE s.synced_at>=? AND s.session_id NOT IN ("
                "    SELECT session_id FROM extraction_sessions WHERE source=?)) "
                "AND content_type='text' "
                "AND speaker IN ('user','assistant') AND LENGTH(content)>=? "
                "GROUP BY session_id",
                (source, self.args.changed_since, source, MIN_CHARS))
            self.db.commit()
        elif not cached or source != "codex":
            print("caching session list for {} (one-time scan)...".format(source),
                  flush=True)
            self.db.execute(
                "INSERT OR IGNORE INTO extraction_sessions "
                "SELECT source, session_id, MIN(timestamp) FROM episodic_events "
                "WHERE source=? AND content_type='text' "
                "AND speaker IN ('user','assistant') AND LENGTH(content)>=? "
                "GROUP BY session_id", (source, MIN_CHARS))
            self.db.commit()
        if self.args.changed_since and source == "opencode":
            # incremental mode: only sessions the sync touched recently
            q = (
                "SELECT e.session_id, e.first_ts FROM extraction_sessions e "
                "JOIN opencode_sync_sessions s ON s.session_id=e.session_id "
                "WHERE e.source=? AND s.native=1 AND s.synced_at>=? "
            )
            params = [source, self.args.changed_since]
            if not getattr(self.args, "active", False):
                # settled and idle >= 30 min, so the trailing window is stable
                q += "AND s.time_updated>0 AND s.time_updated<? "
                params.append(int((time.time() - 1800) * 1000))
            q += "ORDER BY e.first_ts"
            return self.db.execute(q, params).fetchall()
        return self.db.execute(
            "SELECT session_id, first_ts FROM extraction_sessions "
            "WHERE source=? ORDER BY first_ts", (source,)).fetchall()

    def events(self, source, session_id):
        q = (
            "SELECT id, timestamp, speaker, content FROM episodic_events "
            "WHERE source=? AND session_id=? AND content_type='text' "
            "AND speaker IN ('user','assistant') AND LENGTH(content)>=? "
            "ORDER BY timestamp, id"
        )
        # materialize so no read snapshot stays open while finish_window writes
        # (open read snapshot + concurrent writer = SQLITE_BUSY_SNAPSHOT)
        rows = self.db.execute(q, (source, session_id, MIN_CHARS)).fetchall()
        for eid, ts, speaker, content in rows:
            if len(content) > MAX_EVENT_CHARS:
                continue
            text = content.strip()
            if not text or NOISE_RE.match(text):
                continue
            if speaker == "assistant" and len(text) < 400 and not SIGNAL_RE.search(text):
                continue
            yield (eid, ts, speaker, text)

    def session_watermark(self, source, session_id):
        """Highest event id already extracted for this session (0 if none)."""
        row = self.db.execute(
            "SELECT MAX(last_event_id) FROM extraction_runs "
            "WHERE source=? AND session_id=?", (source, session_id)).fetchone()
        return row[0] or 0

    def build_windows(self, source, session_id, watermark=0, ctx=8):
        """Yield (win_all, win_new). win_new = events with id > watermark (the
        window identity / watermark basis). win_all = win_new plus up to `ctx`
        preceding already-extracted events, prepended to the first window as
        LLM context so tail facts keep their conversational grounding."""
        evs = list(self.events(source, session_id))
        if watermark:
            pos = next((i for i, e in enumerate(evs) if e[0] > watermark), len(evs))
            new, prefix = evs[pos:], evs[max(0, pos - ctx):pos]
        else:
            new, prefix = evs, []
        win, chars = [], 0
        for ev in new:
            add = min(len(ev[3]), EVENT_HEAD_CHARS)
            if win and (len(win) >= WINDOW_EVENTS or chars + add > WINDOW_CHARS):
                yield (prefix + win, win)
                prefix = []
                win, chars = [], 0
            win.append(ev)
            chars += add
        if win:
            yield (prefix + win, win)

    # ---------------- LLM (worker threads, no db) ----------------
    def call_llm(self, payload_text):
        url = self.args.base_url.rstrip("/") + "/chat/completions"
        body = json.dumps({
            "model": self.args.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": payload_text},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
        }).encode("utf-8")
        req = urllib.request.Request(
            url, data=body,
            headers={"Authorization": "Bearer " + self.args.api_key,
                     "Content-Type": "application/json"})
        data, last_err = None, None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as e:
                last_err = "http {}: {}".format(e.code, e)
                if e.code != 429 and e.code < 500:
                    # 4xx is *usually* permanent, but gateways sometimes answer
                    # 4xx during overload hiccups; retry before giving up
                    if attempt >= 3:
                        return None, 0.0, "permanent: " + last_err
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                last_err = str(e)
            time.sleep(5 * (attempt + 1))
        if data is None:
            # transient: caller must not record the window so a later run retries it
            return None, 0.0, "transient: " + str(last_err)
        cost = 0.0
        usage = data.get("usage") or {}
        cd = usage.get("cost_details") or {}
        if isinstance(cd.get("upstream_inference_cost"), (int, float)):
            cost = cd["upstream_inference_cost"]
        else:
            cost = (usage.get("prompt_tokens", 0) * 0.125
                    + usage.get("completion_tokens", 0) * 0.5) / 1e6
        try:
            content = data["choices"][0]["message"]["content"]
            # glm-5.3-flash on inferhub sometimes wraps the JSON object in
            # markdown code fences on large prompts; strip them
            c = (content or "").strip()
            if c.startswith("```"):
                c = re.sub(r"^```[a-zA-Z]*\s*", "", c)
                c = re.sub(r"\s*```\s*$", "", c)
            return json.loads(c), cost, None
        except (KeyError, IndexError, ValueError) as e:
            return None, cost, "parse: " + str(e)

    # ---------------- window pipeline (main thread unless noted) ----------------
    def prepare_window(self, source, session_id, win, win_new=None):
        """Returns (key, payload) or None if already processed. Window identity
        comes from win_new (new events) when given, else the whole window."""
        wn = win_new if win_new is not None else win
        key = window_key(source, session_id, wn[0][0], wn[-1][0])
        row = self.db.execute(
            "SELECT 1 FROM extraction_runs WHERE window_key=?", (key,)).fetchall()
        if row:
            self.stats["skipped"] += 1
            return None
        lines = []
        for i, (eid, ts, speaker, text) in enumerate(win, 1):
            head = text[:EVENT_HEAD_CHARS]
            if len(text) > EVENT_HEAD_CHARS:
                head += " ...[truncated]"
            lines.append("[{}] {} {}: {}".format(
                i, time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)),
                speaker, head))
        return key, "\n\n".join(lines)

    def finish_window(self, source, session_id, win, key, future, win_new=None):
        result, cost, err = future.result()
        if self.args.dry_run:
            return
        facts = []
        if err:
            self.stats["api_err"] += 1
            if err.startswith("parse"):
                self.stats["bad_json"] += 1
            if err.startswith("transient"):
                # leave extraction_runs untouched so the next run retries it
                self.stats["retry_later"] = self.stats.get("retry_later", 0) + 1
                return
        elif isinstance(result, dict):
            raw_facts = result.get("facts") or []
            if isinstance(raw_facts, list):
                facts = [f for f in raw_facts if isinstance(f, dict)]
        for attempt in range(60):
            try:
                stored, dupes, new_known = self._write_window(
                    source, session_id, win, key, facts, cost, win_new)
                break
            except sqlite3.OperationalError as e:
                if "locked" not in str(e) and "busy" not in str(e):
                    raise
                self.db.rollback()
                time.sleep(min(2 + attempt, 30))
        else:
            raise RuntimeError("could not write window after retries")
        self.known.update(new_known)
        self.stats["windows"] += 1
        self.stats["events"] += len(win_new) if win_new is not None else len(win)
        self.stats["facts_in"] += len(facts)
        self.stats["stored"] += stored
        self.stats["dupes"] += dupes
        self.total_cost += cost

    def _write_window(self, source, session_id, win, key, facts, cost, win_new=None):
        stored, dupes = 0, 0
        new_known = set()
        now = int(time.time())
        wn = win_new if win_new is not None else win
        if self.db.in_transaction:
            self.db.commit()
        self.db.execute("BEGIN IMMEDIATE")
        for f in facts[:FACTS_PER_WINDOW_CAP]:
            stmt = (f.get("statement") or "").strip()
            if len(stmt) < 10:
                continue
            ns = norm_statement(stmt)
            if ns in self.known or ns in new_known:
                dupes += 1
                continue
            idxs = f.get("event_indices") or []
            src_eid = wn[0][0]
            if isinstance(idxs, list) and idxs and isinstance(idxs[0], int) \
                    and 1 <= idxs[0] <= len(win):
                src_eid = win[idxs[0] - 1][0]
            ftype = f.get("fact_type")
            if ftype not in ("decision", "preference", "constraint",
                             "solved_problem", "profile", "workflow"):
                ftype = "decision"
            if is_head_snapshot(stmt, ftype):
                self.stats["head_filtered"] += 1
                continue
            conf = f.get("confidence")
            conf = conf if isinstance(conf, (int, float)) and 0 <= conf <= 1 else 0.8
            self.db.execute(
                "INSERT INTO semantic_facts(fact_type, subject, predicate, object, "
                "statement, source_event_id, extracted_at, confidence, is_active, "
                "valid_from) VALUES (?,?,?,?,?,?,?,?,1,?)",
                (ftype, str(f.get("subject") or "")[:500],
                 str(f.get("predicate") or "")[:500],
                 str(f.get("object") or "")[:1000],
                 stmt[:2000], src_eid, now, conf, wn[0][1]))
            new_known.add(ns)
            stored += 1
        self.db.execute(
            "INSERT OR REPLACE INTO extraction_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (key, source, session_id, wn[0][0], wn[-1][0], len(wn),
             sum(min(len(w[3]), EVENT_HEAD_CHARS) for w in wn),
             len(facts), stored, dupes, cost, self.args.model, now))
        self.db.commit()
        return stored, dupes, new_known

    def run(self):
        limit = self.args.limit_windows
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=self.args.workers) as pool:
            pending = []
            for source in self.args.sources:
                sess = self.sessions(source)
                print("source {}: {:,} sessions".format(source, len(sess)),
                      flush=True)
                stop = False
                # incremental opencode runs extract only each session's tail
                # (events newer than its watermark); bulk runs do full sessions
                tail_mode = bool(self.args.changed_since) and source == "opencode"
                for i, (session_id, _first_ts) in enumerate(sess):
                    if stop:
                        break
                    wm = self.session_watermark(source, session_id) if tail_mode else 0
                    for win, win_new in self.build_windows(source, session_id, watermark=wm):
                        if limit and self.stats["windows"] + len(pending) >= limit:
                            stop = True
                            break
                        if self.total_cost >= self.args.max_cost:
                            print("cost cap reached (${:.2f})".format(
                                self.total_cost), flush=True)
                            stop = True
                            break
                        prep = self.prepare_window(source, session_id, win, win_new)
                        if prep is None:
                            continue
                        key, payload = prep
                        if self.args.dry_run:
                            print("=== {}:{} events={} chars={} ===".format(
                                source, session_id, len(win_new), len(payload)))
                            print(payload[:1500])
                            self.stats["windows"] += 1
                            if limit and self.stats["windows"] >= limit:
                                stop = True
                                break
                            continue
                        pending.append((source, session_id, win, key,
                                        pool.submit(self.call_llm, payload),
                                        win_new))
                        while len(pending) >= self.args.workers * 2:
                            item = pending.pop(0)
                            self.finish_window(*item)
                    if (i + 1) % 200 == 0:
                        rate = (i + 1) / max(time.time() - t0, 1)
                        print("  {} {}/{} sess | windows={:,} stored={:,} "
                              "dupes={:,} err={} cost=${:.2f} ({:.1f} sess/s)"
                              .format(source, i + 1, len(sess),
                                      self.stats["windows"], self.stats["stored"],
                                      self.stats["dupes"], self.stats["api_err"],
                                      self.total_cost, rate), flush=True)
                if stop:
                    break
            while pending:
                item = pending.pop(0)
                self.finish_window(*item)
        print("DONE: retry_later={} ".format(self.stats.get("retry_later", 0)) +
              "windows={:,} events={:,} facts_in={:,} stored={:,} "
              "dupes={:,} bad_json={} api_err={} skipped={:,} cost=${:.2f}".format(
                  self.stats["windows"], self.stats["events"],
                  self.stats["facts_in"], self.stats["stored"],
                  self.stats["dupes"], self.stats["bad_json"],
                  self.stats["api_err"], self.stats["skipped"],
                  self.total_cost), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sources", nargs="+", default=SOURCES, choices=SOURCES)
    p.add_argument("--model", default=os.environ.get("EXTRACT_MODEL", DEFAULT_MODEL))
    p.add_argument("--base-url",
                   default=os.environ.get("EXTRACT_BASE_URL", DEFAULT_BASE_URL))
    p.add_argument("--api-key-file", default=DEFAULT_KEY_FILE)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--max-cost", type=float, default=40.0)
    p.add_argument("--budget-mode", choices=["cumulative", "monthly"],
                   default="cumulative",
                   help="cumulative: --max-cost vs lifetime extraction spend "
                        "(historical backfill, $200). monthly: --max-cost vs "
                        "current-month extraction+judge+profile spend (tick, $1000)")
    p.add_argument("--limit-windows", type=int, default=0)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--retry-failed", action="store_true",
                   help="forget windows recorded with cost=0 and no facts "
                        "(old transient API errors) so they are re-extracted")
    p.add_argument("--changed-since", type=int, default=0,
                   help="epoch secs; opencode sessions synced at/after this only")
    p.add_argument("--active", action="store_true",
                   help="with --changed-since: also extract sessions that are "
                        "still active (no 30-min idle settle). Tails use "
                        "watermark keys, so growing windows are not re-extracted")
    args = p.parse_args()
    args.api_key = open(args.api_key_file).read().strip()
    if not args.api_key:
        print("empty api key", file=sys.stderr)
        sys.exit(1)
    Extractor(args).run()


if __name__ == "__main__":
    main()
