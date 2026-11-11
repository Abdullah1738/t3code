#!/usr/bin/python3
"""Memory-triggered restarts with bounded, continuous mount read-back."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time


def log(event, **fields):
    print(json.dumps(dict(at=time.strftime("%Y-%m-%dT%H:%M:%S%z"), event=event, **fields)), flush=True)


def footprint_mb(text):
    match = re.search(r"phys_footprint:\s*([\d.]+)\s*(KB|MB|GB|TB)\b", text)
    if not match:
        return None
    return int(float(match[1]) * {"KB": 1 / 1024, "MB": 1, "GB": 1024, "TB": 1024**2}[match[2]])


def supports_keep_mount(version):
    match = re.search(r"\bv(\d+)\.(\d+)\.(\d+)\b", version)
    return match is not None and tuple(map(int, match.groups())) >= (0, 3, 0)


def command(args, timeout=10):
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout)


def mounted(mount):
    result = command(["/sbin/mount"], timeout=2)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return any(" on " + mount + " " in line for line in result.stdout.splitlines())


def probe(mount):
    begin = time.monotonic()
    try:
        # Reading directory entries sends actual NFS I/O without opening a
        # user's files or writing anything into a checkout.
        with os.scandir(mount) as entries:
            next(entries, None)
        return dict(read="ok", errno=None, seconds=time.monotonic() - begin)
    except OSError as error:
        return dict(read="error", errno=error.errno, seconds=time.monotonic() - begin)


class Readback:
    """At most one blocked probe, even when a kernel mount stops answering."""
    def __init__(self, mount, lock_fd=None):
        self.mount = mount
        self.lock_fd = lock_fd
        self.child = None
        self.begin = None

    def sample(self):
        try:
            entry = mounted(self.mount)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            return dict(mount_entry=None, read="mount_table_error", error=str(error))
        if self.child is not None:
            if self.child.poll() is None:
                return dict(mount_entry=entry, read="pending", seconds=time.monotonic() - self.begin)
            out, err = self.child.communicate()
            try:
                result = json.loads(out)
            except (ValueError, TypeError):
                result = dict(read="probe_failed", exit=self.child.returncode, error=err.strip())
            self.child = None
            # A successful bare-folder read must not look like NFS recovery.
            result["mount_entry"] = entry
            if not entry and result.get("read") == "ok":
                result["read"] = "not_mounted"
            return result
        if not entry:
            return dict(mount_entry=False, read="not_mounted")
        self.begin = time.monotonic()
        self.child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--probe", self.mount], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, pass_fds=() if self.lock_fd is None else (self.lock_fd,))
        return dict(mount_entry=True, read="pending", seconds=0)

    def close(self):
        if self.child is not None:
            # Only our captured probe pid; never a daemon or a matched process.
            if self.child.poll() is None:
                self.child.kill()
            try:
                self.child.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                log("probe_still_blocked", pid=self.child.pid)


def stream_restart(child):
    for line in child.stdout:
        log("restart_output", pid=child.pid, line=line.rstrip())


def monitor_restart(binary, mount, after=120, budget=1800, interval=1, lock_fd=None):
    child = subprocess.Popen([binary, "restart"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    stream = threading.Thread(target=stream_restart, args=(child,), daemon=True)
    stream.start()
    reader = Readback(mount, lock_fd)
    begin = time.monotonic()
    ended = None
    try:
        while True:
            now = time.monotonic()
            code = child.poll()
            if code is not None and ended is None:
                ended = now
                log("restart_exit", pid=child.pid, exit=code, seconds=now - begin)
            if code is None and ended is None and now - begin >= budget:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                log("restart_timeout", pid=child.pid, seconds=now - begin)
                ended = now
            log("mount_readback", phase="during" if ended is None else "after", **reader.sample())
            if ended is not None and now - ended >= after:
                return child.poll()
            time.sleep(interval)
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
        reader.close()
        stream.join(timeout=1)
        if not stream.is_alive():
            child.stdout.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe")
    args = parser.parse_args()
    if args.probe:
        print(json.dumps(probe(args.probe)))
        return 0
    binary = str(Path.home() / ".local/bin/ovnfs")
    stamp = Path.home() / ".local/state/ovnfs-memguard.last"
    stamp.parent.mkdir(parents=True, exist_ok=True)
    with stamp.with_suffix(".lock").open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("guard_already_running")
            return 0
        result = command([binary, "--json", "status"])
        if result.returncode:
            log("daemon_not_ready", detail=result.stderr.strip())
            return 0
        status = json.loads(result.stdout)
        pid, mount = status["pid"], status["mount"]
        result = command(["/usr/bin/footprint", str(pid)])
        memory = footprint_mb(result.stdout)
        if memory is None:
            log("footprint_unavailable", pid=pid, exit=result.returncode)
            return 1
        limit = int(os.environ.get("OVNFS_MEMGUARD_LIMIT_MB", "14336"))
        cooldown = int(os.environ.get("OVNFS_MEMGUARD_COOLDOWN_S", "1200"))
        if memory < limit:
            return 0
        try:
            last = int(stamp.read_text().strip())
        except (OSError, ValueError):
            last = 0
        now = int(time.time())
        if now - last < cooldown:
            log("cooldown", pid=pid, memory_mb=memory, limit_mb=limit, elapsed_s=now - last)
            return 0
        version = command([binary, "version"]).stdout
        if not supports_keep_mount(version):
            log("keep_mount_unsupported", version=version.strip())
            return 0
        try:
            entry = mounted(mount)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            entry = None
            log("initial_mount_table_error", error=str(error))
        stamp.write_text(str(now) + "\n")
        log("restart_begin", pid=pid, memory_mb=memory, limit_mb=limit, cooldown_s=cooldown, mount=mount, mount_entry=entry)
        code = monitor_restart(binary, mount, lock_fd=lock.fileno())
        log("readback_finished", restart_exit=code)
        return 0 if code == 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        log("guard_error", error=str(error))
        sys.exit(1)
