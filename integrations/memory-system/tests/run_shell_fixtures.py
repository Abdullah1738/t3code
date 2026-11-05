"""Run macOS shell regressions offbox using disposable Linux path/utility shims.

Production scripts remain unchanged. Only temporary copies receive Linux paths;
taskpolicy is emulated and BSD date/stat/df invocations are mapped to GNU forms.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    source = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="memory-shell-fixtures-") as temp:
        root = Path(temp) / "memory-system"
        shutil.copytree(source, root, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        bins = Path(temp) / "bin"
        bins.mkdir()
        taskpolicy = bins / "taskpolicy"
        taskpolicy.write_text('#!/bin/bash\n[ "$1" = -b ] && shift\nexec "$@"\n')
        taskpolicy.chmod(0o755)
        date = bins / "date"
        date.write_text('#!/bin/bash\nif [ "$1" = -r ]; then shift; timestamp="$1"; shift; '
                        'exec /bin/date -d "@$timestamp" "$@"; fi\nexec /bin/date "$@"\n')
        date.chmod(0o755)
        replacements = {
            "/opt/homebrew/opt/sqlite/bin/sqlite3": shutil.which("sqlite3"),
            "/opt/homebrew/bin/python3": sys.executable,
            "/opt/homebrew/bin/restic": shutil.which("restic"),
            "/opt/homebrew/bin/rsync": shutil.which("rsync"),
            "/usr/sbin/taskpolicy": str(taskpolicy),
            "/opt/homebrew/bin": str(bins),
            "df -g ": "df -B 1073741824 ",
            "stat -f %m ": "stat -c %Y ",
        }
        if any(value is None for value in replacements.values()):
            raise RuntimeError("shell fixtures require sqlite3, restic and rsync")
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in (".py", ".sh"):
                content = path.read_text()
                for old, new in replacements.items():
                    content = content.replace(old, new)
                path.write_text(content)
        env = dict(os.environ, PATH=str(bins) + ":" + os.environ["PATH"])
        for test in ("test_stages.sh", "test_backup_replica.sh"):
            result = subprocess.run(["bash", str(root / "tests" / test)], cwd=root, env=env)
            if result.returncode:
                return result.returncode
    return 0


if __name__ == "__main__":
    sys.exit(main())
