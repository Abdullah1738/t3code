"""recover-payment re-reads of old declines block from when the decline happened."""
import contextlib
import io
import json
import math
import os
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import card_status as cs
import commerce_cli as cli
import commerce_journal as j

DECLINE = 'PAYMENT_DECLINED_INSUFFICIENT_FUNDS_NO_RETRY'
ORDER = '3965762974'
HOUR = 3600


class RecoverDeclineTimeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name).resolve()
        self.card_file = root / 'state' / 'card-status.json'
        for patcher in (patch.dict(os.environ, {'CARD_STATUS_FILE': str(self.card_file)}),
                        patch.object(j, 'ROOT', root / 'commerce')):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.flow = str(uuid.uuid4())

    def at(self, stamp):
        return patch.object(j.time, 'time', return_value=stamp)

    def journal_flow(self, *, created, declined=None):
        """A Talabat flow; with `declined`, its payment error was observed then."""
        with self.at(created):
            j.open_flow(flow_id=self.flow, app='talabat', vertical='restaurants',
                        account_hash='a' * 64, scope_hash='b' * 64)
        if declined is None:
            return
        with self.at(created + 5):
            j.consume(self.flow, 'quote_initial', kind='quote', request_hash='c' * 64, cart_hash='d' * 64)
            j.observe(self.flow, 'quote_initial', outcome='RESPONSE_RECEIVED', evidence_hash='e' * 64)
            j.consume(self.flow, 'place', kind='place', request_hash='c' * 64, cart_hash='d' * 64,
                      review_hash='f' * 64, payable_minor=2600)
            j.observe(self.flow, 'place', outcome='ORDER_ID_RECEIVED', evidence_hash='1' * 64, order_id=ORDER)
            j.consume(self.flow, 'payment', kind='payment', request_hash='c' * 64, cart_hash='d' * 64,
                      review_hash='f' * 64, payable_minor=2600, payment_order_id=ORDER)
            j.observe(self.flow, 'payment', outcome='RESPONSE_RECEIVED', evidence_hash='2' * 64, order_id=ORDER)
        with self.at(declined):
            j.observe(self.flow, 'payment', outcome='UNKNOWN', evidence_hash='3' * 64, order_id=ORDER)

    def recover(self):
        declined = {'ok': False, 'state': 'PAYMENT_ERROR_REPORTED', 'reason': DECLINE, 'flow_id': self.flow,
                    'order': ORDER, 'financial_retry': False, 'completed': False}
        with patch.object(cli, 'recover_payment', return_value=declined), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            code = cli.main(['recover-payment', self.flow])
        return code, json.loads(out.getvalue().strip().splitlines()[-1])

    def stored(self):
        return json.loads(self.card_file.read_text())['5542']

    def test_journal_reports_when_the_payment_error_was_observed(self):
        now = time.time()
        self.journal_flow(created=now - 3 * HOUR, declined=now - 2 * HOUR)
        self.assertEqual(j.decline_observed_at(self.flow), now - 2 * HOUR)
        other = self.flow
        self.flow = str(uuid.uuid4())
        with self.at(now):
            j.open_flow(flow_id=self.flow, app='talabat', vertical='mart',
                        account_hash='9' * 64, scope_hash='b' * 64)
        self.assertIsNone(j.decline_observed_at(self.flow))
        self.assertEqual(j.decline_observed_at(other), now - 2 * HOUR)
        with self.assertRaisesRegex(j.JournalError, 'JOURNAL_FLOW_UNKNOWN'):
            j.decline_observed_at(str(uuid.uuid4()))

    def test_old_decline_is_recorded_but_does_not_block(self):
        now = time.time()
        occurred = now - 24 * HOUR
        self.journal_flow(created=occurred - 45, declined=occurred)
        code, result = self.recover()
        self.assertEqual(code, 1)
        self.assertEqual((result['state'], result['reason']), ('PAYMENT_ERROR_REPORTED', DECLINE))
        self.assertTrue(result['card_status']['recorded'])
        self.assertFalse(result['card_status']['blocked'])
        self.assertIn('more than 12h ago', result['card_status']['message'])
        record = self.stored()
        self.assertEqual(record['at'], math.ceil(occurred))
        self.assertGreaterEqual(record['recorded_at'], int(now))
        self.assertEqual(record['events'], [self.flow])
        self.assertFalse(cs.check('5542')['blocked'])

    def test_recent_decline_blocks_until_12h_after_it_happened(self):
        now = time.time()
        occurred = now - 2 * HOUR
        self.journal_flow(created=occurred - 45, declined=occurred)
        code, result = self.recover()
        self.assertEqual(code, 1)
        self.assertTrue(result['card_status']['recorded'])
        self.assertTrue(result['card_status']['blocked'])
        at = self.stored()['at']
        self.assertEqual(at, math.ceil(occurred))
        self.assertTrue(cs.check('5542', now=at + 12 * HOUR - 1)['blocked'])
        self.assertFalse(cs.check('5542', now=at + 12 * HOUR)['blocked'])
        # The same flow re-read again is not a second decline.
        self.assertFalse(self.recover()[1]['card_status']['recorded'])

    def test_no_decline_row_records_the_decline_as_now_and_blocks(self):
        # A receipt parked before it was journaled leaves no decline row. The
        # decline may be fresh even on an old flow, so the block must stand.
        created = time.time() - 30 * HOUR
        self.journal_flow(created=created)
        before = time.time()
        code, result = self.recover()
        self.assertEqual(code, 1)
        self.assertTrue(result['card_status']['recorded'])
        self.assertTrue(result['card_status']['blocked'])
        self.assertGreaterEqual(self.stored()['at'], int(before))

    def test_unreadable_journal_records_the_decline_as_happening_now(self):
        with patch.object(cli.journal, 'flow_created_at', side_effect=j.JournalError('JOURNAL_UNAVAILABLE')), \
                patch.object(cli.journal, 'decline_observed_at',
                             side_effect=j.JournalError('JOURNAL_UNAVAILABLE')):
            code, result = self.recover()
        self.assertEqual(code, 1)
        self.assertTrue(result['card_status']['recorded'])
        self.assertTrue(result['card_status']['blocked'])
        record = self.stored()
        self.assertEqual(record['at'], record['recorded_at'])

    def test_ok_after_the_decline_still_wins_over_a_re_read(self):
        now = time.time()
        occurred = now - 2 * HOUR
        self.journal_flow(created=occurred - 45, declined=occurred)
        cs.record_ok('5542', note='topped up', now=now - HOUR)
        code, result = self.recover()
        self.assertEqual(code, 1)
        self.assertFalse(result['card_status']['recorded'])
        self.assertFalse(result['card_status']['blocked'])
        self.assertEqual(self.stored()['state'], 'ok')


if __name__ == '__main__':
    unittest.main()
