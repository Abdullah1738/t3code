"""An unrelated payment fence and a basket acknowledgement never grant consent."""
import datetime as dt
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import card_status
import commerce_journal as j
import commerce_pending as pending
import order_card
import owner_go


LANES = ('main', 'minutes', 'food', 'nownow', 'supermall')
ITEM_KEYS = dict(main='sku_config', minutes='sku', food='itemCode',
                 nownow='product_code', supermall='sku_config')


class FenceApprovalTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.ledger = owner_go.Ledger(root / 'approval')
        for fixture in (patch.object(j, 'ROOT', root / 'commerce'),
                        patch.object(owner_go, 'Ledger', return_value=self.ledger),
                        patch.object(order_card, 'LAST4', '2342'),
                        patch.dict(os.environ, CARD_STATUS_FILE=str(root / 'cards.json'),
                                   ORDERING_PAUSE_FILE=str(root / 'paused'))):
            fixture.start()
            self.addCleanup(fixture.stop)
        card_status.record_declined('9546', reason='synthetic decline', source='test')

    def flow(self, lane, item):
        flow = str(uuid.uuid4())
        j.open_flow(flow_id=flow, app='noon', vertical=lane,
                    account_hash='a'*64, scope_hash=j.digest([lane, item, flow]))
        if lane == 'nownow':
            j.record_nownow_prepared(flow, 'c'*64)
        pending.register(flow, lane, 'a'*64, [{ITEM_KEYS[lane]: item, 'quantity': 1}],
                         card_last4='2342')
        return flow

    def approve(self, flow, amount=2675):
        return self.ledger.record(vendor='noon', item=owner_go.commerce_item(j.binding(flow)),
                                  amount=amount, currency='AED', quote='Yes to this synthetic basket',
                                  source='unit-test', at=dt.datetime.now(owner_go.UTC).isoformat())

    def consume(self, flow, kind='place'):
        args = dict(request_hash='b'*64, cart_hash=j.digest(flow),
                    review_hash='c'*64, payable_minor=2675)
        if kind == 'payment':
            args['payment_order_id'] = 'NSYNTHETIC'
        if kind == 'prepay':
            args['payment_intent_hash'] = 'd'*64
        return j.consume(flow, 'financial', kind=kind, **args)

    def fence(self, lane='nownow', item='OLD'):
        flow = self.flow(lane, item)
        self.approve(flow)
        self.consume(flow)
        j.observe(flow, 'financial', outcome='CHALLENGE_REQUIRED', evidence_hash='e'*64)
        self.assertEqual(j.inspect(flow)['state'], 'FENCED')
        return flow

    def test_unrelated_fence_allows_prepare_but_never_authorizes_any_financial_kind(self):
        old = self.fence()
        for lane in LANES:
            for kind in ('place', 'payment', 'preauthorize', 'prepay'):
                with self.subTest(lane=lane, kind=kind):
                    self.assertTrue(j.require_account_available('noon', 'a'*64))
                    new = self.flow(lane, 'NEW')
                    j.consume(new, 'cart', kind='cart', request_hash='f'*64)
                    j.observe(new, 'cart', outcome='RESPONSE_RECEIVED', evidence_hash='f'*64)
                    self.assertFalse(pending.warnings(new))
                    before = j.inspect(new)
                    with self.assertRaisesRegex(j.JournalError, '^OWNER_GO_REQUIRED$'):
                        self.consume(new, kind)
                    self.assertEqual(j.inspect(new), before)
        with self.assertRaisesRegex(j.JournalError, '^JOURNAL_FLOW_FENCED$'):
            self.consume(old)

    def test_same_basket_needs_both_recorded_approval_and_exact_acknowledgement(self):
        for lane in LANES:
            with self.subTest(lane=lane):
                old = self.fence(lane)
                new = self.flow(lane, 'OLD')
                from commerce_cli import prepared_result
                result = prepared_result(SimpleNamespace(flow_id=new), {
                    'flow_id': new, 'prepared_only': True, 'review': {'payable_minor': 2675},
                    'readback': {'manifest_verified': True}})
                self.assertEqual(result['warnings'][0]['flow_id'], old)
                self.assertEqual(result['owner_go_item'], owner_go.commerce_item(j.binding(new)))
                self.assertFalse(result['financial_send'])
                pending.acknowledge(new, [old])
                with self.assertRaisesRegex(j.JournalError, '^OWNER_GO_REQUIRED$'):
                    self.consume(new)
                self.assertEqual(j.inspect(new)['operations'], [])
                self.approve(new)
                pending.acknowledge(new, [])
                with self.assertRaisesRegex(j.JournalError, '^SAME_BASKET_PENDING_ACK_REQUIRED$'):
                    self.consume(new)
                self.assertEqual(j.inspect(new)['operations'], [])
                pending.acknowledge(new, [old])
                self.assertTrue(self.consume(new))
                j.observe(new, 'financial', outcome='CHALLENGE_REQUIRED', evidence_hash='e'*64)
                with self.assertRaisesRegex(j.JournalError, '^JOURNAL_FLOW_FENCED$'):
                    self.consume(new)


if __name__ == '__main__':
    unittest.main()
