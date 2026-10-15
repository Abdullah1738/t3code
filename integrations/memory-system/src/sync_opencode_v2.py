#!/usr/bin/env python3
"""Continuous importer for native OpenCode 2 sessions.

Reads session_v2 / session_message from the live opencode.db (read-only) and
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
SETTLE_SECS). A message is re-projected when its time_updated changes; facts
pointing at replaced rows are re-linked.

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
import zlib

HOME = os.path.expanduser("~")
MEM_DB = os.environ.get("MEMORY_DB", os.path.join(HOME, ".local/share/memory-system/data/memory.db"))
RAW_DB = os.environ.get("OPENCODE_RAW_DB", os.path.join(HOME, ".local/share/memory-system/data/opencode_raw.db"))
SRC_DB = os.path.join(HOME, ".local/share/opencode/opencode.db")
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
        except sqlite3.OperationalError as e:
            if db.in_transaction:
                db.rollback()
            if "locked" not in str(e) and "busy" not in str(e):
                raise
            time.sleep(min(1 + i, 20))
    raise RuntimeError("database busy after retries")


class Sync:
    def __init__(self, args):
        self.args = args
        self.src = sqlite3.connect("file:{}?mode=ro".format(SRC_DB), uri=True, timeout=60)
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
        """)
        self.mem.commit()
        self.att = Attachments(self.mem)
        self.stats = dict(sessions=0, raw_upserts=0, projected=0, reprojected=0,
                          legacy=0, unsettled=0, rows=0)

    # ------------------------------------------------------------ source reads
    def changed_sessions(self):
        cols = [r[1] for r in self.src.execute("PRAGMA table_info(session_v2)")]
        rows = self.src.execute("SELECT * FROM session_v2").fetchall()
        self.src.commit()
        known = dict(self.mem.execute(
            "SELECT session_id, time_updated FROM opencode_sync_sessions").fetchall())
        out = []
        for r in rows:
            d = dict(zip(cols, r))
            if known.get(d["id"]) == d["time_updated"] and not self.args.full:
                continue
            out.append(d)
        return out

    def session_messages(self, sid, page=300):
        """Yield pages ordered by seq; some sessions carry 500+ MB of data."""
        last = -1
        while True:
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
        native = is_native(sess.get("metadata"))
        if not native:
            with_retry(self.mem, lambda: self.mem.execute(
                "INSERT OR REPLACE INTO opencode_sync_sessions VALUES (?,?,?,?)",
                (sid, 0, sess["time_updated"], int(time.time()))))
            return
        self.stats["sessions"] += 1
        ledger = dict((m, (tu, p, lg)) for m, tu, p, lg in self.mem.execute(
            "SELECT msg_id, time_updated, projected, legacy FROM opencode_sync_messages"
            " WHERE session_id=?", (sid,)).fetchall())
        raw_have = dict(self.raw.execute(
            "SELECT id, time_updated FROM raw_messages WHERE session_id=?", (sid,)).fetchall())
        all_settled = True
        for msgs in self.session_messages(sid):
            # raw archive (every native message, settled or not)
            raw_batch = []
            for mid, mtype, seq, tc, tu, data in msgs:
                if raw_have.get(mid) != tu:
                    b = data.encode("utf-8")
                    raw_batch.append((mid, sid, mtype, seq, tc, tu,
                                      hashlib.sha256(b).hexdigest(), len(b),
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
                if led and led[0] == tu:
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
        srow = json.dumps(sess, ensure_ascii=False).encode("utf-8")
        with_retry(self.raw, lambda: self.raw.execute(
            "INSERT OR REPLACE INTO raw_sessions VALUES (?,?,?)",
            (sid, sess["time_updated"], zlib.compress(srow, 6))))
        stamp = sess["time_updated"] if all_settled else -1
        with_retry(self.mem, lambda: self.mem.execute(
            "INSERT OR REPLACE INTO opencode_sync_sessions VALUES (?,?,?,?)",
            (sid, 1, stamp, int(time.time()))))

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
                    (SOURCE, sid, turn_id, ts, speaker, content or "", ctype, model, tokens,
                     json.dumps(meta, ensure_ascii=False)))
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
            self.sync_session(s)
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
    Sync(args).run()


if __name__ == "__main__":
    main()
