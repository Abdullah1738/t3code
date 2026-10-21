#!/usr/bin/env zsh
# Links offbox-person into the user's PATH and skills dir and installs the backup LaunchAgent. Does not start any box.
set -eu
here=${0:A:h}
label=com.abdullah.offbox-person-backup
plist="$HOME/Library/LaunchAgents/$label.plist"

mkdir -p "$HOME/.local/bin" "$HOME/.config/opencode/skills" "$HOME/.local/share/offbox-person/state" "${plist:h}"
ln -sfn "$here/bin/offbox-person" "$HOME/.local/bin/offbox-person"
ln -sfn "$here/bin/offbox-person-backup" "$HOME/.local/bin/offbox-person-backup"
ln -sfn "$here/skill" "$HOME/.config/opencode/skills/offbox-person"

# Reload only when the plist changed: a reload stops a backup that is running.
loaded=0
launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && loaded=1
if ! cmp -s "$here/launchd/$label.plist" "$plist" 2>/dev/null; then
  cp "$here/launchd/$label.plist" "$plist"
  if [[ $loaded == 1 ]]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    # bootstrap fails (error 5) while the old job is still exiting
    for i in {1..30}; do
      launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 || break
      sleep 1
    done
    loaded=0
  fi
fi
[[ $loaded == 1 ]] || launchctl bootstrap "gui/$(id -u)" "$plist"

print "linked offbox-person, offbox-person-backup and the offbox-person skill; loaded $label (at login and every 6 h)"
