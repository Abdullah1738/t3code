#!/bin/zsh
# Installs the pinned Antigravity ACP server (agy, the runtime Robob's Antigravity provider runs) on
# Moni's box for the "antigravity" harness. Pins match apps/server/src/provider/antigravityRelease.ts.
# Then set in ~/person/agent/config.json: "harness": "antigravity",
# "antigravity": "/home/user/person/agent/antigravity-bin/1.3.0", "model": "ag/gemini-4-neon-high".
set -euo pipefail
BOX=${1:?usage: install-antigravity.zsh BOX_ID}
[[ $BOX =~ '^bx_[a-zA-Z0-9]+$' ]] || exit 2
cd "$HOME/.local/share/offbox-person/moni"
export OFFBOX_THREAD=person:moni OFFBOX_BACKEND=server
offbox ssh "$BOX" -- 'bash -s' <<'BOXSETUP'
set -euo pipefail
umask 077
version=1.3.0
url=https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-$version-linux-x86_64.zip
sha=9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96
[[ $(uname -m) == x86_64 ]] || { echo 'Only the linux x86_64 build is pinned' >&2; exit 1; }
dir=$HOME/person/agent/antigravity-bin/$version
if [[ ! -x $dir/agy_acp_server.par || ! -x $dir/localharness_external ]]; then
  stage=$(mktemp -d "$HOME/person/agent/antigravity-bin.new.XXXXXX")
  trap 'rm -rf "$stage"' EXIT
  curl -fsSL --retry 3 -o "$stage/agy.zip" "$url"
  echo "$sha  $stage/agy.zip" | sha256sum -c - >/dev/null
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$stage/agy.zip" "$stage/out"
  [[ $(stat -c %s "$stage/out/agy_acp_server.par") == 926533965 && $(stat -c %s "$stage/out/localharness_external") == 130388040 ]]
  chmod 700 "$stage/out/agy_acp_server.par" "$stage/out/localharness_external"
  mkdir -p "$(dirname "$dir")"; rm -rf "$dir"; mv "$stage/out" "$dir"
fi
# agy's InitGoogle looks up group "nobody" at start and aborts without it; Ubuntu only has "nogroup".
getent group nobody >/dev/null || sudo -n groupadd nobody
echo "agy $version ready at $dir"
BOXSETUP
