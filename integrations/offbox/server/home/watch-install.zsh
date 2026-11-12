#!/bin/zsh
# watch-install.zsh: from this Mac, say which stage the home server is in and what to do next.
#
#   watch-install.zsh [--minutes N] [--once] [--host ADDR]
#   OFFBOX_KVM_URL=https://<the KVM's address>  (optional) is printed as the first thing to open when the
#                                               box is silent. Nothing here logs in to the KVM or drives it.
#
# The server has no monitor. Ways to see it: the network KVM on its HDMI port (screen, keyboard, power and
# reset buttons), the tailnet, the LAN this Mac is on, and the stick's log volume once the stick is plugged
# back into the Mac (read-stick-log.zsh). This script watches the tailnet and the LAN; the KVM is for eyes.
# This script polls the first two until the installed system answers on the tailnet (exit 0) or N minutes have
# passed (exit 1, with the debugging steps for a box that stayed silent). Default N = 90.
#
# States, in the order a good install goes through them:
#   nothing yet            the board is training memory / the stick is booting (normal for the first 5-20 min)
#   installer on tailnet   or installer on LAN: Ubuntu is being installed; the stage is shown
#   installed on LAN       the server is up but not (yet) on the tailnet
#   installed on tailnet   done
set -u
KEY=$HOME/.ssh/offbox_server
STATE=$HOME/.local/share/offbox
MINUTES=90 ONCE=0 EXTRA=()
while (( $# )); do
  case $1 in
    --minutes) MINUTES=$2; shift 2 ;;
    --once) ONCE=1; shift ;;
    --host) EXTRA+=($2); shift 2 ;;
    *) print -u2 "usage: watch-install.zsh [--minutes N] [--once] [--host ADDR]"; exit 2 ;;
  esac
done
mkdir -p $STATE
KVM_URL=${OFFBOX_KVM_URL:-}
kvm_first() { # the first debugging step of every silent state
  if [[ -n $KVM_URL ]]; then
    print -r -- "  0. Open the KVM screen: $KVM_URL"
  else
    print -r -- "  0. Open the KVM screen (the Comet's web page; set OFFBOX_KVM_URL to have its address printed here)."
  fi
  print -r -- "     $1"
}
TS=$(command -v tailscale || true)
[[ -z $TS && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale

# The installer's ssh host key is new on every boot and the server's changes with a full reinstall, so host
# keys are not pinned here; bootstrap.zsh pins the server's key for real use.
SSHO=(-i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=no
      -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
PROBE='if [ -s /etc/offbox/installed ]; then echo KIND=installed; offbox-status 2>/dev/null | head -12; else echo KIND=installer; echo "stage=$(cat /run/offbox/stage 2>/dev/null)"; tail -4 /run/offbox/stage.log 2>/dev/null; fi'

tailnet_peers() { # lines: name ip online
  [[ -n $TS ]] || return 0
  $TS status --json 2>/dev/null | /usr/bin/python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for p in (d.get("Peer") or {}).values():
    name = (p.get("HostName") or "").lower()
    dns = (p.get("DNSName") or "").split(".")[0].lower()
    if name.startswith("offbox-") or dns.startswith("offbox-"):
        ips = [i for i in p.get("TailscaleIPs") or [] if ":" not in i]
        if ips:
            print(dns or name, ips[0], "online" if p.get("Online") else "offline")
'
}

lan_addrs() { # lines: name ip   (mDNS, then the router's DNS for the DHCP hostname)
  local n ip
  for n in offbox-installer.local offbox-server.local offbox-installer offbox-server; do
    ip=$(dscacheutil -q host -a name $n 2>/dev/null | awk '/^ip_address:/{print $2; exit}')
    [[ -n $ip ]] && print -r -- "$n $ip"
  done
}

probe() { ssh $SSHO root@$1 $PROBE 2>/dev/null; }

START=$(date +%s)
LAST=
while :; do
  now=$(date +%s); mins=$(( (now - START) / 60 ))
  found= kind= where= addr= detail=
  # tailnet first: it is the path everything else will use
  while read -r name ip online; do
    [[ -z $name ]] && continue
    [[ $online == online ]] || { detail="$detail tailnet knows $name ($ip) but it is offline;"; continue; }
    out=$(probe $ip) || continue
    [[ $out == *KIND=* ]] || continue
    k=${${(M)${(f)out}:#KIND=*}#KIND=}
    # the installed system on the tailnet wins over everything
    if [[ $k == installed || -z $found ]]; then found=1; kind=$k; where=tailnet; addr=$ip; body=$out; fi
  done < <(tailnet_peers)
  if [[ $kind != installed ]]; then
    while read -r name ip; do
      [[ -z $name ]] && continue
      out=$(probe $ip) || continue
      [[ $out == *KIND=* ]] || continue
      k=${${(M)${(f)out}:#KIND=*}#KIND=}
      if [[ -z $found || ( $k == installed && $kind != installed ) ]]; then found=1; kind=$k; where=LAN; addr=$ip; body=$out; fi
    done < <(lan_addrs; for h in $EXTRA; do print -r -- "$h $h"; done)
  fi

  if [[ -z $found ]]; then
    line="nothing answers yet (${mins} min).$detail"
  else
    line="$kind system on the $where at $addr: ${${(f)body}[2]}"
  fi
  if [[ $line != $LAST ]]; then
    print -r -- "$(date +%H:%M:%S) $line"
    [[ -n $found ]] && print -r -- "${(F)${(f)body}[3,-1]}" | sed 's/^/           /'
    LAST=$line
  fi

  if [[ $kind == installed && $where == tailnet ]]; then
    cat <<EOF

DONE: the installed server answers on the tailnet at $addr.
Next:
  1. ssh -i $KEY root@$addr 'bash -s' < ${0:A:h}/acceptance.sh        (day-one hardware checks)
  2. ${0:A:h:h}/bootstrap.zsh $addr home                              (ZFS pool, Incus, boatd, client config)
EOF
    exit 0
  fi
  if (( ONCE )) || (( mins >= MINUTES )); then break; fi
  sleep 20
done

print
case "$kind/$where" in
  installer/*)
    print -r -- "The INSTALLER is running and reachable ($where, $addr) but the install has not finished."
    kvm_first "The installer's status page (Alt+F8) shows the same stage lines, the addresses and, when it waits, why and for how long. Alt+F1 is Ubuntu's own installer screen, Alt+F2 a shell."
    cat <<EOF
  look:   ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@$addr
          cat /run/offbox/stage.log            # one line per step; the last line is where it is
          tail -50 /run/offbox/early.log /run/offbox/late.log /var/log/installer/subiquity-server-debug.log
          cat /run/offbox/plan.json | head -20 # what it decided about the disks and why
  stage "hold": it refused or failed and will restart by itself; 'touch /run/offbox/hold' keeps it here.
  stage "plan ... action=abort": the disks are not what it expects (need exactly two equal NVMe disks): lsblk
  stage "plan ... action=refuse": the disks already hold an install or pool data and the stick has no marker
          file. To reinstall anyway: touch /run/offbox/logvol/REINSTALL-OS (keeps the pool) or WIPE-EVERYTHING,
          then: reboot
  An install normally takes 10-15 minutes from the first "early-start" line.
EOF
    ;;
  installed/LAN)
    print -r -- "The server is INSTALLED and reachable on the LAN ($addr) but not on the tailnet."
    kvm_first "The login screen shows the server's addresses; log in as root with the console password (Keychain: offbox-server-console) and run offbox-status."
    cat <<EOF
  look:   ssh -i $KEY root@$addr 'offbox-status; journalctl -u offbox-tailscale-join -u tailscaled -n 40 --no-pager'
  no key: "no auth key on this machine" -> the stick had no tailscale-authkey file, or the key had expired.
          Fix: ssh -i $KEY root@$addr 'tailscale up --auth-key=<new key> --hostname=offbox-server --ssh=false --accept-dns=false'
  key rejected / needs approval: check the Tailscale admin console (Machines) for a pending offbox-server.
  no internet on the box: ssh ... 'ping -c2 1.1.1.1; resolvectl status | head -20'
EOF
    ;;
  *)
    print -r -- "NOTHING answered after ${mins} minutes: not on the tailnet, not on this Mac's LAN (mDNS offbox-installer.local /"
    print -r -- "offbox-server.local, DHCP names offbox-installer / offbox-server).$detail"
    print -r -- "Work through this in order; each step says what the cause would be."
    kvm_first "What is on the screen decides everything below:"
    cat <<EOF
       - black, no signal                          -> not powered or no POST: power LED on the KVM's ATX board;
                                                      press power there; the board's Q-LED needs eyes on site
       - ASUS logo / "memory training" for minutes -> normal on the first boot with 4 DIMMs (5-15 min): wait
       - a BIOS message waiting for a key          -> answer it with the KVM keyboard (F1; fTPM prompt: Y),
                                                      then fix the cause in the BIOS (README: BIOS settings)
       - BIOS setup or "no boot device"            -> the stick is not being booted: F8 at the logo, pick it
       - the stick's menu, countdown stopped       -> a key was pressed: Enter on the highlighted entry
       - the installer's status page               -> read its last lines; it also shows the addresses
       - "EMERGENCY MODE" lines                    -> the installed system could not boot normally; it shows
                                                      the SSH address and restarts by itself
       - "offbox home server ... login:"           -> it is installed and up; the network is the problem
                                                      (addresses are printed above the prompt)
     The KVM itself does not answer: go on with step 1; nothing below needs it.
  1. Is the Mac on the same network as the server (same router, not a guest Wi-Fi)? If not, look in the router's
     DHCP client list for "offbox-installer" or "offbox-server" and rerun:  $0 --host <that ip>
  2. Router shows NO such client: the box never got on the network.
       - power LED on, fans spinning, Ethernet port LEDs dark  -> cable / router port
       - Ethernet LEDs on, no DHCP lease                       -> still in memory training (first boot: up to
         ~15 min, leave it), or it did not boot the stick, or the installer has no driver for the NIC
       - no LEDs, no fans                                      -> not powered: PSU switch, front-panel cable
  3. Wait 20 more minutes, then: short-press the power button ONCE (that is a restart, never a power-off), wait
     another 20 minutes.
  4. Still nothing: unplug the stick from the server, plug it into this Mac and run
         ${0:A:h}/read-stick-log.zsh
     The log volume says how far it got:
       - stage.log does not exist / no new lines   -> the board never booted the stick: wrong USB port, boot
         order, Secure Boot refusing it, or no POST at all (see the Q-LED; BIOS FlashBack file A5677.CAP is on
         the stick). This is the one case that needs a screen or the shop.
       - last line "live-start"/"live-ready", no "live-reachable" -> Linux booted, the network did not come up:
         inventory/nics.txt and inventory/lspci.txt show whether the NIC has a driver and a link
       - "plan ... action=abort"                   -> it did not find exactly two equal NVMe disks: inventory/lsblk.txt
       - "install-failed"                          -> subiquity/curtin error: the summary prints it
       - "late-done" but nothing after             -> installed, but the installed system did not boot or has
         no network: plug the stick back in and power on; the next boot adds its own report to the stick
EOF
    ;;
esac
exit 1
