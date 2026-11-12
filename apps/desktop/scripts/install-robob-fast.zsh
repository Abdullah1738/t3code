#!/bin/zsh -f
# Usage: zsh install-robob-fast.zsh --dmg /absolute/build.dmg
# --dry-run prints the plan; --rollback restores the previous bundle only.
set -euo pipefail
unset BUN_INSPECT
SCRIPT=${0:A}
if (( ${argv[(Ie)--dry-run]} )); then
  exec node "${SCRIPT:h}/install-robob-fast.mjs" "$@"
fi
if [[ -z ${TMUX:-} ]]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  log=$HOME/.robob/install-$stamp.ndjson
  launch="zsh ${(q)SCRIPT} ${(j: :)${(q)@}} >> ${(q)log} 2>&1"
  tmux -L robob-install new-session -d -s "install-$stamp" "$launch"
  /Users/ardud/.bun/bin/bun /Users/ardud/.local/share/telegram-bridge/src/cli.ts notify \
    --source 'Robob install' --severity attention --key "robob-install:$stamp:start" \
    --text "Install starts after preflight and a 10 s cancel window. Watch: tmux -L robob-install attach -t install-$stamp ; tail -f $log" || true
  print -r -- "tmux -L robob-install attach -t install-$stamp"
  print -r -- "tail -f $log"
  exit 0
fi
exec node "${SCRIPT:h}/install-robob-fast.mjs" "$@"
