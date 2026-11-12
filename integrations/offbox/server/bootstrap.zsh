#!/bin/zsh
# bootstrap.zsh <public-ip> [step...]: install and set up the offbox server from this Mac.
#   os      rescue system -> installimage Ubuntu 24.04 (RAID1 / + /boot, rest left for ZFS) -> reboot
#   ts      install Tailscale and join the tailnet (auth key read from $TS_AUTHKEY_FILE, deleted after use)
#   host    copy server files, run install-host.sh (ZFS, Incus, firewall, boatd, base image)
#   client  one API token per owner (ardud, moni), created on the server and put straight into Keychain
#           (service offbox-server-api, account = owner), and offbox's server.json. From then on offbox sends
#           runs home while the health monitor says the box is up.
#   client-off  set "disabled" in server.json: offbox is on Boat only, exactly as before the home server
#   admin   optional: an admin token (stats over all owners, token management) in Keychain account `admin`
# Default: all steps in order. Key: ~/.ssh/offbox_server (the one given to Hetzner at order time).
#
# Home server (installed by the USB stick, see home/README.md): the stick already did `os` and `ts`, so run
#   bootstrap.zsh <tailnet-ip> home
# which checks that the box is the stick-installed server and on the tailnet, then runs `host` and `client`.
# `host` and `client` also work on their own with the tailnet IP.
set -euo pipefail
IP=$1; shift
STEPS=(${@:-os ts host client})
if [[ ${STEPS[1]} == home ]]; then STEPS=(homecheck host client ${STEPS[2,-1]}); fi
HERE=${0:A:h}
KEY=$HOME/.ssh/offbox_server
STATE=$HOME/.local/share/offbox
KH=$STATE/server_known_hosts
mkdir -p $STATE
SSHO=(-i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KH -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10
      -o ServerAliveInterval=15 -o BatchMode=yes)
r() { ssh $SSHO root@$IP "$@"; }

wait_ssh() {
  for i in {1..120}; do r true 2>/dev/null && return 0; sleep 5; done
  print -u2 "ssh to $IP not back"; return 1
}

for step in $STEPS; do
  case $step in
    os)
      ssh-keygen -R $IP -f $KH >/dev/null 2>&1 || true
      r 'test -x /root/.oldroot/nfs/install/installimage || test -e /usr/sbin/installimage || command -v installimage' \
        || { print -u2 "not in the Hetzner rescue system"; exit 1; }
      img=$(r 'ls /root/.oldroot/nfs/images/ | grep -E "^Ubuntu-2404-noble-amd64-base\.tar\.(gz|zst)$" | head -1')
      [[ -n $img ]] || { print -u2 "no Ubuntu 24.04 image in rescue"; exit 1; }
      r "cat > /tmp/offbox.conf" <<EOF
DRIVE1 /dev/nvme0n1
DRIVE2 /dev/nvme1n1
SWRAID 1
SWRAIDLEVEL 1
BOOTLOADER grub
HOSTNAME offbox-server
PART /boot/efi esp 256M
PART /boot ext3 1024M
PART swap swap 8G
PART / ext4 160G
IMAGE /root/.oldroot/nfs/images/$img
EOF
      r 'installimage -a -c /tmp/offbox.conf' | tail -20
      r 'reboot' || true
      sleep 30
      ssh-keygen -R $IP -f $KH >/dev/null 2>&1 || true
      wait_ssh
      r 'cat /etc/os-release | head -2; lsblk -o NAME,SIZE,TYPE,MOUNTPOINT'
      ;;
    homecheck)
      r 'test -s /etc/offbox/installed' || { print -u2 "$IP is not a stick-installed offbox server (/etc/offbox/installed missing)"; exit 1; }
      r 'offbox-status | head -6'
      [[ -n $(r 'tailscale ip -4 2>/dev/null | head -1') ]] ||
        { print -u2 "the server is not on the tailnet yet (see: journalctl -u offbox-tailscale-join); boatd listens only there"; exit 1; }
      r 'grep -Eq "\[U_\]|\[_U\]" /proc/mdstat' && print -u2 "warning: an mdraid array is degraded (cat /proc/mdstat)"
      [[ $(r 'lsblk -lno PARTLABEL | grep -cx offbox-zfs') == 2 ]] ||
        { print -u2 "expected two offbox-zfs partitions on the server"; exit 1; }
      ;;
    ts)
      [[ -s ${TS_AUTHKEY_FILE:-} ]] || { print -u2 "set TS_AUTHKEY_FILE to a file holding a one-off auth key"; exit 1; }
      r 'command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null'
      r 'k=$(cat) && tailscale up --auth-key="$k" --hostname=offbox-server --ssh=false --accept-dns=false' < $TS_AUTHKEY_FILE
      rm -f $TS_AUTHKEY_FILE
      r 'tailscale ip -4'
      ;;
    host)
      r 'mkdir -p /root/offbox-server'
      scp -q $SSHO $HERE/{boatd.py,boatd-wrap,base-image.sh,boatd.service,install-host.sh} root@$IP:/root/offbox-server/
      r 'bash /root/offbox-server/install-host.sh' 2>&1 | tail -40
      ;;
    client)
      tsip=$(r 'tailscale ip -4 | head -1')
      [[ -n $tsip ]] || { print -u2 "the server has no tailnet address"; exit 1; }
      api=http://$tsip:8443/api/v1
      curl -fsS -m 8 $api/health | grep -q '"ok": true' ||
        { print -u2 "boatd does not report healthy at $api/health; fix that first (journalctl -u boatd)"; exit 1; }
      for owner in ardud moni; do
        # Keep a token that is already in Keychain and still works; otherwise make a new one. The token only
        # ever lives in a shell variable here: never echoed, never written to a file. (The one shared token of
        # the first boatd version became ardud's on the server, so an old Keychain entry keeps working.)
        tok=$(security find-generic-password -s offbox-server-api -a $owner -w 2>/dev/null || true)
        code=000
        [[ -n $tok ]] && code=$(print -rn -- "Authorization: Bearer $tok" | curl -s -m 8 -o /dev/null -w '%{http_code}' -H @- $api/limits)
        if [[ $code == 200 ]]; then
          print "token for $owner: the one in Keychain works, kept"
        else
          tok=$(r "boatd token create --owner $owner --label 'mac client $(date +%F)'")
          [[ $tok == obx_* ]] || { unset tok; print -u2 "could not create a token for $owner"; exit 1; }
          security add-generic-password -U -s offbox-server-api -a $owner -w "$tok"
          print "token for $owner: created, stored in Keychain (offbox-server-api/$owner)"
        fi
        unset tok
      done
      print -r -- "{\"url\": \"$api\", \"public_ip\": \"$IP\", \"disabled\": false}" > $STATE/server.json
      rm -f $STATE/server-admin.sshconfig   # was only for copying Moni's box data to this Mac; that flow is gone
      r 'hostname; boatd token list | sed "s/^/  /"; boatd box list | head -20'
      print "offbox now uses the home server while it is up (state: $STATE/backend-state.json); Boat is the standby"
      ;;
    client-off)
      if [[ -s $STATE/server.json ]]; then
        sed -i '' -E 's/"disabled": *false/"disabled": true/' $STATE/server.json
        grep -q '"disabled": true' $STATE/server.json ||
          { print -u2 "could not mark $STATE/server.json disabled; move the file away instead"; exit 1; }
        print "server.json disabled: offbox runs go to Boat only"
      else
        print "no server.json: offbox is on Boat already"
      fi
      ;;
    admin)
      tok=$(r "boatd token create --admin --label 'mac admin $(date +%F)'")
      [[ $tok == obx_* ]] || { unset tok; print -u2 "could not create an admin token"; exit 1; }
      security add-generic-password -U -s offbox-server-api -a admin -w "$tok"
      unset tok
      print "admin token stored in Keychain (offbox-server-api/admin)"
      ;;
  esac
done
