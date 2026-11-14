#!/bin/zsh -f
set -eu
here=${0:A:h}
repo=$(git -C "$here" rev-parse --show-toplevel)
source "$repo/integrations/mac-logging/pushed.zsh"
require_pushed
for file in health_backup.sh snapshot_extra.py; do
  dst="$HOME/health-data/abdullah/backup/$file"
  if [[ ${1:-} == --dry-run ]]; then
    print "copy $here/$file -> $dst"
  elif [[ ${1:-} == --check ]]; then
    cmp "$here/$file" "$dst" || exit 1
    require_mode "$dst" 755
  elif [[ -z ${1:-} ]]; then
    mkdir -p "${dst:h}"
    [[ ! -e $dst ]] || cp -p "$dst" "$dst.bak-$(date +%Y%m%d-%H%M%S)"
    install -m 755 "$here/$file" "$dst"
  else
    exit 2
  fi
done
