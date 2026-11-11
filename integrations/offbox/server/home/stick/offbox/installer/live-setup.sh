#!/bin/bash
# live-setup.sh: makes the installer session debuggable with no screen. Started by cloud-init (bootcmd) long
# before subiquity touches a disk, and independent of subiquity from then on:
#   - mounts the stick's log volume and writes a stage log + hardware inventory + all installer logs to it
#   - lets the offbox SSH key in as root, answers to offbox-installer.local (mDNS) and DHCP hostname
#   - joins the tailnet as offbox-installer when the stick carries a tailscale-authkey file
#   - restarts the machine if the install has neither finished nor failed after the deadline
# Never touches the internal disks.
# shellcheck source=common.sh
. /cdrom/offbox/installer/common.sh

case ${1:-} in
  start)
    # cloud-init runs bootcmd in its earliest stage, before systemd has reached sysinit.target. Only queue the
    # agent here (--no-block): waiting for it would wait for a boot that is itself waiting for this command.
    systemctl is-active -q offbox-live.service && exit 0
    systemd-run --no-block --unit=offbox-live --description="offbox installer agent" --collect -p KillMode=process \
      bash /cdrom/offbox/installer/live-setup.sh run >/dev/null 2>&1 ||
      (setsid bash /cdrom/offbox/installer/live-setup.sh run >/dev/null 2>&1 &)
    exit 0
    ;;
  run) ;;
  *) echo "usage: live-setup.sh start" >&2; exit 2 ;;
esac

exec >> "$RUN/live.log" 2>&1
set -x
START=$(date +%s)
# No "remove the installation medium, then press ENTER" at any shutdown of this session (also: noprompt on
# the kernel command line). And a hardware watchdog driver, so that systemd can reset a shutdown that hangs.
touch /run/casper-no-prompt
for m in sp5100_tco i6300esb; do
  [ -e /dev/watchdog0 ] && break
  modprobe -q "$m" 2>/dev/null || true
done

bootdir >/dev/null
stage live-start "why=$(cmdline_arg offbox.why || echo unknown) kernel=$(uname -r) logvol=$(cat "$RUN/logvol.dev" 2>/dev/null || echo none)"

# ---- SSH: root with the offbox key
install -d -m 700 /root/.ssh
if [ -s "$OFFBOX_SRC/site/authorized_keys" ]; then
  cat "$OFFBOX_SRC/site/authorized_keys" >> /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi
# VM tests only: an extra key handed in through QEMU fw_cfg (see common.sh testcfg; absent on real hardware).
TESTKEY=$(testcfg ssh_test_key)
if [ -n "$TESTKEY" ]; then echo "$TESTKEY" >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; fi
ssh-keygen -A >/dev/null 2>&1
# --no-block everywhere: this agent must never wait on the rest of the boot.
systemctl start --no-block ssh.service 2>/dev/null || systemctl start --no-block ssh.socket 2>/dev/null

# ---- name on the LAN: DHCP hostname + mDNS (offbox-installer.local)
HOST=$(cfgval ts_hostname offbox)-installer
timeout 20 hostnamectl set-hostname "$HOST" 2>/dev/null || hostname "$HOST"
mkdir -p /etc/systemd/resolved.conf.d
printf '[Resolve]\nMulticastDNS=yes\nLLMNR=yes\n' > /etc/systemd/resolved.conf.d/offbox.conf
systemctl restart --no-block systemd-resolved 2>/dev/null
mdns_links() {
  local l
  for l in /sys/class/net/e*; do
    [ -e "$l" ] || continue
    timeout 10 resolvectl mdns "${l##*/}" yes 2>/dev/null
  done
}
mdns_links
(sleep 20; for l in /sys/class/net/e*; do [ -e "$l" ] && timeout 20 networkctl renew "${l##*/}"; done) >/dev/null 2>&1 &

inventory
stage live-ready "agent running; ssh and network come up with the rest of the boot"
(
  # one more stage line once the session is actually reachable
  for _ in $(seq 1 120); do
    if ss -ltn 2>/dev/null | grep -q ':22 ' && [ -n "$(hostname -I 2>/dev/null | tr -d ' ')" ]; then
      stage live-reachable "ssh is listening, ip=$(hostname -I | tr ' ' ,)"
      inventory
      exit 0
    fi
    sleep 5
  done
  stage live-unreachable "after 10 minutes: ssh listening=$(ss -ltn 2>/dev/null | grep -c ':22 ') ip=$(hostname -I 2>/dev/null | tr ' ' ,) (no DHCP lease? cable? NIC driver? see inventory/)"
  inventory
) &

# ---- Tailscale (optional): binaries come from the .deb on the stick, state lives on the log volume so the
# installer keeps one tailnet identity across boots and still works after the auth key has expired.
tailscale_loop() {
  local key='' deb ts sock state f n=0
  for f in /cdrom/tailscale-authkey /cdrom/tailscale-authkey.txt "$LOGMNT/tailscale-authkey" "$LOGMNT/tailscale-authkey.txt"; do
    if [ -s "$f" ]; then key=$f; break; fi
  done
  if logvol_mounted; then state=$LOGMNT/ts-installer; else state=$RUN/ts-state; fi
  if [ -z "$key" ] && [ ! -s "$state/tailscaled.state" ]; then
    stage tailscale-skip "no tailscale-authkey file on the stick: LAN only"
    return 0
  fi
  deb=$(find "$OFFBOX_SRC/pkgs" -maxdepth 1 -name 'tailscale_*_amd64.deb' 2>/dev/null | sort | head -1)
  if [ -z "$deb" ]; then stage tailscale-skip "no tailscale .deb on the stick"; return 0; fi
  ts=$RUN/ts
  sock=$ts/tailscaled.sock
  mkdir -p "$ts" "$state"
  dpkg -x "$deb" "$ts" || { stage tailscale-fail "cannot unpack $deb"; return 0; }
  modprobe -q tun 2>/dev/null
  systemd-run --no-block --unit=offbox-ts --collect "$ts/usr/sbin/tailscaled" --statedir="$state" --socket="$sock" >/dev/null 2>&1 ||
    (setsid "$ts/usr/sbin/tailscaled" --statedir="$state" --socket="$sock" >> "$RUN/tailscaled.log" 2>&1 &)
  echo "$sock" > "$RUN/ts.sock"
  while :; do
    n=$((n + 1))
    if "$ts/usr/bin/tailscale" --socket="$sock" status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; then
      stage tailscale-up "name=$HOST ip=$("$ts/usr/bin/tailscale" --socket="$sock" ip -4 2>/dev/null | head -1) attempts=$n"
      "$ts/usr/bin/tailscale" --socket="$sock" ip -4 2>/dev/null | head -1 > "$RUN/tailscale-ip"
      return 0
    fi
    if [ -n "$key" ]; then
      "$ts/usr/bin/tailscale" --socket="$sock" up --auth-key="file:$key" --hostname="$HOST" --ssh=false \
        --accept-dns=false --timeout=40s >> "$RUN/tailscale-up.log" 2>&1
    else
      "$ts/usr/bin/tailscale" --socket="$sock" up --hostname="$HOST" --ssh=false --accept-dns=false \
        --timeout=40s >> "$RUN/tailscale-up.log" 2>&1
    fi
    [ "$n" = 3 ] && stage tailscale-waiting "not up after 3 attempts: $(tail -1 "$RUN/tailscale-up.log" | cut -c1-160)"
    sleep 10
  done
}
tailscale_loop &

# ---- agent loop: keep the stick's copy of the logs fresh, enforce the deadline
DEADLINE=$(cfgval deadline_seconds 7200)
while :; do
  sleep 15
  mdns_links
  sync_logs
  if [ -e "$RUN/install-done" ]; then
    # The installer restarts the machine itself when it is done. If that has not happened after 5 minutes
    # (a shutdown that hangs), do it from here.
    done_at=${done_at:-$(date +%s)}
    if [ $(( $(date +%s) - done_at )) -gt "$(cfgval done_reboot_seconds 300)" ]; then
      stage forced-restart "install finished but the machine did not restart by itself: restarting it now"
      sync_logs
      reboot_now
    fi
    continue
  fi
  [ -e "$RUN/hold" ] && continue
  [ -e "$RUN/holding" ] && continue
  if [ $(( $(date +%s) - START )) -gt "$DEADLINE" ]; then
    stage deadline "install neither finished nor failed after ${DEADLINE}s: restarting to try again"
    inventory
    sync_logs
    reboot_now
  fi
done
