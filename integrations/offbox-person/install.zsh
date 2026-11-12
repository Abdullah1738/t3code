#!/usr/bin/env zsh
# Links offbox-person into the user's PATH and skills dir. Does not start any box.
#
# It also retires the Mac-side backup job that older installs set up (offbox-person-backup: box home -> restic
# repo on this Mac -> Dropbox). A person's data now stays on her box on the home offbox server, which snapshots
# it itself; nothing copies it to this Mac. Running this again is harmless: every step is a no-op once done.
set -eu
here=${0:A:h}
share="$HOME/.local/share/offbox-person"

mkdir -p "$HOME/.local/bin" "$HOME/.config/opencode/skills" "$share/state"
ln -sfn "$here/bin/offbox-person" "$HOME/.local/bin/offbox-person"
ln -sfn "$here/bin/offbox-person-wa-new" "$HOME/.local/bin/offbox-person-wa-new"
ln -sfn "$here/skill" "$HOME/.config/opencode/skills/offbox-person"

# Retire the old backup job: stop it, then remove its plist, its PATH link and the copy launchd ran.
label=com.abdullah.offbox-person-backup
domain="gui/$(id -u)"
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  # A backup that is running gets TERM; its own trap detaches and deletes its encrypted stage image.
  launchctl bootout "$domain/$label" 2>/dev/null || true
  for i in {1..30}; do
    launchctl print "$domain/$label" >/dev/null 2>&1 || break
    sleep 1
  done
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    print -u2 "warning: $label is still loaded; run: launchctl bootout $domain/$label"
  fi
fi
rm -f -- "$HOME/Library/LaunchAgents/$label.plist" "$HOME/.local/bin/offbox-person-backup" \
  "$share/bin/offbox-person-backup"
rmdir -- "$share/bin" 2>/dev/null || true

print "linked offbox-person, offbox-person-wa-new and the offbox-person skill; the Mac backup job ($label) is retired"
# What the old backup left behind is not opened, read or deleted here, whether or not it still exists.
print "left in place, deleting them is Abdullah's decision: the old restic repo $share/restic/ (with $share/.restic-cache and anything in $share/stage/), its Keychain password (service restic-offbox-person), the Dropbox mirror /Backups/offbox-person/, and the old status and log files $share/state/*backup*"
