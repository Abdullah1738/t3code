"""Give unit, pytest and Bun test processes a private, inherited log destination."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main(argv=None):
    command = sys.argv[1:] if argv is None else argv
    if not command:
        raise SystemExit("usage: test-runner.py <test command> [args ...]")
    with tempfile.TemporaryDirectory(prefix="offbox-test-logs-") as root:
        env = dict(os.environ, OFFBOX_TEST="1", OFFBOX_LOG_DIR=str(Path(root) / "offbox"),
                   OFFBOX_TOOL_LOG_DIR=str(Path(root) / "offbox"), TOOLLOG_ROOT=root,
                   OFFBOX_STATE_DIR=str(Path(root) / "state"))
        return subprocess.call(command, env=env)


if __name__ == "__main__":
    sys.exit(main())
