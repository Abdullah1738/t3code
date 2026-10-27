import contextlib
import datetime as dt
import io
import json
import sqlite3
import unittest
import os as _os, tempfile as _tempfile
# The live card-status record must never decide these tests.
_os.environ['CARD_STATUS_FILE']=_os.path.join(_tempfile.mkdtemp(prefix='card-status-test-'),'card-status.json')
# Nor may her live Robob thread: an empty bridge chat DB unless a test fills one.
_BRIDGE_DIR = _tempfile.mkdtemp(prefix='moni-bridge-test-')


def bridge_db(*rows, name='state.sqlite'):
    path = _os.path.join(_BRIDGE_DIR, name)
    if _os.path.exists(path):
        _os.unlink(path)
    con = sqlite3.connect(path)
    con.execute('CREATE TABLE inbound (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL)')
    for row_id, payload, state in rows:
        con.execute('insert into inbound values (?, ?, ?)', (row_id, payload if isinstance(payload, str) else json.dumps(payload), state))
    con.commit()
    con.close()
    return path


_os.environ['MONI_BRIDGE_DB'] = bridge_db()
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


def said(row_id, text, minutes_ago, *, sender='+971585933213', state='done'):
    at = int((NOW - dt.timedelta(minutes=minutes_ago)).timestamp() * 1000)
    return (row_id, {'id': row_id, 'text': text, 'isAudioMessage': False, 'attachments': [],
                     'receivedAt': at, 'source': 'typed', 'sender': sender}, state)


class BridgeSourceTests(unittest.TestCase):
    def verify(self, go, *bridge_rows, chat=()):
        path = bridge_db(*bridge_rows, name='case.sqlite')
        return moni_go.verify(go, now=NOW, runner=history(*chat), bridge=lambda: moni_go.read_bridge(path))

    def test_go_found_only_in_her_robob_thread(self):
        got = self.verify('yes order it', said('AB-1', 'yes order it pls', 4, state='batched'))
        self.assertEqual(got, {'message_id': 'bridge:AB-1', 'at': runner_at(4).replace('Z', '+00:00'),
                               'text': 'yes order it pls'})

    def test_go_in_bridge_then_cancel_in_chat_45_refuses(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO') as err:
            self.verify('yes order it', said('AB-1', 'yes order it', 6), chat=[msg('pls leave it', 3, mid=900)])
        self.assertEqual((err.exception.go['message_id'], err.exception.cancelled_by['message_id']), ('bridge:AB-1', 900))

    def test_go_in_chat_45_then_cancel_in_bridge_refuses(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO') as err:
            self.verify('yes order it', said('AB-2', 'nvm', 2, state='processing'), chat=[msg('yes order it', 6, mid=900)])
        self.assertEqual(err.exception.cancelled_by['message_id'], 'bridge:AB-2')

    def test_cancel_before_the_go_across_sources_does_not_count(self):
        got = self.verify('yes order it', said('AB-1', 'nvm', 9), chat=[msg('yes order it', 4, mid=900)])
        self.assertEqual(got['message_id'], 900)

    def test_other_senders_and_machine_rows_do_not_count(self):
        rows = (said('AB-1', 'yes order it', 4, sender='+971500000000'),
                ('wake:1', {'id': 'wake:1', 'text': 'yes order it', 'receivedAt': 1, 'attachments': [], 'isAudioMessage': False}, 'done'))
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            self.verify('yes order it', *rows)

    def test_a_tapback_never_starts_an_order_but_can_call_it_off(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            self.verify('yes order it', said('AB-1', 'Loved \u201cyes order it?\u201d', 3))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('yes order it', said('AB-1', 'yes order it', 6), said('AB-2', 'Liked "ok I will cancel it"', 3))

    def test_missing_or_broken_bridge_db_is_unverifiable(self):
        missing = _os.path.join(_BRIDGE_DIR, 'nope', 'state.sqlite')
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            moni_go.verify('yes order it', now=NOW, runner=history(msg('yes order it', 3)),
                           bridge=lambda: moni_go.read_bridge(missing))
        self.assertFalse(_os.path.exists(missing))
        for bad in ('not json', '[1]'):
            with self.subTest(bad=bad), self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
                self.verify('yes order it', ('AB-9', bad, 'done'), chat=[msg('yes order it', 3)])

    def test_a_bridge_row_without_a_readable_time_is_unverifiable(self):
        for at in (None, 'soon', True):
            row = said('AB-2', 'nvm', 2)
            row[1]['receivedAt'] = at
            with self.subTest(at=at), self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
                self.verify('yes order it', said('AB-1', 'yes order it', 4), row)

    def test_a_cancel_from_her_other_address_counts_but_never_starts_an_order(self):
        email = 'moni@example.com'
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('yes order it', said('AB-1', 'yes order it', 6), said('AB-2', 'nvm', 3, sender=email))
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            self.verify('yes order it', said('AB-1', 'yes order it', 6, sender=email))

    def test_a_voice_note_after_the_go_is_unverifiable(self):
        voice = said('AB-2', '', 3)
        voice[1]['isAudioMessage'] = True
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.verify('yes order it', said('AB-1', 'yes order it', 6), voice)
        before = said('AB-0', '', 9)
        before[1]['isAudioMessage'] = True
        self.assertEqual(self.verify('yes order it', before, said('AB-1', 'yes order it', 6))['message_id'], 'bridge:AB-1')

    def test_a_cancel_at_the_same_second_as_the_go_wins_across_sources(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('yes order it', said('AB-1', 'nvm', 4), chat=[msg('yes order it', 4, mid=900)])
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('yes order it', said('AB-1', 'yes order it', 4), chat=[msg('nvm', 4, mid=900)])

    def test_a_chat_45_cancel_before_a_bridge_go_refuses(self):
        # Bridge times are when it stored her message, which can lag her send by any amount,
        # so a chat 45 cancel anywhere before a bridge go in the window counts.
        for minutes in (10, 25, 44):
            with self.subTest(minutes=minutes), self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
                self.verify('yes order it', said('AB-1', 'yes order it', 4), chat=[msg('nvm', minutes, mid=900)])
        # Outside the window it doesn't count.
        self.assertEqual(self.verify('yes order it', said('AB-1', 'yes order it', 4),
                                     chat=[msg('nvm', 60, mid=900)])['message_id'], 'bridge:AB-1')

    def test_a_later_chat_45_go_cannot_hide_a_cancel_before_a_bridge_go(self):
        # Chat 45 alone: "ok psl", "nvm", "ok psl" refuses, since a short go can't restart it.
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('ok psl', said('AB-1', 'ok psl', 30), chat=[msg('nvm', 35, mid=900), msg('ok psl', 28, mid=901)])
        # Two bridge gos: the later one can't move the check off the first.
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('ok psl', said('AB-1', 'ok psl', 30), said('AB-2', 'ok psl', 5), chat=[msg('nvm', 35, mid=900)])

    def test_old_bridge_messages_are_outside_the_window(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            self.verify('yes order it', said('AB-1', 'yes order it', 60))

    def test_reads_the_env_db_read_only(self):
        path = bridge_db(said('AB-1', 'yes order it', 3), name='env.sqlite')
        before = _os.stat(path).st_mtime_ns
        with patch.dict(_os.environ, {'MONI_BRIDGE_DB': path}):
            self.assertEqual(moni_go.verify('yes order it', now=NOW, runner=history())['message_id'], 'bridge:AB-1')
        self.assertEqual(_os.stat(path).st_mtime_ns, before)


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

    def test_check_reads_her_robob_thread_too(self):
        path = bridge_db(said('AB-1', 'yes order it', 5), said('AB-2', 'forget it', 2), name='check.sqlite')
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = moni_go.main(['check', '--go', 'yes order it'], runner=history(), now=NOW,
                                bridge=lambda: moni_go.read_bridge(path))
        out = json.loads(out.getvalue())
        self.assertEqual((code, out['error'], out['cancelled_by']['message_id']), (4, 'MONI_CANCELLED_AFTER_GO', 'bridge:AB-2'))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = moni_go.main(['check', '--go', 'yes order it'], runner=history(msg('yes order it', 3)), now=NOW,
                                bridge=lambda: None)
        self.assertEqual((code, json.loads(out.getvalue())['error']), (2, 'MONI_GO_UNVERIFIABLE'))


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

    def test_moni_order_is_refused_when_her_robob_thread_is_unreadable(self):
        missing = _os.path.join(_BRIDGE_DIR, 'gone', 'state.sqlite')
        with patch.object(c, 'purchase_talabat') as purchase, \
                patch.dict(_os.environ, {'MONI_BRIDGE_DB': missing}), \
                patch.object(moni_go, 'read_history', return_value=[msg('yes order it', 3)]):
            code, out = self.run_cli(['order', 'talabat', '--branch', '1', '--item', '2', '--for', 'moni',
                                      '--moni-go', 'yes order it'])
        self.assertEqual((code, out['error'], out['financial_retry']), (1, 'MONI_GO_UNVERIFIABLE', False))
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


def _bridge_payload(text, sender, minutes_ago, *, audio=False):
    at = int((NOW - dt.timedelta(minutes=minutes_ago)).timestamp() * 1000)
    # The bridge writes sentAt (her send time) alongside receivedAt; tests use the real shape.
    return {'text': text, 'sender': sender, 'isAudioMessage': audio, 'receivedAt': at, 'sentAt': at}


class GroupChatGoTests(unittest.TestCase):
    """Her go counts in her 1:1 and any group chat; only her addresses count in a group."""

    def setUp(self):
        self.root = _tempfile.mkdtemp(prefix='moni-chats-test-')
        self.env = patch.dict(_os.environ, {'MONI_BRIDGE_CHATS_DIR': self.root}, clear=False)
        self.env.start()
        _os.environ.pop('MONI_BRIDGE_DB', None)
        self.addCleanup(self.env.stop)

    def chat(self, slug, *rows):
        d = _os.path.join(self.root, slug)
        _os.makedirs(d, exist_ok=True)
        path = _os.path.join(d, 'state.sqlite')
        if _os.path.exists(path):
            _os.unlink(path)
        con = sqlite3.connect(path)
        con.execute('CREATE TABLE inbound (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL)')
        for i, (payload) in enumerate(rows, 1):
            con.execute('insert into inbound values (?, ?, ?)', (f'{slug}-{i}', json.dumps(payload), 'done'))
        con.commit()
        con.close()
        return path

    def verify(self, go, *, chat=None, runner=None):
        return moni_go.verify(go, now=NOW, runner=runner or history(), chat=chat)

    def test_go_in_group_counts_by_default(self):
        self.chat('moni')
        self.chat('group-sb_gro', _bridge_payload('Order pls', moni_go.MONI_NUMBER, 2))
        got = self.verify('Order pls')
        self.assertEqual(got['text'], 'Order pls')

    def test_abdullah_in_group_is_ignored(self):
        self.chat('moni')
        self.chat('group-sb_gro', _bridge_payload('order pls', '+971585134795', 3),
                  _bridge_payload('wait', '+971585134795', 2))
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            self.verify('order pls')
        self.chat('group-sb_gro', _bridge_payload('order pls', moni_go.MONI_NUMBER, 5),
                  _bridge_payload('cancel', '+971585134795', 2))
        self.assertEqual(self.verify('order pls')['text'], 'order pls')

    def test_go_in_1to1_then_cancel_in_group_is_cancelled(self):
        self.chat('moni', _bridge_payload('yes order it', moni_go.MONI_NUMBER, 5))
        self.chat('group-sb_gro', _bridge_payload('nvm leave it', moni_go.MONI_NUMBER, 2))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('yes order it')

    def test_go_in_group_then_cancel_in_1to1_is_cancelled(self):
        self.chat('moni', _bridge_payload('nvm leave it', moni_go.MONI_NUMBER, 2))
        self.chat('group-sb_gro', _bridge_payload('yes order it', moni_go.MONI_NUMBER, 5))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('yes order it')

    def test_chat_reads_only_moni_and_that_group(self):
        self.chat('moni')
        self.chat('group-test', _bridge_payload('Order pls', moni_go.MONI_NUMBER, 2))
        self.chat('group-other', _bridge_payload('Order pls', moni_go.MONI_NUMBER, 2))
        self.assertEqual(self.verify('Order pls', chat='group-test')['text'], 'Order pls')
        self.chat('group-test')
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            self.verify('Order pls', chat='group-test')

    def test_invalid_chat_slug_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_CHAT_INVALID'):
            self.verify('Order pls', chat='../x')

    def test_missing_chat_dir_is_unverifiable(self):
        self.chat('moni')
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.verify('Order pls', chat='group-missing')

    def test_broken_group_db_is_unverifiable(self):
        self.chat('moni')
        d = _os.path.join(self.root, 'group-broken')
        _os.makedirs(d)
        with open(_os.path.join(d, 'state.sqlite'), 'w') as f:
            f.write('not a database')
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.verify('Order pls')

    def test_legacy_env_db_in_group_dir_applies_sender_filter(self):
        path = self.chat('group-sb_gro', _bridge_payload('order pls', '+971585134795', 3),
                         _bridge_payload('Order pls', moni_go.MONI_NUMBER, 2))
        with patch.dict(_os.environ, {'MONI_BRIDGE_DB': path}):
            got = self.verify('Order pls')
        self.assertEqual(got['text'], 'Order pls')
        self.assertEqual(moni_go.read_bridge(path)[0]['text'], 'Order pls')
        self.assertEqual(len(moni_go.read_bridge(path)), 1)

    def test_lithuanian_and_attachment_tapbacks_never_start_an_order(self):
        self.chat('moni', _bridge_payload('Labai patiko \u201eOrder pls\u201c', moni_go.MONI_NUMBER, 3),
                  _bridge_payload('Loved an image', moni_go.MONI_NUMBER, 2))
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_NOT_FOUND'):
            self.verify('Order pls')

    def test_tapback_can_call_off_a_go(self):
        self.chat('moni', _bridge_payload('yes order it', moni_go.MONI_NUMBER, 5))
        self.chat('group-sb_gro', _bridge_payload('Pasijuokta i\u0161 \u201envm\u201c', moni_go.MONI_NUMBER, 2))
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.verify('yes order it')

    def test_cli_check_accepts_chat_flag(self):
        self.chat('moni')
        self.chat('group-test', _bridge_payload('Order pls', moni_go.MONI_NUMBER, 2))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = moni_go.main(['check', '--go', 'Order pls', '--chat', 'group-test'], runner=history(), now=NOW)
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out.getvalue())['ok'])

    def test_commerce_passes_moni_chat_to_verify(self):
        with patch.object(c, 'purchase_talabat', return_value={'ok': True}), \
                patch.object(moni_go, 'verify', return_value={'message_id': 1}) as verify:
            code = c.main(['order', 'talabat', '--branch', '1', '--item', '2', '--for', 'moni',
                           '--moni-go', 'Order pls', '--moni-chat', 'group-sb_gro'])
        self.assertEqual(code, 0)
        verify.assert_called_once_with('Order pls', chat='group-sb_gro')


class DelayedSourceOrderTests(unittest.TestCase):
    """Bridge rows sent at one time can be ingested later; cross-source order must not trust receipt time."""

    def sent(self, row_id, text, sent_ago, recv_ago, *, group=None, sender=moni_go.MONI_NUMBER):
        at = lambda m: int((NOW - dt.timedelta(minutes=m)).timestamp() * 1000)
        payload = {'id': row_id, 'text': text, 'isAudioMessage': False, 'attachments': [],
                   'receivedAt': at(recv_ago), 'sentAt': at(sent_ago), 'source': 'typed', 'sender': sender}
        return (row_id, payload, 'done'), group

    def recv_only(self, row_id, text, recv_ago):
        at = int((NOW - dt.timedelta(minutes=recv_ago)).timestamp() * 1000)
        return (row_id, {'id': row_id, 'text': text, 'isAudioMessage': False, 'attachments': [],
                         'receivedAt': at, 'source': 'typed', 'sender': moni_go.MONI_NUMBER}, 'done')

    def run_case(self, go, rows_by_db):
        root = _tempfile.mkdtemp(prefix='moni-delay-test-')
        dbs = {}
        for name, rows in rows_by_db.items():
            d = _os.path.join(root, name)
            _os.makedirs(d)
            path = _os.path.join(d, 'state.sqlite')
            con = sqlite3.connect(path)
            con.execute('CREATE TABLE inbound (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL)')
            for row_id, payload, state in rows:
                con.execute('insert into inbound values (?, ?, ?)', (row_id, json.dumps(payload), state))
            con.commit()
            con.close()
            dbs[name] = path
        paths = list(dbs.values())
        return moni_go.verify(go, now=NOW, runner=history(), bridge=lambda: moni_go.read_bridges(paths))

    def test_group_go_sent_before_her_1to1_cancel_is_called_off_even_if_received_later(self):
        go, _ = self.sent('G1', 'yes order it', sent_ago=5, recv_ago=1)
        cancel, _ = self.sent('P1', 'nvm', sent_ago=2, recv_ago=2)
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.run_case('yes order it', {'group-sb_gro': [go], 'moni': [cancel]})

    def test_1to1_go_sent_before_group_cancel_is_called_off_even_if_received_later(self):
        go, _ = self.sent('P1', 'yes order it', sent_ago=5, recv_ago=1)
        cancel, _ = self.sent('G1', 'nvm', sent_ago=2, recv_ago=2)
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.run_case('yes order it', {'moni': [go], 'group-sb_gro': [cancel]})

    def test_cancel_sent_clearly_before_the_go_does_not_count_across_groups(self):
        cancel, _ = self.sent('G1', 'nvm', sent_ago=20, recv_ago=1)
        go, _ = self.sent('G2', 'yes order it', sent_ago=5, recv_ago=5)
        got = self.run_case('yes order it', {'moni': [], 'group-a': [cancel], 'group-b': [go]})
        self.assertEqual(got['text'], 'yes order it')

    def test_ambiguous_cross_group_order_fails_closed(self):
        # No sentAt on either row: ordering is only receipt time, so a close cancel may really follow the go.
        go = self.recv_only('G1', 'yes order it', 5)
        cancel = self.recv_only('G2', 'nvm', 4)
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.run_case('yes order it', {'moni': [], 'group-a': [go], 'group-b': [cancel]})

    def test_missing_sent_time_falls_back_to_received(self):
        at = int((NOW - dt.timedelta(minutes=3)).timestamp() * 1000)
        row = ('R1', {'id': 'R1', 'text': 'yes order it', 'isAudioMessage': False, 'attachments': [],
                      'receivedAt': at, 'source': 'typed', 'sender': moni_go.MONI_NUMBER}, 'done')
        self.assertEqual(self.run_case('yes order it', {'moni': [row]})['text'], 'yes order it')


class ReceiptGapOrderTests(unittest.TestCase):
    """Receipt-only rows are upper bounds on send time: a cross-DB cancel is ordered only when provable.

    A timed row (sentAt) keeps its send time; a receipt-only row was sent no later than its receipt.
    Gaps here are well past 15 minutes, so a fixed skew window would wrongly trust the receipt order.
    """

    def timed(self, row_id, text, sent_ago, *, sender=moni_go.MONI_NUMBER):
        at = int((NOW - dt.timedelta(minutes=sent_ago)).timestamp() * 1000)
        return (row_id, {'id': row_id, 'text': text, 'isAudioMessage': False, 'attachments': [],
                         'receivedAt': at, 'sentAt': at, 'source': 'typed', 'sender': sender}, 'done')

    def recv(self, row_id, text, recv_ago, *, sender=moni_go.MONI_NUMBER):
        at = int((NOW - dt.timedelta(minutes=recv_ago)).timestamp() * 1000)
        return (row_id, {'id': row_id, 'text': text, 'isAudioMessage': False, 'attachments': [],
                         'receivedAt': at, 'source': 'typed', 'sender': sender}, 'done')

    def run_case(self, go, rows_by_db):
        root = _tempfile.mkdtemp(prefix='moni-gap-test-')
        paths = []
        for name, rows in rows_by_db.items():
            d = _os.path.join(root, name)
            _os.makedirs(d)
            path = _os.path.join(d, 'state.sqlite')
            con = sqlite3.connect(path)
            con.execute('CREATE TABLE inbound (id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL)')
            for row_id, payload, state in rows:
                con.execute('insert into inbound values (?, ?, ?)', (row_id, json.dumps(payload), state))
            con.commit()
            con.close()
            paths.append(path)
        return moni_go.verify(go, now=NOW, runner=history(), bridge=lambda: moni_go.read_bridges(paths))

    def test_both_receipt_only_20_min_apart_fails_closed_group_then_1to1(self):
        # Go received 1 min ago could have been sent before the cancel received 20 min ago.
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.run_case('yes order it', {'group-sb_gro': [self.recv('G1', 'yes order it', 1)],
                                           'moni': [self.recv('P1', 'nvm', 20)]})

    def test_both_receipt_only_20_min_apart_fails_closed_1to1_then_group(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.run_case('yes order it', {'moni': [self.recv('P1', 'yes order it', 1)],
                                           'group-sb_gro': [self.recv('G1', 'nvm', 20)]})

    def test_both_receipt_only_20_min_apart_fails_closed_group_then_group(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.run_case('yes order it', {'group-a': [self.recv('G1', 'yes order it', 1)],
                                           'group-b': [self.recv('G2', 'nvm', 20)]})

    def test_timed_go_with_receipt_only_cancel_received_long_after_fails_closed(self):
        # Go sent 20 min ago; the cancel was received 1 min ago but may have been sent 19 min ago, after it.
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.run_case('yes order it', {'moni': [self.timed('P1', 'yes order it', 20)],
                                           'group-sb_gro': [self.recv('G1', 'nvm', 1)]})

    def test_receipt_only_go_with_timed_cancel_sent_long_before_fails_closed(self):
        # Cancel sent 20 min ago; the go was received 1 min ago, so it may have been sent after the cancel.
        with self.assertRaisesRegex(RuntimeError, 'MONI_GO_UNVERIFIABLE'):
            self.run_case('yes order it', {'group-sb_gro': [self.recv('G1', 'yes order it', 1)],
                                           'moni': [self.timed('P1', 'nvm', 20)]})

    def test_receipt_only_cancel_received_before_timed_go_was_sent_is_provably_earlier(self):
        # The cancel was sent no later than 30 min ago; the go was sent 5 min ago, so the go stands.
        got = self.run_case('yes order it', {'group-sb_gro': [self.recv('G1', 'nvm', 30)],
                                             'moni': [self.timed('P1', 'yes order it', 5)]})
        self.assertEqual(got['text'], 'yes order it')

    def test_receipt_only_go_received_before_timed_cancel_was_sent_is_called_off(self):
        # The go was sent no later than 30 min ago, before the cancel sent 5 min ago: a real cancel after the go.
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.run_case('yes order it', {'group-sb_gro': [self.recv('G1', 'yes order it', 30)],
                                           'moni': [self.timed('P1', 'nvm', 5)]})

    def test_both_timed_across_dbs_use_sent_order(self):
        with self.assertRaisesRegex(RuntimeError, 'MONI_CANCELLED_AFTER_GO'):
            self.run_case('yes order it', {'group-sb_gro': [self.timed('G1', 'yes order it', 20)],
                                           'moni': [self.timed('P1', 'nvm', 2)]})
        got = self.run_case('yes order it', {'group-sb_gro': [self.timed('G1', 'nvm', 20)],
                                             'moni': [self.timed('P1', 'yes order it', 2)]})
        self.assertEqual(got['text'], 'yes order it')


if __name__ == '__main__':
    unittest.main()
