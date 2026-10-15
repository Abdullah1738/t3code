"""Capture Muse Code sessions into memory.db (source 'muse').

Muse writes one append-only JSONL event log per session:
  ~/.local/share/muse/sessions/YYYY/MM/DD/<session>/session.jsonl
  .../<session>/subagent/<child>/session.jsonl
This tails each log from the last byte offset it read (complete lines only) and
projects the conversation records into episodic_events:
  runtime.user_intent.accepted              -> user text
  run assistant_message_committed           -> assistant text
  run reasoning_summary_committed           -> assistant text, kind reasoning
  run assistant_tool_calls_committed        -> tool_call rows (<record>.t<i>)
  run tool_result_batch_committed           -> tool_result rows (<record>.o<i>)
  run terminal (not completed)              -> error row
Everything else (task bookkeeping, reminders, traces) stays in the log only.
Muse's own "reminder observer" child sessions are skipped.

Thread titles and parents come from Robob's state DB when the session belongs
to a Robob thread (a delegated Muse thread's parent is the session of the
thread that delegated it). Rows use the record uuid as turn_id, so re-reading a
log is idempotent; a log that shrinks, is replaced or changes its head is
re-projected. A bad record is skipped and a bad file doesn't hold up the others;
each run writes logs/muse_last.json for the health check.
"""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backend  # noqa: E402
from sync_opencode_v2 import with_retry  # noqa: E402

HOME = os.path.expanduser("~")
MEM_DB = os.environ.get("MEMORY_DB", os.path.join(HOME, ".local/share/memory-system/data/memory.db"))
MUSE_SESSIONS = os.environ.get(
    "MUSE_SESSIONS",
    os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(HOME, ".local/share"), "muse/sessions"),
)
SOURCE = "muse"
CHUNK_BYTES = 8 << 20
MAX_CONTENT = 1 << 20
HEAD_BYTES = 4096
OBSERVER_PREFIX = "You are a reminder observer"
UNDECIDED_QUIET = 5 * 60  # a child log with no run start, quiet this long, is kept as a subagent
SKIP_DIRS = {"tool-outputs", "approval-review"}
STATUS = os.environ.get(
    "MUSE_STATUS", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs", "muse_last.json")
)

MUSE_INDEX = os.path.join(os.path.dirname(MUSE_SESSIONS), "session-index.db")
SOURCE_CHECK_OLD = "CHECK(source IN ('codex', 'hermes', 'opencode'))"
SOURCE_CHECK_NEW = "CHECK(source IN ('codex', 'hermes', 'opencode', 'muse'))"

SCHEMA = """
CREATE TABLE IF NOT EXISTS muse_sync_files(
  path TEXT PRIMARY KEY, session_id TEXT, root_id TEXT, offset INTEGER,
  size INTEGER, mtime_ns INTEGER, head_sha TEXT, skip INTEGER DEFAULT 0,
  state_json TEXT, synced_at INTEGER);
CREATE TABLE IF NOT EXISTS muse_sessions(
  session_id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, cwd TEXT, model TEXT,
  robob_thread_id TEXT, path TEXT, updated_at INTEGER);
"""


def allow_muse_source(con):
    """Widen episodic_events' source CHECK to accept 'muse' (one-time, in place).

    Rebuilding the table is not an option at this size. Loosening a CHECK cannot
    invalidate existing rows, so editing the stored schema is the documented,
    safe route (sqlite.org/lang_altertable.html, "other kinds of changes").
    Raises unless the table ends up accepting 'muse'.
    """

    def table_sql():
        row = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='episodic_events'").fetchone()
        if not row:
            raise RuntimeError("memory.db has no episodic_events table")
        return row[0]

    def accepts_muse(sql):
        return "'muse'" in sql or "CHECK(source" not in sql.replace(" ", "")

    if accepts_muse(table_sql()):
        return False
    changed = []

    def migrate():
        sql = table_sql()  # re-check under the write lock
        if accepts_muse(sql):
            return
        if SOURCE_CHECK_OLD not in sql:
            raise RuntimeError("episodic_events has an unexpected source CHECK; widen it by hand")
        version = con.execute("PRAGMA schema_version").fetchone()[0]
        con.execute("PRAGMA writable_schema=ON")
        try:
            con.execute(
                "UPDATE sqlite_master SET sql=replace(sql, ?, ?) WHERE type='table' AND name='episodic_events'",
                (SOURCE_CHECK_OLD, SOURCE_CHECK_NEW),
            )
            con.execute(f"PRAGMA schema_version={version + 1}")
        finally:
            con.execute("PRAGMA writable_schema=OFF")
        changed.append(True)

    with_retry(con, migrate)
    check = sqlite3.connect(MEM_DB, timeout=60)
    try:
        sql = check.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='episodic_events'").fetchone()[0]
    finally:
        check.close()
    if "'muse'" not in sql:
        raise RuntimeError("episodic_events still rejects source 'muse' after widening")
    if changed:
        print("widened episodic_events source CHECK to include 'muse'", flush=True)
    return bool(changed)


def index_titles():
    """Muse's own session titles (session-index.db), when it has a real one."""
    try:
        con = sqlite3.connect(f"file:{MUSE_INDEX}?mode=ro", uri=True, timeout=5)
        rows = con.execute(
            "SELECT session_id, coalesce(nullif(msp_title,''), nullif(title,''), nullif(effective_long_title,''))"
            " FROM sessions"
        ).fetchall()
        con.close()
    except sqlite3.Error:
        return {}
    return {sid: t for sid, t in rows if t and t.strip() not in ("New session", "Untitled")}


def session_files(root):
    """Yield (path, session_id, parent_session_id or None) for every session log."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS)
        if "session.jsonl" not in filenames:
            continue
        parts = os.path.relpath(dirpath, root).split(os.sep)
        sid = parts[-1]
        parent = parts[-3] if len(parts) >= 3 and parts[-2] == "subagent" else None
        yield os.path.join(dirpath, "session.jsonl"), sid, parent


def head_sha(path, length):
    """'<n>:<sha256>' of the log's first n = min(length, HEAD_BYTES) bytes."""
    n = min(length, HEAD_BYTES)
    with open(path, "rb") as f:
        return f"{n}:" + hashlib.sha256(f.read(n)).hexdigest()


def head_changed(path, stored):
    """True when the bytes a stored head_sha covered are no longer the same."""
    if not stored or ":" not in stored:
        return bool(stored)
    n = int(stored.split(":", 1)[0])
    return head_sha(path, n) != stored


def _d(v):
    return v if isinstance(v, dict) else {}


def _s(v):
    return v if isinstance(v, str) else ""


def _l(v):
    return v if isinstance(v, list) else []


def clip(text):
    if text is None:
        return ""
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)
    return text if len(text) <= MAX_CONTENT else text[:MAX_CONTENT] + "\n[truncated]"


def intent_text(p):
    out = [_s(b.get("text")) for b in _l(p.get("refill_blocks")) if isinstance(b, dict) and _s(b.get("text"))]
    if not out:
        for m in _l(p.get("model_messages")):
            for c in _l(_d(m).get("content")):
                if isinstance(c, dict) and _s(c.get("text")):
                    out.append(c["text"])
    return "\n".join(out)


def project(rec, st, rel):
    """Return rows (turn_id, ts, speaker, ctype, content, model, meta) for one record.

    `st` carries per-log state across records: dir, model, observer, tools.
    Fields of the wrong type are treated as missing.
    """
    ptype = rec.get("payload_type")
    p = rec.get("payload")
    rid = rec.get("id")
    if not isinstance(ptype, str) or not isinstance(rid, str) or not rid or not isinstance(p, dict):
        return []
    at = rec.get("recorded_at")
    ts = int(at // 1_000_000) if isinstance(at, (int, float)) and at > 0 else int(time.time())
    if ptype == "runtime.session.metadata":
        r = _d(p.get("record"))
        st["dir"] = _s(r.get("workspace_root")) or st.get("dir")
        st["model"] = _s(r.get("model_id")) or st.get("model")
        return []
    if ptype == "runtime.session.route_facts":
        st["dir"] = st.get("dir") or _s(_d(p.get("record")).get("cwd")) or None
        return []
    if ptype == "run.model.configured":
        st["model"] = _s(_d(p.get("record")).get("model_id")) or st.get("model")
        return []
    base = {"rec_id": rid, "seq": rec.get("sequence"), "dir": st.get("dir"), "raw_sidecar": "muse_log", "file": rel}
    if st.get("title"):
        base["title"] = st["title"]
    model = st.get("model")
    if ptype == "runtime.user_intent.accepted":
        text = intent_text(p)
        if not text:
            return []
        return [(rid, ts, "user", "text", clip(text), None, dict(base, kind="user"))]
    if ptype != "runtime.session" or p.get("kind") != "run":
        return []
    ev = _d(p.get("event"))
    kind = ev.get("kind")
    base["run_id"] = _s(p.get("run_id")) or None
    if kind == "started":
        if st.get("observer") is None:
            st["observer"] = _s(ev.get("prompt")).startswith(OBSERVER_PREFIX)
        return []
    if kind == "assistant_message_committed":
        text = _s(ev.get("text"))
        if not text:
            return []
        meta = dict(base, kind="assistant", message_id=ev.get("message_id"))
        if _s(ev.get("phase")):
            meta["phase"] = ev["phase"]
        return [(rid, ts, "assistant", "text", clip(text), model, meta)]
    if kind in ("reasoning_summary_committed", "reasoning_committed"):
        text = _s(ev.get("text"))
        mid = _s(ev.get("message_id"))
        summarized = st.setdefault("summarized", [])
        if kind == "reasoning_summary_committed":
            if mid and mid not in summarized:
                summarized.append(mid)
                del summarized[:-200]
        elif mid and mid in summarized:
            return []  # the summary already carries this reasoning
        if not text.strip():
            return []
        return [(rid, ts, "assistant", "text", clip(text), model, dict(base, kind="reasoning"))]
    if kind == "assistant_tool_calls_committed":
        rows = []
        for i, c in enumerate(_l(ev.get("tool_calls"))):
            if not isinstance(c, dict):
                continue
            name = _s(c.get("name"))
            cid = _s(c.get("call_id")) or _s(c.get("id")) or None
            if cid:
                st.setdefault("tools", {})[cid] = name
            rows.append((f"{rid}.t{i}", ts, "assistant", "tool_call", clip(name + "\n" + clip(c.get("args"))),
                         model, dict(base, kind="tool_call", tool=name, call_id=cid)))
        return rows
    if kind == "tool_result_batch_committed":
        rows = []
        tools = st.setdefault("tools", {})
        for i, r in enumerate(_l(ev.get("results"))):
            if not isinstance(r, dict) or not r.get("text"):
                continue
            cid = r.get("tool_call_id") if isinstance(r.get("tool_call_id"), str) else None
            rows.append((f"{rid}.o{i}", ts, "system", "tool_result", clip(r.get("text")), None,
                         dict(base, kind="tool_result", tool=tools.get(cid), call_id=cid)))
        return rows
    if kind == "terminal":
        term = ev.get("terminal")
        if term in (None, "completed"):
            return []
        reason = ev.get("reason")
        text = f"run ended: {term}" + (f" ({reason})" if reason else "")
        return [(rid, ts, "system", "error", clip(text), model, dict(base, kind="terminal", terminal=str(term)))]
    return []


class Robob:
    """Thread titles and parents for Muse sessions owned by Robob threads."""

    def __init__(self):
        self.by_native = {}
        try:
            self.con = backend.robob_ro()
        except (FileNotFoundError, sqlite3.Error):
            self.con = None
            return
        try:
            rows = self.con.execute(
                "SELECT p.thread_id, json_extract(p.payload_json,'$.nativeThreadRef.nativeId'),"
                " json_extract(p.payload_json,'$.createdAt'), t.title,"
                " json_extract(t.payload_json,'$.lineage.parentThreadId')"
                " FROM orchestration_v2_projection_provider_threads p"
                " LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id=p.thread_id"
                " WHERE p.provider='muse'"
            ).fetchall()
        except sqlite3.Error:
            rows = []
        for thread_id, native, created, title, parent_thread in rows:
            if native:
                self.by_native[native] = (thread_id, created or "", title, parent_thread)

    def parent_session(self, parent_thread, created):
        """The provider session of the parent thread that was live when the child started."""
        if not self.con or not parent_thread:
            return None
        try:
            rows = self.con.execute(
                "SELECT json_extract(payload_json,'$.nativeThreadRef.nativeId'), json_extract(payload_json,'$.createdAt')"
                " FROM orchestration_v2_projection_provider_threads WHERE thread_id=?",
                (parent_thread,),
            ).fetchall()
        except sqlite3.Error:
            return None
        rows = [(n, c or "") for n, c in rows if n]
        before = [r for r in rows if r[1] <= created] or rows
        return max(before, key=lambda r: r[1])[0] if before else None

    def describe(self, sid):
        hit = self.by_native.get(sid)
        if not hit:
            return None, None, None
        thread_id, created, title, parent_thread = hit
        return thread_id, title, self.parent_session(parent_thread, created)


class MuseSync:
    def __init__(self, args):
        self.args = args
        self.mem = sqlite3.connect(MEM_DB, timeout=600)
        self.mem.execute("PRAGMA busy_timeout=600000")
        self.mem.executescript(SCHEMA)
        cols = {r[1] for r in self.mem.execute("PRAGMA table_info(muse_sync_files)")}
        if "ino" not in cols:
            self.mem.execute("ALTER TABLE muse_sync_files ADD COLUMN ino INTEGER")
        self.mem.commit()
        allow_muse_source(self.mem)
        self.robob = Robob()
        self.titles = index_titles()
        self.stats = dict(files=0, changed=0, rows=0, skipped_observers=0, reset=0, bad_records=0, errors=0)
        self.errors = []

    def ledger(self):
        cols = ("path", "session_id", "root_id", "offset", "size", "mtime_ns", "head_sha", "skip", "state_json", "ino")
        return {r[0]: dict(zip(cols, r)) for r in self.mem.execute(f"SELECT {','.join(cols)} FROM muse_sync_files")}

    def session_meta(self, sid, parent, st, path):
        thread_id, title, robob_parent = self.robob.describe(sid)
        title = title or self.titles.get(sid)
        return dict(session_id=sid, parent_id=parent or robob_parent, title=title, cwd=st.get("dir"),
                    model=st.get("model"), robob_thread_id=thread_id, path=path)

    @staticmethod
    def _boundary_ok(path, offset):
        """The byte before the saved offset must still end a line."""
        if offset <= 0:
            return True
        with open(path, "rb") as f:
            f.seek(offset - 1)
            return f.read(1) == b"\n"

    def sync_file(self, path, sid, parent, led):
        stt = os.stat(path)
        if led and led["size"] == stt.st_size and led["mtime_ns"] == stt.st_mtime_ns and not self.args.full:
            return
        self.stats["changed"] += 1
        offset = (led or {}).get("offset") or 0
        try:
            state = json.loads((led or {}).get("state_json") or "{}")
        except ValueError:
            state = {}
        reset = bool(led) and (
            self.args.full
            or stt.st_size < offset
            or (led.get("ino") is not None and led["ino"] != stt.st_ino)
            or head_changed(path, led.get("head_sha"))
            or not self._boundary_ok(path, offset)
        )
        if reset:
            offset, state = 0, {}
            self.stats["reset"] += 1
        if led and led.get("skip") and not reset:
            with_retry(self.mem, lambda: self.mem.execute(
                "UPDATE muse_sync_files SET size=?, mtime_ns=?, ino=?, synced_at=? WHERE path=?",
                (stt.st_size, stt.st_mtime_ns, stt.st_ino, int(time.time()), path)))
            return
        _, title, _ = self.robob.describe(sid)
        title = title or self.titles.get(sid)
        if title:
            state["title"] = title
        rel = os.path.relpath(path, MUSE_SESSIONS)
        is_child = parent is not None
        first = True
        with open(path, "rb") as f:
            f.seek(offset)
            pos = offset
            while True:
                rows, budget = [], CHUNK_BYTES
                while budget > 0:
                    line = f.readline()
                    if not line.endswith(b"\n"):
                        break  # EOF or a line Muse is still writing
                    pos += len(line)
                    budget -= len(line)
                    try:
                        rec = json.loads(line)
                        if isinstance(rec, dict):
                            rows.extend(project(rec, state, rel))
                    except Exception:  # noqa: BLE001 - one bad record must not stop the log
                        self.stats["bad_records"] += 1
                done = budget > 0
                if is_child and state.get("observer") is None:
                    quiet = time.time() - stt.st_mtime > UNDECIDED_QUIET
                    if done and not quiet:
                        # No run start yet: read it again next time.
                        self._save(path, sid, parent, 0, 0, stt, 0, {}, reset and first, None)
                        return
                    state["observer"] = False  # quiet or long without a start: keep it as a subagent
                if is_child and state.get("observer"):
                    self.stats["skipped_observers"] += 1
                    self._save(path, sid, parent, pos, stt.st_size, stt, 1, {}, reset and first, None)
                    return
                tools = state.get("tools") or {}
                if len(tools) > 2000:
                    state["tools"] = dict(list(tools.items())[-1000:])
                meta = self.session_meta(sid, parent, state, rel)
                size = stt.st_size if done else 0
                self._save(path, sid, parent or sid, pos, size, stt, 0, state, reset and first, meta, rows)
                first = False
                if done:
                    return

    def _save(self, path, sid, root_id, offset, size, stt, skip, state, reset, meta, rows=()):
        sha = head_sha(path, offset)

        def write():
            if reset:
                self.mem.execute("DELETE FROM episodic_events WHERE source=? AND session_id=?", (SOURCE, sid))
            if rows:
                # ON CONFLICT (not OR IGNORE) so a CHECK failure raises instead of dropping rows.
                self.mem.executemany(
                    "INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,"
                    "content_type,model,tokens_used,metadata_json) VALUES (?,?,?,?,?,?,?,?,NULL,?)"
                    " ON CONFLICT(source,session_id,turn_id) DO NOTHING",
                    [(SOURCE, sid, tid, ts, spk, content, ctype, model, json.dumps(m, ensure_ascii=False))
                     for tid, ts, spk, ctype, content, model, m in rows],
                )
            self.mem.execute(
                "INSERT OR REPLACE INTO muse_sync_files(path, session_id, root_id, offset, size, mtime_ns, head_sha,"
                " skip, state_json, synced_at, ino) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (path, sid, root_id, offset, size, stt.st_mtime_ns, sha, skip,
                 json.dumps(state, ensure_ascii=False), int(time.time()), stt.st_ino),
            )
            if meta:
                self._upsert_meta(meta)

        with_retry(self.mem, write)
        self.stats["rows"] += len(rows)

    def _upsert_meta(self, meta):
        self.mem.execute(
            "INSERT INTO muse_sessions VALUES (:session_id,:parent_id,:title,:cwd,:model,:robob_thread_id,"
            ":path,:now) ON CONFLICT(session_id) DO UPDATE SET"
            " parent_id=coalesce(excluded.parent_id, parent_id), title=coalesce(excluded.title, title),"
            " cwd=coalesce(excluded.cwd, cwd), model=coalesce(excluded.model, model),"
            " robob_thread_id=coalesce(excluded.robob_thread_id, robob_thread_id),"
            " path=excluded.path, updated_at=excluded.updated_at",
            dict(meta, now=int(time.time())),
        )

    def late_metadata(self):
        """Titles and parents that showed up after a log went quiet (Robob maps threads late)."""
        rows = self.mem.execute(
            "SELECT session_id, parent_id, title, robob_thread_id FROM muse_sessions"
            " WHERE title IS NULL OR parent_id IS NULL OR robob_thread_id IS NULL"
        ).fetchall()
        updates = []
        for sid, parent, title, thread_id in rows:
            t_id, t_title, t_parent = self.robob.describe(sid)
            t_title = t_title or self.titles.get(sid)
            if (t_id and t_id != thread_id) or (t_title and not title) or (t_parent and not parent):
                updates.append((sid, t_id, t_title, t_parent))
        if not updates:
            return 0

        def write():
            for sid, t_id, t_title, t_parent in updates:
                self.mem.execute(
                    "UPDATE muse_sessions SET robob_thread_id=coalesce(?, robob_thread_id), title=coalesce(title, ?),"
                    " parent_id=coalesce(parent_id, ?), updated_at=? WHERE session_id=?",
                    (t_id, t_title, t_parent, int(time.time()), sid),
                )

        with_retry(self.mem, write)
        return len(updates)

    def write_status(self, ok):
        st = dict(ts=int(time.time()), ok=ok, stats=self.stats, errors=self.errors[-5:])
        try:
            os.makedirs(os.path.dirname(STATUS), exist_ok=True)
            tmp = STATUS + ".tmp"
            with open(tmp, "w") as f:
                json.dump(st, f)
            os.replace(tmp, STATUS)
        except OSError:
            pass

    def run(self):
        t0 = time.time()
        if not os.path.isdir(MUSE_SESSIONS):
            self.write_status(True)
            print("DONE", json.dumps(dict(self.stats, note="no muse sessions dir")), flush=True)
            return self.stats
        led = self.ledger()
        for path, sid, parent in session_files(MUSE_SESSIONS):
            if self.args.only and sid not in self.args.only and parent not in self.args.only:
                continue
            self.stats["files"] += 1
            try:
                self.sync_file(path, sid, parent, led.get(path))
            except FileNotFoundError:
                continue
            except Exception as e:  # noqa: BLE001 - one bad file must not hold up the rest
                if isinstance(e, sqlite3.OperationalError) and "locked" in str(e):
                    raise
                self.stats["errors"] += 1
                self.errors.append(f"{sid}: {type(e).__name__}: {str(e)[:200]}")
                print(f"error in {path}: {type(e).__name__}: {e}", flush=True)
            if self.args.deadline and time.time() - t0 > self.args.deadline:
                print(f"soft deadline {self.args.deadline}s reached; rest next run", flush=True)
                break
        try:
            self.stats["late_meta"] = self.late_metadata()
        except sqlite3.Error as e:
            self.errors.append(f"late metadata: {e}")
        self.stats["secs"] = round(time.time() - t0, 2)
        self.write_status(not self.stats["errors"])
        print("DONE", json.dumps(self.stats), flush=True)
        return self.stats


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--full", action="store_true", help="re-project every log from the start")
    p.add_argument("--only", nargs="*", help="session ids")
    p.add_argument("--deadline", type=int, default=0, help="soft deadline (secs)")
    args = p.parse_args()
    try:
        stats = MuseSync(args).run()
    except Exception as e:  # noqa: BLE001 - record the failure for the health check, then fail the run
        st = dict(ts=int(time.time()), ok=False, stats={}, errors=[f"{type(e).__name__}: {str(e)[:300]}"])
        try:
            os.makedirs(os.path.dirname(STATUS), exist_ok=True)
            with open(STATUS, "w") as f:
                json.dump(st, f)
        except OSError:
            pass
        raise
    sys.exit(1 if stats.get("errors") else 0)


if __name__ == "__main__":
    main()
