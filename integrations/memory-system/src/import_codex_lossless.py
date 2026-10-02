#!/usr/bin/env python3
"""
Lossless Codex import.

Every JSONL line becomes one episodic_events row (except cumulative token_count
lines, whose final totals are folded into the per-file import_status record).

Lossless guarantee: for every row, the original payload can be reconstructed as
    raw_payload = metadata_json["payload"] with metadata_json["content_field"] restored from `content`
    (images are replaced by content-addressed refs "att:sha256:<hex>" stored in `attachments`)

Design:
  * Streams files line by line; never loads a file into memory.
  * Base64 images (data: URLs) are deduplicated into the `attachments` table.
    This is what makes the 23 GB "giant" files small: compaction snapshots
    re-embed every screenshot on every compaction.
  * turn_id = relative file path plus zero-padded line number. Fork and
    compaction files can contain multiple logical session IDs, so a line
    number alone is not globally unique in episodic_events.
  * Per-file checkpointing via `import_status` (status=completed, metadata.file).
  * Old (2025-08) format supported: header line {id,timestamp,instructions},
    followed by bare message/reasoning/function_call lines without timestamps.

Usage:
  python3 -u src/import_codex_lossless.py [--reset | --reset-normalized] [--projection-only] [--compact-metadata] [--limit N] [--dry-run]
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path.home() / ".local/share/memory-system/data/memory.db"
RAW_DB_PATH = Path.home() / ".local/share/memory-system/data/codex_raw.db"
CODEX_ROOT = Path.home() / ".codex"
SOURCE = "codex"
BATCH_ROWS = 250
MAX_BATCH_BYTES = 64 * 1024 * 1024
IMAGE_MIN_LEN = 256  # data: URLs shorter than this are kept inline
UUID_RE = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
def iso_to_unix(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return int(ts if ts < 1e11 else ts / 1000)
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def join_text_items(items):
    """Concatenate text-bearing content items from a Codex message content list."""
    out = []
    for c in items or []:
        if not isinstance(c, dict):
            continue
        t = c.get("type")
        if t in ("input_text", "output_text", "text", "summary_text"):
            out.append(c.get("text") or c.get("summary_text") or "")
        elif t == "input_image":
            out.append(f"<image {c.get('image_url', '')}>")
        elif t == "encrypted_content":
            out.append("<encrypted_content>")
    return "\n".join(x for x in out if x is not None)


class AttachmentStore:
    """Content-addressed store for data: URLs."""

    def __init__(self, conn):
        self.conn = conn
        self.cache = set()
        self.new_count = 0
        self.new_bytes = 0
        self.ref_count = 0
        conn.execute(
            """CREATE TABLE IF NOT EXISTS attachments (
                   sha256 TEXT PRIMARY KEY,
                   mime TEXT,
                   size INTEGER NOT NULL,
                   data BLOB NOT NULL,
                   first_seen INTEGER NOT NULL
               )"""
        )
        self.cache.update(r[0] for r in conn.execute("SELECT sha256 FROM attachments"))

    def intern(self, data_url, now):
        # data:image/png;base64,....
        head, _, b64 = data_url.partition(",")
        mime = head[5:].split(";")[0] if head.startswith("data:") else None
        digest = hashlib.sha256(b64.encode("ascii", "ignore")).hexdigest()
        self.ref_count += 1
        if digest not in self.cache:
            try:
                import base64
                blob = base64.b64decode(b64, validate=False)
            except Exception:
                blob = b64.encode("ascii", "ignore")
            self.conn.execute(
                "INSERT OR IGNORE INTO attachments(sha256, mime, size, data, first_seen) VALUES (?,?,?,?,?)",
                (digest, mime, len(blob), blob, now),
            )
            self.cache.add(digest)
            self.new_count += 1
            self.new_bytes += len(blob)
        return f"att:sha256:{digest}"

    def strip(self, obj, now):
        """Recursively replace data: URLs with refs. Mutates and returns obj."""
        if isinstance(obj, str):
            if len(obj) > IMAGE_MIN_LEN and obj.startswith("data:"):
                return self.intern(obj, now)
            return obj
        if isinstance(obj, list):
            for i, v in enumerate(obj):
                obj[i] = self.strip(v, now)
            return obj
        if isinstance(obj, dict):
            for k, v in obj.items():
                obj[k] = self.strip(v, now)
            return obj
        return obj


# ----------------------------------------------------------------------------
# line -> row mapping
# ----------------------------------------------------------------------------
def pop_path(d, path):
    """Pop nested key path like ('collaboration_mode','settings','developer_instructions')."""
    cur = d
    for k in path[:-1]:
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    if isinstance(cur, dict):
        return cur.pop(path[-1], None)
    return None


def map_response_item(p, speaker_default="assistant"):
    """Map a response_item payload (or old-format bare item). Returns (speaker, ctype, content, meta, content_field)."""
    t = p.get("type")
    if t == "message":
        role = p.get("role") or speaker_default
        speaker = {"user": "user", "assistant": "assistant"}.get(role, "system")
        content = join_text_items(p.get("content"))
        return speaker, "text", content, p, "content"
    if t == "reasoning":
        content = join_text_items(p.get("summary"))
        return "assistant", "text", content, p, "summary"
    if t in ("function_call", "custom_tool_call"):
        name = p.get("name", "")
        args = p.get("arguments") if t == "function_call" else p.get("input")
        if not isinstance(args, str):
            args = json.dumps(args) if args is not None else ""
        content = f"{name}\n{args}"
        return "assistant", "tool_call", content, p, ("arguments" if t == "function_call" else "input")
    if t in ("function_call_output", "custom_tool_call_output"):
        out = p.get("output")
        if not isinstance(out, str):
            out = json.dumps(out) if out is not None else ""
        return "system", "tool_result", out, p, "output"
    if t == "web_search_call":
        q = (p.get("action") or {}).get("query") or ""
        return "assistant", "tool_call", f"web_search\n{q}", p, None
    if t == "tool_search_call":
        q = json.dumps((p.get("arguments") or {}))
        return "assistant", "tool_call", f"tool_search\n{q}", p, None
    if t == "tool_search_output":
        return "system", "tool_result", json.dumps(p.get("tools") or []), p, "tools"
    if t == "agent_message":  # inter-agent
        content = join_text_items(p.get("content"))
        return "system", "text", content, p, "content"
    # ghost_snapshot, compaction, unknown
    return "system", "text", "", p, None


def map_line(d):
    """Return (speaker, ctype, content, meta, kind, model) for one parsed line."""
    t = d.get("type")
    p = d.get("payload")
    if not isinstance(p, dict):
        p = {"_raw_payload": p}
    model = None

    if t == "session_meta":
        content = pop_path(p, ("base_instructions", "text")) or ""
        return "system", "text", content, p, "session_meta", "base_instructions.text", model
    if t == "turn_context":
        model = p.get("model")
        content = pop_path(p, ("collaboration_mode", "settings", "developer_instructions")) or ""
        return "system", "text", content, p, "turn_context", "collaboration_mode.settings.developer_instructions", model
    if t == "compacted":
        content = p.get("message") or ""
        return "system", "text", content, p, "compacted", "message", model
    if t == "world_state":
        return "system", "text", "", p, "world_state", None, model
    if t == "inter_agent_communication_metadata":
        return "system", "text", "", p, "inter_agent_meta", None, model
    if t == "response_item":
        sp, ct, content, meta, cf = map_response_item(p)
        return sp, ct, content, meta, f"response_item/{p.get('type')}", cf, model
    if t == "event_msg":
        et = p.get("type")
        kind = f"event_msg/{et}"
        if et == "user_message":
            return "user", "text", p.get("message") or "", p, kind, "message", model
        if et == "agent_message":
            return "assistant", "text", p.get("message") or "", p, kind, "message", model
        if et == "agent_reasoning":
            return "assistant", "text", p.get("text") or "", p, kind, "text", model
        if et == "task_complete":
            return "assistant", "text", p.get("last_agent_message") or "", p, kind, "last_agent_message", model
        if et == "exec_command_end":
            content = p.get("aggregated_output")
            if not content:
                content = (p.get("stdout") or "") + (("\n" + p["stderr"]) if p.get("stderr") else "")
            cf = "aggregated_output" if p.get("aggregated_output") else None
            return "system", "tool_result", content or "", p, kind, cf, model
        if et == "patch_apply_end":
            content = (p.get("stdout") or "") + (("\n" + p["stderr"]) if p.get("stderr") else "")
            return "system", "tool_result", content, p, kind, None, model
        if et == "mcp_tool_call_end":
            res = p.get("result") or {}
            ok = res.get("Ok") if isinstance(res, dict) else None
            texts = []
            if isinstance(ok, dict):
                for c in ok.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "text":
                        texts.append(c.get("text") or "")
            content = "\n".join(texts) if texts else json.dumps(res)
            return "system", "tool_result", content, p, kind, None, model
        if et in ("web_search_end", "web_search_begin"):
            return "assistant", "tool_call", f"web_search\n{p.get('query') or ''}", p, kind, None, model
        if et == "error":
            return "system", "error", p.get("message") or "", p, kind, "message", model
        if et == "item_completed":
            item = p.get("item") or {}
            return "assistant", "text", item.get("text") or "", p, kind, None, model
        if et == "thread_goal_updated":
            return "system", "text", ((p.get("goal") or {}).get("objective") or ""), p, kind, None, model
        if et == "thread_name_updated":
            return "system", "text", p.get("thread_name") or "", p, kind, None, model
        if et == "thread_settings_applied":
            model = (p.get("thread_settings") or {}).get("model")
        return "system", "text", "", p, kind, None, model

    # ---- old format (2025-08): bare items ----
    if t in ("message", "reasoning", "function_call", "function_call_output"):
        sp, ct, content, meta, cf = map_response_item(d)
        return sp, ct, content, meta, f"legacy/{t}", cf, model
    if t is None and "instructions" in d and "id" in d:
        return "system", "text", d.get("instructions") or "", d, "legacy/session_header", "instructions", model
    if t is None and "record_type" in d:
        return "system", "text", "", d, f"legacy/{d.get('record_type')}", None, model

    return "system", "text", "", d, f"unknown/{t}", None, model


# ----------------------------------------------------------------------------
# main import
# ----------------------------------------------------------------------------
def discover_files():
    files = []
    for root in (CODEX_ROOT / "sessions", CODEX_ROOT / "archived_sessions"):
        if not root.exists():
            continue
        for p in root.rglob("*.jsonl"):
            if p.name.startswith("."):
                continue  # partial download artifacts
            if p.stat().st_size == 0:
                continue
            files.append(p)
    def chronological_key(path):
        match = re.search(r"rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z?)", path.name)
        if match:
            return (match.group(1).replace("-", "", 3), str(path))
        return ("999999999999999999999999", str(path))

    # Rollout names begin with an ISO-like timestamp. Sorting by that timestamp
    # gives chronological session order across active/archive trees, while the
    # JSONL line order preserves message order within a file.
    files.sort(key=chronological_key)
    return files


def already_done(conn):
    done = set()
    for (mj,) in conn.execute(
        "SELECT metadata_json FROM import_status WHERE source=? AND status='completed' AND metadata_json IS NOT NULL",
        (SOURCE,),
    ):
        try:
            f = json.loads(mj).get("file")
            if f:
                done.add(f)
        except Exception:
            pass
    return done


def import_file(conn, raw_conn, att, path: Path, dry_run=False, write_raw=True, compact_metadata=False):
    rel = str(path.relative_to(CODEX_ROOT))
    now = int(time.time())
    m = UUID_RE.search(path.name)
    session_id = m.group(1) if m else path.stem
    last_ts = None
    rows = []
    rows_bytes = 0
    raw_rows = []
    raw_bytes = 0
    n_lines = n_rows = n_skipped_tc = n_err = 0
    last_token_count = None
    session_model = None
    bytes_in = 0

    def flush():
        nonlocal rows, rows_bytes
        if rows and not dry_run:
            conn.executemany(
                "INSERT OR IGNORE INTO episodic_events(source, session_id, turn_id, timestamp, speaker, content, content_type, model, tokens_used, metadata_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
            # Commit normalized rows at the same granularity as raw rows. A
            # process interruption must not discard an entire large file's
            # searchable projection while its raw sidecar is already durable.
            conn.commit()
        rows = []
        rows_bytes = 0

    def flush_raw():
        nonlocal raw_rows, raw_bytes
        if raw_rows and not dry_run and write_raw:
            raw_conn.executemany(
                "INSERT OR IGNORE INTO raw_events(file, line_no, session_id, event_type, timestamp, raw_json_zlib, raw_size) VALUES (?,?,?,?,?,?,?)",
                raw_rows,
            )
            raw_conn.commit()
        raw_rows = []
        raw_bytes = 0

    if not dry_run:
        cur = conn.execute(
            "INSERT INTO import_status(source, import_started_at, status, metadata_json) VALUES (?,?,'in_progress',?)",
            (SOURCE, now, json.dumps({"file": rel, "session_id": session_id})),
        )
        status_id = cur.lastrowid
        conn.commit()

    with open(path, "rb") as fh:
        for line_no, raw in enumerate(fh, start=1):
            n_lines += 1
            bytes_in += len(raw)
            raw = raw.strip()
            if not raw:
                continue
            try:
                d = json.loads(raw)
            except Exception:
                n_err += 1
                rows.append((SOURCE, session_id, f"{rel}:{line_no:07d}", last_ts or now, "system", raw.decode("utf-8", "replace"),
                             "error", None, None, json.dumps({"kind": "parse_error", "file": rel})))
                n_rows += 1
                continue
            if not isinstance(d, dict):
                n_err += 1
                rows.append((SOURCE, session_id, f"{rel}:{line_no:07d}", last_ts or now, "system", raw.decode("utf-8", "replace"),
                             "error", None, None, json.dumps({"kind": "non_object", "file": rel})))
                n_rows += 1
                continue

            t = d.get("type")
            p = d.get("payload")
            # token_count: fold into file totals, don't store a searchable row
            if t == "event_msg" and isinstance(p, dict) and p.get("type") == "token_count":
                n_skipped_tc += 1
                info = p.get("info") or {}
                if info.get("total_token_usage"):
                    last_token_count = info["total_token_usage"]
                del d, raw
                continue

            # session id from session_meta / legacy header wins over filename
            if t == "session_meta" and isinstance(p, dict) and p.get("id"):
                session_id = p["id"]
            elif t is None and "instructions" in d and d.get("id"):
                session_id = d["id"]

            ts = iso_to_unix(d.get("timestamp"))
            if ts is None and isinstance(p, dict):
                ts = iso_to_unix(p.get("timestamp"))
            if ts is None:
                ts = last_ts or now
            last_ts = ts

            # Retain the exact JSONL payload separately. The searchable event
            # row below is normalized, but this sidecar makes the import
            # lossless even when Codex adds new event shapes later.
            compressed_raw = zlib.compress(raw, 6)
            if write_raw:
                raw_rows.append((rel, line_no, session_id, d.get("type"), ts, compressed_raw, len(raw)))
                raw_bytes += len(compressed_raw)
                if len(raw_rows) >= BATCH_ROWS or raw_bytes >= MAX_BATCH_BYTES:
                    flush_raw()

            att.strip(d, now)  # replace images with refs (mutates d)
            speaker, ctype, content, meta, kind, content_field, model = map_line(d)
            if model:
                session_model = model
            if content is None:
                content = ""
            if not isinstance(content, str):
                content = json.dumps(content)

            # remove the content-bearing field from meta so we don't store it twice
            meta_copy = meta
            if content_field and "." not in content_field and isinstance(meta, dict) and content_field in meta:
                meta_copy = dict(meta)
                meta_copy.pop(content_field, None)
            if compact_metadata:
                # The raw sidecar is the authoritative lossless payload. Keep
                # only a stable pointer in the searchable projection so large
                # developer prompts and duplicated compaction payloads are not
                # stored a second time in memory.db.
                md = {"kind": kind, "line": line_no, "file": rel,
                      "content_field": content_field, "raw_sidecar": True}
                if speaker == "system" and ctype == "text" and kind != "compacted":
                    content = ""
            else:
                md = {"kind": kind, "line": line_no, "file": rel,
                      "content_field": content_field, "payload": meta_copy}
            if t == "response_item" and isinstance(p, dict) and p.get("call_id"):
                md["call_id"] = p["call_id"]
            tokens = None
            metadata_json = json.dumps(md, ensure_ascii=False)
            rows.append((SOURCE, session_id, f"{rel}:{line_no:07d}", ts, speaker, content, ctype,
                         model or session_model, tokens, metadata_json))
            rows_bytes += len(content) + len(metadata_json)
            n_rows += 1
            if len(rows) >= BATCH_ROWS or rows_bytes >= MAX_BATCH_BYTES:
                flush()
            del d, raw, compressed_raw, metadata_json
    flush()
    flush_raw()

    if not dry_run:
        conn.execute(
            "UPDATE import_status SET status='completed', import_completed_at=?, total_events=?, metadata_json=? WHERE id=?",
            (int(time.time()), n_rows, json.dumps({
                "file": rel, "session_id": session_id, "lines": n_lines, "rows": n_rows,
                "token_count_lines_folded": n_skipped_tc, "parse_errors": n_err, "bytes": bytes_in,
                "final_token_usage": last_token_count, "model": session_model,
            }), status_id),
        )
        conn.commit()
        raw_conn.commit()
    return session_id, n_lines, n_rows, n_skipped_tc, n_err, bytes_in


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="delete all existing codex rows and import_status before importing")
    ap.add_argument("--reset-normalized", action="store_true",
                    help="delete only normalized codex rows/status; preserve the raw sidecar")
    ap.add_argument("--projection-only", action="store_true",
                    help="when rebuilding normalized rows, do not rewrite the existing raw sidecar")
    ap.add_argument("--compact-metadata", action="store_true",
                    help="store only raw sidecar pointers in Codex normalized metadata")
    ap.add_argument("--limit", type=int, default=0, help="only import first N files (smallest first)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", help="substring filter on file path")
    args = ap.parse_args()
    if args.projection_only and not args.reset_normalized:
        ap.error("--projection-only requires --reset-normalized")

    conn = sqlite3.connect(DB_PATH, timeout=600)
    conn.execute("PRAGMA busy_timeout=600000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-512000")
    conn.execute("PRAGMA temp_store=MEMORY")

    raw_conn = sqlite3.connect(RAW_DB_PATH, timeout=600)
    raw_conn.execute("PRAGMA busy_timeout=600000")
    raw_conn.execute("PRAGMA journal_mode=WAL")
    raw_conn.execute("PRAGMA synchronous=NORMAL")
    raw_conn.execute("""CREATE TABLE IF NOT EXISTS raw_events (
        file TEXT NOT NULL,
        line_no INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT,
        timestamp INTEGER,
        raw_json_zlib BLOB NOT NULL,
        raw_size INTEGER NOT NULL,
        PRIMARY KEY(file, line_no)
    )""")
    raw_conn.execute("CREATE INDEX IF NOT EXISTS idx_raw_session ON raw_events(session_id)")
    raw_conn.commit()

    if (args.reset or args.reset_normalized) and not args.dry_run:
        if args.reset and args.reset_normalized:
            ap.error("--reset and --reset-normalized are mutually exclusive")
        print("Deleting existing normalized codex rows ...", flush=True)
        t0 = time.time()
        conn.execute("DELETE FROM episodic_events WHERE source=?", (SOURCE,))
        conn.execute("DELETE FROM import_status WHERE source=?", (SOURCE,))
        conn.commit()
        if args.reset:
            print("Deleting existing raw codex rows ...", flush=True)
            raw_conn.execute("DELETE FROM raw_events")
            raw_conn.commit()
        print(f"  done in {time.time()-t0:.0f}s", flush=True)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    att = AttachmentStore(conn)
    files = discover_files()
    if args.only:
        files = [f for f in files if args.only in str(f)]
    done = already_done(conn)
    todo = [f for f in files if str(f.relative_to(CODEX_ROOT)) not in done]
    if args.limit:
        todo = todo[: args.limit]
    total_bytes = sum(f.stat().st_size for f in todo)
    print(f"Files: {len(files)} total, {len(done)} done, {len(todo)} to import ({total_bytes/1e9:.1f} GB)", flush=True)

    t_start = time.time()
    done_bytes = 0
    tot_rows = 0
    for i, f in enumerate(todo, 1):
        t0 = time.time()
        try:
            sid, nl, nr, ntc, nerr, nb = import_file(
                conn, raw_conn, att, f, args.dry_run,
                write_raw=not args.projection_only,
                compact_metadata=args.compact_metadata,
            )
        except Exception as e:
            print(f"[{i}/{len(todo)}] FAILED {f.name}: {e!r}", flush=True)
            conn.rollback()
            raw_conn.rollback()
            if not args.dry_run:
                conn.execute(
                    "UPDATE import_status SET status='failed', error_message=? WHERE source=? AND status='in_progress'",
                    (repr(e), SOURCE),
                )
                conn.commit()
            continue
        done_bytes += nb
        tot_rows += nr
        dt = time.time() - t0
        elapsed = time.time() - t_start
        rate = done_bytes / elapsed if elapsed else 0
        eta = (total_bytes - done_bytes) / rate / 60 if rate else 0
        if i % 50 == 0 or nb > 50_000_000 or i == len(todo):
            print(f"[{i}/{len(todo)}] {f.name[:60]} {nb/1e6:.1f}MB lines={nl} rows={nr} err={nerr} {dt:.1f}s | "
                  f"total rows={tot_rows:,} att={att.new_count} ({att.new_bytes/1e6:.0f}MB) refs={att.ref_count} | "
                  f"{done_bytes/1e9:.1f}/{total_bytes/1e9:.1f} GB {rate/1e6:.1f} MB/s ETA {eta:.0f}m", flush=True)
        if i % 200 == 0 and not args.dry_run:
            conn.execute("PRAGMA wal_checkpoint(PASSIVE)")

    if not args.dry_run:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        raw_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    raw_conn.close()
    print(f"DONE: {tot_rows:,} rows, {att.new_count} attachments ({att.new_bytes/1e9:.2f} GB), {time.time()-t_start:.0f}s", flush=True)


if __name__ == "__main__":
    main()
