#!/opt/homebrew/bin/python3
"""Prune agent and test leftovers from $TMPDIR (internal SSD, wiped at boot).

  tmpdir_prune.py scan             read-only; JSON summary of what apply would remove
  tmpdir_prune.py scan --list      ...plus every candidate path
  tmpdir_prune.py apply            re-scans, removes candidates, appends to the audit log

Why: macOS wipes $TMPDIR on every boot, and a ~280 GB wipe is the likely cause of
the 2026-10-16 boot hangs. Two test leaks refill it between boots:
  - vitest <5.0.3 (vite-plus <1.1.0) never removes its root temp dir: one
    $TMPDIR/<21-char nanoid>/ssr/ of ~20 MB per run.
  - crpko-devops guard tests mkdtemp a dir per case and never remove it
    (tens of thousands of tiny dirs a day).
Agent scratch in $TMPDIR/opencode is only reported, never removed here: Crpko
review checkouts live there, so deleting it stays a manual call (owner, 22 Oct).

Removed by apply (older than TEST_IDLE_HOURS by newest mtime, deep):
  vitest   $TMPDIR/<nanoid21> holding only ssr/
  guard    $TMPDIR/<known crpko test prefix>*
Reported only (opencode_stale): $TMPDIR/opencode/<entry> unchanged for
OPENCODE_IDLE_DAYS, minus entries holding a registered git worktree (kept_worktrees).
Never touched: anything a process uses (cwd or open file), symlinks are not followed,
and entries listed in ~/.config/opencode/dev-janitor-keep.txt (one path per line).
Stdlib only.
"""
import argparse, fcntl, json, os, re, shutil, subprocess, sys, time

def user_tmp():
    # robob-watch runs checks with only HOME/PATH/LANG, so TMPDIR is often unset.
    try:
        path = os.environ.get("TMPDIR") or subprocess.run(
            ["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True,
            check=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return ""
    return os.path.realpath(path) if path else ""


TMP = user_tmp()
OPENCODE = os.path.join(TMP, "opencode")
TEST_IDLE_HOURS = float(os.environ.get("TMPDIR_PRUNE_TEST_HOURS", "24"))
OPENCODE_IDLE_DAYS = float(os.environ.get("TMPDIR_PRUNE_OPENCODE_DAYS", "3"))
LOG_DIR = os.path.expanduser(os.environ.get("DEV_JANITOR_LOG_DIR", "~/.local/share/dev-janitor"))
AUDIT = os.path.join(LOG_DIR, "tmpdir-audit.jsonl")
KEEP_FILE = os.path.expanduser("~/.config/opencode/dev-janitor-keep.txt")
NANOID = re.compile(r"^[A-Za-z0-9_-]{21}$")
# crpko-devops scripts/test-*.mjs mkdtempSync prefixes that are never cleaned up.
GUARD_PREFIXES = (
    "coord-scope-guard-", "coord-scope-apply-", "coord-scope-report-",
    "grow-agent-render-", "crpko-fdb-plan-guard-", "crpko-fdb-targets-",
)


class UsageUnavailable(Exception):
    def __init__(self, skipped, reason):
        self.skipped, self.reason = skipped, reason


def walk(path):
    """(newest mtime, bytes on disk, files) for a tree, without following symlinks."""
    try:
        st = os.lstat(path)
    except OSError as err:
        raise UsageUnavailable("tree_unavailable", type(err).__name__) from err
    newest, size, files = st.st_mtime, st.st_blocks * 512, 0
    stack = [path] if os.path.isdir(path) and not os.path.islink(path) else []
    if not stack:
        return newest, size, 1
    while stack:
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError as err:
            raise UsageUnavailable("tree_unavailable", type(err).__name__) from err
        with it:
            for e in it:
                try:
                    s = e.stat(follow_symlinks=False)
                except OSError as err:
                    raise UsageUnavailable("tree_unavailable", type(err).__name__) from err
                newest = max(newest, s.st_mtime)
                size += s.st_blocks * 512
                if e.is_dir(follow_symlinks=False):
                    stack.append(e.path)
                else:
                    files += 1
    return newest, size, files


def in_use():
    """Paths under $TMPDIR that a process has as cwd or holds open."""
    try:
        r = subprocess.run(["/usr/sbin/lsof", "-n", "-w", "-F", "n", "+c0"],
                           capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as err:
        raise UsageUnavailable("lsof_unavailable", "timed out after 120 seconds") from err
    except (OSError, subprocess.SubprocessError, UnicodeError) as err:
        raise UsageUnavailable("lsof_unavailable", type(err).__name__) from err
    if r.returncode != 0:
        raise UsageUnavailable("lsof_unavailable", f"exited {r.returncode}")
    if (r.stderr or not isinstance(r.stdout, str) or not r.stdout.strip()
            or not r.stdout.endswith("\n") or "\x00" in r.stdout):
        raise UsageUnavailable("lsof_unavailable", "unreadable output or diagnostics")
    used = set()
    process, file, named = False, False, False
    for line in r.stdout.splitlines():
        # -F n also emits process/file delimiters. Reject incomplete/foreign output rather than
        # treating an unreadable snapshot as proof that no temporary files are open.
        if re.fullmatch(r"p[0-9]+", line):
            if process and not named:
                raise UsageUnavailable("lsof_unavailable", "incomplete process record")
            process, file, named = True, False, False
        elif line.startswith("f") and len(line) > 1 and process:
            if file and not named:
                raise UsageUnavailable("lsof_unavailable", "incomplete file record")
            if line[1:].upper() in {"ERR", "NOFD"}:
                raise UsageUnavailable("lsof_unavailable", "unreadable file descriptors")
            file, named = True, False
        elif line.startswith("n") and file:
            # macOS NPOLICY descriptors have an explicit empty name. That is a complete record;
            # a missing name field still leaves the file's use unknown.
            named = True
        else:
            raise UsageUnavailable("lsof_unavailable", "unreadable output")
        if line.startswith("n") and TMP in line:
            p = line[1:]
            p = p[p.index(TMP):] if TMP in p else p
            used.add(p)
    if not named:
        raise UsageUnavailable("lsof_unavailable", "incomplete final record")
    return used


def used_under(path, used):
    prefix = path + os.sep
    return any(u == path or u.startswith(prefix) for u in used)


def keep_list():
    try:
        with open(KEEP_FILE) as f:
            return {os.path.realpath(os.path.expanduser(l.strip())) for l in f
                    if l.strip() and not l.startswith("#")}
    except FileNotFoundError:
        return set()
    except (OSError, UnicodeError) as err:
        raise UsageUnavailable("keep_list_unavailable", type(err).__name__) from err


def linked_worktree(path, depth=4):
    """True when a registered git worktree (.git file) sits under path; removing it
    would leave a stale registration (and a locked branch) in its main repo."""
    stack = [(path, 0)]
    while stack:
        d, n = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                if e.name == ".git" and e.is_file(follow_symlinks=False):
                    return True
                if n < depth and e.is_dir(follow_symlinks=False) and e.name != "node_modules":
                    stack.append((e.path, n + 1))
    return False


def classify(name, path):
    if NANOID.match(name) and os.path.isdir(path) and not os.path.islink(path):
        try:
            if set(os.listdir(path)) == {"ssr"}:
                return "vitest"
        except OSError:
            return None
    if name.startswith(GUARD_PREFIXES):
        return "guard"
    return None


def scan():
    try:
        return scan_available()
    except UsageUnavailable as err:
        return {"skipped": err.skipped, "reason": err.reason}
    except OSError as err:
        return {"skipped": "tree_unavailable", "reason": type(err).__name__}


def scan_available():
    now = time.time()
    used, keep = in_use(), keep_list()
    out = {"tmpdir": TMP, "classes": {}, "candidates": [], "kept_in_use": 0, "kept_young": 0,
           "kept_worktrees": [], "opencode_stale": {"entries": 0, "bytes": 0, "top": []}}

    def consider(cls, path, idle_s):
        if path in keep or used_under(path, used):
            out["kept_in_use"] += 1
            return
        newest, size, files = walk(path)
        if now - newest < idle_s:
            out["kept_young"] += 1
            return
        if cls == "opencode":
            if linked_worktree(path):
                out["kept_worktrees"].append({"path": path, "bytes": size})
                return
            stale = out["opencode_stale"]
            stale["entries"] += 1
            stale["bytes"] += size
            stale["top"].append({"path": path, "bytes": size,
                                 "idle_h": round((now - newest) / 3600, 1)})
            return
        c = out["classes"].setdefault(cls, {"entries": 0, "bytes": 0, "files": 0})
        c["entries"] += 1
        c["bytes"] += size
        c["files"] += files
        out["candidates"].append({"class": cls, "path": path, "bytes": size,
                                  "idle_h": round((now - newest) / 3600, 1)})

    with os.scandir(TMP) as it:
        for e in it:
            cls = classify(e.name, e.path)
            if cls:
                consider(cls, e.path, TEST_IDLE_HOURS * 3600)
    if os.path.isdir(OPENCODE) and not os.path.islink(OPENCODE):
        with os.scandir(OPENCODE) as it:
            for e in it:
                consider("opencode", e.path, OPENCODE_IDLE_DAYS * 86400)
    out["opencode_stale"]["top"].sort(key=lambda x: -x["bytes"])
    return out


def apply():
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "tmpdir-prune.lock"), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"skipped": "another prune is running"}
        return apply_locked()


def apply_locked():
    res = scan()
    if "skipped" in res:
        entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": "tmpdir_prune", **res}
        with open(AUDIT, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return entry
    removed, failed, freed = 0, [], 0
    for c in res["candidates"]:
        p = c["path"]
        # Re-check right before removal: the scan can take minutes.
        if not os.path.realpath(p).startswith(TMP + os.sep) or os.path.islink(p):
            failed.append({"path": p, "error": "outside $TMPDIR or symlink"})
            continue
        try:
            if os.path.isdir(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
            removed += 1
            freed += c["bytes"]
        except OSError as err:
            failed.append({"path": p, "error": str(err)})
    stale = res["opencode_stale"]
    entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "removed": removed,
             "freed_bytes": freed, "classes": res["classes"], "failed": failed[:20],
             "opencode_stale": {"entries": stale["entries"], "bytes": stale["bytes"],
                                "top": stale["top"][:10]}}
    with open(AUDIT, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return entry


def main():
    from io_priority import throttle_disk
    throttle_disk()
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["scan", "apply"])
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if not TMP:
        if a.cmd == "apply":
            os.makedirs(LOG_DIR, exist_ok=True)
            with open(AUDIT, "a") as f:
                f.write(json.dumps({"event": "tmpdir_prune", "skipped": "tmpdir_unavailable",
                                    "reason": "could not resolve user temp directory"}) + "\n")
        return 0
    if not TMP.startswith("/private/var/folders/"):
        print(f"tmpdir_prune: refusing to run on {TMP or 'an unknown dir'}", file=sys.stderr)
        return 2
    if a.cmd == "scan":
        res = scan()
        if "skipped" not in res:
            res["total_bytes"] = sum(c["bytes"] for c in res["classes"].values())
        if "skipped" not in res and not a.list:
            res["candidates"] = len(res["candidates"])
            res["kept_worktrees"] = len(res["kept_worktrees"])
            res["opencode_stale"]["top"] = res["opencode_stale"]["top"][:10]
        print(json.dumps(res, indent=1))
    else:
        apply()
    return 0


if __name__ == "__main__":
    sys.exit(main())
