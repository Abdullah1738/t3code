import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import cpu
import disk_low
import jobs

GB = 1024**3


class FloorTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root/'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs), BUN_INSPECT='private')
        env.start()
        self.addCleanup(env.stop)
        self.sent, self.launched = [], []

    def rows(self, name):
        return [row for path in self.logs.glob('*.ndjson')
                for row in map(json.loads, path.read_text().splitlines()) if row['name'] == name]

    def tick(self, now=1000, free=(14, 101), error=None):
        def statvfs(path):
            if error is not None and path == disk_low.VOLUMES[error][1]:
                raise OSError('fixture')
            return SimpleNamespace(f_bavail=free[0 if path == disk_low.VOLUMES[0][1] else 1]*GB, f_frsize=1)
        with patch.object(disk_low.os, 'statvfs', side_effect=statvfs) as stat:
            disk_low.check(now=now, launch=self.launched.append)
        return stat

    def deliver(self, code=0, now=1000, movers=None):
        def run(command, **kwargs):
            self.sent.append((command, kwargs))
            if isinstance(code, Exception):
                raise code
            return SimpleNamespace(returncode=code)
        with patch.object(disk_low, 'movers', return_value=movers or {}):
            disk_low.pending(run=run, now=now)

    def test_episode_restart_recovery_and_new_episode(self):
        self.tick()
        self.deliver()
        importlib.reload(disk_low)
        self.tick(1120, (1.468, 101))
        self.deliver(now=1120)
        self.assertEqual(len(self.rows('disk.low')), 1)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.launched), 1)
        self.tick(1240, (15, 101))
        self.assertEqual(self.rows('disk.low_cleared')[0]['props'], dict(volume='internal', lowForS=240))
        self.tick(1360)
        self.deliver(now=1360)
        self.assertEqual(len(self.sent), 2)
        self.assertNotEqual(self.sent[0][0][-1], self.sent[1][0][-1])
        self.assertEqual(self.rows('disk.low')[0]['props'], dict(volume='internal', freeGb=14, floorGb=15))

    def test_failure_retries_frozen_message_key_next_tick(self):
        for code in (3, subprocess.TimeoutExpired('notify', 10), OSError('fixture')):
            with self.subTest(code=code):
                jobs.save_state('disk-low', {})
                self.tick()
                self.deliver(code, movers=dict(topMover1Path='/fixture/snapshot', topMover1Gb=54.2))
                first = self.sent[-1][0]
                self.assertFalse(self.rows('disk.alert')[-1]['ok'])
                self.assertEqual(self.rows('disk.alert')[-1]['kind'], 'error')
                self.tick(1120, (1, 101))
                self.deliver(now=1120)
                self.assertTrue(self.rows('disk.alert')[-1]['ok'])
                self.assertEqual(first, self.sent[-1][0])
                self.assertNotIn('BUN_INSPECT', self.sent[-1][1]['env'])

    def test_independent_volumes_and_thresholds(self):
        for internal, external, expected in ((15, 100, []), (14.9999, 100, ['internal']),
                                             (15, 99.9999, ['external']), (1, 1, ['internal', 'external'])):
            with self.subTest(internal=internal, external=external):
                jobs.save_state('disk-low', {})
                before = len(self.rows('disk.low'))
                self.tick(free=(internal, external))
                self.deliver()
                self.assertEqual([r['props']['volume'] for r in self.rows('disk.low')[before:]], expected)

    def test_two_minute_check_no_du_or_tree_reads(self):
        with patch.object(jobs, 'du_total', side_effect=AssertionError('du in detector')), \
             patch.object(disk_low, 'du_total', side_effect=AssertionError('du in detector')), \
             patch.object(disk_low.os, 'scandir', side_effect=AssertionError('tree read')), \
             patch.object(disk_low, 'movers', side_effect=AssertionError('attribution in detector')), \
             patch.object(disk_low.subprocess, 'run', side_effect=AssertionError('command in detector')):
            stat = self.tick(960)
            self.assertEqual([call.args[0] for call in stat.call_args_list], [v[1] for v in disk_low.VOLUMES])
            self.assertEqual(self.tick(1079).call_count, 0)
            self.assertEqual(self.tick(1080).call_count, 2)
        self.assertEqual(len(self.rows('disk.floor_check')), 2)

    def test_volume_error_does_not_clear_and_clock_rollback_checks(self):
        self.tick()
        self.deliver()
        self.tick(1120, (100, 101), error=0)
        self.assertEqual(self.rows('disk.low_cleared'), [])
        self.assertFalse(self.rows('disk.floor_check')[-1]['ok'])
        self.assertEqual(self.tick(900).call_count, 2)

    def test_live_temp_child_named_and_old_entries_and_symlinks_skipped(self):
        root = self.root/'temp'
        root.mkdir()
        child = root/'live-db-snapshot-as3zsikq'
        child.mkdir()
        (root/'old').mkdir()
        os.utime(root/'old', (1, 1))
        (root/'ssd-link').symlink_to('/Volumes/ExternalSSD', target_is_directory=True)
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            self.assertLessEqual(kwargs['timeout'], disk_low.CHILD_BUDGET_S)
            self.assertIn('-skl', command)
            self.assertEqual(command[-1], str(child))
            return SimpleNamespace(returncode=0, stdout='%d\t%s\n' % (58190110720//1024, child), stderr='')
        props = disk_low.movers('internal', now=__import__('time').time(), run=run, temp_dir=root)
        self.assertEqual(props['topMover1Path'], str(child))
        self.assertAlmostEqual(props['topMover1Gb'], 54.194, places=2)
        self.assertNotIn('topMover1GbDelta', props)
        self.assertEqual(len(calls), 1)
        self.tick()
        self.deliver(movers=props)
        self.assertIn('live-db-snapshot-as3zsikq 54.2 GB', self.sent[-1][0][self.sent[-1][0].index('--text')+1])
        self.assertEqual(self.rows('disk.low')[-1]['props']['topMover1Path'], str(child))

    def test_du_timeout_and_exhausted_budget_are_logged(self):
        root = self.root/'temp'
        root.mkdir()
        (root/'snapshot').mkdir()
        with patch.object(disk_low.time, 'monotonic', return_value=1):
            with self.assertRaises(jobs.SourceFailure):
                disk_low.recent_temp_sizes(root, 1000,
                    lambda *a, **kw: self.fail('du after budget'), deadline=0)
            with patch.object(disk_low, 'MOVER_BUDGET_S', -1):
                self.assertEqual(disk_low.movers('internal', 1000,
                    run=lambda *a, **kw: self.fail('du after budget'), temp_dir=root), {})
        self.assertTrue(self.rows('disk.movers_skipped'))

    def test_du_timeout_is_logged(self):
        root = self.root/'temp'
        root.mkdir()
        (root/'snapshot').mkdir()
        def timeout(command, **kw):
            raise subprocess.TimeoutExpired(command, kw['timeout'])
        self.assertEqual(disk_low.movers('internal', 1000, run=timeout, temp_dir=root), {})
        self.assertTrue(self.rows('disk.movers_skipped'))

    def test_budget_exhaustion_retains_completed_sizes(self):
        root = self.root/'temp'
        root.mkdir()
        (root/'snapshot').mkdir()
        (root/'next').mkdir()
        os.utime(root/'snapshot', (1000, 1000))
        os.utime(root/'next', (999, 999))
        clock = [100]
        def measure(path, run, timeout):
            clock[0] = 107
            return 54*GB, 0, 0
        with patch.object(disk_low.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(disk_low, 'du_total', side_effect=measure):
            sizes = disk_low.recent_temp_sizes(root, 1000, None, 106)
        self.assertEqual(sizes, {str(root/'snapshot'): 54*GB})
        self.assertTrue(self.rows('disk.movers_skipped'))

    def test_sampler_calls_floor_before_slow_probes(self):
        calls = []
        with patch.object(disk_low, 'check', side_effect=lambda: calls.append('floor')), \
             patch('u_sample.sample', side_effect=lambda: calls.append('u')), \
             patch.object(cpu, 'sample', side_effect=lambda: calls.append('cpu')):
            cpu.main()
        self.assertEqual(calls, ['floor', 'u', 'cpu'])

    def test_busy_worker_lock_prevents_extra_worker(self):
        lock = disk_low.lock_file()
        with lock:
            self.tick()
        self.assertEqual(self.launched, [])

    def test_unkillable_du_is_abandoned_without_wait(self):
        child = Mock(pid=123, returncode=None)
        child.poll.return_value = None
        child.stdout, child.stderr = io.BytesIO(), io.BytesIO()
        child.stdout.fileno = child.stderr.fileno = lambda: 1
        with patch.object(disk_low.subprocess, 'Popen', return_value=child), \
             patch.object(disk_low.time, 'monotonic', side_effect=[0, 1]), \
             patch.object(disk_low.os, 'set_blocking'), \
             patch.object(disk_low.os, 'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                disk_low.bounded_command(['du'], timeout=.5)
        kill.assert_called_once()
        child.wait.assert_not_called()
        child.communicate.assert_not_called()

    def test_bounded_command_returns_small_output_without_tempfiles(self):
        result = disk_low.bounded_command([sys.executable, '-I', '-c', 'print("fixture")'],
                                          timeout=2, text=True)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, 'fixture\n', ''))

    def test_external_alert_never_scans(self):
        with patch.object(disk_low, 'user_temp_dir', side_effect=AssertionError('temp read')), \
             patch.object(disk_low, 'du_total', side_effect=AssertionError('du')), \
             patch.object(disk_low.os, 'scandir', side_effect=AssertionError('SSD scan')):
            self.tick(free=(20, 99))
            disk_low.pending(run=lambda *a, **kw: SimpleNamespace(returncode=0))
        self.assertEqual(self.rows('disk.low')[-1]['props']['volume'], 'external')

    def test_opencode_directory_uses_shared_mover_delta(self):
        path = str(Path.home()/'.local/share/opencode')
        jobs.save_state('disk', dict(sizes={path: 60*GB}))
        parent = str(Path.home()/'.local/share')
        jobs.save_state('disk-inventory', dict(at=1000, children={parent: {path: 67*GB}},
            childState={parent: {path: dict(at=1000, partial=False, isDirectory=True)}}))
        root = self.root/'temp'
        root.mkdir()
        props = disk_low.movers('internal', 1000, temp_dir=root)
        self.assertEqual(props, dict(topMover1Path=path, topMover1Gb=67, topMover1GbDelta=7))

    def test_attribution_failure_still_alerts(self):
        self.tick()
        with patch.object(disk_low, 'movers', side_effect=ValueError('corrupt inventory')):
            disk_low.pending(run=lambda *a, **kw: SimpleNamespace(returncode=0))
        self.assertEqual(len(self.rows('disk.low')), 1)
        self.assertTrue(self.rows('disk.alert')[0]['ok'])
        self.assertTrue(self.rows('disk.movers_skipped'))


if __name__ == '__main__':
    unittest.main()
