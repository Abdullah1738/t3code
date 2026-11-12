#!/usr/bin/env python3
"""test_plan.py: unit tests of the installer's disk decision (stick/offbox/installer/plan.py).

No disks, no root: decide() works on plain data, and the commands prepare() would run are captured.
    python3 test_plan.py
"""
import copy
import importlib.util
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True  # plan.py lives in the stick tree: never leave a __pycache__ next to it
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("plan", os.path.join(HERE, "..", "stick", "offbox", "installer", "plan.py"))
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)
plan.log = lambda msg: None

GIB = 1024**3
MIB = 1024**2
DISK = 2000398934016


def our_parts(path, esp=None, zfs=True):
    """The four partitions a finished offbox install leaves on one disk."""
    sizes = [1 * GIB, 2 * GIB, 150 * GIB, DISK - 153 * GIB - 2 * MIB]
    fstypes = ["vfat", "linux_raid_member", "linux_raid_member", "zfs_member" if zfs else ""]
    out, start = [], MIB
    for n in (1, 2, 3, 4):
        p = {"node": f"{path}p{n}", "number": n, "start": start, "size": sizes[n - 1], "type": "x",
             "name": plan.NAMES[n], "uuid": f"u{n}", "fstype": fstypes[n - 1], "label": ""}
        if n == 1:
            p["esp"] = esp if esp is not None else {"installed": "20261111T000000Z mode=full", "consumed": []}
        out.append(p)
        start += sizes[n - 1]
    return out


def disk(name, size=DISK, parts=None, ptable=None, whole=""):
    return {"name": name, "path": f"/dev/{name}", "size": size, "model": "KINGSTON", "serial": "S" + name,
            "partitions": parts or [], "ptable": ptable or ("gpt" if parts else None), "whole_fstype": whole,
            "whole_label": ""}


def facts(nvme, markers=()):
    return {"errors": [], "stick": {"partition": "/dev/sda1", "disk": "sda"}, "all_disks": [], "nvme": list(nvme),
            "markers": [{"kind": k, "path": f"/run/offbox/logvol/{k}", "identity": f"{k}:0:1:abc"} for k in markers]}


def blank():
    return [disk("nvme0n1"), disk("nvme1n1")]


def installed(**kw):
    return [disk("nvme0n1", parts=our_parts("/dev/nvme0n1", **kw)), disk("nvme1n1", parts=our_parts("/dev/nvme1n1", **kw))]


class Decide(unittest.TestCase):
    def d(self, f):
        return plan.decide(f)

    def test_blank_disks_full_install(self):
        p = self.d(facts(blank()))
        self.assertEqual((p["action"], p["mode"], p["reason"]), ("install", "full", "blank disks"))
        self.assertEqual([d["path"] for d in p["disks"]], ["/dev/nvme0n1", "/dev/nvme1n1"])

    def test_not_exactly_two_disks_abort(self):
        for n in (0, 1, 3):
            p = self.d(facts([disk(f"nvme{i}n1") for i in range(n)]))
            self.assertEqual(p["action"], "abort", n)
            self.assertIn("need exactly two NVMe disks", p["reason"])
            self.assertEqual(p["disks"], [])

    def test_one_disk_of_a_finished_install_missing_abort(self):
        p = self.d(facts(installed()[:1]))
        self.assertEqual(p["action"], "abort")

    def test_unequal_sizes_abort(self):
        p = self.d(facts([disk("nvme0n1"), disk("nvme1n1", size=DISK // 2)]))
        self.assertEqual(p["action"], "abort")
        self.assertIn("not the same size", p["reason"])

    def test_small_disks_abort(self):
        p = self.d(facts([disk("nvme0n1", size=100 * GIB), disk("nvme1n1", size=100 * GIB)]))
        self.assertEqual(p["action"], "abort")

    def test_unreadable_disks_abort(self):
        f = facts(blank())
        f["errors"] = ["lsblk failed"]
        self.assertEqual(self.d(f)["action"], "abort")

    def test_finished_install_without_marker_refuses(self):
        p = self.d(facts(installed()))
        self.assertEqual(p["action"], "refuse")
        self.assertEqual(p["boot_disk_hint"], "/dev/nvme0n1p1")
        self.assertIsNone(p["mode"])

    def test_finished_mark_on_one_esp_only_still_refuses(self):
        nv = installed()
        nv[0]["partitions"][0]["esp"] = {"installed": None, "consumed": []}
        p = self.d(facts(nv))
        self.assertEqual((p["action"], p["boot_disk_hint"]), ("refuse", "/dev/nvme1n1p1"))

    def test_pool_data_without_finished_mark_refuses(self):
        p = self.d(facts(installed(esp={"installed": None, "consumed": []})))
        self.assertEqual(p["action"], "refuse")
        self.assertIn("ZFS pool data", p["reason"])

    def test_whole_disk_pool_refuses(self):
        p = self.d(facts([disk("nvme0n1", whole="zfs_member"), disk("nvme1n1", whole="zfs_member")]))
        self.assertEqual(p["action"], "refuse")

    def test_interrupted_install_is_redone(self):
        # partitions and md superblocks exist, but no finished mark and no pool: nothing worth keeping
        p = self.d(facts(installed(esp={"installed": None, "consumed": []}, zfs=False)))
        self.assertEqual((p["action"], p["mode"]), ("install", "full"))
        self.assertIn("interrupted install", p["reason"])

    def test_wipe_marker_full_install_even_with_pool(self):
        p = self.d(facts(installed(), ["wipe"]))
        self.assertEqual((p["action"], p["mode"]), ("install", "full"))

    def test_reinstall_marker_preserves(self):
        p = self.d(facts(installed(), ["reinstall"]))
        self.assertEqual((p["action"], p["mode"]), ("install", "preserve"))
        self.assertEqual([g["number"] for g in p["geometry"]], [1, 2, 3, 4])
        self.assertEqual(p["geometry"][3]["start"], MIB + 153 * GIB)

    def test_reinstall_marker_needs_our_layout(self):
        for nv in (blank(), [disk("nvme0n1", parts=our_parts("/dev/nvme0n1")[:3]), disk("nvme1n1", parts=our_parts("/dev/nvme1n1")[:3])]):
            p = self.d(facts(nv, ["reinstall"]))
            self.assertEqual(p["action"], "abort")
            self.assertIn("Nothing was changed", p["reason"])
        nv = installed()
        nv[1]["partitions"][3]["name"] = "something-else"
        self.assertEqual(self.d(facts(nv, ["reinstall"]))["action"], "abort")
        nv = installed()
        nv[1]["partitions"][3]["start"] += MIB
        self.assertEqual(self.d(facts(nv, ["reinstall"]))["action"], "abort")

    def test_both_markers_abort(self):
        p = self.d(facts(installed(), ["wipe", "reinstall"]))
        self.assertEqual(p["action"], "abort")

    def test_marker_already_acted_on_is_ignored(self):
        # the stick went read-only: the marker could not be deleted, but the ESPs remember it
        nv = installed(esp={"installed": "x", "consumed": ["wipe:0:1:abc"]})
        p = self.d(facts(nv, ["wipe"]))
        self.assertEqual(p["action"], "refuse")
        self.assertEqual(len(p["consumed_markers"]), 1)

    def test_decide_changes_nothing(self):
        f = facts(installed(), ["reinstall"])
        before = copy.deepcopy(f)
        self.d(f)
        self.assertEqual(f, before)


class Gather(unittest.TestCase):
    """The stick and anything that is not an internal NVMe disk never become install targets."""

    def test_targets(self):
        devs = [
            {"name": "sda", "path": "/dev/sda", "type": "disk", "tran": "usb", "size": 123009761280, "rm": True},
            {"name": "sdb", "path": "/dev/sdb", "type": "disk", "tran": "sata", "size": DISK, "rm": False},
            {"name": "nvme0n1", "path": "/dev/nvme0n1", "type": "disk", "tran": "nvme", "size": DISK, "rm": False},
            {"name": "nvme1n1", "path": "/dev/nvme1n1", "type": "disk", "tran": "nvme", "size": DISK, "rm": False},
            {"name": "nvme2n1", "path": "/dev/nvme2n1", "type": "disk", "tran": "nvme", "size": DISK, "rm": True},
            {"name": "loop0", "path": "/dev/loop0", "type": "loop", "tran": None, "size": 1000, "rm": False},
        ]

        def fake_sh(cmd, check=False, quiet=False):
            if cmd[:2] == ["findmnt", "-n"]:
                return 0, "/dev/sda1\n"
            if cmd[:2] == ["lsblk", "-no"]:
                return 0, "sda\n"
            if cmd[:2] == ["lsblk", "-J"]:
                return 0, json.dumps({"blockdevices": devs})
            if cmd[0] == "sfdisk":
                return 1, ""
            return 0, ""

        old = plan.sh, plan.find_markers
        plan.sh, plan.find_markers = fake_sh, lambda roots: []
        try:
            f = plan.gather()
        finally:
            plan.sh, plan.find_markers = old
        self.assertEqual([d["name"] for d in f["nvme"]], ["nvme0n1", "nvme1n1"])
        self.assertEqual(f["stick"]["disk"], "sda")

    def test_stick_on_nvme_enclosure_is_not_a_target(self):
        devs = [{"name": f"nvme{i}n1", "path": f"/dev/nvme{i}n1", "type": "disk", "tran": "nvme", "size": DISK, "rm": False}
                for i in range(3)]

        def fake_sh(cmd, check=False, quiet=False):
            if cmd[:2] == ["findmnt", "-n"]:
                return 0, "/dev/nvme2n1p1\n"
            if cmd[:2] == ["lsblk", "-no"]:
                return 0, "nvme2n1\n"
            if cmd[:2] == ["lsblk", "-J"]:
                return 0, json.dumps({"blockdevices": devs})
            return 1, ""

        old = plan.sh, plan.find_markers
        plan.sh, plan.find_markers = fake_sh, lambda roots: []
        try:
            f = plan.gather()
        finally:
            plan.sh, plan.find_markers = old
        self.assertEqual([d["name"] for d in f["nvme"]], ["nvme0n1", "nvme1n1"])


class Prepare(unittest.TestCase):
    def run_prepare(self, p):
        cmds = []
        old = plan.sh, plan.part_nodes, plan.carry_over, os.listdir
        plan.sh = lambda cmd, check=False, quiet=False: (cmds.append(cmd), (0, ""))[1]
        plan.part_nodes = lambda d: [(f"{d}p{n}", GIB) for n in (1, 2, 3, 4)]
        plan.carry_over = lambda pl: None
        os.listdir = lambda path: []
        try:
            plan.prepare(p)
        finally:
            plan.sh, plan.part_nodes, plan.carry_over, os.listdir = old
        return cmds

    def test_preserve_never_writes_the_pool_partitions_or_the_partition_table(self):
        p = plan.decide(facts(installed(), ["reinstall"]))
        cmds = self.run_prepare(p)
        writers = [c for c in cmds if c[0] in ("wipefs", "dd", "sgdisk", "blkdiscard", "mkfs.ext4", "mkfs.vfat", "sfdisk")]
        self.assertTrue(writers)
        for c in writers:
            line = " ".join(c)
            self.assertNotIn("p4", line)
            self.assertNotIn(c[0], ("sgdisk", "blkdiscard", "sfdisk"), line)
            for tok in c:
                self.assertNotIn(tok.replace("of=", ""), ("/dev/nvme0n1", "/dev/nvme1n1"), line)
        wiped = sorted(c[-1] for c in cmds if c[0] == "wipefs")
        self.assertEqual(wiped, sorted(f"/dev/nvme{i}n1p{n}" for i in (0, 1) for n in (1, 2, 3)))

    def test_full_clears_both_disks_and_nothing_else(self):
        p = plan.decide(facts(installed(), ["wipe"]))
        cmds = self.run_prepare(p)
        touched = {tok.replace("of=", "") for c in cmds for tok in c if tok.replace("of=", "").startswith("/dev/")}
        self.assertTrue(all(t.startswith(("/dev/nvme0n1", "/dev/nvme1n1", "/dev/zero")) for t in touched), touched)
        self.assertEqual(sorted(c[-1] for c in cmds if c[0] == "sgdisk"), ["/dev/nvme0n1", "/dev/nvme1n1"])

    def test_refuse_and_abort_plans_cannot_be_prepared(self):
        for f in (facts(installed()), facts(blank()[:1])):
            with self.assertRaises(SystemExit):
                self.run_prepare(plan.decide(f))


class Storage(unittest.TestCase):
    def test_full_layout(self):
        cfg = plan.storage_config(plan.decide(facts(blank())))
        self.assertEqual(cfg["swap"], {"size": 0})
        self.assertEqual(cfg["grub"], {"update_nvram": False, "reorder_uefi": False})
        parts = [c for c in cfg["config"] if c["type"] == "partition"]
        self.assertEqual([p["size"] for p in parts], [1 * GIB, 2 * GIB, 150 * GIB, -1] * 2)
        self.assertEqual([p["partition_name"] for p in parts], ["offbox-esp", "offbox-boot", "offbox-root", "offbox-zfs"] * 2)
        self.assertTrue(all(not p["preserve"] for p in parts))
        raids = {c["id"]: c for c in cfg["config"] if c["type"] == "raid"}
        self.assertEqual(raids["md0"]["devices"], ["d0p2", "d1p2"])
        self.assertEqual(raids["md1"]["devices"], ["d0p3", "d1p3"])
        self.assertEqual({c["raidlevel"] for c in raids.values()}, {"raid1"})
        self.assertEqual((raids["md0"].get("metadata"), raids["md1"].get("metadata")), ("1.0", None))
        mounts = {c["path"]: c["device"] for c in cfg["config"] if c["type"] == "mount"}
        self.assertEqual(mounts, {"/": "fs-root", "/boot": "fs-boot", "/boot/efi": "fs-esp0"})
        self.assertEqual([p["grub_device"] for p in parts], [True, False, False, False] * 2)

    def test_nothing_is_formatted_on_or_built_from_the_pool_partition(self):
        for f in (facts(blank()), facts(installed(), ["reinstall"])):
            cfg = plan.storage_config(plan.decide(f))["config"]
            users = [c for c in cfg if c.get("volume") in ("d0p4", "d1p4") or "d0p4" in c.get("devices", []) or "d1p4" in c.get("devices", [])]
            self.assertEqual(users, [])

    def test_preserve_layout_keeps_table_and_pool_partition(self):
        p = plan.decide(facts(installed(), ["reinstall"]))
        cfg = plan.storage_config(p)["config"]
        disks = [c for c in cfg if c["type"] == "disk"]
        parts = [c for c in cfg if c["type"] == "partition"]
        self.assertTrue(all(d["preserve"] and "wipe" not in d for d in disks))
        self.assertTrue(all(q["preserve"] for q in parts))
        for q in parts:
            self.assertEqual("wipe" in q, q["number"] != 4, q)
        self.assertEqual([q["offset"] for q in parts[:4]], [g["start"] for g in p["geometry"]])
        self.assertEqual([q["size"] for q in parts[:4]], [g["size"] for g in p["geometry"]])

    def test_ids_resolve(self):
        for f in (facts(blank()), facts(installed(), ["reinstall"])):
            cfg = plan.storage_config(plan.decide(f))["config"]
            ids = [c["id"] for c in cfg]
            self.assertEqual(len(ids), len(set(ids)))
            for c in cfg:
                for ref in [c.get("device"), c.get("volume")] + c.get("devices", []):
                    if ref is not None:
                        self.assertIn(ref, ids, c)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--dump-storage":
        # for the curtin schema check in static-check.sh: the two storage configs the installer can produce
        out = {"full": plan.storage_config(plan.decide(facts(blank()))),
               "preserve": plan.storage_config(plan.decide(facts(installed(), ["reinstall"])))}
        json.dump(out, sys.stdout, indent=1)
        sys.exit(0)
    unittest.main(verbosity=1)
