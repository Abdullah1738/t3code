"""SSH config per box (pinned host key, ControlMaster) and rsync push/pull."""

from __future__ import annotations

from contextlib import nullcontext
import os
import re
import secrets
import shlex
import shutil
import subprocess
import tempfile
import time
import unicodedata
from pathlib import Path

from . import api, git_snapshot
from .common import CM_DIR, KEY_PATH, SSH_DIR, OffboxError, ensure_dirs, log

RSYNC = "/opt/homebrew/bin/rsync" if Path("/opt/homebrew/bin/rsync").exists() else "rsync"

# Never sent to a box. Excluded paths are also protected from --delete on the box, so remote-only
# installs (node_modules, .terraform, caches, build output) survive between runs and resumes.
SECRET_EXCLUDES = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.p8", "*.mobileprovision",
                   ".aws/", ".ssh/", ".netrc", ".npmrc", ".pypirc", ".docker/config.json", "*.tfstate", "*.tfstate.*",
                   ".terraform.d/", "credentials.json", "id_rsa*", "id_ed25519*",
                   ".gnupg/", "gnupg/", "private-keys-v1.d/", "*.keystore", "*.kdbx"]
SAFE_ENV_TEMPLATES = [".env.example", ".env.sample", ".env.template", ".env.dist"]
# node_modules without the trailing slash: worktrees often symlink it to the main checkout, and a dir-only
# pattern would sync that (dangling) symlink over the box's own install.
HEAVY_EXCLUDES = ["node_modules", ".terraform/", ".next/", ".turbo/", ".expo/", ".gradle/", ".nx/", ".parcel-cache/",
                  "__pycache__/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", ".venv/", ".tox/", ".gocache/",
                  ".cache/", ".DS_Store", "Pods/", "DerivedData/", ".build/"]


def pubkey() -> str:
    ensure_dirs()
    if not KEY_PATH.exists():
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "offbox", "-f", str(KEY_PATH)], check=True)
    return Path(str(KEY_PATH) + ".pub").read_text().strip()


def cfg_path(box_id: str) -> Path:
    return SSH_DIR / f"config_{box_id}"


def setup(box_id: str) -> Path:
    """Authorize our key on the box's current machine and pin its host key. Needed after every create/resume/fork."""
    ensure_dirs()
    last = None
    for attempt in range(8):
        try:
            r = api.sshkey(box_id, pubkey())
            break
        except api.ApiError as e:
            last = e
            if e.api_code in ("machine_not_running", "sandbox_starting", "boat_starting", "ssh_host_key_unavailable") \
                    or e.status in (409, 502, 503):
                time.sleep(1 + attempt)
                continue
            raise
    else:
        raise OffboxError(f"ssh key setup failed for {box_id}: {last}")
    ep = r.get("sshEndpoint")
    if ep:
        host, port = ep.rsplit(":", 1)
    else:
        host, port = r.get("machineIp"), "22"
    if not host or not r.get("hostKey"):
        raise OffboxError(f"no ssh endpoint/host key for {box_id}")
    kh = SSH_DIR / f"known_hosts_{box_id}"
    kh.write_text(f"{box_id} {r['hostKey']}\n")
    cfg = cfg_path(box_id)
    tmp = cfg.with_suffix(".tmp")
    tmp.write_text(f"""Host {box_id}
  HostName {host}
  Port {port}
  User {r.get('sshUser') or 'user'}
  IdentityFile {KEY_PATH}
  IdentitiesOnly yes
  HostKeyAlias {box_id}
  UserKnownHostsFile {kh}
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 4
  ControlMaster auto
  ControlPath {CM_DIR}/%C
  ControlPersist 600
  LogLevel ERROR
""")
    os.replace(tmp, cfg)
    log(f"ssh setup {box_id} endpoint={host}:{port}")
    return cfg


def ssh_base(box_id: str) -> list[str]:
    return ["ssh", "-F", str(cfg_path(box_id))]


def ssh(box_id: str, command: str, input: bytes | None = None, timeout: float = 120, check: bool = False):
    p = subprocess.run(ssh_base(box_id) + [box_id, command], input=input, capture_output=True, timeout=timeout)
    if check and p.returncode != 0:
        raise OffboxError(f"ssh {box_id} failed ({p.returncode}): {p.stderr.decode(errors='replace')[-400:]}")
    return p


def wait_ssh(box_id: str, timeout: float = 90) -> None:
    deadline = time.time() + timeout
    err = ""
    while time.time() < deadline:
        try:
            p = ssh(box_id, "true", timeout=20)
            if p.returncode == 0:
                return
            err = p.stderr.decode(errors="replace")[-300:]
            if "Host key verification failed" in err or "REMOTE HOST IDENTIFICATION" in err:
                setup(box_id)
        except subprocess.TimeoutExpired:
            err = "timeout"
        time.sleep(1)
    raise OffboxError(f"ssh to {box_id} not ready after {int(timeout)}s: {err}")


def close_master(box_id: str) -> None:
    if cfg_path(box_id).exists():
        subprocess.run(ssh_base(box_id) + ["-O", "exit", box_id], capture_output=True, timeout=10)


DEAD_MOUNT = re.compile(r"Transport endpoint is not connected|Software caused connection abort|Stale file handle", re.I)


def dead_mount(text: str) -> str | None:
    m = DEAD_MOUNT.search(text or "")
    return m.group(0) if m else None


def probe_home(box_id: str, timeout: float = 45) -> str | None:
    """The matched dead-mount error when $HOME on the box can't be written, else None (also None when the probe
    can't tell: the sync still catches it). Creates nothing outside .offbox, so a --no-sync run still sees a
    missing remote dir."""
    try:
        p = ssh(box_id, 'cd "$HOME" && mkdir -p .offbox && p=".offbox/probe-$$" && : > "$p" && rm -f -- "$p" '
                        '&& echo OFFBOX_PROBE_OK', timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"probe {box_id} inconclusive ({type(e).__name__})")
        return None
    text = (p.stdout + p.stderr).decode(errors="replace")
    if p.returncode == 0 and "OFFBOX_PROBE_OK" in text:
        return None
    return dead_mount(text)


def _gitinfo_exclude(root: Path) -> list[str]:
    """info/exclude lives in the COMMON git dir. In a linked worktree root/.git is a file, so ask git."""
    cands = [root / ".git" / "info" / "exclude"]
    try:
        p = subprocess.run(["git", "-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip():
            cands.insert(0, Path(p.stdout.strip()) / "info" / "exclude")
    except Exception:  # noqa: BLE001
        pass
    seen, out = set(), []
    for c in cands:
        if c.is_file() and str(c) not in seen:
            seen.add(str(c))
            out.append(f"--exclude-from={c}")
    return out


def _soft_partial(stderr: str) -> list[str] | None:
    """rsync 23 caused only by unreadable or vanished local files: return those paths (sync is otherwise complete)."""
    bad = []
    for ln in stderr.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("rsync error: some files/attrs were not transferred"):
            continue
        # [generator]/[receiver] errors come from the box side (a root-owned dir there, say): never a local skip.
        if ln.startswith(("rsync: [generator]", "rsync: [receiver]")):
            return None
        m = re.search(r'(?:failed to open|file has vanished:) "([^"]+)"', ln)
        if m and ("Permission denied" in ln or "vanished" in ln):
            bad.append(m.group(1))
            continue
        if re.search(r'opendir "([^"]+)" failed: Permission denied', ln):
            bad.append(re.search(r'opendir "([^"]+)"', ln).group(1))
            continue
        return None
    return bad or None


def _include_refused(inc: str) -> OffboxError:
    return OffboxError(f"cannot sync --include {inc!r}: offbox couldn't tell what else sits beside it, "
                       "so it won't send it (local filter inspection failed)", code=2)


def _ignored_include_tops(root: Path, includes: list[str] | None) -> list[str]:
    """For each --include, its shortest ancestor dir that git ignores (tmp for tmp/a/b.sh), once each."""
    tops: list[str] = []
    for inc in includes or []:
        parts = inc.strip("/").split("/")
        for i in range(1, len(parts)):
            anc = "/".join(parts[:i])
            try:
                p = subprocess.run(["git", "-C", str(root), "check-ignore", "-q", "--", anc + "/"],
                                   capture_output=True, timeout=10)
            except (OSError, subprocess.TimeoutExpired) as e:
                raise _include_refused(inc) from e
            if p.returncode not in (0, 1):
                raise _include_refused(inc)
            if p.returncode == 0:
                if anc not in tops:
                    tops.append(anc)
                break
    return tops


# rsync couldn't remove or replace a file on the box (root-owned, e.g. a container's cache inside the checkout).
RECEIVER_DENIED = re.compile(r"^rsync: \[(?:generator|receiver)\] .*Permission denied \(13\)$", re.I)
QUOTED_PATH = re.compile(r'"([^"]+)"|\(([^)]+)\)')


def _receiver_denied(stderr: str) -> list[str] | None:
    """rsync 23 caused only by Permission denied on the box's side: those paths, else None."""
    bad = []
    for ln in stderr.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("rsync error: some files/attrs were not transferred"):
            continue
        if not RECEIVER_DENIED.match(ln):
            return None
        m = QUOTED_PATH.search(ln)
        bad.append((m.group(1) or m.group(2)) if m else ln)
    return bad or None


def _reclaim(box_id: str, remote_dir: str) -> bool:
    """Give the box user back every file in the remote checkout (sudo chown -R). True when it worked."""
    if not remote_dir or remote_dir.strip("/") in ("", ".") or ".." in remote_dir.split("/"):
        return False
    q = shlex.quote(remote_dir)
    try:
        p = ssh(box_id, f'cd "$HOME" && test -d {q} && sudo -n chown -R "$(id -u):$(id -g)" -- {q}', timeout=300)
    except (subprocess.TimeoutExpired, OSError):
        return False
    return p.returncode == 0


def _visible_include_ancestors(root: Path, ancestors: set[str], inc: str) -> set[str]:
    # Rsync's inherited merge rules differ from Git's. Probe only a synthetic ancestor tree, never
    # the checkout's subtrees, so checking an include cannot walk unrelated scratch or copy its files.
    try:
        with tempfile.TemporaryDirectory(prefix="offbox-include-filters-") as tmp:
            source, dest = Path(tmp) / "source", Path(tmp) / "dest"
            source.mkdir()
            dest.mkdir()
            for anc in ancestors:
                (source / anc).mkdir(parents=True, exist_ok=True)
            paths = {""} | {str(p.relative_to(source)) for p in source.rglob("*")}
            for rel in paths:
                ignore = root / rel / ".gitignore"
                try:
                    ignore.lstat()
                except FileNotFoundError:
                    continue
                shutil.copyfile(ignore, source / rel / ".gitignore")
            cmd = [RSYNC, "-r", "--dry-run", "-8", "--out-format=%n"]
            cmd += push_filters(root, False)
            result = subprocess.run(cmd + [f"{source}/", f"{dest}/"], capture_output=True, timeout=20)
            if result.returncode != 0:
                raise _include_refused(inc)
            # Rsync escapes control bytes and literal escape-like names even with -8. Decode once,
            # after splitting output records, so embedded newlines never become record separators.
            return {os.fsdecode(re.sub(rb"\\#([0-7]{3})", lambda m: bytes([int(m[1], 8)]), name[:-1]))
                    for name in result.stdout.split(b"\n") if name.endswith(b"/")}
    except (OSError, subprocess.TimeoutExpired) as e:
        raise _include_refused(inc) from e


def push_filters(root: Path, with_git: bool, includes: list[str] | None = None) -> list[str]:
    # --git uses a separate portable export. Never send a raw git-dir or pointer,
    # even when --include .git is supplied, or copy private config/hooks/worktrees.
    f = ["--filter=- /.git"]
    ancestors: set[str] = set()
    for inc in includes or []:      # explicit opt-in (e.g. committed test certs); wins over every exclude
        inc = inc.strip("/")
        parts = inc.split("/")
        for i in range(1, len(parts)):
            anc = "/".join(parts[:i])
            ancestors.add(anc)
            f.append(f"--filter=+ /{anc}/")
        f.append(f"--filter=+ /{inc}")
        f.append(f"--filter=+ /{inc}/**")
    is_git = False
    if includes:
        try:
            p = subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
                               capture_output=True, timeout=10)
            is_git = p.returncode == 0 and p.stdout.strip() == b"true"
        except (OSError, subprocess.TimeoutExpired):
            pass  # No Git index: guard every opened ancestor.
    guarded = ancestors.copy()
    if is_git and ancestors:
        try:
            p = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "--", *sorted(ancestors)],
                               capture_output=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise _include_refused(includes[0]) from e
        if p.returncode != 0:
            raise _include_refused(includes[0])
        for raw in p.stdout.split(b"\0"):
            if raw:
                parts = os.fsdecode(raw).split("/")
                for i in range(1, len(parts)):
                    guarded.discard("/".join(parts[:i]))
    # A whole-directory include already authorizes these siblings, even with redundant child includes.
    unchecked = {anc for anc in ancestors - guarded
                 if not any(anc == i.strip("/") or anc.startswith(i.strip("/") + "/") for i in includes)}
    visible = _visible_include_ancestors(root, unchecked, includes[0]) if unchecked else set()
    for anc in sorted(unchecked):
        inc = next(i for i in includes if i.strip("/").startswith(anc + "/"))
        try:
            # Bypass the index to see ignored dirs with tracked descendants. No trailing slash: tmp/*
            # matches tmp/'s empty child in check-ignore, but does not ignore tmp itself.
            p = subprocess.run(["git", "-C", str(root), "check-ignore", "--no-index", "-q", "--", anc],
                               capture_output=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise _include_refused(inc) from e
        if p.returncode not in (0, 1):
            raise _include_refused(inc)
        # Check this directory's own name so safe env template parents don't look excluded again.
        excluded = _offbox_skips(anc.rsplit("/", 1)[-1]) or any(
            anc == pat or anc.endswith("/" + pat)
            for pat in SECRET_EXCLUDES + HEAVY_EXCLUDES if "/" in pat.rstrip("/")
        )
        if p.returncode == 0 or excluded or anc not in visible:
            raise OffboxError(f"cannot sync --include {inc!r}: excluded ancestor {anc!r} contains tracked files; "
                              "offbox can't send only the named path there. Pass the script inline in argv or "
                              "with --step, or move it out of the excluded directory", code=2)
    # Opening an ignored ancestor bypasses its ignore rule. Close its other children after all includes,
    # so rsync never walks unrelated scratch trees; tracked ancestors retain the normal sync behavior.
    for anc in sorted(guarded, key=lambda a: (-a.count("/"), a)):
        f.append(f"--filter=- /{anc}/*")
    # An include under an ignored dir (tmp/) makes rsync walk that dir, and --delete would then remove the box's own
    # files there (31 Oct: root-owned tmp/localstack, written by the LocalStack container, failed the sync with 23).
    # Protect the rest of that dir on the box; the included path itself still mirrors.
    for top in _ignored_include_tops(root, includes) if is_git else []:
        f.append(f"--filter=P /{top}/**")
    for t in SAFE_ENV_TEMPLATES:
        f.append(f"--filter=+ {t}")
    for x in SECRET_EXCLUDES:
        f.append(f"--filter=- {x}")
    for x in HEAVY_EXCLUDES:
        f.append(f"--filter=- {x}")
    f.append("--filter=:- .gitignore")
    f += _gitinfo_exclude(root)
    return f


def tracked_secret_matches(root: Path, includes: list[str] | None) -> list[str]:
    """Git-tracked files the secret filters skip (e.g. a committed sample configs/.env). Shown as a hint only."""
    import fnmatch
    try:
        p = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, timeout=20)
    except Exception:  # noqa: BLE001
        return []
    if p.returncode != 0:
        return []
    inc = [i.strip("/") for i in includes or []]
    pats = [x.rstrip("/") for x in SECRET_EXCLUDES]
    out = []
    for f in p.stdout.decode(errors="replace").split("\0"):
        if not f or any(f == i or f.startswith(i + "/") for i in inc):
            continue
        parts = f.split("/")
        if any(fnmatch.fnmatch(seg, pat) for seg in parts for pat in pats) and \
                not any(fnmatch.fnmatch(parts[-1], t) for t in SAFE_ENV_TEMPLATES):
            out.append(f)
    return out


# Pass 1 lists every file it considered (-ii) with this prefix, so the tracked files it skipped can be found.
ITEM = "offbox-item "


def _key(name: str) -> str:
    # git's index and the disk can differ in Unicode form and (on APFS) in case. Matching on a folded key keeps
    # pass 2 from sending a second copy under another spelling to the case-sensitive box.
    return unicodedata.normalize("NFC", name).casefold()


def _seen(out: str) -> set[str]:
    """Paths pass 1's itemized output says it sent or checked (deletions left out)."""
    seen = set()
    for ln in out.split("\n"):
        if ln.startswith(ITEM) and not ln.startswith(ITEM + "*"):
            seen.add(_key(ln[len(ITEM) + 12:].rstrip("/")))
    return seen


def _offbox_skips(path: str) -> bool:
    """True when the secret or heavy excludes cover the path (a dir rule covers everything below it)."""
    import fnmatch
    parts = path.split("/")
    if any(fnmatch.fnmatch(parts[-1], t) for t in SAFE_ENV_TEMPLATES):
        parts = parts[:-1]
    pats = [x.rstrip("/") for x in SECRET_EXCLUDES + HEAVY_EXCLUDES]
    if any(fnmatch.fnmatch(seg, pat) for seg in parts for pat in pats if "/" not in pat):
        return True
    joined = "/" + "/".join(parts)
    return any(joined.endswith("/" + pat) or ("/" + pat + "/") in joined for pat in pats if "/" in pat)


def _same_file(a: Path, b: Path) -> bool:
    try:
        sa, sb = os.lstat(a), os.lstat(b)
    except OSError:
        return False
    return (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino)


def _disk_path(root: Path, rel: str, names: dict[str, list[str]]) -> str | None:
    """The on-disk spelling of a git index path, or None when the file is gone or a parent is a symlink.

    The index can spell a path differently from disk after a case-only rename on APFS (`.AWS/canary` vs
    `.aws/canary`), so each component is matched against the real listing; the excludes then apply to the real
    name. Parents are never followed: rsync would traverse a symlinked dir, and pass 1 already sends the link."""
    cur, real = root, []
    for i, part in enumerate(rel.split("/")):
        if i and os.path.islink(cur):
            return None
        d = str(cur)
        if d not in names:
            try:
                names[d] = os.listdir(cur)
            except OSError:
                names[d] = []
        ents = names[d]
        if part in ents:
            name = part
        else:
            # Accept a casefold/NFC match only when it is the same file on disk, so an unrelated `foo` next to a
            # deleted `Foo` on a case-sensitive box is never taken for it.
            hits = [e for e in ents if _key(e) == _key(part) and _same_file(cur / part, cur / e)]
            if len(hits) != 1:
                return None
            name = hits[0]
        real.append(name)
        cur = cur / name
    return "/".join(real)


def _tracked_skipped(root: Path, seen: set[str]) -> list[str]:
    """Git-tracked files pass 1 left out, other than secret/heavy ones. Those are .gitignore matches (a tracked
    package-lock.json, 31 Oct) or rsync reading .gitignore more broadly than git (`test/*`, `!` lines)."""
    try:
        p = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, timeout=20)
    except Exception:  # noqa: BLE001 - no git: pass 1 is the whole sync, as before
        return []
    if p.returncode != 0:
        return []
    out, names = [], {}
    for raw in p.stdout.split(b"\0"):
        if not raw:
            continue
        f = os.fsdecode(raw)
        # A tracked file deleted in the checkout (or outside a sparse checkout) resolves to None and is skipped.
        real = _disk_path(root, f, names)
        if real is None:
            continue
        if any(_key(x) in seen for x in (f, real)) or _offbox_skips(f) or _offbox_skips(real):
            continue
        q = root / real
        # A dir here is a submodule: pass 2 recurses into what it lists, so sending one would bypass its .gitignore.
        if os.path.islink(q) or not os.path.isdir(q):
            out.append(real)
    return out


def tracked_ignored_note(st: dict) -> str | None:
    """The run's one line about tracked files .gitignore matches, which pass 2 sent anyway. Only when pass 2
    changed something on the box: a repo with many of them (t3code-fork's .repos/) would print it every run."""
    n = st.get("tracked_ignored") or 0
    if not n or not st.get("tracked_ignored_sent"):
        return None
    first = st.get("tracked_ignored_first") or []
    more = f" (+{n - len(first)} more)" if n > len(first) else ""
    return f"also synced {n} git-tracked file(s) that .gitignore matches: {', '.join(first)}{more}"


def _stats(out: str) -> dict:
    d = {}
    for key, name in (("Total bytes sent", "sent"), ("Total bytes received", "received"),
                      ("Number of regular files transferred", "files"), ("Total transferred file size", "xfer"),
                      ("Number of files", "count")):
        m = re.search(key + r":\s*([\d,]+)", out)
        if m:
            d[name] = int(m.group(1).replace(",", ""))
    return d


def push(box_id: str, root: Path, remote_dir: str, with_git: bool = False, timeout: float = 3600,
         includes: list[str] | None = None) -> dict:
    """Mirror root/ to ~/<remote_dir>/ on the box. Deletes remote files removed locally (inside remote_dir only)."""
    if str(root) in ("/", str(Path.home())):
        raise OffboxError(f"refusing to sync {root} (not a repo). cd into a repo first.", code=2)
    t = time.time()
    with git_snapshot.snapshot(root) if with_git else nullcontext(None) as gitdir:
        st = _push_files(box_id, root, remote_dir, with_git, timeout, includes)
        if gitdir is not None:
            extra = _push_git(box_id, gitdir, remote_dir, timeout)
            for key, value in extra.items():
                st[key] = st.get(key, 0) + value
    st["seconds"] = round(time.time() - t, 2)
    log(f"push {box_id} {root} -> {remote_dir} {st}")
    return st


def _push_git(box_id: str, gitdir: Path, remote_dir: str, timeout: float) -> dict:
    # Stage independently of a previous .git file/symlink/directory. A partial
    # metadata transfer must fail the run rather than leave usable stale history.
    staging = f"{remote_dir}/.offbox-git-{secrets.token_hex(8)}"
    qstage, qdest = shlex.quote(staging), shlex.quote(f"{remote_dir}/.git")
    ssh(box_id, f"mkdir -m 700 -- {qstage}", check=True)
    try:
        cmd = [RSYNC, "-az", "--no-o", "--no-g", "--stats", "--timeout=120",
               "-e", " ".join(shlex.quote(x) for x in ssh_base(box_id)),
               f"{gitdir}/", f"{box_id}:{staging}/"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if p.returncode != 0:
            # Keep rsync's stderr: a dead mount reported here must still classify as dead-mount.
            raise OffboxError(f"Git history sync to {box_id} failed ({p.returncode}): {p.stderr.strip()[-600:]}")
        ssh(box_id, f"rm -rf -- {qdest} && mv -- {qstage} {qdest}", check=True)
        return _stats(p.stdout)
    finally:
        try:
            ssh(box_id, f"rm -rf -- {qstage}", check=True)
        except (OffboxError, OSError, subprocess.TimeoutExpired):
            log(f"push_git cleanup failed {box_id} {staging}")


def _push_files(box_id: str, root: Path, remote_dir: str, with_git: bool, timeout: float,
                includes: list[str] | None) -> dict:
    ssh_cmd = " ".join(shlex.quote(x) for x in ssh_base(box_id))
    cmd = [RSYNC, "-az", "--delete", "--mkpath", "--no-o", "--no-g", "--omit-dir-times", "--stats",
           "--timeout=120", "-e", ssh_cmd, "-ii", "-8", f"--out-format={ITEM}%i %n"]
    cmd += push_filters(root, with_git, includes)
    cmd += [f"{root}/", f"{box_id}:{remote_dir}/"]
    out = _rsync(box_id, remote_dir, cmd, timeout)
    st = _stats(out)
    # A file git tracks is part of the checkout the command expects, whatever .gitignore says. Pass 2 sends the
    # ones pass 1 skipped, by name and without --delete; pass 1 excludes them, which also keeps them from --delete.
    extra = _tracked_skipped(root, _seen(out))
    if extra:
        cmd2 = [RSYNC, "-az", "--no-o", "--no-g", "--omit-dir-times", "--stats", "--timeout=120", "-e", ssh_cmd,
                "-8", "--from0", "--files-from=-", "--ignore-missing-args", "--filter=- /.git"]
        cmd2 += [f"--filter=+ {t}" for t in SAFE_ENV_TEMPLATES]
        for x in SECRET_EXCLUDES + HEAVY_EXCLUDES:
            # Files go by name here, so a dir rule needs its /** form too (`- .aws/` alone lets .aws/creds through).
            cmd2 += [f"--filter=- {x.rstrip('/')}", f"--filter=- {x.rstrip('/')}/**"]
        cmd2 += [f"{root}/", f"{box_id}:{remote_dir}/"]
        st2 = _stats(_rsync(box_id, remote_dir, cmd2, timeout, files="\0".join(extra)))
        for k in ("sent", "received", "files", "xfer"):
            if k in st2:
                st[k] = st.get(k, 0) + st2[k]
        st["tracked_ignored"] = len(extra)
        st["tracked_ignored_first"] = extra[:5]
        st["tracked_ignored_sent"] = st2.get("files", 0)
        log(f"push_tracked_ignored {box_id} n={len(extra)} sent={st2.get('files', 0)} first={extra[0]}")
    return st


def _rsync(box_id: str, remote_dir: str, cmd: list[str], timeout: float, files: str | None = None) -> str:
    """One push rsync: reclaim box-owned files once, skip unreadable local files, else raise. Returns stdout."""
    def run():
        return subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="surrogateescape",
                              timeout=timeout, input=files)
    p = run()
    if p.returncode == 23 and (denied := _receiver_denied(p.stderr)):
        import sys
        shown = ", ".join(denied[:3]) + (f" (+{len(denied) - 3} more)" if len(denied) > 3 else "")
        if not _reclaim(box_id, remote_dir):
            raise OffboxError(f"rsync to {box_id} failed (23): files on the box aren't writable ({shown}) and "
                              f"sudo chown failed. Nothing ran. Fix: offbox ssh {box_id} -- sudo chown -R user:user "
                              f"{remote_dir}")
        print(f"offbox: warning: {len(denied)} root-owned path(s) on the box blocked the sync ({shown}); "
              f"gave them back to the box user (sudo chown) and synced again", file=sys.stderr)
        log(f"push_reclaim {box_id} {remote_dir} paths={len(denied)} first={denied[0]}")
        p = run()
    if p.returncode == 23 and (skipped := _soft_partial(p.stderr)):
        # Unreadable/vanished local files (e.g. a chmod 000 scratch file in tmp/) must not fail the run.
        import sys
        shown = ", ".join(skipped[:3]) + (f" (+{len(skipped) - 3} more)" if len(skipped) > 3 else "")
        print(f"offbox: warning: skipped {len(skipped)} unreadable/vanished local file(s): {shown}", file=sys.stderr)
        log(f"push_partial {box_id} skipped={len(skipped)} first={skipped[0]}")
    elif p.returncode not in (0, 24):     # 24 = files vanished during transfer (fine)
        raise OffboxError(f"rsync to {box_id} failed ({p.returncode}): {p.stderr.strip()[-600:]}")
    return p.stdout or ""


def pull(box_id: str, remote_dir: str, rel_cwd: str, path: str, local_cwd: Path) -> dict:
    """Copy <remote cwd>/<path> back to <local cwd>/<path> (file or dir; remote globs allowed)."""
    path = path.rstrip("/") or "."
    if path.startswith("/") or ".." in Path(path).parts:
        raise OffboxError(f"--pull path must be relative to the cwd: {path}", code=2)
    rbase = f"{remote_dir}/{rel_cwd}".rstrip("/").replace("/./", "/").rstrip(".")
    rbase = rbase.rstrip("/")
    parent = os.path.dirname(path)
    dest = (local_cwd / parent) if parent else local_cwd
    dest.mkdir(parents=True, exist_ok=True)
    cmd = [RSYNC, "-az", "--no-o", "--no-g", "--stats", "-e", " ".join(shlex.quote(x) for x in ssh_base(box_id)),
           f"{box_id}:{rbase}/{path}", f"{dest}/"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    st = _stats(p.stdout)
    st["ok"] = p.returncode == 0
    if p.returncode != 0:
        st["error"] = p.stderr.strip()[-300:]
    return st


def put_file(box_id: str, remote_path: str, content: bytes, mode: str = "600") -> None:
    d = os.path.dirname(remote_path)
    ssh(box_id, f"umask 077; mkdir -p {shlex.quote(d)} && cat > {shlex.quote(remote_path)} && chmod {mode} "
                f"{shlex.quote(remote_path)}", input=content, check=True)


def tunnel(box_id: str, remote_port: int, local_port: int, reverse: bool = False) -> subprocess.Popen:
    fwd = (["-R", f"127.0.0.1:{remote_port}:127.0.0.1:{local_port}"] if reverse
           else ["-L", f"127.0.0.1:{local_port}:127.0.0.1:{remote_port}"])
    return subprocess.Popen(ssh_base(box_id) + ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ControlMaster=no",
                                                "-o", "ControlPath=none", *fwd, box_id])
