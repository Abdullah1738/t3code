#!/usr/bin/env python3
"""
Repair the Codex raw sidecar's intentionally omitted JSONL records.

The normalized importer keeps ordinary valid records in ``raw_events`` and
folds cumulative token_count records into per-file import metadata.  Malformed
records become searchable error events but were not copied to the raw sidecar.
This pass stores the exact source line bytes for those exceptional records in
``raw_omissions``.  The bytes include their original newline framing, so the
table is also an auditable ledger for the records absent from ``raw_events``.

The source files remain the authoritative byte-for-byte archive.  This table
closes the raw-sidecar coverage gap without duplicating the full corpus.

The pass is resumable per file.  A completed file is reused only when its
source size and mtime are unchanged.  Each file's scan and audit commit in one
transaction, so an interrupted run never marks a partial file complete.
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import time
import zlib
from datetime import datetime
from pathlib import Path


RAW_DB_PATH = Path.home() / ".local/share/memory-system/data/codex_raw.db"
CODEX_ROOT = Path.home() / ".codex"
UUID_RE = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$")


def iso_to_unix(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value if value < 1e11 else value / 1000)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def discover_files():
    files = []
    for root in (CODEX_ROOT / "sessions", CODEX_ROOT / "archived_sessions"):
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            if path.name.startswith(".") or path.stat().st_size == 0:
                continue
            files.append(path)

    def chronological_key(path):
        match = re.search(
            r"rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d+)?Z?)",
            path.name,
        )
        return (match.group(1).replace("-", "", 3) if match else "9" * 24, str(path))

    files.sort(key=chronological_key)
    return files


def initial_session_id(path):
    match = UUID_RE.search(path.name)
    return match.group(1) if match else path.stem


def line_timestamp(record, last_timestamp, fallback):
    payload = record.get("payload")
    timestamp = iso_to_unix(record.get("timestamp"))
    if timestamp is None and isinstance(payload, dict):
        timestamp = iso_to_unix(payload.get("timestamp"))
    return timestamp if timestamp is not None else (last_timestamp or fallback)


def ensure_schema(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_omissions (
            file TEXT NOT NULL,
            line_no INTEGER NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('token_count', 'parse_error', 'non_object', 'blank')),
            session_id TEXT,
            event_type TEXT,
            timestamp INTEGER,
            raw_line_zlib BLOB NOT NULL,
            raw_size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            error_text TEXT,
            PRIMARY KEY(file, line_no)
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_raw_omissions_kind ON raw_omissions(kind)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_raw_omissions_session ON raw_omissions(session_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_repair_files (
            file TEXT PRIMARY KEY,
            source_size INTEGER NOT NULL,
            source_mtime_ns INTEGER NOT NULL,
            source_sha256 TEXT NOT NULL,
            source_lines INTEGER NOT NULL,
            source_bytes INTEGER NOT NULL,
            valid_non_token_lines INTEGER NOT NULL,
            omission_lines INTEGER NOT NULL,
            token_count_lines INTEGER NOT NULL,
            parse_error_lines INTEGER NOT NULL,
            non_object_lines INTEGER NOT NULL,
            blank_lines INTEGER NOT NULL,
            raw_event_lines INTEGER NOT NULL,
            completed_at INTEGER NOT NULL
        )
        """
    )
    conn.commit()


def completed_unchanged(conn, rel, stat):
    row = conn.execute(
        "SELECT source_size, source_mtime_ns FROM raw_repair_files WHERE file=?",
        (rel,),
    ).fetchone()
    return row is not None and row == (stat.st_size, stat.st_mtime_ns)


def import_file(conn, path):
    rel = str(path.relative_to(CODEX_ROOT))
    stat = path.stat()
    fallback = int(time.time())
    session_id = initial_session_id(path)
    last_timestamp = None
    source_hash = hashlib.sha256()
    source_lines = source_bytes = 0
    valid_non_token = omission_lines = token_count_lines = 0
    parse_error_lines = non_object_lines = blank_lines = 0
    pending = []

    # A changed source file must not retain omission rows from its previous
    # version.  If the scan is interrupted, the missing completion row causes
    # the next run to delete these partial rows and replay the file cleanly.
    conn.execute("DELETE FROM raw_omissions WHERE file=?", (rel,))
    conn.execute("DELETE FROM raw_repair_files WHERE file=?", (rel,))
    conn.commit()

    def flush():
        nonlocal pending
        if pending:
            conn.executemany(
                """
                INSERT OR REPLACE INTO raw_omissions(
                    file, line_no, kind, session_id, event_type, timestamp,
                    raw_line_zlib, raw_size, sha256, error_text
                ) VALUES (?,?,?,?,?,?,?,?,?,?)
                """,
                pending,
            )
            conn.commit()
            pending = []

    with path.open("rb") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            source_lines += 1
            source_bytes += len(raw_line)
            source_hash.update(raw_line)
            stripped = raw_line.strip()
            kind = None
            record = None
            error_text = None
            parsed = False

            if not stripped:
                kind = "blank"
                blank_lines += 1
            else:
                try:
                    record = json.loads(stripped)
                    parsed = True
                except Exception as exc:
                    kind = "parse_error"
                    error_text = repr(exc)[:1000]
                    parse_error_lines += 1

                if parsed and not isinstance(record, dict):
                    kind = "non_object"
                    non_object_lines += 1

                if isinstance(record, dict):
                    event_type = record.get("type")
                    payload = record.get("payload")
                    if event_type == "session_meta" and isinstance(payload, dict) and payload.get("id"):
                        session_id = str(payload["id"])
                    elif event_type is None and record.get("instructions") and record.get("id"):
                        session_id = str(record["id"])

                    timestamp = line_timestamp(record, last_timestamp, fallback)
                    if timestamp is not None:
                        last_timestamp = timestamp

                    if event_type == "event_msg" and isinstance(payload, dict) and payload.get("type") == "token_count":
                        kind = "token_count"
                        token_count_lines += 1
                    else:
                        valid_non_token += 1
                        last_timestamp = timestamp

            if kind is None:
                continue

            omission_lines += 1
            if isinstance(record, dict):
                event_type = record.get("type")
                timestamp = line_timestamp(record, last_timestamp, fallback)
            else:
                event_type = None
                timestamp = last_timestamp or fallback
            pending.append(
                (
                    rel,
                    line_no,
                    kind,
                    session_id,
                    event_type,
                    timestamp,
                    sqlite3.Binary(zlib.compress(raw_line, 6)),
                    len(raw_line),
                    hashlib.sha256(raw_line).hexdigest(),
                    error_text,
                )
            )
            if len(pending) >= 10000:
                flush()

    flush()
    final_stat = path.stat()
    if final_stat.st_size != stat.st_size or final_stat.st_mtime_ns != stat.st_mtime_ns:
        raise RuntimeError(f"source changed while scanning {rel}")
    raw_event_lines = conn.execute("SELECT COUNT(*) FROM raw_events WHERE file=?", (rel,)).fetchone()[0]
    if raw_event_lines + omission_lines != source_lines:
        raise RuntimeError(
            f"coverage mismatch for {rel}: raw={raw_event_lines} omissions={omission_lines} "
            f"source={source_lines}"
        )
    if valid_non_token != raw_event_lines:
        raise RuntimeError(
            f"valid-row mismatch for {rel}: scanned={valid_non_token} raw_events={raw_event_lines}"
        )

    conn.execute(
        """
        INSERT OR REPLACE INTO raw_repair_files(
            file, source_size, source_mtime_ns, source_sha256, source_lines, source_bytes,
            valid_non_token_lines, omission_lines, token_count_lines,
            parse_error_lines, non_object_lines, blank_lines, raw_event_lines,
            completed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            rel,
            stat.st_size,
            stat.st_mtime_ns,
            source_hash.hexdigest(),
            source_lines,
            source_bytes,
            valid_non_token,
            omission_lines,
            token_count_lines,
            parse_error_lines,
            non_object_lines,
            blank_lines,
            raw_event_lines,
            int(time.time()),
        ),
    )
    conn.commit()
    return {
        "lines": source_lines,
        "bytes": source_bytes,
        "valid": valid_non_token,
        "omissions": omission_lines,
        "token_count": token_count_lines,
        "parse_error": parse_error_lines,
        "non_object": non_object_lines,
        "blank": blank_lines,
        "raw": raw_event_lines,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="substring filter on relative source path")
    parser.add_argument("--limit", type=int, default=0, help="process at most N files")
    parser.add_argument("--recheck", action="store_true", help="rescan completed files")
    args = parser.parse_args()

    conn = sqlite3.connect(RAW_DB_PATH, timeout=600)
    conn.execute("PRAGMA busy_timeout=600000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    ensure_schema(conn)

    files = discover_files()
    if args.only:
        files = [path for path in files if args.only in str(path.relative_to(CODEX_ROOT))]
    if args.limit:
        files = files[: args.limit]

    totals = {key: 0 for key in ("lines", "bytes", "valid", "omissions", "token_count", "parse_error", "non_object", "blank", "raw")}
    started = time.time()
    processed = skipped = 0
    for index, path in enumerate(files, start=1):
        rel = str(path.relative_to(CODEX_ROOT))
        stat = path.stat()
        if not args.recheck and completed_unchanged(conn, rel, stat):
            skipped += 1
            continue
        result = import_file(conn, path)
        processed += 1
        for key, value in result.items():
            totals[key] += value
        elapsed = time.time() - started
        rate = totals["bytes"] / elapsed / 1e6 if elapsed else 0
        print(
            f"[{index}/{len(files)}] {path.name[:60]} lines={result['lines']} "
            f"raw={result['raw']} omissions={result['omissions']} "
            f"token={result['token_count']} errors={result['parse_error'] + result['non_object']} "
            f"{result['bytes'] / 1e9:.3f}GB rate={rate:.1f}MB/s",
            flush=True,
        )

    print(
        json.dumps(
            {
                "files": len(files),
                "processed": processed,
                "skipped": skipped,
                "totals": totals,
                "elapsed_seconds": round(time.time() - started, 1),
            },
            sort_keys=True,
        ),
        flush=True,
    )
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()


if __name__ == "__main__":
    main()
