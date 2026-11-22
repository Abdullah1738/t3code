#!/bin/zsh
set -euo pipefail
HERE=${0:A:h}
BOX=${1:?usage: install.zsh BOX_ID BUN_PATH}
BUN_PATH=${2:?usage: install.zsh BOX_ID BUN_PATH}
[[ $BOX =~ '^bx_[a-zA-Z0-9]+$' && $BUN_PATH =~ '^/[a-zA-Z0-9/_.-]+$' ]] || exit 2
cd "$HOME/.local/share/offbox-person/moni"
export OFFBOX_THREAD=person:moni OFFBOX_BACKEND=server
# Caller resumes this exact box with supervisor.py --ensure-only first. Explicit ssh cannot allocate.
# tar can emit a valid but incomplete archive before failing; finish it before the box can promote it.
archive_dir=$(mktemp -d)
trap 'rm -rf "$archive_dir"' EXIT
trap 'exit 1' HUP INT TERM
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$HERE/../.." -cf - integrations/moni-box-runner/src integrations/spectrum-bridge/src > "$archive_dir/source.tar"
offbox ssh "$BOX" -- '
set -eu
umask 077
agent_dir=$HOME/person/agent
mkdir -p "$agent_dir"
stage=$(mktemp -d "$agent_dir/code.new.XXXXXX")
cleanup() {
  result=$?
  trap - EXIT
  # A failed promotion must put the complete old tree back before removing staging.
  if [ -e "$stage/old" ] && [ ! -e "$agent_dir/code" ]; then
    mv "$stage/old" "$agent_dir/code" || exit 1
  fi
  rm -rf "$stage"
  exit "$result"
}
trap cleanup EXIT
trap "exit 1" HUP INT TERM
mkdir "$stage/code"
tar -xf - -C "$stage/code"
if [ -e "$agent_dir/code" ]; then
  mv "$agent_dir/code" "$stage/old"
fi
mv "$stage/code" "$agent_dir/code"
' < "$archive_dir/source.tar"
offbox ssh "$BOX" -- "bash -s -- '$BUN_PATH'" <<'BOXSETUP'
set -euo pipefail
bun_bin=$1
agent_dir=$HOME/person/agent
[[ -x $bun_bin && -r $agent_dir/config.json ]] || { echo 'Provide box config and pinned Bun before installing' >&2; exit 1; }
"$bun_bin" -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.env.HOME+"/person/agent/config.json","utf8"));for(const k of ["tokenFile","callbackTokenFile","privateKeyFile","systemFile"])fs.accessSync(c[k]);if((c.harness??"claude")==="antigravity"){for(const f of ["agy_acp_server.par","localharness_external"])fs.accessSync(c.antigravity+"/"+f,fs.constants.X_OK)}else fs.accessSync(c.claude,fs.constants.X_OK)'
"$bun_bin" "$agent_dir/code/integrations/moni-box-runner/src/router-auth.ts" --check-config "$agent_dir/config.json"
# The supervisor owns separate loopback forwards: router 19465 -> 20128, livez 19466 -> 20129.
# Validate configured overrides above; do not require tunnels before installing the paused runner.
mkdir -p "$HOME/.config/systemd/user" "$HOME/person/bin"
cat > "$HOME/.config/systemd/user/moni-box-runner.service" <<UNIT
[Unit]
Description=Moni agent runner
[Service]
Environment=MONI_RUNNER_CONFIG=$agent_dir/config.json
ExecStart=$bun_bin $agent_dir/code/integrations/moni-box-runner/src/main.ts
UMask=0077
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
UNIT
cat > "$HOME/person/bin/moni-agent" <<WRAPPER
#!/bin/sh
export MONI_RUNNER_CONFIG='$agent_dir/config.json'
exec '$bun_bin' '$agent_dir/code/integrations/moni-box-runner/src/cli.ts' "\$@"
WRAPPER
chmod 700 "$HOME/person/bin/moni-agent"
sudo loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
systemctl --user enable --now moni-box-runner
BOXSETUP
print 'After supervisor reload, verify on the box: curl -fsS http://127.0.0.1:19466/livez (HTTP 200, ready true; use boxLivezPort if overridden)'
