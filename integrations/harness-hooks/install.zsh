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
# The hooks call Robob's control API with their own component credential. Without it every
# identity, coord, offbox and desktop-lease check is unavailable (desktop actions are denied).
cred="$HOME/.robob/components/harness-hooks.json"
if [[ ! -f $cred ]]; then
  print -u2 "WARNING: $cred is missing. Issue it: ELECTRON_RUN_AS_NODE=1 /Applications/Robob.app/Contents/MacOS/Robob /Applications/Robob.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs ardud component-token issue harness-hooks --base-dir ~/.robob --json, then write {url: http://127.0.0.1:3773, token} there with mode 600."
fi
