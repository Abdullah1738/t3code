"""Payment text corpus: only synthetic test PANs, no owner data."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from card_mask import mask_text, mask_value

PAN = '4111111111111111'


class CardMaskTests(unittest.TestCase):
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
