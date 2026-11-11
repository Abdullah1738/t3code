#!/bin/bash
# acceptance.sh: day-one checks on the real home server, for everything a VM could not prove.
# Run as root over SSH:   ssh root@offbox-server 'bash -s' < acceptance.sh [-- options]
#
#   (no option)          non-destructive checks, about 6 minutes (2 min CPU load, 3 min memory pass)
#   --memory-full        add a long memory test: memtester over ~85% of free RAM, one pass (hours with 192 GB)
#   --test-rtc-wake      REAL power-off with a 4-minute RTC alarm. The machine must switch itself back on.
#                        Run `acceptance.sh --after-rtc-wake` once it is back.
#   --test-watchdog      hang every CPU. The chipset watchdog must reset the machine within about 2 minutes.
#                        Run `acceptance.sh --after-watchdog` once it is back.
#   --after-rtc-wake / --after-watchdog   verdict of the destructive test that ran before the restart
#
# Every line starts with PASS, FAIL, WARN or INFO. Exit code 1 if anything FAILed.
# One thing no script can check: pull the power cable for 30 s and plug it back in. The machine must start by
# itself. If it stays off, the BIOS setting "Restore AC Power Loss" is not "Power On" (needs a screen once).
set -u
STATE=/var/lib/offbox
FAILS=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILS=$((FAILS + 1)); }
warn() { echo "WARN $*"; }
info() { echo "INFO $*"; }
have() { command -v "$1" >/dev/null 2>&1; }
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 2; }
mkdir -p "$STATE"

case ${1:-} in
  --after-rtc-wake)
    f=$STATE/acceptance-rtc-wake
    [ -s "$f" ] || { fail "no RTC wake test was started"; exit 1; }
    off=$(cat "$f"); up=$(date -d "$(uptime -s)" +%s); gap=$((up - off))
    if [ "$gap" -ge 60 ] && [ "$gap" -le 600 ]; then
      pass "RTC wake from a real power-off: off at $(date -u -d "@$off" +%T), running again $gap s later"
    else
      fail "RTC wake: the machine came back $gap s after the power-off (expected 60-600 s; did somebody press the button?)"
    fi
    rm -f "$f"; exit $FAILS ;;
  --after-watchdog)
    f=$STATE/acceptance-watchdog
    [ -s "$f" ] || { fail "no watchdog test was started"; exit 1; }
    hang=$(cat "$f"); up=$(date -d "$(uptime -s)" +%s); gap=$((up - hang))
    prev=$(journalctl -b -1 --no-pager 2>/dev/null | tail -3 | grep -ci 'reboot\|shutdown\|power')
    if [ "$gap" -ge 30 ] && [ "$gap" -le 400 ] && [ "$prev" = 0 ]; then
      pass "hardware watchdog: hang at $(date -u -d "@$hang" +%T), reset and running again $gap s later, previous boot ended without a shutdown"
    else
      fail "hardware watchdog: back after $gap s, previous boot's journal ends with a shutdown message: $prev (expected a hard reset 30-400 s after the hang)"
    fi
    rm -f "$f"; exit $FAILS ;;
  --test-rtc-wake)
    [ -w /sys/class/rtc/rtc0/wakealarm ] || { fail "no writable RTC wake alarm"; exit 1; }
    echo "The machine will now REALLY power off and must come back by itself in about 4 minutes."
    echo "If it is still off after 10 minutes: press the power button, then report RTC wake as not working (BIOS: ErP must be disabled)."
    date +%s > "$STATE/acceptance-rtc-wake"
    systemctl stop offbox-rtcwake.timer
    echo 0 > /sys/class/rtc/rtc0/wakealarm; echo +240 > /sys/class/rtc/rtc0/wakealarm
    sync
    # --force: skips the poweroff.target alias (which restarts instead); file systems are still unmounted.
    nohup sh -c 'sleep 3; systemctl --force poweroff' >/dev/null 2>&1 &
    exit 0 ;;
  --test-watchdog)
    wd=$(cat /sys/class/watchdog/watchdog0/identity 2>/dev/null)
    [ "$(cat /sys/class/watchdog/watchdog0/state 2>/dev/null)" = active ] || { fail "watchdog0 is not active (identity: ${wd:-none}); nothing to test"; exit 1; }
    echo "Hanging every CPU now. Watchdog: $wd. The machine must reset itself within about 2 minutes."
    echo "If it is still dead after 10 minutes: hold the power button 5 s, press it again, then report the watchdog as not working."
    date +%s > "$STATE/acceptance-watchdog"
    sync
    # Real-time busy loops on every CPU with both safety nets off: RT throttling, and (kernel 6.12+) the fair
    # server that would still give normal tasks 5% of each CPU. systemd can then no longer feed the watchdog.
    sysctl -qw kernel.sched_rt_runtime_us=-1 kernel.nmi_watchdog=0 kernel.softlockup_panic=0 2>/dev/null
    for f in /sys/kernel/debug/sched/fair_server/cpu*/runtime; do [ -e "$f" ] && echo 0 > "$f"; done
    nohup sh -c 'sleep 3; for c in $(seq 0 $(( $(nproc) - 1 ))); do taskset -c $c chrt -f 99 sh -c "while :; do :; done" & done' >/dev/null 2>&1 &
    exit 0 ;;
esac
MEMFULL=0
[ "${1:-}" = --memory-full ] && MEMFULL=1

echo "== offbox-server acceptance $(date -u +%FT%TZ)"
# ---------------------------------------------------------------- tools (need the network once)
need=()
have smartctl || need+=(smartmontools)
have stress-ng || need+=(stress-ng)
have sensors || need+=(lm-sensors)
have memtester || need+=(memtester)
have dmidecode || need+=(dmidecode)
if [ ${#need[@]} -gt 0 ]; then
  info "installing: ${need[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" >/dev/null 2>&1 || warn "could not install ${need[*]} (no network?); some checks will be skipped"
fi

# ---------------------------------------------------------------- what is this machine
info "board: $(cat /sys/class/dmi/id/board_vendor 2>/dev/null) $(cat /sys/class/dmi/id/board_name 2>/dev/null), BIOS $(cat /sys/class/dmi/id/bios_version 2>/dev/null) $(cat /sys/class/dmi/id/bios_date 2>/dev/null)"
cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)
info "cpu: $cpu, $(nproc) threads, kernel $(uname -r)"
case $cpu in *9950X3D*) pass "CPU is the Ryzen 9 9950X3D with $(nproc) threads" ;; *) warn "CPU is not reported as a 9950X3D: $cpu" ;; esac
[ "$(nproc)" = 32 ] || warn "expected 32 threads, see $(nproc) (SMT off in the BIOS?)"
memgb=$(awk '/MemTotal/{printf "%d", $2/1024/1024}' /proc/meminfo)
if have dmidecode; then
  dimms=$(dmidecode -t memory 2>/dev/null | grep -cE '^\s+Size: [0-9]+ GB')
  speeds=$(dmidecode -t memory 2>/dev/null | grep -E 'Configured Memory Speed: [0-9]' | sort | uniq -c | xargs)
  if [ "$dimms" = 4 ] && [ "$memgb" -ge 180 ]; then pass "memory: 4 DIMMs, ${memgb} GiB usable; $speeds"; else fail "memory: $dimms DIMMs populated, ${memgb} GiB usable (expected 4 DIMMs, ~187 GiB); $speeds"; fi
else
  [ "$memgb" -ge 180 ] && pass "memory: ${memgb} GiB usable" || fail "memory: only ${memgb} GiB usable (expected ~187)"
fi
sb=$(mokutil --sb-state 2>/dev/null | head -1)
info "secure boot: ${sb:-unknown}"

# ---------------------------------------------------------------- disks
mapfile -t nv < <(lsblk -dnpo NAME,TRAN | awk '$2=="nvme"{print $1}')
[ "${#nv[@]}" = 2 ] && pass "two NVMe disks: ${nv[*]}" || fail "expected two NVMe disks, found ${#nv[@]}: ${nv[*]}"
for d in "${nv[@]}"; do
  model=$(lsblk -dno MODEL "$d" | xargs); size=$(lsblk -bdno SIZE "$d")
  info "$d: $model, $((size / 1000000000)) GB, serial $(lsblk -dno SERIAL "$d")"
  if have smartctl; then
    s=$(smartctl -a "$d" 2>/dev/null)
    crit=$(echo "$s" | awk -F: '/Critical Warning/{print $2}' | xargs)
    temp=$(echo "$s" | awk -F: '/^Temperature:/{print $2}' | xargs | cut -d' ' -f1)
    used=$(echo "$s" | awk -F: '/Percentage Used/{print $2}' | xargs)
    merr=$(echo "$s" | awk -F: '/Media and Data Integrity Errors/{print $2}' | xargs)
    health=$(echo "$s" | awk -F: '/SMART overall-health/{print $2}' | xargs)
    if [ "$health" = PASSED ] && [ "$crit" = 0x00 ] && [ "${merr:-0}" = 0 ]; then
      pass "$d SMART: $health, critical warning $crit, media errors ${merr:-0}, wear $used, ${temp} C"
    else
      fail "$d SMART: health=$health critical=$crit media_errors=$merr wear=$used temp=$temp"
    fi
    [ -n "$temp" ] && [ "$temp" -ge 70 ] && warn "$d is ${temp} C at idle: check the M.2 heatsink"
  else
    warn "$d: smartctl not available, SMART not checked"
  fi
done
md=$(grep -cE '\[UU\]' /proc/mdstat)
if [ "$md" = 2 ] && ! grep -qE 'resync|recovery' /proc/mdstat; then pass "both mdraid arrays complete and in sync"; else fail "mdraid: $(grep -E '^md|blocks|resync|recovery' /proc/mdstat | xargs)"; fi
if have zpool && zpool list -H offbox >/dev/null 2>&1; then
  [ "$(zpool list -H -o health offbox)" = ONLINE ] && pass "pool offbox: ONLINE, $(zpool list -H -o size,alloc offbox | xargs)" || fail "pool offbox: $(zpool status -x offbox | head -3 | xargs)"
else
  info "pool offbox does not exist yet (bootstrap.zsh ... home creates it)"
fi

# ---------------------------------------------------------------- boot chain
efi=$(efibootmgr -v 2>/dev/null)
n=0
for d in "${nv[@]}"; do
  pu=$(blkid -o value -s PARTUUID "${d}p1")
  if echo "$efi" | grep -i "$pu" | grep -qi shimx64; then n=$((n + 1)); else fail "no firmware boot entry for the ESP on $d"; fi
done
order=$(echo "$efi" | sed -n 's/^BootOrder: //p')
[ "$n" = 2 ] && pass "firmware boot list has an entry for each disk's ESP (BootOrder: $order)"
# BootNext is what brings an interrupted install back to the stick (FAILURE-MODES 2.13a). Stored and
# cleared here; whether the firmware honours it at power-on shows in the stick's stage log of a re-install.
if echo "$efi" | grep -q '^BootNext'; then
  warn "a BootNext is still set ($(echo "$efi" | sed -n 's/^BootNext: //p')): the next boot will not follow the boot order"
else
  cur=$(echo "$efi" | sed -n 's/^BootCurrent: //p')
  if [ -n "$cur" ] && efibootmgr -n "$cur" >/dev/null 2>&1 && efibootmgr | grep -q "^BootNext: $cur" && efibootmgr -N >/dev/null 2>&1; then
    pass "the firmware stores and clears BootNext"
  else
    warn "the firmware did not accept BootNext: a power cut in the last minute of an install could start a half-configured system (FAILURE-MODES 2.13a)"
    efibootmgr -N >/dev/null 2>&1
  fi
fi
first=$(echo "$order" | cut -d, -f1)
echo "$efi" | grep "^Boot$first" | grep -qi shimx64 && pass "the first boot entry is the installed system" || warn "the first boot entry is not the installed system: $(echo "$efi" | grep "^Boot$first" | cut -c1-80)"
for d in "${nv[@]}"; do
  m=$(findmnt -n -o TARGET --source "${d}p1" | head -1); own=0
  if [ -z "$m" ]; then m=/run/offbox/acc-esp; mkdir -p "$m"; mount -o ro "${d}p1" "$m" && own=1; fi
  miss=
  for f in EFI/ubuntu/shimx64.efi EFI/ubuntu/grubx64.efi EFI/ubuntu/grub.cfg EFI/BOOT/BOOTX64.EFI EFI/offbox/installed; do [ -s "$m/$f" ] || miss="$miss $f"; done
  [ -z "$miss" ] && pass "ESP on $d has shim, grub, the removable fallback and the install mark" || fail "ESP on $d is missing:$miss"
  [ "$own" = 1 ] && umount "$m"
done

# ---------------------------------------------------------------- network
for i in /sys/class/net/e*; do
  [ -e "$i" ] || continue
  i=${i##*/}
  sp=$(cat "/sys/class/net/$i/speed" 2>/dev/null); drv=$(basename "$(readlink "/sys/class/net/$i/device/driver" 2>/dev/null)")
  car=$(cat "/sys/class/net/$i/carrier" 2>/dev/null)
  if [ "$car" = 1 ]; then
    if [ "${sp:-0}" -ge 2500 ]; then pass "$i ($drv): link at ${sp} Mb/s"; elif [ "${sp:-0}" -ge 1000 ]; then warn "$i ($drv): link at ${sp} Mb/s, not 2500 (router port or cable is 1 GbE)"; else fail "$i ($drv): link at only ${sp} Mb/s (bad cable?)"; fi
    err=$(cat "/sys/class/net/$i/statistics/rx_errors" "/sys/class/net/$i/statistics/tx_errors" 2>/dev/null | paste -sd+ | bc 2>/dev/null)
    [ "${err:-0}" = 0 ] || warn "$i: $err rx/tx errors since boot"
  else
    info "$i ($drv): no link"
  fi
done
ts=$(tailscale status --json 2>/dev/null | sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' | head -1)
[ "$ts" = Running ] && pass "tailscale: Running, $(tailscale ip -4 | head -1)" || fail "tailscale: state ${ts:-not installed}"
timedatectl show -p NTPSynchronized --value | grep -q yes && pass "clock synchronised (UTC)" || warn "clock not synchronised yet"

# ---------------------------------------------------------------- never-stays-off settings on the real hardware
wd=$(cat /sys/class/watchdog/watchdog0/identity 2>/dev/null)
wds=$(cat /sys/class/watchdog/watchdog0/state 2>/dev/null)
case "$wd/$wds" in
  *SP5100*/active | *sp5100*/active) pass "hardware watchdog: $wd, active, timeout $(cat /sys/class/watchdog/watchdog0/timeout) s  (prove it with --test-watchdog)" ;;
  */active) warn "watchdog is active but it is '$wd', not the chipset's sp5100_tco: $(dmesg | grep -i sp5100 | tail -2 | xargs)" ;;
  *) fail "no active hardware watchdog (identity '${wd:-none}', state '${wds:-none}'): $(dmesg | grep -i -E 'sp5100|watchdog' | tail -3 | xargs)" ;;
esac
if [ -w /sys/class/rtc/rtc0/wakealarm ]; then
  systemctl start offbox-rtcwake.service
  a=$(cat /sys/class/rtc/rtc0/wakealarm); ahead=$((a - $(date +%s)))
  [ "$ahead" -gt 300 ] && pass "RTC wake alarm armed ${ahead} s ahead  (prove it with --test-rtc-wake)" || fail "RTC wake alarm not armed (wakealarm='$a')"
else
  fail "the RTC has no writable wake alarm"
fi
[ "$(readlink -f /etc/systemd/system/poweroff.target)" = /usr/lib/systemd/system/reboot.target ] && pass "poweroff and halt restart the machine" || fail "poweroff.target is not aliased to reboot.target"
[ "$(sysctl -n kernel.panic)" = 10 ] && [ "$(sysctl -n kernel.panic_on_oops)" = 1 ] && pass "panic and oops restart after 10 s" || fail "kernel.panic / panic_on_oops not set"
h=$(cat "$STATE/health.json" 2>/dev/null)
case $h in *'"verdict":"healthy"'*) pass "boot health: $h" ;; *) warn "boot health not healthy (yet): ${h:-no verdict; it runs 4 minutes after boot}" ;; esac
f=$(systemctl --failed --no-legend --plain | awk '{print $1}' | xargs)
[ -z "$f" ] && pass "no failed systemd units" || fail "failed units: $f"
info "kernel trial: $(offbox-kernel-trial status | xargs)"
mce=$(dmesg | grep -ci -E 'mce:|machine check|hardware error|edac.*error')
[ "$mce" = 0 ] && pass "no machine-check / hardware errors in the kernel log" || fail "$mce machine-check / hardware error lines in dmesg: $(dmesg | grep -i -E 'mce:|machine check|hardware error' | head -2 | xargs)"

# ---------------------------------------------------------------- temperatures under load
cputemp() { # hottest k10temp reading, whole degrees
  local t max=0 f
  for f in /sys/class/hwmon/hwmon*/; do
    [ "$(cat "$f/name" 2>/dev/null)" = k10temp ] || continue
    for t in "$f"/temp*_input; do t=$(cat "$t" 2>/dev/null); [ -n "$t" ] && [ "$((t / 1000))" -gt "$max" ] && max=$((t / 1000)); done
  done
  echo "$max"
}
idle=$(cputemp)
if [ "$idle" = 0 ]; then
  warn "no k10temp sensor: CPU temperature not checked"
elif have stress-ng; then
  info "CPU idle ${idle} C; loading all $(nproc) threads for 120 s"
  stress-ng --cpu "$(nproc)" --cpu-method matrixprod --timeout 120s >/dev/null 2>&1 &
  peak=$idle
  for _ in $(seq 1 24); do sleep 5; t=$(cputemp); [ "$t" -gt "$peak" ] && peak=$t; done
  wait
  thr=$(dmesg | grep -ci 'thermal\|throttl')
  if [ "$peak" -le 92 ]; then pass "CPU under full load: peak ${peak} C (idle ${idle} C)"; elif [ "$peak" -le 96 ]; then warn "CPU peaks at ${peak} C under load: at the limit (cooler mounting / paste / fan curve)"; else fail "CPU reached ${peak} C under load: cooling problem"; fi
  [ "$thr" = 0 ] || info "$thr thermal/throttle lines in dmesg"
  for d in "${nv[@]}"; do
    have smartctl && info "$d after the load: $(smartctl -a "$d" 2>/dev/null | awk -F: '/^Temperature:/{print $2}' | xargs)"
  done
else
  warn "stress-ng not available: load test skipped (idle ${idle} C)"
fi

# ---------------------------------------------------------------- memory
if have stress-ng; then
  info "memory pass: 3 minutes over 75% of free RAM with verification (4 DIMMs at this speed is the riskiest part of the build)"
  if stress-ng --vm 8 --vm-bytes 75% --vm-method all --verify --timeout 180s --metrics-brief >/tmp/offbox-acc-vm.log 2>&1; then
    pass "memory: 3-minute verified pass over 75% of free RAM, no errors"
  else
    fail "memory: stress-ng reported errors: $(grep -i -E 'fail|error' /tmp/offbox-acc-vm.log | head -3 | xargs)"
  fi
  mce2=$(dmesg | grep -ci -E 'mce:|machine check|hardware error')
  [ "$mce2" = "$mce" ] || fail "new machine-check lines appeared during the tests"
fi
if [ "$MEMFULL" = 1 ]; then
  if have memtester; then
    mb=$(awk '/MemAvailable/{printf "%d", $2/1024*0.85}' /proc/meminfo)
    info "memtester ${mb}M, one pass: this takes hours"
    memtester "${mb}M" 1 >/tmp/offbox-acc-memtester.log 2>&1 && pass "memtester ${mb}M: one clean pass" || fail "memtester found errors: $(grep -i fail /tmp/offbox-acc-memtester.log | head -3 | xargs)"
  else
    warn "memtester not available"
  fi
else
  info "for the long memory test run again with --memory-full (hours), ideally overnight before the box carries work"
fi

echo "== $([ "$FAILS" = 0 ] && echo "ALL CHECKS PASSED" || echo "$FAILS CHECK(S) FAILED")"
echo "== still to do by hand, once each: --test-watchdog, --test-rtc-wake, and pulling the power cable (must start by itself)"
[ "$FAILS" = 0 ]
