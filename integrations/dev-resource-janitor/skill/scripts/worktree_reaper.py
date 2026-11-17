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
import shlex
import subprocess
import sys
import tarfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import active_sessions  # noqa: E402

HOME = os.path.expanduser("~")
STALE_DAYS = int(os.environ.get("WORKTREE_STALE_DAYS", "60"))
CREATED_MIN_DAYS = 7
MAX_PER_RUN = 50
LOG_DIR = f"{HOME}/.local/share/dev-janitor"
AUDIT = f"{LOG_DIR}/worktree_reaper.jsonl"
STATUS = f"{LOG_DIR}/worktree_reaper_last.json"
HISTORY_CACHE = f"{LOG_DIR}/session-history.json"
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


class Timeouts:
    def __init__(self):
        self.events = []
        self.skipped = []
        self.wait_s = 0

    def run(self, cmd, path, phase, timeout, retry=False, cwd=None):
        for attempt in range(1, 3 if retry else 2):
            started = time.monotonic()
            try:
                result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                elapsed = time.monotonic() - started
                self.wait_s += elapsed
                event = 'timeout'
            else:
                if attempt == 1:
                    return result
                elapsed = time.monotonic() - started
                event = 'retry_complete'
            row = dict(path=path, cmd=shlex.join(cmd), timeout_s=timeout, attempt=attempt,
                       phase=phase, event=event, duration_s=round(elapsed, 3))
            self.events.append(row)
            print('worktree_reaper_command ' + json.dumps(row), flush=True)
            if event == 'retry_complete':
                return result
            if not retry or attempt == 2:
                raise subprocess.TimeoutExpired(cmd, timeout)

    def skip(self, path, phase, error):
        row = dict(path=path, cmd=shlex.join(error.cmd), timeout_s=error.timeout, phase=phase)
        if row not in self.skipped:
            self.skipped.append(row)

    def blocked(self, path):
        path = os.path.realpath(path)
        return any(inside(path, os.path.realpath(row['path'])) or
                   inside(os.path.realpath(row['path']), path) for row in self.skipped)


def git(args, cwd=None, timeout=60, *, timeouts=None, path=None, phase='check', retry=True):
    p = (timeouts or Timeouts()).run(["git"] + args, path or cwd, phase, timeout, retry, cwd)
    return p.returncode, p.stdout, p.stderr.strip()


def keep_list():
    try:
        return [l.strip().rstrip("/") for l in open(KEEP_FILE) if l.strip() and not l.startswith("#")]
    except FileNotFoundError:
        return []


def inside(path, root):
    return path == root or path.startswith(root.rstrip("/") + "/")


def common_dir(d, timeouts=None):
    try:
        rc, out, _ = git(["-C", d, "rev-parse", "--path-format=absolute", "--git-common-dir"], timeout=20,
                         timeouts=timeouts, path=d, phase='discover')
    except subprocess.TimeoutExpired as error:
        if timeouts is not None:
            timeouts.skip(d, 'discover', error)
        return None
    return os.path.realpath(out.strip()) if rc == 0 and out.strip() else None


def discover(session_dirs, timeouts=None):
    timeouts = timeouts or Timeouts()
    commons = set()
    seen = set()

    def add(d):
        canonical = os.path.realpath(d)
        if canonical in seen:
            return
        seen.add(canonical)
        c = common_dir(d, timeouts)
        if c:
            commons.add(c)

    for d in sorted(session_dirs):
        if os.path.isdir(d):
            add(d)
    for root, depth in SCAN_ROOTS:
        if not os.path.isdir(root):
            continue
        cmd = ["find", root, "-maxdepth", str(depth)]
        for n in FIND_PRUNE:
            cmd += ["-name", n, "-prune", "-o"]
        cmd += ["-name", ".git", "-print"]
        try:
            p = timeouts.run(cmd, root, 'discover', 300)
        except subprocess.TimeoutExpired as error:
            timeouts.skip(root, 'discover', error)
            continue
        for g in p.stdout.splitlines():
            add(os.path.dirname(g))
    return sorted(commons)


def worktrees(common, timeouts=None):
    rc, out, err = git(["--git-dir", common, "worktree", "list", "--porcelain"],
                      timeouts=timeouts, path=common, phase='discover')
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


def running_dirs():
    snap = active_sessions.checked_snapshot(timeout=30)
    dirs, err = active_sessions.directories(snap)
    if err:
        raise RuntimeError("liveness_unavailable: " + err)
    return {path.rstrip("/") for path in dirs.values()}


class Activity(dict):
    def __init__(self, paths, projects, stats, error):
        super().__init__(paths or {})
        self.projects, self.stats, self.error = projects or {}, stats, error
        self.commons = None
        self.project_stats = {}


def session_activity(write_cache=False):
    paths, stats, err = active_sessions.session_history(HISTORY_CACHE, write_cache=write_cache)
    roots, roots_err = active_sessions.project_roots()
    return Activity(paths, roots, stats, err or roots_err)


def activity_for_repo(common, history, now, worktree_paths=None, timeouts=None):
    if history is None:
        return None, "session history unavailable"
    if not isinstance(history, Activity):
        return history, None
    if history.error:
        return None, history.error
    if history.commons is None:
        history.commons = {pid: common_dir(root, timeouts) for pid, root in history.projects.items() if os.path.isdir(root)}
    # Unknown project bindings cannot prove that this repo has no recent threads.
    if timeouts and any(timeouts.blocked(root) for root in history.projects.values()):
        return None, 'git_timeout: project repository binding unavailable'
    activity = dict(history)
    if worktree_paths is None:
        listed, error = worktrees(common, timeouts)
        if error:
            return None, "worktree history coverage unavailable: " + error
        worktree_paths = [w["worktree"] for w in listed]
    for pid, root in history.projects.items():
        # A registered project can point inside a missing linked checkout. Git's
        # worktree roster still binds that path to this repo without opening it.
        belongs = history.commons.get(pid) == common or any(inside(root, path) for path in worktree_paths)
        if not belongs:
            continue
        stats = {'root': root, 'common': common}
        history.project_stats[pid] = stats
        paths, err = active_sessions.project_activity(pid, history.projects[pid],
                                                     int((now - STALE_DAYS * 86400) * 1000), stats=stats)
        if err:
            stats['error'] = err
            return None, err
        for path, updated in paths.items():
            activity[path] = max(activity.get(path, 0), updated)
    return activity, None


def removal_activity(common, path, now, timeouts=None):
    # Refresh updated-time deltas first so newly created/moved session directories
    # join the known set. Then read every session in this worktree's directories,
    # including old rows whose viewed/idle changed without an updated-time bump.
    history = session_activity()
    activity, err = activity_for_repo(common, history, now, timeouts=timeouts)
    if err:
        return None
    fresh, err = active_sessions.worktree_activity(path, history)
    if err:
        return None
    for directory, updated in fresh.items():
        activity[directory] = max(activity.get(directory, 0), updated)
    return activity


def process_cwds(timeouts=None, path=None):
    p = (timeouts or Timeouts()).run(["lsof", "-n", "-P", "-d", "cwd", "-Fpn"], path, 'check', 120)
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


def evaluate(w, now, running, activity, cwds, keep, timeouts=None):
    timeouts = timeouts or Timeouts()
    path = w['worktree']
    try:
        if timeouts.blocked(path):
            return dict(path=path, reasons=['git_timeout: earlier item timeout'])
        return _evaluate(w, now, running, activity, cwds, keep, timeouts)
    except subprocess.TimeoutExpired as error:
        timeouts.skip(path, 'check', error)
        return dict(path=path, reasons=['git_timeout: ' + shlex.join(error.cmd)])


def _evaluate(w, now, running, activity, cwds, keep, timeouts):
    path = w["worktree"]
    r = {"path": path, "common": w["common"], "branch": (w.get("branch") or "").replace("refs/heads/", "") or None,
         "head": w.get("HEAD"), "reasons": []}
    why = r["reasons"]
    if activity is None:
        why.append("activity_history_unavailable: report_only")
        activity = {}
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
    rc, out, err = git(["-C", path, "log", "-1", "--format=%ct"], timeouts=timeouts, path=path)
    if rc != 0 or not out.strip():
        why.append(f"no_head_commit:{err[:80]}")
        return r
    r["last_commit"] = int(out.strip())
    age_days = (now - r["last_commit"]) / 86400
    r["last_commit_days"] = round(age_days, 1)
    if age_days <= STALE_DAYS:
        why.append("recent_commit")
    rc, out, err = git(["-C", path, "rev-list", "--count", "HEAD", "--not", "--remotes"], timeouts=timeouts, path=path)
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
    rc, out, _ = git(["-C", path, "rev-parse", "--path-format=absolute", "--git-dir"], timeouts=timeouts, path=path)
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
    rc, out, err = git(["-C", path, "status", "--porcelain=v1", "--ignored"], timeout=180, timeouts=timeouts, path=path)
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
                p = timeouts.run(["find", full, "-name", ".git", "-print", "-quit"], path, 'check', 120)
                if p.stdout.strip():
                    why.append("nested_repo_in_ignored")
                    break
                p = timeouts.run(["du", "-sk", full], path, 'check', 120)
                size += int((p.stdout.split() or ["0"])[0]) * 1024
            elif os.path.exists(full):
                size += os.path.getsize(full)
        r["ignored_keep_bytes"] = size
        if size > 500 * 1024 * 1024:
            why.append("large_ignored_data")
    rc, out, _ = git(["-C", path, "submodule", "status", "--recursive"], timeouts=timeouts, path=path)
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
    if not a.dry_run:
        os.makedirs(LOG_DIR, exist_ok=True)
    st = {"ts": int(t0), "dry_run": a.dry_run, "state": "done", "removed": [], "would_remove": [],
          "kept": {}, "missing_directories": [], "errors": []}
    timeouts = Timeouts()
    removal_timeouts = 0
    try:
        running = running_dirs()
        activity = session_activity(write_cache=not a.dry_run)
        st["history_stats"] = getattr(activity, "stats", {})
        st["project_history_stats"] = getattr(activity, "project_stats", {})
        st["repo_outcomes"] = {}
        st["activity_history_unavailable"] = {}
        cwds = process_cwds(timeouts)
        keep = keep_list()
        commons = discover(set(running) | set(activity or {}) | set(getattr(activity, "projects", {}).values()), timeouts)
        st["repos"] = len(commons)
        cands = []
        total = 0
        for common in commons:
            try:
                wts, err = worktrees(common, timeouts)
                repo_activity, history_error = activity_for_repo(common, activity, t0, [w["worktree"] for w in wts], timeouts)
            except subprocess.TimeoutExpired as error:
                timeouts.skip(common, 'discover', error)
                st['repo_outcomes'][common] = {'kept': {'git_timeout': 1}, 'would_remove': []}
                continue
            if history_error:
                st["activity_history_unavailable"][common] = history_error
            outcome = {"kept": {}, "would_remove": [], "history_error": history_error}
            st["repo_outcomes"][common] = outcome
            if err:
                st["errors"].append(f"{common}: {err[:120]}")
            for w in wts:
                total += 1
                r = evaluate(w, t0, running, repo_activity, cwds, keep, timeouts)
                if "missing_directory" in r["reasons"]:
                    st["missing_directories"].append(r["path"])
                for x in r["reasons"]:
                    k = x.split(":")[0]
                    st["kept"][k] = st["kept"].get(k, 0) + 1
                    outcome["kept"][k] = outcome["kept"].get(k, 0) + 1
                if not r["reasons"]:
                    cands.append(r)
        st["worktrees"] = total
        # A later project-binding/discovery failure can also protect an earlier candidate.
        unblocked = []
        for r in cands:
            if timeouts.blocked(r['path']):
                st['kept']['git_timeout'] = st['kept'].get('git_timeout', 0) + 1
                kept = st['repo_outcomes'][r['common']]['kept']
                kept['git_timeout'] = kept.get('git_timeout', 0) + 1
            else:
                unblocked.append(r)
        cands = unblocked
        st["stale"] = len(cands)
        cands.sort(key=lambda r: r["last_commit"])
        for r in cands[:a.limit]:
            info = {k: r.get(k) for k in ("path", "common", "branch", "head", "last_commit_days",
                                          "last_session_days", "created_days")}
            info["ignored_archived"] = len(r.get("ignored_keep") or [])
            if a.dry_run:
                st["would_remove"].append(info)
                st["repo_outcomes"][r["common"]]["would_remove"].append(r["path"])
                continue
            # re-check right before removal
            try:
                again = evaluate({"worktree": r["path"], "common": r["common"], "main": False,
                                  "HEAD": r["head"], "branch": r.get("branch")},
                                 time.time(), running_dirs(), removal_activity(r["common"], r["path"], time.time(), timeouts),
                                 process_cwds(timeouts, r['path']), keep_list(), timeouts)
            except subprocess.TimeoutExpired as error:
                timeouts.skip(r['path'], 'check', error)
                again = {'reasons': ['git_timeout: ' + shlex.join(error.cmd)]}
            if again["reasons"] or again.get("head") != r["head"]:
                st["kept"]["changed_before_remove"] = st["kept"].get("changed_before_remove", 0) + 1
                if timeouts.blocked(r['path']):
                    st['kept']['git_timeout'] = st['kept'].get('git_timeout', 0) + 1
                    kept = st['repo_outcomes'][r['common']]['kept']
                    kept['git_timeout'] = kept.get('git_timeout', 0) + 1
                continue
            try:
                arc = archive_ignored(again)
            except Exception as e:  # noqa: BLE001
                st["errors"].append(f"{r['path']}: archive failed: {e}")
                continue
            try:
                rc, out, err = git(["--git-dir", r["common"], "worktree", "remove", r["path"]], timeout=600,
                                  timeouts=timeouts, path=r['path'], phase='remove', retry=False)
            except subprocess.TimeoutExpired as error:
                timeouts.skip(r['path'], 'remove', error)
                st['errors'].append(f"{r['path']}: worktree remove timed out: {shlex.join(error.cmd)}")
                removal_timeouts += 1
                continue
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
    st['skipped_timeouts'] = timeouts.skipped
    st['timeout_events'] = timeouts.events
    st['timeouts'] = len({os.path.realpath(row['path']) for row in timeouts.skipped})
    st['timeout_wait_s'] = round(timeouts.wait_s, 3)
    st['timeout_attempts'] = sum(row['event'] == 'timeout' for row in timeouts.events)
    total = st.get('worktrees', 0)
    if st['timeouts'] >= 10 or st['timeouts'] / max(total, 1) > 0.05:
        st['state'] = 'error'
        st['errors'].append(f"systemic timeouts: {st['timeouts']} items, {total} listed worktrees")
    if len(st["errors"]) - removal_timeouts >= 5:
        st["state"] = "error"
    st["duration_s"] = round(time.time() - t0, 1)
    if not a.dry_run:
        with open(STATUS, "w") as status_file:
            json.dump(st, status_file, indent=1)
    json.dump(st, sys.stdout, indent=1)
    print()
    return 0 if st["state"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
