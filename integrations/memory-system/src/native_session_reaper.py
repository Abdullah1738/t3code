#!/opt/homebrew/bin/python3
"""REPORT ONLY: which native transcripts would be archived. Never deletes anything.

Lists native harness transcript files (Claude/Codex homes, see transcript_roots.py)
that are candidates for later archival: older than 180 days, the Robob thread they
belong to is settled or archived, fully captured to the end per the capture ledger,
and present in the latest backup manifest. Output is a plan only. Not wired into
launchd; the destructive step is a later card with its own gate.

  native_session_reaper.py [--days 180] [--manifest PATH] [--ledger PATH]
"""
import argparse
import glob
import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_roots  # noqa: E402

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".local/share/memory-system")
MANIFEST_DIR = os.path.join(ROOT, "data/backup-manifests")
MIN_AGE_DAYS = 180


def latest_manifest(manifest_dir=MANIFEST_DIR):
    paths = sorted(glob.glob(os.path.join(manifest_dir, "*.json")))
    if not paths:
        return None
    with open(paths[-1]) as f:
        return json.load(f)


def captured_to_end(ledger, path, size):
    """True when the ledger's consumed offset reached the file's current size."""
    row = ledger.get(path)
    return bool(row) and row.get("offset", -1) >= size and row.get("error_count", 0) == 0


def settled_threads(state_db):
    """Thread ids of settled/archived kanban cards and archived app threads.
    Unknown or unreadable -> empty set (nothing becomes a candidate)."""
    out = set()
    if not state_db or not os.path.isfile(state_db):
        return out
    c = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=30)
    try:
        for (tid,) in c.execute(
                "SELECT DISTINCT json_extract(json, '$.workThreadId') FROM ardud_kanban_cards "
                "WHERE json_extract(json, '$.settledAt') IS NOT NULL"):
            if tid:
                out.add(tid)
        for (tid,) in c.execute(
                "SELECT thread_id FROM orchestration_v2_projection_threads WHERE archived_at IS NOT NULL"):
            out.add(tid)
    finally:
        c.close()
    return out


def plan(roots, ledger, manifest, settled, now=None, min_age_days=MIN_AGE_DAYS):
    """Return a list of candidate dicts. Pure function: reads nothing itself."""
    now = now or time.time()
    cutoff = now - min_age_days * 86400
    in_manifest = {f["path"] for f in (manifest or {}).get("files", [])}
    out = []
    for r in roots:
        if not r.get("exists"):
            continue
        for d in transcript_roots.transcript_dirs(r["instance"]):
            for dirpath, _, names in os.walk(d):
                for name in names:
                    full = os.path.join(dirpath, name)
                    if not name.endswith(".jsonl"):
                        continue
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    if st.st_mtime > cutoff:
                        continue
                    if not captured_to_end(ledger, full, st.st_size):
                        continue
                    rel = os.path.relpath(full, r["root"])
                    if rel not in in_manifest:
                        continue
                    thread = ledger.get(full, {}).get("thread_id")
                    if not thread or thread not in settled:
                        continue
                    out.append({"instance": r["instance"], "path": full, "size": st.st_size,
                                "thread_id": thread})
    return out


def load_ledger(path):
    """native_capture_files as {path: row}. Read only; missing ledger -> empty."""
    if not path or not os.path.isfile(path):
        return {}
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    try:
        cols = [d[1] for d in c.execute("PRAGMA table_info(native_capture_files)")]
        rows = c.execute("SELECT * FROM native_capture_files").fetchall()
    except sqlite3.Error:
        return {}
    finally:
        c.close()
    return {r[cols.index("path")]: dict(zip(cols, r)) for r in rows}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Report-only: native transcripts that would be archived.")
    ap.add_argument("--days", type=int, default=MIN_AGE_DAYS)
    ap.add_argument("--manifest", help="backup manifest json (default: latest in data/backup-manifests)")
    ap.add_argument("--ledger", default=os.path.join(ROOT, "data/memory.db"))
    ap.add_argument("--state-db", default=os.path.join(HOME, ".robob/userdata/statev2.sqlite"))
    args = ap.parse_args(argv)
    manifest = json.load(open(args.manifest)) if args.manifest else latest_manifest()
    ledger = load_ledger(args.ledger)
    settled = settled_threads(args.state_db)
    candidates = plan(transcript_roots.roots(), ledger, manifest, settled, min_age_days=args.days)
    print(json.dumps({"mode": "report-only", "deletes": 0, "candidates": len(candidates),
                      "manifest": (manifest or {}).get("stamp"), "items": candidates}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
