#!/bin/zsh -f
# Install the harness-homes generator to ~/.local/share/harness-homes, build the
# homes under ~/.robob/harness-homes, and check them.
#   install.zsh            copy, generate, check
#   install.zsh --check    check only (no copy, no write)
#   install.zsh --with-agent   also (re)load com.ardud.harness-homes every 5 min
set -eu

pkg="${0:A:h}"
dst="$HOME/.local/share/harness-homes"
py=/opt/homebrew/bin/python3
label=com.ardud.harness-homes
plist="$HOME/Library/LaunchAgents/$label.plist"

mode=install
with_agent=0
for arg in "$@"; do
  case "$arg" in
    --check) mode=check ;;
    --with-agent) with_agent=1 ;;
    *) print -u2 "usage: install.zsh [--check] [--with-agent]"; exit 2 ;;
  esac
done

if [[ "$mode" == check ]]; then
  exec "$py" "$dst/generate_homes.py" check
fi

mkdir -p "$dst/logs"
rsync -a --itemize-changes \
  --exclude node_modules --exclude data --exclude logs --exclude .venv --exclude venv \
  --exclude backups --exclude __pycache__ --exclude '*.bak*' --exclude '*.sqlite*' \
  --exclude '*.db' --exclude '*.db-*' --exclude '*.log' --exclude '*.pid' --exclude '*.lock' \
  --exclude tmp --exclude 'verification*' --exclude bin --exclude .gitignore --exclude README.md \
  --exclude docs --exclude tests \
  "$pkg/" "$dst/"

"$py" "$dst/generate_homes.py" generate
"$py" "$dst/generate_homes.py" check

if (( with_agent )); then
  install -m 0644 "$pkg/launchd/$label.plist" "$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  print "loaded $label"
fi
