"""CLI basket and nonfinancial boundaries; no account or merchant traffic."""
import os as _os, tempfile as _tempfile
# commerce_cli reads the pause file at import; the owner's real one must not refuse test orders.
_os.environ['ORDERING_PAUSE_FILE'] = _os.path.join(_tempfile.gettempdir(), 'ordering-pause-test-absent', 'ordering-paused')
import contextlib
import copy
import io
import json
import tempfile
import unittest
import os as _os, tempfile as _tempfile
# The live card-status record must never decide these tests.
_os.environ['CARD_STATUS_FILE']=_os.path.join(_tempfile.mkdtemp(prefix='card-status-test-'),'card-status.json')
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import commerce_cli as cli


class BasketCLITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'basket.json'
        self.flow = Mock()
        self.flow.flow_id = '10000000-0000-4000-8000-000000000041'
        self.flow.prepare_only.return_value = {
            'flow_id': self.flow.flow_id,
            'prepared_only': True,
            'review': {'payable_minor': 123456, 'quantity': 42},
            'readback': {'manifest_verified': True},
        }

    def run_cli(self, argv):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = cli.main(argv)
        lines = [json.loads(x) for x in out.getvalue().splitlines() if x.strip()]
        return code, lines[-1]

    def lane(self, name):
        return {
            'minutes': ('commerce_minutes.MinutesFlow', {'sku': 'SKU1', 'qty': 4}, []),
            'nownow': ('commerce_nownow_order.NowNowOrderFlow',
                       {'product_code': 'P1', 'quantity': 4}, ['--store-code', 'STORE']),
            'main': ('commerce_main_order.MainOrderFlow',
                     {'sku_config': 'Z1', 'quantity': 4}, []),
            'supermall': ('commerce_supermall_order.SupermallOrderFlow',
                          {'sku_config': 'Z1', 'quantity': 4}, []),
        }[name]

    def test_all_noon_lanes_pass_full_basket_and_stop_before_financial_calls(self):
        for name in ('minutes', 'nownow', 'main', 'supermall'):
            with self.subTest(name=name):
                self.flow.reset_mock()
                target, row, extra = self.lane(name)
                rows = [row, {**row, next(iter(row)): 'SECOND'}]
                self.path.write_text(json.dumps({'items': rows}))
                with patch(target, return_value=self.flow) as cls, \
                     patch.object(cli, 'CommerceAuth'), \
                     patch('commerce_minutes.readback_active_orders', return_value=SimpleNamespace(
                         projection={'count': 0, 'active': []})), \
                     patch.object(cli, 'cvv_from_keychain', side_effect=AssertionError('CVV forbidden')), \
                     patch.object(cli.journal, 'complete', side_effect=AssertionError('complete forbidden')):
                    code, result = self.run_cli(['order', name, '--items-file', str(self.path),
                                                 '--prepare-only', *extra])
                self.assertEqual(code, 0, result)
                self.assertEqual(cls.call_args.kwargs['items'], rows)
                self.assertEqual(result['state'], 'PREPARED_NOT_ORDERED')
                self.assertFalse(result['financial_send'])
                self.assertTrue(result['cart_readback_verified'])
                self.flow.prepare_only.assert_called_once_with()
                for method in ('place', 'complete', 'await_payment', 'await_success',
                               'poll_tracking', 'confirm_paid', 'register_tracker'):
                    getattr(self.flow, method).assert_not_called()

    def test_all_noon_lanes_resume_full_manifest_without_new_flow(self):
        for name in ('minutes', 'nownow', 'main', 'supermall'):
            with self.subTest(name=name):
                target, row, extra = self.lane(name)
                self.path.write_text(json.dumps([row]))
                with patch(target) as cls, patch.object(cli, 'CommerceAuth'), \
                     patch('commerce_minutes.readback_active_orders', return_value=SimpleNamespace(
                         projection={'count': 0, 'active': []})), \
                     patch.object(cli.journal, 'inspect', return_value={'order_id': None}):
                    cls.resume_active.return_value = self.flow
                    code, result = self.run_cli(['order', name, '--items-file', str(self.path),
                        '--resume-flow', self.flow.flow_id, '--prepare-only', *extra])
                self.assertEqual(code, 0, result)
                cls.assert_not_called()
                self.assertEqual(cls.resume_active.call_args.args, (self.flow.flow_id,))
                self.assertEqual(cls.resume_active.call_args.kwargs['items'], [row])

    def test_incomplete_prepare_evidence_blocks_even_financial_invocation(self):
        for name in ('minutes', 'nownow', 'main', 'supermall'):
            target, row, extra = self.lane(name)
            for change in ({'readback': None}, {'readback': {}}, {'readback': False},
                           {'prepared_only': False}, {'flow_id': 'different'}):
                with self.subTest(name=name, change=change):
                    prepared = copy.deepcopy(self.flow.prepare_only.return_value)
                    self.flow.prepare_only.return_value = {
                        'flow_id': self.flow.flow_id, 'prepared_only': True,
                        'review': {'payable_minor': 123}, 'readback': {'exact': True}, **change}
                    self.path.write_text(json.dumps([row]))
                    with patch(target, return_value=self.flow), patch.object(cli, 'CommerceAuth'), \
                         patch('commerce_minutes.readback_active_orders', return_value=SimpleNamespace(
                             projection={'count': 0, 'active': []})), \
                         patch.object(cli, 'cvv_from_keychain', side_effect=AssertionError('CVV forbidden')):
                        code, result = self.run_cli(['order', name, '--items-file', str(self.path), *extra])
                    self.assertEqual(code, 1)
                    self.assertEqual(result['error'], 'PREPARE_ONLY_READBACK_UNCONFIRMED')
                    self.flow.place.assert_not_called()
                    self.flow.prepare_only.return_value = prepared

    def test_file_quantity_conflict_fails_before_auth(self):
        for name in ('minutes', 'nownow', 'main', 'supermall'):
            target, row, extra = self.lane(name)
            self.path.write_text(json.dumps([row]))
            with self.subTest(name=name), patch.object(cli, 'CommerceAuth',
                    side_effect=AssertionError('auth forbidden')):
                code, result = self.run_cli(['order', name, '--items-file', str(self.path),
                                             '--quantity', '2', *extra])
            self.assertEqual(code, 1)
            self.assertEqual(result['error'], 'BASKET_FILE_AND_SINGLE_ITEM_FLAGS_CONFLICT')

    def test_talabat_alias_and_canonical_refuse_retired(self):
        # Talabat retired by owner 2026-11-07: both spellings refuse before the lane runs.
        for prefix in (['test-talabat-shops'], ['order', 'talabat']):
            with self.subTest(prefix=prefix), patch.object(cli, 'purchase_talabat',
                    side_effect=AssertionError('must not run')) as purchase:
                code, _ = self.run_cli([*prefix, '--branch', '123', '--vertical', 'restaurants',
                    '--items-file', str(self.path), '--prepare-only'])
            self.assertEqual(code, 5)
            purchase.assert_not_called()

    def test_prepare_only_does_not_recover_already_ordered_supermall(self):
        with patch.object(cli, 'CommerceAuth'), \
             patch.object(cli.journal, 'inspect', return_value={'order_id': 'EXACTORDER'}), \
             patch('commerce_supermall_order.SupermallOrderFlow') as cls:
            code, result = self.run_cli(['order', 'supermall', '--sku-config', 'Z1',
                '--resume-flow', self.flow.flow_id, '--prepare-only'])
        self.assertEqual(code, 1)
        self.assertEqual(result['error'], 'PREPARE_ONLY_FLOW_ALREADY_ORDERED')
        cls.resume_paid.assert_not_called()


if __name__ == '__main__':
    unittest.main()
