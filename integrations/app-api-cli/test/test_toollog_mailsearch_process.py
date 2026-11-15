"""Exercise real helper exits/deadlines without mail, credentials or network."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import amazon_email_orders as amazon
import toollog as log
from test_amazon_email_orders import FakeMailsearch, NOW, OID, confirmation


CHILD = r'''
import importlib.machinery
import importlib.util
import sys
import threading
from types import SimpleNamespace

sys.modules['mail_oauth'] = SimpleNamespace()
loader = importlib.machinery.SourceFileLoader('fixture_mailsearch', sys.argv[1])
mail = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(mail)
command, target, outcome = sys.argv[2:]

def stop():
    if outcome in ('deadline', 'helper_deadline'):
        threading.Event().wait()
    raise TimeoutError('private-cookie private-account private-address private-body')

class Connection:
    def select(self, *args, **kwargs):
        if target in ('order_list', 'order_detail'):
            stop()
        return 'OK', []
    def uid(self, op, *args):
        if op == 'SEARCH':
            return 'OK', [b'1']
        return 'OK', [(b'UID 1', b'From: fixture@example.invalid\r\nSubject: private-body\r\n\r\nprivate-body')]
    def logout(self):
        pass

def connect(*args, **kwargs):
    if target == 'session_open':
        stop()
    return Connection()

mail.connect = connect
if target == 'parse':
    if command == 'search':
        mail.email.message_from_bytes = lambda *a, **k: stop()
    else:
        class Output:
            def write(self, data):
                stop()
            def flush(self):
                pass
        sys.stdout = Output()
if command == 'search':
    mail.cmd_search(['-a', 'icloud', '--json', '-t', '0.1' if outcome == 'helper_deadline' else '60', 'fixture'])
else:
    sys.exit(mail.cmd_read(['icloud', 'INBOX', '1', '--raw']))
'''

CASES = (
    ('search', 'session_open', '/amazon/session/open'),
    ('search', 'order_list', '/amazon/mail/search'),
    ('search', 'parse', '/amazon/mail/parse'),
    ('read', 'session_open', '/amazon/session/open'),
    ('read', 'order_detail', '/amazon/mail/read'),
    ('read', 'parse', '/amazon/mail/parse'),
)


class MailsearchProcess(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.script = self.root / 'child.py'
        self.script.write_text(CHILD)
        self.helper = Path(amazon.__file__).parents[1] / 'local-helpers/bin/mailsearch'
        env = patch.dict(os.environ, TOOLLOG_ROOT=str(self.root / 'logs'),
                         ROBOB_TOOL_LOG_DIR=str(self.root / 'logs'))
        env.start()
        self.addCleanup(env.stop)

    def rows(self):
        return [json.loads(line) for path in (self.root / 'logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]

    def test_real_helper_nonzero_and_parent_deadlines_keep_each_actual_phase(self):
        tokens = []
        for command, phase, endpoint in CASES:
            for outcome in ('nonzero', 'deadline'):
                with self.subTest(command=command, phase=phase, outcome=outcome):
                    fake = FakeMailsearch(messages={1: confirmation()})
                    def runner(args, **kwargs):
                        if (args[1] == 'read') != (command == 'read'):
                            return fake(args, **kwargs)
                        tokens.append(kwargs['env']['MAILSEARCH_PHASE_TOKEN'])
                        self.assertGreater(kwargs['timeout'], 1)
                        self.assertLessEqual(kwargs['timeout'], 2)
                        return subprocess.run([sys.executable, '-I', str(self.script), str(self.helper),
                                               command, phase, outcome], **kwargs)
                    result = amazon.track(OID, runner=runner, now=NOW, timeout=2)
                    self.assertTrue(result['errors'])
                    row = self.rows()[-1]
                    cause = row['error']['cause']
                    self.assertEqual(cause['phase'], phase)
                    self.assertEqual(cause['endpoint'], endpoint)
                    self.assertGreaterEqual(cause['phaseElapsedMs'], 0)
                    self.assertLess(cause['phaseElapsedMs'], 3000)
                    if outcome == 'deadline':
                        self.assertGreater(cause['phaseElapsedMs'], 100)
                    self.assertEqual(cause['exceptionClass'],
                                     'TimeoutExpired' if outcome == 'deadline' else 'TimeoutError')
                    self.assertTrue(cause['retryable'])
                    self.assertEqual(cause['attempt'], 1)
        serialized = json.dumps(self.rows())
        for value in ['private-', 'icloud', 'gmail', 'INBOX', OID, *tokens]:
            self.assertNotIn(value, serialized)

    def test_nonzero_read_without_markers_still_records_a_sanitized_cause(self):
        fake = FakeMailsearch(messages={1: confirmation()})
        def runner(args, **kwargs):
            if args[1] == 'read':
                return subprocess.CompletedProcess(args, 1, 'private-body', 'TimeoutError: private-cookie')
            return fake(args, **kwargs)
        result = amazon.track(OID, runner=runner, now=NOW)
        self.assertEqual(result['errors'][0]['code'], 'message_read_failed')
        cause = self.rows()[-1]['error']['cause']
        self.assertEqual(cause['phase'], 'order_detail')
        self.assertEqual(cause['endpoint'], '/amazon/mail/read')
        self.assertGreaterEqual(cause['phaseElapsedMs'], 0)
        self.assertNotIn('private-', json.dumps(self.rows()))

    def test_progress_parser_accepts_only_current_token_and_safe_phase_metadata(self):
        token = 'f' * 32
        base = {'token': token, 'slot': 0, 'state': 'active', 'phase': 'session_open',
                'startedAt': 10, 'phaseElapsedMs': 0, 'timedOut': False}
        def marker(row):
            return 'MAILSEARCH_PHASE ' + json.dumps(row) + '\n'
        for stderr in (marker(base), marker(base).encode()):
            self.assertEqual(amazon._helper_phase(stderr, token, 12),
                             {'slot': 0, 'phase': 'session_open', 'elapsed_ms': 2000, 'timed_out': False})
        forms = [dict(base, token='private-cookie'), dict(base, phase='private-address'),
                 dict(base, slot='private-account'), dict(base, slot=True),
                 dict(base, startedAt=float('nan')), dict(base, startedAt=float('inf')),
                 dict(base, startedAt=10**400), dict(base, startedAt=13),
                 dict(base, state='private-body'), dict(base, state='failed', phaseElapsedMs=-1),
                 dict(base, state='failed', phaseElapsedMs=10**400),
                 dict(base, state='failed', phaseElapsedMs=True)]
        for row in forms:
            with self.subTest(row=row):
                self.assertEqual(amazon._helper_phase(marker(row), token, 12), {})
        stderr = marker(base) + marker(dict(base, state='done'))
        stderr += marker(dict(base, slot=1, phase='order_list', startedAt=11))
        self.assertEqual(amazon._helper_phase(stderr, token, 12)['phase'], 'order_list')
        stderr += marker(dict(base, slot=2, startedAt=10.5))
        self.assertEqual(amazon._helper_phase(stderr, token, 12)['phase'], 'session_open')
        stderr = marker(dict(base, state='failed', timedOut=False))
        stderr += marker(dict(base, slot=1, state='failed', startedAt=11, timedOut=True))
        self.assertEqual(amazon._helper_phase(stderr, token, 12)['slot'], 1)
        stderr = marker(dict(base, state='failed', phaseElapsedMs=250, timedOut=True))
        stderr += marker(dict(base, phase='order_list', startedAt=11))
        stderr += marker(dict(base, state='done', phase='order_list', startedAt=11))
        self.assertEqual(amazon._helper_phase(stderr, token, 12),
                         {'slot': 0, 'phase': 'session_open', 'elapsed_ms': 250, 'timed_out': True})

    def test_helper_owned_deadline_keeps_timeout_classification_and_phase(self):
        tokens = []
        for _, phase, endpoint in CASES[:3]:
            with self.subTest(phase=phase):
                def runner(args, **kwargs):
                    self.assertEqual(kwargs['timeout'], 8)
                    tokens.append(kwargs['env']['MAILSEARCH_PHASE_TOKEN'])
                    process = subprocess.run([sys.executable, '-I', str(self.script), str(self.helper),
                        'search', phase, 'helper_deadline'], **kwargs)
                    self.assertEqual(process.returncode, 1)
                    self.assertIn('timeout after', json.loads(process.stdout)['status']['icloud']['error'])
                    markers = [json.loads(line.split(' ', 1)[1]) for line in process.stderr.splitlines()
                               if line.startswith('MAILSEARCH_PHASE ')]
                    self.assertEqual(markers[-1]['state'], 'failed')
                    self.assertTrue(markers[-1]['timedOut'])
                    return process
                result = amazon.track(OID, accounts=['icloud'], runner=runner, now=NOW, timeout=8)
                self.assertEqual(result['errors'], [{'code': 'account_timeout', 'account': 'icloud'}])
                row = self.rows()[-1]
                self.assertEqual(row['error']['message'], 'account_timeout')
                cause = row['error']['cause']
                self.assertEqual(cause['upstreamCode'], 'account_timeout')
                self.assertEqual(cause['phase'], phase)
                self.assertEqual(cause['endpoint'], endpoint)
                self.assertGreater(cause['phaseElapsedMs'], 100)
                self.assertLess(cause['phaseElapsedMs'], 5000)
                self.assertTrue(cause['retryable'])
        for value in ['private-', 'icloud', OID, *tokens]:
            self.assertNotIn(value, json.dumps(self.rows()))

    def test_timeout_status_and_progress_stay_on_the_same_selected_account(self):
        for marker_state in ('active', 'failed', None):
            for slot in (0, 1):
                with self.subTest(marker_state=marker_state, slot=slot):
                    def runner(args, **kwargs):
                        accounts = ['icloud', 'gmail']
                        status = {account: {'ok': False, 'error': 'timeout after 1s' if i == slot
                                           else 'private-cookie unavailable'} for i, account in enumerate(accounts)}
                        marker = {'token': kwargs['env']['MAILSEARCH_PHASE_TOKEN'], 'slot': slot,
                                  'state': marker_state, 'phase': 'session_open', 'startedAt': time.time() - .25,
                                  'phaseElapsedMs': 250, 'timedOut': marker_state == 'failed'}
                        return subprocess.CompletedProcess(args, 1, json.dumps({'hits': [], 'status': status}),
                            'MAILSEARCH_PHASE ' + json.dumps(marker) + '\n' if marker_state else '')
                    amazon.track(OID, accounts=['icloud', 'gmail'], runner=runner, now=NOW)
                    row = self.rows()[-1]
                    expected = 'account_timeout' if marker_state or slot == 1 else 'account_unavailable'
                    self.assertEqual(row['error']['message'], expected)
                    self.assertEqual(row['error']['cause']['upstreamCode'], expected)
                    if marker_state:
                        self.assertEqual(row['error']['cause']['phase'], 'session_open')
                        self.assertEqual(row['error']['cause']['endpoint'], '/amazon/session/open')
                        self.assertTrue(row['error']['cause']['retryable'])
        self.assertNotIn('private-', json.dumps(self.rows()))

    def test_slow_process_creation_does_not_discard_later_child_progress(self):
        clock = [0]
        def runner(args, **kwargs):
            clock[0] = 100
            marker = {'token': kwargs['env']['MAILSEARCH_PHASE_TOKEN'], 'slot': 0,
                      'phase': 'session_open', 'startedAt': 99.5, 'state': 'active'}
            raise subprocess.TimeoutExpired(args, kwargs['timeout'],
                stderr=('MAILSEARCH_PHASE ' + json.dumps(marker) + '\n').encode())
        @log.timed('amazon', 'provider.track')
        def provider():
            amazon._run_mailsearch(runner, ['fixture'], 1, log.operation_recorder(), 'order_list')
        with patch.object(amazon.time, 'time', side_effect=lambda: clock[0]):
            with self.assertRaises(subprocess.TimeoutExpired):
                provider()
        cause = self.rows()[-1]['error']['cause']
        self.assertEqual((cause['phase'], cause['endpoint'], cause['phaseElapsedMs']),
                         ('session_open', '/amazon/session/open', 500))
