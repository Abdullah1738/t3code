#!/bin/zsh -f
# Explicit installation only; importing or deploying this directory does not run it.
set -eu
source_dir="${0:A:h}"
dry=0
target="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
while (( $# )); do
  case "$1" in
    --dry-run) dry=1; shift ;;
    --config-dir) [[ $# -ge 2 ]] || exit 2; target="$2"; shift 2 ;;
    *) print -u2 "usage: plugin/install.zsh [--dry-run] [--config-dir DIR]"; exit 2 ;;
  esac
done
[[ -f "$source_dir/recall.ts" ]] || { print -u2 "missing repo-owned plugin source"; exit 1; }
python3 - "$source_dir/recall.ts" "$target" "$dry" "$source_dir/../skill/remember-this-next-time" <<'PY'
import datetime
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

source, root, dry = Path(sys.argv[1]), Path(sys.argv[2]).resolve(), sys.argv[3] == "1"
skill = Path(sys.argv[4])
plugin, config = root / "plugin/recall.ts", root / "recall.json"
if plugin.is_symlink() or config.is_symlink():
    raise SystemExit("refusing symlink targets; choose an explicit configuration directory")
value = json.loads(config.read_text()) if config.exists() else {}
if not isinstance(value, dict) or value.get("mode", "on") not in ("on", "observe", "off"):
    raise SystemExit("invalid existing recall config; no changes made")
value.update(wait_ms=500, timeout_ms=500, preaction_ms=3000, work=False, work_subagents=False)
value.setdefault("mode", "on")
value.setdefault("url", "http://127.0.0.1:18765")
targets = [(plugin, source.read_bytes()), (config, (json.dumps(value, indent=2) + "\n").encode())]
if skill.is_dir():
    for item in sorted(skill.rglob("*")):
        if item.is_symlink():
            raise SystemExit("refusing skill source symlink")
        if item.is_file():
            targets.append((root / "skills/remember-this-next-time" / item.relative_to(skill), item.read_bytes()))
for path, _content in targets:
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root.parent):
        raise SystemExit("refusing symlink target; no changes made")
for path, content in targets:
    if path.exists() and path.read_bytes() == content:
        print(f"unchanged: {path}")
        continue
    print(f"{'would install' if dry else 'install'}: {path}")
    if dry:
        continue
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        backup = path.with_name(path.name + ".bak-" + stamp)
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)
    fd, temporary = tempfile.mkstemp(prefix=".recall-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(content)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
print("No service restart or harness-home generation performed.")
PY
