import unittest
from unittest.mock import patch
import commerce_food as f


class FoodTests(unittest.TestCase):
    def test_recovery_instance_cannot_mutate(self):
        flow=f.FoodFlow.__new__(f.FoodFlow);flow.card_last4='2342';flow.read_only=True
        with patch.object(f,'request') as send, patch.object(f.journal,'consume') as consume:
            with self.assertRaises(f.journal.JournalError):flow.write('create',{})
        send.assert_not_called();consume.assert_not_called()

    def test_review_rejects_changed_cart_card_and_quiet(self):
        flow=f.FoodFlow.__new__(f.FoodFlow);flow.card_last4='2342'
        flow.outlet='OUTLET';flow.state={'session':'SESSION'}
        flow.headers={'x-addresscode':'ADDR','x-addresskey':'ADDR-1'}
        flow.rows=f.manifest([{'item_code':'I1'}])
        data={'checkoutSessionCode':'SESSION','outletCode':'OUTLET','addressCode':'ADDR','addressVersion':1,
              'items':flow.rows,'deliveryPreferenceInfo':[{'code':k,'value':True} for k in f.QUIET],
              'driverNotes':f.QUIET_NOTE,'creditCardMask':'****2342','paymentMethodCode':'prepaid',
              'prepaidPaymentMethodCode':'cc_noonpay','orderWalletAmount':0,'orderPaymentAmount':10,'orderTotal':10}
        self.assertEqual(flow.review(data)['payable_minor'],1000)
        flow.card_last4='9546'
        with self.assertRaises(f.journal.JournalError):flow.review(data)
        self.assertEqual(flow.review({**data,'creditCardMask':'****9546'})['card_last4'],'9546')
        flow.card_last4='2342'
        for key,value in [('orderNr','FOTHER'),('items',[]),('creditCardMask','****5542'),
                          ('driverNotes',''),('orderPaymentAmount',9),('addressVersion',2)]:
            with self.subTest(key=key), self.assertRaises(f.journal.JournalError):flow.review({**data,key:value})

    def test_financial_routes_cannot_dispatch(self):
        for route in ('place', 'place-order', 'payment', 'paymentintent/complete', '../order/place-order'):
            with patch('urllib.request.build_opener') as send, self.assertRaises(f.journal.JournalError):
                f.request(route, {}, {})
            send.assert_not_called()

    def test_manifest_rejects_unknown_fields_and_bad_quantities(self):
        for row in ({'item_code':'I1','qty':True}, {'item_code':'I1','qty':0},
                    {'item_code':'I1','price':0}, {'item_code':'I1','notes':'a\nb'}):
            with self.assertRaises(f.journal.JournalError): f.manifest([row])
        with self.assertRaises(f.journal.JournalError):
            f.manifest([{'item_code':'I1','qty':1},{'item_code':'I1','qty':2}])

    def test_distinct_variants_share_item_quantity_limit(self):
        rows=f.manifest([{'item_code':'I1','qty':2,'notes':'One'}, {'item_code':'I1','qty':1,'notes':'Two'}])
        with self.assertRaises(f.journal.JournalError):
            f.validate_choices(rows,[{'id':'I1','available':True,'max_quantity':2,'note_type':'optional','choice_groups':[]}])

    def test_choices_require_explicit_selection(self):
        item={'id':'I1','available':True,'max_quantity':3,'note_type':'none',
              'choice_groups':[{'id':'MD1','available':True,'min':1,'max':1,'max_per_option':1,
                                'options':[{'id':'I2','available':True,'groups':[]}]}]}
        with self.assertRaises(f.journal.JournalError):
            f.validate_choices(f.manifest([{'item_code':'I1'}]), [item])
        f.validate_choices(f.manifest([{'item_code':'I1','modifiers':{'MD1':{'I2':1}}}]), [item])
        with self.assertRaises(f.journal.JournalError):
            f.validate_choices(f.manifest([{'item_code':'I1','modifiers':{'MD1':{'I2':1}},'notes':'note'}]), [item])

    def test_money(self):
        self.assertEqual(f.money('12.34'),1234)
        for value in ('NaN',-1,True,'0.001'):
            with self.assertRaises(f.journal.JournalError):f.money(value)


if __name__=='__main__': unittest.main()
