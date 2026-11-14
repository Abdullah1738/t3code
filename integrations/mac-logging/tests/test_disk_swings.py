import fcntl
import errno
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import jobs
import test_shell_jobs as shell_jobs

GB = 1024**3


class DiskSwingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root/'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        self.paths = [Path('/Volumes/ExternalSSD')/name for name in ('t3code-wt', 'caches', 'wt')]
        self.at = time.time()

    def rows(self, name):
        return [row for path in self.logs.glob('*.ndjson')
                for row in map(json.loads, path.read_text().splitlines()) if row['name'] == name]

    def inventory(self, sizes, age=0):
        jobs.save_state('disk-inventory', dict(at=self.at-age,
                        sizes={str(p): size*GB for p, size in zip(self.paths, sizes)}))

    def sample(self, free=642):
        with patch.object(jobs.os, 'statvfs', return_value=SimpleNamespace(f_bavail=free*GB, f_frsize=1)), \
             patch.object(jobs, 'storage_probes', return_value=dict(internalPurgeableGb=2, externalPurgeableGb=4,
                    internalLocalSnapshotCount=1, externalLocalSnapshotCount=0)):
            jobs.disk_sample(self.root, self.root/'tmp', paths=[])
        return self.rows('disk.sample')[-1]

    def test_baseline_small_positive_and_negative_swings(self):
        self.inventory([100, 20, 10])
        baseline = self.sample()
        self.assertIsNone(baseline['props']['externalFreeGbDelta'])
        self.assertIsNone(baseline['props']['internalFreeGbDelta'])
        self.assertEqual(self.rows('disk.swing'), [])
        small = self.sample(643)
        self.assertEqual(small['props']['externalFreeGbDelta'], 1)
        self.assertEqual(self.rows('disk.swing'), [])
        self.inventory([5, 24, 7])
        sample = self.sample(738)
        self.assertEqual(sample['props']['topMover1Path'], str(self.paths[0]))
        self.assertEqual(sample['props']['topMover1GbDelta'], -95)
        swing = self.rows('disk.swing')[-1]
        self.assertEqual(swing['kind'], 'event')
        self.assertEqual(swing['props']['externalFreeGbDelta'], 95)
        self.assertEqual([swing['props']['topMover%dGbDelta' % i] for i in (1, 2, 3)], [-95, 4, -3])
        self.assertEqual(swing['props']['previousTs'], small['ts'])
        self.assertEqual(swing['props']['sampleTs'], sample['ts'])
        if os.environ.get('DISK_SWING_SHOW_EVIDENCE') == '1':
            print(json.dumps(sample, separators=(',', ':')))
            print(json.dumps(swing, separators=(',', ':')))
        self.assertEqual(self.sample(712)['props']['externalFreeGbDelta'], -26)
        self.assertEqual(len(self.rows('disk.swing')), 2)
        self.assertTrue(all(row['ok'] for row in self.rows('disk.sample')))
        self.assertEqual(self.rows('disk.alert'), [])

    def test_thresholds_independent_volumes_and_single_event(self):
        self.sample(100)
        for delta in (19.999, 20, -20, -19.999):
            with self.subTest(delta=delta):
                self.sample(100)
                before = len(self.rows('disk.swing'))
                with patch.object(jobs.os, 'statvfs', side_effect=[SimpleNamespace(f_bavail=100*GB, f_frsize=1),
                     SimpleNamespace(f_bavail=(100+delta)*GB, f_frsize=1)]), patch.object(jobs, 'storage_probes', return_value={}):
                    jobs.disk_sample(self.root, self.root/'tmp', paths=[])
                self.assertEqual(len(self.rows('disk.swing'))-before, int(abs(delta) >= 20))

    def test_stale_missing_and_failed_inventory_omit_movers(self):
        for state in ({}, {'at': self.at-7201, 'sizes': {str(self.paths[0]): 5*GB}},
                      {'at': self.at, 'sizes': {}, 'sourceErrors': 13},
                      {'at': self.at+100, 'sizes': {str(self.paths[0]): 5*GB}}):
            with self.subTest(state=state):
                self.inventory([100, 20, 10])
                self.sample()
                jobs.save_state('disk-inventory', state)
                row = self.sample(737)
                swing = self.rows('disk.swing')[-1]
                self.assertNotIn('topMover1Path', row['props'])
                self.assertNotIn('topMover1Path', swing['props'])
                self.assertTrue(row['ok'])

    def test_malformed_previous_state_and_inventory(self):
        for text in ('{bad', '[]', 'null', '42', '{"sizes": [], "free": []}',
                     '{"sizes":{"x":null},"free":{"externalFreeGb":"bad"}}'):
            with self.subTest(text=text):
                jobs.state_path('disk').write_text(text)
                jobs.state_path('disk-inventory').write_text(text)
                row = self.sample()
                self.assertIsNone(row['props']['externalFreeGbDelta'])
                self.assertTrue(row['ok'])

    def test_partial_inventory_does_not_claim_a_shrinker(self):
        self.inventory([100, 20, 10])
        self.sample()
        self.inventory([5, 20, 10])
        state = jobs.read_state('disk-inventory')
        state['partials'] = {str(self.paths[0]): dict(partial=True, deniedCount=1)}
        jobs.save_state('disk-inventory', state)
        self.assertNotIn('topMover1Path', self.sample(737)['props'])
        self.inventory([100, 20, 10])
        self.assertNotIn('topMover1Path', self.sample()['props'])

    def test_confirmed_root_creation_and_deletion_are_movers(self):
        for created in (False, True):
            with self.subTest(created=created):
                root = self.root/('created-root' if created else 'deleted-root')
                jobs.save_state('disk', {})
                if not created:
                    root.mkdir()
                def run(command, **kwargs):
                    return SimpleNamespace(returncode=0, stdout=str(95*GB//1024)+'\t'+command[-1], stderr='')
                with patch.object(jobs, 'DIRECTORY_ROOTS', [root]):
                    jobs.directory_inventory([root], run)
                    before = self.sample(737 if created else 642)
                    if created:
                        root.mkdir()
                    else:
                        root.rmdir()
                    jobs.directory_inventory([root], run)
                    after = self.sample(642 if created else 737)
                state = jobs.read_state('disk')
                self.assertEqual(state['sizes'][str(root)], 95*GB if created else 0)
                self.assertTrue(after['ok'])
                self.assertEqual(after['props']['topMover1Path'], str(root))
                self.assertEqual(after['props']['topMover1GbDelta'], 95 if created else -95)
                swing = self.rows('disk.swing')[-1]['props']
                self.assertEqual(swing['previousTs'], before['ts'])
                self.assertEqual(swing['topMover1GbDelta'], 95 if created else -95)
                self.assertEqual(swing['externalFreeGbDelta'], -95 if created else 95)
                self.assertEqual(self.rows('disk.alert'), [])
                if os.environ.get('DISK_SWING_SHOW_EVIDENCE') == '1':
                    print(json.dumps(after, separators=(',', ':')))
                    print(json.dumps(self.rows('disk.swing')[-1], separators=(',', ':')))

    def test_confirmed_wal_creation_deletion_and_repeated_absence(self):
        wal = self.root/'tracked.sqlite-wal'
        self.inventory([])
        def sample(size, free):
            if size is None:
                wal.unlink(missing_ok=True)
            else:
                with wal.open('wb') as stream:
                    stream.truncate(size)
            with patch.object(jobs.os, 'statvfs', return_value=SimpleNamespace(f_bavail=free*GB, f_frsize=1)), \
                 patch.object(jobs, 'storage_probes', return_value={}):
                jobs.disk_sample(self.root, self.root/'tmp', paths=[wal])
            return self.rows('disk.sample')[-1]
        self.assertEqual(sample(None, 737)['props']['baseline'], 1)
        creation = sample(26*GB, 711)
        self.assertEqual(creation['props']['topMover1GbDelta'], 26)
        self.assertEqual(creation['props']['grower1DeltaGb'], 26)
        deletion = sample(None, 737)
        self.assertEqual(deletion['props']['topMover1Path'], str(wal))
        self.assertEqual(deletion['props']['topMover1GbDelta'], -26)
        self.assertEqual(jobs.read_state('disk')['sizes'][str(wal)], 0)
        self.assertNotIn('topMover1Path', sample(None, 737)['props'])
        self.assertEqual(len(self.rows('disk.swing')), 2)

    def test_unknown_root_transitions_are_not_zero(self):
        for failure in ('timeout', 'permission', 'parse', 'missing-du', 'missing-filename'):
            for failed_first in (False, True):
                with self.subTest(failure=failure, failed_first=failed_first):
                    root = self.root/(failure+str(failed_first)); root.mkdir()
                    jobs.save_state('disk', {})
                    def run(command, **kwargs):
                        if failure == 'timeout': raise subprocess.TimeoutExpired(command, 60)
                        if failure == 'permission': raise PermissionError(errno.EACCES, 'fixture', str(root))
                        if failure == 'missing-du': raise FileNotFoundError(errno.ENOENT, 'fixture', '/usr/bin/du')
                        if failure == 'missing-filename': raise FileNotFoundError(errno.ENOENT, 'fixture')
                        return SimpleNamespace(returncode=0, stdout='bad total', stderr='')
                    def good(command, **kwargs):
                        return SimpleNamespace(returncode=0, stdout=str(95*GB//1024)+'\t'+command[-1], stderr='')
                    with patch.object(jobs, 'DIRECTORY_ROOTS', [root]):
                        jobs.directory_inventory([root], run if failed_first else good)
                        self.sample(642)
                        jobs.directory_inventory([root], good if failed_first else run)
                        self.assertEqual(jobs.read_state('disk-inventory')['sizes'].get(str(root)), 95*GB if failed_first else None)
                        after = self.sample(737)
                    self.assertNotIn('topMover1Path', after['props'])
                    self.assertNotIn('topMover1Path', self.rows('disk.swing')[-1]['props'])

    def test_unknown_wal_stat_is_not_absence_in_either_sample(self):
        wal = self.root/'unknown.sqlite-wal'
        for failure in (PermissionError(errno.EACCES, 'fixture', str(wal)),
                        OSError(errno.EIO, 'fixture', str(wal)),
                        FileNotFoundError(errno.ENOENT, 'fixture'),
                        FileNotFoundError(errno.ENOENT, 'fixture', str(self.root/'unrelated'))):
            for failed_first in (False, True):
                with self.subTest(failure=failure, failed_first=failed_first):
                    jobs.save_state('disk', {})
                    self.inventory([])
                    original = Path.stat
                    failing = [failed_first]
                    def stat(path, *args, **kwargs):
                        if path == wal:
                            if failing[0]: raise failure
                            return SimpleNamespace(st_size=26*GB)
                        return original(path, *args, **kwargs)
                    with patch.object(Path, 'stat', stat), patch.object(jobs, 'storage_probes', return_value={}):
                        with patch.object(jobs.os, 'statvfs', return_value=SimpleNamespace(f_bavail=711*GB, f_frsize=1)):
                            jobs.disk_sample(self.root, self.root/'tmp', paths=[wal])
                        failing[0] = not failed_first
                        with patch.object(jobs.os, 'statvfs', return_value=SimpleNamespace(f_bavail=737*GB, f_frsize=1)):
                            jobs.disk_sample(self.root, self.root/'tmp', paths=[wal])
                    self.assertNotIn('topMover1Path', self.rows('disk.sample')[-1]['props'])
                    self.assertNotIn('topMover1Path', self.rows('disk.swing')[-1]['props'])

    def test_stale_partial_and_unrecorded_absence_cannot_claim_movers(self):
        for status in ('stale', 'partial', 'unrecorded'):
            for unknown_first in (False, True):
                with self.subTest(status=status, unknown_first=unknown_first):
                    jobs.save_state('disk', {})
                    path = str(self.paths[0])
                    known = dict(at=self.at, sizes={path: 95*GB})
                    unknown = dict(at=self.at-(7201 if status == 'stale' else 0),
                                   sizes={} if status == 'unrecorded' else {path: 0})
                    if status == 'partial': unknown['partials'] = {path: dict(partial=True)}
                    jobs.save_state('disk-inventory', unknown if unknown_first else known)
                    self.sample(642)
                    jobs.save_state('disk-inventory', known if unknown_first else unknown)
                    self.assertNotIn('topMover1Path', self.sample(737)['props'])
                    self.assertNotIn('topMover1Path', self.rows('disk.swing')[-1]['props'])

    def test_backing_volume_availability_controls_absence(self):
        root = self.root/'unmounted-root'
        wal = self.root/'unmounted.sqlite-wal'
        original = Path.resolve
        def resolve(path, *args, **kwargs):
            if path in (root, wal):
                return Path('/Volumes/Unavailable')/path.name
            return original(path, *args, **kwargs)
        for mounted in (False, True):
            with self.subTest(mounted=mounted), patch.object(Path, 'resolve', resolve), \
                 patch.object(Path, 'is_mount', return_value=mounted):
                jobs.directory_inventory([root], lambda *args, **kwargs: self.fail('must not launch du'))
                inventory = jobs.read_state('disk-inventory')
                self.assertEqual(inventory['sizes'].get(str(root)), 0 if mounted else None)
                self.assertEqual(inventory['sourceErrors'], 0 if mounted else 1)
                self.inventory([])
                with patch.object(jobs, 'storage_probes', return_value={}):
                    jobs.disk_sample(self.root, self.root/'tmp', volumes=(self.root, self.root), paths=[wal])
                self.assertEqual(jobs.read_state('disk')['sizes'].get(str(wal)), 0 if mounted else None)
                self.assertEqual(self.rows('disk.sample')[-1]['props']['sourceErrors'], 0 if mounted else 1)

    def test_symlink_loop_during_absence_check_is_unknown(self):
        root = self.root/'missing-root'
        with patch.object(Path, 'resolve', side_effect=RuntimeError('symlink loop')):
            jobs.directory_inventory([root], lambda *args, **kwargs: self.fail('must not launch du'))
        self.assertNotIn(str(root), jobs.read_state('disk-inventory')['sizes'])
        self.assertEqual(jobs.read_state('disk-inventory')['sourceErrors'], 1)

    def test_previous_partial_state_keys_suppress_growers_and_movers(self):
        for key in ('partials', 'inventoryPartials'):
            with self.subTest(key=key):
                path = str(self.paths[0])
                jobs.save_state('disk', dict(sizes={path: GB}, inventoryAt=self.at,
                    free={'internalFreeGb': 737, 'externalFreeGb': 737},
                    ts='2026-11-13T12:00:00.000Z', **{key: {path: dict(partial=True)}}))
                self.inventory([95])
                after = self.sample(642)
                self.assertNotIn('grower1Path', after['props'])
                self.assertNotIn('topMover1Path', after['props'])
                self.assertNotIn('topMover1Path', self.rows('disk.swing')[-1]['props'])
                recovered = self.sample(642)
                self.assertNotIn('grower1Path', recovered['props'])
                self.assertNotIn('topMover1Path', recovered['props'])

    def test_main_state_without_inventory_at_migrates_without_invented_deltas(self):
        for partial in (False, True):
            case_logs = self.root/('partial-logs' if partial else 'complete-logs')
            with self.subTest(partial=partial), patch.object(self, 'logs', case_logs), \
                 patch.dict(os.environ, TOOLLOG_DIR=str(case_logs)):
                path = str(self.paths[0])
                jobs.save_state('disk', dict(sizes={path: GB},
                    partials={path: dict(partial=True)} if partial else {}))
                self.inventory([95])
                swings_before = len(self.rows('disk.swing'))
                first = self.sample(642)
                self.assertTrue(first['ok'])
                self.assertEqual(first['props']['baseline'], 0)
                self.assertEqual(first['props']['count'], 0 if partial else 1)
                if not partial:
                    self.assertEqual(first['props']['grower1DeltaGb'], 94)
                self.assertIsNone(first['props']['internalFreeGbDelta'])
                self.assertIsNone(first['props']['externalFreeGbDelta'])
                self.assertNotIn('topMover1Path', first['props'])
                self.assertEqual(len(self.rows('disk.swing')), swings_before)
                migrated = jobs.read_state('disk')
                self.assertEqual(migrated['sizes'][path], 95*GB)
                self.assertEqual(migrated['partials'], {})
                self.assertEqual(migrated['inventoryAt'], self.at)
                self.assertEqual(migrated['ts'], first['ts'])
                self.inventory([121])
                next_sample = self.sample(616)
                self.assertEqual(next_sample['props']['topMover1Path'], path)
                self.assertEqual(next_sample['props']['topMover1GbDelta'], 26)
                self.assertEqual(next_sample['props']['externalFreeGbDelta'], -26)
                self.assertEqual(len(self.rows('disk.swing')), swings_before+1)
                self.assertEqual(self.rows('disk.swing')[-1]['props']['previousTs'], first['ts'])

    def test_big_root_partial_scan_recovery_and_deletion(self):
        root = self.root/'big-root'; root.mkdir()
        fast, slow = root/'fast', root/'slow'
        fast.mkdir(); slow.mkdir()
        mode = ['complete']
        def run(command, **kwargs):
            if Path(command[-1]) == slow and mode[0] == 'partial':
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            size = 95*GB if mode[0] == 'complete' else GB
            return SimpleNamespace(returncode=0, stdout=str(size//1024)+'\t'+command[-1], stderr='')
        with patch.object(jobs, 'DIRECTORY_ROOTS', [root]), patch.object(jobs, 'BIG_ROOTS', {root}):
            jobs.directory_inventory([root], run)
            self.sample(642)
            mode[0] = 'partial'
            jobs.directory_inventory([root], run)
            inventory = jobs.read_state('disk-inventory')
            self.assertEqual(inventory['children'][str(root)], {str(fast): GB})
            self.assertTrue(inventory['partials'][str(root)]['partial'])
            after = self.sample(737)
            self.assertNotIn('topMover1Path', after['props'])
            self.assertNotIn('grower1Path', after['props'])
            mode[0] = 'low'
            jobs.directory_inventory([root], run)
            recovered = self.sample(737)
            self.assertNotIn('topMover1Path', recovered['props'])
            self.assertNotIn('grower1Path', recovered['props'])
            fast.rmdir(); slow.rmdir(); root.rmdir()
            jobs.directory_inventory([root], run)
            deleted = self.sample(763)
            self.assertEqual(deleted['props']['topMover1Path'], str(root))
            self.assertEqual(deleted['props']['topMover1GbDelta'], -2)
            self.assertEqual(self.rows('disk.swing')[-1]['props']['topMover1GbDelta'], -2)

    def test_private_output_and_untracked_movers_cannot_enter_log(self):
        self.inventory([100, 20, 10])
        self.sample()
        previous = jobs.read_state('disk')
        previous['sizes']['/private/customer-name'] = 200*GB
        jobs.save_state('disk', previous)
        state = jobs.read_state('disk-inventory')
        state['sizes']['/private/customer-name'] = 1
        jobs.save_state('disk-inventory', state)
        row = self.sample(737)
        self.assertNotIn('topMover1Path', row['props'])
        # Arbitrary names in diskutil plist and tmutil headers are ignored.
        executable = self.root/'probe'
        executable.write_text('#!'+sys.executable+'\nimport plistlib,sys\n'
            'if sys.argv[1] == "info": sys.stdout.buffer.write(plistlib.dumps({"PurgeableSpace":1073741824,"VolumeName":"private-volume-name"}))\n'
            'else: print("Snapshots for private-volume-name:");print("com.apple.TimeMachine.2026-11-13-120000.local")\n')
        executable.chmod(0o755)
        def popen(command, **kwargs):
            return subprocess.Popen([str(executable), *command[1:]], **kwargs)
        props = jobs.storage_probes(('/', '/Volumes/ExternalSSD'), time.monotonic(), popen)
        self.assertEqual(props, dict(internalPurgeableGb=1, externalPurgeableGb=1,
                                    internalLocalSnapshotCount=1, externalLocalSnapshotCount=1))
        self.assertNotIn('private-volume-name', json.dumps(props))

    def test_parser_forms(self):
        for key in ('PurgeableSpace', 'PurgeableSize'):
            for value in (0, GB):
                self.assertEqual(jobs.storage_value(plistlib.dumps({key: value})), value/GB)
        self.assertIsNone(jobs.storage_value(plistlib.dumps({'FreeSpace': GB})))
        for value in (-1, True, '123'):
            with self.assertRaises(ValueError):
                jobs.storage_value(plistlib.dumps({'PurgeableSpace': value}))
        for output, expected in ((b'Snapshots for disk:\n', 0),
                                 (b'Snapshots for disk:\ncom.apple.TimeMachine.2026-11-13-120000\n', 1)):
            self.assertEqual(jobs.storage_value(output, True), expected)
        for output in (b'', b'private error', b'Snapshots for disk:\nprivate-name'):
            with self.assertRaises(ValueError):
                jobs.storage_value(output, True)

    def test_busy_or_already_slow_run_launches_no_probe(self):
        with (jobs.state_path('disk').parent/'disk-space-probes.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(subprocess, 'Popen') as popen:
                result = jobs.storage_probes(('/', '/Volumes/ExternalSSD'), time.monotonic(), popen)
                popen.assert_not_called()
                self.assertEqual(result['internalPurgeableError'], 'busy')
        with patch.object(subprocess, 'Popen') as popen:
            jobs.storage_probes(('/', '/Volumes/ExternalSSD'), time.monotonic()-9, popen)
            popen.assert_not_called()
        self.assertEqual(len(self.rows('disk.probe_slow')), 1)

    def test_surviving_child_retains_lock_and_prevents_another_batch(self):
        children = []
        clock = [time.monotonic()]
        def popen(command, **kwargs):
            child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'], **kwargs)
            children.append(child)
            clock[0] += 5
            return child
        try:
            with patch.object(jobs.time, 'monotonic', side_effect=lambda: clock[0]), \
                 patch.object(jobs.os, 'killpg'):
                props = jobs.storage_probes(('/', '/Volumes/ExternalSSD'), clock[0], popen)
                self.assertEqual(props['internalPurgeableError'], 'timeout')
                with patch.object(subprocess, 'Popen') as no_spawn:
                    props = jobs.storage_probes(('/', '/Volumes/ExternalSSD'), clock[0], no_spawn)
                    no_spawn.assert_not_called()
                    self.assertEqual(props['internalPurgeableError'], 'busy')
        finally:
            for child in children:
                child.kill()
                child.wait(timeout=2)


class DiskSwingShellTests(unittest.TestCase):
    fixture = shell_jobs.ShellJobsTests.fixture
    rows = shell_jobs.ShellJobsTests.rows

    @unittest.skipUnless(shutil.which('zsh'), 'guard uses zsh')
    def test_fixture_guard_status_and_alerts_unchanged(self):
        for scenario in ('baseline', 'small', 'plus95', 'minus26', 'stale', 'malformed', 'timeout'):
            for alert in ('healthy', 'low', 'suppressed', 'notify-fails'):
                with self.subTest(scenario=scenario, alert=alert):
                    root, home, fake, logs, env = self.fixture()
                    watch = root/'watch'; watch.mkdir(); (watch/'tmp_kb').write_text('1')
                    helper = root/'helper'; helper.mkdir()
                    for name in ('toollog.py', 'toollog.sh', 'jobs.py'):
                        text = (HERE/name).read_text()
                        for command in ('/usr/sbin/diskutil', '/usr/bin/tmutil'):
                            text = text.replace(command, str(fake/Path(command).name))
                        text = text.replace("'/System/Volumes/Data', '/Volumes/ExternalSSD'", repr(str(root))+', '+repr(str(root)))
                        text = text.replace('st = os.statvfs(volume)', "st = type('Fixture', (), {'f_bavail': 700*1024**3, 'f_frsize': 1})()")
                        (helper/name).write_text(text)
                    for name in ('diskutil', 'tmutil'):
                        command = fake/name
                        command.write_text('#!'+sys.executable+'\nimport time,sys,plistlib\n'+
                            ('time.sleep(20)\n' if scenario == 'timeout' else '')+
                            ('sys.stdout.buffer.write(plistlib.dumps({"PurgeableSpace":1073741824}))\n' if name == 'diskutil'
                             else 'print("Snapshots for private-volume-name:")\n'))
                        command.chmod(0o755)
                    state = logs/'state'; state.mkdir(parents=True)
                    free = 700
                    delta = {'small': 1, 'plus95': 95, 'minus26': -26}.get(scenario, 0)
                    previous = dict(free={'internalFreeGb': free-delta, 'externalFreeGb': free-delta},
                                    ts='2026-11-13T12:00:00.000Z', sizes={})
                    if scenario != 'baseline':
                        (state/'disk.json').write_text('{bad' if scenario == 'malformed' else json.dumps(previous))
                    (state/'disk-inventory.json').write_text(json.dumps(dict(at=time.time()-(8000 if scenario == 'stale' else 0),sizes={})))
                    env.update(MAC_LOG_HOME=str(helper), WATCH_DIR=str(watch),
                               FREE_MIN_GB='100' if alert == 'healthy' else '900',
                               NOTIFY_TEST_RC='1' if alert == 'notify-fails' else '0')
                    if alert == 'suppressed':
                        (watch/'last_fire').write_text(str(int(time.time())))
                    text = (shell_jobs.REPO/'integrations/robob-watch/watchers/disk-space-guard/check.sh').read_text()
                    for command in ('/bin/df', '/usr/bin/getconf', '/usr/bin/stat', '/Users/ardud/.bun/bin/bun'):
                        text = text.replace(command, str(fake/Path(command).name))
                    script = root/'run.zsh'; script.write_text(text)
                    started = time.monotonic()
                    result = subprocess.run(['zsh', str(script)], env=env, capture_output=True, text=True, timeout=8)
                    elapsed = time.monotonic()-started
                    self.assertEqual(result.returncode, int(alert == 'notify-fails'), result.stderr)
                    rows = self.rows(logs)
                    samples = [r for r in rows if r['name'] == 'disk.sample']
                    self.assertEqual(len(samples), 1)
                    self.assertTrue(samples[0]['ok'])
                    self.assertEqual(len([r for r in rows if r['name'] == 'disk.alert']), int(alert in ('low', 'notify-fails')))
                    self.assertEqual(len([r for r in rows if r['name'] == 'disk.swing']), int(scenario in ('plus95', 'minus26')))
                    if scenario == 'timeout':
                        self.assertLess(elapsed, 6)
                        self.assertNotIn('internalPurgeableGb', samples[0]['props'])
                        self.assertNotIn('internalLocalSnapshotCount', samples[0]['props'])
                        self.assertEqual(samples[0]['props']['internalPurgeableError'], 'timeout')
                        self.assertEqual(len([r for r in rows if r['name'] == 'disk.probe_slow']), 1)
                    self.assertNotIn('private-volume-name', json.dumps(rows))


if __name__ == '__main__':
    unittest.main()
