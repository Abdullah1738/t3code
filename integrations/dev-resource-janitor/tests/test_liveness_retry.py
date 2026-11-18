import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
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
