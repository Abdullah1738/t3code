#!/usr/bin/env python3
"""Prepare Flighty's private Python without changing services or harness config."""
from pathlib import Path
import subprocess


def prepare():
    home = Path.home().resolve()
    venv = home / ".local/share/flighty-mcp/.venv"
    config = dict(line.split("=", 1) for line in (venv / "pyvenv.cfg").read_text().splitlines()
                  if "=" in line)
    config = {key.strip(): value.strip() for key, value in config.items()}
    if not config.get("home") or not Path(config["home"]).is_absolute():
        raise ValueError(f"{venv / 'pyvenv.cfg'}: expected an absolute home path")
    base = Path(config["home"]).resolve(strict=True).parent
    binary = (venv / "bin/python").resolve(strict=True).relative_to(base)
    destination = home / ".local/share/shared-mcp-flighty/python"
    if destination.resolve() != destination or base.is_relative_to(destination) or destination.is_relative_to(base):
        raise ValueError("dedicated Flighty Python must be separate from the base interpreter")
    destination.mkdir(parents=True, exist_ok=True)
    # Avoid rewriting an unchanged executable: TCC grants belong to this copy.
    changes = subprocess.run(
        ["rsync", "-ac", "--dry-run", "--delete", "--itemize-changes", f"{base}/", f"{destination}/"],
        check=True, capture_output=True, text=True)
    if changes.stdout.strip():
        subprocess.run(["rsync", "-a", "--delete", "--checksum", f"{base}/", f"{destination}/"], check=True)
    copied_binary = (destination / binary).resolve(strict=True)
    copied_binary.relative_to(destination)
    print(f"FULL_DISK_ACCESS_PATH={copied_binary}")


if __name__ == "__main__":
    try:
        prepare()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"flighty: cannot prepare dedicated Python: {exc}")
