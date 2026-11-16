"""Exercise the profile-only installer path without changing a host or running box."""
import json
import copy
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


INSTALLER = Path(__file__).resolve().parents[1] / "server/install-host.sh"
ENTRY = "lxc.mount.entry = tmpfs tmp tmpfs rw,nosuid,nodev,mode=1777,size=8G,create=dir 0 0"


class TmpProfile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / "raw.lxc"
        self.config.write_text("")
        self.log = self.root / "calls.jsonl"
        incus = self.root / "incus"
        incus.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as f:
    f.write(json.dumps(args) + '\\n')
if os.environ.get('FAIL_AT') == args[1]:
    sys.exit(42)
config = Path(os.environ['RAW_CONFIG'])
if args == ['profile', 'get', 'offbox', 'raw.lxc']:
    print(config.read_text(), end='')
elif args[:4] == ['profile', 'set', 'offbox', 'raw.lxc'] and len(args) == 5:
    config.write_text(args[4])
else:
    raise AssertionError(args)
""")
        incus.chmod(0o755)

    def apply(self, fail_at=""):
        return subprocess.run(
            ["bash", str(INSTALLER), "tmp-profile"], capture_output=True, text=True,
            env={**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                 "RAW_CONFIG": str(self.config), "CALLS": str(self.log), "FAIL_AT": fail_at},
        )

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_configures_bounded_executable_sticky_tmp_without_restarting_anything(self):
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), ENTRY)
        self.assertEqual(self.calls(), [
            ["profile", "get", "offbox", "raw.lxc"],
            ["profile", "set", "offbox", "raw.lxc", ENTRY],
        ])
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), ENTRY)
        self.assertEqual(len([c for c in self.calls() if c[1] == "set"]), 1)

    def test_preserves_other_settings_mounts_and_comments(self):
        before = "lxc.log.level = warn\nlxc.mount.entry=/data var/tmp none bind 0 0\n# lxc.mount.entry=x tmp none bind 0 0\n"
        self.config.write_text(before)
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), before + ENTRY)

    def test_refuses_existing_tmp_mounts_without_changing_them(self):
        for target in (
            "tmp", "/tmp", "tmp/", "/tmp/", "//tmp//", "./tmp", "tmp/.", "./tmp/./",
            "/tmp/.", "var/../tmp", "/var/../tmp", "var/tmp/../../tmp", "tmp/../tmp",
            "tmp/sub", "/tmp/sub/child", "tmp/sub/../child", "./tmp/sub",
        ):
            for separator in ("=", " = ", "\t=\t"):
                with self.subTest(target=target, separator=separator):
                    before = f"  lxc.mount.entry{separator}/data\t{target} none bind 0 0"
                    self.config.write_text(before)
                    result = self.apply()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("already mounts /tmp", result.stderr)
                    self.assertEqual(self.config.read_text(), before)
        self.assertTrue(all(c[1] == "get" for c in self.calls()))

    def test_other_normalized_destinations_are_preserved(self):
        for target in ("var/tmp", "var/tmp/sub", "tmp/../var/tmp", "tmpfile", ".tmp", "tmp/.."):
            with self.subTest(target=target):
                before = f"lxc.mount.entry = /data {target} none bind 0 0"
                self.config.write_text(before)
                result = self.apply()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.config.read_text(), before + "\n" + ENTRY)

    def test_own_entry_does_not_hide_a_second_conflicting_mount(self):
        before = ENTRY + "\nlxc.mount.entry = /data /tmp none bind 0 0"
        self.config.write_text(before)
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(), before)
        self.assertTrue(all(c[1] == "get" for c in self.calls()))

    def test_conflict_check_consumes_large_configs_under_pipefail(self):
        for padding in ("", "# existing config\n" * 20000):
            with self.subTest(bytes=len(padding)):
                before = "lxc.mount.entry = /data tmp none bind 0 0\n" + padding
                self.config.write_text(before)
                result = self.apply()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.config.read_text(), before)
        self.assertTrue(all(c[1] == "get" for c in self.calls()))

    def test_read_or_write_errors_are_not_success(self):
        for operation in ("get", "set"):
            with self.subTest(operation=operation):
                result = self.apply(fail_at=operation)
                self.assertEqual(result.returncode, 42, result.stderr)
                self.assertEqual(self.config.read_text(), "")



    def test_disk_undo_only_changes_new_box_default_without_host_mutations(self):
        config = self.root / 'config.json'
        before = {'owners': ['ardud'], 'sample_s': 17, 'scratch_disk': True}
        config.write_text(json.dumps(before))
        for name in ('zfs', 'systemctl'):
            command = self.root / name
            command.write_text('#!/bin/sh\nexit 42\n')
            command.chmod(0o755)
        for _ in range(2):
            result = subprocess.run(['bash', str(INSTALLER), 'scratch-disk-undo'], capture_output=True, text=True,
                                    env={**os.environ, 'BOATD_ETC': str(self.root),
                                         'PATH': str(self.root) + os.pathsep + os.environ['PATH']})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(config.read_text()), {**before, 'scratch_disk': False})
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.log.exists())


spec = importlib.util.spec_from_file_location("scratch_under_test", INSTALLER.with_name("boatd_tmp.py"))
scratch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scratch)


class ScratchDisk(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = patch.object(scratch, 'ROOT', Path(self.temp.name).resolve() / 'scratch')
        root.start()
        self.addCleanup(root.stop)
        self.events, self.datasets, self.snaps = [], {}, set()
        self.instances = {'bx-aaaaaaaa': {'name': 'bx-aaaaaaaa', 'status': 'Stopped', 'config': {}, 'devices': {}}}
        self.cfg = {'zpool': 'offbox', 'scratch_disk': True}
        self.manager = scratch.Scratch(self.cfg, self.incus)
        self.box = 'bx_aaaaaaaa'
        self.ds = 'offbox/scratch/bx-aaaaaaaa'
        self.mount = scratch.ROOT / 'bx-aaaaaaaa'
        self.fail = None
        self.run_patch = patch.object(scratch.subprocess, 'run', side_effect=self.command)
        self.run_patch.start()
        self.addCleanup(self.run_patch.stop)

    def incus(self, *args, **kwargs):
        self.events.append(('incus', *args))
        if args == self.fail:
            raise RuntimeError('injected Incus failure')
        out = b''
        if args[0] == 'query':
            if args[1] == '/1.0/instances?recursion=1':
                result = list(self.instances.values())
            else:
                result = copy.deepcopy(self.instances[args[1].split('/')[-1]])
                result['expanded_config'] = {'raw.lxc': scratch.TMPFS, **result['config']}
                result['expanded_devices'] = result['devices']
            out = json.dumps(result).encode()
        elif args[:2] == ('config', 'set'):
            self.instances[args[2]]['config'].update(x.split('=', 1) for x in args[3:])
        elif args[:2] == ('config', 'unset'):
            self.instances[args[2]]['config'].pop(args[3], None)
        elif args[:3] == ('config', 'device', 'add'):
            self.instances[args[3]]['devices'][args[4]] = {'type': args[5], **dict(x.split('=', 1) for x in args[6:])}
        elif args[:3] == ('config', 'device', 'remove'):
            del self.instances[args[3]]['devices'][args[4]]
        elif args[0] == 'start':
            self.instances[args[1]]['status'] = 'Running'
        elif args[0] == 'exec':
            out = (self.ds + ' zfs rw,nosuid,nodev,relatime,idmapped\n').encode() if 'findmnt' in args else b'1777\n'
        else:
            raise AssertionError(args)
        return subprocess.CompletedProcess(args, 0, out, b'')

    def command(self, args, **kwargs):
        self.events.append(tuple(args))
        if tuple(args) == self.fail:
            return subprocess.CompletedProcess(args, 1, '', 'injected ZFS failure')
        out, rc = '', 0
        if args[0] == 'findmnt':
            out = next(ds for ds, props in self.datasets.items() if props['mountpoint'] == args[3]) + ' zfs\n'
        elif args[1] == 'create':
            props = dict(args[i + 1].split('=', 1) for i, a in enumerate(args) if a == '-o')
            props.update(refquota=str(64 * 1024**3) if props.get('refquota') == '64G' else '0', reservation='0')
            self.datasets[args[-1]] = props
            Path(props['mountpoint']).mkdir(parents=True)
        elif args[1] == 'get':
            out = ''.join(k + '\t' + self.datasets[args[-1]].get(k, '-') + '\n' for k in args[-2].split(','))
        elif args[1] == 'list':
            if 'snapshot' in args:
                out = '\n'.join(s for s in self.snaps if s.startswith(args[-1] + '@'))
            elif '-r' in args:
                out = '\n'.join(self.datasets)
            else:
                rc = 0 if args[-1] in self.datasets else 1
                out = args[-1] if not rc else ''
        elif args[1] == 'snapshot':
            self.snaps.add(args[-1])
        elif args[1] == 'rollback':
            if args[-1] not in self.snaps:
                rc = 1
        elif args[1] == 'destroy':
            if '@' in args[-1]:
                self.snaps.remove(args[-1])
            else:
                del self.datasets[args[-1]]
        elif args[1] == 'set':
            self.datasets[args[-1]].update([args[2].split('=', 1)])
        else:
            raise AssertionError(args)
        return subprocess.CompletedProcess(args, rc, out, 'missing' if rc else '')

    def create(self):
        self.manager.create(self.box, 'ardud')
        self.events.clear()

    def test_create_is_private_bounded_and_snapshots_empty_sticky_root(self):
        self.manager.create(self.box, 'ardud')
        self.assertEqual(self.mount.stat().st_mode & 0o7777, 0o1777)
        props = self.datasets[self.ds]
        self.assertEqual((props['normalization'], props['utf8only'], props['refquota'], props['reservation']),
                         ('none', 'on', str(64 * 1024**3), '0'))
        self.assertEqual(props[scratch.BOX], self.box)
        self.assertIn(self.ds + '@empty', self.snaps)
        self.assertNotIn(scratch.TMPFS, self.instances['bx-aaaaaaaa']['config']['raw.lxc'])
        self.assertEqual(self.instances['bx-aaaaaaaa']['devices'][scratch.DEVICE]['raw.mount.options'], 'nosuid,nodev')
        self.assertFalse(any(e[:2] == ('incus', 'start') for e in self.events))

    def test_stopped_start_rolls_back_exact_dataset_before_start(self):
        self.create()
        self.manager.start(self.box)
        mutations = [e for e in self.events if e[:2] == ('zfs', 'rollback') or e[:2] == ('incus', 'start')]
        self.assertEqual(mutations, [('zfs', 'rollback', self.ds + '@empty'), ('incus', 'start', 'bx-aaaaaaaa')])
        self.manager.verify(self.box)

    def test_running_start_is_noop_and_never_rolls_back(self):
        self.create()
        self.instances['bx-aaaaaaaa']['status'] = 'Running'
        self.manager.start(self.box)
        self.assertEqual(len(self.events), 1)

    def test_unknown_state_or_identity_mismatch_never_starts_or_rolls_back(self):
        self.create()
        for key, value in ((scratch.MANAGED, 'foreign'), (scratch.BOX, 'bx_bbbbbbbb'),
                           (scratch.ZOWNER, 'moni'), ('normalization', 'formD'), ('mountpoint', '/tmp')):
            with self.subTest(key=key):
                old = self.datasets[self.ds][key]
                self.datasets[self.ds][key] = value
                with self.assertRaises(RuntimeError): self.manager.start(self.box)
                self.datasets[self.ds][key] = old
        self.instances['bx-aaaaaaaa']['status'] = 'Frozen'
        with self.assertRaises(RuntimeError): self.manager.start(self.box)
        self.assertFalse(any(e[:2] in (('zfs', 'rollback'), ('incus', 'start')) for e in self.events))

    def test_rollback_failure_blocks_start(self):
        self.create()
        self.fail = ('zfs', 'rollback', self.ds + '@empty')
        with self.assertRaisesRegex(RuntimeError, 'rollback failed'): self.manager.start(self.box)
        self.assertFalse(any(e[:2] == ('incus', 'start') for e in self.events))

    def test_copy_gets_fresh_independent_backing_and_saved_copy_loses_source_reference(self):
        self.create()
        self.instances['bx-bbbbbbbb'] = copy.deepcopy(self.instances['bx-aaaaaaaa'])
        self.instances['bx-bbbbbbbb']['name'] = 'bx-bbbbbbbb'
        self.manager.create('bx_bbbbbbbb', 'ardud')
        self.assertEqual(self.instances['bx-bbbbbbbb']['devices'][scratch.DEVICE]['source'], str(scratch.ROOT / 'bx-bbbbbbbb'))
        self.assertEqual(len(self.datasets), 2)
        self.instances['sv-test'] = copy.deepcopy(self.instances['bx-aaaaaaaa'])
        self.manager.detach_copy('sv-test')
        self.assertNotIn(scratch.LABEL, self.instances['sv-test']['config'])
        self.assertNotIn(scratch.DEVICE, self.instances['sv-test']['devices'])
        self.assertIn(scratch.DEVICE, self.instances['bx-aaaaaaaa']['devices'])

    def test_rollback_flag_only_changes_new_boxes_and_restores_tmpfs_for_clones(self):
        self.create()
        self.cfg['scratch_disk'] = False
        self.instances['bx-bbbbbbbb'] = copy.deepcopy(self.instances['bx-aaaaaaaa'])
        self.manager.create('bx_bbbbbbbb', 'ardud')
        self.assertNotIn('offbox/scratch/bx-bbbbbbbb', self.datasets)
        self.assertNotIn(scratch.DEVICE, self.instances['bx-bbbbbbbb']['devices'])
        self.assertIn(scratch.TMPFS, self.instances['bx-bbbbbbbb']['config']['raw.lxc'])
        self.manager.start(self.box)
        self.assertIn(('zfs', 'rollback', self.ds + '@empty'), self.events)

    def test_delete_rejects_live_reference_then_removes_only_owned_dataset(self):
        self.create()
        with self.assertRaisesRegex(RuntimeError, 'still exists'): self.manager.delete(self.box, 'ardud')
        del self.instances['bx-aaaaaaaa']
        self.instances['sv-test'] = {'devices': {'borrowed': {'source': str(self.mount)}}}
        with self.assertRaisesRegex(RuntimeError, 'still referenced'): self.manager.delete(self.box, 'ardud')
        del self.instances['sv-test']
        self.manager.delete(self.box, 'ardud')
        self.assertNotIn(self.ds, self.datasets)
        self.assertNotIn(self.ds + '@empty', self.snaps)
        self.assertEqual([e for e in self.events if e[:2] == ('zfs', 'destroy')],
                         [('zfs', 'destroy', self.ds + '@empty'), ('zfs', 'destroy', self.ds)])
        self.manager.delete(self.box, 'ardud')

    def test_delete_handles_partial_creation_but_refuses_unexpected_snapshots(self):
        self.create()
        del self.instances['bx-aaaaaaaa']
        self.snaps.add(self.ds + '@foreign')
        with self.assertRaisesRegex(RuntimeError, 'unexpected'): self.manager.delete(self.box, 'ardud')
        self.snaps.clear()
        self.manager.delete(self.box, 'ardud')

    def test_chown_keeps_owner_markers_consistent(self):
        self.create()
        self.manager.chown(self.box, 'ardud', 'moni')
        self.assertEqual(self.datasets[self.ds][scratch.ZOWNER], 'moni')
        self.assertEqual(self.instances['bx-aaaaaaaa']['config'][scratch.OWNER], 'moni')
        self.assertNotIn(('zfs', 'rollback', self.ds + '@empty'), self.events)

    def test_foreign_mount_inputs_are_rejected_without_creating_a_dataset(self):
        for target in ('tmp', '/tmp', '//tmp//', './tmp', '/var/../tmp', 'tmp/sub', 'tmp/sub/../child'):
            for separator in ('=', ' = ', '\t=\t'):
                with self.subTest(target=target, separator=separator):
                    raw = f'lxc.mount.entry{separator}/data {target} none bind 0 0'
                    self.instances['bx-aaaaaaaa']['config']['raw.lxc'] = scratch.TMPFS + '\n' + raw
                    with self.assertRaisesRegex(RuntimeError, 'foreign'): self.manager.create(self.box, 'ardud')
        self.assertFalse(self.datasets)

    def test_unmounted_or_symlinked_backing_is_not_rolled_back(self):
        self.create()
        self.fail = ('findmnt', '-rn', '-M', str(self.mount), '-o', 'SOURCE,FSTYPE')
        with self.assertRaisesRegex(RuntimeError, 'not mounted'): self.manager.start(self.box)
        self.fail = None
        self.mount.rmdir()
        self.mount.symlink_to(Path(self.temp.name))
        with self.assertRaisesRegex(RuntimeError, 'noncanonical'): self.manager.start(self.box)
        self.assertFalse(any(e[:2] == ('zfs', 'rollback') for e in self.events))


if __name__ == "__main__":
    unittest.main()
