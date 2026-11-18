#!/bin/zsh -f
# Reinstall /Applications/Robob.app from a dmg. Quitting Robob interrupts running turns.
# Usage: zsh install-robob.zsh [path/to/Robob.dmg]   (defaults to the newest dmg in tmp/build/release)
set -euo pipefail
REL=/Volumes/ExternalSSD/t3code-fork/tmp/build/release
DMG=${1:-$(ls -t $REL/Robob-*-arm64.dmg | head -1)}
echo "installing $DMG"
source "${0:A:h}/../../../integrations/robob-guard/scripts/install-hold.zsh"
robob_hold_begin install-robob || exit $?
robob_quit_reason install-robob || exit $?
osascript -e 'tell application "Robob" to quit' 2>/dev/null || true
for i in {1..30}; do pgrep -xq Robob || break; sleep 1; done
pgrep -xq Robob && { echo "Robob still running; quit it and rerun"; exit 1; }
MNT=$(mktemp -d /tmp/robob-dmg.XXXX)
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null
trap 'hdiutil detach "$MNT" >/dev/null 2>&1 || true' EXIT
# Restart the OpenCode service while Robob is down so it reloads global plugins/config.
launchctl kickstart -k gui/$UID/com.ardud.opencode-service
PW=$(cat ~/.config/opencode-service/password)
for i in {1..60}; do curl -fsS -u opencode:$PW http://127.0.0.1:49374/api/info >/dev/null 2>&1 && break; sleep 1; done
echo "opencode: $(curl -fsS -u opencode:$PW http://127.0.0.1:49374/api/info)"
rm -rf /Applications/Robob.app
ditto "$MNT/Robob.app" /Applications/Robob.app
xattr -dr com.apple.quarantine /Applications/Robob.app || true
zsh ${0:A:h}/open-robob-clean.zsh /Applications/Robob.app || open /Applications/Robob.app
until node /Volumes/ExternalSSD/t3code-fork/apps/server/src/ardud/control/t3ctl.mjs health >/dev/null 2>&1; do sleep 5; done
echo "done: $(defaults read /Applications/Robob.app/Contents/Info CFBundleShortVersionString)"
