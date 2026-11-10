#!/usr/bin/python3
"""Install only after the reviewed commit is merged and pushed."""
import argparse
import fcntl
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    repo = subprocess.check_output(["git", "-C", str(here), "rev-parse", "--show-toplevel"], text=True).strip()
    subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", "HEAD", "origin/main"], check=True)
    if subprocess.check_output(["git", "-C", repo, "status", "--porcelain", "--", str(here)], text=True).strip():
        raise SystemExit("refusing uncommitted memguard files")
    home = Path.home()
    pairs = [(here / "memguard.py", home / ".local/libexec/ovnfs-memguard/memguard.py", 0o644), (here / "ovnfs-memguard", home / ".local/bin/ovnfs-memguard", 0o755)]
    label = "com.abdullah.ovnfs-memguard"
    plist = home / ("Library/LaunchAgents/" + label + ".plist")
    settings = dict(Label=label, ProcessType="Interactive", ProgramArguments=["/bin/zsh", str(home / ".local/bin/ovnfs-memguard")], RunAtLoad=True, StartInterval=300, StandardOutPath=str(home / "Library/Logs/ovnfs-memguard.log"), StandardErrorPath=str(home / "Library/Logs/ovnfs-memguard.log"))
    # Owner-approved thresholds/cooldowns live in this block; installing a
    # helper must not silently replace them with the code defaults.
    if plist.exists():
        previous = plistlib.loads(plist.read_bytes())
        if "EnvironmentVariables" in previous:
            settings["EnvironmentVariables"] = previous["EnvironmentVariables"]
    domain = "gui/" + str(os.getuid())
    if args.check:
        problems = [str(dst) for src, dst, mode in pairs if not dst.exists() or dst.read_bytes() != src.read_bytes() or dst.stat().st_mode & 0o777 != mode]
        if not plist.exists() or plistlib.loads(plist.read_bytes()) != settings:
            problems.append(str(plist))
        if subprocess.run(["launchctl", "print", domain + "/" + label], capture_output=True).returncode:
            problems.append("LaunchAgent not loaded")
        print("\n".join(problems) if problems else "memguard matches reviewed source and LaunchAgent is loaded")
        return 1 if problems else 0
    lock_path = home / ".local/state/ovnfs-memguard.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("memguard is running; retry installation after its read-back completes")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        for src, dst, mode in pairs:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                shutil.copy2(dst, str(dst) + ".bak-" + stamp)
            shutil.copy2(src, dst)
            dst.chmod(mode)
        plist_changed = not plist.exists() or plistlib.loads(plist.read_bytes()) != settings
        if plist_changed:
            plist.parent.mkdir(parents=True, exist_ok=True)
            if plist.exists():
                shutil.copy2(plist, str(plist) + ".bak-" + stamp)
            plist.write_bytes(plistlib.dumps(settings))
        loaded = subprocess.run(["launchctl", "print", domain + "/" + label], capture_output=True).returncode == 0
        if loaded and plist_changed:
            subprocess.run(["launchctl", "bootout", domain + "/" + label], check=True)
        if not loaded or plist_changed:
            subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    print("installed; existing periodic job will use the new helper on its next run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
