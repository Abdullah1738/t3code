import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from catalog_schema import normalize


class CatalogSchemaKcalTest(unittest.TestCase):
    def test_kcal_read_from_size(self):
        out = normalize({'name': 'SHOT Iced Caramel Macchiato', 'price': 9, 'size': '190 kcal'})
        self.assertEqual(out['calories_kcal'], 190.0)

    def test_description_kcal_wins_over_size(self):
        out = normalize({'name': 'Latte', 'price': 9, 'description': '120 kcal per cup', 'size': '190 kcal'})
        self.assertEqual(out['calories_kcal'], 120.0)


if __name__ == '__main__':
    unittest.main()
