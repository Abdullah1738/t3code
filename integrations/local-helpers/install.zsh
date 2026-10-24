#!/bin/zsh -f
# Install the local helpers from this repo onto the Mac, or check that the Mac matches it.
#
#   install.zsh [--dry-run]         copy changed files, keep a .bak of each replaced file, reload agents, smoke test
#   install.zsh --check             exit 1 if a live file, mode, link or agent differs from this tree, or HEAD is not on origin
#   install.zsh --allow-unpushed    install (or check) uncommitted or unpushed changes (testing only)
#
# Commit and push first: the live copy must always be a commit on origin/main.
set -eu

here="${0:A:h}"
repo="$(git -C "$here" rev-parse --show-toplevel)"
prefix="${here#$repo/}"
lctl="${LOCAL_HELPERS_LAUNCHCTL:-launchctl}"
domain="gui/$(id -u)"
stamp="$(date +%Y%m%d-%H%M%S)"
state_dir="$HOME/.local/state/local-helpers"
# Set before new mail code lands, cleared once otp-idle runs it: a failed run leaves the restart pending.
pending="$state_dir/restart-otp-idle"
# Same for plists: reload-<label> is set before a new plist lands and cleared once launchd has loaded it,
# so a run that dies between the copy and the reload leaves the reload for the next run. It holds
# "bak:<path>" (the backup of the plist launchd ran when it was set) or "new" (there was no plist), so
# whichever run does the reload knows what to fall back to.
reload_mark() { print -r -- "$state_dir/reload-${${1:t}%.plist}" }
# REPLY = the marker's backup ('' for "new"). Fails for a marker that doesn't say (empty, cut short, or its
# backup is gone): then nobody knows which plist launchd runs.
read_mark() {
  local v=''
  REPLY=''
  [[ -r "$1" ]] && v="$(<"$1")"
  case "$v" in
    new) return 0 ;;
    bak:/*) REPLY=${v#bak:} ;;
    *) return 1 ;;
  esac
  [[ -e "$REPLY" ]]
}
# One install at a time per HOME: a marker is only right if nobody copies or reloads between this run's copy
# and its reload. The lock goes with the process, so a killed run never leaves it behind.
zmodload zsh/system
lockfile="$state_dir/install.lock"
lock_wait="${LOCAL_HELPERS_LOCK_WAIT:-300}"
take_lock() {
  local how=${1:-}
  [[ -z $how && ! -w "$lockfile" ]] && { print -u2 "local-helpers: can't write $lockfile"; exit 1 }
  zsystem flock $how -t 0 -f lockfd "$lockfile" 2>/dev/null && return 0
  print -u2 "local-helpers: waiting for another install.zsh to finish"
  zsystem flock $how -t "$lock_wait" -f lockfd "$lockfile" 2>/dev/null && return 0
  print -u2 "local-helpers: another install.zsh is still running after ${lock_wait}s; try again later"
  exit 1
}

# repo dir -> live dir. Only files git knows about: keys, tokens, caches and state stay on the live side.
typeset -A live=(
  libexec/mail "$HOME/.local/libexec/mail"
  libexec/card-preview "$HOME/.local/libexec/card-preview"
  libexec/qcard "$HOME/.local/libexec/qcard"
  bin "$HOME/.local/bin"
  launchd "$HOME/Library/LaunchAgents"
)
# Modes git can't keep: the keychain helpers and the OTP watcher stay private.
typeset -A private=(kc-read 1 kc-write 1 otp-watch.py 1)
# ~/.local/bin entries that point into other deployed integrations.
links=(
  "$HOME/.local/bin/wa:$HOME/.local/share/robob-watch/helpers/wa"
  "$HOME/.local/bin/mailsend:$HOME/.local/share/robob-watch/helpers/mailsend"
)
# Watchers run with a short PATH and the Uber CLI is a node script under nvm (22 Oct: the ride watcher lost it),
# so ~/.local/bin/uber is a wrapper that pins node and the CLI of the newest nvm install that has it.
uber="$HOME/.local/bin/uber"
uber_mark="# local-helpers uber wrapper"

mode=install
dry=0
allow=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --check) mode=check ;;
    --allow-unpushed) allow=1 ;;
    *) print -u2 "usage: install.zsh [--dry-run | --check] [--allow-unpushed]"; exit 2 ;;
  esac
done

pushed() {
  local dirty head remote
  dirty="$(git -C "$repo" status --porcelain -- "$prefix")"
  [[ -z "$dirty" ]] || { print -u2 "local-helpers: uncommitted changes under $prefix:"; print -u2 -r -- "$dirty"; return 1 }
  head="$(git -C "$repo" rev-parse HEAD)"
  remote="$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)"
  [[ -n "$remote" ]] || { print -u2 "local-helpers: cannot read origin/main"; return 1 }
  if [[ "$head" != "$remote" ]] && ! git -C "$repo" merge-base --is-ancestor HEAD "$remote" 2>/dev/null; then
    print -u2 "local-helpers: HEAD $head is not on origin/main; push first (git push origin HEAD:main)"
    return 1
  fi
}

# Payload as "src:dst:mode": files git tracks (or would track) directly in each mapped dir.
pairs=()
for rel in "${(@f)$(git -C "$here" ls-files --cached --others --exclude-standard -- ${(k)live})}"; do
  [[ -n "$rel" && -f "$here/$rel" && -n "${live[${rel:h}]:-}" ]] || continue
  [[ "${rel:t}" == *.bak* || "${rel:t}" == *.pyc ]] && continue
  if (( ${+private[${rel:t}]} )); then m=700; elif [[ -x "$here/$rel" ]]; then m=755; else m=644; fi
  pairs+=("$here/$rel:${live[${rel:h}]}/${rel:t}:$m")
done
(( ${#pairs} )) || { print -u2 "local-helpers: no payload files found"; exit 1 }
plists=()
for p in "${pairs[@]}"; do [[ "${${p%:*}#*:}" == *.plist ]] && plists+=("${${p%:*}#*:}"); done

perm_of() { stat -f %Lp "$1" 2>/dev/null || true; }
same() { [[ ! -L "$2" ]] && cmp -s "$1" "$2"; }
loaded() { "$lctl" print "$domain/$1" >/dev/null 2>&1; }
label_of() { print -r -- "${${1:t}%.plist}"; }

uber_node='' uber_js=''
for n in "$HOME"/.nvm/versions/node/*(N/nOn); do
  if [[ -x "$n/bin/node" && -f "$n/lib/node_modules/@crafter/uber-cli/bin/uber.js" ]]; then
    uber_node="$n/bin/node" uber_js="$n/lib/node_modules/@crafter/uber-cli/bin/uber.js"
    break
  fi
done
uber_want=''
[[ -n "$uber_node" ]] && uber_want="#!/bin/sh
$uber_mark: watchers run with a short PATH, so node is pinned here.
exec \"$uber_node\" \"$uber_js\" \"\$@\""
uber_ours() { [[ -f "$uber" && ! -L "$uber" ]] && [[ "$(sed -n 2p "$uber")" == "$uber_mark"* ]]; }

# Installs hold the lock to the end; --check and --dry-run only wait for a running install (and write nothing).
if [[ $mode == check ]] || (( dry )); then
  [[ -e "$lockfile" ]] && take_lock -r
else
  mkdir -p "$state_dir"
  [[ -e "$lockfile" ]] || : > "$lockfile"
  take_lock
fi

if [[ $mode == check ]]; then
  rc=0
  (( allow )) || pushed || rc=1
  for p in "${pairs[@]}"; do
    src="${p%%:*}" rest="${p#*:}"; dst="${rest%:*}" want="${rest##*:}"
    if ! same "$src" "$dst"; then print -u2 "local-helpers: $dst differs"; rc=1
    elif [[ "$(perm_of "$dst")" != "$want" ]]; then print -u2 "local-helpers: $dst mode $(perm_of "$dst"), want $want"; rc=1; fi
  done
  for l in "${links[@]}"; do
    ln_path="${l%%:*}" target="${l#*:}"
    if [[ ! -x "$target" ]]; then print -u2 "local-helpers: $target is missing; deploy that integration first"; rc=1
    elif [[ "$(readlink "$ln_path" 2>/dev/null)" != "$target" ]]; then print -u2 "local-helpers: $ln_path is not a link to $target"; rc=1; fi
  done
  if [[ -z "$uber_want" ]]; then print -u2 "local-helpers: no Uber CLI under ~/.nvm (npm i -g @crafter/uber-cli)"; rc=1
  elif [[ ! -f "$uber" || -L "$uber" || "$(<"$uber")" != "$uber_want" ]]; then print -u2 "local-helpers: $uber is not the current wrapper"; rc=1
  elif [[ "$(perm_of "$uber")" != 755 ]]; then print -u2 "local-helpers: $uber mode $(perm_of "$uber"), want 755"; rc=1; fi
  for f in "${plists[@]}"; do
    loaded "$(label_of "$f")" || { print -u2 "local-helpers: $(label_of "$f") is not loaded"; rc=1 }
    [[ -e "$(reload_mark "$f")" ]] && { print -u2 "local-helpers: $(label_of "$f") still runs an older plist (reload pending); run install.zsh"; rc=1 }
  done
  [[ -e "$pending" ]] && { print -u2 "local-helpers: local.ardud.otp-idle still runs older mail code (restart pending); run install.zsh"; rc=1 }
  (( rc == 0 )) && print "local-helpers: live copy matches $(git -C "$repo" rev-parse --short HEAD)"
  exit $rc
fi

if (( ! allow )) && ! pushed; then
  print -u2 "local-helpers: refusing to install. Commit and push, or pass --allow-unpushed for a test install."
  exit 1
fi

# Keep the known-good copy (a link stays a link) under a name no earlier backup has: a pending reload may
# still need an older one, and two runs can start in the same second. REPLY is the backup ('' if none).
# Runs under the install lock, so nobody else picks names meanwhile.
backup() {
  local dst=$1 b="$1.bak-$stamp" n=1
  REPLY=''
  [[ -e "$dst" || -L "$dst" ]] || return 0
  while [[ -e "$b" || -L "$b" ]]; do b="$dst.bak-$stamp-$(( n++ ))"; done
  cp -pP "$dst" "$b" && REPLY=$b
}
# Copy and rename so a reader never sees half a file.
land() {
  local src=$1 dst=$2 want=$3
  cp "$src" "$dst.tmp-$$"
  chmod "$want" "$dst.tmp-$$"
  mv -f "$dst.tmp-$$" "$dst"
}
put() { mkdir -p "${2:h}"; backup "$2" && land "$@" }

changed=()
for p in "${pairs[@]}"; do
  src="${p%%:*}" rest="${p#*:}"; dst="${rest%:*}" want="${rest##*:}"
  if same "$src" "$dst"; then
    [[ "$(perm_of "$dst")" == "$want" ]] && continue
    print "chmod $want $dst"
    (( dry )) || chmod "$want" "$dst"
    continue
  fi
  print "update $dst"
  changed+=("$dst")
  (( dry )) && continue
  case "$dst" in
    */libexec/mail/mail_oauth.py|*/libexec/mail/otp-idle.py|*/libexec/mail/otp-watch.py) mkdir -p "$state_dir"; : > "$pending" ;;
    */LaunchAgents/*.plist)
      mkdir -p "$state_dir" "${dst:h}"
      backup "$dst" || exit 1
      mark="$(reload_mark "$dst")"
      # A marker left by a run that died stays as it is: its backup is the plist launchd still runs.
      if [[ ! -e "$mark" ]]; then
        if [[ -n "$REPLY" ]]; then print -r -- "bak:$REPLY"; else print new; fi > "$mark.tmp-$$"
        mv -f "$mark.tmp-$$" "$mark"
      fi
      land "$src" "$dst" "$want"
      continue ;;
  esac
  put "$src" "$dst" "$want"
done
for l in "${links[@]}"; do
  ln_path="${l%%:*}" target="${l#*:}"
  if [[ ! -x "$target" ]]; then print -u2 "local-helpers: warning: $target is missing, not linking ${ln_path:t} (deploy it first)"; continue; fi
  [[ "$(readlink "$ln_path" 2>/dev/null)" == "$target" ]] && continue
  if [[ -e "$ln_path" && ! -L "$ln_path" ]]; then
    print -u2 "local-helpers: $ln_path is a real file, not replacing it with a link"
    continue
  fi
  print "link $ln_path -> $target"
  (( dry )) || { mkdir -p "${ln_path:h}"; ln -sfn "$target" "$ln_path" }
done
if [[ -z "$uber_want" ]]; then
  print -u2 "local-helpers: warning: no Uber CLI under ~/.nvm, ride watchers fall back to PATH"
elif [[ -f "$uber" && ! -L "$uber" ]] && ! uber_ours; then
  print -u2 "local-helpers: $uber is someone else's file, not replacing it"
elif [[ ! -f "$uber" || -L "$uber" || "$(<"$uber")" != "$uber_want" ]]; then
  print "wrap $uber -> $uber_js"
  if (( ! dry )); then
    mkdir -p "$state_dir"
    print -r -- "$uber_want" > "$state_dir/uber.new"
    put "$state_dir/uber.new" "$uber" 755
    rm -f "$state_dir/uber.new"
  fi
elif [[ "$(perm_of "$uber")" != 755 ]]; then
  print "chmod 755 $uber"
  (( dry )) || chmod 755 "$uber"
fi
(( dry )) && exit 0

# Agents. Log dirs first: launchd won't create them and the job dies without them.
for f in "${plists[@]}"; do
  for key in StandardOutPath StandardErrorPath; do
    log="$(plutil -extract "$key" raw "$f" 2>/dev/null)" && mkdir -p "${log:h}"
  done
done
agent_fail=0
up() { "$lctl" bootstrap "$domain" "$1" 2>/dev/null || { sleep 1; "$lctl" bootstrap "$domain" "$1" } }
# A plist with a reload pending (changed now or by a run that died) is reloaded; if the new one won't load,
# the backup named in its marker (the plist launchd ran before) goes back in and loads instead.
for f in "${plists[@]}"; do
  mark="$(reload_mark "$f")"
  [[ -e "$mark" ]] || continue
  label="$(label_of "$f")"
  if read_mark "$mark"; then
    bak=$REPLY
  elif loaded "$label"; then
    # Unloading it would leave nothing to fall back to, so the running job stays.
    agent_fail=1
    print -u2 "local-helpers: $label: $mark doesn't say which plist launchd runs, so the job is left running."
    print -u2 "  Once $f is right, reload it by hand ($lctl bootout $domain/$label; $lctl bootstrap $domain $f) and delete the marker."
    continue
  else
    bak=''
  fi
  "$lctl" bootout "$domain/$label" >/dev/null 2>&1 || true
  if up "$f"; then
    rm -f "$mark"
    print "reloaded $label"
    [[ $label == local.ardud.otp-idle ]] && rm -f "$pending"
    continue
  fi
  agent_fail=1
  if [[ -n "$bak" && -e "$bak" ]]; then
    cp -p "$bak" "$f"
    # Disk and launchd agree on the old plist again; the next run sees the difference and retries.
    up "$f" && { rm -f "$mark"; print -u2 "local-helpers: $label: the new plist didn't load, the previous one is back" }
  fi
  print -u2 "local-helpers: $label failed to load; fix it and run install.zsh again"
done
# Every run: load any managed agent that isn't loaded (a failed earlier run, a manual bootout).
for f in "${plists[@]}"; do
  label="$(label_of "$f")"
  loaded "$label" && continue
  if up "$f"; then
    rm -f "$(reload_mark "$f")"
    print "loaded $label"
    [[ $label == local.ardud.otp-idle ]] && rm -f "$pending"
  else
    agent_fail=1; print -u2 "local-helpers: $label is not loaded and failed to load"
  fi
done
# otp-idle stays running, so new mail code needs a restart; otp-watch and mail-token-refresh are short runs.
if [[ -e "$pending" ]] && loaded local.ardud.otp-idle; then
  if "$lctl" kickstart -k "$domain/local.ardud.otp-idle"; then
    rm -f "$pending"; print "restarted local.ardud.otp-idle"
  else
    agent_fail=1; print -u2 "local-helpers: otp-idle restart failed; it stays pending for the next run"
  fi
fi

# Smoke test the installed copy (offline: parses, imports, plist lint, a qcard sample, the uber wrapper).
fail=0
smoke() { "$@" >/dev/null 2>&1 || { print -u2 "local-helpers: smoke failed: $*"; fail=1 } }
lib="$HOME/.local/libexec"
py=()
for p in "${pairs[@]}"; do
  dst="${${p%:*}#*:}"
  [[ "$dst" == *.py || "$(head -c 40 "$dst" 2>/dev/null)" == '#!/usr/bin/python3'* ]] && py+=("$dst")
done
smoke /usr/bin/python3 -c 'import ast, sys
for f in sys.argv[1:]:
    ast.parse(open(f, encoding="utf-8").read(), f)' "${py[@]}"
smoke env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -c "import sys; sys.path[:0] = ['$lib/mail', '$lib/card-preview', '$lib/qcard']; import mail_oauth, cardpreview, render, data"
smoke env PYTHONDONTWRITEBYTECODE=1 "$HOME/.local/bin/qcard" templates
for f in "${plists[@]}"; do smoke plutil -lint "$f"; done
smoke sh -n "$HOME/.local/bin/himalaya-heal"
# The way the watchers run it: bare PATH, no nvm.
uber_ours && smoke env -i HOME="$HOME" PATH=/usr/bin:/bin /usr/bin/perl -e 'alarm 20; exec @ARGV or die "exec failed: $!\n"' "$uber" --version
(( fail )) && { print -u2 "local-helpers: installed, but the smoke test failed; the previous files are kept as *.bak-$stamp*"; exit 1 }
(( agent_fail )) && { print -u2 "local-helpers: installed, but a LaunchAgent didn't load (see above); run install.zsh again after fixing it"; exit 1 }
print "local-helpers: installed $(git -C "$repo" rev-parse --short HEAD) (${#changed} files changed)"
