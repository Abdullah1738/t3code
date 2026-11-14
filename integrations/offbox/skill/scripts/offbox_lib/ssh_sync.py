"""SSH config per box (pinned host key, ControlMaster) and rsync push/pull."""

from __future__ import annotations

from contextlib import nullcontext
import hashlib
import json
import os
import stat
import signal
from functools import lru_cache
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from pathlib import Path

import toollog

from . import api, capacity, common, git_snapshot
from .common import CM_DIR, KEY_PATH, SSH_DIR, OffboxError, ensure_dirs, log
from .home import StartWaitFailed

RSYNC = "/opt/homebrew/bin/rsync" if Path("/opt/homebrew/bin/rsync").exists() else "rsync"
STALL_S = capacity.setting("OFFBOX_SYNC_STALL_S", 180)
SYNC_PROGRESS_S = 60
MAX_TRACKED_INCLUDE_FILES = 200
MAX_INCLUDE_FILTER_BYTES = 512 * 1024
RETRY_PAUSES = (5, 15, 45)
CHECKOUT_DIR = re.compile(r"^w/[A-Za-z0-9._-]{1,40}-[0-9a-f]{6}$")
_HOME_PORTS: dict[str, tuple[str, int]] = {}

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


def _atomic_write_text(path: Path, text: str) -> None:
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp",
                                         delete=False, mode="w") as f:
            tmp = Path(f.name)
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


@toollog.observed("ssh", "ssh.setup", "ssh_setup")
def setup(box_id: str) -> Path:
    """Authorize our key on the box's current machine and pin its host key. Needed after every create/resume/fork."""
    from . import prepare
    ensure_dirs()
    last = None
    for attempt in range(8):
        try:
            r = api.sshkey(box_id, pubkey())
            prepare.observe_outage()
            break
        except api.ApiError as e:
            prepare.observe_outage(e)
            if not (e.api_code in ("machine_not_running", "sandbox_starting", "boat_starting", "ssh_host_key_unavailable")
                    or e.status in (409, 502, 503) or api.gateway_timeout(e)):
                raise
            last = e
        except StartWaitFailed:
            raise
        except api.BudgetExpired as error:
            if last is not None and last.outage:
                raise last from error
            raise
        except OffboxError as e:
            prepare.observe_outage(e)
            if not e.outage:
                raise
            last = e
        if attempt < 7:
            left = api.left()
            if left is not None and left <= 0:
                raise last
            # Authorizing the same public key is safe to repeat even when boat did not answer.
            log(f"ssh_setup_retry {box_id} attempt={attempt + 1} {str(last)[:200]}")
            time.sleep(1 + attempt if left is None else min(1 + attempt, left))
    else:
        error = OffboxError(f"ssh key setup failed for {box_id}: {last}", outage=bool(last and last.outage))
        error.status = getattr(last, 'status', None)
        raise error
    ep = r.get("sshEndpoint")
    if ep:
        host, port = ep.rsplit(":", 1)
    else:
        host, port = r.get("machineIp"), "22"
    if not host or not r.get("hostKey"):
        raise OffboxError(f"no ssh endpoint/host key for {box_id}")
    home_ports = ""
    if api.BACKEND == "server" and r.get("managementSshEndpoint"):
        mgmt_host, mgmt_port = r["managementSshEndpoint"].rsplit(":", 1)
        if mgmt_host != host:
            raise OffboxError(f"management SSH host differs from legacy SSH host for {box_id}")
        # Both are allocated host proxy ports, not the guest's 2222/22 listeners.
        home_ports = f"# offbox-home-ports {int(mgmt_port)} {int(port)}\n"
    kh = SSH_DIR / f"known_hosts_{box_id}"
    _atomic_write_text(kh, f"{box_id} {r['hostKey']}\n")
    cfg = cfg_path(box_id)
    _atomic_write_text(cfg, f"""Host {box_id}
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
""" + home_ports)
    log(f"ssh setup {box_id} endpoint={host}:{port}")
    return cfg


def _host_key_error(stderr: bytes) -> bool:
    return any(s in stderr for s in (b"Host key verification failed", b"REMOTE HOST IDENTIFICATION",
                                     b"Offending ", b"host key has changed"))


def _management_unreachable(box_id: str) -> common.SshHostKeyMismatch:
    return common.SshHostKeyMismatch(f"management SSH unreachable for {box_id}: host key mismatch; "
                       "use `offbox exec` through the home control API (#95); leave known_hosts unchanged")


def check_host_key(box_id: str, stderr: bytes) -> None:
    if api.BACKEND == "server" and _host_key_error(stderr):
        raise _management_unreachable(box_id)


def ssh_base(box_id: str, *, probe: bool = True) -> list[str]:
    base = ["ssh", "-F", str(cfg_path(box_id))]
    if api.BACKEND != "server":
        return base
    try:
        config = cfg_path(box_id).read_text()
    except OSError:
        return base
    ports = re.search(r"^# offbox-home-ports (\d+) (\d+)$", config, re.M)
    if not ports:
        return base  # pre-upgrade daemon: only its legacy endpoint is known
    cached = _HOME_PORTS.get(box_id)
    if cached and cached[0] == config:
        return base + ["-p", str(cached[1])]
    if not probe:
        return base
    for port in ports.groups():
        left = api.left()
        timeout = 5 if left is None else min(5, max(0, left))
        if timeout <= 0:
            raise subprocess.TimeoutExpired(base, timeout)
        try:
            p = subprocess.run(base + ["-p", port, "-o", "ConnectTimeout=3", "-o", "ControlPath=none",
                                      box_id, "true"], capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            continue
        check_host_key(box_id, p.stderr)
        if p.returncode == 0:
            _HOME_PORTS[box_id] = (config, int(port))
            return base + ["-p", port]
    raise OffboxError(f"management SSH unreachable for {box_id} on management and legacy endpoints; "
                       "use the home control API (`offbox exec`, #95)")


def ssh(box_id: str, command: str, input: bytes | None = None, timeout: float = 120, check: bool = False):
    p = subprocess.run(ssh_base(box_id) + [box_id, command], input=input, capture_output=True, timeout=timeout)
    if p.returncode == 255:
        check_host_key(box_id, p.stderr)
    if p.returncode == 255:
        toollog.emit("ssh", "ssh.drop", kind="error", ok=False, ids={"box": box_id}, tag="ssh_drop", props={"exitCode": 255})
    if check and p.returncode != 0:
        raise OffboxError(f"ssh {box_id} failed ({p.returncode}): {p.stderr.decode(errors='replace')[-400:]}")
    return p


@toollog.observed("ssh", "ssh.readiness", "readiness")
def wait_ssh(box_id: str, timeout: float = 90) -> None:
    left = api.left()
    window = timeout if left is None else max(0, min(timeout, left))
    client_limited = left is not None and left < timeout
    deadline = time.time() + window
    err = ""
    while time.time() < deadline:
        try:
            p = ssh(box_id, "true", timeout=min(20, deadline - time.time()))
            if p.returncode == 0:
                return
            err = p.stderr.decode(errors="replace")[-300:]
            if _host_key_error(p.stderr):
                if api.BACKEND == "server":
                    raise _management_unreachable(box_id)
                setup(box_id)
        except subprocess.TimeoutExpired:
            err = "timeout"
        except common.SshHostKeyMismatch:
            raise
        except OffboxError as error:
            if error.outage or not client_limited or time.time() < deadline:
                raise
            err = str(error)
        time.sleep(max(0, min(1, deadline - time.time())))
    if client_limited:
        raise api.BudgetExpired(f"ssh to {box_id} not ready within {window:g}s client budget: {err}")
    raise OffboxError(f"ssh to {box_id} not ready after {int(timeout)}s: {err}")


def close_master(box_id: str) -> None:
    path = None
    try:
        if not cfg_path(box_id).exists():
            return
        left = api.left()
        timeout = 2 if left is None else min(2, max(0, left))
        if timeout > 0:
            # Resolve %C before exit can exhaust the budget, without connecting to the remote machine.
            config = subprocess.run(ssh_base(box_id, probe=False) + ["-G", box_id], capture_output=True, text=True, timeout=timeout)
            if config.returncode == 0:
                for line in config.stdout.splitlines():
                    if line.startswith("controlpath "):
                        candidate = Path(line.split(" ", 1)[1])
                        if candidate.parent.resolve() == CM_DIR.resolve():
                            path = candidate
                        break
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        left = api.left()
        timeout = 10 if left is None else min(10, max(0, left))
        if timeout > 0:
            subprocess.run(ssh_base(box_id, probe=False) + ["-O", "exit", box_id], capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        pass  # closing a cached connection must not undo a confirmed box stop
    try:
        if path is not None and path.is_socket():
            path.unlink(missing_ok=True)
    except OSError:
        pass


DEAD_MOUNT = re.compile(r"Transport endpoint is not connected|Software caused connection abort|Stale file handle", re.I)


def dead_mount(text: str) -> str | None:
    m = DEAD_MOUNT.search(text or "")
    return m.group(0) if m else None


def _write_seconds(output: bytes) -> float | None:
    match = re.search(rb"^OFFBOX_WRITE_SECONDS ([0-9]+(?:\.[0-9]+)?)$", output, re.M)
    return float(match[1]) if match else None


def _timed_write(privileged: bool = False) -> str:
    sudo = "sudo -n " if privileged else ""
    return (f"{{ trap '{sudo}rm -f -- \"$p\"' EXIT; export LC_ALL=C; TIMEFORMAT='OFFBOX_WRITE_SECONDS %R'; "
            f'{{ time {sudo}dd if=/dev/zero of="$p" bs=1M count=1 conv=fsync; }} 2>&1; }}')


def probe_home(box_id: str, timeout: float = 45, *, measure_write: bool = False) -> tuple[str | None, float | None]:
    """The matched dead-mount error when $HOME on the box can't be written, else None (also None when the probe
    can't tell: the sync still catches it), plus the optional fsync duration. Creates nothing outside .offbox,
    so a --no-sync run still sees a missing remote dir. Timing is remote, excluding SSH connection latency."""
    script = 'cd "$HOME" && mkdir -p .offbox && p=".offbox/probe-$$" && '
    script += _timed_write() if measure_write else ': > "$p" && rm -f -- "$p"'
    script += ' && echo OFFBOX_PROBE_OK'
    try:
        p = ssh(box_id, "bash -c " + shlex.quote(script), timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"probe {box_id} inconclusive ({type(e).__name__})")
        return None, None
    text = (p.stdout + p.stderr).decode(errors="replace")
    if p.returncode == 0 and "OFFBOX_PROBE_OK" in text:
        return None, _write_seconds(p.stdout) if measure_write else None
    return dead_mount(text), None


def probe_docker_root(box_id: str, timeout: float = 45) -> float | None:
    """Best effort fsync on Docker's disk; missing or wedged Docker is handled by image readiness."""
    try:
        info = ssh(box_id, "docker info -f '{{.DockerRootDir}}'", timeout=10)
        root = info.stdout.decode(errors="replace").strip()
        if info.returncode or not root.startswith("/") or "\n" in root:
            return None
        script = f'p={shlex.quote(root)}/.offbox-probe-$$; ' + _timed_write(privileged=True)
        p = ssh(box_id, "bash -c " + shlex.quote(script), timeout=timeout)
        return _write_seconds(p.stdout) if p.returncode == 0 else None
    except (subprocess.TimeoutExpired, OSError):
        return None


def _gitinfo_exclude(root: Path) -> list[str]:
    """info/exclude lives in the COMMON git dir. In a linked worktree root/.git is a file, so ask git."""
    cands = [root / ".git" / "info" / "exclude"]
    try:
        p = subprocess.run(["git", "-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=10, cwd=str(root))
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


INCLUDE_WORKAROUND = ("Create a dot-directory at the checkout root (mktemp -d ./.scratch.XXXX), "
                      "put the script there and --include that path, or use a committed or included file in the repo.")


def _include_refused(inc: str) -> OffboxError:
    return OffboxError(f"cannot sync --include {inc!r}: offbox couldn't tell what else sits beside it, "
                       f"so it won't send it (local filter inspection failed). {INCLUDE_WORKAROUND}", code=2)


def _include_alias_refused(inc: str, path: str, real: str) -> OffboxError:
    return OffboxError(f"cannot sync --include {inc!r}: {path!r} has disk spelling {real!r}; "
                       f"offbox can't safely guard aliased paths. {INCLUDE_WORKAROUND}", code=2)


def _ignored_include_tops(root: Path, includes: list[str] | None) -> list[str]:
    """For each --include, its shortest ancestor dir that git ignores (tmp for tmp/a/b.sh), once each."""
    # Ignore rules must protect box-only siblings even when the index tracks files below this top.
    tops: list[str] = []
    for inc in includes or []:
        parts = inc.strip("/").split("/")
        for i in range(1, len(parts)):
            anc = "/".join(parts[:i])
            try:
                p = subprocess.run(["git", "-C", str(root), "check-ignore", "--no-index", "-q", "--", anc + "/"],
                                   capture_output=True, timeout=10, cwd=str(root))
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


def _literal_filter_path(path: str, *, wildcard: bool = False) -> str:
    # Rsync only interprets backslash escapes in rules containing wildcard syntax.
    if not wildcard and not any(char in path for char in "*?["):
        return path
    return re.sub(r"([\\*?\[])", r"\\\1", path)


def push_filters(root: Path, with_git: bool, includes: list[str] | None = None) -> list[str]:
    # --git uses a separate portable export. Never send a raw git-dir or pointer,
    # even when --include .git is supplied, or copy private config/hooks/worktrees.
    f = ["--filter=- /.git"]
    ancestors: set[str] = set()
    names: dict[str, list[str]] = {}
    for inc in includes or []:      # explicit opt-in (e.g. committed test certs); wins over every exclude
        inc = inc.strip("/")
        real = _disk_path(root, inc, names)
        if real is not None and real != inc:
            raise _include_alias_refused(inc, inc, real)
        parts = inc.split("/")
        for i in range(1, len(parts)):
            anc = "/".join(parts[:i])
            ancestors.add(anc)
            f.append(f"--filter=+ /{_literal_filter_path(anc)}/")
        f.append(f"--filter=+ /{_literal_filter_path(inc)}")
        f.append(f"--filter=+ /{_literal_filter_path(inc, wildcard=True)}/**")
    is_git = False
    if includes:
        try:
            p = subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
                               capture_output=True, timeout=10, cwd=str(root))
            is_git = p.returncode == 0 and p.stdout.strip() == b"true"
        except (OSError, subprocess.TimeoutExpired):
            pass  # No Git index: guard every opened ancestor.
    guarded = ancestors.copy()
    tracked: set[str] = set()
    if is_git and ancestors:
        try:
            p = subprocess.run(["git", "--literal-pathspecs", "-C", str(root), "ls-files", "-z", "--", *sorted(ancestors)],
                               capture_output=True, timeout=20, cwd=str(root))
        except (OSError, subprocess.TimeoutExpired) as e:
            raise _include_refused(includes[0]) from e
        if p.returncode != 0:
            raise _include_refused(includes[0])
        for raw in p.stdout.split(b"\0"):
            if raw:
                path = os.fsdecode(raw)
                tracked.add(path)
                parts = path.split("/")
                for i in range(1, len(parts)):
                    guarded.discard("/".join(parts[:i]))
    # A whole-directory include already authorizes these siblings, even with redundant child includes.
    unchecked = {anc for anc in ancestors - guarded
                 if not any(anc == i.strip("/") or anc.startswith(i.strip("/") + "/") for i in includes)}
    visible = _visible_include_ancestors(root, unchecked, includes[0]) if unchecked else set()
    reopen: set[str] = set()
    for anc in sorted(unchecked):
        inc = next(i for i in includes if i.strip("/").startswith(anc + "/"))
        try:
            # Bypass the index to see ignored dirs with tracked descendants. No trailing slash: tmp/*
            # matches tmp/'s empty child in check-ignore, but does not ignore tmp itself.
            p = subprocess.run(["git", "-C", str(root), "check-ignore", "--no-index", "-q", "--", anc],
                               capture_output=True, timeout=10, cwd=str(root))
        except (OSError, subprocess.TimeoutExpired) as e:
            raise _include_refused(inc) from e
        if p.returncode not in (0, 1):
            raise _include_refused(inc)
        # Check this directory's own name so safe env template parents don't look excluded again.
        excluded = _offbox_skips(anc.rsplit("/", 1)[-1]) or any(
            anc == pat or anc.endswith("/" + pat)
            for pat in SECRET_EXCLUDES + HEAVY_EXCLUDES if "/" in pat.rstrip("/")
        )
        if excluded:
            raise OffboxError(f"cannot sync --include {inc!r}: excluded ancestor {anc!r} contains tracked files; "
                              f"offbox can't send only the named path there. {INCLUDE_WORKAROUND}", code=2)
        if p.returncode == 0 or anc not in visible:
            descendants = {path for path in tracked if path.startswith(anc + "/")}
            if len(descendants) > MAX_TRACKED_INCLUDE_FILES:
                raise OffboxError(f"cannot sync --include {inc!r}: excluded ancestor {anc!r} contains "
                                  f"{len(descendants)} tracked files (limit {MAX_TRACKED_INCLUDE_FILES}); "
                                  f"offbox can't send only the named path there. {INCLUDE_WORKAROUND}", code=2)
            guarded.add(anc)
            reopen.update(descendants)
    # Plain sync sends ignored tracked files in pass 2. Reopen the same eligible files here,
    # closing every intermediate directory so their untracked siblings are never traversed.
    reopened_dirs: set[str] = set()
    for path in sorted(reopen):
        real = _disk_path(root, path, names)
        if real is None or _offbox_skips(path) or _offbox_skips(real):
            continue
        if real != path:
            # Mixing index/include aliases with disk spellings bypasses rsync's case-sensitive guards.
            raise _include_alias_refused(includes[0], path, real)
        if not (root / real).is_symlink() and (root / real).is_dir():
            continue  # A submodule must not authorize its whole working tree.
        parts = real.split("/")
        for i in range(1, len(parts)):
            parent = "/".join(parts[:i])
            if parent not in reopened_dirs:
                f.append(f"--filter=+ /{_literal_filter_path(parent)}/")
                reopened_dirs.add(parent)
            if any(parent == anc or parent.startswith(anc + "/") for anc in guarded):
                guarded.add(parent)
        f.append(f"--filter=+ /{_literal_filter_path(real)}")
    # Close only after all requested and tracked paths have been opened (rsync's first match wins).
    for anc in sorted(guarded, key=lambda a: (-a.count("/"), a)):
        f.append(f"--filter=- /{_literal_filter_path(anc, wildcard=True)}/*")
    # An include under an ignored dir (tmp/) makes rsync walk that dir, and --delete would then remove the box's own
    # files there (31 Oct: root-owned tmp/localstack, written by the LocalStack container, failed the sync with 23).
    # Protect the rest of that dir on the box; the included path itself still mirrors.
    for top in _ignored_include_tops(root, includes) if is_git else []:
        f.append(f"--filter=P /{_literal_filter_path(top, wildcard=True)}/**")
    for t in SAFE_ENV_TEMPLATES:
        f.append(f"--filter=+ {t}")
    for x in SECRET_EXCLUDES:
        f.append(f"--filter=- {x}")
    for x in HEAVY_EXCLUDES:
        f.append(f"--filter=- {x}")
    f.append("--filter=:- .gitignore")
    f += _gitinfo_exclude(root)
    # A file count alone cannot bound argv when tracked files have distinct deep parents.
    # Leave half of macOS ARG_MAX for the environment and rsync's other arguments.
    if includes and (size := sum(len(os.fsencode(arg)) + 1 for arg in f)) > MAX_INCLUDE_FILTER_BYTES:
        raise OffboxError(f"cannot sync --include {includes[0]!r}: include filters need {size} bytes "
                          f"(limit {MAX_INCLUDE_FILTER_BYTES}). {INCLUDE_WORKAROUND}", code=2)
    return f


def tracked_secret_matches(root: Path, includes: list[str] | None) -> list[str]:
    """Git-tracked files the secret filters skip (e.g. a committed sample configs/.env). Shown as a hint only."""
    import fnmatch
    try:
        p = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, timeout=20, cwd=str(root))
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


@lru_cache(maxsize=8)
def _skip_component_pattern(patterns: tuple[str, ...]) -> re.Pattern:
    import fnmatch
    # One compiled match avoids a Python fnmatch loop over every rule for every path component.
    return re.compile("|".join(fnmatch.translate(os.path.normcase(p)) for p in patterns))


def _offbox_skips(path: str) -> bool:
    """True when the secret or heavy excludes cover the path (a dir rule covers everything below it)."""
    import fnmatch
    parts = path.split("/")
    if any(fnmatch.fnmatch(parts[-1], t) for t in SAFE_ENV_TEMPLATES):
        parts = parts[:-1]
    pats = [x.rstrip("/") for x in SECRET_EXCLUDES + HEAVY_EXCLUDES]
    pattern = _skip_component_pattern(tuple(p for p in pats if "/" not in p))
    if any(pattern.match(os.path.normcase(seg)) for seg in parts):
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
        p = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], capture_output=True, timeout=20, cwd=str(root))
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
         includes: list[str] | None = None, seed_candidates: list[str] | None = None,
         run_id: str | None = None) -> dict:
    with toollog.span("sync", "run.sync", ids={"run": run_id, "box": box_id}, tag="sync_failed") as data:
        try:
            result = _push(box_id, root, remote_dir, with_git, timeout, includes, seed_candidates, run_id)
        except (OffboxError, OSError) as error:
            if not root.is_dir():
                raise common.SourceGone(root) from error
            raise
        data["props"].update(bytes=result.get("sent", 0), files=result.get("files", 0),
                             skipped=result.get("skipped", 0))
        return result


def _push(box_id: str, root: Path, remote_dir: str, with_git: bool = False, timeout: float = 3600,
         includes: list[str] | None = None, seed_candidates: list[str] | None = None,
         run_id: str | None = None) -> dict:
    """Mirror root/ to ~/<remote_dir>/ on the box. Deletes remote files removed locally (inside remote_dir only)."""
    if str(root) in ("/", str(Path.home())):
        raise OffboxError(f"refusing to sync {root} (not a repo). cd into a repo first.", code=2)
    t = time.time()
    with git_snapshot.snapshot(root) if with_git else nullcontext(None) as gitdir:
        st = _push_files(box_id, root, remote_dir, with_git, timeout, includes, seed_candidates, run_id)
        if gitdir is not None:
            extra = _push_git(box_id, gitdir, remote_dir, timeout, run_id=run_id)
            for key, value in extra.items():
                st[key] = st.get(key, 0) + value
        verified = _verify_content(box_id, root, remote_dir, _tracked_content(root, includes), timeout, run_id)
        for key, value in verified.items():
            st[key] = st.get(key, 0) + value
    st["seconds"] = round(time.time() - t, 2)
    st["secret_skips"] = tracked_secret_matches(root, includes)
    st["skipped"] = len(st["secret_skips"])
    log(f"push {box_id} {root} -> {remote_dir} {st}")
    return st


def _content_signature(path: Path) -> tuple[str, str]:
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return ("missing", "")
    if stat.S_ISLNK(info.st_mode):
        data = os.fsencode(os.readlink(path))
        return ("link", hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest())
    if stat.S_ISDIR(info.st_mode):
        return ("dir", "")
    if not stat.S_ISREG(info.st_mode):
        return ("other", "")
    h = hashlib.sha1(b"blob " + str(info.st_size).encode() + b"\0")
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return ("file", h.hexdigest())


def _tracked_content(root: Path, includes: list[str] | None) -> dict[str, tuple[str, str]]:
    p = subprocess.run(["git", "-C", str(root), "ls-files", "--stage", "-z"], capture_output=True,
                       env=git_snapshot._git_env(), timeout=30, cwd=str(root))
    if p.returncode:
        # Plain directories are supported too. A broken index in a repository must fail closed.
        probe = subprocess.run(["git", "-C", str(root), "rev-parse", "--git-dir"],
                               capture_output=True, env=git_snapshot._git_env(), timeout=30, cwd=str(root))
        if probe.returncode and not os.path.lexists(root / ".git"):
            return {}
        raise OffboxError("cannot list tracked content for sync; nothing ran")
    entries = [raw for raw in p.stdout.split(b"\0") if raw]
    deleted = subprocess.run(["git", "-C", str(root), "diff", "--cached", "--raw", "-z",
                              "--diff-filter=D", "--no-renames"], capture_output=True,
                             env=git_snapshot._git_env(), timeout=30, cwd=str(root))
    if deleted.returncode:
        raise OffboxError("cannot list staged deletions for sync; nothing ran")
    rows = deleted.stdout.split(b"\0")
    for meta, raw_path in zip(rows[::2], rows[1::2]):
        # A file merely untracked with git rm --cached still exists and stays outside verification.
        if not os.path.lexists(root / os.fsdecode(raw_path)):
            entries.append(meta[1:7] + b" \t" + raw_path)
    names, result = {}, {}
    inc = [i.strip("/") for i in includes or []]
    for raw in entries:
        entry, _, raw_path = raw.partition(b"\t")
        if entry.startswith(b"160000 "):
            continue
        path = os.fsdecode(raw_path)
        real = _disk_path(root, path, names)
        if real is None:
            # Do not inspect descendants hidden behind a symlinked parent.
            if any((root / Path(path).parents[i]).is_symlink() for i in range(len(Path(path).parents) - 1)):
                continue
            real = path
        if real == ".git" or real.startswith(".git/"):
            continue
        included = any(real == i or real.startswith(i + "/") for i in inc)
        if not included and (_offbox_skips(path) or (real != path and _offbox_skips(real))):
            continue
        try:
            sig = _content_signature(root / real)
        except OSError as e:
            raise OffboxError(f"cannot hash tracked file {real!r}; nothing ran") from e
        if sig[0] == "other":
            raise OffboxError(f"unsupported tracked file type {real!r}; nothing ran")
        result[real] = sig
    return result


# Run the same raw Git-blob hash on both hosts: no git installation, filters, index or history needed remotely.
_CONTENT_CHECK = '''import hashlib,json,os,stat,sys
def signature(path):
    try:
        if any(os.path.islink(os.path.join(*path.split('/')[:i])) for i in range(1,len(path.split('/')))):
            return ('other','')
        info=os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            data=os.fsencode(os.readlink(path))
            return ('link',hashlib.sha1(b'blob '+str(len(data)).encode()+b'\\0'+data).hexdigest())
        if stat.S_ISDIR(info.st_mode): return ('dir','')
        if not stat.S_ISREG(info.st_mode): return ('other','')
        h=hashlib.sha1(b'blob '+str(info.st_size).encode()+b'\\0')
        with open(path,'rb') as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''): h.update(chunk)
        return ('file',h.hexdigest())
    except (FileNotFoundError,NotADirectoryError): return ('missing','')
    except OSError: return ('unreadable','')
rows=json.load(sys.stdin)
print(json.dumps([p for p,want in rows.items() if list(signature(p))!=want]))
'''


def _content_mismatches(box_id: str, remote_dir: str, expected: dict, timeout: float) -> list[str]:
    command = f'cd -- {shlex.quote(remote_dir)} && python3 -I -c {shlex.quote(_CONTENT_CHECK)}'
    p = ssh(box_id, command, input=json.dumps(expected).encode(), timeout=min(timeout, 120), check=True)
    try:
        bad = json.loads(p.stdout)
        if not isinstance(bad, list) or any(not isinstance(x, str) or x not in expected for x in bad):
            raise ValueError("unexpected paths")
        return bad
    except (ValueError, TypeError) as e:
        raise OffboxError("invalid tracked-content verification response; nothing ran") from e


def _content_event(box_id: str, paths: list[str], repaired: bool, run_id: str | None) -> None:
    con = common.db()
    try:
        common.event(con, box_id, "sync_content_mismatch", json.dumps(
            {"run_id": run_id, "path_count": len(paths), "repaired": repaired,
             "paths": [p[:200] for p in paths[:5]]}, ensure_ascii=False))
    finally:
        con.close()


def _verify_content(box_id: str, root: Path, remote_dir: str, expected: dict, timeout: float,
                    run_id: str | None) -> dict:
    if not expected:
        return {"verified": 0, "repaired": 0}
    t = time.monotonic()
    bad = _content_mismatches(box_id, remote_dir, expected, timeout)
    result = {"verified": len(expected), "repaired": 0}
    if bad:
        repaired = False
        try:
            cmd = [RSYNC, "-az", "--checksum", "--from0", "--files-from=-", "--delete-missing-args",
                   "--no-o", "--no-g", "--omit-dir-times", "--stats", "--timeout=120",
                   "-e", " ".join(shlex.quote(x) for x in ssh_base(box_id)),
                   f"{root}/", f"{box_id}:{remote_dir}/"]
            extra = _stats(_rsync(box_id, remote_dir, cmd, timeout, files="\0".join(bad) + "\0",
                                  source=root, phase="content-repair", run_id=run_id))
            for key in ("sent", "received", "files", "xfer"):
                result[key] = extra.get(key, 0)
            remaining = _content_mismatches(box_id, remote_dir, expected, timeout)
            if remaining:
                raise OffboxError(f"tracked content differs after checksum repair: {remaining[:20]!r}; nothing ran")
            repaired = True
            result["repaired"] = len(bad)
        except (common.SshHostKeyMismatch, StartWaitFailed):
            raise
        except (OffboxError, OSError, subprocess.TimeoutExpired) as e:
            raise OffboxError(f"tracked content repair failed for {bad[:20]!r}: {e}; nothing ran") from e
        finally:
            _content_event(box_id, bad, repaired, run_id)
    result["verify_seconds"] = round(time.monotonic() - t, 3)
    return result


class BoxStoppedDuringPush(OffboxError):
    def __init__(self, box_id: str):
        super().__init__(f"box stopped during push: {box_id}; nothing ran", box=box_id)


def _endpoint(box_id: str) -> str | None:
    try:
        config = cfg_path(box_id).read_text()
    except OSError:
        return None
    host = re.search(r"^\s*HostName\s+(\S+)", config, re.M | re.I)
    port = re.search(r"^\s*Port\s+(\S+)", config, re.M | re.I)
    return f"{host[1]}:{port[1]}" if host and port else None


@lru_cache(maxsize=8)
def _progress_args(binary: str) -> tuple[str, ...]:
    try:
        p = subprocess.run([binary, "--version"], capture_output=True, timeout=5)
        if re.search(rb"^rsync\s+version 3\.", p.stdout):
            return ("--info=progress2", "--outbuf=N")
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ()


PROGRESS = re.compile(r"(?m)(?:^|(?<=\r))[ \t]*[\d,]+[ \t]+\d+%[ \t]+[^\r\n]*(?:\r\n|[\r\n]|$)")


def _without_progress(output: str) -> str:
    return PROGRESS.sub("", output).replace("\r\n", "\n").replace("\r", "\n")


class SyncStalled(Exception):
    pass


def _kill_rsync(proc) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # An outer prepare deadline can interrupt the grace wait. It must still kill every group member.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass


def _watch_rsync(cmd, timeout, input=None, *, on_stall=None, on_progress=None, cwd=None):
    """One attempt with independent pipe draining and a wall/idle bound, reusable by artifact pulls."""
    started = last = time.monotonic()
    chunks = [[], []]
    count, sent, source_sent = 0, 0, False
    lock = threading.Lock()
    changed = threading.Event()
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, start_new_session=True, cwd=cwd)

    def read(stream, index):
        nonlocal last, count, sent, source_sent
        pending = b""
        try:
            while data := os.read(stream.fileno(), 65536):
                with lock:
                    chunks[index].append(data)
                    count += len(data)
                    last = time.monotonic()
                    if index == 0:
                        pending += data
                        parts = re.split(rb"[\r\n]", pending)
                        pending = parts.pop()[-4096:]
                        # Progress frames can end at the next CR rather than at this read's boundary.
                        for line in [*parts, pending]:
                            m = re.match(rb"\s*([\d,]+)\s+(\d+)%\s+", line)
                            if m:
                                sent = int(m[1].replace(b",", b""))
                                # 100% during an incremental scan can still discover more files.
                                source_sent = m[2] == b"100" and b"to-chk=0/" in line
                changed.set()
        finally:
            stream.close()
            changed.set()

    def write():
        try:
            data = memoryview(input.encode("utf-8", "surrogateescape"))
            while data:
                data = data[os.write(proc.stdin.fileno(), data):]
        except (BrokenPipeError, OSError):
            pass
        finally:
            proc.stdin.close()

    readers = [threading.Thread(target=read, args=(stream, i), daemon=True)
               for i, stream in enumerate((proc.stdout, proc.stderr))]
    for thread in readers:
        thread.start()
    writer = threading.Thread(target=write, daemon=True) if input is not None else None
    if writer:
        writer.start()
    report_at = started + SYNC_PROGRESS_S
    try:
        while proc.poll() is None or any(t.is_alive() for t in readers):
            now = time.monotonic()
            with lock:
                idle, seen, transferred, complete = now - last, count, sent, source_sent
            if now - started >= timeout:
                raise subprocess.TimeoutExpired(cmd, timeout)
            if idle >= STALL_S:
                if on_stall:
                    on_stall(proc, seen, complete)
                if time.monotonic() - started >= timeout:
                    raise subprocess.TimeoutExpired(cmd, timeout)
                raise SyncStalled()
            if on_progress and now >= report_at:
                on_progress(seen, transferred, complete)
                report_at = now + SYNC_PROGRESS_S
            changed.wait(min(.05, max(0, timeout - (now - started)), max(0, STALL_S - idle)))
            changed.clear()
        proc.wait()
    except BaseException:
        _kill_rsync(proc)
        raise
    finally:
        for thread in [*readers, *([writer] if writer else [])]:
            thread.join(timeout=.2)
    out, err = (b"".join(c).decode("utf-8", "surrogateescape") for c in chunks)
    return subprocess.CompletedProcess(cmd, proc.returncode, _without_progress(out), err)


def _bounded_command(cmd, timeout, *, stdout=None, capture_stderr=False):
    # A pipe's communicate()/wait() cleanup can itself hang after SIGKILL on an uninterruptible filesystem call.
    # A temporary file lets us abandon an unreaped helper without waiting for EOF or blocking a reader thread.
    with (tempfile.TemporaryFile() if stdout is None else nullcontext(stdout)) as output, \
            (tempfile.TemporaryFile() if capture_stderr else nullcontext(None)) as errors:
        proc = subprocess.Popen(cmd, stdout=output, stderr=errors if capture_stderr else subprocess.DEVNULL,
                                start_new_session=True)
        try:
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                if capture_stderr:
                    errors.seek(0)
                    stderr = errors.read()
                    if _host_key_error(stderr):
                        return subprocess.CompletedProcess(cmd, 255, b"", stderr)
                return None
            if stdout is None:
                output.seek(0)
                data = output.read()
            else:
                data = b""
            stderr = b""
            if capture_stderr:
                errors.seek(0)
                stderr = errors.read()
            return subprocess.CompletedProcess(cmd, proc.returncode, data, stderr)
        finally:
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(timeout=.1)
                except subprocess.TimeoutExpired:
                    pass


def _source_fs(root: Path | None) -> str:
    # A subprocess keeps statfs of a wedged mount outside the watchdog's own thread.
    if root is None or sys.platform != "darwin":
        return "unknown"
    try:
        script = ("import ctypes,os,sys; b=ctypes.create_string_buffer(4096); "
                  "rc=ctypes.CDLL(None).statfs(os.fsencode(sys.argv[1]),b); "
                  "print(b.raw[72:88].split(bytes([0]))[0].decode() if rc==0 else 'unknown')")
        p = _bounded_command([sys.executable, "-c", script, str(root)], 2)
        return p.stdout.decode(errors="replace").strip().lower() if p is not None and p.returncode == 0 else "unknown"
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"


def _remote_stall(box_id: str, timeout: float) -> tuple[str, str | None]:
    try:
        # A separate connection must not wait behind the stalled multiplexed session.
        cmd = ssh_base(box_id) + ["-o", "ControlMaster=no", "-o", "ControlPath=none", box_id,
                                  "ps -eo pid,ppid,stat,wchan:32,etime,comm,args"]
        p = _bounded_command(cmd, timeout, capture_stderr=api.BACKEND == "server")
        if p is None:
            return "remote_probe=unavailable", None
        if p.returncode:
            check_host_key(box_id, p.stderr)
            return "remote_probe=failed", None
    except (common.SshHostKeyMismatch, StartWaitFailed):
        raise
    except (OffboxError, OSError, subprocess.TimeoutExpired):
        return "remote_probe=unavailable", None
    states, prune, blocked = [], [], None
    for line in p.stdout.decode(errors="replace").splitlines():
        cols = line.split(None, 6)
        if len(cols) < 6:
            continue
        _, _, state, wchan, _, comm = cols[:6]
        if comm == "rsync":
            states.append(f"remote_rsync_stat={state} wchan={wchan}")
            if wchan == "request_wait_answer" or wchan.startswith("fuse_"):
                blocked = "box workspace filesystem (FUSE) blocked"
            elif state.startswith("D") and blocked is None:
                blocked = "box disk I/O blocked (remote rsync in D state)"
        if len(cols) > 6 and (".offbox/trash" in cols[6] or "prune-v2-" in cols[6]):
            prune.append(line.strip())
    return f"{' '.join(states) or 'remote_rsync_stat=none'} prune_workers={prune!r}", blocked


def _sync_wait(source_sent: bool, blocked: str | None = None, sample: str = "") -> str:
    if blocked:
        return f"remote receiver blocked: {blocked}"
    if source_sent:
        return "source sent; waiting on box"
    if re.search(r"\b(?:read_ndx\w*|read_a_msg|write_buf)\b", sample):
        return "waiting on remote receiver"
    if "map_ptr" in sample and re.search(r"\b(?:read|pread|stalled_read)\b", sample):
        return "local source read stalled"
    return "waiting for transfer progress"


def _stall_diagnosis(box_id, pid, source, run_id, phase, count, timeout, source_sent=False):
    deadline = time.monotonic() + timeout
    fs = _source_fs(source) if timeout >= 2 else "unknown"
    sample = ""
    if run_id and re.fullmatch(r"[A-Za-z0-9._-]+", run_id) and sys.platform == "darwin" and Path("/usr/bin/sample").exists():
        try:
            path = common.LOGS_DIR / f"{run_id}.stall.sample"
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a+b") as out:
                start = out.tell()
                _bounded_command(["/usr/bin/sample", str(pid), "2"],
                                 min(5, max(.001, deadline - time.monotonic())), stdout=out)
                out.seek(start)
                sample = out.read(65536).decode(errors="replace")
        except (OSError, subprocess.TimeoutExpired):
            pass
    remote, blocked = _remote_stall(box_id, min(10, max(.001, deadline - time.monotonic())))
    wait = _sync_wait(source_sent, blocked, sample)
    log(f"push_stall {box_id} idle={STALL_S:g}s pass={phase} src_fs={fs} bytes_seen={count} {remote} wait={wait!r}")
    return {"src_fs": fs, "blocked": blocked, "wait": wait}


def _refresh_master(box_id, *, close=True, refresh=True):
    for action in ([close_master] if close else []) + ([setup] if refresh else []):
        try:
            action(box_id)
        except StartWaitFailed:
            raise
        except (OffboxError, OSError, subprocess.TimeoutExpired):
            pass


def _run_rsync(box_id: str, cmd: list[str], timeout: float, input: str | None = None, *,
               source: Path | None = None, phase: str = "files1", run_id: str | None = None):
    deadline = time.monotonic() + timeout
    attempt, stalls = 0, 0
    cmd = [cmd[0], *_progress_args(cmd[0]), *cmd[1:]]
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise subprocess.TimeoutExpired(cmd, timeout)
        diagnosis = {}

        def stalled(proc, count, source_sent):
            diagnosis.update(_stall_diagnosis(box_id, proc.pid, source, run_id, phase, count,
                                             min(15, max(0, deadline - time.monotonic())), source_sent))

        def progress(count, sent, source_sent):
            common.say(f"still syncing -> {box_id} pass={phase} bytes_sent={sent} bytes_seen={count}; "
                       f"{_sync_wait(source_sent)}")

        try:
            if api.BACKEND == "server" and "-e" in cmd:
                # setup can change the proxy endpoint between rsync attempts.
                with api.budget(left):
                    cmd[cmd.index("-e") + 1] = shlex.join(ssh_base(box_id))
            p = _watch_rsync(cmd, left, input=input, on_stall=stalled, on_progress=progress,
                             cwd=str(source) if source is not None else None)
        except FileNotFoundError:
            if source is not None and not source.is_dir():
                raise common.SourceGone(source) from None
            raise
        except SyncStalled:
            with api.budget(max(0, deadline - time.monotonic())):
                _refresh_master(box_id, refresh=False)
            source_note = "; source is on nfs (ovnfs checkout)" if diagnosis.get("src_fs") == "nfs" else ""
            reason = diagnosis.get("blocked")
            wait = diagnosis.get("wait", "waiting for transfer progress")
            if reason or stalls:
                from . import lease
                why = reason or f"push stalled twice (pass={phase})"
                lease.quarantine(box_id, why)
                detail = wait if reason else f"no data for {STALL_S:g}s, twice; {wait}"
                raise OffboxError(f"rsync to {box_id} stalled: {detail}{source_note}; box {box_id} quarantined; "
                                  "the next run picks another box. Nothing ran.") from None
            common.say(f"rsync to {box_id} stalled (no data for {STALL_S:g}s; {wait}{source_note}), "
                       "retrying once with a fresh ssh connection")
            with api.budget(max(0, deadline - time.monotonic())):
                _refresh_master(box_id, close=False)
            stalls += 1
            continue
        if (p.returncode == 3 and source is not None and not source.is_dir()
                and re.search(r'(?:getcwd\(\)|change_dir)[^\n]*No such file', p.stderr)):
            raise common.SourceGone(source)
        if p.returncode:
            check_host_key(box_id, p.stderr.encode(errors="replace"))
        if p.returncode not in (255, 12):
            return p
        old = _endpoint(box_id)
        if attempt < len(RETRY_PAUSES):
            with api.budget(max(0, deadline - time.monotonic())):
                _refresh_master(box_id)
        # sshkey only returns connection details. Read state even when refreshing those details failed.
        try:
            with api.budget(max(0, deadline - time.monotonic())):
                state = (api.get(box_id) or {}).get("state")
        except StartWaitFailed:
            raise
        except (OffboxError, OSError, subprocess.TimeoutExpired):
            state = None
        if state and state not in api.LIVE_STATES:
            log(f"push_retry_box_not_running {box_id}")
            raise BoxStoppedDuringPush(box_id)
        if attempt == len(RETRY_PAUSES):
            return p
        new = _endpoint(box_id)
        endpoint = f" endpoint={old} -> {new}" if old and new and old != new else ""
        pause = RETRY_PAUSES[attempt]
        common.say(f"rsync exit {p.returncode} to {box_id}, retry {attempt + 1}/3 in {pause}s")
        log(f"push_retry {box_id} exit={p.returncode} try={attempt + 1}{endpoint}")
        time.sleep(min(pause, max(0, deadline - time.monotonic())))
        attempt += 1


def _push_git(box_id: str, gitdir: Path, remote_dir: str, timeout: float, *, run_id: str | None = None) -> dict:
    # Stage independently of a previous .git file/symlink/directory. A partial
    # metadata transfer must fail the run rather than leave usable stale history.
    staging = f"{remote_dir}/.offbox-git-{secrets.token_hex(8)}"
    qstage, qdest = shlex.quote(staging), shlex.quote(f"{remote_dir}/.git")
    ssh(box_id, f"mkdir -m 700 -- {qstage}", check=True)
    try:
        cmd = [RSYNC, "-az", "--no-o", "--no-g", "--stats", "--timeout=120",
               "-e", " ".join(shlex.quote(x) for x in ssh_base(box_id)),
               f"{gitdir}/", f"{box_id}:{staging}/"]
        p = _run_rsync(box_id, cmd, timeout, source=gitdir, phase="git", run_id=run_id)
        if p.returncode != 0:
            # Keep rsync's stderr: a dead mount reported here must still classify as dead-mount.
            raise OffboxError(f"Git history sync to {box_id} failed ({p.returncode}): {p.stderr.strip()[-600:]}")
        ssh(box_id, f"rm -rf -- {qdest} && mv -- {qstage} {qdest}", check=True)
        return _stats(p.stdout)
    finally:
        try:
            ssh(box_id, f"rm -rf -- {qstage}", check=True, timeout=5)
        except (common.SshHostKeyMismatch, StartWaitFailed):
            raise
        except (OffboxError, OSError, subprocess.TimeoutExpired):
            log(f"push_git cleanup failed {box_id} {staging}")


def _seed(box_id: str, remote_dir: str, candidates: list[str]) -> tuple[bool, str | None]:
    """Check the destination and ordered candidates in one SSH call; uncertainty never enables a seed."""
    if not CHECKOUT_DIR.fullmatch(remote_dir):
        return False, None
    candidates = [d for d in candidates if CHECKOUT_DIR.fullmatch(d) and d != remote_dir]
    lines = [f'if test -d "$HOME"/{shlex.quote(remote_dir)}; then echo existing; exit 0; fi', 'echo first']
    lines += [f'if test -d "$HOME"/{shlex.quote(d)}; then echo {shlex.quote(d)}; exit 0; fi' for d in candidates]
    try:
        p = ssh(box_id, "\n".join(lines), timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False, None
    if p.returncode != 0:
        return False, None
    result = p.stdout.decode(errors="replace").splitlines()
    if not result or result[0] != "first":
        return False, None
    sibling = result[1] if len(result) > 1 and result[1] in candidates else None
    return True, sibling


def _push_files(box_id: str, root: Path, remote_dir: str, with_git: bool, timeout: float,
                includes: list[str] | None, seed_candidates: list[str] | None = None, run_id: str | None = None) -> dict:
    first, sibling = _seed(box_id, remote_dir, seed_candidates) if seed_candidates is not None else (False, None)
    if sibling:
        log(f"push_seed {box_id} {remote_dir} from={sibling}")
    return _push_file_passes(box_id, root, remote_dir, with_git, timeout, includes, sibling, run_id)


def _push_file_passes(box_id: str, root: Path, remote_dir: str, with_git: bool, timeout: float,
                      includes: list[str] | None, sibling: str | None, run_id: str | None = None) -> dict:
    ssh_cmd = " ".join(shlex.quote(x) for x in ssh_base(box_id))
    cmd = [RSYNC, "-az", "--delete", "--mkpath", "--no-o", "--no-g", "--omit-dir-times", "--stats",
           "--timeout=120", "-e", ssh_cmd, "-ii", "-8", f"--out-format={ITEM}%i %n"]
    if sibling:
        # --copy-dest otherwise trusts size + whole-second mtime across different working trees.
        cmd.append("--checksum")
        cmd.append(f"--copy-dest=../{sibling.split('/')[-1]}")
    cmd += push_filters(root, with_git, includes)
    cmd += [f"{root}/", f"{box_id}:{remote_dir}/"]
    out = _rsync(box_id, remote_dir, cmd, timeout, source=root, phase="files1", run_id=run_id)
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
        st2 = _stats(_rsync(box_id, remote_dir, cmd2, timeout, files="\0".join(extra),
                            source=root, phase="files2", run_id=run_id))
        for k in ("sent", "received", "files", "xfer"):
            if k in st2:
                st[k] = st.get(k, 0) + st2[k]
        st["tracked_ignored"] = len(extra)
        st["tracked_ignored_first"] = extra[:5]
        st["tracked_ignored_sent"] = st2.get("files", 0)
        log(f"push_tracked_ignored {box_id} n={len(extra)} sent={st2.get('files', 0)} first={extra[0]}")
    return st


def _rsync(box_id: str, remote_dir: str, cmd: list[str], timeout: float, files: str | None = None, *,
           source: Path | None = None, phase: str = "files1", run_id: str | None = None) -> str:
    """One push rsync: reclaim box-owned files once, skip unreadable local files, else raise. Returns stdout."""
    def run():
        return _run_rsync(box_id, cmd, timeout, input=files, source=source, phase=phase, run_id=run_id)
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


def _missing_pull(code: int, error: str) -> bool:
    if code != 23:
        return False
    missing = False
    for line in error.splitlines():
        if re.fullmatch(r'rsync: (?:\[sender\] )?link_stat ".*" failed: No such file or directory \(2\)', line):
            missing = True
        elif not (line.startswith("rsync error: some files/attrs were not transferred")
                  or re.fullmatch(r'rsync: \[.*\] write error: Broken pipe \(32\)', line)):
            return False
    return missing


def pull(box_id: str, remote_dir: str, rel_cwd: str, path: str, local_cwd: Path, timeout: float = 1800) -> dict:
    with toollog.span("sync", "run.pull", ids={"box": box_id}, tag="pull_failed") as data:
        result = _pull(box_id, remote_dir, rel_cwd, path, local_cwd, timeout)
        data["ok"] = bool(result.get("ok"))
        data["props"].update(bytes=result.get("received", 0), files=result.get("files", 0),
                             failed=not data["ok"], stale=not data["ok"])
        return result


def _pull(box_id: str, remote_dir: str, rel_cwd: str, path: str, local_cwd: Path, timeout: float = 1800) -> dict:
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
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        check_host_key(box_id, p.stderr.encode(errors="replace"))
    st = _stats(p.stdout)
    st["ok"] = p.returncode == 0
    if p.returncode != 0:
        st["missing"] = _missing_pull(p.returncode, p.stderr.strip())
        st["error"] = p.stderr.strip()[-300:]
    return st


@toollog.observed("ssh", "ssh.put_file", "put_file_failed", timeout_tag="put_file_timeout")
def put_file(box_id: str, remote_path: str, content: bytes, mode: str = "600", timeout: float = 120) -> None:
    d = os.path.dirname(remote_path)
    ssh(box_id, f"umask 077; mkdir -p {shlex.quote(d)} && cat > {shlex.quote(remote_path)} && chmod {mode} "
                f"{shlex.quote(remote_path)}", input=content, check=True, timeout=timeout)


def tunnel(box_id: str, remote_port: int, local_port: int, reverse: bool = False) -> subprocess.Popen:
    fwd = (["-R", f"127.0.0.1:{remote_port}:127.0.0.1:{local_port}"] if reverse
           else ["-L", f"127.0.0.1:{local_port}:127.0.0.1:{remote_port}"])
    return subprocess.Popen(ssh_base(box_id) + ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ControlMaster=no",
                                                "-o", "ControlPath=none", *fwd, box_id])
