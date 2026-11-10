import unittest
from unittest.mock import patch
import commerce_cli


class FoodTrackingTests(unittest.TestCase):
    def test_exact_food_route(self):
        with patch('noon_vertical_reads.track', return_value={'status': 'delivered'}) as read:
            self.assertEqual(commerce_cli.track_exact('noon', 'food', 'FTEST')['status'], 'delivered')
        read.assert_called_once_with('FTEST', 'food')


if __name__ == '__main__':
    unittest.main()
