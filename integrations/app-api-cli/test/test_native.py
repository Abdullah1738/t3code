import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import native

class NativeReadOnlyTests(unittest.TestCase):
    def test_no_writes_or_credential_redirects(self):
        for url in ['https://api-app.noon.com/_svc/checkout-v2/order/place',
                    'https://api-app-instant.noon.com/_svc/instant/session/sync',
                    'https://example.com/_svc/catalog/search',
                    'http://api-app.noon.com/_svc/catalog/api/v3/u/search',
                    'https://user:password@api-app.noon.com/_svc/catalog/api/v3/u/search']:
            with self.assertRaises(native.NativeError) as e: native.get(url, {}, 5)
            self.assertEqual(e.exception.code, 'ENDPOINT_DENIED')

    def test_invalid_auth_or_home_never_reaches_search(self):
        saved = {'headers':{'cookie':'fixture-only','x-addresscode':'A','x-addresskey':'K'},
                 'url':'https://api-app.noon.com/_svc/catalog/api/v3/u/search?q=example'}
        for identity, code in [({},'AUTH_EXPIRED'),
                              ({'customer':{'customerCode':'C'},'experiences':[]},'HOME_MISMATCH')]:
            with patch.object(native,'load',return_value=saved), patch.object(native,'get',return_value=identity) as http:
                with self.assertRaises(native.NativeError) as e: native.search('noon','test',3,1,5)
                self.assertEqual(e.exception.code,code)
                self.assertEqual(http.call_count,1)

    def test_authenticated_search_projects_catalog_only(self):
        saved={'headers':{'cookie':'fixture-secret','x-addresscode':'A','x-addresskey':'K'},
               'url':'https://api-app-instant.noon.com/_svc/catalog/search'}
        identity={'customer':{'customerCode':'C'},'experiences':[{'selectedAddress':{
            'addressCode':'A','addressKey':'K','addressTitle':'BanyanTree Hillside'}}]}
        catalog={'hits':[{'sku':'X','title':'Milk','offerPrice':0,'isBuyable':False,'token':'fixture-secret'}]}
        with patch.object(native,'load',return_value=saved), patch.object(native,'get',side_effect=[identity,catalog]):
            d=native.search('minutes','milk',3,1,5)
        self.assertTrue(d['location']['saved_address_verified'])
        self.assertTrue(d['account']['authenticated'])
        self.assertEqual(d['items'][0]['price'],0)
        self.assertFalse(d['items'][0]['buyable'])
        self.assertNotIn('fixture-secret',str(d))

if __name__=='__main__':unittest.main()
