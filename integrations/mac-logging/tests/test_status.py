import datetime as dt
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import collector
import status
import toollog
from rollup import rollup

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 11, 15, 12, tzinfo=UTC)


class StatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'logs'
        self.root.mkdir()
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root), PYTHONDONTWRITEBYTECODE='1')
        env.start()
        self.addCleanup(env.stop)

    def write(self, key, at=NOW, ok=True, **extra):
        cadence = status.CADENCES[key]
        row = dict(ts=status.stamp(at), tool='mac', name=cadence['name'],
                   kind='perf' if ok else 'error', ok=ok,
                   props={'target': cadence['target']} if cadence['target'] else {})
        row.update(extra)
        with (self.root / (at.date().isoformat() + '.ndjson')).open('a') as stream:
            stream.write(json.dumps(row) + '\n')

    def seed(self, overrides=None):
        for key in status.CADENCES:
            at = (overrides or {}).get(key, NOW - dt.timedelta(minutes=1 if key == 'cpu.sample' else 5))
            if at is not None:
                self.write(key, at)

    def report(self, now=NOW):
        return status.report(now, self.root)

    def test_every_job_on_cadence_and_last_outcome_is_independent(self):
        self.seed()
        self.write('disk.sample', NOW - dt.timedelta(minutes=1), False)
        result = self.report()
        self.assertEqual(result['missingJobs'], [])
        self.assertEqual({row['status'] for row in result['jobs'].values()}, {'OK'})
        row = result['jobs']['disk.sample']
        self.assertEqual(row['lastSeen'], '2026-11-15T11:59:00.000Z')
        self.assertFalse(row['lastOk'])
        self.assertEqual(row['lines'], 2)
        self.assertEqual(row['ageMin'], 1)

    def test_spikes_are_conditional_and_roll_up_highest_five(self):
        self.seed()
        self.assertNotIn('cpu.spike', self.report()['jobs'])
        self.assertNotIn('cpu.spike', self.report()['missingJobs'])
        daemon = 'com.apple.DriverKit-AppleBCMWLAN'
        for i in range(7):
            props = dict(load=[40+i, 30, 20], systemCpuPct=1200+i, unattributedCpuPct=400+i,
                         top=[dict(pid=1, family=daemon, cpuPct=10), dict(pid=2, family='Xcode', cpuPct=100),
                              dict(pid=3, family='Xcode', cpuPct=50), dict(pid=4, family='python', cpuPct=30),
                              dict(pid=5, family='git', cpuPct=5)],
                         spawnedFamilies=[dict(family='git', count=3), dict(family='clang', count=20),
                                          dict(family='python', count=5), dict(family='true', count=1)])
            row = dict(ts=status.stamp(NOW+dt.timedelta(minutes=i)), tool='mac', name='cpu.spike', kind='event', props=props)
            with (self.root/'2026-11-15.ndjson').open('a') as stream:
                stream.write(json.dumps(row)+'\n')
        daily = rollup('2026-11-15', self.root)
        summary = daily['cpuSpikes']
        self.assertEqual(summary['minutes'], 7)
        self.assertEqual([p['load1'] for p in summary['highestLoad']], [46, 45, 44, 43, 42])
        highest = summary['highestLoad'][0]
        self.assertEqual(highest['ts'], '2026-11-15T12:06:00.000Z')
        self.assertEqual((highest['systemCpuPct'], highest['unattributedCpuPct']), (1206, 406))
        self.assertEqual(highest['families'], [dict(family='Xcode', cpuPct=150), dict(family='python', cpuPct=30), dict(family=daemon, cpuPct=10)])
        self.assertEqual(highest['spawnedFamilies'], [dict(family='clang', count=20), dict(family='python', count=5), dict(family='git', count=3)])
        self.assertNotIn('cpu.spike', daily['missingJobs'])

    def test_one_late_job_others_fine(self):
        self.seed({'disk.sample': NOW - dt.timedelta(hours=6)})
        result = self.report()
        self.assertEqual(result['missingJobs'], ['disk.sample'])
        self.assertEqual(result['jobs']['disk.sample']['status'], 'LATE')
        self.assertEqual(result['jobs']['disk.sample']['ageMin'], 360)

    def test_silent_absent_and_older_than_36_hours(self):
        for at in (None, NOW - dt.timedelta(hours=37)):
            with self.subTest(at=at):
                root = self.root / str(at is None)
                root.mkdir()
                with patch.object(self, 'root', root):
                    self.seed({'backup.run:health': at})
                    result = self.report()
                self.assertEqual(result['missingJobs'], ['backup.run:health'])
                row = result['jobs']['backup.run:health']
                self.assertEqual(row['status'], 'SILENT')
                self.assertEqual(row['lines'], 0)

    def test_target_matching_and_timestamp_order(self):
        self.write('backup.run:health', NOW - dt.timedelta(hours=8))
        self.write('backup.run:memory')
        self.write('backup.run:health', NOW - dt.timedelta(hours=9))
        self.write('backup.run:health', NOW, props={'target': 'other'})
        row = self.report()['jobs']['backup.run:health']
        self.assertEqual(row['status'], 'LATE')
        self.assertEqual(row['ageMin'], 480)
        self.assertEqual(row['lines'], 2)

    def test_error_only_empty_and_missing_files(self):
        for key in status.CADENCES:
            self.write(key, ok=False)
        result = self.report()
        self.assertEqual(result['missingJobs'], [])
        self.assertTrue(all(row['lastOk'] is False for row in result['jobs'].values()))
        path = self.root / '2026-11-15.ndjson'
        path.write_text('')
        result = self.report()
        self.assertEqual(set(result['missingJobs']), set(status.CADENCES))
        self.assertEqual(result['missingFiles'], ['2026-11-14.ndjson'])
        path.unlink()
        result = self.report()
        self.assertEqual(result['missingFiles'], ['2026-11-14.ndjson', '2026-11-15.ndjson'])
        self.assertTrue(all(row['status'] == 'SILENT' for row in result['jobs'].values()))
        self.assertEqual(list(self.root.iterdir()), [])  # status never writes, even on missing inputs.

    def test_timestamp_forms(self):
        forms = ['2026-11-15T11:00:00Z', '2026-11-15T15:00:00+04:00',
                 '2026-11-15 07:00:00-0400', '2026-11-15T11:00:00.000+0000']
        for form in forms:
            with self.subTest(form=form):
                self.write('disk.sample', ts=form)
                self.assertEqual(self.report()['jobs']['disk.sample']['ageMin'], 60)
        # Malformed timestamps cannot masquerade as a recent run.
        bad = ['2026-11-15', '2026-11-15T11:00:00', 'nonsense', None, 17, [], {}]
        for value in bad:
            with self.subTest(value=value):
                with self.assertRaises((TypeError, ValueError)):
                    status.timestamp(value)

    def test_window_crosses_utc_dates_before_and_after_noon(self):
        # now, sweep timestamp, oldest UTC file needed for the 36-hour window
        cases = [
            ('2026-11-15T00:00:00Z', '2026-11-13T23:45:00Z', '2026-11-13'),
            ('2026-11-15T00:30:00Z', '2026-11-13T23:45:00Z', '2026-11-13'),
            ('2026-11-15T11:59:59Z', '2026-11-14T11:45:00Z', '2026-11-13'),
            ('2026-11-15T12:00:00Z', '2026-11-14T11:45:00Z', '2026-11-14'),
            ('2026-11-15T12:00:01Z', '2026-11-14T11:45:00Z', '2026-11-14'),
            ('2026-11-15T23:59:59Z', '2026-11-14T23:45:00Z', '2026-11-14'),
            ('2026-11-15T04:30:00+04:00', '2026-11-13T23:45:00Z', '2026-11-13'),
            ('2026-11-15T04:30:00+0400', '2026-11-13T23:45:00Z', '2026-11-13'),
            ('2026-11-15T00:30:00+04:00', '2026-11-13T19:45:00Z', '2026-11-13'),
            ('2026-12-01T00:30:00Z', '2026-11-29T23:45:00Z', '2026-11-29'),
            ('2027-01-01T00:30:00Z', '2026-12-30T23:45:00Z', '2026-12-30'),
            ('2028-03-01T00:30:00Z', '2028-02-28T23:45:00Z', '2028-02-28'),
        ]
        for index, (now_text, sweep_text, first_day) in enumerate(cases):
            with self.subTest(now=now_text):
                root = self.root / str(index)
                root.mkdir()
                now, sweep = status.timestamp(now_text), status.timestamp(sweep_text)
                with patch.object(self, 'root', root):
                    for key in status.CADENCES:
                        self.write(key, sweep if key == 'sweep.run' else now)
                    result = self.report(now_text)
                self.assertEqual(result['missingJobs'], [])
                row = result['jobs']['sweep.run']
                self.assertEqual(row['status'], 'OK')
                self.assertEqual(row['lastSeen'], status.stamp(sweep))
                self.assertEqual(row['ageMin'], round((now - sweep).total_seconds() / 60, 3))
                self.assertEqual(row['lines'], 1)
                first = dt.date.fromisoformat(first_day)
                dates = [first + dt.timedelta(days=i) for i in range((now.date() - first).days + 1)]
                self.assertEqual(result['missingFiles'], [date.isoformat() + '.ndjson' for date in dates
                                                         if not (root / (date.isoformat() + '.ndjson')).exists()])

    def test_early_morning_silence_boundary_in_third_file(self):
        now = status.timestamp('2026-11-15T00:30:00Z')
        for index, (age_hours, expected) in enumerate([(26, 'OK'), (27, 'LATE'),
                                                     (36, 'LATE'), (36.001, 'SILENT')]):
            with self.subTest(age_hours=age_hours):
                root = self.root / str(index)
                root.mkdir()
                at = now - dt.timedelta(hours=age_hours)
                with patch.object(self, 'root', root):
                    self.write('sweep.run', at)
                    result = self.report(now)
                row = result['jobs']['sweep.run']
                self.assertEqual(row['status'], expected)
                self.assertEqual(row['lastSeen'], status.stamp(at))
                self.assertEqual(row['lines'], 0 if expected == 'SILENT' else 1)

    def test_utc_conversion_overflow_skips_rows_and_preserves_jobs_and_rollup(self):
        # Local dates can parse successfully but overflow when converted to UTC.
        overflowing = [
            '0001-01-01T00:00:00+04:00', '0001-01-01T00:00:00+0400',
            '0001-01-01 00:00:00+2359',
            '9999-12-31T23:59:59-04:00', '9999-12-31T23:59:59-0400',
            '9999-12-31 23:59:59-2359',
        ]
        representable = ['0001-01-01T04:00:00+04:00', '0001-01-01T00:00:00Z',
                         '9999-12-31T19:59:59-04:00', '9999-12-31T23:59:59Z']
        for key in status.CADENCES:
            self.write(key, NOW.replace(hour=23, minute=59 if key == 'cpu.sample' else 45))
        end = NOW + dt.timedelta(hours=12)
        baseline = status.report(end, self.root, day=NOW.date())
        for index, value in enumerate(overflowing + representable):
            with self.subTest(timestamp=value):
                self.write('disk.sample', ts=value)
                result = status.report(end, self.root, day=NOW.date())
                self.assertNotIn('error', result)
                self.assertEqual(result['malformed'], min(index + 1, len(overflowing)))
                self.assertEqual(result['jobs'], baseline['jobs'])
                self.assertEqual(result['missingJobs'], [])
                daily = rollup('2026-11-15', self.root)
                self.assertEqual(daily['jobs'], baseline['jobs'])
                self.assertEqual(daily['missingJobs'], [])
                self.assertEqual(json.loads((self.root / 'rollup-2026-11-15.json').read_text())['jobs'], baseline['jobs'])

        cli = subprocess.run([sys.executable, str(HERE / 'status.py'), '--json',
                              '--now', '2026-11-15T23:59:00Z'], capture_output=True, text=True)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        result = json.loads(cli.stdout)
        self.assertEqual(result['malformed'], len(overflowing))
        self.assertEqual(set(result['jobs']), set(status.CADENCES))
        self.assertEqual(result['missingJobs'], [])

    def test_malformed_inputs_are_counted_and_skipped(self):
        self.seed()
        bad = ['{broken', 'null', '[]', '42', '"text"',
               json.dumps(dict(tool='mac', name='disk.sample', kind='perf', ts='bad'))]
        for changes in [dict(props=[]), dict(props=None), dict(ok='true'), dict(ts=0),
                        dict(name=[]), dict(kind='bad'), dict(tool='other')]:
            row = dict(tool='mac', name='disk.sample', kind='perf', ts=status.stamp(NOW))
            row.update(changes)
            bad.append(json.dumps(row))
        with (self.root / '2026-11-15.ndjson').open('ab') as stream:
            stream.write(('\n'.join(bad) + '\n').encode() + b'\xff\n')
        result = self.report()
        self.assertEqual(result['malformed'], len(bad) + 1)
        self.assertEqual(result['missingJobs'], [])
        self.assertTrue(all(row['lines'] == 1 for row in result['jobs'].values()))

    def test_gap_since_and_silence_boundaries(self):
        for hours, expected in [(2, 'OK'), (2.001, 'LATE'), (36, 'LATE'), (36.001, 'SILENT')]:
            with self.subTest(hours=hours):
                root = self.root / str(hours)
                root.mkdir()
                with patch.object(self, 'root', root):
                    self.write('disk.sample', NOW - dt.timedelta(hours=hours))
                    self.assertEqual(self.report()['jobs']['disk.sample']['status'], expected)
        since = dt.datetime(2026, 11, 13, tzinfo=UTC)
        self.assertEqual(self.report(since - dt.timedelta(seconds=1))['jobs']['disk.sample']['status'], 'PENDING')
        self.assertEqual(self.report(since + dt.timedelta(hours=2))['jobs']['disk.sample']['status'], 'OK')
        self.assertEqual(self.report(since + dt.timedelta(hours=2, seconds=1))['jobs']['disk.sample']['status'], 'SILENT')

    def test_future_events_are_not_last_seen(self):
        self.write('disk.sample', NOW + dt.timedelta(minutes=1))
        self.assertIsNone(self.report()['jobs']['disk.sample']['lastSeen'])

    def test_cli_frozen_json_text_and_failure_exit_zero(self):
        self.seed({'disk.sample': NOW - dt.timedelta(hours=6), 'backup.run:health': None})
        for args in (['--json'], []):
            result = subprocess.run([sys.executable, str(HERE / 'status.py'), '--now', status.stamp(NOW), *args],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            if args:
                report = json.loads(result.stdout)
                self.assertEqual(report['missingJobs'], ['disk.sample', 'backup.run:health'])
            else:
                self.assertIn('LATE', result.stdout)
                self.assertIn('SILENT', result.stdout)
        for args in (['--now', 'invalid', '--json'], ['--unknown'], ['--now'], ['--help']):
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, str(HERE / 'status.py'), *args], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0)
                self.assertNotIn('Traceback', result.stderr)
        with patch.object(status, 'read_days', side_effect=RuntimeError('private')):
            self.assertEqual(self.report()['error'], 'status.unavailable')
        with patch.object(status.Path, 'open', side_effect=PermissionError):
            self.assertEqual(len(self.report()['readErrors']), 2)
        with patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(status.main(['--now', 'bad', '--json']), 0)
            self.assertEqual(json.loads(output.getvalue())['error'], 'status.unavailable')

    def test_rollup_jobs_at_day_end_preserve_old_fields(self):
        self.write('disk.sample', NOW, durationMs=42)
        self.write('backup.run:health', NOW - dt.timedelta(hours=20), False,
                   error={'tag': 'backup.failed'}, ids={'runId': 'fixture'})
        with (self.root / '2026-11-15.ndjson').open('a') as stream:
            stream.write('{broken\n')
        result = rollup('2026-11-15', self.root)
        old = dict(day='2026-11-15', tool='mac', total=1, countsByName={'disk.sample': 1},
                   countsByKind={'perf': 1}, outcomes=1, okRate=1, errorRate=0, failedRate=0,
                   durationMs={'disk.sample': dict(p50=42, p95=42, max=42)}, malformed=1,
                   topErrors=[], diskTooling=dict(probes=0, timeouts=0, maxDurationMs=None, latestBlockedIn=None))
        old.update(backup={key: dict(memory=0, health=0, other=0)
                           for key in ('skipped_runs', 'ok_runs', 'failed_runs')},
                   diskInventory=dict(scans=0, rootsOk=0, rootsPartial=0, rootsTimeout=0, rootsDenied=0, scanMs=0),
                   diskWait=dict(runs=0, maxStuckForS=None, latestStuckUnmountMountPoint=None,
                                 busyRuns=0, topBusyComms=[]))
        self.assertEqual({k: v for k, v in result.items() if k not in ('jobs', 'missingJobs', 'cpuSpikes')}, old)
        self.assertEqual(result['cpuSpikes'], dict(minutes=0, highestLoad=[]))
        health = result['jobs']['backup.run:health']
        self.assertEqual(health['lastSeen'], '2026-11-14T16:00:00.000Z')
        self.assertFalse(health['lastOk'])
        self.assertEqual(health['gapMaxMin'], 420)
        self.assertIn('backup.run:health', result['missingJobs'])
        self.assertEqual(json.loads((self.root / 'rollup-2026-11-15.json').read_text()), result)
        self.assertEqual(rollup('2026-11-12', self.root)['missingJobs'], [])

    def test_replica_failure_fixture_is_a_run_in_status_cli_and_rollup(self):
        source = HERE / 'tests/fixtures/status/backup-failed-replica.ndjson'
        (self.root / '2026-11-14.ndjson').write_bytes(source.read_bytes())
        cli = subprocess.run([sys.executable, str(HERE / 'status.py'), '--json',
                              '--now', '2026-11-14T19:29:00Z'], capture_output=True, text=True)
        self.assertEqual(cli.returncode, 0, cli.stderr)
        result = json.loads(cli.stdout)
        daily = rollup('2026-11-14', self.root)
        for jobs_view in (result, daily):
            row = jobs_view['jobs']['backup.run:memory']
            self.assertEqual(row['lastSeen'], '2026-11-14T19:28:00.000Z')
            self.assertFalse(row['lastOk'])
            self.assertEqual(row['lines'], 1)
            self.assertEqual(row['status'], 'OK')
            self.assertNotIn('backup.run:memory', jobs_view['missingJobs'])
        self.assertEqual(daily['backup']['failed_runs']['memory'], daily['jobs']['backup.run:memory']['lines'])
        self.assertEqual(daily['backup']['ok_runs']['memory'], 0)
        self.assertEqual(daily['backup']['skipped_runs']['memory'], 0)

    def test_failure_stage_forms_are_seen_without_becoming_skips(self):
        stages = ('admission', 'stage', 'repo', 'disk', 'replica', 'verify',
                  'files', 'restic', 'prune', 'dropbox', 'manifest', 'unknown')
        at = NOW.replace(hour=23, minute=55)
        for target in ('memory', 'health'):
            for field in ('failureStage', 'failedStage'):
                for stage in stages:
                    with self.subTest(target=target, field=field, stage=stage):
                        root = self.root / (target + '-' + field + '-' + stage)
                        root.mkdir()
                        props = dict(target=target, exitCode=1, skipped=0, **{field: stage})
                        with patch.dict(os.environ, TOOLLOG_DIR=str(root)):
                            toollog.emit('backup', 'error', 'backup.run', now=at, ok=False,
                                         props=props, error_tag='backup.failed_' + stage)
                        logged = json.loads((root / '2026-11-15.ndjson').read_text())
                        self.assertEqual(logged['props'][field], stage)
                        self.assertEqual(logged['props']['skipped'], 0)
                        self.assertNotIn('skipReason', logged['props'])
                        self.assertEqual(logged['error']['tag'], 'backup.failed_' + stage)
                        current = status.report(at + dt.timedelta(minutes=1), root)
                        daily = rollup('2026-11-15', root)
                        for view in (current, daily):
                            row = view['jobs']['backup.run:' + target]
                            self.assertEqual(row['lastSeen'], status.stamp(at))
                            self.assertFalse(row['lastOk'])
                            self.assertEqual(row['lines'], 1)
                            self.assertEqual(row['status'], 'OK')
                        self.assertEqual(daily['backup']['failed_runs'][target], 1)
                        self.assertEqual(daily['backup']['ok_runs'][target], 0)
                        self.assertEqual(daily['backup']['skipped_runs'][target], 0)

    def test_new_periodic_jobs_and_daily_event_without_outcome(self):
        self.seed()
        # The nightly end event omits ok; it still proves the pass finished.
        self.write('disk.deep.end', NOW - dt.timedelta(minutes=1))
        path = self.root / '2026-11-15.ndjson'
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        rows[-1].pop('ok')
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        result = self.report()
        self.assertEqual(result['missingJobs'], [])
        self.assertIsNone(result['jobs']['disk.deep.end']['lastOk'])
        self.assertEqual(result['jobs']['disk.deep.end']['status'], 'OK')
        self.assertEqual(result['jobs']['memory.sample']['gapMaxMin'], 15)
        self.assertEqual(result['jobs']['cpu.sample']['gapMaxMin'], 3)
        # CPU and memory each become late at their own allowance.
        later = self.report(NOW + dt.timedelta(minutes=11))
        self.assertEqual(later['missingJobs'], ['memory.sample', 'cpu.sample'])
        self.assertEqual(later['jobs']['memory.sample']['status'], 'LATE')

    def test_cpu_three_minute_cadence_and_failed_probe_liveness(self):
        self.seed()
        self.assertEqual(self.report(NOW + dt.timedelta(minutes=2))['jobs']['cpu.sample']['status'], 'OK')
        self.assertEqual(self.report(NOW + dt.timedelta(minutes=2, seconds=1))['jobs']['cpu.sample']['status'], 'LATE')
        self.write('cpu.sample', NOW + dt.timedelta(minutes=3), False)
        row = self.report(NOW + dt.timedelta(minutes=4))['jobs']['cpu.sample']
        self.assertEqual(row['status'], 'OK')
        self.assertFalse(row['lastOk'])

    def test_missing_day_emitted_once_daily_before_any_jobs(self):
        collector.missing_day(NOW)
        collector.missing_day(NOW)
        rows = [json.loads(line) for line in (self.root / '2026-11-15.ndjson').read_text().splitlines()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['name'], 'log.missing_day')
        self.assertEqual(rows[0]['kind'], 'error')
        self.assertFalse(rows[0]['ok'])
        self.assertIn('runId', rows[0]['ids'])
        self.assertEqual(rows[0]['props'], {'source': '2026-11-14 and 2026-11-15', 'count': 2})
        collector.missing_day(NOW + dt.timedelta(days=1))
        self.assertTrue((self.root / '2026-11-16.ndjson').exists())
        with patch.object(collector, 'read_state', side_effect=PermissionError):
            collector.missing_day(NOW)
        with patch.object(collector, 'missing_day') as check, \
             patch.object(collector, 'disk_tooling_probe', side_effect=lambda: self.assertTrue(check.called)), \
             patch.object(collector, 'directory_inventory'), patch.object(collector, 'collect'), \
             patch.object(collector, 'disk_wait'):
            collector.main()

    def test_missing_yesterday_detected_when_today_exists(self):
        self.write('disk.sample')
        collector.missing_day(NOW)
        rows = [json.loads(line) for line in (self.root / '2026-11-15.ndjson').read_text().splitlines()]
        self.assertEqual(rows[-1]['props']['source'], '2026-11-14')
        # No false missing day before the instrumentation was introduced.
        collector.missing_day(dt.datetime(2026, 11, 12, tzinfo=UTC))
        self.assertFalse((self.root / '2026-11-12.ndjson').exists())

    def test_missing_day_retries_failed_append_even_if_it_created_the_file(self):
        for failure in (BlockingIOError, OSError):
            with self.subTest(failure=failure.__name__):
                root = self.root / failure.__name__
                root.mkdir()
                (root / '2026-11-14.ndjson').touch()
                with patch.dict(os.environ, TOOLLOG_DIR=str(root)):
                    target = toollog.fcntl if failure is BlockingIOError else toollog
                    method = 'flock' if failure is BlockingIOError else 'append'
                    with patch.object(target, method, side_effect=failure):
                        collector.missing_day(NOW)
                    self.assertEqual((root / '2026-11-15.ndjson').read_text(), '')
                    pending = json.loads((root / 'state/missing-day.json').read_text())
                    self.assertNotIn('reportedDay', pending)
                    self.assertEqual(pending['missingDates'], ['2026-11-15'])
                    collector.missing_day(NOW)
                    collector.missing_day(NOW)
                lines = (root / '2026-11-15.ndjson').read_text().splitlines()
                self.assertEqual(len(lines), 1)
                self.assertEqual(json.loads(lines[0])['name'], 'log.missing_day')
                self.assertEqual(json.loads(lines[0])['props']['source'], '2026-11-15')
