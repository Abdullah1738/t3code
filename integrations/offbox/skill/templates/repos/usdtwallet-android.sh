#!/usr/bin/env bash
set -euo pipefail

export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
if [ ! -x "$JAVA_HOME/bin/java" ]; then
  sudo apt-get install -y -qq openjdk-17-jdk-headless
fi
export ANDROID_HOME="$HOME/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/26.3.11579264"
export PATH="/usr/local/go/bin:$JAVA_HOME/bin:$PATH"

sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$sdkmanager" ]; then
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  curl -fsSL --retry 3 https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip -o "$stage/tools.zip"
  unzip -q "$stage/tools.zip" -d "$stage"
  mkdir -p "$ANDROID_HOME/cmdline-tools/latest"
  cp -R "$stage/cmdline-tools/." "$ANDROID_HOME/cmdline-tools/latest/"
fi

packages=()
for package in platform-tools 'platforms;android-37.1' 'platforms;android-36' 'build-tools;36.0.0' 'ndk;26.3.11579264'; do
  # package.xml is written on completion; a directory alone may be an interrupted download.
  [ -f "$ANDROID_HOME/${package//;//}/package.xml" ] || packages+=("$package")
done
if [ "${#packages[@]}" -gt 0 ]; then
  # sdkmanager closes stdin after accepting licenses. Only its status matters, not yes's SIGPIPE.
  set +e
  yes | "$sdkmanager" --sdk_root="$ANDROID_HOME" "${packages[@]}"
  sdk_rc=${PIPESTATUS[1]}
  set -e
  [ "$sdk_rc" -eq 0 ] || exit "$sdk_rc"
fi

root=${OFFBOX_REPO_ROOT:?offbox must supply the synced repository root}
version=$(python3 - "$root/core/go.mod" <<'PY'
import re, sys
from pathlib import Path
match = re.search(r'^\s*(?:require\s+)?golang\.org/x/mobile\s+(v[^\s]+)', Path(sys.argv[1]).read_text(), re.M)
if not match:
    sys.exit('core/go.mod has no pinned golang.org/x/mobile version')
print(match[1])
PY
)
mobile_bin="$HOME/.local/share/usdtwallet-toolchains/x-mobile-$version/bin"
if [ ! -x "$mobile_bin/gomobile" ] || [ ! -x "$mobile_bin/gobind" ]; then
  mkdir -p "$mobile_bin"
  GOBIN="$mobile_bin" GOTOOLCHAIN=local GOWORK=off go install \
    "golang.org/x/mobile/cmd/gomobile@$version" "golang.org/x/mobile/cmd/gobind@$version"
fi

mkdir -p "$HOME/.offbox/repo-env"
env_file="$HOME/.offbox/repo-env/usdtwallet-android.sh"
{
  printf 'export JAVA_HOME=%q\n' "$JAVA_HOME"
  printf 'export ANDROID_HOME=%q\n' "$ANDROID_HOME"
  printf 'export ANDROID_SDK_ROOT=%q\n' "$ANDROID_SDK_ROOT"
  printf 'export ANDROID_NDK_HOME=%q\n' "$ANDROID_NDK_HOME"
  printf 'export PATH=%q:%q:/usr/local/go/bin:%q:%q:$PATH\n' "$JAVA_HOME/bin" "$mobile_bin" \
    "$ANDROID_HOME/cmdline-tools/latest/bin" "$ANDROID_HOME/platform-tools"
} > "$env_file.tmp"
mv -f "$env_file.tmp" "$env_file"
