#!/bin/zsh -f
# Install the run-cloud skill (rcsim) from this repo onto the Mac, or check that the Mac matches it.
#
#   install.zsh [--dry-run]    copy skill/ over the live skill, keeping a .bak-<stamp> of every file replaced
#   install.zsh --check        exit 1 if the live skill differs from this tree
#
# The live skill is ~/.config/opencode/skills/run-cloud. The LaunchAgent that runs rcsim monitor reads the
# skill path, so the evaluator restarts it only after this install.
set -eu

here="${0:A:h}"
src="$here/skill"
live="$HOME/.config/opencode/skills/run-cloud"
stamp="$(date +%Y%m%d-%H%M%S)"
excludes=(--exclude __pycache__ --exclude '*.pyc' --exclude '*.bak*' --exclude .DS_Store)

mode=install
dry=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --check) mode=check ;;
    *) print -u2 "usage: install.zsh [--dry-run | --check]"; exit 2 ;;
  esac
done

[[ -d "$src" ]] || { print -u2 "run-cloud: missing $src"; exit 1 }

if [[ $mode == check ]]; then
  out="$(rsync -rlp --checksum --dry-run --itemize-changes "${excludes[@]}" "$src/" "$live/")"
  if [[ -n "$out" ]]; then
    print -u2 "run-cloud: live skill differs from $src:"
    print -u2 -r -- "$out"
    exit 1
  fi
  print "run-cloud: live skill matches $src"
  exit 0
fi

# Back up each file that the install would replace or delete, so a bad install can be undone by hand.
backup_dir="$live.bak-$stamp"
changes="$(rsync -rlp --checksum --dry-run --itemize-changes "${excludes[@]}" "$src/" "$live/" 2>/dev/null || true)"
if [[ -z "$changes" ]]; then
  print "run-cloud: nothing to install (live skill already matches)"
  exit 0
fi
print -r -- "$changes"
if (( dry )); then
  print "run-cloud: --dry-run, nothing written"
  exit 0
fi

mkdir -p "$backup_dir"
if [[ -d "$live" ]]; then
  rsync -rlp "${excludes[@]}" "$live/" "$backup_dir/"
fi
mkdir -p "$live"
rsync -rlp --checksum "${excludes[@]}" "$src/" "$live/"
print "run-cloud: installed. Previous copy kept at $backup_dir"
