#!/bin/zsh -f
# Install the .tail gateway from this repo onto the Mac, or check that the Mac matches it.
#
#   install.zsh [--dry-run]        copy scripts, Corefile and LaunchAgents, link tailname, reload changed agents
#   install.zsh --check            exit 1 if the live copy differs from this tree or HEAD is not on origin
#   install.zsh --allow-unpushed   install even with uncommitted or unpushed changes (testing only)
#
# Live state that never comes from the repo: the CA (ca/root.key stays mode 600 and never leaves this Mac),
# the gateway node's Tailscale state (ts-state/), Caddy's issued certs (caddy-data/), the tailscaled binaries,
# logs, and the routes (~/.config/tail-gateway/routes.json).
set -eu

here="${0:A:h}"
repo="$(git -C "$here" rev-parse --show-toplevel)"
prefix="${here#$repo/}"
live="${TAIL_GATEWAY_HOME:-$HOME/.local/share/tail-gateway}"
agents="$HOME/Library/LaunchAgents"
link="$HOME/.local/bin/tailname"
lctl="${TAIL_GATEWAY_LAUNCHCTL:-launchctl}"
domain="gui/$(id -u)"
labels=(com.ardud.tail-gateway-node com.ardud.tail-gateway-dns com.ardud.tail-gateway-proxy)

mode=install
dry=0
allow=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --check) mode=check ;;
    --allow-unpushed) allow=1 ;;
    *) print -u2 "usage: install.zsh [--dry-run | --check | --allow-unpushed]"; exit 2 ;;
  esac
done

pushed() {
  local dirty head remote
  dirty="$(git -C "$repo" status --porcelain -- "$prefix" | grep -v '__pycache__' || true)"
  [[ -z "$dirty" ]] || { print -u2 "tail-gateway: uncommitted changes under $prefix:"; print -u2 -r -- "$dirty"; return 1 }
  head="$(git -C "$repo" rev-parse HEAD)"
  remote="$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)"
  [[ -n "$remote" ]] || { print -u2 "tail-gateway: cannot read origin/main"; return 1 }
  if [[ "$head" != "$remote" ]] && ! git -C "$repo" merge-base --is-ancestor HEAD "$remote" 2>/dev/null; then
    print -u2 "tail-gateway: HEAD $head is not on origin/main; push first (git push origin HEAD:main)"
    return 1
  fi
}

# repo file -> live file
typeset -A files=(
  bin/tailname "$live/bin/tailname"
  bin/tail-gateway-site "$live/bin/tail-gateway-site"
  bin/tail-gateway-run "$live/bin/tail-gateway-run"
  dns/Corefile "$live/Corefile"
)
for l in $labels; do files[launchd/$l.plist]="$agents/$l.plist"; done

if [[ $mode == check ]]; then
  rc=0
  pushed || rc=1
  for src dst in ${(kv)files}; do
    cmp -s "$here/$src" "$dst" || { print -u2 "tail-gateway: $dst differs from $src"; rc=1 }
  done
  [[ "$(readlink "$link" 2>/dev/null)" == "$live/bin/tailname" ]] || { print -u2 "tail-gateway: $link is not a link to $live/bin/tailname"; rc=1 }
  [[ "$(stat -f %Lp "$live/ca/root.key" 2>/dev/null)" == 600 ]] || { print -u2 "tail-gateway: $live/ca/root.key missing or not mode 600"; rc=1 }
  for l in $labels; do
    $lctl print "$domain/$l" >/dev/null 2>&1 || { print -u2 "tail-gateway: $l is not loaded"; rc=1 }
  done
  (( rc == 0 )) && print "tail-gateway: live copy matches $(git -C "$repo" rev-parse --short HEAD) and it is on origin"
  exit $rc
fi

if (( allow )); then
  pushed 2>/dev/null || print -u2 "tail-gateway: WARNING installing work that is not on origin/main (--allow-unpushed)"
else
  pushed
fi
[[ -f "$live/ca/root.crt" && -f "$live/ca/root.key" ]] || { print -u2 "tail-gateway: no CA in $live/ca (see README: first-time setup)"; exit 1 }
[[ -x "$live/tailscaled" && -x "$live/tailscale" ]] || { print -u2 "tail-gateway: no tailscaled/tailscale in $live (see README)"; exit 1 }

stamp="$(date +%Y%m%d-%H%M%S)"
changed=()
for src dst in ${(kv)files}; do
  cmp -s "$here/$src" "$dst" && continue
  print "update $dst"
  (( dry )) && continue
  mkdir -p "${dst:h}"
  [[ -e "$dst" ]] && cp -p "$dst" "$dst.bak-$stamp"
  cp "$here/$src" "$dst.tmp.$$"
  case "$src" in bin/*) chmod 755 "$dst.tmp.$$" ;; *) chmod 644 "$dst.tmp.$$" ;; esac
  mv "$dst.tmp.$$" "$dst"
  changed+=("$src")
done
if [[ "$(readlink "$link" 2>/dev/null)" != "$live/bin/tailname" ]]; then
  print "link $link -> $live/bin/tailname"
  (( dry )) || { mkdir -p "${link:h}"; ln -sfn "$live/bin/tailname" "$link" }
fi
(( dry )) && exit 0

# Caddyfile and landing page come from routes.json, so a new tailname/site script regenerates them.
"$live/bin/tail-gateway-site" >/dev/null
[[ -f "$live/Caddyfile" ]] || "$live/bin/tailname" render >/dev/null

# bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error".
load_agent() {
  local l=$1 plist="$agents/$1.plist" i
  $lctl bootout "$domain/$l" 2>/dev/null || true
  for i in {1..20}; do $lctl print "$domain/$l" >/dev/null 2>&1 || break; sleep 0.5; done
  for i in {1..5}; do $lctl bootstrap "$domain" "$plist" 2>/dev/null && return 0; sleep 1; done
  local bak=( $plist.bak-*(N.om[1]) )
  if (( $#bak )); then
    print -u2 "tail-gateway: $l would not load; putting back $bak[1]"
    cp -p "$bak[1]" "$plist"
    $lctl bootstrap "$domain" "$plist" 2>/dev/null || print -u2 "tail-gateway: $l still won't load, check: launchctl bootstrap $domain $plist"
  fi
  return 1
}

failed=0
for l in $labels; do
  svc=${l#com.ardud.tail-gateway-}
  if (( ${changed[(I)launchd/$l.plist]} )) || ! $lctl print "$domain/$l" >/dev/null 2>&1; then
    if load_agent $l; then print "loaded $l"; else failed=1; fi
  elif (( ${changed[(I)bin/tail-gateway-run]} )) || { [[ $svc == dns ]] && (( ${changed[(I)dns/Corefile]} )) }; then
    $lctl kickstart -k "$domain/$l"
    print "restarted $l"
  fi
done
if (( ${changed[(I)bin/tailname]} )); then
  "$live/bin/tailname" render >/dev/null
  print "re-rendered Caddyfile"
fi

(( failed )) && { print -u2 "tail-gateway: installed with errors (see above)"; exit 1 }
print "tail-gateway: installed $(git -C "$repo" rev-parse --short HEAD)"
