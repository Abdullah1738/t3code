"""vm.py: a QEMU/KVM machine shaped like the home server, for the offbox installer tests.

UEFI (OVMF), two NVMe disks of the real size, the installer stick as a USB drive, one wired NIC with DHCP,
no display. Everything a test needs: start, hard power cut, ACPI power button, pull a disk, pull the network
cable, read the serial console, run commands over SSH, read the stick's log volume afterwards.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time

NVME_BYTES = 2000398934016  # 2 TB, as the Kingston drives report it
OVMF_CODE = "/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS = "/usr/share/OVMF/OVMF_VARS_4M.fd"
OVMF_CODE_SB = "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd"
OVMF_VARS_SB = "/usr/share/OVMF/OVMF_VARS_4M.ms.fd"
STICK_P2_START_MIB = 1 + 16384


class Fail(Exception):
    pass


def run(cmd, check=True, **kw):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **kw)
    if check and p.returncode != 0:
        raise Fail(f"{' '.join(map(str, cmd))} -> {p.returncode}: {p.stdout[-600:]}")
    return p.stdout


def qcow(path, size=None, backing=None):
    cmd = ["qemu-img", "create", "-q", "-f", "qcow2"]
    if backing:
        fmt = "raw" if backing.endswith(".img") else "qcow2"
        cmd += ["-b", os.path.abspath(backing), "-F", fmt]
    cmd.append(path)
    if size:
        cmd.append(str(size))
    run(cmd)
    return path


class VM:
    def __init__(self, work, name, port, log):
        self.work = work
        self.name = name
        self.port = port
        self.log = log
        self.dir = os.path.join(work, name)
        os.makedirs(self.dir, exist_ok=True)
        self.disks = [os.path.join(self.dir, "nvme0.qcow2"), os.path.join(self.dir, "nvme1.qcow2")]
        self.stick = os.path.join(self.dir, "stick.qcow2")
        self.vars = os.path.join(self.dir, "OVMF_VARS.fd")
        self.serial = os.path.join(self.dir, "serial.log")
        self.qmp_path = os.path.join(self.dir, "qmp.sock")
        self.pidfile = os.path.join(self.dir, "qemu.pid")
        self.fwcfg = {}
        self.key = os.path.join(work, "testkey")
        self.boots = 0
        self.secboot = False
        self.proc = None
        self.cable_out = False
        self.qmp_lock = threading.Lock()

    # ------------------------------------------------------------------ images
    def fresh_disks(self):
        for d in self.disks:
            if os.path.exists(d):
                os.remove(d)
            qcow(d, size=NVME_BYTES)
        shutil.copy(OVMF_VARS_SB if self.secboot else OVMF_VARS, self.vars)

    def fresh_stick(self, base):
        if os.path.exists(self.stick):
            os.remove(self.stick)
        qcow(self.stick, backing=base)

    def from_golden(self, golden, stick=True):
        """Disks, firmware variables and stick as a finished install left them (copy-on-write)."""
        for i, d in enumerate(self.disks):
            if os.path.exists(d):
                os.remove(d)
            qcow(d, backing=os.path.join(golden, f"nvme{i}.qcow2"))
        shutil.copy(os.path.join(golden, "OVMF_VARS.fd"), self.vars)
        if stick:
            if os.path.exists(self.stick):
                os.remove(self.stick)
            # OHV_FRESH_STICK=<image>: development only, try a newer stick build against older golden disks
            qcow(self.stick, backing=os.environ.get("OHV_FRESH_STICK") or os.path.join(golden, "stick.qcow2"))

    def save_golden(self, golden):
        os.makedirs(golden, exist_ok=True)
        for i, d in enumerate(self.disks):
            shutil.copy(d, os.path.join(golden, f"nvme{i}.qcow2"))
        shutil.copy(self.vars, os.path.join(golden, "OVMF_VARS.fd"))
        # flatten the stick overlay so the golden set is self-contained
        run(["qemu-img", "convert", "-O", "qcow2", self.stick, os.path.join(golden, "stick.qcow2")])

    # ------------------------------------------------------------------ run
    def start(self, disks=(0, 1), stick=True, net=True, stick_first=False, mem=8192, smp=4):
        if self.running():
            raise Fail("already running")
        self.boots += 1
        for f in (self.qmp_path, self.pidfile):
            if os.path.exists(f):
                os.remove(f)
        code = OVMF_CODE_SB if self.secboot else OVMF_CODE
        machine = "q35,accel=kvm" + (",smm=on" if self.secboot else "")
        cmd = [
            "qemu-system-x86_64", "-name", self.name, "-machine", machine, "-cpu", "host", "-smp", str(smp),
            "-m", str(mem), "-display", "none", "-rtc", "base=utc", "-nodefaults",
            "-drive", f"if=pflash,format=raw,unit=0,readonly=on,file={code}",
            "-drive", f"if=pflash,format=raw,unit=1,file={self.vars}",
            "-chardev", f"file,id=ser0,path={self.serial},append=on", "-serial", "chardev:ser0",
            "-qmp", f"unix:{self.qmp_path},server=on,wait=off", "-pidfile", self.pidfile,
            "-device", "i6300esb", "-action", "watchdog=reset",
            "-device", "qemu-xhci,id=xhci",
        ]
        if self.secboot:
            cmd += ["-global", "driver=cfi.pflash01,property=secure,value=on"]
        for i in disks:
            cmd += ["-drive", f"file={self.disks[i]},if=none,id=nv{i},format=qcow2,discard=unmap,detect-zeroes=unmap,cache=writeback",
                    "-device", f"nvme,drive=nv{i},serial=OFFBOXTEST{i}" + (f",bootindex={i + 1}" if stick_first else "")]
        if stick:
            cmd += ["-drive", f"file={self.stick},if=none,id=stick,format=qcow2,cache=writethrough",
                    "-device", "usb-storage,bus=xhci.0,drive=stick,removable=on" + (",bootindex=0" if stick_first else "")]
        cmd += ["-netdev", f"user,id=n0,hostfwd=tcp:127.0.0.1:{self.port}-:22",
                "-device", "e1000e,netdev=n0,id=nic0,mac=52:54:00:0f:fb:01,romfile="]
        for k, v in self.fwcfg.items():
            cmd += ["-fw_cfg", f"name=opt/offbox/{k},string={str(v).replace(',', ',,')}"]
        if not net:
            cmd.append("-S")
        with open(self.serial, "a") as f:
            f.write(f"\n===== vmtest: power on #{self.boots} disks={list(disks)} stick={stick} net={net} "
                    f"stick_first={stick_first} =====\n")
        self.proc = subprocess.Popen(cmd, stdout=open(os.path.join(self.dir, "qemu.out"), "a"), stderr=subprocess.STDOUT)
        deadline = time.time() + 20
        while not os.path.exists(self.qmp_path):
            if self.proc.poll() is not None or time.time() > deadline:
                raise Fail("qemu did not start: " + open(os.path.join(self.dir, "qemu.out")).read()[-800:])
            time.sleep(0.2)
        self.cable_out = not net
        if not net:
            self.qmp("set_link", name="nic0", up=False)
            self.qmp("cont")
            threading.Thread(target=self._hold_cable_out, args=(self.proc,), daemon=True).start()
        self.log(f"{self.name}: power on #{self.boots} disks={list(disks)} stick={stick} net={net} stick_first={stick_first}")

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def _hold_cable_out(self, proc):
        """QEMU forgets a link-down set before the machine runs, and may again at a machine reset: while the
        cable is meant to be out, say so once a second (a reset is long over before any NIC driver loads)."""
        while self.cable_out and self.proc is proc and proc.poll() is None:
            try:
                self.qmp("set_link", name="nic0", up=False)
            except (Fail, OSError, ValueError):
                pass
            time.sleep(1)

    def qmp(self, execute, **arguments):
        with self.qmp_lock:
            return self._qmp(execute, **arguments)

    def _qmp(self, execute, **arguments):
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(20)
        s.connect(self.qmp_path)
        f = s.makefile("rw")
        f.readline()
        f.write(json.dumps({"execute": "qmp_capabilities"}) + "\n")
        f.flush()
        f.readline()
        msg = {"execute": execute}
        if arguments:
            msg["arguments"] = arguments
        f.write(json.dumps(msg) + "\n")
        f.flush()
        while True:
            r = json.loads(f.readline())
            if "return" in r or "error" in r:
                break
        s.close()
        if "error" in r:
            raise Fail(f"qmp {execute}: {r['error']}")
        return r["return"]

    def power_cut(self):
        """Pull the plug: the QEMU process is killed without warning."""
        if self.running():
            self.proc.send_signal(signal.SIGKILL)
            self.proc.wait()
        self.log(f"{self.name}: POWER CUT")

    def power_button(self):
        self.qmp("system_powerdown")

    def link(self, up):
        self.cable_out = not up
        self.qmp("set_link", name="nic0", up=up)
        if not up:
            threading.Thread(target=self._hold_cable_out, args=(self.proc,), daemon=True).start()
        self.log(f"{self.name}: network cable {'in' if up else 'out'}")

    def clean_stop(self, timeout=180):
        """Stop the machine with clean file systems: let it restart and make QEMU exit at the reset."""
        self.qmp("set-action", reboot="shutdown")
        self.ssh("systemctl reboot", check=False, timeout=20)
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.power_cut()
            raise Fail("machine did not go down cleanly")
        self.log(f"{self.name}: stopped cleanly")

    def wait_off(self, timeout):
        try:
            self.proc.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    # ------------------------------------------------------------------ serial console
    def serial_size(self):
        return os.path.getsize(self.serial) if os.path.exists(self.serial) else 0

    def serial_text(self, since=0):
        if not os.path.exists(self.serial):
            return ""
        with open(self.serial, "rb") as f:
            f.seek(since)
            return f.read().decode("utf-8", "replace")

    def wait_serial(self, pattern, timeout, since=0, must_run=True):
        end = time.time() + timeout
        while time.time() < end:
            if pattern in self.serial_text(since):
                return True
            if must_run and not self.running():
                raise Fail(f"machine switched off while waiting for {pattern!r} on the console")
            time.sleep(2)
        raise Fail(f"console never showed {pattern!r} within {timeout}s")

    # ------------------------------------------------------------------ ssh
    def ssh(self, cmd, check=True, timeout=120, key=None):
        """Run cmd as root in the guest. Returns (exit code, stdout); stderr is appended only when it failed."""
        full = ["ssh", "-p", str(self.port), "-i", key or self.key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=8",
                "-o", "LogLevel=ERROR", "root@127.0.0.1", cmd]
        env = {k: v for k, v in os.environ.items() if not k.startswith("LC_") and k != "LANG"}
        try:
            p = subprocess.run(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            if check:
                raise Fail(f"ssh timed out: {cmd[:80]}")
            return 124, ""
        if check and p.returncode != 0:
            raise Fail(f"ssh `{cmd[:120]}` -> {p.returncode}: {(p.stdout + p.stderr)[-600:]}")
        return p.returncode, p.stdout if p.returncode == 0 else p.stdout + p.stderr

    def scp(self, src, dst):
        run(["scp", "-P", str(self.port), "-i", self.key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
             "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-r"]
            + list(src) + [f"root@127.0.0.1:{dst}"])

    def who(self):
        """'installed', 'installer', or None when nothing answers on SSH."""
        rc, out = self.ssh("if [ -s /etc/offbox/installed ]; then echo installed; else echo installer; fi; cat /proc/sys/kernel/random/boot_id",
                           check=False, timeout=15)
        if rc != 0 or not out.strip():
            return None, None
        lines = out.strip().splitlines()
        return lines[0], lines[-1]

    def wait_ssh(self, want="installed", timeout=600, not_boot=None, must_run=True):
        """Wait until SSH answers from the wanted system (and, if given, from a different boot than not_boot)."""
        end = time.time() + timeout
        last = None
        while time.time() < end:
            if must_run and not self.running():
                raise Fail("machine is OFF (qemu exited) while waiting for it to come up")
            kind, boot = self.who()
            last = kind
            if kind == want and boot and boot != not_boot:
                return boot
            time.sleep(4)
        raise Fail(f"no SSH from the {want} system within {timeout}s (last seen: {last})")

    def boot_id(self):
        return self.ssh("cat /proc/sys/kernel/random/boot_id")[1].strip()

    # ------------------------------------------------------------------ the stick's log volume
    def stick_logs(self, dest):
        """Copy the stick's log volume (partition 2) out of the image. The machine must be off or not writing."""
        os.makedirs(dest, exist_ok=True)
        full = os.path.join(self.dir, "stick-full.img")
        run(["qemu-img", "convert"] + (["-U"] if self.running() else []) + ["-f", "qcow2", "-O", "raw", self.stick, full])
        env = dict(os.environ, MTOOLS_SKIP_CHECK="1")
        start = STICK_P2_START_MIB * 1024 * 1024
        try:  # read the real offset of partition 2 (an image written by macOS is laid out differently)
            parts = json.loads(run(["sfdisk", "-J", full]))["partitiontable"]["partitions"]
            start = int(parts[1]["start"]) * 512
        except (Fail, ValueError, KeyError, IndexError):
            pass
        p = subprocess.run(["mcopy", "-i", f"{full}@@{start}", "-s", "-n", "-Q", "::*", dest],
                           env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        os.remove(full)
        if p.returncode != 0:
            self.log(f"{self.name}: reading the stick's log volume failed: {p.stdout.strip()[-300:]}")
        # the installer's tailnet identity is a secret: never keep it with the logs
        shutil.rmtree(os.path.join(dest, "ts-installer"), ignore_errors=True)
        for f in ("tailscale-authkey", "tailscale-authkey.txt"):
            if os.path.exists(os.path.join(dest, f)):
                os.remove(os.path.join(dest, f))
        stage = os.path.join(dest, "stage.log")
        return open(stage).read() if os.path.exists(stage) else ""
