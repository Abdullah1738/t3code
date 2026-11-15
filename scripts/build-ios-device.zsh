#!/bin/zsh
# Release device build of the t3code mobile app for Abdullah's iPhone/iPad. Run from a worktree root.
#
#   build-ios-device.zsh upstream   # "T3 Code" branding, bundle com.ardud.t3code.demo, no Expo OTA
#   build-ios-device.zsh fork       # Robob branding, bundle com.ardud.robob.mobile
#
# Output: tmp/build/ios/Build/Products/Release-iphoneos/<Scheme>.app, logs in tmp/build/logs/.
# Then: resign-publish.zsh <that .app> <slug>.
set -e
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 EXPO_NO_GIT_STATUS=1
export APP_VARIANT=production T3CODE_IOS_PERSONAL_TEAM=1 T3CODE_MOBILE_UPDATES_ENABLED=0
case "$1" in
  upstream) export T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.ardud.t3code.demo ;;
  fork) export ROBOB_MOBILE=1 T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.ardud.robob.mobile ;;
  *) sed -n '2,8p' $0; exit 1 ;;
esac
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}  # Xcode 27.2 since Nov 2026; the 26.6 copy is stale
export PATH="$PWD/node_modules/.bin:$PATH"
mkdir -p tmp/build/logs
# Pod install and Xcode both regenerate the provider and can succeed after dropping modules.
check_expo_module_scan() {
  local scan_log=$1
  if grep -E "Scanning for Expo modules failed|Scanning for @ExpoModule classes didn't complete" "$scan_log" >&2; then
    echo "ERROR: Expo module scan failed; refusing to build a partially linked iOS app. See $scan_log." >&2
    exit 1
  else
    local scan_log_status=$?
    if (( scan_log_status != 1 )); then
      echo "ERROR: Could not check $scan_log for Expo module scan failures; refusing to continue." >&2
      exit 1
    fi
  fi
}
echo "prebuild..."
(cd apps/mobile && ../../node_modules/.bin/vp exec expo prebuild --clean --platform ios --no-install) > tmp/build/logs/prebuild.log 2>&1
echo "pod install..."
(cd apps/mobile/ios && pod install) > tmp/build/logs/pod.log 2>&1
check_expo_module_scan tmp/build/logs/pod.log
WS=$(ls -d apps/mobile/ios/*.xcworkspace | head -1)
SCHEME=$(basename "$WS" .xcworkspace)
# The cached wildcard dev profile has no Push or Associated Domains, and the personal-team plugin
# does not strip them all. Drop them from the generated (gitignored) entitlements.
ENT=apps/mobile/ios/$SCHEME/$SCHEME.entitlements
for key in aps-environment com.apple.developer.associated-domains; do
  /usr/libexec/PlistBuddy -c "Delete :$key" "$ENT" 2>/dev/null || true
done
echo "xcodebuild $SCHEME (several minutes)..."
xcodebuild -workspace "$WS" -scheme "$SCHEME" -configuration Release -destination generic/platform=iOS \
  -derivedDataPath tmp/build/ios DEVELOPMENT_TEAM=HVG39427R3 CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration build > tmp/build/logs/xcodebuild.log 2>&1
check_expo_module_scan tmp/build/logs/xcodebuild.log
echo "BUILD-OK $PWD/tmp/build/ios/Build/Products/Release-iphoneos/$SCHEME.app"
