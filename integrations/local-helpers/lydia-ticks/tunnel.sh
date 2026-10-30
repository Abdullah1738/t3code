#!/bin/zsh -f
# Named Cloudflare tunnel "lydia-ticks": https://lydia.abdullah.fund -> the ticks server on 127.0.0.1:18820.
creds=$HOME/.local/share/lydia-ticks/tunnel.json
tid=$(/usr/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["TunnelID"])' "$creds") || exit 1
exec /opt/homebrew/bin/cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:0 run --credentials-file "$creds" \
  --url http://127.0.0.1:18820 "$tid"
