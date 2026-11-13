#!/bin/zsh -f
# Installs files only. Loading the LaunchAgent and adding the tailname are separate steps.
set -eu
here="${0:A:h}"
live="${ROBOB_WIDGETS_HOME:-$HOME/.local/share/robob-widgets}"
agents="$HOME/Library/LaunchAgents"
logs="$HOME/Library/Logs/robob-widgets"
dry=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    *) print -u2 "usage: install.zsh [--dry-run]"; exit 2 ;;
  esac
done

if (( dry )); then
  print "Install bin/, lib/ and sources/ into $live; install the LaunchAgent into $agents"
  print "Create logs directory $logs; do not load the LaunchAgent"
  for file in "$here"/widgets/*.json(N); do
    if [[ -e "$live/widgets/${file:t}" || -L "$live/widgets/${file:t}" ]]; then
      print "Keep $live/widgets/${file:t}"
    else
      print "Add $live/widgets/${file:t}"
    fi
  done
  exit 0
fi

mkdir -p "$live/bin" "$live/lib" "$live/sources" "$live/widgets" "$agents" "$logs"
rsync -ac "$here/bin/" "$live/bin/"
rsync -ac "$here/lib/" "$live/lib/"
rsync -ac --exclude '__pycache__' --exclude '*.pyc' "$here/sources/" "$live/sources/"
for file in "$here"/widgets/*.json(N); do
  # Definitions are runtime state: installing an update must not overwrite them.
  if [[ ! -e "$live/widgets/${file:t}" && ! -L "$live/widgets/${file:t}" ]]; then
    /bin/cp -n "$file" "$live/widgets/${file:t}" || {
      # macOS cp -n exits 1 if another writer created the destination.
      [[ -e "$live/widgets/${file:t}" || -L "$live/widgets/${file:t}" ]] || exit 1
    }
  fi
done
/bin/cp "$here/launchd/com.ardud.robob-widgets.plist" "$agents/com.ardud.robob-widgets.plist"
print "robob-widgets: files installed; LaunchAgent not loaded"
