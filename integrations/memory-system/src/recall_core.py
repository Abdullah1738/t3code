"""Recall core: fast, read-only search over every captured agent session.

memory.db `episodic_events` is the only source of truth. Two FTS5 indexes sit on
it: `episodic_text_fts` (user/assistant text, contentless) and `episodic_fts`
(every event, incl. tool calls/results). This module plans FTS queries from
document frequencies so they stay fast on 120M+ events, groups hits into
sessions, and renders sessions for reading. Stdlib only.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
import re
import sqlite3
import threading
import time
import unicodedata
from collections import deque
from contextlib import closing
from functools import wraps
from dataclasses import dataclass, field
from pathlib import Path

import robob_readonly

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("RECALL_DATA", str(ROOT / "data")))
MEM_DB = Path(os.environ.get("RECALL_MEM_DB", str(DATA / "memory.db")))
HOT_DB = Path(os.environ["RECALL_HOT_DB"]) if os.environ.get("RECALL_HOT_DB") else None
CATALOG_DB = Path(os.environ.get("RECALL_CATALOG_DB", str(DATA / "recall_catalog.db")))
OPENCODE_DB = Path(robob_readonly.opencode_db())
STATE_DB = Path(robob_readonly.state_db("RECALL_STATE_DB"))

STOP = set(
    """a an and are as at be by can do does for from has have how i in is it its me my of on or our
    should that the this to was we what when where which who why will with you your did were been
    about into there their them then than so not no if but just also all any some get got use used
    using like want need make made let lets please could would there here these those yes ok okay
    thanks know think see look way thing things one two now still again more most much very really
    after before over under up down out off via per each other same such only own too us he she they
    his her hers him its it's i'm im you're dont don't doesnt doesn't didnt didn't cant can't wont
    won't isnt isn't arent aren't wasnt wasn't""".split()
)
# Words that say "search my history" but never appear verbatim in the answer.
META_WORDS = set(
    """remember recall earlier previously previous last time discussed discuss talked talk session
    sessions chat chats thread threads conversation conversations decided decide decision agent
    agents past history ago week weeks month months yesterday today said told mentioned""".split()
)

WORD_RE = re.compile(r"[^\W_]+(?:[._\-/:@][^\W_]+)*", re.UNICODE)
TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)

TEXT_FTS = "episodic_text_fts"
ALL_FTS = "episodic_fts"
RANK_LIMIT = 20_000  # above this many hits, BM25 sorting gets slow; use recency
REASONING_KINDS = ("reasoning",)

_local = threading.local()


def _interrupted() -> int:
    deadline = getattr(_local, "deadline", None)
    return int(deadline is not None and deadline.expired())


def _check_budget():
    if _interrupted():
        raise Timeout("recall work budget exceeded")


class Timeout(Exception):
    pass


@dataclass
class Deadline:
    seconds: float
    t: float = field(init=False)

    def __post_init__(self) -> None:
        self.t = time.monotonic() + self.seconds

    def left(self) -> float:
        return self.t - time.monotonic()

    def expired(self) -> bool:
        return time.monotonic() > self.t


# ---------------------------------------------------------------------------
# connections


def connect_ro(path: Path) -> sqlite3.Connection:
    # mode=ro without query_only: fts5vocab needs a writable temp schema.
    try:
        if path == OPENCODE_DB:
            reader = robob_readonly.native_ro
        elif path == STATE_DB:
            reader = robob_readonly.state_ro
        else:
            reader = robob_readonly.connect_ro
        con = reader(path, timeout=0.1, check_same_thread=False)
    except OSError as exc:
        raise sqlite3.OperationalError(str(exc)) from exc
    con.execute("PRAGMA temp_store=MEMORY")
    con.execute("PRAGMA busy_timeout=100")
    con.execute("PRAGMA cache_size=-8192")
    con.set_progress_handler(_interrupted, 1000)
    return con


def mem() -> sqlite3.Connection:
    con = getattr(_local, "mem", None)
    if con is None:
        con = connect_ro(HOT_DB or MEM_DB)
        con.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS temp.vocab_text USING fts5vocab(main, {TEXT_FTS}, row)")
        con.execute(f"CREATE VIRTUAL TABLE IF NOT EXISTS temp.vocab_all USING fts5vocab(main, {ALL_FTS}, row)")
        _local.mem = con
    return con


def cold() -> sqlite3.Connection:
    if HOT_DB is None:
        return mem()
    con = getattr(_local, "cold", None)
    if con is None:
        con = connect_ro(MEM_DB)
        _local.cold = con
    return con


def close_readers() -> None:
    # Thread pools reuse threads; no reader survives a request or model wait.
    for key in ("mem", "cold", "catalog_r", "opencode"):
        con = getattr(_local, key, None)
        if con is not None:
            con.close()
            setattr(_local, key, None)


def bounded(seconds: float):
    """A nested operation shares the caller's budget, including direct SQL."""
    def decorate(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            previous = getattr(_local, "deadline", None)
            deadline = kwargs.get("deadline") or Deadline(seconds)
            if previous is not None and previous.t < deadline.t:
                deadline = previous
            _local.deadline = deadline
            try:
                return fn(*args, **kwargs)
            except sqlite3.OperationalError as exc:
                if "interrupt" in str(exc).lower():
                    raise Timeout("recall read budget exceeded; narrow the query or use an event reference") from None
                raise
            finally:
                _local.deadline = previous
                if previous is None:
                    close_readers()
        return wrapped
    return decorate


def catalog(write: bool = False) -> sqlite3.Connection:
    key = "catalog_w" if write else "catalog_r"
    con = getattr(_local, key, None)
    if con is None:
        path = robob_readonly.safe_path(CATALOG_DB)
        if write or not CATALOG_DB.exists():
            con = sqlite3.connect(str(path), timeout=0.1, check_same_thread=False)
            con.execute("PRAGMA journal_mode=WAL")
            con.executescript(CATALOG_SCHEMA)
            con.commit()
        else:
            con = robob_readonly.connect_ro(path, timeout=0.1, check_same_thread=False)
        con.set_progress_handler(_interrupted, 1000)
        setattr(_local, key, con)
    return con


def opencode_ro() -> sqlite3.Connection | None:
    con = getattr(_local, "opencode", None)
    fresh = None
    try:
        path = robob_readonly.safe_path(OPENCODE_DB)
        info = path.stat()
        fresh = connect_ro(OPENCODE_DB)
        updated = robob_readonly.native_generation(fresh)
        generation = str(path), info.st_dev, info.st_ino, updated
        if (con is not None and con.in_transaction
                and getattr(_local, "opencode_generation", None) == generation
                and robob_readonly.native_generation(con) == updated):
            fresh.close()
        else:
            fresh.execute("SELECT 1 FROM session_v2 LIMIT 1").fetchone()
            if con is not None:
                con.close()
            con = _local.opencode = fresh
            _local.opencode_generation = generation
        fresh = None
    except (OSError, sqlite3.Error):
        if fresh is not None:
            fresh.close()
        if con is not None:
            con.close()
            _local.opencode = None
        return None
    return con


def run(con: sqlite3.Connection, sql: str, params=(), deadline: Deadline | None = None) -> list:
    request_deadline = getattr(_local, "deadline", None)
    if request_deadline is not None and (deadline is None or request_deadline.t < deadline.t):
        deadline = request_deadline
    if deadline is not None:
        if deadline.expired():
            raise Timeout()
        end = deadline.t
        con.set_progress_handler(lambda: 1 if time.monotonic() > end else 0, 5000)
    try:
        return con.execute(sql, params).fetchall()
    except sqlite3.OperationalError as e:
        if "interrupt" in str(e).lower():
            raise Timeout() from None
        raise
    finally:
        if deadline is not None:
            con.set_progress_handler(_interrupted, 1000)


# ---------------------------------------------------------------------------
# text cleanup

GUIDANCE_END = "[End of channel guidance. The owner's message follows.]"
BOILERPLATE_PREFIXES = (
    "# AGENTS.md instructions",
    "<environment_context>",
    "<user_instructions>",
    "<permissions instructions>",
    "<turn_aborted>",
    "[Compressed conversation section]",
    "<shell id=",
    "<system-update>",
    "<skill_content",
    "<subagent sessionID=",
    "<recall>",
)
AUTOMATION_MARKERS = (
    "The watcher keeps running; manage it with robob-watch",
    "You are coord actor",
)
AUTOMATION_PREFIXES = (
    "[coord]",
    "[crw]",
    "[master hourly",
    "cell-triage",
    "[offbox]",
    "[Watcher event from robob-watch",
)
SYSTEM_REMINDER_RE = re.compile(r"<(system-reminder|dcp-system-reminder)>.*?(</\1>|$)", re.S)
# DCP appends context nudges to the user message; without tags they run to the end.
DCP_NUDGE_RE = re.compile(
    r"(Evaluate the conversation for compressible ranges\.|You've been iterating for a while after the last user message\."
    r"|CRITICAL WARNING: MAX CONTEXT LIMIT REACHED|Compressed block context:).*",
    re.S,
)
FILE_LINE_RE = re.compile(r"^\[file [^\n]{0,400}\]$", re.M)
THINK_RE = re.compile(r"<think>.*?(</think>|$)", re.S)
# DCP message-id markers the plugin sees in live context ("@531@", "@b3@ [high]", <dcp-message-id>m0531</...>).
DCP_ID_RE = re.compile(r"<dcp-message-id[^>]*>[^<]*</dcp-message-id>|@b?\d+@(?: \[[^\]\n]{0,40}\])?")


def clean_text(text: str | None, speaker: str = "user") -> str:
    """Strip harness boilerplate; '' means the message is pure boilerplate."""
    if not text:
        return ""
    t = THINK_RE.sub("", text) if "<think>" in text else text
    if "@" in t or "<dcp-message-id" in t:
        t = DCP_ID_RE.sub("", t)
    if speaker == "user":
        if GUIDANCE_END in t:
            t = t.split(GUIDANCE_END, 1)[1]
        elif t.startswith("[Channel guidance from"):
            return ""
        if t.startswith("[Abdullah] "):
            t = t[len("[Abdullah] ") :]
        s = t.lstrip()
        if s.startswith(BOILERPLATE_PREFIXES):
            return ""
        t = SYSTEM_REMINDER_RE.sub("", t)
        t = DCP_NUDGE_RE.sub("", t)
        t = FILE_LINE_RE.sub("[file]", t)
    return t.strip()


def is_automation(text: str) -> bool:
    s = text.lstrip()
    return s.startswith(AUTOMATION_PREFIXES) or any(m in text for m in AUTOMATION_MARKERS)


SKILL_LINK_RE = re.compile(r"\[\$([\w.-]+)\]\([^)]*\)")


def nice_title(title: str) -> str:
    """Titles from Codex first prompts carry skill links; keep just $skill."""
    return squash(SKILL_LINK_RE.sub(r"$\1", title or ""))


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def fold(token: str) -> str:
    token = token.lower()
    if token.isascii():
        return token
    return "".join(c for c in unicodedata.normalize("NFKD", token) if not unicodedata.combining(c))


def fmt_ts(ts: int | float | None, with_time: bool = True) -> str:
    if not ts:
        return "?"
    return time.strftime("%Y-%m-%d %H:%M" if with_time else "%Y-%m-%d", time.localtime(int(ts)))


def parse_when(value: str | int | float | None) -> int | None:
    """'2026-10-01', '7d', '3w', '2m' (months), unix seconds -> unix seconds."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    v = str(value).strip()
    m = re.fullmatch(r"(\d+)\s*([hdwmy])", v)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        secs = {"h": 3600, "d": 86400, "w": 7 * 86400, "m": 30 * 86400, "y": 365 * 86400}[unit]
        return int(time.time()) - n * secs
    if v.isdigit():
        return int(v)
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y-%m"):
        try:
            return int(time.mktime(time.strptime(v, fmt)))
        except ValueError:
            pass
    raise ValueError(f"can't parse date {value!r} (use YYYY-MM-DD or 7d/3w/2m)")


# ---------------------------------------------------------------------------
# query planning


@dataclass
class Term:
    tokens: list[str]
    df: int

    @property
    def match(self) -> str:
        return '"' + " ".join(self.tokens) + '"'


def words_of(text: str, drop_meta: bool = True) -> list[list[str]]:
    out, seen = [], set()
    for w in WORD_RE.findall(text or ""):
        toks = [fold(t) for t in TOKEN_RE.findall(w)]
        if not toks:
            continue
        if len(toks) == 1:
            t = toks[0]
            if t in STOP or (drop_meta and t in META_WORDS):
                continue
            if len(t) < 2 or (t.isdigit() and len(t) < 3):
                continue
        key = " ".join(toks)
        if key not in seen:
            seen.add(key)
            out.append(toks)
    return out


_df_cache: dict[tuple[str, str], int] = {}
_df_lock = threading.Lock()


def doc_freq(con: sqlite3.Connection, token: str, vocab: str, deadline: Deadline | None = None) -> int:
    key = (vocab, token)
    hit = _df_cache.get(key)
    if hit is not None:
        return hit
    rows = run(con, f"SELECT doc FROM temp.{vocab} WHERE term=?", (token,), deadline)
    n = int(rows[0][0]) if rows else 0
    with _df_lock:
        if len(_df_cache) > 50_000:
            _df_cache.clear()
        _df_cache[key] = n
    return n


def plan_terms(con: sqlite3.Connection, text: str, vocab: str, max_terms: int = 6, deadline: Deadline | None = None) -> list[Term]:
    terms = []
    for toks in words_of(text)[:24]:
        df = min(doc_freq(con, t, vocab, deadline) for t in toks)
        if df > 0:
            terms.append(Term(toks, df))
    # Rarest first: they carry the meaning and keep AND queries cheap.
    terms.sort(key=lambda t: t.df)
    return terms[:max_terms]


def count_hits(con: sqlite3.Connection, table: str, match: str, deadline: Deadline | None, cap: int = RANK_LIMIT + 1) -> int:
    rows = run(
        con,
        f"SELECT count(*) FROM (SELECT 1 FROM {table} WHERE {table} MATCH ? LIMIT {cap})",
        (match,),
        deadline,
    )
    return int(rows[0][0])


MAX_AND = 4  # more ANDed words rarely co-occur in one message


def plan_candidates(con: sqlite3.Connection, text: str, table: str, deadline: Deadline | None):
    """AND combinations of the query's terms that have hits: largest first, then most specific.

    Lazy, so callers only pay for counts until a candidate survives filtering.
    """
    vocab = "vocab_text" if table == TEXT_FTS else "vocab_all"
    terms = plan_terms(con, text, vocab, deadline=deadline)
    for size in range(min(len(terms), MAX_AND), 0, -1):
        found = []
        for combo in itertools.combinations(terms, size):
            match = " AND ".join(t.match for t in combo)
            n = combo[0].df if size == 1 and len(combo[0].tokens) == 1 else count_hits(con, table, match, deadline)
            if n:
                weight = sum(math.log(1e8 / (t.df + 1)) for t in combo)
                found.append((weight, match, n, list(combo)))
        for weight, match, n, combo in sorted(found, key=lambda f: -f[0]):
            yield match, n, combo


def plan_query(con: sqlite3.Connection, text: str, table: str, deadline: Deadline | None) -> tuple[str, int, list[Term]] | None:
    """The best candidate from plan_candidates, or None."""
    return next(plan_candidates(con, text, table, deadline), None)


# ---------------------------------------------------------------------------
# search


@dataclass
class Hit:
    event_id: int
    source: str
    session_id: str
    speaker: str
    ts: int
    content_type: str = "text"
    text: str = ""
    score: float = 0.0


def fetch_events(con: sqlite3.Connection, ids: list[int], max_chars: int = 30000) -> dict[int, tuple]:
    out = {}
    for i in range(0, len(ids), 200):
        chunk = ids[i : i + 200]
        q = ",".join("?" * len(chunk))
        for row in con.execute(
            f"SELECT id, source, session_id, speaker, timestamp, content_type, substr(content,1,{max_chars}), metadata_json "
            f"FROM episodic_events WHERE id IN ({q})",
            chunk,
        ).fetchall():
            out[row[0]] = row
    return out


def _kind(meta_json: str | None) -> str:
    if not meta_json:
        return ""
    try:
        return str((json.loads(meta_json) or {}).get("kind") or "")
    except (ValueError, TypeError):
        return ""


@dataclass(frozen=True)
class Filters:
    source: str | None = None
    since: int | None = None
    until: int | None = None
    exclude: frozenset = frozenset()

    def sql(self, table: str) -> tuple[str, list]:
        # episodic_text_fts stores source/session_id/ts itself; episodic_fts needs the join.
        col = {"source": f"{TEXT_FTS}.source", "session_id": f"{TEXT_FTS}.session_id", "ts": f"{TEXT_FTS}.ts"}
        if table != TEXT_FTS:
            col = {"source": "e.source", "session_id": "e.session_id", "ts": "e.timestamp"}
        where, params = [], []
        if self.source:
            where.append(f"{col['source']} = ?")
            params.append(self.source)
        if self.since:
            where.append(f"{col['ts']} >= ?")
            params.append(int(self.since))
        if self.until:
            where.append(f"{col['ts']} <= ?")
            params.append(int(self.until))
        if self.exclude:
            # One JSON parameter avoids SQLite's bind-variable limit without
            # truncating a large caller tree or consuming the FTS hit window.
            where.append(f"{col['session_id']} NOT IN (SELECT value FROM json_each(?))")
            params.append(json.dumps(sorted(self.exclude)))
        return "".join(" AND " + w for w in where), params

    def __bool__(self) -> bool:
        return bool(self.source or self.since or self.until or self.exclude)


def _fts_rows(con, table: str, match: str, n: int, filters: Filters, limit: int, deadline: Deadline | None) -> tuple[list, str]:
    order = "rank" if n <= RANK_LIMIT else "rowid DESC"
    extra, params = filters.sql(table)
    # FTS5's MATCH column and bm25() want the bare table name, so no alias for it.
    if table == TEXT_FTS:
        sql = f"SELECT rowid, bm25({table}) FROM {table} WHERE {table} MATCH ?{extra} ORDER BY {order} LIMIT ?"
    elif extra:
        sql = (
            f"SELECT {table}.rowid, bm25({table}) AS r FROM {table} JOIN episodic_events e ON e.id = {table}.rowid "
            f"WHERE {table} MATCH ?{extra} ORDER BY {'r' if order == 'rank' else table + '.rowid DESC'} LIMIT ?"
        )
    else:
        sql = f"SELECT rowid, bm25({table}) FROM {table} WHERE {table} MATCH ? ORDER BY {order} LIMIT ?"
    return run(con, sql, [match, *params, limit], deadline), order


def _hits_from_rows(con, rows: list, terms: list[Term], text: str, *, include_tools: bool, exact: bool) -> list[Hit]:
    events = fetch_events(con, [r[0] for r in rows])
    needles = [" ".join(t.tokens) for t in terms]
    hits: list[Hit] = []
    for pos, (rowid, _bm) in enumerate(rows):
        ev = events.get(rowid)
        if not ev:
            continue
        _, source, session_id, speaker, ts, ctype, content, meta = ev
        if not include_tools and (ctype != "text" or speaker not in ("user", "assistant")):
            continue
        cleaned = clean_text(content, speaker) if ctype == "text" else (content or "")
        if not cleaned:
            continue
        # The FTS row can match inside boilerplate we just stripped; require the
        # terms in what the reader will actually see.
        low = fold_text(cleaned)
        if HOT_DB and not all(f" {n_} " in low for n_ in needles):
            # FTS indexes the full archive, while hot rows only keep previews.
            # Resolve a bounded window by primary key, never a transcript scan.
            needle = " ".join(terms[0].tokens) if terms else text
            row = cold().execute(
                "SELECT substr(content, max(1, instr(lower(content), lower(?))-200), 30000) "
                "FROM episodic_events WHERE id=?", (needle, rowid)).fetchone()
            if row:
                cleaned = clean_text(row[0], speaker) if ctype == "text" else row[0]
                low = fold_text(cleaned)
        if exact:
            if fold_text(text) not in low:
                continue
        elif not all(f" {n_} " in low for n_ in needles):
            continue
        score = 1.0 / (20 + pos)
        if speaker == "assistant" and _kind(meta).endswith(REASONING_KINDS):
            score *= 0.5
        hits.append(Hit(rowid, source, session_id, speaker, int(ts or 0), ctype, cleaned, score))
    return hits


def raw_hits(
    con: sqlite3.Connection,
    text: str,
    *,
    include_tools: bool,
    limit: int,
    deadline: Deadline | None,
    exact: bool = False,
    filters: Filters = Filters(),
    max_candidates: int = 5,
) -> tuple[list[Hit], dict]:
    table = ALL_FTS if include_tools else TEXT_FTS
    info: dict = {"input": text}
    if exact:
        toks = [fold(t) for t in TOKEN_RE.findall(text)]
        if not toks:
            info["error"] = "query needs letters or numbers"
            return [], info
        match = '"' + " ".join(toks) + '"'
        candidates = iter([(match, count_hits(con, table, match, deadline), [Term(toks, 0)])])
    else:
        candidates = plan_candidates(con, text, table, deadline)
    tried = 0
    for match, n, terms in candidates:
        tried += 1
        rows, order = _fts_rows(con, table, match, n, filters, limit, deadline)
        info.update(match=match, hits=n if n <= RANK_LIMIT else f">{RANK_LIMIT}", order=order)
        hits = _hits_from_rows(con, rows, terms, text, include_tools=include_tools, exact=exact)
        # A combination can match only inside stripped boilerplate or filtered
        # sessions; fall back to the next one instead of reporting nothing.
        if hits or tried >= max_candidates:
            if tried > 1:
                info["fallbacks"] = tried - 1
            return hits, info
    info.setdefault("hits", 0)
    return [], info


def fold_text(text: str) -> str:
    return " " + " ".join(fold(t) for t in TOKEN_RE.findall(text)) + " "


def snippet(text: str, needles: list[str], width: int = 320) -> str:
    flat = squash(text)
    low = flat.lower()
    pos = -1
    for n in needles:
        for tok in n.split():
            p = low.find(tok)
            if p >= 0 and (pos < 0 or p < pos):
                pos = p
        if pos >= 0:
            break
    if pos < 0 or len(flat) <= width:
        return flat[:width] + ("…" if len(flat) > width else "")
    start = max(0, pos - width // 3)
    end = min(len(flat), start + width)
    return ("…" if start else "") + flat[start:end] + ("…" if end < len(flat) else "")


@bounded(0.8)
def search(
    queries: list[str] | str,
    *,
    source: str | None = None,
    since: int | None = None,
    until: int | None = None,
    include_tools: bool = False,
    exclude_sessions: set[str] | frozenset = frozenset(),
    cwd: str | None = None,
    limit_sessions: int = 10,
    hits_per_session: int = 3,
    per_query: int = 200,
    exact: bool = False,
    include_children: bool = True,
    cwd_only: bool = False,
    deadline: Deadline | None = None,
) -> dict:
    """Sessions best-first. `cwd` boosts same-project sessions; `cwd_only` keeps only those."""
    t0 = time.monotonic()
    deadline = deadline or Deadline(0.8)
    con = mem()
    if isinstance(queries, str):
        queries = [queries]
    queries = [q for q in dict.fromkeys(q.strip() for q in queries) if q]
    infos = []
    by_session: dict[str, list[Hit]] = {}
    needles: list[str] = []
    filters = Filters(source=source, since=since, until=until, exclude=frozenset(exclude_sessions))
    for q in queries:
        try:
            hits, info = raw_hits(
                con, q, include_tools=include_tools, limit=per_query, deadline=deadline, exact=exact, filters=filters
            )
        except Timeout:
            infos.append({"input": q, "error": "timeout"})
            break
        infos.append(info)
        if info.get("match"):
            needles.extend(m.strip('"') for m in info["match"].split(" AND "))
        for h in hits:
            if h.session_id in exclude_sessions:
                continue
            by_session.setdefault(h.session_id, []).append(h)

    now = time.time()
    cat = catalog_rows(list(by_session))
    sessions = []
    for sid, hits in by_session.items():
        meta = cat.get(sid) or {}
        if not include_children and meta.get("parent_id"):
            continue
        if cwd_only and cwd and not (meta.get("cwd") and _same_project(cwd, meta["cwd"])):
            continue
        uniq, seen = [], set()
        for h in sorted(hits, key=lambda h: -h.score):
            key = hashlib.sha1(squash(h.text)[:400].encode()).hexdigest()
            if key in seen:
                continue
            seen.add(key)
            uniq.append(h)
        if exact:
            score = len(uniq) + max(h.ts for h in uniq) / 1e11
        else:
            top = uniq[:3]
            score = sum(h.score * (1.25 if h.speaker == "user" else 1.0) for h in top)
            age_days = max(0.0, (now - max(h.ts for h in uniq)) / 86400)
            score *= 1 + 0.25 * math.exp(-age_days / 45)
            if cwd and meta.get("cwd") and _same_project(cwd, meta["cwd"]):
                score *= 1.3
        sessions.append((score, sid, uniq, meta))
    sessions.sort(key=lambda s: -s[0])
    out = []
    for score, sid, uniq, meta in sessions[:limit_sessions]:
        first = uniq[0]
        out.append(
            {
                "session_id": sid,
                "source": first.source,
                "title": meta.get("title") or "",
                "cwd": meta.get("cwd") or "",
                "parent_id": meta.get("parent_id") or None,
                "first_ts": meta.get("first_ts") or min(h.ts for h in uniq),
                "last_ts": meta.get("last_ts") or max(h.ts for h in uniq),
                "matches": len(uniq),
                "score": round(score, 5),
                "hits": [
                    {
                        "event_id": h.event_id,
                        "ts": h.ts,
                        "speaker": h.speaker,
                        "content_type": h.content_type,
                        "snippet": snippet(h.text, needles or [q.lower() for q in queries]),
                        "text": h.text,
                    }
                    for h in uniq[:hits_per_session]
                ],
            }
        )
    return {
        "sessions": out,
        "queries": infos,
        "total_sessions": len(sessions),
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
    }


def _same_project(query_cwd: str, session_cwd: str) -> bool:
    """Session ran in the query's directory or below it (not in a parent like ~)."""
    a, b = query_cwd.rstrip("/"), session_cwd.rstrip("/")
    if not a or not b:
        return False
    return a == b or b.startswith(a + "/")


# ---------------------------------------------------------------------------
# catalog: one row per session (title, cwd, time range, first prompt)

CATALOG_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT,
  cwd TEXT,
  parent_id TEXT,
  first_ts INTEGER,
  last_ts INTEGER,
  n_events INTEGER,
  first_prompt TEXT,
  model TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_ts DESC);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""

TITLE_SKIP = ("The following is the Codex agent history", "You are a subagent spawned by another session")
CWD_TAG_RE = re.compile(r"<cwd>([^<\n]{1,400})</cwd>")
AGENTS_FOR_RE = re.compile(r"^# AGENTS\.md instructions for (\S[^\n]{0,400})")


def compute_session(con: sqlite3.Connection, session_id: str) -> dict | None:
    # Legacy stores may lack the session-only index. Never turn a missing index
    # into a scan of the entire transcript archive during an HTTP request.
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_episodic_session_timestamp'").fetchone():
        raise sqlite3.OperationalError("session index missing; run the offline recall migration")
    row = con.execute(
        "SELECT min(timestamp), max(timestamp), count(*) FROM episodic_events WHERE session_id=?",
        (session_id,),
    ).fetchone()
    if not row or not row[2]:
        return None
    first_ts, last_ts, n = row
    rows = con.execute(
        "SELECT source, speaker, content_type, substr(content,1,30000), metadata_json FROM episodic_events "
        "WHERE session_id=? ORDER BY timestamp, id LIMIT 300",
        (session_id,),
    ).fetchall()
    source = rows[0][0] if rows else "?"
    title = cwd = model = first_prompt = None
    for src, speaker, ctype, content, meta_json in rows:
        try:
            meta = json.loads(meta_json) if meta_json else {}
        except ValueError:
            meta = {}
        if not isinstance(meta, dict):
            meta = {}
        title = title or meta.get("title") or meta.get("session_name")
        cwd = cwd or meta.get("dir") or meta.get("cwd")
        model = model or meta.get("model")
        if speaker == "user" and ctype == "text" and content:
            if not cwd:
                m = CWD_TAG_RE.search(content[:4000]) or AGENTS_FOR_RE.search(content[:400])
                if m:
                    cwd = m.group(1).strip()
            if first_prompt is None:
                c = clean_text(content, "user")
                if c and not is_automation(c) and not c.startswith(TITLE_SKIP):
                    first_prompt = squash(c)[:600]
        if title and cwd and first_prompt and model:
            break
    parent_id = None
    if source == "opencode":
        oc = opencode_ro()
        if oc is not None:
            try:
                r = oc.execute(
                    "SELECT title, directory, parent_id FROM session_v2 WHERE id=?", (session_id,)
                ).fetchone()
            except sqlite3.Error:
                r = None
            if r:
                title = r[0] or title
                cwd = r[1] or cwd
                parent_id = r[2]
    elif source == "muse":
        # sync_muse.py keeps Robob thread titles and parents for Muse sessions.
        try:
            r = (cold() if HOT_DB else con).execute(
                "SELECT title, cwd, parent_id, model FROM muse_sessions WHERE session_id=?", (session_id,)
            ).fetchone()
        except sqlite3.Error:
            r = None
        if r:
            title = r[0] or title
            cwd = r[1] or cwd
            parent_id = r[2]
            model = r[3] or model
    if not title or re.match(r"^(New session|Untitled)\b", title or ""):
        title = (first_prompt or "")[:90] or title
    return {
        "session_id": session_id,
        "source": source,
        "title": title,
        "cwd": cwd,
        "parent_id": parent_id,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "n_events": n,
        "first_prompt": first_prompt,
        "model": model,
    }


def upsert_sessions(rows: list[dict]) -> None:
    con = catalog(write=True)
    now = int(time.time())
    con.executemany(
        "INSERT INTO sessions(session_id, source, title, cwd, parent_id, first_ts, last_ts, n_events, first_prompt, model, updated_at) "
        "VALUES(:session_id,:source,:title,:cwd,:parent_id,:first_ts,:last_ts,:n_events,:first_prompt,:model,:updated_at) "
        "ON CONFLICT(session_id) DO UPDATE SET source=excluded.source, title=excluded.title, cwd=excluded.cwd, "
        "parent_id=coalesce(excluded.parent_id, sessions.parent_id), first_ts=excluded.first_ts, last_ts=excluded.last_ts, "
        "n_events=excluded.n_events, first_prompt=excluded.first_prompt, model=excluded.model, updated_at=excluded.updated_at",
        [dict(r, updated_at=now) for r in rows],
    )
    con.commit()


def catalog_meta(key: str) -> str | None:
    try:
        r = catalog().execute("SELECT v FROM meta WHERE k=?", (key,)).fetchone()
    except sqlite3.Error:
        return None
    return r[0] if r else None


def set_catalog_meta(key: str, value) -> None:
    con = catalog(write=True)
    con.execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (key, str(value)))
    con.commit()


def _refresh_muse_meta(con) -> int:
    """Muse titles/parents can arrive after a log goes quiet (Robob maps threads late)."""
    since = int(catalog_meta("muse_meta_at") or 0)
    try:
        rows = (cold() if HOT_DB else con).execute(
            "SELECT session_id, updated_at FROM muse_sessions WHERE updated_at > ?", (since,)
        ).fetchall()
    except sqlite3.Error:
        return 0
    if not rows:
        return 0
    done = _compute_and_store(con, [r[0] for r in rows])
    set_catalog_meta("muse_meta_at", max(r[1] for r in rows))
    return done


def refresh_catalog(full: bool = False, progress=None, deadline: Deadline | None = None) -> dict:
    """Recompute sessions touched since the last watermark (or all of them)."""
    con = mem()
    t0 = time.monotonic()
    if HOT_DB:
        turn = int(catalog_meta("hot_reconcile_turn") or 0) + 1
        set_catalog_meta("hot_reconcile_turn", turn)
        if turn % 3 == 0:
            _refresh_hot_catalog(con, deadline)
    max_id = con.execute("SELECT max(id) FROM episodic_events").fetchone()[0] or 0
    wm = 0 if full else int(catalog_meta("watermark") or 0)
    if wm >= max_id:
        n = _refresh_muse_meta(con)
        return {"updated": n, "watermark": wm, "elapsed_ms": int((time.monotonic() - t0) * 1000)}
    if wm == 0:
        # Bootstrap also resumes. In particular, never scan the archive simply
        # because a disposable catalog is absent after a crash or migration.
        last = "" if full else catalog_meta("bootstrap_session") or ""
        bootstrap_hi = int(catalog_meta("bootstrap_hi") or max_id) if not full else max_id
        set_catalog_meta("bootstrap_hi", bootstrap_hi)
        done = 0
        while deadline is None or not deadline.expired():
            ids = [r[0] for r in run(con, "SELECT DISTINCT session_id FROM episodic_events "
                                   "INDEXED BY idx_episodic_session_timestamp WHERE session_id>? "
                                   "ORDER BY session_id LIMIT 50", (last,), deadline)]
            if not ids:
                break
            for sid in ids:
                if deadline is not None and deadline.expired():
                    return {"updated": done, "watermark": 0, "bootstrap_session": last}
                done += _compute_and_store(con, [sid], progress)
                last = sid
                set_catalog_meta("bootstrap_session", last)
        else:
            return {"updated": done, "watermark": 0, "bootstrap_session": last}
        set_catalog_meta("watermark", bootstrap_hi)
        set_catalog_meta("bootstrap_session", "")
        set_catalog_meta("bootstrap_hi", 0)
        set_catalog_meta("refreshed_at", int(time.time()))
        return {"updated": done, "watermark": bootstrap_hi, "elapsed_ms": int((time.monotonic() - t0) * 1000)}
    # Incremental: walk event-id windows and move the watermark after each, so a
    # deadline keeps the progress made so far.
    done = 0
    while wm < max_id:
        if deadline is not None and deadline.expired():
            break
        hi = min(max_id, wm + CATALOG_WINDOW)
        ids = [r[0] for r in con.execute("SELECT DISTINCT session_id FROM episodic_events WHERE id > ? AND id <= ?", (wm, hi))]
        done += _compute_and_store(con, ids, progress)
        wm = hi
        set_catalog_meta("watermark", wm)
    done += _refresh_muse_meta(con)
    set_catalog_meta("refreshed_at", int(time.time()))
    return {"updated": done, "watermark": wm, "elapsed_ms": int((time.monotonic() - t0) * 1000)}


CATALOG_WINDOW = 50_000


def _refresh_hot_catalog(con, deadline):
    # An UPDATE/deletion can leave max(id) unchanged. Reconcile the small catalog
    # on a rotating cursor as well as consuming new event ids.
    cursor = catalog_meta("hot_reconcile_session") or ""
    rows = run(con, "SELECT DISTINCT session_id FROM episodic_events INDEXED BY idx_episodic_session_timestamp "
               "WHERE session_id>? ORDER BY session_id LIMIT 20", (cursor,), deadline)
    for (sid,) in rows:
        if deadline and deadline.expired():
            return
        _compute_and_store(con, [sid])
        set_catalog_meta("hot_reconcile_session", sid)
    if not rows:
        set_catalog_meta("hot_reconcile_session", "")
    writer = catalog(write=True)
    # Catalog deletion probes are bounded by a second independent keyset cursor.
    cursor = catalog_meta("hot_prune_session") or ""
    rows = writer.execute("SELECT session_id FROM sessions WHERE session_id>? ORDER BY session_id LIMIT 50", (cursor,)).fetchall()
    for (sid,) in rows:
        if deadline and deadline.expired():
            return
        if not con.execute("SELECT 1 FROM episodic_events INDEXED BY idx_episodic_session_timestamp WHERE session_id=? LIMIT 1", (sid,)).fetchone():
            writer.execute("DELETE FROM sessions WHERE session_id=?", (sid,))
            writer.commit()
        set_catalog_meta("hot_prune_session", sid)
    if not rows:
        set_catalog_meta("hot_prune_session", "")


def _compute_and_store(con, ids: list[str], progress=None) -> int:
    batch, done = [], 0
    for sid in ids:
        s = compute_session(con, sid)
        if s:
            batch.append(s)
        done += 1
        if len(batch) >= 500:
            upsert_sessions(batch)
            batch = []
            if progress:
                progress(done, len(ids))
    if batch:
        upsert_sessions(batch)
    return done


def catalog_rows(session_ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not session_ids:
        return out
    try:
        con = catalog()
        cols = [d[1] for d in con.execute("PRAGMA table_info(sessions)")]
        for i in range(0, len(session_ids), 400):
            chunk = session_ids[i : i + 400]
            q = ",".join("?" * len(chunk))
            for row in con.execute(f"SELECT * FROM sessions WHERE session_id IN ({q})", chunk):
                out[row[0]] = dict(zip(cols, row))
    except sqlite3.Error:
        pass
    # Catalog catchup belongs to the background writer, never a tool request.
    return out


@bounded(0.8)
def list_sessions(
    *,
    text: str | None = None,
    source: str | None = None,
    cwd: str | None = None,
    since: int | None = None,
    until: int | None = None,
    include_children: bool = False,
    limit: int = 20,
    exclude_sessions: set[str] | frozenset = frozenset(),
) -> list[dict]:
    con = catalog()
    where, params = [], []
    if source:
        where.append("source=?")
        params.append(source)
    if cwd:
        where.append("(cwd = ? OR cwd LIKE ?)")
        params += [cwd.rstrip("/"), cwd.rstrip("/") + "/%"]
    if since:
        where.append("last_ts >= ?")
        params.append(since)
    if until:
        where.append("first_ts <= ?")
        params.append(until)
    if not include_children:
        where.append("parent_id IS NULL")
    if exclude_sessions:
        where.append("session_id NOT IN (SELECT value FROM json_each(?))")
        params.append(json.dumps(sorted(exclude_sessions)))
    if text:
        for w in text.split():
            where.append("(title LIKE ? OR first_prompt LIKE ? OR cwd LIKE ? OR session_id LIKE ?)")
            params += [f"%{w}%"] * 4
    sql = "SELECT * FROM sessions" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY last_ts DESC LIMIT ?"
    params.append(limit)
    cols = [d[1] for d in con.execute("PRAGMA table_info(sessions)")]
    return [dict(zip(cols, r)) for r in con.execute(sql, params)]


# ---------------------------------------------------------------------------
# reading a session


RESUME_SUFFIX_RE = re.compile(r"\s*\((?:resume|cont|continued|continuation)\b[^)]*\)\s*$", re.I)
_lineage_cache: dict[str, tuple[float, frozenset]] = {}


class UnknownCaller(Exception):
    """A supplied caller could not be excluded safely."""


def _members(values: set[str]) -> str:
    return json.dumps(sorted(values))


def _alias_table_tree(ids: set[str]) -> set[str]:
    """Read D1's materialized aliases when available; never cache a changing map."""
    con = cold()
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_aliases'").fetchone():
        return set()
    natives = {value.split(":agent:", 1)[0] for value in ids}
    rows = con.execute(
        "SELECT root_thread_id FROM thread_aliases WHERE canonical_thread_id IN (SELECT value FROM json_each(?)) "
        "UNION SELECT root_thread_id FROM thread_aliases WHERE native_id IN (SELECT value FROM json_each(?)) "
        "UNION SELECT root_thread_id FROM thread_aliases WHERE root_thread_id IN (SELECT value FROM json_each(?))",
        (_members(ids), _members(natives), _members(ids)),
    ).fetchall()
    roots = {row[0] for row in rows if row[0]}
    if not roots:
        return set()
    out = set(roots)
    for canonical, native, agent in con.execute(
        "SELECT canonical_thread_id,native_id,agent_id FROM thread_aliases "
        "WHERE root_thread_id IN (SELECT value FROM json_each(?))", (_members(roots),)
    ):
        out.update(x for x in (canonical, native, agent) if x)
        if native and agent:
            out.add(f"{native}:agent:{agent}")
    return out


class _BudgetLock:
    def __init__(self, lock):
        self.lock = lock

    def acquire(self, blocking=True):
        if not blocking:
            return self.lock.acquire(blocking=False)
        deadline = getattr(_local, "deadline", None)
        if deadline is None:
            return self.lock.acquire()
        if not self.lock.acquire(timeout=max(0, min(0.1, deadline.left()))):
            raise Timeout("caller identity cache busy; retry")
        return True

    def release(self):
        self.lock.release()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *args):
        self.release()


_state_reads = _BudgetLock(threading.BoundedSemaphore(2))
_state_refresh_lock = _BudgetLock(threading.Lock())
_state_snapshot = None
_state_snapshot_generation = None
_STATE_CHUNK = 2000
_STATE_REFRESH_SECONDS = 60


def _state_generation():
    try:
        info = robob_readonly.safe_path(STATE_DB).stat()
        with closing(robob_readonly.state_ro(STATE_DB, timeout=0.1)) as con:
            updated = robob_readonly.ready_generation(con)
    except OSError as exc:
        raise sqlite3.OperationalError("Robob read-only replica unavailable") from exc
    return info.st_dev, info.st_ino, updated


@dataclass(frozen=True)
class _StateSnapshot:
    path: Path
    sequence: int
    built_sequence: int
    checked_at: float
    lineage: dict[str, tuple[str | None, str | None]]
    neighbors: dict[str, frozenset[str]]
    children: dict[str, frozenset[str]]
    natives_by_thread: dict[str, frozenset[str]]
    threads_by_native: dict[str, frozenset[str]]
    provider_owners: dict[str, str | None] = field(default_factory=dict)
    provider_natives: dict[str, str | None] = field(default_factory=dict)


def _state_index(path: Path, sequence: int, lineage: dict, natives: dict, *, built_sequence: int | None = None,
                 provider_owners: dict[str, str | None] | None = None,
                 provider_natives: dict[str, str | None] | None = None) -> _StateSnapshot:
    neighbors: dict[str, set[str]] = {}
    children: dict[str, set[str]] = {}
    by_native: dict[str, set[str]] = {}
    for child, (parent, root) in lineage.items():
        for other in (parent, root):
            if other and other != child:
                neighbors.setdefault(other, set()).add(child)
                neighbors.setdefault(child, set()).add(other)
        if parent and parent != child:
            children.setdefault(parent, set()).add(child)
    for thread, ids in natives.items():
        for native in ids:
            by_native.setdefault(native, set()).add(thread)
    return _StateSnapshot(
        path, sequence, sequence if built_sequence is None else built_sequence, time.monotonic(), lineage,
        {k: frozenset(v) for k, v in neighbors.items()},
        {k: frozenset(v) for k, v in children.items()},
        {k: frozenset(v) for k, v in natives.items()},
        {k: frozenset(v) for k, v in by_native.items()},
        provider_owners or {},
        provider_natives or {},
    )


def _state_sequence(con: sqlite3.Connection) -> int:
    return con.execute("SELECT max(sequence) FROM orchestration_events").fetchone()[0] or 0


def _state_changed(con: sqlite3.Connection, start: int, end: int, relevant: set[str], snapshot: _StateSnapshot) -> bool:
    """Check the indexed event window for changes that can affect these aliases."""
    while start < end:
        rows = con.execute(
            # Skip copying large payloads (turn items) that are never parsed.
            "SELECT sequence,event_type,stream_id,"
            "CASE WHEN event_type LIKE 'thread.%' OR event_type IN ('provider-thread.updated','subagent.updated') "
            "THEN payload_json END FROM orchestration_events "
            "WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
            (start, end, _STATE_CHUNK),
        ).fetchall()
        if not rows:
            break
        start = rows[-1][0]
        for event_sequence, kind, stream, raw in rows:
            if kind == "thread.pull-request-link-updated":
                continue
            if not (kind.startswith("thread.") or kind in ("provider-thread.updated", "subagent.updated")):
                continue
            try:
                payload = json.loads(raw) if raw else {}
                if not isinstance(payload, dict):
                    return True
            except (ValueError, TypeError):
                return True
            if kind.startswith("thread."):
                lineage = payload.get("lineage") or {}
                if not isinstance(lineage, dict):
                    return True
                thread = payload.get("id") or stream
                previous = snapshot.lineage.get(thread)
                endpoints = {thread, lineage.get("parentThreadId"), lineage.get("rootThreadId")}
                if previous:
                    endpoints.update(previous)
                if not endpoints & relevant:
                    continue
                if kind == "thread.created":
                    return True
                if kind == "thread.deleted" and not con.execute(
                    "SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id=?", (thread,)
                ).fetchone():
                    return True
                # Most thread events are titles, visits or status. The cache
                # retains old lineage long enough to detect a real edge change.
                if previous is None or previous != (lineage.get("parentThreadId"), lineage.get("rootThreadId")):
                    return True
            elif kind == "provider-thread.updated":
                owner = payload.get("appThreadId")
                if "appThreadId" not in payload:
                    owner = stream
                native_ref = payload.get("nativeThreadRef") or {}
                if not isinstance(native_ref, dict):
                    return True
                native = native_ref.get("nativeId")
                provider_id = payload.get("id")
                previous_owner = snapshot.provider_owners.get(provider_id) if provider_id else None
                previous_native = snapshot.provider_natives.get(provider_id) if provider_id else None
                if not ({owner, native, previous_owner, previous_native} & relevant):
                    continue
                if (not provider_id or provider_id not in snapshot.provider_owners
                        or previous_owner != owner or previous_native != native):
                    return True
            else:
                # Subagent changes are indexed and few. Conservatively retry
                # only when an endpoint or task alias intersects the closure.
                native_ref = payload.get("nativeTaskRef") or {}
                if not isinstance(native_ref, dict):
                    return True
                current = {payload.get("threadId") or stream, payload.get("childThreadId"), native_ref.get("nativeId")}
                task_id = payload.get("id")
                old = getattr(_local, "state_subagents", {}).get(task_id, ()) if task_id else ()
                identity = (payload.get("threadId") or stream, payload.get("childThreadId"), native_ref.get("nativeId"))
                if current & relevant and old and all(previous == identity for previous in old):
                    # Same endpoints and task alias as every read of this task:
                    # the lineage is unchanged whether the read came before or
                    # after the event, so a status-only update never retries.
                    # (Retrying here failed busy callers closed, 4 Nov.)
                    pass
                elif current & relevant:
                    return True
                if task_id:
                    # The old edge may have moved away after it was read.
                    for parent, child, task in old:
                        if (parent, child, task) != identity and {parent, child, task} & relevant:
                            return True
    return False


def _build_state_snapshot(con: sqlite3.Connection, path: Path, sequence: int) -> _StateSnapshot:
    # Each page ends its own implicit read transaction before the next begins.
    lineage = {}
    natives: dict[str, set[str]] = {}
    provider_owners: dict[str, str | None] = {}
    provider_natives: dict[str, str | None] = {}
    for table, columns in (
        ("orchestration_v2_projection_threads",
         "thread_id,json_extract(payload_json,'$.lineage.parentThreadId'),"
         "json_extract(payload_json,'$.lineage.rootThreadId')"),
        ("orchestration_v2_projection_provider_threads",
         "thread_id,json_extract(payload_json,'$.nativeThreadRef.nativeId'),provider_thread_id"),
    ):
        rowid = 0
        while True:
            rows = con.execute(
                f"SELECT rowid,{columns} FROM {table} WHERE rowid>? ORDER BY rowid LIMIT ?",
                (rowid, _STATE_CHUNK),
            ).fetchall()
            if not rows:
                break
            rowid = rows[-1][0]
            if table == "orchestration_v2_projection_threads":
                for _, thread, parent, root in rows:
                    lineage[thread] = (parent, root)
            else:
                for _, thread, native, provider_id in rows:
                    if provider_id:
                        provider_owners[provider_id] = thread
                        provider_natives[provider_id] = native
                    if thread and native:
                        natives.setdefault(thread, set()).add(native)
    return _state_index(path, sequence, lineage, natives, provider_owners=provider_owners,
                        provider_natives=provider_natives)


def _state_with_changes(con: sqlite3.Connection, snapshot: _StateSnapshot, sequence: int) -> _StateSnapshot:
    """Overlay projections changed since the base, including changes during a paged build."""
    if sequence <= snapshot.sequence:
        return snapshot
    changed = set()
    changed_providers = set()
    cursor = snapshot.sequence
    while cursor < sequence:
        rows = con.execute(
            "SELECT sequence,event_type,stream_id,"
            "CASE WHEN event_type='provider-thread.updated' THEN json_extract(payload_json,'$.id') END,"
            "CASE WHEN event_type='provider-thread.updated' THEN json_extract(payload_json,'$.appThreadId') END "
            "FROM orchestration_events "
            "WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?",
            (cursor, sequence, _STATE_CHUNK),
        ).fetchall()
        if not rows:
            break
        cursor = rows[-1][0]
        for _, kind, stream, provider_id, owner in rows:
            if stream and (kind.startswith("thread.") or kind == "provider-thread.updated"):
                changed.add(stream)
            if kind == "provider-thread.updated":
                if owner:
                    changed.add(owner)
                if provider_id:
                    changed_providers.add(provider_id)
                    previous = snapshot.provider_owners.get(provider_id)
                    if previous:
                        changed.add(previous)
    owners = dict(snapshot.provider_owners)
    provider_natives = dict(snapshot.provider_natives)
    provider_ids = list(changed_providers)
    for i in range(0, len(provider_ids), _STATE_CHUNK):
        ids = provider_ids[i:i + _STATE_CHUNK]
        for provider_id in ids:
            owners.pop(provider_id, None)
            provider_natives.pop(provider_id, None)
        for provider_id, owner, native in con.execute(
            "SELECT provider_thread_id,thread_id,json_extract(payload_json,'$.nativeThreadRef.nativeId') "
            "FROM orchestration_v2_projection_provider_threads "
            "WHERE provider_thread_id IN (SELECT value FROM json_each(?))", (_members(set(ids)),)
        ).fetchall():
            owners[provider_id] = owner
            provider_natives[provider_id] = native
            if owner:
                changed.add(owner)
    if not changed:
        return _StateSnapshot(snapshot.path, sequence, snapshot.built_sequence, snapshot.checked_at, snapshot.lineage,
                              snapshot.neighbors, snapshot.children, snapshot.natives_by_thread,
                              snapshot.threads_by_native, owners, provider_natives)
    updates_lineage = {}
    updates_natives: dict[str, set[str]] = {}
    changed_list = list(changed)
    for i in range(0, len(changed_list), _STATE_CHUNK):
        chunk = changed_list[i:i + _STATE_CHUNK]
        for thread, parent, root in con.execute(
            "SELECT thread_id,json_extract(payload_json,'$.lineage.parentThreadId'),"
            "json_extract(payload_json,'$.lineage.rootThreadId') FROM orchestration_v2_projection_threads "
            "WHERE thread_id IN (SELECT value FROM json_each(?))", (_members(set(chunk)),)
        ).fetchall():
            updates_lineage[thread] = (parent, root)
        for thread, native in con.execute(
            "SELECT thread_id,json_extract(payload_json,'$.nativeThreadRef.nativeId') "
            "FROM orchestration_v2_projection_provider_threads "
            "WHERE thread_id IN (SELECT value FROM json_each(?))", (_members(set(chunk)),)
        ).fetchall():
            if native:
                updates_natives.setdefault(thread, set()).add(native)
    if all(snapshot.lineage.get(thread) == updates_lineage.get(thread)
           and snapshot.natives_by_thread.get(thread, frozenset()) == updates_natives.get(thread, set())
           for thread in changed):
        return _StateSnapshot(snapshot.path, sequence, snapshot.built_sequence, snapshot.checked_at, snapshot.lineage,
                              snapshot.neighbors, snapshot.children, snapshot.natives_by_thread,
                              snapshot.threads_by_native, owners, provider_natives)
    lineage = dict(snapshot.lineage)
    natives = dict(snapshot.natives_by_thread)
    for thread in changed:
        lineage.pop(thread, None)
        natives.pop(thread, None)
    lineage.update(updates_lineage)
    natives.update(updates_natives)
    result = _state_index(snapshot.path, sequence, lineage, natives, built_sequence=snapshot.built_sequence,
                          provider_owners=owners, provider_natives=provider_natives)
    return _StateSnapshot(result.path, result.sequence, result.built_sequence, snapshot.checked_at, result.lineage,
                          result.neighbors, result.children, result.natives_by_thread, result.threads_by_native,
                          result.provider_owners, result.provider_natives)


def _state_cache(*, caller: str | None = None, after_sequence: int | None = None) -> _StateSnapshot:
    global _state_snapshot, _state_snapshot_generation
    path = STATE_DB
    generation = _state_generation()
    snapshot = _state_snapshot
    if snapshot is None or snapshot.path != path or _state_snapshot_generation != generation:
        with _state_refresh_lock:
            snapshot = _state_snapshot
            if snapshot is None or snapshot.path != path or _state_snapshot_generation != generation:
                with _state_reads, closing(connect_ro(path)) as con:
                    snapshot = _build_state_snapshot(con, path, _state_sequence(con))
                    snapshot = _state_with_changes(con, snapshot, _state_sequence(con))
                    if _state_generation() != generation:
                        raise UnknownCaller("read-only replica replaced while being read")
                    _state_snapshot = snapshot
                    _state_snapshot_generation = generation
    # A missing caller can have appeared since the last build. Serialize its
    # forced incremental refresh without occupying a database-reader slot.
    native = caller.split(":agent:", 1)[0] if caller else None
    missing = caller and caller not in snapshot.lineage and native not in snapshot.threads_by_native
    due = time.monotonic() - snapshot.checked_at >= _STATE_REFRESH_SECONDS
    if missing or due or (after_sequence is not None and after_sequence > snapshot.sequence):
        acquired = _state_refresh_lock.acquire(blocking=bool(missing))
        if acquired:
            try:
                current = _state_snapshot
                if current is not None and current.path == path and _state_snapshot_generation == generation:
                    snapshot = current
                with _state_reads, closing(connect_ro(path)) as con:
                    sequence = _state_sequence(con)
                    due = time.monotonic() - snapshot.checked_at >= _STATE_REFRESH_SECONDS
                    if due and sequence != snapshot.built_sequence:
                        snapshot = _build_state_snapshot(con, path, sequence)
                    elif due:
                        snapshot = _StateSnapshot(snapshot.path, snapshot.sequence, snapshot.built_sequence, time.monotonic(), snapshot.lineage,
                                                  snapshot.neighbors, snapshot.children, snapshot.natives_by_thread,
                                                  snapshot.threads_by_native, snapshot.provider_owners,
                                                  snapshot.provider_natives)
                    snapshot = _state_with_changes(con, snapshot, _state_sequence(con))
                    _state_snapshot = snapshot
            finally:
                _state_refresh_lock.release()
    # Event rows are indexed by sequence and read in pages. An overlay closes
    # the window where an existing caller acquires a new child within 60 s.
    # It is local when a rebuild is in flight, so known callers do not wait.
    with _state_reads, closing(connect_ro(path)) as con:
        snapshot = _state_with_changes(con, snapshot, _state_sequence(con))
    if _state_refresh_lock.acquire(blocking=False):
        try:
            current = _state_snapshot
            if (current is not None and current.path == path and _state_snapshot_generation == generation
                    and snapshot.sequence > current.sequence
                    and snapshot.built_sequence == current.built_sequence
                    and snapshot.checked_at == current.checked_at):
                _state_snapshot = snapshot
        finally:
            _state_refresh_lock.release()
    if _state_generation() != generation:
        raise UnknownCaller("read-only replica replaced while being read")
    return snapshot


def _state_tree(ids: set[str], *, caller: str | None = None) -> set[str]:
    previous = getattr(_local, "state_subagents", None)
    if previous is None:
        _local.state_subagents = {}
        _local.state_subagent_read_sequence = {}
    try:
        return _state_tree_checked(ids, caller=caller)
    finally:
        if previous is None:
            del _local.state_subagents
            del _local.state_subagent_read_sequence


def _state_tree_checked(ids: set[str], *, caller: str | None = None) -> set[str]:
    """Interim D1 reader. State is read-only; it is not a second identity writer."""
    after_sequence = None
    for _ in range(3):
        generation = _state_generation()
        old_observations = getattr(_local, "state_subagents", None)
        old_read_sequences = getattr(_local, "state_subagent_read_sequence", None)
        if old_observations is not None:
            _local.state_subagents = {}
            _local.state_subagent_read_sequence = {}
        snapshot = _state_cache(caller=caller, after_sequence=after_sequence)
        try:
            result = _state_tree_once(ids, snapshot)
            error = None
        except UnknownCaller as exc:
            result = set()
            error = exc
        # The paged cache and indexed queries are separate snapshots. Do not
        # expose a partial tree if a relevant commit landed between them.
        with _state_reads, closing(connect_ro(STATE_DB)) as con:
            end = _state_sequence(con)
            changed = _state_changed(con, snapshot.sequence, end, set(result) | ids, snapshot)
        changed = changed or _state_generation() != generation
        if not changed:
            if old_observations is not None:
                for task_id, identities in _local.state_subagents.items():
                    old_observations.setdefault(task_id, set()).update(identities)
                for task_id, sequences in _local.state_subagent_read_sequence.items():
                    old_read_sequences.setdefault(task_id, set()).update(sequences)
                _local.state_subagents = old_observations
                _local.state_subagent_read_sequence = old_read_sequences
            if error:
                raise error
            return result
        if old_observations is not None:
            _local.state_subagents = old_observations
            _local.state_subagent_read_sequence = old_read_sequences
        after_sequence = end
    raise UnknownCaller("caller lineage changed while being read")


def _state_tree_once(ids: set[str], snapshot: _StateSnapshot) -> set[str]:
    with _state_reads, closing(connect_ro(STATE_DB)) as con:
        thread_table = "orchestration_v2_projection_threads"
        provider_table = "orchestration_v2_projection_provider_threads"
        subagent_table = "orchestration_v2_projection_subagents"
        natives = {ident.split(":agent:", 1)[0] for ident in ids}
        seeds = {r[0] for r in con.execute(
            f"SELECT thread_id FROM {thread_table} WHERE thread_id IN (SELECT value FROM json_each(?))", (_members(ids),)
        ).fetchall()}
        seeds.update(thread for native in natives for thread in snapshot.threads_by_native.get(native, ()))
        seeds.update(r[0] for r in con.execute(
            "SELECT thread_id FROM ardud_opencode_import WHERE native_session_id IN (SELECT value FROM json_each(?))", (_members(natives),)
        ).fetchall())
        seeds.update(r[0] for r in con.execute(
            f"SELECT child_thread_id FROM {subagent_table} "
            "WHERE child_thread_id IN (SELECT value FROM json_each(?))", (_members(ids),)
        ).fetchall() if r[0])
        seeds.update(r[0] for r in con.execute(
            f"SELECT thread_id FROM {subagent_table} "
            "WHERE thread_id IN (SELECT value FROM json_each(?))", (_members(ids),)
        ).fetchall() if r[0])
        if not seeds:
            return set()
        # Root hints and explicit edges all establish possible membership, even
        # when projections disagree. Only direct parent edges prove ownership.
        neighbors: dict[str, set[str]] = {}
        ownership_children: dict[str, set[str]] = {}

        def link(parent: str, child: str, *, owns: bool) -> None:
            if not parent or not child or parent == child:
                return
            neighbors.setdefault(parent, set()).add(child)
            neighbors.setdefault(child, set()).add(parent)
            if owns:
                ownership_children.setdefault(parent, set()).add(child)

        threads = set(seeds)
        frontier = set(seeds)
        subagents = set()
        while frontier:
            _check_budget()
            read_sequence = _state_sequence(con)
            rows = con.execute(
                f"SELECT thread_id,child_thread_id,json_extract(payload_json,'$.nativeTaskRef.nativeId'),subagent_id "
                f"FROM {subagent_table} WHERE thread_id IN (SELECT value FROM json_each(?)) "
                "OR child_thread_id IN (SELECT value FROM json_each(?))", (_members(frontier), _members(frontier))
            ).fetchall()
            subagents.update((parent, child, agent) for parent, child, agent, _ in rows)
            seen = getattr(_local, "state_subagents", None)
            if seen is not None:
                for parent, child, agent, task_id in rows:
                    if task_id:
                        seen.setdefault(task_id, set()).add((parent, child, agent))
                        _local.state_subagent_read_sequence.setdefault(task_id, set()).add(read_sequence)
            for parent, child, _agent, _ in rows:
                if child:
                    link(parent, child, owns=True)
            found = set().union(*(snapshot.neighbors.get(thread, frozenset()) | neighbors.get(thread, set()) for thread in frontier))
            frontier = found - threads
            threads.update(frontier)
        out = set(threads)
        natives_by_thread: dict[str, set[str]] = {}
        for thread, native_id in con.execute(
            f"SELECT thread_id,json_extract(payload_json,'$.nativeThreadRef.nativeId') FROM {provider_table} "
            "WHERE thread_id IN (SELECT value FROM json_each(?))", (_members(threads),)
        ).fetchall():
            if native_id:
                out.add(native_id)
                natives_by_thread.setdefault(thread, set()).add(native_id)
        for thread, native_id in con.execute(
            "SELECT thread_id,native_session_id FROM ardud_opencode_import "
            "WHERE thread_id IN (SELECT value FROM json_each(?))", (_members(threads),)
        ).fetchall():
            if native_id:
                out.add(native_id)
                natives_by_thread.setdefault(thread, set()).add(native_id)
        # Native subagents may have no provider row. Carry every possible
        # ancestor incarnation through the ownership graph; a nearer provider
        # does not prove that older/root incarnations did not capture the task.
        owners = {thread: set(natives) for thread, natives in natives_by_thread.items()}
        pending = deque((thread, native) for thread, natives in owners.items() for native in natives)
        while pending:
            parent, native = pending.popleft()
            for child in snapshot.children.get(parent, frozenset()) | ownership_children.get(parent, set()):
                if child in threads and native not in owners.get(child, ()):
                    owners.setdefault(child, set()).add(native)
                    pending.append((child, native))
        # A second possible ownership path can have no provider even when
        # another path has one. Propagate that uncertainty rather than using
        # a root hint to guess the missing incarnation.
        dangling = threads - owners.keys()
        pending_dangling = deque(dangling)
        while pending_dangling:
            parent = pending_dangling.popleft()
            for child in snapshot.children.get(parent, frozenset()) | ownership_children.get(parent, set()):
                if child in threads and child not in dangling:
                    dangling.add(child)
                    pending_dangling.append(child)
        if dangling:
            raise UnknownCaller("subagent provider ownership could not be resolved")
        for parent, _child, agent in subagents:
            if agent:
                out.add(agent)
                out.update(f"{n}:agent:{agent}" for n in owners[parent])
        return out


def _opencode_edges(con: sqlite3.Connection) -> dict[str, set[str]]:
    edges: dict[str, set[str]] = {}
    for sid, parent, old in con.execute(
        "SELECT id,parent_id,json_extract(metadata,'$.migration.sourceSessionID') FROM session_v2"
    ):
        for other in (parent, old):
            if other:
                edges.setdefault(sid, set()).add(other)
                edges.setdefault(other, set()).add(sid)
    return edges


def _opencode_tree(ids: set[str], edges: dict[str, set[str]] | None = None) -> set[str]:
    """Add OpenCode ancestors, descendants and explicit migration aliases."""
    con = opencode_ro()
    if con is None:
        if any(s.startswith("ses_") for s in ids):
            raise UnknownCaller("OpenCode lineage store unavailable")
        return set()
    out = set(ids)
    if edges is None:
        edges = _opencode_edges(con)
    frontier = set(ids)
    while frontier:
        _check_budget()
        found = set().union(*(edges.get(sid, set()) for sid in frontier))
        frontier = found - out
        out.update(frontier)
    return out - ids


def _catalog_tree(ids: set[str]) -> set[str]:
    """Explicit catalog parent edges are evidence; titles are not."""
    con = catalog()
    out = set(ids)
    frontier = set(ids)
    while frontier:
        _check_budget()
        found = {r[0] for r in con.execute(
            "SELECT parent_id FROM sessions WHERE session_id IN (SELECT value FROM json_each(?))", (_members(frontier),)
        ) if r[0]}
        found.update(r[0] for r in con.execute(
            "SELECT session_id FROM sessions WHERE parent_id IN (SELECT value FROM json_each(?))", (_members(frontier),)
        ))
        frontier = found - out
        out.update(frontier)
    return out - ids


def validate_driver(ident: str, driver: str) -> None:
    """Qualifiers must agree with a persisted provider binding."""
    generation = _state_generation()
    snapshot = _state_cache(caller=ident)
    with _state_reads, closing(connect_ro(STATE_DB)) as con:
        native = ident.split(":agent:", 1)[0]
        threads = set(snapshot.threads_by_native.get(native, ())) | {ident}
        row = con.execute(
            "SELECT 1 FROM orchestration_v2_projection_provider_threads "
            "WHERE thread_id IN (SELECT value FROM json_each(?)) "
            "AND (thread_id=? OR json_extract(payload_json,'$.nativeThreadRef.nativeId')=?) "
            "AND COALESCE(driver,json_extract(payload_json,'$.driver'))=? LIMIT 1", (_members(threads), ident, native, driver)
        ).fetchone()
        if not row and driver == "opencode":
            row = con.execute("SELECT 1 FROM ardud_opencode_import WHERE thread_id=? OR native_session_id=?", (ident, native)).fetchone()
        if not row:
            raise UnknownCaller("caller driver does not match")
    if _state_generation() != generation:
        raise UnknownCaller("read-only replica replaced while being read")


@bounded(0.8)
def lineage_exclusions(canonical_or_native_id: str | None, *, fresh_legacy: bool = False) -> frozenset:
    """All known aliases in the caller's complete root tree, or fail closed."""
    if not canonical_or_native_id or not canonical_or_native_id.strip():
        raise UnknownCaller("caller identity is missing")
    previous_subagents = getattr(_local, "state_subagents", None)
    previous_read_sequence = getattr(_local, "state_subagent_read_sequence", None)
    _local.state_subagents = {}
    _local.state_subagent_read_sequence = {}
    try:
        for _ in range(3):
            generation = _state_generation()
            _local.state_subagents = {}
            _local.state_subagent_read_sequence = {}
            snapshot = _state_cache(caller=canonical_or_native_id.strip())
            start = snapshot.sequence
            try:
                result = _lineage_exclusions_once(canonical_or_native_id, fresh_legacy=fresh_legacy)
                error = None
            except UnknownCaller as exc:
                result = frozenset()
                error = exc
            with _state_reads, closing(connect_ro(STATE_DB)) as con:
                end = _state_sequence(con)
                changed = _state_changed(con, start, end, set(result) | {canonical_or_native_id.strip()}, snapshot)
            changed = changed or _state_generation() != generation
            if not changed:
                if error:
                    raise error
                return result
        raise UnknownCaller("caller lineage changed while being read")
    except sqlite3.Error as e:
        raise UnknownCaller("caller lineage could not be read") from e
    finally:
        if previous_subagents is None:
            del _local.state_subagents
            del _local.state_subagent_read_sequence
        else:
            _local.state_subagents = previous_subagents
            _local.state_subagent_read_sequence = previous_read_sequence


def _lineage_exclusions_once(canonical_or_native_id: str | None, *, fresh_legacy: bool = False) -> frozenset:
    """All known aliases in the caller's complete root tree, or fail closed."""
    # Robob commits identity rows before creating a transcript; capture reads
    # that transcript later. Recheck after retrieval before exposing candidates.
    # Legacy results are only an additional exclusion, never proof of identity.
    if not canonical_or_native_id:
        raise UnknownCaller("caller identity is missing")
    ident = canonical_or_native_id.strip()
    if not ident:
        raise UnknownCaller("caller identity is missing")
    try:
        memo: dict[frozenset[str], set[str]] = {}
        expanded: set[str] = set()
        def state_tree(ids: set[str]) -> set[str]:
            key = frozenset(ids)
            if key not in memo:
                memo[key] = _state_tree(ids, caller=ident if not expanded else None)
                expanded.update(ids)
            return memo[key]

        oc = opencode_ro()
        edges = _opencode_edges(oc) if oc is not None else None
        aliases = _alias_table_tree({ident})
        try:
            initial = state_tree({ident})
            aliases.update(initial)
            # An alias row can predate its state's descendants. Expand from
            # every historical binding, but require a current state anchor.
            remaining = aliases - expanded
            additional = state_tree(remaining) if remaining else set()
            state_anchor = bool(initial or additional)
            aliases.update(additional)
            state_available = True
        except sqlite3.Error:
            raise UnknownCaller("caller identity store unavailable") from None
        if not aliases:
            # A known OpenCode id can bridge into the authoritative map through
            # migration links. Only use title matching if no mapped id exists.
            if not state_available or oc is None or not oc.execute(
                "SELECT 1 FROM session_v2 WHERE id=?", (ident,)
            ).fetchone():
                raise UnknownCaller("caller identity is unknown")
            explicit = {ident} | _opencode_tree({ident}, edges) | _catalog_tree({ident})
            explicit_state = state_tree(explicit - expanded) if explicit - expanded else set()
            aliases.update(_alias_table_tree(explicit) | explicit_state)
            aliases.update(explicit if aliases else _legacy_lineage(ident, fresh=fresh_legacy))
            pending_state = aliases - expanded
            anchor_state = state_tree(pending_state) if pending_state else set()
            state_anchor = bool(explicit_state or anchor_state)
            aliases.update(anchor_state)
        if not state_anchor and not (ident.startswith("ses_") and oc is not None and oc.execute(
                "SELECT 1 FROM session_v2 WHERE id=?", (ident,)).fetchone()):
            raise UnknownCaller("caller has no current identity anchor")
        aliases.add(ident)
        # A migration edge can reveal a later Robob binding, and that binding
        # can reveal more OpenCode aliases. Close both maps until stable.
        frontier = set(aliases)
        legacy_checked: set[str] = set()
        while frontier:
            _check_budget()
            found = _opencode_tree(frontier, edges) | _alias_table_tree(frontier) | _catalog_tree(frontier)
            if state_available:
                pending_state = frontier - expanded
                if pending_state:
                    found.update(state_tree(pending_state))
            for sid in frontier:
                if sid.startswith("ses_") and sid not in legacy_checked:
                    legacy_checked.add(sid)
                    found.update(_legacy_lineage(sid, fresh=fresh_legacy))
            frontier = found - aliases
            aliases.update(frontier)
        return frozenset(aliases)
    except sqlite3.Error as e:
        raise UnknownCaller("caller lineage could not be read") from e


def base_title(title: str) -> str:
    t = (title or "").strip()
    while True:
        s = RESUME_SUFFIX_RE.sub("", t)
        if s == t:
            return t
        t = s


def _legacy_lineage(session_id: str | None, days: int = 14, *, fresh: bool = False) -> frozenset:
    """The session, its subagents, and recent earlier incarnations of the same thread.

    A resumed thread starts a new session with the same title and directory; its
    predecessors (and their subagents) hold the same work, so recalling them back
    into it is an echo, not memory.
    """
    if not session_id:
        return frozenset()
    hit = _lineage_cache.get(session_id)
    if not fresh and hit and time.monotonic() - hit[0] < 300:
        return hit[1]
    roots = {session_id}
    oc = opencode_ro()
    title = cwd = None
    if oc is not None:
        try:
            r = oc.execute("SELECT title, directory FROM session_v2 WHERE id=?", (session_id,)).fetchone()
        except sqlite3.Error:
            r = None
        if r:
            title, cwd = r
    if not title:
        meta = catalog_rows([session_id]).get(session_id) or {}
        title, cwd = meta.get("title"), meta.get("cwd")
    base = base_title(title or "")
    if base and cwd and len(base) >= 8:
        try:
            rows = catalog().execute(
                "SELECT session_id, title FROM sessions WHERE cwd=? AND parent_id IS NULL AND last_ts>=? AND title LIKE ?",
                (cwd, int(time.time()) - days * 86400, base.replace("%", "").replace("_", "") + "%"),
            ).fetchall()
        except sqlite3.Error:
            rows = []
        roots |= {sid for sid, t in rows if base_title(t or "") == base}
    out = set(roots)
    # Children come from OpenCode's own session tree and from the catalog, which
    # also knows other harnesses' children (e.g. Muse threads a session delegated).
    sources = [catalog()] + ([oc] if oc is not None else [])
    frontier = list(roots)
    while frontier:
        _check_budget()
        nxt = []
        for i in range(0, len(frontier), 400):
            chunk = frontier[i : i + 400]
            marks = ",".join("?" * len(chunk))
            for con in sources:
                table = "session_v2" if con is oc else "sessions"
                key = "id" if con is oc else "session_id"
                try:
                    nxt += [r[0] for r in con.execute(f"SELECT {key} FROM {table} WHERE parent_id IN ({marks})", chunk)]
                except sqlite3.Error:
                    continue
        nxt = [s for s in dict.fromkeys(nxt) if s not in out]
        out.update(nxt)
        frontier = nxt
    res = frozenset(out)
    if len(_lineage_cache) > 500:
        _lineage_cache.clear()
    _lineage_cache[session_id] = (time.monotonic(), res)
    return res


def lineage(session_id: str | None) -> frozenset:
    """Compatibility wrapper for callers which can tolerate unknown identity."""
    if not session_id:
        return frozenset()
    try:
        return lineage_exclusions(session_id)
    except UnknownCaller:
        return frozenset()


@bounded(0.8)
def resolve_session(ident: str) -> str | None:
    ident = ident.strip()
    if not ident:
        return None
    ident = ident.split("#", 1)[0].split("@", 1)[0]
    if catalog().execute("SELECT 1 FROM sessions WHERE session_id=? LIMIT 1", (ident,)).fetchone():
        return ident
    if cold().execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_episodic_session_timestamp'").fetchone():
        if cold().execute("SELECT 1 FROM episodic_events INDEXED BY idx_episodic_session_timestamp WHERE session_id=? LIMIT 1", (ident,)).fetchone():
            return ident
    try:
        rows = catalog().execute(
            "SELECT session_id, title FROM sessions WHERE session_id LIKE ? ORDER BY last_ts DESC LIMIT 6", (ident + "%",)
        ).fetchall()
    except sqlite3.Error:
        rows = []
    if len(rows) == 1:
        return rows[0][0]
    if len(rows) > 1:
        options = "; ".join(f"{r[0]} {nice_title(r[1] or '')[:50]!r}" for r in rows)
        raise ValueError(f"'{ident}' matches several sessions, use more of the id: {options}")
    if ident.startswith("ses_"):
        oc = opencode_ro()
        if oc is not None:
            try:
                r = oc.execute(
                    "SELECT json_extract(metadata,'$.migration.sourceSessionID') FROM session_v2 WHERE id=?", (ident,)
                ).fetchone()
            except sqlite3.Error:
                r = None
            if r and r[0]:
                return r[0]
    return None


@dataclass
class Message:
    n: int
    event_id: int
    ts: int
    speaker: str
    text: str
    tools: list[str] = field(default_factory=list)


EVENT_COLS = "id, timestamp, speaker, content_type, substr(content,1,30000), metadata_json"
TEXT_ONLY = "content_type='text' AND speaker IN ('user','assistant')"


def _event_rows(con, session_id: str, include_tools: bool, *, after: tuple[int, int] | None = None, before: tuple[int, int] | None = None, limit: int = 400):
    """Rows in (timestamp, id) order, read through idx_episodic_session_timestamp."""
    where = ["session_id=?"]
    params: list = [session_id]
    if not include_tools:
        where.append(TEXT_ONLY)
    if after:
        where.append("(timestamp, id) > (?, ?)")
        params += list(after)
    if before:
        where.append("(timestamp, id) < (?, ?)")
        params += list(before)
    order = "timestamp DESC, id DESC" if before and not after else "timestamp, id"
    rows = con.execute(
        f"SELECT {EVENT_COLS} FROM episodic_events INDEXED BY idx_episodic_session_timestamp "
        f"WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ?",
        [*params, limit],
    ).fetchall()
    return rows[::-1] if order.startswith("timestamp DESC") else rows


class _Builder:
    """Turns event rows into deduped messages; tool events attach to the previous message."""

    def __init__(self, include_tools: bool, include_reasoning: bool, first_n: int = 1):
        self.include_tools, self.include_reasoning = include_tools, include_reasoning
        self.msgs: list[Message] = []
        self.next_n = first_n
        self.seen_long: set[str] = set()
        self.recent: list[tuple[str, str]] = []
        self.pending_tools: list[str] = []

    def add(self, row) -> None:
        eid, ts, speaker, ctype, content, meta = row
        if ctype == "text" and speaker in ("user", "assistant"):
            if speaker == "assistant" and not self.include_reasoning and _kind(meta).endswith(REASONING_KINDS):
                return
            text = clean_text(content, speaker)
            if not text:
                return
            key = hashlib.sha1(squash(text).encode()).hexdigest()
            if (speaker, key) in self.recent or (len(text) > 40 and key in self.seen_long):
                return
            self.recent = (self.recent + [(speaker, key)])[-6:]
            if len(text) > 40:
                self.seen_long.add(key)
            self.msgs.append(Message(self.next_n, eid, int(ts or 0), speaker, text))
            self.next_n += 1
        elif self.include_tools and ctype in ("tool_call", "tool_result", "error", "code"):
            line = f"[{ctype}] " + squash(content or "")[:400]
            if self.msgs:
                self.msgs[-1].tools.append(line)


@bounded(0.8)
def session_messages(
    session_id: str,
    include_tools: bool = False,
    include_reasoning: bool = False,
    *,
    start: int = 1,
    count: int | None = None,
    max_rows: int = 200_000,
) -> list[Message]:
    """Messages numbered from 1, read in windows. Stops after `count` messages from `start`.

    Numbering comes from scanning from the beginning, so huge sessions are capped by
    `max_rows` scanned events; use read_around() to jump to an event instead.
    """
    con = cold()
    b = _Builder(include_tools, include_reasoning)
    after = None
    scanned = 0
    stop_at = start + count - 1 if count else None
    while scanned < max_rows:
        rows = _event_rows(con, session_id, include_tools, after=after, limit=2000)
        if not rows:
            break
        for row in rows:
            b.add(row)
            if stop_at and b.next_n > stop_at + 1:
                break
        scanned += len(rows)
        after = (rows[-1][1], rows[-1][0])
        if stop_at and b.next_n > stop_at + 1:
            break
    msgs = [m for m in b.msgs if m.n >= start]
    return msgs[:count] if count else msgs


@bounded(0.8)
def read_around(session_id: str, event_id: int, *, include_tools: bool = False, include_reasoning: bool = False, context: int = 3) -> tuple[list[Message], int | None]:
    """Messages around one event, without numbering the whole session.

    Returns (messages, index of the hit in that list). Message numbers are relative
    (negative before the hit, 0 at it, positive after) because absolute numbers
    would need a full scan.
    """
    con = cold()
    hit = con.execute("SELECT timestamp, session_id FROM episodic_events WHERE id=?", (event_id,)).fetchone()
    if not hit or hit[1] != session_id:
        return [], None
    pivot = (int(hit[0] or 0), event_id)
    limit = 400 if include_tools else 60
    before = _event_rows(con, session_id, include_tools, before=pivot, limit=limit * (context + 1))
    hit_and_after = _event_rows(con, session_id, include_tools, after=(pivot[0], pivot[1] - 1), limit=limit * (context + 1))
    b = _Builder(include_tools, include_reasoning, first_n=0)
    for row in before + hit_and_after:
        b.add(row)
    msgs = b.msgs
    idx = next((i for i, m in enumerate(msgs) if m.event_id >= event_id and (m.ts, m.event_id) >= pivot), None)
    if idx is None:
        if not msgs:
            return [], None
        idx = len(msgs) - 1
    lo, hi = max(0, idx - context), min(len(msgs), idx + context + 1)
    window = msgs[lo:hi]
    for i, m in enumerate(window):
        m.n = i - (idx - lo)
    return window, idx - lo


def session_size(session_id: str, deadline: Deadline | None = None) -> int | None:
    """Text message rows in the session (approximate message count; None if slow)."""
    try:
        rows = run(
            mem(),
            f"SELECT count(*) FROM episodic_events INDEXED BY idx_episodic_session_timestamp WHERE session_id=? AND {TEXT_ONLY}",
            (session_id,),
            deadline or Deadline(1.5),
        )
        return int(rows[0][0])
    except Timeout:
        return None


def render_messages(
    msgs: list[Message],
    *,
    max_chars: int = 4000,
    total_chars: int = 60000,
    relative: bool = False,
) -> tuple[str, Message | None]:
    """Render messages until the output cap; returns (text, last message shown)."""
    if not msgs:
        return "(no messages)", None
    parts, used, last = [], 0, None
    for m in msgs:
        body = m.text if len(m.text) <= max_chars else m.text[:max_chars] + f"\n… [{len(m.text) - max_chars} more chars]"
        label = (f"{m.n:+d}" if m.n else ">> hit") if relative else f"#{m.n}"
        block = f"{label} {m.speaker} · {fmt_ts(m.ts)} · e{m.event_id}\n{body}"
        if m.tools:
            shown = m.tools[:12]
            block += "\n" + "\n".join("  " + t for t in shown)
            if len(m.tools) > len(shown):
                block += f"\n  … {len(m.tools) - len(shown)} more tool events"
        if used + len(block) > total_chars and parts:
            parts.append("… output cap reached")
            break
        parts.append(block)
        used += len(block)
        last = m
    return "\n\n".join(parts), last


def session_header(session_id: str, n_messages: int | None = None) -> str:
    meta = catalog_rows([session_id]).get(session_id) or {}
    bits = [nice_title(meta.get("title") or "") or "(untitled)", f"{meta.get('source', '?')} {session_id}"]
    line2 = []
    if meta.get("cwd"):
        line2.append(f"cwd {meta['cwd']}")
    if meta.get("first_ts"):
        line2.append(f"{fmt_ts(meta['first_ts'])} → {fmt_ts(meta.get('last_ts'))}")
    if n_messages is not None:
        line2.append(f"~{n_messages} text events")
    elif meta.get("n_events"):
        line2.append(f"{meta['n_events']} events")
    if meta.get("parent_id"):
        line2.append(f"subagent of {meta['parent_id']}")
    return " — ".join(bits) + ("\n" + " · ".join(line2) if line2 else "")


@bounded(0.8)
def excerpt_around(session_id: str, event_id: int, *, before_chars: int = 500, hit_chars: int = 1200, after_chars: int = 900) -> list[tuple[str, int, int, str]]:
    """The hit message plus the neighbor that gives it meaning (question or answer)."""
    con = cold()
    hit = con.execute(
        "SELECT id, timestamp, speaker, content_type, substr(content,1,30000), metadata_json FROM episodic_events WHERE id=?",
        (event_id,),
    ).fetchone()
    if not hit:
        return []
    out = []
    hid, hts, hspeaker, hctype, hcontent, _ = hit
    pivot = (int(hts or 0), hid)
    text = clean_text(hcontent, hspeaker) if hctype == "text" else squash(hcontent or "")
    if hspeaker == "assistant":
        prev = _event_rows(con, session_id, False, before=pivot, limit=40)
        for pid, pts, pspeaker, _pctype, pcontent, _pmeta in reversed(prev):
            if pspeaker != "user":
                continue
            c = clean_text(pcontent, "user")
            if c:
                out.append(("user", pid, pts, _clip(c, before_chars)))
                break
    out.append((hspeaker, hid, hts, _clip(text, hit_chars)))
    if hspeaker == "user":
        nxt = [(r[0], r[1], r[2], r[4], r[5]) for r in _event_rows(con, session_id, False, after=pivot, limit=12)]
        answer = None
        for nid, nts, nspeaker, ncontent, nmeta in nxt:
            if nspeaker == "user":
                c = clean_text(ncontent, "user")
                if c and squash(c) != squash(text):
                    break
                continue
            if _kind(nmeta).endswith(REASONING_KINDS):
                continue
            c = clean_text(ncontent, "assistant")
            if c:
                answer = (nid, nts, c)  # keep the last answer before the next user turn
        if answer:
            out.append(("assistant", answer[0], answer[1], _clip(answer[2], after_chars)))
    return out


def _clip(text: str, n: int) -> str:
    text = text.strip()
    return text if len(text) <= n else text[: n - 1] + "…"
