"""Capture Robob's Codex rollouts into memory.db (source 'codex').

Layout per root (transcript_roots.json, driver codex):
  sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
  archived_sessions/...                       (moved here later; same content)

Session key = SessionMeta.id (the thread id). SessionMeta.session_id is the
ROOT thread id and is kept in metadata. Subagent rollouts carry
subagent_history_start_ordinal: items before that ordinal are inherited
context from the parent and are not projected (they stay in the raw journal).

Compressed rollouts (.jsonl.zst, Codex 0.166+) are read through `zstd -dc`. If
the binary is missing the file is recorded as an error ("zstd missing") and
the others continue.

turn_id = "<sha1 of the file's first line>:<line_no>:<item index>". The first
line is identical across an archive move or a .zst conversion, so re-reading a
moved or re-compressed rollout hits ON CONFLICT and adds nothing.
"""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import schema_migrations  # noqa: E402
import transcript_capture as tc  # noqa: E402
import transcript_roots  # noqa: E402
from sync_claude import clip, is_seeded, load_seeded  # noqa: E402
from sync_opencode_v2 import with_retry  # noqa: E402

HOME = os.path.expanduser("~")
MEM_DB = os.environ.get("MEMORY_DB", os.path.join(HOME, ".local/share/memory-system/data/memory.db"))
SOURCE = "codex"
DRIVER = "codex"
ZSTD = os.environ.get("ZSTD_BIN") or shutil.which("zstd")


def read_lines(path, offset):
    """Yield (line_bytes, end_offset) for complete lines after offset, from a plain or .zst rollout."""
    if path.endswith(".zst"):
        if not ZSTD:
            raise FileNotFoundError("zstd missing")
        data = subprocess.run([ZSTD, "-dc", path], capture_output=True, check=True).stdout
        pos = offset
        i = offset
        while True:
            j = data.find(b"\n", i)
            if j < 0:
                return
            line = data[i:j + 1]
            i = j + 1
            pos = i
            yield line, pos
    else:
        yield from tc.read_complete_lines(path, offset)


def session_files(root):
    for sub in ("sessions", "archived_sessions"):
        base = os.path.join(root, sub)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort()
            for name in sorted(filenames):
                if name.startswith("rollout-") and (name.endswith(".jsonl") or name.endswith(".jsonl.zst")):
                    yield os.path.join(dirpath, name)


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and isinstance(c.get("text"), str))
    return ""


class CodexProjector:
    """Holds per-rollout state: session identity, root id and the inherited-history boundary."""

    def __init__(self, file_hash):
        self.file_hash = file_hash
        self.session_id = None
        self.root_id = None
        self.model = None
        self.start_ordinal = 0
        self.ordinal = 0
        self.inherited = 0

    def feed(self, rec, line_no):
        if not isinstance(rec, dict):
            return []
        kind = rec.get("type")
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        if kind == "session_meta":
            self.session_id = payload.get("id") if isinstance(payload.get("id"), str) else self.session_id
            self.root_id = payload.get("session_id") if isinstance(payload.get("session_id"), str) else self.session_id
            ordinal = payload.get("subagent_history_start_ordinal")
            self.start_ordinal = int(ordinal) if isinstance(ordinal, int) and ordinal > 0 else 0
            return []
        if kind == "turn_context" and isinstance(payload.get("model"), str):
            self.model = payload["model"]
            return []
        if not self.session_id:
            return []
        if kind == "event_msg" and payload.get("type") == "error":
            msg = payload.get("message") if isinstance(payload.get("message"), str) else "error"
            return [self._row(line_no, 0, "system", "error", msg, {"kind": "error"})]
        if kind != "response_item":
            return []
        self.ordinal += 1
        if self.ordinal <= self.start_ordinal:
            self.inherited += 1
            return []  # inherited from the parent thread
        ptype = payload.get("type")
        rows = []
        if ptype == "message" and payload.get("role") in ("user", "assistant"):
            text = _text_of(payload.get("content"))
            if text.strip():
                role = payload["role"]
                rows.append(self._row(line_no, 0, role, "text", text, {"kind": role}))
        elif ptype in ("function_call", "custom_tool_call"):
            args = payload.get("arguments") if ptype == "function_call" else payload.get("input")
            name = payload.get("name") if isinstance(payload.get("name"), str) else ""
            rows.append(self._row(line_no, 0, "assistant", "tool_call",
                                  name + "\n" + (args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)),
                                  {"kind": "tool_call", "tool": name, "call_id": payload.get("call_id")}))
        elif ptype in ("function_call_output", "custom_tool_call_output"):
            out = payload.get("output")
            text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
            if text:
                rows.append(self._row(line_no, 0, "system", "tool_result", text,
                                      {"kind": "tool_result", "call_id": payload.get("call_id")}))
        return rows

    def _row(self, line_no, idx, speaker, ctype, text, meta):
        turn_id = f"{self.file_hash}:{line_no}:{self.ordinal}:{idx}"
        meta = dict(meta, root_session_id=self.root_id, native_id=self.session_id)
        return (turn_id, speaker, ctype, clip(text), self.model, meta)


def _first_line_hash(path):
    if path.endswith(".zst"):
        if not ZSTD:
            raise FileNotFoundError("zstd missing")
        out = subprocess.run([ZSTD, "-dc", path], capture_output=True, check=True).stdout
        first = out.split(b"\n", 1)[0] + b"\n"
    else:
        with open(path, "rb") as f:
            first = f.readline()
    return hashlib.sha1(first).hexdigest()


class CodexSync:
    def __init__(self, args, roots=None):
        self.args = args
        self.roots = roots if roots is not None else [
            r for r in transcript_roots.existing() if r["driver"] == DRIVER]
        self.all_roots = [r for r in transcript_roots.resolve() if r["driver"] == DRIVER]
        self.mem = sqlite3.connect(MEM_DB, timeout=600)
        self.mem.execute("PRAGMA busy_timeout=600000")
        schema_migrations.migrate(self.mem)
        tc.ensure_schema(self.mem)
        self.seeded = load_seeded()
        self.stats = dict(files=0, rows=0, raw=0, skipped_inherited=0, skipped_seeded=0, errors=0,
                          quarantined=0, missing_roots=[])
        self.errors = []

    def sync_file(self, path, st):
        rep = tc.open_representation(self.mem, path, st)
        if rep["quarantined_until"] > time.time():
            self.stats["quarantined"] += 1
            return
        if rep["offset"] == st.st_size and rep["size"] == st.st_size and not rep["error"]:
            return
        file_hash = _first_line_hash(path)
        proj = CodexProjector(file_hash)
        events, raw, pos = [], [], 0
        line_no = 0
        if rep["offset"]:
            # Resume: replay the consumed prefix through the projector (state only, no
            # events or raw lines) so session identity and the inherited boundary are known.
            for line, end in read_lines(path, 0):
                if end > rep["offset"]:
                    break
                line_no += 1
                try:
                    proj.feed(json.loads(line), line_no)
                except ValueError:
                    pass
            proj.inherited = 0  # counted in the earlier pass; don't double-count on resume
            pos = rep["offset"]
        for line, end in read_lines(path, pos):
            line_no += 1
            pos = end
            try:
                rec = json.loads(line)
            except ValueError:
                raw.append((line, line_no))
                continue
            raw.append((line, line_no))
            if is_seeded(self.seeded, path, line_no, proj.session_id):
                self.stats["skipped_seeded"] += 1
                continue
            for turn_id, speaker, ctype, text, model, meta in proj.feed(rec, line_no):
                events.append((turn_id, speaker, ctype, text, model, meta))
        self.stats["skipped_inherited"] += proj.inherited
        self._write(path, rep, pos, st, proj, events, raw)

    def _write(self, path, rep, pos, st, proj, events, raw):
        def txn():
            if raw:
                self.mem.executemany(
                    "INSERT INTO native_capture_raw(source, path, rep_id, line_no, sha1, raw) VALUES(?,?,?,?,?,?)",
                    [(SOURCE, path, rep["rep_id"], ln, tc.raw_sha1(line), line.decode("utf-8", "replace"))
                     for line, ln in raw],
                )
            if events and proj.session_id:
                self.mem.executemany(
                    "INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,"
                    "content_type,model,tokens_used,metadata_json) VALUES (?,?,?,?,?,?,?,?,NULL,?)"
                    " ON CONFLICT(source,session_id,turn_id) DO NOTHING",
                    [(SOURCE, proj.session_id, tid, int(time.time()), spk, text, ctype, model,
                      json.dumps(m, ensure_ascii=False)) for tid, spk, ctype, text, model, m in events],
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
                except FileNotFoundError as e:
                    if "zstd missing" in str(e):
                        self.stats["errors"] += 1
                        self.errors.append(f"{os.path.basename(path)}: zstd missing")
                    continue
                except subprocess.CalledProcessError as e:
                    self._fail(path, f"zstd failed rc={e.returncode}")
                except sqlite3.OperationalError as e:
                    if "locked" in str(e) or "busy" in str(e):
                        raise
                    self._fail(path, str(e))
                except Exception as e:  # noqa: BLE001 - one bad file must not block the others
                    self._fail(path, f"{type(e).__name__}: {str(e)[:200]}")
        self.stats["secs"] = round(time.time() - t0, 2)
        self.mem.close()
        print("DONE", json.dumps(self.stats), flush=True)
        return self.stats

    def _fail(self, path, msg):
        self.stats["errors"] += 1
        self.errors.append(f"{os.path.basename(path)}: {msg}")
        print(f"error in {path}: {msg}", flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--deadline", type=int, default=0, help="soft deadline (secs)")
    args = p.parse_args()
    stats = CodexSync(args).run()
    sys.exit(1 if stats["errors"] else 0)


if __name__ == "__main__":
    main()
