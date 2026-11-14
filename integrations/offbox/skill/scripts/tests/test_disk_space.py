import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import offbox_disk_space as disk


class DiskSpaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / 'run.log'

    def space(self, free):
        return dict(tmp=dict(path='/tmp', free_bytes=free, size_bytes=8*disk.GIB, fstype='tmpfs'),
                    workspace=dict(path='/home/user', free_bytes=90*disk.GIB, size_bytes=100*disk.GIB, fstype='zfs'))

    def test_warning_boundary(self):
        for free in [disk.WARN_BYTES-1, disk.WARN_BYTES, disk.WARN_BYTES+1]:
            with self.subTest(free=free):
                self.assertEqual(bool(disk.warning(self.space(free), 'bx_test')), free < disk.WARN_BYTES)

    def preflight(self, before, after, live):
        lines, calls = [], []
        samples = iter([self.space(before), self.space(after)])
        code = disk.preflight(dict(box_id='bx_test', run_id='run_new', uid=os.getuid(), live=live),
            measure=lambda: next(samples), reaper=lambda *a, **kw: calls.append(a) or 12, emit=lines.append)
        return code, calls, '\n'.join(lines)

    def test_idle_critical_box_reclaims_then_runs_or_refuses(self):
        for after, expected in [(disk.GATE_BYTES, 0), (disk.GATE_BYTES-1, 90)]:
            with self.subTest(after=after):
                code, calls, output = self.preflight(0, after, [])
                self.assertEqual(code, expected)
                self.assertEqual(calls[0][0], '/tmp')
                self.assertIn('reclaimed total 12 bytes', output)
                self.assertEqual('"phase": "gate"' in output, expected == 90)

    def test_critical_busy_box_refuses_without_reclaim(self):
        code, calls, output = self.preflight(disk.GATE_BYTES-1, 0, [dict(run_id='live', started_at=1)])
        self.assertEqual(code, 90)
        self.assertEqual(calls, [])
        self.assertIn('command not started', output)

    def test_healthy_box_keeps_warm_caches(self):
        code, calls, _ = self.preflight(4*disk.GIB, 4*disk.GIB, [])
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])

    def test_failure_patterns_and_record_fields(self):
        for text in ['No space left on device', 'ENOSPC: write', 'os error 28', 'OSError: [Errno 28]']:
            for code in [0, 1, 2, 90, None]:
                with self.subTest(text=text, code=code):
                    self.log.write_text(disk.MARKER+json.dumps(dict(phase='start', space=self.space(disk.GIB)))+'\n'+text+'\n')
                    record = disk.result(self.log, code)
                    self.assertEqual(record['infra_failure'], 'enospc' if code not in (0, None) else None)
                    self.assertEqual(record['command_exit_code'], code)
                    self.assertEqual(record['tmp_free_bytes'], disk.GIB)
                    self.assertEqual(record['tmp_size_bytes'], 8*disk.GIB)
                    self.assertEqual(record['tmp_fstype'], 'tmpfs')
                    self.assertEqual(record['workspace_fstype'], 'zfs')

    def test_low_end_space_boundary_and_successful_run(self):
        for free in [disk.FAIL_BYTES-1, disk.FAIL_BYTES]:
            for code in [0, 7]:
                with self.subTest(free=free, code=code):
                    self.log.write_text(disk.MARKER+json.dumps(dict(phase='end', space=self.space(free)))+'\n')
                    self.assertEqual(bool(disk.result(self.log, code)['infra_failure']), code == 7 and free < disk.FAIL_BYTES)

    def test_warning_does_not_contaminate_ordinary_failure(self):
        self.log.write_text(disk.warning(self.space(disk.GIB-1), 'bx_test')+'\nassertion failed\n')
        self.assertIsNone(disk.result(self.log, 1)['infra_failure'])

    def test_final_attempt_replaces_earlier_enospc(self):
        for phase in ['server_start', 'start']:
            self.log.write_text('ENOSPC\n'+disk.MARKER+json.dumps(dict(phase=phase, space=self.space(disk.GIB)))+'\nassertion failed\n')
            self.assertIsNone(disk.result(self.log, 1)['infra_failure'])

    def test_precommand_gate_is_infra(self):
        self.log.write_text(disk.MARKER+json.dumps(dict(phase='gate', space=self.space(0)))+'\n')
        self.assertEqual(disk.result(self.log, 90)['infra_reason'], 'low_space_gate')
        self.assertIsNone(disk.result(self.log, 90)['command_exit_code'])

    def test_malformed_metadata_does_not_replace_real_space_or_crash(self):
        for space in [[], {'tmp': []}, {'tmp': {'free_bytes': 'oops'}}, {'tmp': {'size_bytes': -1}}]:
            with self.subTest(space=space):
                self.log.write_text(disk.MARKER+json.dumps(dict(phase='end', space=space))+'\n')
                self.assertIsNone(disk.result(self.log, 1)['infra_failure'])


class ReaperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'tmp'
        self.root.mkdir()
        self.proc = self.base / 'proc'
        self.proc.mkdir()
        self.messages = []
        self.clock = time.time()+10000
        self.mountinfo = self.base / 'mountinfo'
        self.mountinfo.write_text('')

    def entry(self, name):
        path = self.root / name
        path.mkdir()
        (path / 'proof').write_text('keep me')
        return path

    def reap(self, live=None, uid=None):
        return disk.reap(self.root, os.getuid() if uid is None else uid, live or [], clock=lambda: self.clock,
                         proc=self.proc, emit=self.messages.append, mountinfo=self.mountinfo)

    def process(self, kind, target):
        p = self.proc / '123456789'
        p.mkdir(exist_ok=True)
        (p / 'fd').mkdir(exist_ok=True)
        if not (p / 'cwd').exists():
            (p / 'cwd').symlink_to(self.base)
        if not (p / 'root').exists():
            (p / 'root').symlink_to(self.base)
        if not (p / 'maps').exists():
            (p / 'maps').write_text('')
        if kind == 'cwd':
            (p / 'cwd').unlink()
            (p / 'cwd').symlink_to(target)
        if kind == 'fd':
            (p / 'fd' / '5').symlink_to(target)
        if kind == 'mmap':
            (p / 'maps').write_text('0-1 r--p 0 00:01 1 '+str(target)+'\n')

    def test_removes_old_user_tree_and_logs_size_and_mtime(self):
        path = self.entry('stale')
        size = self.reap()
        self.assertFalse(path.exists())
        self.assertGreater(size, 0)
        self.assertEqual(self.messages[0]['path'], str(path))
        self.assertGreater(self.messages[0]['mtime'], 0)

    def test_cwd_fd_mmap_protect_entries_while_other_stale_tree_is_reclaimed(self):
        for kind in ['cwd', 'fd', 'mmap']:
            with self.subTest(kind=kind):
                path = self.entry(kind)
                self.process(kind, path if kind == 'cwd' else path / 'proof')
                stale = self.entry('stale-'+kind)
                self.reap([dict(run_id='live', started_at=self.clock-1000)])
                self.assertEqual((path / 'proof').read_text(), 'keep me')
                self.assertFalse(stale.exists())

    def test_foreign_owner_socket_and_private_run_parent(self):
        path = self.entry('foreign')
        self.reap(uid=os.getuid()+1)
        self.assertTrue(path.exists())
        sock = socket.socket(socket.AF_UNIX)
        sock.bind(str(self.root / 'sock'))
        self.addCleanup(sock.close)
        private = self.entry('offbox-run')
        (private / 'live').mkdir()
        for name in ['.X11-unix', 'systemd-private-test', 'snap-private-tmp']:
            self.entry(name)
        self.reap()
        self.assertTrue((self.root / 'sock').exists())
        self.assertTrue((private / 'live').exists())
        for name in ['.X11-unix', 'systemd-private-test', 'snap-private-tmp']:
            self.assertTrue((self.root / name).exists())

    def test_recent_descendant_and_oldest_live_run_protect_tree(self):
        path = self.entry('recent-child')
        old, new = self.clock-4000, self.clock-800
        os.utime(path / 'proof', (new, new))
        os.utime(path, (old, old))
        self.reap([dict(run_id='older', started_at=self.clock-1000)])
        self.assertTrue((path / 'proof').exists())

    def test_no_live_run_requires_ten_minutes(self):
        path = self.entry('fresh')
        self.clock = time.time()
        self.reap()
        self.assertTrue(path.exists())

    def test_symlink_never_traverses_external_target(self):
        target = self.base / 'outside'
        target.mkdir()
        (target / 'file').write_text('outside')
        (self.root / 'link').symlink_to(target)
        self.reap()
        self.assertEqual((target / 'file').read_text(), 'outside')
        self.assertFalse((self.root / 'link').is_symlink())

    def test_proc_permission_failure_preserves_files(self):
        path = self.entry('uncertain')
        with patch.object(disk, 'held_paths', side_effect=PermissionError('no proc access')):
            self.reap()
        self.assertTrue(path.exists())
        self.assertIn('skipped', self.messages[0])

    def test_mmap_path_with_spaces_is_preserved(self):
        path = self.entry('has spaces')
        self.process('mmap', path / 'proof')
        maps = self.proc / '123456789' / 'maps'
        maps.write_text(maps.read_text().replace('has spaces', r'has\040spaces'))
        self.reap()
        self.assertTrue((path / 'proof').exists())

    def test_foreign_owned_descendant_preserves_whole_tree(self):
        path = self.entry('foreign-child')
        original = Path.lstat
        def foreign(p):
            info = original(p)
            if p == path / 'proof':
                fields = list(info)
                fields[4] = 0 if os.getuid() != 0 else 1
                return os.stat_result(fields)
            return info
        with patch.object(Path, 'lstat', foreign):
            self.reap()
        self.assertTrue((path / 'proof').exists())

    def test_same_filesystem_bind_mount_protects_whole_tree(self):
        path = self.entry('mounted-child')
        self.mountinfo.write_text(f'1 0 0:1 / {path}/sub rw - tmpfs tmpfs rw\n')
        self.reap()
        self.assertTrue((path / 'proof').exists())

    def test_replaced_top_level_tree_is_not_deleted(self):
        path = self.entry('raced')
        remove = disk.remove_checked
        def replace(parent, name, *args, **kw):
            path.rename(self.root / 'moved')
            self.entry('raced')
            return remove(parent, name, *args, **kw)
        with patch.object(disk, 'remove_checked', replace):
            self.reap()
        self.assertEqual((path / 'proof').read_text(), 'keep me')


if __name__ == '__main__':
    unittest.main()
