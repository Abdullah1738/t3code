import time
import unittest
import hashlib
from noon_checkout import AccountHome,fingerprint
from noon_minutes_checkout import _json
from noon_nownow_checkout import SavedCard,payment_payload
import noon_nownow_controller as c


class NativeControllerTests(unittest.TestCase):
    def setUp(self):
        self.row={'id':'native-token','ccMasked':'xxxx5542','ccType':'MASTERCARD','isDeleted':False}
        self.card=SavedCard('native-token','xxxx5542','mastercard')
        self.home=AccountHome('nownow','1'*64,'2'*64,time.time())

    def test_native_instrument_to_context_exact_five_keys_no_wallet(self):
        instrument=c.selected_instrument(self.row)
        self.assertEqual(set(instrument),{'kind','cardId','creditCardMask','card','cvv'})
        context=c.finalize_input(instrument)
        self.assertEqual(context,{'paymentMethod':'cc_noonpay','walletEnabled':False,
            'walletAmount':0,'card':self.row,'applePayHashedTransactionId':None})
        instrument['cardId']='foreign'
        with self.assertRaises(c.ControllerError):c.finalize_input(instrument)

    def test_sync_binding_uses_real_request_receipt_not_basket_echo(self):
        digest=hashlib.sha256(_json(payment_payload('SESSION',self.card))).hexdigest()
        response={'data':{'checkoutSessionCode':'SESSION','paymentMethodCode':'prepaid',
            'creditCardMask':'xxxx5542','orderWalletAmount':0,
            'prepaidPaymentMisc':{'prepaidPaymentMethodCode':'cc_noonpay'}}}
        receipt={'service':'nownow','operation':'payment','request_sha256':digest,
            'outcome':'RESPONSE_RECEIVED','http_status':200,'evidence_hash':'3'*64}
        b=c.bind_card_sync(account_home=self.home,session_code='SESSION',card=self.card,
            request_hash=digest,receipt=receipt,response=response,observed_at=time.time())
        self.assertEqual(c.check_card_binding(b,account_home=self.home,session_code='SESSION',
            card=self.card,now=time.time()),fingerprint('native-token'))
        with self.assertRaises(c.ControllerError):c.check_card_binding(b,account_home=self.home,
            session_code='OTHER',card=self.card,now=time.time())
        with self.assertRaises(c.ControllerError):c.bind_card_sync(account_home=self.home,
            session_code='SESSION',card=self.card,request_hash='9'*64,receipt=receipt,
            response=response,observed_at=time.time())
        receipt['outcome']='UNKNOWN'
        with self.assertRaises(c.ControllerError):c.bind_card_sync(account_home=self.home,
            session_code='SESSION',card=self.card,request_hash=digest,receipt=receipt,
            response=response,observed_at=time.time())

    def test_no_membership_does_not_require_subscription_but_cvv_is_independent(self):
        for subscribed in (True,False):
            flags=c.source_flags({'vipSingleCheckoutInfo':{'isAddedToCart':False},
                'hasPaymentSubscription':subscribed,'prepaidPaymentMisc':{'isCvvRequired':True}})
            self.assertFalse(flags['requiresCardSubscription']);self.assertTrue(flags['isCvvRequired'])
        self.assertTrue(c.source_flags({'vipSingleCheckoutInfo':{'isAddedToCart':True},
            'hasPaymentSubscription':False})['requiresCardSubscription'])


if __name__=='__main__':unittest.main()
