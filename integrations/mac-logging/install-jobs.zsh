#!/bin/zsh -f
# Recall deploys memory-system from robob/recall-golive; send changes there as port requests.
# This installer must never write under ~/.local/share/memory-system.
set -eu
here=${0:A:h}
repo=$(git -C "$here" rev-parse --show-toplevel)
source "$here/pushed.zsh"
require_pushed
for pair in \
  "integrations/robob-watch/watchers/disk-space-guard/check.sh:$HOME/.local/share/robob-watch/watchers/disk-space-guard/check.sh" \
  "integrations/dev-resource-janitor/skill/scripts/dev_janitor.py:$HOME/.config/opencode/skills/dev-resource-janitor/scripts/dev_janitor.py" \
  "integrations/dev-resource-janitor/skill/scripts/janitor_watch.py:$HOME/.config/opencode/skills/dev-resource-janitor/scripts/janitor_watch.py"; do
  src="$repo/${pair%%:*}"
  dst="${pair#*:}"
  if [[ $dst == "$HOME/.local/share/memory-system" || $dst == "$HOME/.local/share/memory-system/"* ]]; then
    print -u2 "mac: refusing memory-system target: $dst"
    exit 2
  fi
  perm=755
  if [[ ${1:-} == --dry-run ]]; then
    print "$src -> $dst"
  elif [[ ${1:-} == --check ]]; then
    cmp "$src" "$dst" || exit 1
    require_mode "$dst" "$perm"
  elif [[ -z ${1:-} ]]; then
    mkdir -p "${dst:h}"
    [[ ! -e $dst ]] || cp -p "$dst" "$dst.bak-$(date +%Y%m%d-%H%M%S)"
    install -m "$perm" "$src" "$dst"
  else
    exit 2
  fi
done
