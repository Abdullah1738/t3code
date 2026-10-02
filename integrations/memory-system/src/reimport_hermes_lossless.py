#!/usr/bin/env python3
"""Lossless reimport of native Hermes messages into the memory system.

Replaces the original lossy hermes import, which:
  - dropped every role='tool' message (tool results) via speaker CHECK
  - dropped every role='session_meta' row
  - discarded assistant text content whenever tool_calls were present
  - never imported reasoning_content / reasoning

Scope: sessions WHERE source != 'codex-import'. The codex-import sessions
inside hermes are a copy of codex history whose canonical, exact bytes are
already preserved in data/codex_raw.db, so they are intentionally skipped
(recorded in the import_status metadata).

Mapping per source message m (sessions s):
  - one episodic row per message:
      turn_id = str(m.id)
      user -> (user, text), assistant -> (assistant, text),
      tool -> (system, tool_result), session_meta/other -> (system, text)
      content = m.content or ''
  - one extra row per parsed tool call in m.tool_calls:
      turn_id = f"{m.id}.tc.{i}", (assistant, tool_call), content = call JSON
  - one extra row if reasoning_content/reasoning non-empty:
      turn_id = f"{m.id}.reasoning", (assistant, text), kind='reasoning'

metadata_json carries msg_id, role, tool_name, tool_call_id, display_kind,
token_count, model, session_name, channel (s.source), cwd.

Usage:
  python3 -u src/reimport_hermes_lossless.py            # delete + reimport
  python3 -u src/reimport_hermes_lossless.py --verify   # read-only checks
"""

import json
import sqlite3
import sys
import time
from pathlib import Path

SOURCE_DB = Path.home() / ".hermes" / "state.db"
TARGET_DB = Path.home() / ".local" / "share" / "memory-system" / "data" / "memory.db"
BATCH = 1000

ROLE_MAP = {
    "user": ("user", "text"),
    "assistant": ("assistant", "text"),
    "tool": ("system", "tool_result"),
    "session_meta": ("system", "text"),
    "system": ("system", "text"),
}


def connect_target():
    conn = sqlite3.connect(str(TARGET_DB))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=600000")
    conn.execute("PRAGMA cache_size=-64000")
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn


def message_rows(m, s):
    """Build episodic rows for one source message."""
    (mid, session_id, role, content, tool_call_id, tool_calls, tool_name,
     ts, token_count, reasoning, reasoning_content, reasoning_details,
     display_kind, model, display_name, channel, cwd) = m

    speaker, ctype = ROLE_MAP.get(role, ("system", "text"))
    meta = {
        "kind": "message" if role in ("user", "assistant") else role,
        "msg_id": mid,
        "role": role,
        "tool_name": tool_name,
        "tool_call_id": tool_call_id,
        "display_kind": display_kind,
        "token_count": token_count,
        "model": model,
        "session_name": display_name,
        "channel": channel,
        "cwd": cwd,
    }
    rows = [(
        "hermes", session_id, str(mid), int(ts), speaker,
        content or "", ctype, model, token_count, json.dumps(meta),
    )]

    if tool_calls:
        try:
            calls = json.loads(tool_calls)
            if not isinstance(calls, list):
                calls = [calls]
        except Exception:
            calls = None
        if calls is None:
            rows.append((
                "hermes", session_id, f"{mid}.tc.0", int(ts), "assistant",
                tool_calls, "tool_call", model, token_count,
                json.dumps({**meta, "kind": "tool_call", "parse_error": True}),
            ))
        else:
            for i, call in enumerate(calls):
                cname = None
                cid = None
                if isinstance(call, dict):
                    cid = call.get("id")
                    fn = call.get("function") or {}
                    cname = fn.get("name") or call.get("name")
                rows.append((
                    "hermes", session_id, f"{mid}.tc.{i}", int(ts), "assistant",
                    json.dumps(call), "tool_call", model, token_count,
                    json.dumps({**meta, "kind": "tool_call",
                                "tool_name": cname or tool_name,
                                "tool_call_id": cid or tool_call_id}),
                ))

    reasoning_text = reasoning_content or reasoning
    if reasoning_text:
        rows.append((
            "hermes", session_id, f"{mid}.reasoning", int(ts), "assistant",
            reasoning_text, "text", model, token_count,
            json.dumps({**meta, "kind": "reasoning",
                        "has_details": reasoning_details is not None}),
        ))
    return rows


def main():
    verify_only = "--verify" in sys.argv
    src = sqlite3.connect(f"file:{SOURCE_DB}?mode=ro", uri=True)
    tgt = connect_target()

    src_counts = dict(src.execute(
        """SELECT m.role, COUNT(*) FROM messages m
           JOIN sessions s ON m.session_id = s.id
           WHERE s.source != 'codex-import' GROUP BY m.role"""))
    src_total = sum(src_counts.values())
    src_sessions = src.execute(
        "SELECT COUNT(*) FROM sessions WHERE source != 'codex-import'").fetchone()[0]
    print(f"source native: {src_total} messages {src_counts} across {src_sessions} sessions")

    if verify_only:
        mem_counts = dict(tgt.execute(
            "SELECT speaker || '/' || content_type, COUNT(*) FROM episodic_events "
            "WHERE source='hermes' GROUP BY speaker, content_type"))
        mem_total = tgt.execute(
            "SELECT COUNT(*) FROM episodic_events WHERE source='hermes'").fetchone()[0]
        mem_sessions = tgt.execute(
            "SELECT COUNT(DISTINCT session_id) FROM episodic_events WHERE source='hermes'").fetchone()[0]
        print(f"memory hermes: {mem_total} rows {mem_counts} across {mem_sessions} sessions")
        missing = tgt.execute(
            """SELECT COUNT(*) FROM episodic_events e
               WHERE e.source='hermes' AND json_extract(e.metadata_json,'$.msg_id') IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM episodic_events) """).fetchone()
        del missing
        mismatched = 0
        checked = 0
        for (mid, content) in src.execute(
                """SELECT m.id, m.content FROM messages m
                   JOIN sessions s ON m.session_id = s.id
                   WHERE s.source != 'codex-import'
                     AND m.content IS NOT NULL AND m.content != ''
                   ORDER BY m.id LIMIT 5000"""):
            row = tgt.execute(
                "SELECT content FROM episodic_events WHERE source='hermes' AND turn_id=?",
                (str(mid),)).fetchone()
            checked += 1
            if row is None or (row[0] or "") != (content or ""):
                mismatched += 1
        print(f"content spot-check: {checked} messages compared, {mismatched} mismatches")
        return

    t0 = time.time()
    cur = tgt.cursor()
    cur.execute("DELETE FROM episodic_events WHERE source='hermes'")
    deleted = cur.rowcount
    tgt.commit()
    print(f"deleted {deleted} old hermes rows ({time.time()-t0:.0f}s)")

    cur.execute("DELETE FROM import_status WHERE source='hermes'")
    cur.execute(
        "INSERT INTO import_status (source, import_started_at, status) VALUES ('hermes', ?, 'in_progress')",
        (int(time.time()),))
    import_id = cur.lastrowid
    tgt.commit()

    inserted = 0
    batch = []
    query = """
        SELECT m.id, m.session_id, m.role, m.content, m.tool_call_id, m.tool_calls,
               m.tool_name, m.timestamp, m.token_count, m.reasoning, m.reasoning_content,
               m.reasoning_details, m.display_kind, s.model, s.display_name, s.source, s.cwd
        FROM messages m JOIN sessions s ON m.session_id = s.id
        WHERE s.source != 'codex-import'
        ORDER BY m.timestamp, m.id
    """
    for m in src.execute(query):
        batch.extend(message_rows(m, s=m))
        if len(batch) >= BATCH:
            cur.executemany(
                """INSERT OR IGNORE INTO episodic_events
                   (source, session_id, turn_id, timestamp, speaker, content,
                    content_type, model, tokens_used, metadata_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", batch)
            tgt.commit()
            inserted += len(batch)
            batch.clear()
            if inserted % 100000 < BATCH:
                print(f"  {inserted} rows ({time.time()-t0:.0f}s)", flush=True)
    if batch:
        cur.executemany(
            """INSERT OR IGNORE INTO episodic_events
               (source, session_id, turn_id, timestamp, speaker, content,
                content_type, model, tokens_used, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", batch)
        tgt.commit()
        inserted += len(batch)

    codex_import = src.execute(
        """SELECT COUNT(*), COALESCE(SUM(s.message_count),0) FROM sessions s
           WHERE s.source = 'codex-import'""").fetchone()
    meta = {
        "scope": "native hermes only (sessions WHERE source != 'codex-import')",
        "source_roles": src_counts,
        "source_messages": src_total,
        "source_sessions": src_sessions,
        "skipped_codex_import_sessions": codex_import[0],
        "skipped_codex_import_messages": codex_import[1],
        "codex_import_note": "canonical exact bytes preserved in data/codex_raw.db",
        "replaces_lossy_import": True,
    }
    cur.execute(
        """UPDATE import_status SET import_completed_at=?, total_events=?,
           status='completed', metadata_json=? WHERE id=?""",
        (int(time.time()), inserted, json.dumps(meta), import_id))
    tgt.commit()
    tgt.execute("PRAGMA wal_checkpoint(PASSIVE)")
    print(f"DONE: inserted {inserted} rows from {src_total} source messages "
          f"({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
