#!/usr/bin/env bash
# Runs on an offbox-person VM (pushed by `offbox-person wa <person> setup`). Installs the person's own WhatsApp
# linked device: wacli (same pinned release as the owner's Mac), a systemd --user sync service that survives box
# stop/resume (user lingering is on, a resume is a fresh boot), the `wa` wrapper and the wa-db reader.
# Her store lives only here: ~/person/wa/store. Nothing is linked until `wa link <phone>` runs.
set -euo pipefail

P="$HOME/person"
WA="$P/wa"
VER=0.20.0
SHA=f243ea7c70f7ff8fc4de7fd7eb478698708acbd8470ad38ffc13379806321e8c  # wacli_${VER}_linux_amd64.tar.gz, checksums.txt
mkdir -p "$P/bin" "$WA/store" "$WA/watch" "$P/files/whatsapp" "$HOME/.config/systemd/user"
chmod 700 "$WA" "$WA/store"

if ! "$P/bin/wacli" --version 2>/dev/null | grep -q "$VER"; then
  t=$(mktemp -d)
  curl -fsSL -o "$t/w.tgz" "https://github.com/openclaw/wacli/releases/download/v$VER/wacli_${VER}_linux_amd64.tar.gz"
  echo "$SHA  $t/w.tgz" | sha256sum -c - >/dev/null
  tar -xzf "$t/w.tgz" -C "$t"
  install -m 755 "$(find "$t" -type f -name wacli | head -1)" "$P/bin/wacli"
  rm -rf "$t"
fi

# The wrapper and the reader come from stdin-pushed copies next to this script (see offbox-person cmd_wa).
for f in wa wa-db; do
  [ -f "$P/run/push-$f" ] && install -m 755 "$P/run/push-$f" "$P/bin/$f" && rm -f "$P/run/push-$f"
done

cat > "$HOME/.config/systemd/user/wacli-sync.service" <<EOF
[Unit]
Description=wacli sync for this person's WhatsApp (store ~/person/wa/store)
After=network-online.target
StartLimitIntervalSec=900
StartLimitBurst=30

[Service]
Environment=WACLI_STORE_DIR=%h/person/wa/store
ExecStart=%h/person/bin/wacli sync --follow --max-reconnect 0 --stale-threshold 2m --presence-mode quiet --refresh-contacts --max-db-size 4GB --events
Restart=always
RestartSec=10
StandardOutput=append:%h/person/wa/sync.out.log
StandardError=append:%h/person/wa/sync.events.log

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
"$P/bin/wacli" --version
