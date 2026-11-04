"""Capture Robob's Codex rollouts into memory.db (source 'codex').

Layout per root (transcript_roots.json, driver codex):
  sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
  archived_sessions/...                       (moved here later; same content)

Session key = SessionMeta.id (the thread id). SessionMeta.session_id is the
ROOT thread id and is kept in metadata. Subagent rollouts carry
subagent_history_start_ordinal (Codex 0.166 protocol: "first rollout ordinal
that belongs to this subagent's own projected history"; earlier records are
inherited model context). The ordinal counts rollout records, so every record
advances it and only the projection of records at or after it is kept.

Compressed rollouts (.jsonl.zst) are read through `zstd -dc`. If the binary is
missing the file is recorded as an error ("zstd missing") and the others
continue. A .zst file is checkpointed by its logical (decompressed) offset, so
an unchanged compressed file is a no-op.

turn_id = "<sha1 of the file's first line>:<line_no>:<item index>". The first
line is identical across an archive move or a .zst conversion, so re-reading
a moved or re-compressed rollout hits ON CONFLICT and adds nothing.

Resume replays the whole consumed prefix through the projector in batches (no
single-batch cap), so line numbers and ordinals stay correct past 8 MiB.
"""

import argparse
import hashlib
import json
import os
import sqlite3
import stat
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


def _physical_lines(path, start_offset=0):
    """Yield (line_bytes, end_offset_in_logical_bytes) for complete lines, from a plain or .zst rollout.

    Offsets are logical (uncompressed) bytes, so a .zst and its plain copy share
    one checkpoint. Reads are streamed; nothing is held beyond one batch.
    """
    if path.endswith(tc.ZST):
        zstd = tc.zstd_bin()
        if not zstd:
            raise FileNotFoundError("zstd missing")
        proc = subprocess.Popen([zstd, "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            pos = 0
            buf = b""
            while True:
                chunk = proc.stdout.read(1 << 20)
                if not chunk:
                    break
                buf += chunk
                while True:
                    j = buf.find(b"\n")
                    if j < 0:
                        break
                    line, buf = buf[: j + 1], buf[j + 1:]
                    pos += len(line)
                    if pos > start_offset:
                        yield line, pos
                    elif pos <= start_offset:
                        continue
            rc = proc.wait()
            if rc != 0:
                raise subprocess.CalledProcessError(rc, zstd)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            proc.stdout.close()
            proc.stderr.close()
        return
    yield from tc.read_complete_lines(path, start_offset, max_bytes=1 << 62)


def session_files(root, on_alias=None):
    for sub in ("sessions", "archived_sessions"):
        base = os.path.join(root, sub)
        try:
            mode = os.stat(base).st_mode
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(mode):
            raise NotADirectoryError(base)
        for dirpath, dirnames, filenames in os.walk(base, onerror=_walk_error):
            dirnames.sort()
            for name in sorted(filenames):
                if name.startswith("rollout-") and (name.endswith(".jsonl") or name.endswith(".jsonl.zst")):
                    path = os.path.join(dirpath, name)
                    if path.endswith(tc.ZST):
                        parts = os.path.relpath(path[:-len(tc.ZST)], root).split(os.sep)
                        plain_paths = [os.path.join(root, *parts)]
                        if parts[0] in ("sessions", "archived_sessions"):
                            parts[0] = "archived_sessions" if parts[0] == "sessions" else "sessions"
                            plain_paths.append(os.path.join(root, *parts))
                        if any(os.path.isfile(plain) and tc.compressed_equals_plain(path, plain)
                               for plain in plain_paths):
                            if on_alias:
                                on_alias()
                            continue
                    yield path


def _walk_error(error):
    raise error


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and isinstance(c.get("text"), str))
    return ""


def parse_ts(value):
    """Unix seconds from an ISO-8601 timestamp (with Z or an offset). None when unparseable."""
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


class ZstdMissing(RuntimeError):
    pass


class CodexProjector:
    """Per-rollout state: session identity, root id, the inherited-history boundary and item ordinals."""

    def __init__(self, file_hash):
        self.file_hash = file_hash
        self.session_id = None
        self.root_id = None
        self.model = None
        self.start_ordinal = 0
        self.ordinal = 0
        self.inherited = 0
        self._line_sha = None

    def feed(self, rec, line_no, line_sha=None):
        """Rows for one record: (turn_id, speaker, content_type, content, model, meta, timestamp).

        The inherited boundary is the record's own ordinal (see below), so records that
        produce no rows still move the position forward.
        """
        self._line_sha = line_sha
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
        # Paginated rollouts (Codex 0.166) write an explicit top-level "ordinal" on each record;
        # the subagent boundary is compared against that value. Legacy rollouts have none, and
        # the boundary does not apply to them, so the line counter is used only as a fallback.
        rec_ordinal = rec.get("ordinal")
        if isinstance(rec_ordinal, int) and not isinstance(rec_ordinal, bool):
            self.ordinal = rec_ordinal
        else:
            self.ordinal += 1
        if self.start_ordinal and self.ordinal < self.start_ordinal:
            self.inherited += 1
            return []  # inherited from the parent thread (before subagent_history_start_ordinal)
        ts = parse_ts(rec.get("timestamp"))
        if kind == "event_msg" and payload.get("type") == "error":
            msg = payload.get("message") if isinstance(payload.get("message"), str) else "error"
            return [self._row(line_no, 0, "system", "error", msg, {"kind": "error"}, ts)]
        if kind != "response_item":
            return []
        ptype = payload.get("type")
        rows = []
        if ptype == "message" and payload.get("role") in ("user", "assistant"):
            text = _text_of(payload.get("content"))
            if text.strip():
                role = payload["role"]
                rows.append(self._row(line_no, 0, role, "text", text, {"kind": role}, ts))
        elif ptype in ("function_call", "custom_tool_call"):
            args = payload.get("arguments") if ptype == "function_call" else payload.get("input")
            name = payload.get("name") if isinstance(payload.get("name"), str) else ""
            rows.append(self._row(line_no, 0, "assistant", "tool_call",
                                  name + "\n" + (args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)),
                                  {"kind": "tool_call", "tool": name, "call_id": payload.get("call_id")}, ts))
        elif ptype in ("function_call_output", "custom_tool_call_output"):
            out = payload.get("output")
            text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
            if text:
                rows.append(self._row(line_no, 0, "system", "tool_result", text,
                                      {"kind": "tool_result", "call_id": payload.get("call_id")}, ts))
        return rows

    def _row(self, line_no, idx, speaker, ctype, text, meta, ts):
        # The line's own bytes identify the event: an archive move or .zst conversion keeps the
        # bytes (same id, no duplicate), while a rewrite at the same position has different bytes
        # (a new event; the earlier one stays). Falls back to position when no bytes are given.
        anchor = self._line_sha or f"{self.file_hash}:{line_no}"
        turn_id = f"{anchor}:{self.ordinal}:{idx}"
        meta = dict(meta, root_session_id=self.root_id, native_id=self.session_id)
        return (turn_id, speaker, ctype, clip(text), self.model, meta, ts)


def _first_line_hash(path):
    if path.endswith(tc.ZST):
        gen = _physical_lines(path)
        try:
            first = next(gen, (b"", 0))[0]
        finally:
            gen.close()
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
        self.mem.execute("PRAGMA wal_autocheckpoint=0")
        self.mem.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, True)
        self.mem.execute("PRAGMA busy_timeout=600000")
        schema_migrations.migrate(self.mem)
        tc.ensure_schema(self.mem)
        self.seed_roots = list(self.roots) + list(self.all_roots)
        self.seeded = load_seeded(roots=self.seed_roots)
        self.stats = dict(files=0, rows=0, raw=0, skipped_inherited=0, skipped_seeded=0, errors=0,
                          quarantined=0, unchanged=0, missing_roots=[])
        self.errors = []

    def key_of(self, path):
        """Qualified identity: the home's configured instance plus the path below its root (realpaths)."""
        root = self._root_of(path)
        return f"{root['instance']}:{tc.logical_name(os.path.realpath(path), os.path.realpath(root['path']))}"

    def _root_of(self, path):
        real = os.path.realpath(path)
        for r in self.roots:
            base = os.path.realpath(r["path"])
            if real.startswith(base + os.sep):
                return r
        raise ValueError(f"{path} is outside every captured Codex home")

    @staticmethod
    def _zst_unchanged(known, st):
        """A .zst is written once and never edited in place, so its inode and size identify it.

        The shortcut is taken only when the last pass reached the end of the decompressed stream
        (complete). A pass killed partway leaves complete = 0 and the next tick finishes the file.
        """
        return bool(known and known["error"] is None and known["quarantined_until"] <= time.time()
                    and known["inode"] == st.st_ino and known["phys_size"] == st.st_size and known["offset"]
                    and known["complete"])

    def sync_file(self, path, st):
        key = self.key_of(path)
        instance = self._root_of(path)["instance"]
        if tc.quarantined(self.mem, key):
            with_retry(self.mem, lambda: tc.follow_quarantined_move(self.mem, path, key, instance))
            self.stats["quarantined"] += 1
            return
        if path.endswith(tc.ZST) and not tc.zstd_bin():
            raise ZstdMissing(path)  # recorded against the file's ledger row by run()
        if path.endswith(tc.ZST):
            known = self._latest(key)
            if self._zst_unchanged(known, st):
                if known["path"] != path or known["instance"] != instance:
                    def update_known():
                        self.mem.execute("UPDATE native_capture_files SET path=?, instance=? WHERE rep_id=?",
                                         (path, instance, known["rep_id"]))
                    with_retry(self.mem, update_known)
                if known["session_key"] is None:
                    self._restore_identity(known["rep_id"])
                self.stats["unchanged"] += 1
                return  # archive unchanged: no decode, no head probe, no re-journal
        rep = with_retry(self.mem, lambda: tc.open_representation(self.mem, path, st, key=key, instance=instance))
        if rep["quarantined_until"] > time.time():
            self.stats["quarantined"] += 1
            return
        if not path.endswith(tc.ZST) and self._plain_unchanged(path, st, rep):
            if rep["session_key"] is None:
                self._restore_identity(rep["rep_id"])
            self.stats["unchanged"] += 1
            return  # nothing new, and the consumed bytes still match the checkpoint
        self._capture(path, key, rep, st)

    def _latest(self, key):
        row = self.mem.execute(
            "SELECT rep_id, offset, phys_size, inode, error, quarantined_until, complete, session_key, path, instance FROM native_capture_files"
            " WHERE logical=? AND retired=0 ORDER BY rep_id DESC LIMIT 1", (key,)).fetchone()
        if not row:
            return None
        return dict(zip(("rep_id", "offset", "phys_size", "inode", "error", "quarantined_until", "complete",
                         "session_key", "path", "instance"), row))

    def _restore_identity(self, rep_id):
        key = None
        for (line,) in self.mem.execute("SELECT raw FROM native_capture_raw WHERE rep_id=? ORDER BY line_no", (rep_id,)):
            try:
                rec = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(rec, dict) and rec.get("type") == "session_meta" and isinstance(rec.get("payload"), dict):
                key = tc.merge_session_key(key, rec["payload"].get("id"))
        if key is not None:
            with_retry(self.mem, lambda: self.mem.execute(
                "UPDATE native_capture_files SET session_key=? WHERE rep_id=? AND session_key IS NULL", (key, rep_id)))

    @staticmethod
    def _plain_unchanged(path, st, rep):
        """Plain rollout unchanged: exact size, no error, and the consumed tail bytes still match."""
        if rep["error"] or rep["offset"] != st.st_size or not rep.get("tail_sha1"):
            return False
        return tc.tail_sha1(path, rep["offset"]) == rep["tail_sha1"]

    def _capture(self, path, key, rep, st):
        """Read complete lines in bounded batches; each batch commits its events, raw lines and checkpoint.

        The consumed prefix is replayed first (state only, no rows, unbounded but no writes) so
        session identity, the inherited boundary and line/ordinal numbering continue exactly.
        """
        file_ident = tc.seed_identity(path, self.seed_roots)
        file_hash = _first_line_hash(path)
        proj = CodexProjector(file_hash)
        session_key = rep["session_key"]
        line_no = 0
        pos = 0
        if rep["offset"]:
            for line, end in _physical_lines(path, 0):
                if end > rep["offset"]:
                    break
                line_no += 1
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    proj.feed(rec, line_no, line_sha=tc.raw_sha1(line))  # state only: same as the live path
                    session_key = tc.merge_session_key(session_key, proj.session_id)
            proj.inherited = 0
            pos = rep["offset"]
        batch_rows, batch_raw, batch_end, batch_bytes = [], [], pos, 0
        for line, end in _physical_lines(path, pos):
            line_no += 1
            batch_end = end
            batch_bytes += len(line)
            try:
                rec = json.loads(line)
            except ValueError:
                rec = None
            batch_raw.append((line, line_no))
            if rec is not None:
                if is_seeded(self.seeded, file_ident, line_no, proj.session_id):
                    proj.feed(rec, line_no)  # seeded: identity/ordinal state only
                    self.stats["skipped_seeded"] += 1
                else:
                    for row in proj.feed(rec, line_no, line_sha=tc.raw_sha1(line)):
                        batch_rows.append((proj.session_id, *row))
                session_key = tc.merge_session_key(session_key, proj.session_id)
            if batch_bytes >= tc.BATCH_BYTES:
                self._write(path, key, rep, batch_end, st, proj, batch_rows, batch_raw, line_no,
                            eof=False, session_key=session_key)
                batch_rows, batch_raw, batch_bytes = [], [], 0
        # Reached only when the loop read the stream to its end (a read or zstd error raises first).
        # The final commit marks the checkpoint complete. It also runs when the physical identity
        # changed: a plain rollout converted to .zst under the same name keeps its old inode
        # otherwise, the unchanged shortcut never fires, and every tick decodes the archive again.
        # An unchanged, complete file costs no write.
        if (batch_raw or batch_end != rep["offset"] or not rep.get("complete") or rep.get("inode") != st.st_ino
                or rep.get("error") or rep.get("error_count")
                or session_key != rep["session_key"]):
            self._write(path, key, rep, batch_end, st, proj, batch_rows, batch_raw, line_no,
                        eof=True, session_key=session_key)
        self.stats["skipped_inherited"] += proj.inherited

    def _write(self, path, logical, rep, pos, st, proj, events, raw, lines_total, eof=False, session_key=None):
        tail = ((tc.compressed_tail_sha1(path, pos) if path.endswith(tc.ZST) else tc.tail_sha1(path, pos))
                if pos else None)

        if pos and path.endswith(tc.ZST) and tail is None:
            raise ValueError("compressed stream shorter than capture checkpoint")

        def txn():
            if raw:
                self.mem.executemany(
                    "INSERT INTO native_capture_raw(source, path, rep_id, line_no, sha1, raw) VALUES(?,?,?,?,?,?)",
                    [(SOURCE, path, rep["rep_id"], ln, tc.raw_sha1(line), sqlite3.Binary(line))
                     for line, ln in raw],
                )
            if events:
                self.mem.executemany(
                    "INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,content,"
                    "content_type,model,tokens_used,metadata_json) VALUES (?,?,?,?,?,?,?,?,NULL,?)"
                    " ON CONFLICT(source,session_id,turn_id) DO NOTHING",
                     [(SOURCE, event_session, tid, ts or int(time.time()), spk, text, ctype, model,
                       json.dumps(m, ensure_ascii=False)) for event_session, tid, spk, ctype, text, model, m, ts in events],
                )
            tc.record_ok(self.mem, rep["rep_id"], pos, st.st_size, st.st_mtime, lines_total,
                         tail=tail,
                         complete=eof, inode=st.st_ino, instance=self._root_of(path)["instance"],
                         session_key=session_key, clear_error=eof)

        with_retry(self.mem, txn)
        self.stats["rows"] += len(events)
        self.stats["raw"] += len(raw)

    def _fail(self, path, msg):
        """Durable per-file failure: counted, logged, quarantined, and never raised.

        Works on the first pass too, when the file may be unreadable: the ledger row is
        created from stat data alone, so no read is needed to record the failure.
        """
        self.stats["errors"] += 1
        self.errors.append(f"{os.path.basename(path)}: {msg}")
        print(f"error in {path}: {msg}", flush=True)
        try:
            key = self.key_of(path)
        except (OSError, ValueError):
            return
        try:
            with_retry(self.mem, lambda: self._record_failure(path, key, msg))
        except Exception as e:  # noqa: BLE001 - recording must never abort the other files
            self.errors.append(f"{os.path.basename(path)}: could not record failure: {type(e).__name__}")

    def _record_failure(self, path, key, msg):
        row = self.mem.execute(
            "SELECT rep_id FROM native_capture_files WHERE logical=? AND retired=0 ORDER BY rep_id DESC LIMIT 1",
            (key,)).fetchone()
        if row:
            tc.record_error(self.mem, row[0], msg)
            return
        try:
            st = os.stat(path)
        except OSError:
            return  # gone entirely: nothing to quarantine
        now = int(time.time())
        cur = self.mem.execute(
            "INSERT INTO native_capture_files(path, logical, inode, head_len, head_sha1, offset, phys_size, mtime,"
            " error, error_count, error_since, quarantined_until, instance) VALUES(?,?,?,0,NULL,0,?,?,?,1,?,?,?)",
            (path, key, st.st_ino, st.st_size, st.st_mtime, str(msg)[:500], now, now + tc.QUARANTINE_SECS,
             self._root_of(path)["instance"]))
        return cur.lastrowid

    def run(self):
        t0 = time.time()
        for r in self.all_roots:
            if not r["exists"]:
                self.stats["missing_roots"].append(r["path"])
        for r in self.roots:
            if not os.path.isdir(r["path"]):
                continue
            if self.args.deadline and time.time() - t0 > self.args.deadline:
                break
            files_before, errors_before = self.stats["files"], self.stats["errors"]
            finished = True
            def skip_alias():
                self.stats["files"] += 1
                self.stats["unchanged"] += 1

            for path in session_files(r["path"], on_alias=skip_alias):
                if self.args.deadline and time.time() - t0 > self.args.deadline:
                    print("soft deadline reached; rest next run", flush=True)
                    finished = False
                    break
                self.stats["files"] += 1
                try:
                    st = os.stat(path)
                except FileNotFoundError:
                    continue  # moved between listing and stat: the archive move is picked up next tick
                try:
                    self.sync_file(path, st)
                except ZstdMissing:
                    self._fail(path, "zstd missing")
                except FileNotFoundError:
                    continue
                except sqlite3.OperationalError as e:
                    if "locked" in str(e) or "busy" in str(e):
                        raise  # shared write lock: the whole tick retries, not one file
                    self._fail(path, str(e))
                except subprocess.CalledProcessError as e:
                    self._fail(path, f"zstd failed rc={e.returncode}")
                except Exception as e:  # noqa: BLE001 - one bad file must not block the others
                    self._fail(path, f"{type(e).__name__}: {str(e)[:200]}")
            if (finished and os.path.isdir(r["path"]) and
                    (not self.args.deadline or time.time() - t0 <= self.args.deadline)):
                with_retry(self.mem, lambda: tc.record_root_pass(
                    self.mem, r["instance"], r["path"], self.stats["files"] - files_before,
                    self.stats["errors"] - errors_before))
        self.stats["secs"] = round(time.time() - t0, 2)
        self.mem.close()
        print("DONE", json.dumps(self.stats), flush=True)
        return self.stats


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--deadline", type=int, default=0, help="soft deadline (secs)")
    args = p.parse_args()
    stats = CodexSync(args).run()
    sys.exit(1 if stats["errors"] else 0)


if __name__ == "__main__":
    main()
