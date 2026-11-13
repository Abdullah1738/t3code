#!/opt/homebrew/bin/python3
"""Copy a data dir outside the vault into the backup stage.

    snapshot_extra.py SRC DB_DST FILES_DST [REQUIRED_DB...]

Used by health_backup.sh for pet records under ~/Documents. Under launchd,
macOS privacy rules stop /usr/bin/find, the Homebrew sqlite3 and rsync from
reading ~/Documents (they hang on a privacy prompt or fail, and the old shell
loop hid that: pets.db was never snapshotted). Homebrew python has Full Disk
Access, so it does the whole copy, and any listing or copy error fails the run.
A missing SRC is an error too: the dir is required.

SQLite DBs go to DB_DST through the backup API (consistent while others
write), switched to journal_mode=DELETE so each opens on its own, and must pass
quick_check. Every other file, dir and symlink is mirrored to FILES_DST (stale
entries removed). Each REQUIRED_DB (path relative to SRC) must be among the
snapshotted DBs: old copies under backups/ would otherwise keep the count
positive with the live DB gone. Prints the number of DBs snapshotted.

A read-only open of a WAL-mode DB can leave empty -wal/-shm files beside it.
They are left alone: removing SQLite's files next to a DB someone else may
open at the same moment can lose their commits.
"""
import fcntl
import os
import shutil
import signal
import sqlite3
import sys
import unicodedata
import urllib.parse

DB_EXT = (".db", ".sqlite", ".sqlite3")
SKIP = ("-wal", "-shm", "-journal", ".pyc", ".DS_Store")
# The backup API retries a busy source forever, and a privacy prompt can block
# an open; the default SIGALRM action ends the process even inside a C call,
# so the shell sees a failure instead of a run that never finishes.
DEADLINE_SECS = 600


def raise_error(err):
    raise err


def snapshot(path, out):
    if os.path.exists(out):
        os.remove(out)
    s = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(path), uri=True, timeout=30)
    try:
        t = sqlite3.connect(out)
        try:
            s.backup(t)
            t.execute("PRAGMA journal_mode=DELETE")
            return t.execute("PRAGMA quick_check").fetchone()[0]
        finally:
            t.close()
    finally:
        s.close()


def remove_tree(path):
    """Delete a stage tree. Copied dir modes can be read-only, which rmtree
    can't empty, so make the stage dirs writable first. Errors propagate."""
    if not os.path.lexists(path):
        return
    if os.path.islink(path) or not os.path.isdir(path):
        os.remove(path)
        return
    for d, dirs, _ in os.walk(path):
        os.chmod(d, 0o700)
        for x in dirs:
            p = os.path.join(d, x)
            if not os.path.islink(p):
                os.chmod(p, 0o700)
    shutil.rmtree(path)


def copy_link(path, out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    os.symlink(os.readlink(path), out)


def stage_path(path):
    """Normalized destination (no trailing slash, so a symlink there is
    replaced, not followed) whose parent has no symlinked component: the tree
    under it gets deleted, and must stay inside the stage. The caller passes a
    canonical stage root (pwd -P), so /var vs /private/var style aliases don't
    trip this."""
    path = os.path.normpath(os.path.abspath(path))
    parent = os.path.dirname(path)
    if os.path.realpath(parent) != parent:
        sys.exit("%s: destination parent goes through a symlink (pass a canonical path)" % path)
    return path


def fold(path):
    # APFS here is case- and normalization-insensitive: compare folded names,
    # which fails closed on a case-sensitive volume.
    return unicodedata.normalize("NFD", path).casefold()


# <sys/fcntl.h>; Python's fcntl module doesn't export it.
F_GETPATH_NOFIRMLINK = 102


def physical(path, follow=True):
    """The path the kernel reports for the deepest existing part of path, with
    the missing rest appended. That resolves firmlinks (/Users is
    /System/Volumes/Data/Users), symlinked ancestors such as /var and the
    stored letter case, so different spellings of one place compare equal by
    name. With follow=False a symlink at path itself stays the link, which is
    what remove_tree deletes."""
    path = os.path.normpath(os.path.abspath(path))
    rest = []
    while True:
        flags = os.O_EVTONLY | os.O_NONBLOCK
        if not follow and not rest:
            flags |= os.O_SYMLINK
        try:
            fd = os.open(path, flags)
        except (FileNotFoundError, NotADirectoryError):
            up = os.path.dirname(path)
            if up == path:
                raise
            rest.insert(0, os.path.basename(path))
            path = up
            continue
        try:
            got = fcntl.fcntl(fd, F_GETPATH_NOFIRMLINK, bytes(1024))
        finally:
            os.close(fd)
        return os.path.join(os.fsdecode(got.split(b"\0", 1)[0]), *rest)


def overlap(a, b):
    """a and b (physical paths) are the same tree or one contains the other."""
    fa, fb = fold(a), fold(b)
    return os.path.commonpath([fa, fb]) in (fa, fb)


def main(src, db_dst, files_dst, *required):
    # resolve symlinks before "..", and walk the same path the checks below
    # saw (normpath of link/../x would name a different directory)
    src = os.path.realpath(src)
    if not os.path.isdir(src):
        sys.exit("%s: not a readable directory" % src)
    db_dst, files_dst = stage_path(db_dst), stage_path(files_dst)
    files_new = files_dst + ".new"
    # every tree deleted below must be apart from SRC and from each other
    trees = [("SRC", physical(src)), ("DB_DST", physical(db_dst, False)),
             ("FILES_DST", physical(files_dst, False)), ("FILES_DST.new", physical(files_new, False))]
    for i, (na, a) in enumerate(trees):
        for nb, b in trees[i + 1:]:
            if overlap(a, b):
                sys.exit("%s %s overlaps %s %s" % (na, a, nb, b))
    # fresh trees, so nothing written below them goes through a symlink
    remove_tree(db_dst)
    os.makedirs(db_dst)
    n = 0
    done = set()
    remove_tree(files_new)
    os.makedirs(files_new)
    made = []
    for d, dirs, files in os.walk(src, onerror=raise_error):
        rel_dir = os.path.normpath(os.path.relpath(d, src))
        keep = []
        for x in sorted(dirs):
            if x == "__pycache__":
                continue
            path = os.path.join(d, x)
            if os.path.islink(path):
                copy_link(path, os.path.join(files_new, rel_dir, x))
            else:
                keep.append(x)
        dirs[:] = keep
        out_dir = os.path.join(files_new, rel_dir)
        os.makedirs(out_dir, exist_ok=True)
        made.append((d, out_dir))
        for f in sorted(files):
            path = os.path.join(d, f)
            rel = os.path.normpath(os.path.join(rel_dir, f))
            if f.endswith(SKIP):
                continue
            if os.path.islink(path):
                copy_link(path, os.path.join(files_new, rel))
            elif f.endswith(DB_EXT):
                out = os.path.join(db_dst, rel)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                q = snapshot(path, out)
                if q != "ok":
                    sys.exit("%s snapshot quick_check: %s" % (rel, q))
                done.add(rel)
                n += 1
            else:
                shutil.copy2(path, os.path.join(files_new, rel), follow_symlinks=False)
    # dir times last, deepest first, since writing into a dir changes its mtime
    for d, out_dir in reversed(made):
        shutil.copystat(d, out_dir, follow_symlinks=False)
    missing = [r for r in required if os.path.normpath(r) not in done]
    if missing:
        sys.exit("required DB not snapshotted: %s" % ", ".join(missing))
    remove_tree(files_dst)
    os.rename(files_new, files_dst)
    print(n)


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit("usage: snapshot_extra.py SRC DB_DST FILES_DST [REQUIRED_DB...]")
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.alarm(DEADLINE_SECS)
    main(*sys.argv[1:])
