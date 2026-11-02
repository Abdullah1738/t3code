#!/bin/zsh -f
# Install the harness-cli job to ~/.local/share/harness-cli and (optionally) load its daily LaunchAgent.
#   install.zsh                copy the package, run the self-tests, run `status`
#   install.zsh --check        check only: compare the installed copy with the fork, no write
#   install.zsh --with-agent   also (re)load com.ardud.harness-cli (daily 06:00 Dubai)
# Pins and records live in ~/.robob/harness-cli and are never touched by this script.
set -eu

pkg="${0:A:h}"
dst="$HOME/.local/share/harness-cli"
py=/opt/homebrew/bin/python3
label=com.ardud.harness-cli
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
  if [[ ! -f "$dst/harness_cli.py" ]]; then
    print -u2 "not installed: $dst/harness_cli.py missing"; exit 1
  fi
  if ! diff -q "$pkg/harness_cli.py" "$dst/harness_cli.py" >/dev/null; then
    print -u2 "drift: $dst/harness_cli.py differs from the fork"; exit 1
  fi
  print "OK installed copy matches the fork"
  exit 0
fi

# Refuse to install a copy that fails its own tests.
(cd "$pkg" && "$py" -m unittest discover -s tests >/dev/null)

mkdir -p "$dst" "$HOME/.robob/harness-cli/logs"
rsync -a --itemize-changes \
  --exclude __pycache__ --exclude tests --exclude README.md --exclude install.zsh \
  --exclude launchd --exclude '*.bak*' \
  "$pkg/" "$dst/"

if (( with_agent )); then
  install -m 0644 "$pkg/launchd/$label.plist" "$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  print "loaded $label"
fi

"$py" "$dst/harness_cli.py" status
