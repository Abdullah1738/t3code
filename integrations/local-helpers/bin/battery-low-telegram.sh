#!/bin/zsh -f
# Telegram alert every run (launchd com.ardud.battery-low-telegram: every 5 min) while the MacBook is on battery
# at 20% or less.
pmset=${POWER_PMSET:-/usr/bin/pmset}
notify=(${POWER_NOTIFY:-$HOME/.bun/bin/bun} $HOME/.local/share/telegram-bridge/src/cli.ts notify)
out=$("$pmset" -g batt) || exit 1
[[ $out == *"'Battery Power'"* ]] || exit 0  # on AC, or nothing pmset names
pct=''; [[ $out =~ '([0-9]+)%' ]] && pct=$match[1]
[[ $pct == <-> ]] || exit 0
(( pct > 20 )) && exit 0
unset BUN_INSPECT
"${notify[@]}" --source Battery --severity attention --text "MacBook battery at ${pct}%. Plug it in." \
  --key "battery-low:$(date +%Y%m%d%H%M)"
