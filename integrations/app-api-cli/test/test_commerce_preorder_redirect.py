import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import commerce_journal as j
import commerce_preorder as p
import commerce_redirect as r

FLOW = '10000000-0000-4000-8000-000000000001'


class RedirectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = patch.object(j, 'ROOT', Path(self.temp.name) / 'commerce')
        root.start()
        self.addCleanup(root.stop)
        j.open_flow(flow_id=FLOW, app='noon', vertical='nownow',
                    account_hash='1'*64, scope_hash='2'*64)

    def test_preparation_visible_even_after_window(self):
        rows = j.open_payments(now=j.flow_created_at(FLOW)+86400)
        self.assertEqual(rows[0]['flow_id'], FLOW)
        self.assertFalse(rows[0]['financial_send'])
        self.assertIsNone(rows[0]['sent_seconds_ago'])

    def test_open_once_across_restart_and_changed_url(self):
        opener = Mock(return_value=True)
        r.open_once(FLOW, '3'*64, 'https://bank.example/challenge?secret=private', opener=opener)
        r.open_once(FLOW, '3'*64, 'https://bank.example/changed', opener=opener)
        opener.assert_called_once()
        self.assertNotIn('private', next((j.ROOT/'redirect-attempts').glob('*.json')).read_text())
        with self.assertRaisesRegex(j.JournalError, 'INTENT_CHANGED'):
            r.open_once(FLOW, '4'*64, 'https://bank.example/changed', opener=opener)

    def test_uncertain_open_is_never_retried(self):
        opener = Mock(side_effect=TimeoutError())
        for _ in range(2):
            with self.assertRaisesRegex(j.JournalError, 'UNCONFIRMED_NO_RETRY'):
                r.open_once(FLOW, '3'*64, 'https://bank.example/challenge', opener=opener)
        opener.assert_called_once()

    def test_invalid_url_never_opens(self):
        opener = Mock()
        for url in ('file:///tmp/test', 'http://bank.example', 'https://user:pw@bank.example'):
            with self.assertRaises(j.JournalError):
                r.open_once(FLOW, '3'*64, url, opener=opener)
        opener.assert_not_called()

    def test_plain_await_never_opens_or_notifies(self):
        def recover(flow_id, challenge):
            challenge({}, {})
            return {'payment_status': 'payment_ready_to_redirect'}
        with patch.object(p, 'recover', side_effect=recover), patch.object(r, 'open_once') as opened, \
                patch.object(p, 'notify_owner') as notify:
            result = p.await_payment(FLOW, wait_seconds=0)
        self.assertTrue(result['timed_out'])
        opened.assert_not_called()
        notify.assert_not_called()

    def test_expired_preparation_refuses_challenge_before_status(self):
        with patch.object(j, 'flow_created_at', return_value=0), patch.object(p, 'recover') as recover:
            with self.assertRaisesRegex(j.JournalError, 'EXPIRED_24H'):
                p.await_payment(FLOW, open_redirect=True, wait_seconds=0)
        recover.assert_not_called()

    def test_redirect_outranks_raw_confirmation(self):
        with patch.object(p, 'recover', return_value={
                'payment_status': 'payment_confirmed', 'redirect_required': True}):
            result = p.await_payment(FLOW, wait_seconds=0)
        self.assertTrue(result['timed_out'])
        self.assertFalse(result['verification_confirmed'])

    def test_cli_pending_exception_enters_wait_without_replaying_verification(self):
        import commerce_cli as cli
        from types import SimpleNamespace
        args = SimpleNamespace(resume_flow=None, store_code='store', prepare_only=False,
                               cvv_from_keychain=True)
        flow = Mock(flow_id=FLOW)
        flow.prepare_only.return_value = {'review': {}}
        pending = j.PaymentError('NOWNOW_BANK_APPROVAL_OR_PAYMENT_PENDING', {})
        flow.prepare_payment.side_effect = pending
        with patch.object(cli, 'input_items', return_value=[]), \
                patch.object(cli, 'CommerceAuth'), patch.object(cli, 'prepared_result'), \
                patch('commerce_nownow_order.NowNowOrderFlow', return_value=flow) as cls, \
                patch.object(p, 'await_payment', return_value={'verification_confirmed': False}) as wait:
            with self.assertRaises(j.PaymentError) as caught:
                cli.order_nownow(args)
        self.assertIs(caught.exception, pending)
        wait.assert_called_once_with(FLOW, open_redirect=True)
        flow.prepare_payment.assert_called_once()
        flow.place.assert_not_called()
        cls.resume_active.assert_not_called()
        resumed = Mock()
        resumed.prepare_payment.side_effect = AssertionError('verification replay')
        resumed.place.side_effect = RuntimeError('placement boundary')
        with patch.object(cli, 'input_items', return_value=[]), \
                patch.object(cli, 'CommerceAuth'), patch.object(cli, 'prepared_result'), \
                patch('commerce_nownow_order.NowNowOrderFlow', return_value=flow) as cls, \
                patch.object(p, 'await_payment', return_value={'verification_confirmed': True}):
            cls.resume_active.return_value = resumed
            with self.assertRaisesRegex(RuntimeError, 'placement boundary'):
                cli.order_nownow(args)
        resumed.prepare_only.assert_called_once()
        resumed.prepare_payment.assert_not_called()
        resumed.place.assert_called_once()

    def test_minutes_challenge_reconciliation_preserves_unknown_fence(self):
        flow = '20000000-0000-4000-8000-000000000001'
        j.open_flow(flow_id=flow, app='noon', vertical='minutes', account_hash='7'*64, scope_hash='2'*64)
        args = dict(request_hash='3'*64, cart_hash='4'*64, review_hash='5'*64, payable_minor=100)
        j.consume(flow, 'place', kind='place', **args)
        j.observe(flow, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='6'*64, order_id='IAEGATEST1')
        j.consume(flow, 'payment_complete', kind='payment', payment_order_id='IAEGATEST1', **args)
        j.observe(flow, 'payment_complete', outcome='CHALLENGE_REQUIRED', evidence_hash='6'*64, order_id='IAEGATEST1')
        with self.assertRaises(j.JournalError):
            j.reconcile_minutes_challenge(flow, evidence_hash='6'*64)
        j.observe(flow, 'payment_complete', outcome='PAYMENT_REPORTED_SUCCESS', evidence_hash='6'*64, order_id='IAEGATEST1')
        j.reconcile_minutes_challenge(flow, evidence_hash='6'*64)
        self.assertEqual(j.inspect(flow)['state'], 'ACTIVE')
        j.observe(flow, 'payment_complete', outcome='UNKNOWN', evidence_hash='6'*64, order_id='IAEGATEST1')
        j.observe(flow, 'payment_complete', outcome='PAYMENT_REPORTED_SUCCESS', evidence_hash='6'*64, order_id='IAEGATEST1')
        with self.assertRaisesRegex(j.JournalError, 'UNPROVEN'):
            j.reconcile_minutes_challenge(flow, evidence_hash='6'*64)
        self.assertEqual(j.inspect(flow)['state'], 'FENCED')

    def test_authorized_challenge_opens_before_actual_verification_amount_alert(self):
        from noon_checkout import fingerprint
        saved = {'intent_hash': '3'*64, 'card_hash': fingerprint('token'), 'payable_minor': 2675}
        state = {'binding': {'account_hash': fingerprint('customer')}, 'card_last4': '9546'}
        wire = {'customer_code': 'customer', 'id_token': 'token', 'cc_masked': 'xxxx9546',
                'currency_code': 'AED', 'amount': 1, 'redirect_url': 'https://bank.example/challenge'}
        events = []
        def recover(flow_id, challenge):
            challenge(saved, wire)
            return {'payment_status': 'payment_ready_to_redirect'}
        with patch.object(p, 'recover', side_effect=recover), \
                patch('commerce_nownow_capture.load', return_value=state), \
                patch.object(r, 'open_once', side_effect=lambda *a: events.append('open')), \
                patch.object(p, 'notify_owner', side_effect=lambda *a: events.append(a) or True):
            p.await_payment(FLOW, open_redirect=True, wait_seconds=0)
        self.assertEqual(events, ['open', (FLOW, 100, '9546')])


if __name__ == '__main__':
    unittest.main()
