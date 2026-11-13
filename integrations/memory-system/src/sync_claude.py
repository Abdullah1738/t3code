"""Capture Robob's Claude Code transcripts into memory.db (source 'claude').

Layout per root (transcript_roots.json, driver claudeAgent):
  projects/<cwd-slug>/<sessionId>.jsonl                      top-level session
  projects/<cwd-slug>/<sessionId>/subagents/agent-<id>.jsonl child (and deeper)

Every child record carries the PARENT sessionId and its own agentId, so a child
is keyed by "<sessionId>:agent:<agentId>" from its file, never by the bare
sessionId. Each line is also kept verbatim in native_capture_raw.

Projection: user/assistant text -> 'text'; thinking -> 'text' (metadata kind
"thinking"); tool_use -> 'tool_call'; tool_result -> 'tool_result' ('error' when
is_error). turn_id = "<uuid>:<block index>". Hook-injected <recall> notes and
seeded-prefix lines (harness_migrate_manifest) are kept raw but not projected.
"""

import argparse
import json
import os
import sqlite3
import redact_guard
import stat
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schema_migrations  # noqa: E402
import transcript_capture as tc  # noqa: E402
import transcript_roots  # noqa: E402
from sync_opencode_v2 import with_retry  # noqa: E402
from capture_budget import Budget, Exhausted, checkpoint, setup_writer  # noqa: E402

HOME = os.path.expanduser("~")
MEM_DB = os.environ.get("MEMORY_DB", os.path.join(HOME, ".local/share/memory-system/data/memory.db"))
SEEDED_DEFAULT = os.path.join(HOME, ".robob/harness-migrate/seeded.jsonl")
SOURCE = "claude"
DRIVER = "claudeAgent"
MAX_CONTENT = 1 << 20
RECALL_PREFIX = "<recall>"


def parse_ts(value):
    """Unix seconds from an ISO-8601 timestamp; a 'Z' or offset is honoured, a naive value is UTC."""
    from datetime import datetime, timezone

    if not isinstance(value, str) or len(value) < 19:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def clip(text):
    if text is None:
        return ""
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)
    return text if len(text) <= MAX_CONTENT else text[:MAX_CONTENT] + "\n[truncated]"


def seeded_path():
    """Read at call time, so each run (and test) sees its own environment."""
    return os.environ.get("HARNESS_SEEDED_MANIFEST", SEEDED_DEFAULT)


def load_seeded(path=None, roots=()):
    """{native_session_id: [(first_line, last_line, seed_identity|None), ...]} from an optional JSONL manifest.

    The card that writes seeded.jsonl owns its format; a missing file means nothing is seeded, and a
    malformed line is ignored rather than fatal. An entry's path becomes its seed identity against the
    given homes (see tc.seed_identity). An entry whose path no home contains is logged and ignored:
    matching it on the file name alone could cross homes. An entry without a path covers any
    transcript of that session.
    """
    out = {}
    try:
        f = open(path or seeded_path())
    except FileNotFoundError:
        return out
    with f:
        for line in f:
            try:
                e = json.loads(line)
                native = e["native_session_id"]
                first, last = int(e["first_line"]), int(e["last_line"])
                ident = None
                if isinstance(e.get("path"), str) and e["path"]:
                    ident = tc.seed_identity(e["path"], roots)
                    if ident is None:
                        print(f"seeded entry for {native} ignored: {e['path']} is outside every captured home",
                              file=sys.stderr, flush=True)
                        continue
                out.setdefault(native, []).append((first, last, ident))
            except (ValueError, KeyError, TypeError):
                continue
    return out


def session_key(record_session, agent_id):
    """Top-level: sessionId. Child: '<sessionId>:agent:<agentId>' (never the bare parent)."""
    if agent_id:
        return f"{record_session}:agent:{agent_id}"
    return record_session


def is_child_path(path):
    return os.path.basename(os.path.dirname(path)) == "subagents"


def session_files(root):
    """Yield the transcript files under a Claude home, sorted for stable scheduling."""
    proj = os.path.join(root, "projects")
    try:
        mode = os.stat(proj).st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(mode):
        raise NotADirectoryError(proj)
    for slug in sorted(os.listdir(proj)):
        d = os.path.join(proj, slug)
        try:
            mode = os.stat(d).st_mode
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(mode):
            continue
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if name.endswith(".jsonl") and os.path.isfile(p):
                yield p
        for dirpath, dirnames, filenames in os.walk(d, onerror=_walk_error):
            dirnames.sort()
            if os.path.basename(dirpath) != "subagents":
                continue
            for name in sorted(filenames):
                if name.startswith("agent-") and name.endswith(".jsonl"):
                    yield os.path.join(dirpath, name)


def _walk_error(error):
    raise error


def _blocks(msg):
    content = msg.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def _tool_result_text(block):
    c = block.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and isinstance(b.get("text"), str))
    return json.dumps(c, ensure_ascii=False) if c is not None else ""


def project(rec, path, line_no):
    """Rows (turn_id, ts, speaker, content_type, content, model, metadata, session_key) for one record."""
    if not isinstance(rec, dict):
        return []
    sid = rec.get("sessionId")
    uuid = rec.get("uuid")
    if not isinstance(sid, str) or not sid or not isinstance(uuid, str) or not uuid:
        return []
    if rec.get("type") not in ("user", "assistant"):
        return []
    msg = rec.get("message")
    if not isinstance(msg, dict):
        return []
    role = msg.get("role") if msg.get("role") in ("user", "assistant") else rec.get("type")
    agent = rec.get("agentId") if isinstance(rec.get("agentId"), str) and rec.get("agentId") else None
    if is_child_path(path) and not agent:
        agent = os.path.basename(path)[len("agent-"):-len(".jsonl")]
        if not agent:
            return []
    key = session_key(sid, agent)
    ts = parse_ts(rec.get("timestamp"))
    base = {"file": os.path.basename(path), "line": line_no, "cwd": rec.get("cwd"), "parent_session": sid,
            "agent_id": agent, "sidechain": bool(rec.get("isSidechain")), "uuid": uuid}
    model = msg.get("model") if isinstance(msg.get("model"), str) else None
    rows = []
    for i, b in enumerate(_blocks(msg)):
        t = b.get("type")
        tid = f"{uuid}:{i}"
        if t == "text" and isinstance(b.get("text"), str) and b["text"].strip():
            text = b["text"]
            if role == "user" and text.lstrip().startswith(RECALL_PREFIX):
                continue
            rows.append((tid, ts or int(time.time()), role, "text", clip(text), model, dict(base, kind=role), key))
        elif t == "thinking" and isinstance(b.get("thinking"), str) and b["thinking"].strip():
            rows.append((tid, ts or int(time.time()), "assistant", "text", clip(b["thinking"]), model,
                         dict(base, kind="thinking"), key))
        elif t == "tool_use":
            name = b.get("name") if isinstance(b.get("name"), str) else ""
            args = json.dumps(b.get("input"), ensure_ascii=False) if b.get("input") is not None else ""
            rows.append((tid, ts or int(time.time()), "assistant", "tool_call", clip(name + "\n" + args), model,
                         dict(base, kind="tool_call", tool=name, call_id=b.get("id")), key))
        elif t == "tool_result":
            text = _tool_result_text(b)
            if not text:
                continue
            ctype = "error" if b.get("is_error") else "tool_result"
            rows.append((tid, ts or int(time.time()), "system", ctype, clip(text), None,
                         dict(base, kind=ctype, call_id=b.get("tool_use_id")), key))
    return rows


def is_seeded(seeded, file_ident, line_no, key):
    """True when this line sits in a seeded (transplanted) range for its capture key.

    `key` is the capture identity of the transcript line: the top-level sessionId, or
    "<sessionId>:agent:<agentId>" for a child. `file_ident` is tc.seed_identity of the file (None
    when no captured home contains it). A range with an identity applies only to that transcript;
    a range without one applies to any transcript of the session.
    """
    if not isinstance(key, str):
        return False
    for first, last, ident in seeded.get(key, ()):
        if (ident is None or ident == file_ident) and first <= line_no <= last:
            return True
    return False


class ClaudeSync:
    def __init__(self, args, roots=None):
        self.args = args
        self.budget = Budget(args.deadline)
        self.roots = roots if roots is not None else transcript_roots.existing(
            [e for e in transcript_roots.load() if e["driver"] == DRIVER])
        self.all_roots = [r for r in transcript_roots.resolve() if r["driver"] == DRIVER]
        self.mem = setup_writer(sqlite3.connect(MEM_DB, timeout=0.1), self.budget)
        self.redactor = redact_guard.CaptureGuard(self.mem)
        schema_migrations.migrate(self.mem)
        tc.ensure_schema(self.mem)
        self.seed_roots = list(self.roots) + list(self.all_roots)
        self.seeded = load_seeded(roots=self.seed_roots)
        self.stats = dict(files=0, rows=0, raw=0, skipped_seeded=0, errors=0, quarantined=0, unchanged=0,
                          missing_roots=[])
        self.errors = []

    def _key_of_line(self, path, rec):
        """Capture identity of one line; child files use their own agentId (the parent id is not a key)."""
        if not isinstance(rec, dict) or not isinstance(rec.get("sessionId"), str) or not rec["sessionId"]:
            return None
        agent = rec.get("agentId") if isinstance(rec.get("agentId"), str) and rec.get("agentId") else None
        if is_child_path(path) and not agent:
            agent = os.path.basename(path)[len("agent-"):-len(".jsonl")]
        # A child without an agent id must not acquire its parent's identity.
        if is_child_path(path) and not agent:
            return None
        return session_key(rec["sessionId"], agent)

    def key_of(self, path):
        """Qualified identity: the home's configured instance plus the path below its root.

        Both sides are compared as realpaths, because the roots are resolved (a symlinked
        or /tmp -> /private/tmp home would otherwise match nothing).
        """
        root = self._root_of(path)
        return f"{root['instance']}:{tc.logical_name(os.path.realpath(path), os.path.realpath(root['path']))}"

    def _root_of(self, path):
        """The captured home a file lives under (the home the walk started from).

        Both sides are realpaths: a root may be given as a symlink, /tmp, or ~.
        """
        real = os.path.realpath(path)
        for r in self.roots:
            base = os.path.realpath(r["path"])
            if real.startswith(base + os.sep):
                return r
        raise ValueError(f"{path} is outside every captured Claude home")

    @staticmethod
    def _unchanged(path, st, rep):
        """Nothing to read: the file is exactly the size of the last clean pass and its consumed bytes match."""
        if rep["error"] or rep["offset"] != st.st_size:
            return False
        if not rep.get("tail_sha1"):
            return False  # no checksum from a previous clean pass yet: read once to establish it
        return tc.tail_sha1(path, rep["offset"]) == rep["tail_sha1"]

    def sync_file(self, path, st):
        key = self.key_of(path)
        instance = self._root_of(path)["instance"]
        if tc.quarantined(self.mem, key):
            with_retry(self.mem, lambda: tc.follow_quarantined_move(self.mem, path, key, instance), budget=self.budget)
            self.stats["quarantined"] += 1
            return
        rep = with_retry(self.mem, lambda: tc.open_representation(self.mem, path, st, key=key, instance=instance), budget=self.budget)
        if rep["quarantined_until"] > time.time():
            self.stats["quarantined"] += 1
            return
        if self._unchanged(path, st, rep):
            if rep["session_key"] is None:
                self._restore_identity(path, rep)
            self.stats["unchanged"] += 1
            return  # nothing new since the last clean pass, and the consumed bytes still match
        file_ident = tc.seed_identity(path, self.seed_roots)
        events, raw = [], []
        session_key = rep["session_key"]
        if session_key is None and rep["offset"]:
            session_key = self._key_from_raw(path, rep["rep_id"])
        pos = rep["offset"]
        line_no = rep["lines"]  # lines already journaled for this representation
        for line, end in tc.read_complete_lines(path, pos, max_bytes=tc.BATCH_BYTES):
            self.budget.check()
            line_no += 1
            pos = end
            try:
                rec = json.loads(line)
            except ValueError:
                rec = None
            raw.append((line, line_no))
            if rec is None:
                continue
            key_line = self._key_of_line(path, rec)
            session_key = tc.merge_session_key(session_key, key_line)
            if is_seeded(self.seeded, file_ident, line_no, key_line):
                self.stats["skipped_seeded"] += 1
                continue
            events.extend(project(rec, path, line_no))
        self._write(path, rep, pos, st, events, raw, line_no, session_key)

    def _key_from_raw(self, path, rep_id):
        key = None
        for (line,) in self.mem.execute("SELECT raw FROM native_capture_raw WHERE rep_id=? ORDER BY line_no", (rep_id,)):
            self.budget.check()
            try:
                key = tc.merge_session_key(key, self._key_of_line(path, json.loads(line)))
            except (ValueError, UnicodeDecodeError):
                continue
        return key

    def _restore_identity(self, path, rep):
        key = self._key_from_raw(path, rep["rep_id"])
        if key is not None:
            with_retry(self.mem, lambda: self.mem.execute(
                "UPDATE native_capture_files SET session_key=? WHERE rep_id=? AND session_key IS NULL",
                (key, rep["rep_id"])), budget=self.budget)

    def _write(self, path, rep, pos, st, events, raw, lines_total, session_key):
        def txn():
            if raw:
                self.mem.executemany(
                    "INSERT INTO native_capture_raw(source, path, rep_id, line_no, sha1, raw) VALUES(?,?,?,?,?,?)",
                    [(SOURCE, path, rep["rep_id"], ln, tc.raw_sha1(safe_line), sqlite3.Binary(safe_line))
                     for line, ln in raw for safe_line in [self.redactor.raw(line, session=session_key, capture_id=(SOURCE,tc.raw_sha1(line)))]],
                )
            if events:
                self.mem.executemany(
                    "INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,"
                    "content_type,model,tokens_used,metadata_json) VALUES (?,?,?,?,?,?,?,?,NULL,?)"
                    " ON CONFLICT(source,session_id,turn_id) DO NOTHING",
                    [(SOURCE, key, tid, ts, spk, safe_content, ctype, model, safe_meta)
                     for tid, ts, spk, ctype, content, model, m, key in events
                     for safe_content, safe_meta in [self.redactor.event(
                         SOURCE, key, tid, content, json.dumps(m, ensure_ascii=False))]],
                )
            tc.record_ok(self.mem, rep["rep_id"], pos, st.st_size, st.st_mtime, lines_total,
                         tail=tc.tail_sha1(path, pos) if pos else None,
                         instance=self._root_of(path)["instance"], session_key=session_key)

        with_retry(self.mem, txn, budget=self.budget)
        self.stats["rows"] += len(events)
        self.stats["raw"] += len(raw)

    def _fail(self, path, msg, key=None):
        """Durable per-file failure: counted, logged and quarantined, even on the first pass.

        The row is created from stat data alone (no head read), so an unreadable file
        cannot abort the run or escape the handler.
        """
        self.stats["errors"] += 1
        self.errors.append(f"{os.path.basename(path)}: {msg}")
        print(f"error in {path}: {msg}", flush=True)
        key = key or self.key_of(path)
        try:
            st = os.stat(path)
        except OSError:
            st = None
        row = self.mem.execute(
            "SELECT rep_id FROM native_capture_files WHERE logical=? AND retired=0 ORDER BY rep_id DESC LIMIT 1",
            (key,)).fetchone()
        if row is None and st is not None:
            def ins():
                now = int(time.time())
                cur = self.mem.execute(
                    "INSERT INTO native_capture_files(path, logical, inode, head_len, head_sha1, offset, phys_size,"
                    " mtime, instance, error, error_count, error_since, quarantined_until)"
                    " VALUES(?,?,?,0,NULL,0,?,?,?,?,1,?,?)",
                    (path, key, st.st_ino, st.st_size, st.st_mtime, self._root_of(path)["instance"],
                     str(msg)[:500], now, now + tc.QUARANTINE_SECS))
                return cur.lastrowid
            with_retry(self.mem, ins, budget=self.budget)
            return
        if row:
            with_retry(self.mem, lambda: tc.record_error(self.mem, row[0], msg), budget=self.budget)

    def run(self):
        try:
            return self._run()
        finally:
            checkpoint(self.mem)
            self.mem.close()

    def _run(self):
        t0 = time.time()
        for r in self.all_roots:
            if not r["exists"]:
                self.stats["missing_roots"].append(r["path"])
        for r in self.roots:
            if not os.path.isdir(r["path"]):
                continue
            if self.budget.expired() or (self.args.deadline and time.time() - t0 > self.args.deadline):
                self.stats["partial"] = True
                break
            files_before, errors_before = self.stats["files"], self.stats["errors"]
            finished = True
            for path in session_files(r["path"]):
                if self.budget.expired() or (self.args.deadline and time.time() - t0 > self.args.deadline):
                    print("soft deadline reached; rest next run", flush=True)
                    finished = False
                    self.stats["partial"] = True
                    break
                self.stats["files"] += 1
                try:
                    st = os.stat(path)
                    self.sync_file(path, st)
                except Exhausted:
                    finished = False
                    self.stats["partial"] = True
                    break
                except FileNotFoundError:
                    continue
                except sqlite3.OperationalError as e:
                    if self.budget.expired():
                        finished = False
                        self.stats["partial"] = True
                        break
                    if "locked" in str(e) or "busy" in str(e):
                        raise
                    self._fail(path, str(e))
                except Exception as e:  # noqa: BLE001 - one bad file must not block the others
                    self._fail(path, f"{type(e).__name__}: {str(e)[:200]}")
            if (finished and not self.budget.expired() and os.path.isdir(r["path"]) and
                    (not self.args.deadline or time.time() - t0 <= self.args.deadline)):
                with_retry(self.mem, lambda: tc.record_root_pass(
                    self.mem, r["instance"], r["path"], self.stats["files"] - files_before,
                    self.stats["errors"] - errors_before), budget=self.budget)
        self.stats["secs"] = round(time.time() - t0, 2)
        print("DONE", json.dumps(self.stats), flush=True)
        return self.stats


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--deadline", type=int, default=0, help="soft deadline (secs)")
    args = p.parse_args()
    stats = ClaudeSync(args).run()
    sys.exit(1 if stats["errors"] else 0)


if __name__ == "__main__":
    main()
