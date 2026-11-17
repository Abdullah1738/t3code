#!/bin/zsh -f
# Sync one integration from this repo to its live copy under ~/.local/share.
# Source files only: runtime state, data and credentials on the live side are
# excluded and never deleted.
set -eu

name="${1:-}"
shift || true
case "$name" in
  router-logging|agent-bridges|spectrum-bridge|telegram-bridge|robob-watch|memory-system|coord|app-api-cli|stream-recovery|catalog-guard|robob-guard|message-archive) ;;
  9router-reauth) exec /usr/bin/python3 "${0:A:h}/robob-watch/checks/9router-claude-reauth/install.py" "$@" ;;
  offbox) exec "${0:A:h}/offbox/install.zsh" "$@" ;;  # several live targets, see offbox/README.md
  local-helpers) exec "${0:A:h}/local-helpers/install.zsh" "$@" ;;  # files under ~/.local, see local-helpers/README.md
  harness-homes) exec "${0:A:h}/harness-homes/install.zsh" "$@" ;;  # Robob's Claude/Codex homes, see harness-homes/README.md
  harness-cli) exec "${0:A:h}/harness-cli/install.zsh" "$@" ;;  # pinned Claude/Codex CLIs + daily job, see harness-cli/README.md
  tail-gateway) exec "${0:A:h}/tail-gateway/install.zsh" "$@" ;;  # https://<name>.tail gateway, see tail-gateway/README.md
  robob-widgets) exec "${0:A:h}/robob-widgets/install.zsh" "$@" ;;
  harness-hooks) exec "${0:A:h}/harness-hooks/install.zsh" "$@" ;;
  venice-x402) exec "${0:A:h}/venice-x402/install.zsh" "$@" ;;  # x402 Venice proxy + LaunchAgent, see venice-x402/README.md
  *) print -u2 "usage: deploy.zsh <9router-reauth|router-logging|agent-bridges|spectrum-bridge|telegram-bridge|robob-watch|memory-system|coord|app-api-cli|stream-recovery|catalog-guard|robob-guard|message-archive|offbox|local-helpers|harness-homes|harness-cli|tail-gateway|robob-widgets|harness-hooks|venice-x402> [--dry-run] [--no-fence]"; exit 2 ;;
esac

if [[ "$name" == memory-system ]]; then
  no_fence=0
  deploy_args=()
  for arg in "$@"; do
    if [[ "$arg" == --no-fence ]]; then
      no_fence=1
    else
      deploy_args+=("$arg")
    fi
  done
  set -- "${deploy_args[@]}"
  # A pre-fence tree would roll live recall back to stale memory-system code.
  if [[ "${1:-}" != --dry-run ]] && ! grep -qF "sys.argv[1] == 'fence'" "${0:A:h}/memory-system/src/backup_control.py"; then
    print -u2 "memory-system: this tree's backup_control.py has no backup fence; memory-system deploys come from an export of robob/recall-golive"
    exit 2
  fi
  if (( no_fence )); then
    print -u2 "WARNING: memory-system deploy is bypassing the backup fence (--no-fence)"
  elif [[ "${1:-}" != --dry-run && "${MEMORY_DEPLOY_FENCED:-}" != 1 ]]; then
    # Backups load Python between steps; hold their fence across every install.
    export MEMORY_DEPLOY_FENCED=1
    exec python3 "${0:A:h}/memory-system/src/backup_control.py" fence \
      "$HOME/.local/share/memory-system/logs/backup.lock" --reason deploy -- zsh -f "$0" "$name" "$@"
  fi
fi

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

if [[ "$name" == app-api-cli && "${1:-}" != --dry-run ]]; then
  "$HOME/.local/share/uv/tools/mitmproxy/bin/python" "$dst/order_tracker.py" configure-problem-checks
fi

if [[ "$name" == robob-watch ]]; then
  # Watcher directories also contain private state: sync only this source allowlist.
  rsync "${flags[@]}" --relative \
    "$src"./watchers/meds-nag/check.py \
    "$src"./watchers/meds-nag/took.py \
    "$src"./watchers/forge-workouts/check.py \
    "$src"./watchers/gym-nudge/check.py \
    "$src"./watchers/activity-digest/check.sh \
    "$src"./watchers/activity-digest/summarize.py \
    "$dst"
fi

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

if [[ "$name" == robob-guard ]]; then
  if [[ "${1:-}" == "--dry-run" ]]; then
    print "robob-guard: would copy bin/robob-install-hold, symlink ~/.local/bin/robob-install-hold and install LaunchAgent (not load it)"
  else
    mkdir -p "$dst/bin" "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$HOME/.local/state/robob-guard"
    install -m 755 "${src}bin/robob-install-hold" "${dst}bin/robob-install-hold"
    ln -sfn "${dst}bin/robob-install-hold" "$HOME/.local/bin/robob-install-hold"
    install -m 644 "${src}scripts/com.ardud.robob-guard.plist" "$HOME/Library/LaunchAgents/com.ardud.robob-guard.plist"
  fi
fi

if [[ "${1:-}" == "--dry-run" ]]; then
  print -r -- "dry run: $name"
else
  "$HOME/.bun/bin/bun" "${0:A:h}/robob-watch/src/cli.ts" log-marker --service "$name" --sha "$(git -C "${0:A:h}" rev-parse HEAD 2>/dev/null)" --step deploy.complete >/dev/null 2>&1 || true
  print -r -- "deployed $name to $dst"
fi
