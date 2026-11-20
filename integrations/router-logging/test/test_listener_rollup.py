import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rollup import rollup
import poller


def row(name, at, **props):
    return dict(tool='9router', component='guard' if name.startswith('listener.') else 'supervisor', kind='event', name=name, ts=at, props=props)


class ListenerRollupTests(unittest.TestCase):
    def test_recorded_18_nov_replay(self):
        fixtures = Path(__file__).with_name('fixtures')
        rows = [json.loads(line) for line in (fixtures / 'listener-2026-11-18.ndjson').read_text().splitlines()]
        rows += json.loads((fixtures / 'listener-deploy-2026-11-18.json').read_text())
        result = self.make({'2026-11-18': rows})['listener']
        self.assertEqual(result['count'], 1)
        self.assertEqual(result['confirmedDownMs'], 14964)
        self.assertEqual(result['totalDownMs'], 14964)
        self.assertEqual(result['windows'][0]['cause'], 'deploy_failed')
        self.assertEqual(result['unknownStateMs'], 225119)
        self.assertEqual(len(result['unknownWindows']), 7)
        self.assertEqual({w['cause'] for w in result['unknownWindows']}, {'state_unknown'})

    def test_unknown_state_open_resolved_and_day_boundaries(self):
        start = '2026-11-17T23:59:00Z'
        files = {'2026-11-17': [row('listener.state_unknown', start, unknownSince=start, state='unknown', listener='open')],
                 '2026-11-18': [],
                 '2026-11-19': [row('listener.state_resolved', '2026-11-19T00:01:00Z', unknownSince=start, listener='open', state='loaded')]}
        result = self.make(files)['listener']
        self.assertEqual(result['confirmedDownMs'], 0)
        self.assertEqual(result['unknownStateMs'], 86400000)
        self.assertEqual(result['unknownWindows'][0]['end'], '2026-11-19T00:01:00Z')
        result = self.make(files, now=dt.datetime(2026, 11, 18, 1, tzinfo=dt.timezone.utc))['listener']
        self.assertEqual(result['unknownStateMs'], 3600000)
        self.assertIsNone(result['unknownWindows'][0]['end'])

    def test_unknown_job_failed_probe_is_confirmed_not_unknown_time(self):
        start = '2026-11-18T01:00:00Z'
        rows = [row('listener.state_unknown', start, state='unknown', listener='refused'),
                row('listener.down', start, downSince=start, state='unknown', listener='refused', cause='deploy_failed'),
                row('listener.up', '2026-11-18T01:01:00Z', downSince=start, listener='open', downListener='refused', cause='deploy_failed')]
        result = self.make({'2026-11-18': rows})['listener']
        self.assertEqual(result['confirmedDownMs'], 60000)
        self.assertEqual(result['unknownStateMs'], 0)

    def test_stale_failed_transaction_does_not_relabel_refusal(self):
        start = '2026-11-18T18:51:26.758Z'
        rows = [row('deploy.result', '2026-11-18T15:51:09.186Z', status='failed',
                    startedAtMs=1795017064172, finishedAtMs=1795017069186),
                row('listener.down', start, downSince=start, state='loaded', listener='refused', cause='listener_refused'),
                row('listener.up', '2026-11-18T18:52:00Z', downSince=start, downListener='refused', listener='open', cause='listener_refused')]
        result = self.make({'2026-11-18': rows})['listener']
        self.assertEqual(result['count'], 1)
        self.assertEqual(result['windows'][0]['cause'], 'listener_refused')

    def test_poller_refreshes_open_unknown_window_after_later_recovery(self):
        get = lambda route: {'/api/providers': {'connections': []}, '/api/usage/logs': [],
                             '/api/usage/stats?period=today': {'byAccount': {}}}[route]
        start = '2026-11-17T23:59:00Z'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '2026-11-17.ndjson').write_text(json.dumps(row('listener.state_unknown', start, unknownSince=start, listener='open')))
            report = root / 'rollup-2026-11-17.json'
            with patch.object(poller, 'emit'):
                poller.poll(get, root, dt.datetime(2026, 11, 18, 0, 5, tzinfo=dt.timezone.utc))
                self.assertIsNone(json.loads(report.read_text())['listener']['unknownWindows'][0]['end'])
                end = '2026-11-19T00:01:00Z'
                (root / '2026-11-19.ndjson').write_text(json.dumps(row('listener.state_resolved', end, unknownSince=start, listener='open')))
                poller.poll(get, root, dt.datetime(2026, 11, 19, 0, 5, tzinfo=dt.timezone.utc))
                result = json.loads(report.read_text())['listener']
                self.assertEqual(result['unknownStateMs'], 60000)
                self.assertEqual(result['unknownWindows'][0]['end'], end)

    def make(self, files, day='2026-11-18', now=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for date, rows in files.items():
                (root / (date + '.ndjson')).write_text('\n'.join(map(json.dumps, rows)))
            return rollup(day, root, now=now or dt.datetime(2026, 11, 20, tzinfo=dt.timezone.utc))

    def test_stops_exits_deploys_and_windows(self):
        rows = [row('supervisor.start', '2026-11-18T00:00:00Z'), row('supervisor.reload', '2026-11-18T00:00:01Z'),
                row('supervisor.stopping', '2026-11-18T00:00:02Z', signal='SIGTERM', initiator='install-launchagent.sh'),
                row('supervisor.exit', '2026-11-18T00:00:03Z', code=0, pendingWorkers=[dict(pid=2)]),
                row('worker.forked', '2026-11-18T00:00:04Z'), row('supervisor.restart_scheduled', '2026-11-18T00:00:05Z')]
        rows += [row(name, '2026-11-18T00:01:00Z') for name in ('deploy.bootout', 'deploy.bootstrap', 'deploy.reload', 'deploy.result')]
        rows += [row('listener.down', '2026-11-18T01:00:00Z', cause='listener_refused', downSince='2026-11-18T01:00:00Z'),
                 row('listener.up', '2026-11-18T01:02:00Z', cause='listener_refused', downSince='2026-11-18T01:00:00Z', downMs=120000)]
        result = self.make({'2026-11-18': rows})
        for field in ('starts', 'stopping', 'exits', 'reloads', 'workerForks', 'restartScheduled', 'pendingWorkerOutcomes'):
            self.assertEqual(result['supervisor'][field], 1)
        self.assertEqual(result['supervisor']['stopsByInitiator'], {'install-launchagent.sh': 1})
        self.assertEqual(result['supervisor']['exitCodes'], {'0': 1})
        self.assertEqual(len(result['supervisor']['deploy']), 4)
        self.assertEqual(result['listener']['totalDownMs'], 120000)
        self.assertEqual(result['listener']['maxDownMs'], 120000)

    def test_midnight_open_closed_multiday_and_daily_counts(self):
        files = {'2026-11-17': [row('listener.down', '2026-11-17T23:59:00Z', downSince='2026-11-17T23:59:00Z', cause='listener_refused')],
                 '2026-11-18': [],
                 '2026-11-19': [row('listener.up', '2026-11-19T00:01:00Z', downSince='2026-11-17T23:59:00Z', cause='listener_refused')]}
        result = self.make(files)
        self.assertEqual(result['total'], 0)
        self.assertEqual(result['listener']['totalDownMs'], 86400000)
        self.assertEqual(result['listener']['windows'][0]['end'], '2026-11-19T00:01:00Z')
        result = self.make(files, now=dt.datetime(2026, 11, 18, 1, tzinfo=dt.timezone.utc))
        self.assertEqual(result['listener']['totalDownMs'], 3600000)
        self.assertIsNone(result['listener']['windows'][0]['end'])

    def test_up_without_down_duplicate_rows_and_invalid_timestamps(self):
        up = row('listener.up', '2026-11-18T00:01:00Z', downSince='2026-11-17T23:59:00Z', cause='listener_refused')
        files = {'2026-11-18': [up, up, row('listener.down', 'broken'), row('listener.down', '2026-11-18T00:00:00')]}
        result = self.make(files)
        self.assertEqual(result['listener']['count'], 1)
        self.assertEqual(result['listener']['totalDownMs'], 60000)

    def test_recovery_day_class_keeps_original_day_counts_and_end(self):
        start = '2026-11-17T23:59:00Z'
        for gap in (0, 1, 2, 7):
            with self.subTest(recovery_days_later=gap):
                end = (dt.datetime(2026, 11, 17, 23, 59, 30, tzinfo=dt.timezone.utc) if gap == 0 else
                       dt.datetime(2026, 11, 17, 0, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=gap))
                end_iso = end.isoformat().replace('+00:00', 'Z')
                files = {'2026-11-17': [row('listener.down', start, downSince=start, cause='listener_refused')]}
                files.setdefault(end.date().isoformat(), []).append(row('listener.up', end_iso, downSince=start, cause='listener_refused'))
                result = self.make(files, day='2026-11-17', now=end + dt.timedelta(minutes=1))
                self.assertEqual(result['listener']['windows'][0]['end'], end_iso)
                self.assertEqual(result['listener']['totalDownMs'], 30000 if gap == 0 else 60000)
                self.assertEqual(result['total'], 2 if gap == 0 else 1)

    def test_poll_refreshes_finalized_open_windows_until_recovery_then_stops(self):
        get = lambda route: {'/api/providers': {'connections': []}, '/api/usage/logs': [],
                             '/api/usage/stats?period=today': {'byAccount': {}}}[route]
        start = '2026-11-17T23:59:00Z'
        for gap in (1, 2, 7):
            with self.subTest(recovery_days_later=gap), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / '2026-11-17.ndjson').write_text(json.dumps(row('listener.down', start, downSince=start, cause='listener_refused')))
                report = root / 'rollup-2026-11-17.json'
                with patch.object(poller, 'emit'):
                    self.assertEqual(poller.poll(get, root, dt.datetime(2026, 11, 18, 0, 5, tzinfo=dt.timezone.utc)), 0)
                    before = json.loads(report.read_text())
                    self.assertTrue(before['complete'])
                    self.assertIsNone(before['listener']['windows'][0]['end'])
                    end = dt.datetime(2026, 11, 17, 0, 10, tzinfo=dt.timezone.utc) + dt.timedelta(days=gap)
                    end_iso = end.isoformat().replace('+00:00', 'Z')
                    (root / (end.date().isoformat() + '.ndjson')).write_text(json.dumps(row('listener.up', end_iso, downSince=start, cause='listener_refused')))
                    self.assertEqual(poller.poll(get, root, end + dt.timedelta(minutes=5)), 0)
                    after = json.loads(report.read_text())
                    self.assertEqual(after['listener']['windows'][0]['end'], end_iso)
                    self.assertEqual(after['listener']['totalDownMs'], 60000)
                    self.assertEqual(after['total'], before['total'])
                    with patch.object(poller, 'rollup', wraps=rollup) as build:
                        self.assertEqual(poller.poll(get, root, end + dt.timedelta(minutes=10)), 0)
                    self.assertNotIn('2026-11-17', [call.args[0] for call in build.call_args_list])
                    self.assertEqual(json.loads(report.read_text()), after)


if __name__ == '__main__':
    unittest.main()
