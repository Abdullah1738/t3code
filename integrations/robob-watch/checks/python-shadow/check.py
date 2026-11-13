"""Report import-name collisions at shared scratch roots without opening their files."""

import argparse
import datetime as dt
import fcntl
import importlib.machinery
import json
import os
from pathlib import Path
import sys
import time


COMMON_NAMES = {"pytest", "conftest", "requests", "yaml", "typing_extensions",
                "sitecustomize", "usercustomize"}
SUFFIXES = sorted(importlib.machinery.all_suffixes(), key=len, reverse=True)


def default_roots():
    temp_roots = [Path(os.environ["TMPDIR"])] if os.environ.get("TMPDIR") else []
    # The runner builds a small environment without TMPDIR. Darwin still exposes
    # this user's private temp root, so scheduled scans cover it as shell scans do.
    if "CS_DARWIN_USER_TEMP_DIR" in os.confstr_names:
        darwin_temp = os.confstr("CS_DARWIN_USER_TEMP_DIR")
        if darwin_temp:
            temp_roots.append(Path(darwin_temp))
    return [Path("/tmp"), Path("/private/tmp"),
            *temp_roots,
            Path.home() / "tmp", Path("/Volumes/ExternalSSD/tmp"),
            Path("/Volumes/ExternalSSD/t3code-fork/tmp"),
            Path("/Volumes/ExternalSSD/crpko-devops/tmp")]


def module_name(filename):
    for suffix in SUFFIXES:
        if filename.endswith(suffix):
            return filename[:-len(suffix)]
    return None


def scan(roots):
    names = set(sys.stdlib_module_names) | COMMON_NAMES
    findings, inventory, visited = [], [], set()
    for raw in roots:
        root = Path(raw).resolve()
        if root in visited:
            continue
        visited.add(root)
        try:
            entries = sorted(root.iterdir())
        except FileNotFoundError:
            inventory.append({"root": str(root), "status": "absent"})
            continue
        packages, namespaces, py_files = [], [], 0
        for entry in entries:
            try:
                if entry.is_dir():
                    # A bare directory is a namespace portion, which loses to a regular
                    # stdlib module/package later on sys.path. List it without alerting.
                    initializers = [entry / ("__init__" + s) for s in SUFFIXES]
                    is_package = any(p.is_file() for p in initializers)
                    if is_package:
                        packages.append(entry.name)
                    elif entry.name in names:
                        namespaces.append(str(entry))
                    if not is_package or entry.name not in names:
                        continue
                    kind, name = "package", entry.name
                elif entry.is_file():
                    py_files += entry.suffix == ".py"
                    name = module_name(entry.name)
                    if name not in names:
                        continue
                    kind = "module"
                else:
                    continue
                stat = entry.stat()
            except FileNotFoundError:
                continue  # A scratch writer may remove an entry between listing and stat.
            # Keep the import pathname: two aliases to one target can hijack different names.
            path = str(entry)
            key = json.dumps([path, stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns])
            findings.append({"path": path, "name": name, "kind": kind,
                             "size": stat.st_size,
                             "mtime_utc": dt.datetime.fromtimestamp(
                                 stat.st_mtime, dt.timezone.utc).isoformat(),
                             "key": key})
        inventory.append({"root": str(root), "status": "scanned", "entries": len(entries),
                          "python_files": py_files, "packages": packages,
                          "namespace_candidates": namespaces})
    return {"roots": inventory, "findings": sorted(findings, key=lambda f: f["path"])}


def save(path, state):
    temporary = path.with_suffix(".new")
    with temporary.open("w") as handle:
        json.dump(state, handle)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def runner_state(watch_dir):
    try:
        state = json.loads((watch_dir / "state.json").read_text())
    except FileNotFoundError:
        return {"fires": 0}
    if not isinstance(state, dict):
        raise ValueError("runner state must be an object")
    fires = state.get("fires", 0)
    if type(fires) is not int or fires < 0:
        raise ValueError("runner delivery counter must be a nonnegative integer")
    return {**state, "fires": fires}


def check(watch_dir, report, run_id):
    path = watch_dir / "shadow-seen.json"
    current = {item["key"] for item in report["findings"]}
    if not path.exists():
        save(path, {"seen": sorted(current)})
        return ""
    state = json.loads(path.read_text())
    runner = runner_state(watch_dir)
    pending = state.get("pending")
    if pending:
        ack = watch_dir / ".run-ok"
        acknowledged = ack.exists() and ack.read_text().strip() == pending["run"]
        owned = (runner.get("pending") or {}).get("event") == pending["event"]
        # The runner can crash after persisting pending but before writing .run-ok,
        # then deliver before it calls this check again. This watcher's fires counter
        # only advances on delivery; retain its original value across outbox replays.
        delivered = type(pending.get("fires")) is int and runner["fires"] > pending["fires"]
        if acknowledged or owned or delivered:
            state["seen"] = sorted(set(state["seen"]) | set(pending["keys"]))
            del state["pending"]
        else:
            # Rebind every replay so r2's acknowledgement commits an r1 outbox.
            pending["run"] = run_id
            save(path, state)
            return pending["event"]
    unseen = [item for item in report["findings"] if item["key"] not in set(state["seen"])]
    lines, keys = ["Python import shadows in shared scratch directories:"], []
    for item in unseen:
        line = (f'{json.dumps(item["path"], ensure_ascii=True)} '
                f'({item["kind"]}, {item["size"]} bytes, {item["mtime_utc"]})')
        if len("\n".join(lines + [line])) > 4000:
            if not keys:
                raise ValueError("shadow path exceeds watcher event budget; use --report")
            break
        lines.append(line)
        keys.append(item["key"])
    event = "\n".join(lines) if keys else ""
    if keys:
        state["pending"] = {"run": run_id, "keys": keys, "event": event, "fires": runner["fires"]}
    save(path, state)
    return event


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="print inventory; no state writes")
    parser.add_argument("--root", action="append", type=Path, help="override all default roots")
    args = parser.parse_args()
    if not hasattr(sys, "stdlib_module_names"):
        parser.error("Python 3.10+ required; /usr/bin/python3 on this Mac is too old")
    if args.report:
        print(json.dumps(scan(args.root or default_roots()), indent=2))
        return
    watch_dir = Path(os.environ["WATCH_DIR"])
    # robob-watch test runs on a state copy without assigning WATCH_RUN.
    run_id = os.environ.get("WATCH_RUN") or f"manual-{os.getpid()}-{time.time_ns()}"
    with (watch_dir / "shadow-check.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        event = check(watch_dir, scan(args.root or default_roots()), run_id)
        if event:
            print(event)


if __name__ == "__main__":
    main()
