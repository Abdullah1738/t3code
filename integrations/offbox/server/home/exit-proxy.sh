#!/bin/bash
# Residential exit for the sites that refuse VPN addresses (owner, 13 Nov 2026: "buy a residential proxy and
# use that as the exit").
#
# Boxes leave through Mullvad (mullvad.sh). Some sites refuse Mullvad's addresses: dl.google.com answers 404 for
# Go toolchain and Android SDK downloads from some relays. Connections from boxes to the names in
# /etc/offbox/exit-proxy-domains leave through one static residential address instead (IPRoyal, SOCKS5,
# reached through the Mullvad tunnel). Everything else still leaves through Mullvad.
#
# Why a list and not everything: the address is sold as "unlimited" under a fair-use policy (other sellers
# put that at about 100 GB a month per address) and the server pulls far more than that (22 GB in 87 minutes
# on 13 Nov). Add a name only when a site refuses the VPN address.
#
# How: box TCP to ports 80/443 is redirected to sing-box on the host, which reads the server name from the
# TLS hello (or the HTTP Host header) and picks the exit. The redirect exists only while sing-box runs, so a
# stopped or crashed sing-box means "everything through Mullvad", never "no internet".
#
# Copy to the server and run as root (install puts it at /usr/local/sbin/offbox-exit-proxy):
#   exit-proxy.sh install          sing-box (GitHub, checksum pinned), unit, default name list
#   exit-proxy.sh set              proxy as host:port:user:password on stdin (SOCKS5 port), then starts it
#   exit-proxy.sh reload           after editing /etc/offbox/exit-proxy-domains
#   exit-proxy.sh health           used by the timer: bypass the proxy while it is down, use it again when it is back
#   exit-proxy.sh check            PASS/FAIL lines; exit 1 on any FAIL
#   exit-proxy.sh off              stop it; every box connection leaves through Mullvad again
#   exit-proxy.sh rules-on | rules-off    used by the unit
set -euo pipefail

VERSION=${SING_BOX_VERSION:-1.14.4}
SHA256=699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968   # sing-box-$VERSION-linux-amd64.tar.gz
SELF=/usr/local/sbin/offbox-exit-proxy
BIN=/usr/local/bin/sing-box
ENVF=/etc/offbox/exit-proxy.env          # EXIT_PROXY_HOST/PORT/USER/PASS, mode 600
DOMAINS=/etc/offbox/exit-proxy-domains   # one name per line; a name covers its subdomains
CONF=/etc/offbox/exit-proxy.json         # generated, mode 600 (holds the proxy password)
BYPASS=/run/offbox-exit-proxy.bypass     # exists = the proxy failed its health probe; names go through Mullvad
FAILS=/run/offbox-exit-proxy.fails
LISTEN=10.77.0.1                         # incusbr0; a nat "redirect" lands on the incoming interface's address
PORT=12380
PROBE_URL=https://dl.google.com/android/repository/repository2-3.xml

install_bin() {
  [ -x "$BIN" ] && [[ $("$BIN" version 2>/dev/null | head -n 1) == *" $VERSION"* ]] && return 0
  local d f
  d=$(mktemp -d)
  f=sing-box-$VERSION-linux-amd64.tar.gz
  # SING_BOX_TARBALL=<file> skips the download (copy it over the LAN when the server's own link is slow).
  if [ -n "${SING_BOX_TARBALL:-}" ]; then cp "$SING_BOX_TARBALL" "$d/$f"
  else curl -fsSL --max-time 600 -o "$d/$f" "https://github.com/SagerNet/sing-box/releases/download/v$VERSION/$f"; fi
  echo "$SHA256  $d/$f" | sha256sum -c --quiet ||
    { echo "exit-proxy.sh: checksum mismatch for $f" >&2; rm -rf "$d"; exit 1; }
  tar -xzf "$d/$f" -C "$d"
  install -m 755 "$d/sing-box-$VERSION-linux-amd64/sing-box" "$BIN"
  rm -rf "$d"
}

write_config() {
  [ -r "$ENVF" ] || { echo "exit-proxy.sh: $ENVF is missing (run: offbox-exit-proxy set)" >&2; exit 2; }
  # The password goes through the environment into python, never onto a command line.
  ( set -a; . "$ENVF"; set +a
    BYPASSED=$([ -e "$BYPASS" ] && echo 1 || echo 0) DOMAINS=$DOMAINS LISTEN=$LISTEN PORT=$PORT python3 - <<'PY' > "$CONF.new"
import json, os
names = []
for line in open(os.environ["DOMAINS"]):
    line = line.split("#")[0].strip().lower().lstrip(".")
    if line:
        names.append(line)
rules = [{"action": "sniff", "timeout": "300ms"}]
if names and os.environ["BYPASSED"] != "1":
    rules.append({"domain_suffix": names, "action": "route", "outbound": "residential"})
print(json.dumps({
    "log": {"level": "warn", "timestamp": False},
    "inbounds": [{"type": "redirect", "tag": "boxes", "listen": os.environ["LISTEN"], "listen_port": int(os.environ["PORT"])}],
    "outbounds": [
        {"type": "direct", "tag": "vpn"},
        {"type": "socks", "tag": "residential", "version": "5",
         "server": os.environ["EXIT_PROXY_HOST"], "server_port": int(os.environ["EXIT_PROXY_PORT"]),
         "username": os.environ["EXIT_PROXY_USER"], "password": os.environ["EXIT_PROXY_PASS"]},
    ],
    "route": {"rules": rules, "final": "vpn"},
}, indent=1))
PY
  )
  chmod 600 "$CONF.new"
  "$BIN" check -c "$CONF.new" || { echo "exit-proxy.sh: generated config is invalid; keeping the old one" >&2; rm -f "$CONF.new"; exit 1; }
  mv "$CONF.new" "$CONF"
}

# Only new connections are redirected; ones already open keep their path.
rules_on() {
  local i
  for i in $(seq 50); do ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q . && break; sleep 0.2; done
  ss -ltnH "sport = :$PORT" | grep -q . || { echo "exit-proxy.sh: sing-box is not listening on $PORT" >&2; exit 1; }
  # The host firewall (install-host.sh, table inet offbox) drops everything a box sends to the host itself.
  nft list chain inet offbox input 2>/dev/null | grep -q "tcp dport $PORT accept" ||
    nft insert rule inet offbox input iifname "incusbr0" tcp dport "$PORT" accept 2>/dev/null || true
  nft -f - <<EOF
table inet offbox_exit
delete table inet offbox_exit
table inet offbox_exit {
  chain prerouting {
    type nat hook prerouting priority dstnat + 5; policy accept;
    iifname "incusbr0" ip daddr != { 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/3 } tcp dport { 80, 443 } redirect to :$PORT
  }
}
EOF
}

rules_off() { nft delete table inet offbox_exit 2>/dev/null || true; }

write_unit() {
  cat > /etc/systemd/system/offbox-exit-proxy.service <<EOF
[Unit]
Description=offbox: residential exit for the sites that refuse VPN addresses (sing-box)
ConditionPathExists=$ENVF
After=network-online.target incus.service mullvad-daemon.service
Wants=network-online.target

[Service]
ExecStartPre=$SELF write-config
ExecStart=$BIN run -c $CONF
ExecStartPost=$SELF rules-on
ExecStopPost=$SELF rules-off
Restart=always
RestartSec=2
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/offbox-exit-proxy-health.service <<EOF
[Unit]
Description=offbox: bypass the residential exit while it is down
ConditionPathExists=$ENVF

[Service]
Type=oneshot
ExecStart=$SELF health
EOF
  cat > /etc/systemd/system/offbox-exit-proxy-health.timer <<EOF
[Unit]
Description=offbox: check the residential exit

[Timer]
OnBootSec=120
OnUnitActiveSec=120

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable offbox-exit-proxy.service >/dev/null 2>&1
  systemctl enable --now offbox-exit-proxy-health.timer >/dev/null 2>&1
}

# 200/206 = fine, anything else = the http code or 000. Credentials come from a curl config on stdin.
probe() {
  ( set -a; . "$ENVF"; set +a
    printf 'proxy = "socks5h://%s:%s"\nproxy-user = "%s:%s"\n' "$EXIT_PROXY_HOST" "$EXIT_PROXY_PORT" "$EXIT_PROXY_USER" "$EXIT_PROXY_PASS" |
      curl -4 -sL -K - --max-time 20 -r 0-99 -o /dev/null -w '%{http_code}' "$PROBE_URL" 2>/dev/null || true )
}

cmd_install() {
  [ "$(readlink -f "$0")" = "$SELF" ] || install -m 755 "$0" "$SELF"
  install_bin
  mkdir -p /etc/offbox
  [ -e "$DOMAINS" ] || cat > "$DOMAINS" <<'EOF'
# Names whose connections from boxes leave through the residential address instead of Mullvad.
# One per line; a name covers its subdomains. After editing: offbox-exit-proxy reload
# Keep it short: the address has a fair-use traffic limit. Add a name only when a site refuses the VPN.
dl.google.com        # Go toolchains and Android SDK: 404 from some Mullvad relays (FAILURE-MODES 3.35)
go.dev               # redirects to dl.google.com
EOF
  write_unit
  echo "sing-box $VERSION installed. Next: offbox-exit-proxy set  (host:port:user:password on stdin)"
}

cmd_set() {
  local h p u w
  IFS=: read -r h p u w
  [ -n "$h" ] && [[ $p =~ ^[0-9]+$ ]] && [ -n "$u" ] && [ -n "$w" ] ||
    { echo "exit-proxy.sh: expected host:port:user:password on stdin" >&2; exit 2; }
  ( umask 077; mkdir -p /etc/offbox
    printf 'EXIT_PROXY_HOST=%q\nEXIT_PROXY_PORT=%q\nEXIT_PROXY_USER=%q\nEXIT_PROXY_PASS=%q\n' "$h" "$p" "$u" "$w" > "$ENVF" )
  unset w
  rm -f "$BYPASS" "$FAILS"
  systemctl restart offbox-exit-proxy.service
  cmd_check
}

cmd_reload() { write_config; systemctl restart offbox-exit-proxy.service; }

# Three failed probes in a row (6 minutes) turn the bypass on; one good probe turns it off.
cmd_health() {
  [ -r "$ENVF" ] || return 0
  systemctl is-enabled -q offbox-exit-proxy.service 2>/dev/null || return 0
  local code n
  code=$(probe)
  case $code in
    200 | 206)
      rm -f "$FAILS"
      if [ -e "$BYPASS" ]; then
        rm -f "$BYPASS"
        logger -t offbox-exit "residential exit answers again; using it"
        cmd_reload
      fi ;;
    *)
      n=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAILS"
      if [ "$n" -ge 3 ] && [ ! -e "$BYPASS" ]; then
        : > "$BYPASS"
        logger -p user.err -t offbox-exit "residential exit failed $n probes (last: ${code:-000}); its names leave through Mullvad until it answers"
        cmd_reload
      fi ;;
  esac
  systemctl is-active -q offbox-exit-proxy.service || systemctl start offbox-exit-proxy.service || true
}

cmd_off() {
  systemctl disable --now offbox-exit-proxy.service offbox-exit-proxy-health.timer >/dev/null 2>&1 || true
  rules_off
  echo "residential exit off: every box connection leaves through Mullvad"
}

cmd_check() {
  local bad=0 code box got
  ok() { echo "PASS exit: $*"; }
  no() { echo "FAIL exit: $*"; bad=1; }
  [ -r "$ENVF" ] || { echo "INFO exit: no residential exit configured"; return 0; }
  systemctl is-active -q offbox-exit-proxy.service && ok "sing-box is running" || no "offbox-exit-proxy.service is not running (boxes use Mullvad for everything)"
  nft list table inet offbox_exit >/dev/null 2>&1 && ok "box web traffic is redirected through it" || no "table inet offbox_exit is missing"
  [ -e "$BYPASS" ] && no "the proxy failed its health probes: its names leave through Mullvad (journalctl -t offbox-exit)" || ok "not bypassed"
  code=$(probe)
  case $code in 200 | 206) ok "proxy answers and dl.google.com accepts its address" ;; *) no "probe through the proxy answered ${code:-nothing}" ;; esac
  box=$(incus list -f csv -c n,s 2>/dev/null | awk -F, '$2=="RUNNING"{print $1; exit}')
  if [ -n "$box" ]; then
    got=$(incus exec "$box" -- curl -4 -sL --max-time 25 -r 0-99 -o /dev/null -w '%{http_code}' "$PROBE_URL" 2>/dev/null || true)
    case $got in
      200 | 206) ok "box $box downloads from dl.google.com" ;;
      "" | 000) echo "INFO exit: box $box gave no answer (starting or stopping?), not counted" ;;
      *) no "box $box gets $got from dl.google.com" ;;
    esac
    got=$(incus exec "$box" -- curl -4 -s --max-time 20 https://am.i.mullvad.net/json 2>/dev/null || true)
    case $got in
      *'"mullvad_exit_ip":true'*) ok "box $box still leaves through Mullvad for other sites" ;;
      "") echo "INFO exit: box $box gave no answer for the Mullvad check, not counted" ;;
      *) no "box $box does not leave through Mullvad for other sites" ;;
    esac
  else
    echo "INFO exit: no running box to test"
  fi
  return $bad
}

case "${1:-}" in
  install) cmd_install ;;
  set) cmd_set ;;
  reload) cmd_reload ;;
  health) cmd_health ;;
  check) cmd_check ;;
  off) cmd_off ;;
  write-config) write_config ;;
  rules-on) rules_on ;;
  rules-off) rules_off ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
