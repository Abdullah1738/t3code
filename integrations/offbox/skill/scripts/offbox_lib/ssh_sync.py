"""SSH config per box (pinned host key, ControlMaster) and rsync push/pull."""

from __future__ import annotations

from contextlib import nullcontext
import os
import re
import secrets
import shlex
import subprocess
import time
from pathlib import Path

from . import api, git_snapshot
from .common import CM_DIR, KEY_PATH, SSH_DIR, OffboxError, ensure_dirs, log

RSYNC = "/opt/homebrew/bin/rsync" if Path("/opt/homebrew/bin/rsync").exists() else "rsync"

# Never sent to a box. Excluded paths are also protected from --delete on the box, so remote-only
# installs (node_modules, .terraform, caches, build output) survive between runs and resumes.
SECRET_EXCLUDES = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.p8", "*.mobileprovision",
                   ".aws/", ".ssh/", ".netrc", ".npmrc", ".pypirc", ".docker/config.json", "*.tfstate", "*.tfstate.*",
                   ".terraform.d/", "credentials.json", "id_rsa*", "id_ed25519*"]
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
        m = re.search(r'(?:failed to open|file has vanished:) "([^"]+)"', ln)
        if m and ("Permission denied" in ln or "vanished" in ln):
            bad.append(m.group(1))
            continue
        if re.search(r'opendir "([^"]+)" failed: Permission denied', ln):
            bad.append(re.search(r'opendir "([^"]+)"', ln).group(1))
            continue
        return None
    return bad or None


def push_filters(root: Path, with_git: bool, includes: list[str] | None = None) -> list[str]:
    # --git uses a separate portable export. Never send a raw git-dir or pointer,
    # even when --include .git is supplied, or copy private config/hooks/worktrees.
    f = ["--filter=- /.git"]
    for inc in includes or []:      # explicit opt-in (e.g. committed test certs); wins over every exclude
        inc = inc.strip("/")
        parts = inc.split("/")
        for i in range(1, len(parts)):
            f.append("--filter=+ /" + "/".join(parts[:i]) + "/")
        f.append(f"--filter=+ /{inc}")
        f.append(f"--filter=+ /{inc}/**")
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
            raise OffboxError(f"Git history sync to {box_id} failed ({p.returncode})")
        ssh(box_id, f"rm -rf -- {qdest} && mv -- {qstage} {qdest}", check=True)
        return _stats(p.stdout)
    finally:
        try:
            ssh(box_id, f"rm -rf -- {qstage}", check=True)
        except (OffboxError, OSError, subprocess.TimeoutExpired):
            log(f"push_git cleanup failed {box_id} {staging}")


def _push_files(box_id: str, root: Path, remote_dir: str, with_git: bool, timeout: float,
                includes: list[str] | None) -> dict:
    cmd = [RSYNC, "-az", "--delete", "--mkpath", "--no-o", "--no-g", "--omit-dir-times", "--stats",
           "--timeout=120", "-e", " ".join(shlex.quote(x) for x in ssh_base(box_id))]
    cmd += push_filters(root, with_git, includes)
    cmd += [f"{root}/", f"{box_id}:{remote_dir}/"]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    st = _stats(p.stdout)
    if p.returncode == 23 and (skipped := _soft_partial(p.stderr)):
        # Unreadable/vanished local files (e.g. a chmod 000 scratch file in tmp/) must not fail the run.
        import sys
        shown = ", ".join(skipped[:3]) + (f" (+{len(skipped) - 3} more)" if len(skipped) > 3 else "")
        print(f"offbox: warning: skipped {len(skipped)} unreadable/vanished local file(s): {shown}", file=sys.stderr)
        log(f"push_partial {box_id} skipped={len(skipped)} first={skipped[0]}")
    elif p.returncode not in (0, 24):     # 24 = files vanished during transfer (fine)
        raise OffboxError(f"rsync to {box_id} failed ({p.returncode}): {p.stderr.strip()[-600:]}")
    return st


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
