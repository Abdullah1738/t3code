import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

import card_status
import commerce_cli as cli
import commerce_journal as j
import order_card


class PurchaseGuardTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for p in (patch.object(j, 'ROOT', self.root / 'commerce'),
                  patch.dict(os.environ, CARD_STATUS_FILE=str(self.root / 'cards.json'),
                             ORDERING_PAUSE_FILE=str(self.root / 'paused'))):
            p.start()
            self.addCleanup(p.stop)

    def consume(self, kind='place', lane='food'):
        flow = str(uuid.uuid4())
        j.open_flow(flow_id=flow, app='noon', vertical=lane,
                    account_hash=j.digest(flow), scope_hash='b'*64)
        j.consume(flow, kind, kind=kind, request_hash='c'*64, cart_hash='d'*64,
                  review_hash='e'*64, payable_minor=100)
        return flow

    def test_fallback_requires_recent_recorded_decline_for_every_lane(self):
        cases = [None, {'state': 'ok', 'reason': None, 'source': 'test', 'at': time.time()},
                 {'state': 'cancelled', 'reason': 'test', 'source': 'test', 'at': time.time()},
                 {'state': 'declined', 'reason': 'test', 'source': 'test', 'at': time.time()-86400}]
        with patch.object(order_card, 'LAST4', '2342'):
            for lane in ('food', 'minutes', 'nownow', 'main', 'supermall'):
                for record in cases:
                    with self.subTest(lane=lane, record=record):
                        (self.root / 'cards.json').write_text(json.dumps({'9546': record} if record else {}))
                        with self.assertRaisesRegex(j.JournalError, 'FALLBACK_REQUIRES_RECORDED_9546_DECLINE'):
                            self.consume(lane=lane)
            (self.root / 'cards.json').write_text('invalid')
            with self.assertRaisesRegex(j.JournalError, 'FALLBACK_REQUIRES'):
                self.consume()
            (self.root / 'cards.json').write_text('{}')
            card_status.record_declined('9546', reason='issuer decline', source='fixture')
            flow = self.consume()
            self.assertEqual(j.inspect(flow)['operations'][0]['state'], 'MAY_HAVE_SENT')
            # A decline never releases an unresolved account or permits a second card send.
            with self.assertRaises(j.JournalError):
                j.open_flow(flow_id=str(uuid.uuid4()), app='noon', vertical='minutes',
                            account_hash=j.binding(flow)['account_hash'], scope_hash='f'*64)
            with self.assertRaises(j.JournalError):
                j.consume(flow, 'replacement', kind='place', request_hash='c'*64,
                          cart_hash='d'*64, review_hash='e'*64, payable_minor=100)

    def test_default_needs_no_fallback_and_pause_is_rechecked_before_money(self):
        with patch.object(order_card, 'LAST4', '9546'):
            self.consume()
            with self.assertRaisesRegex(j.JournalError, 'NOWNOW_9546_PAID_CONTRACT_UNPROVEN'):
                self.consume(lane='nownow')
            (self.root / 'paused').touch()
            for kind, lane in (('place', 'food'), ('preauthorize', 'nownow')):
                with self.subTest(kind=kind), self.assertRaisesRegex(j.JournalError, 'ORDERING_PAUSED'):
                    self.consume(kind=kind, lane=lane)

    def test_cli_fallback_refuses_before_auth_or_cart_changes(self):
        with patch.object(order_card, 'LAST4', '2342'), patch.object(cli, 'CommerceAuth') as auth:
            for lane, args in (
                ('food', ['--outlet-code', 'OUTLET1', '--items-file', '/unused']),
                ('minutes', ['--sku', 'TEST', '--quantity', '1']),
                ('nownow', ['--store-code', 'STORE', '--product-code', 'ITEM', '--quantity', '1']),
                ('main', ['--sku', 'TEST', '--quantity', '1']),
                ('supermall', ['--sku', 'TEST', '--quantity', '1'])):
                with self.subTest(lane=lane), contextlib.redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(cli.main(['order', lane, *args]), 1)
                    self.assertEqual(json.loads(out.getvalue())['error'], 'NOON_FALLBACK_REQUIRES_RECORDED_9546_DECLINE')
            auth.assert_not_called()


if __name__ == '__main__':
    unittest.main()
