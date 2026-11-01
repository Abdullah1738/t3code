#!/bin/zsh -f
# Copy this integration; trust and generated-home changes are separate steps.
set -eu
pkg="${0:A:h}"
dst="$HOME/.local/share/harness-hooks"
flags=(-a --itemize-changes)
case "${1:-}" in
  '') ;;
  --dry-run) flags+=(--dry-run) ;;
  *) print -u2 'usage: install.zsh [--dry-run]'; exit 2 ;;
esac
(( $# <= 1 )) || { print -u2 'usage: install.zsh [--dry-run]'; exit 2; }
rsync "${flags[@]}" \
  --exclude __pycache__ --exclude '*.pyc' --exclude tests --exclude .gitignore \
  "$pkg/" "$dst/"
