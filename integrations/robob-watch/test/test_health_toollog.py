import contextlib
import datetime as dt
import importlib.util
import json
import os
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
        self.assertEqual(result['topErrors'], [{'tag': 'io_error', 'count': 1, 'sampleId': 'a' * 32}])
        self.assertEqual(result['malformedCount'], 1)
        self.assertEqual(stat.S_IMODE(next(self.root.glob('rollup-*.json')).stat().st_mode), 0o600)

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


if __name__ == '__main__':
    unittest.main()
