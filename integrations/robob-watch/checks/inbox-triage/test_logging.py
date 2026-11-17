"""Exercise the existing offline triage/delivery fixtures with metadata logging enabled."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

import test_fastpath as fast_fixtures
import test_triage as triage_fixtures
from test_triage import t


_sampled = set()


class TriageLoggingTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.logs = self.root / 'logs'
        self.stack.enter_context(patch.dict(os.environ, {'TOOLLOG_DIR': str(self.logs), 'ROBOB_TEST': '1',
                                                        'WATCH_DIR': str(self.root / 'check'), 'WATCH_RUN': 'private-run-id'}))
        os.environ.pop('WATCH_ID', None)

    def tearDown(self):
        if os.environ.get('TOOLLOG_SAMPLES'):
            for row in self.rows():
                if row['name'] not in _sampled:
                    print('LOG_SAMPLE ' + json.dumps(row, separators=(',', ':')))
                    _sampled.add(row['name'])

    def rows(self, name=None):
        rows = [json.loads(line) for path in self.logs.glob('*.ndjson') for line in path.read_text().splitlines()]
        return [row for row in rows if name is None or row['name'] == name]

    def decisions(self, item_id):
        digest = hashlib.sha256(item_id.encode()).hexdigest()[:24]
        return [row for row in self.rows('triage.decision') if row.get('ids', {}).get('item') == digest]

    def fixture(self, cls):
        fixture = cls()
        self.addCleanup(fixture.doCleanups)
        fixture.setUp()
        return fixture

    def item(self, **fields):
        return triage_fixtures.TriageTests().item(ts=time.time() - 60, **fields)

    def run_batch(self, items, hits=(), error=None):
        wd = Path(os.environ['WATCH_DIR'])
        t.atomic(wd / 'cursor.json', {'version': 1, 'initialized_at': time.time() - 300, 'cursors': {}, 'queue': []})
        results = {'icloud': {'cursor': {'validity': 1, 'uid': 99}, 'items': items, 'drops': {}, 'scanned': len(items)}}
        with contextlib.ExitStack() as stack:
            for name, result in (('active_watchers', []), ('noise_rules', []), ('collect', (results, {})),
                                 ('build_context', {}), ('handled', ({}, {})), ('payment_checks', ({}, None)),
                                 ('renewal_checks', ({}, None)), ('charge_checks', ({}, set(), None)),
                                 ('urgent_alerts', {}), ('charges_raised', None)):
                stack.enter_context(patch.object(t, name, return_value=result))
            stack.enter_context(patch.object(t, 'classify', side_effect=error,
                                            return_value=(list(hits), {'cost_usd': 0})))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=None, report=None)), 0)
        return t.read_json(wd / 'cursor.json')

    def test_success_records_actual_mail_sms_urgency_and_noise_decisions(self):
        items = [self.item(id='mail:private:1:1', subject='Private booking subject'),
                 self.item(id='imsg:2', source='imessage', preview='hi'),
                 self.item(id='mail:private:1:3', subject='Private unselected subject'),
                 self.item(id='imsg:4', source='imessage', preview='Private reply body')]
        hits = [{'id': items[0]['id'], 'urgency': 'urgent', 'reason': 'Private classifier reason'},
                {'id': items[3]['id'], 'urgency': 'today', 'reason': 'Private classifier reason'}]
        state = self.run_batch(items, hits)
        self.assertIn('outbox', state)
        for item, category, routed, source in zip(items, ('urgent', 'noise', 'noise', 'today'),
                                                 ('chat', 'ignored', 'ignored', 'chat'), ('mail', 'sms', 'mail', 'sms')):
            row, = self.decisions(item['id'])
            self.assertEqual({key: row['props'][key] for key in ('class', 'routed', 'source')},
                             {'class': category, 'routed': routed, 'source': source})
        self.assertTrue(self.rows('triage.run')[-1]['ok'])
        serialized = json.dumps(self.rows())
        for value in ('Private booking subject', 'Private unselected subject', 'Private reply body',
                      'Private classifier reason', 'private-run-id', t.SYSTEM):
            self.assertNotIn(value, serialized)

    def test_replayed_outbox_records_queue_event_without_event_text(self):
        triage_fixtures.TriageTests().test_unacked_event_replays_and_acked_does_not()
        self.assertTrue(self.rows('triage.replay'))
        self.assertNotIn('review this', json.dumps(self.rows()))

    def test_handled_id_missing_from_current_batch_cannot_break_logging(self):
        fixture = self.fixture(triage_fixtures.ChatFollowUpTests)
        fixture.test_a_slow_replay_that_clears_its_batch_leaves_collection_to_the_next_run()
        self.assertTrue(self.decisions('imsg:1'))

    def test_classifier_failure_logs_stable_tag_and_actual_fail_open_route(self):
        item = self.item(id='mail:private:1:1', preview='Private body should never appear')
        state = self.run_batch([item], error=ValueError('private token and response body'))
        self.assertIn('outbox', state)
        row, = self.decisions(item['id'])
        self.assertEqual((row['props']['class'], row['props']['routed']), ('fail_open', 'chat'))
        self.assertEqual(self.rows('triage.classify')[-1]['ok'], False)
        errors = [row['error'] for row in self.rows() if 'error' in row]
        self.assertIn({'tag': 'classifier.failed', 'message': 'classifier.failed'}, errors)
        self.assertNotIn('private token', json.dumps(self.rows()))

    def test_failed_run_is_traced_and_keeps_the_original_failure(self):
        with patch.object(t, 'active_watchers', return_value=[]), \
             patch.object(t, 'noise_rules', side_effect=ValueError('private broken rules')):
            with self.assertRaisesRegex(ValueError, 'private broken rules'):
                t.run(types.SimpleNamespace(dry_run_hours=None, report=None))
        row, = self.rows('triage.run')
        self.assertFalse(row['ok'])
        self.assertTrue(any(row.get('error', {}).get('tag') == 'triage.run.failed' for row in self.rows()))
        self.assertNotIn('private broken rules', json.dumps(self.rows()))

    def test_money_case_charge_dedup_and_bank_tracking_use_existing_fixtures(self):
        fixture = self.fixture(triage_fixtures.ChargeTests)
        sms = fixture.alert(1, '50.00', 'UMBRELLA', 600)
        mail = {**sms, 'id': 'mail:icloud:1:2', 'source': 'email', 'sender': 'alert@emiratesnbd.com', 'ts': sms['ts'] + 10}
        model, _, runs = fixture.run_triage([sms, mail])
        self.assertEqual([item['id'] for item in model.call_args[0][0]], [sms['id']])
        self.assertEqual(runs[-1]['dropped']['charge_asked'], 1)
        duplicate, = self.decisions(mail['id'])
        self.assertEqual(duplicate['props'], {'source': 'charge', 'class': 'deduped', 'routed': 'ignored', 'deduped': True})
        selected, = self.decisions(sms['id'])
        self.assertEqual((selected['props']['source'], selected['props']['routed']), ('charge', 'chat'))
        (fixture.tmp / 'wd/.run-ok').write_text('test')
        payment = self.item(id='mail:wio:3', sender='Wio', subject='Autopay failed',
                            preview='Your autopay of AED 3,532.73 failed; repay before midnight')
        model, _, _ = fixture.run_triage([payment])
        model.assert_not_called()
        tracked, = self.decisions(payment['id'])
        self.assertEqual((tracked['props']['source'], tracked['props']['class'], tracked['props']['routed']),
                         ('bank', 'bank', 'ignored'))
        self.assertNotIn('3,532.73', json.dumps(self.rows()))

    def test_fast_delivery_and_dedup_log_real_stubbed_helper_runs(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        message = fast_fixtures.item(id='imsg:private-id', preview='Your SIM has been replaced with an eSIM. private payload')
        fixture.run_items([message])
        fixture.run_items([message])
        helpers = self.rows('helper.run')
        self.assertEqual({row['ids']['helper'] for row in helpers}, {'telegram-bridge', 'spectrum-bridge'})
        self.assertEqual(len(helpers), 2)
        self.assertTrue(all(row['ok'] and row['props']['exitCode'] == 0 and row['durationMs'] >= 0 for row in helpers))
        self.assertTrue(any(row['props'].get('deduped') is True and row['props'].get('routed') == 'chat'
                            for row in self.decisions(message['id'])))
        self.assertTrue(self.rows('triage.fastpath')[-1]['ok'])
        self.assertTrue(any(row['props']['class'] == 'security' for row in self.rows('fastpath.classify')))
        self.assertNotIn('private payload', json.dumps(self.rows()))
        self.assertNotIn(str(fixture.stub), json.dumps(self.rows()))

    def test_fast_failed_helper_tags_error_retains_pending_and_retries_one_channel(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        message = fast_fixtures.item(id='imsg:private-failure')
        os.environ['FAIL_CHANNEL'] = 'notify'
        fixture.run_items([message])
        self.assertIn(message['id'], t.read_json(fixture.wd / 'cursor.json')['pending'])
        failed = [row for row in self.rows('helper.run') if not row['ok']]
        self.assertEqual([(row['ids']['helper'], row['props']['exitCode']) for row in failed], [('telegram-bridge', 1)])
        self.assertTrue(any(row.get('error', {}).get('tag') == 'fastpath.delivery_failed' for row in self.rows()))
        os.environ['FAIL_CHANNEL'] = ''
        fixture.run_items([message])
        self.assertEqual(t.read_json(fixture.wd / 'cursor.json')['pending'], {})
        self.assertEqual(len(self.rows('helper.run')), 3)

    def test_unwritable_logger_does_not_change_fast_delivery(self):
        self.logs.write_text('not a directory')
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        fixture.run_items([fast_fixtures.item()])
        self.assertEqual(len(fixture.notifications()), 2)
        self.assertEqual(t.read_json(fixture.wd / 'cursor.json')['pending'], {})
        self.assertEqual(self.logs.read_text(), 'not a directory')

    def test_unexpected_auth_is_logged_with_safe_metadata_and_never_sent(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        for n, (sender, text, kind, label) in enumerate((
            ('Bank', 'Your verification code is 123456.', 'otp', 'an inbox sender'),
            ('WHOOP', 'Your verification code is 123 456.', 'otp', 'WHOOP'),
            ('Claude', 'Your secure link to Claude: https://example.test/auth?token=fixture', 'signin_link', 'Claude'),
        )):
            with self.subTest(kind=kind, label=label):
                msg = fast_fixtures.item(sender, text, id=f'imsg:auth-{n}')
                before = len(self.rows('fastpath.auth_logged'))
                fixture.run_items([msg])
                event, = self.rows('fastpath.auth_logged')[before:]
                self.assertEqual(event['props'], {'source': 'sms', 'senderLabel': label, 'authKind': kind})
                self.assertEqual(event['ids']['item'], hashlib.sha256(msg['id'].encode()).hexdigest()[:24])
                decision, = self.decisions(msg['id'])
                self.assertEqual((decision['props']['class'], decision['props']['routed']), ('otp', 'logged'))
                self.assertEqual(fixture.notifications(), [])
        for secret in ('123456', '123 456', 'example.test', 'token=fixture'):
            self.assertNotIn(secret, json.dumps(self.rows()))

    def test_expected_auth_stays_ignored_and_stale_auth_is_logged_only(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        t.atomic(fixture.data / 'inflight-actions.json', [{'sender': 'bank', 'at': 990}])
        msg = fast_fixtures.item('Bank', 'Your verification code is 123456.')
        fixture.run_items([msg])
        decision, = self.decisions(msg['id'])
        self.assertEqual((decision['props']['class'], decision['props']['routed']), ('otp', 'ignored'))
        self.assertEqual(self.rows('fastpath.auth_logged'), [])
        t.atomic(fixture.wd / 'cursor.json', {'initialized_at': 900, 'cursors': {}, 'pending': {
            'mail:fund:1:1': {'kind': 'auth', 'text': 'Security: a sign-in link from Claude', 'at': 1000,
                            'auth_identity': {'sender': 'support@anthropic.com', 'account': 'fund', 'ts': 1000}}}})
        fixture.run_items([])
        event, = self.rows('fastpath.auth_logged')
        self.assertEqual(event['props'], {'source': 'mail', 'senderLabel': 'Claude', 'authKind': 'signin_link'})
        self.assertEqual(t.read_json(fixture.wd / 'cursor.json')['pending'], {})
        self.assertEqual(fixture.notifications(), [])

    def test_collected_expected_mail_otps_keep_issuance_evidence_after_redaction(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        actions = [{'sender': 'support@whoop.com', 'account': 'fund', 'at': 990}]
        t.atomic(fixture.data / 'inflight-actions.json', actions)
        cases = (
            ('unspaced', 'Notice', 'Your verification code is 123456.'),
            ('spaced', 'Notice', 'Your verification code is 123 456.'),
            ('alphanumeric', 'Notice', 'Your verification code is A1B2C3.'),
            ('subject', 'Verification code: 123456', 'Use this to sign in.'),
        )
        for n, (shape, subject, body) in enumerate(cases, 1):
            with self.subTest(shape=shape):
                raw = (f'From: support@whoop.com\r\nSubject: {subject}\r\nContent-Type: text/plain\r\n\r\n{body}').encode()
                with patch.object(t, 'fetch_verified', return_value=[(n, '', raw)]):
                    msg, _ = t.mail_record(None, None, 'fund', 1,
                        (n, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0]), 0, 1001,
                        {'seen': [], 'rules': [], 'fast': True, 'actions': actions})
                self.assertIsNone(msg['hard_alert'])
                self.assertIs(msg['auth_issued'], True)
                self.assertFalse(t.fastpath.issued_auth(msg['subject'] + ' ' + msg['preview']))
                fixture.run_items([msg])
                decision, = self.decisions(msg['id'])
                self.assertEqual((decision['props']['class'], decision['props']['routed']), ('otp', 'ignored'))
        self.assertEqual(self.rows('fastpath.auth_logged'), [])
        self.assertEqual(fixture.notifications(), [])

    def test_pending_auth_preserves_expected_decision_for_otp_and_link(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        cases = (
            ('matching', {'sender': 'bank', 'account': 'fund', 'at': 990}, True),
            ('wrong sender', {'sender': 'other', 'account': 'fund', 'at': 990}, False),
            ('wrong account', {'sender': 'bank', 'account': 'gmail', 'at': 990}, False),
            ('future action', {'sender': 'bank', 'account': 'fund', 'at': 1001}, False),
            ('expired action', {'sender': 'bank', 'account': 'fund', 'at': 399}, False),
            ('no identity', {'sender': 'bank', 'account': 'fund', 'at': 990}, False),
        )
        for what in ('an OTP', 'a sign-in link'):
            for shape, action, expected in cases:
                with self.subTest(kind=what, shape=shape):
                    item_id = 'mail:fund:1:' + str(len(self.rows()))
                    identity = None if shape == 'no identity' else {'sender': 'Bank', 'account': 'fund', 'ts': 1000}
                    t.atomic(fixture.data / 'inflight-actions.json', [action])
                    t.atomic(fixture.wd / 'cursor.json', {'initialized_at': 900, 'cursors': {}, 'pending': {
                        item_id: {'kind': 'auth', 'text': f'Security: {what} from your bank',
                                  'at': 1000, 'auth_identity': identity}}})
                    before = len(self.rows('fastpath.auth_logged'))
                    fixture.run_items([])
                    decision, = self.decisions(item_id)
                    self.assertEqual((decision['props']['class'], decision['props']['routed']),
                                     ('otp', 'ignored' if expected else 'logged'))
                    self.assertEqual(len(self.rows('fastpath.auth_logged')) - before, int(not expected))
                    self.assertEqual(t.read_json(fixture.wd / 'cursor.json')['pending'], {})
        self.assertEqual(fixture.notifications(), [])

    def test_collected_expected_mail_links_keep_issuance_evidence_after_redaction(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        actions = [{'sender': 'support@anthropic.com', 'account': 'fund', 'at': 990}]
        t.atomic(fixture.data / 'inflight-actions.json', actions)
        cases = (
            ('plain', 'text/plain', 'Your secure link to Claude: https://example.test/private'),
            ('HTML', 'text/html', '<a href="https://example.test/private">Sign in</a>'),
            ('multipart', 'multipart/alternative; boundary=fixture',
             '--fixture\r\nContent-Type: text/plain\r\n\r\nClick below.\r\n'
             '--fixture\r\nContent-Type: text/html\r\n\r\n<a href="https://example.test/private">Sign in</a>\r\n--fixture--'),
        )
        helper = types.SimpleNamespace(html_to_text=lambda _: 'Sign in')
        for n, (shape, mime, body) in enumerate(cases, 1):
            with self.subTest(shape=shape):
                raw = (f'From: support@anthropic.com\r\nSubject: Sign in\r\nContent-Type: {mime}\r\n\r\n{body}').encode()
                with patch.object(t, 'fetch_verified', return_value=[(n, '', raw)]):
                    msg, _ = t.mail_record(None, helper, 'fund', 1,
                        (n, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0]), 0, 1001,
                        {'seen': [], 'rules': [], 'fast': True, 'actions': actions})
                self.assertIsNone(msg['hard_alert'])
                self.assertFalse(t.fastpath.issued_auth(msg['subject'] + ' ' + msg['preview']))
                self.assertNotIn('example.test', json.dumps(msg))
                fixture.run_items([msg])
                decision, = self.decisions(msg['id'])
                self.assertEqual((decision['props']['class'], decision['props']['routed']), ('otp', 'ignored'))
        self.assertEqual(self.rows('fastpath.auth_logged'), [])
        self.assertEqual(fixture.notifications(), [])

    def test_collected_expected_imessage_links_stay_ignored(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        actions = [{'sender': 'claude', 'at': 990}]
        t.atomic(fixture.data / 'inflight-actions.json', actions)
        cases = ('Your secure link to Claude: https://example.test/private',
                 'Sign in: https://example.test/private. This link expires in 10 minutes.')
        path = fixture.root / 'Library/Messages/chat.db'
        path.parent.mkdir(parents=True)
        triage_fixtures.chat_db(path, [(n, 10, 'Claude', 1000, 0, {'text': body})
                                     for n, body in enumerate(cases, 1)], {10: ['Claude']})
        with patch.object(t, 'HOME', fixture.root), \
             patch.object(t, 'settings', return_value={'excluded_imessage_chat_ids': [], 'excluded_imessage_identifiers': []}):
            result = t.collect_imessage(0, 1001, fast={'actions': actions})
        self.assertEqual(len(result['items']), len(cases))
        for msg in result['items']:
            self.assertIsNone(msg['hard_alert'])
            self.assertNotIn('example.test', json.dumps(msg))
            fixture.run_items([msg])
            decision, = self.decisions(msg['id'])
            self.assertEqual((decision['props']['class'], decision['props']['routed']), ('otp', 'ignored'))
        self.assertEqual(self.rows('fastpath.auth_logged'), [])
        self.assertEqual(fixture.notifications(), [])

    def test_collected_expected_imessage_otps_keep_issuance_evidence_after_redaction(self):
        fixture = self.fixture(fast_fixtures.DeliveryTests)
        actions = [{'sender': 'bank', 'at': 990}]
        t.atomic(fixture.data / 'inflight-actions.json', actions)
        cases = (
            ('unspaced', '', 'Your verification code is 123456.'),
            ('spaced', '', 'Your verification code is 123 456.'),
            ('alphanumeric', '', 'Your verification code is A1B2C3.'),
            ('subject', 'Verification code: 123456', 'Use this to sign in.'),
        )
        path = fixture.root / 'Library/Messages/chat.db'
        path.parent.mkdir(parents=True)
        triage_fixtures.chat_db(path, [(n, 10, 'Bank', 1000, 0, {'subject': subject, 'text': body})
                                     for n, (_, subject, body) in enumerate(cases, 1)], {10: ['Bank']})
        with patch.object(t, 'HOME', fixture.root), \
             patch.object(t, 'settings', return_value={'excluded_imessage_chat_ids': [], 'excluded_imessage_identifiers': []}):
            result = t.collect_imessage(0, 1001, fast={'actions': actions})
        self.assertEqual(len(result['items']), len(cases))
        for (shape, _, _), msg in zip(cases, result['items']):
            with self.subTest(shape=shape):
                self.assertIsNone(msg['hard_alert'])
                self.assertIs(msg['auth_issued'], True)
                self.assertFalse(t.fastpath.issued_auth(msg['subject'] + ' ' + msg['preview']))
                fixture.run_items([msg])
                decision, = self.decisions(msg['id'])
                self.assertEqual((decision['props']['class'], decision['props']['routed']), ('otp', 'ignored'))
        self.assertEqual(self.rows('fastpath.auth_logged'), [])
        self.assertEqual(fixture.notifications(), [])

    def test_mail_helper_success_exit_and_timeout_never_log_args_or_output(self):
        payload = {'now': time.time(), 'private': 'private mail payload'}
        good = {'items': [], 'cursor': {}, 'drops': {}, 'scanned': 0}
        outcomes = (subprocess.CompletedProcess([], 0, json.dumps(good), 'private output'),
                    subprocess.CompletedProcess([], 2, '', 'private response'),
                    subprocess.TimeoutExpired(['private command'], 1, output='private stdout', stderr='private stderr'))
        for outcome in outcomes:
            with patch.object(t.subprocess, 'run', side_effect=outcome if isinstance(outcome, Exception) else None,
                              return_value=outcome):
                if isinstance(outcome, Exception):
                    with self.assertRaises(subprocess.TimeoutExpired):
                        t.run_mail('icloud', {**payload, 'fast': True})
                elif outcome.returncode:
                    with self.assertRaises(RuntimeError):
                        t.run_mail('icloud', payload)
                else:
                    self.assertEqual(t.run_mail('icloud', payload), good)
        rows = self.rows('helper.run')
        self.assertEqual([row['ok'] for row in rows], [True, False, False])
        self.assertEqual(rows[-1]['props'], {'outcome': 'timeout', **t.stderr_cause('private stderr', True)})
        self.assertEqual(rows[1]['props']['stderrClass'], 'unknown')
        self.assertTrue(any(row.get('error', {}).get('tag') == 'helper.timeout' for row in self.rows()))
        for value in ('private mail payload', 'private response', 'private command', 'private stdout', 'private stderr'):
            self.assertNotIn(value, json.dumps(self.rows()))

    def test_collection_failure_is_tagged_without_exception_content(self):
        state = {'cursors': {}, 'initialized_at': time.time()}
        with patch.object(t, 'ACCOUNTS', ()), patch.object(t, 'collect_whatsapp', side_effect=OSError('private path and token')), \
             patch.object(t, 'collect_imessage', return_value={'items': [], 'cursor': 0}):
            results, errors = t.collect(state, time.time(), [], [])
        self.assertIn('imessage', results)
        self.assertIn('whatsapp', errors)
        self.assertTrue(any(row.get('error', {}).get('tag') == 'collection.failed' for row in self.rows()))
        self.assertNotIn('private path', json.dumps(self.rows()))

    def test_fast_unknown_and_invalid_rate_paths_are_traced_without_financial_values(self):
        self.assertIsNone(t.fastpath.classify(fast_fixtures.item('friend', 'Private ordinary note')))
        message = fast_fixtures.item('Mashreq', 'Purchase of EUR 1,999.00 with your card ending 2342')
        self.assertIsNone(t.fastpath.classify(message, rates={'EUR': 'private-invalid-rate'}))
        self.assertEqual([row['props']['class'] for row in self.rows('fastpath.classify')], ['unknown', 'unknown'])
        self.assertTrue(any(row.get('error', {}).get('tag') == 'fastpath.rate_invalid' for row in self.rows()))
        for value in ('Private ordinary note', '1,999.00', '2342', 'private-invalid-rate'):
            self.assertNotIn(value, json.dumps(self.rows()))

    def test_installed_and_isolated_scratch_imports_find_installed_helper(self):
        fake_home = self.root / 'home-fixture'
        runtime = fake_home / '.local/share/robob-watch'
        helpers = runtime / 'helpers'
        helpers.mkdir(parents=True)
        source = Path(t.__file__).parent
        for name in ('redact.py', 'toollog.py'):
            shutil.copy2(source.parents[1] / 'helpers' / name, helpers / name)
        program = '''import importlib.util, sys
from pathlib import Path
Path.home = classmethod(lambda cls: Path(sys.argv[2]))
spec = importlib.util.spec_from_file_location('isolated_triage', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert mod.tool_log.__module__ == 'toollog'
assert mod.fastpath.tool_log.__module__ == 'toollog'
mod.fastpath.classify({'id':'mail:fixture:1','source':'email','sender':'fixture','preview':'ordinary'})
'''
        for destination in (runtime / 'watchers/inbox-triage', self.root / 'isolated/scratch'):
            destination.mkdir(parents=True)
            for name in ('triage.py', 'fastpath.py', 'expected_auth.py'):
                shutil.copy2(source / name, destination / name)
            result = subprocess.run([sys.executable, '-I', '-B', '-c', program, str(destination / 'triage.py'), str(fake_home)],
                                    text=True, capture_output=True, timeout=5)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
        self.assertEqual(len(self.rows('fastpath.classify')), 2)


if __name__ == '__main__':
    unittest.main()
