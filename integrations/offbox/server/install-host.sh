#!/bin/bash
# Set up the offbox server on Ubuntu 24.04. Idempotent; run as root:
#   bash install-host.sh            # packages, ZFS pool, state datasets, Incus, firewall, boatd service, timers
#   bash install-host.sh image      # (re)build the offbox-base image from base-image.sh
# Everything that must outlive an OS reinstall is on the pool: boatd's state (dataset offbox/boatd at
# /var/lib/boatd: database, run logs, hashed tokens) and Incus's own state (offbox/incus-var at /var/lib/incus:
# its database of boxes, images, profiles). So this script handles both a fresh pool and one that already holds
# all of that (REINSTALL-OS from the stick, then `bootstrap.zsh <ip> home` again): it imports, mounts and reuses.
# Works after either OS install: the home server's USB stick (home/README.md; the two offbox-zfs partitions
# already exist) or Hetzner's installimage (the free space on each NVMe becomes the offbox-zfs partition here).
# Needs Tailscale up first (tailscale up --auth-key ... --hostname offbox-server): boatd and box ssh listen only on
# the tailnet IP. OFFBOX_LISTEN_IP=<ip> overrides that address (VM tests without a tailnet).
# Files next to this script: boatd.py, boatd-wrap, base-image.sh, boatd.service.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
POOL=offbox
export DEBIAN_FRONTEND=noninteractive

image() {
  incus delete --force offbox-build 2>/dev/null || true
  incus launch images:ubuntu/24.04 offbox-build -p default -p offbox
  for _ in $(seq 60); do incus exec offbox-build -- systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
  incus file push "$HERE/boatd-wrap" offbox-build/usr/local/sbin/boatd-wrap --mode 0755
  incus file push "$HERE/base-image.sh" offbox-build/root/base-image.sh --mode 0700
  incus exec offbox-build -- bash /root/base-image.sh
  incus exec offbox-build -- rm -f /root/base-image.sh
  incus stop offbox-build
  incus image delete offbox-base 2>/dev/null || true
  incus publish offbox-build --alias offbox-base --compression none
  incus delete offbox-build
  echo "image offbox-base ready"
}

if [ "${1:-}" = image ]; then image; exit 0; fi

TS_IP=${OFFBOX_LISTEN_IP:-$(tailscale ip -4 2>/dev/null | head -1 || true)}
[ -n "$TS_IP" ] || { echo "tailscale is not up; run: tailscale up --auth-key ... --hostname offbox-server" >&2; exit 1; }

# ---- packages
apt-get update -qq
apt-get -y -qq full-upgrade
apt-get install -y -qq zfsutils-linux nftables sqlite3 jq rsync curl gnupg unattended-upgrades \
  linux-tools-common smartmontools >/dev/null
# Incus itself is installed further down, after its state directory is on the pool.

# ---- kernel: what Docker-in-container and big test suites need
cat > /etc/modules-load.d/offbox.conf <<'EOF'
overlay
br_netfilter
nf_nat
ip_tables
ip6_tables
iptable_nat
iptable_filter
xt_conntrack
xt_MASQUERADE
xt_addrtype
veth
EOF
systemctl restart systemd-modules-load
cat > /etc/sysctl.d/90-offbox.conf <<'EOF'
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 2097152
fs.inotify.max_queued_events = 1048576
vm.max_map_count = 1048576
kernel.keys.maxkeys = 20000
kernel.keys.maxbytes = 2000000
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
kernel.dmesg_restrict = 1
vm.swappiness = 10
EOF
sysctl -q --system
cat > /etc/security/limits.d/90-offbox.conf <<'EOF'
* soft nofile 1048576
* hard nofile 1048576
EOF

# ---- ZFS mirror over the two partitions with the GPT name offbox-zfs (one per NVMe disk).
# Home server: the installer stick made and named them. Hetzner: installimage left the space unallocated, so
# the partition is added here. The partitions are found by name, never by a fixed /dev/nvmeXn1 (the kernel may
# number the disks either way round), and the pool is built on their stable by-partuuid paths.
zfs_parts() { lsblk -lnpo NAME,PARTLABEL | awk '$2=="offbox-zfs"{print $1}'; }
if ! zpool list "$POOL" >/dev/null 2>&1; then
  if zpool import 2>/dev/null | grep -Eq "^ *pool: $POOL\$"; then
    # The pool is already on the disks (the OS was reinstalled with REINSTALL-OS): take it back, keep the data.
    zpool import -f "$POOL"
  else
    if [ "$(zfs_parts | wc -l)" -lt 2 ]; then
      for d in $(lsblk -dnpo NAME,TYPE,TRAN | awk '$2=="disk" && $3=="nvme"{print $1}'); do
        lsblk -lno PARTLABEL "$d" | grep -qx offbox-zfs && continue
        sgdisk -n 0:0:0 -t 0:BF01 -c 0:offbox-zfs "$d"
        partprobe "$d"
      done
      udevadm settle
      sleep 2
    fi
    mapfile -t parts < <(zfs_parts)
    if [ "${#parts[@]}" != 2 ]; then
      echo "expected two partitions named offbox-zfs, found ${#parts[@]}: ${parts[*]}" >&2
      exit 1
    fi
    devs=()
    for p in "${parts[@]}"; do
      u=$(blkid -o value -s PARTUUID "$p")
      if [ -n "$u" ] && [ -e "/dev/disk/by-partuuid/$u" ]; then devs+=("/dev/disk/by-partuuid/$u"); else devs+=("$p"); fi
    done
    zpool create -f -o ashift=12 -o autotrim=on -O compression=lz4 -O atime=off -O xattr=sa -O acltype=posixacl \
      -O dnodesize=auto -O normalization=formD "$POOL" mirror "${devs[@]}"
  fi
fi
# ---- state that survives an OS reinstall: two datasets on the pool, mounted where the services look.
# state_ds <dataset> <dir> <what>: create or reuse the dataset and mount it at <dir>.
state_ds() {
  local ds=$1 dir=$2 what=$3 cur old
  if zfs list -H "$ds" >/dev/null 2>&1; then
    # Already on the pool (an earlier run, or an imported pool after an OS reinstall): reuse it as it is.
    cur=$(zfs get -H -o value mountpoint "$ds")
    [ "$cur" = "$dir" ] || zfs set mountpoint="$dir" "$ds"
    mountpoint -q "$dir" || zfs mount "$ds"
  elif [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    # A first-version server kept this on the OS disk. Carry it over; the old copy stays, renamed.
    old="$dir.os-disk.$(date -u +%Y%m%dT%H%M%S)"
    mv "$dir" "$old"
    zfs create -o mountpoint="$dir" "$ds"
    cp -a "$old"/. "$dir"/
    echo "moved $what from the OS disk to $ds (old copy kept at $old)"
  else
    zfs create -o mountpoint="$dir" "$ds"
  fi
  mountpoint -q "$dir" || { echo "$ds is not mounted at $dir" >&2; exit 1; }
}
systemctl stop boatd 2>/dev/null || true     # runs keep going in their own units; boatd picks them up again below
state_ds "$POOL/boatd" /var/lib/boatd "boatd state"
chmod 700 /var/lib/boatd
if command -v incus >/dev/null && ! zfs list -H "$POOL/incus-var" >/dev/null 2>&1 && [ -n "$(ls -A /var/lib/incus 2>/dev/null)" ]; then
  # Incus is installed with its state on the OS disk (first-version layout). Moving it means stopping every box,
  # so it is not done behind anyone's back: it keeps working where it is, but an OS reinstall would lose the
  # list of boxes. To move it: stop the boxes, then run this again with OFFBOX_MOVE_INCUS=1.
  if [ "${OFFBOX_MOVE_INCUS:-0}" = 1 ]; then
    if incus list -c s --format csv 2>/dev/null | grep -qi running; then
      echo "boxes are still running; stop them before moving Incus's state" >&2; exit 1
    fi
    systemctl stop incus.service incus.socket incus-startup.service incus-user.service incus-user.socket 2>/dev/null || true
    state_ds "$POOL/incus-var" /var/lib/incus "Incus state"
  else
    echo "WARNING: Incus's state is on the OS disk, not on the pool (see OFFBOX_MOVE_INCUS in this script)" >&2
  fi
else
  state_ds "$POOL/incus-var" /var/lib/incus "Incus state"
fi
if mountpoint -q /var/lib/incus; then
  # Incus must never start on the bare directory under the mount point (it would create an empty world on the
  # OS disk): with the pool away it stays down, boatd says why in /health, and starts it once the pool is back.
  for u in incus.service incus.socket incus-startup.service incus-user.service incus-user.socket; do
    mkdir -p "/etc/systemd/system/$u.d"
    cat > "/etc/systemd/system/$u.d/10-offbox-pool.conf" <<'EOF'
[Unit]
After=zfs-mount.service zfs-import.target
ConditionPathIsMountPoint=/var/lib/incus
EOF
  done
  systemctl daemon-reload
fi
if ! command -v incus >/dev/null; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc
  cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: main
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/zabbly.asc
EOF
  apt-get update -qq
  apt-get install -y -qq incus >/dev/null
fi
systemctl start incus.socket incus.service 2>/dev/null || true
for _ in $(seq 60); do incus query /1.0 >/dev/null 2>&1 && break; sleep 2; done

# ARC: leave RAM for the boxes.
echo "options zfs zfs_arc_max=$((16 * 1024 * 1024 * 1024))" > /etc/modprobe.d/zfs-offbox.conf
echo $((16 * 1024 * 1024 * 1024)) > /sys/module/zfs/parameters/zfs_arc_max || true

# ---- Incus
if ! incus storage show default >/dev/null 2>&1; then
  if zfs list -H "$POOL/incus/containers" >/dev/null 2>&1; then
    echo "the pool already holds Incus boxes ($POOL/incus) but Incus has no record of them (its state was not on" >&2
    echo "the pool when the OS was reinstalled). Recover them with: incus admin recover   (pool default, zfs," >&2
    echo "source $POOL/incus), then run this script again." >&2
    exit 1
  fi
  cat <<EOF | incus admin init --preseed
config: {}
networks:
- name: incusbr0
  type: bridge
  config:
    ipv4.address: 10.77.0.1/16
    ipv4.nat: "true"
    ipv6.address: none
storage_pools:
- name: default
  driver: zfs
  config:
    source: $POOL/incus
profiles:
- name: default
  devices:
    root: {path: /, pool: default, type: disk}
    eth0: {name: eth0, network: incusbr0, type: nic, security.port_isolation: "true"}
EOF
fi
incus profile show offbox >/dev/null 2>&1 || incus profile create offbox
incus profile set offbox security.nesting=true security.syscalls.intercept.mknod=true \
  security.syscalls.intercept.setxattr=true security.syscalls.intercept.sysinfo=true \
  linux.kernel_modules=overlay,br_netfilter,nf_nat,ip_tables,ip6_tables,iptable_nat,iptable_filter,xt_conntrack,xt_MASQUERADE \
  boot.autostart=false limits.processes=65536

# ---- firewall: boxes reach the internet, never the host's services or the tailnet. Public side: ssh only.
cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
table inet offbox {
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    iifname "tailscale0" accept
    iifname "incusbr0" udp dport { 53, 67 } accept
    iifname "incusbr0" tcp dport 53 accept
    iifname "incusbr0" icmp type echo-request accept
    iifname "incusbr0" drop
    udp dport 41641 accept
    tcp dport 22 accept
    # mDNS from the local network only: offbox-server.local is the way to find a home server whose tailnet is down
    ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } udp dport 5353 accept
    ip6 saddr fe80::/10 udp dport 5353 accept
    icmp type { echo-request, destination-unreachable, time-exceeded } accept
    icmpv6 type { echo-request, nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert, destination-unreachable, packet-too-big, time-exceeded } accept
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "incusbr0" ip daddr { 100.64.0.0/10, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } ip daddr != 10.77.0.0/16 drop
    iifname "incusbr0" oifname "tailscale0" drop
  }
}
EOF
systemctl enable --now nftables >/dev/null
nft -f /etc/nftables.conf
systemctl restart incus  # re-adds its own NAT/DHCP rules after the flush

# ---- boatd
install -d -m 700 /etc/boatd
mkdir -p /opt/boatd
install -m 0755 "$HERE/boatd.py" /opt/boatd/boatd.py
printf '#!/bin/sh\nexec /usr/bin/python3 /opt/boatd/boatd.py "$@"\n' > /usr/local/sbin/boatd
chmod 0755 /usr/local/sbin/boatd
# Settings this script owns are set; anything else already in config.json (owners, retention, sizes) is kept.
python3 - "$TS_IP" "$POOL" <<'PY'
import json, os, sys
p = "/etc/boatd/config.json"
try:
    c = json.load(open(p))
except (OSError, ValueError):
    c = {}
c.update(listen=sys.argv[1], ssh_host=sys.argv[1], port=c.get("port", 8443), zpool=sys.argv[2],
         state_dataset=sys.argv[2] + "/boatd")
with open(p + ".tmp", "w") as f:
    json.dump(c, f, indent=1)
os.replace(p + ".tmp", p)
os.chmod(p, 0o600)
PY
install -m 0644 "$HERE/boatd.service" /etc/systemd/system/boatd.service

# ---- timers: snapshots of the person boxes (retention numbers: RETENTION in boatd.py, or "retention" in
# config.json) and a monthly scrub of the pool. Persistent: a run missed while the power was out happens at boot.
cat > /etc/systemd/system/boatd-snap@.service <<'EOF'
[Unit]
Description=boatd: %i snapshots of the person boxes, with pruning
After=boatd.service
ConditionPathIsMountPoint=/var/lib/boatd

[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=/usr/bin/python3 /opt/boatd/boatd.py snap-rotate %i
EOF
snap_timer() {  # <kind> <OnCalendar, UTC>
  cat > "/etc/systemd/system/boatd-snap-$1.timer" <<EOF
[Unit]
Description=boatd: $1 snapshots of the person boxes

[Timer]
OnCalendar=$2
Persistent=true
Unit=boatd-snap@$1.service

[Install]
WantedBy=timers.target
EOF
}
snap_timer hourly '*-*-* *:17:00'
snap_timer daily '*-*-* 22:30:00'       # 02:30 in Dubai
snap_timer weekly 'Sun *-*-* 23:00:00'  # Monday 03:00 in Dubai
cat > /etc/systemd/system/boatd-scrub.service <<EOF
[Unit]
Description=monthly scrub of the ZFS pool $POOL

[Service]
Type=oneshot
ExecStart=-/usr/sbin/zpool scrub $POOL
EOF
cat > /etc/systemd/system/boatd-scrub.timer <<'EOF'
[Unit]
Description=monthly scrub of the offbox ZFS pool

[Timer]
OnCalendar=Sat *-*-01..07 21:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable boatd >/dev/null
systemctl enable --now boatd-snap-hourly.timer boatd-snap-daily.timer boatd-snap-weekly.timer boatd-scrub.timer >/dev/null
systemctl restart boatd

# Home server: a new kernel only becomes the default (offbox-kernel-trial) if Incus and boatd run on it.
if [ -d /etc/offbox/health.d ]; then printf 'incus.service\nboatd.service\n' > /etc/offbox/health.d/offbox-host.units; fi

incus image show offbox-base >/dev/null 2>&1 || image
for _ in $(seq 90); do curl -fsS -m 3 "http://$TS_IP:8443/api/v1/health" 2>/dev/null | grep -q '"ok": true' && break; sleep 2; done
echo "boatd on http://$TS_IP:8443/api/v1"
curl -fsS -m 5 "http://$TS_IP:8443/api/v1/health" || echo "boatd does not answer /health yet: journalctl -u boatd"
echo
echo "tokens (shown once, stored hashed):  boatd token create --owner ardud | --owner moni | --admin"
echo "(bootstrap.zsh <ip> client creates them and puts them straight into the Mac's Keychain)"
