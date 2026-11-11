#!/usr/bin/env python3
"""plan.py: decides what the offbox installer may do to the internal disks, and does the disk part of it.

  plan.py decide  [--facts F] > plan.json    look at the disks and the stick, decide. Changes nothing.
  plan.py prepare plan.json                  stop arrays and clear what the plan allows to be cleared.
  plan.py render  plan.json IN OUT           write the autoinstall file with the real storage section.
  plan.py consume plan.json ESP_DIR...       record + delete the marker files that were acted on.

Rules (the brief's "install modes"):
  target disks = the two NVMe disks of equal size. Anything else -> abort, logged, nothing touched.
  WIPE-EVERYTHING marker                     -> full: everything on both disks goes.
  REINSTALL-OS marker                        -> preserve: ESP + /boot + / are rebuilt, the offbox-zfs
                                                partitions are never written to.
  no marker, finished install on the disks   -> refuse (boot the disks instead).
  no marker, ZFS pool data, no finished mark -> refuse (data present, an explicit marker is required).
  no marker, anything else                   -> full. This covers blank disks and an install that lost power
                                                half-way: without the pool nothing on the disks is worth keeping.
A marker that was already acted on (recorded on the ESP) but could not be deleted from the stick is ignored, so
a stick that has gone read-only cannot cause a reinstall loop.
"""
import hashlib
import json
import os
import subprocess
import sys
import time

GIB = 1024**3
MIB = 1024**2
ESP_SIZE = 1 * GIB
BOOT_SIZE = 2 * GIB
ROOT_SIZE = 150 * GIB
MIN_DISK = 200 * GIB
NAMES = {1: "offbox-esp", 2: "offbox-boot", 3: "offbox-root", 4: "offbox-zfs"}
MARKERS = {
    "wipe-everything": "wipe",
    "wipe-everything.txt": "wipe",
    "reinstall-os": "reinstall",
    "reinstall-os.txt": "reinstall",
}
INSTALLED_MARK = "EFI/offbox/installed"
CONSUMED_LOG = "EFI/offbox/consumed"
RUN = "/run/offbox"
LOG = None


def log(msg):
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + msg
    print(line, file=sys.stderr, flush=True)
    if LOG:
        with open(LOG, "a") as f:
            f.write(line + "\n")


def sh(cmd, check=False, quiet=False):
    """Run a command (list), return (rc, stdout). Everything is logged."""
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if not quiet:
        log("$ " + " ".join(cmd) + f" -> rc={p.returncode}" + ("\n" + p.stdout.rstrip() if p.stdout.strip() else ""))
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed rc={p.returncode}: {p.stdout.strip()[-400:]}")
    return p.returncode, p.stdout


# --------------------------------------------------------------------------------------------- facts
def blkid(dev):
    rc, out = sh(["blkid", "-p", "-o", "export", dev], quiet=True)
    d = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k] = v
    return d


def read_esp(dev):
    """Mount a FAT partition read-only and report our files on it."""
    mnt = os.path.join(RUN, "probe-esp")
    os.makedirs(mnt, exist_ok=True)
    res = {"installed": None, "consumed": []}
    rc, _ = sh(["mount", "-t", "vfat", "-o", "ro", dev, mnt], quiet=True)
    if rc != 0:
        return res
    try:
        p = os.path.join(mnt, INSTALLED_MARK)
        if os.path.isfile(p):
            res["installed"] = open(p, errors="replace").read().strip()[:400] or "present"
        p = os.path.join(mnt, CONSUMED_LOG)
        if os.path.isfile(p):
            res["consumed"] = [l.strip() for l in open(p, errors="replace") if l.strip()]
    finally:
        sh(["umount", mnt], quiet=True)
    return res


def marker_identity(path, kind):
    st = os.stat(path)
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read(1 << 20))
    return f"{kind}:{st.st_size}:{int(st.st_mtime)}:{h.hexdigest()[:16]}"


def find_markers(roots):
    found = []
    for root in roots:
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for n in names:
            kind = MARKERS.get(n.lower())
            p = os.path.join(root, n)
            if kind and os.path.isfile(p):
                found.append({"kind": kind, "path": p, "identity": marker_identity(p, kind)})
    return found


def gather():
    """Everything decide() needs, as plain data (so the decision can be unit-tested from a fixture)."""
    facts = {"errors": []}
    rc, out = sh(["findmnt", "-n", "-o", "SOURCE", "/cdrom"], quiet=True)
    stick_part = out.strip()
    stick_disk = ""
    if stick_part:
        rc, out = sh(["lsblk", "-no", "PKNAME", stick_part], quiet=True)
        stick_disk = out.strip().splitlines()[0] if out.strip() else ""
    facts["stick"] = {"partition": stick_part, "disk": stick_disk}

    rc, out = sh(["lsblk", "-J", "-b", "-d", "-o", "NAME,PATH,TYPE,TRAN,SIZE,RM,RO,MODEL,SERIAL"], quiet=True)
    try:
        devs = json.loads(out)["blockdevices"]
    except (ValueError, KeyError):
        devs = []
        facts["errors"].append("lsblk failed: " + out.strip()[:200])
    facts["all_disks"] = devs
    disks = []
    for d in devs:
        if d.get("type") != "disk" or d.get("name") == stick_disk:
            continue
        if d.get("tran") != "nvme" and not str(d.get("name", "")).startswith("nvme"):
            continue
        if d.get("rm") in (True, "1", 1) or not d.get("size"):
            continue
        disk = {k: d.get(k) for k in ("name", "path", "size", "model", "serial")}
        disk["size"] = int(disk["size"])
        disk["partitions"] = []
        disk["ptable"] = None
        rc, out = sh(["sfdisk", "-J", disk["path"]], quiet=True)
        if rc == 0:
            try:
                pt = json.loads(out)["partitiontable"]
                disk["ptable"] = pt.get("label")
                ss = int(pt.get("sectorsize", 512))
                for i, p in enumerate(pt.get("partitions", [])):
                    node = p["node"]
                    num = int("".join(ch for ch in node[len(disk["path"]):] if ch.isdigit()) or i + 1)
                    part = {
                        "node": node, "number": num, "start": int(p["start"]) * ss, "size": int(p["size"]) * ss,
                        "type": p.get("type", ""), "name": p.get("name", ""), "uuid": p.get("uuid", ""),
                    }
                    b = blkid(node)
                    part["fstype"] = b.get("TYPE", "")
                    part["label"] = b.get("LABEL", "")
                    if part["fstype"] == "vfat":
                        part["esp"] = read_esp(node)
                    disk["partitions"].append(part)
            except (ValueError, KeyError) as e:
                facts["errors"].append(f"sfdisk parse {disk['path']}: {e}")
        b = blkid(disk["path"])
        disk["whole_fstype"] = b.get("TYPE", "")
        disk["whole_label"] = b.get("LABEL", "")
        disks.append(disk)
    facts["nvme"] = sorted(disks, key=lambda d: d["name"])
    facts["markers"] = find_markers(["/cdrom", os.path.join(RUN, "logvol")])
    return facts


# --------------------------------------------------------------------------------------------- decide
def layout_ok(disks):
    """True when both disks carry exactly our four partitions, same geometry on both."""
    geo = []
    for d in disks:
        if d.get("ptable") != "gpt":
            return False, f"{d['path']}: no GPT"
        parts = {p["number"]: p for p in d["partitions"]}
        if sorted(parts) != [1, 2, 3, 4]:
            return False, f"{d['path']}: partitions {sorted(parts)} instead of 1-4"
        for n, want in NAMES.items():
            if parts[n]["name"] != want:
                return False, f"{d['path']} partition {n}: name {parts[n]['name']!r} instead of {want!r}"
        for n, want in ((1, ESP_SIZE), (2, BOOT_SIZE), (3, ROOT_SIZE)):
            if parts[n]["size"] != want:
                return False, f"{d['path']} partition {n}: size {parts[n]['size']} instead of {want}"
        geo.append([(parts[n]["start"], parts[n]["size"]) for n in (1, 2, 3, 4)])
    if geo[0] != geo[1]:
        return False, "the two disks do not have the same partition geometry"
    return True, "ok"


def decide(facts):
    plan = {"action": "abort", "reason": "", "mode": None, "disks": [], "markers": facts.get("markers", []),
            "consumed_markers": [], "boot_disk_hint": None}
    nv = facts.get("nvme", [])
    seen = ", ".join(f"{d['path']}={d['size']}" for d in nv) or "none"
    if facts.get("errors"):
        plan["reason"] = "could not read the disks: " + "; ".join(facts["errors"])
        return plan
    if len(nv) != 2:
        plan["reason"] = f"need exactly two NVMe disks, found {len(nv)} ({seen})"
        return plan
    if nv[0]["size"] != nv[1]["size"]:
        plan["reason"] = f"the two NVMe disks are not the same size ({seen})"
        return plan
    if nv[0]["size"] < MIN_DISK:
        plan["reason"] = f"NVMe disks are smaller than {MIN_DISK // GIB} GiB ({seen})"
        return plan
    plan["disks"] = [{"path": d["path"], "name": d["name"], "size": d["size"], "model": d.get("model"),
                      "serial": d.get("serial")} for d in nv]

    installed, consumed, zfs, md = [], set(), [], []
    for d in nv:
        if d.get("whole_fstype") == "zfs_member":
            zfs.append(d["path"])
        for p in d["partitions"]:
            if p.get("fstype") == "zfs_member":
                zfs.append(p["node"])
            if p.get("fstype") == "linux_raid_member":
                md.append(p["node"])
            esp = p.get("esp") or {}
            if esp.get("installed"):
                installed.append(p["node"])
            consumed.update(esp.get("consumed", []))
    plan["found"] = {"installed_marks": installed, "zfs_members": zfs, "md_members": md}

    live = [m for m in plan["markers"] if m["identity"] not in consumed]
    plan["consumed_markers"] = [m for m in plan["markers"] if m["identity"] in consumed]
    kinds = sorted({m["kind"] for m in live})

    if kinds == ["wipe"]:
        plan.update(action="install", mode="full", reason="WIPE-EVERYTHING marker on the stick")
    elif kinds == ["reinstall"]:
        ok, why = layout_ok(nv)
        if ok:
            plan.update(action="install", mode="preserve", reason="REINSTALL-OS marker on the stick")
            plan["geometry"] = [{"number": p["number"], "start": p["start"], "size": p["size"]}
                                for p in sorted(nv[0]["partitions"], key=lambda p: p["number"])]
        else:
            plan.update(action="abort", reason="REINSTALL-OS asked for, but the disks do not carry the offbox "
                        f"layout ({why}). Nothing was changed. Use WIPE-EVERYTHING for a full install.")
    elif len(kinds) > 1:
        plan.update(action="abort", reason="both WIPE-EVERYTHING and REINSTALL-OS are on the stick: remove one")
    elif installed:
        plan.update(action="refuse", reason="a finished offbox install is on the disks and the stick has no "
                    "marker file: not installing", boot_disk_hint=installed[0])
    elif zfs:
        plan.update(action="refuse", reason="ZFS pool data is on the disks (" + ", ".join(zfs) + ") but no "
                    "finished-install mark and no marker file: not touching it. REINSTALL-OS keeps the pool.")
    else:
        why = "blank disks" if not md and not any(d["partitions"] for d in nv) else \
            "no finished install and no pool data on the disks (interrupted install or leftovers)"
        plan.update(action="install", mode="full", reason=why)
    return plan


# --------------------------------------------------------------------------------------------- prepare
def stop_arrays():
    sh(["swapoff", "-a"])
    sh(["mdadm", "--stop", "--scan"])
    for n in sorted(os.listdir("/dev")):
        if n.startswith("md") and n[2:].isdigit():
            sh(["mdadm", "--stop", "/dev/" + n])
    sh(["udevadm", "settle", "--timeout=30"])


def zero_ends(dev, size, span=8 * MIB):
    span = min(span, size)
    sh(["dd", "if=/dev/zero", "of=" + dev, "bs=1M", f"count={span // MIB}", "conv=fsync", "status=none"])
    if size > span:
        sh(["dd", "if=/dev/zero", "of=" + dev, "bs=1M", f"seek={(size - span) // MIB}", f"count={span // MIB}",
            "conv=fsync", "status=none"])


def part_nodes(disk):
    rc, out = sh(["lsblk", "-lnpb", "-o", "NAME,TYPE,SIZE", disk], quiet=True)
    res = []
    for line in out.splitlines():
        f = line.split()
        if len(f) == 3 and f[1] == "part":
            res.append((f[0], int(f[2])))
    return res


def carry_over(plan):
    """REINSTALL-OS: keep the machine's identity (ssh host keys, tailnet node, boatd token) from the old root."""
    dest = os.path.join(RUN, "carry")
    mnt = os.path.join(RUN, "oldroot")
    os.makedirs(dest, exist_ok=True)
    os.makedirs(mnt, exist_ok=True)
    members = [d["path"] + "p3" for d in plan["disks"]]
    md = None
    rc, out = sh(["lsblk", "-lnpo", "NAME,TYPE"] + members, quiet=True)
    for line in out.splitlines():
        f = line.split()
        if len(f) == 2 and f[1].startswith("raid"):
            md = f[0]
    if not md:
        md = "/dev/md/offbox-carry"
        sh(["mdadm", "--assemble", "--readonly", "--run", md] + members)
    rc, _ = sh(["mount", "-o", "ro,noload", md, mnt])
    if rc != 0:
        rc, _ = sh(["mount", "-o", "ro", md, mnt])
    if rc != 0:
        log("carry-over: old root not mountable, the new install gets a fresh identity")
        return
    try:
        keep = [p for p in ("var/lib/tailscale", "etc/boatd", "etc/machine-id") if os.path.exists(os.path.join(mnt, p))]
        try:  # host keys only: the sshd configuration always comes from the stick
            keep += sorted("etc/ssh/" + n for n in os.listdir(os.path.join(mnt, "etc/ssh")) if n.startswith("ssh_host_"))
        except OSError:
            pass
        if keep:
            sh(["tar", "-C", mnt, "-cpf", os.path.join(dest, "carry.tar")] + keep)
            os.chmod(os.path.join(dest, "carry.tar"), 0o600)
            log("carry-over: saved " + ", ".join(keep))
    finally:
        sh(["umount", mnt])


def prepare(plan):
    if plan.get("action") != "install":
        raise SystemExit("plan does not allow an install")
    disks = [d["path"] for d in plan["disks"]]
    if plan["mode"] == "preserve":
        carry_over(plan)
    stop_arrays()
    if plan["mode"] == "full":
        for d in disks:
            for node, size in part_nodes(d):
                sh(["wipefs", "-a", "-f", node])
                zero_ends(node, size)
            sh(["sgdisk", "--zap-all", d])
            sh(["wipefs", "-a", "-f", d])
            sh(["blkdiscard", "-f", d])  # instant on NVMe; failure is fine
            zero_ends(d, next(x["size"] for x in plan["disks"] if x["path"] == d))
            sh(["blockdev", "--rereadpt", d])
    elif plan["mode"] == "preserve":
        for d in disks:
            for node, size in part_nodes(d):
                num = int("".join(ch for ch in node[len(d):] if ch.isdigit()))
                if num == 4:
                    log(f"preserve: leaving {node} (offbox-zfs) untouched")
                    continue
                sh(["wipefs", "-a", "-f", node])
                zero_ends(node, size)
    else:
        raise SystemExit(f"unknown mode {plan['mode']}")
    sh(["udevadm", "settle", "--timeout=30"])
    stop_arrays()  # udev may have re-assembled something from a stale superblock while we were wiping
    sh(["lsblk", "-o", "NAME,SIZE,TYPE,FSTYPE,PARTLABEL"] + disks)


# --------------------------------------------------------------------------------------------- render
def storage_config(plan):
    cfg = []
    full = plan["mode"] == "full"
    geo = {g["number"]: g for g in plan.get("geometry", [])}
    for i, d in enumerate(plan["disks"]):
        disk = {"type": "disk", "id": f"disk{i}", "path": d["path"], "ptable": "gpt", "preserve": not full,
                "grub_device": False}
        if full:
            disk["wipe"] = "superblock-recursive"
        cfg.append(disk)
        sizes = {1: ESP_SIZE, 2: BOOT_SIZE, 3: ROOT_SIZE, 4: -1}
        for n in (1, 2, 3, 4):
            p = {"type": "partition", "id": f"d{i}p{n}", "device": f"disk{i}", "number": n, "preserve": not full,
                 "partition_name": NAMES[n], "grub_device": n == 1}  # type codes are set by late.sh (sgdisk)
            if n == 1:
                p["flag"] = "boot"
            if full:
                p["size"] = sizes[n]
                p["wipe"] = "superblock"
            else:
                p["size"] = geo[n]["size"]
                p["offset"] = geo[n]["start"]
                p["path"] = f"{d['path']}p{n}"
                if n != 4:
                    p["wipe"] = "superblock"
            cfg.append(p)
    cfg += [
        {"type": "format", "id": "fs-esp0", "volume": "d0p1", "fstype": "fat32", "preserve": False},
        {"type": "format", "id": "fs-esp1", "volume": "d1p1", "fstype": "fat32", "preserve": False},
        # /boot: RAID metadata 1.0 (superblock at the end), so each member also reads as a plain ext4 file
        # system. The stick's GRUB has no RAID support built in and must be able to load the installed
        # system's boot menu and kernel from here (a stick left plugged in, firmware boot entries lost).
        {"type": "raid", "id": "md0", "name": "md0", "raidlevel": "raid1", "devices": ["d0p2", "d1p2"],
         "spare_devices": [], "preserve": False, "metadata": "1.0"},
        {"type": "raid", "id": "md1", "name": "md1", "raidlevel": "raid1", "devices": ["d0p3", "d1p3"],
         "spare_devices": [], "preserve": False},
        {"type": "format", "id": "fs-boot", "volume": "md0", "fstype": "ext4", "label": "offbox-boot",
         "preserve": False},
        {"type": "format", "id": "fs-root", "volume": "md1", "fstype": "ext4", "label": "offbox-root",
         "preserve": False},
        {"type": "mount", "id": "mnt-root", "device": "fs-root", "path": "/"},
        {"type": "mount", "id": "mnt-boot", "device": "fs-boot", "path": "/boot"},
        {"type": "mount", "id": "mnt-esp", "device": "fs-esp0", "path": "/boot/efi"},
    ]
    # grub: ask the installer not to touch the firmware's boot entries. It honours this only in part (it
    # still registers the disks); common.sh pin_stick_next / drop_disk_entries cover the rest.
    return {"swap": {"size": 0}, "grub": {"update_nvram": False, "reorder_uefi": False}, "config": cfg}


def render(plan, src, dst):
    import yaml

    with open(src) as f:
        doc = yaml.safe_load(f)
    ai = doc["autoinstall"] if isinstance(doc, dict) and "autoinstall" in doc else doc
    ai["storage"] = storage_config(plan)
    tmp = dst + ".offbox-tmp"
    with open(tmp, "w") as f:
        yaml.safe_dump(doc, f, default_flow_style=False, sort_keys=False)
    os.replace(tmp, dst)


# --------------------------------------------------------------------------------------------- consume
def consume(plan, esp_dirs):
    """After a successful install: remember the markers on the ESPs, then delete them from the stick."""
    markers = plan.get("markers", [])
    for esp in esp_dirs:
        os.makedirs(os.path.join(esp, "EFI/offbox"), exist_ok=True)
        with open(os.path.join(esp, CONSUMED_LOG), "a") as f:
            for m in markers:
                f.write(m["identity"] + "\n")
            f.flush()
            os.fsync(f.fileno())
    left = []
    for m in markers:
        p = m["path"]
        remount = p.startswith("/cdrom/")
        if remount:
            sh(["mount", "-o", "remount,rw", "/cdrom"])
        try:
            os.remove(p)
        except OSError as e:
            log(f"marker {p}: could not delete ({e})")
        sh(["sync"])
        if remount:
            sh(["mount", "-o", "remount,ro", "/cdrom"])
        if os.path.exists(p):
            left.append(p)
    if left:
        log("markers still on the stick (recorded as consumed, they will be ignored): " + ", ".join(left))
    else:
        log("markers removed: " + (", ".join(m["path"] for m in markers) or "none"))
    return left


def main(argv):
    global LOG
    if len(argv) < 2:
        raise SystemExit(__doc__)
    cmd = argv[1]
    if cmd == "decide":
        LOG = os.path.join(RUN, "early.log") if os.path.isdir(RUN) else None
        if len(argv) > 3 and argv[2] == "--facts":
            facts = json.load(open(argv[3]))
        else:
            facts = gather()
        plan = decide(facts)
        plan["facts"] = facts
        json.dump(plan, sys.stdout, indent=1)
        print()
    elif cmd == "prepare":
        LOG = os.path.join(RUN, "prepare.log")
        prepare(json.load(open(argv[2])))
    elif cmd == "render":
        render(json.load(open(argv[2])), argv[3], argv[4])
    elif cmd == "storage":
        json.dump(storage_config(json.load(open(argv[2]))), sys.stdout, indent=1)
        print()
    elif cmd == "consume":
        LOG = os.path.join(RUN, "late.log")
        left = consume(json.load(open(argv[2])), argv[3:])
        sys.exit(3 if left else 0)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
