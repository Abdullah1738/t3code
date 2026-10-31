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

    def test_separators_repeated_spaces_and_dashes(self):
        self.assertEqual(ph.redact("4111  1111  1111  1111"), "•••• 1111")
        self.assertEqual(ph.redact("4111--1111 1111-1111"), "•••• 1111")

    def test_labels_split_by_newline_are_masked(self):
        self.assertEqual(ph.redact("Security code\n123"), "Security code\n•••")
        self.assertEqual(ph.redact("Expiry\n12/29"), "Expiry\n••/••")

    def test_bare_value_with_sensitive_field_context_is_masked(self):
        self.assertEqual(ph.redact("123", "card_cvc"), "•••")
        self.assertEqual(ph.redact("12/29", "card_expiry"), "••/••")
        self.assertEqual(ph.redact("Pay now", "card_cvc"), "Pay now")
        self.assertEqual(ph.redact("CVV", "card_cvc"), "CVV")

    def test_show_masks_split_label_nodes(self):
        import io, contextlib
        fake = [dict(t="123", c="CVV", rid="card_cvc", x=1, y=2, b=(0,0,1,1), clk=False, edit=True, chk=False, sel=False, pkg="com.uber"),
                dict(t="12/29", c="Expiry MM/YY", rid="card_exp", x=1, y=3, b=(0,0,1,1), clk=False, edit=True, chk=False, sel=False, pkg="com.uber")]
        orig = ph.nodes; ph.nodes = lambda: fake
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf): ph.show(True)
        finally:
            ph.nodes = orig
        out = buf.getvalue()
        self.assertNotIn("123", out); self.assertNotIn("12/29", out)
        self.assertIn("•••", out); self.assertIn("••/••", out)

    def test_plain_text_and_prices_untouched(self):
        self.assertEqual(ph.redact("Total AED 245.00"), "Total AED 245.00")
        self.assertEqual(ph.redact("Pay now"), "Pay now")
        self.assertEqual(ph.redact(""), "")


if __name__ == "__main__":
    unittest.main()
