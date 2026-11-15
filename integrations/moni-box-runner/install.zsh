#!/bin/zsh
set -euo pipefail
HERE=${0:A:h}
BOX=${1:?usage: install.zsh BOX_ID BUN_PATH}
BUN_PATH=${2:?usage: install.zsh BOX_ID BUN_PATH}
[[ $BOX =~ '^bx_[a-zA-Z0-9]+$' && $BUN_PATH =~ '^/[a-zA-Z0-9/_.-]+$' ]] || exit 2
cd "$HOME/.local/share/offbox-person/moni"
export OFFBOX_THREAD=person:moni OFFBOX_BACKEND=server
# Caller resumes this exact box with supervisor.py --ensure-only first. Explicit ssh cannot allocate.
tar -C "$HERE/../.." -cf - integrations/moni-box-runner/src integrations/spectrum-bridge/src |
  offbox ssh "$BOX" -- 'umask 077; mkdir -p ~/person/agent/code; tar -xf - -C ~/person/agent/code'
offbox ssh "$BOX" -- "bash -s -- '$BUN_PATH'" <<'BOXSETUP'
set -euo pipefail
bun_bin=$1
agent_dir=$HOME/person/agent
[[ -x $bun_bin && -r $agent_dir/config.json ]] || { echo 'Provide box config and pinned Bun before installing' >&2; exit 1; }
"$bun_bin" -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.env.HOME+"/person/agent/config.json","utf8"));for(const k of ["tokenFile","callbackTokenFile","privateKeyFile","systemFile"])fs.accessSync(c[k]);fs.accessSync(c.claude,fs.constants.X_OK)'
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
