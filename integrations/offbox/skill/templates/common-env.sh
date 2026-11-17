#!/bin/bash
# offbox: point every tool cache under $HOME so boat snapshots (stop/fork) keep them.
# Idempotent. Runs as the box user (passwordless sudo). Used by every template recipe and fresh leases.
set -euo pipefail
H=/home/user
BEGIN="# >>> offbox cache env >>>"
END="# <<< offbox cache env <<<"
# The uv cache and workdirs can be on different filesystems; hardlinks can fail with EXDEV.
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
UV_LINK_MODE=copy
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

# Keep fresh templates on the shipping Bun; runs may select another exact repo pin.
OFFBOX_BUN_DEFAULT=1.4.1
if [ "$("$H/.bun/bin/bun" --version 2>/dev/null || true)" != "$OFFBOX_BUN_DEFAULT" ]; then
  (
    case $(uname -m) in
      x86_64|amd64) bun_arch=x64 ;;
      aarch64|arm64) bun_arch=aarch64 ;;
      *) echo 'offbox: unsupported Bun architecture' >&2; exit 1 ;;
    esac
    mkdir -p "$H/.bun-versions" "$H/.bun/bin"
    exec 9>"$H/.bun-versions/$OFFBOX_BUN_DEFAULT.lock"
    flock -w 120 9
    bun_cache="$H/.bun-versions/$OFFBOX_BUN_DEFAULT"
    if [ "$("$bun_cache/bin/bun" --version 2>/dev/null || true)" != "$OFFBOX_BUN_DEFAULT" ]; then
      bun_stage=$(mktemp -d "$H/.bun-versions/.stage.XXXXXX")
      trap 'rm -rf -- "$bun_stage"' EXIT
      offbox_fetch "https://github.com/oven-sh/bun/releases/download/bun-v$OFFBOX_BUN_DEFAULT/bun-linux-$bun_arch.zip" "$bun_stage/bun.zip"
      unzip -q "$bun_stage/bun.zip" -d "$bun_stage"
      mkdir -p "$bun_stage/ready/bin"
      mv "$bun_stage/bun-linux-$bun_arch/bun" "$bun_stage/ready/bin/bun"
      chmod +x "$bun_stage/ready/bin/bun"
      [ "$("$bun_stage/ready/bin/bun" --version)" = "$OFFBOX_BUN_DEFAULT" ]
      ln -s bun "$bun_stage/ready/bin/bunx"
      if [ -e "$bun_cache" ]; then mv "$bun_cache" "$bun_stage/invalid"; fi
      mv "$bun_stage/ready" "$bun_cache"
    fi
    ln -sf "$bun_cache/bin/bun" "$H/.bun/bin/bun"
    ln -sf bun "$H/.bun/bin/bunx"
  )
fi
export PATH="$H/.bun/bin:$PATH"
echo "offbox cache env ok"
