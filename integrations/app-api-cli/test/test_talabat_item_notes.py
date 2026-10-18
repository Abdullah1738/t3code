"""Item-note and choice identity from CLI intent through cart, checkout and owned readback.

All transports and state roots are isolated; no live account calls or purchases.
"""
import contextlib
import copy
import io
import json
import tempfile
import time
import unittest
import os as _os, tempfile as _tempfile
# The live card-status record must never decide these tests.
_os.environ['CARD_STATUS_FILE']=_os.path.join(_tempfile.mkdtemp(prefix='card-status-test-'),'card-status.json')
from pathlib import Path
from unittest.mock import Mock, patch

import commerce_cli as cli
import commerce_journal as journal
import commerce_receipts as receipts
import commerce_talabat as commerce
import talabat_http_checkout as h
import talabat_restaurant_cart as restaurant
from test.test_commerce_talabat import StubAuth
from test.test_talabat_http_checkout import context, KEY

NOTE = 'No onions please. الصلصة جانباً\nThank you.'
CHOICE_ID = 549025015
CHOICE_QTY = 1
CHOICE_SECTION_ID = 2130621
CHOICE_NAME = 'Extra Turkey Ham - 30g'
CATALOG = {CHOICE_ID: {'section_id': CHOICE_SECTION_ID, 'name': CHOICE_NAME,
                       'original_price_minor': 1600}}


def noted_context(note=NOTE):
    home, config, card, store, _, raw, _, quote = context('restaurants')
    items = (h.Item(12345, 2, note=note),)
    raw['cart']['items'][0]['specialRequest'] = note
    quote['checkout']['cart']['items'][0]['specialRequest'] = note
    cart = h.parse_cart(raw, store, items)
    return home, config, card, store, items, raw, cart, quote


def parse_noted_quote(note=NOTE):
    home, config, card, store, _, _, cart, data = noted_context(note)
    selection = h.select_payment(config, card)
    body = h.prepare_body(store, home, selection=selection,
                          instructions=data['checkout']['deliveryInstructions'])
    return h.parse_quote(data, cart, home, body, selection)


def choice_echo_row(menu_id=12345, quantity=2, note='', choice_id=CHOICE_ID, choice_qty=CHOICE_QTY):
    return {'id': 335, 'menuItemId': menu_id, 'quantity': quantity, 'specialRequest': note,
            'choices': [choice_id], 'choicesString': CHOICE_NAME,
            'choicesDetails': [{'id': choice_id, 'quantity': choice_qty,
                                'itemChoiceSectionId': CHOICE_SECTION_ID,
                                'localeNames': [{'locale': 'en', 'value': CHOICE_NAME},
                                                {'locale': 'ar', 'value': 'لغة'}]}]}


class ItemNoteContractTests(unittest.TestCase):
    def test_text_is_exact_without_local_caps_or_silent_normalization(self):
        # No local length cap: the order-level characterLimit is not an item
        # bound, so arbitrarily long exact text stays valid until a server
        # or merchant refusal says otherwise.
        for note in ('', ' No onions please. ', NOTE, 'x' * 4000, '😀' * 300):
            self.assertEqual(h.Item(12345, 1, note=note).note, note)
        for note in (None, True, 7, b'note', [], {}, 'no\x00onions', 'no\x1bonions',
                     'no\ronions', '\ud800'):
            with self.subTest(note=repr(note)), self.assertRaisesRegex(h.orders.TalabatError, 'ITEM_NOTE_INVALID'):
                h.Item(12345, 1, note=note)

    def test_body_and_cart_bind_note_to_exact_item(self):
        home, _, _, store, items, raw, cart, _ = noted_context()
        self.assertEqual(h.cart_body(store, home, items)['items'], [{
            'menuItemId':12345, 'quantity':2, 'specialRequest':NOTE,
            'choices':[], 'isFromUpsell':False}])
        self.assertEqual(cart.items, items)
        for value in (None, '', 'No onions', False, {'value':NOTE}):
            bad = copy.deepcopy(raw)
            bad['cart']['items'][0]['specialRequest'] = value
            with self.subTest(value=value), self.assertRaisesRegex(h.orders.TalabatError, 'ITEM_NOTE_MISMATCH'):
                h.parse_cart(bad, store, items)

    def test_empty_missing_null_notes_remain_backwards_compatible(self):
        home, _, _, store, items, raw, _, _ = context('restaurants')
        self.assertEqual(h.cart_body(store, home, items)['items'][0]['specialRequest'], '')
        for note in (None, ''):
            raw['cart']['items'][0]['specialRequest'] = note
            h.parse_cart(raw, store, items)
        raw['cart']['items'][0].pop('specialRequest')
        h.parse_cart(raw, store, items)

    def test_grocery_note_refused_not_silently_dropped(self):
        for vertical in ('shops', 'mart'):
            home, _, _, store, items, *_ = context(vertical)
            with self.assertRaisesRegex(h.orders.TalabatError, 'ITEM_NOTES_RESTAURANTS_ONLY'):
                h.cart_body(store, home, (h.Item(items[0].item_id, 1, note=NOTE),))

    def test_quote_must_echo_requested_note_and_review_displays_it(self):
        quote = parse_noted_quote()
        review = h.project_quote(quote)
        self.assertEqual(review['item_notes'], [{'item_id':12345,'quantity':2,'note':NOTE}])
        self.assertNotEqual(review['quote_digest'], h.project_quote(parse_noted_quote('No ice'))['quote_digest'])
        self.assertNotIn('item_notes', h.project_quote(parse_noted_quote('')))
        for value in (None, '', 'No onions', False, {'value':NOTE}):
            data = json.loads(quote.response)
            data['checkout']['cart']['items'][0]['specialRequest'] = value
            with self.subTest(value=value), self.assertRaisesRegex(h.orders.TalabatError, 'QUOTE_ITEM_NOTE_MISMATCH'):
                h.parse_quote(data, quote.cart, json.loads(quote.home), json.loads(quote.body), quote.selection)

    def test_cart_choices_echo_validated_against_observed_contract(self):
        home, _, _, store, _, raw, _, _ = context('restaurants')
        items = (h.Item(12345, 2, choices=((CHOICE_ID, CHOICE_QTY, ()),)),)
        body = h.cart_body(store, home, items)
        self.assertEqual(body['items'][0]['choices'],
                         [{'choiceId': CHOICE_ID, 'quantity': CHOICE_QTY, 'subChoiceIds': []}])
        raw['cart']['items'][0].update(choice_echo_row(), id=333, quantity=2)
        raw['cart']['items'][0]['choices'] = [CHOICE_ID]
        cart = h.parse_cart(raw, store, items, choice_catalog=CATALOG)
        self.assertEqual(cart.line_choice_labels, (CHOICE_NAME,))
        # Catalog truth violations are hard failures; a different quantity is a
        # different selection and fails the line match instead.
        for mutation, code in (({'itemChoiceSectionId': 999}, 'FOOD_CART_ECHO_CHOICES_INVALID'),
                               ({'localeNames': [{'locale': 'en', 'value': 'Wrong'}]}, 'FOOD_CART_ECHO_CHOICES_INVALID'),
                               ({'quantity': 5}, 'FOOD_CHOICE_ECHO_MISMATCH'),
                               ({'id': 424242}, 'FOOD_CART_ECHO_CHOICES_INVALID')):
            bad = copy.deepcopy(raw)
            bad['cart']['items'][0]['choicesDetails'][0].update(mutation)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(h.orders.TalabatError, code):
                h.parse_cart(bad, store, items, choice_catalog=CATALOG)
        # Quantity moved without the requested change stops the readback.
        bad = copy.deepcopy(raw)
        bad['cart']['items'][0]['choicesDetails'][0]['quantity'] = 2
        with self.assertRaises(h.orders.TalabatError):
            h.parse_cart(bad, store, items, choice_catalog=CATALOG)
        # Structural corruption is refused even without a catalog.
        for key, value in (('choices', [{'id': 99}]), ('choices', '549025015'),
                           ('choicesDetails', {'id': CHOICE_ID}), ('choicesString', None),
                           ('choices', [0]), ('choices', [CHOICE_ID, CHOICE_ID])):
            bad = copy.deepcopy(raw)
            bad['cart']['items'][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(h.orders.TalabatError):
                h.parse_cart(bad, store, items)

    def test_quote_choices_label_must_match_cart_echo_of_same_line(self):
        home, config, card, store, items, raw, _, quote = context('restaurants')
        items = (h.Item(12345, 2, choices=((CHOICE_ID, CHOICE_QTY, ()),)),)
        raw['cart']['items'][0].update(choice_echo_row(), id=333, quantity=2)
        cart = h.parse_cart(raw, store, items, choice_catalog=CATALOG)
        quote['checkout']['cart']['items'][0].update(id='333', quantity=2, choicesString=CHOICE_NAME)
        selection = h.select_payment(config, card)
        body = h.prepare_body(store, home, selection=selection,
                              instructions=quote['checkout']['deliveryInstructions'])
        parsed = h.parse_quote(quote, cart, home, body, selection)
        review = h.project_quote(parsed)
        self.assertEqual(review['item_choices'], [{'item_id': 12345, 'quantity': 2, 'note': '',
                                                   'choices_label': CHOICE_NAME,
                                                   'choices': [{'choice_id': CHOICE_ID, 'quantity': CHOICE_QTY,
                                                                'sub_choice_ids': []}]}])
        for label in ('', 'Wrong topping', None):
            bad = copy.deepcopy(quote)
            bad['checkout']['cart']['items'][0]['choicesString'] = label
            with self.subTest(label=label), self.assertRaises(h.orders.TalabatError):
                h.parse_quote(bad, cart, home, body, selection)

    def test_duplicate_lines_same_item_with_distinct_notes_and_choices(self):
        home, _, _, store, _, raw, _, _ = context('restaurants')
        items = (h.Item(12345, 1, note='No onions'),
                 h.Item(12345, 1, note='Extra spicy', choices=((CHOICE_ID, 1, ()),)),
                 h.Item(12346, 3))
        raw['cart']['items'] = [
            {'id': 334, 'menuItemId': 12345, 'quantity': 1, 'specialRequest': 'Extra spicy',
             'choices': [CHOICE_ID], 'choicesString': CHOICE_NAME,
             'choicesDetails': choice_echo_row()['choicesDetails']},
            {'id': 333, 'menuItemId': 12345, 'quantity': 1, 'specialRequest': 'No onions'},
            {'id': 335, 'menuItemId': 12346, 'quantity': 3}]
        cart = h.parse_cart(raw, store, items, choice_catalog=CATALOG)
        self.assertEqual(sorted(cart.quote_item_ids), [(12345, '333'), (12345, '334'), (12346, '335')])
        owned = restaurant.project_cart(raw, cart_id='900', branch_id=store.branch_id,
                                        items=items, choice_catalog=CATALOG)
        self.assertEqual(owned.lines, ((12345, 333, 1), (12345, 334, 1), (12346, 335, 3)))
        self.assertEqual(owned.item_notes, ((12345, 'Extra spicy'), (12345, 'No onions')))
        self.assertEqual(owned.line_choices, ((334, ((CHOICE_ID, 1, ()),)),))
        self.assertEqual(restaurant.read_owned_cart(lambda *_a, **_k: raw, owned,
                                                    choice_catalog=CATALOG), owned)
        # Identical duplicate rows merge by summed quantity at the wire layer.
        merged = h._items(store, (h.Item(12345, 1, note='No onions'), h.Item(12345, 2, note='No onions')))
        self.assertEqual(merged, (h.Item(12345, 3, note='No onions'),))

    def test_owned_get_retains_note_and_refuses_removed_changed_or_moved_note(self):
        _, _, _, store, _, raw, _, _ = noted_context()
        raw['cart']['items'].append({'id':334,'menuItemId':12346,'quantity':1,'specialRequest':''})
        owned = restaurant.project_cart(raw, cart_id='900', branch_id=store.branch_id,
            items=((12345,2),(12346,1)), item_notes=((12345,NOTE),))
        self.assertEqual(owned.item_notes, ((12345,NOTE),))
        self.assertEqual(restaurant.read_owned_cart(lambda *_a, **_k:raw, owned), owned)
        for changed in ('drop','change','swap'):
            bad = copy.deepcopy(raw)
            bad['cart']['items'][0]['specialRequest'] = 'No ice' if changed == 'change' else ''
            if changed == 'swap':
                bad['cart']['items'][1]['specialRequest'] = NOTE
            with self.subTest(changed=changed), self.assertRaisesRegex(h.orders.TalabatError, 'ITEM_NOTE_MISMATCH'):
                restaurant.read_owned_cart(lambda *_a, **_k:bad, owned)

    def test_invalid_owned_note_context_cannot_issue_get(self):
        get = Mock(side_effect=AssertionError('must not call GET'))
        for notes in (((999,NOTE),), ((12345,NOTE),(12345,NOTE)), ((12345,None),), []):
            owned = restaurant.RestaurantCart('900',44444,((12345,333,2),),3000,notes)
            with self.assertRaises(h.orders.TalabatError):
                restaurant.read_owned_cart(get, owned)
        get.assert_not_called()

    def test_intent_scope_binds_note_but_preserves_old_empty_note_hash(self):
        original = {'branch':44444,'vertical':'restaurants','items':[(12345,2)],
                    'home':'Banyantree2104','card':'5542','quiet':True,'extras':False}
        empty = commerce.intent_scope('restaurants',44444,(h.Item(12345,2),))
        self.assertEqual(empty,journal.digest(original))
        noted = commerce.intent_scope('restaurants',44444,(h.Item(12345,2,note=NOTE),))
        self.assertNotEqual(empty,noted)
        self.assertNotEqual(noted,commerce.intent_scope('restaurants',44444,(h.Item(12345,2,note='No ice'),))
)
    def test_intent_scope_binds_choices_without_touching_old_hashes(self):
        original = {'branch':44444,'vertical':'restaurants','items':[(12345,2)],
                    'home':'Banyantree2104','card':'5542','quiet':True,'extras':False}
        empty = commerce.intent_scope('restaurants',44444,(h.Item(12345,2),))
        self.assertEqual(empty,journal.digest(original))
        chosen = commerce.intent_scope('restaurants',44444,
            (h.Item(12345,2,choices=((CHOICE_ID,1,()),)),))
        self.assertNotEqual(empty,chosen)
        self.assertNotEqual(chosen,commerce.intent_scope('restaurants',44444,
            (h.Item(12345,2,choices=((CHOICE_ID,2,()),)),)))


class ItemNoteFlowTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for module in (journal, receipts):
            p = patch.object(module,'ROOT',Path(temp.name).resolve()/'commerce')
            p.start(); self.addCleanup(p.stop)
        self.home,self.config,self.card,self.store,self.items,self.raw,_,self.quote = noted_context()
        self.saved = {'account_verified':True,'country':'AE','headers':{},
            'auth':{'access_token':'synthetic-secret','customerId':77},
            'expected_profile':{'id':77,'mobile_country_code':'971','mobile_number':'500000000'}}
        self.auth = StubAuth(self.saved)
        self.calls = []
        self.menu = {'vendor':{'result':{'restaurant':{'bid':44444}}},
                     'menu':{'result':{'menu':{'menuSection':[
                         {'nm':'Shakes','itm':[{'id':12345,'nm':'Vanilla protein shake','pr':15,'opr':15,'icc':False},
                                               {'id':12346,'nm':'Chamomile tea','pr':18,'opr':18,'icc':False}]}]}}}}
        pool = Path(temp.name) / 'pool.txt'
        pool.write_text('[pp+0x7c80] String: "%s"\n' % KEY)
        self.pool = str(pool)
        for p in (patch.object(h,'_wire',side_effect=self.wire),
                  patch.object(h.auth,'expiry',return_value=time.time()+3600),
                  patch.object(h.orders,'request',return_value=self.saved['expected_profile'])):
            p.start(); self.addCleanup(p.stop)

    def wire(self, saved, deadline, method, path, **kwargs):
        self.calls.append((method,path,copy.deepcopy(kwargs)))
        if path == '/api/v2/user/addresses':
            data = {'has_error':False,'result':[self.home]}
        elif path == '/pay/v1/cards': data = {'data':[self.card]}
        elif path == '/pay/v2/payments': data = self.config
        elif path == '/menubff/v4/branches/44444/menu':
            data = self.menu
        elif path in ('/cart/v2','/cart/v1/900'): data = self.raw
        elif path == '/ccx/v1/checkout/900': data = self.quote
        else: raise AssertionError('unexpected/financial wire: '+method+' '+path)
        return h.WireResponse(200,copy.deepcopy(data))

    def flow(self, **kwargs):
        return commerce.TalabatFlow(vertical='restaurants',branch=44444,
            items=kwargs.pop('items',self.items),auth=self.auth,**kwargs)

    def test_resume_requires_same_note_and_reverifies_cart_and_quote(self):
        flow = self.flow()
        review = flow.prepare(verticals_key=KEY)
        self.assertEqual(review['item_notes'][0]['note'],NOTE)
        with self.assertRaisesRegex(journal.JournalError,'OWNED_PREPARATION_NOT_RESUMABLE'):
            self.flow(flow_id=flow.flow_id,items=(h.Item(12345,2,note='No ice'),))
        resumed = self.flow(flow_id=flow.flow_id)
        self.assertEqual(resumed.resume_cart(verticals_key=KEY)['item_notes'],review['item_notes'])
        self.assertEqual(sum(p == '/cart/v2' for _,p,_ in self.calls),1)
        self.assertIsNone(journal.inspect(flow.flow_id)['order_id'])
        self.assertFalse(any(x['kind'] in ('place','payment') for x in journal.inspect(flow.flow_id)['operations']))

    def test_note_edit_after_review_stops_before_financial_send(self):
        flow = self.flow()
        flow.prepare(verticals_key=KEY)
        self.raw['cart']['items'][0]['specialRequest'] = 'No ice'
        with self.assertRaisesRegex(h.orders.TalabatError,'ITEM_NOTE_MISMATCH'):
            flow.purchase()
        self.assertFalse(any(x['kind'] in ('place','payment') for x in journal.inspect(flow.flow_id)['operations']))

    def test_prepare_only_cli_uses_real_journal_and_never_calls_purchase_or_tracker(self):
        args = ['order','talabat','--vertical','restaurants','--branch','44444',
            '--item','12345','--quantity','2','--apk-pool',self.pool,'--item-note',NOTE,'--prepare-only']
        with patch.object(cli,'CommerceAuth',return_value=self.auth), \
                patch.object(commerce,'CommerceAuth',return_value=self.auth), \
                patch.object(h.shared,'verticals_key',return_value=KEY), \
                patch.object(commerce.TalabatFlow,'purchase',side_effect=AssertionError('purchase forbidden')) as buy, \
                patch.object(cli,'register_tracking',side_effect=AssertionError('tracker forbidden')) as tracker, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(args),0)
        result = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(result['state'],'PREPARED_NOT_ORDERED')
        self.assertFalse(result['financial_send'])
        self.assertTrue(result['cart_readback_verified'])
        self.assertEqual(result['review']['item_notes'][0]['note'],NOTE)
        buy.assert_not_called(); tracker.assert_not_called()
        state = journal.inspect(result['flow_id'])
        self.assertIsNone(state['order_id']); self.assertEqual(state['reserved_minor'],0)
        self.assertEqual(self.calls[-1][0:2],('GET','/cart/v1/900'))

    def test_prepare_only_discounted_item_without_choices(self):
        # My Six Pak's 2026-10-13 quote: strike-through unit price, net row
        # total, and a waived delivery fee whose display still shows AED4.90.
        self.raw['cart']['items'][0]['quantity'] = 1
        self.raw['cart']['totalValue'] = 75
        self.menu['menu']['result']['menu']['menuSection'][0]['itm'][0].update(pr=75, opr=105)
        checkout = self.quote['checkout']
        checkout.update(amount='79.9', discountsTotal='30')
        checkout['cart']['items'][0].update(quantity=1, price='AED 105.00', total='AED 75.00')
        checkout['paymentSummary']['items'] = [
            {'type':'SubTotal','amount':105,'value':'AED 105.00'},
            {'type':'AutoAppliedDiscount','amount':30,'value':'- AED 30.00'},
            {'type':'DeliveryFee','amount':0,'value':'AED 4.90'},
            {'type':'ServiceFee','amount':4.9,'value':'AED 4.90'},
            {'type':'Total','amount':79.9,'value':'AED 79.90'}]
        with patch.object(cli,'CommerceAuth',return_value=self.auth), \
                patch.object(commerce,'CommerceAuth',return_value=self.auth), \
                patch.object(h.shared,'verticals_key',return_value=KEY), \
                patch.object(commerce.TalabatFlow,'purchase',side_effect=AssertionError('purchase forbidden')), \
                patch.object(cli,'register_tracking',side_effect=AssertionError('tracker forbidden')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            code = cli.main(['order','talabat','--vertical','restaurants','--branch','44444',
                '--item','12345','--quantity','1','--apk-pool',self.pool,'--item-note',NOTE,'--prepare-only'])
        result = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(code, 0, result)
        self.assertEqual(result['state'], 'PREPARED_NOT_ORDERED')
        self.assertEqual(result['review']['payable_minor'], 7990)
        self.assertFalse(result['financial_send'])
        self.assertTrue(result['cart_readback_verified'])
        self.assertEqual(result['review']['item_notes'][0]['note'], NOTE)
        state = journal.inspect(result['flow_id'])
        self.assertIsNone(state['order_id'])
        self.assertEqual(state['reserved_minor'], 0)
        self.assertFalse(any(x['kind'] in ('place', 'payment') for x in state['operations']))
        self.assertEqual(self.calls[-1][0:2], ('GET','/cart/v1/900'))

    def test_prepare_only_cli_accepts_items_file_with_choices_and_duplicate_lines(self):
        rows = {'items':[
            {'item_id': 12345, 'quantity': 2, 'note': NOTE,
             'choices': [{'choice_id': str(CHOICE_ID), 'quantity': 1}]},
            {'item_id': '12346', 'quantity': 1}]}
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
            json.dump(rows, fh); path = fh.name
        self.addCleanup(Path(path).unlink)
        items = (h.Item(12345,2,note=NOTE,choices=((CHOICE_ID,1,()),)), h.Item(12346,1))
        self.raw['cart']['items'][0].update(choice_echo_row(), id=333, quantity=2, specialRequest=NOTE)
        self.raw['cart']['items'].append({'id':334,'menuItemId':12346,'quantity':1,'specialRequest':''})
        # Each of the 2x25.00 items carries its 16.00 choice, plus 1x18.00 tea.
        self.quote['checkout']['cart']['items'][0].update(
            id='333', quantity=2, price='25.00', total='82.00', specialRequest=NOTE, choicesString=CHOICE_NAME)
        self.quote['checkout']['cart']['items'].append(
            {'id':'334','quantity':1,'price':'18.00','total':'18.00','specialRequest':'','choicesString':''})
        self.quote['checkout']['paymentSummary']['items'] = [
            {'type':'SubTotal','amount':100},{'type':'DeliveryFee','amount':3},
            {'type':'ServiceFee','amount':2},{'type':'Total','amount':105}]
        self.quote['checkout']['amount'] = 105
        self.raw['cart']['totalValue'] = 100
        menu_section = self.menu['menu']['result']['menu']['menuSection'][0]
        menu_section['itm'][0].update(icc=True, pr=25, opr=25)
        self.menu_choices = {'result': {'choiceForItem': [{'itemId': '12345', 'choiceSections': [{
            'id': CHOICE_SECTION_ID, 'iid': 12345, 'nm': 'Extras', 'mnq': 0, 'mxq': 2,
            'ich': [{'id': CHOICE_ID, 'nm': CHOICE_NAME, 'pr': 14.4, 'opr': 16, 'subCategories': None}]}]}]}}
        original_wire = self.wire
        def wire_with_choices(saved, deadline, method, path, **kwargs):
            if path == '/menubff/v3/branches/44444/menu/12345/choices':
                self.calls.append((method,path,copy.deepcopy(kwargs)))
                return h.WireResponse(200, copy.deepcopy(self.menu_choices))
            return original_wire(saved, deadline, method, path, **kwargs)
        with patch.object(h,'_wire',side_effect=wire_with_choices):
            flow = self.flow(items=items)
            review = flow.prepare(verticals_key=KEY)
        self.assertEqual(review['item_choices'][0]['choices'],[{'choice_id':CHOICE_ID,'quantity':1,'sub_choice_ids':[]}])
        self.assertTrue(any('/menubff/v3/' in p for _,p,_ in self.calls))

    def test_conflicting_menu_names_refused_before_cart_creation(self):
        menu_section = self.menu['menu']['result']['menu']['menuSection'][0]
        menu_section['itm'].append({'id':12345,'nm':'Chocolate protein shake','pr':30,'opr':30,'icc':False})
        with patch.object(cli,'CommerceAuth',return_value=self.auth), \
                patch.object(commerce,'CommerceAuth',return_value=self.auth), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['order','talabat','--vertical','restaurants',
                '--branch','44444','--item','12345','--apk-pool',self.pool,
                '--item-note',NOTE,'--prepare-only']),1)
        self.assertEqual(json.loads(output.getvalue())['error'],'MENU_DUPLICATE_ITEM_CONFLICT')
        self.assertFalse(any(method == 'POST' for method,_,_ in self.calls))

    def test_unknown_menu_item_or_uncustomizable_choices_refused_before_cart(self):
        with patch.object(cli,'CommerceAuth',return_value=self.auth), \
                patch.object(commerce,'CommerceAuth',return_value=self.auth), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['order','talabat','--vertical','restaurants',
                '--branch','44444','--item','999999','--apk-pool',self.pool,'--prepare-only']),1)
        self.assertEqual(json.loads(output.getvalue())['error'],'MENU_ITEM_UNKNOWN')
        self.assertFalse(any(method == 'POST' for method,_,_ in self.calls))
        # Requesting a choice on a non-customizable item is refused at the
        # menu-verification stage, before any cart POST.
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as fh:
            json.dump({'items': [{'item_id': '12346', 'quantity': 1,
                                  'choices': [{'choice_id': CHOICE_ID, 'quantity': 1}]}]}, fh)
            basket = fh.name
        self.addCleanup(Path(basket).unlink)
        with patch.object(cli,'CommerceAuth',return_value=self.auth), \
                patch.object(commerce,'CommerceAuth',return_value=self.auth), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['order','talabat','--vertical','restaurants',
                '--branch','44444','--items-file',basket,'--apk-pool',self.pool,'--prepare-only']),1)
        self.assertEqual(json.loads(output.getvalue())['error'],'MENU_ITEM_NOT_CUSTOMIZABLE')
        self.assertFalse(any(method == 'POST' for method,_,_ in self.calls))

    def test_cli_invalid_note_or_grocery_note_refused_before_auth(self):
        uuid = '9bc5c169-1d79-4d94-821f-e18542669426'
        for vertical,item,note in (('mart',uuid,NOTE),('shops',uuid,NOTE),
                                   ('restaurants','12345','no\x00onions')):
            with patch.object(cli,'CommerceAuth',side_effect=AssertionError('auth forbidden')) as auth, \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cli.main(['order','talabat','--vertical',vertical,
                    '--branch','44444','--item',item,'--apk-pool',self.pool,
                    '--item-note',note]),1)
            auth.assert_not_called()
            self.assertIn('ITEM_NOTE',json.loads(output.getvalue())['error'])


if __name__ == '__main__':
    unittest.main()
