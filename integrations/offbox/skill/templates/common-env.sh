#!/bin/bash
# offbox: point every tool cache under $HOME so boat snapshots (stop/fork) keep them.
# Idempotent. Runs as the box user (passwordless sudo). Used by every template recipe and fresh leases.
set -euo pipefail
H=/home/user
BEGIN="# >>> offbox cache env >>>"
END="# <<< offbox cache env <<<"
read -r -d '' VARS <<EOF || true
XDG_CACHE_HOME=$H/.xcache
GOCACHE=$H/.xcache/go-build
GOMODCACHE=$H/go/pkg/mod
GOTOOLCHAIN=auto
npm_config_cache=$H/.npm
npm_config_update_notifier=false
npm_config_fund=false
npm_config_audit=false
npm_config_store_dir=$H/.local/share/pnpm/store
PNPM_HOME=$H/.local/share/pnpm
YARN_CACHE_FOLDER=$H/.xcache/yarn
PIP_CACHE_DIR=$H/.xcache/pip
UV_CACHE_DIR=$H/.xcache/uv
PLAYWRIGHT_BROWSERS_PATH=$H/.local/share/ms-playwright
CYPRESS_CACHE_FOLDER=$H/.xcache/cypress
DOCKER_BUILDKIT=1
OFFBOX_BUILDCACHE=$H/.buildcache
EOF

mkdir -p "$H/.xcache" "$H/.npm" "$H/.local/share/pnpm/store" "$H/.local/share/ms-playwright" "$H/.buildcache" "$H/go/pkg/mod" "$H/w" "$H/.offbox/env"
chmod 700 "$H/.offbox/env"

# ~/.bashrc: block at the very top (the stock file returns early for non-interactive shells).
if ! grep -qF "$BEGIN" "$H/.bashrc" 2>/dev/null; then
  {
    echo "$BEGIN"
    while IFS= read -r line; do [ -n "$line" ] && echo "export $line"; done <<< "$VARS"
    echo "$END"
    cat "$H/.bashrc" 2>/dev/null || true
  } > "$H/.bashrc.offbox.tmp"
  mv "$H/.bashrc.offbox.tmp" "$H/.bashrc"
fi

# /etc/environment: plain KEY=VALUE (no expansion), read by PAM for ssh and systemd user sessions.
if ! sudo grep -qF "$BEGIN" /etc/environment 2>/dev/null; then
  {
    echo "$BEGIN"
    echo "$VARS"
    echo "$END"
  } | sudo tee -a /etc/environment >/dev/null
fi

git config --global --get safe.directory >/dev/null 2>&1 || git config --global --add safe.directory '*'
echo "offbox cache env ok"
