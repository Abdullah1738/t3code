import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import datetime as dt
import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))
import toollog as log


class ToolLogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'health'
        self.env = mock.patch.dict(os.environ, HEALTH_TOOLLOG_DIR=str(self.root))
        self.env.start()
        self.addCleanup(self.env.stop)
        self.config = Path(self.temp.name) / 'expected.json'
        config_patch = mock.patch.object(log, 'EXPECTED_PATH', self.config)
        config_patch.start()
        self.addCleanup(config_patch.stop)

    def tearDown(self):
        destination = os.environ.get('HEALTH_TOOLLOG_SAMPLES')
        if destination:
            with open(destination, 'a') as fh:
                for row in self.rows():
                    fh.write(json.dumps(row) + '\n')

    def rows(self):
        rows = []
        for path in self.root.glob('*.ndjson'):
            for line in path.read_text().splitlines():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass  # The rollup test deliberately leaves a truncated line.
        return rows

    def test_format_and_permissions(self):
        with log.run('food', ['today', '--note', 'private']):
            pass
        row, = self.rows()
        self.assertEqual(row['tool'], 'health')
        self.assertRegex(row['ts'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
        self.assertEqual(row['props'], {'command': 'food', 'subcommand': 'today'})
        self.assertTrue(row['ok'])
        self.assertGreaterEqual(row['durationMs'], 0)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(next(self.root.glob('*.ndjson')).stat().st_mode), 0o600)

    def test_chrome_errors_are_classified_without_output(self):
        import subprocess
        self.assertEqual(log.error_tag(subprocess.CalledProcessError(1, ['/x/chrome-headless-shell', 'private']), True), 'headless_chrome')
        self.assertEqual(log.error_tag(subprocess.TimeoutExpired(['chromium'], 1), True), 'headless_chrome')
        self.assertEqual(log.error_tag(subprocess.CalledProcessError(1, ['rsvg-convert']), True), 'renderer_failed')

    def test_private_values_never_reach_logs_or_rollups(self):
        secret = 'Testosterone 31337.456mg 98765.432kg PurpleDragonFixtureFood token-cookie-otp'
        with self.assertRaises(RuntimeError):
            with log.run('food', ['quick', secret]):
                raise RuntimeError(secret)
        log.emit('food', 'cli.run', props={'command': secret, 'subcommand': secret, 'food': secret,
                 'dose': secret, 'weight': secret, 'kcal': 87654321}, tag=secret, run_id=secret)
        log.emit('whoop-sync', 'sync.run', props={'trigger': secret})
        log.conflicts([(secret, 1)])
        log.rollup(log.utcnow().date().isoformat())
        raw = ''.join(p.read_text() for p in self.root.iterdir() if p.suffix in ('.json', '.ndjson'))
        for banned in secret.split():
            self.assertNotIn(banned, raw)

    def test_failures_never_raise_or_hide_tool_error(self):
        for target in ['mkdir', 'chmod']:
            with mock.patch.object(Path, target, side_effect=OSError('private')):
                log.emit('hlog', 'cli.run')
                self.assertIsNone(log.rollup())
        for target in ['open', 'write', 'fchmod', 'close']:
            with mock.patch.object(os, target, side_effect=OSError('private')):
                with log.run('food', ['today']):
                    pass
        with mock.patch.object(log.time, 'monotonic', side_effect=RuntimeError()):
            with self.assertRaisesRegex(ValueError, 'original'):
                with log.run('food', ['today']):
                    raise ValueError('original')
        log.emit('food', 'cli.run', props=object())
        log.emit('food', 'cli.run', duration_ms=float('nan'))
        self.assertIsNone(log.rollup('../../bad'))

    def test_retention_keeps_boundary_and_unrelated_files(self):
        self.root.mkdir()
        today = log.utcnow().date()
        for ago in [30, 31]:
            day = str(today - dt.timedelta(days=ago))
            for n in [day + '.ndjson', 'rollup-' + day + '.json', '.cap-' + day]:
                (self.root / n).touch()
        (self.root / 'unrelated.txt').touch()
        log.emit('hlog', 'cli.run')
        self.assertFalse((self.root / (str(today - dt.timedelta(days=31)) + '.ndjson')).exists())
        self.assertTrue((self.root / (str(today - dt.timedelta(days=30)) + '.ndjson')).exists())
        self.assertTrue((self.root / 'unrelated.txt').exists())

    def test_cap_survives_new_process_module_and_preserves_errors(self):
        with mock.patch.object(log, 'CAP_BYTES', 1):
            log.emit('hlog', 'cli.run')
            for _ in range(3):
                log.emit('hlog', 'cli.run')
            log.emit('hlog', 'cli.run', 'error', ok=False, tag='io_error')
            rows = self.rows()
            self.assertEqual(sum(r['name'] == 'log.cap' for r in rows), 1)
            self.assertEqual(len(rows), 3)
            self.assertEqual(rows[-1]['kind'], 'error')

    def test_nonblocking_lock_and_latency(self):
        import fcntl
        log.emit('hlog', 'cli.run')
        with next(self.root.glob('*.ndjson')).open() as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            log.emit('hlog', 'cli.run')
        self.assertEqual(len(self.rows()), 1)
        samples = []
        for _ in range(100):
            start = time.monotonic()
            log.emit('hlog', 'cli.run')
            samples.append((time.monotonic() - start) * 1000)
        self.assertLess(sorted(samples)[94], 20)  # Allows CI/filesystem jitter, never tool work.

    def test_rollup_counts_percentiles_and_bad_line(self):
        for value in range(1, 101):
            log.emit('food', 'cli.run', 'perf', value, value != 100,
                     tag='io_error' if value == 100 else None, run_id='a' * 32)
        with next(self.root.glob('*.ndjson')).open('a') as fh:
            fh.write('{partial\n')
        result = log.rollup(log.utcnow().date().isoformat())
        self.assertEqual(result['countsByName'], {'cli.run': 100})
        self.assertEqual(result['countsByKind'], {'perf': 100})
        self.assertEqual(result['okRate'], .99)
        self.assertEqual(result['errorRate'], .01)
        self.assertEqual(result['durationMs']['cli.run'], {'p50': 50, 'p95': 95, 'max': 100})
        self.assertEqual(result['topErrors'], [{'tag': 'io_error', 'count': 1, 'sampleId': 'a' * 32,
                                              'exceptionClass': None, 'exitCode': None, 'reason': None, 'rejected': []}])
        self.assertEqual(result['malformedCount'], 1)
        self.assertEqual(stat.S_IMODE(next(self.root.glob('rollup-*.json')).stat().st_mode), 0o600)

    def test_nag_outcome_schema_and_daily_rollup(self):
        now = dt.datetime(2026, 11, 13, 20, 1, tzinfo=dt.timezone.utc)
        with mock.patch.object(log, 'utcnow', return_value=now):
            for latency in range(1, 101):
                log.emit('took', 'nag.resolved', props={'slotKind': 'morning', 'nagCount': 3,
                    'firstNagToTookSeconds': latency, 'snoozeCount': 1, 'lateMinutes': 5,
                    'med': 'PRIVATE_MED', 'dose': 'PRIVATE_DOSE', 'site': 'PRIVATE_SITE'}, run_id='a' * 32)
            log.emit('meds-nag', 'nag.day_end', props={
                'slotsDue': 5, 'slotsTaken': 3, 'slotsOpen': 2, 'nagsSent': 4})
            log.emit('took', 'nag.resolved', props={'slotKind': 'PRIVATE_MED',
                'nagCount': True, 'firstNagToTookSeconds': -1, 'snoozeCount': '3', 'lateMinutes': 1.5})
            result = log.rollup('2026-11-13')
        self.assertEqual(result['nag'], {'firstNagToTookSeconds': {
            'median': 50.5, 'p95': 95, 'samples': 100}, 'openSlotsByDay': {'2026-11-13': 2}})
        raw = ''.join(p.read_text() for p in self.root.iterdir())
        for secret in ('PRIVATE_MED', 'PRIVATE_DOSE', 'PRIVATE_SITE'):
            self.assertNotIn(secret, raw)
        self.assertNotIn('props', self.rows()[-1])

    def fixture_rollup(self, rows, expected=None, now=None):
        self.root.mkdir(exist_ok=True)
        (self.root / '2026-11-13.ndjson').write_text(''.join(json.dumps(row) + '\n' for row in rows))
        if expected is not None:
            self.config.write_text(json.dumps({'expected': expected}))
        now = now or dt.datetime(2026, 11, 14, tzinfo=dt.timezone.utc)
        with mock.patch.object(log, 'utcnow', return_value=now):
            result = log.rollup('2026-11-13')
        self.assertIsNotNone(result)
        return result

    def run_row(self, seconds, component='meds-nag', name='watcher.run', kind='perf'):
        stamp = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=seconds)
        return {'ts': stamp.isoformat(), 'tool': 'health', 'component': component, 'kind': kind, 'name': name}

    def test_trigger_enum_and_missing_emitters(self):
        values = ['schedule', 'manual', 'chained', 'retry', 'unknown', None, '',
                  'PRIVATE_HEALTH_VALUE', [], {}, True, 123]
        for value in values:
            expected = value if isinstance(value, str) and value in log.TRIGGERS else 'unknown'
            for name in ('watcher.run', 'sync.run'):
                with self.subTest(value=value, name=name):
                    with log.Span('whoop-sync', name, trigger=value):
                        pass
                    self.assertEqual(self.rows()[-1]['props']['trigger'], expected)
                    log.emit('whoop-sync', name, props={'trigger': value})
                    self.assertEqual(self.rows()[-1]['props']['trigger'], expected)
        with log.run('meds-nag', name='watcher.run'):
            pass
        self.assertEqual(self.rows()[-1]['props']['trigger'], 'unknown')
        for value in values:
            if isinstance(value, str):
                with mock.patch.dict(os.environ, HEALTH_TOOLLOG_TRIGGER=value):
                    self.assertEqual(log.trigger(), value if value in log.TRIGGERS else 'unknown')
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(log.trigger(), 'manual')

    def tagged(self, seconds, trigger, component='whoop-sync'):
        row = self.run_row(seconds, component, 'sync.run' if component == 'whoop-sync' else 'watcher.run')
        row['props'] = {'trigger': trigger}
        return row

    def test_hourly_schedule_with_chained_ten_minute_syncs(self):
        schedule = [self.tagged(t, 'schedule') for t in range(0, 86400, 3600)]
        chained = [self.tagged(t + 30, 'chained') for t in range(0, 86400, 600)]
        summary = self.fixture_rollup(schedule + chained, {'whoop-sync': 3600})['components']['whoop-sync']
        self.assertEqual(summary['runs'], 168)
        self.assertEqual(summary['runsByTrigger'], {'schedule': 24, 'chained': 144})
        self.assertEqual((summary['expectedRuns'], summary['missedRuns']), (24, 0))
        self.assertEqual((summary['medianGapSeconds'], summary['maxGapSeconds'], summary['gapsOver']), (3600, 3600, []))
        # Three missing hourly ticks leave four hours between successful ticks.
        hole = [r for r in schedule if r['ts'][11:13] not in ('02', '03', '04')]
        result = self.fixture_rollup(hole + chained, {'whoop-sync': 3600})['components']['whoop-sync']
        self.assertEqual(result['missedRuns'], 3)
        self.assertEqual(result['maxGapSeconds'], 14400)
        self.assertEqual(result['gapsOver'], [{'startTs': '2026-11-13T01:00:00Z', 'seconds': 14400}])
        exact = [r for r in schedule if r['ts'][11:13] not in ('02', '03')]
        self.assertEqual(self.fixture_rollup(exact + chained, {'whoop-sync': 3600})['components']['whoop-sync']['gapsOver'], [])

    def test_schedule_selection_partial_upgrade_and_no_schedule(self):
        rows = [self.tagged(0, 'schedule', 'meds-nag'), self.tagged(300, 'manual', 'meds-nag'),
                self.tagged(600, 'chained', 'meds-nag'), self.tagged(900, 'retry', 'meds-nag'),
                self.tagged(1200, 'PRIVATE_HEALTH_VALUE', 'meds-nag'), self.run_row(1500)]
        rows += [self.run_row(t, 'gym-nudge') for t in (0, 300, 600)]
        result = self.fixture_rollup(rows, {'meds-nag': 300, 'gym-nudge': 300})
        meds = result['components']['meds-nag']
        self.assertEqual(meds['runsByTrigger'], {'schedule': 1, 'manual': 1, 'chained': 1, 'retry': 1, 'unknown': 2})
        self.assertEqual((meds['runs'], meds['missedRuns'], meds['medianGapSeconds']), (6, 287, None))
        self.assertEqual(result['components']['gym-nudge']['missedRuns'], 285)
        self.assertNotIn('PRIVATE_HEALTH_VALUE', json.dumps(result))
        for trigger in ('chained', 'manual', 'unknown', 'PRIVATE_HEALTH_VALUE'):
            with self.subTest(trigger=trigger):
                summary = self.fixture_rollup([self.tagged(300, trigger)], {'whoop-sync': 3600})['components']['whoop-sync']
                self.assertEqual((summary['runs'], summary['missedRuns'], summary['maxGapSeconds']), (1, 24, 86400))
                self.assertEqual(summary['gapsOver'], [{'startTs': '2026-11-13T00:00:00Z', 'seconds': 86400}])

    def test_legacy_mixed_cadence_uses_configured_threshold(self):
        rows = [self.run_row(t, 'whoop-sync', 'sync.run') for t in range(0, 43200, 600)]
        rows += [self.run_row(t, 'whoop-sync', 'sync.run') for t in range(43200, 86400, 3600)]
        summary = self.fixture_rollup(rows, {'whoop-sync': 3600})['components']['whoop-sync']
        self.assertEqual(summary['runsByTrigger'], {'unknown': 84})
        self.assertEqual((summary['expectedRuns'], summary['missedRuns'], summary['medianGapSeconds']), (24, 0, 600))
        self.assertEqual(summary['gapsOver'], [])

    def test_cadence_and_nag_rollups_coexist_for_all_day_shapes(self):
        intervals = {'meds-nag': 300, 'gym-nudge': 300, 'nutrition-nudge': 300,
                     'nutrition-checkin': 300, 'whoop-sync': 3600, 'forge-workouts': 600}
        config = Path(self.temp.name) / 'expected.json'
        config.write_text(json.dumps({'expected': intervals}))
        start = dt.datetime(2026, 11, 13, tzinfo=dt.timezone.utc)
        def row(seconds, component, name, props=None):
            return {'ts': (start + dt.timedelta(seconds=seconds)).isoformat(), 'tool': 'health',
                    'component': component, 'kind': 'event', 'name': name, 'props': props or {}}
        outcomes = [row(72010, 'took', 'nag.resolved', {'firstNagToTookSeconds': value})
                    for value in (30, 90)]
        outcomes.append(row(72060, 'meds-nag', 'nag.day_end',
                            {'slotsDue': 3, 'slotsTaken': 1, 'slotsOpen': 2, 'nagsSent': 4}))
        hole = [row(t, 'meds-nag', 'watcher.run') for t in range(0, 86400, 300)
                if not 3600 < t < 14400]
        steady = [row(t, 'gym-nudge', 'watcher.run') for t in range(0, 86400, 300)]
        scenarios = [('hole_and_steady', hole + steady + outcomes, 86400),
                     ('single_run', [row(43200, 'meds-nag', 'watcher.run')] + outcomes, 86400),
                     ('empty', [], 86400), ('absent', None, 86400),
                     ('current_day', [row(0, 'meds-nag', 'watcher.run')], 3600)]
        for name, rows, elapsed in scenarios:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / 'logs'
                if rows is not None:
                    root.mkdir()
                    (root / '2026-11-13.ndjson').write_text(
                        ''.join(json.dumps(value) + '\n' for value in rows))
                with mock.patch.object(log, 'EXPECTED_PATH', config), \
                     mock.patch.object(log, 'utcnow', return_value=start + dt.timedelta(seconds=elapsed)), \
                     mock.patch.dict(os.environ, HEALTH_TOOLLOG_DIR=str(root)):
                    result = log.rollup('2026-11-13')
                self.assertIsNotNone(result)
                components = result['components']
                self.assertEqual(set(components), set(intervals))
                for component, interval in intervals.items():
                    summary = components[component]
                    self.assertEqual(set(summary), {'runs', 'firstRunTs', 'lastRunTs',
                        'medianGapSeconds', 'maxGapSeconds', 'gapsOver', 'expectedRuns', 'missedRuns', 'runsByTrigger'})
                    self.assertEqual(summary['expectedRuns'], elapsed // interval)
                    self.assertEqual(summary['missedRuns'], max(0, elapsed // interval - summary['runs']))
                if name == 'hole_and_steady':
                    self.assertEqual(components['meds-nag'], {'runs': 253,
                        'firstRunTs': '2026-11-13T00:00:00Z', 'lastRunTs': '2026-11-13T23:55:00Z',
                        'medianGapSeconds': 300, 'maxGapSeconds': 10800,
                        'gapsOver': [{'startTs': '2026-11-13T01:00:00Z', 'seconds': 10800}],
                        'expectedRuns': 288, 'missedRuns': 35, 'runsByTrigger': {'unknown': 253}})
                    self.assertEqual((components['gym-nudge']['runs'], components['gym-nudge']['gapsOver']), (288, []))
                elif name == 'single_run':
                    self.assertEqual((components['meds-nag']['runs'], components['meds-nag']['maxGapSeconds'],
                                      components['meds-nag']['medianGapSeconds']), (1, 43200, None))
                elif name in ('empty', 'absent'):
                    self.assertEqual(result['total'], 0)
                    self.assertTrue(all(value['maxGapSeconds'] == 86400 for value in components.values()))
                if name in ('hole_and_steady', 'single_run'):
                    self.assertEqual(result['nag'], {'firstNagToTookSeconds': {
                        'median': 60.0, 'p95': 90, 'samples': 2}, 'openSlotsByDay': {'2026-11-13': 2}})
                else:
                    self.assertEqual(result['nag'], {'firstNagToTookSeconds': {
                        'median': None, 'p95': None, 'samples': 0}, 'openSlotsByDay': {}})
                for component in set(intervals) - {'meds-nag', 'gym-nudge'}:
                    self.assertEqual(components[component]['runs'], 0)
                    self.assertEqual(components[component]['maxGapSeconds'], elapsed)
                self.assertTrue((root / 'rollup-2026-11-13.json').exists())

    def test_nag_rollup_without_outcomes(self):
        log.emit('took', 'cli.run')
        result = log.rollup(log.utcnow().date().isoformat())
        self.assertEqual(result['nag'], {'firstNagToTookSeconds': {
            'median': None, 'p95': None, 'samples': 0}, 'openSlotsByDay': {}})

    def test_rollup_after_0005_only_once_and_gap(self):
        now = dt.datetime(2026, 11, 13, 0, 4, tzinfo=dt.timezone.utc)
        with mock.patch.object(log, 'utcnow', return_value=now), mock.patch.object(log, 'rollup') as roll:
            log.rollup_previous()
            roll.assert_not_called()
        with mock.patch.object(log, 'utcnow', return_value=now.replace(minute=5)), mock.patch.object(log, 'rollup') as roll:
            log.rollup_previous()
            roll.assert_called_once_with('2026-11-12')
            self.root.mkdir()
            (self.root / 'rollup-2026-11-12.json').touch()
            log.rollup_previous()
            roll.assert_called_once()
        log.sync_gap((log.utcnow() - dt.timedelta(hours=37)).isoformat())
        log.sync_gap(log.utcnow().isoformat())
        self.assertEqual([r['name'] for r in self.rows()], ['sync.gap'])



class IsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.live = self.home / '.robob/logs/tools/health'
        self.live.mkdir(parents=True)
        self.day = log.utcnow().date().isoformat()
        (self.live / (self.day + '.ndjson')).write_text('{}\n')
        self.before = self.snapshot()

    def snapshot(self):
        return {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in self.live.iterdir()}

    def test_each_marker_drops_all_write_paths_without_override(self):
        for marker in ('HEALTH_VAULT_TEST_COPY', 'PYTEST_CURRENT_TEST', 'unittest'):
            for value in ('1', ''):
                with self.subTest(marker=marker, value=value), mock.patch.dict(os.environ, {'HOME': str(self.home)}, clear=True):
                    # unittest is already loaded; remove it to prove each env marker independently.
                    modules = dict(sys.modules)
                    if marker != 'unittest':
                        modules.pop('unittest', None)
                        os.environ[marker] = value
                    with mock.patch.dict(sys.modules, modules, clear=True):
                        self.assertIsNone(log.log_dir())
                        with log.run('food', ['today']):
                            pass
                        log.emit('food', 'cli.run')
                        log.conflicts([('other', 1)])
                        log.delivery('card', 'a' * 32)
                        log.sync_gap(None)
                        self.assertIsNone(log.rollup(self.day))
                        log.rollup_previous()
                    self.assertEqual(self.snapshot(), self.before)

    def test_explicit_override_writes_under_all_markers(self):
        target = self.home / 'isolated'
        with mock.patch.dict(os.environ, {'HOME': str(self.home), 'HEALTH_TOOLLOG_DIR': str(target),
                         'HEALTH_VAULT_TEST_COPY': '', 'PYTEST_CURRENT_TEST': ''}, clear=True):
            log.emit('food', 'cli.run')
            self.assertIsNotNone(log.rollup(self.day))
        self.assertEqual(len(list(target.glob('*.ndjson'))), 1)
        self.assertEqual(self.snapshot(), self.before)

    def test_empty_override_does_not_enable_live_writes(self):
        with mock.patch.dict(os.environ, {'HOME': str(self.home), 'HEALTH_TOOLLOG_DIR': ''}, clear=True):
            log.emit('food', 'cli.run')
            self.assertIsNone(log.rollup(self.day))
        self.assertEqual(self.snapshot(), self.before)

    def test_production_fallback_in_fresh_process(self):
        import subprocess
        code = ('import sys, runpy; from pathlib import Path; '
                'm = runpy.run_path(sys.argv[1]); '
                'assert "unittest" not in sys.modules; '
                'assert m["log_dir"]() == Path.home()/".robob/logs/tools/health"; '
                'm["emit"]("food", "cli.run"); '
                'assert m["rollup"](sys.argv[2]) is not None')
        result = subprocess.run([sys.executable, '-I', '-c', code, str(log.__file__), self.day],
                                env={'HOME': str(self.home)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(self.snapshot(), self.before)
        self.assertIn('rollup-' + self.day + '.json', self.snapshot())

    def test_guard_failures_still_never_raise_or_hide_original_error(self):
        with mock.patch.object(log, 'log_dir', side_effect=RuntimeError('guard failure')):
            log.emit('food', 'cli.run')
            self.assertIsNone(log.rollup())
            log.rollup_previous()
            with self.assertRaisesRegex(ValueError, 'tool failure'):
                with log.run('food'):
                    raise ValueError('tool failure')


class ReasonRollupTests(unittest.TestCase):
    setUp = ToolLogTests.setUp
    tearDown = ToolLogTests.tearDown
    rows = ToolLogTests.rows
    def test_reason_allowlist_and_types(self):
        for reason in log.FOOD_EXIT_REASONS:
            log.emit('food', 'cli.run', props={'reason': reason, 'candidateCount': 2, 'queryLen': 9})
            self.assertEqual(self.rows()[-1]['props'], {'reason': reason, 'candidateCount': 2, 'queryLen': 9})
        for value in ('PrivateValueToken', True, [], {'private': 'text'}):
            log.emit('food', 'cli.run', props={'reason': value, 'candidateCount': value, 'queryLen': value})
            self.assertNotIn('props', self.rows()[-1])
        self.assertNotIn('PrivateValueToken', json.dumps(self.rows()))

    def test_rollup_groups_reason_and_includes_legacy_null(self):
        for reason in ('food_not_found', 'food_ambiguous', 'PrivateValueToken'):
            with self.assertRaises(SystemExit):
                with log.run('food', ['log']) as span:
                    span.props['reason'] = reason
                    raise SystemExit(2)
        result = log.rollup(log.utcnow().date().isoformat())
        self.assertEqual({r['reason'] for r in result['topErrors']}, {'food_not_found', 'food_ambiguous', None})
        self.assertNotIn('PrivateValueToken', json.dumps(result))

    def test_delivery_unmarked_exact_definition(self):
        log.emit('cards', 'card.render', props={'kind': 'nutrition'}, run_id='a' * 32, ok=True)
        log.emit('cards', 'card.render', props={'kind': 'nutrition'}, run_id='b' * 32, ok=False)
        log.emit('food', 'food.warning', props={'warning': 'unverified', 'count': 5}, run_id='a' * 32)
        log.emit('food', 'food.warning', props={'warning': 'no_time', 'count': 1}, run_id='a' * 32)
        log.emit('meds-nag', 'nag.sent', props={'count': 3}, run_id='c' * 32)
        for _ in range(2):
            log.emit('cards', 'card.render', props={'kind': 'nutrition'})
        log.delivery('card', 'a' * 32)
        log.delivery('nag', 'c' * 32, ok=False)
        log.delivery('nag', 'c' * 32, ok=True)
        log.delivery('warning', 'd' * 32, ok=False)
        delivery = log.rollup(log.utcnow().date().isoformat())['delivery']
        self.assertEqual({k: v for k, v in delivery.items() if k != 'unmarkedMeaning'},
                         {'sent': 2, 'failed': 1, 'unmarked': 4, 'autoReceipts': 0, 'manualReceipts': 3})
        self.assertEqual(delivery['unmarkedMeaning'], log.UNMARKED_MEANING)
        self.assertIn('including failed renders', delivery['unmarkedMeaning'])
        self.assertIn('UTC day file', delivery['unmarkedMeaning'])




class ArgumentDiagnosticsTests(unittest.TestCase):
    setUp = ToolLogTests.setUp
    rows = ToolLogTests.rows

    def test_shared_parser_matrix_keeps_values_private(self):
        import argparse
        cases = [
            (['unknown-command'], 'unknown_subcommand', ['unknown-command']),
            (['PrivateValueToken'], 'unknown_subcommand', ['<redacted>']),
            (['two words'], 'unknown_subcommand', ['<redacted>']),
            (['a' * 32], 'unknown_subcommand', ['<redacted>']),
            (['known', '--bogus=PrivateValueToken'], 'bad_arguments', ['--bogus']),
            (['known', '-z'], 'bad_arguments', ['<redacted>']),
            (['known', '--number'], 'missing_required', ['--number']),
            (['known', '--number', 'PrivateValueToken'], 'bad_value', ['--number']),
            (['known', '--choice', 'PrivateValueToken'], 'bad_value', ['--choice']),
            (['known', '--note=--PrivateValueToken', '--number', 'bad'], 'bad_value', ['--number']),
            (['known', 'PrivateValueToken'], 'bad_arguments', ['<redacted>']),
            (['known', '--', '--PrivateValueToken'], 'bad_arguments', ['<redacted>']),
            ([], 'missing_required', []),
        ]
        for args, reason, rejected in cases:
            with self.subTest(args=args), self.assertRaises(SystemExit) as caught:
                with log.run('food', args) as span:
                    parser = log.LoggedArgumentParser(log_span=span, prog='fixture')
                    sub = parser.add_subparsers(dest='cmd', required=True)
                    known = sub.add_parser('known')
                    known.add_argument('--number', type=int)
                    known.add_argument('--choice', choices=['one', 'two'])
                    known.add_argument('--note')
                    with contextlib.redirect_stderr(__import__('io').StringIO()):
                        parser.parse_args(args)
            self.assertEqual(caught.exception.code, 2)
            row = self.rows()[-1]
            self.assertEqual(row['props']['reason'], reason)
            self.assertEqual(row['props']['rejected'], rejected)
            self.assertEqual(row['props']['argc'], len(args))
            self.assertNotIn('PrivateValueToken', json.dumps(row))

    def test_required_group_and_conflicting_options(self):
        for args, required, reason, names in [([], True, 'missing_required', ['--first', '--second']),
                (['--first', '--second'], False, 'bad_arguments', ['--second'])]:
            with self.assertRaises(SystemExit), log.run('cards', args) as span:
                parser = log.LoggedArgumentParser(log_span=span)
                group = parser.add_mutually_exclusive_group(required=required)
                group.add_argument('--first', action='store_true')
                group.add_argument('--second', action='store_true')
                with contextlib.redirect_stderr(__import__('io').StringIO()):
                    parser.parse_args(args)
            row = self.rows()[-1]
            self.assertEqual(row['props']['reason'], reason)
            self.assertEqual(row['props']['rejected'], names)

    def test_rejected_schema_and_top_three_grouped_by_tag_reason(self):
        entries = [('SystemExit', 2, ['--one=PrivateValueToken', '--two', '--three', '--four']),
                   ('ValueError', 1, ['--one', '--two']), ('SystemExit', 2, ['--one'])]
        for cls, code, names in entries:
            log.emit('food', 'cli.run', 'error', ok=False, tag='invalid_arguments',
                     props={'command': 'food', 'subcommand': 'log', 'reason': 'bad_arguments',
                            'exceptionClass': cls, 'exitCode': code, 'rejected': names, 'argc': 4})
        log.emit('food', 'cli.run', 'error', ok=False, tag='invalid_arguments',
                 props={'reason': 'unknown_subcommand', 'rejected': ['valid-token', 'PrivateValueToken']})
        result = log.rollup(log.utcnow().date().isoformat())
        first, second = result['topErrors']
        self.assertEqual(first['count'], 3)
        self.assertEqual(first['reason'], 'bad_arguments')
        self.assertIsNone(first['exceptionClass'])
        self.assertIsNone(first['exitCode'])
        self.assertEqual(first['rejected'], [{'name': '--one', 'count': 3}, {'name': '--two', 'count': 2},
                                            {'name': '--four', 'count': 1}])
        self.assertEqual(second['rejected'], [{'name': '<redacted>', 'count': 1}, {'name': 'valid-token', 'count': 1}])
        self.assertNotIn('PrivateValueToken', json.dumps(self.rows()) + json.dumps(result))
        log.emit('food', 'cli.run', props={'reason': 'private', 'rejected': ['private'], 'argc': True})
        self.assertEqual(self.rows()[-1]['props'], {'rejected': ['<redacted>']})

    def test_repeat_burst_windows(self):
        for seconds, expected in [([0, .1, .2, .4, 1], 1), ([0, 2, 5], 1),
                                  ([0, 2, 5.001], 0), ([0, 4, 6, 8], 1),
                                  ([0, 1, 2, 6, 7, 8], 2), ([0, 1], 0),
                                  ([0, 6, 12], 0)]:
            stamps = [dt.datetime(2030, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=x) for x in seconds]
            self.assertEqual(log._repeat_bursts(list(reversed(stamps))), expected, seconds)
        day = log.utcnow().date()
        stamp = dt.datetime.combine(day, dt.time(1), tzinfo=dt.timezone.utc)
        for second in [1, .4, .2, 0, .1]:
            log.emit('food', 'cli.run', 'error', ok=False, tag='invalid_arguments',
                     props={'command': 'food', 'subcommand': 'meals-count', 'reason': 'bad_arguments'},
                     _now=stamp + dt.timedelta(seconds=second))
        for command, sub, reason in [('food', 'log', 'bad_arguments'), ('whoop', 'meals-count', 'bad_arguments'),
                                     ('food', 'meals-count', 'missing_required')]:
            for _ in range(2):
                log.emit(command, 'cli.run', 'error', ok=False, tag='invalid_arguments',
                         props={'command': command, 'subcommand': sub, 'reason': reason}, _now=stamp)
        self.assertEqual(log.rollup(day.isoformat())['repeatBurst'], 1)



if __name__ == '__main__':
    unittest.main()
