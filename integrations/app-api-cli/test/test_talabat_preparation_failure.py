"""Quote rejection must not become a financial/account-wide dead end."""
import os as _os, tempfile as _tempfile
# commerce_cli reads the pause file at import; the owner's real one must not refuse test orders.
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import copy
from dataclasses import replace
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import commerce_cli as cli
import commerce_journal as journal
import commerce_receipts as receipts
from commerce_flow import FlowGate
import talabat_http_checkout as h
import talabat_menu_choices as menu_choices
from test.test_talabat_http_checkout import context, FLOW


class PreparationFailureTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve() / 'commerce'
        for module in (journal, receipts):
            p = patch.object(module, 'ROOT', root)
            p.start(); self.addCleanup(p.stop)
        self.binding = dict(flow_id=FLOW, app='talabat', vertical='restaurants',
                            account_hash='a'*64, scope_hash='b'*64)
        self.sink = receipts.create(**self.binding)
        self.gate = FlowGate(**self.binding, receipt_sink=self.sink, request_check=lambda r: True)
        self.cart_id = 'synthetic-owned-cart'
        self.cart_hash = hashlib.sha256(self.cart_id.encode()).hexdigest()

    def consume(self, name, **extra):
        self.gate.before_talabat(dict(version=1, app='talabat', flow_id=FLOW,
            account_binding='a'*64, operation=name, state='MAY_HAVE_SENT',
            request_sha256='c'*64, cart_binding=self.cart_hash, **extra))

    def create_cart(self):
        self.consume('create_cart')
        self.gate.talabat_receipt(dict(operation='create_cart', state='SUCCEEDED',
            http_status=200, cart_id=self.cart_id, cart_binding=self.cart_hash))

    def legacy_failure(self, status=200):
        self.create_cart(); self.consume('quote_initial')
        self.gate.talabat_receipt(dict(operation='quote_initial', state='SUBMISSION_UNKNOWN',
            http_status=status, reason='RESPONSE_INVALID_OR_UNAVAILABLE_NO_RETRY'))

    def test_release_legacy_200_quote_fence_without_network_or_financial_retry(self):
        self.legacy_failure()
        with patch.object(h, '_wire', side_effect=AssertionError('no network')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['release-flow', FLOW]), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result['state'], 'RELEASED')
        self.assertFalse(result['financial_retry'])
        self.assertFalse(result['remote_cart_deleted'])
        self.assertEqual(journal.inspect(FLOW)['reserved_minor'], 0)
        self.assertTrue(journal.require_account_available('talabat', 'a'*64))
        with self.assertRaises(journal.JournalError):
            self.consume('quote_selected')

    def test_failed_quote_is_diagnosable_and_releases_account_atomically(self):
        self.create_cart(); self.consume('quote_initial')
        diagnostic = h.quote_failure_diagnostic({'checkout': {'amount': '25.60',
            'paymentSummary': {'items': [{'type': 'SmallOrderFee', 'value': 'AED 1.00'}]},
            'address': {'description': 'private-address', 'phone': 'private-phone'},
            'cardToken': 'private-card'}, 'token': 'private-token'},
            h.orders.TalabatError('QUOTE_CHARGE_TYPE_UNSUPPORTED'))
        self.gate.talabat_receipt(dict(operation='quote_initial', state='PREPARATION_FAILED',
            reason='QUOTE_CHARGE_TYPE_UNSUPPORTED', http_status=200, diagnostic=diagnostic))
        self.assertEqual(journal.inspect(FLOW)['state'], 'RELEASED')
        stored = self.sink.snapshot().receipts[-1]
        self.assertEqual(stored.diagnostic['error_code'], 'QUOTE_CHARGE_TYPE_UNSUPPORTED')
        raw = json.dumps(stored.diagnostic)
        for secret in ('private-address', 'private-phone', 'private-card', 'private-token'):
            self.assertNotIn(secret, raw)
        self.assertIn('SmallOrderFee', raw)
        self.assertIn('25.60', raw)
        self.assertTrue(journal.require_account_available('talabat', 'a'*64))

    def test_release_refuses_unobserved_cart_and_any_financial_operation(self):
        self.consume('create_cart')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['release-flow', FLOW]), 1)
        self.gate.talabat_receipt(dict(operation='create_cart', state='SUCCEEDED',
            http_status=200, cart_id=self.cart_id, cart_binding=self.cart_hash))
        self.consume('place', currency='AED', payable_minor=2560, review_sha256='d'*64)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['release-flow', FLOW]), 1)
        self.assertEqual(journal.inspect(FLOW)['reserved_minor'], 2560)

    def test_release_refuses_unknown_cart_before_failed_quote(self):
        self.consume('create_cart')
        self.gate.talabat_receipt(dict(operation='create_cart', state='SUBMISSION_UNKNOWN',
            http_status=200, reason='RESPONSE_INVALID_OR_UNAVAILABLE_NO_RETRY'))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['release-flow', FLOW]), 1)
        self.assertEqual(journal.inspect(FLOW)['state'], 'FENCED')

    def test_persisted_failed_receipt_survives_loss_before_journal_release(self):
        self.create_cart(); self.consume('quote_initial')
        diagnostic = h.quote_failure_diagnostic({}, h.orders.TalabatError('QUOTE_CHARGES_INVALID'))
        self.sink(dict(flow_id=FLOW, operation='quote_initial', state='PREPARATION_FAILED',
            reason='QUOTE_CHARGES_INVALID', http_status=200, diagnostic=diagnostic))
        self.assertEqual(journal.inspect(FLOW)['operations'][-1]['state'], 'MAY_HAVE_SENT')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['release-flow', FLOW]), 0)
        self.assertEqual(journal.inspect(FLOW)['state'], 'RELEASED')

    def test_failed_quote_receipt_write_failure_does_not_release(self):
        self.create_cart(); self.consume('quote_initial')
        self.gate.receipt_sink = lambda r: False
        with self.assertRaises(journal.JournalError):
            self.gate.talabat_receipt(dict(operation='quote_initial', state='PREPARATION_FAILED',
                reason='QUOTE_CHARGES_INVALID', http_status=200,
                diagnostic=h.quote_failure_diagnostic({}, h.orders.TalabatError('QUOTE_CHARGES_INVALID'))))
        self.assertEqual(journal.inspect(FLOW)['state'], 'ACTIVE')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['release-flow', FLOW]), 1)


class DiagnosticTests(unittest.TestCase):
    def test_cli_preserves_safe_quote_failure_code_and_phase(self):
        with patch.object(cli, 'capabilities', side_effect=h.orders.TalabatError(
                'PREPARATION_FAILED:quote_initial:QUOTE_CHARGE_TYPE_UNSUPPORTED')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['capabilities']), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result['error'], 'PREPARATION_FAILED')
        self.assertEqual(result['phase'], 'quote_initial')
        self.assertEqual(result['cause'], 'QUOTE_CHARGE_TYPE_UNSUPPORTED')
        self.assertFalse(result['financial_send'])
        self.assertFalse(result['financial_retry'])

    def test_cli_does_not_expose_untrusted_exception_suffix(self):
        with patch.object(cli, 'capabilities', side_effect=h.orders.TalabatError(
                'PREPARATION_FAILED:quote_initial:private-token')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['capabilities']), 1)
        self.assertEqual(json.loads(output.getvalue())['error'], 'COMMERCE_OPERATION_FAILED')
        self.assertNotIn('private-token', output.getvalue())

    def test_arbitrary_exception_text_and_untrusted_body_are_not_retained(self):
        data = {'checkout': {'amount': 'private-token', 'discountsTotal': 'https://secret',
            'cart': {'items': [{'id': 'secret-id', 'quantity': 1, 'price': 'AED 19.00',
                'total': 'AED 19.00', 'choicesString': 'private-name', 'specialRequest': 'private-phone'}]},
            'paymentSummary': {'items': [{'type': 'https://secret', 'value': 'private-token'}]}}}
        diagnostic = h.quote_failure_diagnostic(data, ValueError('private-exception-secret'))
        self.assertTrue(h.quote_diagnostics.valid(diagnostic))
        self.assertEqual(diagnostic['error_code'], 'UNEXPECTED_QUOTE_PARSE_ERROR')
        text = json.dumps(diagnostic)
        for secret in ('private-', 'https://', 'secret-id'):
            self.assertNotIn(secret, text)
        forged = copy.deepcopy(diagnostic)
        forged['quote']['token'] = 'secret'
        self.assertFalse(h.quote_diagnostics.valid(forged))

    def test_projection_bounded_for_large_baskets(self):
        data = {'checkout': {'cart': {'items': [{'quantity': 1, 'price': 'AED 1.00'}]*10000},
                             'paymentSummary': {'items': [{'type': 'Total', 'amount': 10000}]}}}
        diagnostic = h.quote_failure_diagnostic(data, KeyError('private-field'))
        self.assertTrue(h.quote_diagnostics.valid(diagnostic))
        self.assertEqual(diagnostic['quote']['item_count'], 10000)
        self.assertLess(len(json.dumps(diagnostic).encode()), 24001)

    def test_oversized_json_integer_cannot_break_failure_receipt(self):
        # Valid JSON can contain integers too large for a float conversion.
        huge = 10**400
        data = {'checkout': {'amount': huge, 'cart': {'items': [{'price': huge}]},
            'paymentSummary': {'items': [{'type': 'Total', 'amount': huge}]}}}
        diagnostic = h.quote_failure_diagnostic(data, h.orders.TalabatError('AMOUNT_INVALID'))
        self.assertTrue(h.quote_diagnostics.valid(diagnostic))
        self.assertEqual(diagnostic['quote']['amount'], '<redacted-invalid-money>')
        self.assertNotIn(str(huge), json.dumps(diagnostic))


class QuoteParserDefectTests(unittest.TestCase):
    def test_live_free_choice_negative_original_sentinel_keeps_subtotal_anchor(self):
        # Live Right Bite choice: pr=0, opr=-1. The negative sentinel is not a
        # price; explicit free current price is the zero-cost evidence.
        data = {'result': {'choiceForItem': [{'choiceSections': [{
            'id': 123, 'iid': 3739746911, 'nm': 'Sauce', 'mnq': 1, 'mxq': 1,
            'ich': [{'id': 3739746913, 'nm': 'Dynamite Sauce', 'pr': 0, 'opr': -1}]}]}]}}
        choices = menu_choices.parse_choices(data, 3739746911)
        catalog = menu_choices.choice_catalog(choices)
        home, _, _, cart, quote_data = self.right_bite()
        anchor = h._line_undiscounted(cart.store, cart.items, catalog, {3739746911: 3400})
        self.assertEqual(anchor, (3400,))
        body = h.prepare_body(cart.store, home, features={'paySupportsTPro': False})
        self.assertEqual(h.parse_quote(quote_data, replace(cart, line_undiscounted=anchor),
                                      home, body, None).amount_minor, 2560)
        # No general 'missing price means free' shortcut. Only the explicit
        # no-original-price sentinel can use a valid current price.
        for price, original in ((None, -1), (0, None), (0, -2), (0, False)):
            with self.subTest(price=price, original=original):
                raw = copy.deepcopy(data)
                raw['result']['choiceForItem'][0]['choiceSections'][0]['ich'][0].update(pr=price, opr=original)
                self.assertIsNone(menu_choices.parse_choices(raw, 3739746911)
                                  .options_by_id()[3739746913].original_price_minor)

    def right_bite(self):
        fixture = json.loads((Path(__file__).parent / 'fixture_talabat_right_bite_quote.json').read_text())
        home, config, card, _, _, _, base, data = context('restaurants')
        store = h.Store('restaurants', fixture['branch_id'], 0, False)
        items = (h.Item(fixture['item_id'], 1, choices=((fixture['choice_id'], 1, ()),)),)
        # Only the monetary shape and public menu IDs above are live data.
        # Cart/account identity and the choice label are synthetic test bindings.
        cart = replace(base, store=store, items=items, route_amount_minor=fixture['route_minor'],
            quote_item_ids=((fixture['item_id'], '333'),), line_choice_labels=('synthetic-free-sauce',),
            line_undiscounted=(fixture['original_item_minor'] + fixture['choice_minor'],))
        checkout = data['checkout']
        checkout.update(branchId=store.branch_id, amount=fixture['amount'], discountsTotal=fixture['discountsTotal'])
        checkout['cart']['items'] = [{'id': '333', **fixture['row'],
            'choicesString': 'synthetic-free-sauce', 'specialRequest': ''}]
        checkout['paymentSummary']['items'] = fixture['charges']
        return home, config, card, cart, data

    def test_right_bite_coupon_small_order_free_choice_initial_and_quiet_quotes(self):
        home, config, card, cart, data = self.right_bite()
        for selected in (False, True):
            with self.subTest(selected=selected):
                selection = h.select_payment(config, card) if selected else None
                body = h.prepare_body(cart.store, home, selection=selection,
                    features=None if selected else {'paySupportsTPro': False},
                    instructions=data['checkout']['deliveryInstructions'] if selected else None)
                quote = h.parse_quote(data, cart, home, body, selection)
                self.assertEqual(quote.amount_minor, 2560)
                self.assertEqual(h.project_quote(quote)['item_choices'][0]['choices'],
                                 [{'choice_id': 3739746913, 'quantity': 1, 'sub_choice_ids': []}])

    def test_right_bite_fee_and_discount_reconciliation_stays_exact(self):
        for change in ('unknown_fee', 'duplicate_fee', 'duplicate_discount', 'fee_wrong',
                       'total_wrong', 'choice_changed', 'tip', 'subscription'):
            with self.subTest(change=change):
                home, _, _, cart, data = self.right_bite()
                checkout = data['checkout']; charges = checkout['paymentSummary']['items']
                if change == 'unknown_fee': charges[2]['type'] = 'UnverifiedFee'
                elif change == 'duplicate_fee': charges.append(copy.deepcopy(charges[2]))
                elif change == 'duplicate_discount': charges.append({'type': 'Discount', 'amount': 15})
                elif change == 'fee_wrong': charges[2]['amount'] = 2
                elif change == 'total_wrong': checkout['amount'] = 24.6
                elif change == 'choice_changed': checkout['cart']['items'][0]['choicesString'] = 'different'
                elif change == 'tip': charges.append({'type': 'Tip', 'amount': 1})
                elif change == 'subscription': checkout['subscription'] = {}
                body = h.prepare_body(cart.store, home, features={'paySupportsTPro': False})
                with self.assertRaises(h.orders.TalabatError):
                    h.parse_quote(data, cart, home, body, None)

    def test_missing_subtotal_is_an_explicit_parse_error_not_keyerror(self):
        home, config, card, store, items, cart, parsed, data = context('restaurants')
        data['checkout']['paymentSummary']['items'] = [{'type': 'Total', 'amount': 35}]
        body = h.prepare_body(store, home, features={'paySupportsTPro': False})
        with self.assertRaisesRegex(h.orders.TalabatError, 'QUOTE_AMOUNT_RECONCILIATION_FAILED'):
            h.parse_quote(data, parsed, home, body, None)
