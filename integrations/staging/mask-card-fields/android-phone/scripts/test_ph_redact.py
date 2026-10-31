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


class FieldContextTests(unittest.TestCase):
    """Synthetic nodes with generic or absent IDs: the label/content-desc alone must carry the context."""

    def _node(self, t, c, rid, x=1, y=2):
        return dict(t=t, c=c, rid=rid, x=x, y=y, b=(0, 0, 1, 1), clk=False, edit=True, chk=False, sel=False, pkg="com.uber")

    def _show(self, nodes):
        import io, contextlib
        orig = ph.nodes; ph.nodes = lambda: nodes
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf): ph.show(True)
        finally:
            ph.nodes = orig
        return buf.getvalue()

    def test_show_masks_generic_rid_cvc_from_content_desc(self):
        out = self._show([self._node("123", "CVV", "text_input")])
        self.assertNotIn("123", out); self.assertIn("•••", out)

    def test_show_masks_expiry_from_content_desc_without_rid(self):
        out = self._show([self._node("12/29", "Expiry MM/YY", "")])
        self.assertNotIn("12/29", out); self.assertIn("••/••", out)

    def test_tap_echo_masks_cvc_node(self):
        import io, contextlib
        class FakeDev:
            def click(self, x, y): pass
        orig_nodes, orig_d = ph.nodes, ph.d
        ph.nodes = lambda: [self._node("123", "CVV", "text_input")]
        ph.d = lambda: FakeDev()
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf): ph.main(["tap", "CVV"])
        finally:
            ph.nodes, ph.d = orig_nodes, orig_d
        self.assertNotIn("123", buf.getvalue()); self.assertIn("•••", buf.getvalue())

    def test_wait_echo_masks_matched_cvc_node(self):
        import io, contextlib
        orig = ph.nodes
        ph.nodes = lambda: [self._node("123", "CVV", "card_cvc")]
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf): ph.main(["wait", "123", "1"])
        finally:
            ph.nodes = orig
        self.assertNotIn("123", buf.getvalue()); self.assertIn("found •••", buf.getvalue())

    def test_plain_labels_unaffected_by_context(self):
        out = self._show([self._node("Pay now", "Button", "submit_btn")])
        self.assertIn("'Pay now'", out)


class ThreeFixesTests(unittest.TestCase):
    def _node(self, t, c, rid):
        return dict(t=t, c=c, rid=rid, x=1, y=2, b=(0, 0, 1, 1), clk=False, edit=True, chk=False, sel=False, pkg="com.uber")

    def test_mm_yy_format_label_marks_expiry_field(self):
        import io, contextlib
        buf = io.StringIO()
        orig = ph.nodes; ph.nodes = lambda: [self._node("12/29", "MM/YY", "text_input")]
        try:
            with contextlib.redirect_stdout(buf): ph.show(True)
        finally:
            ph.nodes = orig
        self.assertNotIn("12/29", buf.getvalue()); self.assertIn("••/••", buf.getvalue())

    def test_three_word_gap_masks_cvc_value(self):
        self.assertEqual(ph.redact("CVC for card is 123"), "CVC for card is •••")
        self.assertEqual(ph.redact("CVC for card is one two three 123"), "CVC for card is one two three 123")


class PunctuationGapTests(unittest.TestCase):
    def test_json_stringified_fields_masked(self):
        import json
        out = ph.redact(json.dumps({"cvc": "123", "expiry": "12/29"}))
        self.assertEqual(out, '{"cvc": "•••", "expiry": "••/••"}')

    def test_parenthesised_values_masked(self):
        self.assertEqual(ph.redact("CVV (123)"), "CVV (•••)")
        self.assertEqual(ph.redact("Expiry (12/29)"), "Expiry (••/••)")


class ClosingBracketGapTests(unittest.TestCase):
    def test_closing_brackets_in_gap_masked(self):
        self.assertEqual(ph.redact("Security code (CVV): 123"), "Security code (CVV): •••")
        self.assertEqual(ph.redact("(CVC) 123"), "(CVC) •••")
        self.assertEqual(ph.redact("Expiry (MM/YY): 12/29"), "Expiry (MM/YY): ••/••")
        self.assertEqual(ph.redact("Total (AED): 245.00"), "Total (AED): 245.00")
