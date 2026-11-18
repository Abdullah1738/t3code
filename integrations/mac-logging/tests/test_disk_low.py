import importlib
import io
import json
import errno
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import signal
import time
from copy import deepcopy
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
        backup = patch.object(disk_low, 'EMERGENCY_STATE', self.root/'backup'/'disk-low.json', create=True)
        backup.start()
        self.addCleanup(backup.stop)
        mounted = patch.object(disk_low.os.path, 'ismount', return_value=True)
        mounted.start()
        self.addCleanup(mounted.stop)

    def rows(self, name):
        return [row for path in self.logs.glob('*.ndjson')
                for row in map(json.loads, path.read_text().splitlines()) if row['name'] == name]

    def tick(self, now=1000, free=(14, 101), error=None):
        def statvfs(path):
            if error is not None and path == disk_low.VOLUMES[error][1]:
                raise OSError('fixture')
            return SimpleNamespace(f_bavail=free[0 if path == disk_low.VOLUMES[0][1] else 1]*GB, f_frsize=1)
        with patch.object(disk_low.os, 'statvfs', side_effect=statvfs) as stat:
            disk_low.check(now=now, launch=lambda *args: self.launched.append(deepcopy(args)))
        return stat

    def deliver(self, code=0, now=1000, movers=None, state=None):
        def run(command, **kwargs):
            self.sent.append((command, kwargs))
            if isinstance(code, Exception):
                raise code
            return SimpleNamespace(returncode=code)
        with patch.object(disk_low, 'movers', return_value=movers or {}):
            if state is None:
                disk_low.pending(run=run, now=now)
            else:
                disk_low.pending(run=run, now=now, state=state)

    def test_enospc_checkpoints_do_not_gate_delivery_or_change_retry(self):
        for failure in ('detection', 'message', 'receipt', 'all'):
            with self.subTest(failure=failure):
                jobs.save_state('disk-low', {})
                backup = disk_low.EMERGENCY_STATE
                backup.unlink(missing_ok=True)
                def save(name, value):
                    episodes = value.get('episodes', {})
                    stage = ('receipt' if any(e.get('sent') for e in episodes.values()) else
                             'message' if any(e.get('logged') for e in episodes.values()) else 'detection')
                    if name == 'disk-low' and failure in ('all', stage):
                        raise OSError(errno.ENOSPC, 'fixture full')
                    jobs.save_state(name, value)
                with patch.object(disk_low, 'save_state', side_effect=save):
                    before = len(self.sent)
                    low_before = len(self.rows('disk.low'))
                    self.tick()
                    self.assertTrue(self.launched)
                    state = self.launched[-1][1] if len(self.launched[-1]) > 1 else None
                    self.deliver(code=3, state=state,
                                 movers=dict(topMover1Path='/fixture/snapshot', topMover1Gb=54))
                    first = self.sent[-1][0]
                    # A fresh tick reads only durable state, as after restart.
                    self.tick(1120, (1, 101))
                    state = self.launched[-1][1] if len(self.launched[-1]) > 1 else None
                    self.deliver(now=1120, state=state)
                    self.assertEqual(len(self.sent), before+2)
                    self.assertEqual(first, self.sent[-1][0])
                    self.tick(1240, (1, 101))
                    state = self.launched[-1][1] if len(self.launched[-1]) > 1 else None
                    self.deliver(now=1240, state=state)
                    self.assertEqual(len(self.sent), before+2)
                    self.assertEqual(len(self.rows('disk.low')), low_before+1)
                self.assertTrue(self.rows('disk.state_failed'))

    def test_full_filesystem_does_not_need_a_new_lock_file(self):
        jobs.save_state('disk-low', {})
        original = os.open
        def no_create(path, flags, *args, **kwargs):
            if flags & os.O_CREAT:
                raise OSError(errno.ENOSPC, 'fixture full')
            return original(path, flags, *args, **kwargs)
        with patch.object(disk_low.os, 'open', side_effect=no_create):
            self.tick()
        self.deliver(state=self.launched[-1][1])
        self.assertEqual(len(self.sent), 1)

    def test_emergency_state_records_recovery_and_rearms_after_restart(self):
        with patch.object(disk_low, 'save_state', side_effect=OSError(errno.ENOSPC, 'fixture full')):
            self.tick()
            self.deliver(state=self.launched[-1][1])
            first_key = self.sent[-1][0][-1]
            self.tick(1120, (20, 101))
            self.deliver(now=1120, state=self.launched[-1][1])
            self.assertEqual(self.rows('disk.low_cleared')[-1]['props'], dict(volume='internal', lowForS=120))
            self.tick(1240)
            self.deliver(now=1240, state=self.launched[-1][1])
            self.assertEqual(len(self.sent), 2)
            self.assertNotEqual(first_key, self.sent[-1][0][-1])
            self.tick(1360)
            self.deliver(now=1360, state=self.launched[-1][1])
            self.assertEqual(len(self.sent), 2)
        # Restoring primary writes migrates the emergency receipt back.
        self.tick(1480)
        self.deliver(now=1480, state=self.launched[-1][1])
        self.assertEqual(len(self.sent), 2)
        self.assertTrue(jobs.read_state('disk-low')['episodes']['internal']['sent'])
        self.assertFalse(disk_low.EMERGENCY_STATE.exists())

    def test_unavailable_backup_never_blocks_full_internal_alert(self):
        for external, mounted, error in ((101, False, None), (101, False, 1), (99, True, None)):
            with self.subTest(external=external, mounted=mounted, error=error):
                jobs.save_state('disk-low', {})
                with patch.object(disk_low, 'save_state', side_effect=OSError(errno.ENOSPC, 'fixture full')), \
                     patch.object(disk_low.os.path, 'ismount', return_value=mounted):
                    self.tick(free=(1, external), error=error)
                    state = self.launched[-1][1] if len(self.launched[-1]) > 1 else None
                    before = len(self.sent)
                    self.deliver(state=state)
                self.assertEqual(len(self.sent)-before, 1 if external >= 100 else 2)
                self.assertFalse(disk_low.EMERGENCY_STATE.exists())
                self.assertTrue(self.rows('disk.state_failed'))

    def test_emergency_io_timeout_or_full_backup_still_sends(self):
        for phase in ('mount', 'read', 'write'):
            with self.subTest(phase=phase):
                jobs.save_state('disk-low', {})
                disk_low.EMERGENCY_STATE.unlink(missing_ok=True)
                def slow(*args):
                    time.sleep(.2)
                def full(state):
                    raise OSError(errno.ENOSPC, 'fixture backup full')
                target = {'mount': (disk_low.os.path, 'ismount', slow),
                          'read': (disk_low, 'read_emergency', slow),
                          'write': (disk_low, 'write_emergency', full)}[phase]
                with patch.object(disk_low, 'save_state', side_effect=OSError(errno.ENOSPC, 'fixture full')), \
                     patch.object(disk_low, 'STATE_IO_BUDGET_S', .02), \
                     patch.object(target[0], target[1], side_effect=target[2]):
                    self.tick()
                    before = len(self.sent)
                    self.deliver(state=self.launched[-1][1])
                    self.assertEqual(len(self.sent), before+1)
                self.assertTrue(self.rows('disk.state_skipped'))

    def test_child_snapshot_handoff_with_inherited_directory_lock(self):
        popen = subprocess.Popen
        children = []
        def spawn(*args, **kwargs):
            child = popen(*args, **kwargs)
            children.append(child)
            return child
        with disk_low.lock_file() as fd, patch.object(disk_low.subprocess, 'Popen', side_effect=spawn):
            disk_low.launch_worker(fd, dict(episodes={}, handoff='fixture'))
            self.assertEqual(children[0].wait(timeout=3), 0)
        self.assertEqual(jobs.read_state('disk-low')['handoff'], 'fixture')

    def test_corrupt_emergency_checkpoint_is_optional(self):
        fixtures = [[], {'episodes': []}, {'episodes': {'internal': None}},
                    {'episodes': {'internal': {'key': 'fixture'}}},
                    {'healthyAt': {'internal': 'bad'}},
                    {'episodes': {'internal': dict(key='fixture', start=1, sent='true')}},
                    {'episodes': {'internal': dict(key='fixture', start=1, logged=True, text=None)}}]
        for value in fixtures:
            with self.subTest(value=value):
                jobs.save_state('disk-low', {})
                self.tick()
                disk_low.EMERGENCY_STATE.parent.mkdir(exist_ok=True)
                disk_low.EMERGENCY_STATE.write_text(json.dumps(value))
                before = len(self.sent)
                skipped = len(self.rows('disk.state_skipped'))
                self.deliver()
                self.assertEqual(len(self.sent), before+1)
                self.assertGreater(len(self.rows('disk.state_skipped')), skipped)

    def test_no_checkpoint_available_retries_one_bridge_key(self):
        accepted, attempts = {}, []
        def bridge(command, **kwargs):
            key = command[-1]
            text = command[command.index('--text')+1]
            attempts.append(key)
            if key in accepted:
                # The real bridge rejects changed text and retains its first
                # accepted payload; an ambiguous send cannot create a duplicate.
                return SimpleNamespace(returncode=0 if accepted[key] == text else 1)
            accepted[key] = text
            return SimpleNamespace(returncode=0)
        with patch.object(disk_low, 'save_state', side_effect=OSError(errno.ENOSPC, 'fixture full')), \
             patch.object(disk_low.os.path, 'ismount', return_value=False), \
             patch.object(disk_low, 'movers', return_value={}):
            for now, free in ((1000, 1), (1120, .5)):
                self.tick(now, (free, 101))
                disk_low.pending(run=bridge, now=now, state=self.launched[-1][1])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(len(set(attempts)), 1)
        self.assertEqual(len(accepted), 1)

    def test_mover_cache_enospc_preserves_measured_attribution(self):
        root = self.root/'temp'
        root.mkdir()
        child = root/'snapshot'
        child.mkdir()
        def run(command, **kwargs):
            return SimpleNamespace(returncode=0, stdout='%d\t%s\n' % (54*GB//1024, child), stderr='')
        with patch.object(disk_low, 'save_state', side_effect=OSError(errno.ENOSPC, 'fixture full')):
            props = disk_low.movers('internal', 1000, run=run, temp_dir=root)
        self.assertEqual(props['topMover1Path'], str(child))
        self.assertEqual(props['topMover1Gb'], 54)

    def test_listing_deadline_covers_open_next_stat_and_close_and_releases_lock(self):
        for phase in ('open', 'next', 'stat', 'close'):
            with self.subTest(phase=phase):
                jobs.save_state('disk-low', {})
                self.tick()
                completed = []
                def slow():
                    # An actual interrupted operation proves the alarm is live.
                    time.sleep(.2)
                    completed.append(phase)
                entry = SimpleNamespace(path='/fixture/snapshot')
                entry.stat = lambda **kw: slow() if phase == 'stat' else SimpleNamespace(st_mtime=1000, st_mode=0o040700)
                class Listing:
                    yielded = False
                    def __enter__(self):
                        return self
                    def __exit__(self, *args):
                        if phase == 'close':
                            slow()
                    def __iter__(self):
                        return self
                    def __next__(self):
                        if phase == 'next':
                            slow()
                        if phase == 'stat' and not self.yielded:
                            self.yielded = True
                            return entry
                        raise StopIteration
                def listing(root):
                    if phase == 'open':
                        slow()
                    return Listing()
                with patch.object(disk_low, 'user_temp_dir', return_value=self.root), \
                     patch.object(disk_low.os, 'scandir', side_effect=listing), \
                     patch.object(disk_low, 'MOVER_BUDGET_S', .02):
                    with disk_low.lock_file():
                        disk_low.pending(run=lambda *a, **kw: SimpleNamespace(returncode=0), now=1000)
                self.assertEqual(completed, [], phase)
                self.assertTrue(self.rows('disk.movers_skipped'))
                self.assertTrue(self.rows('disk.alert')[-1]['ok'])
                with disk_low.lock_file() as lock:
                    self.assertIsNotNone(lock)
                self.assertEqual(signal.getitimer(signal.ITIMER_REAL)[0], 0)

    def test_episode_restart_recovery_and_new_episode(self):
        self.tick()
        self.deliver()
        importlib.reload(disk_low)
        disk_low.EMERGENCY_STATE = self.root/'backup'/'disk-low.json'
        self.tick(1120, (1.468, 101))
        self.deliver(now=1120)
        self.assertEqual(len(self.rows('disk.low')), 1)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(len(self.launched), 2)
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
             patch.object(disk_low, 'emergency_io', side_effect=AssertionError('SSD state in detector')), \
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
