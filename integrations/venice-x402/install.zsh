#!/bin/zsh -f
# Install venice-x402 from this repo onto the Mac, or check that the Mac matches it.
#
#   install.zsh [--dry-run]        sync source to ~/.local/share/venice-x402, npm ci, install + (re)load the LaunchAgent
#   install.zsh --check            exit 1 if the live copy differs from this tree or HEAD is not on origin/main
#   install.zsh --allow-unpushed   install with uncommitted/unpushed changes (testing only)
#
# Live state that never comes from the repo: the wallet key (login Keychain,
# venice-x402-wallet/ardud), the local client token (~/.config/venice-x402/client-token,
# mode 600), the spend ledger (~/.local/share/venice-x402/data) and the log
# (~/Library/Logs/venice-x402.log).
set -eu

here="${0:A:h}"
repo="$(git -C "$here" rev-parse --show-toplevel)"
prefix="${here#$repo/}"
live="${VENICE_X402_HOME:-$HOME/.local/share/venice-x402}"
label=com.ardud.venice-x402
plist="$HOME/Library/LaunchAgents/$label.plist"
token="$HOME/.config/venice-x402/client-token"
domain="gui/$(id -u)"
node_bin=/Users/ardud/.nvm/versions/node/v24.22.3/bin

mode=install; dry=0; allow=0
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
  dirty="$(git -C "$repo" status --porcelain -- "$prefix")"
  [[ -z "$dirty" ]] || { print -u2 "venice-x402: uncommitted changes under $prefix:"; print -u2 -r -- "$dirty"; return 1 }
  head="$(git -C "$repo" rev-parse HEAD)"
  remote="$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)"
  [[ -n "$remote" ]] || { print -u2 "venice-x402: cannot read origin/main"; return 1 }
  if [[ "$head" != "$remote" ]] && ! git -C "$repo" merge-base --is-ancestor HEAD "$remote" 2>/dev/null; then
    print -u2 "venice-x402: HEAD $head is not on origin/main; push first (git push origin HEAD:main)"
    return 1
  fi
}

rs=(-a --delete --exclude node_modules --exclude data --exclude test --exclude install.zsh --exclude README.md --exclude launchd)

if [[ $mode == check ]]; then
  rc=0
  pushed || rc=1
  out="$(rsync $rs --dry-run --itemize-changes "$here/" "$live/" | grep -v '/$' || true)"
  [[ -z "$out" ]] || { print "drift (repo -> live):"; print -r -- "$out"; rc=1 }
  cmp -s "$here/launchd/$label.plist" "$plist" || { print "drift: $plist"; rc=1 }
  launchctl print "$domain/$label" >/dev/null 2>&1 || { print "not loaded: $label"; rc=1 }
  (( rc == 0 )) && print "venice-x402: live matches repo"
  exit $rc
fi

(( allow )) || pushed
if (( dry )); then
  rsync $rs --dry-run --itemize-changes "$here/" "$live/"
  cmp -s "$here/launchd/$label.plist" "$plist" || print "would install $plist"
  exit 0
fi

mkdir -p "$live" "$live/data" "${token:h}"
chmod 700 "$live/data" "${token:h}"
rsync $rs --itemize-changes "$here/" "$live/"
chmod 755 "$live/bin/egress-check" "$live/cli.mjs"
(cd "$live" && PATH="$node_bin:$PATH" npm ci --omit=dev --no-fund --loglevel=error)

if [[ ! -s "$token" ]]; then
  (umask 077; /usr/bin/openssl rand -hex 32 > "$token")
  print "venice-x402: created client token $token"
fi
chmod 600 "$token"

cp "$here/launchd/$label.plist" "$plist"
launchctl bootout "$domain/$label" 2>/dev/null || true
# bootout returns before the job is gone; wait, then bootstrap (retry once).
for _ in {1..20}; do launchctl print "$domain/$label" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "$domain" "$plist" 2>/dev/null || { sleep 2; launchctl bootstrap "$domain" "$plist" }
print "venice-x402: installed; LaunchAgent $label (re)loaded. Log: ~/Library/Logs/venice-x402.log"
