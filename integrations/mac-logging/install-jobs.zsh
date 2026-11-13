#!/bin/zsh -f
# Targeted updates: do not deploy unrelated memory/watch/skill changes with these jobs.
set -eu
here=${0:A:h}
repo=$(git -C "$here" rev-parse --show-toplevel)
source "$here/pushed.zsh"
require_pushed
for pair in \
  "integrations/memory-system/scripts/memory_backup.sh:$HOME/.local/share/memory-system/scripts/memory_backup.sh" \
  "integrations/memory-system/src/backup_control.py:$HOME/.local/share/memory-system/src/backup_control.py" \
  "integrations/memory-system/src/redact_lock.py:$HOME/.local/share/memory-system/src/redact_lock.py" \
  "integrations/robob-watch/watchers/disk-space-guard/check.sh:$HOME/.local/share/robob-watch/watchers/disk-space-guard/check.sh" \
  "integrations/dev-resource-janitor/skill/scripts/dev_janitor.py:$HOME/.config/opencode/skills/dev-resource-janitor/scripts/dev_janitor.py" \
  "integrations/dev-resource-janitor/skill/scripts/janitor_watch.py:$HOME/.config/opencode/skills/dev-resource-janitor/scripts/janitor_watch.py"; do
  src="$repo/${pair%%:*}"
  dst="${pair#*:}"
  perm=755
  [[ $src != */backup_control.py && $src != */redact_lock.py ]] || perm=644
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
