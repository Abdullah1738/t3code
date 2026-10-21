#!/usr/bin/env bash
# Runs on an offbox-person VM (pushed by `offbox-person up`). The marker guards the heavy install, so re-runs are cheap.
# apt, pip and the installers go out directly; only the browser uses the home route.
set -euo pipefail

MARK="$HOME/person/.setup-v2"
mkdir -p "$HOME/person"/{profile,secrets,work,run}
chmod 700 "$HOME/person/secrets"
[ -f "$MARK" ] && exit 0

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq xvfb xauth x11-utils openbox dbus dbus-x11 at-spi2-core libatk-adaptor \
  curl python3-venv python3-pip fonts-liberation fonts-noto-color-emoji

[ -x "$HOME/person/venv/bin/python" ] || python3 -m venv "$HOME/person/venv"
"$HOME/person/venv/bin/pip" install -q --upgrade pip
"$HOME/person/venv/bin/pip" install -q "cloakbrowser[geoip]"
$SUDO "$HOME/person/venv/bin/python" -m playwright install-deps chromium
"$HOME/person/venv/bin/python" -m cloakbrowser install
"$HOME/person/venv/bin/python" -m cloakbrowser info

# Telemetry is off before cua-driver's first run: the installer itself reports an install event otherwise.
export CUA_DRIVER_RS_TELEMETRY_ENABLED=0 CUA_TELEMETRY_ENABLED=0
curl -fsSL https://cua.ai/driver/install.sh | bash -s -- --no-modify-path
"$HOME/.local/bin/cua-driver" telemetry disable

touch "$MARK"
