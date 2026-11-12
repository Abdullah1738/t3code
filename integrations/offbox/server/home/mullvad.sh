#!/bin/bash
# Mullvad VPN on the home offbox server (owner, 12 Nov 2026: "install mullvad on the box, keep it permanently on").
#
# The host and every box leave through Mullvad. Tailscale and the local network stay direct, so the server
# stays reachable when the tunnel is down. With the tunnel down nothing else gets out.
#
# Copy it to the server and run it there as root (install puts it at /usr/local/sbin/offbox-mullvad):
#   mullvad.sh install            package (from GitHub, signature checked) + firewall marks + boot guard + settings
#   mullvad.sh login              account number on stdin; connects, then auto-connect + lockdown + boot guard on
#   mullvad.sh check              PASS/FAIL lines; exit 1 on any FAIL
#   mullvad.sh off                emergency: guard off, lockdown off, disconnect (traffic goes out directly again)
#   mullvad.sh guard-on | guard-release    used by the two systemd units below
#
# mullvad.net, api.mullvad.net and repository.mullvad.net are blocked on UAE lines (TLS reset), so the
# package comes from GitHub and the daemon reaches the API through its own bridges ("api-access").
#
# Four things here are not Mullvad defaults, each for a reason found on install day (home/FAILURE-MODES.md 3.29-3.33):
#  - table inet offbox_vpn gives tailnet flows Mullvad's split-tunnel conntrack mark, so its kill switch lets them through.
#  - mullvad-early-boot-blocking.service is masked. Its table blocks everything, tailnet and LAN included, until
#    the daemon replaces it; if the daemon does not start, or anything runs "systemctl start mullvad-daemon" on a
#    running daemon, the server is cut off until someone uses the KVM console.
#  - table inet offbox_vpn_guard replaces it: loaded before the network comes up, it lets only the tailnet, the
#    LAN and Mullvad's own tunnel packets out, and is removed once Mullvad's own lockdown rules are in place.
#  - the daemon's cgroup v1 net_cls mount is moved out of /sys/fs/cgroup (TALPID_NET_CLS_MOUNT_DIR), or Incus
#    starts no box after a reboot.
#  - box DNS to any outside resolver is redirected to the host's (Mullvad refuses DNS to anything but its own).
set -euo pipefail

VERSION=${MULLVAD_VERSION:-2026.5}
SIGNING_FPR=A1198702FC3E0A09A9AE5B75D5A1D4F266DE8DDF   # Mullvad (code signing) <admin@mullvad.net>
LOCATION=${MULLVAD_LOCATION:-de fra}                    # lowest latency from Dubai with many relays (fr mrs is 10 ms closer)
MARKS=/etc/nftables.d/offbox-vpn.nft
ENABLED=/etc/offbox/vpn-enabled                         # exists = the VPN is meant to be on; the boot guard needs it
SELF=/usr/local/sbin/offbox-mullvad
NET_CLS=/run/offbox-mullvad-net-cls                     # where the daemon may mount its cgroup v1 hierarchy

install_pkg() {
  [ "$(dpkg-query -W -f='${Version}' mullvad-vpn 2>/dev/null || true)" = "$VERSION" ] && return 0
  local d base deb
  d=$(mktemp -d)
  base=https://github.com/mullvad/mullvadvpn-app/releases/download/$VERSION
  deb=MullvadVPN-${VERSION}_amd64.deb
  curl -fsSL --max-time 900 -o "$d/$deb" "$base/$deb"
  curl -fsSL --max-time 60 -o "$d/$deb.asc" "$base/$deb.asc"
  export GNUPGHOME=$d/gnupg
  mkdir -m 700 "$GNUPGHOME"
  gpg --batch -q --keyserver hkps://keys.openpgp.org --recv-keys "$SIGNING_FPR" 2>/dev/null ||
    gpg --batch -q --keyserver hkps://keyserver.ubuntu.com --recv-keys "$SIGNING_FPR"
  local sig
  sig=$(gpg --batch --status-fd 1 --verify "$d/$deb.asc" "$d/$deb" 2>/dev/null || true)
  grep -q "VALIDSIG .* $SIGNING_FPR\$" <<<"$sig" ||
    { echo "mullvad.sh: signature check failed for $deb" >&2; rm -rf "$d"; exit 1; }
  unset GNUPGHOME
  # Mask first: the package's postinst starts the daemon, and that start would pull the blocker in.
  systemctl mask mullvad-early-boot-blocking.service >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$d/$deb"
  rm -rf "$d"
}

write_marks() {
  mkdir -p /etc/nftables.d
  cat > "$MARKS" <<'EOF'
#!/usr/sbin/nft -f
# Keeps the tailnet outside the Mullvad tunnel and reachable while its kill switch is on; sizes TCP for the tunnel.
# Mullvad's two split-tunnel marks do it: conntrack mark 0x00000f41 passes its firewall, and packet mark
# 0x6d6f6c65 skips its routing rule (ip rule 5209, which sits BEFORE Tailscale's 5210/5270 while connected).
# Its own nat chain then masquerades these flows to the interface they really leave on.
table inet offbox_vpn
delete table inet offbox_vpn
table inet offbox_vpn {
  chain output {
    # -149 = after Tailscale's own mangle OUTPUT chain (-150). Its "connmark rp_filter workaround" copies the
    # packet mark into the conntrack mark for new flows; run before it and the conntrack mark ends up 0x6f0f41,
    # Mullvad's masquerade no longer matches, and tailscaled's packets leave with the tunnel's source address.
    type route hook output priority -149; policy accept;
    meta mark & 0x00ff0000 == 0x00080000 ct mark set 0x00000f41 meta mark set 0x6d6f6c65 comment "tailscaled's own traffic (control, DERP, peers)"
    ip daddr 100.64.0.0/10 ct mark set 0x00000f41 meta mark set 0x6d6f6c65 comment "to tailnet peers"
    ip6 daddr fd7a:115c:a1e0::/48 ct mark set 0x00000f41 meta mark set 0x6d6f6c65
  }
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "tailscale0" ct mark set 0x00000f41
    udp dport 41641 ct mark set 0x00000f41 comment "tailnet peers that dial in first"
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    oifname "wg0-mullvad" tcp flags syn / syn,rst tcp option maxseg size set rt mtu
  }
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname "incusbr0" ip daddr != 10.77.0.0/16 meta l4proto { tcp, udp } th dport 53 dnat ip to 10.77.0.1 comment "Mullvad refuses DNS to anything but its own resolver: a box that hardcodes 8.8.8.8 gets the host's resolver instead"
  }
}
EOF
  grep -q 'nftables.d' /etc/nftables.conf || echo 'include "/etc/nftables.d/*.nft"' >> /etc/nftables.conf
  nft -f "$MARKS"
}

guard_on() {
  nft -f - <<'EOF'
table inet offbox_vpn_guard
delete table inet offbox_vpn_guard
table inet offbox_vpn_guard {
  chain egress {
    oifname { "lo", "tailscale0", "incusbr0", "wg0-mullvad" } accept
    meta mark & 0x00ff0000 == 0x00080000 accept comment "tailscaled"
    meta mark 0x6d6f6c65 accept comment "Mullvad's own tunnel packets, and tailnet flows re-marked by offbox_vpn"
    udp sport 68 udp dport 67 accept
    meta l4proto { tcp, udp } th dport 53 drop comment "no DNS to the router"
    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 224.0.0.0/4, 255.255.255.255 } accept
    ip6 daddr { fe80::/10, ff02::/16 } accept
    counter drop
  }
  chain output { type filter hook output priority 10; policy accept; jump egress; }
  chain forward { type filter hook forward priority 10; policy accept; jump egress; }
}
EOF
}

guard_off() { nft delete table inet offbox_vpn_guard 2>/dev/null || true; }

# Hand over to Mullvad's own rules once they are the lockdown kind (policy drop with the tailnet exemption).
guard_release() {
  while :; do
    local chain lock
    chain=$(nft list chain inet mullvad output 2>/dev/null || true); lock=$(mullvad lockdown-mode get 2>/dev/null || true)
    if [[ $chain == *"ct mark 0x00000f41 accept"* && $lock == *": on"* ]]; then
      guard_off
      return 0
    fi
    sleep 2
  done
}

write_units() {
  systemctl mask mullvad-early-boot-blocking.service >/dev/null 2>&1
  mkdir -p /etc/systemd/system/mullvad-daemon.service.d
  cat > /etc/systemd/system/mullvad-daemon.service.d/offbox.conf <<EOF
# Mullvad mounts a cgroup v1 net_cls hierarchy for its split tunnelling. Under /sys/fs/cgroup (its default) it
# makes Incus see a "hybrid" layout when incusd starts after the daemon, and no container starts.
[Service]
Environment=TALPID_NET_CLS_MOUNT_DIR=$NET_CLS
ExecStartPre=/bin/mkdir -p $NET_CLS
EOF
  cat > /etc/systemd/system/offbox-vpn-guard.service <<EOF
[Unit]
Description=offbox: nothing but tailnet, LAN and the Mullvad tunnel leaves until Mullvad's lockdown is up
DefaultDependencies=no
ConditionPathExists=$ENABLED
After=local-fs.target
Before=network-pre.target mullvad-daemon.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$SELF guard-on

[Install]
WantedBy=sysinit.target
EOF
  cat > /etc/systemd/system/offbox-vpn-guard-release.service <<EOF
[Unit]
Description=offbox: remove the boot guard once Mullvad's lockdown rules are in place
ConditionPathExists=$ENABLED
After=mullvad-daemon.service offbox-vpn-guard.service

[Service]
Type=exec
ExecStart=$SELF guard-release

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable offbox-vpn-guard.service offbox-vpn-guard-release.service >/dev/null 2>&1
}

settings() {
  # shellcheck disable=SC2086
  mullvad relay set location $LOCATION >/dev/null
  mullvad lan set allow >/dev/null                 # LAN ssh, the KVM, and host <-> box traffic on incusbr0
  mullvad anti-censorship set mode auto >/dev/null # plain WireGuard is not reliable on UAE lines
  mullvad dns set default >/dev/null
}

cmd_install() {
  [ "$(readlink -f "$0")" = "$SELF" ] || install -m 755 "$0" "$SELF"
  install_pkg
  write_marks
  write_units
  # Never "systemctl start/enable --now mullvad-daemon" here: the package already runs it (see the header).
  for _ in $(seq 20); do mullvad status >/dev/null 2>&1 && break; sleep 1; done
  settings
  echo "mullvad $VERSION installed. Next: offbox-mullvad login  (account number on stdin)"
}

cmd_login() {
  local acct
  read -r acct
  acct=${acct//[^0-9]/}
  [ ${#acct} = 16 ] || { echo "mullvad.sh: expected a 16-digit account number on stdin" >&2; exit 2; }
  [[ $(mullvad account get 2>/dev/null || true) == "Mullvad account:"* ]] || mullvad account login "$acct" >/dev/null
  unset acct
  settings
  mullvad auto-connect set on >/dev/null
  mullvad connect --wait
  mullvad lockdown-mode set on >/dev/null          # only after a tunnel came up once
  mkdir -p "${ENABLED%/*}" && : > "$ENABLED"
  mullvad status
}

cmd_off() {
  rm -f "$ENABLED"
  guard_off
  mullvad lockdown-mode set off || true
  mullvad auto-connect set off || true
  mullvad disconnect --wait || true
  mullvad status || true
}

cmd_check() {
  local bad=0 j box ts
  ok() { echo "PASS vpn: $*"; }
  no() { echo "FAIL vpn: $*"; bad=1; }
  systemctl is-active -q mullvad-daemon && ok "mullvad-daemon is running" || no "mullvad-daemon is not running"
  # Outputs go into variables first: with pipefail, "mullvad ... | grep -q" fails when grep closes the pipe early.
  local st lock auto
  st=$(mullvad status 2>&1 || true); st=${st%%$'\n'*}
  lock=$(mullvad lockdown-mode get 2>&1 || true); auto=$(mullvad auto-connect get 2>&1 || true)
  case $st in Connected*) ok "$st" ;; *) no "tunnel is not up: $st" ;; esac
  case $lock in *": on"*) ok "lockdown mode on (nothing leaves when the tunnel is down)" ;; *) no "lockdown mode is off" ;; esac
  case $auto in *": on"*) ok "auto-connect on" ;; *) no "auto-connect is off" ;; esac
  nft list table inet offbox_vpn >/dev/null 2>&1 && ok "tailnet exemption rules loaded" || no "table inet offbox_vpn is missing (the kill switch would cut the tailnet)"
  [ "$(systemctl is-enabled mullvad-early-boot-blocking.service 2>/dev/null)" = masked ] && ok "Mullvad's early-boot blocker is masked" || no "mullvad-early-boot-blocking.service is not masked (it can cut the server off, see mullvad.sh)"
  [ -e "$ENABLED" ] && systemctl is-enabled -q offbox-vpn-guard.service 2>/dev/null && ok "boot guard enabled" || no "boot guard is not enabled (traffic could leave directly while booting)"
  mountpoint -q /sys/fs/cgroup/net_cls && no "a cgroup v1 net_cls hierarchy is mounted under /sys/fs/cgroup: Incus will not start boxes (reboot after mullvad.sh install)" || ok "no cgroup v1 mount under /sys/fs/cgroup"
  nft list table inet offbox_vpn_guard >/dev/null 2>&1 && no "boot guard is still loaded: Mullvad's lockdown rules never came up" || ok "boot guard handed over to Mullvad's rules"
  j=$(curl -4 -s --max-time 15 https://am.i.mullvad.net/json || true)
  echo "$j" | grep -q '"mullvad_exit_ip":true' && ok "host leaves through Mullvad ($(echo "$j" | sed -n 's/.*"country":"\([^"]*\)".*/\1/p'))" || no "host does not leave through Mullvad"
  box=$(incus list -f csv -c n,s 2>/dev/null | awk -F, '$2=="RUNNING"{print $1; exit}')
  if [ -n "$box" ]; then
    j=$(incus exec "$box" -- curl -4 -s --max-time 15 https://am.i.mullvad.net/json 2>/dev/null || true)
    case $j in
      *'"mullvad_exit_ip":true'*) ok "box $box leaves through Mullvad" ;;
      *'"mullvad_exit_ip":false'*) no "box $box leaves WITHOUT Mullvad" ;;
      *) echo "INFO vpn: box $box gave no answer (starting or stopping?), not counted" ;;
    esac
  else
    echo "INFO vpn: no running box to test"
  fi
  # Online, not just Running: with a broken exemption tailscaled keeps "Running" for a while but cannot reach its control server.
  ts=$(tailscale status --peers=false --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("BackendState"), d.get("Self",{}).get("Online"))' 2>/dev/null || true)
  [ "$ts" = "Running True" ] && ok "tailscale Running and online" || no "tailscale is not online (state: ${ts:-none}); from the LAN: ssh root@offbox-server.local"
  return $bad
}

case "${1:-}" in
  install) cmd_install ;;
  login) cmd_login ;;
  check) cmd_check ;;
  off) cmd_off ;;
  guard-on) guard_on ;;
  guard-release) guard_release ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
