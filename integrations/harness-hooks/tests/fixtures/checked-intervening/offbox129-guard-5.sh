cat > integrations/offbox/skill/scripts/tests/test_disk_space.py <<'PY'
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
        self.log = self.root/'run.log'

    def space(self, free, size=8*disk.GIB):
        return dict(tmp=dict(path='/tmp', free_bytes=free, size_bytes=size, fstype='tmpfs'),
                    workspace=dict(path='/home/user', free_bytes=90*disk.GIB, size_bytes=100*disk.GIB, fstype='zfs'))

    def test_warning_boundary_is_absolute_even_on_large_filesystems(self):
        for free, expected in [(disk.WARN_BYTES-1, True), (disk.WARN_BYTES, False), (disk.WARN_BYTES+1, False)]:
            with self.subTest(free=free):
                self.assertEqual(bool(disk.warning(self.space(free), 'bx_test')), expected)

    def preflight(self, before, after, live):
        lines, calls = [], []
        samples = iter([self.space(before), self.space(after)])
        code = disk.preflight(dict(box_id='bx_test', run_id='run_new', uid=os.getuid(), live=live),
            measure=lambda: next(samples), reaper=lambda *a, **kw: calls.append(a) or 12, emit=lines.append)
        return code, calls, '\n'.join(lines)

    def test_idle_critical_box_reclaims_then_runs_or_refuses(self):
        for after, expected in [(disk.GATE_BYTES, 0), (disk.GATE_BYTES-1, 90)]:
            with self.subTest(after=after):
                code, calls, log = self.preflight(0, after, [])
                self.assertEqual(code, expected)
                self.assertEqual(calls[0][0], '/tmp')
                self.assertIn('reclaimed total 12 bytes', log)
                self.assertEqual('phase": "gate"' in log, expected == 90)

    def test_critical_busy_box_is_refused_without_any_reclaim(self):
        code, calls, log = self.preflight(disk.GATE_BYTES-1, 0, [dict(run_id='live', started_at=1)])
        self.assertEqual(code, 90)
        self.assertEqual(calls, [])
        self.assertIn('command not started', log)

    def test_healthy_box_keeps_warm_caches(self):
        code, calls, _ = self.preflight(4*disk.GIB, 4*disk.GIB, [])
        self.assertEqual(code, 0)
        self.assertEqual(calls, [])

    def test_failed_command_classification_and_record_fields(self):
        patterns=['No space left on device', 'ENOSPC: write', 'os error 28', 'OSError: [Errno 28]']
        for text in patterns:
            for code in [0, 1, 2, 90, None]:
                with self.subTest(text=text, code=code):
                    self.log.write_text(disk.MARKER+json.dumps(dict(phase='start',space=self.space(disk.GIB)))+'\n'+text+'\n')
                    record=disk.result(self.log,code)
                    self.assertEqual(record['infra_failure'], 'enospc' if code not in (0,None) else None)
                    self.assertEqual(record['command_exit_code'],code)
                    self.assertEqual(record['tmp_free_bytes'],disk.GIB)
                    self.assertEqual(record['tmp_size_bytes'],8*disk.GIB)
                    self.assertEqual(record['tmp_fstype'],'tmpfs')
                    self.assertEqual(record['workspace_fstype'],'zfs')

    def test_low_end_space_boundary_and_successful_run(self):
        for free in [disk.FAIL_BYTES-1,disk.FAIL_BYTES]:
            for code in [0,7]:
                with self.subTest(free=free,code=code):
                    self.log.write_text(disk.MARKER+json.dumps(dict(phase='end',space=self.space(free)))+'\n')
                    self.assertEqual(bool(disk.result(self.log,code)['infra_failure']),code==7 and free<disk.FAIL_BYTES)

    def test_warning_does_not_contaminate_an_ordinary_test_failure(self):
        self.log.write_text(disk.warning(self.space(disk.GIB-1),'bx_test')+'\nassertion failed\n')
        self.assertIsNone(disk.result(self.log,1)['infra_failure'])

    def test_final_attempt_replaces_earlier_enospc_evidence(self):
        self.log.write_text('ENOSPC\n'+disk.MARKER+json.dumps(dict(phase='server_start',space=self.space(disk.GIB)))+'\nassertion failed\n')
        self.assertIsNone(disk.result(self.log,1)['infra_failure'])

    def test_precommand_gate_is_infra_without_planned_steps(self):
        self.log.write_text(disk.MARKER+json.dumps(dict(phase='gate',space=self.space(0)))+'\n')
        self.assertEqual(disk.result(self.log,90)['infra_reason'],'low_space_gate')


class ReaperTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.root=self.base/'tmp';self.root.mkdir()
        self.proc=self.base/'proc';self.proc.mkdir();self.messages=[]
        self.clock=time.time()+10000

    def entry(self,name):
        path=self.root/name;path.mkdir();(path/'proof').write_text('keep me');return path

    def reap(self,live=None,uid=None):
        return disk.reap(self.root,os.getuid() if uid is None else uid,live or [],clock=lambda:self.clock,
                         proc=self.proc,emit=self.messages.append)

    def process(self,kind,target):
        p=self.proc/'123456789';p.mkdir(exist_ok=True)
        (p/'fd').mkdir(exist_ok=True)
        if not (p/'cwd').exists():(p/'cwd').symlink_to(self.base)
        if not (p/'maps').exists():(p/'maps').write_text('')
        if kind=='cwd':(p/'cwd').unlink();(p/'cwd').symlink_to(target)
        if kind=='fd':(p/'fd'/'5').symlink_to(target)
        if kind=='mmap':(p/'maps').write_text('0-1 r--p 0 00:01 1 '+str(target)+'\n')

    def test_removes_old_user_tree_and_logs_size_and_newest_mtime(self):
        path=self.entry('stale');size=self.reap()
        self.assertFalse(path.exists());self.assertGreater(size,0)
        self.assertEqual(self.messages[0]['path'],str(path))
        self.assertGreater(self.messages[0]['mtime'],0)

    def test_holders_protect_cwd_fd_and_mmap_even_with_live_run(self):
        for kind in ['cwd','fd','mmap']:
            with self.subTest(kind=kind):
                path=self.entry(kind);self.process(kind,path if kind=='cwd' else path/'proof')
                self.reap([dict(run_id='live',started_at=self.clock-1000)])
                self.assertEqual((path/'proof').read_text(),'keep me')

    def test_foreign_owner_socket_and_run_parent_are_preserved(self):
        path=self.entry('foreign');self.reap(uid=os.getuid()+1);self.assertTrue(path.exists())
        (self.root/'sock').unlink(missing_ok=True)
        sock=socket.socket(socket.AF_UNIX);sock.bind(str(self.root/'sock'));self.addCleanup(sock.close)
        private=self.entry('offbox-run');(private/'live').mkdir()
        for name in ['.X11-unix','systemd-private-test','snap-private-tmp']:
            self.entry(name)
        self.reap();self.assertTrue((self.root/'sock').exists());self.assertTrue((private/'live').exists())
        for name in ['.X11-unix','systemd-private-test','snap-private-tmp']:self.assertTrue((self.root/name).exists())

    def test_recent_descendant_and_oldest_live_run_protect_whole_tree(self):
        path=self.entry('recent-child');old=self.clock-4000;new=self.clock-500
        os.utime(path/'proof',(new,new));os.utime(path,(old,old))
        self.reap([dict(run_id='older',started_at=self.clock-1000)])
        self.assertTrue((path/'proof').exists())

    def test_no_live_run_requires_ten_minutes(self):
        path=self.entry('fresh');self.clock=time.time();self.reap();self.assertTrue(path.exists())

    def test_symlink_never_traverses_external_target(self):
        target=self.base/'outside';target.mkdir();(target/'file').write_text('outside')
        (self.root/'link').symlink_to(target);self.reap()
        self.assertEqual((target/'file').read_text(),'outside');self.assertFalse((self.root/'link').is_symlink())

    def test_permission_failure_in_proc_is_not_permission_to_delete(self):
        path=self.entry('uncertain')
        with patch.object(disk,'held_paths',side_effect=PermissionError('no proc access')):
            self.reap()
        self.assertTrue(path.exists());self.assertIn('skipped',self.messages[0])


if __name__=='__main__':unittest.main()
PY
python3 -I - <<'PY'
from pathlib import Path
import ast
for p in ['integrations/offbox/skill/scripts/tests/test_disk_space.py']:
 ast.parse(Path(p).read_text());print('syntax ok')
PY