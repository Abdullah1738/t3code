"""Real request entry points with only merchant transport and notifications stubbed."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import datetime as dt
import io
from pathlib import Path
import sys
import time
import types
import unittest
from unittest.mock import patch

import test_fastpath as delivery
item, t = delivery.item, delivery.t

APP = Path(__file__).resolve().parents[3] / 'app-api-cli'


def disabled_keychain(*args, **kwargs):
    raise RuntimeError('keychain disabled in tests')


keychain_stub = types.ModuleType('keychain')
keychain_stub.load = keychain_stub.store = disabled_keychain


def app_modules():
    return {name: module for name, module in sys.modules.copy().items()
            if getattr(module, '__file__', None)
            and Path(module.__file__).resolve().is_relative_to(APP)}


@contextlib.contextmanager
def app_imports():
    with patch.object(sys, 'path', [str(APP / 'test'), str(APP), *sys.path]), \
         patch.dict(sys.modules):
        for name in app_modules():
            sys.modules.pop(name)
        # Each integration owns a different bare toollog; restore the triage one even on failure.
        sys.modules.pop('toollog', None)
        # The complete merchant fixture graph must never read the login Keychain, including on Mac.
        sys.modules['keychain'] = keychain_stub
        yield


with app_imports():
    import careem_account_auth as careem
    import card_status
    import commerce_journal as journal
    import commerce_receipts as receipts
    import inbox_auth
    import test_careem_account_auth as careem_fixture
    import test_commerce_main_order as main_fixture
    merchant_modules = app_modules()
    merchant_modules.pop('toollog')
    merchant_modules['keychain'] = keychain_stub

assert Path(journal.toollog.__file__).resolve() == APP / 'toollog.py'
assert Path(t.tool_log.__code__.co_filename).resolve() == APP.parent / 'robob-watch/helpers/toollog.py'
assert t.tool_log is t.fastpath.tool_log is sys.modules['toollog'].tool_log


class ImportIsolationTests(unittest.TestCase):
    def test_keychain_bindings_are_disabled(self):
        for boundary in (careem.load, careem.store, main_fixture.c.core.load):
            self.assertIs(boundary, disabled_keychain)
            with self.assertRaisesRegex(RuntimeError, '^keychain disabled in tests$'):
                boundary('fixture')

    def test_import_success_and_failure_restore_paths_and_cached_modules(self):
        with patch.dict(sys.modules, {'careem_account_auth': careem,
                                     'keychain': types.ModuleType('keychain')}):
            before_modules, before_path = sys.modules.copy(), sys.path[:]
            for fail in (False, True):
                with self.subTest(fail=fail):
                    try:
                        with app_imports():
                            import careem_account_auth as isolated
                            self.assertIsNot(isolated, careem)
                            self.assertIs(isolated.load, disabled_keychain)
                            if fail:
                                raise ImportError('fixture import failure')
                    except ImportError:
                        if not fail:
                            raise
                    self.assertEqual(sys.path, before_path)
                    self.assertEqual(sys.modules, before_modules)


class RequestCallerTests(unittest.TestCase):
    def setUp(self):
        delivery.DeliveryTests.setUp(self)
        # Lazy merchant imports need the same isolated module graph while a request runs.
        self.stack.enter_context(patch.object(sys, 'path', [str(APP), *sys.path]))
        self.stack.enter_context(patch.dict(sys.modules, merchant_modules))
        self.owner_ledger = journal.owner_go.Ledger(self.root.resolve() / 'owner-go')
        self.stack.enter_context(patch.object(journal.owner_go, 'Ledger', return_value=self.owner_ledger))
        self.stack.enter_context(patch.dict(os.environ, {
            'CARD_STATUS_FILE': str(self.root / 'cards.json'),
            'ORDERING_PAUSE_FILE': str(self.root / 'ordering-paused'),
        }))
        card_status.record_declined('9546', reason='synthetic-test-decline', source='unit-test')

    run_items = delivery.DeliveryTests.run_items
    notifications = delivery.DeliveryTests.notifications

    def approve_flow(self, flow_id, amount):
        binding = journal.binding(flow_id)
        self.owner_ledger.record(vendor=binding['app'], item=journal.owner_go.commerce_item(binding),
                                 amount=amount, currency='AED', quote='Approve this synthetic test basket',
                                 source='unit-test:938', at=dt.datetime.now(journal.owner_go.UTC).isoformat())

    def prepare_registry(self):
        self.stack.enter_context(patch.object(inbox_auth, 'DATA', self.data))
        self.stack.enter_context(patch.object(inbox_auth, 'WATCHERS', self.root))
        t.atomic(self.wd / 'watcher.json', {'paused': False})

    def test_careem_request_records_before_dispatch_and_marks_only_its_otp_expected(self):
        self.prepare_registry()
        def transport(method, url, *args):
            if url == careem.ROUTES['pow'][1]:
                return 200, {}
            self.assertEqual(url, careem.ROUTES['otp'][1])
            evidence = t.read_json(self.data / 'inflight-actions.json', [])
            self.assertEqual([a['sender'] for a in evidence], ['careem'])
            self.assertTrue(all(a['at'] <= time.time() for a in evidence))
            return 202, {'retry_in': 30, 'expires_in': 300, 'otp_length': 6}
        with patch.object(careem, 'guest_context', return_value=careem_fixture.context()), \
             patch.object(careem, 'solve_pow', return_value='pow:fixture:0'), \
             patch.object(careem, '_transport', side_effect=transport):
            flow = careem.Bootstrap(careem_fixture.PHONE, mutate=True)
            flow.last_challenge = 'OTP'
            flow.request_otp()
        requested = item('Careem', 'Your verification code is 123 456.', ts=time.time())
        unrelated = item('Apple', 'Your Apple ID Code is 123 456.', id='imsg:other', ts=time.time())
        with patch.object(t, 'log_decision', wraps=t.log_decision) as decisions:
            self.run_items([requested])
            self.run_items([unrelated])
        self.assertEqual(self.notifications(), [])
        self.assertTrue(any(c.args == (requested, 'otp', 'ignored') for c in decisions.call_args_list))
        self.assertTrue(any(c.args == (unrelated, 'otp', 'logged') for c in decisions.call_args_list))
        evidence = t.read_json(self.data / 'inflight-actions.json', [])
        self.assertEqual(set(evidence[0]), {'sender', 'account', 'at'})

    def test_noon_real_place_records_selected_bank_before_financial_transport(self):
        self.prepare_registry()
        self.stack.enter_context(patch.object(journal, 'ROOT', self.root.resolve() / 'commerce'))
        self.stack.enter_context(patch.object(receipts, 'ROOT', self.root.resolve() / 'commerce'))
        for last4, sender, aliases in (
            ('2342', 'EmiratesNBD', ('emiratesnbd', 'emirates nbd', 'emirates-nbd')),
            ('9546', 'Mashreq', ('mashreq',)),
        ):
            with self.subTest(last4=last4), patch.object(journal.order_card, 'LAST4', last4):
                t.atomic(self.data / 'inflight-actions.json', [])
                # The actual Main caller validates the selected card before reserving place.
                responses = main_fixture.happy_responses(
                    order_status=[{'status': 'pending', 'clientSecret': 'fixture-intent'},
                                  main_fixture.FIXTURE['status_success']],
                    payment_complete={'status': 'payment_pending'})
                responses['session']['isCvvRequired'] = False
                for method in responses['session']['paymentMethods']:
                    for card in method.get('cards', []):
                        card['id'] = 'fixture-card-token'
                def replace_card(value):
                    if isinstance(value, dict):
                        return {k: replace_card(v) for k, v in value.items()}
                    if isinstance(value, list):
                        return [replace_card(v) for v in value]
                    return value.replace('2342', last4) if isinstance(value, str) else value
                responses = replace_card(responses)
                # Distinct account to retain the previous financial operation's fence.
                if last4 == '9546':
                    self.stack.enter_context(patch.object(journal, 'ROOT', self.root.resolve() / 'commerce2'))
                    self.stack.enter_context(patch.object(receipts, 'ROOT', self.root.resolve() / 'commerce2'))
                flow, wire = main_fixture.make_flow(responses)
                flow.offers = {main_fixture.SKU: main_fixture.OFFER}
                wire.responses['cart'] = main_fixture.cart_state()
                flow.add()
                flow.checkout_session()
                flow.review_session()
                flow.prepare_payment()
                self.approve_flow(flow.flow_id, flow.review['payable_minor'])
                original_request = wire.request
                started, dispatched = time.time(), []
                # Client captured the bound method at construction; wrap that boundary.
                def request(op, *args, **kwargs):
                    if op.name in ('place', 'payment_complete'):
                        dispatch_at = time.time()
                        evidence = t.read_json(self.data / 'inflight-actions.json', [])
                        self.assertEqual(sorted(a['sender'] for a in evidence),
                                         sorted(aliases * (len(dispatched) + 1)))
                        for action in evidence:
                            self.assertEqual(set(action), {'sender', 'account', 'at'})
                            self.assertIsNone(action['account'])
                            self.assertIsInstance(action['at'], (int, float))
                            self.assertLessEqual(started, action['at'])
                            self.assertLessEqual(action['at'], dispatch_at)
                            self.assertLessEqual(dispatch_at - action['at'], 600)
                        dispatched.append(op.name)
                    return original_request(op, *args, **kwargs)
                with patch.object(flow.client, '_request', side_effect=request), contextlib.redirect_stdout(io.StringIO()):
                    flow.place()
                    flow.await_success(notify=None, sleep=lambda _: None)
                evidence = t.read_json(self.data / 'inflight-actions.json', [])
                self.assertEqual(dispatched, ['place', 'payment_complete'])
                self.assertEqual(sum(a['sender'] == sender.casefold() for a in evidence), 2)
                otp = item(sender, 'Your OTP for purchase of AED 1200 is 123 456.',
                           ts=time.time(), id=f'imsg:bank-{last4}')
                with patch.object(t, 'log_decision', wraps=t.log_decision) as decisions:
                    self.run_items([otp])
                decisions.assert_called_once_with(otp, 'otp', 'ignored')
                self.assertEqual(self.notifications(), [])

    def test_registry_failure_stops_careem_before_otp_dispatch(self):
        self.prepare_registry()
        with patch.object(careem, 'guest_context', return_value=careem_fixture.context()), \
             patch.object(careem, 'solve_pow', return_value='pow:fixture:0'), \
             patch.object(careem, '_transport', return_value=(200, {})) as transport, \
             patch.object(inbox_auth, 'SOURCE', self.root / 'missing'):
            flow = careem.Bootstrap(careem_fixture.PHONE, mutate=True)
            flow.last_challenge = 'OTP'
            with self.assertRaisesRegex(RuntimeError, 'REGISTRY_UNAVAILABLE'):
                flow.request_otp()
            self.assertEqual(transport.call_count, 1)  # read-only proof of work only

    def test_unknown_card_does_not_register_a_bank_or_mark_auth_expected(self):
        self.prepare_registry()
        inbox_auth.expect_payment('9999')
        self.assertFalse((self.data / 'inflight-actions.json').exists())
        otp = item('Mashreq', 'Your verification code is 123 456.', ts=time.time())
        with patch.object(t, 'log_decision', wraps=t.log_decision) as decisions:
            self.run_items([otp])
        self.assertEqual(self.notifications(), [])
        self.assertTrue(any(c.args == (otp, 'otp', 'logged') for c in decisions.call_args_list))

    def test_registry_failure_rolls_back_financial_consume_before_dispatch(self):
        self.prepare_registry()
        self.stack.enter_context(patch.object(journal, 'ROOT', self.root.resolve() / 'commerce'))
        flow_id = '00000000-0000-4000-8000-000000000938'
        journal.open_flow(flow_id=flow_id, app='noon', vertical='main', account_hash='a'*64, scope_hash='b'*64)
        self.approve_flow(flow_id, 120000)
        with patch.object(inbox_auth, 'SOURCE', self.root / 'missing'):
            with self.assertRaisesRegex(journal.JournalError, 'JOURNAL_UNAVAILABLE'):
                journal.consume(flow_id, 'place', kind='place', request_hash='c'*64,
                                cart_hash='d'*64, review_hash='e'*64, payable_minor=120000)
        self.assertEqual(journal.inspect(flow_id)['operations'], [])

    def test_owner_go_denial_records_no_auth_expectation_and_sends_nothing(self):
        self.prepare_registry()
        for last4 in ('2342', '9546'):
            with self.subTest(last4=last4), patch.object(journal.order_card, 'LAST4', last4), \
                 patch.object(journal, 'ROOT', self.root.resolve() / ('commerce-' + last4)), \
                 patch.object(receipts, 'ROOT', self.root.resolve() / ('commerce-' + last4)):
                responses = main_fixture.happy_responses()
                for method in responses['session']['paymentMethods']:
                    for card in method.get('cards', []):
                        if card['isSelected']:
                            card['mask'] = 'xxxx' + last4
                flow, wire = main_fixture.make_flow(responses)
                flow.offers = {main_fixture.SKU: main_fixture.OFFER}
                wire.responses['cart'] = main_fixture.cart_state()
                flow.add()
                flow.checkout_session()
                flow.review_session()
                before = journal.inspect(flow.flow_id)['operations']
                with patch.object(journal.owner_go, 'require', wraps=journal.owner_go.require) as require, \
                     patch.object(flow.client, '_request', wraps=wire.request) as transport:
                    with self.assertRaisesRegex(main_fixture.market.MarketplaceError, 'OWNER_GO_REQUIRED'):
                        flow.place()
                    require.assert_called_once()
                    transport.assert_not_called()
                self.assertEqual(journal.inspect(flow.flow_id)['operations'], before)
                self.assertEqual(journal.inspect(flow.flow_id)['reserved_minor'], 0)
                self.assertFalse((self.data / 'inflight-actions.json').exists())
                self.assertFalse((self.data / 'inflight-actions.lock').exists())
                self.assertEqual(self.notifications(), [])


if __name__ == '__main__':
    unittest.main()
