"""Forced failures use synthetic messages and private log/state directories."""
import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import amazon_email_orders as amazon
import order_tracker as tracker
import toollog as log
from test_amazon_email_orders import FakeMailsearch, NOW, OID


class PollHealth(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.folder = self.root / 'watcher'
        self.folder.mkdir()
        self.state = self.folder / 'order-tracker-state.json'
        tracker.write(self.state, {'primed': True, 'status': 'unknown'})
        tracker.write(self.folder / 'watcher.json', {'interval_s': 900})
        self.env = patch.dict(os.environ, ROBOB_TOOL_LOG_DIR=str(self.root / 'logs'),
                              TOOLLOG_ROOT=str(self.root / 'logs'), WATCH_DIR=str(self.folder),
                              WATCH_RUN='scheduled-fixture', WATCH_MAIN_CHECKED='0')
        self.env.start()
        self.addCleanup(self.env.stop)
        self.cfg = {'app': 'amazon', 'order': OID, 'watcher': 'fixture', 'for': 'owner',
                    'placed_at': tracker.stamp(NOW.timestamp() - 3600),
                    'registered_at': tracker.stamp(NOW.timestamp()), 'eta': None}

    def rows(self):
        return [json.loads(line) for path in (self.root / 'logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]

    def test_timeout_phase_and_endpoint_survive_caught_exceptions_and_workers(self):
        for phase in ('order_list', 'order_detail', 'parse'):
            with self.subTest(phase=phase):
                fake = FakeMailsearch()
                def runner(args, **kwargs):
                    if phase == ('order_detail' if args[1] == 'read' else 'order_list'):
                        raise subprocess.TimeoutExpired(['private-cookie', 'private-account'], 12,
                                                        output='private-address')
                    return fake(args, **kwargs)
                start = len(self.rows())
                parse = patch.object(amazon, 'parse_message', side_effect=TimeoutError('private-content'))
                with parse if phase == 'parse' else contextlib.nullcontext():
                    amazon.track(OID, runner=runner, now=NOW)
                row = self.rows()[start:][-1]
                cause = row['error']['cause']
                self.assertEqual(cause['phase'], phase)
                self.assertEqual(cause['endpoint'], log._AMAZON_PHASES[phase])
                self.assertGreaterEqual(cause['phaseElapsedMs'], 0)
                self.assertEqual(cause['attempt'], 1)
                self.assertTrue(cause['retryable'])
        serialized = json.dumps(self.rows())
        for private in ('private-', OID, 'gmail', '[Gmail]/All Mail'):
            self.assertNotIn(private, serialized)

    def test_all_phase_forms_and_elapsed_time_are_recorded_at_failure(self):
        forms = [('session_open', '/amazon/session/open'), ('order_list', '/amazon/mail/search'),
                 ('order_detail', '/amazon/mail/read'), ('parse', '/amazon/mail/parse')]
        for phase, endpoint in forms:
            with self.subTest(phase=phase):
                @log.timed('amazon', 'provider.track')
                def provider():
                    with log.operation_recorder()(phase):
                        raise subprocess.TimeoutExpired(['secret-cookie'], 3)
                with patch.object(log, 'perf_counter', side_effect=[10, 11, 14, 15, 20]):
                    with self.assertRaises(subprocess.TimeoutExpired):
                        provider()
                cause = self.rows()[-1]['error']['cause']
                self.assertEqual((cause['phase'], cause['endpoint'], cause['phaseElapsedMs']),
                                 (phase, endpoint, 3000))

    def test_poll_streak_persists_resets_and_isolated_by_tracker(self):
        success_at = tracker.stamp(2000)
        for at, errors, streak, last in [(1000, ['source_error'], 1, None),
                                        (1500, ['source_error'], 2, None),
                                        (2000, [], 0, success_at),
                                        (2500, ['source_error'], 1, success_at)]:
            start = len(self.rows())
            with patch.object(tracker, 'fetch', return_value={'status': 'unknown', 'errors': errors}), \
                    patch.object(tracker.time, 'time', return_value=at), \
                    patch.object(tracker, 'bank_charge_events', return_value=[]), \
                    contextlib.redirect_stdout(io.StringIO()):
                tracker._check(self.cfg)
            state = tracker.read(self.state)
            self.assertEqual(state['consecutive_failures'], streak)
            self.assertEqual(state.get('last_success_at'), last)
            for row in self.rows()[start:]:
                if row['name'] in {'track.poll', 'track.error'}:
                    self.assertEqual(row['props']['consecutive_failures'], streak)
                    self.assertEqual(row['props']['last_success_at'], last)
                    self.assertEqual(row['props']['poll_interval_s'], 900)
        other = self.root / 'other'
        other.mkdir()
        with patch.dict(os.environ, WATCH_DIR=str(other)), \
                patch.object(tracker, 'fetch', return_value={'status': 'unknown', 'errors': ['error']}), \
                patch.object(tracker, 'bank_charge_events', return_value=[]), \
                contextlib.redirect_stdout(io.StringIO()):
            tracker._check({**self.cfg, 'order': '999-1234567-1234567'})
        self.assertEqual(tracker.read(other / self.state.name)['consecutive_failures'], 1)
        self.assertIsNone(self.rows()[-1]['props']['last_success_at'])

    def test_helper_phase_diagnostics_propagate_through_tracker_without_private_metadata(self):
        for phase in ('session_open', 'order_list', 'parse', 'private-account'):
            with self.subTest(phase=phase):
                tracker.write(self.state, {'primed': True, 'status': 'unknown'})
                payload = {'hits': [], 'status': {account: {'ok': False, 'error': 'timeout private-cookie',
                           'phase': phase, 'phaseElapsedMs': 123.5} for account in amazon.ACCOUNTS}}
                runner = unittest.mock.Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps(payload)))
                start = len(self.rows())
                with patch.object(amazon.subprocess, 'run', runner), \
                        patch.object(tracker.store, 'evidence', return_value=([], [])), \
                        patch.object(tracker, 'bank_charge_events', return_value=[]), \
                        contextlib.redirect_stdout(io.StringIO()):
                    tracker._check(self.cfg)
                for row in self.rows()[start:]:
                    if row['kind'] != 'error':
                        continue
                    cause = row['error']['cause']
                    expected = 'order_list' if phase == 'private-account' else phase
                    self.assertEqual(cause['phase'], expected)
                    self.assertEqual(cause['endpoint'], log._AMAZON_PHASES[expected])
                    if phase != 'private-account':
                        self.assertEqual(cause['phaseElapsedMs'], 123.5)
                runner.assert_called_once()
                self.assertEqual(runner.call_args.kwargs['env']['MAILSEARCH_PHASE_DIAGNOSTICS'], '1')
        self.assertNotIn('private-', json.dumps(self.rows()))

    def test_pending_and_raised_fetch_errors_increment_once(self):
        with patch.object(tracker, 'fetch', side_effect=TimeoutError('private-value')), \
                patch.object(tracker, 'send_problem_notices'), \
                contextlib.redirect_stdout(io.StringIO()):
            for pending in (False, True):
                with patch.object(tracker, 'order_total_aed', return_value=600):
                    with self.assertRaises(TimeoutError):
                        tracker._check(self.cfg, pending_only=pending)
        self.assertEqual(tracker.read(self.state)['consecutive_failures'], 2)

    def test_pending_source_result_updates_health_without_moving_delivery_cursor(self):
        for at, errors, failures in [(1000, ['timeout'], 1), (1500, ['timeout'], 2), (2000, [], 0)]:
            with patch.object(tracker, 'fetch', return_value={'status': 'unknown', 'errors': errors}), \
                    patch.object(tracker, 'order_total_aed', return_value=600), \
                    patch.object(tracker, 'queue_problem_notices'), \
                    patch.object(tracker, 'send_problem_notices'), \
                    patch.object(tracker.time, 'time', return_value=at):
                tracker._check(self.cfg, pending_only=True)
            state = tracker.read(self.state)
            self.assertEqual(state['consecutive_failures'], failures)
            self.assertEqual(state['status'], 'unknown')
            self.assertNotIn('last_result', state)
            row = self.rows()[-1]
            self.assertEqual(row['props']['consecutive_failures'], failures)
            self.assertTrue(row['props']['polled'])
        self.assertEqual(state['last_success_at'], tracker.stamp(2000))
        for row in self.rows():
            self.assertIn('consecutive_failures', row['props'])
            self.assertIn('last_success_at', row['props'])
            self.assertEqual(row['props']['poll_interval_s'], 900)
        with patch.object(tracker, 'fetch') as fetch, \
                patch.object(tracker, 'order_total_aed', return_value=100):
            tracker._check(self.cfg, pending_only=True)
            fetch.assert_not_called()
        self.assertEqual(tracker.read(self.state)['consecutive_failures'], 0)

    def test_new_metadata_rejects_private_values(self):
        log.emit('order-watch', 'track.error', kind='error', error='TRACK_POLL_SOURCE_ERROR',
                 props={'consecutive_failures': 'private-account', 'last_success_at': 'private-address',
                        'poll_interval_s': 'private-cookie'},
                 cause={'phase': 'private-token', 'phaseElapsedMs': 'private-content',
                        'endpoint': 'https://private-account.example/?cookie=private-cookie'})
        row = self.rows()[-1]
        self.assertNotIn('private-', json.dumps(row))
        self.assertNotIn('phase', row['error']['cause'])
        self.assertNotIn('last_success_at', row['props'])

    def test_poll_rollup_uses_the_shared_readers_merchant_categories(self):
        for merchant in ('amazon', 'web', 'unknown'):
            log.emit('order-watch', 'track.poll', kind='perf', ok=True,
                     props={'merchant': merchant, 'polled': True})
        result = log.rollup(dt.datetime.now(dt.timezone.utc).date().isoformat())
        self.assertEqual(result['pollsByMerchant'], {
            'amazon': {'count': 1, 'failed': 0, 'failureShare': 0},
            'unknown': {'count': 2, 'failed': 0, 'failureShare': 0}})

    def test_nonzero_read_helper_phase_reaches_tracker_error_and_poll_rows(self):
        from test_toollog_mailsearch_process import CHILD
        from test_amazon_email_orders import confirmation
        import sys
        child = self.root / 'child.py'
        child.write_text(CHILD)
        helper = Path(amazon.__file__).parents[1] / 'local-helpers/bin/mailsearch'
        real_run = subprocess.run
        fake = FakeMailsearch(messages={1: confirmation()})
        def runner(args, **kwargs):
            if args[1] == 'read':
                return real_run([sys.executable, '-I', str(child), str(helper),
                                 'read', 'session_open', 'nonzero'], **kwargs)
            return fake(args, **kwargs)
        with patch.object(amazon.subprocess, 'run', side_effect=runner), \
                patch.object(tracker.store, 'evidence', return_value=([], [])), \
                patch.object(tracker, 'bank_charge_events', return_value=[]), \
                contextlib.redirect_stdout(io.StringIO()):
            tracker._check(self.cfg)
        rows = {row['name']: row for row in self.rows()
                if row['name'] in {'provider.track', 'track.error', 'track.poll'}}
        self.assertTrue({'provider.track', 'track.error', 'track.poll'} <= rows.keys())
        for row in rows.values():
            self.assertEqual(row['error']['cause']['phase'], 'session_open')
            self.assertEqual(row['error']['cause']['endpoint'], '/amazon/session/open')
            self.assertEqual(row['error']['cause']['exceptionClass'], 'TimeoutError')
        self.assertEqual(rows['track.poll']['props']['consecutive_failures'], 1)
        self.assertNotIn('private-', json.dumps(self.rows()))
