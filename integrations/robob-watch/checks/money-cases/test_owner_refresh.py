"""Owner snapshots use loopback fixtures and private data dirs only."""
import os
os.environ.setdefault('ROBOB_TEST', '1')
import datetime as dt
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import owner_refresh as owner
import charges
import state_json
from test_charges import ControlServer, summary
from test_cases import Base, mc, finder


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name)
        self.now = dt.datetime.now(dt.timezone.utc)
        self.since = self.now - dt.timedelta(hours=24)
        self.thread = {'threadId': 'a', 'title': 'App', 'updatedAt': charges.iso(self.now)}
        self.row = summary('I paid Acme', createdAt=charges.iso(self.now - dt.timedelta(minutes=1)))

    def server(self, **kw):
        return ControlServer([self.row], threads=[self.thread], **kw)

    def seed(self):
        with self.server():
            self.assertEqual(owner.refresh(self.data, self.since), 'ok')
        return (self.data / 'owner-snapshot.json').read_bytes()

    def test_slow_lists_refresh_but_cache_reads_have_no_network_dependency(self):
        with self.server(list_delay=.12), patch.object(charges, 'OWNER_REQUEST_TIMEOUT', .03), \
                patch.object(owner, 'REQUEST_TIMEOUT', .8):
            started = time.monotonic()
            self.assertEqual(owner.refresh(self.data, self.since, budget=4), 'ok')
            self.assertGreater(time.monotonic() - started, .2)
        with patch.object(charges, 'control_get', side_effect=AssertionError('check made a live request')):
            stats = {}
            rows = charges.owner_texts(self.since, self.now, stats=stats, cache_path=self.data / 'owner-texts.json')
        self.assertEqual([r[1] for r in rows], ['I paid Acme'])
        self.assertEqual(stats['owner_source'], 'cache')
        self.assertEqual(stats['owner_result'], 'ok')
        self.assertEqual(stats['owner_refresh_result'], 'ok')
        self.assertLess(stats['owner_cache_age_s'], 5)

    def test_missing_stale_corrupt_or_uncovered_snapshot_never_returns_texts(self):
        self.seed()
        path = self.data / 'owner-snapshot.json'
        good = json.loads(path.read_text())
        for kind in ('missing', 'corrupt', 'old_version', 'stale', 'future', 'uncovered'):
            with self.subTest(kind=kind):
                obj = {**good}
                if kind == 'missing':
                    path.unlink(missing_ok=True)
                elif kind == 'corrupt':
                    path.write_text('{broken')
                else:
                    if kind == 'old_version': obj['version'] = 0
                    if kind == 'stale': obj.update(as_of=(self.now - dt.timedelta(seconds=1801)).isoformat(), rows=[])
                    if kind == 'future': obj['as_of'] = (self.now + dt.timedelta(hours=1)).isoformat()
                    if kind == 'uncovered': obj['since'] = (self.since + dt.timedelta(seconds=1)).isoformat()
                    path.write_text(json.dumps(obj))
                with self.assertRaises(charges.Lookup), patch.object(owner, 'launch', side_effect=AssertionError('write in read')):
                    charges.owner_texts(self.since, self.now, cache_path=self.data / 'owner-texts.json', write_cache=False)

    def test_incremental_refresh_merges_threads_and_falls_back_for_older_window(self):
        self.thread['updatedAt'] = charges.iso(self.now - dt.timedelta(minutes=10))
        self.seed()
        previous = owner.snapshot(self.data)
        later = dt.datetime.now(dt.timezone.utc)
        new = {'threadId': 'b', 'title': 'New', 'updatedAt': charges.iso(later + dt.timedelta(seconds=1))}
        with ControlServer(threads=[self.thread, new], strict_threads=True) as server:
            server.rows['a'] = [self.row]
            server.rows['b'] = [summary('I ordered Apple', createdAt=charges.iso(later))]
            self.assertEqual(owner.refresh(self.data, self.since), 'ok')
            params = [params for path, params, _ in server.calls if path.endswith('/threads') and 'ids' not in params]
            expected = charges.owner_time(previous['as_of']) - dt.timedelta(minutes=2, milliseconds=1)
            self.assertTrue(all(p['updatedSince'][0] == charges.iso(expected) for p in params))
            self.assertEqual(set(owner.snapshot(self.data)['threads']), {'a', 'b'})
            self.assertEqual(len(owner.snapshot(self.data)['rows']), 2)
            server.calls.clear()
            older = self.since - dt.timedelta(days=1)
            self.assertEqual(owner.refresh(self.data, older), 'ok')
            params = [params for path, params, _ in server.calls if path.endswith('/threads') and 'ids' not in params]
            self.assertTrue(all(p['updatedSince'][0] == charges.iso(older - dt.timedelta(milliseconds=1)) for p in params))

    def test_incremental_membership_reconciles_removals_and_title_exclusions(self):
        for change in ('deleted', 'archived', 'Moni', 'Group', 'subagent'):
            with self.subTest(change=change):
                self.seed()
                with self.server() as server:
                    if change == 'deleted': server.threads.clear()
                    elif change == 'archived': server.threads[0]['archived'] = True
                    elif change == 'subagent': server.threads[0]['subagent'] = True
                    else: server.threads[0]['title'] = change + ' chat'
                    self.assertEqual(owner.refresh(self.data, self.since), 'ok')
                    self.assertTrue(any('ids' in params for path, params, _ in server.calls))
                self.assertEqual(owner.snapshot(self.data)['rows'], [])
                self.assertEqual(owner.snapshot(self.data)['threads'], {})

    def test_failed_or_partial_refresh_preserves_complete_snapshot_and_age(self):
        before = self.seed()
        for failure in ('list', 'messages', 'provenance'):
            with self.subTest(failure=failure), self.server() as server:
                # Force a changed thread so the old per-thread cache cannot hide the failure.
                server.threads[0]['updatedAt'] = charges.iso(self.now + dt.timedelta(seconds=1))
                if failure == 'list': server.responses['/api/ardud/control/threads'] = {'ok': False}
                if failure == 'messages': server.responses['/api/ardud/control/threads/a/messages'] = {'ok': True, 'messages': [], 'total': 1}
                if failure == 'provenance': server.rows['a'][0].pop('automated', None)
                self.assertNotEqual(owner.refresh(self.data, self.since), 'ok')
                self.assertEqual((self.data / 'owner-snapshot.json').read_bytes(), before)
                self.assertNotEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'ok')
                self.assertEqual(len(charges.owner_texts(self.since, self.now, cache_path=self.data / 'owner-texts.json')), 1)

    def test_lock_contention_and_dead_pid_metadata_are_safe(self):
        fd = owner.take_lock(self.data)
        try:
            owner.mark_lock(fd, os.getpid())
            with patch.object(charges, 'live_owner_texts', side_effect=AssertionError('contended refresh read API')):
                self.assertEqual(owner.refresh(self.data, self.since), 'busy')
                with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}):
                    self.assertEqual(owner.launch(self.data, self.since), 'busy')
        finally:
            os.close(fd)
        (self.data / 'owner-refresh.lock').write_text(json.dumps({'pid': 99999999, 'started_at': 1}))
        with self.server():
            self.assertEqual(owner.refresh(self.data, self.since), 'ok')
        lock = json.loads((self.data / 'owner-refresh.lock').read_text())
        self.assertEqual(lock['pid'], os.getpid())
        self.assertGreater(lock['started_at'], 1)

    def test_list_timeout_is_logged_without_renewing_the_snapshot(self):
        before = self.seed()
        with self.server(list_delay=1), patch.object(owner, 'REQUEST_TIMEOUT', .05):
            self.assertEqual(owner.refresh(self.data, self.since, budget=3), 'list_failed')
        self.assertEqual((self.data / 'owner-snapshot.json').read_bytes(), before)
        stats = owner.refresh_stats(self.data)
        self.assertEqual(stats['owner_refresh_timeouts'], 1)
        self.assertEqual(stats['owner_refresh_result'], 'list_failed')
        self.assertGreater(stats['owner_refresh_ms'], 0)

    def test_interrupted_atomic_publication_preserves_previous_complete_file(self):
        before = self.seed()
        replace = state_json.os.replace
        def interrupted(src, dst):
            if Path(dst).name == 'owner-snapshot.json':
                raise OSError('interrupted before replace')
            return replace(src, dst)
        with self.server(), patch.object(state_json.os, 'replace', interrupted):
            self.assertEqual(owner.refresh(self.data, self.since), 'error')
        self.assertEqual((self.data / 'owner-snapshot.json').read_bytes(), before)
        self.assertEqual(list(self.data.glob('.owner-snapshot.json.*')), [])
        self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')

    def test_detached_process_inherits_lock_and_recovers_after_crash(self):
        processes = []
        popen = subprocess.Popen
        def capture(*a, **kw):
            p = popen(*a, **kw)
            processes.append(p)
            return p
        with self.server(list_delay=.1), patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                patch.object(owner.subprocess, 'Popen', capture):
            self.assertEqual(owner.launch(self.data, self.since), 'started')
            self.assertEqual(owner.launch(self.data, self.since), 'busy')
            self.assertEqual(processes[0].wait(timeout=5), 0)
        self.assertIsNotNone(owner.snapshot(self.data))
        # A killed child closes its inherited lock; the inode/old PID is harmless.
        with self.server(list_delay=5), patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                patch.object(owner.subprocess, 'Popen', capture):
            self.assertEqual(owner.launch(self.data, self.since), 'started')
            processes[-1].kill()
            processes[-1].wait(timeout=2)
        fd = owner.take_lock(self.data)
        os.close(fd)


class CheckTests(Base):
    def test_scratch_check_never_launches_a_refresh_even_when_globally_enabled(self):
        now = dt.datetime.now(mc.TZ)
        self.data.mkdir()
        book = {'version': 1, 'questions': []}
        text = 'Purchase of AED 12.34 with Credit Card ending 1111 at Acme, Dubai.'
        mc.new_question(book, charges.parse(text, 'EmiratesNBD'), text, now, now, 'sms')
        mc.write_json(self.data / 'questions.json', book)
        with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                patch.object(owner, 'launch', side_effect=AssertionError('scratch launched refresher')), \
                patch.object(mc.charges, 'search', return_value=[]):
            mc.check_command(self.wd, 'scratch', self.data)
        self.assertFalse((self.wd / 'scratch-books/owner-refresh.lock').exists())

    def test_check_starts_refresh_before_follow_and_reads_previous_result(self):
        now = dt.datetime.now(mc.TZ)
        self.data.mkdir()
        text = 'Purchase of AED 12.34 with Credit Card ending 1111 at Acme, Dubai.'
        book = {'version': 1, 'questions': []}
        mc.new_question(book, charges.parse(text, 'EmiratesNBD'), text, now - dt.timedelta(minutes=1), now, 'sms')
        (self.data / 'questions.json').write_text(json.dumps(book))
        thread = {'threadId': 'a', 'title': 'App', 'updatedAt': charges.iso(now)}
        row = summary('I paid Acme', createdAt=charges.iso(now - dt.timedelta(minutes=1)))
        sequence = []
        follow = mc.follow
        def launched(*a): sequence.append('launch'); return 'skipped'
        def followed(*a, **kw): sequence.append('follow'); return follow(*a, **kw)
        with ControlServer([row], threads=[thread], list_delay=.12) as server, \
                patch.object(owner, 'launch', launched), patch.object(mc, 'follow', followed), \
                patch.object(mc, 'CHECK_BUDGET', 11), patch.object(mc, 'FOLLOW_EACH', 1), \
                patch.object(charges, 'OWNER_REQUEST_TIMEOUT', .03), \
                patch.object(owner, 'REQUEST_TIMEOUT', .8):
            started = time.monotonic()
            mc.run_check(self.wd, 'before', self.data, self.root, now, finder())
            self.assertLess(time.monotonic() - started, mc.CHECK_BUDGET + 2)
            self.assertEqual(server.calls, [])
            self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'open')
            self.assertEqual(owner.refresh(self.data, now - dt.timedelta(hours=1), budget=4), 'ok')
            server.calls.clear()
            started = time.monotonic()
            mc.run_check(self.wd, 'after', self.data, self.root, now, finder())
            self.assertLess(time.monotonic() - started, mc.CHECK_BUDGET + 2)
            self.assertEqual(server.calls, [])
        self.assertEqual(sequence, ['launch', 'follow', 'launch', 'follow'])
        self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'closed')
        rows = [json.loads(line) for line in (self.wd / 'runs.jsonl').read_text().splitlines()]
        self.assertEqual([r['owner_result'] for r in rows], ['cache_missing', 'ok'])
        self.assertEqual(rows[-1]['owner_source'], 'cache')
        self.assertEqual(rows[-1]['owner_refresh_result'], 'ok')
