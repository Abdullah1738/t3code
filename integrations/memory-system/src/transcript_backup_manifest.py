"""sha256 manifest of the staged transcript copies (backup stage, no credentials).

build(staged_root) walks the staged transcript dirs and lists path, size and
sha256 for every file. verify(manifest, staged_root) recomputes and fails on any
mismatch, so a backup only succeeds when the manifest matches the staged copy.

Credential/auth files and SQLite files are excluded here as well as in the
backup script, so a bad staging rule can't leak them into the manifest.
"""
import fnmatch
import hashlib
import json
import os
import sys
import time

EXCLUDE_NAMES = {".credentials.json", "auth.json", "settings.local.json"}
EXCLUDE_PATTERNS = ("*.key", "*.sqlite*", "*.db", "*.db-*", "*-wal", "*-shm")


def excluded(name):
    if name in EXCLUDE_NAMES:
        return True
    return any(fnmatch.fnmatch(name, p) for p in EXCLUDE_PATTERNS)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build(staged_root, stamp=None):
    """Manifest for every non-excluded file under staged_root (relative paths)."""
    files = []
    for dirpath, dirnames, filenames in os.walk(staged_root):
        dirnames.sort()
        for name in sorted(filenames):
            if excluded(name):
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, staged_root)
            files.append({"path": rel, "size": os.path.getsize(full), "sha256": sha256_file(full)})
    return {"stamp": stamp or time.strftime("%Y%m%dT%H%M%S"), "root": "transcripts", "files": files}


def verify(manifest, staged_root):
    """Return a list of problems (empty when the staged copy matches the manifest)."""
    problems = []
    listed = {f["path"]: f for f in manifest.get("files", [])}
    actual = build(staged_root)["files"]
    actual_map = {f["path"]: f for f in actual}
    for path in sorted(set(listed) - set(actual_map)):
        problems.append(f"missing in staged copy: {path}")
    for path in sorted(set(actual_map) - set(listed)):
        problems.append(f"not in manifest: {path}")
    for path in sorted(set(listed) & set(actual_map)):
        a, b = listed[path], actual_map[path]
        if a["size"] != b["size"] or a["sha256"] != b["sha256"]:
            problems.append(f"changed since manifest: {path}")
    return problems


def write(manifest, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, manifest["stamp"] + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=1)
    os.replace(tmp, path)
    return path


def main(argv):
    if argv[1:2] == ["build"] and len(argv) == 4:
        print(write(build(argv[2]), argv[3]))
        return 0
    if argv[1:2] == ["verify"] and len(argv) == 4:
        problems = verify(json.load(open(argv[2])), argv[3])
    else:
        print("usage: transcript_backup_manifest.py build <staged-root> <out-dir>\n"
              "       transcript_backup_manifest.py verify <manifest.json> <staged-root>", file=sys.stderr)
        return 2
    for p in problems:
        print("MISMATCH", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
