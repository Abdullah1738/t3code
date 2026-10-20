#!/bin/zsh -f
# Install offbox from this repo onto the Mac, or check that the Mac matches it.
#
#   install.zsh [--dry-run]         sync skill, gate plugin, boat wrapper, offbox link, LaunchAgent
#   install.zsh --check             exit 1 if the live copy differs from this tree or HEAD is not on origin
#   install.zsh --allow-unpushed    install even with uncommitted or unpushed offbox changes (testing only)
#
# Commit and push first: the live copy must always be a commit on origin/main.
set -eu

here="${0:A:h}"
repo="$(git -C "$here" rev-parse --show-toplevel)"
prefix="${here#$repo/}"
skill="$HOME/.config/opencode/skills/remote-compute"
plugin="$HOME/.config/opencode/plugin/offbox-gate.ts"
boat="$HOME/.local/bin/boat"
link="$HOME/.local/bin/offbox"
label="com.ardud.offbox-monitor"
plist="$HOME/Library/LaunchAgents/$label.plist"
excludes=(--exclude __pycache__ --exclude '*.pyc' --exclude '*.bak*' --exclude tmp --exclude .DS_Store)

mode=install
dry=()
allow=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=(--dry-run) ;;
    --check) mode=check ;;
    --allow-unpushed) allow=1 ;;
    *) print -u2 "usage: install.zsh [--dry-run | --check | --allow-unpushed]"; exit 2 ;;
  esac
done

pushed() {
  local dirty head remote
  dirty="$(git -C "$repo" status --porcelain -- "$prefix" | grep -v '__pycache__' || true)"
  [[ -z "$dirty" ]] || { print -u2 "offbox: uncommitted changes under $prefix:"; print -u2 -r -- "$dirty"; return 1 }
  head="$(git -C "$repo" rev-parse HEAD)"
  remote="$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)"
  [[ -n "$remote" ]] || { print -u2 "offbox: cannot read origin/main"; return 1 }
  if [[ "$head" != "$remote" ]] && ! git -C "$repo" merge-base --is-ancestor HEAD "$remote" 2>/dev/null; then
    print -u2 "offbox: HEAD $head is not on origin/main; push first (git push origin HEAD:main)"
    return 1
  fi
}

if [[ $mode == check ]]; then
  rc=0
  pushed || rc=1
  # Content and modes only: mtimes differ after every install and mean nothing here.
  out="$(rsync -rlp --checksum --dry-run --delete --itemize-changes "${excludes[@]}" "$here/skill/" "$skill/")"
  [[ -z "$out" ]] || { print -u2 "offbox: live skill differs from the repo:"; print -u2 -r -- "$out"; rc=1 }
  cmp -s "$here/plugin/offbox-gate.ts" "$plugin" || { print -u2 "offbox: $plugin differs"; rc=1 }
  cmp -s "$here/bin/boat" "$boat" || { print -u2 "offbox: $boat differs"; rc=1 }
  cmp -s "$here/launchd/$label.plist" "$plist" || { print -u2 "offbox: $plist differs"; rc=1 }
  [[ "$(readlink "$link" 2>/dev/null)" == "$skill/scripts/offbox.py" ]] || { print -u2 "offbox: $link is not a link to the skill"; rc=1 }
  (( rc == 0 )) && print "offbox: live copy matches $(git -C "$repo" rev-parse --short HEAD) and it is on origin"
  exit $rc
fi

if ! pushed; then
  (( allow )) || { print -u2 "offbox: refusing to install. Commit and push, or pass --allow-unpushed for a test install."; exit 1 }
  print -u2 "offbox: installing unpushed changes (--allow-unpushed); commit and push before you finish"
fi

# --delete keeps removed files from lingering; excluded files (tmp/, .bak, caches) on the live side are kept.
rsync -a --delete --itemize-changes "${dry[@]}" "${excludes[@]}" "$here/skill/" "$skill/"
for pair in "plugin/offbox-gate.ts:$plugin" "bin/boat:$boat" "launchd/$label.plist:$plist"; do
  src="$here/${pair%%:*}"
  dst="${pair#*:}"
  cmp -s "$src" "$dst" && continue
  print "update $dst"
  (( ${#dry} )) || { mkdir -p "${dst:h}"; cp -p "$src" "$dst" }
done
if [[ "$(readlink "$link" 2>/dev/null)" != "$skill/scripts/offbox.py" ]]; then
  print "link $link"
  (( ${#dry} )) || ln -sfn "$skill/scripts/offbox.py" "$link"
fi
(( ${#dry} )) && exit 0

# The monitor imports the skill's scripts, so restart it to pick up new code.
if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$label"
else
  launchctl bootstrap "gui/$(id -u)" "$plist"
fi
print "offbox: installed $(git -C "$repo" rev-parse --short HEAD); monitor restarted."
print "The gate plugin loads when OpenCode starts: a plugin change needs an OpenCode restart (ask Abdullah first)."
