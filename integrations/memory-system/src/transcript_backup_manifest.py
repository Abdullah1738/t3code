"""Prepare the transcript replica and verify its exact, credential-free manifest."""
import datetime
import fnmatch
import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile

EXCLUDE_NAMES = {".credentials.json", "auth.json", "settings.local.json"}
EXCLUDE_PATTERNS = ("*.key", "*.sqlite*", "*.db", "*.db-*", "*-wal", "*-shm")


def excluded(name):
    return name in EXCLUDE_NAMES or any(fnmatch.fnmatchcase(name, p) for p in EXCLUDE_PATTERNS)


class Forbidden(Exception):
    """The staged tree contains an entry that must not be snapshotted."""


def ensure_directory(path):
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        os.mkdir(path)
        mode = os.lstat(path).st_mode
    if not stat.S_ISDIR(mode):
        raise Forbidden(f"not a real directory: {path}")


def remove_entry(path, mode):
    # Neither a symlink to a directory nor anything beneath it is followed.
    if stat.S_ISDIR(mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def prepare(stage, pairs):
    """Remove unsafe entries from the replica, including roots not synced this run."""
    if not stat.S_ISDIR(os.lstat(stage).st_mode):
        raise Forbidden(f"not a real directory: {stage}")
    files = os.path.join(stage, "files")
    root = os.path.join(files, "transcripts")
    ensure_directory(files)
    ensure_directory(root)

    def clean(directory):
        with os.scandir(directory) as entries:
            for entry in entries:
                mode = entry.stat(follow_symlinks=False).st_mode
                if excluded(entry.name) or stat.S_ISLNK(mode):
                    remove_entry(entry.path, mode)
                elif stat.S_ISDIR(mode):
                    clean(entry.path)
                elif not stat.S_ISREG(mode):
                    raise Forbidden(f"unsupported staged entry: {entry.path}")

    clean(root)
    for pair in pairs:
        parts = pair.split("/")
        if len(parts) != 2 or any(not part or part in (".", "..") for part in parts):
            raise ValueError(f"invalid transcript root: {pair}")
        path = root
        for part in parts:
            path = os.path.join(path, part)
            ensure_directory(path)

    # Only this run's manifest belongs next to the staged transcripts. This
    # directory is entirely within the replica, never a live source directory.
    manifests = os.path.join(files, "transcript-manifest")
    if os.path.lexists(manifests):
        remove_entry(manifests, os.lstat(manifests).st_mode)
    ensure_directory(manifests)


def file_info(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(path, flags), "rb") as f:
        before = os.fstat(f.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise Forbidden(f"not a regular file: {path}")
        digest = hashlib.sha256()
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
        after = os.fstat(f.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise Forbidden(f"file changed while hashing: {path}")
    return {"size": after.st_size, "sha256": digest.hexdigest()}


def scan(staged_root):
    """Return all regular files and unsafe entries; never follow symlinks."""
    if not stat.S_ISDIR(os.lstat(staged_root).st_mode):
        raise Forbidden(f"not a real directory: {staged_root}")
    files, unsafe = [], []

    def visit(directory):
        # scandir errors are propagated: an unreadable subtree cannot look empty.
        with os.scandir(directory) as entries:
            for entry in sorted(entries, key=lambda item: item.name):
                rel = os.path.relpath(entry.path, staged_root)
                mode = entry.stat(follow_symlinks=False).st_mode
                if excluded(entry.name):
                    unsafe.append(f"forbidden file in staged copy: {rel}")
                elif stat.S_ISLNK(mode):
                    unsafe.append(f"symlink in staged copy: {rel}")
                elif stat.S_ISDIR(mode):
                    visit(entry.path)
                elif stat.S_ISREG(mode):
                    files.append({"path": rel, **file_info(entry.path)})
                else:
                    unsafe.append(f"unsupported entry in staged copy: {rel}")

    visit(staged_root)
    return files, unsafe


def build(staged_root, stamp=None):
    files, unsafe = scan(staged_root)
    if unsafe:
        raise Forbidden("; ".join(unsafe[:5]))
    # Keep the local-time ordering used by older manifests, with microseconds to
    # avoid replacing a prior manifest when two backups run in the same second.
    stamp = stamp or datetime.datetime.now().strftime("%Y%m%dT%H%M%S%f")
    return {"stamp": stamp, "root": "transcripts", "files": files}


def verify(manifest, staged_root):
    """Return problems unless paths, sizes and hashes match exactly."""
    if not isinstance(manifest, dict) or manifest.get("root") != "transcripts":
        return ["invalid manifest root"]
    entries = manifest.get("files")
    if not isinstance(entries, list):
        return ["invalid manifest files"]
    listed = {}
    for item in entries:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            return ["invalid manifest entry"]
        path = item["path"]
        if path in listed:
            return [f"duplicate manifest path: {path}"]
        if not isinstance(item.get("size"), int) or not isinstance(item.get("sha256"), str):
            return [f"invalid manifest entry: {path}"]
        listed[path] = item
    actual, problems = scan(staged_root)
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


def atomic_write(out_dir, name, content):
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".manifest-", dir=out_dir)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        path = os.path.join(out_dir, name)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path


def write(manifest, out_dir):
    return atomic_write(out_dir, manifest["stamp"] + ".json", json.dumps(manifest, indent=1).encode())


def publish(manifest_path, staged_root, out_dir):
    with open(manifest_path, "rb") as f:
        content = f.read()
    manifest = json.loads(content)
    problems = verify(manifest, staged_root)
    if problems:
        raise Forbidden("; ".join(problems[:5]))
    name = os.path.basename(manifest_path)
    if name != manifest.get("stamp", "") + ".json":
        raise Forbidden("manifest stamp does not match its filename")
    return atomic_write(out_dir, name, content)


def main(argv):
    try:
        if argv[1:2] == ["prepare"] and len(argv) >= 3:
            prepare(argv[2], argv[3:])
            return 0
        if argv[1:2] == ["build"] and len(argv) == 4:
            print(write(build(argv[2]), argv[3]))
            return 0
        if argv[1:2] == ["verify"] and len(argv) == 4:
            with open(argv[2]) as f:
                problems = verify(json.load(f), argv[3])
            for problem in problems:
                print("MISMATCH", problem)
            return 1 if problems else 0
        if argv[1:2] == ["publish"] and len(argv) == 5:
            print(publish(argv[2], argv[3], argv[4]))
            return 0
    except (Forbidden, OSError, ValueError) as e:
        print(f"transcript manifest: {e}", file=sys.stderr)
        return 1
    print("usage: transcript_backup_manifest.py prepare <stage> [instance/root ...]\n"
          "       transcript_backup_manifest.py build <staged-root> <out-dir>\n"
          "       transcript_backup_manifest.py verify <manifest.json> <staged-root>\n"
          "       transcript_backup_manifest.py publish <manifest.json> <staged-root> <out-dir>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
