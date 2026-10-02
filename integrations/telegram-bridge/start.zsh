#!/bin/zsh -f
set -eu
umask 077
config="$HOME/.config/telegram-bridge"
credentials="$config/credentials.env"
[[ -d "$config" && ! -L "$config" && -O "$config" ]] || exit 1
[[ "$(stat -f '%Lp' "$config")" == 700 ]] || exit 1
[[ -f "$credentials" && ! -L "$credentials" && -O "$credentials" ]] || exit 1
[[ "$(stat -f '%Lp' "$credentials")" == 600 ]] || exit 1
set -a
source "$credentials"
set +a
[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] || exit 1
exec "$HOME/.bun/bin/bun" "$HOME/.local/share/telegram-bridge/src/main.ts" "$@"
