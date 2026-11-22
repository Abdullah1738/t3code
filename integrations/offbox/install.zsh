#!/bin/zsh -f
# Install offbox from this repo onto the Mac, or check that the Mac matches it.
#
#   install.zsh [--dry-run]         sync skill, gate plugin, boat wrapper, offbox link, both LaunchAgents
#   install.zsh --check             exit 1 if the live copy differs from this tree or HEAD is not on origin
#   install.zsh --allow-unpushed    install even with uncommitted or unpushed offbox changes (testing only)
#   install.zsh --allow-reload      allow watched writes while OpenCode sessions are busy
#   install.zsh --since=COMMIT --only=PATH [--only=PATH ...] [--dry-run]
#                                   install only these skill files (paths under skill/), in the order given.
#                                   Each live file must be exactly COMMIT's version, so what goes live is
#                                   COMMIT..HEAD for those files and nothing else: a file that is behind COMMIT
#                                   (held changes) is refused, and no other file is touched. Use while a full
#                                   install is on hold.
#
# Commit and push first: the live copy must always be a commit on origin/main.
set -eu

here="${0:A:h}"
repo="$(git -C "$here" rev-parse --show-toplevel)"
prefix="${here#$repo/}"
reload_helper="$repo/integrations/local-helpers/libexec/opencode-reload/opencode_reload.py"
reload_sources=(integrations/local-helpers/libexec/opencode-reload integrations/local-helpers/libexec/toollog)
quint_source="$repo/integrations/local-helpers/bin/quint"
skill="$HOME/.config/opencode/skills/remote-compute"
plugin="$HOME/.config/opencode/plugin/offbox-gate.ts"
boat="$HOME/.local/bin/boat"
link="$HOME/.local/bin/offbox"
label="com.ardud.offbox-monitor"
plist="$HOME/Library/LaunchAgents/$label.plist"
# Home server health monitor: a one-shot every minute, beside the load monitor (README: "Two monitors").
home_label="com.ardud.offbox-home-monitor"
home_plist="$HOME/Library/LaunchAgents/$home_label.plist"
excludes=(--exclude __pycache__ --exclude '*.pyc' --exclude '*.bak*' --exclude tmp --exclude .DS_Store --exclude /tools/)

mode=install
dry=()
allow=0
reload_flags=()
only=()
since=
for arg in "$@"; do
  case "$arg" in
    --check|--dry-run)
      [[ $mode == install ]] || { print -u2 'choose --check or --dry-run'; exit 2 }
      mode="${arg#--}"
      [[ $mode != dry-run ]] || dry=(--dry-run)
      ;;
    --allow-unpushed) allow=1 ;;
    --allow-reload) reload_flags=(--allow-reload) ;;
    --only=?*) only+=("${arg#--only=}") ;;
    --since=?*) since="${arg#--since=}" ;;
    *) print -u2 "usage: install.zsh [--dry-run | --check] [--allow-unpushed] [--allow-reload] [--since=COMMIT --only=PATH ...]"; exit 2 ;;
  esac
done

pushed() {
  local dirty head remote
  dirty="$(git -C "$repo" status --porcelain -- "$prefix" "${reload_sources[@]}" integrations/local-helpers/bin/quint | grep -v '__pycache__' || true)"
  [[ -z "$dirty" ]] || { print -u2 "offbox: uncommitted changes under $prefix or installer dependencies:"; print -u2 -r -- "$dirty"; return 1 }
  head="$(git -C "$repo" rev-parse HEAD)"
  remote="$(git -C "$repo" ls-remote origin refs/heads/main | cut -f1)"
  [[ -n "$remote" ]] || { print -u2 "offbox: cannot read origin/main"; return 1 }
  if [[ "$head" != "$remote" ]] && ! git -C "$repo" merge-base --is-ancestor HEAD "$remote" 2>/dev/null; then
    print -u2 "offbox: HEAD $head is not on origin/main; push first (git push origin HEAD:main)"
    return 1
  fi
}

if (( ${#only} )) || [[ -n "$since" ]]; then
  [[ $mode != check && $allow == 0 && ${#only} -gt 0 && -n "$since" ]] || {
    print -u2 "offbox: a selective install needs --since=COMMIT and --only=PATH, without --check or --allow-unpushed"; exit 2 }
  pushed || { print -u2 "offbox: refusing a selective install of unpushed work"; exit 1 }
  base="$(git -C "$repo" rev-parse --verify --quiet "$since^{commit}")" || { print -u2 "offbox: --since=$since is not a commit"; exit 1 }
  git -C "$repo" merge-base --is-ancestor "$base" HEAD || { print -u2 "offbox: --since=$since is not an ancestor of HEAD"; exit 1 }
  # Everything is checked before anything is written.
  for rel in "${only[@]}"; do
    installed="$skill/$rel"
    # :A resolves symlinks, so a linked directory on the way cannot send the write outside the skill.
    [[ "$rel" != /* && "$rel" != *..* && -f "$here/skill/$rel" && -f "$installed" && ! -L "$installed"
       && "${installed:A}" == "${skill:A}/$rel" ]] || {
      print -u2 "offbox: --only=$rel is not a skill file present here and installed"; exit 1 }
    want="$(git -C "$repo" rev-parse --verify --quiet "$base:$prefix/skill/$rel")" || {
      print -u2 "offbox: --only=$rel does not exist at $since"; exit 1 }
    # A file already at this tree's version is done (a re-run, or a run resumed after a failed write).
    cmp -s "$here/skill/$rel" "$installed" && continue
    [[ "$(git -C "$repo" hash-object --no-filters "$installed")" == "$want" ]] || {
      print -u2 "offbox: the installed $rel is not the $since version; a selective install would carry other changes with it. Nothing was written."; exit 1 }
  done
  print "offbox: selective install of ${#only} file(s), commits ${base[1,10]}..$(git -C "$repo" rev-parse --short=10 HEAD):"
  git -C "$repo" log --format='  %h %s' "$base..HEAD" -- "${only[@]/#/$prefix/skill/}"
  backup="$HOME/.local/share/offbox/backups/only-$(date -u +%Y%m%dT%H%M%SZ)"
  changed=0
  for rel in "${only[@]}"; do
    if cmp -s "$here/skill/$rel" "$skill/$rel"; then
      print "same $rel"
      continue
    fi
    print "update $rel"
    changed=$(( changed + 1 ))
    (( ${#dry} )) && continue
    mkdir -p "$backup/${rel:h}"
    cp -p "$skill/$rel" "$backup/$rel"
    staging=$(mktemp "$skill/$rel.XXXXXX")
    cp -p "$here/skill/$rel" "$staging" && mv -f "$staging" "$skill/$rel" || {
      rm -f "$staging"
      print -u2 "offbox: could not write $rel; files listed above it were updated, run the same command again"; exit 1 }
  done
  (( ${#dry} || changed == 0 )) || print "offbox: previous copies are in $backup"
  rest="$(rsync -rlp --checksum --dry-run --delete --itemize-changes "${excludes[@]}" "$here/skill/" "$skill/" | grep -c '^[<>*]' || true)"
  (( ${#dry} )) && rest=$(( rest - changed ))
  print "offbox: $rest other installed skill file(s) still differ from this tree and were not touched."
  exit 0
fi

# Fail on missing late inputs before the watched batch can replace anything.
[[ -d "$here/skill" ]] || { print -u2 "offbox: missing source directory: $here/skill"; exit 1 }
for src in "$here"/skill/**/*(DN.) "$here/lib/toollog.ts" "$here/plugin/offbox-gate.ts" "$here/bin/boat" \
           "$here/launchd/$label.plist" "$here/launchd/$home_label.plist" "$quint_source" \
           "$here/home-repair/delete-idle-boxes.sh" "$here/home-repair/idle-boxes-list.py" \
           "$reload_helper" "$repo/integrations/local-helpers/libexec/toollog/toollog.py"; do
  [[ -f "$src" && -r "$src" ]] || { print -u2 "offbox: missing or unreadable source: $src"; exit 1 }
done

if [[ $mode == check ]]; then
  rc=0
  for source in "$here"/home-repair/*; do
    cmp -s "$source" "$HOME/.local/share/offbox/home-repair/${source:t}" || { print -u2 "offbox: repair source differs: ${source:t}"; rc=1 }
  done
  pushed || rc=1
  # Content and modes only: mtimes differ after every install and mean nothing here.
  if [[ ! -d "$skill" ]]; then
    print -u2 "offbox: skill not installed: $skill"
    rc=1
  elif out="$(rsync -rlp --checksum --dry-run --delete --itemize-changes "${excludes[@]}" "$here/skill/" "$skill/")"; then
    [[ -z "$out" ]] || { print -u2 "offbox: live skill differs from the repo:"; print -u2 -r -- "$out"; rc=1 }
  else
    print -u2 "offbox: could not compare the installed skill"
    rc=1
  fi
  cmp -s "$here/lib/toollog.ts" "$HOME/.config/opencode/lib/toollog.ts" || { print -u2 "offbox: toollog helper differs"; rc=1 }
  cmp -s "$here/plugin/offbox-gate.ts" "$plugin" || { print -u2 "offbox: $plugin differs"; rc=1 }
  cmp -s "$here/bin/boat" "$boat" || { print -u2 "offbox: $boat differs"; rc=1 }
  cmp -s "$quint_source" "$skill/tools/quint" || { print -u2 "offbox: guarded Quint wrapper differs"; rc=1 }
  cmp -s "$here/launchd/$label.plist" "$plist" || { print -u2 "offbox: $plist differs"; rc=1 }
  cmp -s "$here/launchd/$home_label.plist" "$home_plist" || { print -u2 "offbox: $home_plist differs"; rc=1 }
  [[ "$(readlink "$link" 2>/dev/null)" == "$skill/scripts/offbox.py" ]] || { print -u2 "offbox: $link is not a link to the skill"; rc=1 }
  if (( rc == 0 )); then
    print "offbox: live copy matches $(git -C "$repo" rev-parse --short HEAD) and it is on origin"
  fi
  exit $rc
fi

if [[ $mode == install ]] && ! pushed; then
  (( allow )) || { print -u2 "offbox: refusing to install. Commit and push, or pass --allow-unpushed for a test install."; exit 1 }
  print -u2 "offbox: installing unpushed changes (--allow-unpushed); commit and push before you finish"
fi

python3 -B "$reload_helper" --installer offbox "${reload_flags[@]}" "${dry[@]}" \
  --pair "$here/lib/toollog.ts" "$HOME/.config/opencode/lib/toollog.ts" \
  --pair "$here/plugin/offbox-gate.ts" "$plugin"

# --delete keeps removed files from lingering; excluded files (tmp/, .bak, caches) on the live side are kept.
(( ${#dry} )) || mkdir -p "${skill:h}"
if (( ${#dry} )) && [[ ! -d "${skill:h}" ]]; then
  print "sync $skill"
else
  rsync -a --delete --itemize-changes "${dry[@]}" "${excludes[@]}" "$here/skill/" "$skill/"
fi
if (( ! ${#dry} )); then
  mkdir -p "$skill/tools"
  cp -p "$quint_source" "$skill/tools/quint"
fi
home_plist_changed=0
for pair in "bin/boat:$boat" "launchd/$label.plist:$plist" \
            "launchd/$home_label.plist:$home_plist"; do
  src="$here/${pair%%:*}"
  dst="${pair#*:}"
  if cmp -s "$src" "$dst"; then
    continue
  fi
  print "update $dst"
  if [[ "$dst" == "$home_plist" ]]; then
    home_plist_changed=1
  fi
  (( ${#dry} )) || { mkdir -p "${dst:h}"; cp -p "$src" "$dst" }
done
if [[ "$(readlink "$link" 2>/dev/null)" != "$skill/scripts/offbox.py" ]]; then
  print "link $link"
  (( ${#dry} )) || ln -sfn "$skill/scripts/offbox.py" "$link"
fi
if (( ${#dry} )); then
  exit 0
fi
mkdir -p "$HOME/.local/share/offbox/home-repair"
for source in "$here"/home-repair/*; do
  destination="$HOME/.local/share/offbox/home-repair/${source:t}"
  staging=$(mktemp "$destination.XXXXXX")
  cp -p "$source" "$staging"
  mv -f "$staging" "$destination"
done

# The monitor imports the skill's scripts, so restart it to pick up new code.
if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$label"
else
  launchctl bootstrap "gui/$(id -u)" "$plist"
fi
# The home monitor is a new process every minute, so new code needs no restart. A changed plist does:
# launchd keeps the definition it loaded. Otherwise just run one check now; no -k, a tick in flight finishes.
if ! launchctl print "gui/$(id -u)/$home_label" >/dev/null 2>&1; then
  launchctl bootstrap "gui/$(id -u)" "$home_plist"
elif (( home_plist_changed )); then
  launchctl bootout "gui/$(id -u)/$home_label" || true
  # bootout returns before the job is gone; bootstrap answers "Input/output error" until it is.
  for try in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$(id -u)" "$home_plist" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  launchctl print "gui/$(id -u)/$home_label" >/dev/null 2>&1 || { print -u2 "offbox: could not reload $home_label"; exit 1 }
else
  launchctl kickstart "gui/$(id -u)/$home_label"
fi
print "offbox: installed $(git -C "$repo" rev-parse --short HEAD); monitor restarted, home monitor loaded."
