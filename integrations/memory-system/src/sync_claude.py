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
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schema_migrations  # noqa: E402
import transcript_capture as tc  # noqa: E402
import transcript_roots  # noqa: E402
from sync_opencode_v2 import with_retry  # noqa: E402

HOME = os.path.expanduser("~")
MEM_DB = os.environ.get("MEMORY_DB", os.path.join(HOME, ".local/share/memory-system/data/memory.db"))
SEEDED = os.environ.get("HARNESS_SEEDED_MANIFEST", os.path.join(HOME, ".robob/harness-migrate/seeded.jsonl"))
SOURCE = "claude"
DRIVER = "claudeAgent"
MAX_CONTENT = 1 << 20
RECALL_PREFIX = "<recall>"


def clip(text):
    if text is None:
        return ""
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)
    return text if len(text) <= MAX_CONTENT else text[:MAX_CONTENT] + "\n[truncated]"


def load_seeded(path=SEEDED):
    """{native_session_id: [(first_line, last_line, file_name|None), ...]} from an optional JSONL manifest.

    The card that writes seeded.jsonl owns its format; a missing file means
    nothing is seeded, and a malformed line is ignored rather than fatal.
    """
    out = {}
    try:
        f = open(path)
    except FileNotFoundError:
        return out
    with f:
        for line in f:
            try:
                e = json.loads(line)
                out.setdefault(e["native_session_id"], []).append(
                    (int(e["first_line"]), int(e["last_line"]), e.get("path") and os.path.basename(e["path"])))
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
    if not os.path.isdir(proj):
        return
    for slug in sorted(os.listdir(proj)):
        d = os.path.join(proj, slug)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if name.endswith(".jsonl") and os.path.isfile(p):
                yield p
        for dirpath, dirnames, filenames in os.walk(d):
            dirnames.sort()
            if os.path.basename(dirpath) != "subagents":
                continue
            for name in sorted(filenames):
                if name.startswith("agent-") and name.endswith(".jsonl"):
                    yield os.path.join(dirpath, name)


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
    key = session_key(sid, agent)
    ts_raw = rec.get("timestamp")
    ts = int(time.mktime(time.strptime(ts_raw[:19], "%Y-%m-%dT%H:%M:%S"))) if isinstance(ts_raw, str) and len(ts_raw) >= 19 else int(time.time())
    base = {"file": os.path.basename(path), "line": line_no, "cwd": rec.get("cwd"), "parent_session": sid,
            "agent_id": agent, "sidechain": bool(rec.get("isSidechain"))}
    model = msg.get("model") if isinstance(msg.get("model"), str) else None
    rows = []
    for i, b in enumerate(_blocks(msg)):
        t = b.get("type")
        tid = f"{uuid}:{i}"
        if t == "text" and isinstance(b.get("text"), str) and b["text"].strip():
            text = b["text"]
            if role == "user" and text.lstrip().startswith(RECALL_PREFIX):
                continue
            rows.append((tid, ts, role, "text", clip(text), model, dict(base, kind=role), key))
        elif t == "thinking" and isinstance(b.get("thinking"), str) and b["thinking"].strip():
            rows.append((tid, ts, "assistant", "text", clip(b["thinking"]), model, dict(base, kind="thinking"), key))
        elif t == "tool_use":
            name = b.get("name") if isinstance(b.get("name"), str) else ""
            args = json.dumps(b.get("input"), ensure_ascii=False) if b.get("input") is not None else ""
            rows.append((tid, ts, "assistant", "tool_call", clip(name + "\n" + args), model,
                         dict(base, kind="tool_call", tool=name, call_id=b.get("id")), key))
        elif t == "tool_result":
            text = _tool_result_text(b)
            if not text:
                continue
            ctype = "error" if b.get("is_error") else "tool_result"
            rows.append((tid, ts, "system", ctype, clip(text), None,
                         dict(base, kind=ctype, call_id=b.get("tool_use_id")), key))
    return rows


def is_seeded(seeded, path, line_no, sid):
    """True when this line sits in a seeded (transplanted) range for its native session.

    Ranges are keyed by native session id and match on file name, so a
    re-homed copy of the same transcript is still recognised.
    """
    if not isinstance(sid, str):
        return False
    base = os.path.basename(path)
    for first, last, file_hint in seeded.get(sid, ()):
        if (not file_hint or file_hint == base) and first <= line_no <= last:
            return True
    return False


class ClaudeSync:
    def __init__(self, args, roots=None):
        self.args = args
        self.roots = roots if roots is not None else transcript_roots.existing(
            [e for e in transcript_roots.load() if e["driver"] == DRIVER])
        self.all_roots = [r for r in transcript_roots.resolve() if r["driver"] == DRIVER]
        self.mem = sqlite3.connect(MEM_DB, timeout=600)
        self.mem.execute("PRAGMA busy_timeout=600000")
        schema_migrations.migrate(self.mem)
        tc.ensure_schema(self.mem)
        self.seeded = load_seeded()
        self.stats = dict(files=0, rows=0, raw=0, skipped_seeded=0, errors=0, quarantined=0, missing_roots=[])
        self.errors = []

    def sync_file(self, path, st):
        rep = tc.open_representation(self.mem, path, st)
        if rep["quarantined_until"] > time.time():
            self.stats["quarantined"] += 1
            return
        if rep["offset"] == st.st_size and rep["size"] == st.st_size and not rep["error"]:
            return  # nothing new since the last clean pass
        first_line = self._line_of(path, rep["offset"])  # lines already consumed
        events, raw, pos = [], [], rep["offset"]
        try:
            for line, end in tc.read_complete_lines(path, rep["offset"]):
                first_line += 1
                pos = end
                try:
                    rec = json.loads(line)
                except ValueError:
                    raw.append((line, first_line, None))
                    continue
                raw.append((line, first_line, rec))
                rec_sid = rec.get("sessionId") if isinstance(rec, dict) else None
                if is_seeded(self.seeded, path, first_line, rec_sid):
                    self.stats["skipped_seeded"] += 1
                    continue
                events.extend(project(rec, path, first_line))
        except OSError as e:
            tc.record_error(self.mem, rep["rep_id"], f"read: {e}")
            self.stats["errors"] += 1
            self.errors.append(f"{os.path.basename(path)}: {e}")
            return
        self._write(path, rep, pos, st, events, raw)

    def _line_of(self, path, offset):
        """Lines before a byte offset (the raw journal numbers lines from 1)."""
        if offset == 0:
            return 0
        with open(path, "rb") as f:
            return f.read(offset).count(b"\n")

    def _write(self, path, rep, pos, st, events, raw):
        def txn():
            if raw:
                self.mem.executemany(
                    "INSERT INTO native_capture_raw(source, path, rep_id, line_no, sha1, raw) VALUES(?,?,?,?,?,?)",
                    [(SOURCE, path, rep["rep_id"], ln, tc.raw_sha1(line),
                      line.decode("utf-8", "replace")) for line, ln, _ in raw],
                )
            if events:
                self.mem.executemany(
                    "INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,"
                    "content_type,model,tokens_used,metadata_json) VALUES (?,?,?,?,?,?,?,?,NULL,?)"
                    " ON CONFLICT(source,session_id,turn_id) DO NOTHING",
                    [(SOURCE, key, tid, ts, spk, content, ctype, model, json.dumps(m, ensure_ascii=False))
                     for tid, ts, spk, ctype, content, model, m, key in events],
                )
            tc.record_ok(self.mem, rep["rep_id"], pos, st.st_size, st.st_mtime)

        with_retry(self.mem, txn)
        self.stats["rows"] += len(events)
        self.stats["raw"] += len(raw)

    def run(self):
        t0 = time.time()
        for r in self.all_roots:
            if not r["exists"]:
                self.stats["missing_roots"].append(r["path"])
        for r in self.roots:
            for path in session_files(r["path"]):
                if self.args.deadline and time.time() - t0 > self.args.deadline:
                    print("soft deadline reached; rest next run", flush=True)
                    break
                self.stats["files"] += 1
                try:
                    st = os.stat(path)
                    self.sync_file(path, st)
                except FileNotFoundError:
                    continue
                except sqlite3.OperationalError as e:
                    if "locked" in str(e) or "busy" in str(e):
                        raise
                    self.stats["errors"] += 1
                    self.errors.append(f"{os.path.basename(path)}: {e}")
                except Exception as e:  # noqa: BLE001 - one bad file must not block the others
                    self.stats["errors"] += 1
                    self.errors.append(f"{os.path.basename(path)}: {type(e).__name__}: {str(e)[:200]}")
                    print(f"error in {path}: {type(e).__name__}: {e}", flush=True)
        self.stats["secs"] = round(time.time() - t0, 2)
        self.mem.close()
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
