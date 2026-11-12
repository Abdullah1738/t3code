#!/bin/zsh -f
# Install the harness-cli job to ~/.local/share/harness-cli and its daily LaunchAgent.
#   install.zsh                copy the package, run the self-tests, install + load com.ardud.harness-cli
#   install.zsh --no-agent     copy the package only; leave the LaunchAgent as it is
#   install.zsh --check        check only: installed copy, plist and loaded agent match the fork, no write
# --with-agent is accepted for older notes; the agent is installed by default (card #960: the
# opt-in flag was never passed, so the daily job never ran).
# Pins and records live in ~/.robob/harness-cli and are never touched by this script.
set -eu

pkg="${0:A:h}"
dst="$HOME/.local/share/harness-cli"
py=/opt/homebrew/bin/python3
launchctl="${HARNESS_CLI_LAUNCHCTL:-launchctl}"
label=com.ardud.harness-cli
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

mode=install
with_agent=1
for arg in "$@"; do
  case "$arg" in
    --check) mode=check ;;
    --with-agent) with_agent=1 ;;
    --no-agent) with_agent=0 ;;
    *) print -u2 "usage: install.zsh [--check] [--no-agent]"; exit 2 ;;
  esac
done

agent_loaded() { "$launchctl" print "$domain/$label" >/dev/null 2>&1 }

if [[ "$mode" == check ]]; then
  bad=0
  if [[ ! -f "$dst/harness_cli.py" ]]; then
    print -u2 "not installed: $dst/harness_cli.py missing"; bad=1
  elif ! diff -q "$pkg/harness_cli.py" "$dst/harness_cli.py" >/dev/null; then
    print -u2 "drift: $dst/harness_cli.py differs from the fork"; bad=1
  fi
  if [[ ! -f "$plist" ]]; then
    print -u2 "agent missing: $plist not installed (the daily auto job never runs)"; bad=1
  elif ! cmp -s "$pkg/launchd/$label.plist" "$plist"; then
    print -u2 "drift: $plist differs from the fork"; bad=1
  fi
  if ! agent_loaded; then
    print -u2 "agent not loaded: $label is not in launchctl ($domain)"; bad=1
  fi
  (( bad )) && exit 1
  print "OK installed copy and $label match the fork"
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
  # Reload only when the plist changed or the agent is not loaded: a bootout during the 06:00
  # run would kill a canary or promotion mid-way. RunAtLoad is false, so loading runs nothing.
  if ! cmp -s "$pkg/launchd/$label.plist" "$plist" || ! agent_loaded; then
    mkdir -p "${plist:h}"
    install -m 0644 "$pkg/launchd/$label.plist" "$plist"
    "$launchctl" bootout "$domain/$label" 2>/dev/null || true
    "$launchctl" bootstrap "$domain" "$plist"
    print "loaded $label"
  else
    print "$label already loaded and current"
  fi
fi

"$py" "$dst/harness_cli.py" status
