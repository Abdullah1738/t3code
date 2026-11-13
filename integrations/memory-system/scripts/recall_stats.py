#!/usr/bin/env python3
"""Bounded read-only sampling for the coordinator; never checkpoints or migrates."""
import argparse
import json
import os
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import robob_readonly


def inspect(path, seconds=2, samples=16):
    path = robob_readonly.safe_path(path)
    started = time.monotonic()
    result = {"path": str(path), "files": {}, "read_only": True, "estimates_are_sampled": True}
    for suffix in ("", "-wal", "-shm"):
        try:
            result["files"][suffix or "main"] = Path(str(path) + suffix).stat().st_size
        except FileNotFoundError:
            result["files"][suffix or "main"] = 0
    with closing(robob_readonly.connect_ro(path, timeout=0.1)) as con:
        con.execute("PRAGMA query_only=ON")
        con.execute("PRAGMA cache_size=-2048")
        con.set_progress_handler(lambda: int(time.monotonic() - started >= seconds), 1000)
        try:
            result["page_size"] = con.execute("PRAGMA page_size").fetchone()[0]
            result["pages"] = con.execute("PRAGMA page_count").fetchone()[0]
            result["free_pages"] = con.execute("PRAGMA freelist_count").fetchone()[0]
            hi = con.execute("SELECT coalesce(max(id),0) FROM episodic_events").fetchone()[0]
            result["max_event_id"] = hi
            rows = []
            for index in range(samples):
                pivot = hi * index // max(1, samples)
                row = con.execute("SELECT id,length(CAST(content AS BLOB)),length(CAST(metadata_json AS BLOB)),content_type,speaker "
                                  "FROM episodic_events WHERE id>=? ORDER BY id LIMIT 1", (pivot,)).fetchone()
                if row:
                    rows.append(row)
            result["samples"] = rows
            if rows:
                mean = sum((row[1] or 0) + (row[2] or 0) for row in rows) / len(rows)
                result["mean_sampled_payload_bytes"] = round(mean)
                result["planning_cold_payload_gb_range"] = [round(mean * hi * factor / 1e9, 2) for factor in (0.5, 2)]
                result["planning_hot_previews_gb_upper"] = round(hi * (8192 + 8192 + 256) / 1e9, 2)
            result["indexes"] = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='episodic_events'").fetchall()]
        except sqlite3.OperationalError as exc:
            result["partial"] = str(exc)
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    result["caveats"] = ["max_event_id is an upper bound, not a row count", "uniform id samples are not byte-weighted", "FTS and temporary migration bytes require fixture throughput plus free disk headroom", "no source checkpoint or write performed"]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=2)
    args = parser.parse_args()
    print(json.dumps(inspect(args.source, max(0.1, min(args.seconds, 10))), indent=2))
