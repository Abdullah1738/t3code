import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import causes
import observer
import poller
from guard import Guard
from rollup import rollup
from toollog import clean

UTC = dt.timezone.utc
BASE = 1795132800000


def clock(seconds):
    return dict(wallMs=BASE + seconds * 1000, monotonicMs=seconds * 1000,
                continuousMs=seconds * 1000, pid=42)


class CauseTests(unittest.TestCase):
    def setUp(self):
        cpu = patch('observer.time.process_time', side_effect=lambda: observer.time.monotonic())
        cpu.start()
        self.addCleanup(cpu.stop)
        for module in ('observer', 'poller', 'guard'):
            fake = patch(module + '.Sampler', return_value=lambda: {'e': 'unsupported'})
            fake.start()
            self.addCleanup(fake.stop)

    def test_launchctl_outcome_class(self):
        cases = [(0, 'launchctl_exit:0'), (113, 'launchctl_exit:113'), (-9, 'launchctl_exit:-9'),
                 ('timeout', 'launchctl_timeout'), ('oserror', 'unknown_no_data'),
                 (None, 'unknown_no_data'), (True, 'unknown_no_data'), ('5', 'unknown_no_data'),
                 (32768, 'unknown_no_data'), (float('nan'), 'unknown_no_data')]
        for outcome, expected in cases:
            with self.subTest(outcome=outcome):
                result = causes.launchctl_info(dict(launchctlExit=outcome))
                self.assertEqual(result['cause'], expected)
                if expected == 'unknown_no_data':
                    self.assertIn('missingEvidence', result)
                else:
                    self.assertEqual(result['causeEvidenceField'], 'launchctlExit')
                    self.assertEqual(result['causeEvidenceValue'], outcome)
        for tag, expected in [('launchctl_unknown:5', 'launchctl_exit:5'),
                              ('launchctl_unknown:-9', 'launchctl_exit:-9'),
                              ('launchctl_unknown:timeout', 'launchctl_timeout'),
                              ('launchctl_timeout', 'launchctl_timeout'),
                              ('launchctl_exit:113', 'launchctl_exit:113')]:
            with self.subTest(legacy=tag):
                self.assertEqual(causes.launchctl_info(dict(cause=tag))['cause'], expected)

    def test_gap_evidence_class(self):
        cases = [
            (dict(launchctlMs=18000, tcpMs=1, monotonicGapMs=18001, cause='other'), 'tick_blocked:launchctl', 'launchctlMs'),
            (dict(postEndDiagMs=140000, monotonicGapMs=150000), 'tick_blocked:post_end_diag', 'postEndDiagMs'),
            (dict(childWaitMs=180000, launchctlMs=1, monotonicGapMs=180001), 'child_wait', 'childWaitMs'),
            (dict(sleepGapMs=180000, launchctlMs=1), 'guard_not_scheduled', 'sleepGapMs'),
            (dict(previousPid=42, pid=43), 'guard_not_scheduled', 'previousPid'),
            (dict(cause='sleep_gap', phase='rollup_write', sleepGapMs=180000), 'guard_not_scheduled', 'sleepGapMs'),
            (dict(cause='tick_blocked:launchctl'), 'unknown_no_data', None),
            (dict(cause='other'), 'unknown_no_data', None),
            # This is the poll LaunchAgent's state; it cannot prove the guard was unscheduled.
            (dict(jobStateStart='absent'), 'unknown_no_data', None),
            (dict(launchctlMs=float('nan'), tcpMs=True), 'unknown_no_data', None),
            (dict(launchctlMs=10 ** 1000), 'unknown_no_data', None),
        ]
        for props, expected, field in cases:
            with self.subTest(props=props):
                result = causes.gap_info(props, props.get('phase'))
                self.assertEqual(result['cause'], expected)
                if field:
                    self.assertEqual(result['causeEvidenceField'], field)
                    self.assertEqual(result['causeEvidenceValue'], props[field])
                else:
                    self.assertIn('missingEvidence', result)
        for invalid in (None, [], {}, 'new_phase', 12):
            self.assertEqual(causes.gap_info({}, invalid)['cause'], 'unknown_no_data')

    def test_phase_cpu_class_preserves_evidence_and_precedence(self):
        cases = [(120000, 0, False), (120001, 0, True), (180000, 17999, True),
                 (180000, 18000, False), (180000, 180001, False), (180000, -1, False),
                 (180000, None, False), (180000, True, False), (180000, '0', False),
                 (180000, float('nan'), False), (180000, float('inf'), False),
                 (180000, 10 ** 1000, False)]
        for name, field in causes.PHASES.items():
            for wall, cpu, starved in cases:
                with self.subTest(phase=name, wall=wall, cpu=cpu):
                    props = {field: wall, field[:-2] + 'CpuMs': cpu, 'monotonicGapMs': wall}
                    result = causes.gap_info(props)
                    expected = 'child_wait' if name == 'child_wait' else ('tick_starved:' if starved else 'tick_blocked:') + name
                    self.assertEqual(result['cause'], expected)
                    self.assertEqual(result['causeEvidenceField'], field)
                    self.assertEqual(result['causeEvidenceValue'], wall)
            props = {field: 180000, field[:-2] + 'CpuMs': 0, 'monotonicGapMs': 180000}
            self.assertEqual(causes.gap_info(dict(props, sleepGapMs=180000))['cause'], 'guard_not_scheduled')
            self.assertEqual(causes.gap_info(dict(props, monotonicGapMs=600000))['cause'], 'unknown_no_data')
        self.assertEqual(causes.gap_info(dict(cause='tick_starved:tcp'))['missingEvidence'], 'tick_phase_durations')

    def test_legacy_scheduling_tag_class_requires_independent_evidence(self):
        for tag in ('agent_not_running', 'sleep_gap', 'guard_not_scheduled', 'other'):
            for state in ('running', 'stopped', 'absent', 'unknown'):
                props = dict(cause=tag, previousPid=42, pid=42, sleepGapMs=0, jobStateStart=state)
                with self.subTest(tag=tag, state=state):
                    self.assertEqual(causes.gap_info(props)['cause'], 'unknown_no_data')
                    self.assertEqual(causes.gap_info(dict(props, sleepGapMs=180000))['cause'], 'guard_not_scheduled')
                    self.assertEqual(causes.gap_info(dict(props, pid=43))['cause'], 'guard_not_scheduled')
                    self.assertEqual(causes.gap_info(dict(props, launchctlMs=5, monotonicGapMs=5))['cause'], 'tick_blocked:launchctl')

    def test_phase_coverage_class(self):
        cases = [
            ('fully_measured', dict(launchctlMs=100000, tcpMs=80000), 180000, 'tick_blocked:launchctl', None),
            ('phase_larger', dict(launchctlMs=100000, tcpMs=30000), 180000, 'tick_blocked:launchctl', None),
            ('tie', dict(launchctlMs=80000, tcpMs=20000), 180000, 'tick_blocked:launchctl', None),
            ('remainder_larger', dict(launchctlMs=60000, tcpMs=50000), 180000, 'unknown_no_data', 'unmeasured_tick_time'),
            ('tiny_snapshots', dict(observerSnapshotStartMs=1, postEndDiagMs=1), 180002, 'unknown_no_data', 'unmeasured_tick_time'),
            ('child_wait_partial', dict(childWaitMs=1), 180000, 'unknown_no_data', 'unmeasured_tick_time'),
            ('old_cause', dict(cause='tick_blocked:launchctl'), 180000, 'unknown_no_data', 'tick_phase_durations'),
            ('old_phase', dict(phase='launchctl'), 180000, 'unknown_no_data', 'tick_phase_durations'),
            ('old_cause_partial', dict(cause='tick_blocked:launchctl', launchctlMs=1), 180000, 'unknown_no_data', 'unmeasured_tick_time'),
            ('zero_phases', dict(launchctlMs=0), 180000, 'unknown_no_data', 'unmeasured_tick_time'),
            ('invalid_phases', dict(launchctlMs=float('nan'), tcpMs=True), 180000, 'unknown_no_data', 'unmeasured_tick_time'),
            ('missing_total', dict(launchctlMs=1), None, 'unknown_no_data', 'tick_duration'),
            ('invalid_total', dict(launchctlMs=1, wallGapMs=float('inf'), monotonicGapMs=True), None, 'unknown_no_data', 'tick_duration'),
            ('wall_jump', dict(launchctlMs=180000, monotonicGapMs=180000, wallGapMs=600000), 180000, 'unknown_no_data', 'unmeasured_tick_time'),
        ]
        for name, props, total, expected, reason in cases:
            with self.subTest(name=name):
                result = causes.gap_info(props, props.get('phase'), duration_ms=total)
                self.assertEqual(result['cause'], expected)
                self.assertEqual(result.get('missingEvidence'), reason)
                if reason:
                    self.assertNotIn('causeEvidenceField', result)
                if name in ('fully_measured', 'phase_larger', 'tie', 'remainder_larger'):
                    self.assertEqual(result['phase'], 'launchctl')
                    self.assertEqual(result['phaseMs'], props['launchctlMs'])
                    self.assertEqual(result['measuredMs'] + result['unmeasuredMs'], total)

    def test_unmeasured_tick_time_survives_logging_and_rollup(self):
        for component, name in [('guard', 'guard.tick_late'), ('poller', 'poll.phases'), ('poller', 'rollup.phases')]:
            seconds = [0]
            def snapshot():
                seconds[0] += .001
                return {}
            with self.subTest(name=name), patch('observer.clock_sample', side_effect=lambda: clock(seconds[0])), \
                    patch('observer.time.monotonic', side_effect=lambda: seconds[0]), \
                    patch('observer.job_snapshot', side_effect=snapshot), patch('observer.emit') as emit:
                with observer.Timings(component, name):
                    seconds[0] += 180
            row = clean(dict(component=component, name=name, **emit.call_args.kwargs), dt.datetime.now(UTC))
            props = row['props']
            self.assertEqual(row['durationMs'], 180002)
            self.assertEqual(props['cause'], 'unknown_no_data')
            self.assertEqual(props['missingEvidence'], 'unmeasured_tick_time')
            self.assertEqual(props['phase'], 'observer_snapshot_start')
            self.assertEqual(props['phaseMs'], 1)
            self.assertEqual(props['measuredMs'], 2)
            self.assertEqual(props['unmeasuredMs'], 180000)
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / '2026-11-20.ndjson').write_text(json.dumps(row))
                report = rollup('2026-11-20', root, dt.datetime(2026, 11, 21, tzinfo=UTC))
            gaps = report['guardGaps' if component == 'guard' else 'pollGaps']
            self.assertEqual(gaps[0]['cause'], 'unknown_no_data')
            self.assertEqual(gaps[0]['phase'], props['phase'])
            self.assertEqual(gaps[0]['phaseMs'], 1)
            self.assertEqual(gaps[0]['unmeasuredMs'], 180000)
            self.assertEqual(report['coverage']['unknownCauses']['remaining'], {'unmeasured_tick_time': 1})

    def test_legacy_gap_keeps_unmeasured_time_before_daily_clipping(self):
        # Sanitized timing fields from 21 Nov gap #1; no request context.
        props = dict(cause='other', phase='other', monotonicGapMs=146984.995,
                     launchctlMs=9387.944, stateSaveMs=73.833, lockWaitMs=.017, tcpMs=27.617)
        for start, day, expected_duration in [(BASE, '2026-11-20', 146984.995),
                                               (BASE + 86340000, '2026-11-20', 60000)]:
            with self.subTest(start=start):
                row = dict(component='guard', name='guard.tick_late', ts=observer.iso(start + 146984.995),
                           durationMs=146984.995, props=dict(props, startedAtMs=start, finishedAtMs=start + 146984.995))
                gap = observer.gap_summary([row], day, dt.datetime(2026, 11, 22, tzinfo=UTC))['guardGaps'][0]
                self.assertEqual(gap['cause'], 'unknown_no_data')
                self.assertEqual(gap['missingEvidence'], 'unmeasured_tick_time')
                self.assertEqual(gap['phase'], 'launchctl')
                self.assertEqual(gap['phaseMs'], 9387.944)
                self.assertEqual(gap['measuredMs'], 9489.411)
                self.assertEqual(gap['unmeasuredMs'], 137495.584)
                self.assertEqual(gap['durationMs'], expected_duration)

    def test_pool_fetch_duration_must_explain_its_full_span(self):
        cases = [(300000, 300000, 'tick_blocked:pool_fetch'),
                 (150000, 300000, 'tick_blocked:pool_fetch'),
                 (1, 300000, 'unknown_no_data'),
                 (1, 120001, 'unknown_no_data'), (1, 120000, None)]
        for duration, wall, expected in cases:
            with self.subTest(duration=duration, wall=wall), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'auth').mkdir()
                (root / 'auth/cli-secret').write_text('fixture')
                (root / 'machine-id').write_text('fixture')
                router = poller.Router(root, component='pool-alerts', event_name='pool.endpoint.get')
                router.opener = MagicMock()
                response = router.opener.open.return_value.__enter__.return_value
                response.status, response.read.return_value = 200, b'{}'
                with patch('poller.time.monotonic', side_effect=[0, duration / 1000]), \
                        patch('poller.time.time', side_effect=[BASE / 1000, (BASE + wall) / 1000]), patch('poller.emit') as emit:
                    self.assertEqual(router.get('/api/monitoring/pools'), {})
                row = clean(dict(component=emit.call_args.args[0], name=emit.call_args.args[1], **emit.call_args.kwargs),
                            dt.datetime.fromtimestamp((BASE + wall) / 1000, UTC))
                self.assertNotIn('wallGapMs', row['props'])
                (root / '2026-11-20.ndjson').write_text(json.dumps(row))
                result = rollup('2026-11-20', root, dt.datetime(2026, 11, 21, tzinfo=UTC))
                if expected is None:
                    self.assertEqual(result['pollGaps'], [])
                    continue
                gap = result['pollGaps'][0]
                self.assertEqual(gap['cause'], expected)
                if expected == 'unknown_no_data':
                    self.assertEqual(gap['missingEvidence'], 'unmeasured_tick_time')
                    self.assertEqual(gap['unmeasuredMs'], wall - duration)
                    self.assertEqual(result['coverage']['unknownCauses']['remaining'], {'unmeasured_tick_time': 1})
                else:
                    self.assertEqual(gap['causeEvidenceField'], 'durationMs')
                    self.assertEqual(gap['causeEvidenceValue'], duration)

    def test_reconstruction_uses_all_valid_elapsed_totals(self):
        for duration in (600000, 100000, 0, None, True, float('nan'), float('inf'), '600000'):
            with self.subTest(duration=duration):
                row = dict(component='guard', name='guard.tick_late', ts=observer.iso(BASE + 180000),
                           durationMs=duration, props=dict(startedAtMs=BASE, finishedAtMs=BASE + 180000, launchctlMs=100000))
                gap = observer.gap_summary([row], '2026-11-20', dt.datetime(2026, 11, 21, tzinfo=UTC))['guardGaps'][0]
                self.assertEqual(gap['cause'], 'unknown_no_data' if duration == 600000 else 'tick_blocked:launchctl')
                self.assertEqual(gap['unmeasuredMs'], 500000 if duration == 600000 else 80000)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row['durationMs'] = 600000
            sanitized = clean(dict(row, kind='perf'), dt.datetime.fromtimestamp((BASE + 180000) / 1000, UTC))
            (root / '2026-11-20.ndjson').write_text(json.dumps(sanitized))
            report = rollup('2026-11-20', root, dt.datetime(2026, 11, 21, tzinfo=UTC))
        self.assertEqual(report['guardGaps'][0]['unmeasuredMs'], 500000)
        self.assertEqual(report['coverage']['unknownCauses']['remaining'], {'unmeasured_tick_time': 1})

    def test_pool_span_collection_boundary_class(self):
        iso_bounds = dict(start='2026-11-20T00:00:00Z', end='2026-11-20T00:05:00Z')
        cases = [
            ('numeric', dict(startedAtMs=BASE, finishedAtMs=BASE + 300000), True),
            ('iso', iso_bounds, True),
            ('offset_iso', dict(start='2026-11-20T04:00:00+04:00', end='2026-11-20T04:05:00+04:00'), True),
            ('partial_numeric_with_iso', dict(iso_bounds, startedAtMs=BASE), True),
            ('missing', {}, False),
            ('boolean', dict(startedAtMs=True, finishedAtMs=BASE + 300000), False),
            ('nonfinite', dict(startedAtMs=float('inf'), finishedAtMs=BASE + 300000), False),
            ('reversed', dict(startedAtMs=BASE + 300000, finishedAtMs=BASE), False),
            ('naive_iso', dict(start='2026-11-20T00:00:00', end='2026-11-20T00:05:00'), False),
            ('malformed_iso', dict(start='invalid', end=iso_bounds['end']), False),
            ('future', dict(startedAtMs=BASE, finishedAtMs=BASE + 86400001), False),
        ]
        for name, props, admitted in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                row = dict(tool='9router', kind='perf', component='pool-alerts', name='pool.endpoint.get',
                           ts=observer.iso(BASE + 300000), durationMs=1, props=props)
                (root / '2026-11-20.ndjson').write_text(json.dumps(row))
                report = rollup('2026-11-20', root, dt.datetime(2026, 11, 21, tzinfo=UTC))
                self.assertEqual(len(report['pollGaps']), int(admitted))
                if admitted:
                    self.assertEqual(report['pollGaps'][0]['cause'], 'unknown_no_data')
                    self.assertEqual(report['pollGaps'][0]['unmeasuredMs'], 299999)

    def test_unknown_window_boundary_and_persisted_state_class(self):
        outcomes = [({}, 'unknown_no_data', 'legacy_launchctl_outcome_not_recorded'),
                    (dict(cause='other'), 'unknown_no_data', 'legacy_launchctl_outcome_not_recorded'),
                    (dict(cause='launchctl_unknown:timeout'), 'launchctl_timeout', None),
                    (dict(cause='launchctl_unknown:oserror'), 'unknown_no_data', 'launchctl_exit_code'),
                    (dict(cause='launchctl_exit:5'), 'launchctl_exit:5', None),
                    (dict(cause='unknown_no_data', missingEvidence='launchctl_exit_code'), 'unknown_no_data', 'launchctl_exit_code')]
        for props, expected, reason in outcomes:
            for source in ('both_boundaries', 'recovery_only', 'persisted_state'):
                with self.subTest(props=props, source=source), tempfile.TemporaryDirectory() as directory:
                    root, rows = Path(directory), []
                    since = observer.iso(BASE)
                    if source == 'persisted_state':
                        state = dict(unknownSinceMs=BASE, jobUnknown=True)
                        if props.get('cause') == 'unknown_no_data':
                            state['unknownEvidence'] = props
                        elif 'cause' in props:
                            state['unknownCause'] = props['cause']
                        guard = Guard(state=state, event=lambda name, **data: rows.append(dict(tool='9router',
                            component='guard', kind='event', name=name, ts=observer.iso(BASE + 5000), props=data)))
                        guard.step(BASE + 5000, 'loaded', 'open')
                        self.assertEqual(rows[0]['props']['cause'], expected)
                        if reason:
                            self.assertEqual(rows[0]['props']['missingEvidence'], reason)
                    else:
                        if source == 'both_boundaries':
                            rows.append(dict(tool='9router', component='guard', kind='event', name='listener.state_unknown',
                                             ts=since, props=dict(unknownSince=since, listener='open', **props)))
                        rows.append(dict(tool='9router', component='guard', kind='event', name='listener.state_resolved',
                                         ts=observer.iso(BASE + 5000), props=dict(unknownSince=since, listener='open', **props)))
                    (root / '2026-11-20.ndjson').write_text('\n'.join(map(json.dumps, rows)))
                    result = rollup('2026-11-20', root, dt.datetime(2026, 11, 21, tzinfo=UTC))
                    window = result['listener']['unknownWindows'][0]
                    self.assertEqual(window['cause'], expected)
                    self.assertEqual(window['unknownMs'], 5000)
                    if reason:
                        self.assertEqual(window['missingEvidence'], reason)
                    self.assertEqual(result['coverage']['unknownCauses']['legacyListenerWindows'],
                                     int(reason == 'legacy_launchctl_outcome_not_recorded'))

    def test_tick_pairs_include_previously_unmeasured_end_diagnostic(self):
        seconds = [0]
        def snapshot():
            seconds[0] += 1 if seconds[0] == 0 else 140
            return dict(jobState='running', jobPid=123, jobExit=0)
        with patch('observer.clock_sample', side_effect=lambda: clock(seconds[0])), \
                patch('observer.time.monotonic', side_effect=lambda: seconds[0]), \
                patch('observer.job_snapshot', side_effect=snapshot) as snapshots, patch('observer.emit') as emit:
            with observer.Timings('guard', 'guard.tick_late') as timing:
                with observer.phase('launchctl'):
                    seconds[0] += 2
        self.assertEqual(snapshots.call_count, 2, 'bookkeeping adds no diagnostic subprocess')
        self.assertEqual(emit.call_count, 1)
        props = clean(dict(component='guard', name='guard.tick_late', **emit.call_args.kwargs), dt.datetime.now(UTC))['props']
        self.assertEqual(props['cause'], 'tick_blocked:post_end_diag')
        self.assertEqual(props['postEndDiagMs'], 140000)
        self.assertEqual(props['causeEvidenceValue'], 140000)
        self.assertEqual(props['startedAtMs'], BASE)
        self.assertEqual(props['finishedAtMs'], BASE + 143000)
        self.assertEqual(props['monotonicStartMs'], 0)
        self.assertEqual(props['monotonicEndMs'], 143000)
        self.assertEqual(props['openPhase'], 'none')
        self.assertEqual(timing.end['wallMs'], BASE + 143000)

    def test_host_diagnostics_keep_phase_coverage_and_boundary_times(self):
        for measured_body, failed_sample in [(False, None), (True, None), (False, 1), (False, 2)]:
            seconds, calls = [0], [0]
            def sample_host():
                calls[0] += 1
                seconds[0] += calls[0]
                if calls[0] == failed_sample:
                    raise OSError('fixture host sampler')
                return dict(l1=315 if calls[0] == 1 else 1, c=16)
            with self.subTest(measured_body=measured_body, failed_sample=failed_sample), \
                    patch('observer.clock_sample', side_effect=lambda: clock(seconds[0])), \
                    patch('observer.time.monotonic', side_effect=lambda: seconds[0]), \
                    patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
                with observer.Timings('guard', 'guard.tick_late', sampler=sample_host):
                    if measured_body:
                        with observer.phase('launchctl'):
                            seconds[0] += 180
                    else:
                        seconds[0] += 180
            row = clean(dict(component='guard', name='guard.tick_late', **emit.call_args.kwargs),
                        dt.datetime.fromtimestamp((BASE + 183000) / 1000, UTC))
            props = row['props']
            self.assertEqual(calls[0], 2)
            self.assertEqual(row['durationMs'], 183000)
            self.assertEqual(props['observerSnapshotStartMs'], 1000)
            self.assertEqual(props['postEndDiagMs'], 2000)
            self.assertEqual(props['hostStartAtMs'], BASE)
            self.assertEqual(props['hostEndAtMs'], BASE + 183000)
            if failed_sample:
                self.assertEqual(props['hostStart' if failed_sample == 1 else 'hostEnd'], {'e': 'error'})
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / '2026-11-20.ndjson').write_text(json.dumps(row))
                report = rollup('2026-11-20', root, dt.datetime(2026, 11, 21, tzinfo=UTC))
            gap = report['guardGaps'][0]
            self.assertEqual(gap['cause'], 'tick_blocked:launchctl' if measured_body else 'unknown_no_data')
            self.assertEqual(gap['unmeasuredMs'], 0 if measured_body else 180000)
            self.assertEqual(gap['hostStart'], props['hostStart'])
            self.assertEqual(gap['hostEndAtMs'], props['hostEndAtMs'])

    def test_poll_completion_survives_start_clock_failure(self):
        responses = {'/api/providers': {'connections': []}, '/api/usage/logs': [],
                     '/api/usage/stats?period=today': {'byAccount': {}}}
        for failure in (RuntimeError('clock'), OSError('clock'), OverflowError('clock')):
            for request_fails in (False, True):
                def get(route):
                    if request_fails:
                        raise OSError('fixture request')
                    return responses[route]
                with self.subTest(failure=type(failure).__name__, request_fails=request_fails), \
                        tempfile.TemporaryDirectory() as directory, \
                        patch('observer.clock_sample', side_effect=failure), patch('poller.emit') as emit:
                    self.assertEqual(poller.poll(get, directory, dt.datetime(2026, 11, 20, tzinfo=UTC)), int(request_fails))
                completed = [call.kwargs for call in emit.call_args_list if call.args[1] == 'poll.complete']
                self.assertEqual(len(completed), 1)
                self.assertEqual(completed[0]['ok'], not request_fails)
                self.assertEqual(completed[0]['props'], {'host': {'e': 'error'}})
                self.assertIsNone(observer._active.get())

    def test_poll_host_missing_and_invalid_timestamp_class(self):
        cases = [None, [], {}, *[dict(hostAtMs=value) for value in
                 (None, True, '1795132800000', float('nan'), float('inf'), -1, 10 ** 1000)]]
        for start in cases:
            with self.subTest(start=start):
                token = observer._active.set(MagicMock(start=start))
                try:
                    self.assertEqual(observer.poll_host(), {'host': {'e': 'error'}})
                finally:
                    observer._active.reset(token)
        for at_ms in (0, BASE, BASE + .875):
            token = observer._active.set(MagicMock(start=dict(host=dict(l1=315, c=16), hostAtMs=at_ms)))
            try:
                self.assertEqual(observer.poll_host(), dict(host=dict(l1=315, c=16), hostAtMs=int(at_ms)))
            finally:
                observer._active.reset(token)
        self.assertEqual(observer.poll_host(), {})

    def test_tick_rows_only_over_thirty_seconds_and_longest_phase_has_no_minimum(self):
        for duration, count in [(29, 0), (30, 0), (31, 1)]:
            seconds = [0]
            with self.subTest(duration=duration), patch('observer.clock_sample', side_effect=lambda: clock(seconds[0])), \
                    patch('observer.time.monotonic', side_effect=lambda: seconds[0]), \
                    patch('observer.job_snapshot', return_value={}), patch('observer.emit') as emit:
                with observer.Timings('guard', 'guard.tick_late'):
                    for _ in range(duration):
                        with observer.phase('tcp'):
                            seconds[0] += 1
                self.assertEqual(emit.call_count, count)
                if count:
                    self.assertEqual(emit.call_args.kwargs['props']['cause'], 'tick_blocked:tcp')
        self.assertEqual(causes.gap_info(dict(tcpMs=.01, monotonicGapMs=.01))['cause'], 'tick_blocked:tcp')

    def test_diagnostic_failures_preserve_body_result_and_exception(self):
        for failure in ('start_clock', 'end_clock', 'phase_clock', 'snapshot', 'emit'):
            for body_fails in (False, True):
                with self.subTest(failure=failure, body_fails=body_fails):
                    samples = [RuntimeError('clock'), clock(40)] if failure == 'start_clock' else [clock(0), RuntimeError('clock') if failure == 'end_clock' else clock(40), clock(40)]
                    with patch('observer.clock_sample', side_effect=samples), \
                            patch('observer.time.monotonic', side_effect=RuntimeError('phase') if failure == 'phase_clock' else None), \
                            patch('observer.job_snapshot', side_effect=RuntimeError('snapshot') if failure == 'snapshot' else None, return_value={}), \
                            patch('observer.emit', side_effect=RuntimeError('emit') if failure == 'emit' else None):
                        def run():
                            with observer.Timings('guard', 'guard.tick_late'):
                                with observer.phase('tcp'):
                                    if body_fails:
                                        raise ValueError('body')
                                    return 42
                        if body_fails:
                            with self.assertRaisesRegex(ValueError, 'body'):
                                run()
                        else:
                            self.assertEqual(run(), 42)
                    self.assertIsNone(observer._active.get())

    def test_rollup_mixes_legacy_missing_evidence_and_new_causes(self):
        rows = []
        def row(name, second, component='guard', **props):
            value = dict(tool='9router', component=component, kind='event', name=name,
                         ts=observer.iso(BASE + second * 1000), props=props)
            rows.append(value)
            return value
        for index, props in enumerate([dict(cause='other', launchctlMs=18000), dict(cause='other'),
                                       dict(cause='tick_blocked:post_end_diag', postEndDiagMs=140000)]):
            start = index * 300
            row('guard.tick_late', start + 150, startedAtMs=BASE + start * 1000,
                finishedAtMs=BASE + (start + 150) * 1000, **props)['durationMs'] = 150000
        outcomes = [dict(cause='other'), dict(cause='launchctl_unknown:timeout'),
                    dict(launchctlExit=5), dict(cause='unknown_no_data', missingEvidence='launchctl_exit_code')]
        for index, props in enumerate(outcomes):
            second = 1000 + index * 100
            since = observer.iso(BASE + second * 1000)
            row('listener.state_unknown', second, unknownSince=since, listener='open', **props)
            row('listener.state_resolved', second + 5, unknownSince=since, listener='open', **props)
        row('supervisor.stopping', 1500, 'supervisor', initiator='unknown', signal='SIGTERM')
        row('supervisor.stopping', 1501, 'supervisor', initiator='install-launchagent.sh', signal='SIGTERM', deployMarkerState='active')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '2026-11-20.ndjson').write_text('\n'.join(map(json.dumps, rows)))
            result = rollup('2026-11-20', root, dt.datetime(2026, 11, 21, tzinfo=UTC))
        self.assertEqual([item['cause'] for item in result['guardGaps']], ['unknown_no_data', 'unknown_no_data', 'tick_blocked:post_end_diag'])
        self.assertEqual(result['guardGaps'][0]['phase'], 'launchctl')
        self.assertEqual(result['guardGaps'][0]['unmeasuredMs'], 132000)
        self.assertEqual(sum(item['count'] for item in result['guardGapsByCause']), 3)
        self.assertEqual(sum(item['durationMs'] for item in result['guardGapsByCause']), 450000)
        self.assertEqual([item['cause'] for item in result['listener']['unknownWindows']], ['unknown_no_data', 'launchctl_timeout', 'launchctl_exit:5', 'unknown_no_data'])
        missing = result['coverage']['unknownCauses']['remaining']
        self.assertEqual(missing['legacy_launchctl_outcome_not_recorded'], 1)
        self.assertEqual(missing['launchctl_exit_code'], 1)
        self.assertEqual(missing['inter_tick_phase_or_scheduler_state'], 1)
        self.assertEqual(missing['unmeasured_tick_time'], 1)
        self.assertEqual(result['supervisor']['stopsByInitiator'], {'unknown_no_marker': 1, 'install-launchagent.sh': 1})
        self.assertEqual(result['supervisor']['stopMarkerStates'], {'legacy_no_marker_state': 1, 'active': 1})

    @unittest.skipUnless(os.environ.get('ROUTER_TICK_BENCHMARK') == '1', 'offbox bookkeeping budget check')
    def test_tick_bookkeeping_budget_without_probe_or_log_io(self):
        iterations = 5000
        with patch('observer.job_snapshot', return_value={}) as snapshot, patch('observer.emit') as emit:
            started = time.perf_counter()
            for _ in range(iterations):
                with observer.Timings('guard', 'guard.tick_late'):
                    with observer.phase('tcp'):
                        pass
            per_tick_ms = (time.perf_counter() - started) * 1000 / iterations
        self.assertLess(per_tick_ms, 5)
        self.assertEqual(snapshot.call_count, iterations * 2)
        emit.assert_not_called()
        print(f'TICK_BOOKKEEPING {per_tick_ms:.4f} ms/tick ({iterations} ticks; existing probe I/O excluded)')
