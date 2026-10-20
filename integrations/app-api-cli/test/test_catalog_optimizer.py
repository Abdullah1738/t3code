import unittest
from catalog_schema import image, normalize
from optimizer import optimize, collect, strict_match
from delivery_apps_watch import detect


def store(key, terms, eta=20, fee=2):
    return {'key':key, 'store':key, 'matches':{t:{'name':t,'price':3,'image_url':'https://example.com/a.jpg'} for t in terms},
            'eta_minutes':eta, 'delivery_fee':fee, 'min_order':0}


class CatalogTests(unittest.TestCase):
    def test_not_food_named_like_requested_grocery(self):
        self.assertFalse(strict_match('milk', 'Milk Chocolate Bar'))
        self.assertFalse(strict_match('butter', 'Peanut Butter'))
        self.assertFalse(strict_match('milk 1l', 'Milk 500ml'))
        self.assertTrue(strict_match('milk 1l', 'Fresh Milk 1 L'))

    def test_empty_search_is_not_empty_complete_basket(self):
        self.assertEqual(optimize([], ['milk'])[0], [])

    def test_nownow_cdn(self):
        self.assertEqual(image(['shop/a.jpg'],'https://f.nooncdn.com/nownow/'), 'https://f.nooncdn.com/nownow/shop/a.jpg')

    def test_catalog_link_is_not_image(self):
        self.assertIsNone(normalize({'name':'Store','id':1,'url':'https://example.com/store'})['image_url'])
        self.assertEqual(image({'image_urls':['https://example.com/item.jpg']}),'https://example.com/item.jpg')

    def test_eta_units_and_unknown(self):
        self.assertEqual(normalize({'eta':'1–2 hours'})['eta_minutes'],120)
        self.assertIsNone(normalize({'eta':'Tomorrow, 4 October'})['eta_minutes'])

    def test_unit_price(self):
        row=normalize({'name':'Milk 500ml','price':5})
        self.assertEqual(row['unit_price'],10)
        self.assertIsNone(normalize({'name':'Milk 6 x 500ml','price':20})['unit_price'])

    def test_single_store_beats_fast_split(self):
        plans,_=optimize([store('slow',['milk','eggs'],60),store('a',['milk'],5),store('b',['eggs'],5)],['milk','eggs'])
        self.assertEqual(plans[0]['stores'][0]['key'],'slow')

    def test_minimal_split_then_eta(self):
        plans,_=optimize([store('a',['milk'],30),store('b',['eggs'],10),store('c',['milk'],5)],['milk','eggs'])
        self.assertEqual(plans[0]['max_eta_minutes'],10)
        self.assertEqual(plans[0]['order_count'],2)

    def test_unknown_fee_not_free(self):
        plans,_=optimize([store('unknown',['milk'],20,None),store('known',['milk'],20,4)],['milk'])
        self.assertEqual(plans[0]['stores'][0]['key'],'known')
        self.assertIsNone(plans[1]['total_including_delivery'])

    def test_partial_coverage(self):
        plans,_=optimize([store('a',['milk'])],['milk','eggs'])
        self.assertEqual(plans[0]['coverage_gaps'],['eggs'])

    def test_strict_names_closed_and_unavailable(self):
        data={'stores':[{'store_id':'a','status':'open','items':[{'name':'eggplant','price':1},{'name':'eggs','price':1,'buyable':False}]}]}
        stores,_,_=collect([('noon','nownow','eggs',data,None)],['eggs'])
        self.assertFalse(stores[0]['matches'])

    def test_open_excludes_unknown(self):
        stores,_,_=collect([('noon','minutes','milk',{'items':[{'name':'milk','price':1}]},None)],['milk'],True)
        self.assertEqual(stores,[])

    def test_detection_amazon_excluded_deduped(self):
        self.assertEqual(detect(['com.deliveroo.orderapp','com.amazon.mShop.android.shopping'],[]),['com.deliveroo.orderapp'])
        self.assertEqual(detect(['com.deliveroo.orderapp'],['com.deliveroo.orderapp']),[])


if __name__ == '__main__':
    unittest.main()
