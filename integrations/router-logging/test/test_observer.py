import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import observer
import guard
import poller
import rollup
import toollog
from guard import Guard, Runtime
from toollog import clean

UTC = dt.timezone.utc
BASE = 1795132800000


def sample(wall=BASE, mono=1000, continuous=2000, pid=42, state='running'):
    return dict(wallMs=wall, monotonicMs=mono, continuousMs=continuous, pid=pid,
                jobState=state, jobPid=pid, jobExit=0)


class ObserverTests(unittest.TestCase):
    def setUp(self):
        for module in ('observer', 'poller', 'guard'):
            fake = patch(module + '.Sampler', return_value=lambda: {'e': 'unsupported'})
            fake.start()
            self.addCleanup(fake.stop)

    def test_poll_refreshes_finalized_days_for_late_gap_class(self):
        cases = [('pool-alerts', 'pool.endpoint.get', 'tick_blocked:pool_fetch'),
                 ('poller', 'poll.phases', 'tick_blocked:rollup_write'),
                 ('poller', 'rollup.phases', 'tick_blocked:rollup_write'),
                 ('guard', 'guard.tick_late', 'tick_blocked:rollup_write'),
                 ('guard', 'observer.gap', 'sleep_gap')]
        get = lambda route: {'/api/providers': {'connections': []}, '/api/usage/logs': [],
                             '/api/usage/stats?period=today': {'byAccount': {}}}[route]
        for component, name, cause in cases:
            for late_days in (1, 2):
                with self.subTest(name=name, late_days=late_days), tempfile.TemporaryDirectory() as directory, patch('poller.emit'), patch('observer.emit'), patch('observer.job_snapshot', return_value={}):
                    root = Path(directory)
                    first = dt.datetime(2026, 11, 21, 0, 6, tzinfo=UTC)
                    self.assertEqual(poller.poll(get, root, first), 0)
                    report = root / 'rollup-2026-11-20.json'
                    self.assertEqual(json.loads(report.read_text())['pollGaps'], [])
                    ended = first.replace(minute=10) + dt.timedelta(days=late_days - 1)
                    start = dt.datetime(2026, 11, 20, 23, 59, tzinfo=UTC)
                    event = dict(tool='9router', component=component, name=name, kind='perf',
                                 ts=observer.iso(ended.timestamp() * 1000), durationMs=(ended - start).total_seconds() * 1000,
                                 props=dict(start=observer.iso(start.timestamp() * 1000), end=observer.iso(ended.timestamp() * 1000),
                                            phase='pool_fetch' if name == 'pool.endpoint.get' else 'rollup_write', cause=cause))
                    if name != 'pool.endpoint.get':
                        event['props']['rollupWriteMs'] = (ended - start).total_seconds() * 1000
                    if cause == 'sleep_gap':
                        event['props']['sleepGapMs'] = (ended - start).total_seconds() * 1000
                    if late_days == 1:
                        event['props'].pop('start')
                        event['props'].pop('end')
                        event['props'].update(startedAtMs=start.timestamp() * 1000, finishedAtMs=ended.timestamp() * 1000)
                    source = root / (ended.date().isoformat() + '.ndjson')
                    # An incomplete append must remain available to the following poll.
                    source.write_text(json.dumps(event)[:25])
                    self.assertEqual(poller.poll(get, root, ended + dt.timedelta(minutes=1)), 0)
                    with source.open('a') as out:
                        out.write(json.dumps(event)[25:] + '\n')
                    self.assertEqual(poller.poll(get, root, ended + dt.timedelta(minutes=2)), 0)
                    result = json.loads(report.read_text())
                    field = 'guardGaps' if component == 'guard' else 'pollGaps'
                    self.assertEqual(result[field][0]['durationMs'], 60000)
                    self.assertEqual(result[field][0]['cause'], 'guard_not_scheduled' if cause == 'sleep_gap' else cause)
                    self.assertEqual(result['listener']['unknownWindows'], [])
                    with patch.object(poller, 'rollup', wraps=rollup.rollup) as build:
                        self.assertEqual(poller.poll(get, root, ended + dt.timedelta(minutes=3)), 0)
                    self.assertNotIn('2026-11-20', [call.args[0] for call in build.call_args_list])

    def test_guard_tick_includes_observer_state_write_stall(self):
        seconds, checks, handlers = [0], [], {}
        def clock():
            return sample(BASE + seconds[0] * 1000, seconds[0] * 1000, seconds[0] * 1000)
        with tempfile.TemporaryDirectory() as directory:
            runtime = MagicMock()
            runtime.state_file = Path(directory) / 'guard.json'
            runtime.marker = Path(directory) / 'deploy.json'
            runtime.lock_age_ms.return_value = None
            def observe():
                checks.append('probe')
                if len(checks) == 2:
                    handlers[guard.signal.SIGTERM]()
                return 'loaded', 'open'
            runtime.observe.side_effect = observe
            child = MagicMock()
            child.poll.return_value = None
            replace = os.replace
            delayed = []
            def slow_save(source, target):
                state = json.loads(Path(source).read_text())
                if target == runtime.state_file and 'observerTick' in state and not delayed:
                    seconds[0] += 180
                    delayed.append(True)
                return replace(source, target)
            with patch('guard.Runtime', return_value=runtime), patch('guard.signal.signal', side_effect=lambda key, callback: handlers.update({key: callback})), patch('guard.subprocess.Popen', return_value=child), patch('observer.job_snapshot', return_value={}), patch('guard.clock_sample', side_effect=clock), patch('observer.clock_sample', side_effect=clock), patch('observer.time.monotonic', side_effect=lambda: seconds[0]), patch('guard.os.replace', side_effect=slow_save), patch('observer.emit') as emit:
                guard.serve()
            self.assertEqual(len(checks), 2)
            self.assertEqual(emit.call_count, 1)
            self.assertEqual(emit.call_args.args, ('guard', 'guard.tick_late'))
            self.assertEqual(emit.call_args.kwargs['props']['stateSaveMs'], 180000)
            self.assertEqual(emit.call_args.kwargs['props']['cause'], 'tick_blocked:state_save')

    def test_poll_refresh_cursor_handles_future_rows_and_source_removal_class(self):
        get = lambda route: {'/api/providers': {'connections': []}, '/api/usage/logs': [],
                             '/api/usage/stats?period=today': {'byAccount': {}}}[route]
        for change in ('truncate', 'replace', 'delete'):
            with self.subTest(source_change=change), tempfile.TemporaryDirectory() as directory, patch('poller.emit'), patch('observer.emit'), patch('observer.job_snapshot', return_value={}):
                root = Path(directory)
                first = dt.datetime(2026, 11, 21, 0, 6, tzinfo=UTC)
                source = root / '2026-11-21.ndjson'
                source.write_text(json.dumps(dict(tool='9router', component='pool-alerts', name='pool.endpoint.get',
                    kind='perf', ts='2026-11-21T00:10:00Z', durationMs=660000,
                    props=dict(start='2026-11-20T23:59:00Z', end='2026-11-21T00:10:00Z'))) + '\n')
                report = root / 'rollup-2026-11-20.json'
                self.assertEqual(poller.poll(get, root, first), 0)
                self.assertEqual(json.loads(report.read_text())['pollGaps'], [])
                self.assertEqual(poller.poll(get, root, first.replace(minute=11)), 0)
                self.assertEqual(json.loads(report.read_text())['pollGaps'][0]['durationMs'], 60000)
                if change == 'delete':
                    source.unlink()
                elif change == 'replace':
                    replacement = root / 'replacement'
                    replacement.write_text('{}\n')
                    replacement.replace(source)
                else:
                    source.write_text('')
                self.assertEqual(poller.poll(get, root, first.replace(minute=12)), 0)
                self.assertEqual(json.loads(report.read_text())['pollGaps'], [])

    def test_ndjson_write_stalls_are_separate_from_snapshot_processing(self):
        for mode in ('normal', 'failure', 'cap', 'volume'):
            with self.subTest(write_mode=mode), tempfile.TemporaryDirectory() as directory:
                seconds, delayed = [0], []
                def clock():
                    return sample(BASE + seconds[0] * 1000, seconds[0] * 1000, seconds[0] * 1000)
                write = os.write
                def slow_write(fd, data):
                    if not delayed:
                        seconds[0] += 180
                        delayed.append(True)
                        if mode == 'failure':
                            raise OSError('fixture write failed')
                    return write(fd, data)
                with patch.dict(os.environ, ROUTER_LOG_DIR=directory), patch('observer.clock_sample', side_effect=clock), patch('observer.job_snapshot', return_value={}), patch('observer.time.monotonic', side_effect=lambda: seconds[0]), patch('toollog.os.write', side_effect=slow_write):
                    with observer.Timings():
                        if mode == 'cap':
                            with patch.object(toollog, 'CAP', 0):
                                poller.snapshot({'connections': []}, [], {}, dt.datetime(2026, 11, 20, tzinfo=UTC))
                        elif mode == 'volume':
                            state = toollog.volume.state_for(Path(directory), dt.datetime.now(UTC).date().isoformat())
                            toollog.volume.dropped(state, 'daily_cap')
                            toollog.report_volume()
                        else:
                            poller.snapshot({'connections': []}, [], {}, dt.datetime(2026, 11, 20, tzinfo=UTC))
                rows = [json.loads(line) for path in Path(directory).glob('*.ndjson') for line in path.read_text().splitlines()]
                phases = [row for row in rows if row['name'] == 'poll.phases']
                self.assertEqual(len(phases), 1)
                props = phases[0]['props']
                self.assertEqual(props['logWriteMs'], 180000)
                self.assertEqual(props['snapshotMs'], 0)
                self.assertEqual(props['stateSaveMs'], 0)
                self.assertEqual(props['cause'], 'tick_blocked:log_write')

    def test_gap_cause_input_class(self):
        before = sample()
        cases = [
            ('cadence', sample(BASE + 15000, 16000, 17000), None),
            ('late', sample(BASE + 200000, 201000, 202000), 'unknown_no_data'),
            ('sleep', sample(BASE + 200000, 16000, 202000), 'guard_not_scheduled'),
            ('clock_step', sample(BASE + 200000, 16000, 17000), 'unknown_no_data'),
            ('no_suspend_clock', sample(BASE + 200000, 16000, None), 'unknown_no_data'),
            ('restarted', sample(BASE + 200000, 16000, 202000, pid=43), 'guard_not_scheduled'),
            ('clock_back', sample(BASE - 200000, 201000, 202000), None),
        ]
        for name, after, cause in cases:
            with self.subTest(name=name):
                result = observer.gap(before, after)
                self.assertEqual(result['cause'] if result else None, cause)
        for state in ('stopped', 'absent'):
            result = observer.gap(sample(state=state), sample(BASE + 200000, 201000, 202000, pid=43))
            self.assertEqual(result['cause'], 'guard_not_scheduled')
            self.assertEqual(result['jobStateStart'], state)
        self.assertIsNone(observer.gap({}, sample()))
        self.assertIsNone(observer.gap(None, sample()))

    def test_unknown_launchctl_outcome_is_sparse_and_reaches_rollup(self):
        for value in (1, -9, 'timeout', 'oserror'):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                events = []
                def event(name, **props):
                    row = clean(dict(component='guard', name=name, kind='event', props=props),
                                dt.datetime.fromtimestamp((BASE + (60000 if name.endswith('resolved') else 0)) / 1000, UTC))
                    events.append(row)
                guard = Guard(event=event)
                evidence = dict(launchctlExit=value, launchctlStderr='  timed out\n  printing service  ')
                guard.step(BASE, 'unknown', 'open', observation=evidence)
                guard.step(BASE + 15000, 'unknown', 'open', observation=evidence)
                guard.step(BASE + 60000, 'loaded', 'open')
                self.assertEqual(len(events), 2)
                self.assertEqual(events[0]['props']['launchctlStderr'], 'timed out printing service')
                self.assertNotIn('launchctlStderr', events[1]['props'])
                root = Path(directory)
                (root / '2026-11-20.ndjson').write_text('\n'.join(map(json.dumps, events)))
                listener = rollup.rollup('2026-11-20', root, dt.datetime(2026, 11, 21, tzinfo=UTC))['listener']
                cause = ('launchctl_timeout' if value == 'timeout' else 'unknown_no_data' if value == 'oserror'
                         else 'launchctl_exit:' + str(value))
                self.assertEqual(listener['unknownWindows'][0]['cause'], cause)
                self.assertEqual(listener['unknownByCause'], [dict(cause=cause, count=1, unknownMs=60000)])
                self.assertEqual(listener['confirmedDownMs'], 0)

    def test_launchctl_preserves_exit_timeout_oserror_and_trimmed_stderr(self):
        job = 'gui/501/example'
        result = subprocess.CompletedProcess([], 37, ' state = running\n pid = 123\n', ' diagnostic\n text\t')
        with patch('observer.subprocess.run', return_value=result) as run:
            outcome = observer.launchctl_print(job)
        self.assertEqual(outcome, dict(launchctlExit=37, launchctlStderr='diagnostic text', jobState='running', jobPid=123))
        self.assertEqual(run.call_args.kwargs['timeout'], 5)
        for error, code, stderr in (
                (subprocess.TimeoutExpired('launchctl', 5, stderr=b' partial\n diagnostic '), 'timeout', 'partial diagnostic'),
                (subprocess.TimeoutExpired('launchctl', 5, stderr=' partial text '), 'timeout', 'partial text'),
                (subprocess.TimeoutExpired('launchctl', 5), 'timeout', ''),
                (OSError('failed to execute'), 'oserror', 'failed to execute')):
            with patch('observer.subprocess.run', side_effect=error):
                self.assertEqual(observer.launchctl_print(job), dict(launchctlExit=code, launchctlStderr=stderr))
        with patch('guard.launchctl_print', return_value=outcome), patch.object(Runtime, 'probe', return_value='open'):
            runtime = Runtime()
            self.assertEqual(runtime.observe(), ('unknown', 'open'))
            self.assertEqual(runtime.observation, outcome)

    def test_stderr_is_bounded_redacted_and_only_allowed_on_unknown_transition(self):
        raw = ' token=private-value\nBearer private-value sk-private-value ' + 'x' * 500
        for name in ('listener.state_unknown', 'poll.phases'):
            row = clean(dict(component='guard', name=name, kind='event', props=dict(launchctlStderr=raw)), dt.datetime.now(UTC))
            self.assertNotIn('private-value', json.dumps(row))
            if name.endswith('unknown'):
                self.assertLessEqual(len(row['props']['launchctlStderr']), 240)
            else:
                self.assertNotIn('launchctlStderr', row.get('props', {}))

    def test_snapshot_failures_are_observations_and_do_not_interrupt_tick(self):
        for error, code in (
                (subprocess.TimeoutExpired('launchctl', .5), 'timeout'),
                (OSError('cannot execute'), 'oserror'),
                (TypeError('bad subprocess response'), 'snapshot_error')):
            with self.subTest(code=code), patch('observer.subprocess.run', side_effect=error), patch('observer.clock_sample', side_effect=[sample(), sample(BASE + 180000, 181000, 182000), sample(BASE + 180000, 181000, 182000)]), patch('observer.emit') as emit, patch('guard.socket.create_connection'):
                with observer.Timings('guard', 'guard.tick_late') as timing:
                    listener = Runtime().probe()
                self.assertEqual(listener, 'open')
                self.assertEqual(timing.start['jobState'], 'unknown')
                self.assertEqual(timing.end['jobExit'], code)
                props = emit.call_args.kwargs['props']
                self.assertEqual(props['jobExitStart'], code)
                self.assertEqual(props['jobExitEnd'], code)

    def test_non_cumulative_nested_phases_and_sparse_threshold(self):
        seconds = [0]
        def clock():
            return sample(BASE + seconds[0] * 1000, seconds[0] * 1000, seconds[0] * 1000)
        with patch('observer.time.monotonic', side_effect=lambda: seconds[0]), patch('observer.clock_sample', side_effect=clock), patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
            with observer.Timings() as timing:
                with observer.phase('history_scan_parse'):
                    seconds[0] += 10
                    with observer.phase('rollup_write'):
                        seconds[0] += 180
                    seconds[0] += 5
            self.assertEqual(timing.values['history_scan_parse'], 15000)
            self.assertEqual(timing.values['rollup_write'], 180000)
            self.assertEqual(emit.call_count, 1)
            props = emit.call_args.kwargs['props']
            self.assertEqual(props['cause'], 'tick_blocked:rollup_write')
            self.assertEqual(props['wallGapMs'], 195000)
            self.assertEqual(sum(timing.values.values()), 195000)
            with observer.Timings():
                with observer.phase('history_scan_parse'):
                    seconds[0] += 30
            self.assertEqual(emit.call_count, 1, 'no normal per-poll phase row')

    def test_real_rollup_write_is_identified_and_logged_once(self):
        seconds = [0]
        def clock():
            return sample(BASE + seconds[0] * 1000, seconds[0] * 1000, seconds[0] * 1000)
        replace = os.replace
        def slow_replace(source, destination):
            if str(destination).endswith('rollup-2026-11-20.json'):
                seconds[0] += 180
            return replace(source, destination)
        with tempfile.TemporaryDirectory() as directory, patch('observer.time.monotonic', side_effect=lambda: seconds[0]), patch('observer.clock_sample', side_effect=clock), patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit, patch('rollup.os.replace', side_effect=slow_replace):
            with observer.Timings():
                result = rollup.rollup('2026-11-20', directory, dt.datetime(2026, 11, 21, tzinfo=UTC))
            self.assertEqual(emit.call_count, 1)
            props = emit.call_args.kwargs['props']
            self.assertEqual(props['rollupWriteMs'], 180000)
            self.assertEqual(props['historyScanParseMs'], 0)
            self.assertEqual(result['healthByHour'], [])
            self.assertEqual(result['pools'], [])
            self.assertIn('Threshold', result['coverage']['healthByHour'])
            row = clean(dict(component='poller', name='poll.phases', **emit.call_args.kwargs), dt.datetime(2026, 11, 20, 0, 3, tzinfo=UTC))
            self.assertEqual(row['props']['rollupWriteMs'], 180000)
            (Path(directory) / '2026-11-20.ndjson').write_text(json.dumps(row))
            next_report = rollup.rollup('2026-11-20', directory, dt.datetime(2026, 11, 21, tzinfo=UTC))
            self.assertEqual(next_report['pollGaps'][0]['cause'], 'tick_blocked:rollup_write')

    def test_sleep_during_tick_survives_into_gap_rollup(self):
        with patch('observer.clock_sample', side_effect=[sample(), sample(BASE + 200000, 16000, 202000), sample(BASE + 200000, 16000, 202000)]), patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
            with observer.Timings():
                pass
        self.assertEqual(emit.call_count, 1)
        self.assertEqual(emit.call_args.kwargs['props']['cause'], 'guard_not_scheduled')
        row = clean(dict(component='poller', name='poll.phases', **emit.call_args.kwargs), dt.datetime(2026, 11, 20, 0, 4, tzinfo=UTC))
        result = observer.gap_summary([row], '2026-11-20', dt.datetime(2026, 11, 21, tzinfo=UTC))
        self.assertEqual(result['pollGaps'][0]['cause'], 'guard_not_scheduled')
        self.assertEqual(result['pollGaps'][0]['durationMs'], 200000)

    def test_gap_crosses_midnight_without_relabeling_unknown_window(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unknown = dict(tool='9router', component='guard', name='listener.state_unknown', kind='event', ts='2026-11-20T23:58:00Z', props=dict(unknownSince='2026-11-20T23:58:00Z', listener='open', launchctlExit=5))
            gap = dict(tool='9router', component='guard', name='observer.gap', kind='perf', ts='2026-11-21T00:03:00Z', props=dict(start='2026-11-20T23:59:00Z', end='2026-11-21T00:03:00Z', cause='sleep_gap', sleepGapMs=240000))
            (root / '2026-11-20.ndjson').write_text(json.dumps(unknown))
            (root / '2026-11-21.ndjson').write_text(json.dumps(gap))
            result = rollup.rollup('2026-11-20', root, dt.datetime(2026, 11, 21, 1, tzinfo=UTC))
            self.assertEqual(result['listener']['unknownWindows'][0]['cause'], 'launchctl_exit:5')
            self.assertEqual(result['guardGaps'], [dict(number=1, start='2026-11-20T23:59:00.000Z', end='2026-11-21T00:03:00.000Z', cause='guard_not_scheduled', causeEvidenceField='sleepGapMs', causeEvidenceValue=240000, component='guard', durationMs=60000)])
            self.assertEqual(result['pollGaps'], [])

    def test_pool_fetch_uses_own_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'auth').mkdir()
            (root / 'machine-id').write_text('fixture')
            (root / 'auth/cli-secret').write_text('fixture')
            router = poller.Router(root, component='pool-alerts', event_name='pool.endpoint.get')
            router.opener = MagicMock()
            response = router.opener.open.return_value.__enter__.return_value
            response.status, response.read.return_value = 200, b'{}'
            with patch('poller.emit') as emit:
                self.assertEqual(router.get('/api/monitoring/pools'), {})
            self.assertEqual(emit.call_args.args, ('pool-alerts', 'pool.endpoint.get'))
            self.assertIn('startedAtMs', emit.call_args.kwargs['props'])


if __name__ == '__main__':
    unittest.main()
