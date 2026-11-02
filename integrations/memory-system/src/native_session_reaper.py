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
import hashlib
import json
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import transcript_backup_manifest  # noqa: E402
import transcript_roots  # noqa: E402

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".local/share/memory-system")
MANIFEST_DIR = os.path.join(ROOT, "data/backup-manifests")
MIN_AGE_DAYS = 180
# Backup paths use home directory names, while D1 calls the Claude instance
# claudeAgent. Do not infer a backup location for an unknown instance.
STAGED_DIRS = {
    "claude": ("claude", ("projects",)),
    "claudeAgent": ("claude", ("projects",)),
    "codex": ("codex", ("sessions", "archived_sessions")),
    "codex-cu": ("codex-cu", ("sessions", "archived_sessions")),
}


def latest_manifest(manifest_dir=MANIFEST_DIR):
    paths = sorted(glob.glob(os.path.join(manifest_dir, "*.json")))
    if not paths:
        return None
    try:
        with open(paths[-1]) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def captured_to_end(ledger, path, st):
    """A missing or stale checkpoint is not evidence of complete capture."""
    row = ledger.get(path)
    if not (isinstance(row, dict) and type(row.get("offset")) is int and row["offset"] == st.st_size
            and type(row.get("error_count")) is int and row["error_count"] == 0
            and type(row.get("inode")) is int and row["inode"] == st.st_ino
            and type(row.get("phys_size")) is int and row["phys_size"] == st.st_size
            and row.get("retired") == 0 and st.st_size > 0):
        return False
    head_len = row.get("head_len")
    if not (type(head_len) is int and 0 < head_len <= min(st.st_size, 4096)
            and isinstance(row.get("head_sha1"), str) and isinstance(row.get("tail_sha1"), str)):
        return False
    try:
        with open(path, "rb") as f:
            head = hashlib.sha1(f.read(head_len)).hexdigest()
            f.seek(max(0, st.st_size - 4096))
            tail = hashlib.sha1(f.read(st.st_size)).hexdigest()
    except OSError:
        return False
    return head == row["head_sha1"] and tail == row["tail_sha1"]


def settled_threads(state_db):
    """Thread ids of settled/archived kanban cards and archived app threads.
    Unknown or unreadable -> empty set (nothing becomes a candidate)."""
    out = set()
    if not state_db or not os.path.isfile(state_db):
        return out
    try:
        c = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=30)
        try:
            for (tid,) in c.execute(
                    "SELECT DISTINCT json_extract(json, '$.workThreadId') FROM ardud_kanban_cards "
                    "WHERE json_extract(json, '$.settledAt') IS NOT NULL"):
                if tid:
                    out.add(tid)
            for (tid,) in c.execute(
                    "SELECT thread_id FROM orchestration_v2_projection_threads WHERE archived_at IS NOT NULL"):
                if tid:
                    out.add(tid)
        finally:
            c.close()
    except sqlite3.Error:
        return set()
    return out


def manifest_entries(manifest):
    """Only unambiguous, complete entries from a transcript backup count."""
    if not isinstance(manifest, dict) or manifest.get("root") != "transcripts":
        return {}
    files = manifest.get("files")
    if not isinstance(files, list):
        return {}
    entries, duplicates = {}, set()
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            continue
        path = entry["path"]
        if path in entries or path in duplicates:
            entries.pop(path, None)
            duplicates.add(path)
        elif type(entry.get("size")) is int and entry["size"] >= 0 and isinstance(entry.get("sha256"), str):
            entries[path] = entry
        else:
            duplicates.add(path)
    return entries


def matches_backup(path, st, entry):
    if not entry or entry["size"] != st.st_size or os.path.islink(path):
        return False
    try:
        info = transcript_backup_manifest.file_info(path)
        after = os.stat(path)
    except (OSError, transcript_backup_manifest.Forbidden):
        return False
    # A file that changes while being hashed is not proven to match the backup.
    return (info["size"] == st.st_size and info["sha256"] == entry["sha256"] and
            (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns))


def plan(roots, ledger, manifest, settled, now=None, min_age_days=MIN_AGE_DAYS):
    """Return a report from the supplied evidence and current transcript files."""
    now = time.time() if now is None else now
    cutoff = now - min_age_days * 86400
    in_manifest = manifest_entries(manifest)
    out = []
    for r in roots:
        instance = r.get("instance")
        stage = STAGED_DIRS.get(instance)
        root = r.get("path") or r.get("root")
        if not r.get("exists") or not stage or not isinstance(root, str):
            continue
        root = os.path.expanduser(root)
        prefix, dirs = stage
        for subdir in dirs:
            d = os.path.join(root, subdir)
            for dirpath, _, names in os.walk(d):
                for name in names:
                    if not name.endswith(".jsonl"):
                        continue
                    full = os.path.join(dirpath, name)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    if st.st_mtime > cutoff:
                        continue
                    if not captured_to_end(ledger, full, st):
                        continue
                    thread = ledger.get(full, {}).get("thread_id")
                    if not thread or thread not in settled:
                        continue
                    key = os.path.join(prefix, os.path.relpath(full, root))
                    if not matches_backup(full, st, in_manifest.get(key)):
                        continue
                    out.append({"instance": instance, "path": full, "size": st.st_size,
                                "thread_id": thread})
    return out


def load_ledger(path):
    """Only use a ledger that explicitly binds each captured path to a thread.

    D1's current schema has no thread_id; until its identity mapping is wired in,
    it is unknown whether a file's thread is settled, so nothing is eligible.
    """
    if not path or not os.path.isfile(path):
        return {}
    try:
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
        try:
            cols = [d[1] for d in c.execute("PRAGMA table_info(native_capture_files)")]
            if not {"path", "offset", "error_count", "thread_id"} <= set(cols):
                return {}
            # Only a current, successful checkpoint with an unchanged inode and
            # physical size can attest to this specific representation.
            if not {"retired", "inode", "phys_size", "head_len", "head_sha1", "tail_sha1"} <= set(cols):
                return {}
            where = " WHERE retired=0"
            rows = c.execute("SELECT * FROM native_capture_files" + where).fetchall()
        finally:
            c.close()
    except sqlite3.Error:
        return {}
    result, ambiguous = {}, set()
    for row in rows:
        record = dict(zip(cols, row))
        key = record["path"]
        if not isinstance(key, str):
            continue
        if key in result or key in ambiguous:
            result.pop(key, None)
            ambiguous.add(key)
        else:
            result[key] = record
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description="Report-only: native transcripts that would be archived.")
    ap.add_argument("--days", type=int, default=MIN_AGE_DAYS)
    ap.add_argument("--manifest", help="backup manifest json (default: latest in data/backup-manifests)")
    ap.add_argument("--ledger", default=os.path.join(ROOT, "data/memory.db"))
    ap.add_argument("--state-db", default=os.path.join(HOME, ".robob/userdata/statev2.sqlite"))
    args = ap.parse_args(argv)
    if args.manifest:
        try:
            with open(args.manifest) as f:
                manifest = json.load(f)
        except (OSError, ValueError):
            manifest = None
    else:
        manifest = latest_manifest()
    ledger = load_ledger(args.ledger)
    settled = settled_threads(args.state_db)
    roots = transcript_roots.resolve() if hasattr(transcript_roots, "resolve") else transcript_roots.roots()
    candidates = plan(roots, ledger, manifest, settled, min_age_days=args.days)
    print(json.dumps({"mode": "report-only", "deletes": 0, "candidates": len(candidates),
                      "manifest": (manifest or {}).get("stamp"), "items": candidates}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
