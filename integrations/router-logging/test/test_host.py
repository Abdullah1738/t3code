import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import guard
import host
import observer
import poller
import rollup
import toollog

UTC = dt.timezone.utc
MEMORY = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\nPages inactive: 2000.\n'
NORMAL = dict(l1=1.25, l5=2.5, l15=3.75, c=16, p=1, f=16384000, a=49152000)


def result(output, code=0):
    return subprocess.CompletedProcess([], code, output, '')


class HostTests(unittest.TestCase):
    def test_normal_and_pressure_levels(self):
        for pressure in (1, 2, 4):
            with self.subTest(pressure=pressure), patch('host.sys.platform', 'darwin'), patch('host.os.getloadavg', return_value=(1.25, 2.5, 3.75)), patch('host.os.cpu_count', return_value=16), patch('host.subprocess.run', side_effect=[result(str(pressure)), result(MEMORY)]) as run:
                sample = host.Sampler()()
                self.assertEqual(sample, dict(NORMAL, p=pressure))
                self.assertTrue(all(0 < call.kwargs['timeout'] <= 1.75 for call in run.call_args_list))

    def test_failure_input_class_and_no_unbounded_retry(self):
        cases = [
            ('timeout', subprocess.TimeoutExpired('sysctl', 1.75)),
            ('missing', FileNotFoundError()), ('error', OSError()),
            ('garbage', result('')), ('garbage', result('normal')),
            ('garbage', result('3')), ('garbage', result('-1')),
            ('command', result('4', 1)), ('error', TypeError()),
        ]
        for tag, response in cases:
            with self.subTest(tag=tag, response=response), patch('host.sys.platform', 'darwin'), patch('host.subprocess.run', side_effect=response if isinstance(response, Exception) else [response]) as run:
                self.assertEqual(host.Sampler()()['e'], tag)
                self.assertEqual(run.call_count, 1)
        for output in ('garbage', MEMORY.replace('16384', 'bad'), MEMORY.replace('Pages inactive: 2000.', ''), MEMORY.replace('1000.', '-1.')):
            with self.subTest(memory=output), patch('host.sys.platform', 'darwin'), patch('host.subprocess.run', side_effect=[result('1'), result(output)]):
                self.assertEqual(host.Sampler()()['e'], 'garbage')

    def test_total_tick_budget_after_timeout(self):
        seconds = [0]
        def timeout(*args, **kwargs):
            seconds[0] += kwargs['timeout']
            raise subprocess.TimeoutExpired(args[0], kwargs['timeout'])
        with patch('host.sys.platform', 'darwin'), patch('host.time.monotonic', side_effect=lambda: seconds[0]), patch('host.subprocess.run', side_effect=timeout) as run:
            sampler = host.Sampler()
            self.assertEqual(sampler()['e'], 'timeout')
            self.assertEqual(sampler()['e'], 'timeout')
            self.assertEqual(run.call_count, 1)
            self.assertLess(seconds[0], 2)

    def test_real_subprocess_timeout_is_under_two_seconds(self):
        run = subprocess.run
        def blocked(args, **kwargs):
            return run([sys.executable, '-I', '-c', 'import time; time.sleep(5)'], **kwargs)
        with patch('host.sys.platform', 'darwin'), patch('host.subprocess.run', side_effect=blocked):
            start = time.monotonic()
            self.assertEqual(host.Sampler()()['e'], 'timeout')
            self.assertLess(time.monotonic() - start, 2)

    def test_wire_privacy_and_size_budget(self):
        now = dt.datetime.now(UTC)
        samples = (NORMAL, dict(NORMAL, l1=315.25, l5=299.99, l15=201.1, f=137438953472, a=137438953472),
                   dict(NORMAL, e='timeout'), dict(l1=999998.99, l5=999998.99, l15=999998.99, c=65536, p=4, e='unsupported'), dict(l1=999999, l5=999999, l15=999999, c=65536, p=4, f=2**50, a=2**50, e='unsupported'))
        for sample in samples:
            for failed in (False, True):
                base = dict(component='poller', name='poll.complete', kind='error' if failed else 'perf', ok=not failed, durationMs=42)
                if failed:
                    base['error'] = {'tag': 'poll_failed'}
                original = toollog.clean(base, now)
                for props in (dict(host=dict(sample)), host.poll_props(sample, 1795219200000)):
                    with self.subTest(sample=sample, failed=failed, timestamp='hostAtMs' in props):
                        props['host'].update(process='private', command='private')
                        row = toollog.clean(dict(base, props=props), now)
                        wire = json.dumps(row, separators=(',', ':')).encode()
                        self.assertNotIn(b'private', wire)
                        self.assertLessEqual(len(wire) - len(json.dumps(original, separators=(',', ':')).encode()), 120)
        self.assertEqual(host.clean_host(dict(l1=float('nan'), l5=True, c=-1, f='x', p=3, e='secret')), {})
        self.assertEqual(host.clean_host(dict(l1=10**1000, f=10**1000)), {})

    def test_poll_success_and_failure_keep_host_without_new_rows(self):
        get = lambda route: {'/api/providers': {'connections': []}, '/api/usage/logs': [], '/api/usage/stats?period=today': {'byAccount': {}}}[route]
        for failed in (False, True):
            with tempfile.TemporaryDirectory() as directory, patch('observer.Sampler', return_value=lambda: dict(NORMAL, e='timeout')), patch('observer.job_snapshot', return_value={}), patch('poller.emit') as emit:
                def request(route):
                    if failed:
                        raise OSError()
                    return get(route)
                self.assertEqual(poller.poll(request, directory, dt.datetime(2026, 11, 21, 1, tzinfo=UTC)), int(failed))
                rows = [call for call in emit.call_args_list if call.args[1] == 'poll.complete']
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0].kwargs['props']['host']['e'], 'timeout')
                self.assertFalse(any(call.args[1].startswith('host.') for call in emit.call_args_list))

    def test_guard_unknown_snapshots_survive_restart_and_midnight(self):
        rows = []
        at = dt.datetime(2026, 11, 20, 23, 59, tzinfo=UTC)
        def event(name, **props):
            rows.append(toollog.clean(dict(component='guard', name=name, kind='event', props=props), at))
        start = dict(NORMAL, l1=315)
        state = {}
        g = guard.Guard(state=state, event=event)
        g.step(at.timestamp() * 1000, 'unknown', 'open', observation={'launchctlExit': 5}, host=start)
        state = json.loads(json.dumps(g.state))
        at = dt.datetime(2026, 11, 21, 0, 3, tzinfo=UTC)
        guard.Guard(state=state, event=event).step(at.timestamp() * 1000, 'loaded', 'open', host=NORMAL)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for row in rows:
                with (root / (row['ts'][:10] + '.ndjson')).open('a') as out:
                    out.write(json.dumps(row) + '\n')
            report = rollup.rollup('2026-11-20', root, at)
            window = report['listener']['unknownWindows'][0]
            self.assertEqual(window['hostStart'], start)
            self.assertEqual(window['hostEnd'], NORMAL)
            self.assertEqual(window['unknownMs'], 60000)

    def test_gap_and_slow_tick_snapshots(self):
        start = dict(wallMs=1795219200000, monotonicMs=0, pid=1, host=dict(NORMAL, l1=315))
        end = dict(wallMs=start['wallMs'] + 180000, monotonicMs=180000, pid=1, host=NORMAL)
        gap = observer.gap(start, end)
        self.assertEqual(gap['hostStart']['l1'], 315)
        for component in ('guard', 'poller'):
            with patch('observer.clock_sample', return_value=end), patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
                with observer.Timings(component, start=start, sampler=lambda: NORMAL):
                    pass
            row = dict(tool='9router', component=component, name='guard.tick_late' if component == 'guard' else 'poll.phases', ts='2026-11-21T00:03:00Z', **emit.call_args.kwargs)
            bucket = observer.gap_summary([row], '2026-11-21', dt.datetime(2026, 11, 22, tzinfo=UTC))[('guardGaps' if component == 'guard' else 'pollGaps')]
            self.assertEqual(bucket[0]['hostStart']['l1'], 315)
            self.assertEqual(bucket[0]['hostEnd'], NORMAL)

    def test_rollup_hourly_overload_latency_missing_and_failed(self):
        rows = []
        def add(hour, name, props, duration=None):
            row = dict(tool='9router', component='poller', kind='perf', name=name, ts=f'2026-11-21T{hour:02d}:05:00Z', props=props)
            if duration is not None:
                row['durationMs'] = duration
            rows.append(row)
        add(0, 'poll.complete', {'host': NORMAL})
        add(0, 'poll.complete', {'host': dict(NORMAL, l1=315, p=4)})
        add(1, 'poll.complete', {'host': dict(l1=4, c=16, e='timeout')})
        add(2, 'poll.complete', {})
        for duration in (10, 20, 30):
            add(0, 'proxy.request', dict(model='test', route='chat', stream=True), duration)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '2026-11-21.ndjson').write_text('\n'.join(map(json.dumps, rows)))
            report = rollup.rollup('2026-11-21', root, dt.datetime(2026, 11, 22, tzinfo=UTC))
        load = report['hostLoad']
        self.assertEqual(load['hourly'][0]['load1'], dict(avg=158.12, max=315))
        self.assertEqual(load['hourly'][0]['maxPressureLevel'], 4)
        self.assertEqual(load['hoursWithLoadAbove2xCpu'], ['2026-11-21T00:00:00Z'])
        self.assertEqual(load['failedSnapshots'], {'timeout': 1})
        self.assertEqual(load['pollRowsWithoutHost'], 1)
        self.assertEqual(report['proxySummary']['byHour'][0]['p95DurationMs'], 30)
        self.assertIn('missing', report['coverage']['hostLoad'])

    def test_anomaly_boundary_input_class_does_not_double_count_alias(self):
        start = dict(NORMAL, l1=100)
        end = dict(NORMAL, l1=1)
        cases = [
            ('poll.phases', dict(start='2026-11-21T00:00:00Z', end='2026-11-21T00:03:00Z')),
            ('guard.tick_late', dict(startedAtMs=1795219200000, finishedAtMs=1795219380000)),
            ('observer.gap', dict(start='2026-11-21T00:00:00Z', end='2026-11-21T00:03:00Z')),
            ('listener.state_resolved', dict(unknownSince='2026-11-21T00:00:00Z')),
            ('listener.up', dict(downSince='2026-11-21T00:00:00Z')),
        ]
        for name, bounds in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                row = dict(tool='9router', component='guard' if name != 'poll.phases' else 'poller', name=name,
                           kind='perf', durationMs=180000, ts='2026-11-21T00:03:00.007Z',
                           props=dict(bounds, host=end, hostStart=start, hostEnd=end))
                (root / '2026-11-21.ndjson').write_text(json.dumps(row))
                result = rollup.rollup('2026-11-21', root, dt.datetime(2026, 11, 22, tzinfo=UTC))
                hour = result['hostLoad']['hourly'][0]
                self.assertEqual(hour['samples'], 2)
                self.assertEqual(hour['load1']['avg'], 50.5)

    def test_poll_sample_timestamp_crosses_hour_and_midnight(self):
        for sample_time, completed, expected_hour in (
                ('2026-11-21T22:59:59Z', '2026-11-21T23:00:01Z', '2026-11-21T22:00:00Z'),
                ('2026-11-21T23:59:59Z', '2026-11-22T00:00:01Z', '2026-11-21T23:00:00Z'),
                ('2026-11-21T23:59:59Z', '2026-11-23T00:00:01Z', '2026-11-21T23:00:00Z')):
            for failed in (False, True):
                with self.subTest(completed=completed, failed=failed), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    at = dt.datetime.fromisoformat(sample_time.replace('Z', '+00:00'))
                    props = host.poll_props(dict(NORMAL, e='timeout') if failed else NORMAL, at.timestamp() * 1000)
                    row = dict(tool='9router', component='poller', kind='error' if failed else 'perf', name='poll.complete',
                               ts=completed, durationMs=2000, props=props)
                    (root / (completed[:10] + '.ndjson')).write_text(json.dumps(row))
                    generated = dt.datetime(2026, 11, 24, tzinfo=UTC)
                    result = rollup.rollup('2026-11-21', root, generated)['hostLoad']
                    self.assertEqual(result['pollRows'], 1)
                    self.assertEqual(result['hourly'][0]['hour'], expected_hour)
                    self.assertEqual(result['hourly'][0]['samples'], 1)
                    self.assertEqual(result['failedSnapshots'], {'timeout': 1} if failed else {})
                    if completed[:10] != '2026-11-21':
                        completion_report = rollup.rollup(completed[:10], root, generated)['hostLoad']
                        self.assertEqual(completion_report['pollRows'], 0)
                        self.assertEqual(completion_report['hourly'], [])

    def test_late_poll_completion_refreshes_finalized_sample_day(self):
        get = lambda route: {'/api/providers': {'connections': []}, '/api/usage/logs': [], '/api/usage/stats?period=today': {'byAccount': {}}}[route]
        with tempfile.TemporaryDirectory() as directory, patch('poller.emit'), patch('observer.Sampler', return_value=lambda: NORMAL), patch('observer.job_snapshot', return_value={}):
            root = Path(directory)
            first = dt.datetime(2026, 11, 22, 0, 6, tzinfo=UTC)
            self.assertEqual(poller.poll(get, root, first), 0)
            report = root / 'rollup-2026-11-21.json'
            self.assertEqual(json.loads(report.read_text())['hostLoad']['hourly'], [])
            start = dt.datetime(2026, 11, 21, 23, 59, tzinfo=UTC)
            row = dict(tool='9router', component='poller', name='poll.complete', kind='perf',
                       ts='2026-11-22T00:07:00Z', props=host.poll_props(NORMAL, start.timestamp() * 1000))
            (root / '2026-11-22.ndjson').write_text(json.dumps(row) + '\n')
            with patch('poller.rollup', wraps=rollup.rollup) as rebuild:
                self.assertEqual(poller.poll(get, root, first.replace(minute=10)), 0)
                self.assertEqual(json.loads(report.read_text())['hostLoad']['hourly'][0]['samples'], 1)
                self.assertEqual(rebuild.call_count, 1)
                self.assertEqual(poller.poll(get, root, first.replace(minute=15)), 0)
                self.assertEqual(rebuild.call_count, 1)

    def test_slow_pool_fetch_carries_same_boundary_shape(self):
        from unittest.mock import MagicMock
        seconds = [0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'auth').mkdir()
            (root / 'machine-id').write_text('fixture')
            (root / 'auth/cli-secret').write_text('fixture')
            router = poller.Router(root, component='pool-alerts', event_name='pool.endpoint.get')
            router.opener = MagicMock()
            response = router.opener.open.return_value.__enter__.return_value
            response.status = 200
            def read(*_):
                seconds[0] += 180
                return b'{}'
            response.read.side_effect = read
            with patch('poller.time.monotonic', side_effect=lambda: seconds[0]), patch('poller.Sampler', return_value=lambda: NORMAL), patch('poller.emit') as emit:
                self.assertEqual(router.get('/api/monitoring/pools'), {})
            props = emit.call_args.kwargs['props']
            self.assertEqual(props['hostStart'], NORMAL)
            self.assertEqual(props['hostEnd'], NORMAL)

    def test_poll_and_phase_start_share_one_sample(self):
        cases = [dict(NORMAL, l1=100),
                 dict(NORMAL, l1=315.25, l5=299.99, l15=201.1, f=137438953472, a=137438953472),
                 dict(NORMAL, l1=999998.99, l5=999998.99, l15=999998.99, c=65536, p=4, e='unsupported')]
        for start in cases:
            with self.subTest(start=start), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                end = dict(NORMAL, l1=1)
                poll_props = host.poll_props(start, 1795219200000.875)
                if start['l1'] != 100:
                    self.assertNotEqual(poll_props['host'], start, 'exercise trimming')
                rows = [dict(tool='9router', component='poller', kind='perf', name='poll.complete',
                             ts='2026-11-21T00:03:00.007Z', props=poll_props),
                        dict(tool='9router', component='poller', kind='perf', name='poll.phases', durationMs=180000,
                             ts='2026-11-21T00:03:00.008Z', props=dict(startedAtMs=1795219200000.875,
                                 finishedAtMs=1795219380000.875, host=end, hostStart=start, hostEnd=end))]
                (root / '2026-11-21.ndjson').write_text('\n'.join(map(json.dumps, rows)))
                report = rollup.rollup('2026-11-21', root, dt.datetime(2026, 11, 22, tzinfo=UTC))
                hour = report['hostLoad']['hourly'][0]
                self.assertEqual(hour['samples'], 2)
                self.assertEqual(hour['load1']['avg'], round((start['l1'] + 1) / 2, 2))
                self.assertEqual(hour['failedSnapshots'], int('e' in start))

    def test_decimal_load_size_class(self):
        now = dt.datetime.now(UTC)
        base = dict(component='poller', name='poll.complete', kind='perf', ok=True, durationMs=123)
        original = json.dumps(toollog.clean(base, now), separators=(',', ':')).encode()
        for load in (0.01, 9.99, 99.99, 999.99, 9999.99, 99999.99, 999998.99, 999999):
            for cpus in (16, 65536):
                for error in (None, 'timeout', 'unsupported'):
                    with self.subTest(load=load, cpus=cpus, error=error):
                        sample = dict(l1=load, l5=load, l15=load, c=cpus, p=4, f=2**50, a=2**50)
                        if error:
                            sample['e'] = error
                        row = toollog.clean(dict(base, props=host.poll_props(sample, 1795219200000)), now)
                        wire = json.dumps(row, separators=(',', ':')).encode()
                        self.assertLessEqual(len(wire) - len(original), 120)
                        self.assertEqual(row['props']['host']['l1'], load)
                        self.assertEqual(row['props']['host']['c'], cpus)


if __name__ == '__main__':
    unittest.main()
