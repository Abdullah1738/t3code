import copy
from dataclasses import replace
from decimal import Decimal
import unittest

from noon_checkout import AccountHome, fingerprint
from noon_nownow_checkout import SavedCard, Snapshot, QUIET_NOTE
import noon_nownow_review as r
from noon_nownow_controller import CardSyncBinding


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.row = {k: Decimal('0') for k in r.FINANCIAL_FIELDS}
        self.row.update(checkoutSessionCode='owned', storeCode='shop', storeInfo={'storeCode': 'shop'},
            addressCode='home', addressVersion=1, customerCode='customer', currencyCode='AED',
            products=[{'productCode': 'p', 'qty': Decimal('2'), 'modifiers': [], 'notes': None,'totalPrice':Decimal('20')}],
            totalQuantity=2, orderSubtotal=Decimal('20'), orderSubtotalDiscounted=Decimal('20'),
            orderDeliveryFee=Decimal('5'), cartTotal=Decimal('25'), orderTotal=Decimal('25'),
            orderPaymentAmount=Decimal('25'), hasPackageFee=False,
            vipSingleCheckoutInfo={'isAddedToCart': False}, priceBreakdown=[{'label': 'Total', 'values': ['25 AED']}],
            paymentMethodCode='prepaid', prepaidPaymentMisc={'prepaidPaymentMethodCode': 'cc_noonpay', 'isCvvRequired': False},
            creditCardMask='xxxx5542', paymentToken='synthetic-token', hasPaymentSubscription=True,
            isVerifyDeviceRequired=False, deliveryPreference={'dont_ring_the_bell': True, 'leave_it_at_my_door': True},
            driverNotes=QUIET_NOTE, checkoutWarningPopup=None)
        self.args = dict(account_home=AccountHome('nownow', fingerprint('customer'), fingerprint('home', 'key'), 100),
            session_code='owned', store_code='shop', address_code='home', address_key='key', address_version=1,
            expected_manifest=[{'productCode': 'p', 'qty': 2, 'modifiers': {}, 'notes': None}],
            expected_financials_minor={k: int(self.row[k] * 100) for k in r.FINANCIAL_FIELDS},
            expected_price_breakdown=copy.deepcopy(self.row['priceBreakdown']),
             card=SavedCard('synthetic-token', 'xxxx5542', 'mastercard'), now=110)
        self.args['card_binding']=CardSyncBinding(fingerprint('customer'),fingerprint('home','key'),
            fingerprint('owned'),fingerprint('synthetic-token'),'1'*64,'2'*64,100)

    def review(self):
        return r.review_snapshot(Snapshot({'data': self.row}, {}, 100), **self.args)

    def test_frozen_review_is_detached_and_binds_payable(self):
        review = self.review()
        self.assertEqual(review.payable_minor, 2500)
        self.row['driverNotes'] = 'changed'
        self.assertNotIn('changed', review.frozen_json)
        self.assertNotIn('synthetic-token', review.frozen_json)

    def test_manifest_extras_quantity_and_modifiers(self):
        for change in ('extra', 'qty', 'modifier'):
            with self.subTest(change=change):
                old = copy.deepcopy(self.row['products'])
                if change == 'extra':
                    self.row['products'].append({'productCode': 'extra', 'qty': 1, 'modifiers': [], 'notes': None})
                elif change == 'qty':
                    self.row['products'][0]['qty'] = Decimal('1.5')
                else:
                    self.row['products'][0]['modifiers'] = [{'modifierCode': 'size', 'modifierOptionList': [
                        {'isSelected': True, 'modifierOptionCode': 'large'}]}]
                with self.assertRaises(r.ReviewError): self.review()
                self.row['products'] = old

    def test_every_fee_is_reviewed(self):
        for field in r.FINANCIAL_FIELDS:
            with self.subTest(field=field):
                self.row[field] += Decimal('0.01')
                with self.assertRaises(r.ReviewError) as exc: self.review()
                self.assertEqual(exc.exception.field, 'data.' + field)
                self.row[field] -= Decimal('0.01')

    def test_missing_token_echo_uses_exact_synced_controller_card(self):
        del self.row['paymentToken']
        self.assertEqual(self.review().payable_minor,2500)
        self.args['card_binding']=None
        with self.assertRaises(r.ReviewError) as exc:self.review()
        self.assertEqual((exc.exception.code,exc.exception.field),('DURABLE_CARD_SYNC_REQUIRED','controller.card_sync'))

    def test_reviewed_tip_or_wrong_arithmetic_still_rejected(self):
        self.row['orderRiderTip']=Decimal('1')
        self.args['expected_financials_minor']['orderRiderTip']=100
        with self.assertRaises(r.ReviewError) as error:self.review()
        self.assertEqual(error.exception.code,'UNAPPROVED_TIP')
        self.row['orderRiderTip']=0;self.args['expected_financials_minor']['orderRiderTip']=0
        self.row['products'][0]['totalPrice']=Decimal('19')
        with self.assertRaises(r.ReviewError) as error:self.review()
        self.assertEqual(error.exception.code,'SUBTOTAL_MISMATCH')

    def test_card_home_quiet_and_extra_membership(self):
        for key, value in [('paymentToken', 'other'), ('addressCode', 'other'), ('driverNotes', ''),
                           ('deliveryPreference', {'dont_ring_the_bell': False, 'leave_it_at_my_door': True}),
                           ('vipSingleCheckoutInfo', {'isAddedToCart': True})]:
            with self.subTest(field=key):
                old = self.row[key]; self.row[key] = value
                with self.assertRaises(r.ReviewError): self.review()
                self.row[key] = old

    def test_controller_validate_first_then_preorder_or_finalize(self):
        review = self.review()
        controller = dict(observed_at=100, review_digest=review.digest, status='idle',
            orderPaymentAmount=25, selection={'kind': 'card', 'cardId': 'synthetic-token'},
            wallet={'enabled': False}, requiresCardSubscription=False, isCvvRequired=False)
        self.assertEqual(r.continuation_decision(review, controller, now=110)['state'], 'validate_basket_required')
        validation = dict(review_digest=review.digest, observed_at=100, checkoutWarningPopup=None)
        result = r.continuation_decision(review, controller, now=110, validation=validation)
        self.assertEqual(result['state'], 'finalize_candidate')
        self.assertFalse(result['financial_send_allowed'])
        controller['requiresCardSubscription'] = True
        with self.assertRaises(r.ReviewError):r.continuation_decision(review, controller, now=110, validation=validation)
        controller['requiresCardSubscription']=False
        for key, value in [('observed_at', 1), ('review_digest', 'old'), ('orderPaymentAmount', 24)]:
            old = controller[key]; controller[key] = value
            with self.assertRaises(r.ReviewError): r.continuation_decision(review, controller, now=110)
            controller[key] = old

    def test_finalize_preserves_reconciliation(self):
        self.assertEqual(r.finalize_result({'order': {'orderNr': 'NNTEST'}})['state'], 'exact_order_readback_required')
        self.assertEqual(r.finalize_result({'session': {'checkoutWarningPopup': {'title': 'Changed'}}})['kind'], 'warning')
        self.assertFalse(r.finalize_result(None)['resend_allowed'])

    def test_digest_rejects_changed_or_tampered_and_stale_reviews(self):
        first = self.review()
        with self.assertRaises(r.ReviewError):
            r.require_same_review(first, replace(first, payable_minor=1), now=110)
        with self.assertRaises(r.ReviewError):
            r.require_same_review(first, first, now=161)
        self.row['hasPaymentSubscription'] = False
        with self.assertRaises(r.ReviewError):
            r.require_same_review(first, self.review(), now=110)

    def test_wallet_zero_even_when_parent_expectation_changed(self):
        self.row['orderWalletAmount'] = Decimal('1')
        self.args['expected_financials_minor']['orderWalletAmount'] = 100
        with self.assertRaises(r.ReviewError) as exc: self.review()
        self.assertEqual(exc.exception.code, 'WALLET_NOT_ZERO')


if __name__ == '__main__':
    unittest.main()
