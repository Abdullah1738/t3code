import importlib.util, os, unittest

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ph.py")
_spec = importlib.util.spec_from_file_location("ph_under_test", _PATH)
ph = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ph)  # module import only; no phone is contacted


class RedactTests(unittest.TestCase):
    def test_luhn_card_masked_to_last_four(self):
        self.assertEqual(ph.redact("card 4111 1111 1111 1111 saved"), "card •••• 1111 saved")
        self.assertEqual(ph.redact("4111-1111-1111-1111"), "•••• 1111")
        self.assertEqual(ph.redact("4111111111111111"), "•••• 1111")

    def test_non_luhn_order_id_untouched(self):
        self.assertEqual(ph.redact("Order 1234 5678 9012 3456 placed"), "Order 1234 5678 9012 3456 placed")

    def test_cvc_labels_masked(self):
        self.assertEqual(ph.redact("cvc=123"), "cvc=•••")
        self.assertEqual(ph.redact("CVV: 1234"), "CVV: •••")

    def test_security_code_and_expiry_masked(self):
        self.assertEqual(ph.redact("Security code 123 Expires 12/29"), "Security code ••• Expires ••/••")

    def test_plain_text_and_prices_untouched(self):
        self.assertEqual(ph.redact("Total AED 245.00"), "Total AED 245.00")
        self.assertEqual(ph.redact("Pay now"), "Pay now")
        self.assertEqual(ph.redact(""), "")


if __name__ == "__main__":
    unittest.main()
