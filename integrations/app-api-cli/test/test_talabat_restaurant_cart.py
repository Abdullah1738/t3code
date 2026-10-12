import copy
import unittest

import talabat_restaurant_cart as r


def response():
    return {'branchInfo': {'restaurant': {'id': 77, 'branchId': 44444}},
            'cart': {'id': 900, 'totalValue': 35, 'items': [
                {'id': 333, 'menuItemId': 12345, 'quantity': 2,
                 'choices': [], 'specialRequest': '', 'choicesString': ''},
                {'id': 334, 'menuItemId': 12346, 'quantity': 1}]}}


def project(data=None):
    return r.project_cart(response() if data is None else data, cart_id='900',
                          branch_id=44444, items=((12345, 2), (12346, 1)))


class RestaurantCartTests(unittest.TestCase):
    def test_native_get_route_differs_from_creation_version(self):
        self.assertEqual(r.existing_cart_request('900'), {
            'method': 'GET', 'path': '/cart/v1/900',
            'params': {'hasOutstandingPayments': 'false'}, 'body': None})
        for invalid in (True, False, 0, -1, '0900', '900/other', '900?x=1',
                        ' 900', '900.0', 900.0, None, 2**63):
            with self.subTest(invalid=invalid), self.assertRaises(r.TalabatError):
                r.existing_cart_request(invalid)

    def test_line_and_menu_identity_remain_distinct(self):
        owned = project()
        self.assertEqual(owned.lines, ((12345, 333, 2), (12346, 334, 1)))
        self.assertEqual(owned.total_minor, 3500)
        self.assertFalse(hasattr(owned, 'quote_item_ids'))
        self.assertEqual(r.CCX_MAPPING_BLOCKER, 'RESTAURANT_CCX_ITEM_ID_MAPPING_UNVERIFIED')

    def test_read_accepts_reordering_but_no_identity_or_quantity_changes(self):
        owned = project()
        data = response()
        data['cart']['items'].reverse()
        calls = []
        def get(path, *, params):
            calls.append((path, params))
            return data
        self.assertEqual(r.read_owned_cart(get, owned), owned)
        self.assertEqual(calls, [('/cart/v1/900', {'hasOutstandingPayments': 'false'})])
        for key, value in (('id', 777), ('menuItemId', 777), ('quantity', 2)):
            bad = copy.deepcopy(data)
            bad['cart']['items'][0][key] = value
            with self.subTest(key=key), self.assertRaises(r.TalabatError):
                r.read_owned_cart(lambda *_a, **_k: bad, owned)

    def test_read_accepts_server_total_move_to_quoted_amount(self):
        # After a CCX quote the server rewrites totalValue to the full payable
        # (item value minus booster plus delivery/service); identity is the
        # id + line set, so the move to an approved quote total is legal.
        owned = project()
        data = response()
        data['cart']['totalValue'] = 31.15
        get = lambda *_a, **_k: data
        current = r.read_owned_cart(get, owned, allowed_totals=(3115,))
        self.assertEqual(current.total_minor, 3115)
        self.assertEqual(current.lines, owned.lines)
        with self.assertRaises(r.TalabatError):
            r.read_owned_cart(get, owned)

    def test_exact_cart_and_native_branch_binding(self):
        for field, value in (('cart', {'id': 901}), ('cart', {'id': True}),
                             ('restaurant', {'branchId': 44445}),
                             ('restaurant', {'branchId': '44444'})):
            data = response()
            target = data['cart'] if field == 'cart' else data['branchInfo']['restaurant']
            target.update(value)
            with self.subTest(field=field, value=value), self.assertRaises(r.TalabatError):
                project(data)
        data = response()
        del data['branchInfo']
        data['cart']['branch_id'] = 44444
        with self.assertRaises(r.TalabatError):
            project(data)

    def test_customizations_and_group_or_placed_cart_rejected(self):
        for key, value in (('choices', [{}]), ('choices', {}), ('specialRequest', 'no onions'),
                           ('choicesString', 'extra egg'), ('isFromUpsell', True)):
            data = response()
            data['cart']['items'][0][key] = value
            with self.subTest(key=key), self.assertRaises(r.TalabatError):
                project(data)
        for key in ('isGroupOrder', 'isGroupOrderLocked', 'isOrderPlaced'):
            data = response()
            data['cart'][key] = True
            with self.subTest(key=key), self.assertRaises(r.TalabatError):
                project(data)

    def test_ambiguous_or_coerced_items_rejected(self):
        for key, value in (('id', 333), ('menuItemId', 12345), ('quantity', True),
                           ('quantity', '1'), ('id', '334'), ('menuItemId', True)):
            data = response()
            data['cart']['items'][1][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(r.TalabatError):
                project(data)
        for rows in ([], response()['cart']['items'][:1], [None, None]):
            data = response()
            data['cart']['items'] = rows
            with self.assertRaises(r.TalabatError):
                project(data)

    def test_total_changes_including_disappearance_stop_readback(self):
        for total in (36, None, '35.001', float('nan'), True):
            data = response()
            data['cart']['totalValue'] = total
            with self.subTest(total=total), self.assertRaises(r.TalabatError):
                r.read_owned_cart(lambda *_a, **_k: data, project())

    def test_invalid_owned_context_cannot_issue_get(self):
        calls = []
        def get(*args, **kwargs):
            calls.append(args)
            return response()
        for owned in (None, r.RestaurantCart('900/other', 44444, ((12345, 333, 2),), 3500),
                      r.RestaurantCart('900', 44444, ((12345, 333, True),), 3500),
                      r.RestaurantCart('900', 44444, (), 3500)):
            with self.assertRaises(r.TalabatError):
                r.read_owned_cart(get, owned)
        self.assertEqual(calls, [])

    def test_transport_failure_is_not_retried(self):
        calls = []
        def get(*args, **kwargs):
            calls.append(args)
            raise r.TalabatError('READ_FAILED')
        with self.assertRaisesRegex(r.TalabatError, 'READ_FAILED'):
            r.read_owned_cart(get, project())
        self.assertEqual(len(calls), 1)


if __name__ == '__main__':
    unittest.main()
