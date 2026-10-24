#!/bin/zsh -f
# Sync one integration from this repo to its live copy under ~/.local/share.
# Source files only: runtime state, data and credentials on the live side are
# excluded and never deleted.
set -eu

name="${1:-}"
shift || true
case "$name" in
  agent-bridges|spectrum-bridge|telegram-bridge|robob-watch|memory-system|coord|app-api-cli|stream-recovery|scribe|catalog-guard|message-archive) ;;
  offbox) exec "${0:A:h}/offbox/install.zsh" "$@" ;;  # several live targets, see offbox/README.md
  local-helpers) exec "${0:A:h}/local-helpers/install.zsh" "$@" ;;  # files under ~/.local, see local-helpers/README.md
  *) print -u2 "usage: deploy.zsh <agent-bridges|spectrum-bridge|telegram-bridge|robob-watch|memory-system|coord|app-api-cli|stream-recovery|scribe|catalog-guard|message-archive|offbox|local-helpers> [--dry-run]"; exit 2 ;;
esac

src="${0:A:h}/$name/"
dst="$HOME/.local/share/$name/"
flags=(-a --itemize-changes)
[[ "${1:-}" == "--dry-run" ]] && flags+=(--dry-run)

rsync "${flags[@]}" \
  --exclude node_modules --exclude data --exclude logs --exclude .venv --exclude venv \
  --exclude backups --exclude __pycache__ --exclude '*.bak*' --exclude '*.sqlite*' \
  --exclude '*.db' --exclude '*.db-*' --exclude '*.log' --exclude '*.pid' --exclude '*.lock' \
  --exclude '*.sock' --exclude archive --exclude watchers --exclude HANDOFF.md --exclude tmp \
  --exclude 'verification*' --exclude bin --exclude .gitignore --exclude README.md --exclude docs \
  "$src" "$dst"
