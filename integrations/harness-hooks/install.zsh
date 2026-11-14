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
rsync --copy-unsafe-links "${flags[@]}" \
  --exclude __pycache__ --exclude '*.pyc' --exclude tests --exclude .gitignore \
  "$pkg/" "$dst/"
if [[ ${1:-} != --dry-run ]]; then
  chmod 700 "$dst/bin/live-db-snapshot"
  /usr/bin/python3 -I -c 'import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); from snapshot_guard import install_pin; install_pin(Path(sys.argv[1]).parent)' "$dst/src"
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$dst/bin/live-db-snapshot" "$HOME/.local/bin/live-db-snapshot"
fi
# rsync preserves removed source files; retire the old wrappers explicitly.
for retired in "$dst/coord-blockers" "$dst/src/coord_shim.py"; do
  if [[ -e $retired || -L $retired ]]; then
    if [[ ${1:-} == --dry-run ]]; then
      print -r -- "remove $retired"
    else
      rm -rf -- "$retired"
    fi
  fi
done
# The hooks call Robob's control API with their own component credential. Without it every
# identity, offbox and desktop-lease check is unavailable (desktop actions are denied).
cred="$HOME/.robob/components/harness-hooks.json"
if [[ ! -f $cred ]]; then
  print -u2 "WARNING: $cred is missing. Issue it: ELECTRON_RUN_AS_NODE=1 /Applications/Robob.app/Contents/MacOS/Robob /Applications/Robob.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs ardud component-token issue harness-hooks --base-dir ~/.robob --json, then write {url: http://127.0.0.1:3773, token} there with mode 600."
fi
