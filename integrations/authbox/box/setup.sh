#!/usr/bin/env bash
# Runs once on an authbox VM (pushed by `authbox up`). The marker guards the heavy install, so re-runs are cheap.
set -euo pipefail

MARK="$HOME/authbox/.setup-v1"
mkdir -p "$HOME/authbox"/{profile,secrets,work}
chmod 700 "$HOME/authbox/secrets"
[ -f "$MARK" ] && exit 0

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq xvfb xauth curl python3-venv python3-pip fonts-liberation fonts-noto-color-emoji

python3 -m venv "$HOME/authbox/venv"
"$HOME/authbox/venv/bin/pip" install -q --upgrade pip
"$HOME/authbox/venv/bin/pip" install -q "cloakbrowser[geoip]"
"$HOME/authbox/venv/bin/python" -m cloakbrowser info

touch "$MARK"
