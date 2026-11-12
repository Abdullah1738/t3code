#!/usr/bin/env python3
"""run.py: end-to-end tests of the offbox installer stick in a VM shaped like the home server.

  run.py build              build the stick tree + image from this checkout (needs ~/ohv/site, see README)
  run.py c1                 zero-touch fresh install; saves the result as the "golden" disks for the others
  run.py c2 ... c11         one case each (c2-c11 start from the golden disks, except c4 and c5)
  run.py all                everything, in order

Results: ~/ohv/results/<case>/ (test.log, result.json, serial console, the stick's log volume).
Exit code 0 only when every requested case passed.
"""
import base64
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from vm import FOREIGN_FILES, OVMF_VARS, VM, Fail, run  # noqa: E402

HOME_DIR = os.path.dirname(HERE)
SERVER_DIR = os.path.dirname(HOME_DIR)
ROOT = os.environ.get("OHV_ROOT", os.path.expanduser("~/ohv"))
WORK = os.path.join(ROOT, "work")
# OHV_GOLDEN_SUFFIX: development only, use another set of golden disks (e.g. a copy kept from an older build)
GOLD = os.path.join(ROOT, "golden" + os.environ.get("OHV_GOLDEN_SUFFIX", ""))
GOLD_POOL = os.path.join(ROOT, "golden-pool" + os.environ.get("OHV_GOLDEN_SUFFIX", ""))
RESULTS = os.path.join(ROOT, "results")
TREE = os.path.join(ROOT, "tree-out")
STICK = os.environ.get("OHV_STICK", os.path.join(ROOT, "stick-base.img"))
SITE = os.path.join(ROOT, "site")
GIB = 1024**3

CASE = None


class Case:
    def __init__(self, name, title):
        self.name = name
        self.title = title
        self.dir = os.path.join(RESULTS, name)
        shutil.rmtree(self.dir, ignore_errors=True)
        os.makedirs(self.dir)
        self.checks = []
        self.t0 = time.time()
        self.vms = []

    def log(self, msg):
        line = f"{time.strftime('%H:%M:%S')} [{self.name}] {msg}"
        print(line, flush=True)
        with open(os.path.join(self.dir, "test.log"), "a") as f:
            f.write(line + "\n")

    def check(self, ok, what, evidence=""):
        self.checks.append({"ok": bool(ok), "what": what, "evidence": str(evidence)[:400]})
        self.log(("  ok   " if ok else "  FAIL ") + what + (f"  [{str(evidence)[:200]}]" if evidence != "" else ""))
        return bool(ok)

    def vm(self, port, suffix=""):
        v = VM(WORK, self.name + suffix, port, self.log)
        shutil.rmtree(v.dir, ignore_errors=True)
        os.makedirs(v.dir)
        v.fwcfg = knobs()
        self.vms.append(v)
        return v

    def finish(self, error=None):
        for v in self.vms:
            try:
                if v.running():
                    v.power_cut()
                if os.path.exists(v.serial):
                    shutil.copy(v.serial, os.path.join(self.dir, f"serial-{v.name}.log"))
                if os.path.exists(v.stick):
                    v.stick_logs(os.path.join(self.dir, f"stick-log-{v.name}"))
            except Exception as e:  # noqa: BLE001
                self.log(f"collecting logs of {v.name} failed: {e}")
        failed = [c for c in self.checks if not c["ok"]]
        status = "PASS" if not failed and not error and self.checks else "FAIL"
        res = {"case": self.name, "title": self.title, "status": status, "seconds": int(time.time() - self.t0),
               "error": error, "checks": self.checks}
        with open(os.path.join(self.dir, "result.json"), "w") as f:
            json.dump(res, f, indent=1)
        self.log(f"RESULT {status}: {len(self.checks) - len(failed)}/{len(self.checks)} checks ok"
                 + (f"; error: {error}" if error else "") + f"; {int(time.time() - self.t0)}s")
        return status == "PASS"


def testkey():
    key = os.path.join(WORK, "testkey")
    if not os.path.exists(key):
        os.makedirs(WORK, exist_ok=True)
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key])
    return " ".join(open(key + ".pub").read().split()[:2])


def knobs():
    """Test-only settings, handed to the guest through QEMU fw_cfg. Real hardware has no fw_cfg."""
    return {
        "ssh_test_key": testkey(),
        "hold_seconds": 90,
        "refuse_boot_seconds": 15,
        "error_hold_seconds": 60,
        "marker_reboot_delay": 5,
        "emergency_hold_seconds": 100,
        "emergency_net_wait": 8,
    }


# ------------------------------------------------------------------------------------------ shared checks
def sshv(vm, cmd, **kw):
    return vm.ssh(cmd, **kw)[1].strip()


def verify_install(c, vm, expect_mode=None):
    """The layout and settings the brief specifies, read from the running installed system."""
    out = sshv(vm, "lsblk -b -J -o NAME,SIZE,TYPE,FSTYPE,PARTLABEL,PARTTYPE,MOUNTPOINTS /dev/nvme0n1 /dev/nvme1n1")
    disks = json.loads(out)["blockdevices"]
    c.check(len(disks) == 2 and disks[0]["size"] == disks[1]["size"], "two NVMe disks of equal size",
            [d["size"] for d in disks])
    want = [("offbox-esp", 1 * GIB, "vfat"), ("offbox-boot", 2 * GIB, "linux_raid_member"),
            ("offbox-root", 150 * GIB, "linux_raid_member"), ("offbox-zfs", None, None)]
    for d in disks:
        parts = d.get("children", [])
        ok = len(parts) == 4
        ev = []
        for p, (label, size, fstype) in zip(parts, want):
            ev.append(f"{p['name']}:{p['partlabel']}:{p['size'] // (1024 * 1024)}M:{p['fstype']}")
            ok = ok and p["partlabel"] == label and (size is None or p["size"] == size)
            ok = ok and (fstype is None or p["fstype"] == fstype)
        if ok:
            types = [p["parttype"].lower() for p in parts]
            ev.append("types=" + ",".join(t[:8] for t in types))
            ok = parts[3]["size"] > 1700 * GIB and types == [
                "c12a7328-f81f-11d2-ba4b-00a0c93ec93b", "a19d880f-05fc-4d3b-a006-743f0f84911e",
                "a19d880f-05fc-4d3b-a006-743f0f84911e", "6a898cc3-1dd2-11b2-99a6-080020736631"]
        c.check(ok, f"{d['name']}: GPT with ESP 1 GiB, /boot 2 GiB, / 150 GiB, rest offbox-zfs", " ".join(ev))
    mounts = sshv(vm, "for m in / /boot /boot/efi; do findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS --mountpoint $m; done")
    md = sshv(vm, "cat /proc/mdstat")
    root_src = sshv(vm, "findmnt -n -o SOURCE /")
    boot_src = sshv(vm, "findmnt -n -o SOURCE /boot")
    det = sshv(vm, f"mdadm --detail {root_src} | egrep 'Raid Level|Raid Devices|nvme'; mdadm --detail {boot_src} | egrep 'Raid Level|Raid Devices|nvme'")
    meta = sshv(vm, f"mdadm --detail {boot_src} | sed -n 's/^ *Version : //p'; mdadm --detail {root_src} | sed -n 's/^ *Version : //p'").split()
    c.check(meta == ["1.0", "1.2"], "/boot array has its RAID superblock at the end (metadata 1.0), / uses 1.2", " ".join(meta))
    c.check(root_src.startswith("/dev/md") and boot_src.startswith("/dev/md") and root_src != boot_src
            and det.count("raid1") == 2 and det.count("nvme0n1p3") == 1 and det.count("nvme1n1p3") == 1
            and det.count("nvme0n1p2") == 1 and det.count("nvme1n1p2") == 1,
            "/ and /boot are mdraid1 over partition 3 and 2 of both disks", f"/={root_src} /boot={boot_src}")
    fs = {l.split()[0]: l.split()[2] for l in mounts.splitlines() if len(l.split()) >= 3}
    c.check(fs == {"/": "ext4", "/boot": "ext4", "/boot/efi": "vfat"} and md.count("[UU]") == 2,
            "/ and /boot ext4, /boot/efi vfat, both arrays complete", mounts.replace("\n", " | ")[:300])
    fstab = sshv(vm, "grep -v '^#' /etc/fstab")
    nofail = all("nofail" in l for l in fstab.splitlines() if l.split()[1:2] and l.split()[1] in ("/boot", "/boot/efi"))
    c.check(nofail and "swap" not in fstab, "fstab: /boot and /boot/efi are nofail, no swap", fstab.replace("\n", " | ")[:300])
    c.check(sshv(vm, "swapon --show | wc -l") == "0", "no swap active")
    esp = sshv(vm, "mkdir -p /run/t2; for p in /dev/nvme0n1p1 /dev/nvme1n1p1; do m=$(findmnt -n -o TARGET --source $p | head -1); o=0; "
                   "if [ -z \"$m\" ]; then mount -o ro $p /run/t2; m=/run/t2; o=1; fi; "
                   "for f in EFI/ubuntu/shimx64.efi EFI/ubuntu/grubx64.efi EFI/ubuntu/grub.cfg EFI/BOOT/BOOTX64.EFI EFI/offbox/installed EFI/offbox/grubenv; do "
                   "[ -s $m/$f ] && echo ok || echo MISSING:$p:$f; done; sha256sum $m/EFI/ubuntu/grubx64.efi | cut -c1-16; [ $o = 1 ] && umount /run/t2; done; true")
    lines = esp.splitlines()
    hashes = [l for l in lines if l not in ("ok",) and not l.startswith("MISSING")]
    c.check("MISSING" not in esp and lines.count("ok") == 12 and len(set(hashes)) == 1,
            "both ESPs carry shim, grub, the removable fallback path and the finished-install mark; same grub on both",
            esp.replace("\n", " ")[-200:])
    efi = sshv(vm, "efibootmgr -v")
    order = [l for l in efi.splitlines() if l.startswith("BootOrder")]
    pu = sshv(vm, "blkid -o value -s PARTUUID /dev/nvme0n1p1; blkid -o value -s PARTUUID /dev/nvme1n1p1").split()
    ents = {}
    for l in efi.splitlines():
        for i, u in enumerate(pu):
            if u.lower() in l.lower() and "shimx64" in l.lower():
                ents[i] = l[4:8]
    first_two = order[0].split()[1].split(",")[:2] if order else []
    c.check(len(ents) == 2 and sorted(first_two) == sorted(ents.values()),
            "firmware has a boot entry for each disk's ESP, and they come first in BootOrder",
            f"{order[0] if order else ''} entries={ents}")
    c.check("BootNext" not in efi, "the installer's pin on the stick (BootNext) is gone: the firmware follows its boot order again")
    c.check(sshv(vm, "hostname") == "offbox-server", "hostname is offbox-server")
    kern = sshv(vm, "uname -r")
    hwe = sshv(vm, "dpkg -l linux-generic-hwe-24.04 2>/dev/null | grep -c ^ii", check=False)
    c.check(hwe == "1" and not kern.startswith("6.8."), "HWE kernel installed and running", kern)
    cmdline = sshv(vm, "cat /proc/cmdline")
    c.check("panic=10" in cmdline and "fsck.repair=yes" in cmdline and "quiet" not in cmdline,
            "kernel command line: panic=10, fsck.repair=yes", cmdline)
    sshd = sshv(vm, "sshd -T 2>/dev/null | egrep '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|listenaddress) '")
    c.check("permitrootlogin without-password" in sshd or "permitrootlogin prohibit-password" in sshd,
            "sshd: root by key only", sshd.replace("\n", " "))
    c.check("passwordauthentication no" in sshd and "0.0.0.0:22" in sshd, "sshd: no passwords, all interfaces")
    want_hash = open(os.path.join(SITE, "root-password.hash")).read().strip()
    c.check(sshv(vm, "getent shadow root | cut -d: -f2") == want_hash, "root console password hash is the one from the stick")
    want_key = open(os.path.join(SITE, "authorized_keys")).read().split()[1]
    c.check(want_key in sshv(vm, "cat /root/.ssh/authorized_keys"), "root's authorized_keys has the offbox key")
    c.check(sshv(vm, "ls /home | wc -l") == "0", "no other user accounts in /home")
    rc, loc = vm.ssh("LC_ALL=en_US.UTF-8 bash -c 'echo ok' 2>&1", check=False)
    c.check(loc.strip() == "ok", "en_US.UTF-8 exists (no setlocale warning for ssh clients that send it)", loc.strip()[:120])
    td = sshv(vm, "timedatectl show -p Timezone -p LocalRTC -p NTP; systemctl is-enabled systemd-timesyncd")
    c.check("Timezone=Etc/UTC" in td and "LocalRTC=no" in td and "NTP=yes" in td, "UTC clock with timesyncd", td.replace("\n", " "))
    inst = sshv(vm, "cat /etc/offbox/installed")
    c.check("mode=" in inst and (expect_mode is None or f"mode={expect_mode}" in inst), "finished-install record", inst)
    grubd = sshv(vm, "offbox-kernel-trial status")
    booted = sshv(vm, "offbox-status | sed -n 's/.*booted_image=//p' | cut -d' ' -f1")
    c.check(f"good={booted}" in grubd and "gnulinux-" in grubd, "known-good kernel recorded and set as the GRUB default", grubd.replace("\n", " "))
    units = sshv(vm, "systemctl is-enabled offbox-boot-report.service offbox-tailscale-join.timer offbox-rtcwake.timer "
                     "offbox-rtcwake-shutdown.service offbox-boot-health.timer offbox-emergency-agent.service "
                     "offbox-watchdog.service tailscaled unattended-upgrades 2>&1 | sort | uniq -c")
    c.check(units.strip().endswith("enabled") and len(units.splitlines()) == 1, "offbox units, tailscaled and unattended-upgrades enabled", units)
    wd = sshv(vm, "cat /sys/class/watchdog/watchdog0/identity /sys/class/watchdog/watchdog0/state /sys/class/watchdog/watchdog0/timeout 2>&1")
    c.check("active" in wd and "60" in wd, "hardware watchdog armed by systemd, 60 s", wd.replace("\n", " "))
    sysctl = sshv(vm, "sysctl -n kernel.panic kernel.panic_on_oops")
    c.check(sysctl.split() == ["10", "1"], "kernel.panic=10, panic_on_oops=1", sysctl.replace("\n", " "))
    tg = sshv(vm, "readlink -f /etc/systemd/system/poweroff.target /etc/systemd/system/halt.target; systemctl is-enabled suspend.target hibernate.target 2>&1", check=False)
    c.check(tg.count("reboot.target") == 2 and tg.count("masked") == 2, "poweroff/halt point at reboot, sleep targets masked", tg.replace("\n", " "))
    c.check(sshv(vm, "[ -e /etc/cloud/cloud-init.disabled ] && echo y") == "y", "cloud-init disabled on the installed system")
    src = sshv(vm, "grep -h URIs /etc/apt/sources.list.d/ubuntu.sources | sort -u | tr '\\n' ' '")
    c.check("archive.ubuntu.com" in src and "security.ubuntu.com" in src and "127.0.0.1" not in src, "apt sources are the real archive", src)
    state = ""
    for _ in range(40):
        state = sshv(vm, "systemctl is-system-running", check=False)
        if state != "starting":
            break
        time.sleep(5)
    failed = sshv(vm, "systemctl --failed --no-legend --plain | awk '{print $1}' | tr '\\n' ' '")
    c.check(state == "running" and failed == "", "systemd: running, no failed units", f"{state} failed=[{failed}]")
    return inst


def wait_md_sync(c, vm, timeout=3600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        md = sshv(vm, "cat /proc/mdstat")
        if "resync" not in md and "recovery" not in md and md.count("[UU]") == 2:
            c.log(f"mdraid in sync after {int(time.time() - t0)}s")
            return True
        time.sleep(15)
    raise Fail("mdraid did not finish syncing")


def stage_lines(text, word):
    return [l for l in text.splitlines() if f" {word} " in l + " "]


def install_fresh(c, vm, **start):
    vm.fresh_disks()
    vm.fresh_stick(STICK)
    vm.start(**start)


def need_golden(pool=False):
    g = GOLD_POOL if pool else GOLD
    if not os.path.exists(os.path.join(g, "nvme0.qcow2")):
        raise Fail(f"{g} missing: run c1 first" + (" and then golden-pool" if pool else ""))
    return g


def make_pool(vm):
    """What install-host.sh will do later: a ZFS mirror named offbox on the two offbox-zfs partitions."""
    vm.ssh("zpool list offbox >/dev/null 2>&1 || zpool create -f -o ashift=12 -O compression=lz4 offbox mirror /dev/nvme0n1p4 /dev/nvme1n1p4", timeout=300)
    vm.ssh("echo offbox-pool-marker-$(cat /proc/sys/kernel/random/uuid) > /offbox/MARKER; "
           "dd if=/dev/urandom of=/offbox/blob bs=1M count=64 status=none; sha256sum /offbox/blob | cut -d' ' -f1 > /offbox/blob.sha; sync; zpool sync offbox")
    return sshv(vm, "cat /offbox/MARKER; cat /offbox/blob.sha")


def pool_marker(vm, do_import=True):
    if do_import:
        vm.ssh("zpool list offbox >/dev/null 2>&1 || zpool import -f offbox", check=False, timeout=300)
    rc, out = vm.ssh("cat /offbox/MARKER && sha256sum /offbox/blob | cut -d' ' -f1 && zpool status -x offbox", check=False)
    return out.strip()


# ------------------------------------------------------------------------------------------ cases
def build(_):
    os.makedirs(ROOT, exist_ok=True)
    for f in ("authorized_keys", "root-password.hash"):
        if not os.path.exists(os.path.join(SITE, f)):
            raise SystemExit(f"{SITE}/{f} missing (copy the site files from the Mac first)")
    print(run(["bash", os.path.join(HOME_DIR, "build-tree.sh"), "--cache", os.path.join(ROOT, "cache"), "--site", SITE, "--out", TREE]))
    print(run(["bash", os.path.join(HERE, "mkimage.sh"), TREE, os.path.join(ROOT, "stick-base.img")]))
    return True


def c1(c):
    vm = c.vm(2201)
    install_fresh(c, vm)
    t0 = time.time()
    seen_installer = None
    while time.time() - t0 < 3600:
        if not vm.running():
            raise Fail("machine switched off during the install")
        kind, _ = vm.who()
        if kind == "installer" and seen_installer is None:
            seen_installer = int(time.time() - t0)
            c.log(f"installer session answers on SSH after {seen_installer}s")
            c.log("installer says: " + sshv(vm, "cat /run/offbox/stage; hostname; systemctl is-active offbox-live", check=False).replace("\n", " "))
        if kind == "installed":
            break
        time.sleep(5)
    else:
        raise Fail("no installed system after 60 minutes")
    c.check(True, "zero-touch: power on with blank disks ended in a running installed system", f"{int(time.time() - t0)}s after power-on")
    c.check(seen_installer is not None, "installer session was reachable over SSH with the key during the install", f"first answer after {seen_installer}s")
    serial = vm.serial_text()
    c.check("offbox: installed=0 marker=0 -> install" in serial, "stick GRUB chose the installer by itself", "console: installed=0 marker=0 -> install")
    c.check(serial.count("power on #") == 1, "one power-on only: the machine restarted itself into the installed system")
    c1_checks(c, vm)


def c1_checks(c, vm):
    verify_install(c, vm, expect_mode="full")
    ts = sshv(vm, "dpkg -s tailscale | grep -E '^(Status|Version)' | tr '\\n' ' '; journalctl -b -u offbox-tailscale-join --no-pager | tail -2")
    c.check("install ok installed" in ts, "tailscale installed from the stick", ts.replace("\n", " ")[:200])
    wait_md_sync(c, vm)
    rep = sshv(vm, "cat /var/lib/offbox/boot-report.txt | head -5")
    c.check("offbox-server boot report" in rep, "first-boot report written", rep.splitlines()[0])
    vm.clean_stop()
    stage = vm.stick_logs(os.path.join(c.dir, "stick-log"))
    names = [l.split()[2] for l in stage.splitlines() if len(l.split()) > 2]
    c.check(all(s in names for s in ("live-start", "early-start", "plan", "prepare-done", "early-done", "late-start", "firmware", "late-done")),
            "stick stage log has every installer stage", " ".join(names))
    c.check(any("installed-system boot" in l for l in stage.splitlines()), "installed system appended its first-boot report to the stick")
    d = os.path.join(c.dir, "stick-log", "logs")
    boots = [b for b in sorted(os.listdir(d)) if b != "seq"] if os.path.isdir(d) else []
    files = os.listdir(os.path.join(d, boots[0])) if boots else []
    inv = os.listdir(os.path.join(d, boots[0], "inventory")) if boots and "inventory" in files else []
    c.check(all(f in files for f in ("journal.txt", "installer-logs.tgz", "plan.json", "autoinstall.generated.yaml", "subiquity-server-debug.log"))
            and all(f in inv for f in ("lsblk.txt", "lspci.txt", "ip.txt", "dmesg.txt")),
            "stick has full logs + hardware inventory of the install", f"{boots} {sorted(files)}")
    vm.save_golden(GOLD)
    c.log(f"golden disks saved in {GOLD}")


def recheck_c1(c):
    """Development helper: boot the disks a c1 run left in work/c1 and repeat only the checks."""
    vm = VM(WORK, "c1", 2201, c.log)
    vm.fwcfg = knobs()
    c.vms.append(vm)
    vm.start()
    vm.wait_ssh("installed", 900)
    c1_checks(c, vm)


def golden_pool(c):
    """Helper state for c3 and c6: the golden install plus a ZFS pool with known content."""
    g = need_golden()
    vm = c.vm(2202)
    vm.from_golden(g)
    vm.start()
    vm.wait_ssh("installed", 900)
    marker = make_pool(vm)
    c.check("offbox-pool-marker" in marker, "pool offbox created on the two offbox-zfs partitions", sshv(vm, "zpool status offbox | grep -E 'state|nvme' | tr -s ' \\n' ' '"))
    vm.clean_stop()
    vm.save_golden(GOLD_POOL)
    with open(os.path.join(GOLD_POOL, "marker.txt"), "w") as f:
        f.write(marker + "\n")


def c2(c):
    g = need_golden(pool=True)
    want = open(os.path.join(g, "marker.txt")).read().strip()
    port = 2240
    for stick in (False, True):
        for gone in (0, 1):
            port += 1
            vm = c.vm(port, f"-no-nvme{gone}-{'stick' if stick else 'nostick'}")
            vm.from_golden(g)
            keep = (1 - gone,)
            t0 = time.time()
            vm.start(disks=keep, stick=stick, stick_first=stick)   # with the stick: the firmware prefers it
            label = f"without nvme{gone} ({'stick in and first in the boot order' if stick else 'no stick'})"
            try:
                vm.wait_ssh("installed", 900)
                if stick:
                    ser = vm.serial_text()
                    c.check("offbox: installed=1 marker=0 -> disk" in ser and "offbox: loading the installed system's boot menu" in ser,
                            f"{label}: the stick's GRUB found the install on the remaining disk and started it",
                            "console: installed=1 marker=0 -> disk, loading the installed system's boot menu")
                md = sshv(vm, "cat /proc/mdstat | grep -E '^md|blocks' | tr -s ' \\n' ' '")
                state = sshv(vm, "systemctl is-system-running; findmnt -n -o SOURCE /; findmnt -n -o SOURCE /boot; cat /etc/offbox/installed | cut -c1-40", check=False)
                c.check(md.count("[U_]") + md.count("[_U]") == 2 and state.count("/dev/md") == 2,
                        f"boots unattended {label}, both arrays degraded and mounted", f"{int(time.time() - t0)}s; {md}")
                pool = ""
                for _ in range(40):
                    pool = sshv(vm, "zpool list -H -o name,health offbox 2>&1 | tr '\\t' ' '", check=False)
                    if pool.startswith("offbox "):
                        break
                    time.sleep(5)
                marker = pool_marker(vm, do_import=False)
                c.check(pool == "offbox DEGRADED" and marker.startswith(want),
                        f"{label}: the pool was imported degraded by itself and its data reads back", f"{pool}; {marker.splitlines()[0][:50]}")
            except Fail as e:
                c.check(False, f"boots unattended {label}", e)
            vm.power_cut()
    # firmware settings lost (CMOS cleared / board swapped): no boot entries, only the removable path on the ESPs
    for stick in (False, True):
        port += 1
        vm = c.vm(port, f"-cmos-cleared-{'stick' if stick else 'nostick'}")
        vm.from_golden(g)
        shutil.copy(OVMF_VARS, vm.vars)
        t0 = time.time()
        vm.start(stick=stick)
        try:
            vm.wait_ssh("installed", 900)
            efi = sshv(vm, "efibootmgr | grep -c -i ubuntu", check=False)
            via = "stick GRUB" if "offbox: loading the installed system's boot menu" in vm.serial_text() else "firmware fallback path on the disks"
            c.check(True, f"firmware boot entries wiped ({'stick in' if stick else 'no stick'}): still boots the installed system by itself",
                    f"{int(time.time() - t0)}s via {via}; 'ubuntu' entries seen by the OS after boot: {efi}")
            vm.ssh("systemctl start offbox-boot-health.service", timeout=400)
            n = sshv(vm, "efibootmgr -v | grep -c -i shimx64", check=False)
            first = sshv(vm, "efibootmgr -v | grep -i shimx64 | cut -c5-8 | paste -sd, -; efibootmgr | sed -n 's/^BootOrder: //p'", check=False).split()
            c.check(n == "2" and len(first) == 2 and sorted(first[1].split(",")[:2]) == sorted(first[0].split(",")),
                    f"({'stick in' if stick else 'no stick'}) the health check then put the boot entries for both disks back, first in the boot order",
                    " / ".join(first))
        except Fail as e:
            c.check(False, f"firmware boot entries wiped ({'stick in' if stick else 'no stick'}): boots", e)
        vm.power_cut()
    # only one (blank) NVMe present: the installer must not install on half a mirror
    vm = c.vm(port + 1, "-one-blank-disk")
    vm.fresh_disks()
    vm.fresh_stick(STICK)
    vm.start(disks=(0,))
    vm.wait_serial(" abort ", 900)
    kind = None
    for _ in range(30):
        kind, _b = vm.who()
        if kind == "installer":
            break
        time.sleep(4)
    plan = sshv(vm, "python3 -c 'import json; p=json.load(open(\"/run/offbox/plan.json\")); print(p[\"action\"], \"|\", p[\"reason\"])'", check=False)
    since = vm.serial_size()
    c.check(plan.startswith("abort | need exactly two NVMe disks, found 1") and kind == "installer"
            and " prepare-start " not in vm.serial_text(),
            "one NVMe missing at install time: installer aborts, changes nothing, stays reachable over SSH", plan[:120])
    vm.wait_serial(" abort ", 900, since)
    c.check(True, "after the hold it restarts by itself and decides again (so adding the disk later needs no other action)",
            "second 'abort' stage line after an automatic restart")
    vm.power_cut()


def c3(c):
    g = need_golden(pool=True)
    want = open(os.path.join(g, "marker.txt")).read().strip()
    vm = c.vm(2203)
    vm.from_golden(g)
    before = vm.stick_logs(os.path.join(c.dir, "stick-before"))
    vm.start(stick_first=True)   # worst case: the firmware prefers the stick on every boot
    boot = vm.wait_ssh("installed", 900)
    inst0 = sshv(vm, "cat /etc/offbox/installed; cat /etc/machine-id")
    for i in range(1, 4):
        since = vm.serial_size()
        vm.ssh("systemctl reboot", check=False, timeout=20)
        boot = vm.wait_ssh("installed", 900, not_boot=boot)
        inst = sshv(vm, "cat /etc/offbox/installed; cat /etc/machine-id")
        marker = pool_marker(vm, do_import=False)
        ser = vm.serial_text(since)
        c.check(inst == inst0 and "offbox: installed=1 marker=0 -> disk" in ser and "offbox: loading the installed system's boot menu" in ser and "did not start a system" not in ser,
                f"reboot {i} with the stick first in the boot order: stick GRUB started the installed system, same install",
                "console: installed=1 marker=0 -> disk, loading the installed system's boot menu; " + inst.splitlines()[0][:50])
        c.check(marker.startswith(want) and "healthy" in marker, f"reboot {i}: file on the pool partition intact, pool healthy", marker.replace("\n", " ")[:160])
    vm.clean_stop()
    after = vm.stick_logs(os.path.join(c.dir, "stick-log"))
    c.check(len(stage_lines(after, "early-start")) == len(stage_lines(before, "early-start"))
            and len(stage_lines(after, "live-start")) == len(stage_lines(before, "live-start")),
            "the installer never ran again", f"live-start lines before={len(stage_lines(before, 'live-start'))} after={len(stage_lines(after, 'live-start'))}")


def c4(c):
    vm = c.vm(2204)
    install_fresh(c, vm)
    # timing of a normal install in this VM: prepare 33 s, early-done -> late-start 170 s, late-start -> late-done 20 s
    cuts = [("while the disks are being cleared", " prepare-start ", 2), ("during partitioning/RAID creation", " early-done ", 25),
            ("while the system is being copied", " early-done ", 100),
            # Ubuntu's installer has just installed GRUB and registered the disks with the firmware, first in
            # the boot order; our late step has not started. BootNext must bring the next boot back to the stick.
            ("right after the installer registered the half-finished disks with the firmware", "subiquity/Install/install/postinstall: final system configuration", 3),
            ("during the final configuration", " late-start ", 9)]
    for i, (what, pat, delay) in enumerate(cuts, 1):
        since = vm.serial_size()
        try:
            vm.wait_serial(pat, 2400, since)
            time.sleep(delay)
            running = vm.running()
            vm.power_cut()
            c.check(running, f"cut {i}: power cut {what}", f"{delay}s after console line '{pat.strip()}'")
        except Fail as e:
            c.check(False, f"cut {i}: reach '{pat.strip()}' after the previous cut", e)
            return
        vm.start()
    boot = vm.wait_ssh("installed", 3600)
    c.check(True, "after 5 power cuts the next power-on ended in a running installed system")
    verify_install(c, vm, expect_mode="full")
    vm.clean_stop()
    st = vm.stick_logs(os.path.join(c.dir, "stick-log"))
    c.check(len(stage_lines(st, "live-start")) == 6 and len(stage_lines(st, "late-done")) == 1,
            "stick stage log tells the story: 6 installer boots, 1 finished", f"live-start={len(stage_lines(st, 'live-start'))} late-done={len(stage_lines(st, 'late-done'))}")
    # one more: right after the installer finished, before/while it restarts
    vm2 = c.vm(2214, "-after-done")
    install_fresh(c, vm2)
    vm2.wait_serial(" late-done ", 3600)
    time.sleep(1)
    vm2.power_cut()
    vm2.start()
    vm2.wait_ssh("installed", 900)
    stage = sshv(vm2, "cat /etc/offbox/installed")
    ser = vm2.serial_text()
    c.check(ser.count(" early-start ") == 1, "cut 6 (just after the last installer step): next power-on boots the install, no second install",
            f"early-start seen {ser.count(' early-start ')}x; {stage[:60]}")
    vm2.power_cut()
    # and one in the last window: the finished-install mark is written, the disks are not yet bootable for the
    # firmware (test hook: the installer pauses there so the cut can be placed)
    vm3 = c.vm(2225, "-after-mark")
    vm3.fwcfg["late_pause_after_mark"] = 45
    install_fresh(c, vm3)
    vm3.wait_serial(" marked ", 3600)
    time.sleep(10)
    vm3.power_cut()
    since = vm3.serial_size()
    vm3.start()
    boot3 = vm3.wait_ssh("installed", 900)
    ser = vm3.serial_text(since)
    c.check("offbox: installed=1 marker=0 -> disk" in ser and "offbox: loading the installed system's boot menu" in ser
            and vm3.serial_text().count(" early-start ") == 1,
            "cut 7 (finished mark written, disks not yet bootable for the firmware): the stick starts the finished install, no second install",
            "console: installed=1 marker=0 -> disk, loading the installed system's boot menu")
    before = sshv(vm3, "efibootmgr -v | grep -c -i shimx64; ls /boot/efi/EFI/BOOT/BOOTX64.EFI 2>&1 | grep -c 'No such'", check=False).split()
    vm3.ssh("systemctl start offbox-boot-health.service", timeout=400)
    c.check(before == ["0", "1"], "cut 7: as expected the firmware had no boot entry and no removable path for the disks", " ".join(before))
    verify_install(c, vm3, expect_mode="full")
    vm3.clean_stop()
    vm3.start(stick=False)
    vm3.wait_ssh("installed", 900, not_boot=boot3)
    c.check(True, "cut 7: after the first healthy boot the install is complete: it boots from the disks alone, without the stick")
    vm3.power_cut()


def c5(c):
    vm = c.vm(2205)
    install_fresh(c, vm, net=False)
    vm.wait_serial(" late-done ", 3600)
    ser = vm.serial_text()
    c.check(" live-reachable " not in ser and " late-done " in ser, "install finished with the network cable out (no carrier from power-on)",
            "console: late-done, and the installer never reported an address")
    since = vm.serial_size()
    vm.wait_serial("offbox-server login:", 900, since)
    kind, _ = vm.who()
    c.check(kind is None, "installed system is up (console login prompt) and, with the cable out, not reachable")
    time.sleep(20)
    t0 = time.time()
    vm.link(True)
    vm.wait_ssh("installed", 300)
    c.check(True, "comes online by itself when the cable is plugged in", f"SSH answers {int(time.time() - t0)}s after link up")
    verify_install(c, vm, expect_mode="full")
    apt = sshv(vm, "apt-get update -qq 2>&1 | tail -2; apt-cache policy linux-generic-hwe-24.04 | sed -n 2,3p | tr -s ' \\n' ' '", check=False, timeout=300)
    c.check("Err" not in apt and "Candidate" in apt, "apt works against the real archive once online", apt[-160:])
    vm.clean_stop()
    st = vm.stick_logs(os.path.join(c.dir, "stick-log"))
    d = os.path.join(c.dir, "stick-log", "logs")
    boots = [b for b in sorted(os.listdir(d)) if b != "seq"] if os.path.isdir(d) else []
    files = os.listdir(os.path.join(d, boots[0])) if boots else []
    c.check(len(stage_lines(st, "late-done")) == 1 and "installer-logs.tgz" in files and "journal.txt" in files,
            "logs of the offline install are on the stick", sorted(files))
    c.check(any("installed-system boot" in l for l in st.splitlines()) and os.path.isdir(os.path.join(c.dir, "stick-log", "installed")),
            "installed system wrote its boot report to the stick without any network")


def put_marker(vm, name):
    vm.ssh("mkdir -p /run/sl && p=$(lsblk -lnpo NAME,LABEL | awk '$2==\"OFFBOXLOG\"{print $1}') && mount $p /run/sl && "
           f"touch /run/sl/{name} && sync && umount /run/sl")


def wait_new_install(c, vm, old, timeout=3600):
    """Wait until the installed system answers with a different finished-install record."""
    t0 = time.time()
    seen = set()
    while time.time() - t0 < timeout:
        if not vm.running():
            raise Fail("machine switched off")
        kind, _ = vm.who()
        if kind and kind not in seen:
            seen.add(kind)
        if kind == "installed":
            rc, inst = vm.ssh("cat /etc/offbox/installed", check=False)
            if rc == 0 and inst.strip() and inst.strip() != old:
                return inst.strip()
        time.sleep(5)
    raise Fail(f"no new install within {timeout}s")


def c6(c):
    g = need_golden(pool=True)
    want = open(os.path.join(g, "marker.txt")).read().strip()
    # --- REINSTALL-OS, the way it will really be done: drop the file on the stick, restart the box
    vm = c.vm(2206)
    vm.from_golden(g)
    vm.start()
    vm.wait_ssh("installed", 900)
    old = sshv(vm, "cat /etc/offbox/installed")
    hk = sshv(vm, "cat /etc/ssh/ssh_host_ed25519_key.pub")
    # sorted: which disk the kernel calls nvme0n1 can differ from boot to boot
    pu = sorted(sshv(vm, "blkid -o value -s PARTUUID /dev/nvme0n1p4 /dev/nvme1n1p4").split())
    vm.ssh("touch /root/old-root-file")
    put_marker(vm, "REINSTALL-OS")
    vm.ssh("systemctl reboot", check=False, timeout=20)
    new = wait_new_install(c, vm, old)
    c.check("mode=preserve" in new, "REINSTALL-OS on the stick + restart -> the OS was reinstalled by itself", new[:70])
    marker = pool_marker(vm)
    c.check(marker.startswith(want) and "healthy" in marker, "REINSTALL-OS: pool content intact (marker file and 64 MB blob checksum), pool healthy",
            marker.replace("\n", " ")[:160])
    pu2 = sorted(sshv(vm, "blkid -o value -s PARTUUID /dev/nvme0n1p4 /dev/nvme1n1p4").split())
    c.check(len(pu) == 2 and pu2 == pu, "REINSTALL-OS: both offbox-zfs partitions are the same partitions", f"{pu} -> {pu2}")
    c.check(sshv(vm, "ls /root/old-root-file 2>&1 | grep -c 'No such'") == "1", "REINSTALL-OS: the root file system is new")
    c.check(sshv(vm, "cat /etc/ssh/ssh_host_ed25519_key.pub") == hk, "REINSTALL-OS: ssh host key carried over from the old install")
    verify_install(c, vm, expect_mode="preserve")
    left = sshv(vm, "mkdir -p /run/sl && p=$(lsblk -lnpo NAME,LABEL | awk '$2==\"OFFBOXLOG\"{print $1}') && mount -o ro $p /run/sl && ls /run/sl | grep -ci -E 'reinstall|wipe'; umount /run/sl", check=False)
    c.check(left.splitlines()[0] == "0", "REINSTALL-OS: the marker file was removed from the stick")
    # --- WIPE-EVERYTHING on the same machine
    vm.ssh("zpool export offbox", check=False)
    old = new
    put_marker(vm, "WIPE-EVERYTHING")
    vm.ssh("systemctl reboot", check=False, timeout=20)
    new = wait_new_install(c, vm, old)
    c.check("mode=full" in new, "WIPE-EVERYTHING on the stick + restart -> full install by itself", new[:70])
    z = sshv(vm, "zpool import 2>&1 | head -3; blkid -p -o value -s TYPE /dev/nvme0n1p4 /dev/nvme1n1p4 | wc -l", check=False)
    c.check("no pools available" in z and z.splitlines()[-1] == "0", "WIPE-EVERYTHING: the pool is gone from both disks", z.replace("\n", " "))
    c.check(sshv(vm, "cat /etc/ssh/ssh_host_ed25519_key.pub") != hk, "WIPE-EVERYTHING: new machine identity")
    verify_install(c, vm, expect_mode="full")
    vm.clean_stop()
    st = vm.stick_logs(os.path.join(c.dir, "stick-log"))
    c.check(any("mode=preserve" in l and "REINSTALL-OS" in l for l in stage_lines(st, "plan"))
            and any("mode=full" in l and "WIPE-EVERYTHING" in l for l in stage_lines(st, "plan")),
            "stick stage log records both decisions", " | ".join(l[30:110] for l in stage_lines(st, "plan")))

    # --- no marker on installed disks: the installer itself must refuse, even if it gets started
    vm2 = c.vm(2216, "-refuse")
    vm2.from_golden(g)
    vm2.start()
    vm2.wait_ssh("installed", 900)
    old = sshv(vm2, "cat /etc/offbox/installed")
    # simulate the stick's GRUB taking the wrong turn: force its default entry to the installer
    vm2.ssh("mkdir -p /run/sb && p=$(lsblk -lnpo NAME,LABEL | awk '$2==\"OFFBOX\"{print $1}') && mount $p /run/sb && "
            "sed -i 's/^    set default=disk$/    set default=install/' /run/sb/boot/grub/grub.cfg && grep -c 'set default=install' /run/sb/boot/grub/grub.cfg && sync && umount /run/sb")
    vm2.clean_stop()
    since = vm2.serial_size()
    vm2.start(stick_first=True)
    vm2.wait_serial(" refuse ", 1200, since)
    vm2.wait_ssh("installed", 900)
    inst = sshv(vm2, "cat /etc/offbox/installed")
    marker = pool_marker(vm2, do_import=False)
    ser = vm2.serial_text(since)
    c.check(inst == old and " prepare-start " not in ser, "no marker: installer was started against a finished install and refused; nothing was wiped",
            [l for l in ser.splitlines() if " refuse " in l][0][-150:])
    c.check(marker.startswith(want) and "healthy" in marker, "no marker: pool content intact after the refused install", marker.replace("\n", " ")[:120])
    c.check(" -> install" in ser and "next boot goes to the internal disks" in ser, "refusal sent the machine back to the internal disks by itself")
    # --- pool data but no finished-install mark (both marks lost): refuse and stay reachable, never wipe
    vm2.ssh("for p in /dev/nvme0n1p1 /dev/nvme1n1p1; do m=$(findmnt -n -o TARGET --source $p | head -1); o=0; if [ -z \"$m\" ]; then mkdir -p /run/e; mount $p /run/e; m=/run/e; o=1; fi; "
            "rm -f $m/EFI/offbox/installed; sync; [ $o = 1 ] && umount /run/e; done; true")
    vm2.clean_stop()
    since = vm2.serial_size()
    vm2.start(stick_first=True)
    vm2.wait_serial(" refuse ", 1200, since)
    kind = None
    for _ in range(30):
        kind, _b = vm2.who()
        if kind == "installer":
            break
        time.sleep(4)
    ser = vm2.serial_text(since)
    line = [l for l in ser.splitlines() if " refuse " in l][0]
    c.check("ZFS pool data" in line and " prepare-start " not in ser and kind == "installer",
            "pool data without a finished-install mark: installer refuses and stays reachable over SSH", line[-170:])
    vm2.power_cut()
    # With the stick first in the boot order this state refuses for good (and stays reachable): that is the
    # design. Pull the stick: the disks themselves are untouched and still boot.
    vm2.start(stick=False)
    vm2.wait_ssh("installed", 900)
    marker = pool_marker(vm2, do_import=False)
    c.check(marker.startswith(want) and "healthy" in marker, "pool content still intact after that refusal; without the stick the disks boot as before",
            marker.replace("\n", " ")[:120])


def c7(c):
    g = need_golden()
    vm = c.vm(2207)
    vm.from_golden(g)
    vm.start()
    boot = vm.wait_ssh("installed", 900)
    for cmd in ("poweroff", "halt", "shutdown -h now", "systemctl poweroff", "systemctl halt", "init 0", "ACPI power button"):
        t0 = time.time()
        if cmd == "ACPI power button":
            vm.power_button()
        else:
            vm.ssh(f"nohup {cmd} >/dev/null 2>&1 &", check=False, timeout=20)
        try:
            new = vm.wait_ssh("installed", 420, not_boot=boot)
            c.check(vm.running(), f"`{cmd}` -> the machine is back up by itself", f"new boot after {int(time.time() - t0)}s, never powered off")
            boot = new
        except Fail as e:
            c.check(False, f"`{cmd}` -> the machine is back up by itself", e)
            if not vm.running():
                vm.start()
            boot = vm.wait_ssh("installed", 900)
    for cmd in ("systemctl suspend", "systemctl hibernate", "systemctl hybrid-sleep"):
        rc, out = vm.ssh(cmd, check=False, timeout=30)
        time.sleep(20)
        kind, b = vm.who()
        c.check(kind == "installed" and b == boot and rc != 0, f"`{cmd}` is refused, the machine stays up", out.strip()[:100])
    alarm = sshv(vm, "systemctl start offbox-rtcwake.service; a=$(cat /sys/class/rtc/rtc0/wakealarm); echo $((a - $(date +%s)))", check=False)
    c.check(alarm.isdigit() and 600 < int(alarm) <= 905,"RTC wake alarm is armed ~15 min ahead while running", f"{alarm}s ahead")
    vm.ssh("journalctl -b -1 --no-pager | grep -i 'offbox-rtcwake' | tail -2", check=False)


def c8(c):
    g = need_golden()
    vm = c.vm(2208)
    vm.from_golden(g)
    vm.start()
    boot = vm.wait_ssh("installed", 900)
    # kernel panic
    since = vm.serial_size()
    t0 = time.time()
    vm.ssh("echo 1 > /proc/sys/kernel/sysrq; nohup sh -c 'sleep 1; echo c > /proc/sysrq-trigger' >/dev/null 2>&1 &", check=False, timeout=15)
    new = vm.wait_ssh("installed", 420, not_boot=boot)
    ser = vm.serial_text(since)
    c.check("Kernel panic" in ser and "Rebooting in 10 seconds" in ser, "kernel panic -> restarts by itself after 10 s", f"back after {int(time.time() - t0)}s; console: Kernel panic ... Rebooting in 10 seconds")
    boot = new
    # kernel oops (panic_on_oops)
    since = vm.serial_size()
    rc, out = vm.ssh("modprobe lkdtm && ls /sys/kernel/debug/provoke-crash/DIRECT", check=False)
    have_lkdtm = rc == 0
    c.check(sshv(vm, "sysctl -n kernel.panic_on_oops kernel.panic").split() == ["1", "10"],
            "an oops is turned into a panic (kernel.panic_on_oops=1, kernel.panic=10)",
            "oops provoked for real below" if have_lkdtm else "setting only: no lkdtm module on the server to provoke a real oops")
    if have_lkdtm:
        t0 = time.time()
        vm.ssh("nohup sh -c 'sleep 1; echo EXCEPTION > /sys/kernel/debug/provoke-crash/DIRECT' >/dev/null 2>&1 &", check=False, timeout=15)
        new = vm.wait_ssh("installed", 420, not_boot=boot)
        ser = vm.serial_text(since)
        c.check("Oops" in ser or "BUG:" in ser, "kernel oops -> panic -> restarts by itself", f"back after {int(time.time() - t0)}s")
        boot = new
    # hard hang: every CPU spinning with interrupts off. Only the hardware watchdog can end this.
    since = vm.serial_size()
    wd = sshv(vm, "cat /sys/class/watchdog/watchdog0/identity; cat /sys/class/watchdog/watchdog0/state")
    t0 = time.time()
    if have_lkdtm:
        vm.ssh("modprobe lkdtm; sysctl -qw kernel.hardlockup_panic=0 kernel.nmi_watchdog=0 kernel.softlockup_panic=0; "
               "nohup sh -c 'sleep 1; for c in $(seq 0 $(( $(nproc) - 1 ))); do taskset -c $c sh -c \"echo HARDLOCKUP > /sys/kernel/debug/provoke-crash/DIRECT\" & done' >/dev/null 2>&1 &",
               check=False, timeout=15)
        how = "all CPUs locked with interrupts off (lkdtm HARDLOCKUP)"
    else:
        # no lkdtm module on the server (it is in linux-modules-extra): starve everything instead. Real-time
        # busy loops on every CPU, with both safety nets off (RT throttling and, on 6.12+, the fair server
        # that would still hand normal tasks 5% of each CPU). systemd can no longer feed the watchdog.
        vm.ssh("sysctl -qw kernel.sched_rt_runtime_us=-1 kernel.hardlockup_panic=0 kernel.softlockup_panic=0; "
               "for f in /sys/kernel/debug/sched/fair_server/cpu*/runtime; do [ -e $f ] && echo 0 > $f; done; "
               "nohup sh -c 'sleep 1; for c in $(seq 0 $(( $(nproc) - 1 ))); do taskset -c $c chrt -f 99 sh -c \"while :; do :; done\" & done' >/dev/null 2>&1 &",
               check=False, timeout=15)
        how = "every CPU taken by real-time busy loops, nothing else gets to run"
    time.sleep(25)
    kind, _b = vm.who()
    new = vm.wait_ssh("installed", 600, not_boot=boot)
    ser = vm.serial_text(since)
    c.check(kind is None and "Kernel panic" not in ser, f"hard hang ({how}) -> machine was dead to SSH, no panic path",
            f"watchdog: {wd.replace(chr(10), ' ')}")
    c.check(True, "hard hang -> the hardware watchdog reset the machine and it came back by itself", f"back {int(time.time() - t0)}s after the hang began")
    boot = new
    # a boot that cannot find its root file system must not sit at an (initramfs) prompt
    since = vm.serial_size()
    vm.ssh("sed -i 's|root=UUID=[^ ]*|root=UUID=00000000-0000-0000-0000-00000000dead rootdelay=20|' /boot/grub/grub.cfg; sync")
    vm.ssh("systemctl reboot", check=False, timeout=20)
    # The initramfs prints its own messages on the screen (tty0), not on the serial console; the kernel's
    # boot lines are on both. Restarting again and again, never sitting still, is what the serial log shows.
    dead = "Kernel command line: BOOT_IMAGE=/vmlinuz"
    end = time.time() + 600
    while time.time() < end and vm.serial_text(since).count(dead) < 3:
        time.sleep(5)
    ser = vm.serial_text(since)
    c.check(ser.count(dead) >= 3 and "00000000dead" in ser and "(initramfs)" not in ser and vm.running(),
            "root disk not found in the initramfs -> restarts by itself again and again instead of waiting at an (initramfs) prompt",
            f"{ser.count(dead)} boots with the unusable root= in {int(time.time() - (end - 600))}s, machine still on")
    vm.power_cut()


def c9(c):
    g = need_golden()
    vm = c.vm(2209)
    vm.from_golden(g)
    vm.start()
    boot = vm.wait_ssh("installed", 900)
    # a mount that cannot work and is not nofail: the classic way to land in emergency mode
    vm.ssh("echo 'UUID=00000000-0000-0000-0000-00000000dead /mnt/broken ext4 defaults,x-systemd.device-timeout=20s 0 2' >> /etc/fstab; sync")
    vm.ssh("systemctl reboot", check=False, timeout=20)
    t0 = time.time()
    boot1 = vm.wait_ssh("installed", 900, not_boot=boot)
    state = sshv(vm, "systemctl is-system-running; systemctl is-active emergency.target; ls /run/offbox-emergency-sshd.pid; cat /var/lib/offbox/emergency-count", check=False)
    # systemd reports "maintenance" or, while units that do not need the failed mount are still queued,
    # "starting"; either way emergency.target is active and nobody is at the console to leave it.
    c.check(state.split()[1:2] == ["active"] and state.split()[-1] == "1" and state.split()[0] in ("maintenance", "starting"),
            "boot dropped to emergency mode and is reachable over SSH",
            f"{int(time.time() - t0)}s after the restart; {state.replace(chr(10), ' ')}")
    # The countdown line is printed once the script has brought the network up (and again every minute); the
    # login prompt that starts on tty1 meanwhile clears whatever was printed before it. So wait for the line
    # instead of reading the screen the moment SSH answers.
    scr, seen = "", False
    t1 = time.time()
    while time.time() - t1 < 90:
        scr = sshv(vm, "cat /dev/vcs1 | tr -s ' '", check=False)
        seen = "EMERGENCY MODE" in scr and "Restarting in" in scr and "SSH: root@10." in scr
        if seen:
            break
        time.sleep(3)
    c.check(seen, "emergency mode is announced on the screen: state, SSH address and the restart countdown",
            f"after {int(time.time() - t1)}s: " + (scr[scr.find("EMERGENCY MODE"):][:220] if "EMERGENCY MODE" in scr else scr[-160:]))
    boot2 = vm.wait_ssh("installed", 900, not_boot=boot1)
    state2 = sshv(vm, "systemctl is-active emergency.target; cat /var/lib/offbox/emergency-count", check=False)
    c.check(state2.split() == ["active", "2"], "left alone in emergency mode it restarts by itself and is reachable again",
            state2.replace("\n", " "))
    # hold file keeps it there
    vm.ssh("mkdir -p /run/offbox && touch /run/offbox/hold")
    time.sleep(130)
    kind, b = vm.who()
    scr = sshv(vm, "cat /dev/vcs1 | tr -s ' '", check=False)
    c.check(kind == "installed" and b == boot2 and "Held by /run/offbox/hold" in scr,
            "`touch /run/offbox/hold` stops the automatic restart while debugging, and the screen says so")
    vm.ssh("sed -i '/00000000dead/d' /etc/fstab; sync; rm -f /run/offbox/hold")
    boot3 = vm.wait_ssh("installed", 900, not_boot=boot2)
    state3 = ""
    for _ in range(40):
        state3 = sshv(vm, "systemctl is-system-running", check=False)
        if state3 not in ("starting", "initializing"):
            break
        time.sleep(5)
    c.check(state3 == "running", "after the cause is fixed over SSH the next automatic restart is a normal boot", state3)
    vm.ssh("systemctl start offbox-boot-health.service", timeout=300)
    c.check(sshv(vm, "cat /var/lib/offbox/emergency-count 2>/dev/null || echo 0") == "0", "a healthy boot clears the emergency counter")


def fake_kernel(vm, ver, good_initrd):
    cur = sshv(vm, "offbox-status | sed -n 's/.*booted_image=//p' | cut -d' ' -f1")
    vm.ssh(f"cp /boot/vmlinuz-{cur} /boot/vmlinuz-{ver} && cp /boot/config-{cur} /boot/config-{ver} 2>/dev/null; "
           + (f"cp /boot/initrd.img-{cur} /boot/initrd.img-{ver}" if good_initrd else f"head -c 20000000 /dev/urandom > /boot/initrd.img-{ver}")
           + f" && update-grub >/dev/null 2>&1 && /etc/kernel/postinst.d/zzz-offbox-kernel-trial {ver} /boot/vmlinuz-{ver}", timeout=300)
    return cur


def c10(c):
    g = need_golden()
    vm = c.vm(2220)
    vm.from_golden(g)
    vm.start()
    boot = vm.wait_ssh("installed", 900)
    # a "new kernel" that cannot boot (unusable initrd)
    bad = "7.0.0-9998-generic"
    cur = fake_kernel(vm, bad, good_initrd=False)
    st = sshv(vm, "offbox-kernel-trial status | tr '\\n' ' '")
    c.check(f"trial={bad}" in st and "trial_flag_on_esps=2" in st and f"good={cur}" in st and f"gnulinux-{cur}-advanced" in st,
            "new kernel installed -> armed for one trial boot, GRUB default stays on the known-good kernel", st)
    since = vm.serial_size()
    t0 = time.time()
    vm.ssh("systemctl reboot", check=False, timeout=20)
    boot = vm.wait_ssh("installed", 900, not_boot=boot)
    ser = vm.serial_text(since)
    booted = sshv(vm, "offbox-status | sed -n 's/.*booted_image=//p' | cut -d' ' -f1")
    c.check(ser.count(f"Loading Linux {bad}") == 1 and booted == cur,
            "the new kernel was tried exactly once, failed to boot, and the machine fell back to the previous kernel by itself",
            f"console: 'Loading Linux {bad}' once, then booted {booted}; {int(time.time() - t0)}s")
    c.check("Kernel panic" in ser or "Rebooting in" in ser, "the failed kernel ended in a panic + automatic restart, not a hang")
    vm.ssh("systemctl start offbox-boot-health.service", timeout=400)
    st = sshv(vm, "offbox-kernel-trial status | tr '\\n' ' '")
    c.check(f"bad={bad}" in st and "trial= " in st and "trial_flag_on_esps=0" in st, "boot-health marked the failed kernel bad; it will not be tried again", st)
    vm.ssh(f"/etc/kernel/postinst.d/zzz-offbox-kernel-trial {bad} /boot/vmlinuz-{bad}")
    c.check("trial_flag_on_esps=0" in sshv(vm, "offbox-kernel-trial status | tr '\\n' ' '"), "re-installing the bad kernel does not arm it again")
    # a new kernel that boots fine
    good = "7.0.0-9999-generic"
    fake_kernel(vm, good, good_initrd=True)
    since = vm.serial_size()
    vm.ssh("systemctl reboot", check=False, timeout=20)
    boot = vm.wait_ssh("installed", 900, not_boot=boot)
    booted = sshv(vm, "offbox-status | sed -n 's/.*booted_image=//p' | cut -d' ' -f1")
    st = sshv(vm, "offbox-kernel-trial status | tr '\\n' ' '")
    c.check(booted == good and f"good={cur}" in st, "a bootable new kernel is running on trial; the default is still the old one until the health check", st)
    c.log("waiting for the boot-health timer (4 min after boot) to judge the trial by itself")
    for _ in range(40):
        st = sshv(vm, "offbox-kernel-trial status | tr '\\n' ' '")
        if f"good={good}" in st:
            break
        time.sleep(10)
    c.check(f"good={good}" in st and f"gnulinux-{good}-advanced" in st and "trial= " in st,
            "after a healthy boot the health timer made the new kernel the default", st)
    keep = sshv(vm, "cat /etc/apt/apt.conf.d/02offbox-keep-kernel | tail -1")
    c.check("9999" in keep, "the known-good kernel is protected from apt autoremove", keep)
    vm.ssh("systemctl reboot", check=False, timeout=20)
    vm.wait_ssh("installed", 900, not_boot=boot)
    c.check(sshv(vm, "offbox-status | sed -n 's/.*booted_image=//p' | cut -d' ' -f1") == good, "next boot uses the promoted kernel by default")


HOST_FILES = ("boatd.py", "boatd-wrap", "base-image.sh", "boatd.service", "install-host.sh")

# Runs inside the VM: one boatd API call with an owner's token (kept in a root-only file there), JSON out.
API_PY = r'''#!/usr/bin/env python3
import base64, json, sys, urllib.error, urllib.request
who, method, path = sys.argv[1:4]
body = base64.b64decode(sys.argv[4]) if len(sys.argv) > 4 else None
h = {"Content-Type": "application/json"}
if who != "none":
    h["Authorization"] = "Bearer " + open("/root/tok." + who).read().strip()
h.update(json.loads(base64.b64decode(sys.argv[5])) if len(sys.argv) > 5 else {})
req = urllib.request.Request(open("/root/api.url").read().strip() + path, method=method, data=body, headers=h)
try:
    with urllib.request.urlopen(req, timeout=40) as r:
        print(json.dumps({"http": r.status, **json.loads(r.read() or b"{}")}))
except urllib.error.HTTPError as e:
    print(json.dumps({"http": e.code, **json.loads(e.read() or b"{}")}))
except Exception as e:
    print(json.dumps({"http": 0, "error": str(e)}))
'''


def install_host(c, vm, label="install-host.sh"):
    """Copy the server files and run install-host.sh the way bootstrap.zsh does. Returns the listen IP."""
    vm.ssh("mkdir -p /root/offbox-server")
    vm.scp([os.path.join(SERVER_DIR, f) for f in HOST_FILES], "/root/offbox-server/")
    ip = sshv(vm, "hostname -I | awk '{print $1}'")
    t0 = time.time()
    rc, out = vm.ssh(f"OFFBOX_LISTEN_IP={ip} bash /root/offbox-server/install-host.sh > /root/install-host.log 2>&1; echo rc=$?; tail -5 /root/install-host.log",
                     check=False, timeout=5400)
    c.check("rc=0" in out, f"{label} ran to the end on the stick-installed system", f"{int(time.time() - t0)}s; {out.strip()[-200:]}")
    with open(os.path.join(c.dir, f"install-host-{len(os.listdir(c.dir))}.log"), "w") as f:
        f.write(sshv(vm, "cat /root/install-host.log", check=False))
    with open(os.path.join(c.dir, "api.py"), "w") as f:
        f.write(API_PY)
    vm.scp([os.path.join(c.dir, "api.py")], "/root/api.py")
    vm.ssh(f"echo http://{ip}:8443/api/v1 > /root/api.url; umask 077; for o in ardud moni; do "
           "[ -s /root/tok.$o ] || boatd token create --owner $o --label vmtest > /root/tok.$o; done")
    return ip


def api(vm, who, method, path, body=None, headers=None):
    """A boatd API call made inside the VM. who: ardud | moni | none. Returns the JSON with "http" added."""
    args = [who, method, shlex.quote(path)]
    if body is not None or headers:
        args.append(base64.b64encode(json.dumps(body if body is not None else {}).encode()).decode())
    if headers:
        args.append(base64.b64encode(json.dumps(headers).encode()).decode())
    rc, out = vm.ssh("python3 /root/api.py " + " ".join(args), check=False, timeout=90)
    try:
        return json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"http": 0, "error": out.strip()[-200:]}


def wait_api(vm, timeout=900):
    """Until boatd reports it can take runs again (pool there, reconcile done). Returns the last /health."""
    t0, h = time.time(), {}
    while time.time() - t0 < timeout:
        h = api(vm, "none", "GET", "/health")
        if h.get("http") == 200 and h.get("ok"):
            return h
        time.sleep(3)
    return h


def boatd_diag(c, vm, tag):
    """Keep boatd's journal and the container list next to the results (nothing secret is logged there)."""
    out = sshv(vm, "journalctl -u boatd -u incus --no-pager -n 400 2>&1; echo ---; incus list -c nsS4 2>&1; echo ---; "
                   "zfs list -o name,used,mountpoint 2>&1 | head -60; echo ---; free -m; df -h / /var/lib/incus; "
                   "for b in $(incus list -c n -f csv | head -2); do echo \"--- inside $b\"; incus exec $b -- bash -c '"
                   "systemctl is-system-running; ss -Hltn; systemctl --failed --no-pager | head -20; "
                   "systemctl status ssh ssh.socket --no-pager 2>&1 | head -40; ls -la /etc/ssh | head -30' 2>&1; done",
               check=False, timeout=180)
    with open(os.path.join(c.dir, f"boatd-diag-{tag}.log"), "w") as f:
        f.write(out)


def pool_healthy(c, vm, label):
    z = sshv(vm, "zpool status -L offbox | grep -E 'state:|errors:|nvme|mirror' | tr -s ' \\t\\n' ' '", check=False)
    c.check("state: ONLINE" in z and "No known data errors" in z and z.count("ONLINE") == 4
            and "nvme0n1p4 ONLINE" in z and "nvme1n1p4 ONLINE" in z,
            f"{label}: pool offbox is a healthy mirror", z[:260])


def c11(c):
    g = need_golden()
    vm = c.vm(2221)
    vm.from_golden(g)
    vm.start(mem=12288, smp=8)
    boot = vm.wait_ssh("installed", 900)
    ip = install_host(c, vm)

    def healthy(label):
        pool_healthy(c, vm, label)
        st = ""
        for _ in range(30):
            st = sshv(vm, "systemctl is-active incus boatd | tr '\\n' ' '; incus list -c ns --format csv 2>&1 | head -3 | tr '\\n' ' '", check=False)
            if st.startswith("active active"):
                break
            time.sleep(5)
        h = wait_api(vm, 300)
        lim = api(vm, "ardud", "GET", "/limits")
        c.check(st.startswith("active active") and h.get("ok") and lim.get("http") == 200,
                f"{label}: incus and boatd are up, boatd is healthy and answers its API", f"{st} health={h.get('mode')} limits={lim.get('http')}")

    parts = sshv(vm, "zpool status -P offbox | grep -oE '/dev/[^ ]+' | xargs -n1 readlink -f | tr '\\n' ' '")
    c.check("nvme0n1p4" in parts and "nvme1n1p4" in parts, "the pool was created on the two offbox-zfs partitions", parts)
    c.check("offbox-base" in sshv(vm, "incus image list --format csv -c l", check=False), "base image offbox-base built")
    healthy("after install-host.sh")
    vm.ssh("zfs create -o mountpoint=/offbox-pc offbox/pc 2>/dev/null; dd if=/dev/urandom of=/offbox-pc/ref bs=1M count=200 status=none; sha256sum /offbox-pc/ref | cut -d' ' -f1 > /root/ref.sha; sync; zpool sync offbox")
    cuts = [("idle", "true", 5),
            ("while 4 GB are being written to the pool", "nohup dd if=/dev/urandom of=/offbox-pc/load bs=1M count=4000 oflag=dsync >/dev/null 2>&1 &", 8),
            ("while a container is being created and started", "nohup sh -c 'incus launch offbox-base pc-test; incus exec pc-test -- dd if=/dev/urandom of=/root/x bs=1M count=500' >/dev/null 2>&1 &", 12)]
    for i, (what, cmd, delay) in enumerate(cuts, 1):
        vm.ssh(cmd, check=False, timeout=30)
        time.sleep(delay)
        vm.power_cut()
        vm.start(mem=12288, smp=8)
        boot = vm.wait_ssh("installed", 900, not_boot=boot)
        healthy(f"hard power cut {i} ({what})")
        ref = sshv(vm, "sha256sum /offbox-pc/ref | cut -d' ' -f1; cat /root/ref.sha", check=False).split()
        c.check(len(ref) == 2 and ref[0] == ref[1], f"hard power cut {i}: data written before the cut reads back identical")
    vm.ssh("zpool scrub -w offbox", timeout=1800)
    z = sshv(vm, "zpool status offbox | grep -E 'scan:|errors:' | tr -s ' \\n' ' '")
    c.check("0 errors" in z or "No known data errors" in z, "scrub after the three power cuts: no errors", z)
    md = sshv(vm, "cat /proc/mdstat | grep -E 'blocks' | tr -s ' \\n' ' '")
    c.check(md.count("[UU]") == 2, "both mdraid arrays complete after the power cuts", md)


def ts(c):
    """Tailnet path, end to end, with a throw-away auth key (ephemeral, 1 day, same tag as the real one).

    The key comes in through the environment (OFFBOX_TS_TEST_KEY), is written only into this case's stick
    image, and that image is deleted at the end. Nodes use the test names offbox-vmtest(-installer) and are
    logged out at the end (ephemeral nodes disappear from the tailnet when they log out).
    While the installed system is up the case waits (up to OFFBOX_TS_HOLD seconds, default 900) for the file
    ~/ohv/ts-release, so the Mac-side scripts can be tried against it over the real tailnet.
    """
    key = os.environ.get("OFFBOX_TS_TEST_KEY", "").strip()
    if not key.startswith("tskey-"):
        raise Fail("OFFBOX_TS_TEST_KEY is not set (ephemeral test auth key)")
    vm = c.vm(2222)
    vm.fwcfg["ts_hostname"] = "offbox-vmtest"
    img = os.path.join(vm.dir, "stick-ts.img")
    keyfile = os.path.join(vm.dir, "k")
    release = os.path.join(ROOT, "ts-release")
    if os.path.exists(release):
        os.remove(release)
    try:
        run(["cp", "--sparse=always", STICK, img])
        fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, key.encode() + b"\n")
        os.close(fd)
        env = dict(os.environ, MTOOLS_SKIP_CHECK="1")
        env.pop("OFFBOX_TS_TEST_KEY", None)
        subprocess.run(["mcopy", "-i", f"{img}@@{(1 + 16384) * 1024 * 1024}", keyfile, "::tailscale-authkey"], env=env, check=True)
        os.remove(keyfile)
        vm.fresh_disks()
        vm.fresh_stick(img)
        vm.start()
        vm.wait_ssh("installer", 600)
        inst_ip = ""
        for _ in range(40):
            inst_ip = sshv(vm, "cat /run/offbox/tailscale-ip 2>/dev/null", check=False)
            if inst_ip.startswith("100."):
                break
            time.sleep(5)
        st = sshv(vm, "grep -h ' tailscale' /run/offbox/stage.log | tail -2", check=False)
        c.check(inst_ip.startswith("100."), "installer session joined the tailnet by itself with the key file on the stick",
                st.replace("\n", " | ")[-220:])
        name = sshv(vm, "$(cat /run/offbox/ts.sock | sed 's|/tailscaled.sock||')/usr/bin/tailscale --socket=$(cat /run/offbox/ts.sock) status --json | "
                        "python3 -c 'import json,sys; s=json.load(sys.stdin)[\"Self\"]; print(s[\"HostName\"], s.get(\"Tags\"), s.get(\"KeyExpiry\", \"no-expiry\"))'", check=False)
        c.check("offbox-vmtest-installer" in name and "tag:offbox" in name, "installer node: test name, tagged tag:offbox", name)
        with open(os.path.join(c.dir, "tailnet.txt"), "a") as f:
            f.write(f"installer {inst_ip}\n")
        boot = vm.wait_ssh("installed", 3600)
        stage = sshv(vm, "journalctl -b -u offbox-tailscale-join --no-pager | tail -3", check=False)
        ip = ""
        for _ in range(40):
            ip = sshv(vm, "tailscale ip -4 2>/dev/null | head -1", check=False)
            if ip.startswith("100."):
                break
            time.sleep(5)
        info = sshv(vm, "tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d[\"Self\"]; "
                        "print(d[\"BackendState\"], s[\"HostName\"], s.get(\"Tags\"), s.get(\"KeyExpiry\", \"no-expiry\"))'", check=False)
        c.check(ip.startswith("100.") and info.startswith("Running offbox-vmtest ") and "tag:offbox" in info and "no-expiry" in info,
                "installed system is on the tailnet after its first boot with no further touch: tagged, node key does not expire",
                f"{ip} {info}")
        late = sshv(vm, "p=$(lsblk -lnpo NAME,LABEL | awk '$2==\"OFFBOXLOG\"{print $1}'); mkdir -p /run/sl; mount -o ro $p /run/sl; "
                        "grep -h ' tailscale ' /run/sl/stage.log | tail -1; umount /run/sl", check=False)
        c.check("joined the tailnet as offbox-vmtest" in late and ip in late,
                "the join happened during the install (same tailnet address before and after the first boot)", late[-160:])
        c.check(sshv(vm, "ls /etc/offbox/tailscale-authkey 2>&1 | grep -c 'No such'") == "1"
                and sshv(vm, "tailscale debug prefs | grep -E 'RunSSH|CorpDNS' | tr -d ' \\t\\n'") == '"CorpDNS":false,"RunSSH":false,',
                "auth key file removed from the installed system once joined; --ssh=false, --accept-dns=false in effect")
        with open(os.path.join(c.dir, "tailnet.txt"), "a") as f:
            f.write(f"installed {ip}\n")
        hold = int(os.environ.get("OFFBOX_TS_HOLD", "900"))
        c.log(f"installed system is on the tailnet at {ip}; waiting up to {hold}s for {release}")
        t0 = time.time()
        while time.time() - t0 < hold and not os.path.exists(release):
            time.sleep(3)
        seen = open(release).read().strip() if os.path.exists(release) else ""
        c.check(seen.startswith("ok"), "reached from the Mac over the real tailnet with the real offbox key (ssh + watch-install.zsh)",
                seen[:200] or "no result file from the Mac side")
        # a restart keeps the node
        vm.ssh("systemctl reboot", check=False, timeout=20)
        vm.wait_ssh("installed", 900, not_boot=boot)
        ip2 = ""
        for _ in range(40):
            ip2 = sshv(vm, "tailscale ip -4 2>/dev/null | head -1", check=False)
            if ip2.startswith("100."):
                break
            time.sleep(5)
        c.check(ip2 == ip, "after a restart the server is back on the tailnet at the same address", ip2)
        out = sshv(vm, "tailscale logout 2>&1; echo rc=$?", check=False)
        c.check("rc=0" in out, "test node logged out (ephemeral: removed from the tailnet)", out.replace("\n", " ")[-80:])
        vm.clean_stop()
        vm.stick_logs(os.path.join(c.dir, "stick-log"))
    finally:
        if vm.running():
            vm.power_cut()
        for f in (keyfile, img, vm.stick):
            if os.path.exists(f):
                os.remove(f)


def acc(c):
    """acceptance.sh is written for the real board; here it only has to run cleanly and its watchdog test work."""
    g = need_golden()
    vm = c.vm(2226)
    vm.from_golden(g)
    vm.start()
    boot = vm.wait_ssh("installed", 900)
    vm.scp([os.path.join(HOME_DIR, "acceptance.sh")], "/root/acceptance.sh")
    rc, out = vm.ssh("bash /root/acceptance.sh 2>&1", check=False, timeout=1500)
    lines = [l for l in out.splitlines() if l.strip()]
    odd = [l for l in lines if not l.startswith(("PASS ", "FAIL ", "WARN ", "INFO ", "== "))]
    fails = [l for l in lines if l.startswith("FAIL ")]
    c.check(rc in (0, 1) and not odd and any(l.startswith("== still to do by hand") for l in lines),
            "acceptance.sh runs to its end on the installed system, every line is a verdict (no shell errors)",
            f"{len(lines)} lines, exit {rc}; unexpected: {odd[:3]}")
    c.check(sum(l.startswith("PASS ") for l in lines) >= 10, "acceptance.sh: checks pass on the VM install where a VM can",
            f"PASS={sum(l.startswith('PASS ') for l in lines)} WARN={sum(l.startswith('WARN ') for l in lines)} FAIL={len(fails)}: {' | '.join(fails)[:400]}")
    with open(os.path.join(c.dir, "acceptance-output.txt"), "w") as f:
        f.write(out)
    t0 = time.time()
    vm.ssh("bash /root/acceptance.sh --test-watchdog", check=False, timeout=30)
    time.sleep(25)
    kind, _b = vm.who()
    new = vm.wait_ssh("installed", 600, not_boot=boot)
    rc, out = vm.ssh("bash /root/acceptance.sh --after-watchdog 2>&1", check=False, timeout=60)
    c.check(kind is None and rc == 0 and out.startswith("PASS hardware watchdog"),
            "acceptance.sh --test-watchdog hangs the machine for real, the watchdog resets it, --after-watchdog says PASS",
            f"back after {int(time.time() - t0)}s; {out.strip()[:200]}")
    assert new
    vm.power_cut()


def kvm_shape(c, extra, port):
    """C1 and C3 again in the shape the box has with a network KVM attached: a USB keyboard and mouse and a
    second USB mass-storage device, enumerated before the stick (so the stick is not the first USB disk)."""
    vm = c.vm(port)
    vm.kvm = extra
    vm.fresh_disks()
    vm.fresh_stick(STICK)
    if extra == "empty":
        # --- the keyboard works and the manual entry does what it says: session up, nothing installed
        since = vm.serial_size()
        vm.start()
        vm.wait_serial("offbox: installed=0 marker=0 -> install", 300, since)
        time.sleep(1.5)
        vm.keys("down", "down", "ret")          # install (default) -> disk -> installer session only
        vm.wait_ssh("installer", 600)
        st = ""
        for _ in range(30):
            st = sshv(vm, "cat /run/offbox/stage 2>/dev/null; grep -c . /run/offbox/plan.json 2>/dev/null", check=False)
            if st.startswith("shell"):
                break
            time.sleep(5)
        time.sleep(45)
        parts = sshv(vm, "lsblk -lno NAME,TYPE /dev/nvme0n1 /dev/nvme1n1 | grep -c part; grep -c offbox.mode=shell /proc/cmdline; "
                         "cat /run/offbox/stage; fgconsole", check=False).split()
        scr = sshv(vm, "cat /dev/vcs8", check=False)
        c.check(st.startswith("shell") and parts[:3] == ["0", "1", "shell"],
                "manual GRUB entry picked with the keyboard: installer session with SSH is up, nothing is installed, it stays",
                f"stage={st.split()[0] if st else ''} partitions on the NVMe disks={parts[0] if parts else '?'} after 45 s")
        c.check("offbox installer" in scr and "manual entry" in scr and parts[3:4] == ["8"],
                "manual entry: the status screen is the visible console and says what this session is", scr.strip()[:160].replace("\n", " | "))
        vm.power_cut()
    # --- C1 in this shape
    since = vm.serial_size()
    vm.start()
    t0 = time.time()
    seen = None
    shape = scr = ""
    while time.time() - t0 < 3600:
        if not vm.running():
            raise Fail("machine switched off during the install")
        kind, _ = vm.who()
        if kind == "installer" and seen is None:
            seen = int(time.time() - t0)
            time.sleep(20)
            shape = sshv(vm, "lsblk -dno NAME,TRAN,TYPE,SIZE,RM | tr -s ' ' | tr '\n' ';'; echo; findmnt -no SOURCE /cdrom; "
                             "cat /run/offbox/logvol.dev; fgconsole; lsusb | grep -ci -e keyboard -e tablet -e hid", check=False)
            scr = sshv(vm, "cat /dev/vcs8", check=False)
        if kind == "installed":
            break
        time.sleep(5)
    else:
        raise Fail("no installed system after 60 minutes")
    ser = vm.serial_text(since)
    c.check("offbox: installed=0 marker=0 -> install" in ser and ser.count("power on #") == 1,
            f"KVM shape ({extra} virtual drive, USB keyboard + mouse): one power-on with blank disks ended in a running installed system",
            f"{int(time.time() - t0)}s after power-on")
    lines = shape.splitlines()
    stick_part = lines[1] if len(lines) > 1 else ""
    if extra == "fat":
        shape_ok = not stick_part.startswith("/dev/sda")     # the unrelated disk is sda, the stick comes after it
        what = "the stick was not the first USB disk (not /dev/sda); its boot and log volumes were still found, by content"
    else:
        shape_ok = "sr0" in (lines[0] if lines else "")       # the empty virtual drive is there as a CD without medium
        what = "an empty virtual USB drive sits next to the stick; the stick's boot and log volumes were found"
    c.check(len(lines) >= 4 and shape_ok and stick_part.startswith("/dev/sd") and lines[2].startswith(stick_part[:8])
            and lines[2] != stick_part, what,
            f"devices: {lines[0] if lines else ''} boot volume={stick_part} log volume={lines[2] if len(lines) > 2 else ''}")
    c.check("offbox installer" in scr and "steps so far" in scr and "addresses: 10." in scr and len(lines) >= 4 and lines[3] == "8",
            "installer status screen is the visible console: stage lines and the address are on it",
            scr.strip()[:200].replace("\n", " | "))
    c.check("tskey-" not in scr and "$6$" not in scr and "$y$" not in scr, "nothing secret on the installer status screen")
    verify_install(c, vm, expect_mode="full")
    tty = sshv(vm, "systemctl is-active getty@tty1.service; cat /proc/cmdline; cat /dev/vcs1 | tr -s ' \n' ' '", check=False)
    c.check(tty.startswith("active") and "quiet" not in tty.split("\n")[1] and "splash" not in tty.split("\n")[1]
            and tty.split("\n")[1].split("console=")[-1].startswith("tty0") and "offbox home server" in tty and "login:" in tty
            and "addresses: 10." in tty,
            "installed system: login prompt on tty1 with the server's addresses above it, kernel boots verbose with console=tty0 last",
            tty.split("\n")[-1][:200])
    want = make_pool(vm).strip()
    boot = vm.boot_id()
    vm.clean_stop()
    st = vm.stick_logs(os.path.join(c.dir, "stick-log"))
    c.check(len(stage_lines(st, "late-done")) == 1 and any("installed-system boot" in l for l in st.splitlines()),
            "the stick's log volume has the install and the first boot of the installed system")
    # --- C3 in this shape: stick first in the boot order, the extra USB devices still there
    for i in (1, 2, 3):
        since = vm.serial_size()
        vm.start(stick_first=True)
        boot = vm.wait_ssh("installed", 900, not_boot=boot)
        ser = vm.serial_text(since)
        marker = pool_marker(vm)
        c.check("offbox: installed=1 marker=0 -> disk" in ser and "offbox: loading the installed system's boot menu" in ser
                and " early-start " not in ser and marker.startswith(want) and "healthy" in marker,
                f"restart {i} with the stick first and the KVM's USB devices present: the installed system starts, no reinstall, pool intact")
        if i < 3:
            vm.clean_stop()
    if extra == "fat":
        seen_vol = sshv(vm, "lsblk -lno LABEL | grep -c KVMDATA; grep -c . /boot/efi/EFI/offbox/consumed 2>/dev/null", check=False).split()
        vm.clean_stop()
        listing = vm.foreign_listing()
        c.check(seen_vol[:1] == ["1"] and listing == list(FOREIGN_FILES),
                "the unrelated FAT volume, with files named like our marker files, was ignored and is unchanged",
                " ".join(f"{n}:{'same' if t == dict(FOREIGN_FILES)[n] else 'CHANGED'}" for n, t in listing))
    else:
        vm.power_cut()


def kvm_empty(c):
    kvm_shape(c, "empty", 2228)


def kvm_fat(c):
    kvm_shape(c, "fat", 2229)


def macstick(c):
    """The stick as macOS makes it: boot an image written by write-stick.zsh --image (diskutil partition table,
    macOS FAT32, files copied by the same code path as the real stick). Image path in OHV_MAC_STICK."""
    img = os.environ.get("OHV_MAC_STICK", "")
    if not os.path.isfile(img):
        raise Fail("OHV_MAC_STICK is not set to a raw image written by write-stick.zsh --image")
    vm = c.vm(2227)
    vm.fresh_disks()
    vm.fresh_stick(img)
    vm.start()
    t0 = time.time()
    boot = vm.wait_ssh("installed", 3600)
    ser = vm.serial_text()
    c.check("offbox: installed=0 marker=0 -> install" in ser and ser.count("power on #") == 1,
            "macOS-written stick image: one power-on with blank disks ended in a running installed system",
            f"{int(time.time() - t0)}s after power-on")
    verify_install(c, vm, expect_mode="full")
    vm.clean_stop()
    stage = vm.stick_logs(os.path.join(c.dir, "stick-log"))
    c.check(len(stage_lines(stage, "late-done")) == 1 and any("installed-system boot" in l for l in stage.splitlines()),
            "the macOS-made log volume was written by the installer and by the installed system",
            f"{len(stage.splitlines())} stage lines")
    since = vm.serial_size()
    vm.start(stick_first=True)
    vm.wait_ssh("installed", 900, not_boot=boot)
    ser = vm.serial_text(since)
    c.check("offbox: installed=1 marker=0 -> disk" in ser and "offbox: loading the installed system's boot menu" in ser
            and " early-start " not in ser,
            "left in and first in the boot order, the macOS-written stick starts the installed system, no reinstall")
    vm.power_cut()


def sb(c):
    """The same stick with Secure Boot enforced (OVMF with the Microsoft keys enrolled)."""
    vm = c.vm(2223)
    vm.secboot = True
    install_fresh(c, vm)
    boot = vm.wait_ssh("installed", 3600)
    state = sshv(vm, "mokutil --sb-state 2>&1 | head -1; cat /sys/kernel/security/lockdown 2>/dev/null", check=False)
    c.check("SecureBoot enabled" in state, "installed from the stick and booted with Secure Boot enforced", state.replace("\n", " "))
    mods = sshv(vm, "modprobe zfs && modprobe sp5100_tco 2>/dev/null; lsmod | grep -c -E '^(zfs|i6300esb) '; cat /sys/class/watchdog/watchdog0/state", check=False)
    c.check(mods.split()[:2] == ["2", "active"], "under Secure Boot: zfs module loads, watchdog driver active", mods.replace("\n", " "))
    verify_install(c, vm, expect_mode="full")
    vm.clean_stop()
    since = vm.serial_size()
    vm.start(stick_first=True)
    vm.wait_ssh("installed", 900, not_boot=boot)
    ser = vm.serial_text(since)
    c.check("offbox: installed=1 marker=0 -> disk" in ser and "offbox: loading the installed system's boot menu" in ser and "did not start a system" not in ser,
            "under Secure Boot the stick's GRUB starts the installed system from the disks",
            "console: installed=1 marker=0 -> disk, loading the installed system's boot menu")
    wd = vm.serial_text().count(" early-start ")
    c.check(wd == 1, "one install only", f"early-start seen {wd}x")


def err(c):
    """A failed install (test hook: late.sh fails once) is logged, stays reachable, and is retried by itself."""
    vm = c.vm(2224)
    vm.fwcfg["fail_late_once"] = 1
    install_fresh(c, vm)
    vm.wait_serial(" install-failed ", 3600)
    vm.wait_serial(" hold ", 120)
    kind = None
    for _ in range(20):
        kind, _b = vm.who()
        if kind == "installer":
            break
        time.sleep(3)
    st = sshv(vm, "cat /run/offbox/stage; cat /run/offbox/logvol/fail-count; ls /run/offbox/logvol/logs/*/ | grep -c -E 'subiquity-server-debug.log|installer-logs.tgz|late.log'", check=False)
    c.check(kind == "installer" and st.split()[:2] == ["hold", "1"] and st.split()[-1] == "3",
            "failed install: error handler ran, failure counted and full logs on the stick, installer still reachable over SSH",
            st.replace("\n", " "))
    since = vm.serial_size()
    boot = vm.wait_ssh("installed", 3600)
    ser = vm.serial_text(since)
    plan = [l for l in ser.splitlines() if " plan " in l]
    c.check(ser.count(" early-start ") == 1 and plan and "action=install mode=full" in plan[0],
            "after the hold it restarted by itself, found the half-done install and installed again; no touch needed",
            plan[0][-150:] if plan else "")
    verify_install(c, vm, expect_mode="full")
    left = sshv(vm, "mkdir -p /run/sl && p=$(lsblk -lnpo NAME,LABEL | awk '$2==\"OFFBOXLOG\"{print $1}') && mount -o ro $p /run/sl && ls /run/sl | grep -c fail-count; umount /run/sl", check=False)
    c.check(left.splitlines()[0] == "0", "the failure counter on the stick is cleared after the good install")
    vm.clean_stop()
    stage = vm.stick_logs(os.path.join(c.dir, "stick-log"))
    c.check(len(stage_lines(stage, "install-failed")) == 1 and len(stage_lines(stage, "late-done")) == 1,
            "stick stage log tells the story: one failed install, then one finished")


def c12(c):
    """boatd picks up where it left off: a hard power cut with runs going and queued, boatd restarted alone
    mid-run, the pool missing at start, and an OS reinstall (REINSTALL-OS) over the live pool."""
    vm = c.vm(2222)
    try:
        _c12(c, vm)
    except Exception:
        if vm.running():
            try:
                boatd_diag(c, vm, "failure")
            except Exception as e:  # noqa: BLE001
                c.log(f"no boatd diagnostics: {e}")
        raise


def _c12(c, vm):
    g = need_golden()
    vm.from_golden(g)
    vm.start(mem=12288, smp=8)
    boot = vm.wait_ssh("installed", 900)
    ip = install_host(c, vm)
    mounts = sshv(vm, "findmnt -no SOURCE /var/lib/boatd; findmnt -no SOURCE /var/lib/incus; ls /var/lib/boatd | tr '\\n' ' '")
    c.check("offbox/boatd" in mounts and "offbox/incus-var" in mounts and "boatd.db" in mounts,
            "boatd's and Incus's state are on the pool (datasets offbox/boatd, offbox/incus-var), not on the OS disk", mounts.replace("\n", " "))
    timers = sshv(vm, "systemctl is-enabled boatd-snap-hourly.timer boatd-snap-daily.timer boatd-snap-weekly.timer boatd-scrub.timer | tr '\\n' ' '; "
                      "systemctl list-timers --all --no-legend 'boatd-*' | wc -l")
    c.check(timers.startswith("enabled enabled enabled enabled") and timers.split()[-1] == "4",
            "snapshot timers (hourly, daily, weekly) and the monthly scrub timer are installed and enabled", timers)
    # Two runs at once, so one power cut catches: a retried run, a run that must not be retried, a queued run.
    # The first boatd version had one shared token in a file: it must become ardud's, stored hashed.
    vm.ssh("python3 - <<'EOF'\nimport json\np='/etc/boatd/config.json'\nc=json.load(open(p))\n"
           "c.update(max_running=2, mem_reserve_gb=1, default_peak_gb=0.25)\njson.dump(c, open(p,'w'))\nEOF\n"
           "umask 077; echo legacy-shared-token-of-v1 > /etc/boatd/token; cp /etc/boatd/token /root/tok.legacy; systemctl restart boatd")
    h0 = wait_api(vm)
    keys = sorted(k for k in h0 if k != "http")
    c.check(h0.get("ok") and h0.get("mode") == "ok" and h0.get("pool") == {"name": "offbox", "state": "ONLINE"}
            and h0.get("mdraid", {}).get("state") == "ok" and h0.get("queue") == 0
            and keys == ["boatd_uptime_s", "boot_id", "mdraid", "mode", "ok", "pool", "queue", "reasons", "running", "up", "uptime_s", "version"],
            "/health without a token: up, pool ONLINE, mdraid ok, queue 0, boot id, uptime, version, and nothing else", json.dumps(h0)[:300])
    leg = api(vm, "legacy", "GET", "/limits")
    gone = sshv(vm, "ls /etc/boatd/token 2>&1 | grep -c 'No such'; grep -c legacy-shared /dev/null /var/lib/boatd/boatd.db*", check=False).split()
    c.check(leg.get("http") == 200 and gone[0] == "1" and all(x.endswith(":0") for x in gone[1:]),
            "the old single token works as ardud's token; the clear-text file is gone and the database holds no clear token", f"http={leg.get('http')} {gone}")
    box = api(vm, "ardud", "POST", "/sandboxes", {"type": "small", "name": "vmtest-ardud", "ttlSeconds": 7200})
    bid = (box.get("sandbox") or {}).get("id")
    hers = (api(vm, "moni", "POST", "/sandboxes", {"type": "small", "name": "vmtest-moni", "ttlSeconds": 7200}).get("sandbox") or {}).get("id")
    if not bid or not hers:
        raise Fail(f"could not create the test boxes: {json.dumps(box)[:300]}")

    def box_state(who, b):
        return (api(vm, who, "GET", f"/sandboxes/{b}").get("sandbox") or {}).get("state")

    def wait_state(who, b, want, timeout=600):
        t0, st = time.time(), None
        while time.time() - t0 < timeout:
            st = box_state(who, b)
            if st in want or st == "error":
                return st
            time.sleep(3)
        return st
    if not c.check(wait_state("ardud", bid, ("ready", "running")) in ("ready", "running") and
                   wait_state("moni", hers, ("ready", "running")) in ("ready", "running"), "a box per owner was created and is ready", f"{bid} {hers}"):
        why = [(api(vm, w, "GET", f"/sandboxes/{b}").get("sandbox") or {}).get("error") for w, b in (("ardud", bid), ("moni", hers))]
        boatd_diag(c, vm, "boxes")
        raise Fail(f"the test boxes did not come up: {why}")
    cross = [api(vm, "ardud", "GET", f"/sandboxes/{hers}").get("http"),
             api(vm, "ardud", "POST", f"/sandboxes/{hers}/commands", {"command": "id", "detached": True}).get("http"),
             api(vm, "moni", "GET", f"/sandboxes/{bid}").get("http"),
             len(api(vm, "moni", "GET", "/sandboxes").get("sandboxes") or [])]
    c.check(cross == [404, 404, 404, 1], "on the real server: each token sees only its owner's box, the other one answers 404", cross)

    def start(b, cmd, retry=False, who="ardud"):
        body = {"command": cmd, "detached": True}
        if retry:
            body["retry_interrupted"] = True
        r = api(vm, who, "POST", f"/sandboxes/{b}/commands", body)
        if r.get("http") != 200:
            raise Fail(f"command not accepted: {json.dumps(r)[:300]}")
        return r["processId"], r["commandId"]

    def status(b, pid, who="ardud"):
        return api(vm, who, "GET", f"/sandboxes/{b}/commands/{pid}?tailBytes=200")

    def output(b, cid, which="stdout", who="ardud"):
        return api(vm, who, "GET", f"/sandboxes/{b}/command-history/{cid}/logs?stream={which}&offset=0").get("data") or ""

    def wait_done(b, pid, timeout=600, who="ardud"):
        t0, st = time.time(), {}
        while time.time() - t0 < timeout:
            st = status(b, pid, who)
            if st.get("http") == 200 and not st.get("running"):
                return st
            time.sleep(3)
        return st

    def wait_lines(b, cid, word, n, timeout=180):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if output(b, cid).count(word) >= n:
                return True
            time.sleep(2)
        return False

    # ---- 1. hard power cut: A runs (may be retried), D runs (must not be retried), B waits in the queue
    a_pid, a_cid = start(bid, 'for i in $(seq 1 45); do echo "A tick $i"; sleep 1; done; echo A-DONE', retry=True)
    d_pid, d_cid = start(bid, 'for i in $(seq 1 600); do echo "D tick $i"; sleep 1; done; echo D-DONE')
    c.check(wait_lines(bid, a_cid, "A tick", 6) and wait_lines(bid, d_cid, "D tick", 3), "runs A (retry_interrupted) and D (no retry) are running and printing")
    b_pid, b_cid = start(bid, "echo B-RAN; sleep 3; echo B-DONE")
    time.sleep(4)
    sb = status(bid, b_pid)
    hq = api(vm, "none", "GET", "/health")
    c.check(sb.get("queued") is True and hq.get("queue") == 1 and hq.get("running") == 2,
            "run B waits in the queue behind them (2 running, 1 queued in /health)", f"B={sb.get('status')} queued={sb.get('queued')} health={hq.get('running')}/{hq.get('queue')}")
    vm.ssh("sync", check=False)
    vm.power_cut()
    cut = time.time()
    vm.start(mem=12288, smp=8)
    boot = vm.wait_ssh("installed", 900, not_boot=boot)
    h1 = wait_api(vm)
    c.check(h1.get("ok") and h1.get("boot_id") and h1.get("boot_id") != h0.get("boot_id"),
            "after the power cut the machine booted unattended and boatd reports healthy with a new boot id",
            f"{int(time.time() - cut)}s after the cut; {h1.get('mode')} {h1.get('reasons')}")
    sa = wait_done(bid, a_pid, 420)
    oa = output(bid, a_cid)
    ea = output(bid, a_cid, "stderr")
    c.check(sa.get("status") == "exited" and sa.get("exitCode") == 0 and sa.get("attempt") == 2 and oa.count("A-DONE") == 1
            and oa.count("A tick 1\n") == 2 and "A tick 45\n" in oa and "queued again as attempt 2" in ea,
            "run A was retried exactly once as attempt 2 of the same run and finished (exit 0); the output of both attempts is there",
            f"status={sa.get('status')} exit={sa.get('exitCode')} attempt={sa.get('attempt')} A-DONE x{oa.count('A-DONE')} 'tick 1' x{oa.count('A tick 1' + chr(10))}")
    sd = status(bid, d_pid)
    od = output(bid, d_cid)
    c.check(sd.get("status") == "interrupted" and sd.get("running") is False and sd.get("exitCode") is None and sd.get("attempt") == 1
            and "D-DONE" not in od and od.count("D tick 1\n") == 1 and "is not run again" in output(bid, d_cid, "stderr"),
            "run D (no retry_interrupted) is marked interrupted, was not run again, and keeps the output it had",
            f"status={sd.get('status')} exit={sd.get('exitCode')} attempt={sd.get('attempt')} lines={od.count('D tick')}")
    sbd = wait_done(bid, b_pid, 300)
    c.check(sbd.get("status") == "exited" and sbd.get("exitCode") == 0 and sbd.get("attempt") == 1 and "B-DONE" in output(bid, b_cid),
            "run B, queued before the cut, started by itself after the restart and finished",
            f"status={sbd.get('status')} exit={sbd.get('exitCode')} attempt={sbd.get('attempt')}")
    snaps = api(vm, "ardud", "GET", f"/sandboxes/{bid}/snapshots").get("snapshots") or []
    zs = sshv(vm, f"zfs list -H -t snapshot -o name -r offbox/incus/containers/{bid.replace('_', '-')} | wc -l", check=False)
    c.check(len([x for x in snaps if x.get("kind") == "auto"]) >= 2 and int(zs or 0) >= 2,
            "the runs that finished after the restart each left a snapshot (API and ZFS agree)", f"api={len(snaps)} zfs={zs}")
    c.check(box_state("moni", hers) in ("ready", "running") and sshv(vm, "incus list -c s --format csv | grep -ci running") == "2",
            "both boxes the database called live are running again after the restart")
    pool_healthy(c, vm, "after the power cut with runs going")
    jr = sshv(vm, "journalctl -u boatd -b --no-pager | grep -a 'reconciled:' | tail -1", check=False)
    c.check('"retry": 1' in jr and '"interrupted": 1' in jr and '"requeue": 1' in jr, "boatd's journal records the reconcile (1 retried, 1 interrupted, 1 queued again)", jr[-260:])

    # ---- 2. boatd alone restarts mid-run: the run is not touched and its output is complete
    e_pid, e_cid = start(bid, 'for i in $(seq 1 60); do echo "E line $i"; sleep 0.5; done; echo E-DONE')
    wait_lines(bid, e_cid, "E line", 8)
    vm.ssh("systemctl kill -s KILL boatd; sleep 1; systemctl restart boatd", check=False)
    wait_api(vm, 300)
    se = wait_done(bid, e_pid, 240)
    oe = output(bid, e_cid)
    want = "".join(f"E line {i}\n" for i in range(1, 61)) + "E-DONE\n"
    c.check(se.get("status") == "exited" and se.get("exitCode") == 0 and se.get("attempt") == 1 and oe == want,
            "boatd killed and restarted mid-run: the run finished as attempt 1 and its output is complete, in order, nothing twice",
            f"status={se.get('status')} attempt={se.get('attempt')} bytes={len(oe)}/{len(want)}")
    f_pid, f_cid = start(bid, "sleep 8; echo F-DONE; exit 3")
    time.sleep(2)
    vm.ssh("systemctl stop boatd; sleep 16; systemctl start boatd", check=False, timeout=120)
    wait_api(vm, 300)
    sf = status(bid, f_pid)
    n2 = len(api(vm, "ardud", "GET", f"/sandboxes/{bid}/snapshots").get("snapshots") or [])
    c.check(sf.get("status") == "exited" and sf.get("exitCode") == 3 and "F-DONE" in output(bid, f_cid) and n2 > len(snaps),
            "a run that ended while boatd was down has its real exit code (3) and its snapshot", f"status={sf.get('status')} exit={sf.get('exitCode')} snapshots={n2}")
    nres = sshv(vm, "systemctl show boatd -p NRestarts --value")
    # ---- 3. person-box snapshots: the timer's job, on her box only
    rot = sshv(vm, "boatd snap-rotate hourly; boatd snap-rotate hourly", check=False)
    hs = [x.get("kind") for x in api(vm, "moni", "GET", f"/sandboxes/{hers}/snapshots").get("snapshots") or []]
    his = [x.get("kind") for x in api(vm, "ardud", "GET", f"/sandboxes/{bid}/snapshots").get("snapshots") or []]
    c.check(hs.count("hourly") >= 1 and "hourly" not in his and hers in rot and bid not in rot,
            "snap-rotate (the hourly timer's job) snapshots the person box and not the others", f"hers={hs} rotate={rot[:200]}")

    # ---- 4. the pool is not there when boatd starts: degraded mode, no crash loop, and it comes back by itself
    # Incus leaves its own mounts (shmounts, guestapi, the storage pool) under /var/lib/incus: they go first,
    # or the pool is busy and cannot be exported.
    holders = ("for p in /proc/[0-9]*; do { ls -l $p/cwd $p/root $p/exe $p/fd 2>/dev/null; cat $p/maps 2>/dev/null; } | "
               "grep -q '/var/lib/incus' && echo \"holder ${p#/proc/} $(tr '\\0' ' ' < $p/cmdline | cut -c1-120)\"; done")
    rc, exp_out = vm.ssh("cd /; systemctl stop boatd-snap-hourly.timer; systemctl stop boatd; incus stop --all --force; "
                         "systemctl stop incus-user.socket incus-user.service incus.socket incus.service incus-startup.service 2>/dev/null; "
                         "pkill -f '[d]nsmasq.*incus'; sleep 2; "
                         "umount -R /var/lib/incus 2>/dev/null || { echo 'umount busy:'; " + holders + "; "
                         "systemctl list-units --no-legend --state=active 'incus*' | cut -c1-80; findmnt -R -n -o TARGET /var/lib/incus; "
                         "for p in $(" + holders + " | awk '{print $2}'); do kill -9 $p; done; sleep 2; umount -R /var/lib/incus 2>&1; }; "
                         "zpool export offbox 2>&1 || { sleep 3; zpool export -f offbox 2>&1; }", check=False, timeout=300)
    exported = sshv(vm, "zpool list -H -o name 2>/dev/null | grep -c offbox", check=False)
    with open(os.path.join(c.dir, "pool-export.log"), "w") as f:
        f.write(exp_out)
    if exported != "0":
        c.log(f"zpool export did not work: {exp_out.strip()[-600:]}")
    # keep the pool away for a while: boatd must stay up and say why
    vm.ssh("systemctl start boatd", check=False)
    seen, refused = [], None
    t0 = time.time()
    while time.time() - t0 < 240:
        h = api(vm, "none", "GET", "/health")
        if h.get("http") == 200:
            seen.append((h.get("ok"), " | ".join(h.get("reasons") or [])))
            if h.get("ok"):
                break
            if refused is None:
                refused = api(vm, "ardud", "GET", "/sandboxes").get("http")
        time.sleep(1)
    deg = [s for s in seen if s[0] is False]
    c.check(exported == "0" and deg and any("state dataset" in s[1] or "pool offbox" in s[1] for s in deg),
            "started without its pool, boatd stays up in degraded mode and /health says why", f"exported={exported} first={deg[:1]}")
    c.check(bool(seen) and seen[-1][0] is True and sshv(vm, "systemctl show boatd -p NRestarts --value") == nres
            and sshv(vm, "systemctl is-active boatd incus | tr '\\n' ' '").startswith("active active"),
            "it imported the pool again by itself, started Incus, reconciled and went back to healthy without restarting",
            f"{len(deg)} degraded answers (API calls answered {refused} meanwhile), then ok")
    c.check(box_state("ardud", bid) in ("ready", "running") and sshv(vm, "findmnt -no SOURCE /var/lib/boatd") == "offbox/boatd",
            "the box is back and the state is on its dataset after the pool returned")
    vm.ssh("systemctl start boatd-snap-hourly.timer", check=False)

    # ---- 5. OS reinstall from the stick over the live pool: runs, boxes, tokens and snapshots are all still there
    old = sshv(vm, "cat /etc/offbox/installed")
    tokens_before = sshv(vm, "boatd token list | wc -l")
    vm.ssh("install -d -m 700 /offbox/vmtest-keep && cp /root/tok.* /root/api.url /offbox/vmtest-keep/ && sync && zpool sync offbox")
    put_marker(vm, "REINSTALL-OS")
    vm.ssh("systemctl reboot", check=False, timeout=20)
    new = wait_new_install(c, vm, old)
    c.check("mode=preserve" in new, "REINSTALL-OS: the OS was reinstalled by itself; /root and /var are new", new[:70])
    c.check(sshv(vm, "ls /opt/boatd/boatd.py /root/tok.ardud 2>&1 | grep -c 'No such'") == "2", "the new OS has no boatd and no leftovers of the old root")
    vm.ssh("zpool list offbox >/dev/null 2>&1 || zpool import -f offbox; cp /offbox/vmtest-keep/* /root/; chmod 600 /root/tok.*", check=False, timeout=300)
    t0 = time.time()
    install_host(c, vm, "install-host.sh on the reinstalled OS with the pool imported")
    took = int(time.time() - t0)
    h2 = wait_api(vm)
    c.check(h2.get("ok") is True, "boatd is healthy on the reinstalled OS", f"{took}s; {h2.get('mode')} {h2.get('reasons')}")
    mounts = sshv(vm, "findmnt -no SOURCE /var/lib/boatd; findmnt -no SOURCE /var/lib/incus")
    c.check("offbox/boatd" in mounts and "offbox/incus-var" in mounts, "the state datasets were reused, not recreated", mounts.replace("\n", " "))
    boxes = sorted(b.get("id") for b in api(vm, "ardud", "GET", "/sandboxes").get("sandboxes") or [])
    mine = api(vm, "moni", "GET", f"/sandboxes/{hers}")
    c.check(boxes == [bid] and mine.get("http") == 200 and api(vm, "legacy", "GET", "/limits").get("http") == 200
            and sshv(vm, "boatd token list | wc -l") == tokens_before,
            "after the reinstall the same tokens work and each owner still has exactly their box", f"{boxes} moni={mine.get('http')}")
    c.check(output(bid, a_cid).count("A-DONE") == 1 and status(bid, d_pid).get("status") == "interrupted" and status(bid, f_pid).get("exitCode") == 3,
            "run history and run logs from before the reinstall are intact")
    img = sshv(vm, "incus image list --format csv -c l | tr '\\n' ' '; incus list --format csv -c n | tr '\\n' ' '", check=False)
    c.check("offbox-base" in img and bid.replace("_", "-") in img and hers.replace("_", "-") in img,
            "Incus still knows the base image and both boxes (its database is on the pool)", img[:200])
    api(vm, "ardud", "POST", f"/sandboxes/{bid}/resume", {})
    wait_state("ardud", bid, ("ready", "running"), 300)
    g_pid, g_cid = start(bid, "cat /etc/hostname; echo G-DONE")
    sg = wait_done(bid, g_pid, 180)
    c.check(sg.get("exitCode") == 0 and "G-DONE" in output(bid, g_cid), "a run in the old box works on the reinstalled server",
            f"status={sg.get('status')} exit={sg.get('exitCode')}")
    n3 = len(api(vm, "ardud", "GET", f"/sandboxes/{bid}/snapshots").get("snapshots") or [])
    c.check(n3 > n2, "its snapshots from before the reinstall are still listed, plus the new one", f"{n2} -> {n3}")
    pool_healthy(c, vm, "after the OS reinstall")
    vm.ssh("zpool scrub -w offbox", timeout=1800)
    z = sshv(vm, "zpool status offbox | grep -E 'scan:|errors:' | tr -s ' \\n' ' '")
    c.check("0 errors" in z or "No known data errors" in z, "scrub at the end: no errors", z)


CASES = {
    "c1": (c1, "zero-touch fresh install, layout as specified"),
    "recheck-c1": (recheck_c1, "helper: repeat the c1 checks on the disks of the last c1 run"),
    "golden-pool": (golden_pool, "helper: golden install + ZFS pool with known content"),
    "c2": (c2, "boots unattended with either NVMe removed"),
    "c3": (c3, "stick left in across 3 reboots: never reinstalls, pool data survives"),
    "c4": (c4, "power cut at several points mid-install"),
    "c5": (c5, "no network during install"),
    "c6": (c6, "REINSTALL-OS keeps the pool, WIPE-EVERYTHING wipes, no marker refuses"),
    "c7": (c7, "poweroff / halt / shutdown -h / power button end in a running machine"),
    "c8": (c8, "kernel panic and hard hang recover by themselves"),
    "c9": (c9, "emergency mode is reachable over SSH and recovers"),
    "c10": (c10, "a kernel that fails its one-shot try falls back"),
    "c11": (c11, "install-host.sh on the stick install; 3 hard power cuts with a healthy pool"),
    "c12": (c12, "boatd durability: power cut with runs going and queued, boatd restart mid-run, pool missing, OS reinstall"),
    "sb": (sb, "extra: Secure Boot enforced, install + the stick starting the installed system"),
    "err": (err, "extra: a failed install is logged, reachable and retried by itself"),
    "acc": (acc, "extra: acceptance.sh runs cleanly on an install and its watchdog test works"),
    "kvm-empty": (kvm_empty, "KVM attached (USB keyboard, mouse, empty virtual drive): C1 + C3 again, manual GRUB entry"),
    "kvm-fat": (kvm_fat, "KVM attached, its drive holding an unrelated FAT volume with decoy marker files: C1 + C3 again"),
    "macstick": (macstick, "extra: an image written by the Mac's write-stick.zsh installs and boots (OHV_MAC_STICK)"),
    "ts": (ts, "tailnet: installer and installed system join by themselves, reachable from the Mac"),
}


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 2
    if args[0] == "build":
        build(None)
        return 0
    names = [n for n in CASES if n not in ("recheck-c1", "ts", "macstick")] if args[0] == "all" else args
    os.makedirs(RESULTS, exist_ok=True)
    ok = True
    for n in names:
        if n not in CASES:
            print(f"unknown case {n}")
            return 2
        fn, title = CASES[n]
        c = Case(n, title)
        c.log(f"START {title}")
        err = None
        try:
            fn(c)
        except Fail as e:
            err = str(e)
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
            c.log(traceback.format_exc())
        ok = c.finish(err) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
