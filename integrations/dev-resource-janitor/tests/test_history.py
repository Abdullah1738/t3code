import json
from pathlib import Path
import sys
import tempfile
import unittest
from janitor_test_safety import JanitorTestCase
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skill/scripts'))
import active_sessions as active
import worktree_reaper as reaper


def session(sid, directory, updated=1000):
    return {'id': sid, 'location': {'directory': directory}, 'time': {'updated': updated}}


class HistoryTests(JanitorTestCase):
    def test_session_history_follows_every_cursor_and_maps_location_and_activity(self):
        pages = [{'data': [session('a', '/w', 3000)], 'cursor': {'next': 'next'}},
                 {'data': [session('b', '/w', 2000), session('c', '/other')], 'cursor': {'next': None}}]
        with patch.object(active, 'opencode_get', side_effect=pages) as api:
            paths, stats, error = active.session_history()
        self.assertIsNone(error)
        self.assertEqual(paths, {'/w': 3, '/other': 1})
        self.assertEqual({key: stats[key] for key in ('sessions', 'pages')}, {'sessions': 3, 'pages': 2})
        self.assertIn('cursor=next', api.call_args_list[1].args[0])

    def test_missing_fields_cursor_repeat_and_failure_never_return_partial_history(self):
        bad_pages = [
            [{'data': [session('a', '/w')]}],
            [{'data': [{'id': 'a'}], 'cursor': {'next': None}}],
            [{'data': [session('a', '/w')], 'cursor': {'next': 'a'}},
             {'data': [session('b', '/w')], 'cursor': {'next': 'a'}}],
            [RuntimeError('down')],
        ]
        for pages in bad_pages:
            with self.subTest(pages=pages), patch.object(active, 'opencode_get', side_effect=pages):
                paths, stats, error = active.session_history()
                self.assertIsNone(paths)
                self.assertEqual(stats, {})
                self.assertTrue(error)

    def test_project_activity_reads_live_and_archived_and_resolves_root_workspace(self):
        responses = [({'a': {'updatedAt': '2026-10-01T00:00:00Z', 'worktreePath': '/work/tree'}}, None),
                     ({'b': {'updatedAt': '2026-11-01T00:00:00Z', 'worktreePath': None}}, None)]
        with patch.object(active, '_control_threads', side_effect=responses) as api:
            paths, error = active.project_activity('project', '/root', 10)
        self.assertIsNone(error)
        self.assertEqual(set(paths), {'/work/tree', '/root'})
        queries = [parse_qs(urlparse(call.args[0]).query) for call in api.call_args_list]
        self.assertEqual(queries[0]['updatedSince'], ['10'])
        self.assertEqual(queries[1]['archived'], ['true'])

    def test_only_repo_with_incomplete_history_is_report_only(self):
        history = reaper.Activity({'/old': 1}, {'p1': '/root1', 'p2': '/root2'}, {}, None)
        history.commons = {'p1': '/repo1.git', 'p2': '/repo2.git'}
        with patch.object(active, 'project_activity', side_effect=[(None, 'truncated 500/900'), ({'/new': 20}, None)]):
            self.assertEqual(reaper.activity_for_repo('/repo1.git', history, 100, []), (None, 'truncated 500/900'))
            paths, error = reaper.activity_for_repo('/repo2.git', history, 100, [])
        self.assertIsNone(error)
        self.assertEqual(paths, {'/old': 1, '/new': 20})

    def test_project_root_coverage_class(self):
        forms = [
            ('/linked', {'p': '/repo.git'}, ['/linked'], True),
            ('/linked', {}, ['/linked'], True),
            ('/linked/subdir', {}, ['/linked'], True),
            ('/unrelated', {'p': '/other.git'}, ['/linked'], False),
        ]
        for root, commons, roster, expected in forms:
            with self.subTest(root=root, commons=commons):
                history = reaper.Activity({}, {'p': root}, {}, None)
                history.commons = commons
                with patch.object(active, 'project_activity', return_value=(None, 'history down')) as api:
                    paths, error = reaper.activity_for_repo('/repo.git', history, 100, roster)
                self.assertEqual(api.called, expected)
                self.assertEqual(error is not None, expected)

    def test_healthy_api_history_allows_original_sixty_day_rule(self):
        with patch.object(reaper.os.path, 'isdir', return_value=True), \
                patch.object(reaper, 'git', return_value=(1, '', 'no head')):
            value = reaper.evaluate({'worktree': '/work', 'common': '/repo', 'main': False}, 100, set(), {'/work': 99}, [], [])
        self.assertFalse(any('history_unavailable' in reason for reason in value['reasons']))

    def test_full_then_incremental_and_daily_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = str(Path(tmp) / 'history.json')
            pages = [{'data': [session('a', '/w', 3000)], 'cursor': {'next': 'next'}},
                     {'data': [session('b', '/other', 1000)], 'cursor': {'next': None}}]
            with patch.object(active, 'opencode_get', side_effect=pages):
                paths, stats, err = active.session_history(cache, write_cache=True, now=10)
            self.assertIsNone(err)
            self.assertEqual(stats['mode'], 'full')
            self.assertEqual(stats['pages'], 2)
            # First changed page still includes an older row. Only a WHOLE older
            # page can end the scan, and old directories remain protected.
            changes = [{'data': [session('c', '/new', 4000), session('d', '/w', 2000)], 'cursor': {'next': 'next'}},
                       {'data': [session('b', '/other', 1000)], 'cursor': {'next': 'unused'}}]
            with patch.object(active, 'opencode_get', side_effect=changes) as api:
                paths, stats, err = active.session_history(cache, write_cache=True, now=20)
            self.assertIsNone(err)
            self.assertEqual(api.call_count, 2)
            self.assertEqual(paths, {'/w': 3, '/other': 1, '/new': 4})
            self.assertEqual(stats['mode'], 'incremental')
            self.assertEqual(json.loads(Path(cache).read_text())['full_at'], 10)
            with patch.object(active, 'opencode_get', return_value={'data': [], 'cursor': {'next': None}}):
                paths, stats, err = active.session_history(cache, now=86411)
            self.assertIsNone(err)
            self.assertEqual(stats['mode'], 'full')
            self.assertEqual(paths, {})

    def test_bad_incremental_cursor_rebuilds_once_and_read_only_does_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / 'history.json'
            value = dict(version=1, service=active.OC_SERVICE_URL, full_at=10, high_water=3000, directories={'/old': 3})
            cache.write_text(json.dumps(value))
            pages = [RuntimeError('cursor failed'), {'data': [session('a', '/new', 5000)], 'cursor': {'next': None}}]
            with patch.object(active, 'opencode_get', side_effect=pages):
                paths, stats, err = active.session_history(str(cache), now=20)
            self.assertIsNone(err)
            self.assertEqual(paths, {'/new': 5})
            self.assertEqual(stats['mode'], 'full_after_incremental_error')
            self.assertEqual(json.loads(cache.read_text()), value)
            with patch.object(active, 'opencode_get', side_effect=RuntimeError('down')):
                paths, stats, err = active.session_history(str(cache), now=20)
            self.assertIsNone(paths)
            self.assertIn('down', err)
            self.assertEqual(json.loads(cache.read_text()), value)

    def test_removal_refresh_covers_viewed_and_idle_below_incremental_cutoff(self):
        # 1,001 old sessions: the fresh viewed/idle row is below two global
        # updated-time pages, but complete directory pages must still read it.
        for field in ('viewed', 'idle'):
            with self.subTest(field=field):
                old = [session(str(i), '/old/subdir', 2000 - i) for i in range(1001)]
                old[-1]['time'][field] = 100000
                pages = [{'data': old[:500], 'cursor': {'next': 'p2'}},
                         {'data': old[500:1000], 'cursor': {'next': 'p3'}},
                         {'data': old[1000:], 'cursor': {'next': None}}]
                history = reaper.Activity({'/old/subdir': 2}, {}, {'mode': 'incremental'}, None)
                history.commons = {}
                def api(path):
                    query = parse_qs(urlparse(path).query)
                    self.assertIn('directory', query)
                    if query['directory'] == ['/old/subdir']:
                        return pages.pop(0)
                    return {'data': [], 'cursor': {'next': None}}
                with patch.object(reaper, 'session_activity', return_value=history), \
                        patch.object(reaper, 'activity_for_repo', return_value=(dict(history), None)), \
                        patch.object(active, 'opencode_get', side_effect=api):
                    paths = reaper.removal_activity('/repo.git', '/old', 100)
                self.assertEqual(paths['/old/subdir'], 100)
                self.assertEqual(pages, [])

    def test_removal_refresh_directory_failures_keep_worktree(self):
        history = reaper.Activity({'/old': 1}, {}, {'mode': 'incremental'}, None)
        for response in (RuntimeError('down'), {'data': [session('a', '/wrong')], 'cursor': {'next': None}}):
            with self.subTest(response=response), \
                    patch.object(reaper, 'session_activity', return_value=history), \
                    patch.object(reaper, 'activity_for_repo', return_value=(dict(history), None)), \
                    patch.object(active, 'opencode_get', side_effect=[response]):
                self.assertIsNone(reaper.removal_activity('/repo.git', '/old', 100))

    def test_delegated_query_is_filtered_to_live_states(self):
        with patch.object(active, '_control_threads', return_value=({}, None)) as api:
            rows, error = active.robob_active(now_ms=10000)
        self.assertIsNone(error)
        query = parse_qs(urlparse(api.call_args_list[1].args[0]).query)
        self.assertNotIn('state', query)
        self.assertEqual(query['creationSource'], ['provider'])


if __name__ == '__main__':
    unittest.main()
