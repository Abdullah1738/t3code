#!/bin/bash
# Set up the offbox server (Hetzner AX102, Ubuntu 24.04) after installimage. Idempotent; run as root:
#   bash install-host.sh            # packages, ZFS pool, Incus, firewall, boatd service
#   bash install-host.sh image      # (re)build the offbox-base image from base-image.sh
# Needs Tailscale up first (tailscale up --auth-key ... --hostname offbox-server): boatd and box ssh listen only on
# the tailnet IP. Files next to this script: boatd.py, boatd-wrap, base-image.sh, boatd.service.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
POOL=offbox
export DEBIAN_FRONTEND=noninteractive

image() {
  incus delete --force offbox-build 2>/dev/null || true
  incus launch images:ubuntu/24.04 offbox-build -p default -p offbox
  for i in $(seq 60); do incus exec offbox-build -- systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
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

TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
[ -n "$TS_IP" ] || { echo "tailscale is not up; run: tailscale up --auth-key ... --hostname offbox-server" >&2; exit 1; }

# ---- packages
apt-get update -qq
apt-get -y -qq full-upgrade
apt-get install -y -qq zfsutils-linux nftables sqlite3 jq rsync curl gnupg unattended-upgrades \
  linux-tools-common smartmontools >/dev/null
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

# ---- ZFS mirror over the free partition on each NVMe (installimage leaves it unallocated)
if ! zpool list "$POOL" >/dev/null 2>&1; then
  parts=()
  for d in /dev/nvme0n1 /dev/nvme1n1; do
    n=$(lsblk -nro NAME "$d" | wc -l)   # disk + its partitions
    if ! lsblk -nro PARTLABEL "$d" | grep -qx offbox-zfs; then
      sgdisk -n 0:0:0 -t 0:BF01 -c 0:offbox-zfs "$d"
      partprobe "$d"; sleep 2
    fi
    parts+=("/dev/disk/by-partlabel/offbox-zfs")
  done
  # by-partlabel collides for two disks: use the real partition paths.
  p0=$(lsblk -nrpo NAME,PARTLABEL /dev/nvme0n1 | awk '$2=="offbox-zfs"{print $1}')
  p1=$(lsblk -nrpo NAME,PARTLABEL /dev/nvme1n1 | awk '$2=="offbox-zfs"{print $1}')
  zpool create -f -o ashift=12 -o autotrim=on -O compression=lz4 -O atime=off -O xattr=sa -O acltype=posixacl \
    -O dnodesize=auto -O normalization=formD "$POOL" mirror "$p0" "$p1"
fi
# ARC: leave RAM for the boxes.
echo "options zfs zfs_arc_max=$((16 * 1024 * 1024 * 1024))" > /etc/modprobe.d/zfs-offbox.conf
echo $((16 * 1024 * 1024 * 1024)) > /sys/module/zfs/parameters/zfs_arc_max || true

# ---- Incus
if ! incus storage show default >/dev/null 2>&1; then
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
install -d -m 700 /etc/boatd /var/lib/boatd
install -m 0755 "$HERE/boatd.py" /opt/boatd/boatd.py 2>/dev/null || { mkdir -p /opt/boatd; install -m 0755 "$HERE/boatd.py" /opt/boatd/boatd.py; }
[ -s /etc/boatd/token ] || (umask 077; head -c 32 /dev/urandom | base64 | tr -d '/+=' > /etc/boatd/token)
cat > /etc/boatd/config.json <<EOF
{"listen": "$TS_IP", "port": 8443, "ssh_host": "$TS_IP"}
EOF
install -m 0644 "$HERE/boatd.service" /etc/systemd/system/boatd.service
systemctl daemon-reload
systemctl enable boatd >/dev/null
systemctl restart boatd

incus image show offbox-base >/dev/null 2>&1 || image
echo "boatd on http://$TS_IP:8443/api/v1 (token in /etc/boatd/token)"
