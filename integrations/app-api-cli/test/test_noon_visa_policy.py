"""Visa rollout checks; refund wording is synthetic, not live provider proof."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import order_card
import commerce_cli as cli
import commerce_nownow_order as nownow
import commerce_marketplace_disposition as disposition
import commerce_journal as journal
from test_marketplace_payment import failed_responses

class VisaPolicyTests(unittest.TestCase):
    def test_visa_full_non_capture_evidence_and_mismatches(self):
        data=json.loads(json.dumps(failed_responses('NTESTORDER',1980)).replace('mastercard','visa').replace('MASTERCARD','VISA').replace('2342','9546'))
        args=[data[k] for k in ('order_status','order_detail','order_refund')]
        with patch.object(order_card,'LAST4','9546'),patch.object(order_card,'NETWORK','visa'):
            self.assertTrue(disposition.failed_evidence(*args,'NTESTORDER',1980)['provider_no_charge_proven'])
            data['order_refund']['sections']['paymentDetails']['paymentMethods'][0]['title']='VISA xxxx2342'
            with self.assertRaises(journal.JournalError):disposition.failed_evidence(*args,'NTESTORDER',1980)

    def test_nownow_visa_refuses_before_auth_or_cart(self):
        with patch.object(order_card,'LAST4','9546'),patch.object(cli,'CommerceAuth') as auth:
            with self.assertRaisesRegex(journal.JournalError,'NOWNOW_SELECTED_CARD_PAYMENT_UNVERIFIED'):
                cli.order_nownow(SimpleNamespace(prepare_only=False))
            auth.assert_not_called()

    def test_nownow_visa_cannot_claim_paid_from_placed(self):
        flow=nownow.NowNowOrderFlow.__new__(nownow.NowNowOrderFlow)
        with patch.object(order_card,'LAST4','9546'),patch.object(journal,'observe') as observe:
            with self.assertRaisesRegex(journal.JournalError,'NOWNOW_SELECTED_CARD_PAYMENT_UNVERIFIED'):
                flow.confirm_paid({'status':'placed'})
            observe.assert_not_called()

    def test_recovery_steps_name_selected_bank(self):
        for bank in ('Mashreq app','ENBD X'):
            with patch.object(order_card,'BANK_APP',bank):
                for outcome in ('waiting','unconfirmed','declined'):
                    result=journal.payment_details(flow_id='test',order='NTEST',amount_minor=100,outcome=outcome)
                    self.assertIn(bank,result['next'][0])
