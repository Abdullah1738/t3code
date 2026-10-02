#!/bin/zsh -f
set -eu
umask 077
config="$HOME/.config/agent-bridges"
mkdir -p "$config"
chmod 700 "$config"
# Each bridge child sources its own credentials from its own start.zsh.
exec "$HOME/.bun/bin/bun" "$HOME/.local/share/agent-bridges/src/supervisor.ts" "$@"
