"""Shared card status: a decline seen by one agent refuses the card for all."""
import contextlib
import io
import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import card_status as cs
import commerce_cli as cli

DECLINE = 'PAYMENT_DECLINED_INSUFFICIENT_FUNDS_NO_RETRY'
FLOW = '10000000-0000-4000-8000-000000000042'
# 2026-10-18 11:11 Dubai (07:11 UTC)
AT = 1792307460


class TempState(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / 'state' / 'card-status.json'
        env = patch.dict(os.environ, {'CARD_STATUS_FILE': str(self.path)})
        env.start()
        self.addCleanup(env.stop)
        # The owner's real pause file must never leak into tests; PAUSE_FILE is read at import.
        pause = patch.object(cli, 'PAUSE_FILE', self.path.with_name('no-pause'))
        pause.start()
        self.addCleanup(pause.stop)

    def run_card(self, *argv):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            code = cs.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def stored(self):
        return json.loads(self.path.read_text())


class CardStatusModuleTests(TempState):
    def test_no_record_is_not_blocked(self):
        code, out, _ = self.run_card('check', '2342')
        self.assertEqual(code, 0)
        self.assertIn('no decline on record', out)
        self.assertFalse(self.path.exists())

    def test_recent_decline_blocks_with_exact_message(self):
        cs.record_declined('2342', reason=DECLINE, source='commerce talabat 3965762974', now=AT)
        result = cs.check('2342', now=AT + 60)
        self.assertTrue(result['blocked'])
        self.assertEqual(result['error'], 'CARD_RECENTLY_DECLINED')
        self.assertEqual(result['message'],
            f'card 2342 declined at 11:11 Dubai ({DECLINE}, commerce talabat 3965762974). '
            'Ask Abdullah before trying it again; clear with: card-status ok 2342')
        self.assertEqual(result['at_dubai'], '2026-10-18T11:11:00+04:00')

    def test_cli_check_exits_3_and_json_carries_record(self):
        code, out, _ = self.run_card('declined', '2342', '--reason', DECLINE, '--source', 'uber')
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)['recorded'])
        code, out, _ = self.run_card('check', '2342')
        self.assertEqual(code, 3)
        self.assertTrue(out.startswith('card 2342 declined at '))
        self.assertIn(f'({DECLINE}, uber). Ask Abdullah before trying it again; clear with: card-status ok 2342', out)
        code, out, _ = self.run_card('check', '2342', '--json')
        self.assertEqual(code, 3)
        row = json.loads(out)
        self.assertEqual((row['state'], row['reason'], row['source'], row['blocked']),
                         ('declined', DECLINE, 'uber', True))
        # Other cards are unaffected.
        self.assertEqual(self.run_card('check', '1234')[0], 0)

    def test_decline_older_than_12h_no_longer_blocks(self):
        cs.record_declined('2342', reason=DECLINE, now=AT)
        self.assertTrue(cs.check('2342', now=AT + 12 * 3600 - 1)['blocked'])
        late = cs.check('2342', now=AT + 12 * 3600)
        self.assertFalse(late['blocked'])
        self.assertIn('more than 12h ago', late['message'])

    def test_ok_clears_the_card(self):
        self.run_card('declined', '2342', '--reason', DECLINE)
        code, out, _ = self.run_card('ok', '2342', '--note', 'Abdullah topped up 18:12')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['state'], 'ok')
        code, out, _ = self.run_card('check', '2342')
        self.assertEqual(code, 0)
        self.assertIn('ok since', out)
        self.assertIn('Abdullah topped up 18:12', out)
        self.assertEqual(self.stored()['2342']['state'], 'ok')

    def test_only_exact_last4_is_accepted(self):
        for bad in ('554', '23420', 'abcd', '55 2', '5228730112342342', '٥٥٤٢'):
            with self.subTest(bad=bad):
                for argv in (('declined', bad, '--reason', 'x'), ('ok', bad), ('check', bad)):
                    code, _, err = self.run_card(*argv)
                    self.assertEqual(code, 2)
                    self.assertIn('last 4 digits', err)
        self.assertFalse(self.path.exists())

    def test_full_card_numbers_never_stored_in_text(self):
        for text in ('card 5228730112342342 declined', '5228 7301 1234 2342', '5228-7301-1234-2342'):
            for field in ('--reason', '--source'):
                with self.subTest(text=text, field=field):
                    argv = ['declined', '2342', '--reason', DECLINE, field, text]
                    if field == '--reason':
                        argv = ['declined', '2342', '--reason', text]
                    code, _, err = self.run_card(*argv)
                    self.assertEqual(code, 2)
                    self.assertIn('full card number', err)
        self.assertEqual(self.run_card('ok', '2342', '--note', 'paid 5228730112342342')[0], 2)
        self.assertFalse(self.path.exists())
        # Order ids and flow UUIDs are fine.
        code, _, _ = self.run_card('declined', '2342', '--reason', DECLINE,
                                   '--source', f'commerce talabat 3965762974 {FLOW}')
        self.assertEqual(code, 0)

    def test_same_event_recorded_once_so_cleared_card_stays_clear(self):
        first = cs.record_declined('2342', reason=DECLINE, event=FLOW, now=AT)
        self.assertTrue(first['recorded'])
        cs.record_ok('2342', note='topped up', now=AT + 100)
        again = cs.record_declined('2342', reason=DECLINE, event=FLOW, now=AT + 200)
        self.assertFalse(again['recorded'])
        self.assertEqual(again['duplicate_event'], FLOW)
        self.assertFalse(cs.check('2342', now=AT + 300)['blocked'])
        # A new failed attempt blocks again.
        self.assertTrue(cs.record_declined('2342', reason=DECLINE, event='other-flow', now=AT + 400)['recorded'])
        self.assertTrue(cs.check('2342', now=AT + 500)['blocked'])

    def test_attempt_started_before_a_clear_does_not_reblock(self):
        cs.record_ok('2342', now=AT + 100)
        late = cs.record_declined('2342', reason=DECLINE, event='late-read', not_before=AT, now=AT + 200)
        self.assertFalse(late['recorded'])
        self.assertTrue(late['superseded'])
        self.assertFalse(cs.check('2342', now=AT + 300)['blocked'])
        fresh = cs.record_declined('2342', reason=DECLINE, event='fresh', not_before=AT + 150, now=AT + 200)
        self.assertTrue(fresh['recorded'])

    def test_old_decline_re_read_is_recorded_but_does_not_block(self):
        now = AT + 24 * 3600
        late = cs.record_declined('2342', reason=DECLINE, event=FLOW, not_before=AT - 60,
                                  occurred_at=AT, now=now)
        self.assertTrue(late['recorded'])
        record = self.stored()['2342']
        self.assertEqual((record['state'], record['at'], record['recorded_at'], record['events']),
                         ('declined', AT, now, [FLOW]))
        result = cs.check('2342', now=now)
        self.assertFalse(result['blocked'])
        self.assertEqual(result['message'],
                         'card 2342 last declined at 2026-10-18 11:11 Dubai, more than 12h ago, '
                         'recorded 2026-10-19 11:11')

    def test_recent_decline_re_read_blocks_until_12h_after_it_happened(self):
        occurred = AT - 2 * 3600
        cs.record_declined('2342', reason=DECLINE, event=FLOW, not_before=occurred - 60,
                           occurred_at=occurred, now=AT)
        blocked = cs.check('2342', now=AT)
        self.assertTrue(blocked['blocked'])
        self.assertEqual(blocked['error'], 'CARD_RECENTLY_DECLINED')
        self.assertIn('declined at 09:11 Dubai, recorded 2026-10-18 11:11 (', blocked['message'])
        self.assertTrue(cs.check('2342', now=occurred + 12 * 3600 - 1)['blocked'])
        self.assertFalse(cs.check('2342', now=occurred + 12 * 3600)['blocked'])

    def test_decline_time_in_the_future_or_unusable_is_clamped_to_now(self):
        for bad in (AT + 3600, float('inf'), float('nan'), 0, -5, True, '1792307460'):
            with self.subTest(occurred_at=bad):
                self.path.unlink(missing_ok=True)
                cs.record_declined('2342', reason=DECLINE, occurred_at=bad, now=AT)
                self.assertEqual(self.stored()['2342']['at'], AT)
                self.assertTrue(cs.check('2342', now=AT + 12 * 3600 - 1)['blocked'])
                self.assertFalse(cs.check('2342', now=AT + 12 * 3600)['blocked'])

    def test_live_decline_without_occurred_at_blocks_12h_from_now(self):
        cs.record_declined('2342', reason=DECLINE, event=FLOW, now=AT)
        record = self.stored()['2342']
        self.assertEqual((record['at'], record['recorded_at']), (AT, AT))
        self.assertTrue(cs.check('2342', now=AT + 12 * 3600 - 1)['blocked'])
        self.assertFalse(cs.check('2342', now=AT + 12 * 3600)['blocked'])

    def test_ok_after_a_re_read_decline_clears_and_a_later_re_read_stays_clear(self):
        occurred = AT - 3600
        cs.record_declined('2342', reason=DECLINE, event=FLOW, not_before=occurred - 60,
                           occurred_at=occurred, now=AT)
        self.assertTrue(cs.check('2342', now=AT)['blocked'])
        cs.record_ok('2342', note='topped up', now=AT + 60)
        self.assertFalse(cs.check('2342', now=AT + 120)['blocked'])
        # Another old flow whose decline happened before the clear: still clear.
        again = cs.record_declined('2342', reason=DECLINE, event='other-old-flow',
                                   occurred_at=occurred + 30, now=AT + 120)
        self.assertFalse(again['recorded'])
        self.assertTrue(again['superseded'])
        self.assertFalse(cs.check('2342', now=AT + 180)['blocked'])

    def test_re_read_of_an_older_decline_never_shortens_a_newer_block(self):
        cs.record_declined('2342', reason=DECLINE, event='fresh-flow', now=AT)
        older = cs.record_declined('2342', reason=DECLINE, event=FLOW,
                                   occurred_at=AT - 20 * 3600, now=AT + 60)
        self.assertFalse(older['recorded'])
        self.assertEqual(self.stored()['2342']['at'], AT)
        self.assertTrue(cs.check('2342', now=AT + 12 * 3600 - 1)['blocked'])

    def test_records_written_before_recorded_at_existed_still_load(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({'2342': {'state': 'declined', 'reason': DECLINE, 'source': 'uber',
                                                  'at': AT, 'note': None}}))
        result = cs.check('2342', now=AT + 60)
        self.assertTrue(result['blocked'])
        self.assertIsNone(result['recorded_at'])
        self.path.write_text(json.dumps({'2342': {'state': 'declined', 'at': AT, 'recorded_at': 'soon'}}))
        self.assertEqual(cs.check('2342', now=AT + 60)['error'], 'CARD_STATUS_UNREADABLE')

    def test_unreadable_state_fails_closed_and_decline_still_records(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text('{not json')
        code, out, _ = self.run_card('check', '2342')
        self.assertEqual(code, 3)
        self.assertIn('not valid JSON', out)
        self.assertEqual(self.run_card('ok', '2342')[0], 2)
        code, _, _ = self.run_card('declined', '2342', '--reason', DECLINE)
        self.assertEqual(code, 0)
        self.assertEqual(self.stored()['2342']['state'], 'declined')
        self.assertTrue(list(self.path.parent.glob('card-status.json.corrupt-*')))
        self.path.write_text(json.dumps({'2342': {'state': 'maybe', 'at': 1}}))
        self.assertTrue(cs.check('2342')['blocked'])

    def test_state_file_is_private_and_list_shows_cards(self):
        cs.record_declined('2342', reason=DECLINE, source='uber')
        cs.record_ok('1234', note='fine')
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        code, out, _ = self.run_card('list')
        self.assertEqual(code, 0)
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertTrue(lines[0].startswith('card 1234 ok since'))
        self.assertTrue(lines[1].startswith('card 2342 declined at'))
        code, out, _ = self.run_card('list', '--json')
        self.assertEqual([row['card_last4'] for row in json.loads(out)], ['1234', '2342'])
        self.assertEqual(self.run_card('list')[0], 0)


class CommerceCardRefusalTests(TempState):
    LANES = {
        'talabat': (['order', 'talabat', '--vertical', 'restaurants', '--branch', '20515', '--item', '12345',
                     '--apk-pool', 'unused'], 'purchase_talabat'),
        'test-talabat-shops': (['test-talabat-shops', '--branch', '44444', '--item',
                                '10000000-0000-4000-8000-000000000002', '--apk-pool', 'unused'], 'purchase_talabat'),
        'minutes': (['order', 'minutes', '--sku', 'SKU1', '--cvv-from-keychain'], 'order_minutes'),
        'nownow': (['order', 'nownow', '--product-code', 'P', '--store-code', 'S'], 'order_nownow'),
        'main': (['order', 'main', '--sku-config', 'C'], 'order_main'),
        'supermall': (['order', 'supermall', '--sku-config', 'C'], 'order_supermall'),
    }

    def run_cli(self, argv):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = cli.main(argv)
        return code, json.loads(out.getvalue().strip().splitlines()[-1])

    def test_every_paying_lane_refuses_before_any_network_call(self):
        cs.record_declined('2342', reason=DECLINE, source='commerce talabat 3965762974')
        forbidden = AssertionError('no network, auth, keychain or Moni check before the card check')
        for name, (argv, lane) in self.LANES.items():
            with self.subTest(lane=name), \
                    patch.object(cli, lane, side_effect=forbidden) as run, \
                    patch.object(cli, 'CommerceAuth', side_effect=forbidden), \
                    patch.object(cli, 'cvv_from_keychain', side_effect=forbidden), \
                    patch.object(cli.subprocess, 'run', side_effect=forbidden), \
                    patch('moni_go.verify', side_effect=forbidden):
                code, result = self.run_cli([*argv, '--for', 'moni', '--moni-go', 'yes order it'])
                self.assertEqual(code, 3)
                run.assert_not_called()
            self.assertEqual(result['error'], 'CARD_RECENTLY_DECLINED')
            self.assertEqual(result['card_last4'], '2342')
            self.assertFalse(result['ok'])
            self.assertFalse(result['financial_send'])
            self.assertFalse(result['financial_retry'])
            self.assertIn('Ask Abdullah before trying it again; clear with: card-status ok 2342', result['message'])

    def test_lanes_check_the_order_card_not_the_cancelled_one(self):
        # 5542 is cancelled; a cancelled record for it must not stop the lane. 2342 declined must.
        cs.record_cancelled('5542', reason='cancelled')
        with patch.object(cli, 'purchase_talabat', return_value={'ok': True}) as purchase:
            code, _ = self.run_cli(self.LANES['talabat'][0])
        self.assertEqual(code, 0)
        purchase.assert_called_once()
        cs.record_declined('2342', reason=DECLINE)
        code, result = self.run_cli(self.LANES['talabat'][0])
        self.assertEqual(code, 3)
        self.assertEqual(result['card_last4'], '2342')

    def test_prepare_only_is_not_refused_and_clear_reopens_ordering(self):
        cs.record_declined('2342', reason=DECLINE)
        with patch.object(cli, 'purchase_talabat', return_value={'ok': True, 'state': 'PREPARED_NOT_ORDERED'}):
            code, result = self.run_cli([*self.LANES['talabat'][0], '--prepare-only'])
        self.assertEqual((code, result['state']), (0, 'PREPARED_NOT_ORDERED'))
        cs.record_ok('2342', note='topped up')
        with patch.object(cli, 'purchase_talabat', return_value={'ok': True}) as purchase:
            code, _ = self.run_cli(self.LANES['talabat'][0])
        self.assertEqual(code, 0)
        purchase.assert_called_once()

    def test_supermall_paid_resume_only_finishes_tracking(self):
        cs.record_declined('2342', reason=DECLINE)
        argv = [*self.LANES['supermall'][0], '--resume-flow', FLOW]
        with patch.object(cli.journal, 'inspect', return_value={'order_id': 'NAEIA1'}), \
                patch.object(cli, 'order_supermall', return_value={'ok': True}) as resume:
            self.assertEqual(self.run_cli(argv)[0], 0)
        resume.assert_called_once()
        with patch.object(cli.journal, 'inspect', return_value={'order_id': None}), \
                patch.object(cli, 'order_supermall', side_effect=AssertionError('must not run')):
            self.assertEqual(self.run_cli(argv)[0], 3)

    def test_talabat_decline_result_marks_card_and_blocks_next_order(self):
        flow = Mock()
        flow.flow_id = FLOW
        flow.prepare.return_value = {'payable_minor': 4725}
        flow.purchase.return_value = {'state': 'PAYMENT_ERROR_REPORTED', 'reason': DECLINE, 'flow_id': FLOW}
        args = SimpleNamespace(vertical='restaurants', branch=20515, apk_pool='unused', resume_flow=None,
                               prepare_only=False, label='Tim Hortons: muffin', recipient='moni')
        with patch.object(cli, 'input_items', return_value=[{'item_id': 12345, 'quantity': 1}]), \
                patch('talabat_basket.parse_items', return_value=[]), \
                patch.object(cli.talabat.shared, 'verticals_key', return_value='0123456789abcdef'), \
                patch('commerce_talabat.TalabatFlow', return_value=flow), \
                patch.object(cli.journal, 'inspect', return_value={'order_id': '3965762974'}), \
                patch.object(cli.journal, 'complete') as complete, \
                patch.object(cli, 'register_tracking', return_value={'registered': True}) as register, \
                contextlib.redirect_stdout(io.StringIO()):
            result = cli.purchase_talabat(args)
        # The payment outcome itself is unchanged.
        self.assertFalse(result['ok'])
        self.assertFalse(result['purchase_confirmed'])
        self.assertFalse(result['financial_retry'])
        self.assertEqual(result['error'], 'TALABAT_PAYMENT_NOT_CONFIRMED')
        self.assertIn('Do not place another order', result['next_action'])
        complete.assert_not_called()
        self.assertFalse(register.call_args.kwargs['paid'])
        flow.purchase.assert_called_once()
        self.assertTrue(result['card_status']['recorded'])
        self.assertTrue(result['card_status']['blocked'])
        record = self.stored()['2342']
        self.assertEqual((record['state'], record['reason'], record['source']),
                         ('declined', DECLINE, 'commerce talabat 3965762974'))
        self.assertEqual(record['events'], [FLOW])
        # A live decline happened just now: the 12h block starts at this write.
        self.assertEqual(record['at'], record['recorded_at'])
        self.assertLess(abs(record['at'] - time.time()), 60)
        with patch.object(cli, 'purchase_talabat', side_effect=AssertionError('second order must not start')):
            code, refused = self.run_cli(self.LANES['talabat'][0])
        self.assertEqual((code, refused['error']), (3, 'CARD_RECENTLY_DECLINED'))
        self.assertIn('(PAYMENT_DECLINED_INSUFFICIENT_FUNDS_NO_RETRY, commerce talabat 3965762974)',
                      refused['message'])

    def test_other_payment_failures_do_not_mark_the_card(self):
        for reason in ('NO_ROLLBACK_OR_RETRY_ASSUMED', 'STATUS_READ_FAILED_NO_RETRY', None):
            self.assertIsNone(cli.note_card_decline({'state': 'PAYMENT_ERROR_REPORTED', 'reason': reason,
                                                     'flow_id': FLOW}, app='talabat'))
        self.assertFalse(self.path.exists())

    def test_recording_failure_never_changes_the_result(self):
        with patch.object(cs, 'record_declined', side_effect=OSError('disk full')):
            noted = cli.note_card_decline({'reason': DECLINE, 'flow_id': FLOW}, app='talabat')
        self.assertFalse(noted['recorded'])
        self.assertIn('card-status declined 2342', noted['message'])

    def test_recover_payment_decline_records_once_and_respects_a_later_clear(self):
        declined = {'ok': False, 'state': 'PAYMENT_ERROR_REPORTED', 'reason': DECLINE, 'flow_id': FLOW,
                    'order': '3965762974', 'financial_retry': False, 'completed': False}
        with patch.object(cli, 'recover_payment', return_value=dict(declined)), \
                patch.object(cli.journal, 'flow_created_at', return_value=0), \
                patch.object(cli.journal, 'decline_observed_at', return_value=None):
            code, result = self.run_cli(['recover-payment', FLOW])
        self.assertEqual(code, 1)
        self.assertEqual((result['state'], result['reason']), ('PAYMENT_ERROR_REPORTED', DECLINE))
        self.assertTrue(result['card_status']['recorded'])
        self.assertEqual(self.stored()['2342']['source'], 'commerce talabat 3965762974')
        # Abdullah tops up; a later re-read of the same old flow keeps the card clear.
        cs.record_ok('2342', note='topped up')
        with patch.object(cli, 'recover_payment', return_value={**declined, 'flow_id': 'other-old-flow'}), \
                patch.object(cli.journal, 'flow_created_at', return_value=0), \
                patch.object(cli.journal, 'decline_observed_at', return_value=None):
            code, result = self.run_cli(['recover-payment', 'other-old-flow'])
        self.assertEqual(code, 1)
        self.assertFalse(result['card_status']['recorded'])
        self.assertFalse(cs.check('2342')['blocked'])

    def test_cancelled_card_stays_blocked_after_12h(self):
        cs.record_cancelled('2342', reason='lost card', source='owner', now=AT)
        self.assertTrue(cs.check('2342', now=AT + 13 * 3600)['blocked'])

    def test_decline_keeps_a_cancelled_card_cancelled(self):
        cs.record_cancelled('2342', reason='lost card', now=AT)
        cs.record_declined('2342', reason=DECLINE, event=FLOW, now=AT + 60)
        result = cs.check('2342', now=AT + 13 * 3600)
        self.assertEqual((result['blocked'], result['error'], result['state']), (True, 'CARD_CANCELLED', 'cancelled'))
        self.assertEqual(self.stored()['2342']['events'], [FLOW])

    def test_ok_refuses_a_cancelled_card_and_replace_reopens_it(self):
        cs.record_cancelled('2342', reason='lost card', now=AT)
        with self.assertRaisesRegex(cs.CardStatusError, 'card 2342 is cancelled; use card-status replace 2342'):
            cs.record_ok('2342', now=AT + 60)
        self.assertTrue(cs.check('2342', now=AT + 60)['blocked'])
        cs.record_replaced('2342', note='new card from bank', now=AT + 120)
        result = cs.check('2342', now=AT + 120)
        self.assertFalse(result['blocked'])
        self.assertEqual(self.stored()['2342']['note'], 'replaced: new card from bank')

    def test_cli_cancel_and_replace(self):
        code, out, _ = self.run_card('cancel', '2342', '--reason', 'lost card', '--source', 'owner')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['state'], 'cancelled')
        code, out, _ = self.run_card('check', '2342')
        self.assertEqual(code, cs.EXIT_BLOCKED)
        self.assertIn('Card 2342 was cancelled (lost card).', out)
        code, _, err = self.run_card('ok', '2342')
        self.assertEqual(code, cs.EXIT_USAGE)
        self.assertIn('use card-status replace 2342', err)
        code, out, _ = self.run_card('replace', '2342', '--note', 'new card', '--source', 'owner')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['state'], 'ok')
        code, _, _ = self.run_card('check', '2342')
        self.assertEqual(code, 0)

    def test_cancelled_card_refuses_every_paying_lane(self):
        cs.record_cancelled('2342', reason='lost card')
        forbidden = AssertionError('no network, auth, keychain or Moni check before the card check')
        for name, (argv, lane) in CommerceCardRefusalTests.LANES.items():
            with self.subTest(lane=name), \
                    patch.object(cli, lane, side_effect=forbidden) as run, \
                    patch.object(cli, 'CommerceAuth', side_effect=forbidden), \
                    patch.object(cli, 'cvv_from_keychain', side_effect=forbidden), \
                    patch.object(cli.subprocess, 'run', side_effect=forbidden), \
                    patch('moni_go.verify', side_effect=forbidden):
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    code = cli.main([*argv, '--for', 'moni', '--moni-go', 'yes order it'])
                result = json.loads(out.getvalue().strip().splitlines()[-1])
                self.assertEqual(code, 3)
                self.assertEqual((result['error'], result['card_last4']), ('CARD_CANCELLED', '2342'))
                self.assertFalse(result['financial_send'])
                run.assert_not_called()

    def test_ordering_pause_refuses_money_commands_before_anything_else(self):
        pause = Path(self.path.parent) / 'ordering-paused'
        pause.parent.mkdir(parents=True, exist_ok=True)
        pause.write_text('card cancelled by owner 29 Oct\n')
        forbidden = AssertionError('nothing may run while ordering is paused')
        paused = ['order', 'test-talabat-shops', 'await-payment', 'marketplace-cart', 'cart', 'recover-payment']
        argv_for = {'order': ['order', 'talabat', '--vertical', 'restaurants', '--branch', '20515',
                              '--item', '12345', '--apk-pool', 'unused'],
                    'test-talabat-shops': CommerceCardRefusalTests.LANES['test-talabat-shops'][0],
                    'await-payment': ['await-payment', FLOW],
                    'marketplace-cart': ['marketplace-cart', 'main'],
                    'cart': ['cart', 'minutes', 'show'],
                    'recover-payment': ['recover-payment', FLOW]}
        with patch.object(cli, 'PAUSE_FILE', pause), \
                patch.object(cli, 'CommerceAuth', side_effect=forbidden), \
                patch.object(cli, 'cvv_from_keychain', side_effect=forbidden), \
                patch.object(cli.subprocess, 'run', side_effect=forbidden), \
                patch.object(cli, 'purchase_talabat', side_effect=forbidden), \
                patch.object(cli, 'order_minutes', side_effect=forbidden), \
                patch.object(cli, 'recover_payment', side_effect=forbidden), \
                patch.object(cli, 'card_preflight', side_effect=forbidden):
            for command in paused:
                with self.subTest(command=command):
                    code, result = self.run_cli(argv_for[command])
                    self.assertEqual(code, 4)
                    self.assertEqual(result['error'], 'ORDERING_PAUSED')
                    self.assertIn('card cancelled by owner 29 Oct', result['message'])
                    self.assertFalse(result['financial_send'])
                    self.assertFalse(result['financial_retry'])
        with patch.object(cli, 'PAUSE_FILE', pause):
            self.assertEqual(self.run_cli(['capabilities'])[0], 0)


if __name__ == '__main__':
    unittest.main()
