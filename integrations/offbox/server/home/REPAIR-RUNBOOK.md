# Home offbox server: repair runbook

For the repair agent the health monitor starts when the home server stops answering. You have no other
context. Work through the steps in order; each says what to run, what the result means, and the fix.

The box: `offbox-server` on the tailnet (LAN name `offbox-server.local`), at Abdullah's home in Dubai. Ubuntu
on two NVMe disks (mdraid), ZFS pool `offbox`, Incus, and `boatd` (API on the tailnet IP, port 8443).
Everything that must survive is on the pool: boatd's state (dataset `offbox/boatd` at `/var/lib/boatd`) and
Incus's own state (`offbox/incus-var` at `/var/lib/incus`). Without the pool boatd still answers `/health` and
says why, and Incus stays down on purpose; boatd starts it once the pool is back.
Power cuts and restarts are expected: the box is built to come back by itself, so the usual answer is
"it is restarting, wait" or "it came back, here is why it went".

While home is down nothing needs switching: `offbox run` sends runs to Boat by itself and returns to home
after three good health checks in a row. Moni's tasks simply wait for the box.

## Rules (they win over everything else here)

- **Never `WIPE-EVERYTHING`.** Not as a marker file, not in any form.
- **Never destroy a pool, dataset or snapshot.** `zpool destroy`, `zfs destroy`, `incus delete` and
  `incus snapshot delete` are forbidden. So is `zpool import -f` on anything but the one case in step 4.
- **Never open, read or copy Moni's box data.** Her box belongs to owner `moni` (`boatd box list` shows owners).
  Do not `incus exec` into it, do not mount or browse its snapshots, do not copy anything out of it.
- **Never move Moni's box or her work to Boat.**
- **`REINSTALL-OS` only with Abdullah's explicit OK** for this outage. Ask, then wait.
- **Do not touch Boat boxes or the Boat plan.**
- **Do not hand-edit boatd's database** (`/var/lib/boatd/boatd.db`). boatd reconciles runs and boxes by itself
  at every start.
- **Message Abdullah only when hands are needed**, by Telegram (`telegram-notifications` skill), once, with one
  specific action: "press the power button on the box", "plug the stick into the Mac". No progress pings.
- Standard mode only, never fast mode, for you and anything you start.
- **Finish with a note**, appended to `~/.local/share/offbox/home-incidents.md`: date, outage id, what was seen,
  cause, fix, what to change so it does not recur. Report the same in the thread. Do this also when the box
  came back by itself or when you had to stop.

## Setup for every command batch

Each shell call starts fresh, so begin every batch with this:

```bash
STATE=~/.local/share/offbox
IP=$(/usr/bin/python3 -c 'import json,sys,urllib.parse; print(urllib.parse.urlsplit(json.load(open(sys.argv[1]))["url"]).hostname)' $STATE/server.json)
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
# box 'command': root on the server over the tailnet. Another address: HOST=offbox-server.local box 'command'.
# There is no ssh config file for the server: it is always this explicit command. The host key was pinned
# under the tailnet IP by bootstrap.zsh, hence HostKeyAlias.
box() { ssh -i ~/.ssh/offbox_server -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8 \
      -o UserKnownHostsFile=$STATE/server_known_hosts -o HostKeyAlias=$IP root@${HOST:-$IP} "$@"; }
```

What the monitor wrote: `$STATE/backend-state.json` (what offbox believes), `$STATE/home-monitor.log` (every
failed check and its class), `$STATE/home-failures.jsonl` (runs that could not reach home). Failure classes:
`timeout` / `unreachable` = no path to the box or the box is off or hung; `refused` = the box is up but boatd
is not listening; `http_5xx` / `bad_json` = boatd is broken; `not_ok` = boatd answers but cannot run anything
(the reasons are in its `/health`).

## 1. Is it the Mac?

```bash
$TS status --json | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["BackendState"], d["Self"]["Online"])'
nc -z -G 3 1.1.1.1 443 && echo internet-ok; nc -z -G 3 8.8.8.8 443 && echo internet-ok
curl -s -m 5 http://$IP:8443/api/v1/health
```

- Not `Running True`, or neither `internet-ok`: the Mac is offline or off the tailnet. **It is not the box.**
  Stop, write the note. (The monitor does not count checks made while the Mac is offline, so this is rare.)
- `/health` answers with `"ok": true`: the box is back. Go to "When it answers again".
- `/health` answers with `"ok": false`: boatd is up, read `reasons`, go to step 4.

## 2. The tailnet

```bash
$TS status | grep -i offbox          # the line ends in "offline", or shows "active"/"-" when reachable
$TS ping -c 3 --timeout 5s offbox-server
```

- Listed and the ping answers: the network path is fine and the fault is on the box (boatd, pool). Step 4.
- Listed but **offline**: the box is off, hung, restarting, without internet, or its tailscaled is down.
  Step 3 if the Mac is at home, otherwise step 5.
- Not listed, or only `offbox-server-1`: the box rejoined as a new node (after an OS reinstall) and has a new
  address. If `HOST=<new-ip> box offbox-status` works, `integrations/offbox/server/bootstrap.zsh <new-ip> client`
  writes the new address into `server.json`. Report that the stale node should be deleted in the Tailscale
  admin console.
- Listed as expired or needing login: should not happen (the node is tagged). Rejoining needs a new auth key:
  that is a question for Abdullah.

## 3. The home LAN (only when the Mac is at home)

```bash
dscacheutil -q host -a name offbox-server.local      # an ip_address line = the Mac is on the box's LAN
HOST=offbox-server.local box 'offbox-status'
```

- No `ip_address`: the Mac is not on that LAN (or the box is off). Nothing more to learn here: step 5.
- SSH works over the LAN but not over the tailnet: the box is up and off the tailnet.
  `HOST=offbox-server.local box 'tailscale status | head -3; journalctl -u tailscaled -u offbox-tailscale-join -n 40 --no-pager; ping -c2 1.1.1.1'`.
  No internet on the box = the home router or ISP: nothing to fix on the box, say so. tailscaled stopped:
  `systemctl restart tailscaled`. Logged out: a new auth key is needed (Abdullah).

## 4. SSH and the box's own logs

```bash
box 'offbox-status'                                   # one screen: uptime, failed units, md, zpool, health
box 'journalctl -b -1 -n 80 --no-pager'               # the end of the boot before this one: why it went down
box 'journalctl -b -p warning -n 80 --no-pager'       # this boot
box 'zpool status offbox; cat /proc/mdstat; findmnt /var/lib/boatd /var/lib/incus'
box 'systemctl status boatd incus --no-pager | head -40; journalctl -u boatd -n 60 --no-pager'
box 'boatd health'                                    # what /health would say, also when the API is not listening
box "curl -s -m 5 http://$IP:8443/api/v1/health"
```

`boatd` on the server is the same program as the service: `boatd health`, `boatd box list` (boxes and their
owners), `boatd token list`. While it is degraded, `journalctl -u boatd` has one line per reason:
`degraded, serving /health only: ...`.

| What you see | Meaning | Fix |
|---|---|---|
| `up=` is a few minutes, previous boot ends abruptly | power cut or reset; it restarted by itself | none; note the time |
| previous boot ends in `Kernel panic`, MCE or watchdog lines | crash, restarted by itself | none now; note the lines. Repeats = memory or heat (FAILURE-MODES 3.20, 3.21) |
| `zpool=none`, `/health` says the pool is missing | pool not imported; boatd runs in degraded mode and tries a plain `zpool import offbox` itself every 10 s | `zpool import` (lists the pool and why it will not import), then `zpool import offbox`; boatd carries on within seconds, else `systemctl restart boatd`. Only if it refuses with "was previously in use from another system" right after an OS reinstall: `zpool import -f offbox`, which is what `install-host.sh` does (`bootstrap.zsh <ip> host`). This box is the pool's only host; never `-f` for any other reason |
| pool `DEGRADED` or md `[U_]` | one NVMe failed; the box still serves | not an outage. A disk swap needs hands: tell Abdullah (FAILURE-MODES "Replacing a disk") |
| pool `SUSPENDED` / `FAULTED` / `UNAVAIL` | both disks or the pool are in trouble | stop. Do not clear, export or force anything. Tell Abdullah with the `zpool status` text |
| pool imported, `/var/lib/boatd` is not a mount (`findmnt` prints nothing for it) | boatd's dataset is not mounted; it stays degraded and tries `zfs mount offbox/boatd` itself | `zfs mount offbox/boatd` and read the error; `zfs get mountpoint,canmount offbox/boatd` |
| boatd `inactive` / `failed`, or restarting in a loop | boatd itself is broken | read `journalctl -u boatd`; `systemctl restart boatd` once. It reconciles runs and boxes at every start: leave its database alone |
| boatd active, `/health` fine on the box, not from the Mac | boatd listens on an old tailnet address, or the firewall | `tailscale ip -4` against `listen` in `/etc/boatd/config.json`; `nft list ruleset \| head -40`. A changed address: rerun `bootstrap.zsh <ip> host` |
| `incus` inactive with "condition" unmet, `/health` says it waits for Incus | `/var/lib/incus` (dataset `offbox/incus-var`) is not mounted, so Incus stays down on purpose | `zfs mount offbox/incus-var`, then `systemctl start incus.socket incus.service` (boatd also does this once the pool is back). Never remove that condition and never start Incus on the bare directory: it would make an empty world on the OS disk |
| `incus` failed with its state mounted | boxes cannot start | `journalctl -u incus -n 60`; `systemctl restart incus`, then `systemctl restart boatd` |
| root file system full (`df -h /`) | units fail | delete old logs: `journalctl --vacuum-size=500M`. Nothing under `/var/lib/boatd` or `/var/lib/incus` |
| SSH answers and `systemctl is-active emergency.target` = `active` | emergency mode; it restarts by itself in 10 min | `touch /run/offbox/hold` keeps it up; `systemctl --failed`, fix the failed mount or unit, `reboot` |
| SSH works but `offbox-status` is missing | a half-finished install (FAILURE-MODES 2.13a) | stop; that fix is a reinstall, which needs Abdullah's OK |

A restart is safe at any time and is the box's own remedy: `box reboot`. `poweroff` and `halt` also end in a
restart. Wait 10 minutes after it (see the waiting times in step 5) before deciding it did not come back.

## 5. The KVM (eyes and hands when nothing answers)

A GL.iNet Comet sits on the box's HDMI and USB ports with its board on the power and reset pins. Its address is
in the environment as `OFFBOX_KVM_URL` (the same variable `home/watch-install.zsh` reads). It is a web page:
open it in your own Dia window. Nothing in this repo drives it. If the variable is empty or the page does not
load, the KVM is not available (FAILURE-MODES 1.14): go to "When only a person can help".

Look first. What the picture means:

| Screen | Meaning | Do |
|---|---|---|
| no signal, power LED on the KVM's board dark | powered off (power cut with "Restore AC Power Loss" unset, thermal trip) | power button, short press; then wait as below. Afterwards check the BIOS setting (home/README.md, "BIOS settings") |
| black or the ASUS logo, power LED on | memory training after a cold boot: 5-15 min, normal | wait **20 minutes** from power-on before touching anything |
| still black after 20 min, LED on | no POST | reset once, wait 20 min; then one long press (off), short press (on), wait 20 min. Then it needs a person (Q-LED on the board) |
| a firmware prompt: "Press F1", fTPM "... Y/N" | the firmware waits for a key | KVM keyboard: `F1`; fTPM prompt: `Y` (nothing here uses the TPM) |
| BIOS setup, or "no boot device" | boot entries lost | `F8` at the logo, pick an `ubuntu` entry. Once it is up, `offbox-esp-sync` restores the entries |
| the stick's menu, no countdown | a key was pressed | `Enter` on the highlighted entry |
| kernel messages that restart every few seconds, "Kernel panic", an initramfs loop | it cannot find or mount its root (FAILURE-MODES 3.7) | stop. The fix is `REINSTALL-OS` from the stick: ask Abdullah |
| `EMERGENCY MODE`, an SSH address and a countdown | failed mount or unit; restarts by itself | SSH to the address shown, then the emergency row in step 4 |
| `offbox home server ... login:` with addresses above it | the OS is up; the network or tailnet is the problem | SSH to a LAN address if the Mac is at home. Else log in on the console as root (password: Keychain `offbox-server-console`, account `root`; type it, never print it) and run step 4's commands and `tailscale status` there |
| a frozen picture, nothing answers for over 5 min | hard hang and the watchdog did not fire | reset |

Buttons, in this order, never faster:

1. **Wait.** After any power-on or reset: 20 minutes if the screen is black (training), otherwise 10. The
   health check that settles a boot runs 4 minutes after it; the tailnet join retries every 2 minutes.
2. **Power, short press.** Box off: it starts. Box running: a clean restart (the OS never powers off).
3. **Reset.** Only for a hang or no POST. Once, then wait.
4. **Power, long press**, then a short press to start. Last resort, once. If that does not bring a picture,
   stop pressing: it needs a person.

## 6. The stick's logs (needs a person)

The installer stick stays in the box and the installed system adds a report to it at every boot. When nothing
else can be seen, ask Abdullah to "unplug the USB stick from the box and plug it into the Mac", then:

```bash
/Volumes/ExternalSSD/t3code-fork/integrations/offbox/server/home/read-stick-log.zsh
```

It prints the last stages, the newest report of the installed system (`ip=`, `tailscale=`) and what to read
next. The stick must go back into the box afterwards. Do not create marker files on it.

## When only a person can help

No power or no picture after the button sequence, a disk to replace, the mains cable, the stick, a dead KVM
(its own power or network), the home router. Send one Telegram with one action, for example:
"Home offbox: no picture after power and reset. Please check that the box has power (PSU switch, cable) and
tell me which Q-LED on the board is lit." Then wait for his answer in the thread; do not keep pressing buttons.

## When it answers again

The monitor writes to the thread after three good checks, with the box's `boot_id` and `uptime_s`. A changed
`boot_id` and a small uptime mean it restarted: `box 'journalctl -b -1 -n 80 --no-pager'` says why (power
cut: the log just stops; panic, watchdog or thermal: the last lines say so). An unchanged `boot_id` means the
box never restarted: a small `boatd_uptime_s` means boatd did (`journalctl -u boatd --since -2h`), otherwise
look at the network path (step 2, `journalctl -u tailscaled --since -2h`). Check `box 'offbox-status; zpool status -x; boatd box list | head'`, then
write the note and report.
