"""Payment text corpus: only synthetic test PANs, no owner data."""
if __package__:
    from . import test_environment
else:
    import test_environment

import json
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from card_mask import mask_json_text, mask_recall_value, mask_text, mask_value

PAN = '4111111111111111'


class CardMaskTests(unittest.TestCase):
    def setUp(self):
        self.year = patch('card_mask.REFERENCE_YEAR', 2026)
        self.year.start()
        self.addCleanup(self.year.stop)

    def test_pan_corpus(self):
        for value, last in [(PAN, '1111'), ('4111 1111 1111 1111', '1111'),
                            ('5555-5555-5555-4444', '4444'), ('3782 822463 10005', '0005')]:
            with self.subTest(value=value):
                self.assertEqual(mask_text('card: ' + value), 'card: •••• ' + last)

    def test_identifiers_and_unlabelled_values(self):
        for value in ['1234567890123456', '1794222000123456789',
                      '123e4567-e89b-12d3-a456-426614174000',
                      '41111111-1111-1111-a123-123456789abc',
                      'a' + PAN + 'b', PAN + 'abcdef' * 4,
                      'a' * 24 + PAN, 'a' * 48 + PAN,
                      'x' + PAN, PAN + 'z', 'id_' + PAN, PAN + '_id',
                      '1' + PAN + '1111', '123', '12/25']:
            with self.subTest(value=value):
                self.assertEqual(mask_text(value), value)

    def test_label_corpus(self):
        for label in ['CVC', 'cvv', 'CSC', 'CVN', 'security code']:
            for gap in [': ', '=', ' "', '\":\"', ' (', ' for card is ', '\n']:
                for code in ['123', '1234']:
                    with self.subTest(label=label, gap=gap, code=code):
                        self.assertEqual(mask_text(label + gap + code), label + gap + '•••')
        for label in ['exp', 'expiry', 'expires', 'expiration', 'expiration date', 'valid thru', 'valid through', 'MM/YY']:
            for date in ['12/25', '12/2025', '12-25', '12-2025']:
                with self.subTest(label=label, date=date):
                    self.assertEqual(mask_text(label + ': ' + date), label + ': ••/••')
        for value in ['CVV: 12345', 'CVV: 123abc', 'expiry: 13/25', 'exp: 1794222000']:
            self.assertEqual(mask_text(value), value)

    def test_json_string(self):
        value = json.dumps({'number': PAN, 'cvv': '123', 'expiry': '12/25'})
        self.assertEqual(json.loads(mask_text(value)), {'number': '•••• 1111', 'cvv': '•••', 'expiry': '••/••'})

    def test_escaped_json_and_idempotence(self):
        original = {'cvv': '•••', 'expiry': '••/••', 'text': 'CVV: •••'}
        encoded = json.dumps(original)
        self.assertEqual(mask_text(encoded), encoded)
        self.assertEqual(json.loads(mask_text(encoded)), original)
        nested = json.dumps({'result': json.dumps({'cvv': '123', 'expiry': '12/25'})})
        self.assertNotIn('123', mask_text(nested))
        json.loads(mask_text(nested))

    def test_label_values_preserve_whole_identifiers(self):
        tokens = ['abc123', 'a' * 37 + '123', 'a' * 61 + '123',
                  'abc_123', 'abc-123', '123abc', '123_abc', '123-abc',
                  '123e4567-e89b-12d3-a456-426614174000']
        for label in ['CVC', 'CVV', 'CSC', 'CVN', 'security code']:
            for token in tokens:
                text = label + ': ' + token
                with self.subTest(text=text):
                    self.assertEqual(mask_text(text), text)
                    self.assertEqual(mask_value({label: token}), ({label: token}, False))
        for token in ['abc12/25', 'abc-12/25', 'abc_12/25']:
            text = 'expiry: ' + token
            with self.subTest(text=text):
                self.assertEqual(mask_text(text), text)
                self.assertEqual(mask_value({'expiry': token}), ({'expiry': token}, False))

    def test_sensitive_keys_do_not_truncate_values(self):
        for key in [PAN, '4111 1111 1111 1111', 'CVV: 123', 'expiry: 12/25']:
            with self.subTest(key=key):
                value = {key: 'original payload', 'nested': [{key: 'complete value'}]}
                self.assertEqual(mask_value(value), (value, False))
                self.assertEqual(mask_value({key: PAN}), ({key: '•••• 1111'}, True))
        self.assertEqual(mask_value({'CVV': '123', 'expiration date': '12/25'}),
                         ({'CVV': '•••', 'expiration date': '••/••'}, True))

    def test_hook_masker_preserves_numeric_output_types(self):
        value = {'number': int(PAN), 'cvv': 123, 'count': 123, 'ok': True}
        self.assertEqual(mask_value(value), (value, False))

    def test_embedded_pan_expiry_shapes(self):
        for pan in [PAN, '5555555555554444', '378282246310005']:
            expected = '•••• ' + pan[-4:]
            for expiry in ['1227', '122027']:
                for prefix in ['', '753']:
                    value = prefix + pan + expiry + '123'
                    for separator in ['', ' ', '-']:
                        run = separator.join(value)
                        with self.subTest(last4=pan[-4:], expiry=expiry, prefix=prefix, separator=separator):
                            self.assertEqual(mask_text(run), expected)
                            self.assertEqual(json.loads(mask_text(json.dumps({'amt': run}))), {'amt': expected})
                            self.assertEqual(mask_value({'amt': run}), ({'amt': expected}, True))
                            dia = {'inputs': [{'value': run}]}
                            self.assertEqual(mask_value(dia), ({'inputs': [{'value': expected}]}, True))
                            self.assertEqual(mask_recall_value(dia), ({'inputs': [{'value': expected}]}, True))
                            self.assertEqual(json.loads(mask_text(json.dumps(dia))), {'inputs': [{'value': expected}]})

    def test_embedded_pan_label_shapes(self):
        # No expiry: the field label alone supplies the required context.
        value = '753' + PAN + '9999999'
        expected = '•••• 1111'
        for label in ['card', 'CC', 'pan', 'cardnumber', 'CARD_NUMBER', 'amt', 'Amount']:
            for separator in ['=', ': ', '": "', '\\":\\"']:
                prefix = ('"' if '"' in separator else '') + label + separator
                self.assertEqual(mask_text(prefix + value), prefix + expected)
            for leaf in [value, int(value)]:
                original = {label: leaf}
                self.assertEqual(mask_recall_value(original), ({label: expected}, True))
                self.assertEqual(json.loads(mask_json_text(json.dumps(original))), {label: expected})
                self.assertEqual(mask_value(original), ({label: expected}, True) if isinstance(leaf, str) else (original, False))
        for label in ['order', 'reference', 'total_amount', 'card_id', 'discount', 'account']:
            self.assertEqual(mask_value({label: value}), ({label: value}, False))
            self.assertEqual(mask_text(label + '=' + value), label + '=' + value)
        nested = json.dumps({'result': json.dumps({'amt': int(value)})})
        self.assertEqual(json.loads(json.loads(mask_json_text(nested))['result']), {'amt': expected})

    def test_embedded_pan_expiry_year_boundaries(self):
        for expiry in ['0126', '1226', '0136', '1236', '012026', '122026', '012036', '122036']:
            value = PAN + expiry + '999'
            with self.subTest(expiry=expiry):
                self.assertEqual(mask_text(value), '•••• 1111')
                self.assertEqual(mask_recall_value(int(value)), ('•••• 1111', True))
        for expiry in ['0125', '1237', '012025', '122037', '0027', '1327']:
            value = PAN + expiry + '999'
            with self.subTest(expiry=expiry):
                self.assertEqual(mask_text(value), value)
                self.assertEqual(mask_recall_value(int(value)), (int(value), False))
                self.assertEqual(mask_value({'amt': value}), ({'amt': '•••• 1111'}, True))
        with patch('card_mask.REFERENCE_YEAR', 2028):
            value = PAN + '1227' + '999'
            self.assertEqual(mask_text(value), value)
            self.assertEqual(mask_value({'amount': value}), ({'amount': '•••• 1111'}, True))
        with patch('card_mask.REFERENCE_YEAR', 2098):
            for expiry in ['1200', '122100']:
                self.assertEqual(mask_text(PAN + expiry + '999'), '•••• 1111')

    def test_embedded_pan_limits_and_identifier_boundaries(self):
        value = '753' + PAN + '1227' + '123'
        for token in ['a' + value, value + 'f', '0x' + value, 'id_' + value, value + '_id',
                      'id-' + value, value + '-id', '9' * 31, '0' * 26,
                      '9' * 12 + PAN + '1227', '753' + PAN + '1327999']:
            self.assertEqual(mask_text(token), token)
        no_pan = '9' * 26
        self.assertEqual(mask_value({'amt': no_pan}), ({'amt': no_pan}, False))
        masked = mask_text(value)
        self.assertEqual(mask_text(masked), masked)

    def test_embedded_pan_false_positive_corpus(self):
        for value in ['1000000000000000000000', '4500000000000000000000',
                      '25000000000000000000000000', '00000000000000000001',
                      '12345678901234567890123456']:
            self.assertEqual(mask_text(value), value)
            self.assertEqual(mask_value({'order_id': value}), ({'order_id': value}, False))
        rng = random.Random(792)
        masked = 0
        for _ in range(10000):
            value = ''.join(rng.choices('0123456789', k=rng.randint(20, 30)))
            masked += mask_text(value) != value
        print(f'Embedded PAN false positives: {masked}/10000 ({masked / 100:.2f}%)')
        self.assertLess(masked, 50)

    def test_nested_shape_and_original_unchanged(self):
        value = {'stdout': PAN, 'stderr': '', 'interrupted': False, 'count': 123,
                 'nested': [None, 42, {'cvc': '123', 'expiry': '12/2025'}]}
        original = json.loads(json.dumps(value))
        masked, changed = mask_value(value)
        self.assertTrue(changed)
        self.assertEqual(value, original)
        self.assertEqual(masked, {**value, 'stdout': '•••• 1111',
                         'nested': [None, 42, {'cvc': '•••', 'expiry': '••/••'}]})
        self.assertEqual(mask_value(masked), (masked, False))
        self.assertIsNot(masked, value)
        self.assertIsNot(masked['nested'], value['nested'])


if __name__ == '__main__':
    unittest.main()
