"""Offline classifier corpus and direct delivery/recovery checks; notifier CLIs are stubbed."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch
from test_triage import t


def item(sender='e&', preview='Your SIM has been replaced with an eSIM.', **kw):
    return {'id': 'imsg:9001', 'source': 'imessage', 'sender': sender, 'subject': '',
            'preview': preview, 'ts': 1000, **kw}


CORPUS = [
    ('e&', 'Your SIM has been replaced with an eSIM.', 'sim'),
    ('e&', 'Your SIM has been successfully swapped to eSIM.', 'sim'),
    ('Etisalat', 'SIM to eSIM swap completed', 'sim'),
    ('du', 'Your SIM card has been swapped.', 'sim'),
    ('VirginMobile', 'Your number is being ported out.', 'sim'),
    ('Virgin <security@virginmobile.ae>', 'Your SIM replacement is complete.', 'sim'),
    ('Apple <appleid@id.apple.com>', 'Your Apple ID was used to sign in to iCloud on a new device.', 'login'),
    ('Apple <appleid@id.apple.com>', 'Your Apple Account was used to sign in to iCloud via a web browser.', 'login'),
    ('Google <no-reply@accounts.google.com>', 'New sign-in on Windows', 'login'),
    ('Mashreq', 'New device registered for mobile banking', 'login'),
    ('Mashreq', 'Your account was accessed from a new device.', 'login'),
    ('WHOOP <support@whoop.com>', 'Your sign-in code is 123456', 'auth'),
    ('Claude <support@anthropic.com>', 'Here is your secure link to Claude: https://example.test/secret', 'auth'),
    ('Bank', 'Your OTP is 654321. Do not share.', 'auth'),
    ('Bank', 'A1B2C3 is your verification code.', 'auth'),
    ('Bank', 'Your verification code [code]', 'auth'),
    ('Bank', 'Your verification code is: 123456.', 'auth'),
    ('Bank', 'Your verification code is 123 456. Do not share it.', 'auth'),
    ('Bank', 'Your OTP for login is 123456.', 'auth'),
    ('Bank', 'Your OTP for authentication: A1B2C3.', 'auth'),
    ('Bank', 'Your OTP for online log in is: 123456.', 'auth'),
    ('Bank', 'Your OTP for payment is 123456.', 'auth'),
    ('Bank', 'Never share your OTP for purchases of AED 1000 or more.', None),
    ('Bank', 'Your OTP = 123456.', 'auth'),
    ('Bank', 'Your OTP - 123456.', 'auth'),
    ('Bank', 'Use A1B2C3 to sign in.', 'auth'),
    ('Apple', "Your Apple ID Code is: 123456. Don't share it with anyone.", 'auth'),
    ('Apple', 'Your Apple Account Code is 123456.', 'auth'),
    ('Claude <support@anthropic.com>', 'This link expires in 15 minutes. Sign in [https://example.test/magic-login?token=fixture]', 'auth'),
    ('Bank', 'Never share your OTP with anyone.', None),
    ('Wio', 'Your autopay of AED 3,532.73 failed; repay before midnight. Never share your OTP with anyone.', None),
    ('Bank', 'Do not disclose your verification code or security code to anyone.', None),
    ('Mashreq', 'Credit Card Purchase Card Ending: 9546 At: NOON, DUBAI Amount: AED 12,799.00', 'debit'),
    ('EmiratesNBD', 'Purchase of AED 1,000.00 with your Credit Card ending 2342 at SHOP, DUBAI. Available balance AED 99.00.', 'debit'),
    ('ADCB', 'AED 1000 has been debited from your card ending 2342.', 'debit'),
    ('EI SMS', 'Credit Card Purchase Card Ending: 2342 At: HOOLI, 971800000000 Amount: AED 1200.00 Date: 20/10/2026, 19:18', 'debit'),
    ('WioPersonal', 'Payment of USD 300.00 (AED 1101.75) was done at Vandelay using your Wio Personal card 2342. Thanks', 'debit'),
    ('ADCB', 'Card XXXX2342 was used for AED 1200.00 at SHOP, Dubai', 'debit'),
    ('Wio', 'Payment of USD 300.00 was done at SHOP using your Wio debit card ending with 2342', 'debit'),
    ('Mashreq', 'Your card 4111 1111 1111 2342 was used for AED 1000.00 at SHOP, Dubai', 'debit'),
    ('Mashreq', 'Purchase of AED 999.00 with your Credit Card ending 2342 at SHOP. Balance AED 10,000.00', None),
    ('Mashreq', 'Purchase of AED 999.99 with your Credit Card ending 2342 at SHOP.', None),
    ('Mashreq', 'Purchase of AED 1,000.00 with your Credit Card ending 2342 at SHOP was declined.', None),
    ('Mashreq', 'AED 1000 refunded to your card ending 2342.', None),
    ('Mashreq', 'Your card payment due is AED 5000. Statement balance AED 10000.', None),
    ('Mashreq', 'Your card available amount: AED 5000', None),
    ('Mashreq', 'Card payment received. Available balance Amount: AED 5000', None),
    ('Mashreq', 'Payment of AED 5,000.00 received towards your credit card ending 2342.', None),
    ('Mashreq', 'We have received your credit card payment of AED 1,200.00.', None),
    ('Mashreq', 'Your payment of AED 1200 towards your credit card ending 2342 was successful.', None),
    ('Wio', 'Your credit card has been credited with your payment of AED 1200.', None),
    ('Mashreq', 'Purchase of AED 1200 with your Credit Card ending 9546 at SHOP. View your statement in the app.', 'debit'),
    ('EmiratesNBD', 'Your card ending 2342 was used for AED 1200 at SHOP. If a transaction failed, contact support.', 'debit'),
    ('Shop', 'Purchase of AED 5000 with your Credit Card ending 2342 at SHOP.', None),
    ('du', 'Get a new device with your next plan upgrade.', None),
    ('Apple <news@email.apple.com>', 'Get more from your new device', None),
    ('Google <news@google.com>', 'Choose your new device with more storage', None),
    ('Mashreq', 'Upgrade to a new device with our shopping offer', None),
    ('Apple <appleid@id.apple.com>', 'A new device was added to your Apple Account.', 'login'),
    ('Google <no-reply@accounts.google.com>', 'We detected a new device connected to your account.', 'login'),
    ('newsletter@example.test', 'A new device for your office', None),
]


class ClassifierTests(unittest.TestCase):
    def test_numeric_otp_grouping_and_expected_actions(self):
        for code in ('123456', '123 456', '123\u00a0456', '123\u202f456', '12 34 56', '1234 5678'):
            for body in (f'Your verification code is {code}. Do not share it.',
                         f'{code} is your OTP.', f'Use {code} to sign in.'):
                with self.subTest(code=code, body=body):
                    msg = item('Bank', body)
                    self.assertEqual(t.fastpath.classify(msg)['kind'], 'auth')
                    self.assertIsNone(t.fastpath.classify(msg, [{'sender': 'bank', 'at': 990}]))
                    for clean in (t.clean, lambda value: t.clean_lines(value, 500)):
                        self.assertNotIn(code, clean(body))
                    self.assertNotIn(code, t.redact_item(dict(msg))['preview'])

    def test_device_notice_verb_order_and_sender_family(self):
        for sender in ('Mashreq', 'WioPersonal', 'EmiratesNBD', 'Apple', 'Google'):
            for text in ('Your account was accessed from a new device.',
                         'A new device accessed your account.',
                         'Your account was accessed from an unrecognized device.',
                         'You signed in from a new device.', 'You logged in from a new device.'):
                with self.subTest(sender=sender, text=text):
                    self.assertEqual(t.fastpath.classify(item(sender, text))['kind'], 'login')

    def test_corpus(self):
        for sender, text, kind in CORPUS:
            with self.subTest(sender=sender, text=text):
                result = t.fastpath.classify(item(sender, text))
                self.assertEqual(result['kind'] if result else None, kind)
                if result:
                    for secret in ('123456', '654321', '4111 1111 1111', 'https:'):
                        self.assertNotIn(secret, result['text'])

    def test_apple_code_labels_connectors_and_expected_actions(self):
        for label in ('Apple ID Code', 'Apple Account Code'):
            for body in (f'Your {label} is: 123456.', f'Your {label}: 123456.',
                         f'Your {label} = 123456.', f'Your {label} 123456.',
                         f'123456 is your {label}.', f'your {label.lower()} is 123456.'):
                with self.subTest(body=body):
                    msg = item('Apple', body)
                    self.assertEqual(t.fastpath.classify(msg)['kind'], 'auth')
                    self.assertIsNone(t.fastpath.classify(msg, [{'sender': 'apple', 'at': 990}]))
            self.assertIsNone(t.fastpath.classify(item('Apple', f'Never share your {label} with anyone.')))

    def test_html_signin_buttons_keep_only_auth_evidence(self):
        for label in ('Sign in', 'Sign-in', 'Login', 'Log in', 'Sign in to Claude', '<span>Sign</span> in'):
            for quote in ('"', "'"):
                with self.subTest(label=label, quote=quote):
                    markup = f'<A HREF={quote}https://example.test/auth?token=fixture{quote}>{label}</A>'
                    self.assertTrue(t.fastpath.html_signin_link(markup))
        for markup in ('<a href="/relative">Sign in</a>', '<a>Sign in</a>',
                       '<a href="https://example.test">Shop now</a>', '<p>Sign in to our newsletter</p>'):
            with self.subTest(markup=markup):
                self.assertFalse(t.fastpath.html_signin_link(markup))

    def test_plain_signin_button_urls_and_expected_actions(self):
        for label in ('Sign in', 'Sign-in', 'Login', 'Log in'):
            for url in ('https://example.test/auth?token=fixture', '[link]'):
                with self.subTest(label=label, url=url):
                    msg = item('support@anthropic.com', f'{label}: [{url}]', subject='Sign in to Claude', account='fund')
                    self.assertEqual(t.fastpath.classify(msg)['kind'], 'auth')
                    self.assertIsNone(t.fastpath.classify(msg, [{'sender': 'support@anthropic.com', 'account': 'fund', 'at': 990}]))

    def test_portal_buttons_are_not_issued_signin_links(self):
        for label in ('Sign in', 'Sign-in', 'Login', 'Log in'):
            with self.subTest(label=label):
                msg = item('Apple', f'Get more from your new device. {label}: https://example.test/login',
                           subject='Get more from your device', signin_link=True)
                self.assertIsNone(t.fastpath.classify(msg))
        for evidence in ('This link expires in 15 minutes.', 'Your link is valid for 10 minutes.'):
            msg = item('support@anthropic.com', f'{evidence} Sign in https://example.test/token', signin_link=True)
            self.assertEqual(t.fastpath.classify(msg)['kind'], 'auth')

    def test_explicit_link_subjects_with_html_button_evidence(self):
        for subject in ('Secure link to log in to Claude', 'Your magic link', 'Your sign-in link',
                        'Your login link', 'Link to sign in', 'Link to log in', 'Link to Claude'):
            with self.subTest(subject=subject):
                msg = item('support@anthropic.com', 'Click below.', source='email', account='fund',
                           subject=subject, signin_link=True)
                self.assertEqual(t.fastpath.classify(msg)['kind'], 'auth')
                self.assertIsNone(t.fastpath.classify(msg, [{'sender': 'support@anthropic.com', 'account': 'fund', 'at': 990}]))
                self.assertIsNone(t.fastpath.classify({**msg, 'precedence': 'bulk'}))

    def test_transaction_details_do_not_turn_an_otp_into_a_debit(self):
        for details in ('purchase of AED 999.00 at SHOP', 'purchase of AED 1,200.00 at SHOP',
                        'payment of USD 300.00 to SHOP', 'online purchase AED 1200 at SHOP on 20/11/2026',
                        'new device registration'):
            with self.subTest(details=details):
                msg = item('EmiratesNBD', f'Your OTP for {details} is: 123456. Card ending 2342.', account='gmail')
                unknown = t.fastpath.classify(msg)
                self.assertEqual(unknown['kind'], 'auth')
                self.assertNotIn('123456', unknown['text'])
                self.assertIsNone(t.fastpath.classify(msg, [{'sender': 'emiratesnbd', 'account': 'gmail', 'at': 990}]))

    def test_new_device_marketing_is_not_a_login_alert(self):
        for sender in ('Apple <news@email.apple.com>', 'Google <news@google.com>', 'WioPersonal'):
            for bulk in (False, True):
                with self.subTest(sender=sender, bulk=bulk):
                    msg = item(sender, 'Get more from your new device', list_unsubscribe=bulk, precedence='bulk' if bulk else '')
                    self.assertIsNone(t.fastpath.classify(msg))
        genuine = item('WioPersonal', 'New device registered for mobile banking.', list_unsubscribe=True, precedence='bulk')
        self.assertEqual(t.fastpath.classify(genuine)['kind'], 'login')

    def test_explicit_negation_is_not_a_completed_debit(self):
        for text in (
            'Your card ending 2342 has not been charged AED 1200.00.',
            'Your card ending 2342 was not charged AED 1200.00.',
            'Your card ending 2342 has never been debited AED 1200.00.',
            "Your card ending 2342 hasn't been charged AED 1200.00.",
            'Your card ending 2342 has not yet been charged AED 1200.00.',
            'No money was debited AED 1200 from your card ending 2342.',
        ):
            with self.subTest(text=text):
                self.assertIsNone(t.fastpath.classify(item('EmiratesNBD', text)))
        actual = item('EmiratesNBD', 'Your card was charged AED 1200.00. If you did not authorize this, call us.')
        self.assertEqual(t.fastpath.classify(actual)['kind'], 'debit')

    def test_actual_debits_vs_prospective_payment_notices(self):
        for text, alert in [
            ('Your credit card payment of AED 5,000.00 is due on 20 Nov.', False),
            ('Your credit card payment of AED 5,000.00 due by 20 Nov.', False),
            ('Your credit card payment of AED 5,000.00 due 20 Nov.', False),
            ('Your credit card payment of AED 5,000.00 due 20Nov.', False),
            ('Your credit card payment of AED 5,000.00 due 20/11/2026.', False),
            ('Your credit card payment of AED 5,000.00 is payable on 20 Nov.', False),
            ('Your credit card payment of AED 5,000.00 must be paid before 20 Nov.', False),
            ('Your card ending 2342 will be charged AED 1200.00 on 20 Nov.', False),
            ('Your card ending 2342 will be debited AED 1200.00 on 20 Nov.', False),
            ('Your card ending 2342 may be charged AED 1200.00.', False),
            ('Your card ending 2342 is going to be charged AED 1200.00.', False),
            ('Your card ending 2342 is about to be debited AED 1200.00.', False),
            ('Upcoming card payment of AED 1200 on 20 Nov.', False),
            ('Your card payment of AED 1200 has been scheduled for 20 Nov.', False),
            ('Payment reminder: your card payment of AED 1200.', False),
            ('Your card ending 2342 was charged AED 1200.00 on 20 Nov.', True),
            ('Your card ending 2342 has been debited AED 1200.00 on 20 Nov.', True),
            ('Purchase of AED 1200 with your card ending 2342 at DUE STORE.', True),
        ]:
            with self.subTest(text=text):
                self.assertEqual(t.fastpath.classify(item('EmiratesNBD', text)) is not None, alert)

    def test_existing_money_case_bank_sender_variants(self):
        for sender, label in [
            ('EmiratesNBD', 'Emirates NBD'), ('Emirates NBD', 'Emirates NBD'),
            ('Emirates-NBD', 'Emirates NBD'), ('EmiratesIslamic', 'Emirates Islamic'),
            ('Emirates Islamic', 'Emirates Islamic'), ('EI SMS', 'Emirates Islamic'),
            ('EI-SMS', 'Emirates Islamic'), ('EISMS', 'Emirates Islamic'),
            ('Mashreq', 'Mashreq'), ('ADCB', 'ADCB'), ('Wio', 'Wio'),
            ('WioPersonal', 'Wio'), ('WioBusiness', 'Wio'),
        ]:
            with self.subTest(sender=sender):
                debit = item(sender, 'Purchase of AED 1200 with your Credit Card ending 2342 at SHOP.')
                login = item(sender, 'New device registered for mobile banking.')
                self.assertEqual(t.fastpath.classify(debit)['kind'], 'debit')
                self.assertEqual(t.fastpath.classify(login)['kind'], 'login')
                self.assertEqual(t.fastpath.sender_label(sender), label)
                self.assertEqual(t.fastpath.classify({**debit, 'sender': sender.lower()})['kind'], 'debit')
        wio = item('WioPersonal', 'Payment of USD 300.00 was done at SHOP using your Wio debit card ending with 2342.')
        self.assertEqual(t.fastpath.classify(wio)['kind'], 'debit')

    def test_debit_amount_terminators_and_precision(self):
        for amount, suffix, alert in [
            ('1,200.00', '', True), ('1,200.00', '.', True), ('1,200.00', ', thanks', True),
            ('1,200.00', '; ref 1234', True), ('1,200.00', '!', True), ('1,200.00', ')', True),
            ('1200', '.', True), ('1200.001', '.', False), ('1200.0001', '', False),
            ('1200,0000', '', False), ('999.99', '.', False),
        ]:
            with self.subTest(amount=amount, suffix=suffix):
                msg = item('Mashreq', 'Credit Card Purchase Card Ending: 9546 At: SHOP Amount: AED ' + amount + suffix)
                self.assertEqual(t.fastpath.classify(msg) is not None, alert)

    def test_requested_otp_requires_exact_sender_account_and_preceding_ten_minutes(self):
        msg = item('WHOOP <support@whoop.com>', 'Your sign-in code is 123456', source='email', account='gmail')
        for sender, account, at, expected in [
            ('support@whoop.com', 'gmail', 400, True), ('support@whoop.com', 'gmail', 399, False),
            ('support@whoop.com', 'gmail', 1001, False), ('support@whoop.com', 'fund', 990, False),
            ('no-reply@google.com', 'gmail', 990, False),
        ]:
            with self.subTest(sender=sender, account=account, at=at):
                result = t.fastpath.classify(msg, [{'sender': sender, 'account': account, 'at': at}])
                self.assertEqual(result is None, expected)

    def test_currency_thresholds_and_configured_conversion(self):
        for currency, amount, rates, alert in [
            ('USD', '272.29', {}, False), ('USD', '272.30', {}, True), ('SAR', '1022', {}, True),
            ('EUR', '250', {'EUR': '4'}, True), ('EUR', '249.99', {'EUR': '4'}, False),
            ('EUR', '500', {}, False),
            ('BHD', '103', {}, True), ('BHD', '103.0', {}, True), ('BHD', '103.00', {}, True),
            ('BHD', '103.000', {}, True), ('BHD', '1,103.000', {}, True),
            ('BHD', '102.382', {}, False), ('BHD', '102.383', {}, True),
            ('OMR', '105.000', {}, True), ('OMR', '104.697', {}, False),
            ('OMR', '104.698', {}, True), ('KWD', '100.000', {'KWD': '12'}, True),
            ('AED', '1000.001', {}, False), ('USD', '300.001', {}, False),
        ]:
            with self.subTest(currency=currency, amount=amount):
                msg = item('Mashreq', f'Purchase of {currency} {amount} with your Credit Card ending 9546 at SHOP.')
                self.assertEqual(t.fastpath.classify(msg, rates=rates) is not None, alert)

    def test_bulk_auth_promotion_is_not_alerted(self):
        self.assertIsNone(t.fastpath.classify(item(preview='Your login code discount', list_unsubscribe=True)))

    def test_full_mail_body_is_read_before_deciding_and_secrets_are_not_copied(self):
        raw = ('From: support@anthropic.com\r\nSubject: Sign in\r\nContent-Type: text/plain\r\n\r\n'
               + 'Padding ' * 100 + 'Your secure link to Claude: https://example.test/secret').encode()
        request = {'seen': [], 'rules': [], 'fast': True, 'actions': []}
        with patch.object(t, 'fetch_verified', return_value=[(1, '', raw)]):
            msg, reason = t.mail_record(None, None, 'fund', 1,
                (1, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0]), 0, 1001, request)
        self.assertIsNone(reason)
        self.assertEqual(msg['hard_alert']['kind'], 'auth')
        self.assertNotIn('secret', msg['hard_alert']['text'])

    def test_auth_mail_runs_prefilter_but_sim_login_and_debit_bypass_it(self):
        for sender, text, kind in (
            ('Bank', 'Your verification code is 123456.', 'auth'),
            ('du', 'Your SIM card has been swapped.', 'sim'),
            ('Google', 'New sign-in on Windows', 'login'),
            ('Mashreq', 'Purchase of AED 1000 with your card ending 9546 at SHOP.', 'debit'),
        ):
            with self.subTest(kind=kind):
                raw = ('From: ' + sender + '\r\nSubject: Notice\r\nContent-Type: text/plain\r\n\r\n' + text).encode()
                with patch.object(t, 'fetch_verified', return_value=[(1, '', raw)]), \
                     patch.object(t, 'prefilter', return_value='learned_noise') as prefilter:
                    msg, reason = t.mail_record(None, None, 'fund', 1,
                        (1, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0]), 0, 1001,
                        {'seen': [], 'rules': [], 'fast': True, 'actions': []})
                self.assertEqual(msg['hard_alert']['kind'], kind)
                self.assertEqual(reason, 'learned_noise' if kind == 'auth' else None)
                self.assertEqual(prefilter.call_count, 1 + int(kind == 'auth'))


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.live = self.root / 'inbox-triage'
        self.live.mkdir()
        self.wd = self.root / 'inbox-triage-fastpath'
        self.wd.mkdir()
        self.data = self.root / 'data'
        self.data.mkdir()
        self.calls = self.root / 'calls.jsonl'
        self.stub = self.root / 'notify.py'
        self.stub.write_text('''import hashlib, json, os, sqlite3, sys
from pathlib import Path
assert 'BUN_INSPECT' not in os.environ
with Path(os.environ['CALLS']).open('a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
if os.environ.get('FAIL_CHANNEL') == sys.argv[1]: sys.exit(1)
if sys.argv[1] == 'send':
    key = next(a.split('=', 1)[1] for a in sys.argv if a.startswith('--key='))
    state = os.environ.get('SEND_STATE', 'sent')
    attempts = int(os.environ.get('SEND_ATTEMPTS', '1' if state == 'sent' else '0'))
    with sqlite3.connect(os.environ['BRIDGE_DB_FIXTURE']) as connection:
        connection.execute('INSERT OR IGNORE INTO outbox VALUES (?,?,?,?)',
                           ('send:' + hashlib.sha256(key.encode()).hexdigest(), state, attempts,
                            'test-physical-id' if state == 'sent' else None))

''')
        self.stack.enter_context(patch.dict(os.environ, {'WATCH_DIR': str(self.wd), 'ROBOB_TEST': '1',
            'CALLS': str(self.calls), 'INBOX_TRIAGE_SPECTRUM_CLI': str(self.stub),
            'ROBOB_WATCH_TELEGRAM_CLI': str(self.stub), 'BUN_INSPECT': 'remove-me', 'FAIL_CHANNEL': '', 'SEND_STATE': 'sent', 'SEND_ATTEMPTS': '1',
            'BRIDGE_DB_FIXTURE': str(self.root / 'bridge.sqlite')}))
        for key, value in [('LIVE', self.live), ('DATA', self.data), ('BUN', Path(sys.executable))]:
            self.stack.enter_context(patch.object(t, key, value))
        self.bridge_db = self.root / 'bridge.sqlite'
        with sqlite3.connect(self.bridge_db) as connection:
            connection.execute('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)')
            connection.execute('CREATE TABLE outbox (id TEXT PRIMARY KEY, state TEXT, attempts INTEGER, providerId TEXT)')
            connection.execute('INSERT INTO kv VALUES (?,?)', ('route', json.dumps({'id': 'ardud-control:thread:owner', 'generation': 1})))
        self.stack.enter_context(patch.object(t, 'BRIDGE_DB', self.bridge_db))
        t.atomic(self.live / 'cursor.json', {'initialized_at': 900, 'cursors': {'imessage': 9000}, 'queue': [],
                                           'outbox': {'run': 'blocked', 'event': 'old five-minute batch'}})

    def run_items(self, items, dry=False):
        collected = {'imessage': {'cursor': 9001, 'items': items, 'drops': {}, 'scanned': len(items)}}
        with patch.object(t, 'collect', return_value=(collected, {})), \
             patch.object(t, 'classify', side_effect=AssertionError('fast path must not call model')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            result = t.run_fast(types.SimpleNamespace(dry_run_hours=1 if dry else None))
            self.assertEqual(result, 0)
        return output.getvalue()

    def notifications(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_spaced_and_unspaced_otp_are_log_only_and_expected_stays_batch(self):
        for n, code in enumerate(('123456', '123 456', '123\u00a0456', '12 34 56', '1234 5678')):
            with self.subTest(code=code):
                msg = item('Bank', f'Your verification code is {code}. Do not share it.', id=f'imsg:spaced{n}')
                before = len(self.notifications())
                self.run_items([msg])
                self.run_items([msg])
                self.assertEqual(len(self.notifications()) - before, 0)
                self.assertEqual(t.read_json(self.wd / 'cursor.json')['pending'], {})
        with patch.object(t.time, 'time', return_value=990):
            t.expect_auth('Bank')
        before = len(self.notifications())
        self.run_items([item('Bank', 'Your verification code is 123 456.', id='imsg:expected-spaced')])
        self.assertEqual(len(self.notifications()), before)

    def test_access_before_device_alerts_both_once(self):
        for n, text in enumerate(('Your account was accessed from a new device.',
                                  'You signed in from a new device.', 'You logged in from a new device.')):
            msg = item('Mashreq', text, id=f'imsg:access{n}')
            before = len(self.notifications())
            self.run_items([msg])
            self.run_items([msg])
            self.assertEqual(len(self.notifications()) - before, 2)

    def test_button_mail_collects_without_alerting_or_persisting_target(self):
        helper = types.SimpleNamespace(html_to_text=lambda value: re.sub(r'<[^>]+>', ' ', value))
        for n, (mime, body, bulk, expected) in enumerate((
            ('text/html', '<p>Click the button below to securely sign in to Claude. This link expires in 15 minutes.</p>'
             '<a href="https://example.test/magic-login?token=fixture">Sign in</a>', False, False),
            ('text/html', "<a href='https://example.test/auth?token=fixture'><span>Log</span> in</a>", False, True),
            ('text/html', '<a href="https://example.test/auth?token=fixture">Sign in</a>', True, False),
            ('multipart/alternative; boundary=fixture', '--fixture\r\nContent-Type: text/plain\r\n\r\nClick below.\r\n'
             '--fixture\r\nContent-Type: text/html\r\n\r\n<a href="https://example.test/auth?token=fixture">Sign in</a>\r\n--fixture--', False, False),
        )):
            with self.subTest(mime=mime, bulk=bulk, expected=expected):
                headers = 'List-Unsubscribe: <mailto:unsubscribe@example.test>\r\nPrecedence: bulk\r\n' if bulk else ''
                raw = ('From: support@anthropic.com\r\nSubject: Sign in to Claude\r\n' + headers
                       + f'Content-Type: {mime}\r\n\r\n{body}').encode()
                actions = [{'sender': 'support@anthropic.com', 'account': 'fund', 'at': 990}] if expected else []
                request = {'seen': [], 'rules': [], 'fast': True, 'actions': actions}
                with patch.object(t, 'fetch_verified', return_value=[(n + 1, '', raw)]):
                    msg, _ = t.mail_record(None, helper, 'fund', 1,
                        (n + 1, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0]), 0, 1001, request)
                self.assertEqual(bool(msg['hard_alert']), not (bulk or expected))
                before = len(self.notifications())
                self.run_items([msg])
                self.run_items([msg])
                self.assertEqual(len(self.notifications()) - before, 0)
                self.assertNotIn('https:', json.dumps(t.read_json(self.wd / 'cursor.json')))
        for call in self.notifications():
            self.assertNotIn('fixture', next(a.split('=', 1)[1] for a in call if a.startswith('--text=')))

    def test_bank_portal_footer_never_suppresses_a_debit(self):
        helper = types.SimpleNamespace(html_to_text=lambda value: re.sub(r'<[^>]+>', ' ', value))
        n = 100
        for mime, footer in (
            ('text/plain', 'Log in: https://bank.example.test/login'),
            ('text/html', '<a href="https://bank.example.test/login">Log in</a>'),
            ('text/html', "<a href='https://bank.example.test/login'><span>Sign</span> in</a>"),
        ):
            for expected in (False, True):
                with self.subTest(mime=mime, expected=expected):
                    n += 1
                    raw = ('From: EmiratesNBD\r\nSubject: Card purchase\r\n' + f'Content-Type: {mime}\r\n\r\n'
                           + 'Purchase of AED 1,200.00 with your Credit Card ending 2342. ' + footer).encode()
                    actions = [{'sender': 'emiratesnbd', 'account': 'fund', 'at': 990}] if expected else []
                    with patch.object(t, 'fetch_verified', return_value=[(n, '', raw)]):
                        msg, _ = t.mail_record(None, helper, 'fund', 1,
                            (n, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0]), 0, 1001,
                            {'seen': [], 'rules': [], 'fast': True, 'actions': actions})
                    self.assertEqual(msg['hard_alert']['kind'], 'debit')
                    before = len(self.notifications())
                    self.run_items([msg])
                    self.run_items([msg])
                    self.assertEqual(len(self.notifications()) - before, 2)
                    for call in self.notifications()[before:]:
                        self.assertIn('Bank debit: AED 1,200.00', next(a.split('=', 1)[1] for a in call if a.startswith('--text=')))

    def test_explicit_link_subject_survives_hidden_html_target(self):
        helper = types.SimpleNamespace(html_to_text=lambda value: re.sub(r'<[^>]+>', ' ', value))
        anchor = "<a href='https://example.test/auth?token=fixture'><span>Sign</span> in</a>"
        for n, (mime, body) in enumerate((
            ('text/html', anchor),
            ('multipart/alternative; boundary=fixture', '--fixture\r\nContent-Type: text/plain\r\n\r\nClick below.\r\n'
             '--fixture\r\nContent-Type: text/html\r\n\r\n' + anchor + '\r\n--fixture--'),
        ), 200):
            with self.subTest(mime=mime):
                raw = ('From: support@anthropic.com\r\nSubject: Secure link to log in to Claude\r\n'
                       + f'Content-Type: {mime}\r\n\r\n{body}').encode()
                with patch.object(t, 'fetch_verified', return_value=[(n, '', raw)]):
                    msg, _ = t.mail_record(None, helper, 'fund', 1,
                        (n, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0]), 0, 1001,
                        {'seen': [], 'rules': [], 'fast': True, 'actions': []})
                self.assertEqual(msg['hard_alert']['kind'], 'auth')
                self.assertNotIn('https:', msg['preview'])
                before = len(self.notifications())
                self.run_items([msg])
                self.run_items([msg])
                self.assertEqual(len(self.notifications()) - before, 0)
                for call in self.notifications()[before:]:
                    self.assertNotIn('fixture', next(a.split('=', 1)[1] for a in call if a.startswith('--text=')))

    def test_sim_login_and_debit_send_both_once_and_auth_is_log_only(self):
        rows = [item(sender, text, id=f'imsg:{n}') for n, (sender, text, kind) in enumerate(CORPUS) if kind]
        before = (self.live / 'cursor.json').read_bytes()
        for row in rows:
            self.run_items([row])
            self.run_items([row])
        alerted = sum(kind in ('sim', 'login', 'debit') for _, _, kind in CORPUS)
        self.assertEqual(len(self.notifications()), 2 * alerted)
        self.assertEqual((self.live / 'cursor.json').read_bytes(), before)
        for a in self.notifications():
            if a[0] == 'send':
                self.assertEqual(next(arg.split('=', 1)[1] for arg in a if arg.startswith('--session=')), 'ardud-control:thread:owner')
        for channel in ('notify', 'send'):
            keys = [next(arg.split('=', 1)[1] for arg in a if arg.startswith('--key=')) for a in self.notifications() if a[0] == channel]
            self.assertEqual(len(keys), len(set(keys)))

    def test_requested_and_small_debits_remain_batch_only(self):
        t.atomic(self.data / 'inflight-actions.json', [{'sender': 'whoop', 'at': 990}])
        self.run_items([item('WHOOP', 'Your sign-in code is 123456'), item('Mashreq', 'Purchase of AED 999 with your card ending 9546 at SHOP.')])
        self.assertEqual(self.notifications(), [])

    def test_pending_auth_is_dropped_without_delivery(self):
        for identity in (None, {'sender': 'Bank', 'ts': 1000}):
            with self.subTest(identity=identity):
                t.atomic(self.wd / 'cursor.json', {'initialized_at': 900, 'cursors': {}, 'pending': {
                    'imsg:old-auth': {'kind': 'auth', 'text': 'Security: an OTP from your bank',
                                     'at': 1000, 'auth_identity': identity}}})
                self.run_items([])
                self.assertEqual(t.read_json(self.wd / 'cursor.json')['pending'], {})
                self.assertEqual(self.notifications(), [])

    def test_normal_urgent_auth_uses_generic_text(self):
        for text in ('Your verification code is 123456.', 'Your secure link to Claude: [link]'):
            with self.subTest(text=text):
                hit = {**item('Bank', text), 'urgency': 'urgent', 'reason': 'Security: review this account update'}
                with patch.object(t, 'chat_down', return_value=(True, 'fixture')), \
                     patch.object(t, 'send_urgent', return_value=1001) as send:
                    t.urgent_alerts({}, {'hits': [hit]}, self.live, 1001)
                sent = send.call_args.args[1]
                self.assertIn('review this account update', sent)
                self.assertNotIn('no matching in-flight action', sent)
                self.assertNotIn('Check sessions and rotate', sent)
                self.assertNotIn('123456', sent)

    def test_normal_urgent_auth_does_not_retry_legacy_fastpath_text(self):
        for where in ('pending', 'text', 'telegram_text', 'imessage_text'):
            with self.subTest(where=where):
                hit = {**item('Bank', 'Your verification code is 123456.'),
                       'urgency': 'urgent', 'reason': 'Security: review this account update'}
                text = t.fastpath.classify(hit)['text']
                state = {'telegram_pending': {hit['id']: {'text': text}}} if where == 'pending' else {}
                ledger = {} if where == 'pending' else {hit['id']: {where: text}}
                t.atomic(self.live / 'urgent-delivery.json', ledger)
                with patch.object(t, 'chat_down', return_value=(True, 'fixture')), \
                     patch.object(t, 'send_urgent', return_value=1001) as send:
                    t.urgent_alerts(state, {'hits': [hit]}, self.live, 1001)
                send.assert_not_called()
                self.assertNotIn(hit['id'], state.get('telegram_pending', {}))

    def test_legacy_auth_payload_is_blocked_after_normal_mail_redaction(self):
        # Shape table covers issuance evidence that survives, is redacted or is hidden in HTML.
        cases = (
            ('OTP unspaced', 'Notice', 'text/plain', 'Your verification code is 123456.'),
            ('OTP spaced', 'Notice', 'text/plain', 'Your verification code is 123 456.'),
            ('OTP alphanumeric', 'Notice', 'text/plain', 'Your verification code is A1B2C3.'),
            ('OTP subject', 'Verification code: 123456', 'text/plain', 'Use this to sign in.'),
            ('magic plain', 'Sign in', 'text/plain', 'Your secure link to Claude: https://example.test/private'),
            ('magic HTML', 'Sign in', 'text/html', '<a href="https://example.test/private">Sign in</a>'),
            ('magic multipart', 'Sign in', 'multipart/alternative; boundary=fixture',
             '--fixture\r\nContent-Type: text/plain\r\n\r\nClick below.\r\n'
             '--fixture\r\nContent-Type: text/html\r\n\r\n<a href="https://example.test/private">Sign in</a>\r\n--fixture--'),
        )
        helper = types.SimpleNamespace(html_to_text=lambda value: re.sub(r'<[^>]+>', ' ', value))
        for shape, subject, mime, body in cases:
            for where in ('pending', 'text', 'telegram_text', 'imessage_text'):
                with self.subTest(shape=shape, where=where):
                    raw = (f'From: support@anthropic.com\r\nSubject: {subject}\r\nContent-Type: {mime}\r\n\r\n{body}').encode()
                    with patch.object(t, 'fetch_verified', return_value=[(1, '', raw)]):
                        msg, _ = t.mail_record(None, helper, 'fund', 1,
                            (1, '01-Jan-1970 00:16:40 +0000', raw.split(b'\r\n\r\n')[0]), 0, 1001,
                            {'seen': [], 'rules': []})
                    if shape in ('OTP unspaced', 'OTP spaced', 'OTP alphanumeric', 'magic HTML', 'magic multipart'):
                        self.assertIsNone(t.fastpath.classify(msg))
                    hit = {**msg, 'urgency': 'urgent', 'reason': 'Security: review this account update'}
                    what = 'a sign-in link' if shape.startswith('magic') else 'an OTP'
                    text = f'Security: {what} from Claude; no matching in-flight action in the last 10 minutes.'
                    state = {'telegram_pending': {hit['id']: {'text': text}}} if where == 'pending' else {}
                    ledger = {} if where == 'pending' else {hit['id']: {where: text}}
                    t.atomic(self.live / 'urgent-delivery.json', ledger)
                    with patch.object(t, 'chat_down', return_value=(True, 'fixture')), \
                         patch.object(t, 'send_urgent', return_value=1001) as send:
                        t.urgent_alerts(state, {'hits': [hit]}, self.live, 1001)
                    send.assert_not_called()
                    self.assertNotIn(hit['id'], state.get('telegram_pending', {}))

    def test_normal_batch_filters_auth_and_does_not_skip_old_fastpath_delivery(self):
        t.atomic(self.wd / 'watcher.json', {'id': 'inbox-triage-fastpath', 'paused': False})
        t.atomic(self.live / 'cursor.json', {'initialized_at': 900, 'cursors': {}, 'queue': []})
        auth = item('Bank', 'Your verification code is 123456.', ts=t.time.time() - 60)
        t.atomic(self.live / 'urgent-delivery.json', {auth['id']: {'telegram': 1000, 'imessage': 1000}})
        result = {'imessage': {'cursor': 9001, 'items': [auth], 'drops': {}, 'scanned': 1}}
        with patch.dict(os.environ, {'WATCH_DIR': str(self.live)}), \
             patch.object(t, 'collect', return_value=(result, {})), \
             patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
             patch.object(t, 'payment_checks', return_value=({}, None)), \
             patch.object(t, 'renewal_checks', return_value=({}, None)), \
             patch.object(t, 'charge_checks', return_value=({}, set(), None)), \
             patch.object(t, 'handled', return_value=({}, {})), \
             patch.object(t, 'build_context', return_value={}), \
             patch.object(t, 'prefilter', wraps=t.prefilter) as prefilter, \
             patch.object(t, 'classify_batch', return_value=([], {'cost_usd': 0})) as classify, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=None, report=None)), 0)
        self.assertTrue(any(call.args[0]['id'] == auth['id'] for call in prefilter.call_args_list))
        self.assertEqual([row['id'] for row in classify.call_args.args[0]], [auth['id']])

    def test_redacted_auth_mail_with_legacy_login_delivery_reaches_normal_classifier(self):
        cases = (
            ('OTP unspaced', 'Notice', 'text/plain', 'Your verification code is 123456.'),
            ('OTP spaced', 'Notice', 'text/plain', 'Your verification code is 123 456.'),
            ('OTP alphanumeric', 'Notice', 'text/plain', 'Your verification code is A1B2C3.'),
            ('OTP subject', 'Verification code: 123456', 'text/plain', 'Use this to sign in.'),
            ('magic plain', 'Sign in', 'text/plain', 'Your secure link to Google: https://example.test/private'),
            ('magic HTML', 'Sign in', 'text/html', '<a href="https://example.test/private">Sign in</a>'),
            ('magic multipart', 'Sign in', 'multipart/alternative; boundary=fixture',
             '--fixture\r\nContent-Type: text/plain\r\n\r\nNew sign-in on Windows. Click below.\r\n'
             '--fixture\r\nContent-Type: text/html\r\n\r\n<a href="https://example.test/private">Sign in</a>\r\n--fixture--'),
        )
        now = t.time.time()
        internal = t.dt.datetime.fromtimestamp(now - 60, t.dt.timezone.utc).strftime('%d-%b-%Y %H:%M:%S %z')
        helper = types.SimpleNamespace(html_to_text=lambda value: re.sub(r'<[^>]+>', ' ', value))
        t.atomic(self.wd / 'watcher.json', {'id': 'inbox-triage-fastpath', 'paused': False})
        for shape, subject, mime, body in cases:
            for field in ('text', 'telegram_text', 'imessage_text'):
                with self.subTest(shape=shape, field=field):
                    prefix = '' if shape == 'magic multipart' else 'New sign-in on Windows. '
                    raw = (f'From: Google\r\nSubject: {subject}\r\nContent-Type: {mime}\r\n\r\n{prefix}{body}').encode()
                    record = (1, internal, raw.split(b'\r\n\r\n')[0])
                    with patch.object(t, 'fetch_verified', return_value=[(1, '', raw)]):
                        fast, _ = t.mail_record(None, helper, 'fund', 1, record, 0, now,
                                               {'seen': [], 'rules': [], 'fast': True})
                        normal, _ = t.mail_record(None, helper, 'fund', 1, record, 0, now,
                                                 {'seen': [], 'rules': []})
                    original = (t.fastpath.classify({**normal, 'subject': subject, 'preview': body})
                                if shape == 'OTP subject' else fast['hard_alert'])
                    self.assertEqual(original['kind'], 'auth')
                    self.assertEqual(t.fastpath.classify(normal)['kind'], 'auth' if shape == 'magic plain' else 'login')
                    t.atomic(self.live / 'cursor.json', {'initialized_at': now - 300, 'cursors': {}, 'queue': []})
                    t.atomic(self.live / 'urgent-delivery.json', {normal['id']: {
                        'telegram': now - 30, 'imessage': now - 30, field: original['text']}})
                    result = {'fund': {'cursor': {'uid': 1, 'validity': 1}, 'items': [normal], 'drops': {}, 'scanned': 1}}
                    with patch.dict(os.environ, {'WATCH_DIR': str(self.live)}), \
                         patch.object(t, 'collect', return_value=(result, {})), \
                         patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                         patch.object(t, 'payment_checks', return_value=({}, None)), \
                         patch.object(t, 'renewal_checks', return_value=({}, None)), \
                         patch.object(t, 'charge_checks', return_value=({}, set(), None)), \
                         patch.object(t, 'handled', return_value=({}, {})), \
                         patch.object(t, 'build_context', return_value={}), \
                         patch.object(t, 'classify_batch', return_value=([], {'cost_usd': 0})) as classify, \
                         contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=None, report=None)), 0)
                    self.assertEqual([row['id'] for row in classify.call_args.args[0]], [normal['id']])

    def test_failed_initial_collection_recovers_from_saved_time_without_rebaselining(self):
        # A brand-new installation has no inherited collector state.
        (self.live / 'cursor.json').unlink()
        clock, baselines = [1000.0], []
        def collect(state, now, *args, **kwargs):
            baselines.append(kwargs['baseline'])
            if len(baselines) == 1:
                return {}, {'gmail': 'unavailable', 'imessage': 'unavailable'}
            self.assertEqual(state['initialized_at'], 1000)
            return {'imessage': {'cursor': 9001, 'items': [item('Google', 'New sign-in on Linux', ts=1005)]}}, {}
        with patch.object(t.time, 'time', side_effect=lambda: clock[0]), \
             patch.object(t, 'collect', side_effect=collect), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.run_fast(types.SimpleNamespace(dry_run_hours=None)), 1)
            clock[0] = 1015
            self.assertEqual(t.run_fast(types.SimpleNamespace(dry_run_hours=None)), 0)
        self.assertEqual(baselines, [True, False])
        self.assertEqual(len(self.notifications()), 2)

    def test_empty_inherited_cursors_use_the_original_initialization_window(self):
        t.atomic(self.live / 'cursor.json', {'initialized_at': 900, 'cursors': {}, 'queue': []})
        with patch.object(t, 'collect', return_value=({}, {})) as collect, contextlib.redirect_stdout(io.StringIO()):
            t.run_fast(types.SimpleNamespace(dry_run_hours=None))
        self.assertFalse(collect.call_args.kwargs['baseline'])
        self.assertEqual(collect.call_args.args[0]['initialized_at'], 900)

    def test_auth_evidence_committed_during_collection_is_rechecked(self):
        clock = [1000.0]
        msg = item('WHOOP <support@whoop.com>', 'Your verification code is: 123456.', ts=1001, source='email', account='gmail')
        msg['hard_alert'] = t.fastpath.classify(msg)
        msg['auth_identity'] = {k: msg[k] for k in ('sender', 'account', 'ts')}
        def collect(*args, **kwargs):
            clock[0] = 1000.5
            t.expect_auth('support@whoop.com', 'gmail')
            clock[0] = 1001.0
            return {'gmail': {'cursor': 12, 'items': [msg]}}, {}
        with patch.object(t.time, 'time', side_effect=lambda: clock[0]), \
             patch.object(t, 'collect', side_effect=collect), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.run_fast(types.SimpleNamespace(dry_run_hours=None)), 0)
        self.assertEqual(self.notifications(), [])
        self.assertEqual(t.read_json(self.wd / 'cursor.json')['pending'], {})

    def test_queued_imessage_is_not_delivery_and_does_not_get_reenqueued(self):
        os.environ.update(SEND_STATE='pending', SEND_ATTEMPTS='0')
        self.run_items([item()])
        self.assertIn('imsg:9001', t.read_json(self.wd / 'cursor.json')['pending'])
        self.assertNotIn('imessage', t.read_json(self.live / 'urgent-delivery.json')['imsg:9001'])
        self.run_items([])
        self.assertEqual(len(self.notifications()), 2)
        with sqlite3.connect(self.bridge_db) as connection:
            connection.execute("UPDATE outbox SET state='sent', attempts=1, providerId='physical-send'")
        self.run_items([])
        self.assertEqual(len(self.notifications()), 2)
        self.assertEqual(t.read_json(self.wd / 'cursor.json')['pending'], {})

    def test_lost_queue_response_retains_pending_hint_for_batch_fallback(self):
        from subprocess import TimeoutExpired
        os.environ.update(FAIL_CHANNEL='notify', SEND_STATE='pending', SEND_ATTEMPTS='0')
        original = t.subprocess.run
        def lost_ack(command, **kwargs):
            result = original(command, **kwargs)
            if command[2] == 'send':
                raise TimeoutExpired('bridge', 4)
            return result
        with patch.object(t.subprocess, 'run', side_effect=lost_ack):
            self.run_items([item()])
        hit = {**item(), 'reason': 'Security: SIM changed', 'urgency': 'urgent'}
        with patch.object(t, 'chat_down', return_value=(False, '')):
            t.urgent_alerts({}, {'hits': [hit]}, self.live, 1001)
        self.assertTrue(hit['imessage_pending'])
        self.assertIn('check it before sending another notice', t.event_text('batch', [hit], {}))
        self.run_items([])
        self.assertEqual(len([a for a in self.notifications() if a[0] == 'send']), 1)

    def test_cancelled_before_dispatch_gets_a_safe_new_key(self):
        os.environ.update(SEND_STATE='pending', SEND_ATTEMPTS='0')
        self.run_items([item()])
        with sqlite3.connect(self.bridge_db) as connection:
            connection.execute("UPDATE outbox SET state='cancelled'")
            connection.execute("UPDATE kv SET value=? WHERE key='route'", (json.dumps({'id': 'ardud-control:thread:new', 'generation': 2}),))
        os.environ.update(SEND_STATE='sent', SEND_ATTEMPTS='1')
        self.run_items([])
        sends = [a for a in self.notifications() if a[0] == 'send']
        self.assertEqual(len(sends), 2)
        self.assertEqual(next(arg.split('=', 1)[1] for arg in sends[1] if arg.startswith('--key=')), next(arg.split('=', 1)[1] for arg in sends[0] if arg.startswith('--key=')) + ':r1')
        self.assertEqual(t.read_json(self.wd / 'cursor.json')['pending'], {})

    def test_uncertain_or_dispatched_cancellation_never_gets_a_new_key(self):
        os.environ.update(SEND_STATE='uncertain', SEND_ATTEMPTS='1')
        self.run_items([item()])
        self.run_items([])
        with sqlite3.connect(self.bridge_db) as connection:
            connection.execute("UPDATE outbox SET state='cancelled'")
        self.run_items([])
        self.assertEqual(len([a for a in self.notifications() if a[0] == 'send']), 1)
        self.assertIn('imsg:9001', t.read_json(self.wd / 'cursor.json')['pending'])

    def test_one_channel_failure_retries_only_that_channel_with_immutable_text(self):
        os.environ['FAIL_CHANNEL'] = 'send'
        self.run_items([item()])
        self.assertIn('imsg:9001', t.read_json(self.wd / 'cursor.json')['pending'])
        os.environ['FAIL_CHANNEL'] = ''
        self.run_items([])
        calls = self.notifications()
        self.assertEqual([a[0] for a in calls], ['notify', 'send', 'send'])
        self.assertEqual(calls[1], calls[2])
        self.assertEqual(t.read_json(self.wd / 'cursor.json')['pending'], {})

    def test_outage_path_reuses_same_sender_and_ledger_after_fast_delivery(self):
        self.run_items([item()])
        msg = {**item(), 'urgency': 'urgent', 'reason': 'Security: SIM changed'}
        with patch.object(t, 'chat_down', return_value=(True, 'down')):
            t.urgent_alerts({}, {'hits': [msg]}, self.live, 1001)
        self.assertEqual(len(self.notifications()), 2)
        self.assertIn('already sent via iMessage and Telegram', t.event_text('batch', [msg], {}))

    def test_outage_first_preserves_original_payload_and_key(self):
        msg = {**item(), 'urgency': 'urgent', 'reason': 'Security: SIM changed'}
        with patch.object(t, 'chat_down', return_value=(True, 'down')):
            t.urgent_alerts({}, {'hits': [msg]}, self.live, 1001)
        self.run_items([item()])
        self.assertEqual([a[0] for a in self.notifications()], ['notify', 'send'])
        self.assertEqual(next(arg.split('=', 1)[1] for arg in self.notifications()[0] if arg.startswith('--text=')),
                         next(arg.split('=', 1)[1] for arg in self.notifications()[1] if arg.startswith('--text=')))

    def test_dry_and_scratch_runs_never_send_or_change_live_files(self):
        before = (self.live / 'cursor.json').read_bytes()
        self.assertIn('imsg:9001', self.run_items([item()], dry=True))
        scratch = self.root / 'scratch'
        scratch.mkdir()
        with patch.dict(os.environ, {'WATCH_DIR': str(scratch)}):
            self.assertIn('imsg:9001', self.run_items([item()]))
        self.assertEqual(self.notifications(), [])
        self.assertEqual((self.live / 'cursor.json').read_bytes(), before)
        self.assertFalse((self.live / 'urgent-delivery.json').exists())

    def test_expect_auth_records_only_sender_account_and_time(self):
        with patch.object(t.time, 'time', return_value=1000):
            t.expect_auth('WHOOP <support@whoop.com>', 'gmail')
        self.assertEqual(t.read_json(self.data / 'inflight-actions.json'),
                         [{'sender': 'support@whoop.com', 'account': 'gmail', 'at': 1000}])

    def test_full_body_rejection_cannot_be_overridden_by_a_truncated_preview(self):
        self.run_items([item('Mashreq', 'Purchase of AED 5000 with card ending 9546', hard_alert=None)])
        self.assertEqual(self.notifications(), [])

    def test_ordinary_batch_skips_security_but_still_screens_large_debits(self):
        t.atomic(self.wd / 'watcher.json', {'id': 'inbox-triage-fastpath', 'paused': False})
        state = {'initialized_at': 900, 'cursors': {}, 'queue': []}
        t.atomic(self.live / 'cursor.json', state)
        security = item()
        t.atomic(self.live / 'urgent-delivery.json', {security['id']: {'telegram': 1000, 'imessage': 1000}})
        debit = item('Mashreq', 'Purchase of AED 1000 with card ending 9546 at SHOP.', id='imsg:9002')
        ordinary = item('Clinic', 'Your appointment is confirmed.', id='imsg:9003')
        deadline = item('Wio', 'Your autopay of AED 3,532.73 failed; repay before midnight. Never share your OTP with anyone.', id='imsg:9004', ts=t.time.time(), payment_notice={'kind': 'autopay_failed'})
        result = {'imessage': {'cursor': 9003, 'items': [security, debit, ordinary, deadline], 'drops': {}, 'scanned': 4}}
        with patch.dict(os.environ, {'WATCH_DIR': str(self.live)}), \
             patch.object(t, 'collect', return_value=(result, {})), \
             patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
             patch.object(t, 'payment_checks', return_value=({deadline['id']: 'payment_case'}, None)) as payments, \
             patch.object(t, 'renewal_checks', return_value=({}, None)), \
             patch.object(t, 'charge_checks', return_value=({}, set(), None)) as charges, \
             patch.object(t, 'handled', return_value=({}, {})), \
             patch.object(t, 'build_context', return_value={}), \
             patch.object(t, 'classify_batch', return_value=([], {'cost_usd': 0})) as classify, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=None, report=None)), 0)
        self.assertIn(deadline['id'], {r['id'] for r in payments.call_args.args[0]})
        self.assertEqual({r['id'] for r in charges.call_args.args[0]}, {security['id'], debit['id'], ordinary['id']})
        self.assertEqual({r['id'] for r in classify.call_args.args[0]}, {debit['id'], ordinary['id']})

    def test_enabled_fast_watcher_suppresses_only_after_both_deliveries(self):
        t.atomic(self.wd / 'watcher.json', {'id': 'inbox-triage-fastpath', 'paused': False})
        msg = item(ts=t.time.time())
        result = {'imessage': {'cursor': 9001, 'items': [msg], 'drops': {}, 'scanned': 1}}
        for delivered, transport_sent in (({}, False), ({'telegram': 1000}, False), ({'imessage': 1000}, False), ({'telegram': 1000, 'imessage': 1000}, False), ({'telegram': 1000, 'imessage_text': 'Security'}, True)):
            with self.subTest(delivered=delivered):
                t.atomic(self.live / 'cursor.json', {'initialized_at': 900, 'cursors': {}, 'queue': []})
                t.atomic(self.live / 'urgent-delivery.json', {msg['id']: delivered})
                with sqlite3.connect(self.bridge_db) as connection:
                    connection.execute('DELETE FROM outbox')
                    if transport_sent:
                        key = 'inbox-triage:urgent:' + hashlib.sha256(msg['id'].encode()).hexdigest()[:16]
                        connection.execute('INSERT INTO outbox VALUES (?,?,?,?)', ('send:' + hashlib.sha256(key.encode()).hexdigest(), 'sent', 1, 'provider'))
                with patch.dict(os.environ, {'WATCH_DIR': str(self.live)}), \
                     patch.object(t, 'collect', return_value=(result, {})), \
                     patch.object(t, 'active_watchers', return_value=[]), patch.object(t, 'noise_rules', return_value=[]), \
                     patch.object(t, 'payment_checks', return_value=({}, None)), \
                     patch.object(t, 'renewal_checks', return_value=({}, None)), \
                     patch.object(t, 'charge_checks', return_value=({}, set(), None)), \
                     patch.object(t, 'handled', return_value=({}, {})), \
                     patch.object(t, 'build_context', return_value={}), \
                     patch.object(t, 'classify_batch', return_value=([], {'cost_usd': 0})) as classify, \
                     contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(t.run(types.SimpleNamespace(dry_run_hours=None, report=None)), 0)
                self.assertEqual(classify.called, not (bool(delivered.get('telegram') and delivered.get('imessage')) or transport_sent))
                hit = {**msg, 'reason': 'Security alert', 'urgency': 'urgent'}
                for channel, at in delivered.items():
                    if channel in ('telegram', 'imessage'):
                        hit[channel + '_sent_at'] = t.stamp(at)
                event = t.event_text('batch', [hit], {})
                self.assertEqual("don't alert again" in event, bool(delivered))

    def test_slow_telegram_does_not_starve_imessage_and_retries_rotate(self):
        from subprocess import TimeoutExpired
        pending = {f'imsg:{n}': {'text': 'Security: SIM/eSIM change', 'kind': 'sim', 'at': 1000} for n in range(11)}
        t.atomic(self.wd / 'cursor.json', {'initialized_at': 900, 'cursors': {}, 'pending': pending})
        clock, attempted = [1000.0], set()
        real_run = t.subprocess.run
        def slow_telegram(command, **kw):
            if command[2] == 'notify':
                attempted.add(next(arg.split('=', 1)[1] for arg in command if arg.startswith('--key=')))
                clock[0] += kw['timeout']
                raise TimeoutExpired('telegram', kw['timeout'])
            return real_run(command, **kw)
        with patch.object(t.time, 'time', side_effect=lambda: clock[0]), \
             patch.object(t.subprocess, 'run', side_effect=slow_telegram), \
             patch.object(t, 'send_health', return_value={}):
            self.run_items([])
            self.assertEqual(len(self.notifications()), 11)
            for _ in range(5):
                clock[0] += 15
                self.run_items([])
        self.assertEqual(len(self.notifications()), 11)
        self.assertEqual(len(attempted), 11)

    def test_source_directory_fast_invocation_without_watch_dir_stays_scratch(self):
        source = self.root / 'source'
        before = (self.live / 'cursor.json').read_bytes()
        collected = {'imessage': {'cursor': 9001, 'items': [item()], 'drops': {}, 'scanned': 1}}
        with patch.dict(os.environ):
            os.environ.pop('WATCH_DIR', None)
            with patch.object(t, '__file__', str(source / 'triage.py')), \
                 patch.object(sys, 'argv', ['triage.py', '--fast-only']), \
                 patch.object(t, 'collect', return_value=(collected, {})), \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(t.main(), 0)
        self.assertIn('imsg:9001', output.getvalue())
        self.assertEqual((self.live / 'cursor.json').read_bytes(), before)
        self.assertFalse((self.wd / 'cursor.json').exists())
        self.assertEqual(self.notifications(), [])

    def test_no_route_keeps_imessage_pending_without_resending_telegram(self):
        with sqlite3.connect(self.bridge_db) as connection:
            connection.execute('DELETE FROM kv')
        self.run_items([item()])
        self.assertEqual([a[0] for a in self.notifications()], ['notify'])
        self.assertIn('imsg:9001', t.read_json(self.wd / 'cursor.json')['pending'])
        with sqlite3.connect(self.bridge_db) as connection:
            connection.execute('INSERT INTO kv VALUES (?,?)', ('route', json.dumps({'id': 'ardud-control:thread:new'})))
        self.run_items([])
        self.assertEqual([a[0] for a in self.notifications()], ['notify', 'send'])

    def test_fast_mail_has_twelve_second_cap_and_no_transient_retry(self):
        from subprocess import TimeoutExpired
        with patch.object(t.subprocess, 'run', side_effect=TimeoutExpired('mail', 12)) as run:
            with self.assertRaises(TimeoutExpired):
                t.run_mail_fetch('gmail', {'fast': True})
        self.assertEqual(run.call_count, 1)
        self.assertLessEqual(run.call_args.kwargs['timeout'], 12)

    def test_poll_schedule_is_short_and_regular_batch_stays_at_five_minutes(self):
        root = Path(t.__file__).parent
        self.assertEqual(json.loads((root / 'watcher.fastpath.json').read_text())['interval_s'], 15)
        self.assertEqual(json.loads((root / 'watcher.json').read_text())['interval_s'], 300)


if __name__ == '__main__':
    unittest.main()
