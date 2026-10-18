import contextlib
import datetime as dt
import io
import json
import unittest
import os as _os, tempfile as _tempfile
# The live card-status record must never decide these tests.
_os.environ['CARD_STATUS_FILE']=_os.path.join(_tempfile.mkdtemp(prefix='card-status-test-'),'card-status.json')
from unittest.mock import Mock, patch

import commerce_cli as c
import moni_go

NOW = dt.datetime(2026, 10, 15, 6, 40, tzinfo=dt.timezone.utc)


def history(*rows):
    return Mock(return_value=Mock(returncode=0, stdout='\n'.join(json.dumps(r) for r in rows)))


def msg(text, minutes_ago, *, mine=False, chat=45, mid=1):
    at = (NOW - dt.timedelta(minutes=minutes_ago)).isoformat().replace('+00:00', 'Z')
    return {'id': mid, 'chat_id': chat, 'is_from_me': mine, 'created_at': at, 'text': text}


class VerifyTests(unittest.TestCase):
    def test_recent_message_from_moni_matches_loosely(self):
        runner = history(msg('Runny egg and yes mushroom pls\u2019', 3, mid=7))
        got = moni_go.verify('yes mushroom PLS', now=NOW, runner=runner)
        self.assertEqual(got['message_id'], 7)
        self.assertEqual(runner.call_args.args[0][:4], ['imsg', 'history', '--chat-id', '45'])

    def test_own_messages_old_messages_and_other_chats_do_not_count(self):
        runner = history(msg('order it', 1, mine=True), msg('order it', 60), msg('order it', 2, chat=12))
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            moni_go.verify('order it', now=NOW, runner=runner)

    def test_go_must_match_whole_words(self):
        runner = history(msg('yesterday was fine', 3))
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            moni_go.verify('yes', now=NOW, runner=runner)

    def test_missing_go_and_unreadable_history_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_REQUIRED'):
            moni_go.verify('', now=NOW, runner=history())
        broken = Mock(return_value=Mock(returncode=1, stdout=''))
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            moni_go.verify('order it', now=NOW, runner=broken)
        garbled = Mock(return_value=Mock(returncode=0, stdout='not json'))
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            moni_go.verify('order it', now=NOW, runner=garbled)


class CliGateTests(unittest.TestCase):
    def run_cli(self, argv):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = c.main(argv)
        return code, json.loads(out.getvalue())

    def test_moni_order_without_go_never_reaches_the_order_path(self):
        with patch.object(c, 'purchase_talabat') as purchase, \
                patch.object(moni_go, 'read_history', return_value=[]):
            code, out = self.run_cli(['order', 'talabat', '--branch', '1', '--item', '2', '--for', 'moni'])
        self.assertEqual(code, 1)
        self.assertEqual(out['error'], 'MONI_GO_REQUIRED')
        purchase.assert_not_called()

    def test_moni_order_with_unmatched_go_is_refused(self):
        with patch.object(c, 'order_nownow') as order, \
                patch.object(moni_go, 'read_history', return_value=[]):
            code, out = self.run_cli(['order', 'nownow', '--product-code', 'P', '--store-code', 'S',
                                      '--for', 'moni', '--moni-go', 'yes order it'])
        self.assertEqual((code, out['error'], out['financial_retry']), (1, 'MONI_GO_NOT_FOUND', False))
        order.assert_not_called()

    def test_matched_go_passes_and_is_echoed(self):
        found = {'message_id': 9, 'at': 'x', 'text': 'yes order it'}
        with patch.object(c, 'purchase_talabat', return_value={'ok': True}) as purchase, \
                patch.object(moni_go, 'verify', return_value=found):
            code, out = self.run_cli(['order', 'talabat', '--branch', '1', '--item', '2', '--for', 'moni',
                                      '--moni-go', 'yes order it'])
        self.assertEqual(code, 0)
        self.assertEqual(out['moni_go']['message_id'], 9)
        purchase.assert_called_once()

    def test_owner_orders_and_moni_prepare_only_skip_the_gate(self):
        with patch.object(c, 'purchase_talabat', return_value={'ok': True}) as purchase, \
                patch.object(moni_go, 'verify', side_effect=AssertionError('gate ran')):
            self.assertEqual(self.run_cli(['order', 'talabat', '--branch', '1', '--item', '2'])[0], 0)
            self.assertEqual(self.run_cli(['order', 'talabat', '--branch', '1', '--item', '2',
                                           '--for', 'moni', '--prepare-only'])[0], 0)
        self.assertEqual(purchase.call_count, 2)


if __name__ == '__main__':
    unittest.main()
