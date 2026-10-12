"""Synthetic adapter-shape tests; these fixtures are NOT captured Noon sessions."""
from copy import deepcopy
from dataclasses import FrozenInstanceError, replace
import unittest

import noon_marketplace_review as r


class ReviewTests(unittest.TestCase):
    def setUp(self):
        # Deliberately synthetic names prevent this fixture becoming a native schema.
        paths = {
            'cart_rows': ('basket',), 'cart_selected': ('chosen',),
            'session_rows': ('deliveries', '*', 'products'),
            'address_code': ('destination', 'code'), 'address_key': ('destination', 'key'),
            'payment_method': ('pay', 'method'), 'card_token': ('pay', 'token'),
            'card_mask': ('pay', 'mask'), 'card_type': ('pay', 'kind'),
            'currency': ('money', 'ccy'), 'subtotal': ('money', 'subtotal'),
            'payable': ('money', 'due'), 'fee_rows': ('money', 'fees'),
            'fee_code': ('id',), 'fee_amount': ('amount',),
            'discount': ('money', 'discount'), 'tip': ('money', 'tip'),
            'wallet': ('money', 'wallet'), 'subscription': ('subscribe',),
            'extras': ('addons',), 'delivery_options': ('quiet',),
            'option_code': ('id',), 'option_active': ('enabled',),
            'delivery_note': ('note',),
        }
        for prefix in ('cart', 'session'):
            for semantic, key in {'offer':'offer', 'variant':'variant', 'quantity':'qty',
                                  'seller':'merchant', 'fulfillment':'route', 'line_amount':'price'}.items():
                paths[prefix + '_' + semantic] = (key,)
        self.shape = r.EvidenceShape(tuple((k, r.Field(v, 'synthetic test adapter, not native evidence'))
                                         for k, v in paths.items()), 'synthetic-v1')
        self.item = dict(offer='offer-1', variant='vanilla', qty=2, merchant='seller-1',
                         route='fulfillment-1', price='20.00', chosen=True)
        self.cart = {'basket': [deepcopy(self.item)]}
        self.session = {'deliveries': [{'products': [deepcopy(self.item)]}],
            'destination': {'code':'home-code', 'key':'home-key'},
            'pay': {'method':'cc', 'token':'saved-token', 'mask':'****5542', 'kind':'mastercard'},
            'money': {'ccy':'AED', 'subtotal':'20', 'due':'22.50',
                      'fees':[{'id':'shipping', 'amount':'2.50'}], 'discount':0, 'tip':0, 'wallet':0},
            'subscribe':False, 'addons':[],
            'quiet':[{'id':'door', 'enabled':True}, {'id':'bell', 'enabled':False},
                     {'id':'call', 'enabled':False}],
            'note':"Leave at door. Don't ring bell. Don't call."}
        self.home = {'account_ref':'a'*64, 'address_ref':'b'*64, 'address_code':'home-code',
                     'address_key':'home-key', 'title':'Home 2104', 'street_address':'BanyanTree Hillside',
                     'lat':250778251, 'lng':551569039, 'observed_at':990}
        self.card = dict(token='saved-token', mask='****5542', card_type='mastercard', observed_at=990)
        self.manifest = (r.Item('offer-1', 'vanilla', 2, 'seller-1', 'fulfillment-1', 2000),)
        self.quiet = tuple(r.QuietOption(s, c, active, 'synthetic semantics only') for s,c,active in
                           [('leave_at_door','door',True), ('no_bell','bell',False), ('no_call','call',False)])

    def context(self):
        return r.Context('main', 'a'*64, 'b'*64, r.digest(self.cart), r.digest(self.session), 995, 996, 1000)

    def review(self, **overrides):
        kwargs = dict(context=self.context(), shape=self.shape,
                      expected_fees=(('shipping',250),), quiet_options=self.quiet)
        kwargs.update(overrides)
        return r.review(self.cart, self.session, self.manifest, self.home, self.card, **kwargs)

    def fails(self, code, **kwargs):
        with self.assertRaises(r.ReviewError) as raised:
            self.review(**kwargs)
        self.assertEqual(raised.exception.code, code)

    def test_success_is_immutable_and_bound(self):
        result = self.review()
        self.assertEqual(result.payable_minor, 2250)
        self.assertEqual(result.observed_at, 990)
        self.assertEqual(result.expires_at, 1110)
        with self.assertRaises(FrozenInstanceError):
            result.payable_minor = 1
        self.cart['basket'][0]['price'] = '999'
        self.assertEqual(result.items[0].line_minor, 2000)
        self.assertNotIn('saved-token', repr(result))

    def test_supermall_binding(self):
        self.assertNotEqual(self.review().digest,
            self.review(context=replace(self.context(), service='supermall')).digest)

    def test_fee_extra_or_changed(self):
        self.session['money']['fees'].append({'id':'service','amount':1})
        self.fails('FEE_INVENTORY_MISMATCH')

    def test_duplicate_fee(self):
        self.session['money']['fees'] *= 2
        self.fails('DUPLICATE_FEE')

    def test_bad_money(self):
        for amount in ('NaN', '-1', '.001', True):
            with self.subTest(amount=amount):
                self.session['money']['due'] = amount
                self.fails('INVALID_AMOUNT')

    def test_bad_payable(self):
        self.session['money']['due'] = '22.51'
        self.fails('PAYABLE_MISMATCH')

    def test_card_token_and_type(self):
        for field, code in [('token','SAVED_CARD_TOKEN_MISMATCH'), ('kind','SAVED_CARD_TYPE_MISMATCH')]:
            with self.subTest(field=field):
                before = self.session['pay'][field]
                self.session['pay'][field] = 'other'
                self.fails(code)
                self.session['pay'][field] = before

    def test_wrong_home_and_session_address(self):
        self.home['title'] = 'Home 2105'
        self.fails('HOME_2104_MISMATCH')
        self.home['title'] = 'Home 2104'
        self.session['destination']['key'] = 'other'
        self.fails('SESSION_HOME_MISMATCH')

    def test_extras_tip_wallet_subscription(self):
        for field, code in [('tip','UNAPPROVED_TIP'), ('wallet','UNAPPROVED_WALLET')]:
            self.session['money'][field] = 1
            self.fails(code)
            self.session['money'][field] = 0
        self.session['addons'] = [{'gift':True}]
        self.fails('UNAPPROVED_EXTRAS')
        self.session['addons'] = []
        self.session['subscribe'] = True
        self.fails('UNAPPROVED_SUBSCRIPTION')

    def test_stale_and_future(self):
        self.fails('STALE_CART', context=replace(self.context(), cart_observed_at=800))
        self.fails('STALE_SESSION', context=replace(self.context(), session_observed_at=1001))
        self.card['observed_at'] = 1
        self.fails('STALE_CARD')

    def test_changed_after_acquisition(self):
        ctx = self.context()
        self.session['money']['due'] = 30
        self.fails('SESSION_SNAPSHOT_CHANGED', context=ctx)

    def test_selected_extra_and_missing_shipment(self):
        extra = dict(self.item, offer='other')
        self.cart['basket'].append(extra)
        self.fails('SELECTED_CART_MANIFEST_MISMATCH')
        extra['chosen'] = False
        self.review()  # Owner's unselected line is preserved and bound by cart_hash.
        self.session['deliveries'].append({'products':[dict(self.item, offer='extra')]})
        self.fails('SESSION_MANIFEST_MISMATCH')

    def test_exact_seller_fulfillment_qty_variant(self):
        for key, value in [('merchant','other'), ('route','other'), ('qty',3), ('variant','chocolate')]:
            with self.subTest(key=key):
                old = self.session['deliveries'][0]['products'][0][key]
                self.session['deliveries'][0]['products'][0][key] = value
                self.fails('SESSION_MANIFEST_MISMATCH')
                self.session['deliveries'][0]['products'][0][key] = old

    def test_quiet_readback(self):
        self.session['quiet'][1]['enabled'] = True
        self.fails('QUIET_DELIVERY_MISMATCH')

    def test_missing_mapping_and_missing_native_field(self):
        shape = replace(self.shape, fields=tuple(p for p in self.shape.fields if p[0] != 'wallet'))
        self.fails('UNSUPPORTED_WALLET', shape=shape)
        del self.session['money']['wallet']
        self.fails('SCHEMA_WALLET')

    def test_empty_native_cart_is_not_selected_session_proof(self):
        self.cart = {'items':[], 'offers':[], 'count':0}
        self.fails('SCHEMA_CART_ROWS', shape=None)


if __name__ == '__main__':
    unittest.main()
