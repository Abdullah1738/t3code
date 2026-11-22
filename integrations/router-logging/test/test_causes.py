import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import causes
import observer
from guard import Guard
from rollup import rollup
from toollog import clean

UTC = dt.timezone.utc
BASE = 1795132800000


def clock(seconds):
    return dict(wallMs=BASE + seconds * 1000, monotonicMs=seconds * 1000,
                continuousMs=seconds * 1000, pid=42)


class CauseTests(unittest.TestCase):
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
            (dict(launchctlMs=18000, tcpMs=1, cause='other'), 'tick_blocked:launchctl', 'launchctlMs'),
            (dict(postEndDiagMs=140000), 'tick_blocked:post_end_diag', 'postEndDiagMs'),
            (dict(childWaitMs=180000, launchctlMs=1), 'child_wait', 'childWaitMs'),
            (dict(sleepGapMs=180000, launchctlMs=1), 'guard_not_scheduled', 'sleepGapMs'),
            (dict(previousPid=42, pid=43), 'guard_not_scheduled', 'previousPid'),
            (dict(cause='sleep_gap', phase='rollup_write', sleepGapMs=180000), 'guard_not_scheduled', 'sleepGapMs'),
            (dict(cause='tick_blocked:launchctl'), 'tick_blocked:launchctl', 'cause'),
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

    def test_legacy_scheduling_tag_class_requires_independent_evidence(self):
        for tag in ('agent_not_running', 'sleep_gap', 'guard_not_scheduled', 'other'):
            for state in ('running', 'stopped', 'absent', 'unknown'):
                props = dict(cause=tag, previousPid=42, pid=42, sleepGapMs=0, jobStateStart=state)
                with self.subTest(tag=tag, state=state):
                    self.assertEqual(causes.gap_info(props)['cause'], 'unknown_no_data')
                    self.assertEqual(causes.gap_info(dict(props, sleepGapMs=180000))['cause'], 'guard_not_scheduled')
                    self.assertEqual(causes.gap_info(dict(props, pid=43))['cause'], 'guard_not_scheduled')
                    self.assertEqual(causes.gap_info(dict(props, launchctlMs=5))['cause'], 'tick_blocked:launchctl')

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
        self.assertEqual(causes.gap_info(dict(tcpMs=.01))['cause'], 'tick_blocked:tcp')

    def test_diagnostic_failures_preserve_body_result_and_exception(self):
        for failure in ('start_clock', 'end_clock', 'phase_clock', 'snapshot', 'emit'):
            for body_fails in (False, True):
                with self.subTest(failure=failure, body_fails=body_fails):
                    samples = [RuntimeError('clock'), clock(40)] if failure == 'start_clock' else [clock(0), RuntimeError('clock') if failure == 'end_clock' else clock(40)]
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
        self.assertEqual([item['cause'] for item in result['guardGaps']], ['tick_blocked:launchctl', 'unknown_no_data', 'tick_blocked:post_end_diag'])
        self.assertEqual(sum(item['count'] for item in result['guardGapsByCause']), 3)
        self.assertEqual(sum(item['durationMs'] for item in result['guardGapsByCause']), 450000)
        self.assertEqual([item['cause'] for item in result['listener']['unknownWindows']], ['unknown_no_data', 'launchctl_timeout', 'launchctl_exit:5', 'unknown_no_data'])
        missing = result['coverage']['unknownCauses']['remaining']
        self.assertEqual(missing['legacy_launchctl_outcome_not_recorded'], 1)
        self.assertEqual(missing['launchctl_exit_code'], 1)
        self.assertEqual(missing['inter_tick_phase_or_scheduler_state'], 1)
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
