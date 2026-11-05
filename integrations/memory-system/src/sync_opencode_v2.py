#!/usr/bin/env python3
"""Continuous importer for native OpenCode 2 sessions.

Reads session_v2 / session_message from an OpenCode-owned export and
keeps two things current:

1. data/opencode_raw.db  - exact copy of every native session_message.data and
   session_v2 row (zlib), upserted whenever the source row changes. This is the
   lossless archive; migrated (codex/hermes) sessions are skipped because their
   canonical copies live in codex_raw.db / the hermes import.
2. memory.db episodic_events - searchable projection, source='opencode'.
   Per message: main row turn_id=<msg_id>; extra rows <msg_id>.r (reasoning),
   <msg_id>.t<i> (tool call), <msg_id>.o<i> (tool output), <msg_id>.e (error).

Messages mutate while streaming, so only settled messages are projected
(user/system types, assistant with time.completed or error, or untouched for
SETTLE_SECS). A message is re-projected when its payload or time_updated changes,
or its session export fence has not finished projecting.

A session is rescanned when its time_updated, message count, max seq or applied
export sequence changes. The export sequence catches same-millisecond payload
rewrites that leave the other fingerprints unchanged. Progress tables start
empty, so the first runs rescan every session once. This is resumable:
each finished session is recorded as it completes, and --deadline still stops
between sessions.

One failing session is logged and not stamped (so the next run retries it), the
run continues with the rest, and the process exits 1.

Messages already present in memory from the v1 import (turn_id=<msg_id>, not in
the sync ledger) are adopted as legacy rows and left alone unless they change.

Safe to run repeatedly (launchd). Short write transactions with BEGIN IMMEDIATE
and busy retries so it can coexist with the fact extractor.
"""

import argparse
import base64
import hashlib
import json
import os
import sqlite3
import sys
import time
import traceback
import zlib

import robob_readonly

HOME = os.path.expanduser("~")
MEM_DB = os.environ.get("MEMORY_DB", os.path.join(HOME, ".local/share/memory-system/data/memory.db"))
RAW_DB = os.environ.get("OPENCODE_RAW_DB", os.path.join(HOME, ".local/share/memory-system/data/opencode_raw.db"))
SRC_DB = robob_readonly.opencode_db()
SOURCE = "opencode"
SETTLE_SECS = 600
IMAGE_MIN_LEN = 256
BATCH_MESSAGES = 200


def now_ms():
    return int(time.time() * 1000)


def is_native(metadata):
    if not metadata:
        return True
    try:
        m = json.loads(metadata)
    except ValueError:
        return True
    return not (isinstance(m, dict) and m.get("migration"))


class Attachments:
    def __init__(self, db):
        self.db = db
        self.new = 0

    def intern(self, data_url):
        head, _, b64 = data_url.partition(",")
        mime = head[5:].split(";")[0] if head.startswith("data:") else None
        digest = hashlib.sha256(b64.encode("ascii", "ignore")).hexdigest()
        if not self.db.execute("SELECT 1 FROM attachments WHERE sha256=?",
                               (digest,)).fetchall():
            try:
                blob = base64.b64decode(b64, validate=False)
            except Exception:
                blob = b64.encode("ascii", "ignore")
            self.db.execute(
                "INSERT OR IGNORE INTO attachments(sha256,mime,size,data,first_seen)"
                " VALUES (?,?,?,?,?)", (digest, mime, len(blob), blob, int(time.time())))
            self.new += 1
        return "att:sha256:" + digest

    def scrub(self, obj):
        """Replace long data: URLs / bare base64 image payloads with refs."""
        if isinstance(obj, str):
            if obj.startswith("data:") and len(obj) > IMAGE_MIN_LEN:
                return self.intern(obj)
            return obj
        if isinstance(obj, list):
            return [self.scrub(x) for x in obj]
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                if (k == "data" and isinstance(v, str) and len(v) > IMAGE_MIN_LEN
                        and isinstance(obj.get("mime"), str)):
                    out[k] = self.intern("data:{};base64,{}".format(obj["mime"], v))
                else:
                    out[k] = self.scrub(v)
            return out
        return obj


def text_of(items):
    out = []
    for it in items or []:
        if isinstance(it, dict) and it.get("type") == "text" and it.get("text"):
            out.append(it["text"])
        elif isinstance(it, dict) and it.get("type") == "file":
            out.append("[file {} {}]".format(it.get("mime") or "", it.get("uri") or ""))
    return "\n".join(out)


def clean_text(s):
    # json.loads turns a lone \udXXX escape into a lone surrogate, which sqlite
    # can't encode; re-pair valid halves and replace lone ones with U+FFFD
    try:
        s.encode("utf-8")
        return s
    except UnicodeEncodeError:
        return s.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def settled(mtype, data, time_updated):
    if mtype != "assistant":
        return True
    t = data.get("time") or {}
    if t.get("completed") or data.get("error"):
        return True
    return time_updated < now_ms() - SETTLE_SECS * 1000


def project(msg_id, mtype, data, sess, att):
    """Return list of (turn_id, speaker, content_type, content, model, tokens, meta)."""
    data = att.scrub(data)
    base = {"msg_id": msg_id, "type": mtype, "raw_sidecar": "opencode_raw",
            "dir": sess.get("directory"), "title": sess.get("title")}
    rows = []
    if mtype == "user":
        parts = [data.get("text") or ""]
        for f in data.get("files") or []:
            if isinstance(f, dict):
                parts.append("[file {} {} {}]".format(
                    f.get("name") or "", f.get("mime") or "", f.get("data") or ""))
        rows.append((msg_id, "user", "text", "\n".join(p for p in parts if p),
                     None, None, dict(base, kind="user")))
    elif mtype == "assistant":
        model = (data.get("model") or {}).get("id")
        tk = data.get("tokens") or {}
        tokens = None
        if isinstance(tk, dict):
            tokens = (tk.get("input") or 0) + (tk.get("output") or 0) + (tk.get("reasoning") or 0)
        meta = dict(base, kind="assistant", agent=data.get("agent"),
                    provider=(data.get("model") or {}).get("providerID"),
                    variant=(data.get("model") or {}).get("variant"),
                    finish=data.get("finish"), cost=data.get("cost"))
        texts, reasons, ti = [], [], 0
        tool_rows = []
        for it in data.get("content") or []:
            if not isinstance(it, dict):
                continue
            t = it.get("type")
            if t == "text" and it.get("text"):
                texts.append(it["text"])
            elif t == "reasoning" and it.get("text"):
                reasons.append(it["text"])
            elif t == "tool":
                st = it.get("state") or {}
                name = it.get("name") or ""
                inp = st.get("input")
                call = name + "\n" + (json.dumps(inp, ensure_ascii=False)
                                      if not isinstance(inp, str) else inp)
                tmeta = dict(base, kind="tool_call", tool=name, call_id=it.get("id"),
                             status=st.get("status"))
                tool_rows.append(("{}.t{}".format(msg_id, ti), "assistant", "tool_call",
                                  call, model, None, tmeta))
                out = text_of(st.get("content"))
                err = st.get("error")
                if err:
                    out = (out + "\n" if out else "") + "[error] " + (
                        json.dumps(err, ensure_ascii=False) if not isinstance(err, str) else err)
                if out:
                    tool_rows.append(("{}.o{}".format(msg_id, ti), "system", "tool_result",
                                      out, None, None, dict(tmeta, kind="tool_result")))
                ti += 1
        rows.append((msg_id, "assistant", "text", "\n".join(texts), model, tokens, meta))
        if reasons:
            rows.append((msg_id + ".r", "assistant", "text", "\n".join(reasons), model,
                         None, dict(base, kind="reasoning")))
        rows.extend(tool_rows)
        if data.get("error"):
            e = data["error"]
            rows.append((msg_id + ".e", "system", "error",
                         json.dumps(e, ensure_ascii=False) if not isinstance(e, str) else e,
                         model, None, dict(base, kind="error")))
    elif mtype == "compaction":
        rows.append((msg_id, "system", "text", data.get("summary") or "", None, None,
                     dict(base, kind="compaction", status=data.get("status"),
                          reason=data.get("reason"))))
    elif mtype == "synthetic":
        rows.append((msg_id, "system", "text", data.get("text") or "", None, None,
                     dict(base, kind="synthetic", synthetic=data.get("metadata"))))
    else:
        rows.append((msg_id, "system", "text",
                     json.dumps(data, ensure_ascii=False), None, None,
                     dict(base, kind="opencode_" + mtype)))
    return rows


def with_retry(db, fn, tries=120):
    for i in range(tries):
        try:
            if db.in_transaction:
                db.commit()
            db.execute("BEGIN IMMEDIATE")
            r = fn()
            db.commit()
            return r
        except Exception as e:
            if db.in_transaction:
                db.rollback()  # never leave the write lock held on a failure
            if not isinstance(e, sqlite3.OperationalError) or ("locked" not in str(e) and "busy" not in str(e)):
                raise
            time.sleep(min(1 + i, 20))
    raise RuntimeError("database busy after retries")


class Sync:
    def __init__(self, args):
        self.args = args
        # OpenCode's session/message schema is separate from the Robob export.
        # Neither native OpenCode nor Robob live DB aliases are allowed here.
        self.src = robob_readonly.native_ro(SRC_DB, timeout=60)
        self.src.execute("PRAGMA busy_timeout=60000")
        self.raw = sqlite3.connect(RAW_DB, timeout=600)
        self.raw.execute("PRAGMA journal_mode=WAL")
        self.raw.execute("PRAGMA busy_timeout=600000")
        self.raw.executescript("""
            CREATE TABLE IF NOT EXISTS raw_messages(
              id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
              time_created INTEGER, time_updated INTEGER,
              sha256 TEXT, raw_size INTEGER, data_zlib BLOB);
            CREATE INDEX IF NOT EXISTS idx_raw_messages_session
              ON raw_messages(session_id, seq);
            CREATE TABLE IF NOT EXISTS raw_sessions(
              id TEXT PRIMARY KEY, time_updated INTEGER, row_json_zlib BLOB);
        """)
        self.mem = sqlite3.connect(MEM_DB, timeout=600)
        self.mem.execute("PRAGMA busy_timeout=600000")
        self.mem.executescript("""
            CREATE TABLE IF NOT EXISTS opencode_sync_messages(
              msg_id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER,
              projected INTEGER, legacy INTEGER, synced_at INTEGER);
            CREATE INDEX IF NOT EXISTS idx_opencode_sync_messages_session
              ON opencode_sync_messages(session_id);
            CREATE TABLE IF NOT EXISTS opencode_sync_sessions(
              session_id TEXT PRIMARY KEY, native INTEGER, time_updated INTEGER,
              synced_at INTEGER);
            CREATE TABLE IF NOT EXISTS opencode_sync_progress(
              session_id TEXT PRIMARY KEY, max_seq INTEGER NOT NULL,
              msg_count INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS opencode_sync_export_progress(
              session_id TEXT PRIMARY KEY, applied_seq INTEGER NOT NULL);
        """)
        self.mem.commit()
        self.att = Attachments(self.mem)
        self.stats = dict(sessions=0, raw_upserts=0, projected=0, reprojected=0,
                          legacy=0, unsettled=0, rows=0, errors=0, failed=[])

    # ------------------------------------------------------------ source reads
    def changed_sessions(self):
        robob_readonly.refresh_native(self.src)
        cols = [r[1] for r in self.src.execute("PRAGMA table_info(session_v2)")]
        rows = self.src.execute(
            "SELECT s.*,e.applied_seq FROM session_v2 s JOIN ardud_native_sessions e ON e.id=s.id"
            " WHERE e.applied_seq IS NOT NULL AND e.dirty=0").fetchall()
        known = dict(self.mem.execute(
            "SELECT session_id, time_updated FROM opencode_sync_sessions").fetchall())
        # session_v2.time_updated does not move when messages are appended, so
        # the (max seq, message count) fingerprint is what catches new messages
        src_fp = {sid: (mx, n) for sid, mx, n in self.src.execute(
            "SELECT session_id, MAX(seq), COUNT(*) FROM session_message GROUP BY session_id")
            .fetchall()}
        self.src.commit()
        have_fp = {sid: (mx, n) for sid, mx, n in self.mem.execute(
            "SELECT session_id, max_seq, msg_count FROM opencode_sync_progress").fetchall()}
        have_export = dict(self.mem.execute(
            "SELECT session_id,applied_seq FROM opencode_sync_export_progress").fetchall())
        out = []
        for r in rows:
            d = dict(zip(cols + ["_export_seq"], r))
            fp = src_fp.get(d["id"], (0, 0))
            if (known.get(d["id"]) == d["time_updated"] and have_fp.get(d["id"]) == fp
                    and have_export.get(d["id"]) == d["_export_seq"]
                    and not self.args.full):
                continue
            d["_fp"] = fp
            out.append(d)
        return out

    def session_messages(self, sid, page=300, export_seq=None):
        """Yield pages ordered by seq; some sessions carry 500+ MB of data."""
        last = -1
        while True:
            robob_readonly.refresh_native(self.src)
            current_seq = robob_readonly.native_capture_generation(self.src, sid)
            if export_seq is not None and current_seq != export_seq:
                raise robob_readonly.UnsafeStateDatabase("native session export changed during capture; retry next run")
            export_seq = current_seq
            rows = self.src.execute(
                "SELECT id, type, seq, time_created, time_updated, data FROM session_message"
                " WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?",
                (sid, last, page)).fetchall()
            self.src.commit()
            if not rows:
                return
            yield rows
            last = rows[-1][2]

    # ------------------------------------------------------------ processing
    def sync_session(self, sess):
        sid = sess["id"]
        robob_readonly.refresh_native(self.src)
        export_seq = robob_readonly.native_capture_generation(self.src, sid)
        if export_seq != sess.get("_export_seq", export_seq):
            raise robob_readonly.UnsafeStateDatabase("native session export changed since planning; retry next run")
        native = is_native(sess.get("metadata"))
        fp = sess.get("_fp") or (0, 0)
        if not native:
            with_retry(self.mem, lambda: self._stamp(sid, 0, sess["time_updated"], fp, export_seq))
            return
        self.stats["sessions"] += 1
        ledger = dict((m, (tu, p, lg)) for m, tu, p, lg in self.mem.execute(
            "SELECT msg_id, time_updated, projected, legacy FROM opencode_sync_messages"
            " WHERE session_id=?", (sid,)).fetchall())
        raw_have = {mid: (tu, digest) for mid, tu, digest in self.raw.execute(
            "SELECT id,time_updated,sha256 FROM raw_messages WHERE session_id=?", (sid,)).fetchall()}
        previous_export = self.mem.execute(
            "SELECT applied_seq FROM opencode_sync_export_progress WHERE session_id=?", (sid,)).fetchone()
        # Raw writes commit before projections. If a run stopped between them,
        # matching raw hashes alone cannot prove an old projection is current.
        reproject_revision = previous_export is None or previous_export[0] != export_seq
        all_settled = True
        for msgs in self.session_messages(sid, export_seq=export_seq):
            # raw archive (every native message, settled or not)
            raw_batch = []
            payload_hashes = {}
            for mid, mtype, seq, tc, tu, data in msgs:
                b = data.encode("utf-8")
                digest = payload_hashes[mid] = hashlib.sha256(b).hexdigest()
                if raw_have.get(mid) != (tu, digest):
                    raw_batch.append((mid, sid, mtype, seq, tc, tu,
                                      digest, len(b),
                                      zlib.compress(b, 6)))
            if raw_batch:
                with_retry(self.raw, lambda: self.raw.executemany(
                    "INSERT OR REPLACE INTO raw_messages VALUES (?,?,?,?,?,?,?,?,?)",
                    raw_batch))
                self.stats["raw_upserts"] += len(raw_batch)
            # projection
            todo = []
            for mid, mtype, seq, tc, tu, data in msgs:
                led = ledger.get(mid)
                if (led and led[0] == tu and raw_have.get(mid) == (tu, payload_hashes[mid])
                        and not reproject_revision):
                    continue
                try:
                    d = json.loads(data)
                except ValueError:
                    d = {"unparsed": data}
                if not settled(mtype, d, tu):
                    self.stats["unsettled"] += 1
                    all_settled = False
                    continue
                todo.append((mid, mtype, seq, tc, tu, d, led))
            for i in range(0, len(todo), BATCH_MESSAGES):
                chunk = todo[i:i + BATCH_MESSAGES]
                with_retry(self.mem, lambda: self._project_chunk(sid, sess, chunk))
        srow = json.dumps({k: v for k, v in sess.items() if k not in ("_fp", "_export_seq")},
                         ensure_ascii=False).encode("utf-8")
        with_retry(self.raw, lambda: self.raw.execute(
            "INSERT OR REPLACE INTO raw_sessions VALUES (?,?,?)",
            (sid, sess["time_updated"], zlib.compress(srow, 6))))
        stamp = sess["time_updated"] if all_settled else -1
        with_retry(self.mem, lambda: self._stamp(sid, 1, stamp, fp, export_seq))

    def _stamp(self, sid, native, stamp, fp, export_seq):
        # Caller holds BEGIN IMMEDIATE. A -1 stamp (unsettled message) writes no
        # progress row, so the session is retried on the next run.
        self.mem.execute(
            "INSERT OR REPLACE INTO opencode_sync_sessions VALUES (?,?,?,?)",
            (sid, native, stamp, int(time.time())))
        if stamp != -1:
            self.mem.execute(
                "INSERT OR REPLACE INTO opencode_sync_progress VALUES (?,?,?)",
                (sid, fp[0], fp[1]))
            self.mem.execute(
                "INSERT OR REPLACE INTO opencode_sync_export_progress VALUES (?,?)", (sid, export_seq))

    def _project_chunk(self, sid, sess, chunk):
        m = self.mem
        for mid, mtype, seq, tc, tu, d, led in chunk:
            # One range over the unique (source, session_id, turn_id) index.
            # An OR here makes SQLite scan the whole session per message.
            # '/' sorts right after '.', so the range covers mid and mid.*;
            # the filter drops other ids that merely share the prefix.
            old = [(i, t) for i, t in m.execute(
                "SELECT id, turn_id FROM episodic_events WHERE source=? AND session_id=?"
                " AND turn_id>=? AND turn_id<?",
                (SOURCE, sid, mid, mid + "/")).fetchall()
                if t == mid or t.startswith(mid + ".")]
            if old and led is None:
                # imported earlier from the v1 tables (that projection dropped
                # assistant text whenever a message also had tool parts);
                # replace it with the full v2 projection
                self.stats["legacy"] += 1
            if old:
                m.executemany("DELETE FROM episodic_events WHERE id=?", [(o[0],) for o in old])
                self.stats["reprojected"] += 1
            else:
                self.stats["projected"] += 1
            rows = project(mid, mtype, d, sess, self.att)
            ts = tc // 1000
            for turn_id, speaker, ctype, content, model, tokens, meta in rows:
                meta = dict(meta, seq=seq)
                m.execute(
                    "INSERT INTO episodic_events(source,session_id,turn_id,timestamp,speaker,"
                    "content,content_type,model,tokens_used,metadata_json)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (SOURCE, sid, turn_id, ts, speaker, clean_text(content or ""), ctype,
                     model, tokens, clean_text(json.dumps(meta, ensure_ascii=False))))
                self.stats["rows"] += 1
            m.execute("INSERT OR REPLACE INTO opencode_sync_messages VALUES (?,?,?,?,?,?)",
                      (mid, sid, tu, 1, 0, int(time.time())))

    def write_progress(self, done, total, t0, final=False):
        # progress marker for health checks / the stage runner; every session
        # is committed on its own, so a killed run resumes where it stopped
        path = self.args.progress
        if not path:
            return
        obj = dict(ts=int(time.time()), started=int(t0), done=done, total=total,
                   final=final, stats=self.stats)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(obj, f)
        os.replace(tmp, path)

    def run(self):
        t0 = time.time()
        sessions = self.changed_sessions()
        print("changed sessions: {}".format(len(sessions)), flush=True)
        if self.args.only:
            sessions = [s for s in sessions if s["id"] in self.args.only]
        # oldest change first, so a backlog drains in order across runs
        sessions.sort(key=lambda s: s.get("time_updated") or 0)
        if self.args.limit:
            sessions = sessions[:self.args.limit]
        self.stats["remaining"] = 0
        self.write_progress(0, len(sessions), t0)
        for i, s in enumerate(sessions, 1):
            # one bad session must not stop the rest: it is not stamped, so the
            # next run retries it, and the run exits 1 (see main)
            try:
                self.sync_session(s)
            except Exception as e:
                self.stats["errors"] += 1
                if len(self.stats["failed"]) < 20:
                    self.stats["failed"].append(s["id"])
                print("session {} failed: {}: {}".format(s["id"], type(e).__name__, e), flush=True)
                print(traceback.format_exc(), flush=True)
                if self.stats["errors"] >= 20:
                    print("too many failed sessions, stopping", flush=True)
                    break
            if i % 200 == 0:
                print("  {}/{} {}".format(i, len(sessions), self.stats), flush=True)
            if i % 10 == 0:
                self.write_progress(i, len(sessions), t0)
            if self.args.deadline and time.time() - t0 > self.args.deadline and i < len(sessions):
                self.stats["remaining"] = len(sessions) - i
                print("soft deadline {}s reached after {}/{} sessions; rest next run"
                      .format(self.args.deadline, i, len(sessions)), flush=True)
                break
        self.stats["attachments_new"] = self.att.new
        self.stats["secs"] = round(time.time() - t0, 1)
        self.write_progress(len(sessions) - self.stats["remaining"], len(sessions), t0, final=True)
        print("DONE", json.dumps(self.stats), flush=True)
        return self.stats


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--full", action="store_true",
                   help="rescan every session regardless of time_updated")
    p.add_argument("--only", nargs="*", help="session ids")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--deadline", type=int, default=0,
                   help="soft deadline (secs): stop starting new sessions after this")
    p.add_argument("--progress", default="",
                   help="write a JSON progress marker here every 10 sessions")
    args = p.parse_args()
    stats = Sync(args).run()
    sys.exit(1 if stats.get("errors") else 0)


if __name__ == "__main__":
    main()
