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
import poller
import rollup
from guard import Guard, Runtime
from toollog import clean

UTC = dt.timezone.utc
BASE = 1795132800000


def sample(wall=BASE, mono=1000, continuous=2000, pid=42, state='running'):
    return dict(wallMs=wall, monotonicMs=mono, continuousMs=continuous, pid=pid,
                jobState=state, jobPid=pid, jobExit=0)


class ObserverTests(unittest.TestCase):
    def test_gap_cause_input_class(self):
        before = sample()
        cases = [
            ('cadence', sample(BASE + 15000, 16000, 17000), None),
            ('late', sample(BASE + 200000, 201000, 202000), 'other'),
            ('sleep', sample(BASE + 200000, 16000, 202000), 'sleep_gap'),
            ('clock_step', sample(BASE + 200000, 16000, 17000), 'other'),
            ('no_suspend_clock', sample(BASE + 200000, 16000, None), 'other'),
            ('restarted', sample(BASE + 200000, 16000, 202000, pid=43), 'other'),
            ('clock_back', sample(BASE - 200000, 201000, 202000), None),
        ]
        for name, after, cause in cases:
            with self.subTest(name=name):
                result = observer.gap(before, after)
                self.assertEqual(result['cause'] if result else None, cause)
        for state in ('stopped', 'absent'):
            result = observer.gap(sample(state=state), sample(BASE + 200000, 201000, 202000, pid=43))
            self.assertEqual(result['cause'], 'agent_not_running')
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
                cause = 'launchctl_unknown:' + str(value)
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
            with self.subTest(code=code), patch('observer.subprocess.run', side_effect=error), patch('observer.clock_sample', side_effect=[sample(), sample(BASE + 180000, 181000, 182000)]), patch('observer.emit') as emit, patch('guard.socket.create_connection'):
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
        with patch('observer.clock_sample', side_effect=[sample(), sample(BASE + 200000, 16000, 202000)]), patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
            with observer.Timings():
                pass
        self.assertEqual(emit.call_count, 1)
        self.assertEqual(emit.call_args.kwargs['props']['cause'], 'sleep_gap')
        row = clean(dict(component='poller', name='poll.phases', **emit.call_args.kwargs), dt.datetime(2026, 11, 20, 0, 4, tzinfo=UTC))
        result = observer.gap_summary([row], '2026-11-20', dt.datetime(2026, 11, 21, tzinfo=UTC))
        self.assertEqual(result['pollGaps'][0]['cause'], 'sleep_gap')
        self.assertEqual(result['pollGaps'][0]['durationMs'], 200000)

    def test_gap_crosses_midnight_without_relabeling_unknown_window(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unknown = dict(tool='9router', component='guard', name='listener.state_unknown', kind='event', ts='2026-11-20T23:58:00Z', props=dict(unknownSince='2026-11-20T23:58:00Z', listener='open', launchctlExit=5))
            gap = dict(tool='9router', component='guard', name='observer.gap', kind='perf', ts='2026-11-21T00:03:00Z', props=dict(start='2026-11-20T23:59:00Z', end='2026-11-21T00:03:00Z', cause='sleep_gap'))
            (root / '2026-11-20.ndjson').write_text(json.dumps(unknown))
            (root / '2026-11-21.ndjson').write_text(json.dumps(gap))
            result = rollup.rollup('2026-11-20', root, dt.datetime(2026, 11, 21, 1, tzinfo=UTC))
            self.assertEqual(result['listener']['unknownWindows'][0]['cause'], 'launchctl_unknown:5')
            self.assertEqual(result['guardGaps'], [dict(number=1, start='2026-11-20T23:59:00.000Z', end='2026-11-21T00:03:00.000Z', cause='sleep_gap', component='guard', durationMs=60000)])
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
