rg -l 'usdtwallet|ethHolds|ETH_HOLD_TEXT' /Users/ardud/.robob/harness-homes/codex/skills --glob '*.md' --glob '!**/node_modules/**' | head -15
rg --files /Users/ardud/.local/share/robob-watch -g '*.json' -g '*.md' -g '!node_modules/**' -g '!**/node_modules/**' -g '!**/statev2.sqlite*' -g '!**/opencode.db*' | head -15
tail -4 tmp/card-app-reorg-rebase/full-launch.log