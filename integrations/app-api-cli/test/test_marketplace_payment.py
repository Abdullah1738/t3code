"""Payment lifecycle fixtures only. No Keychain, Telegram or merchant traffic."""
import copy
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import commerce_cli as cli
import commerce_journal as j
import commerce_receipts as receipts
import commerce_marketplace_payment as payment
import commerce_marketplace_disposition as disposition
import noon_marketplace_checkout as market
import test_commerce_main_order as main
import test_commerce_supermall_order as rocket


def failed_responses(order, amount):
    """Sanitized shape of the native failed order/refund GETs, 23 Oct."""
    amount = f'{amount / 100:.2f}'
    item = order + '-1'
    method = {'code': 'mastercard', 'title': 'MASTERCARD xxxx5542', 'amount': amount}
    medium = {'code': 'mastercard', 'title': 'Processed to xxxx5542', 'amount': amount,
              'description': disposition.NO_CAPTURE + ' Any temporary hold will be released by your bank.'}
    block = {'refundMediums': [medium], 'refundBreakup': {
        'totalAmount': amount, 'items': [{'itemNr': item, 'amount': amount}], 'feeGroups': []}}
    return {'order_status': {'status': 'failed', 'paymentError': {'instructions': 'Payment failure'}},
            'order_detail': {'orderNr': order, 'paymentMethodCode': 'cc_noonpay', 'itemGroups': [
                {'orderNr': order, 'subStatus': {'highStatusCode': 'cancelled'},
                 'items': [{'itemNr': item}]}]},
            'order_refund': {'sections': {'paymentDetails': {
                'amount': amount, 'triggeredAmount': amount, 'paymentMethods': [method],
                'pendingDetails': {'amount': '0'}, 'nonRefundableDetails': {'amount': '0'}},
                'completedRefunds': copy.deepcopy(block), 'triggeredRefunds': copy.deepcopy(block)}}}


class PaymentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve() / 'commerce'
        for module in (j, receipts):
            patcher = patch.object(module, 'ROOT', self.root)
            patcher.start()
            self.addCleanup(patcher.stop)
        stdout = contextlib.redirect_stdout(io.StringIO())
        stdout.__enter__()
        self.addCleanup(stdout.__exit__, None, None, None)
        # Catch any accidental live effect, including fixture gaps.
        for name in ('subprocess.run', 'urllib.request.OpenerDirector.open'):
            patcher = patch(name, side_effect=AssertionError('live IO forbidden'))
            patcher.start()
            self.addCleanup(patcher.stop)

    def placed(self, fixture=main, **responses):
        flow, wire = fixture.make_flow(fixture.happy_responses(**responses))
        flow.offers = {fixture.SKU: fixture.OFFER}
        flow.offer = fixture.OFFER
        # add() consumes one post-write cart read, unlike guard() + add().
        wire.responses['cart'] = fixture.cart_state()
        flow.add()
        flow.checkout_session()
        flow.review_session()
        return flow, wire

    def setup_cvv(self, flow, wire):
        flow.session_response.data['isCvvRequired'] = True
        for method in flow.session_response.data['paymentMethods']:
            for card in method.get('cards', []):
                if card.get('isSelected'):
                    card['id'] = 'synthetic-card-token'
        wire.responses['payment_config'] = {'cvv_encryption': 'fixture'}
        with patch('noon_cvv.encrypt', return_value={'encCvv': 'encrypted-fixture', 'publicKeyName': 'fixture'}) as encrypt:
            flow.prepare_payment(cvv=b'123')
        self.assertEqual(encrypt.call_args.args[1], b'123')

    def test_cvv_challenge_pending_success_once_on_both_lanes(self):
        for fixture in (main, rocket):
            with self.subTest(lane=fixture.__name__):
                pending = {'status': 'pending', 'clientSecret': 'synthetic-intent'}
                flow, wire = self.placed(fixture, order_status=[pending, pending, fixture.FIXTURE['status_success']],
                    payment_complete={'status': 'payment_pending'}, payment_status={'status': 'payment_ready_to_redirect'})
                self.setup_cvv(flow, wire)
                flow.place()
                notify = Mock(return_value={'queued': True})
                result = flow.await_success(notify=notify, sleep=lambda _: None)
                self.assertTrue(result['paid'])
                notify.assert_called_once_with(fixture.ORDER, flow.review['payable_minor'])
                calls = [x for x in wire.calls if x[0] == 'payment_complete']
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][2]['cvvEncryption']['encCvv'], 'encrypted-fixture')
                self.assertEqual(calls[0][2]['idCustomerToken'], 'synthetic-card-token')
                self.assertIsNone(flow.cvv_encryption)
                self.assertTrue(j.payment_reported(flow.flow_id))
                self.assertEqual(j.inspect(flow.flow_id)['state'], 'ACTIVE')
                flow.verify_tracking()
                j.observe(flow.flow_id, 'place', outcome='TRACKER_REGISTERED',
                          evidence_hash='f'*64, order_id=flow.order)
                j.complete(flow.flow_id)
                durable = b''.join(p.read_bytes() for p in self.root.rglob('*') if p.is_file())
                for secret in (b'encrypted-fixture', b'synthetic-card-token', b'synthetic-intent'):
                    self.assertNotIn(secret, durable)

    def test_redirect_challenge_fence_is_lifted_only_by_later_exact_success(self):
        flow, wire = self.placed(order_status=[{'status': 'pending', 'clientSecret': 'intent'}, main.FIXTURE['status_success']],
            payment_complete={'status': 'payment_ready_to_redirect', 'redirect_url': 'https://bank.invalid/challenge'})
        self.setup_cvv(flow, wire)
        flow.place()
        seen = []
        def notify(*_):
            seen.append(j.inspect(flow.flow_id)['state'])
            return {'queued': True}
        self.assertTrue(flow.await_success(sleep=lambda _: None, notify=notify)['paid'])
        self.assertEqual(seen, ['FENCED'])
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'ACTIVE')

    def test_missing_cvv_stops_before_place(self):
        flow, wire = self.placed()
        flow.session_response.data['isCvvRequired'] = True
        with self.assertRaisesRegex(j.JournalError, 'CVV_REQUIRED'):
            flow.prepare_payment()
        self.assertNotIn('place', [x[0] for x in wire.calls])
        self.assertEqual(j.inspect(flow.flow_id)['reserved_minor'], 0)

    def test_failed_alert_retries_with_backoff_until_queued(self):
        pending = {'status': 'pending', 'clientSecret': 'intent'}
        flow, wire = self.placed(order_status=[pending] * 5 + [main.FIXTURE['status_success']],
            payment_complete={'status': 'payment_pending'}, payment_status={'status': 'payment_pending'})
        self.setup_cvv(flow, wire)
        flow.place()
        now, attempts = [0.0], []
        def sleep(seconds): now[0] += seconds
        def notify(*args):
            attempts.append((now[0], args))
            return {'queued': len(attempts) >= 3}
        self.assertTrue(flow.await_success(sleep=sleep, clock=lambda: now[0], notify=notify)['paid'])
        self.assertEqual([a[0] for a in attempts], [0, 2, 6])
        self.assertEqual(len({a[1] for a in attempts}), 1)

    def test_redirect_without_status_alerts_once(self):
        pending = {'status': 'pending', 'clientSecret': 'intent'}
        redirect = {'redirect_url': 'https://bank.invalid/challenge'}
        flow, wire = self.placed(order_status=[pending, pending, main.FIXTURE['status_success']],
            payment_complete=redirect, payment_status=redirect)
        self.setup_cvv(flow, wire)
        flow.place()
        notify = Mock(return_value={'queued': True})
        self.assertTrue(flow.await_success(sleep=lambda _: None, notify=notify)['paid'])
        notify.assert_called_once_with(main.ORDER, 1980)

    def test_ambiguous_payment_not_resent_and_restart_reads_only(self):
        pending = {'status': 'pending', 'clientSecret': 'intent'}
        flow, wire = self.placed(order_status=pending, payment_complete=OSError('lost response'))
        self.setup_cvv(flow, wire)
        flow.place()
        with self.assertRaisesRegex(j.JournalError, 'WINDOW_ELAPSED'):
            flow.await_success(attempts=1, sleep=lambda _: None, notify=Mock())
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'FENCED')
        recovery_wire = main.Harness({'order_status': [pending, main.FIXTURE['status_success']],
                                      'payment_status': {'status': 'payment_pending'}})
        resumed = main.c.MainOrderFlow.resume_payment(flow.flow_id, auth=main.FakeAuth(), request=recovery_wire.request)
        self.assertTrue(resumed.await_success(sleep=lambda _: None, notify=None)['paid'])
        self.assertEqual([x[0] for x in recovery_wire.calls], ['order_status', 'payment_status', 'order_status'])
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'ACTIVE')

    def test_no_paid_signal_without_shipments(self):
        flow, _ = self.placed(order_status={'status': 'success', 'total': '19.80', 'shipments': []})
        flow.place()
        with self.assertRaisesRegex(j.JournalError, 'SUCCESS_READBACK_MISMATCH'):
            flow.await_success(notify=None)
        self.assertFalse(j.payment_reported(flow.flow_id))

    def test_no_paid_signal_without_matching_amount(self):
        flow, _ = self.placed(order_status={'status': 'success', 'total': '20.80', 'shipments': [{}]})
        flow.place()
        with self.assertRaisesRegex(j.JournalError, 'SUCCESS_READBACK_MISMATCH'):
            flow.await_success(notify=None)
        self.assertFalse(j.payment_reported(flow.flow_id))

    def test_deadline_is_wall_clock_bounded_and_timeout_fences(self):
        flow, wire = self.placed(order_status={'status': 'pending'})
        flow.place()
        now = [0.0]
        def sleep(seconds): now[0] += seconds
        with self.assertRaisesRegex(j.JournalError, 'WINDOW_ELAPSED'):
            flow.await_success(wait_seconds=7, clock=lambda: now[0], sleep=sleep, notify=Mock())
        self.assertEqual(now[0], 7)
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'FENCED')
        self.assertEqual(len([x for x in wire.calls if x[0] == 'place']), 1)

    def test_pending_to_failed_closes_only_with_full_native_no_capture_proof(self):
        failed = failed_responses(main.ORDER, 1980)
        flow, wire = self.placed(**failed)
        self.setup_cvv(flow, wire)
        flow.place()
        wire.responses['order_status'] = [{'status': 'pending', 'clientSecret': 'intent'},
                                          failed['order_status'], failed['order_status']]
        wire.responses['payment_complete'] = {'status': 'payment_pending'}
        with self.assertRaisesRegex(j.JournalError, 'PAYMENT_ERROR_NO_RETRY'):
            flow.await_success(sleep=lambda _: None, notify=None)
        state = j.inspect(flow.flow_id)
        self.assertEqual(state['state'], 'RELEASED')
        self.assertEqual(state['reserved_minor'], 0)
        with self.assertRaises(market.MarketplaceError): flow.place()

    def test_decline_without_no_capture_proof_fences_instead_of_active(self):
        failed = failed_responses(main.ORDER, 1980)
        failed['order_refund']['sections']['completedRefunds']['refundMediums'][0]['description'] = 'Refund processed'
        flow, wire = self.placed(**failed)
        flow.place()
        with self.assertRaisesRegex(j.JournalError, 'PAYMENT_ERROR_NO_RETRY'):
            flow.await_success(notify=Mock())
        self.assertEqual(j.inspect(flow.flow_id)['state'], 'FENCED')
        self.assertEqual(j.inspect(flow.flow_id)['reserved_minor'], 1980)

    def test_reconcile_active_order_without_payment_step_releases_reservation(self):
        flow, wire = self.placed(**failed_responses(main.ORDER, 1980))
        flow.place()
        result = disposition.reconcile(flow.flow_id, client=flow.client)
        self.assertEqual(result['state'], 'RELEASED')
        self.assertEqual(result['reservation_released_minor'], 1980)
        self.assertFalse(result['financial_send'])

    def test_reconcile_rejects_concurrent_success(self):
        flow, wire = self.placed(**failed_responses(main.ORDER, 1980))
        flow.place()
        original = flow.client.call
        def racing(name, **kwargs):
            result = original(name, **kwargs)
            if name == 'order_refund':
                j.observe(flow.flow_id, 'place', outcome='PAYMENT_REPORTED_SUCCESS',
                          evidence_hash='a'*64, order_id=flow.order)
            return result
        with patch.object(flow.client, 'call', side_effect=racing):
            with self.assertRaisesRegex(j.JournalError, 'SUCCESS_ALREADY_OBSERVED'):
                disposition.reconcile(flow.flow_id, client=flow.client)
        self.assertEqual(j.inspect(flow.flow_id)['reserved_minor'], 1980)


class ProjectionTests(unittest.TestCase):
    def test_incomplete_wrong_order_wrong_card_or_partial_refunds_reject(self):
        changes = [lambda s,d,r: s.update(status='pending'),
                   lambda s,d,r: d.update(orderNr='NOTTHISORDER'),
                   lambda s,d,r: d['itemGroups'][0]['subStatus'].update(highStatusCode='delivered'),
                   lambda s,d,r: r['sections']['paymentDetails'].update(amount='1'),
                   lambda s,d,r: r['sections']['paymentDetails']['pendingDetails'].update(amount='1'),
                   lambda s,d,r: r['sections']['paymentDetails']['paymentMethods'][0].update(title='MASTERCARD xxxx1234'),
                   lambda s,d,r: r['sections']['completedRefunds']['refundBreakup']['items'][0].update(itemNr='OTHER-1'),
                   lambda s,d,r: r['sections']['triggeredRefunds']['refundMediums'][0].update(description='Refunded')]
        for change in changes:
            data = failed_responses(main.ORDER, 1980)
            s, d, r = (data[k] for k in ('order_status', 'order_detail', 'order_refund'))
            change(s, d, r)
            with self.assertRaises((j.JournalError, market.MarketplaceError)):
                disposition.failed_evidence(s, d, r, main.ORDER, 1980)

    def test_notify_exact_text_stable_key_and_failed_delivery_is_reported(self):
        with patch.object(payment.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            result = payment.telegram_3ds_notify(main.ORDER, 13348)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index('--text') + 1], 'this is ours: approve noon AED 133.48 in ENBD X')
        self.assertTrue(result['queued'])
        with patch.object(payment.subprocess, 'run', side_effect=OSError):
            self.assertFalse(payment.telegram_3ds_notify(main.ORDER, 13348)['queued'])

    def test_native_refund_route_is_get_only(self):
        op = market.operation('main', 'order_refund', order=main.ORDER)
        self.assertEqual(op.path, '/_svc/order-v2/order/' + main.ORDER + '/refund')
        self.assertFalse(op.mutation)
        self.assertEqual(op.method, 'GET')


if __name__ == '__main__':
    unittest.main()
