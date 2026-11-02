#!/opt/homebrew/bin/python3
"""Remove stale linked git worktrees that agents left behind.

A linked worktree is stale when ALL of these hold:
  - HEAD's last commit (committer date) is older than STALE_DAYS (60)
  - nothing is ahead: HEAD is contained in a remote-tracking ref, no staged/unstaged
    changes, no untracked files, no initialized submodules
  - it is not locked, not in the keep file, not the main worktree
  - no running OpenCode session and no OpenCode session activity in it for STALE_DAYS
  - no process has its cwd inside it, and it was not created in the last 7 days

Ignored files that are not regenerable (e.g. .env, tmp/ notes) are copied into a
tar archive on the SSD before removal. Removal uses plain `git worktree remove`
(no --force), which refuses anything git itself considers dirty. Branches, stashes
and the main checkout are never touched. Missing worktree directories are only
reported, never pruned.

Usage: worktree_reaper.py [--dry-run] [--limit N]
"""
import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import tarfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from active_sessions import snapshot  # noqa: E402

HOME = os.path.expanduser("~")
STALE_DAYS = int(os.environ.get("WORKTREE_STALE_DAYS", "60"))
CREATED_MIN_DAYS = 7
MAX_PER_RUN = 50
OC_DB = f"{HOME}/.local/share/opencode/opencode.db"
LOG_DIR = f"{HOME}/.local/share/dev-janitor"
AUDIT = f"{LOG_DIR}/worktree_reaper.jsonl"
STATUS = f"{LOG_DIR}/worktree_reaper_last.json"
KEEP_FILE = f"{HOME}/.config/opencode/worktree-reaper-keep.txt"
ARCHIVE_ROOT = "/Volumes/ExternalSSD/worktree-reaper-archive"
SCAN_ROOTS = [(HOME, 3), ("/Volumes/ExternalSSD", 3)]
FIND_PRUNE = ["node_modules", "Library", ".Trash", "worktree-reaper-archive", "memory-system-backup"]
# ignored paths that can be rebuilt; anything else ignored gets archived before removal
REGEN = {"node_modules", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", "coverage",
         "target", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
         ".gradle", "Pods", ".expo", ".expo-shared", "DerivedData", ".DS_Store", ".parcel-cache",
         ".svelte-kit", ".vite", "vendor", "bin", "obj", ".terraform", ".tox", "storybook-static",
         ".eslintcache", "tsconfig.tsbuildinfo", ".serverless", ".sst", "playwright-report",
         "test-results", ".husky"}
REGEN_SUFFIX = (".pyc", ".log", ".tsbuildinfo")
os.environ["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
os.environ["GIT_OPTIONAL_LOCKS"] = "0"  # read-only status must not rewrite the index


def git(args, cwd=None, timeout=60):
    p = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr.strip()


def keep_list():
    try:
        return [l.strip().rstrip("/") for l in open(KEEP_FILE) if l.strip() and not l.startswith("#")]
    except FileNotFoundError:
        return []


def inside(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def common_dir(d):
    rc, out, _ = git(["-C", d, "rev-parse", "--path-format=absolute", "--git-common-dir"], timeout=20)
    return os.path.realpath(out.strip()) if rc == 0 and out.strip() else None


def discover(session_dirs):
    commons = set()
    for d in session_dirs:
        if os.path.isdir(d):
            c = common_dir(d)
            if c:
                commons.add(c)
    for root, depth in SCAN_ROOTS:
        if not os.path.isdir(root):
            continue
        cmd = ["find", root, "-maxdepth", str(depth)]
        for n in FIND_PRUNE:
            cmd += ["-name", n, "-prune", "-o"]
        cmd += ["-name", ".git", "-print"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        for g in p.stdout.splitlines():
            c = common_dir(os.path.dirname(g))
            if c:
                commons.add(c)
    return sorted(commons)


def worktrees(common):
    rc, out, err = git(["--git-dir", common, "worktree", "list", "--porcelain"])
    if rc != 0:
        return [], err
    res = []
    for i, block in enumerate(b for b in out.split("\n\n") if b.strip()):
        w = {"main": i == 0, "common": common}
        for line in block.splitlines():
            k, _, v = line.partition(" ")
            w[k] = v or True
        res.append(w)
    return res, None


def running_dirs(c):
    """Directories of every active OpenCode session and every active Robob thread (Claude and Codex included).

    Raises when the active set is incomplete: the caller then keeps every worktree (see main()).
    """
    snap = snapshot(timeout=30)
    if not snap["complete"]:
        raise RuntimeError("cannot read the complete active set: " + "; ".join(snap["problems"]))
    dirs = set()
    for sid in snap["opencode"]:
        row = c.execute("SELECT directory FROM session_v2 WHERE id=?", (sid,)).fetchone()
        if row and row[0]:
            dirs.add(row[0].rstrip("/"))
    # Each in-use thread's directory comes from this same snapshot: a root-workspace thread resolves to its
    # project root. The snapshot is complete here, so every in-use thread has one.
    dirs.update(d.rstrip("/") for d in snap["workspaces"].values())
    return dirs


def session_activity(c):
    act = {}
    for d, t in c.execute("SELECT directory, max(max(time_updated, coalesce(time_viewed, 0))) "
                          "FROM session_v2 WHERE directory IS NOT NULL GROUP BY directory"):
        act[d.rstrip("/")] = t / 1000
    return act


def process_cwds():
    p = subprocess.run(["lsof", "-n", "-P", "-d", "cwd", "-Fpn"], capture_output=True, text=True, timeout=120)
    cwds, pid = [], None
    for line in p.stdout.splitlines():
        if line.startswith("p"):
            pid = line[1:]
        elif line.startswith("n") and pid:
            cwds.append((pid, line[1:]))
    if p.returncode not in (0, 1) or not cwds:
        raise RuntimeError(f"lsof failed rc={p.returncode}")
    return cwds


def regenerable(path):
    parts = path.rstrip("/").split("/")
    return any(x in REGEN for x in parts) or path.endswith(REGEN_SUFFIX)


def evaluate(w, now, running, activity, cwds, keep):
    path = w["worktree"]
    r = {"path": path, "common": w["common"], "branch": (w.get("branch") or "").replace("refs/heads/", "") or None,
         "head": w.get("HEAD"), "reasons": []}
    why = r["reasons"]
    if w["main"]:
        why.append("main_worktree")
        return r
    if w.get("bare"):
        why.append("bare")
        return r
    if w.get("locked"):
        why.append("locked")
    if not os.path.isdir(path):
        why.append("missing_directory")
        return r
    rp = os.path.realpath(path)
    if any(inside(path, k) or inside(rp, k) for k in keep):
        why.append("keep_file")
    rc, out, err = git(["-C", path, "log", "-1", "--format=%ct"])
    if rc != 0 or not out.strip():
        why.append(f"no_head_commit:{err[:80]}")
        return r
    r["last_commit"] = int(out.strip())
    age_days = (now - r["last_commit"]) / 86400
    r["last_commit_days"] = round(age_days, 1)
    if age_days <= STALE_DAYS:
        why.append("recent_commit")
    rc, out, err = git(["-C", path, "rev-list", "--count", "HEAD", "--not", "--remotes"])
    if rc != 0:
        why.append(f"ahead_check_failed:{err[:80]}")
    elif int(out.strip() or 0) > 0:
        why.append(f"ahead_of_remotes:{out.strip()}")
    for d in running:
        if inside(d, path) or inside(d, rp):
            why.append("running_session")
            break
    last_sess = max([t for d, t in activity.items() if inside(d, path) or inside(d, rp)], default=0)
    if last_sess:
        r["last_session_days"] = round((now - last_sess) / 86400, 1)
        if now - last_sess < STALE_DAYS * 86400:
            why.append("recent_session")
    users = [pid for pid, c in cwds if inside(c, path) or inside(c, rp)]
    if users:
        why.append(f"process_cwd:{','.join(users[:5])}")
    gitdir = w.get("gitdir") or ""
    rc, out, _ = git(["-C", path, "rev-parse", "--path-format=absolute", "--git-dir"])
    gitdir = out.strip() if rc == 0 else gitdir
    try:
        created = os.stat(os.path.join(gitdir, "commondir")).st_birthtime
        r["created_days"] = round((now - created) / 86400, 1)
        if now - created < CREATED_MIN_DAYS * 86400:
            why.append("created_recently")
    except OSError:
        why.append("gitdir_unreadable")
    r["gitdir"] = gitdir
    if why:  # already kept; skip the expensive filesystem checks
        return r
    rc, out, err = git(["-C", path, "status", "--porcelain=v1", "--ignored"], timeout=180)
    if rc != 0:
        why.append(f"status_failed:{err[:80]}")
    else:
        dirty = [l for l in out.splitlines() if l and not l.startswith("!! ")]
        if dirty:
            why.append(f"uncommitted_or_untracked:{len(dirty)}")
        r["ignored_keep"] = [l[3:] for l in out.splitlines() if l.startswith("!! ") and not regenerable(l[3:])]
        # never let removal take a nested repo/worktree or a big pile of ignored data with it
        size = 0
        for rel in r["ignored_keep"]:
            full = os.path.join(path, rel.rstrip("/"))
            if os.path.isdir(full):
                p = subprocess.run(["find", full, "-name", ".git", "-print", "-quit"], capture_output=True,
                                   text=True, timeout=120)
                if p.stdout.strip():
                    why.append("nested_repo_in_ignored")
                    break
                p = subprocess.run(["du", "-sk", full], capture_output=True, text=True, timeout=120)
                size += int((p.stdout.split() or ["0"])[0]) * 1024
            elif os.path.exists(full):
                size += os.path.getsize(full)
        r["ignored_keep_bytes"] = size
        if size > 500 * 1024 * 1024:
            why.append("large_ignored_data")
    rc, out, _ = git(["-C", path, "submodule", "status", "--recursive"])
    if rc == 0 and any(l and not l.startswith("-") for l in out.splitlines()):
        why.append("submodules")
    return r


def archive_ignored(r):
    if not r.get("ignored_keep"):
        return None
    if not os.path.isdir(os.path.dirname(ARCHIVE_ROOT)):
        raise RuntimeError("archive volume not mounted")
    day = time.strftime("%Y%m%d")
    os.makedirs(f"{ARCHIVE_ROOT}/{day}", exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", r["path"].strip("/"))[-150:]
    dest = f"{ARCHIVE_ROOT}/{day}/{name}.tar.gz"
    with tarfile.open(dest, "w:gz") as tf:
        for rel in r["ignored_keep"]:
            tf.add(os.path.join(r["path"], rel.rstrip("/")), arcname=rel.rstrip("/"),
                   filter=lambda ti: None if regenerable(ti.name) else ti)
    with tarfile.open(dest) as tf:  # verify readable
        n = len(tf.getmembers())
    return {"archive": dest, "members": n}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=MAX_PER_RUN)
    a = ap.parse_args()
    t0 = time.time()
    os.makedirs(LOG_DIR, exist_ok=True)
    st = {"ts": int(t0), "dry_run": a.dry_run, "state": "done", "removed": [], "would_remove": [],
          "kept": {}, "missing_directories": [], "errors": []}
    try:
        c = sqlite3.connect(f"file:{OC_DB}?mode=ro", uri=True, timeout=30)
        running = running_dirs(c)
        activity = session_activity(c)
        cwds = process_cwds()
        keep = keep_list()
        commons = discover(set(activity))
        st["repos"] = len(commons)
        cands = []
        total = 0
        for common in commons:
            wts, err = worktrees(common)
            if err:
                st["errors"].append(f"{common}: {err[:120]}")
            for w in wts:
                total += 1
                r = evaluate(w, t0, running, activity, cwds, keep)
                if "missing_directory" in r["reasons"]:
                    st["missing_directories"].append(r["path"])
                for x in r["reasons"]:
                    k = x.split(":")[0]
                    st["kept"][k] = st["kept"].get(k, 0) + 1
                if not r["reasons"]:
                    cands.append(r)
        st["worktrees"] = total
        st["stale"] = len(cands)
        cands.sort(key=lambda r: r["last_commit"])
        for r in cands[:a.limit]:
            info = {k: r.get(k) for k in ("path", "common", "branch", "head", "last_commit_days",
                                          "last_session_days", "created_days")}
            info["ignored_archived"] = len(r.get("ignored_keep") or [])
            if a.dry_run:
                st["would_remove"].append(info)
                continue
            # re-check right before removal
            again = evaluate({"worktree": r["path"], "common": r["common"], "main": False,
                              "HEAD": r["head"], "branch": r.get("branch")},
                             time.time(), running_dirs(c), session_activity(c), process_cwds(), keep_list())
            if again["reasons"] or again.get("head") != r["head"]:
                st["kept"]["changed_before_remove"] = st["kept"].get("changed_before_remove", 0) + 1
                continue
            try:
                arc = archive_ignored(again)
            except Exception as e:  # noqa: BLE001
                st["errors"].append(f"{r['path']}: archive failed: {e}")
                continue
            rc, out, err = git(["--git-dir", r["common"], "worktree", "remove", r["path"]], timeout=600)
            if rc != 0:
                st["errors"].append(f"{r['path']}: worktree remove failed: {err[:200]}")
                continue
            info.update(arc or {})
            info["removed_at"] = int(time.time())
            info["restore"] = (f"git --git-dir {r['common']} worktree add {r['path']} "
                               f"{r.get('branch') or r['head']}")
            st["removed"].append(info)
            with open(AUDIT, "a") as f:
                f.write(json.dumps(info) + "\n")
        st["remaining_stale"] = len(cands) - len(st["removed"]) - len(st["would_remove"])
    except Exception as e:  # noqa: BLE001
        st["state"] = "error"
        st["errors"].append(f"{type(e).__name__}: {e}")
    if len(st["errors"]) >= 5:
        st["state"] = "error"
    st["duration_s"] = round(time.time() - t0, 1)
    if not a.dry_run:
        json.dump(st, open(STATUS, "w"), indent=1)
    json.dump(st, sys.stdout, indent=1)
    print()
    return 0 if st["state"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
