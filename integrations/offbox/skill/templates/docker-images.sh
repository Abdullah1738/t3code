#!/bin/bash
# offbox: keep Docker images across boat stop/resume/fork.
# Measured 2026-10-14: boat snapshots keep named volumes and container definitions but NOT image layers
# (contrary to the docs). So: `docker save` every tagged image into $HOME (kept by snapshots) and reload it on
# boot with a systemd unit. Run by `offbox save` before forking and by the crpko-harness template. Idempotent.
#
# Boot-time race: a unit enabled on a box only takes effect on its NEXT boot. A fork boots straight from the
# snapshot, so the unit must already be enabled in that snapshot (it is: this script enables it before the fork).
# offbox-wait-images also does the load itself if the unit didn't run, so a run never sees missing images.
set -euo pipefail
A=/home/user/.offbox/images/saved.tar.zst
command -v docker >/dev/null || exit 0
docker info >/dev/null 2>&1 || exit 0

sudo tee /usr/local/bin/offbox-image-restore >/dev/null <<'EOF'
#!/bin/bash
# Reload images kept by offbox if docker lost them. Safe to run many times.
set -u
A=/home/user/.offbox/images/saved.tar.zst
exec 9>/run/offbox-image-restore.lock
flock 9
[ -e /run/offbox-images-ready ] && exit 0
if [ -s "$A" ] && [ -s "$A.tags" ]; then
  for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  missing=0
  while read -r t; do
    [ -n "$t" ] || continue
    docker image inspect "$t" >/dev/null 2>&1 || { missing=1; break; }
  done < "$A.tags"
  if [ "$missing" = 1 ]; then
    zstd -dc "$A" | docker load > /var/tmp/offbox-image-restore.log 2>&1
  fi
fi
touch /run/offbox-images-ready
EOF
sudo chmod 755 /usr/local/bin/offbox-image-restore

sudo tee /etc/systemd/system/offbox-image-restore.service >/dev/null <<'EOF'
[Unit]
Description=offbox: reload saved docker images after resume/fork
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/offbox-image-restore
RemainAfterExit=yes
TimeoutStartSec=900
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable offbox-image-restore.service >/dev/null 2>&1

sudo tee /usr/local/bin/offbox-wait-images >/dev/null <<'EOF'
#!/bin/bash
# Called at the start of every offbox run: make sure kept images are loaded.
[ -e /run/offbox-images-ready ] && exit 0
[ -s /home/user/.offbox/images/saved.tar.zst ] || exit 0
sudo /usr/local/bin/offbox-image-restore
EOF
sudo chmod 755 /usr/local/bin/offbox-wait-images

IMGS=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -v -e '^redroid/' -e '<none>' | sort -u || true)
if [ -z "$IMGS" ]; then
  echo "offbox images: none to keep"
  exit 0
fi
mkdir -p "$(dirname "$A")"
# Skip the re-save when the kept set is already identical (saves minutes on big stacks).
if [ -s "$A" ] && [ "$(cat "$A.tags" 2>/dev/null)" = "$IMGS" ] && \
   [ "$(docker images --format '{{.ID}}' | sort -u | sha1sum)" = "$(cat "$A.ids" 2>/dev/null)" ]; then
  echo "offbox images: $(echo "$IMGS" | wc -l) images already kept ($(du -h "$A" | cut -f1))"
  exit 0
fi
docker save $IMGS | zstd -T0 -1 -q -f -o "$A.tmp"
mv -f "$A.tmp" "$A"
echo "$IMGS" > "$A.tags"
docker images --format '{{.ID}}' | sort -u | sha1sum > "$A.ids"
rm -f /home/user/.offbox/images/harness.tar.zst
echo "offbox images: kept $(echo "$IMGS" | wc -l) images ($(du -h "$A" | cut -f1)) in $A"
