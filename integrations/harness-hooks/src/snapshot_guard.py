"""Installer-pinned entry point; no owner approval or database access here."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil


FILES = ("bin/live-db-snapshot", "src/live_db_snapshot.py", "src/snapshot_guard.py",
         "src/engine.py", "src/statev2_guard.py")


def snapshot_attempt(command):
    # Unknown executable names are not readers in the legacy classifier. Keep
    # a renamed/unpinned snapshot request closed as well as compound requests.
    return all(flag in command for flag in ("--card", "--ask", "--db"))


def install_pin(root):
    pins = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in FILES}
    path = root / "snapshot-pin.json"
    path.write_text(json.dumps(pins) + "\n")
    path.chmod(0o600)


def exact_invocation(command, cwd):
    # A deliberately small grammar: no wrappers, expansions, shell operators,
    # startup assignments, or escape syntax. Quoted paths may contain spaces.
    if re.search(r"[\n\r;$`|&<>()\\{}*?\[\]#!]", command):
        return False
    try:
        argv = shlex.split(command)
        if not argv:
            return False
        root = Path.home() / ".local/share/harness-hooks"
        executable = os.path.expanduser(argv[0])
        if "/" not in executable:
            executable = shutil.which(executable)
        elif not os.path.isabs(executable):
            executable = os.path.join(cwd, executable)
        if not executable or Path(executable).resolve() != (root / FILES[0]).resolve():
            return False
        # The module and its policy dependencies must be pinned too: hashing a
        # launcher alone would still admit a replaced implementation.
        pins = json.loads((root / "snapshot-pin.json").read_text())
        if any(pins.get(name) != hashlib.sha256((root / name).read_bytes()).hexdigest() for name in FILES):
            return False
        options = argv[1:]
        if len(options) % 2:
            return False
        values = dict(zip(options[::2], options[1::2]))
        return (len(values) * 2 == len(options) and
                {"--card", "--ask", "--db"} <= values.keys() <=
                {"--card", "--ask", "--db", "--board", "--out-parent"} and
                all(value and not value.startswith("-") for value in values.values()) and
                os.path.isabs(values["--db"]))
    except (OSError, ValueError, TypeError, AttributeError):
        return False
