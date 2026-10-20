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


class CancelAfterGoTests(unittest.TestCase):
    def test_leave_it_after_the_go_refuses(self):
        # 19 Oct: her go, then the cancel four minutes later.
        runner = history(msg('JUST psl omg how long', 9, mid=10),
                         msg("It's been like 20 mins since I wanted a coffee pls leave it", 5, mid=11))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO') as caught:
            moni_go.verify('JUST psl omg how long', now=NOW, runner=runner)
        self.assertEqual(caught.exception.go['message_id'], 10)
        self.assertEqual(caught.exception.cancelled_by['message_id'], 11)

    def test_history_order_does_not_matter(self):
        # imsg lists newest first; the walk sorts by time, id breaking ties.
        runner = history(msg('forget it', 2, mid=21), msg('ok psl', 2, mid=20))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            moni_go.verify('ok psl', now=NOW, runner=runner)

    def test_real_cancel_wording_is_caught(self):
        for text in ('nvm', 'Never mind!', 'dont order it', 'Don\u2019t want it anymore', 'cancel pls',
                     'skip it', 'no need', 'STOP', 'not anymore x', 'do not order'):
            with self.subTest(text=text):
                runner = history(msg('yes order it', 6, mid=1), msg(text, 3, mid=2))
                with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
                    moni_go.verify('yes order it', now=NOW, runner=runner)

    def test_dont_cancel_still_want_it_keeps_the_go(self):
        for text in ('dont cancel, still want it', "don't stop", 'no need to change anything',
                     'leave it at the door pls', 'stopwatch says 10 mins', 'cancellation fee?'):
            with self.subTest(text=text):
                runner = history(msg('yes order it', 6, mid=1), msg(text, 3, mid=2))
                self.assertEqual(moni_go.verify('yes order it', now=NOW, runner=runner)['message_id'], 1)

    def test_a_fresh_go_after_the_cancel_wins(self):
        runner = history(msg('yes order it', 10, mid=1), msg('pls leave it', 8, mid=2), msg('yes order it', 4, mid=3))
        got = moni_go.verify('yes order it', now=NOW, runner=runner)
        self.assertEqual(got, {'message_id': 3, 'at': runner_at(4), 'text': 'yes order it'})

    def test_a_clear_go_phrase_after_the_cancel_wins(self):
        runner = history(msg('yes order it', 10, mid=1), msg('nvm', 8, mid=2), msg('ok actually go ahead', 4, mid=3))
        self.assertEqual(moni_go.verify('yes order it', now=NOW, runner=runner)['message_id'], 3)

    def test_dont_go_ahead_is_a_cancel_not_a_fresh_go(self):
        runner = history(msg('yes order it', 10, mid=1), msg('nvm', 8, mid=2), msg('dont go ahead', 4, mid=3))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO') as caught:
            moni_go.verify('yes order it', now=NOW, runner=runner)
        self.assertEqual(caught.exception.cancelled_by['message_id'], 2)

    def test_go_phrase_without_a_cancel_before_it_changes_nothing(self):
        runner = history(msg('yes order it', 10, mid=1), msg('go ahead', 4, mid=3))
        self.assertEqual(moni_go.verify('yes order it', now=NOW, runner=runner)['message_id'], 1)

    def test_a_later_message_with_the_go_words_that_cancels_is_a_cancel(self):
        runner = history(msg('JUST psl', 10, mid=1), msg('cancel the psl', 4, mid=2))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            moni_go.verify('psl', now=NOW, runner=runner)

    def test_a_cancel_after_the_fresh_go_still_refuses(self):
        runner = history(msg('yes order it', 10, mid=1), msg('nvm', 8, mid=2), msg('go ahead', 6, mid=3),
                         msg('forget it', 2, mid=4))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO') as caught:
            moni_go.verify('yes order it', now=NOW, runner=runner)
        self.assertEqual(caught.exception.cancelled_by['message_id'], 4)

    def test_cancel_before_the_go_does_not_count(self):
        runner = history(msg("Wait Robob don't order", 12, mid=1), msg('JUST psl', 6, mid=2))
        self.assertEqual(moni_go.verify('JUST psl', now=NOW, runner=runner)['message_id'], 2)

    def test_wordings_found_in_review_are_caught(self):
        # Nightly review 20 Oct: casual cancels the first list let through.
        for text in ('dont worry about it', 'dw', 'no thanks', 'nah its ok', 'actually no', 'nm', 'nvmd',
                     'nevermindd', 'cancle', 'cancell it', 'forget that', 'dont need it', 'not needed',
                     'no longer need it', 'scrap it', 'drop it', 'dont get it', 'wait', 'hold on',
                     'its too late now', 'i got one already', 'ill get it myself', 'is it cancelled?'):
            with self.subTest(text=text):
                runner = history(msg('yes order it', 6, mid=1), msg(text, 3, mid=2))
                with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
                    moni_go.verify('yes order it', now=NOW, runner=runner)

    def test_delivery_notes_and_delegation_are_not_cancels(self):
        for text in ('leave it on the door', 'leave it at the door', 'leave it with security',
                     'leave it to you', 'leave it up to you', 'no need for cutlery', 'dont forget the sauce',
                     'no need to wait for me', 'cant wait', 'ok ill wait', 'i can wait'):
            with self.subTest(text=text):
                runner = history(msg('yes order it', 6, mid=1), msg(text, 3, mid=2))
                self.assertEqual(moni_go.verify('yes order it', now=NOW, runner=runner)['message_id'], 1)

    def test_a_short_go_repeated_after_a_cancel_does_not_restart_it(self):
        # go "ok", "nvm", then "ok" to Robob's "cancelled": still off.
        for go, later in (('ok', 'ok'), ('psl', 'psl was 20 mins ago')):
            with self.subTest(go=go):
                runner = history(msg(go, 9, mid=1), msg('nvm', 7, mid=2), msg(later, 3, mid=3))
                with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
                    moni_go.verify(go, now=NOW, runner=runner)

    def test_loose_order_words_do_not_restart_a_cancelled_order(self):
        for later in ('ill order it myself', 'i get it', 'should i order it'):
            with self.subTest(later=later):
                runner = history(msg('yes order it', 9, mid=1), msg('nvm', 7, mid=2), msg(later, 3, mid=3))
                with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
                    moni_go.verify('yes order it', now=NOW, runner=runner)

    def test_a_go_message_that_cancels_itself_refuses(self):
        runner = history(msg('yes order it... actually nvm', 4, mid=1))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO') as caught:
            moni_go.verify('yes order it', now=NOW, runner=runner)
        self.assertEqual(caught.exception.cancelled_by['message_id'], 1)

    def test_a_newer_message_without_a_readable_time_is_unverifiable(self):
        bad = {'id': 5, 'chat_id': 45, 'is_from_me': False, 'created_at': None, 'text': 'nvm'}
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            moni_go.verify('yes order it', now=NOW, runner=history(msg('yes order it', 4, mid=4), bad))
        old = {**bad, 'id': 2}
        self.assertEqual(moni_go.verify('yes order it', now=NOW,
                                        runner=history(msg('yes order it', 4, mid=4), old))['message_id'], 4)

    def test_cancel_words_before_the_go_words_in_the_go_message_do_not_cancel(self):
        # Recheck 20 Oct: she changes her mind back within one message.
        for text in ('wait actually yes order it', 'nvm yes order it', 'hold on, ok yes order it'):
            with self.subTest(text=text):
                runner = history(msg(text, 4, mid=1))
                self.assertEqual(moni_go.verify('yes order it', now=NOW, runner=runner)['message_id'], 1)

    def test_order_instructions_are_not_cancels(self):
        for go, later in (('yes order it, dont get the sugar one', 'no need to knock'),
                          ('yes order it', 'tell the driver to wait downstairs'),
                          ('yes order it', 'wait till its ready'),
                          ('yes order it', 'dont worry ill wait'),
                          ('yes order it', 'no need to text me')):
            with self.subTest(go=go, later=later):
                runner = history(msg(go, 6, mid=1), msg(later, 3, mid=2))
                self.assertEqual(moni_go.verify('yes order it', now=NOW, runner=runner)['message_id'], 1)

    def test_cancels_next_to_delivery_wording_still_cancel(self):
        for text in ('no need for it', 'no need for it anymore', 'no need for the coffee anymore',
                     'no need for coffee now', 'leave it, on second thought', 'leave it on hold',
                     'leave it to next time', 'leave it to tomorrow', 'leave it with me ill get it',
                     'ok leave it there', 'just leave it there then', 'i changed my mind', 'changed my mind',
                     'not now', 'not today', 'maybe later', 'later', 'another time', 'dont', 'pls dont',
                     'dont do it', 'dont buy it', 'forget abt it', 'screw it', 'nope', 'its ok dont',
                     'leave itt', 'im not hungry', 'no no'):
            with self.subTest(text=text):
                runner = history(msg('yes order it', 6, mid=1), msg(text, 3, mid=2))
                with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
                    moni_go.verify('yes order it', now=NOW, runner=runner)

    def test_ordering_it_herself_does_not_restart_a_cancelled_order(self):
        for later in ('ok order it myself', 'ok ill order it myself'):
            with self.subTest(later=later):
                runner = history(msg('yes order it', 9, mid=1), msg('nvm', 7, mid=2), msg(later, 3, mid=3))
                with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
                    moni_go.verify('yes order it', now=NOW, runner=runner)

    def test_a_row_without_time_or_id_is_unverifiable(self):
        bad = {'chat_id': 45, 'is_from_me': False, 'created_at': None, 'text': 'nvm'}
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            moni_go.verify('yes order it', now=NOW, runner=history(msg('yes order it', 4, mid=4), bad))

    def test_odd_rows_fail_closed_without_crashing(self):
        # Round 5: a numeric text row and a time without a zone.
        number = {'id': 5, 'chat_id': 45, 'is_from_me': False, 'created_at': runner_at(2), 'text': 42}
        self.assertEqual(moni_go.verify('yes order it', now=NOW,
                                        runner=history(msg('yes order it', 4, mid=4), number))['message_id'], 4)
        naive = {'id': 5, 'chat_id': 45, 'is_from_me': False, 'created_at': '2026-10-19T08:00:00', 'text': 'nvm'}
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            moni_go.verify('yes order it', now=NOW, runner=history(msg('yes order it', 4, mid=4), naive))

    def test_owner_cancel_and_other_chats_are_ignored(self):
        runner = history(msg('yes order it', 6, mid=1), msg('cancel', 3, mine=True, mid=2),
                         msg('cancel', 2, chat=12, mid=3))
        self.assertEqual(moni_go.verify('yes order it', now=NOW, runner=runner),
                         {'message_id': 1, 'at': runner_at(6), 'text': 'yes order it'})


def runner_at(minutes_ago):
    return msg('', minutes_ago)['created_at']


class CheckCommandTests(unittest.TestCase):
    def run_check(self, runner, go='yes order it'):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = moni_go.main(['check', '--go', go], runner=runner, now=NOW)
        return code, json.loads(out.getvalue())

    def test_go_that_stands_exits_zero(self):
        code, out = self.run_check(history(msg('yes order it', 3, mid=5)))
        self.assertEqual((code, out['ok'], out['message_id'], out['text']), (0, True, 5, 'yes order it'))
        self.assertNotIn('error', out)

    def test_cancel_after_go_exits_four_with_the_cancel(self):
        code, out = self.run_check(history(msg('yes order it', 6, mid=5), msg('pls leave it', 2, mid=6)))
        self.assertEqual((code, out['ok'], out['error']), (4, False, 'MONI_CANCELLED_AFTER_GO'))
        self.assertEqual((out['message_id'], out['cancelled_by']['message_id']), (5, 6))

    def test_missing_or_unreadable_exits_two(self):
        code, out = self.run_check(history(msg('something else', 3)))
        self.assertEqual((code, out['ok'], out['error'], out['message_id']), (2, False, 'MONI_GO_NOT_FOUND', None))
        code, out = self.run_check(Mock(return_value=Mock(returncode=1, stdout='')))
        self.assertEqual((code, out['error']), (2, 'MONI_GO_UNVERIFIABLE'))
        code, out = self.run_check(Mock(side_effect=TypeError('boom')))
        self.assertEqual((code, out['ok'], out['error']), (2, False, 'MONI_GO_UNVERIFIABLE'))

    def test_check_only_reads_history(self):
        runner = history(msg('yes order it', 3))
        self.run_check(runner)
        runner.assert_called_once()
        self.assertEqual(runner.call_args.args[0][:2], ['imsg', 'history'])


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

    def test_moni_order_cancelled_after_go_never_reaches_the_purchase(self):
        # The real verify runs on a stubbed chat; its RuntimeError code surfaces through main()'s except block.
        runner = history(msg('JUST psl omg how long', 9, mid=10), msg('pls leave it', 5, mid=11))
        real_verify = moni_go.verify
        with patch.object(c, 'purchase_talabat') as purchase, \
                patch.object(moni_go, 'verify', side_effect=lambda go: real_verify(go, now=NOW, runner=runner)):
            code, out = self.run_cli(['order', 'talabat', '--vertical', 'restaurants', '--branch', '1', '--item', '2',
                                      '--for', 'moni', '--moni-go', 'JUST psl omg how long',
                                      '--resume-flow', '25631dfb-3e6e-4aac-b9c6-761dc53f9b21'])
        self.assertEqual((code, out['ok'], out['error'], out['financial_retry']),
                         (1, False, 'MONI_CANCELLED_AFTER_GO', False))
        purchase.assert_not_called()

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
