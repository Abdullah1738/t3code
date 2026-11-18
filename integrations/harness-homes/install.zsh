#!/bin/zsh -f
# Install the harness-homes generator to ~/.local/share/harness-homes, build the
# homes under ~/.robob/harness-homes, and check them.
#   install.zsh            copy, generate, check
#   install.zsh --check    check only (no copy, no write)
#   install.zsh --flighty-python   prepare only the dedicated Flighty Python
#   install.zsh --inbody-python    prepare only the dedicated InBody runtime
#   install.zsh --with-agent   also (re)load com.ardud.harness-homes every 5 min
set -eu

pkg="${0:A:h}"
dst="$HOME/.local/share/harness-homes"
py="${HARNESS_HOMES_PYTHON:-/opt/homebrew/bin/python3}"
label=com.ardud.harness-homes
plist="$HOME/Library/LaunchAgents/$label.plist"

mode=install
with_agent=0
reload_flags=()
reload_helper="$pkg/../local-helpers/libexec/opencode-reload/opencode_reload.py"
[[ -f "$reload_helper" ]] || reload_helper="$HOME/.local/libexec/opencode-reload/opencode_reload.py"
for arg in "$@"; do
  case "$arg" in
    --allow-reload) reload_flags+=(--allow-reload) ;;
    --check|--dry-run|--flighty-python|--inbody-python)
      [[ $mode == install ]] || { print -u2 'choose --check, --dry-run, --flighty-python or --inbody-python'; exit 2; }
      mode="${arg#--}"
      ;;
    --with-agent) with_agent=1 ;;
    *) print -u2 "usage: install.zsh [--check | --dry-run | --flighty-python | --inbody-python] [--with-agent] [--allow-reload]"; exit 2 ;;
  esac
done

if [[ "$mode" == flighty-python || "$mode" == inbody-python ]]; then
  "$py" "$pkg/shared/${mode//-/_}.py"
  exit
fi

if [[ "$mode" == check ]]; then
  failed=0
  "$py" "$dst/generate_homes.py" check || failed=1
  "$py" "$dst/shared/check.py" || failed=1
  for server in flighty inbody; do
    shared_label="com.ardud.shared-mcp-$server"
    cmp -s "$pkg/launchd/$shared_label.plist" "$HOME/Library/LaunchAgents/$shared_label.plist" || {
      print -u2 "FAIL $shared_label plist drift"; failed=1
    }
    launchctl print "gui/$(id -u)/$shared_label" >/dev/null 2>&1 || {
      print -u2 "FAIL $shared_label is not loaded"; failed=1
    }
  done
  exit "$failed"
fi

shared_mcp_ready_secs=${SHARED_MCP_READY_SECS:-90}
if [[ "$shared_mcp_ready_secs" != <-> ]] || (( shared_mcp_ready_secs <= 0 )); then
  print -u2 "SHARED_MCP_READY_SECS must be a positive integer"
  exit 2
fi

typeset -F SECONDS
bootout_job() {
  local service=$1
  launchctl bootout "$service" 2>/dev/null || true
  local -F deadline=$(( SECONDS + 15 )) remaining
  # bootout can return before launchd releases the label.
  while (( SECONDS < deadline )) && launchctl print "$service" >/dev/null 2>&1; do
    remaining=$(( deadline - SECONDS ))
    (( remaining > 0 )) || break
    sleep $(( remaining < 0.5 ? remaining : 0.5 ))
  done
}

bootstrap_job() {
  # Callers handle failure so errexit inside a function cannot skip the EXIT trap.
  local bootstrap_status=0
  launchctl bootstrap "$@" || bootstrap_status=$?
  if (( bootstrap_status == 5 )); then
    sleep 2
    launchctl bootstrap "$@"
  else
    return "$bootstrap_status"
  fi
}

# Only scratch files may be written until all deterministic checks pass.
preflight_dir=$(mktemp -d "${TMPDIR:-/tmp}/harness-homes-preflight.XXXXXX")
trap 'rm -rf "$preflight_dir"' EXIT
[[ -r "$reload_helper" ]] || { print -u2 "missing reload helper: install local-helpers first"; exit 1; }
"$py" "$pkg/shared/install_preflight.py" "$preflight_dir/opencode.jsonc" --baseline "$preflight_dir/original.jsonc"
opencode_config=$("$py" -c 'import sys; sys.path.insert(0, sys.argv[1]); import generate_homes as g; print(g.opencode_config_path(g.load_manifest(), None))' "$pkg")
"$py" "$reload_helper" --installer harness-homes --dry-run --pair "$preflight_dir/opencode.jsonc" \
  "$opencode_config" >"$preflight_dir/reload-preview"
"$py" "$pkg/shared/flighty_python.py" --dry-run
"$py" "$pkg/shared/inbody_python.py" --dry-run
if [[ $mode == dry-run ]]; then
  cat "$preflight_dir/reload-preview"
  exit
fi
"$py" "$pkg/shared/flighty_python.py"
"$py" "$pkg/shared/inbody_python.py"

backup_dir=$(mktemp -d "${TMPDIR:-/tmp}/harness-homes-install.XXXXXX")
agents=(com.ardud.shared-mcp-flighty com.ardud.shared-mcp-inbody)
if (( with_agent )); then
  agents+=("$label")
fi
if [[ -d "$dst" ]]; then
  rsync --copy-unsafe-links -a --exclude logs "$dst/" "$backup_dir/package/"
fi
for agent in "${agents[@]}"; do
  [[ ! -f "$HOME/Library/LaunchAgents/$agent.plist" ]] || \
    cp "$HOME/Library/LaunchAgents/$agent.plist" "$backup_dir/$agent.plist"
  if launchctl print "gui/$(id -u)/$agent" >/dev/null 2>&1; then
    touch "$backup_dir/$agent.loaded"
  fi
done
install -m 0600 "$preflight_dir/original.jsonc" "$backup_dir/opencode.jsonc"

native_homes_written=0
finish_install() {
  local install_status=$?
  trap - EXIT
  if (( install_status )); then
    local recovery_failed=0
    for agent in "${agents[@]}"; do
      bootout_job "gui/$(id -u)/$agent"
    done
    if [[ -d "$backup_dir/package" ]]; then
      rsync --copy-unsafe-links -ac "$backup_dir/package/" "$dst/" || recovery_failed=1
    else
      rm -f "$dst/manifest.json" || recovery_failed=1
    fi
    # Equal bytes alone do not prove this invocation wrote them.
    if [[ -f "$preflight_dir/replaced.json" ]] && \
       ! cmp -s "$backup_dir/opencode.jsonc" "$opencode_config" && \
       cmp -s "$preflight_dir/opencode.jsonc" "$opencode_config"; then
      "$py" "$reload_helper" --installer harness-homes-rollback "${reload_flags[@]}" \
        --pair "$backup_dir/opencode.jsonc" "$opencode_config" \
        --expect-before "$preflight_dir/opencode.jsonc" "$opencode_config" \
        --owned-by "$preflight_dir/replaced.json" || recovery_failed=1
    fi
    for agent in "${agents[@]}"; do
      if [[ -f "$backup_dir/$agent.plist" ]]; then
        if ! cmp -s "$backup_dir/$agent.plist" "$HOME/Library/LaunchAgents/$agent.plist"; then
          install -m 0644 "$backup_dir/$agent.plist" "$HOME/Library/LaunchAgents/$agent.plist" || recovery_failed=1
        fi
        if [[ -f "$backup_dir/$agent.loaded" ]]; then
          bootstrap_job "gui/$(id -u)" "$HOME/Library/LaunchAgents/$agent.plist" || recovery_failed=1
        fi
      else
        rm -f "$HOME/Library/LaunchAgents/$agent.plist" || recovery_failed=1
      fi
    done
    if (( native_homes_written )) && [[ -f "$backup_dir/package/manifest.json" ]]; then
      "$py" "$dst/generate_homes.py" generate || recovery_failed=1
    fi
    print -u2 "Install failed; previous package/config/jobs restoration attempted (recovery failures: $recovery_failed). Backup: $backup_dir"
  else
    rm -rf "$backup_dir"
  fi
  rm -rf "$preflight_dir"
  exit "$install_status"
}
trap finish_install EXIT

mkdir -p "$dst/logs" "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"
rsync --copy-unsafe-links -ac --itemize-changes \
  --exclude node_modules --exclude data --exclude logs --exclude .venv --exclude venv \
  --exclude backups --exclude __pycache__ --exclude '*.bak*' --exclude '*.sqlite*' \
  --exclude '*.db' --exclude '*.db-*' --exclude '*.log' --exclude '*.pid' --exclude '*.lock' \
  --exclude tmp --exclude 'verification*' --exclude bin --exclude .gitignore --exclude README.md \
  --exclude docs --exclude tests --exclude manifest.json \
  "$pkg/" "$dst/"

# Keep the timer on the old manifest until the new endpoints answer.
for server in flighty inbody; do
  shared_label="com.ardud.shared-mcp-$server"
  shared_plist="$HOME/Library/LaunchAgents/$shared_label.plist"
  cmp -s "$pkg/launchd/$shared_label.plist" "$shared_plist" || install -m 0644 "$pkg/launchd/$shared_label.plist" "$shared_plist"
  bootout_job "gui/$(id -u)/$shared_label"
  bootstrap_job "gui/$(id -u)" "$shared_plist" || exit $?
done
ready=0
typeset -F ready_deadline=$(( SECONDS + shared_mcp_ready_secs )) ready_remaining
while (( SECONDS < ready_deadline )); do
  if last_check_output=$("$py" "$pkg/shared/check.py" 2>&1); then
    print -r -- "$last_check_output"
    ready=1
    break
  fi
  ready_remaining=$(( ready_deadline - SECONDS ))
  (( ready_remaining > 0 )) || break
  sleep $(( ready_remaining < 2 ? ready_remaining : 2 ))
done
(( ready )) || {
  print -u2 -r -- "${last_check_output:-}"
  print -u2 "Shared MCP startup failed; configs were not switched"
  for server in flighty inbody; do
    err_log="$HOME/Library/Logs/com.ardud.shared-mcp-$server.err.log"
    if [[ -r "$err_log" ]]; then
      print -u2 -r -- "Last 20 lines of $err_log:"
      tail -n 20 "$err_log" >&2
    fi
  done
  exit 1
}
if ! cmp -s "$pkg/manifest.json" "$dst/manifest.json"; then
  install -m 0644 "$pkg/manifest.json" "$dst/manifest.json.new"
  mv -f "$dst/manifest.json.new" "$dst/manifest.json"
fi
native_homes_written=1
"$py" "$dst/generate_homes.py" generate --opencode-config "$preflight_dir/opencode.jsonc"
"$py" "$dst/generate_homes.py" check --opencode-config "$preflight_dir/opencode.jsonc"

if (( with_agent )); then
  cmp -s "$pkg/launchd/$label.plist" "$plist" || install -m 0644 "$pkg/launchd/$label.plist" "$plist"
  bootout_job "gui/$(id -u)/$label"
  bootstrap_job "gui/$(id -u)" "$plist" || exit $?
  print "loaded $label"
fi

# The only watched write comes after validation and service startup have passed.
# A concurrent config edit invalidates the staged migration; never restore over it.
cmp -s "$backup_dir/opencode.jsonc" "$opencode_config" || {
  print -u2 "OpenCode config changed during installation; rerun to preserve that edit"
  exit 1
}
"$py" "$reload_helper" --installer harness-homes "${reload_flags[@]}" \
  --pair "$preflight_dir/opencode.jsonc" "$opencode_config" \
  --expect-before "$preflight_dir/original.jsonc" "$opencode_config" --receipt "$preflight_dir/replaced.json"
