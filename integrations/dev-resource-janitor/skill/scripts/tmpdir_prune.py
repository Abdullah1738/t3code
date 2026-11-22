#!/opt/homebrew/bin/python3
"""Bounded TMPDIR reports; apply only deletes when TMPDIR_PRUNE_DELETE=1.

TMPDIR_PRUNE_IDLE_HOURS sets the agent idle threshold (24 hours by default).
Reports and pre-removal rechecks share tmpdir_inventory.inspect. Existing test
patterns use TMPDIR_PRUNE_TEST_HOURS; opencode remains report-only.
"""
import argparse, fcntl, json, math, os, re, shutil, subprocess, sys, time
from tmpdir_inventory import UsageUnavailable, disk_lock, inspect
sys.path.insert(0, os.path.expanduser("~/.local/lib/mac-logging"))
try:
    from toollog import emit
except ImportError:
    def emit(*args, **kwargs):
        pass

RUN_SECONDS = 600


CONFIG = os.path.expanduser('~/.config/opencode/tmpdir-prune.json')


def configuration():
    try:
        with open(CONFIG) as f:
            config = json.load(f)
        if not isinstance(config, dict) or type(config.get('delete', False)) is not bool:
            raise ValueError('invalid configuration')
        return config
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as err:
        raise UsageUnavailable('config_unavailable', 'unreadable configuration') from err


def idle_hours():
    try:
        value = float(os.environ.get('TMPDIR_PRUNE_IDLE_HOURS', configuration().get('idleHours', 24)))
    except (ValueError, TypeError) as err:
        raise UsageUnavailable('config_unavailable', 'invalid idle threshold') from err
    if not math.isfinite(value) or value <= 0:
        raise UsageUnavailable('config_unavailable', 'invalid idle threshold')
    return value


def deletion_enabled():
    value = os.environ.get('TMPDIR_PRUNE_DELETE')
    return configuration().get('delete', False) if value is None else value == '1'


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


def walk(path):
    info = inspect(path)
    return info['newest_mtime'], info['bytes'], info['files']


def process_references():
    try:
        result = subprocess.run(['/bin/ps', '-axo', 'pid=,command='],
                                capture_output=True, text=True, timeout=15)
        if result.returncode or result.stderr or not result.stdout.strip():
            raise UsageUnavailable('ps_unavailable', 'incomplete process snapshot')
        used = set()
        for line in result.stdout.splitlines():
            fields = line.strip().split(None, 1)
            if not fields or not fields[0].isdigit():
                raise UsageUnavailable('ps_unavailable', 'malformed process snapshot')
            if len(fields) < 2:
                continue  # Exiting processes can have an empty argv.
            # TMPDIR commonly ends in '/', so "$TMPDIR/script" has a doubled separator.
            # Normalize the complete path before comparing either macOS /var spelling.
            for match in re.finditer(r'/[^\s\'";]+', fields[1]):
                path = os.path.normpath(match.group())
                for prefix in {TMP, TMP.replace('/private/var/', '/var/')}:
                    if path.startswith(prefix + os.sep):
                        used.add(os.path.join(TMP, path[len(prefix)+1:].split(os.sep)[0]))
        return used
    except (OSError, subprocess.SubprocessError, UnicodeError) as err:
        raise UsageUnavailable('ps_unavailable', type(err).__name__) from err


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
        if line.startswith("n"):
            p = line[1:]
            # lsof emits both /var and /private/var spellings on macOS.
            if TMP.startswith('/private/var/') and p.startswith('/var/'):
                p = '/private' + p
            if p == TMP or p.startswith(TMP + os.sep):
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


def classify(name, path):
    if not re.fullmatch(r'[A-Za-z0-9._-]+', name):
        return None
    if name.startswith('com.apple.') or re.fullmatch(r'uv-.*\.lock', name):
        return None
    if (name.startswith(('tmp.', 'harness-exit.', 'live-db-snapshot-', 't3-control-',
                         't3-orchestration-v2-', 'recall-toollog-test-'))
            or re.fullmatch(r'.+-review-.+', name)
            or re.fullmatch(r'offbox.*-(?:review|recheck|integration|osr).*', name)
            or re.fullmatch(r'robob[0-9]+-traces\..+', name)):
        return 'agent'
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
        with disk_lock() as fd:
            return scan_available(fd)
    except UsageUnavailable as err:
        return {"skipped": err.skipped, "reason": err.reason}
    except OSError as err:
        return {"skipped": "tree_unavailable", "reason": type(err).__name__}


def protected(path, keep, used):
    path = os.path.realpath(path)
    keep = {os.path.realpath(p) for p in keep}
    used = {os.path.realpath(p) for p in used}
    return (used_under(path, used) or any(
        path == k or path.startswith(k + os.sep) or k.startswith(path + os.sep) for k in keep))


def scan_available(lock_fd=None):
    now, deadline = time.time(), time.monotonic() + RUN_SECONDS
    threshold = idle_hours()
    used, keep = in_use() | process_references(), keep_list()
    out = {"tmpdir": TMP, "classes": {}, "candidates": [], "kept_in_use": 0, "kept_young": 0,
           "kept_worktrees": [], "kept": [], "report_only": not deletion_enabled(), "idle_hours": threshold,
           "opencode_stale": {"entries": 0, "bytes": 0, "top": []}}

    def consider(cls, path, idle_s):
        if protected(path, keep, used):
            out["kept_in_use"] += 1
            return
        try:
            info = inspect(path, deadline, lock_fd)
        except (UsageUnavailable, OSError) as err:
            out['kept'].append({'path': path, 'reason': getattr(err, 'skipped', 'tree_unavailable'),
                                'detail': getattr(err, 'reason', type(err).__name__)})
            return
        newest, size, files = info['newest_mtime'], info['bytes'], info['files']
        if now - newest < idle_s:
            out["kept_young"] += 1
            return
        candidate = {"class": cls, "path": path, "bytes": size, "age_s": now - newest,
                     "idle_h": round((now - newest) / 3600, 1), "idle_s": idle_s, **info}
        if cls == "opencode":
            stale = out["opencode_stale"]
            stale["entries"] += 1
            stale["bytes"] += size
            stale["top"].append(candidate)
            return
        c = out["classes"].setdefault(cls, {"entries": 0, "bytes": 0, "files": 0})
        c["entries"] += 1
        c["bytes"] += size
        c["files"] += files
        out["candidates"].append(candidate)

    with os.scandir(TMP) as it:
        for e in it:
            if time.monotonic() >= deadline:
                out['partial'] = True
                break
            cls = classify(e.name, e.path)
            if cls:
                consider(cls, e.path, (threshold if cls == 'agent' else TEST_IDLE_HOURS) * 3600)
    # The historical opencode inventory remains report-only and shares the run budget.
    if os.path.isdir(OPENCODE) and not os.path.islink(OPENCODE):
        with os.scandir(OPENCODE) as it:
            for e in it:
                if time.monotonic() >= deadline:
                    out['partial'] = True
                    break
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


def remove_candidate(candidate, deadline, lock_fd):
    path = candidate['path']
    if os.path.dirname(path) != TMP or classify(os.path.basename(path), path) is None:
        raise UsageUnavailable('tree_kept', 'not an approved direct child')
    fresh = inspect(path, deadline, lock_fd)
    if (fresh['device'], fresh['inode']) != (candidate['device'], candidate['inode']):
        raise UsageUnavailable('tree_kept', 'entry identity changed')
    if time.time() - fresh['newest_mtime'] < candidate['idle_s']:
        raise UsageUnavailable('tree_kept', 'recent activity')
    # A fresh process/keep snapshot is taken after the walk and Git checks, for every removal.
    if protected(path, keep_list(), in_use() | process_references()):
        raise UsageUnavailable('tree_kept', 'in use or kept')
    # lsof can take seconds. Work written during that snapshot must keep the whole candidate.
    fresh = inspect(path, deadline, lock_fd)
    if ((fresh['device'], fresh['inode']) != (candidate['device'], candidate['inode'])
            or time.time() - fresh['newest_mtime'] < candidate['idle_s']):
        raise UsageUnavailable('tree_kept', 'entry changed during process snapshot')
    if time.monotonic() >= deadline:
        raise UsageUnavailable('tree_kept', 'run deadline')
    for repo in sorted(fresh['repos'], key=lambda r: len(r['path']), reverse=True):
        if repo['linked']:
            # A successful worktree remove drops exactly this registration; never globally prune others.
            from tmpdir_inventory import git
            git(repo['parent_repo'], ['worktree', 'remove', repo['path']], deadline, lock_fd)
    if os.path.lexists(path):
        delete_path(path, fresh, deadline, lock_fd)
    return fresh


def delete_path(path, info, deadline, lock_fd):
    # Bound the destructive walk too. rmtree's fd-based implementation rejects symlink substitution.
    code = ('import os,stat,shutil,sys; p=sys.argv[1]; s=os.lstat(p); '
            'assert (s.st_dev,s.st_ino,s.st_uid)==tuple(map(int,sys.argv[2:])); '
            'assert not stat.S_ISLNK(s.st_mode); '
            'shutil.rmtree(p) if stat.S_ISDIR(s.st_mode) else os.remove(p)')
    with subprocess.Popen([sys.executable, '-I', '-c', code, path, str(info['device']),
                           str(info['inode']), str(info['uid'])], pass_fds=(lock_fd,),
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as child:
        try:
            rc = child.wait(timeout=max(0.01, min(60, deadline-time.monotonic())))
        except subprocess.TimeoutExpired as err:
            child.kill()
            child.wait()
            raise UsageUnavailable('remove_incomplete', 'deletion deadline; entry may be partial') from err
    if rc:
        raise UsageUnavailable('remove_incomplete', 'deletion failed; entry may be partial')


def record_event(name, props, ok=True, duration_ms=None):
    # The local audit remains useful when the central logger is unavailable.
    with open(AUDIT, 'a') as f:
        f.write(json.dumps({'event': name, **props}) + '\n')
    emit('janitor', 'event' if ok else 'error', name, ok=ok, duration_ms=duration_ms, props=props,
         error_tag=None if ok else 'janitor.tmpdir_failed')


def apply_locked():
    started = time.monotonic()
    res = scan()
    if "skipped" in res:
        entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "event": "tmpdir_prune", **res}
        record_event('janitor.tmpdir_run', entry, ok=False)
        return entry
    removed, failed, size = 0, [], 0
    deadline = time.monotonic() + RUN_SECONDS
    report_only = res['report_only']
    if not report_only:
        for c in res['candidates']:
            if time.monotonic() >= deadline:
                break
            try:
                if not deletion_enabled():
                    break
                with disk_lock() as fd:
                    fresh = remove_candidate(c, deadline, fd)
                removed += 1
                size += fresh['bytes']
                record_event('janitor.tmpdir_remove', {'path': c['path'], 'bytes': fresh['bytes'],
                             'ageS': time.time() - fresh['newest_mtime'], 'rule': c['class']})
            except (OSError, UsageUnavailable) as err:
                failed.append({'path': c['path'], 'error': getattr(err, 'skipped', type(err).__name__)})
                record_event('janitor.tmpdir_remove', {'path': c['path'], 'bytes': c['bytes'],
                             'ageS': c['age_s'], 'rule': c['class']}, ok=False)
    stale = res['opencode_stale']
    entry = {'removed': removed, 'removed_bytes': size, 'report_only': report_only,
             'found': len(res['candidates']), 'bytes': sum(c['bytes'] for c in res['candidates']),
             'idle_hours': res['idle_hours'], 'classes': res['classes'], 'failed': failed[:20],
             'partial': res.get('partial', False) or time.monotonic() >= deadline,
             'opencode_stale': {'entries': stale['entries'], 'bytes': stale['bytes'], 'top': stale['top'][:10]}}
    record_event('janitor.tmpdir_run', entry, ok=not failed, duration_ms=(time.monotonic()-started)*1000)
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
            record_event('janitor.tmpdir_run', {"event": "tmpdir_prune", "skipped": "tmpdir_unavailable",
                         "reason": "could not resolve user temp directory"}, ok=False)
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
