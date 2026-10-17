import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import talabat_native as t
from native import NativeError


class TalabatTests(unittest.TestCase):
    def test_transport_denies_writes_and_credential_destinations(self):
        for method, url in [
            ('POST', 'https://api.talabat.com/grocery/v2/cart'),
            ('GET', 'https://api.talabat.com/checkout'),
            ('POST', 'https://api.talabat.com.evil.test/search/api/v3/vendor'),
            ('POST', 'http://api.talabat.com/search/api/v3/vendor'),
            ('POST', 'https://user@api.talabat.com/search/api/v3/vendor'),
            ('POST', 'https://api.talabat.com:8443/search/api/v3/vendor'),
            ('POST', 'https://api.talabat.com/search/api/v3/vendor#x'),
            ('GET', 'https://api.talabat.com/search/api/v3/vendor'),
        ]:
            with self.subTest(method=method, url=url): self.assertFalse(t.allowed(method, url))
        self.assertTrue(t.allowed('POST', 'https://api.talabat.com/search/api/v3/vendor'))
        self.assertTrue(t.allowed('GET', 'https://api.talabat.com/menubff/v4/branches/717327/menu'))

    def test_account_required_never_falls_back_to_guest(self):
        adapter = types.ModuleType('talabat_account_catalog')
        adapter.TalabatError = type('TalabatError', (Exception,), {})
        adapter.run = unittest.mock.Mock(side_effect=adapter.TalabatError('IDENTITY_MISMATCH'))
        with patch.dict(sys.modules, {'talabat_account_catalog': adapter}), \
             patch.object(t, 'load') as load, patch.object(t, 'request') as request:
            with self.assertRaises(NativeError) as e: t.run('restaurants', 'x', require_account=True)
            self.assertEqual(e.exception.code, 'IDENTITY_MISMATCH')
            load.assert_not_called(); request.assert_not_called()

    def test_menu_branch_guard_dedup_and_secret_projection(self):
        item = {'id':1,'nm':'Pizza','dsc':'30g protein','pr':10,'opr':12,'token':'secret'}
        data = {'vendor':{'result':{'restaurant':{'bid':8,'na':'Cafe','status_description':'Opens at 09:30am','token':'secret'}}},
                'menu':{'result':{'menu':{'menuSection':[{'nm':'Pizza','itm':[item,item]}]}}}}
        result = t.project_menu(data,8,'protein',10)
        self.assertEqual(result['total_menu_items'],1)
        self.assertEqual(len(result['items']),1)
        self.assertNotIn('secret',json.dumps(result))
        with self.assertRaises(NativeError):t.project_menu(data,9,'',10)

    def test_search_empty_exact_filter_and_ad_token_redaction(self):
        data = {'result':{'vendors':[{'vendor_id':8,'vendor_name':'Cafe','vendor_status':1,'sponsored':{'token':'secret'}}]}}
        self.assertEqual(t.project_restaurants(data,'pizza',5,True)['items'],[])
        result=t.project_restaurants(data,'cafe',5,True)
        self.assertEqual(result['items'][0]['status'],'closed')
        self.assertNotIn('secret',json.dumps(result))
        self.assertEqual(t.project_restaurants({'result':{'vendors':[]}},'x',5,False)['items'],[])
        with self.assertRaises(NativeError):t.project_restaurants({},'x',5,False)

    def test_mart_store_mismatch_stops_before_product_search(self):
        vendor='00000000-0000-0000-0000-000000000001'
        product={'url':f'https://api.talabat.com/grocery/v1/bff/ae/vendors/{vendor}/products/search',
                 'body':json.dumps({'branch_id':'8'}),'method':'POST','headers':{}}
        branch={'url':'https://api.talabat.com/grocery/v2/TB_AE/branches/8','method':'GET','headers':{}}
        with patch.object(t,'request',return_value={'vendor':{'talabat_id':9,'global_id':vendor}}) as req:
            with self.assertRaises(NativeError) as e:t.run('mart','milk',saved={'templates':{'p':product,'b':branch}})
            self.assertEqual(e.exception.code,'BRANCH_MISMATCH');self.assertEqual(req.call_count,1)

    def test_product_projection_keeps_stock_separate_from_order_cap(self):
        d=t.project_products({'products':[{'id':'a','name':'Milk','stock_amount':12,'max_sales_quantity':2,'tracking_code':'secret'}]},1)
        self.assertEqual(d['items'][0]['stock_amount'],12)
        self.assertEqual(d['items'][0]['max_quantity'],2)
        self.assertNotIn('secret',json.dumps(d))


if __name__ == '__main__':unittest.main()
