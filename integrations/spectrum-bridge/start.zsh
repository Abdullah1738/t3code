#!/bin/zsh -f
set -eu
umask 077
config="$HOME/.config/spectrum-bridge"
credentials="$config/credentials.env"
[[ -d "$config" && ! -L "$config" && -O "$config" ]] || exit 1
[[ "$(stat -f '%Lp' "$config")" == 700 ]] || exit 1
[[ -f "$credentials" && ! -L "$credentials" && -O "$credentials" ]] || exit 1
[[ "$(stat -f '%Lp' "$credentials")" == 600 ]] || exit 1
set -a
source "$credentials"
set +a
# Photon needs its project pair; Sendblue mode needs its key pair instead (config.json picks the transport).
[[ -n "${SPECTRUM_PROJECT_ID:-}" && -n "${SPECTRUM_PROJECT_SECRET:-}" ]] \
  || [[ -n "${SENDBLUE_API_KEY_ID:-}" && -n "${SENDBLUE_API_SECRET:-}" ]] || exit 1
exec "$HOME/.bun/bin/bun" "$HOME/.local/share/spectrum-bridge/src/main.ts" "$@"
