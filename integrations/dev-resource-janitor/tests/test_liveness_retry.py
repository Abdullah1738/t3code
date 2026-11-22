import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from janitor_test_safety import JanitorTestCase

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path.insert(0, str(SCRIPTS))
import active_sessions as active
import dev_janitor as janitor
import worktree_reaper as reaper


class Clock:
    def __init__(self):
        self.now = 0
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class ActiveRosterRetryTests(JanitorTestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / 'control.json'
        self.config.write_text(json.dumps(dict(url='http://test', token='test-token')))
        self.config.chmod(0o600)
        self.clock = Clock()
        for obj, name, value in [
                (active.time, 'monotonic', lambda: self.clock.now),
                (active.time, 'sleep', self.clock.sleep),
                (active, '_control_config', lambda: str(self.config)),
                (active, '_password', lambda: None)]:
            p = patch.object(obj, name, value)
            p.start()
            self.addCleanup(p.stop)

    def request(self, outcomes):
        outcomes = iter(outcomes)

        def send(req, timeout):
            self.assertGreater(timeout, 0)
            if urlsplit(req.full_url).path == '/api/session/active':
                body = dict(data={})
            elif parse_qs(urlsplit(req.full_url).query).get('active') == ['true']:
                elapsed, body = next(outcomes)
                self.clock.now += elapsed
                if isinstance(body, Exception):
                    raise body
            else:
                body = dict(ok=True, threads=[], total=0)
            response = io.StringIO(json.dumps(body))
            response.status = 200
            return response

        return patch.object(active.urllib.request, 'urlopen', side_effect=send)

    def roster(self, outcomes, **kwargs):
        stats = {}
        with self.request(outcomes) as api:
            result = active.checked_snapshot(max_attempts=3, deadline=kwargs.pop('deadline', 600),
                                             stats=stats, **kwargs)
        return result, stats, api

    def test_timeout_twice_then_success_uses_complete_roster_and_logs_recovery(self):
        row = dict(threadId='live', state='running', worktreePath='/work')
        snap, stats, _ = self.roster([
            (20, TimeoutError()), (20, TimeoutError()), (1, dict(ok=True, threads=[row], total=1))])
        self.assertTrue(snap['complete'], snap['problems'])
        self.assertEqual(snap['workspaces'], {'live': '/work'})
        self.assertEqual(stats, dict(attempts=3, seconds=48,
                                    last_error='control api active: TimeoutError after 2 attempts, 42.0 s'))
        self.assertEqual(self.clock.sleeps, [2, 5])
        with patch.object(janitor, 'AUDIT', str(self.root / 'audit.jsonl')), \
                patch.object(janitor, 'LOG_DIR', str(self.root)), \
                patch.object(janitor, 'LAST', str(self.root / 'last.json')):
            janitor.record_report(dict(ts=1, liveness_unavailable=None, liveness=stats,
                                      processes=janitor.leftover_processes.unavailable_report('fixture')))
        self.assertEqual(json.loads((self.root / 'audit.jsonl').read_text())['liveness'], stats)

    def test_three_timeouts_fail_closed_with_exact_cause_and_no_owner_calls(self):
        snap, stats, api = self.roster([(20, TimeoutError())] * 3)
        reason = 'control api active: TimeoutError after 3 attempts, 67.0 s'
        self.assertFalse(snap['complete'])
        self.assertEqual(snap['problems'], [reason])
        self.assertEqual(snap['threads'], {})
        self.assertEqual(stats, dict(attempts=3, seconds=67, last_error=reason))
        self.assertEqual(api.call_count, 3)
        lp = janitor.leftover_processes
        row = dict(pid=42, ppid=1, start='old', tty='??', args='python3 -m http.server 9000')
        with patch.object(lp, 'owner') as owner, patch.object(lp, 'probe') as probe:
            report = lp.detect({42: row}, {}, {}, snap, resolve=owner, inspect=probe)
        owner.assert_not_called()
        probe.assert_not_called()
        self.assertEqual(report['candidates'], [])
        self.assertEqual(report['problems'], ['liveness_unavailable: ' + reason])

    def test_transport_errno_22_keeps_exact_reason_and_retries(self):
        error = urllib.error.URLError(OSError(22, 'Invalid argument'))
        snap, stats, api = self.roster([(0, error)] * 3)
        self.assertFalse(snap['complete'])
        self.assertEqual(api.call_count, 3)
        self.assertEqual(stats['last_error'],
                         'control api active: URLError -> OSError [Errno 22] Invalid argument after 3 attempts, 7.0 s')
        self.assertNotIn('phase=', stats['last_error'])

    def test_wrapped_exception_chain_survives_roster_retry_reporting(self):
        cause = TimeoutError()
        cause.__cause__ = OSError(22, 'Invalid argument')
        snap, stats, _ = self.roster([(0, urllib.error.URLError(cause))] * 3)
        self.assertFalse(snap['complete'])
        self.assertEqual(stats['last_error'],
                         'control api active: URLError -> TimeoutError -> OSError [Errno 22] Invalid argument '
                         'after 3 attempts, 7.0 s')
        self.assertNotIn('phase=', stats['last_error'])

    def test_response_body_timeout_has_a_known_read_phase(self):
        class Body(io.StringIO):
            status = 200

            def read(self, *args):
                raise TimeoutError()

        stats = {}
        with patch.object(active.urllib.request, 'urlopen', side_effect=lambda *args, **kwargs: Body('')):
            snap = active.checked_snapshot(max_attempts=3, deadline=600, stats=stats)
        self.assertFalse(snap['complete'])
        self.assertEqual(stats['last_error'],
                         'control api active: TimeoutError (phase=read) after 3 attempts, 7.0 s')

    def test_connection_errors_retry_but_http_payload_and_configuration_failures_do_not(self):
        cases = [
            (ConnectionResetError(), True),
            (urllib.error.URLError(TimeoutError()), True),
            (urllib.error.URLError('connection refused'), True),
            (urllib.error.HTTPError('http://test', 503, 'busy', {}, None), False),
            (dict(ok=True, threads=[], total=1), False),
            (dict(ok=True, threads=[{}], total=1), False),
            ([], False),
            (ValueError('invalid config'), False),
        ]
        for error, retry in cases:
            with self.subTest(error=error):
                snap, stats, api = self.roster([(0, error), (0, dict(ok=True, threads=[], total=0))])
                self.assertEqual(snap['complete'], retry)
                self.assertEqual(stats['attempts'], 2 if retry else 1)
                self.assertEqual(api.call_count, 4 if retry else 1)

    def test_invalid_timeout_and_deadline_never_reach_urlopen(self):
        for value in (0, -1, float('nan'), float('inf'), -float('inf'), 1e20, 10 ** 1000, None, True, '20'):
            with self.subTest(timeout=value):
                snap, stats, api = self.roster([], timeout=value)
                self.assertFalse(snap['complete'])
                self.assertIn('invalid timeout', stats['last_error'])
                self.assertEqual(stats['attempts'], 0)
                api.assert_not_called()
                with patch.object(active.urllib.request, 'urlopen') as direct:
                    status, reason = active._control_get('/threads', timeout=value)
                self.assertEqual(status, 0)
                self.assertIn('invalid timeout', reason)
                direct.assert_not_called()
        for value in (0, -1, float('nan'), float('inf'), True, '600'):
            with self.subTest(deadline=value):
                snap, stats, api = self.roster([], deadline=value)
                self.assertFalse(snap['complete'])
                self.assertIn('budget exhausted' if value in (0, -1) else 'invalid deadline', stats['last_error'])
                self.assertEqual(stats['attempts'], 0)
                api.assert_not_called()

    def test_budget_exhaustion_during_request_or_backoff_stops_without_bad_timeout(self):
        for elapsed, body in [(20, TimeoutError()), (19, TimeoutError()),
                              (20, dict(ok=True, threads=[], total=0))]:
            with self.subTest(elapsed=elapsed, body=body):
                self.clock.now = 0
                snap, stats, api = self.roster([(elapsed, body)], deadline=20)
                self.assertFalse(snap['complete'])
                self.assertIn('budget exhausted', stats['last_error'])
                self.assertEqual(api.call_count, 1)
                self.assertEqual(stats['seconds'], 20)
                self.assertEqual(api.call_args.kwargs['timeout'], 20)

    def test_budget_exhaustion_preserves_last_transport_cause_across_all_retry_stages(self):
        error = urllib.error.URLError(OSError(22, 'Invalid argument'))
        empty = dict(ok=True, threads=[], total=0)
        cases = [
            ('first request', [(20, error)], 1),
            ('first backoff', [(19, error)], 1),
            ('second request', [(1, error), (17, error)], 2),
            ('second backoff', [(1, error), (13, error)], 2),
            ('native read after recovery', [(1, error), (17, empty)], 2),
        ]
        for stage, outcomes, attempts in cases:
            with self.subTest(stage=stage):
                self.clock.now = 0
                snap, stats, api = self.roster(outcomes, deadline=20)
                self.assertFalse(snap['complete'])
                self.assertIn('budget exhausted', stats['last_error'])
                self.assertIn('last transport error: control api active: URLError -> OSError [Errno 22] Invalid argument',
                              stats['last_error'])
                self.assertEqual(stats['attempts'], attempts)
                self.assertEqual(stats['seconds'], 20)
                self.assertEqual(api.call_count, attempts)

    def test_pagination_failure_discards_partial_attempt_and_restarts_at_page_one(self):
        row = dict(threadId='old', state='idle', worktreePath='/old', updatedAt='2026-11-01T00:00:00Z')
        pages = [(200, dict(ok=True, threads=[row], total=2, nextCursor='next')),
                 (0, active.ReadError('timed out', TimeoutError())),
                 (200, dict(ok=True, threads=[], total=0)),
                 (200, dict(ok=True, threads=[], total=0))]
        stats = {}
        with patch.object(active, '_control_get', side_effect=pages) as api:
            rows, error = active.robob_active(max_attempts=3, deadline=600, stats=stats)
        self.assertEqual((rows, error), ({}, None))
        self.assertEqual(stats['attempts'], 2)
        self.assertIn('cursor=next', api.call_args_list[1].args[0])
        self.assertNotIn('cursor=', api.call_args_list[2].args[0])

    def test_native_failure_never_publishes_the_completed_active_roster(self):
        row = dict(threadId='active', state='running', worktreePath='/work')
        pages = [(200, dict(ok=True, threads=[row], total=1)),
                 (0, active.ReadError('connection reset', ConnectionResetError()))] * 3
        stats = {}
        with patch.object(active, '_control_get', side_effect=pages) as api:
            rows, error = active.robob_active(max_attempts=3, deadline=600, stats=stats)
        self.assertIsNone(rows)
        self.assertEqual(error, 'control api native: ConnectionResetError after 3 attempts, 7.0 s')
        self.assertEqual(stats['attempts'], 3)
        self.assertEqual(api.call_count, 6)

    def test_transport_failure_at_each_traversal_boundary_retries_with_remaining_run_budget(self):
        empty = (200, dict(ok=True, threads=[], total=0))
        cases = [('active', 'walk', [20] * 8, 20),
                 ('native', 'walk', [55] * 3, 15),
                 ('active', 'catch-up', [20] * 8, 20),
                 ('native', 'catch-up', [55] * 3, 15)]
        for source, phase, durations, last_duration in cases:
            self.clock.now = 0
            pages = [(0, empty)] if source == 'native' else []
            for index, seconds in enumerate(durations):
                row = dict(threadId=str(index), state='idle', updatedAt='2026-11-01T00:00:00Z')
                main_complete = phase == 'catch-up' and index == 0
                pages.append((seconds, (200, dict(ok=True, threads=[row], total=1 if main_complete else 100,
                                                 nextCursor=None if main_complete else f'cursor-{index}'))))
            pages.append((last_duration, (0, active.ReadError('<urlopen error [Errno 22] Invalid argument>',
                                                           urllib.error.URLError(OSError(22, 'Invalid argument'))))))
            pages += [(0, empty), (0, empty)]
            outcomes = iter(pages)

            def request(path, timeout):
                elapsed, result = next(outcomes)
                self.assertLessEqual(elapsed, timeout)
                self.clock.now += elapsed
                return result

            stats = {}
            with self.subTest(source=source, phase=phase), patch.object(active, '_control_get', side_effect=request):
                rows, error = active.robob_active(max_attempts=3, deadline=600, stats=stats)
            self.assertEqual((rows, error), ({}, None))
            self.assertEqual(stats['attempts'], 2)
            self.assertEqual(stats['seconds'], 182)
            self.assertEqual(stats['last_error'],
                             f'control api {source}: URLError -> OSError [Errno 22] Invalid argument '
                             'after 1 attempts, 180.0 s')

    def test_hourly_scan_audits_liveness_on_success_and_failure_and_shares_deadline(self):
        cases = [
            ('recovered', [(20, TimeoutError()), (20, TimeoutError()),
                           (1, dict(ok=True, threads=[], total=0))], 600, 3, 48, False, 'TimeoutError'),
            ('exhausted', [(20, TimeoutError())] * 3, 600, 3, 67, True, 'TimeoutError'),
            ('budget', [(20, urllib.error.URLError(OSError(22, 'Invalid argument')))],
             20, 1, 20, True, 'last transport error: control api active: URLError -> OSError [Errno 22] Invalid argument'),
        ]
        for label, outcomes, budget, attempts, seconds, fails, cause in cases:
            self.clock.now = 0
            lp = janitor.leftover_processes
            with self.subTest(label=label), self.request(outcomes), \
                    patch.object(lp, 'OBSERVATION_BUDGET', budget), \
                    patch.object(janitor, 'procs', return_value=[]), \
                    patch.object(janitor, 'sh', return_value=(1, '', '')), \
                    patch.object(janitor, 'keep_list', return_value=[]), \
                    patch.object(lp, 'scan', return_value=lp.unavailable_report('fixture')) as process_scan, \
                    patch.object(janitor, 'AUDIT', str(self.root / 'audit.jsonl')), \
                    patch.object(janitor, 'LOG_DIR', str(self.root)), \
                    patch.object(janitor, 'LAST', str(self.root / 'last.json')):
                report = janitor.scan()
                janitor.record_report(report)
            audit = json.loads((self.root / 'audit.jsonl').read_text().splitlines()[-1])
            self.assertEqual(audit['liveness']['attempts'], attempts)
            self.assertEqual(audit['liveness']['seconds'], seconds)
            self.assertIn(cause, audit['liveness']['last_error'])
            self.assertEqual(bool(audit['liveness_unavailable']), fails)
            if fails:
                self.assertIn(cause, audit['liveness_unavailable'])
            self.assertEqual(process_scan.call_args.kwargs['deadline'], budget)
            self.assertIs(process_scan.call_args.kwargs['liveness'], report['liveness'])


GOOD = dict(complete=True, threads={}, opencode={'ses_abcdefgh'},
            workspaces={'native': '/work/native'}, problems=[])


class DirectoryRetryTests(JanitorTestCase):
    def setUp(self):
        self.clock = Clock()
        for name, value in [('monotonic', lambda: self.clock.now), ('sleep', self.clock.sleep)]:
            p = patch.object(active.time, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(active, '_password', return_value=None)
        p.start()
        self.addCleanup(p.stop)

    def lookup(self, ids, outcomes, **kwargs):
        def request(req, timeout):
            elapsed, outcome = next(outcomes)
            self.clock.now += elapsed
            if isinstance(outcome, Exception):
                raise outcome
            return io.StringIO(json.dumps(outcome))
        stats = {}
        with patch.object(active.urllib.request, 'urlopen', side_effect=request) as api:
            result = active.opencode_directories(ids, stats=stats, **kwargs)
        return result, stats, api

    def test_two_timeouts_then_success_returns_complete_map_and_attempt_stats(self):
        (dirs, error), stats, api = self.lookup(['ses_abcdefgh'], iter([
            (20, TimeoutError()), (20, TimeoutError()), (1, {'data': {'location': {'directory': '/work'}}})]))
        self.assertEqual((dirs, error), ({'ses_abcdefgh': '/work'}, None))
        self.assertEqual(stats['attempts'], 3)
        self.assertEqual(stats['resolved'], 1)
        self.assertEqual(stats['seconds'], 48)
        self.assertEqual(stats['per_id_max_s'], 48)
        self.assertEqual(self.clock.sleeps, [2, 5])
        self.assertEqual([c.kwargs['timeout'] for c in api.call_args_list], [20, 20, 20])

    def test_retry_exhaustion_discards_previously_resolved_ids(self):
        (dirs, error), stats, _ = self.lookup(['a', 'ses_abcdefgh'], iter([
            (1, {'data': {'directory': '/a'}}),
            (20, TimeoutError()), (20, TimeoutError()), (14.2, TimeoutError())]))
        self.assertIsNone(dirs)
        self.assertEqual(error, 'opencode-service directory: ses_abcd TimeoutError after 3 attempts, 61.2 s')
        self.assertEqual(stats['last_error'], error)
        self.assertEqual((stats['attempts'], stats['opencode_ids'], stats['resolved']), (4, 2, 1))

    def test_deadline_mid_list_caps_request_and_discards_map_even_on_late_success(self):
        for outcome in (TimeoutError(), {'data': {'directory': '/b'}}):
            with self.subTest(outcome=outcome):
                self.clock.now = 0
                (dirs, error), stats, api = self.lookup(['a', 'b', 'c'], iter([
                    (4, {'data': {'directory': '/a'}}), (6, outcome)]), timeout=45, overall_timeout=10)
                self.assertIsNone(dirs)
                self.assertIn('b overall deadline exceeded', error)
                self.assertEqual([c.kwargs['timeout'] for c in api.call_args_list], [10, 6])
                self.assertEqual(stats['resolved'], 1)
                self.assertEqual(stats['seconds'], 10)

    def test_deadline_before_next_id_and_during_backoff_prevents_another_request(self):
        for elapsed, outcome, expected_attempts in [
                (9, {'data': {'directory': '/a'}}, 2), (9, TimeoutError(), 1)]:
            with self.subTest(outcome=outcome):
                self.clock.now = 0
                (dirs, error), stats, api = self.lookup(['a', 'b'], iter([
                    (elapsed, outcome), (1, TimeoutError())]), overall_timeout=10)
                self.assertIsNone(dirs)
                self.assertIn('overall deadline exceeded', error)
                self.assertEqual(api.call_count, expected_attempts)
                self.assertEqual(stats['seconds'], 10)
        (dirs, error), _, api = self.lookup(['a'], iter([]), overall_timeout=0)
        self.assertIsNone(dirs)
        self.assertIn('after 0 attempts', error)
        api.assert_not_called()

    def test_transport_forms_retry_but_http_and_malformed_responses_fail_closed(self):
        failures = [
            (ConnectionResetError(), True),
            (urllib.error.URLError(TimeoutError()), True),
            (urllib.error.URLError('connection refused'), True),
            (urllib.error.HTTPError('http://test', 404, 'gone', {}, None), False),
            (urllib.error.HTTPError('http://test', 401, 'unauthorized', {}, None), False),
            ({'data': {'location': {'directory': ''}}}, False),
            ({'data': {'location': 'bad'}}, False),
            ({'data': None}, False),
            ([], False),
        ]
        for failure, retry in failures:
            with self.subTest(failure=failure):
                (dirs, error), stats, api = self.lookup(['s'], iter([
                    (0, failure), (0, {'data': {'directory': '/work'}})]))
                self.assertEqual(api.call_count, 2 if retry else 1)
                self.assertEqual(stats['resolved'], int(retry))
                if retry:
                    self.assertEqual((dirs, error), ({'s': '/work'}, None))
                else:
                    self.assertIsNone(dirs)
                    self.assertTrue(error)

    def test_directories_forwards_budget_and_never_publishes_native_partial_map(self):
        stats = {}
        with patch.object(active, 'opencode_directories', return_value=(None, 'unresolved')) as lookup:
            self.assertEqual(active.directories(GOOD, timeout=45, overall_timeout=300, stats=stats),
                             (None, 'unresolved'))
        lookup.assert_called_once_with(GOOD['opencode'], timeout=45, overall_timeout=300,
                                       max_attempts=3, stats=stats)

    def test_location_shapes_cannot_fall_back_from_malformed_location(self):
        cases = [
            ({'directory': '/legacy'}, '/legacy'),
            ({'location': None, 'directory': '/legacy'}, '/legacy'),
            ({'location': {}, 'directory': '/legacy'}, '/legacy'),
            ({'location': {'directory': '/current'}, 'directory': '/legacy'}, '/current'),
            ({'location': {'directory': ''}, 'directory': '/legacy'}, None),
            ({'location': {'directory': None}, 'directory': '/legacy'}, None),
            ({'location': {'directory': 123}, 'directory': '/legacy'}, None),
            ({'location': {'directory': []}, 'directory': '/legacy'}, None),
            ({}, None),
        ]
        cases += [({'location': value, 'directory': '/legacy'}, None)
                  for value in ('bad', '', [], ['/path'], False, 0, 1)]
        for data, expected in cases:
            with self.subTest(data=data):
                (dirs, error), stats, api = self.lookup(['s'], iter([(0, {'data': data})]))
                self.assertEqual(api.call_count, 1)
                if expected is None:
                    self.assertIsNone(dirs)
                    self.assertIn('session directory unavailable after 1 attempts', error)
                    self.assertEqual(stats['resolved'], 0)
                else:
                    self.assertEqual((dirs, error), ({'s': expected}, None))

    def test_hourly_janitor_keeps_twenty_second_single_attempt_budget(self):
        with patch.object(active.urllib.request, 'urlopen', side_effect=TimeoutError()) as api:
            ids, dirs, error = janitor.running_sessions(GOOD)
        self.assertIsNone(ids)
        self.assertEqual(dirs, {})
        self.assertIn('after 1 attempts', error)
        self.assertEqual(api.call_count, 1)
        self.assertEqual(api.call_args.kwargs['timeout'], 20)
        self.assertEqual(self.clock.sleeps, [])


class ReaperLivenessTests(JanitorTestCase):
    def setUp(self):
        self.clock = Clock()
        for name, value in [('monotonic', lambda: self.clock.now), ('sleep', self.clock.sleep)]:
            p = patch.object(reaper.time, name, value)
            p.start()
            self.addCleanup(p.stop)

    def run_reaper(self, results):
        def directories(snap, **kwargs):
            error = next(results)
            kwargs['stats'].update(attempts=3 if error else 1, resolved=0 if error else 1,
                                   per_id_max_s=7, last_error=error)
            self.clock.now += 7
            return (None, error) if error else ({'session': '/work'}, None)
        with patch.object(active, 'checked_snapshot', side_effect=[GOOD, {**GOOD, 'opencode': {'new'}}]) as roster, \
                patch.object(active, 'directories', side_effect=directories) as lookup, \
                patch.object(reaper, 'session_activity', return_value={}), \
                patch.object(reaper, 'discover', return_value=[]) as discover, \
                patch.object(reaper, 'process_cwds', return_value=[]), \
                patch.object(reaper, 'keep_list', return_value=[]), \
                patch.object(reaper, 'archive_ignored') as archive, \
                patch.object(reaper, 'git') as git, \
                patch.object(reaper.os, 'getloadavg', side_effect=[(90, 80, 70), (30, 40, 50)]), \
                patch.object(sys, 'argv', ['reaper', '--dry-run']), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            code = reaper.main()
        archive.assert_not_called()
        git.assert_not_called()
        self.assertEqual(roster.call_count, 2)
        self.assertEqual(lookup.call_args_list[1].args[0]['opencode'], {'new'})
        self.assertTrue(all(c.kwargs['timeout'] == 45 and c.kwargs['overall_timeout'] == 300
                            for c in lookup.call_args_list))
        self.assertEqual(self.clock.sleeps, [60])
        return code, json.loads(out.getvalue()), discover

    def test_step_failure_then_retry_success_continues_with_fresh_roster(self):
        code, status, discover = self.run_reaper(iter(['transient timeout', None]))
        self.assertEqual(code, 0)
        self.assertEqual(status['state'], 'done')
        self.assertTrue(status['liveness']['retried_step'])
        self.assertEqual(status['liveness']['attempts'], 4)
        self.assertEqual(status['liveness']['resolved'], 1)
        self.assertEqual(status['liveness']['seconds'], 74)
        self.assertEqual(status['liveness']['last_error'], 'transient timeout')
        discover.assert_called_once()

    def test_two_failures_keep_everything_and_report_exact_reason_stats_and_load(self):
        reason = 'opencode-service directory: ses_abcd TimeoutError after 3 attempts, 61.2 s'
        code, status, discover = self.run_reaper(iter(['first failure', reason]))
        self.assertEqual(code, 1)
        self.assertEqual(status['errors'], ['RuntimeError: liveness_unavailable: ' + reason])
        self.assertEqual(status['liveness'], dict(attempts=6, opencode_ids=1, resolved=0, seconds=74,
                                                per_id_max_s=7, retried_step=True, last_error=reason))
        self.assertEqual(status['load_avg'], dict(start=[90, 80, 70], end=[30, 40, 50]))
        self.assertEqual(status['removed'], [])
        self.assertEqual(status['would_remove'], [])
        discover.assert_not_called()

    def test_only_reaper_history_gets_three_hundred_seconds(self):
        history = reaper.Activity({}, {'p': '/repo'}, {}, None)
        history.commons = {'p': '/repo.git'}
        with patch.object(active, 'project_activity', return_value=({}, None)) as read:
            reaper.activity_for_repo('/repo.git', history, 100, ['/repo'])
        self.assertEqual(read.call_args.kwargs['traversal_timeout'], 300)
        with patch.object(active, '_control_threads', return_value=({}, None)) as walk:
            active.project_activity('p', '/repo', 0, traversal_timeout=300)
            active.robob_active()
        self.assertEqual([c.kwargs.get('traversal_timeout', active.CONTROL_TRAVERSAL_TIMEOUT)
                          for c in walk.call_args_list], [300, 300, 180, 180])
        self.assertEqual(active.CONTROL_MAX_PAGES, 400)


if __name__ == '__main__':
    unittest.main()
