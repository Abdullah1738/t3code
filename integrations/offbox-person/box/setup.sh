#!/usr/bin/env bash
# Runs once on an offbox-person VM (pushed by `offbox-person up`). The marker guards the heavy install, so re-runs are cheap.
set -euo pipefail

MARK="$HOME/person/.setup-v1"
mkdir -p "$HOME/person"/{profile,secrets,work}
chmod 700 "$HOME/person/secrets"
[ -f "$MARK" ] && exit 0

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq xvfb xauth curl python3-venv python3-pip fonts-liberation fonts-noto-color-emoji

python3 -m venv "$HOME/person/venv"
"$HOME/person/venv/bin/pip" install -q --upgrade pip
"$HOME/person/venv/bin/pip" install -q "cloakbrowser[geoip]"
"$HOME/person/venv/bin/python" -m cloakbrowser info

touch "$MARK"
