#!/bin/zsh -f
# Sync one integration from this repo to its live copy under ~/.local/share.
# Source files only: runtime state, data and credentials on the live side are
# excluded and never deleted.
set -eu

name="${1:-}"
shift || true
case "$name" in
  agent-bridges|spectrum-bridge|telegram-bridge|robob-watch|memory-system|coord|app-api-cli|stream-recovery|catalog-guard|message-archive) ;;
  ovnfs-recovery) exec "${0:A:h}/ovnfs-recovery/install.zsh" "$@" ;;
  offbox) exec "${0:A:h}/offbox/install.zsh" "$@" ;;  # several live targets, see offbox/README.md
  local-helpers) exec "${0:A:h}/local-helpers/install.zsh" "$@" ;;  # files under ~/.local, see local-helpers/README.md
  harness-homes) exec "${0:A:h}/harness-homes/install.zsh" "$@" ;;  # Robob's Claude/Codex homes, see harness-homes/README.md
  harness-cli) exec "${0:A:h}/harness-cli/install.zsh" "$@" ;;  # pinned Claude/Codex CLIs + daily job, see harness-cli/README.md
  tail-gateway) exec "${0:A:h}/tail-gateway/install.zsh" "$@" ;;  # https://<name>.tail gateway, see tail-gateway/README.md
  robob-widgets) exec "${0:A:h}/robob-widgets/install.zsh" "$@" ;;
  harness-hooks) exec "${0:A:h}/harness-hooks/install.zsh" "$@" ;;
  *) print -u2 "usage: deploy.zsh <agent-bridges|spectrum-bridge|telegram-bridge|robob-watch|memory-system|coord|app-api-cli|stream-recovery|catalog-guard|message-archive|offbox|local-helpers|harness-homes|harness-cli|tail-gateway|robob-widgets|harness-hooks|ovnfs-recovery> [--dry-run]"; exit 2 ;;
esac

src="${0:A:h}/$name/"
dst="$HOME/.local/share/$name/"
flags=(-a --itemize-changes)
if [[ "${1:-}" == "--dry-run" ]]; then
  flags+=(--dry-run)
fi

rsync "${flags[@]}" \
  --exclude node_modules --exclude data --exclude logs --exclude .venv --exclude venv \
  --exclude backups --exclude __pycache__ --exclude '*.bak*' --exclude '*.sqlite*' \
  --exclude '*.db' --exclude '*.db-*' --exclude '*.log' --exclude '*.pid' --exclude '*.lock' \
  --exclude '*.sock' --exclude archive --exclude watchers --exclude HANDOFF.md --exclude tmp \
  --exclude 'verification*' --exclude bin --exclude .gitignore --exclude README.md --exclude docs \
  "$src" "$dst"

if [[ "$name" == memory-system ]]; then
  export_plist="com.abdullah.opencode-readonly.plist"
  export_src="${src}scripts/$export_plist"
  export_dst="$HOME/Library/LaunchAgents/$export_plist"
  if ! cmp -s "$export_src" "$export_dst"; then
    print "memory-system: $export_dst missing or differs from scripts/$export_plist"
  fi
  if [[ "${1:-}" == "--dry-run" ]]; then
    print "memory-system: would install -m 644 $export_src $export_dst (bootstrap separately)"
  else
    mkdir -p "${export_dst:h}" "${dst}logs"
    install -m 644 "$export_src" "$export_dst"
    print "memory-system: installed $export_dst; bootstrap/reload requires a separate launchctl command"
  fi
  recall_src="${src}scripts/recall"
  recall_dst="$HOME/.local/bin/recall"
  if [[ -e "$recall_dst" ]] && ! cmp -s "$recall_src" "$recall_dst"; then
    print "memory-system: ~/.local/bin/recall differs from scripts/recall"
  fi
  if [[ "${1:-}" == "--dry-run" ]]; then
    print "memory-system: would install -m 755 $recall_src $recall_dst"
  else
    mkdir -p "${recall_dst:h}"
    install -m 755 "$recall_src" "$recall_dst"
  fi
  /bin/bash "${src}scripts/install_launchagent.sh" "$@"
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  print -r -- "dry run: $name"
else
  print -r -- "deployed $name to $dst"
fi
