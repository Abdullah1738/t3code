#!/bin/zsh
# usage: flighty_notify.sh <owner|moni|group|both> <unique-key> <text>
# Sends a flight update through the spectrum bridge only (never imsg). "group" = owner+Moni+Robob
# group chat (slug group-sb_gro); if that send fails it falls back to owner and moni individually.
# "both" = owner and moni individually. Session = the owner chat's live route (id@generation).
set -u
unset BUN_INSPECT
BUN=/Users/ardud/.bun/bin/bun
CLI=/Users/ardud/.local/share/spectrum-bridge/src/cli.ts
GROUP_SLUG=${FLIGHTY_GROUP_SLUG:-group-sb_gro}
target=$1 key=$2 text=$3
route=$(/usr/bin/sqlite3 -readonly ~/.config/spectrum-bridge/state.sqlite \
  "select json_extract(value,'\$.id')||'@'||json_extract(value,'\$.generation') from kv where key='route'")
[[ -n $route && $route != @ ]] || { echo "no live owner route" >&2; exit 2; }
send() { $BUN $CLI send --to "$1" --session "$route" --key "flighty:$key:$1" --text "$text"; }
case $target in
  owner|moni) send $target ;;
  both) send owner; r1=$?; send moni; exit $(( r1 || $? )) ;;
  group)
    if ! send $GROUP_SLUG; then
      echo "group send failed; falling back to owner + moni individually" >&2
      send owner; r1=$?; send moni; exit $(( r1 || $? ))
    fi ;;
  *) echo "target must be owner|moni|group|both" >&2; exit 64 ;;
esac
