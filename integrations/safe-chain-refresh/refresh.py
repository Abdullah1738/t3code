#!/usr/bin/python3
"""Prewarm safe-chain lists; inline fetch deadlines still require an upstream fix."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

import toollog

PACKAGE = Path(__file__).resolve().parent
LABEL = "com.ardud.safe-chain-refresh"
FILES = {"refresh.py": 0o755, "refresh.mjs": 0o644, "toollog.py": 0o644,
         f"launchd/{LABEL}.plist": 0o644}


def node_path(home: Path) -> str | None:
    try:
        manifest = json.loads((home / ".local/share/harness-homes/manifest.json").read_text())
        path = ":".join(manifest["shellPathPrefix"] + manifest["shellPath"])
    except (OSError, ValueError, KeyError, TypeError):
        path = os.environ.get("PATH", os.defpath)
    return shutil.which("node", path=path)


def stop_child(proc: subprocess.Popen) -> tuple[bytes, bytes]:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.communicate(timeout=1)
    except subprocess.SubprocessError:
        pass
    finally:
        # A descendant can outlive the leader after closing the captured pipes.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    try:
        return proc.communicate(timeout=1)
    except subprocess.SubprocessError:
        proc.stdout.close()
        proc.stderr.close()
        raise


def summary(output: bytes) -> dict:
    result = json.loads(output.decode("utf-8").splitlines()[-1])
    keys = ("expected", "refreshed", "cached", "failed")
    if (any(type(result[key]) is not int or result[key] < 0 for key in keys) or
            result["expected"] == 0 or sum(result[key] for key in keys[1:]) > result["expected"]):
        raise ValueError("invalid refresh summary")
    return result


def refresh(home: Path, package_root: Path, node: str | None, deadline: float) -> tuple[int, str]:
    runtime = home / ".local/share/safe-chain-refresh"
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (runtime / "refresh.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Safe-chain refresh: another refresh is running; skipped.", file=sys.stderr)
            return 0, "locked"
        started = time.monotonic()
        status, rc = "failed", 1
        result = dict(expected=0, refreshed=0, cached=0, failed=0)
        print(f"Safe-chain refresh: starting; deadline {deadline:g}s.", file=sys.stderr, flush=True)
        try:
            if not node:
                raise OSError("node unavailable")
            env = dict(os.environ, HOME=str(home))
            with tempfile.TemporaryDirectory(prefix="safe-chain-refresh-") as scratch:
                proc = subprocess.Popen([node, str(PACKAGE / "refresh.mjs"), str(package_root)],
                                        cwd=scratch, env=env, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, start_new_session=True)
                try:
                    out, _ = proc.communicate(timeout=deadline)
                except subprocess.TimeoutExpired:
                    status = "timeout"
                    out, _ = stop_child(proc)
                    print(f"Safe-chain refresh: deadline {deadline:g}s exceeded; stopped its process group. "
                          "Existing valid caches are retained. Inline fetches still need an upstream deadline.",
                          file=sys.stderr, flush=True)
                result = summary(out)
                pending = result["expected"] - sum(result[key] for key in ("refreshed", "cached", "failed"))
                if status != "timeout":
                    if proc.returncode != 0 or result["failed"] or pending:
                        status, rc = "failed", 1
                    else:
                        status, rc = ("cached", 1) if result["cached"] else ("ok", 0)
                print(f"Safe-chain refresh: {result['refreshed']} lists revalidated, "
                      f"{result['cached']} cached fallbacks, {result['failed']} failed, {pending} pending.",
                      file=sys.stderr, flush=True)
        except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
            print("Safe-chain refresh: could not run the installed list API or read its summary; "
                  "check the safe-chain installation. No package command was run.", file=sys.stderr)
        elapsed = (time.monotonic() - started) * 1000
        state = dict(result, status=status, elapsedMs=round(elapsed), attemptedAt=int(time.time()))
        temporary = runtime / f"state.{os.getpid()}.tmp"
        temporary.write_text(json.dumps(state) + "\n", encoding="utf-8")
        temporary.replace(runtime / "state.json")
        toollog.emit("safe-chain-refresh", "perf" if rc == 0 else "error", "refresh.run",
                     duration_ms=elapsed, ok=rc == 0, props={"status": status, "count": result["refreshed"]},
                     error_tag=None if rc == 0 else "refresh." + status)
        return rc, status


def plist_bytes(home: Path) -> bytes:
    value = plistlib.loads((PACKAGE / "launchd" / f"{LABEL}.plist").read_bytes())
    value["ProgramArguments"] = [s.replace("__HOME__", str(home)) for s in value["ProgramArguments"]]
    for key in ("StandardOutPath", "StandardErrorPath"):
        value[key] = value[key].replace("__HOME__", str(home))
    return plistlib.dumps(value)


def install(home: Path, *, check: bool, dry_run: bool, no_launch: bool) -> int:
    destination = home / ".local/share/safe-chain-refresh"
    binary = home / ".local/bin/safe-chain-refresh"
    plist = home / "Library/LaunchAgents" / f"{LABEL}.plist"
    inventory = destination / "installed-files.json"
    loaded_digest = destination / "loaded-plist.sha256"
    if dry_run:
        print("Would copy safe-chain-refresh and its 30-minute LaunchAgent; no existing service restart.")
        return 0
    if check:
        try:
            recorded = json.loads(inventory.read_text(encoding="utf-8"))
            hashes = recorded if PACKAGE == destination else {
                name: hashlib.sha256((PACKAGE / name).read_bytes()).hexdigest() for name in FILES}
            if set(hashes) != set(FILES) or recorded != hashes:
                raise ValueError("invalid installed inventory")
        except (OSError, ValueError, TypeError):
            print("FAIL " + str(inventory), file=sys.stderr)
            return 1
        failures = []
        for name, mode in FILES.items():
            path = destination / name
            if (not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != hashes[name] or
                    stat.S_IMODE(path.stat().st_mode) != mode):
                failures.append(str(path))
        if not failures:
            if (not plist.is_file() or plist.read_bytes() != plist_bytes(home) or
                    stat.S_IMODE(plist.stat().st_mode) != 0o644):
                failures.append(str(plist))
        if not binary.is_symlink() or binary.resolve() != destination / "refresh.py":
            failures.append(str(binary))
        if not no_launch and subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"],
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            failures.append(LABEL + " is not loaded")
        if not no_launch and not failures and (not loaded_digest.is_file() or
                              loaded_digest.read_text().strip() != hashlib.sha256(plist_bytes(home)).hexdigest()):
            failures.append(LABEL + " must be reloaded by the installer")
        for failure in failures:
            print("FAIL " + failure, file=sys.stderr)
        return int(bool(failures))
    repo = subprocess.check_output(["git", "-C", str(PACKAGE), "rev-parse", "--show-toplevel"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", repo, "status", "--porcelain"], text=True)
    pushed = subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", "HEAD", "origin/main"]).returncode == 0
    if dirty or not pushed:
        print("Refusing install: source must be clean and merged to origin/main.", file=sys.stderr)
        return 1
    if binary.exists() or binary.is_symlink():
        if not binary.is_symlink() or binary.resolve() != destination / "refresh.py":
            print("Refusing to replace an unrelated safe-chain-refresh command.", file=sys.stderr)
            return 1
    contents = {name: (PACKAGE / name).read_bytes() for name in FILES}
    expected = {destination / name: (data, FILES[name]) for name, data in contents.items()}
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}
    expected[inventory] = ((json.dumps(hashes, sort_keys=True) + "\n").encode("utf-8"), 0o644)
    expected[plist] = (plist_bytes(home), 0o644)
    for path, (data, mode) in expected.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        temporary.write_bytes(data)
        temporary.chmod(mode)
        temporary.replace(path)
    binary.parent.mkdir(parents=True, exist_ok=True)
    if not binary.is_symlink():
        binary.symlink_to(destination / "refresh.py")
    (destination / "logs").mkdir(exist_ok=True, mode=0o700)
    if not no_launch:
        digest = hashlib.sha256(expected[plist][0]).hexdigest()
        loaded = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        changed = not loaded_digest.is_file() or loaded_digest.read_text().strip() != digest
        if loaded and changed:
            subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], check=True)
        if not loaded or changed:
            subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)], check=True)
            loaded_digest.write_text(digest + "\n", encoding="utf-8")
    print("Installed safe-chain-refresh; shared services unchanged.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("run", "install"), nargs="?", default="run")
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--package-root", type=Path)
    parser.add_argument("--node")
    parser.add_argument("--deadline", type=float, default=30)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--check", action="store_true")
    actions.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-launch", action="store_true", help="File-only install/check for isolated simulations")
    args = parser.parse_args(argv)
    if args.deadline <= 0 or args.deadline > 120 or not args.deadline < float("inf"):
        parser.error("deadline must be positive and at most 120 seconds")
    home = args.home.resolve()
    if args.command == "install":
        return install(home, check=args.check, dry_run=args.dry_run, no_launch=args.no_launch)
    root = args.package_root or home / ".local/share/safe-chain-global/lib/node_modules/@aikidosec/safe-chain"
    node = str(Path(shutil.which(args.node) or args.node).resolve()) if args.node else node_path(home)
    return refresh(home, root.resolve(), node, args.deadline)[0]


if __name__ == "__main__":
    raise SystemExit(main())
