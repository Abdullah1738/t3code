import json
import unittest
from unittest.mock import patch
import noon_order_details as d
import delivery_cards
import order_tracker


class DetailTests(unittest.TestCase):
    def test_unknown_processing_cannot_render_cancelled(self):
        cfg={'app':'noon','order':'NTEST','vertical':'marketplace'}
        data={'status':'unknown','raw_status':'processing','status_text':'Cancelled',
              'last_confirmed_status':'cancelled','evidence':[]}
        for _ in range(2):
            view=delivery_cards.view(cfg,data,{})
            self.assertEqual(view['stage'],'Processing');self.assertFalse(view['terminal'])
        data.update(status='cancelled',whole_order_complete=True,
                    evidence=[{'source':'native_order_api','confidence':'exact_order','stage':'cancelled'}])
        self.assertEqual(delivery_cards.view(cfg,data,{})['stage'],'Cancelled')
        self.assertTrue(delivery_cards.view(cfg,data,{})['terminal'])

    def test_processing_keeps_native_coverage(self):
        native={'status':'unknown','raw_status':'processing','account_verified':True,'coverage':'exact_native'}
        with patch('native_orders.track',return_value=native), \
                patch.object(d,'details',side_effect=d.core.NoonError('UNAVAILABLE')), \
                patch.object(order_tracker,'mail_evidence') as mail:
            result=order_tracker.fetch({'app':'noon','order':'NTEST','vertical':'marketplace'}, {},100)
        self.assertEqual(result['coverage'],'exact_native');self.assertEqual(result['errors'],[])
        self.assertEqual(result['raw_status'],'processing');mail.assert_not_called()

    def test_existing_choice_gets_private_note_from_exact_inventory(self):
        cfg={'app':'noon','order':'FTEST','vertical':'food','for':'owner','chat':'owner'}
        data=d.food(self.food(),'FTEST');data['status']='delivered'
        meta={'items':[{'name':'Coffee','qty':2,'detail':'Oat milk x1'}]}
        self.assertIn('Extra hot',json.dumps(delivery_cards.view(cfg,data,meta)))

    def test_unresolved_native_inventory_preserves_stored_merchandise(self):
        cfg={'app':'noon','order':'FTEST','vertical':'food','for':'owner','chat':'owner'}
        raw=self.food();raw.pop('menuInfo')
        data=d.food(raw,'FTEST');data['status']='delivered'
        meta={'items':[{'name':'Coffee','qty':2,'detail':'Oat milk','price':12}]}
        row=delivery_cards.view(cfg,data,meta)['items'][0]
        self.assertEqual((row['name'],row['detail'],row['price']),('Coffee','Oat milk',12))

    def test_minutes_does_not_guess_unit_price(self):
        row={'orderNr':'ITEST','createdAt':'2026-10-23T19:45:00Z','orderTotal':8,'items':[{'itemCode':'I1','title':'Item','qty':1,
             'price':10,'offerPrice':8,'salePrice':8}]}
        with patch.object(d.core,'verified_session',return_value={}), \
                patch('noon_minutes_checkout.native_request',return_value=row):
            result=d.details('ITEST','minutes')
        self.assertIsNone(result['items'][0]['price'])
        self.assertEqual(result['total'],8)
        self.assertEqual(result['placed_at'],'2026-10-23T19:45:00Z')

    def test_public_card_never_contains_notes_even_for_owner(self):
        data=d.food(self.food(),'FTEST');data['status']='delivered'
        cfg={'app':'noon','order':'FTEST','vertical':'food','for':'owner','chat':'owner'}
        self.assertNotIn('Extra hot',json.dumps(delivery_cards.view(cfg,data,{'public':True})))
        self.assertIn('Extra hot',json.dumps(delivery_cards.view(cfg,data,{'public':False})))

    def food(self):
        return {'orderNr':'FTEST','orderTotal':12,'outletInfo':{'name':'Cafe','phone':'private'},
                'paymentClientSecret':'SECRET','menuInfo':{'items':[{'itemCode':'I1','name':'Coffee'},
                {'itemCode':'I2','name':'Oat milk'}],'modifiers':[{'modifierCode':'MD1','name':'Milk',
                'options':[{'itemCode':'I2','price':2}]}]},'items':[{'itemCode':'I1','qty':2,'price':6,
                'totalPrice':12,'modifiers':{'MD1':{'I2':1}},'notes':'Extra hot'}]}

    def test_food_snapshot_choices_notes_and_secret_exclusion(self):
        raw=self.food();raw['createdAt']='2026-10-23T19:45:00Z'
        result=d.food(raw,'FTEST');line=result['items'][0]
        self.assertEqual(result['placed_at'],'2026-10-23T19:45:00Z')
        self.assertEqual((line['name'],line['qty'],line['line_total']),('Coffee',2,12))
        self.assertEqual(line['options'][0]['name'],'Oat milk')
        self.assertEqual(line['notes'],'Extra hot')
        self.assertNotIn('Extra hot',line['detail'])
        self.assertNotIn('Extra hot',str(delivery_cards.items(result['items'])))
        self.assertIn('Extra hot',str(delivery_cards.items(result['items'],private_notes=True)))
        self.assertNotIn('SECRET',json.dumps(result));self.assertNotIn('private',json.dumps(result))
        with self.assertRaises(d.core.NoonError):d.food(self.food(),'FOTHER')

    def test_neutral_marketplace_card_preserves_name_units_and_unknown_status(self):
        cfg={'app':'noon','order':'NTEST','vertical':'marketplace'}
        data={'status':'unknown','status_text':'Processing - Verifying payment','items_complete':True,
              'items':[{'name':'Headset','qty':2,'price':235}], 'manifest_items':[{'item_id':'NTEST-1'}],
              'total':473.49,'whole_order_complete':False}
        view=delivery_cards.view(cfg,data,{})
        self.assertEqual(view['vertical'],'marketplace');self.assertEqual(view['count'],2)
        self.assertEqual(view['items'][0]['name'],'Headset');self.assertFalse(view['terminal'])
        self.assertEqual(view['stage'],'Processing - Verifying payment')

    def test_tracker_keeps_merchandise_with_exact_status(self):
        merchandise=d.food(self.food(),'FTEST')
        with patch('native_orders.track',return_value={'status':'delivered','coverage':'exact','items':[]}), \
                patch.object(d,'details',return_value=merchandise):
            result=order_tracker.fetch({'app':'noon','order':'FTEST','vertical':'food'}, {}, 100)
        self.assertEqual(result['items'][0]['name'],'Coffee')
        self.assertEqual(result['total'],12)


if __name__=='__main__':unittest.main()


class MoneyOrderCoverageTests(unittest.TestCase):
    def test_native_paginated_empty_lists_cannot_authorize_a_money_question(self):
        import importlib.util
        import io
        import tempfile
        from contextlib import redirect_stdout
        from pathlib import Path
        import noon_http_orders as core
        import noon_vertical_reads as vertical
        source = Path(__file__).resolve().parents[2] / 'robob-watch/checks/money-cases/cases.py'
        spec = importlib.util.spec_from_file_location('coverage_money_cases', source)
        mc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mc)
        def request(route, *args, **kwargs):
            if route == 'minutes_list':
                return {'orders': [], 'totalPages': 2}
            return {'data': []}
        with patch.object(core, 'verified_session', return_value={}), patch.object(core, 'request', request), \
                patch.object(vertical, '_headers', return_value={}), \
                patch.object(vertical, '_read', return_value={'status': 'success', 'data': {'orders': []}}):
            result = mc.charges.order_lookup.native('noon', str(Path(__file__).resolve().parents[1]))
        self.assertFalse(result['complete'])
        self.assertEqual(result['orders'], [])
        with tempfile.TemporaryDirectory() as tmp, patch.object(mc, 'DATA', Path(tmp)), \
                patch.object(mc.charges.order_lookup, 'read', return_value=result), \
                patch.object(mc.charges, 'search', return_value=[]), \
                patch.object(mc.charges, 'owner_texts', return_value=[]), redirect_stdout(io.StringIO()) as out:
            rc = mc.main(['ask', 'Purchase of AED 1291.20 with Credit Card ending 2342 at NOON, Dubai.',
                          '--at', '2026-10-23T23:47:00+04:00', '--said', 'Is this yours?'])
        self.assertEqual(rc, 4)
        self.assertIn('UNVERIFIED: source orders unreadable', out.getvalue())

    def test_verified_minutes_match_survives_detail_limit_or_marketplace_failure(self):
        import importlib.util
        import io
        import tempfile
        from contextlib import redirect_stdout
        from pathlib import Path
        import noon_http_orders as core
        import noon_minutes_checkout as minutes
        import noon_vertical_reads as vertical
        source = Path(__file__).resolve().parents[2] / 'robob-watch/checks/money-cases/cases.py'
        spec = importlib.util.spec_from_file_location('partial_money_cases', source)
        mc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mc)
        for stop, count, expected in [('detail_limit', 9, 8), ('marketplace_failure', 1, 1)]:
            with self.subTest(stop=stop):
                detail_ids = []
                def request(route, *args, **kwargs):
                    if route == 'minutes_list':
                        return {'orders': [{'orderNr': f'ITEST{i}', 'statusCode': 'delivered',
                                            'placedAt': '2026-10-23T23:45:00'} for i in range(count)],
                                'totalPages': 2}
                    raise core.NoonError('UNRELATED_MARKETPLACE_FAILURE')
                def detail(route, headers, deadline, payload, **kwargs):
                    oid = payload['orderNr']
                    detail_ids.append(oid)
                    return {'orderNr': oid, 'orderTotal': 1291.20 if oid == 'ITEST0' else 99,
                            'items': [{'itemCode': 'I1', 'title': 'Item', 'qty': 1}]}
                with patch.object(core, 'verified_session', return_value={}), patch.object(core, 'request', request), \
                        patch.object(minutes, 'native_request', detail), \
                        patch.object(vertical, '_headers', return_value={}) as other_headers:
                    result = mc.charges.order_lookup.native('noon', str(Path(__file__).resolve().parents[1]))
                self.assertFalse(result['complete'])
                self.assertEqual(len(result['orders']), expected)
                self.assertEqual(len(detail_ids), expected)
                self.assertEqual(result['orders'][0]['order'], 'ITEST0')
                other_headers.assert_not_called()
                for amount, expected_rc in [('1291.20', mc.DONT_ASK), ('1.11', 4)]:
                    with tempfile.TemporaryDirectory() as tmp, patch.object(mc, 'DATA', Path(tmp)), \
                            patch.object(mc.charges.order_lookup, 'read', return_value=result), \
                            patch.object(mc.charges, 'search', return_value=[]), \
                            patch.object(mc.charges, 'owner_texts', return_value=[]), \
                            redirect_stdout(io.StringIO()) as out:
                        rc = mc.main(['ask', f'Purchase of AED {amount} with Credit Card ending 2342 at NOON, Dubai.',
                                      '--at', '2026-10-23T23:47:00+04:00', '--said', 'Is this yours?'])
                    self.assertEqual(rc, expected_rc)
                    self.assertIn('noon order ITEST0' if amount == '1291.20' else 'UNVERIFIED:', out.getvalue())
