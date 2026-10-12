import io
import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import commerce_basket_input as b


class BasketInputTests(unittest.TestCase):
    def read_text(self, text):
        with patch.object(b.sys, 'stdin', io.StringIO(text)):
            return b.read_items('-')

    def test_array_and_items_object_keep_many_arbitrary_items_unchanged(self):
        items = [{'item_id': str(i), 'quantity': 1234, 'note': 'x' * 300,
                  'choices': [{'choice_id': i + 1}]} for i in range(250)]
        for data in (items, {'items': items}):
            self.assertEqual(self.read_text(json.dumps(data)), items)

    def test_utf8_file_preserves_customization_text(self):
        items = [{'item_id': 1, 'quantity': 1, 'note': 'الصلصة جانباً\nNo onions'}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'basket.json'
            path.write_text(json.dumps(items, ensure_ascii=False), encoding='utf-8')
            self.assertEqual(b.read_items(str(path)), items)

    def test_malformed_or_ambiguous_json_fails(self):
        for text in ('{}', '[]', '[1]', 'null', '{"items":[],"other":1}',
                     '[{"quantity":1,"quantity":2}]', '[{"quantity":NaN}]',
                     '[{"quantity":Infinity}]', '[', '{"items":{}}'):
            with self.subTest(text=text), self.assertRaises(b.BasketInputError):
                self.read_text(text)

    def test_missing_file_error_does_not_echo_path_or_content(self):
        with self.assertRaisesRegex(b.BasketInputError, '^BASKET_JSON_UNREADABLE_OR_INVALID$'):
            b.read_items('/nonexistent/private-basket.json')

    def test_legacy_flags_default_quantity_and_preserve_note(self):
        args = Namespace(item='42', quantity=None, item_note='No ice')
        self.assertEqual(b.input_items(args, id_argument='item', id_key='item_id', note_key='note'),
                         [{'item_id': '42', 'quantity': 1, 'note': 'No ice'}])
        args.quantity = 10001
        self.assertEqual(b.input_items(args, id_argument='item', id_key='item_id')[0]['quantity'], 10001)

    def test_mixed_file_and_single_flags_fail_before_read(self):
        for fields in ({'item': '42'}, {'quantity': 1}, {'item_note': 'No ice'}):
            args = Namespace(items_file='basket.json', **fields)
            with patch.object(b, 'read_items', side_effect=AssertionError('read forbidden')), \
                    self.assertRaisesRegex(b.BasketInputError, 'FLAGS_CONFLICT'):
                b.input_items(args, id_argument='item', id_key='item_id')

    def test_file_does_not_invent_single_item_defaults(self):
        args = Namespace(items_file='-', item=None, quantity=None, item_note='')
        with patch.object(b.sys, 'stdin', io.StringIO('[{"sku":"A","qty":3}]')):
            self.assertEqual(b.input_items(args, id_argument='sku', id_key='sku', quantity_key='qty'),
                             [{'sku': 'A', 'qty': 3}])

    def test_single_quantity_must_be_positive_integer(self):
        for quantity in (0, -1, True, 1.5, '2'):
            with self.subTest(quantity=quantity), self.assertRaisesRegex(b.BasketInputError, 'QUANTITY_INVALID'):
                b.input_items(Namespace(item='42', quantity=quantity), id_argument='item', id_key='item_id')


if __name__ == '__main__':
    unittest.main()
