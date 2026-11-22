"""Owner snapshots use loopback fixtures and private data dirs only."""
import os
os.environ.setdefault('ROBOB_TEST', '1')
import datetime as dt
import errno
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

    def test_busy_launch_diagnostics_are_bounded_and_do_not_abort_the_caller(self):
        self.seed()
        fd = owner.take_lock(self.data)
        self.addCleanup(os.close, fd)
        def slow_read(path):
            time.sleep(.65)
            return path.read_text()
        for remaining in (.05, 1):
            with self.subTest(remaining=remaining), \
                    patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                    patch.object(owner.data_io, 'read_text', slow_read), \
                    owner.data_io.scope(time.time() + remaining):
                started = time.monotonic()
                self.assertEqual(owner.launch(self.data, self.since, stats={}), 'busy')
                self.assertLess(time.monotonic() - started, .3)
                self.assertFalse(owner.data_io.current_scope()['failed'])

    def test_failed_crash_status_write_preserves_the_only_attempt_journal(self):
        self.seed()
        fd = owner.take_lock(self.data)
        owner.mark_lock(fd, os.getpid())
        os.close(fd)
        before = (self.data / 'owner-refresh.lock').read_bytes()
        with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                patch.object(owner, 'write_json', side_effect=OSError('status write failed')), \
                patch.object(owner.subprocess, 'Popen') as spawn:
            self.assertEqual(owner.launch(self.data, self.since), 'error')
            spawn.assert_not_called()
        self.assertEqual((self.data / 'owner-refresh.lock').read_bytes(), before)
        self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')

    def test_owned_journal_read_error_does_not_erase_a_previous_crash(self):
        self.seed()
        fd = owner.take_lock(self.data)
        owner.mark_lock(fd, os.getpid())
        os.close(fd)
        before = (self.data / 'owner-refresh.lock').read_bytes()
        with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                patch.object(owner.os, 'read', side_effect=OSError('journal unavailable')), \
                patch.object(owner.subprocess, 'Popen') as spawn:
            stats = {}
            self.assertEqual(owner.launch(self.data, self.since, stats=stats), 'error')
            spawn.assert_not_called()
        self.assertEqual((self.data / 'owner-refresh.lock').read_bytes(), before)
        self.assertEqual(stats['owner_refresh_result'], 'error')
        self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')

    def test_first_launch_has_no_failed_attempt_and_partial_journals_fail_closed(self):
        held = []
        def hold(argv, **kwargs):
            held.append(os.dup(kwargs['pass_fds'][0]))
        with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                patch.object(owner.subprocess, 'Popen', side_effect=hold):
            try:
                stats = {}
                self.assertEqual(owner.launch(self.data, self.since, stats=stats), 'started')
                self.assertNotIn('owner_refresh_result', stats)
                self.assertFalse((self.data / 'owner-refresh.json').exists())
                self.assertNotIn('owner_refresh_result', owner.refresh_stats(self.data))
            finally:
                for fd in held: os.close(fd)
        self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')
        (self.data / 'owner-refresh.lock').write_text('{partial')
        self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')

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

    def test_publication_timeout_is_a_failure_after_a_successful_owner_read(self):
        before = self.seed()
        replace = state_json.os.replace
        def interrupted(src, dst):
            if Path(dst).name == 'owner-snapshot.json':
                raise failure
            return replace(src, dst)
        for failure in (charges.Lookup('Robob control: lookup over time'),
                        owner.data_io.DataUnavailable(self.data / 'owner-snapshot.json', 'deadline')):
            with self.subTest(error=type(failure).__name__), self.server(), \
                    patch.object(state_json.os, 'replace', interrupted):
                self.assertEqual(owner.refresh(self.data, self.since), 'error')
            self.assertEqual((self.data / 'owner-snapshot.json').read_bytes(), before)
            self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')
            self.assertEqual(list(self.data.glob('.owner-snapshot.json.*')), [])

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
    def test_post_lock_resource_errors_reach_analytics_without_an_owner_read(self):
        now = dt.datetime.now(mc.TZ)
        self.data.mkdir()
        thread = {'threadId': 'a', 'title': 'App', 'updatedAt': charges.iso(now)}
        row = summary('I paid Acme', createdAt=charges.iso(now - dt.timedelta(minutes=1)))
        # All failures after acquiring the lock are errors, including EAGAIN.
        targets = ((owner.os, 'read'), (owner, 'mark_lock'), (owner.subprocess, 'Popen'))
        for target, name in targets:
            with self.subTest(operation=name):
                with ControlServer([row], threads=[thread]):
                    self.assertEqual(owner.refresh(self.data, now - dt.timedelta(hours=1)), 'ok')
                before = (self.data / 'owner-snapshot.json').read_bytes()
                text = 'Purchase of AED 12.34 with Credit Card ending 1111 at Acme, Dubai.'
                book = {'version': 1, 'questions': []}
                mc.new_question(book, charges.parse(text, 'EmiratesNBD'), text,
                                now - dt.timedelta(minutes=1), now, 'sms')
                mc.write_json(self.data / 'questions.json', book)
                with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                        patch.object(target, name, side_effect=BlockingIOError(errno.EAGAIN, 'resource unavailable')), \
                        patch.object(mc, 'follow', return_value=[]), \
                        patch('marketplace.launch_refresh', return_value='skipped'), \
                        patch.object(charges, 'owner_texts', side_effect=AssertionError('unexpected owner read')), \
                        patch.object(mc, 'record_event') as log:
                    mc.run_check(self.wd, name, self.data, self.root, now, finder())
                check = next(c for c in log.call_args_list if c.args[0] == 'check.run')
                self.assertEqual(check.kwargs['props']['owner_refresh_result'], 'error')
                report = mc.run_history.summary(self.wd, '24h')
                self.assertEqual(report['owner']['last_refresh']['owner_refresh_result'], 'error')
                self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')
                self.assertEqual((self.data / 'owner-snapshot.json').read_bytes(), before)

    def test_detached_failures_reach_check_and_runs_without_renewing_the_snapshot(self):
        now = dt.datetime.now(mc.TZ)
        since = now - dt.timedelta(hours=1)
        self.data.mkdir()
        thread = {'threadId': 'a', 'title': 'App', 'updatedAt': charges.iso(now)}
        row = summary('I paid Acme', createdAt=charges.iso(now - dt.timedelta(minutes=1)))
        popen = subprocess.Popen
        for failure in ('spawn', 'exit', 'signal'):
            with self.subTest(failure=failure):
                with ControlServer([row], threads=[thread]):
                    self.assertEqual(owner.refresh(self.data, since), 'ok')
                before = (self.data / 'owner-snapshot.json').read_bytes()
                processes = []
                launches = []
                def early_child(argv, **kwargs):
                    # Exit before importing owner_refresh, retaining the real inherited lock.
                    proc = popen([argv[0], '-I', '-B', '-c',
                                  'raise SystemExit(1)' if failure == 'exit' else 'import time; time.sleep(30)'],
                                 **kwargs)
                    processes.append(proc)
                    launches.append((Path(argv[3]).name, len(kwargs.get('pass_fds', ()))))
                    return proc
                with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                        patch.object(owner.subprocess, 'Popen', side_effect=(
                            OSError('private credential must not be logged') if failure == 'spawn' else early_child)):
                    owner.launch(self.data, since)
                if processes:
                    if failure == 'signal': processes[0].kill()
                    self.assertNotEqual(processes[0].wait(timeout=5), 0)
                self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')
                book = {'version': 1, 'questions': []}
                text = 'Purchase of AED 12.34 with Credit Card ending 1111 at Acme, Dubai.'
                mc.new_question(book, charges.parse(text, 'EmiratesNBD'), text,
                                now - dt.timedelta(minutes=1), now, 'sms')
                mc.write_json(self.data / 'questions.json', book)
                with patch.object(mc, 'record_event') as log:
                    mc.run_check(self.wd, failure, self.data, self.root, now, finder(), refresh_owner=False)
                check = next(c for c in log.call_args_list if c.args[0] == 'check.run')
                self.assertEqual(check.kwargs['props']['owner_refresh_result'], 'error')
                report = mc.run_history.summary(self.wd, '24h')
                self.assertEqual(report['owner']['last_refresh']['owner_refresh_result'], 'error')
                self.assertIn("'owner_refresh_result': 'error'", mc.run_history.format_summary(report))
                self.assertEqual((self.data / 'owner-snapshot.json').read_bytes(), before)
                self.assertNotIn('private credential', (self.wd / 'runs.jsonl').read_text())
                # The next check starts a new refresh before reading the old failure.
                # A live child must not hide the failed attempt it is replacing.
                mc.write_json(self.data / 'questions.json', book)
                failure = 'signal'
                with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                        patch.object(owner.subprocess, 'Popen', side_effect=early_child):
                    try:
                        mc.run_check(self.wd, 'retry', self.data, self.root, now, finder())
                        self.assertEqual(launches[-2:], [('owner_refresh.py', 1), ('marketplace_worker.py', 0)])
                        self.assertEqual(owner.refresh_stats(self.data)['owner_refresh_result'], 'error')
                        persisted = json.loads((self.data / 'owner-refresh.json').read_text())
                        self.assertEqual(persisted['owner_refresh_result'], 'error')
                        report = mc.run_history.summary(self.wd, '24h')
                        self.assertEqual(report['owner']['last_refresh']['owner_refresh_result'], 'error')
                    finally:
                        # Both launchers share subprocess; the last child is now
                        # Marketplace, while the owner child holds its own flock.
                        for proc in processes:
                            if proc.poll() is None:
                                proc.kill()
                            proc.wait(timeout=5)
                fd = owner.take_lock(self.data)
                os.close(fd)
                self.assertEqual((self.data / 'owner-snapshot.json').read_bytes(), before)

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
        def launched(*a, **kw): sequence.append('launch'); return 'skipped'
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
