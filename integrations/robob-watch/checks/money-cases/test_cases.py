"""Case book, deadline pings, ended reply watchers, outbox replay and the brief line."""
import datetime as dt
import fcntl
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('money_cases', Path(__file__).with_name('cases.py'))
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)

from test_charges import ControlServer, summary

os.environ['MONEY_CASES_REFRESH_DISABLED'] = '1'

TZ = mc.TZ


def at(text):
    return dt.datetime.fromisoformat(text).replace(tzinfo=TZ)


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        environment = patch.dict(os.environ, {'HOME': str(self.tmp),
                                             'CARD_STATUS_FILE': str(self.tmp / 'card-status.json'),
                                             'ROBOB_TOOL_LOG_DIR': str(self.tmp / 'tool-logs')})
        environment.start()
        self.addCleanup(environment.stop)
        self.data, self.root, self.wd = self.tmp / 'data', self.tmp / 'watch', self.tmp / 'wd'
        self.wd.mkdir()
        registry = patch.object(mc, 'merchant_dead', return_value=[])
        registry.start()
        self.addCleanup(registry.stop)

    def case(self, case_id='acme', deadline='2026-10-25', when=at('2026-10-24T09:00'), **extra):
        fields = dict(merchant='Acme', amount='120.50', currency='aed', state='refund asked',
                      next_action='dispute on the card', deadline=deadline, who='Abdullah')
        fields.update(extra)
        return mc.add(self.data, case_id, at=when, root=self.root, **fields)

    def check(self, now, run='r1', ack=True, delivered_at=None, find=None):
        """One runner tick: build the event, ack the run, then deliver it.

        The runner delivers at `delivered_at` (default: the same moment), so a test can delay delivery. A
        delivered event raises `fires` and sets `last_fire_at` in state.json, which is what the check reads.
        With ack=False nothing is delivered (the runner never took the event)."""
        event = mc.run_check(self.wd, run, self.data, self.root, at(now), find=find or finder())
        if ack and event:
            (self.wd / '.run-ok').write_text(run)
            self.deliver(delivered_at or now)
        return event

    def deliver(self, when):
        path = self.wd / 'state.json'
        state = json.loads(path.read_text()) if path.exists() else {'fires': 0}
        state['fires'] = int(state.get('fires', 0)) + 1
        state['last_fire_at'] = at(when).astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        path.write_text(json.dumps(state))

    def watcher(self, watcher_id, status, fires=1):
        folder = self.root / 'watchers' / watcher_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'watcher.json').write_text(json.dumps({'id': watcher_id}))
        (folder / 'state.json').write_text(json.dumps({'status': status, 'fires': fires,
                                                       'last_fire_at': '2026-10-23T10:44:18Z',
                                                       'last_run_at': '2026-10-23T11:00:00Z'}))


class Moments(unittest.TestCase):
    def test_iso_timestamps_are_normalised_to_dubai(self):
        expected = at('2026-11-05T20:58:51.632')
        for text in ('2026-11-05T16:58:51.632Z', '2026-11-05T16:58:51.632z',
                     '2026-11-05T16:58:51.632+00:00', '2026-11-05T20:58:51.632+04:00',
                     '2026-11-05T20:58:51.632'):
            with self.subTest(text=text):
                result = mc.moment(text)
                self.assertEqual(result, expected)
                self.assertEqual(result.tzinfo, TZ)

    def test_invalid_timestamps_are_none(self):
        for text in ('garbage', None, 123, '2026-11-05T16:Z58:51.632'):
            with self.subTest(text=text):
                self.assertIsNone(mc.moment(text))


class Book(Base):
    def test_add_normalises_and_rejects_bad_rows(self):
        c = self.case(amount='1,234.56', currency='gbp')
        self.assertEqual((c['amount'], c['currency'], c['status']), ('1234.56', 'GBP', 'open'))
        for bad in (dict(case_id='Acme X'), dict(case_id='x', amount='abc'), dict(case_id='y', amount='-1'),
                    dict(case_id='z', currency='dirham'), dict(case_id='w', deadline='next week'),
                    dict(case_id='v', merchant=' ')):
            with self.subTest(bad=bad), self.assertRaises(mc.CaseError):
                self.case(**bad)
        with self.assertRaises(mc.CaseError):
            self.case()
        self.assertEqual(len(mc.load(self.data)['cases']), 1)

    def test_update_close_reopen_keep_history(self):
        self.case()
        self.watcher('acme-reply', 'active')
        mc.update(self.data, 'acme', {'state': 'Acme replied', 'deadline': '2026-10-27'}, ['acme-reply'],
                  note='support answered', source='mail:fixture', because='Acme asked for a week', at=at('2026-10-24T12:00'),
                  root=self.root)
        with self.assertRaises(mc.CaseError):
            mc.update(self.data, 'acme', {'state': 'Acme replied'})
        mc.close(self.data, 'acme', 'refund received', at=at('2026-10-26T10:00'))
        with self.assertRaises(mc.CaseError):
            mc.close(self.data, 'acme', 'again')
        c = mc.reopen(self.data, 'acme', '2026-11-01', 'refund bounced', at=at('2026-10-27T10:00'))
        self.assertEqual((c['status'], c['outcome'], c['deadline'], c['watchers']),
                         ('open', None, '2026-11-01', ['acme-reply']))
        texts = [h['text'] for h in c['history']]
        self.assertEqual(texts[0], 'opened')
        self.assertIn('state: Acme replied', texts[1])
        self.assertIn('watcher acme-reply linked', texts[1])
        self.assertEqual(texts[2:], ['closed: refund received', 'reopened: refund bounced'])
        self.assertEqual(oct(os.stat(self.data / 'cases.json').st_mode & 0o777), '0o600')

    def test_date_deadline_means_nine_dubai(self):
        self.assertEqual(mc.parse_time('2026-10-25'), at('2026-10-25T09:00'))
        self.assertEqual(mc.parse_time('2026-10-25T05:00:00Z'), at('2026-10-25T09:00'))


class Pings(Base):
    def test_runner_z_delivery_is_recorded_and_not_repeated_on_later_ticks(self):
        self.case(deadline='2026-11-06')
        self.assertIn('acme', self.check('2026-11-05T20:58:51.632', 'r1'))
        state = json.loads((self.wd / 'state.json').read_text())
        self.assertEqual(state['last_fire_at'], '2026-11-05T16:58:51.632Z')
        for now, run in (('2026-11-05T21:13:51.632', 'r2'), ('2026-11-05T21:28:51.632', 'r3')):
            with self.subTest(now=now):
                self.assertEqual(self.check(now, run), '')
                self.assertEqual(self.sent()['acme|r0|soon'], '2026-11-05T20:58:51.632000+04:00')
                self.assertNotIn('outbox', json.loads((self.wd / 'pings.json').read_text()))
        self.assertEqual(json.loads((self.wd / 'state.json').read_text())['fires'], 1)

    def test_ping_once_inside_a_day_then_daily_when_overdue(self):
        self.case(deadline='2026-10-25T18:00:00+04:00')
        self.assertEqual(self.check('2026-10-24T17:00'), '')
        event = self.check('2026-10-24T18:30')
        self.assertIn('Money cases: 1 need attention.', event)
        self.assertIn('acme: Acme AED 120.50: due Sun 25 Oct 18:00. Next: dispute on the card. Who: Abdullah', event)
        self.assertEqual(self.check('2026-10-24T20:00', 'r2'), '')
        # Overdue pings come once a day, on the day they are due.
        self.assertIn('OVERDUE since Sun 25 Oct 18:00', self.check('2026-10-25T18:30', 'r3'))
        self.assertEqual(self.check('2026-10-25T21:00', 'r4'), '')
        self.assertIn('OVERDUE', self.check('2026-10-26T09:00', 'r5'))

    def test_new_deadline_rearms_and_closed_cases_stay_quiet(self):
        self.case(deadline='2026-10-25')
        self.assertTrue(self.check('2026-10-24T10:00'))
        mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, source='mail:fixture', because='owner said Wed', at=at('2026-10-24T11:00'))
        self.assertEqual(self.check('2026-10-24T12:00', 'r2'), '')
        self.assertIn('due Wed 28 Oct', self.check('2026-10-27T10:00', 'r3'))
        mc.close(self.data, 'acme', 'refunded')
        self.assertEqual(self.check('2026-10-29T10:00', 'r4'), '')

    def test_quiet_hours_hold_the_ping(self):
        self.case(deadline='2026-10-25T08:30:00+04:00')
        self.assertEqual(self.check('2026-10-24T23:30'), '')
        self.assertEqual(self.check('2026-10-25T07:59'), '')
        self.assertIn('due Sun 25 Oct 08:30', self.check('2026-10-25T08:00'))

    def archive(self, watcher_id):
        (self.root / 'archive').mkdir(exist_ok=True)
        os.rename(self.root / 'watchers' / watcher_id, self.root / 'archive' / f'{watcher_id}-1792800000000')

    def test_ended_reply_watcher_asks_for_options_once(self):
        for w in ('host-reply', 'gone-reply', 'live-reply'):
            self.watcher(w, 'active')
        self.case(deadline='2026-11-01', watchers=['host-reply', 'gone-reply', 'live-reply'])
        self.watcher('host-reply', 'done', fires=3)
        self.archive('gone-reply')
        event = self.check('2026-10-24T10:00')
        self.assertIn('reply watcher host-reply done after 3 fire(s)', event)
        self.assertIn('reply watcher gone-reply removed', event)
        self.assertIn('Options: chase again with a new reply watcher, take the next step, or close the case', event)
        self.assertNotIn('live-reply', event)
        self.assertNotIn('due', event)
        self.assertEqual(self.check('2026-10-24T11:00', 'r2'), '')
        self.watcher('live-reply', 'expired', fires=0)
        # One reminder a day, so the next ending goes out on the next day.
        self.assertIn('live-reply expired after 0 fire(s)', self.check('2026-10-25T10:00', 'r3'))
        # Cleaning up a finished watcher with `robob-watch remove` is not a second ending.
        self.archive('host-reply')
        self.assertEqual(self.check('2026-10-24T13:00', 'r4'), '')

    def test_unknown_watcher_is_refused_or_named_as_unknown(self):
        with self.assertRaises(mc.CaseError):
            self.case(watchers=['never-created-typo'])
        self.case(deadline='2026-11-01')
        with self.assertRaises(mc.CaseError):
            mc.update(self.data, 'acme', {}, ['never-created-typo'], root=self.root)
        book = json.loads((self.data / 'cases.json').read_text())
        book['cases'][0]['watchers'] = ['never-created-typo']
        (self.data / 'cases.json').write_text(json.dumps(book))
        event = self.check('2026-10-24T10:00')
        self.assertIn("reply watcher never-created-typo isn't a robob-watch watcher", event)
        self.assertNotIn('removed', event)

    def test_paused_watcher_is_still_running(self):
        self.watcher('host-reply', 'active')
        (self.root / 'watchers' / 'host-reply' / 'watcher.json').write_text(json.dumps({'id': 'host-reply', 'paused': True}))
        self.case(deadline='2026-11-01', watchers=['host-reply'])
        self.assertEqual(self.check('2026-10-24T10:00'), '')

    def sent(self):
        return json.loads((self.wd / 'pings.json').read_text())['sent']

    def test_old_outbox_keys_are_migrated_to_built_without_repeating(self):
        self.case(deadline='2026-10-25')
        (self.wd / 'pings.json').write_text(json.dumps({'sent': {}, 'outbox': {
            'run': 'old', 'keys': ['acme|r0|soon'], 'at': '2026-10-24T09:30:00+04:00', 'fires': 3}}))
        self.assertEqual(self.check('2026-10-24T10:00', 'r1'), '')
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertIn('acme|r0|soon', state['built'])
        self.assertEqual(self.sent(), {})

    def test_unacked_output_is_built_once_and_new_deadlines_can_fire(self):
        self.case(deadline='2026-10-25')
        self.assertTrue(self.check('2026-10-24T10:00', 'r1', ack=False))
        self.assertEqual(self.check('2026-10-24T10:15', 'r2', ack=False), '')
        self.assertEqual(self.check('2026-10-24T10:30', 'r3', ack=False), '')
        self.assertEqual(self.sent(), {})
        mc.update(self.data, 'acme', {'deadline': '2026-10-26'}, source='mail:fixture', because='new date', at=at('2026-10-24T11:00'))
        self.assertIn('acme', self.check('2026-10-25T10:00', 'r4', ack=False))

    def test_unrecorded_output_respects_quiet_hours_and_current_cases(self):
        self.case(deadline='2026-10-25T10:00:00+04:00')
        self.case('bolt', merchant='Bolt Law', deadline='2026-10-25T10:00:00+04:00')
        self.assertIn('bolt', self.check('2026-10-24T22:59', 'r1', ack=False))
        self.assertEqual(self.check('2026-10-24T23:15', 'r2', ack=False), '')
        mc.close(self.data, 'bolt', 'refunded')
        mc.update(self.data, 'acme', {'deadline': '2026-10-30'}, source='mail:fixture', because='owner said Fri', at=at('2026-10-25T07:00'))
        self.assertEqual(self.check('2026-10-25T08:05', 'r3', ack=False), '')
        self.assertEqual(self.sent(), {})

    def test_event_taken_by_a_runner_that_crashed_before_its_ack_is_not_repeated(self):
        self.case(deadline='2026-10-25')
        (self.wd / 'state.json').write_text(json.dumps({'fires': 4}))
        self.assertTrue(self.check('2026-10-24T10:00', 'r1', ack=False))
        # The runner saved its pending event, died before .run-ok, then delivered it after restart.
        self.deliver('2026-10-24T10:10')
        self.assertEqual(self.check('2026-10-24T10:15', 'r2', ack=False), '')
        self.assertIn('acme|r0|soon', self.sent())

    def test_big_batches_stay_under_the_runner_limit_and_the_rest_follow(self):
        for n in range(80):
            self.case(f'case-{n:02d}', merchant=f'Merchant {n:02d} ' + 'x' * 40, deadline='2026-10-25',
                      reference=f'ref-{n:02d}')
        first = self.check('2026-10-24T10:00')
        self.assertLess(len(first), 6000)
        self.assertIn('more need attention; they follow in a later check', first)
        seen = first.count('\n- ')
        rest = ''
        for n in range(1, 10):
            event = self.check(f'2026-10-24T1{n % 10}:01', f'r{n + 1}')
            if not event:
                break
            self.assertLess(len(event), 6000)
            rest += event
        ids = {line.split(':')[0][2:] for line in (first + '\n' + rest).splitlines() if line.startswith('- ')}
        self.assertEqual(len(ids), 80)
        self.assertGreater(seen, 0)

    def test_one_case_with_many_endings_is_split_and_nothing_is_lost(self):
        names = [f'reply-{n:02d}-' + 'w' * 32 for n in range(35)]
        for w in names:
            self.watcher(w, 'active')
        self.case(deadline='2026-11-01', watchers=names, merchant='Acme ' + 'é' * 70)
        for w in names:
            self.watcher(w, 'done', fires=2)
        mentioned, events = set(), []
        # One reminder a case a day, so the overflow of each day follows on the next day.
        for n in range(10):
            event = self.check(f'2026-10-{24 + n:02d}T10:00', f'r{n}')
            if not event:
                break
            events.append(event)
            self.assertLessEqual(mc.units(event), mc.EVENT_LIMIT)
            mentioned |= {w for w in names if f'reply watcher {w} done' in event}
        self.assertGreater(len(events), 1)
        self.assertEqual(mentioned, set(names))
        self.assertEqual(self.check('2026-10-24T20:00', 'r20'), '')

    def test_wide_characters_count_like_the_runner(self):
        for n in range(40):
            self.case(f'case-{n:02d}', merchant='💸' * 40 + f'{n:02d}', deadline='2026-10-25')
        event = self.check('2026-10-24T10:00')
        self.assertLessEqual(mc.units(event), mc.EVENT_LIMIT)
        self.assertGreater(mc.units(event), len(event))

    def test_going_back_to_an_earlier_deadline_or_reopening_pings_again(self):
        self.case(deadline='2026-10-25')
        self.assertTrue(self.check('2026-10-24T10:00', 'r1'))
        mc.update(self.data, 'acme', {'deadline': '2026-10-26'}, source='mail:fixture', because='owner: Mon', at=at('2026-10-24T10:30'))
        self.assertTrue(self.check('2026-10-25T10:00', 'r2'))
        mc.update(self.data, 'acme', {'deadline': '2026-10-25'}, source='mail:fixture', because='owner: back to Sun', at=at('2026-10-24T10:30'))
        # Moving the deadline re-arms the ping, but the day's one reminder already went out at 10:00.
        self.assertEqual(self.check('2026-10-25T11:00', 'r3'), '')
        self.assertIn('OVERDUE', self.check('2026-10-26T09:00', 'r4'))
        mc.close(self.data, 'acme', 'refunded', source='sms:refund')
        mc.reopen(self.data, 'acme', '2026-10-25', 'refund bounced')
        self.assertEqual(self.check('2026-10-26T12:00', 'r5'), '')
        self.assertIn('OVERDUE', self.check('2026-10-27T09:00', 'r6'))

    def test_card_numbers_and_codes_are_refused_and_never_printed(self):
        for bad in (dict(reference='card 4111 1111 1111 1111'), dict(state='OTP 482913 sent'),
                    dict(next_action='use password hunter2x9'), dict(state='password: Abc!2345'),
                    dict(state='OTP code 482913'), dict(state='the PIN is 1234'), dict(why='CVV: 123'),
                    dict(state='verification code was 55-22-11'), dict(state='password: correcthorsebatterystaple'),
                    dict(state='OTP for payment is 482913'), dict(state='OTP is 482 913')):
            with self.subTest(bad=bad), self.assertRaises(mc.CaseError):
                self.case('bad', **bad)
        self.case(reference='order 1234', state='refund asked on card ending 5542')
        book = json.loads((self.data / 'cases.json').read_text())
        book['cases'][0]['reference'] = '4111-1111-1111-1111'
        book['cases'][0]['state'] = 'verification code: 552211'
        (self.data / 'cases.json').write_text(json.dumps(book))
        event = self.check('2026-10-24T10:00')
        self.assertIn('[card number removed]', event)
        self.assertIn('ending 5542', mc.table([dict(mc.load(self.data)['cases'][0], state='card ending 5542')]))
        for text in (event, mc.table(mc.load(self.data)['cases']), mc.brief(mc.load(self.data)['cases'])):
            self.assertNotIn('4111', text)
            self.assertNotIn('552211', text)
        for fine in ('order 1234', 'case 05177237', 'AED 1,234.56', 'card ending 5542', 'pin code sent by post',
                     'password reset asked', 'TM ref 1137040', 'booking #B23827900', 'password is wrong',
                     'PIN sent on 12 Oct', 'OTP sent to phone, order 1234', 'OTP sent to phone order 1234'):
            self.assertEqual(mc.redact(fine), fine)
            mc.check_secret('state', fine)
        self.assertEqual(mc.redact('password: Abc!2345 then wait'), '[secret removed] then wait')
        for text in ('OTP is 482 913', 'OTP for payment is 482913', 'password: correcthorsebatterystaple'):
            self.assertEqual(mc.redact(text), '[secret removed]')

    def test_table_redacts_before_clipping(self):
        self.case(state='refund asked')
        book = json.loads((self.data / 'cases.json').read_text())
        # The card number straddles the 200-character clip of the state field.
        book['cases'][0]['state'] = 'x' * 180 + ' 4111 1111 1111 1111 then more'
        book['cases'][0]['next'] = 'y' * 190 + ' OTP is 482 913'
        (self.data / 'cases.json').write_text(json.dumps(book))
        text = mc.table(mc.load(self.data)['cases'])
        self.assertNotIn('4111', text)
        self.assertNotIn('482', text)
        self.assertIn('[card number remov', text)

    def test_show_and_json_list_redact_a_hand_edited_book(self):
        self.case(reference='order 1234')
        book = json.loads((self.data / 'cases.json').read_text())
        book['cases'][0]['reference'] = '4111 1111 1111 1111'
        book['cases'][0]['history'].append({'at': 'x', 'text': 'OTP 482913'})
        (self.data / 'cases.json').write_text(json.dumps(book))
        for args in (('show', 'acme'), ('list', '--json')):
            out = io.StringIO()
            with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
                self.assertEqual(mc.main(list(args)), 0)
            text = out.getvalue()
            json.loads(text)
            self.assertNotIn('4111', text)
            self.assertNotIn('482913', text)
            self.assertIn('[card number removed]', text)

    def test_case_without_valid_deadline_still_pings(self):
        self.case(deadline='2026-10-25')
        book = json.loads((self.data / 'cases.json').read_text())
        book['cases'][0]['deadline'] = 'soon'
        (self.data / 'cases.json').write_text(json.dumps(book))
        self.assertIn('has no valid deadline', self.check('2026-10-20T10:00'))
        cases = mc.load(self.data)['cases']
        self.assertIn('1 with no deadline', mc.brief(cases, at('2026-10-20T10:00')))
        self.assertIn("'soon' (not a valid deadline)", mc.table(cases))

    def test_old_sent_keys_are_dropped(self):
        (self.wd / 'pings.json').write_text(json.dumps({'sent': {'old|key': '2026-01-01T10:00:00+04:00'}}))
        self.check('2026-10-24T10:00')
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['sent'], {})

    def test_one_shot_pings_of_an_open_case_are_never_repeated(self):
        self.watcher('host-reply', 'active')
        self.case(deadline='2027-06-01', watchers=['host-reply'])
        self.watcher('host-reply', 'done', fires=3)
        self.assertIn('host-reply done', self.check('2026-10-24T10:00'))
        self.case('later', merchant='Later Co', deadline='2027-06-01')
        book = json.loads((self.data / 'cases.json').read_text())
        book['cases'][1]['deadline'] = 'soon'
        (self.data / 'cases.json').write_text(json.dumps(book))
        # The 'later' case is first reminded when its deadline is near, not earlier. The acme watcher ending is
        # still raised once, on this check, as the case is open.
        event = self.check('2026-12-24T13:00', 'r2')
        self.assertIn('acme', event)
        self.assertIn('later', self.check('2027-06-01T10:00', 'r2b'))
        # Months later both keys are past the 60-day prune, but the case is still open on the same cycle.
        self.assertEqual(self.check('2027-03-01T10:00', 'r3'), '')
        self.assertEqual(self.check('2027-05-01T10:00', 'r4'), '')
        sent = self.sent()
        self.assertTrue(any(k.startswith('acme|c0|watcher|host-reply|') for k in sent))
        mc.close(self.data, 'acme', 'refunded', at=at('2027-05-01T11:00'), source='sms:refund')
        self.check('2027-07-15T10:00', 'r5')
        self.assertFalse(any(k.startswith('acme|') for k in self.sent()))

    def test_busy_lock_exits_75_without_output(self):
        env = dict(os.environ, WATCH_DIR=str(self.wd), MONEY_CASES_DIR=str(self.data))
        with (self.wd / 'check.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            r = subprocess.run(['/usr/bin/python3', '-B', str(Path(__file__).with_name('cases.py')), 'check'],
                               env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        self.assertEqual((r.returncode, r.stdout), (75, ''))


class CheckEntry(Base):
    def test_watchdog_is_armed_and_cancelled_on_every_return(self):
        for failure in (None, mc.CaseError('test failure')):
            with self.subTest(failure=failure), tempfile.TemporaryFile(mode='w+') as stderr:
                with patch.dict(os.environ, {'WATCH_DIR': str(self.wd)}), \
                        patch.object(mc, 'LIVE', self.wd), patch.object(mc, 'DATA', self.data), \
                        patch.object(mc, 'run_check', return_value='', side_effect=failure), \
                        redirect_stderr(stderr), patch.object(mc.faulthandler, 'enable') as enable, \
                        patch.object(mc.faulthandler, 'dump_traceback_later') as arm, \
                        patch.object(mc.faulthandler, 'cancel_dump_traceback_later') as cancel:
                    self.assertEqual(mc.main(['check']), 2 if failure else 0)
                    self.assertTrue(stderr.line_buffering)
                    enable.assert_called_once_with(file=stderr)
                    arm.assert_called_once_with(mc.CHECK_BUDGET + 8, exit=True)
                    cancel.assert_called_once_with()

    def test_watchdog_dumps_and_exits_during_a_c_level_hang(self):
        script = Path(__file__).with_name('cases.py')
        code = (f'import ctypes, runpy, time\nns = runpy.run_path({str(script)!r})\n'
                'def hang(*args):\n'
                '    print(time.time(), flush=True)\n'
                '    ctypes.CDLL(None).sleep(3)\n'
                'ns["main"].__globals__["run_check"] = hang\n'
                'raise SystemExit(ns["main"](["check"]))')
        env = {'HOME': str(self.tmp), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8',
               'WATCH_DIR': str(self.wd), 'MONEY_CASES_DIR': str(self.data), 'MONEY_CASES_HARD_STOP': '0.15'}
        done = subprocess.run(['/usr/bin/python3', '-B', '-c', code], env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, start_new_session=True, timeout=5)
        # The watchdog is armed inside main; imports on the checkout mount are outside its budget.
        self.assertLess(time.time() - float(done.stdout.strip()), 1)
        self.assertEqual(done.returncode, 1)
        self.assertIn('Timeout', done.stderr)
        self.assertIn('hang', done.stderr)

    def test_check_runs_in_runner_environment_with_fake_msgs_and_temp_state(self):
        home = self.tmp / 'home'
        home.mkdir()
        helpers = home / '.local/bin'
        helpers.mkdir(parents=True)
        card_status = helpers / 'card-status'
        card_status.write_text('#!/usr/bin/python3\nimport sys\n'
                               'assert sys.argv[1:] == ["merchant", "dead", "--json"]\nprint("[]")\n')
        card_status.chmod(0o700)
        trace = self.tmp / 'msgs-calls'
        now = mc.now_dubai()
        book = {'version': 1, 'questions': []}
        mc.new_question(book, mc.charges.parse(ALERT, BANK), ALERT, now, now)
        mc.write_json(self.data / 'questions.json', book)
        fake = self.tmp / 'msgs'
        fake.write_text('#!/usr/bin/python3\nimport json, sys\n'
                        'assert sys.stdin.read() == ""\n'
                        f'with open({str(trace)!r}, "a") as out: out.write(sys.argv[1] + "\\n")\n'
                        f'row = {{"id": 1, "ts": {now.timestamp()}, "sender": "Acme", "subject": "Acme receipt"}}\n'
                        'print(json.dumps(row) if sys.argv[1] == "search" else "Acme receipt EUR 12.34")\n')
        fake.chmod(0o700)
        runner_path = ':'.join([str(home / '.local/share/robob-watch/helpers'), str(home / '.local/bin'),
                                str(home / '.bun/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
                                '/bin', '/usr/sbin', '/sbin'])
        env = {'HOME': str(home), 'PATH': runner_path, 'LANG': 'en_US.UTF-8', 'WATCH_DIR': str(self.wd),
               'WATCH_ID': 'money-cases', 'MONEY_CASES_DIR': str(self.data),
               'MONEY_CASES_MSGS': str(fake), 'ROBOB_TOOL_LOG_DIR': str(self.tmp / 'runner-logs')}
        started = time.monotonic()
        with ControlServer(threads=[{'threadId': 'a', 'title': 'iMessage test',
                                     'creationSource': 'server', 'origin': 'imessage',
                                     'updatedAt': mc.charges.iso(now)}]) as server:
            env['T3_CONTROL_TOKEN_FILE'] = str(server.credentials)
            done = subprocess.run(['/usr/bin/python3', '-B', str(Path(__file__).with_name('cases.py')), 'check'],
                                  env=env, stdin=subprocess.DEVNULL, start_new_session=True,
                                  capture_output=True, text=True, timeout=5)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertLess(time.monotonic() - started, 5)
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(state['timing']['owner_queries'], 3)
        timing = state['timing']
        expected = {'owner_list_pages': 2, 'owner_threads_selected': 1,
                    'owner_threads_fresh': 0, 'owner_threads_needed': 1,
                    'owner_threads_fetched': 1, 'owner_timeouts': 0, 'owner_cache_size': 1}
        for key, value in expected.items():
            self.assertEqual(timing[key], value, key)
        for key in ('owner_list_ms', 'owner_fetch_ms_max'):
            self.assertGreaterEqual(timing[key], 0)
        self.assertEqual(timing['owner_result'], 'ok')
        self.assertNotIn('I paid', json.dumps(timing))
        self.assertNotIn('iMessage', json.dumps(timing))
        self.assertNotIn('test-secret', json.dumps(timing))

        self.assertEqual(state['timing']['msgs_calls'], 2)
        self.assertEqual(trace.read_text().splitlines(), ['search', 'show'])
        questions = json.loads((self.wd / 'scratch-books/questions.json').read_text())['questions']
        self.assertEqual(questions[0]['status'], 'closed')
        rows = [json.loads(line) for path in (self.tmp / 'runner-logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]
        row, = [row for row in rows if row['name'] == 'check.run']
        self.assertIs(row['ok'], True)
        self.assertEqual(row['props']['fired'], int(bool(done.stdout)))

    def test_check_records_success_after_a_normal_return(self):
        with patch.object(mc, '_run_check', return_value=''), patch.object(mc, 'record_event') as record:
            self.assertEqual(mc.run_check(self.wd, 'normal', self.data, self.root), '')
        record.assert_called_once()
        self.assertEqual(record.call_args.args, ('check.run',))
        self.assertIs(record.call_args.kwargs['ok'], True)

    def test_check_records_failure_and_propagates_the_original_exception(self):
        failure = RuntimeError('fixture check failed')
        with patch.object(mc, '_run_check', side_effect=failure), patch.object(mc, 'record_event') as record:
            with self.assertRaises(RuntimeError) as raised:
                mc.run_check(self.wd, 'failure', self.data, self.root)
        self.assertIs(raised.exception, failure)
        record.assert_called_once()
        self.assertEqual(record.call_args.args, ('check.run',))
        self.assertIs(record.call_args.kwargs['ok'], False)
        self.assertEqual(record.call_args.kwargs['props']['fired'], 0)

    def test_check_records_fired_event_and_success_when_nothing_is_due(self):
        self.case()
        now = at('2026-10-24T10:00')
        with patch.object(mc, 'record_event') as record:
            event = mc.run_check(self.wd, 'due', self.data, self.root, now, finder(), nobody)
            self.assertTrue(event)
            self.assertIs(record.call_args.kwargs['ok'], True)
            self.assertEqual(record.call_args.kwargs['props']['fired'], 1)
            self.assertEqual(mc.run_check(self.wd, 'nothing-new', self.data, self.root, now, finder(), nobody), '')
            self.assertIs(record.call_args.kwargs['ok'], True)
            self.assertEqual(record.call_args.kwargs['props']['fired'], 0)

    def test_check_records_incomplete_follow_up_as_failure(self):
        with patch.object(mc, 'follow', return_value=['fixture lookup error']), \
                patch.object(mc, 'record_event') as record:
            self.assertEqual(mc.run_check(self.wd, 'partial', self.data, self.root,
                                         at('2026-10-24T10:00'), finder(), nobody), '')
        self.assertIs(record.call_args.kwargs['ok'], False)
        self.assertEqual(record.call_args.kwargs['props']['fired'], 0)


class Rules(Base):
    """The 2026-10-25 fixes: deadline guard, one reminder a day, one yes/no, mail+SMS dedupe, released, unmatched."""

    def test_deadline_change_without_a_reason_is_refused_and_changes_nothing(self):
        self.case(deadline='2026-10-25')
        before = mc.load(self.data)['cases'][0]
        with self.assertRaises(mc.CaseError) as err:
            mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, at=at('2026-10-24T10:00'))
        self.assertIn('--source', str(err.exception))
        after = mc.load(self.data)['cases'][0]
        self.assertEqual((after['deadline'], after['rev'], after['history']),
                         (before['deadline'], before['rev'], before['history']))

    def test_deadline_change_with_source_and_because_is_recorded_in_history(self):
        self.case(deadline='2026-10-25')
        c = mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, source='mail:fixture', because='Acme agreed to Wed',
                      at=at('2026-10-24T10:00'))
        self.assertEqual(c['deadline'], '2026-10-28')
        self.assertIn('because: Acme agreed to Wed', c['history'][-1]['text'])
        self.assertIn('deadline: 2026-10-28', c['history'][-1]['text'])

    def test_deadline_change_with_his_reply_id_is_accepted_and_recorded(self):
        self.case(deadline='2026-10-25')
        c = mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, reply='msg-4471', at=at('2026-10-24T10:00'))
        self.assertIn('owner reply msg-4471', c['history'][-1]['text'])

    def test_because_alone_cannot_move_a_deadline_or_any_other_field(self):
        self.case()
        path = self.data / 'cases.json'
        before, stat = path.read_bytes(), path.stat()
        with self.assertRaises(mc.CaseError) as err:
            mc.update(self.data, 'acme', {'state': 'changed', 'deadline': '2026-11-09T20:00'},
                      because='one-reminder rule used up')
        self.assertEqual(str(err.exception), 'deadline changes need --source (mail:, sms:, imessage: or statement:) '
                         'or --reply (his reply id); nothing was changed')
        self.assertEqual((path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns),
                         (before, stat.st_ino, stat.st_mtime_ns))

    def test_sources_are_validated_and_recorded_without_counting_as_an_owner_answer(self):
        self.case()
        for source in ('mail:abc', 'sms:42', 'imessage:msg-1', 'statement:/tmp/statement.txt#12'):
            with self.subTest(source=source):
                c = mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, source=source)
                self.assertEqual(c['history'][-1]['source'], source)
                self.assertIn('source: ' + source, c['history'][-1]['text'])
                self.assertNotIn('owner', c['history'][-1])
        c = mc.update(self.data, 'acme', {}, source='mail:evidence-only')
        self.assertEqual(c['history'][-1]['text'], 'source: mail:evidence-only')

    def test_bad_sources_never_write_or_echo_the_value(self):
        self.case()
        for source in ('web:x', 'mail:', 'sms: ', 'statement:file', 'statement:#1',
                       'statement:file#0', 'statement:file#x', 'mail:password: supersecret',
                       'mail:4242 4242 4242 4242'):
            with self.subTest(source=source):
                before = (self.data / 'cases.json').read_bytes()
                with self.assertRaises(mc.CaseError) as err:
                    mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, source=source)
                if source not in ('mail:', 'sms: '):
                    self.assertNotIn(source, str(err.exception))
                self.assertEqual((self.data / 'cases.json').read_bytes(), before)

    def test_other_field_edits_need_no_reason(self):
        self.case(deadline='2026-10-25')
        c = mc.update(self.data, 'acme', {'state': 'chasing'}, at=at('2026-10-24T10:00'))
        self.assertEqual(c['state'], 'chasing')

    def test_second_reminder_the_same_day_is_suppressed(self):
        self.case(deadline='2026-10-25T18:00:00+04:00')
        self.assertIn('due Sun 25 Oct 18:00', self.check('2026-10-24T18:00', 'r1'))
        # A new ending from a reply watcher the same day is held until the next day.
        self.assertEqual(self.check('2026-10-24T20:00', 'r2'), '')
        self.assertIn('OVERDUE', self.check('2026-10-25T19:00', 'r3'))

    def test_after_two_unanswered_days_exactly_one_yes_no_then_silence(self):
        # Deadline inside the 24h window, so the first reminder is delivered 24 Oct and starts the clock.
        self.case(deadline='2026-10-25', when=at('2026-10-24T09:00'))
        seen = []
        for day in range(24, 32):
            event = self.check(f'2026-10-{day}T10:00', f'r{day}')
            if 'Yes or no' in event:
                seen.append(day)
        self.assertEqual(seen, [26])
        self.assertEqual(len([k for k in json.loads((self.wd / 'pings.json').read_text())['sent']
                              if '|ask|' in k]), 1)

    def test_output_lost_before_runner_acceptance_is_not_emitted_again(self):
        self.case(deadline='2026-10-25')
        self.assertTrue(self.check('2026-10-24T10:00', 'r1', ack=False))
        self.assertEqual(self.check('2026-10-24T10:30', 'r2', ack=False), '')
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(state['sent'], {})
        self.assertIn('acme|r0|soon', state['built'])
        self.assertNotIn('outbox', state)

    def test_a_pending_event_the_runner_owns_is_waited_for_not_rebuilt(self):
        # The runner saved the event as its pending event, so it will deliver it: the check does not rebuild.
        self.case(deadline='2026-10-25')
        event = self.check('2026-10-24T10:00', 'r1', ack=False)
        self.assertTrue(event)
        (self.wd / 'state.json').write_text(json.dumps({'fires': 0, 'pending': {'event': event, 'key': 'k'}}))
        self.assertEqual(self.check('2026-10-24T10:15', 'r2', ack=False), '')
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['outbox']['run'], 'r1')

    def test_a_batched_event_keeps_its_outbox_until_delivery(self):
        self.case(deadline='2026-10-25')
        event = self.check('2026-10-24T10:00', 'r1', ack=False)
        self.assertTrue(event)
        for queued, owned in [([event], True), (['unrelated event'], False), ([event, 'another event'], True)]:
            with self.subTest(queued=queued):
                (self.wd / 'state.json').write_text(json.dumps({'fires': 0, 'batch': {'events': queued}}))
                self.assertEqual(mc.runner_owns(self.wd, {'event': event}), owned)
        (self.wd / 'state.json').write_text(json.dumps({'fires': 0, 'batch': {'events': [event]}}))
        self.assertEqual(self.check('2026-10-24T10:01', 'r2', ack=False), '')
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['outbox']['run'], 'r1')
        self.deliver('2026-10-24T10:03')
        self.assertEqual(self.check('2026-10-24T10:04', 'r3', ack=False), '')
        pings = json.loads((self.wd / 'pings.json').read_text())
        self.assertNotIn('outbox', pings)
        self.assertIn('acme|r0|soon', pings['sent'])

    def test_a_reminder_delivered_two_days_late_counts_from_delivery(self):
        # Built 24 Oct 10:00, but the runner only delivers it on 26 Oct at 10:00 (a retry after an outage).
        self.case(deadline='2026-10-25', when=at('2026-10-24T09:00'))
        self.assertTrue(self.check('2026-10-24T10:00', 'r1', ack=False))
        (self.wd / '.run-ok').write_text('r1')
        self.deliver('2026-10-26T10:00')
        # Delivery day 26 Oct: that is the one reminder for the day, so no second reminder today.
        self.assertNotIn('acme:', self.check('2026-10-26T11:00', 'r2'))
        # The clock starts at delivery (26 Oct), so no yes/no on 27 Oct; it is due 28 Oct, two full days later.
        self.assertNotIn('Yes or no', self.check('2026-10-27T10:00', 'r3'))
        self.assertIn('Yes or no', self.check('2026-10-28T10:00', 'r4'))
        pings = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(pings['clock']['acme']['at'], '2026-10-26T10:00:00+04:00')

    def test_a_future_bill_is_not_asked_before_its_first_reminder(self):
        self.case(merchant='Acme bill', deadline='2026-11-30', when=at('2026-10-24T09:00'))
        for day in range(24, 28):
            self.assertNotIn('Yes or no', self.check(f'2026-10-{day}T10:00', f'q{day}'))

    def test_answering_restarts_the_yes_no_clock(self):
        self.case(deadline='2026-10-25', when=at('2026-10-24T09:00'))
        self.assertIn('due Sun 25 Oct', self.check('2026-10-24T10:00', 'r1'))
        self.assertIn('Yes or no', self.check('2026-10-26T10:00', 'r2'))
        # His reply id is an owner answer: a fresh two-day clock starts from the next delivered reminder.
        mc.update(self.data, 'acme', {'state': 'keep chasing'}, reply='msg-9001', at=at('2026-10-27T09:00'))
        # The answer on 27 Oct restarts the clock from the first reminder after it (28 Oct), so the next
        # yes/no is due 30 Oct, two days later. Nothing is asked in between.
        self.assertNotIn('Yes or no', self.check('2026-10-28T10:00', 'r3'))
        self.assertNotIn('Yes or no', self.check('2026-10-29T10:00', 'r4'))
        self.assertIn('Yes or no', self.check('2026-10-30T10:00', 'r5'))
        self.assertEqual(self.check('2026-10-31T10:00', 'r6'), '')

    def test_reason_only_update_after_the_yes_no_leaves_the_case_quiet(self):
        self.case(deadline='2026-10-25', when=at('2026-10-24T09:00'))
        self.check('2026-10-24T10:00', 'r1')
        self.assertIn('Yes or no', self.check('2026-10-26T10:00', 'r2'))
        # The merchant asked for more time: a process, not him, so the case stays quiet.
        mc.update(self.data, 'acme', {'deadline': '2026-12-15'}, source='mail:fixture', because='merchant requested more time',
                  at=at('2026-10-27T09:00'))
        for day in range(28, 32):
            self.assertNotIn('Yes or no', self.check(f'2026-10-{day}T10:00', f'q{day}'))
        self.assertEqual(self.check('2026-11-20T10:00', 'q-later'), '')

    def test_email_and_sms_of_the_same_charge_count_once(self):
        self.case('boat-mail', merchant='boat.dev', amount='25.00', currency='USD', deadline='2026-11-10',
                  charged='2026-10-25')
        with self.assertRaises(mc.CaseError) as err:
            self.case('boat-sms', merchant='Boat.dev ', amount='25', currency='usd', deadline='2026-11-10',
                      charged='2026-10-25')
        self.assertIn('boat-mail', str(err.exception))
        mc.corroborate(self.data, 'boat-mail', 'boat.dev', '25', 'USD', '2026-10-25', 'charge',
                       'SMS 10:45', at=at('2026-10-25T10:45'))
        book = mc.load(self.data)['cases']
        self.assertEqual([c['id'] for c in book], ['boat-mail'])
        self.assertIn('seen again: SMS 10:45', book[0]['history'][-1]['text'])

    def test_corroborate_refuses_a_different_charge(self):
        self.case('boat-mail', merchant='boat.dev', amount='25.00', currency='USD', deadline='2026-11-10',
                  charged='2026-10-25')
        for args in (dict(amount='26'), dict(charged='2026-10-26'), dict(merchant='Other Co')):
            with self.subTest(args=args), self.assertRaises(mc.CaseError):
                base = dict(merchant='boat.dev', amount='25', currency='USD', charged='2026-10-25')
                base.update(args)
                mc.corroborate(self.data, 'boat-mail', base['merchant'], base['amount'], base['currency'],
                               base['charged'], 'charge', 'SMS', at=at('2026-10-25T10:45'))

    def test_two_real_same_day_charges_of_equal_value_both_stay(self):
        self.case('boat-a', merchant='boat.dev', amount='25.00', currency='USD', deadline='2026-11-10',
                  charged='2026-10-25', reference='invoice 1001')
        with self.assertRaises(mc.CaseError):
            self.case('boat-b', merchant='boat.dev', amount='25.00', currency='USD', deadline='2026-11-10',
                      charged='2026-10-25', reference='invoice 1002')
        mc.add(self.data, 'boat-b', 'boat.dev', '25.00', 'USD', 's', 'n', '2026-11-10', 'A',
               charged='2026-10-25', reference='invoice 1002', distinct=True, at=at('2026-10-25T10:00'))
        self.assertEqual(sorted(c['id'] for c in mc.load(self.data)['cases']), ['boat-a', 'boat-b'])

    def test_cli_repeat_exits_zero_prints_the_existing_case_and_leaves_one(self):
        self.case('boat-mail', merchant='boat.dev', amount='25.00', currency='USD', deadline='2026-11-10',
                  charged='2026-10-25', reference='email 09:13')
        out, err = io.StringIO(), io.StringIO()
        with patch.object(mc, 'DATA', self.data), patch.object(mc, 'WATCH_ROOT', self.root), \
                redirect_stdout(out), redirect_stderr(err):
            code = mc.main(['add', 'boat-sms', '--merchant', 'boat.dev', '--amount', '25', '--currency', 'USD',
                            '--state', 's', '--next', 'n', '--deadline', '2026-11-10', '--who', 'A',
                            '--charged', '2026-10-25', '--reference', 'sms 10:45', '--repeat', 'boat-mail'])
        self.assertEqual((code, err.getvalue()), (0, ''))
        self.assertIn('boat-mail: boat.dev USD 25', out.getvalue())
        self.assertNotIn('boat-sms', out.getvalue())
        self.assertEqual([c['id'] for c in mc.load(self.data)['cases']], ['boat-mail'])
        self.assertIn('seen again', mc.load(self.data)['cases'][0]['history'][-1]['text'])

    def test_a_hold_and_a_charge_of_the_same_amount_stay_apart(self):
        self.case('shop-charge', merchant='Talabat', amount='90.30', currency='AED', deadline='2026-11-05',
                  charged='2026-10-25')
        self.case('shop-hold', merchant='Talabat', amount='90.30', currency='AED', deadline='2026-11-05',
                  charged='2026-10-25', kind='hold')
        self.assertEqual(len(mc.load(self.data)['cases']), 2)

    def test_a_different_amount_or_day_is_a_different_charge(self):
        self.case('boat-a', merchant='boat.dev', amount='25.00', currency='USD', deadline='2026-11-10',
                  charged='2026-10-25')
        self.case('boat-b', merchant='boat.dev', amount='26.00', currency='USD', deadline='2026-11-10',
                  charged='2026-10-25')
        self.case('boat-c', merchant='boat.dev', amount='25.00', currency='USD', deadline='2026-11-10',
                  charged='2026-10-26')
        self.assertEqual(len(mc.load(self.data)['cases']), 3)

    def test_hold_that_drops_off_is_released_not_refunded(self):
        self.case('hold-1', merchant='Talabat', amount='90.30', currency='AED', deadline='2026-11-05',
                  charged='2026-10-25', kind='hold')
        mc.close(self.data, 'hold-1', 'pre-auth dropped off', at=at('2026-10-27T10:00'))
        c = mc.find(mc.load(self.data), 'hold-1')
        self.assertEqual(c['history'][-1]['text'], 'released: pre-auth dropped off')
        self.assertNotIn('refund', c['history'][-1]['text'])

    def test_a_charge_is_closed_as_closed_not_released(self):
        self.case('charge-1', merchant='Shop', amount='10', currency='AED', deadline='2026-11-05')
        mc.close(self.data, 'charge-1', 'refund landed', at=at('2026-10-27T10:00'))
        self.assertEqual(mc.find(mc.load(self.data), 'charge-1')['history'][-1]['text'], 'closed: refund landed')

    def test_unmatched_charge_says_unmatched_and_is_never_named(self):
        c = mc.add(self.data, 'talabat-2792', None, '90.30', 'AED', 'charge seen on 2792', 'ask owner', '2026-11-05',
                   'Abdullah', unmatched=True, charged='2026-10-25', at=at('2026-10-25T10:00'))
        self.assertEqual(c['merchant'], 'unmatched')
        self.assertIn('unmatched', mc.table([c]))
        self.assertNotIn('Talabat', mc.table([c]))

    def test_unmatched_and_merchant_together_are_refused(self):
        with self.assertRaises(mc.CaseError):
            mc.add(self.data, 'x-1', 'Talabat', '90.30', 'AED', 's', 'n', '2026-11-05', 'A', unmatched=True)

    def test_a_merchant_is_required_unless_unmatched(self):
        with self.assertRaises(mc.CaseError):
            mc.add(self.data, 'x-2', None, '90.30', 'AED', 's', 'n', '2026-11-05', 'A')

    def test_unmatched_charges_are_never_treated_as_duplicates(self):
        mc.add(self.data, 'u-1', None, '90.30', 'AED', 's', 'n', '2026-11-05', 'A', unmatched=True,
               charged='2026-10-25', at=at('2026-10-25T10:00'))
        mc.add(self.data, 'u-2', None, '90.30', 'AED', 's', 'n', '2026-11-05', 'A', unmatched=True,
               charged='2026-10-25', at=at('2026-10-25T11:00'))
        self.assertEqual(len(mc.load(self.data)['cases']), 2)


class DueDates(Base):
    def test_add_accepts_deadline_formats_for_due_and_rejects_bad_dates(self):
        for n, value in enumerate(('2026-11-01', '2026-11-01T05:00:00Z',
                                   '2026-11-01T09:00:00+04:00', '2026-11-01T09:00:00')):
            with self.subTest(value=value):
                c = self.case(f'case-{n}', merchant=f'Merchant {n}', due=value)
                self.assertEqual(c['due'], value)
                self.assertIn('due Sun 1 Nov', mc.brief([c], at('2026-10-31T10:00')))
        for value in ('tomorrow', '2026-02-30', ''):
            with self.subTest(value=value), self.assertRaises(mc.CaseError):
                self.case('invalid', merchant='Invalid', due=value)
        self.assertEqual(len(mc.load(self.data)['cases']), 4)

    def test_brief_keeps_real_due_date_after_follow_up_moves(self):
        c = self.case(due='2026-11-01', deadline='2026-11-02', when=at('2026-10-20T09:00'))
        line = mc.brief([c], at('2026-10-31T10:00'))
        self.assertEqual(line, 'Money: 1 open; due: Acme AED 120.50 due Sun 1 Nov (follow-up Mon 2 Nov).')
        # The true due date is overdue even before the follow-up time on 2 Nov.
        self.assertIn('overdue since Sun 1 Nov (follow-up Mon 2 Nov)', mc.brief([c], at('2026-11-02T08:00')))
        self.assertIn('due Sun 1 Nov, follow-up Mon 2 Nov', mc.table([c]))
        c = mc.update(self.data, 'acme', {'deadline': '2026-11-03'}, source='mail:follow-up')
        self.assertEqual(c['due'], '2026-11-01')
        mc.close(self.data, 'acme', 'done')
        c = mc.reopen(self.data, 'acme', '2026-11-04', 'still unpaid')
        self.assertEqual(c['due'], '2026-11-01')

    def test_brief_sorts_and_buckets_by_due_instead_of_follow_up(self):
        early = self.case('early', merchant='Early', due='2026-11-01', deadline='2026-11-10',
                          when=at('2026-10-20T09:00'))
        later = self.case('later', merchant='Later', due='2026-11-02', deadline='2026-10-30',
                          when=at('2026-10-20T09:00'))
        future = self.case('future', merchant='Future', due='2026-11-10', deadline='2026-10-30',
                           when=at('2026-10-31T09:00'))
        line = mc.brief([later, future, early], at('2026-10-31T10:00'))
        self.assertLess(line.index('Early'), line.index('Later'))
        self.assertIn('changed: Future AED 120.50 due Tue 10 Nov (follow-up Fri 30 Oct)', line)
        self.assertNotIn('overdue', line)
        self.assertIn('nothing due in 48h', mc.brief([future], at('2026-11-02T10:00')))

    def test_same_instant_does_not_repeat_follow_up_in_brief(self):
        c = self.case(due='2026-11-01', deadline='2026-11-01T05:00:00Z')
        line = mc.brief([c], at('2026-10-31T10:00'))
        self.assertIn('due Sun 1 Nov', line)
        self.assertNotIn('follow-up', line)

    def test_missing_or_null_due_keeps_legacy_display(self):
        c = self.case(deadline='2026-11-01', when=at('2026-10-20T09:00'))
        self.assertNotIn('due', c)
        for row in (c, dict(c, due=None)):
            with self.subTest(due=row.get('due')):
                self.assertEqual(mc.brief([row], at('2026-10-31T10:00')),
                                 'Money: 1 open; due: Acme AED 120.50 (Sun 1 Nov).')
                self.assertEqual(mc.brief([row], at('2026-11-02T08:00')),
                                 'Money: 1 open; due: Acme AED 120.50 (overdue since Sun 1 Nov).')
                self.assertIn('Acme AED 120.50, by Sun 1 Nov (Abdullah)', mc.table([row]))

    def test_awaiting_answer_and_urgency_stay_visible_with_due(self):
        c = self.case(due='2026-11-01', deadline='2026-11-02')
        for status in ('open', 'awaiting_answer'):
            with self.subTest(status=status):
                row = dict(c, status=status, urgency='overdue', state='OVERDUE bank bill')
                line = mc.brief([row], at('2026-11-02T08:00'))
                self.assertIn('OVERDUE bank bill', line)
                self.assertIn('overdue since Sun 1 Nov (follow-up Mon 2 Nov)', line)
                if status == 'awaiting_answer':
                    self.assertIn('awaiting answer', line)

    def test_due_edits_require_reason_and_failure_changes_nothing(self):
        self.case(due='2026-11-01')
        path = self.data / 'cases.json'
        before, stat = path.read_bytes(), path.stat()
        for proof in ({}, {'because': ' '}, {'source': 'mail:fixture'}):
            with self.subTest(proof=proof), self.assertRaisesRegex(mc.CaseError, '--because or --reply'):
                mc.update(self.data, 'acme', {'due': '2026-11-03', 'state': 'changed'}, **proof)
            self.assertEqual((path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns),
                             (before, stat.st_ino, stat.st_mtime_ns))
        for value in ('tomorrow', '2026-02-30', ''):
            with self.subTest(value=value), self.assertRaises(mc.CaseError):
                mc.update(self.data, 'acme', {'due': value}, because='corrected date')
            self.assertEqual(path.read_bytes(), before)

    def test_due_edits_record_reason_or_reply_without_revising_ping_deadline(self):
        self.case()
        for value, proof in (('2026-11-01', {'because': 'merchant confirmed the due date'}),
                             ('2026-11-02T09:00:00+04:00', {'reply': 'msg-4471'})):
            with self.subTest(value=value):
                c = mc.update(self.data, 'acme', {'due': value}, **proof)
                self.assertEqual((c['due'], c['deadline'], c['rev']), (value, '2026-10-25', 0))
                self.assertIn('due: ' + value, c['history'][-1]['text'])
                self.assertEqual(c['history'][-1].get('owner', False), 'reply' in proof)
        self.assertIn('owner reply msg-4471', c['history'][-1]['text'])
        self.assertIn('because: merchant confirmed the due date', c['history'][-2]['text'])

    def test_due_does_not_reschedule_or_rearm_pings(self):
        self.case(due='2026-11-01', deadline='2026-11-02', kind='hold')
        self.assertEqual(self.check('2026-10-31T10:00'), '')
        self.assertIn('due Mon 2 Nov', self.check('2026-11-01T10:00', 'r2'))
        mc.update(self.data, 'acme', {'due': '2026-10-30'}, because='corrected due date', at=at('2026-11-01T10:30'))
        self.assertEqual(self.check('2026-11-01T11:00', 'r3'), '')
        self.assertIn('OVERDUE since Mon 2 Nov', self.check('2026-11-02T10:00', 'r4'))

    def test_due_does_not_hide_unasked_charges_from_daily_list(self):
        self.case(due='2026-11-01', deadline='2026-11-10', reference='card ending 1111')
        self.assertIn('1 unasked charges older than 24 h', self.check('2026-10-31T10:00'))
        self.assertEqual([c['id'] for c in mc.unasked_candidates(self.data, at('2026-10-31T10:00'))], ['acme'])


class Brief(Base):
    PAN_LENGTHS = ((13, '6'), (14, '2'), (15, '6'), (16, '2'), (17, '6'), (18, '2'), (19, '6'))

    def test_counts_cases_without_valid_deadlines_instead_of_naming_them(self):
        case = self.case()
        for deadline in (None, '', 'soon', '2026-02-30'):
            with self.subTest(deadline=deadline):
                cases = [dict(case, id=f'case-{n}', merchant=f'Merchant {n}', deadline=deadline)
                         for n in range(10)]
                line = mc.brief(cases, at('2026-10-24T10:00'), root=self.root)
                self.assertEqual(line, 'Money: 10 open; 10 with no deadline.')
                for row in cases:
                    self.assertNotIn(row['merchant'], line)
                self.assertNotIn('nothing due in 48h', line)

    def test_due_names_are_capped_in_due_date_order(self):
        case = self.case(when=at('2026-10-20T09:00'))
        cases = [dict(case, merchant=f'Due {n}', deadline=f'2026-10-25T{n:02}:00:00+04:00')
                 for n in range(9)]
        line = mc.brief(list(reversed(cases)), at('2026-10-24T10:00'), root=self.root)
        expected = '; '.join(f'Due {n} AED 120.50 (Sun 25 Oct {n:02}:00)' for n in range(6))
        self.assertEqual(line, f'Money: 9 open; due: {expected}; +3 more.')

    def test_changed_names_are_capped_in_due_date_order(self):
        case = self.case(when=at('2026-10-24T09:00'))
        cases = [dict(case, merchant=f'Changed {n}', deadline=f'2026-11-{n + 1:02}')
                 for n in range(9)]
        line = mc.brief(list(reversed(cases)), at('2026-10-24T10:00'), root=self.root)
        expected = '; '.join(f'Changed {n} AED 120.50' for n in range(6))
        self.assertEqual(line, f'Money: 9 open; changed: {expected}; +3 more.')

    def test_attention_cases_without_deadlines_stay_named(self):
        case = dict(self.case(), deadline=None)
        for fields, expected in (
                ({'status': 'awaiting_answer'}, 'Acme AED 120.50 (awaiting answer)'),
                ({'urgency': 'overdue'}, 'Acme AED 120.50 (refund asked)'),
                ({'kind': 'merchant_card', 'state': 'Bupa still holds cancelled card ••5542'},
                 'Bupa still holds cancelled card ••5542')):
            with self.subTest(fields=fields):
                line = mc.brief([dict(case, **fields)], at('2026-10-24T10:00'), root=self.root)
                self.assertEqual(line, f'Money: 1 open; due: {expected}.')
                self.assertNotIn('with no deadline', line)

    def test_no_deadline_count_follows_due_and_precedes_changed(self):
        case = self.case()
        cases = [case, dict(case, merchant='No deadline', deadline=None),
                 dict(case, merchant='Changed', deadline='2026-11-01')]
        line = mc.brief(cases, at('2026-10-24T10:00'), root=self.root)
        self.assertEqual(line, 'Money: 3 open; due: Acme AED 120.50 (Sun 25 Oct); '
                              '1 with no deadline; changed: Changed AED 120.50.')

    def test_fifty_without_deadlines_and_two_due_fit_one_short_line(self):
        case = self.case(when=at('2026-10-20T09:00'))
        cases = [dict(case, id=f'case-{n}', merchant=f'Merchant {n}', deadline=None)
                 for n in range(50)]
        cases.extend([dict(case, merchant='Due A'), dict(case, merchant='Due B')])
        line = mc.brief(cases, at('2026-10-24T10:00'), root=self.root)
        self.assertEqual(line, 'Money: 52 open; due: Due A AED 120.50 (Sun 25 Oct); '
                              'Due B AED 120.50 (Sun 25 Oct); 50 with no deadline.')
        self.assertEqual(len(line.splitlines()), 1)
        self.assertLess(len(line), 400)

    def test_lists_due_and_changed_only(self):
        self.assertEqual(mc.brief([], at('2026-10-24T08:00')), '')
        self.case('acme', deadline='2026-10-25', when=at('2026-10-20T09:00'))
        self.case('bolt', merchant='Bolt Law', amount='1234.56', currency='GBP', deadline='2026-10-31',
                  when=at('2026-10-23T20:00'))
        self.case('zeta', merchant='Zeta', amount='9000', deadline='2026-11-05', when=at('2026-10-20T09:00'))
        self.case('old', merchant='Old', amount='5', deadline='2026-10-20', when=at('2026-10-10T09:00'))
        mc.close(self.data, 'old', 'done', at=at('2026-10-21T09:00'))
        line = mc.brief(mc.load(self.data)['cases'], at('2026-10-24T08:00'))
        self.assertEqual(line, 'Money: 3 open; due: Acme AED 120.50 (Sun 25 Oct); changed: Bolt Law GBP 1,234.56.')
        early = [c for c in mc.load(self.data)['cases'] if c['id'] in ('acme', 'zeta')]
        self.assertEqual(mc.brief(early, at('2026-10-22T10:00')), 'Money: 2 open; nothing due in 48h.')
        late = mc.brief(mc.load(self.data)['cases'], at('2026-10-26T08:00'))
        self.assertIn('Acme AED 120.50 (overdue since Sun 25 Oct)', late)

    def test_closed_case_names_running_and_paused_watchers_but_not_ended_or_missing(self):
        for name, status in (('live', 'active'), ('paused', 'active'), ('done', 'done'), ('expired', 'expired')):
            self.watcher(name, status)
        (self.root / 'watchers' / 'paused' / 'watcher.json').write_text(json.dumps({'id': 'paused', 'paused': True}))
        self.case(watchers=['live', 'paused', 'done', 'expired'])
        mc.close(self.data, 'acme', 'resolved')
        case = mc.load(self.data)['cases'][0]
        case['watchers'].append('missing')
        line = mc.brief([case], at('2026-10-24T08:00'), root=self.root)
        self.assertEqual(line, 'Money: 0 open; closed but watcher running: acme (live), acme (paused).')
        self.watcher('live', 'done')
        self.watcher('paused', 'expired')
        self.assertEqual(mc.brief([case], root=self.root), '')

    def test_closed_case_watcher_names_are_capped(self):
        names = [f'reply-{n}' for n in range(5)]
        for name in names:
            self.watcher(name, 'active')
        self.case(watchers=names)
        mc.close(self.data, 'acme', 'resolved')
        line = mc.brief(mc.load(self.data)['cases'], root=self.root)
        self.assertIn('closed but watcher running: acme (reply-0), acme (reply-1), acme (reply-2), +2 more', line)
        self.assertNotIn('reply-3', line)
        self.assertNotIn('reply-4', line)

    def test_closed_case_archived_watchers_are_not_running(self):
        for name, status in (('done', 'done'), ('expired', 'expired'), ('removed', 'active')):
            self.watcher(name, status)
        self.case(watchers=['done', 'expired', 'removed'])
        mc.close(self.data, 'acme', 'resolved')
        archive = self.root / 'archive'
        archive.mkdir()
        for name in ('done', 'expired', 'removed'):
            (self.root / 'watchers' / name).rename(archive / f'{name}-1')
        self.assertEqual(mc.brief(mc.load(self.data)['cases'], root=self.root), '')

    def test_new_parts_keep_owner_scope_and_awaiting_answer_cases(self):
        self.watcher('moni-reply', 'active')
        closed = self.case('moni-closed', who='Moni', watchers=['moni-reply'])
        mc.close(self.data, closed['id'], 'resolved')
        self.case('moni-refund', who='Moni', state='refund to 5542', merchant='Moni merchant')
        waiting = self.case('waiting', state='refund to 5542', merchant='Waiting merchant')
        waiting['status'] = 'awaiting_answer'
        cases = [c for c in mc.load(self.data)['cases'] if c['id'] != 'waiting'] + [waiting]
        line = mc.brief(cases, root=self.root, cancelled={'5542'})
        self.assertIn('Money: 1 open;', line)
        self.assertIn('awaiting answer', line)
        self.assertIn('refund to cancelled card 5542: waiting', line)
        self.assertNotIn('moni', line.lower())
        self.assertNotIn('closed but watcher running', line)

    def test_cancelled_card_file_open_refunds_and_credit_only(self):
        path = Path(os.environ['CARD_STATUS_FILE'])
        self.case('refund', state='AED 109 credited to 5542, awaiting refund')
        self.case('credit', next_action='check ENBD 5542', state='waiting', why='CREDIT pending', merchant='Elsewhere')
        self.case('dispute', next_action='keep 5542 account open', state='dispute', merchant='Dispute')
        self.case('longer', next_action='refund to 15542 or 55421', state='waiting', merchant='Other')
        self.case('closed', next_action='refund 5542', merchant='Closed')
        mc.close(self.data, 'closed', 'resolved')
        cases = mc.load(self.data)['cases']
        now = at('2026-10-24T08:00')
        self.assertNotIn('refund to cancelled card', mc.brief(cases, now, root=self.root))
        path.write_text(json.dumps({'5542': {'state': 'ok', 'at': 1}}))
        self.assertNotIn('refund to cancelled card', mc.brief(cases, now, root=self.root))
        path.write_text(json.dumps({'5542': {'state': 'cancelled', 'at': 1}}))
        line = mc.brief(cases, now, root=self.root)
        self.assertIn('refund to cancelled card 5542: refund, ask ENBD where it went', line)
        self.assertIn('refund to cancelled card 5542: credit, ask ENBD where it went', line)
        self.assertNotIn('5542: dispute', line)
        self.assertNotIn('5542: longer', line)
        self.assertNotIn('5542: closed', line)

    def test_cancelled_card_uses_default_file_without_an_override(self):
        self.case(state='refund to 5542')
        cases = mc.load(self.data)['cases']
        path = self.tmp / '.local' / 'state' / 'card-status.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'5542': {'state': 'cancelled', 'at': 1}}))
        for override in (None, ''):
            with self.subTest(override=override), patch.dict(os.environ):
                if override is None:
                    os.environ.pop('CARD_STATUS_FILE', None)
                else:
                    os.environ['CARD_STATUS_FILE'] = override
                self.assertIn('refund to cancelled card 5542: acme', mc.brief(cases, root=self.root))

    def test_refund_card_matching_across_fields_and_digit_boundaries(self):
        case = self.case()
        rows = (
            ('refund 5542', 'wait', '', True),
            ('wait', 'REFUND to **5542', '', True),
            ('wait', 'check ENBD', 'credit to (5542)', True),
            ('CREDIT pending', 'check 5542', '', True),
            ('wait', 'refund to 15542', '', False),
            ('wait', 'refund to 55421', '', False),
            ('dispute 5542', 'wait', '', False),
        )
        for state, next_action, why, expected in rows:
            with self.subTest(state=state, next_action=next_action, why=why):
                line = mc.brief([dict(case, state=state, next=next_action, why=why)],
                                root=self.root, cancelled={'5542'})
                self.assertEqual('refund to cancelled card 5542:' in line, expected)

    def test_cancelled_card_status_unreadable_or_bad_shape_is_ignored(self):
        self.case(state='refund to 5542')
        cases = mc.load(self.data)['cases']
        path = Path(os.environ['CARD_STATUS_FILE'])
        for raw in ('not json', '[]', 'null', '{"5542": null}', '{"not-a-last4": {"state": "cancelled"}}'):
            with self.subTest(raw=raw):
                path.write_text(raw)
                self.assertNotIn('refund to cancelled card', mc.brief(cases, root=self.root))
        path.write_bytes(b'\xff')
        self.assertNotIn('refund to cancelled card', mc.brief(cases, root=self.root))
        with patch.dict(os.environ, {'CARD_STATUS_FILE': str(self.tmp)}):
            self.assertNotIn('refund to cancelled card', mc.brief(cases, root=self.root))
        read_text = Path.read_text
        def read_unless_status(file, *args, **kwargs):
            if file == path:
                raise PermissionError()
            return read_text(file, *args, **kwargs)
        with patch.object(Path, 'read_text', read_unless_status):
            self.assertNotIn('refund to cancelled card', mc.brief(cases, root=self.root))

    def test_cancelled_card_injected_set_is_capped_and_requires_exact_last4(self):
        self.case(state='refund on 5542 and credit on 2342')
        self.case('two', state='refund on 5542', merchant='Two')
        self.case('three', state='refund on 5542', merchant='Three')
        self.case('four', state='refund on 5542', merchant='Four')
        line = mc.brief(mc.load(self.data)['cases'], root=self.root,
                        cancelled={'5542', '2342', '12345542', 'bad'})
        self.assertEqual(line.count('refund to cancelled card'), 3)
        self.assertIn('refund to cancelled card 2342: acme', line)
        self.assertIn('refund to cancelled card 5542: acme', line)
        self.assertIn('refund to cancelled card 5542: two', line)
        self.assertIn('+2 more', line)
        self.assertNotIn('5542: three', line)
        self.assertNotIn('5542: four', line)

    def test_brief_redacts_identifiers_and_does_not_emit_extra_lines(self):
        card_number = '4111' + '1111' * 3
        secret = '482' + '913'
        self.watcher('reply', 'active')
        self.case(watchers=['reply'])
        mc.close(self.data, 'acme', 'resolved')
        closed = mc.load(self.data)['cases'][0]
        closed['id'] = f'{card_number}\nOTP {secret}'
        self.case('refund', state='refund 5542', merchant='Other')
        refund = mc.find(mc.load(self.data), 'refund')
        refund['id'] = f'{card_number}\nOTP {secret}'
        line = mc.brief([closed, refund], root=self.root, cancelled={'5542'})
        self.assertNotIn(card_number, line)
        self.assertNotIn(secret, line)
        self.assertNotIn('\n', line)
        self.assertIn('[card number removed]', line)
        self.assertIn('[secret removed]', line)

    def test_brief_redacts_pan_ids_at_every_supported_length(self):
        for length, checksum in self.PAN_LENGTHS:
            with self.subTest(length=length):
                number = '4' + '0' * (length - 2) + checksum
                self.watcher(number, 'active')
                self.case(number, merchant=f'Length {length}', watchers=[number])
                mc.close(self.data, number, 'resolved')
                closed = mc.find(mc.load(self.data), number)
                refund = dict(closed, status='open', state='refund to 5542', watchers=[])
                line = mc.brief([closed, refund], root=self.root, cancelled={'5542'})
                self.assertFalse(number in line, 'brief leaked a synthetic PAN')
                self.assertEqual(line.count('[card number removed]'), 3)
                self.assertTrue('closed but watcher running:' in line)
                self.assertTrue('refund to cancelled card 5542:' in line)

    def test_pan_redaction_handles_grouping_at_every_supported_length(self):
        for length, checksum in self.PAN_LENGTHS:
            number = '4' + '0' * (length - 2) + checksum
            for form, separator in (('plain', ''), ('spaces', ' '), ('hyphens', '-')):
                with self.subTest(length=length, form=form):
                    grouped = separator.join(number[i:i + 4] for i in range(0, length, 4))
                    output = mc.redact(f'case {grouped}; card ending 5542')
                    self.assertTrue(output == 'case [card number removed]; card ending 5542',
                                    'redaction leaked a synthetic PAN or removed the last-4')

    def test_cli_brief_includes_both_parts(self):
        self.watcher('refund-reply', 'active')
        self.case('resolved', watchers=['refund-reply'])
        mc.close(self.data, 'resolved', 'resolved')
        self.case('pending-refund', state='AED 109 credited to 5542, awaiting refund', merchant='Pending merchant')
        Path(os.environ['CARD_STATUS_FILE']).write_text(json.dumps({'5542': {'state': 'cancelled', 'at': 1}}))
        result = subprocess.run(['/usr/bin/python3', '-B', str(Path(mc.__file__)), 'brief'],
                                env={**os.environ, 'MONEY_CASES_DIR': str(self.data),
                                     'ROBOB_WATCH_ROOT': str(self.root)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertIn('closed but watcher running: resolved (refund-reply)', result.stdout)
        self.assertIn('refund to cancelled card 5542: pending-refund, ask ENBD where it went', result.stdout)


ALERT = 'Purchase of EUR 12.34 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl Cr. Limit is AED 1'
BANK = 'EmiratesNBD'
HISTORY = {'id': 1, 'ts': at('2026-09-01T12:00').timestamp(), 'sender': BANK, 'source': 'imessage', 'from_me': 0,
           'body': 'Purchase of EUR 9.99 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl Cr. Limit'}
RECEIPT = {'id': 2, 'ts': at('2026-10-24T10:47').timestamp(), 'sender': 'Acme <noreply@acme.example>',
           'subject': 'Your Acme order', 'body': 'Thanks for ordering. Total €12.34', 'source': 'email', 'from_me': 0}
DECLINED = ('Transaction of AED 775.01 on your Credit Card ending 1111 at ANTHROPIC* CLAUDE SUB '
            'was declined due to insufficient limit')
PAID = ('Purchase of AED 775.01 with Credit Card ending 1111 at ANTHROPIC* CLAUDE SUB, Amsterdam. '
        'Avl Cr. Limit is AED 1')
REFUND = {'id': 301, 'ts': at('2026-11-06T22:47').timestamp(), 'source': 'email', 'from_me': 0,
          'sender': 'DigiCert Accounts Receivable <ar@digicert.com>',
          'subject': 'RE: Fifth follow-up - final notice before card dispute: Refund request',
          'body': 'we have manually processed the request and initiated refund from our end. '
                  'The amount should be credited back to your card within the next few days.\n'
                  '> If the refund hasn\'t been issued by Tuesday 10 November, I will dispute the charge'}
NO_REFUND = dict(REFUND, id=302, sender='Dean Lewis <Dean.Lewis@digicert.com>',
                 body='I am not able to provide any answers to your questions around the refund, '
                      'as this falls out of my jurisdiction.')


def read(row, deadline=None, **_):
    if row.get('source') == 'email':
        return (f"Account: fixture   Folder: INBOX\nDate: fixture\nFrom: {row.get('sender', '')}\n"
                f"To: owner@example.test\nSubject: {row.get('subject', '')}\nFile: -\n\n{row.get('body', '')}")
    return f"{row.get('subject', '')}\n{row.get('body', '')}"


def finder(*rows):
    """A fake msgs search; charges.py itself keeps rows by time, sender and source."""
    def find(query, since, until=None, source=None, n=20, deadline=None, memo=None, stats=None, all_copies=False):
        return [r for r in rows if source is None or r['source'] == source]
    return find


def nobody(since, until, deadline=None, **kwargs):
    return []


class Questions(Base):
    def setUp(self):
        super().setUp()
        p = patch.object(mc.charges, 'show', read)
        p.start()
        self.addCleanup(p.stop)

    def ask(self, now, find, said=nobody, **kw):
        return mc.ask(self.data, 'Is the Acme charge yours?', ALERT, BANK, at('2026-10-23T23:47'), now=at(now),
                      find=find, said=said, root=self.root, **kw)

    def questions(self):
        return mc.load_questions(self.data)['questions']

    def follow(self, now, find, run='r1'):
        # A delivered event is what counts (the runner's fires and last_fire_at), as in Base.check.
        event = mc.run_check(self.wd, run, self.data, self.root, at(now), find, nobody)
        if event:
            (self.wd / '.run-ok').write_text(run)
            self.deliver(now)
        return event

    def test_paid_after_decline_closes_and_reports_once(self):
        decline = self.screen(DECLINED, BANK, '2026-11-06T23:07', '2026-11-06T23:08', 'imsg:decline')
        mc.triaged(self.data, [(decline['id'], 'imsg:decline', True)], at('2026-11-06T23:08'))
        charge = self.screen(PAID, BANK, '2026-11-06T23:12', '2026-11-06T23:13', 'imsg:charge')
        with mc.Locked(self.data, 'questions') as book:
            mc.settle(mc.find_question(book, charge['id']), 'receipt', 'ask', at('2026-11-06T23:14'))
        self.assertEqual(self.follow('2026-11-06T23:20', finder()), '')
        q = mc.find_question(mc.load_questions(self.data), decline['id'])
        self.assertEqual((q['status'], q['by']), ('closed', 'check'))
        self.assertIn('paid after decline: declined 23:07, charged 23:12', q['outcome'])
        event = self.follow('2026-11-07T08:00', finder(), 'r2')
        self.assertEqual(event.count('explained now:'), 1)
        self.assertEqual(self.follow('2026-11-07T08:15', finder(), 'r3'), '')

    def test_paid_decline_does_not_explain_its_unmatched_charge(self):
        decline = self.screen(DECLINED, BANK, '2026-11-06T23:07', '2026-11-06T23:08', 'imsg:decline')
        mc.triaged(self.data, [(decline['id'], 'imsg:decline', True)], at('2026-11-06T23:08'))
        charge = self.screen(PAID, BANK, '2026-11-06T23:12', '2026-11-06T23:13', 'imsg:charge')
        event = self.follow('2026-11-07T08:00', finder())
        declined = mc.find_question(mc.load_questions(self.data), decline['id'])
        charged = mc.find_question(mc.load_questions(self.data), charge['id'])
        self.assertEqual((declined['status'], declined['by']), ('closed', 'check'))
        self.assertIn('paid after decline', declined['outcome'])
        self.assertEqual(charged['status'], 'open')
        cases = mc.load(self.data)['cases']
        self.assertEqual(len(cases), 1)
        self.assertEqual((cases[0]['id'], cases[0]['merchant']), (charged['case_opened'], mc.UNMATCHED))
        self.assertEqual(event.count('explained now:'), 1)
        self.assertNotIn('explained now:', self.follow('2026-11-07T08:15', finder(), 'r2'))
        self.assertEqual(mc.load(self.data)['cases'], cases)

    def test_decline_only_matches_exact_charge_after_it_within_an_hour(self):
        rows = [
            ('boundary', PAID, '2026-11-07T00:07', True),
            ('late', PAID, '2026-11-07T00:08', False),
            ('same-time', PAID, '2026-11-06T23:07', False),
            ('earlier', PAID, '2026-11-06T23:06', False),
            ('amount', PAID.replace('775.01', '775.02'), '2026-11-06T23:12', False),
            ('currency', PAID.replace('AED 775', 'USD 775'), '2026-11-06T23:12', False),
            ('card', PAID.replace('1111', '2222'), '2026-11-06T23:12', False),
            ('merchant', PAID.replace('ANTHROPIC* CLAUDE SUB', 'OTHER MERCHANT'), '2026-11-06T23:12', False),
        ]
        for label, alert, charged, closes in rows:
            with self.subTest(label=label):
                self.data = self.tmp / label
                decline = self.screen(DECLINED, BANK, '2026-11-06T23:07', '2026-11-06T23:08', 'imsg:decline')
                self.screen(alert, BANK, charged, '2026-11-07T00:10', 'imsg:charge')
                mc.follow(self.data, at('2026-11-07T00:20'), find=finder(), said=nobody)
                q = mc.find_question(mc.load_questions(self.data), decline['id'])
                self.assertEqual(q['status'], 'closed' if closes else 'open')

    def test_paid_decline_closes_only_untouched_linked_cases(self):
        for edited in (False, True):
            with self.subTest(edited=edited):
                self.data = self.tmp / str(edited)
                decline = self.screen(DECLINED, BANK, '2026-11-06T23:07', '2026-11-06T23:08', 'imsg:decline')
                with mc.Locked(self.data, 'questions') as book:
                    cid = mc.case_from(self.data, book['questions'][0], at('2026-11-06T23:09'), 'check')
                if edited:
                    mc.update(self.data, cid, {'state': 'owner working on it'}, at=at('2026-11-06T23:10'))
                self.screen(PAID, BANK, '2026-11-06T23:12', '2026-11-06T23:13', 'imsg:charge')
                mc.follow(self.data, at('2026-11-06T23:20'), find=finder(), said=nobody)
                q = mc.find_question(mc.load_questions(self.data), decline['id'])
                self.assertEqual(q['status'], 'closed')
                self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'open' if edited else 'closed')

    def refund_case(self, **kw):
        return self.case('digicert-refund', merchant='DigiCert', amount='864', currency='USD',
                         deadline=kw.pop('deadline', '2026-11-10'), when=at('2026-11-06T14:25'), **kw)

    def test_refund_mail_holds_dispute_with_sourced_history_and_one_ping(self):
        self.refund_case()
        event = self.follow('2026-11-06T22:50', finder(REFUND))
        case = mc.load(self.data)['cases'][0]
        self.assertEqual(mc.deadline_of(case), at('2026-11-13T22:47'))
        self.assertIn('refund promised', case['state'])
        self.assertTrue(case['next'].startswith('held: watch the card for the credit; then '))
        self.assertEqual(case['refund_mail'], {'id': 301, 'at': mc.stamp(at('2026-11-06T22:47'))})
        self.assertEqual(len(case['history']), 2)
        self.assertIn('because: merchant mail 301 says the refund was processed; dispute step held', case['history'][-1]['text'])
        self.assertEqual(case['history'][-1]['source'], 'mail:301')
        self.assertEqual(event.count('mailed Fri 6 Nov 22:47'), 1)
        self.assertEqual(self.follow('2026-11-06T22:55', finder(REFUND), 'r2'), '')
        self.assertEqual(self.follow('2026-11-07T09:00', finder(REFUND), 'r3'), '')
        self.assertEqual(mc.load(self.data)['cases'][0], case)

    def test_identified_automatic_case_reports_refund_once_without_asking(self):
        for status in ('open', 'awaiting_answer'):
            with self.subTest(status=status):
                self.data = self.tmp / status
                self.wd = self.tmp / ('wd-' + status)
                self.wd.mkdir()
                cid = 'identified-refund'
                self.case(cid, merchant=None, unmatched=True, amount='864', currency='USD',
                          deadline='2026-11-06T14:00', when=at('2026-11-06T14:25'),
                          next_action='owner: which order is this?',
                          alert_at=mc.stamp(at('2026-11-06T12:00')))
                mc.update(self.data, cid, {'merchant': 'DigiCert', 'state': 'refund requested'},
                          source='mail:identified', at=at('2026-11-06T14:26'))
                with mc.Locked(self.data) as book:
                    book['cases'][0]['status'] = status
                before = mc.load(self.data)['cases'][0]
                self.assertFalse(mc.owner_answered(before))
                self.assertEqual(self.follow('2026-11-06T14:30', finder(), 'before'), '')
                event = self.follow('2026-11-06T22:50', finder(REFUND))
                case = mc.load(self.data)['cases'][0]
                self.assertEqual(mc.deadline_of(case), at('2026-11-13T22:47'))
                self.assertEqual(case['refund_mail'], {'id': 301, 'at': mc.stamp(at('2026-11-06T22:47'))})
                self.assertIn('refund promised', case['state'])
                self.assertFalse(mc.owner_answered(case))
                self.assertEqual(event.count('mailed Fri 6 Nov 22:47'), 1)
                self.assertNotIn('which order is this?', event)
                self.assertNotIn(mc.ASK, event)
                key = f'{cid}|refund|301'
                state = json.loads((self.wd / 'pings.json').read_text())
                self.assertEqual(state['outbox']['keys'], [key])
                self.assertEqual(self.follow('2026-11-06T22:55', finder(REFUND), 'r2'), '')
                self.assertEqual(mc.load(self.data)['cases'][0], case)
                clock = {cid: {'answer': mc.answered_at(case).isoformat(),
                               'at': mc.stamp(at('2026-11-06T14:30'))}}
                future = at('2026-11-14T09:00')
                due = mc.attention([case], future, {}, self.root, clock)
                self.assertEqual([k for _, items, _, _ in due for k, _ in items], [key])
                self.assertEqual(due[0][2], '')
                self.assertEqual(mc.attention([case], future, {key}, self.root, clock), [])
                day = f'{cid}|day|2026-11-14'
                self.assertEqual(mc.attention([case], future, {day}, self.root, clock), [])

    def test_refund_mail_never_shortens_deadline_or_changes_unrelated_next(self):
        self.refund_case(deadline='2026-11-20', next_action='watch for the credit')
        self.follow('2026-11-06T22:50', finder(REFUND))
        case = mc.load(self.data)['cases'][0]
        self.assertEqual((case['deadline'], case['rev'], case['next']), ('2026-11-20', 0, 'watch for the credit'))

    def test_refund_mail_still_holds_a_case_awaiting_his_answer(self):
        self.refund_case()
        with mc.Locked(self.data) as book:
            book['cases'][0]['status'] = 'awaiting_answer'
        event = self.follow('2026-11-06T22:50', finder(REFUND))
        case = mc.load(self.data)['cases'][0]
        self.assertEqual((case['status'], mc.deadline_of(case)), ('awaiting_answer', at('2026-11-13T22:47')))
        self.assertIn('mailed Fri 6 Nov 22:47', event)

    def test_refund_lookup_searches_all_accepted_credit_wording(self):
        rows = [
            ('refund', dict(REFUND, body='Your refund was processed.')),
            ('credit', dict(REFUND, subject='Credit confirmation', body='USD 864 was credited back to your card.')),
            ('account', dict(REFUND, subject='Credit confirmation', body='USD 864 was credited back to your account.')),
        ]
        for label, row in rows:
            with self.subTest(label=label):
                self.data = self.tmp / label
                self.refund_case()
                def search(query, since, **kw):
                    text = (row['subject'] + ' ' + row['body']).lower().split()
                    return [row] if any(term in query.split() and term in text for term in ('refund', 'credited')) else []
                mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8, search)
                self.assertEqual(mc.load(self.data)['cases'][0]['refund_mail']['id'], row['id'])

    def test_refund_ping_waits_for_daily_cap_and_survives_key_pruning(self):
        self.refund_case()
        now = at('2026-11-06T22:50')
        case = mc.load(self.data)['cases'][0]
        ask_key = f"digicert-refund|ask|{mc.answered_at(case).isoformat()}"
        mc.write_json(self.wd / 'pings.json', {'sent': {ask_key: mc.stamp(now),
                      'digicert-refund|day|2026-11-06': mc.stamp(now)}})
        self.assertEqual(self.follow('2026-11-06T22:50', finder(REFUND)), '')
        event = self.follow('2026-11-07T09:00', finder(REFUND), 'r2')
        self.assertEqual(event.count('mailed Fri 6 Nov 22:47'), 1)
        self.assertNotIn('mailed', self.follow('2027-02-01T09:00', finder(REFUND), 'r3'))
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertIn('digicert-refund|refund|301', state['built'])

    def test_reopening_does_not_replay_the_previous_refund_mail(self):
        self.refund_case()
        self.follow('2026-11-06T22:50', finder(REFUND))
        mc.close(self.data, 'digicert-refund', 'refund landed', at=at('2026-11-08T10:00'))
        self.follow('2027-02-01T09:00', finder(REFUND), 'r2')
        mc.reopen(self.data, 'digicert-refund', '2027-03-01', 'refund reversed', at=at('2027-02-01T10:00'))
        self.assertNotIn('refund_mail', mc.load(self.data)['cases'][0])
        self.assertNotIn('mailed', self.follow('2027-02-01T11:00', finder(REFUND), 'r3'))

    def test_refund_mail_rejects_quotes_negations_senders_and_old_mail(self):
        rows = [
            ('dean', NO_REFUND),
            ('own', dict(REFUND, from_me=1)),
            ('other', dict(REFUND, sender='Other <ar@other.example>')),
            ('bank', dict(REFUND, sender='Wio DigiCert alert')),
            ('sms', dict(REFUND, source='imessage')),
            ('old', dict(REFUND, ts=at('2026-11-06T14:24').timestamp())),
            ('same-time', dict(REFUND, ts=at('2026-11-06T14:25').timestamp())),
            ('later-edit', REFUND),
        ]
        for marker in ('> ', '-----Original Message-----\n', 'On Fri, 6 Nov someone wrote:\n'):
            rows.append(('quoted-' + str(len(rows)), dict(REFUND, body='No update yet.\n' + marker + 'Refund was issued.')))
        rows.append(('own-negated-quote', dict(REFUND, body="No update yet.\n> If the refund hasn't been issued, I will dispute it.")))
        for negation in ("not", "can't", "cannot", "unable", "won't", "isn't", 'never'):
            rows.append(('negation-' + negation, dict(REFUND, body=f'We are {negation} confirming your refund was processed.')))
        rows.append(('wrapped-negation', dict(REFUND, body='We cannot\nconfirm your refund was issued.')))
        for label, row in rows:
            with self.subTest(label=label):
                self.data = self.tmp / label
                self.wd = self.tmp / ('wd-' + label)
                self.wd.mkdir()
                self.refund_case()
                if label == 'later-edit':
                    mc.update(self.data, 'digicert-refund', {'state': 'already handled'}, at=at('2026-11-07T01:35'))
                before = mc.load(self.data)
                event = self.follow('2026-11-07T09:00', finder(row))
                self.assertEqual(mc.load(self.data), before)
                self.assertNotIn('mailed', event)

    def test_refund_done_wording_and_newest_mail(self):
        forms = ('Refund processed', 'refund has been issued', 'refund was initiated', 'refund is credited',
                 'refund refunded', 'refund sent', 'processed the refund', 'issued your refund',
                 'initiated refund', 'credited back to your card', 'credited back to your account',
                 'We processed the refund. Have you received it?',
                 'Your refund was processed by Example Inc. Have you received it?',
                 'We have initiated refund. Have you received it?',
                 'We confirm that your refund was processed.',
                 'Kindly note that your refund was processed.',
                 'We can confirm that your refund was processed.',
                 'We have initiated refund. The amount should be credited back to your card within a few days.',
                 'Your refund was processed. We will send a confirmation email.',
                 'Your refund was processed by Mr. Smith. Is there anything else we can help with?')
        for i, body in enumerate(forms):
            with self.subTest(body=body):
                self.data = self.tmp / str(i)
                self.refund_case()
                newest = dict(REFUND, id=303, ts=at('2026-11-06T22:48').timestamp(), body=body)
                self.assertEqual(mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8,
                                               finder(REFUND, newest)), [])
                self.assertEqual(mc.load(self.data)['cases'][0]['refund_mail']['id'], 303)

    def test_refund_negation_survives_money_number_and_wrapped_line_formats(self):
        amounts = ('USD 864.00', 'USD 1,864.00', 'USD 864,00', 'USD 1.864,00',
                   'USD 0.50', 'USD 864.5', '$864.00', '864.00 USD', 'USD 864.00\n')
        for i, amount in enumerate(amounts):
            with self.subTest(amount=amount):
                self.data = self.tmp / f'negative-amount-{i}'
                self.refund_case()
                before = mc.load(self.data)
                row = dict(REFUND, body=f'We cannot confirm whether the {amount} refund was processed.')
                mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8, finder(row))
                self.assertEqual(mc.load(self.data), before)

    def test_refund_completion_requires_authored_body_not_mail_headers(self):
        pending = 'Your request is still pending. We will contact you when there is an update.'
        subject = 'RE: Refund processed?'
        rows = [
            ('archive', read(dict(REFUND, subject=subject, body=pending)), False),
            ('header-only', f'Subject: {subject}\n\n{pending}', False),
            ('folded-subject', f'Subject: RE:\n Refund processed?\n\n{pending}', False),
            ('crlf', read(dict(REFUND, subject=subject, body=pending)).replace('\n', '\r\n'), False),
            ('no-body', f'Subject: {subject}', False),
            ('other-header', f'From: Refund processed <ar@digicert.com>\nSubject: Update\n\n{pending}', False),
            ('affirmative-body', read(dict(REFUND, subject=subject, body='Your refund was processed.')), True),
            ('question-body', read(dict(REFUND, subject='Status', body='Was your refund processed?')), False),
            ('bare-body', 'Your refund was processed.', True),
        ]
        for label, shown, matches in rows:
            with self.subTest(label=label):
                self.data = self.tmp / ('header-' + label)
                self.refund_case()
                before = mc.load(self.data)
                mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8, finder(REFUND),
                                read=lambda row, deadline: shown)
                case = mc.load(self.data)['cases'][0]
                if matches:
                    self.assertEqual(case['refund_mail']['id'], REFUND['id'])
                else:
                    self.assertEqual(mc.load(self.data), before)

    def test_refund_questions_with_abbreviations_leave_case_and_notice_unchanged(self):
        bodies = (
            'Was your refund processed by Mr. Smith?',
            'Is your refund processed by Dr. Smith?',
            'Was your refund processed by Mr. I. Smith of Example Inc.?',
            'Did Mr. Smith confirm that your refund was processed?',
            'Could you confirm that Mr. Smith processed the refund?',
            'What shows that your refund was processed by Mr. Smith?',
            'Your refund was processed by Mr. Smith?',
            'Your refund was processed by Mr. Will Smith?',
            'Refund processed by Mr. Smith?',
            'Hello, was your refund processed by Mr. Smith?',
            'Hello,\nWas your refund processed by Mr. Smith?',
            'Please confirm whether your refund was processed by Mr. Smith.',
            'Let us know if your refund was processed by Mr. Smith.',
            'Our agent asks if your refund was processed by Mr. Smith.',
            'We are wondering if your refund was processed by Mr. Smith.',
            'Please advise if your refund was processed by Mr. Smith.',
            'Was your refund processed by Mr. Smith? Have you received it?',
            'Was your refund processed by Mr. Smith. Have you received it?',
            'Have you received it?',
            'Your request is pending. Have you received it?',
        )
        for i, body in enumerate(bodies):
            with self.subTest(row=i):
                self.data = self.tmp / f'question-{i}'
                self.wd = self.tmp / f'question-wd-{i}'
                self.wd.mkdir()
                self.refund_case()
                before = mc.load(self.data)
                event = self.follow('2026-11-06T22:50', finder(dict(REFUND, body=body)))
                self.assertEqual(mc.load(self.data), before)
                self.assertNotIn('mailed', event)

    def test_refund_confirmation_requests_leave_case_and_notice_unchanged(self):
        requests = (
            'Kindly confirm that your refund was processed.',
            'Confirm that your refund was processed.',
            'Please kindly confirm that your refund was processed.',
            'Kindly verify that your refund was processed.',
            'Kindly\nverify that your refund was processed.',
            'Verify that your refund was processed.',
            'Check that your refund was processed.',
            'Dear customer, kindly confirm that your refund was processed.',
            'Dear customer,\nKindly confirm that your refund was processed.',
            'Kindly provide confirmation that your refund was processed.',
            'Send confirmation that your refund was processed.',
            'Share confirmation that your refund was processed.',
            'We ask you to please confirm that your refund was processed.',
            'We ask you to confirm that your refund was processed.',
            'You are requested to verify that your refund was processed.',
            'Please just confirm that your refund was processed.',
            'Kindly urgently confirm that your refund was processed.',
            'Please let us know that your refund was processed.',
            'Please can you confirm that your refund was processed.',
            'Reconfirm that your refund was processed.',
        )
        self.assert_refund_mail_ignored(requests, 'request')

    def test_future_or_conditional_refund_leaves_case_and_notice_unchanged(self):
        bodies = (
            'We will send a confirmation email once your refund is processed.',
            'Once your refund is processed, a confirmation email will follow.',
            'We send a confirmation email when your refund is processed.',
            'After your refund has been issued, you will receive a confirmation email.',
            'If approved, your refund is processed.',
            'Your refund is processed only if the request is approved.',
            'Your refund is processed provided that approval is received.',
            'Your refund is processed provided\nthat approval is received.',
            'Your refund is processed as long as approval is received.',
            'Your refund is processed subject to approval.',
            'We would confirm that your refund was processed.',
            'We may confirm that your refund was processed.',
            'We might confirm that your refund was processed.',
            "We'll ensure that your refund is processed.",
            "We'd confirm that your refund was processed.",
            'We are going to ensure that your refund is processed.',
            'We are about to ensure that your refund is processed.',
            'We can get your refund processed.',
            'We can ensure that your refund is processed.',
            'We are working to ensure that your refund is processed.',
            'We are trying to ensure that your refund is processed.',
            'We are hoping that your refund was processed.',
            'We expect that your refund was processed.',
            'We hope that your refund was processed.',
            'The amount should be credited back to your card within a few days.',
            'The amount will be credited back to your card.',
            'Your refund is processed tomorrow.',
            'Your refund is processed next week.',
            'Your refund is processed next\nweek.',
            'Your refund is processed after approval.',
            'Your refund is processed before the cutoff.',
            'Your refund is processed upon approval.',
            'Your refund is processed once approved.',
            'Your refund is processed when approved.',
        )
        bodies += tuple(f'The amount {tense}credited back to your {destination} {timing}.'
                        for tense in ('is ', 'is being ', '')
                        for destination in ('card', 'account')
                        for timing in ('after approval', 'before the cutoff', 'upon approval',
                                       'once approved', 'when approved'))
        bodies += tuple(f'The amount {tense}credited back to your {destination}{separator}'
                        f'this will happen only {condition}.'
                        for tense in ('is ', 'is being ', '')
                        for destination in ('card', 'account')
                        for separator in ('; ', '.\n')
                        for condition in ('after approval', 'if approval is received'))
        self.assert_refund_mail_ignored(bodies, 'future')

    def test_completed_refund_keeps_past_timing_and_later_credit_estimates(self):
        bodies = (
            'We have initiated refund. The amount should be credited back to your card next week.',
            'We have initiated refund. The amount should be credited back to your card next\nweek.',
            'We have initiated refund. The amount should be credited back to your card tomorrow.',
            'We have initiated refund. The amount should be credited back to your card soon.',
            'Your refund was processed after approval.',
            'Your refund has been processed after approval.',
            'We processed the refund after approval.',
            'Your refund was processed before the cutoff.',
            'Your refund was processed upon approval.',
            'Your refund was processed once approval was received.',
            'Your refund was processed when approval was received.',
        )
        bodies += tuple(f'The amount {tense} credited back to your {destination} {timing}.'
                        for tense in ('was', 'has been')
                        for destination in ('card', 'account')
                        for timing in ('after approval', 'before the cutoff', 'upon approval',
                                       'once approval was received', 'when approval was received'))
        bodies += (
            'Your refund was processed. Confirmation will be sent.',
            'After approval, your refund was processed. Confirmation will be sent.',
            'Your refund was processed. Confirmation is required for our records.',
            'We have initiated refund. The amount should be credited next week. Confirmation will follow.',
            'After approval, confirmation: your refund was processed.',
            'Your refund was processed. Confirmation from your bank that your refund was processed will be sent.',
            'After approval, your refund was processed. Confirmation from your bank is required for our records.',
            'Confirmation: your refund was processed. The amount should be credited next week.',
            'Confirmation: your refund was processed. The amount will have been credited by Friday.',
            'Your refund was processed. Confirmation must be obtained for our records.',
            'Your refund was processed by Will Smith.',
            'After approval, we confirm that your refund was processed.',
            'Once approval was received, we can confirm that we processed the refund.',
            'After approval, kindly note that your refund was processed.',
            'After approval, DigiCert processed the refund.',
            'After approval, the bank processed the refund.',
            'After approval, your USD 864.00 refund was processed.',
            'Once approval was received, the amount was credited back to your account.',
            'After approval, ' + REFUND['body'],
            'Confirmation: we confirm that your refund was processed. The amount should be credited next week.',
            'After approval, confirmation: we can confirm that your refund was processed. The amount will be credited next week.',
            'Your refund was processed. Confirmation needs the bank to verify it for our records.',
            'Confirmation: we confirm that your refund was processed. The amount is expected to be credited next week.',
            'After approval, confirmation: we confirm that your refund was processed. The amount is expected to have been credited by Friday.',
            'Confirmation: we confirm that your refund was processed. The amount is expected to already be credited next week.',
            'Confirmation: we confirm that your refund was processed. The amount is expected to be promptly credited next week.',
            "Confirmation: we confirm that your refund was processed. It'll be credited next week.",
            'Confirmation: we confirm that your refund was processed. It’ll be credited next week.',
        )
        self.assert_refund_mail_holds(bodies, 'completed-timing')

    def test_past_timing_prefixes_preserve_completed_refund_and_one_notice(self):
        prefixes = ('After approval', 'After the approval', 'Upon approval', 'Before the cutoff',
                    'Once approval was received', 'Once approval has been received',
                    'Once approval had been received', 'When approval was received',
                    'Once the approval was received', 'After approval was granted',
                    'Before approval was received')
        completions = ('your refund was processed.', 'we processed the refund.',
                       'the amount was credited back to your card.')
        bodies = tuple(prefix + separator + completion
                       for prefix in prefixes for separator in (', ', ',\n')
                       for completion in completions)
        self.assert_refund_mail_holds(bodies, 'past-prefix')

    def test_unresolved_timing_prefixes_leave_case_and_notice_unchanged(self):
        prefixes = ('After approval is received', 'Once approval is received',
                    'Once approval has to be received', 'When approval is received',
                    'Before approval is received', 'After your refund has been issued')
        completions = ('your refund was processed.', 'we processed the refund.',
                       'the amount was credited back to your card.')
        bodies = tuple(prefix + separator + completion
                       for prefix in prefixes for separator in (', ', ',\n')
                       for completion in completions)
        bodies += tuple(prefix + ', ' + completion
                        for prefix in ('After approval', 'Once approval was received',
                                       'When approval was received')
                        for completion in ('your refund is processed.',
                                           'your refund will be processed.',
                                           'kindly confirm that your refund was processed.',
                                           'was your refund processed by Mr. Smith?'))
        self.assert_refund_mail_ignored(bodies, 'unresolved-prefix')

    def test_past_prefix_cannot_authorize_a_request_for_confirmation(self):
        requests = tuple(f'After approval, please {verb} {recipient} confirmation '
                         'that your refund was processed.'
                         for verb in ('provide', 'send', 'share', 'give')
                         for recipient in ('me', 'us', 'him', 'her', 'them', 'you'))
        requests += (
            'After approval, please provide us with confirmation that your refund was processed.',
            'After approval, please send to us confirmation that your refund was processed.',
            'After approval, please share with us confirmation that your refund was processed.',
            'Once approval was received, kindly send us confirmation that your refund was processed.',
            'When approval was received, send us confirmation that your refund was processed.',
            'After approval,\nplease send\nus confirmation that your refund was processed.',
            'We ask you to please send us confirmation that your refund was processed.',
            'Kindly provide me with confirmation that your refund was processed.',
            'Send us confirmation that your refund was processed.',
            'After approval, please send your bank confirmation that your refund was processed.',
            'After approval, please provide the support team with confirmation that your refund was processed.',
        )
        self.assert_refund_mail_ignored(requests, 'recipient-request')

    def test_nominal_confirmation_requests_leave_case_and_notice_unchanged(self):
        requests = ('we request', 'our team requests', 'we requested', 'we are requesting',
                    'we ask for', 'our team asks for', 'we asked for', 'we are asking for',
                    'we need', 'our team needs', 'we needed', 'we are needing',
                    'we want', 'our team wants', 'we wanted', 'we are wanting',
                    'we require', 'our team requires', 'we required', 'we are requiring',
                    'we seek', 'our team seeks', 'we sought', 'we are seeking')
        bodies = tuple(f'After approval, {request} confirmation that your refund was processed.'
                       for request in requests)
        bodies += tuple(f'After approval, we request {noun} that your refund was processed.'
                        for noun in ('a confirmation', 'the confirmation', 'your confirmation',
                                     'written confirmation', 'a written confirmation'))
        bodies += (
            'Once approval was received, we request confirmation that your refund was processed.',
            'When approval was received, we need confirmation that your refund was processed.',
            'After approval, we request\nconfirmation that your refund was processed.',
            'We request confirmation that your refund was processed.',
            'After approval, we request written confirmations that your refund was processed.',
            'After approval, we ask for a written confirmation that your refund was processed.',
        )
        self.assert_refund_mail_ignored(bodies, 'nominal-request')

    def test_request_complements_leave_case_and_notice_unchanged(self):
        requests = ('you need', 'our team needs', 'we needed', 'we are needing',
                    'we request', 'our team requests', 'we requested', 'we are requesting',
                    'we ask', 'our team asks', 'we asked', 'we are asking',
                    'we want', 'our team wants', 'we wanted', 'we are wanting',
                    'we require', 'our team requires', 'we required', 'we are requiring',
                    'we seek', 'our team seeks', 'we sought', 'we are seeking')
        bodies = tuple(f'After approval, {request} to confirm that your refund was processed.'
                       for request in requests)
        bodies += tuple(f'After approval, you need to {action} that your refund was processed.'
                        for action in ('verify', 'check', 'reconfirm', 'provide confirmation',
                                       'send us confirmation', 'obtain confirmation', 'please confirm'))
        bodies += tuple(f'Once approval was received, we need {person} to confirm '
                        'that your refund was processed.'
                        for person in ('you', 'me', 'us', 'him', 'her', 'them'))
        bodies += tuple(f'After approval, we ask for {person} to confirm '
                        'that your refund was processed.'
                        for person in ('you', 'me', 'us', 'him', 'her', 'them'))
        bodies += tuple(f'After approval, we request that {person} confirm '
                        'that your refund was processed.'
                        for person in ('i', 'we', 'you', 'he', 'she'))
        bodies += tuple(f'After approval, we {verb} {recipient} to confirm '
                        'that your refund was processed.'
                        for verb in ('need', 'request', 'ask', 'want', 'require', 'seek')
                        for recipient in ('the bank', 'your bank', 'the support team',
                                          'the finance department', 'Mr. I. Smith',
                                          'the U.S. IT team', 'DigiCert Accounts Receivable',
                                          'the representative handling your account at the bank'))
        bodies += tuple(f'After approval, we {verb} that {subject} confirm '
                        'that your refund was processed.'
                        for verb in ('need', 'request', 'ask', 'want', 'require', 'seek')
                        for subject in ('the bank', 'your bank', 'the support team',
                                        'the finance department', 'Mr. I. Smith',
                                        'the U.S. IT team', 'DigiCert Accounts Receivable',
                                        'the representative handling your account at the bank'))
        bodies += (
            'After approval, you need\nto confirm that your refund was processed.',
            'When approval was received, you need to confirm that your refund was processed.',
            'You need to confirm that your refund was processed.',
            'After approval, we request that they confirm that your refund was processed.',
            'Once approval was received, we need the bank to verify that your refund was processed.',
            'When approval was received, we need the bank to check that your refund was processed.',
            'We need the bank to confirm that your refund was processed.',
            'After approval, we need the bank\nto confirm that your refund was processed.',
            'After approval, we need\nthe bank to confirm that your refund was processed.',
            'After approval, we need the bank to obtain proof that your refund was processed.',
            'Once approval was received, we request that the bank verify that your refund was processed.',
            'When approval was received, we request that the bank check that your refund was processed.',
            'We request that the bank confirm that your refund was processed.',
            'After approval, we request\nthat the bank confirm that your refund was processed.',
            'After approval, we request that\nthe bank confirm that your refund was processed.',
            'After approval, we request that the bank provide confirmation that your refund was processed.',
        )
        self.assert_refund_mail_ignored(bodies, 'infinitive-request')

    def test_passive_confirmation_requirements_leave_case_and_notice_unchanged(self):
        prefixes = ('', 'After approval, ', 'Once approval was received, ')
        bodies = tuple(f'{prefix}{noun} that your refund was processed is {predicate}.'
                       for prefix in prefixes
                       for noun in ('confirmation', 'a confirmation', 'written confirmation')
                       for predicate in ('required', 'needed', 'requested', 'wanted', 'sought',
                                         'awaited', 'expected', 'necessary', 'mandatory', 'essential'))
        bodies += tuple(f'{prefix}confirmation that your refund was processed {predicate}.'
                        for prefix in prefixes
                        for predicate in ('will be sent', 'should be obtained',
                                          'must be provided', 'can be requested'))
        bodies += tuple(f'{prefix}confirmations that your refund was processed are required.'
                        for prefix in prefixes)
        bodies += (
            'After approval, confirmation\nthat your refund was processed is still required.',
            'After approval, confirmation that your refund was processed\nis required.',
        )
        bodies += tuple(f'After approval, {noun} that your refund was processed is required.'
                        for noun in ('verification', 'proof', 'evidence', 'assurance'))
        bodies += tuple(f'After approval, {noun} {qualifier} that your refund was processed is {predicate}.'
                        for noun in ('confirmation', 'verification', 'proof', 'evidence', 'assurance')
                        for qualifier in ('from your bank', 'from the support team',
                                          'from Mr. I. Smith', 'from the U.S. IT team',
                                          'from DigiCert Accounts Receivable', 'in writing',
                                          'from the representative handling your account at the bank',
                                          'from your\nbank')
                        for predicate in ('required', 'needed'))
        bodies += (
            'Once approval was received, confirmation from your bank that your refund was processed is required.',
            'When approval was received, confirmation from your bank that your refund was processed is required.',
            'Confirmation from your bank that your refund was processed is required.',
            'After approval, confirmation from your bank\nthat your refund was processed is required.',
            'After approval, confirmation from your bank that your refund was processed\nis required.',
        )
        bodies += tuple(re.sub(r'\bthat\s+', '', body, count=1) for body in bodies)
        bodies += (
            'After approval, acknowledgement your refund was processed is required.',
            'Acknowledgement your refund was processed is required.',
            'After approval, confirmation: your refund was processed is required.',
            'Confirmation: your refund was processed is required.',
            'After approval, we need a response confirming your refund was processed.',
            'We need a response confirming your refund was processed.',
            'After approval, it is necessary to confirm that your refund was processed.',
            'It is necessary to confirm that your refund was processed.',
        )
        self.assert_refund_mail_ignored(bodies, 'passive-confirmation')

    def test_labelled_proof_modal_requirements_leave_case_and_notice_unchanged(self):
        modals = ('must', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might')
        bodies = tuple(f'After approval, confirmation: your refund was processed{qualifier} '
                       f'{modal} be {predicate}.'
                       for modal in modals
                       for qualifier in ('', ' by Mr. I. Smith')
                       for predicate in ('obtained from your bank', 'verified by the support team', 'appreciated'))
        bodies += tuple(f'After approval, {noun}: your refund was processed must be obtained from your bank.'
                        for noun in ('verification', 'proof', 'evidence', 'assurance'))
        bodies += tuple(f'After approval, confirmation: your refund was processed {modal} {action}.'
                        for modal in modals
                        for action in ('come from your bank', 'originate at your bank', 'follow',
                                       'help resolve verification', 'require proof'))
        bodies += tuple(f'After approval, confirmation: your refund was processed {request}.'
                        for request in ('needs the bank to verify it', 'requires independent bank verification',
                                        'wants the support team to verify it', 'seeks independent bank verification',
                                        'asks the bank for verification', 'requests independent bank verification'))
        bodies += tuple(f'After approval, confirmation: your refund was processed. '
                        f'{person}{quote}{ending} obtain confirmation from your bank.'
                        for person in ('We', 'I', 'You', 'They', 'He', 'She', 'It')
                        for quote in ("'", '’') for ending in ('ll', 'd'))
        bodies += (
            'Once approval was received, confirmation: your refund was processed must be obtained from your bank.',
            'When approval was received, confirmation: your refund was processed must be obtained from your bank.',
            'Confirmation: your refund was processed must be obtained from your bank.',
            'After approval, confirmation: your refund was processed must\nbe obtained from your bank.',
            'After approval, confirmation: your refund was processed must be\nobtained from your bank.',
            'After approval, confirmation: your refund was processed may have been obtained from your bank.',
            'After approval, confirmation: your refund was processed must urgently be obtained from your bank.',
            'After approval, confirmation: your refund was processed must first be obtained from your bank.',
            'Confirmation: your refund was processed. Confirmation from your bank that your refund was processed will be sent.',
            'After approval, confirmation: your refund was processed has to be obtained from your bank.',
            'After approval, confirmations: your refund was processed have to be obtained from your bank.',
            'After approval, confirmation: your refund was processed had to be obtained from your bank.',
            'After approval, confirmation: your refund was processed ought to be obtained from your bank.',
            'Confirmation: your refund was processed by Will Smith.',
            'Confirmation: your refund was processed by Mr. Will Smith.',
            "Once approval was received, confirmation: your refund was processed. We'll obtain confirmation from your bank.",
            "When approval was received, confirmation: your refund was processed. We'd obtain confirmation from your bank.",
            "Confirmation: your refund was processed. We'll obtain confirmation from your bank.",
            "After approval, confirmation: your refund was processed. We'll\nobtain confirmation from your bank.",
        )
        # Deliberate: a proof-labelled claim plus pending proof is insufficient for a hold.
        self.assert_refund_mail_ignored(bodies, 'proof-modal')

    def test_labelled_refund_pending_proof_leaves_case_and_notice_unchanged(self):
        pending = (
            'We await confirmation from your bank.',
            'Our team awaits confirmation from your bank.',
            'We are awaiting confirmation from your bank.',
            'We awaited confirmation from your bank.',
            'We expect confirmation from your bank.',
            'Our team expects confirmation from your bank.',
            'We are expecting confirmation from your bank.',
            'We hope to obtain confirmation from your bank.',
            'We are hoping to obtain confirmation from your bank.',
            'We plan to obtain confirmation from your bank.',
            'We are planning to obtain confirmation from your bank.',
            'We anticipate confirmation from your bank.',
            'We are anticipating confirmation from your bank.',
            'We intend to obtain confirmation from your bank.',
            'We are intending to obtain confirmation from your bank.',
            'We aim to obtain confirmation from your bank.',
            'We are scheduled to obtain confirmation from your bank.',
            'We are going to obtain confirmation from your bank.',
            'We are about to obtain confirmation from your bank.',
            'We are trying to obtain confirmation from your bank.',
            'We are attempting to obtain confirmation from your bank.',
            'We are working to obtain confirmation from your bank.',
            'We are working on obtaining confirmation from your bank.',
        )
        bodies = tuple(f'{prefix}Confirmation: your refund was processed.{separator}{tail}'
                       for prefix in ('', 'After approval, ', 'Once approval was received, ')
                       for separator in (' ', '\n') for tail in pending)
        # Deliberate: a proof-labelled claim plus pending proof is insufficient for a hold.
        self.assert_refund_mail_ignored(bodies, 'pending-proof')

    def assert_refund_mail_holds(self, bodies, label):
        for i, body in enumerate(bodies):
            with self.subTest(row=i):
                self.data = self.tmp / f'{label}-{i}'
                self.wd = self.tmp / f'{label}-wd-{i}'
                self.wd.mkdir()
                self.refund_case()
                row = dict(REFUND, body=body)
                event = self.follow('2026-11-06T22:50', finder(row))
                case = mc.load(self.data)['cases'][0]
                self.assertEqual(mc.deadline_of(case), at('2026-11-13T22:47'))
                self.assertEqual(case['refund_mail']['id'], row['id'])
                self.assertIn('refund promised', case['state'])
                self.assertEqual(event.count('mailed Fri 6 Nov 22:47'), 1)
                self.assertEqual(self.follow('2026-11-06T22:55', finder(row), 'r2'), '')
                self.assertEqual(mc.load(self.data)['cases'][0], case)

    def assert_refund_mail_ignored(self, bodies, label):
        for i, body in enumerate(bodies):
            with self.subTest(row=i):
                self.data = self.tmp / f'{label}-{i}'
                self.wd = self.tmp / f'{label}-wd-{i}'
                self.wd.mkdir()
                self.refund_case()
                before = mc.load(self.data)
                event = self.follow('2026-11-06T22:50', finder(dict(REFUND, body=body)))
                self.assertEqual(mc.load(self.data), before)
                self.assertNotIn('mailed', event)

    def test_refund_negation_blocks_a_later_affirmation_across_punctuation(self):
        # Deliberate: any negation in the merchant's own text blocks the hold.
        for i, punctuation in enumerate(('.', '!', '?', ';')):
            with self.subTest(punctuation=punctuation):
                self.data = self.tmp / f'positive-sentence-{i}'
                self.refund_case()
                before = mc.load(self.data)
                row = dict(REFUND, body=f'We cannot provide an exact arrival date{punctuation} '
                                       'Your refund was processed.')
                mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8, finder(row))
                self.assertEqual(mc.load(self.data), before)

    def test_refund_negation_survives_abbreviations(self):
        actors = (
            ('company', 'Example Inc.'), ('company-lower', 'Example inc.'),
            ('company-upper', 'EXAMPLE INC.'), ('limited', 'Example Ltd.'),
            ('corporation', 'Example Corp.'), ('company-short', 'Example Co.'),
            ('dotted-company', 'Example L.L.C.'),
            ('country', 'its U.S. team'), ('country-lower', 'its u.s. team'),
            ('country-upper-next', 'its U.S. Operations team'), ('country-uk', 'its U.K. team'),
            ('country-it', 'its U.S. IT team'), ('country-it-operations', 'its U.S. IT Operations team'),
            ('country-uae', 'its U.A.E. team'), ('spaced-initials', 'its U. S. team'),
            ('title', 'Dr. Example'), ('title-mr', 'Mr. Example'), ('title-ms', 'Ms. Example'),
            ('title-initial-i', 'Mr. I. Smith'),
            ('initial', 'J. Example'), ('initials', 'J. R. Example'),
            ('dotted-initials', 'J.R. Example'), ('department', 'its billing dept.'),
            ('example', 'its agent, e.g. Example'), ('clarification', 'its agent, i.e. Example'),
            ('reference', 'the team named in ref. 301'), ('number', 'the team on invoice no. 301'),
            ('wrapped-company', 'Example Inc.\n'),
        )
        for label, actor in actors:
            with self.subTest(label=label):
                self.data = self.tmp / ('abbreviation-' + label)
                self.refund_case()
                before = mc.load(self.data)
                row = dict(REFUND, body=f'We cannot confirm that {actor} processed the refund.')
                mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8, finder(row))
                self.assertEqual(mc.load(self.data), before)

    def test_refund_negation_blocks_a_later_affirmation_after_abbreviation(self):
        # Deliberate: any negation in the merchant's own text blocks the hold.
        for i, statement in enumerate(('Your refund was processed.', 'The refund was issued.',
                                        'We processed the refund.', 'Our refund was initiated.')):
            with self.subTest(statement=statement):
                self.data = self.tmp / f'new-statement-abbreviation-{i}'
                self.refund_case()
                before = mc.load(self.data)
                row = dict(REFUND, body=f'We cannot give an arrival date for Example Inc. {statement}')
                mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8, finder(row))
                self.assertEqual(mc.load(self.data), before)

    def test_refund_negation_after_affirmation_leaves_case_and_ping_unchanged(self):
        self.refund_case()
        before = mc.load(self.data)
        row = dict(REFUND, body='Your refund was processed. We cannot confirm when it will arrive.')
        event = self.follow('2026-11-06T22:50', finder(row))
        self.assertEqual(mc.load(self.data), before)
        self.assertNotIn('mailed', event)

    def test_embedded_questions_after_abbreviations_keep_negation(self):
        for i, clause in enumerate(('when we', 'how our team', 'why our team', 'where our team', 'what team')):
            with self.subTest(clause=clause):
                self.data = self.tmp / f'embedded-question-{i}'
                self.refund_case()
                before = mc.load(self.data)
                row = dict(REFUND, body=f'We cannot confirm, e.g. {clause} processed the refund.')
                mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8, finder(row))
                self.assertEqual(mc.load(self.data), before)

    def test_refund_lookup_cannot_overwrite_concurrent_case_edit(self):
        self.refund_case()
        def edited(row, deadline):
            mc.update(self.data, 'digicert-refund', {'deadline': '2026-11-25'}, source='mail:other',
                      at=at('2026-11-06T22:49'))
            return read(row)
        mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8, finder(REFUND), edited)
        case = mc.load(self.data)['cases'][0]
        self.assertEqual(case['deadline'], '2026-11-25')
        self.assertNotIn('refund_mail', case)

    def test_refund_errors_are_recorded_and_budget_stops_remaining_cases(self):
        self.refund_case()
        for error in (mc.charges.Lookup('archive unavailable'), TimeoutError('read timed out')):
            with self.subTest(error=type(error).__name__):
                with patch.object(mc.charges, 'show', side_effect=error):
                    self.follow('2026-11-06T22:50', finder(REFUND))
                state = json.loads((self.wd / 'pings.json').read_text())
                self.assertIn(str(error), str(state['question_errors']))
        self.case('other')
        with patch.object(mc.time, 'time', return_value=100), patch.object(mc.charges, 'search') as find:
            errors = mc.refund_mails(self.data, at('2026-11-06T22:50'), 99)
        find.assert_not_called()
        self.assertIn('out of time', errors[0])

    def test_refund_lookup_skips_closed_holds_and_unmatched_cases(self):
        self.refund_case(kind='hold')
        self.case('unknown', merchant=None, unmatched=True)
        self.case('closed')
        mc.close(self.data, 'closed', 'done')
        with patch.object(mc.charges, 'search') as find:
            self.assertEqual(mc.refund_mails(self.data, at('2026-11-06T22:50'), time.time() + 8), [])
        find.assert_not_called()

    def test_a_merchant_he_pays_waits_then_two_asks_at_most_then_a_money_case(self):
        known = finder(HISTORY)
        code, msg = self.ask('2026-10-24T00:37', known)
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('wait for the receipt', msg)
        code, msg = self.ask('2026-10-25T12:00', known)
        self.assertEqual(code, 0)
        self.assertIn('ask him now (1 of 2)', msg)
        code, msg = self.ask('2026-10-25T13:00', known)
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('re-ask waits until', msg)
        self.assertEqual(self.ask('2026-10-26T12:00', known)[0], 0)
        code, msg = self.ask('2026-10-26T13:00', known)
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('never a third ask', msg)
        q = self.questions()[0]
        self.assertEqual((q['status'], len(q['asks'])), ('awaiting_answer', 2))
        case = mc.load(self.data)['cases'][0]
        self.assertEqual((case['id'], case['amount'], case['currency'], case['reference']),
                         (q['case'], '12.34', 'EUR', 'card ending 1111'))
        self.assertEqual(self.ask('2026-10-27T09:00', known)[0], mc.DONT_ASK)

    def test_a_receipt_or_his_own_words_mean_no_ask(self):
        code, msg = self.ask('2026-10-24T11:00', finder(RECEIPT))
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('is explained', msg)
        self.assertEqual(self.questions()[0]['by'], 'ask')

        def said(since, until, deadline=None):
            return [('2026-10-23T19:50:00.000Z', 'ordering acme eats now', 'iMessage 2026-10-23 23:40')]
        other = ALERT.replace('12.34', '9.99')
        code, msg = mc.ask(self.data, 'q?', other, BANK, at('2026-10-23T23:47'), now=at('2026-10-24T00:00'),
                           find=finder(), said=said)
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('he wrote about it at 23:50', msg)

    def test_the_check_closes_a_question_once_the_receipt_lands_and_says_so_once(self):
        r = mc.screen(ALERT, BANK, at('2026-10-23T23:47'), at('2026-10-24T00:37'), data=self.data, find=finder(),
                      said=nobody, item='imsg:1')
        self.assertEqual(r['verdict'], 'ask')
        mc.triaged(self.data, [(r['id'], 'imsg:1', True)], at('2026-10-24T00:37'))
        self.assertIsNone(self.follow('2026-10-24T09:00', finder()) or None)
        event = self.follow('2026-10-24T11:00', finder(RECEIPT))
        self.assertIn('explained now: receipt Sat 24 Oct 10:47', event)
        self.assertEqual(self.questions()[0]['status'], 'closed')
        self.assertEqual(self.follow('2026-10-24T11:15', finder(RECEIPT), 'r2'), '')
        again = mc.screen(ALERT, BANK, at('2026-10-23T23:47'), at('2026-10-24T11:20'), data=self.data,
                          find=finder(), said=nobody, item='imsg:1')
        self.assertEqual(again['verdict'], 'explained')

    def test_the_check_keeps_twice_asked_questions_awaiting_in_one_unmatched_case(self):
        self.assertEqual(self.ask('2026-10-24T00:37', finder())[0], 0)
        self.assertEqual(self.ask('2026-10-25T01:00', finder())[0], 0)
        for now in ('2026-10-25T12:00', '2026-10-25T20:30', '2026-11-25T21:00'):
            self.assertEqual(self.follow(now, finder()), '')
            self.assertEqual(self.questions()[0]['status'], 'awaiting_answer')
            self.assertEqual(len(mc.load(self.data)['cases']), 1)
            case = mc.load(self.data)['cases'][0]
            self.assertEqual(case['status'], 'awaiting_answer')
            self.assertEqual(len(case['asks']), 2)
            self.assertEqual(self.questions()[0]['case_opened'], case['id'])

    def test_a_wait_with_no_receipt_is_raised_once(self):
        r = mc.screen(ALERT, BANK, at('2026-10-23T23:47'), at('2026-10-24T00:37'), data=self.data,
                      find=finder(HISTORY), said=nobody, item='imsg:1')
        self.assertEqual(r['verdict'], 'wait')
        self.assertEqual(self.follow('2026-10-25T09:00', finder(HISTORY)), '')
        event = self.follow('2026-10-25T12:00', finder(HISTORY))
        self.assertIn('unasked charges older than 24 h', event)
        self.assertIn('money-cases unasked --ask', event)
        self.assertEqual(self.follow('2026-10-25T12:15', finder(HISTORY), 'r2'), '')

    def screen(self, text, sender, when, now, item):
        return mc.screen(text, sender, at(when), at(now), data=self.data, find=finder(), said=nobody, item=item)

    def test_the_banks_email_copy_of_an_alert_isnt_passed_on_twice(self):
        first = self.screen(ALERT, BANK, '2026-10-23T23:47', '2026-10-24T00:37', 'imsg:1')
        self.assertFalse(self.questions()[0]['passed'])
        mc.triaged(self.data, [(first['id'], 'imsg:1', True)], at('2026-10-24T00:37'))
        copy = self.screen(ALERT, 'alert@emiratesnbd.com', '2026-10-23T23:48', '2026-10-24T00:38', 'mail:icloud:1:9')
        self.assertEqual((first['verdict'], copy['verdict'], copy['id']), ('ask', 'asked', first['id']))
        self.assertEqual(len(self.questions()), 1)
        self.assertIsNone(mc.screen('Your OTP is [code]', BANK, data=self.data))

    def test_two_alerts_on_one_channel_or_a_decline_then_a_charge_are_separate(self):
        a = self.screen(ALERT, BANK, '2026-10-23T23:47', '2026-10-24T00:37', 'imsg:1')
        mc.triaged(self.data, [(a['id'], 'imsg:1', True)], at('2026-10-24T00:37'))
        b = self.screen(ALERT, BANK, '2026-10-23T23:52', '2026-10-24T00:38', 'imsg:2')
        self.assertEqual(b['verdict'], 'ask')
        self.assertNotEqual(a['id'], b['id'])
        decline = 'Transaction of EUR 12.34 on your Card 1111 at ACME EATS was declined due to insufficient limit'
        d = self.screen(decline, BANK, '2026-10-23T23:53', '2026-10-24T00:39', 'imsg:3')
        c = self.screen(ALERT.replace('EATS PENDING', 'EATS'), BANK, '2026-10-23T23:54', '2026-10-24T00:39', 'imsg:4')
        self.assertEqual(len({a['id'], b['id'], d['id'], c['id']}), 4)
        self.assertEqual([q['kind'] for q in self.questions()], ['charge', 'charge', 'decline', 'charge'])
        # The same alert seen again (a re-run, or an ask quoting it) is still one question.
        self.assertEqual(self.screen(ALERT, BANK, '2026-10-23T23:52', '2026-10-24T00:45', 'imsg:2')['id'], b['id'])

    def test_an_alert_triage_left_out_is_closed_and_unasked_ones_stay_in_queue(self):
        a = self.screen(ALERT, BANK, '2026-10-23T23:47', '2026-10-24T00:37', 'imsg:1')
        mc.triaged(self.data, [(a['id'], 'imsg:1', False)], at('2026-10-24T00:37'))
        self.assertEqual((self.questions()[0]['status'], self.questions()[0]['outcome']),
                         ('closed', 'already answered in a chat'))
        # A never-raised charge still joins the daily list after the receipt wait.
        held = self.screen(ALERT.replace('12.34', '5.55'), BANK, '2026-10-23T23:47', '2026-10-23T23:48', 'imsg:2')
        event = self.follow('2026-10-31T09:00', finder())
        q = mc.find_question(mc.load_questions(self.data), held['id'])
        self.assertEqual(q['status'], 'open')
        self.assertEqual(q['case_opened'], mc.load(self.data)['cases'][0]['id'])
        self.assertIn('money-cases unasked --ask', event)

    def test_ask_on_an_open_pending_hold_keeps_the_wait_verdict(self):
        pending = 'Purchase of EUR 12.34 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl Cr. Limit is AED 1'
        at_ = at('2026-10-23T23:47')
        self.assertEqual(mc.ask(self.data, 'Is the Acme charge yours?', pending, BANK, at_, now=at('2026-10-24T00:37'),
                                find=finder(HISTORY), said=nobody, root=self.root)[0], mc.DONT_ASK)
        q = self.questions()[0]
        self.assertTrue(q['pending'])
        code, msg = mc.ask(self.data, 'Is the Acme charge yours?', qid=q['id'], now=at('2026-10-24T00:45'),
                           find=finder(HISTORY), said=nobody, root=self.root)
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('wait for the receipt', msg)

    def test_a_second_decline_after_sms_and_its_email_copy_still_reaches_him(self):
        decline = 'Transaction of AED 120.00 on your Card 1111 at ACME was declined'
        sms = self.screen(decline, BANK, '2026-10-23T23:47', '2026-10-23T23:48', 'imsg:1')
        email = self.screen(decline, 'alerts@emiratesnbd.example', '2026-10-23T23:47', '2026-10-23T23:48', 'mail:1')
        self.assertEqual(email['id'], sms['id'])
        second = self.screen(decline, BANK, '2026-10-23T23:52', '2026-10-23T23:53', 'imsg:2')
        self.assertNotEqual(second['id'], sms['id'])
        self.assertEqual(second['verdict'], 'ask')

    def test_a_receipt_behind_21_usage_notices_is_still_found(self):
        # Real msgs show output: each copy of a notice has its own Date and File headers, so only the
        # words after them are the same. The receipt is the oldest mail in the window.
        aed = 'Purchase of AED 12.34 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl Cr. Limit is AED 1'
        receipt = {'id': 2, 'ts': at('2026-10-23T23:50').timestamp(), 'sender': 'Acme <noreply@acme.example>',
                   'subject': 'Your Acme order', 'source': 'email', 'from_me': 0}
        shown = {2: 'Account: ardud@icloud\nDate: Fri 23 Oct 23:50\nFrom: Acme <noreply@acme.example>\n'
                    'Subject: Your Acme order\nFile: /m/2.emlx\n\nThanks for ordering. Total AED 12.34'}
        notices = []
        for i in range(21):
            nid = 100 + i
            notices.append({'id': nid, 'ts': at('2026-10-23T23:55').timestamp() + i, 'sender': 'Acme <usage@acme.example>',
                            'subject': 'Usage notice', 'source': 'email', 'from_me': 0})
            shown[nid] = (f'Account: ardud@icloud\nDate: Fri 23 Oct 23:5{i % 10}\nFrom: Acme <usage@acme.example>\n'
                          f'Subject: Usage notice\nFile: /m/{nid}.emlx\n\nYour card 1111 was used for AED 12.34 at Acme. Avl limit.')
        reads = []

        def find(query, since, until=None, source=None, n=20, deadline=None, memo=None, stats=None):
            return sorted([receipt] + notices, key=lambda r: -r['ts'])[:n]

        def read(row, deadline=None, **_):
            reads.append(row['id'])
            return shown[row['id']]
        r = mc.charges.receipt(mc.charges.parse(aed, BANK), at('2026-10-24T00:37'), at('2026-10-24T00:45'),
                               find=find, read=read)
        self.assertIsNotNone(r)
        self.assertEqual(r['id'], receipt['id'])

    def test_what_it_stores_is_redacted(self):
        def said(since, until, deadline=None):
            return [('2026-10-23T19:50:00.000Z', 'acme order, card 4111 1111 1111 1111 and OTP is 482913',
                     'iMessage 2026-10-23 23:40')]
        r = mc.screen(ALERT, BANK, at('2026-10-23T23:47'), at('2026-10-24T00:00'), data=self.data, find=finder(),
                      said=said, item='imsg:1')
        self.assertEqual(r['verdict'], 'explained')
        raw = (self.data / 'questions.json').read_text()
        self.assertNotIn('4111 1111', raw)
        self.assertNotIn('482913', raw)
        self.assertIn('[card number removed]', raw)

    def test_a_late_receipt_settles_a_question_that_became_a_case(self):
        self.assertEqual(self.ask('2026-10-24T00:37', finder())[0], 0)
        self.assertEqual(self.ask('2026-10-25T01:00', finder())[0], 0)
        self.assertEqual(self.ask('2026-10-25T02:00', finder())[0], mc.DONT_ASK)
        q = self.questions()[0]
        self.assertEqual(q['status'], 'awaiting_answer')
        event = self.follow('2026-10-25T09:00', finder(dict(RECEIPT, ts=at('2026-10-25T08:00').timestamp())))
        self.assertIn(f"money case {q['case']} closed", event)
        self.assertEqual(mc.find(mc.load(self.data), q['case'])['status'], 'closed')
        self.assertEqual(self.questions()[0]['status'], 'closed')

    def test_his_answer_to_a_case_question_is_noted_on_the_case(self):
        for now in ('2026-10-24T00:37', '2026-10-25T01:00', '2026-10-25T02:00'):
            self.ask(now, finder())
        q = self.questions()[0]
        mc.answered(self.data, q['id'], 'not mine', now=at('2026-10-24T21:00'))
        case = mc.find(mc.load(self.data), q['case'])
        self.assertEqual(case['status'], 'open')
        self.assertIn('not mine', case['history'][-1]['text'])

    def test_follow_up_starts_with_the_least_recently_checked_and_stops_in_time(self):
        for n, amount in enumerate(('1.11', '2.22', '3.33')):
            self.screen(ALERT.replace('12.34', amount), BANK, f'2026-10-23T23:4{n}', '2026-10-24T00:00', f'imsg:{n}')
        book = mc.load_questions(self.data)
        book['questions'][0]['checked'] = '2026-10-24T01:00:00+04:00'
        mc.write_json(self.data / 'questions.json', book)
        order, clock = [], [1000.0]

        def slow(query, since, until=None, source=None, n=20, deadline=None):
            order.append(query.split('"')[1])
            clock[0] += 5
            return []
        with patch.object(mc.time, 'time', lambda: clock[0]):
            errors = mc.follow(self.data, at('2026-10-24T02:00'), self.root, 1012.5, slow, nobody)
        self.assertEqual(order[0], '2.22')
        self.assertNotIn('1.11', order)
        self.assertIn('out of time; the rest next check', errors)

    def test_answered_closes_it(self):
        self.assertEqual(self.ask('2026-10-24T00:37', finder())[0], 0)
        qid = self.questions()[0]['id']
        mc.answered(self.data, qid, 'his order', now=at('2026-10-24T00:40'))
        code, msg = self.ask('2026-10-24T09:00', finder())
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('settled (his order)', msg)


class UnmatchedCharges(Base):
    def setUp(self):
        super().setUp()
        source = patch.object(mc.charges, 'show', read)
        source.start()
        self.addCleanup(source.stop)

    def follow(self, now, find, run='r1'):
        event = mc.run_check(self.wd, run, self.data, self.root, at(now), find, nobody)
        if event:
            (self.wd / '.run-ok').write_text(run)
            self.deliver(now)
        return event

    def seed_charge(self, text=ALERT, when='2026-10-24T08:00', item='imsg:auto'):
        return mc.screen(text, BANK, at(when), at(when), data=self.data,
                         find=finder(), said=nobody, item=item)['id']

    def question(self, qid):
        return mc.find_question(mc.load_questions(self.data), qid)

    def test_alias_receipt_waits_cover_arrival_order_expiry_and_receipt_precedence(self):
        # persisted/new wait x both insertion orders x receipt/no receipt during wait
        for persisted in (False, True):
            for recognized_first in (False, True):
                for receipt_lands in (False, True):
                    with self.subTest(persisted=persisted, recognized_first=recognized_first, receipt=receipt_lands):
                        label = f'{persisted}-{recognized_first}-{receipt_lands}'
                        self.data, self.wd = self.tmp / label, self.tmp / ('wd-' + label)
                        self.wd.mkdir()
                        unknown = ALERT.replace('ACME * EATS PENDING', 'SECONDVENDOR')
                        def recognized():
                            return mc.screen(ALERT, 'alerts@emiratesnbd.com', at('2026-10-24T08:00'),
                                             at('2026-10-24T08:01'), data=self.data, said=nobody, item='mail:known',
                                             find=finder(HISTORY) if persisted else finder())['id']
                        if recognized_first:
                            known, other = recognized(), self.seed_charge(unknown)
                        else:
                            other, known = self.seed_charge(unknown), recognized()
                        self.follow('2026-10-24T11:00', finder(HISTORY))
                        self.assertEqual(mc.load(self.data)['cases'], [])
                        for qid in (other, known):
                            q = self.question(qid)
                            self.assertEqual((q['status'], q['asks']), ('open', []))
                            self.assertEqual(q['wait_until'], '2026-10-25T20:00:00+04:00')
                        self.assertEqual(mc.unasked_candidates(self.data, at('2026-10-25T09:00')), [])
                        mc.unasked(self.data, at('2026-10-25T09:00'), finder(HISTORY), nobody)
                        self.assertTrue(all(not self.question(qid)['asks'] for qid in (other, known)))
                        rows = [HISTORY]
                        if receipt_lands:
                            rows.append(dict(RECEIPT, ts=at('2026-10-25T10:00').timestamp()))
                            self.follow('2026-10-25T11:00', finder(*rows))
                            self.assertEqual([self.question(qid)['status'] for qid in (other, known)], ['closed', 'closed'])
                        else:
                            self.follow('2026-10-25T19:59:59', finder(*rows))
                            self.assertEqual(mc.load(self.data)['cases'], [])
                        self.follow('2026-10-25T20:00', finder(*rows))
                        self.follow('2026-10-25T20:15', finder(*rows))
                        self.assertEqual(len(mc.load(self.data)['cases']), 0 if receipt_lands else 1)

    def test_wait_on_a_different_alert_does_not_block_promotion(self):
        other = self.seed_charge(ALERT.replace('ACME * EATS PENDING', 'SECONDVENDOR'))
        mc.screen(ALERT, 'alerts@emiratesnbd.com', at('2026-10-24T08:00:01'), at('2026-10-24T08:01'),
                  data=self.data, said=nobody, item='mail:known', find=finder(HISTORY))
        self.follow('2026-10-24T11:00', finder(HISTORY))
        self.assertEqual(len(mc.load(self.data)['cases']), 1)
        self.assertIn('case_opened', self.question(other))

    def test_every_charge_entry_point_uses_the_shared_wait_even_before_a_check(self):
        for persisted in (False, True):
            for entry in ('screen', 'ask', 'charge', 'daily'):
                with self.subTest(persisted=persisted, entry=entry):
                    label = str(persisted) + entry
                    self.data, self.wd = self.tmp / label, self.tmp / ('wd-' + label)
                    self.wd.mkdir()
                    unknown = ALERT.replace('ACME * EATS PENDING', 'SECONDVENDOR')
                    other, known = self.seed_charge(unknown), self.seed_charge(item='sms:known')
                    if persisted:
                        with mc.Locked(self.data, 'questions') as book:
                            mc.find_question(book, known)['wait_until'] = '2026-10-25T20:00:00+04:00'
                        self.assertEqual(mc.unasked_candidates(self.data, at('2026-10-25T09:00')), [])
                    if entry == 'screen':
                        result = mc.screen(unknown, BANK, at('2026-10-24T08:00'), at('2026-10-25T09:00'),
                                           data=self.data, find=finder(HISTORY), said=nobody, item='imsg:auto')
                        self.assertEqual(result['verdict'], 'wait')
                    elif entry == 'ask':
                        rc, text = mc.ask(self.data, 'Yours?', qid=other, now=at('2026-10-25T09:00'),
                                          find=finder(HISTORY), said=nobody)
                        self.assertEqual(rc, mc.DONT_ASK)
                        self.assertIn('wait for the receipt', text)
                    elif entry == 'daily':
                        mc.unasked(self.data, at('2026-10-25T09:00'), finder(HISTORY), nobody)
                    else:
                        out = io.StringIO()
                        with patch.object(mc, 'DATA', self.data), patch.object(mc.charges, 'search', finder(HISTORY)), \
                                patch.object(mc.charges, 'owner_texts', nobody), redirect_stdout(out):
                            self.assertEqual(mc.main(['charge', unknown, '--sender', BANK, '--at', '2026-10-24T08:00+04:00',
                                                      '--now', '2026-10-25T09:00+04:00']), 0)
                        self.assertEqual(json.loads(out.getvalue())['verdict'], 'wait')
                    for qid in (other, known):
                        self.assertEqual((self.question(qid)['status'], self.question(qid)['asks']), ('open', []))
                    self.assertEqual(mc.load(self.data)['cases'], [])

    def test_latest_wait_from_closed_alias_wins_until_explained(self):
        other = self.seed_charge(ALERT.replace('ACME * EATS PENDING', 'SECONDVENDOR'))
        early = self.seed_charge(item='sms:early')
        late = self.seed_charge(ALERT.replace('ACME * EATS PENDING', 'THIRDVENDOR'), item='sms:late')
        with mc.Locked(self.data, 'questions') as book:
            mc.find_question(book, early)['wait_until'] = '2026-10-25T20:00:00+04:00'
            q = mc.find_question(book, late)
            q.update(wait_until='2026-10-26T08:00:00+04:00', status='closed', closed='2026-10-24T09:00+04:00')
        self.follow('2026-10-25T21:00', finder())
        self.assertEqual(mc.load(self.data)['cases'], [])
        self.assertEqual(self.question(other)['wait_until'], '2026-10-26T08:00:00+04:00')
        self.assertEqual(self.question(late)['status'], 'closed')
        self.assertEqual(mc.unasked_candidates(self.data, at('2026-10-26T07:59:59')), [])
        self.follow('2026-10-26T08:00', finder())
        self.assertEqual(len(mc.load(self.data)['cases']), 1)

    def test_explanation_overrides_shared_wait_immediately_at_writing_entry_points(self):
        for entry in ('screen', 'ask', 'daily'):
            with self.subTest(entry=entry):
                self.data, self.wd = self.tmp / entry, self.tmp / ('wd-' + entry)
                self.wd.mkdir()
                unknown = ALERT.replace('ACME * EATS PENDING', 'SECONDVENDOR')
                other, known = self.seed_charge(unknown), self.seed_charge(item='sms:known')
                with mc.Locked(self.data, 'questions') as book:
                    mc.find_question(book, known)['wait_until'] = '2026-10-25T20:00:00+04:00'
                receipt = dict(RECEIPT, ts=at('2026-10-25T08:30').timestamp())
                if entry == 'screen':
                    result = mc.screen(unknown, BANK, at('2026-10-24T08:00'), at('2026-10-25T09:00'), data=self.data,
                                       find=finder(HISTORY, receipt), said=nobody, item='imsg:auto')
                    self.assertEqual(result['verdict'], 'explained')
                elif entry == 'ask':
                    self.assertEqual(mc.ask(self.data, 'Yours?', qid=other, now=at('2026-10-25T09:00'),
                                            find=finder(HISTORY, receipt), said=nobody)[0], mc.DONT_ASK)
                else:
                    # A historical wait must not suppress new evidence at the ask gate.
                    with patch.object(mc, 'unasked_candidates', return_value=[dict(self.question(other), type='question')]):
                        mc.unasked(self.data, at('2026-10-25T09:00'), finder(HISTORY, receipt), nobody)
                self.assertEqual([self.question(qid)['status'] for qid in (other, known)], ['closed', 'closed'])
                self.assertTrue(all(not self.question(qid)['asks'] for qid in (other, known)))
                self.assertEqual(mc.load(self.data)['cases'], [])

    def test_two_hours_opens_one_unmatched_case_without_an_ask(self):
        qid = self.seed_charge()
        self.assertEqual(self.follow('2026-10-24T10:00', finder()), '')
        q = self.question(qid)
        case = mc.find(mc.load(self.data), q['case_opened'])
        self.assertEqual((case['merchant'], case['state'], case['next'], case['who']),
                         ('unmatched', 'charge with no matching order or receipt',
                          'owner: which order is this?', 'Abdullah'))
        self.assertEqual((case['amount'], case['currency'], case['charged'], case['deadline']),
                         ('12.34', 'EUR', '2026-10-24', '2026-10-26'))
        self.assertEqual(case['reference'], 'card ending 1111')
        self.assertEqual(case['alert_at'], q['at'])
        self.assertEqual((q['status'], q['asks'], case['asks']), ('open', [], []))
        self.assertEqual(self.follow('2026-10-24T10:15', finder(), 'r2'), '')
        self.assertEqual(len(mc.load(self.data)['cases']), 1)

    def test_wait_receipt_owner_and_unreadable_sources_never_open_a_case(self):
        for evidence in ('wait', 'receipt', 'owner', 'unreadable'):
            with self.subTest(evidence=evidence):
                self.data = self.tmp / evidence
                qid = self.seed_charge()
                found = finder(HISTORY) if evidence == 'wait' else finder(RECEIPT) if evidence == 'receipt' else finder()
                said = nobody
                if evidence == 'owner':
                    said = lambda *a, **kw: [(mc.stamp(at('2026-10-24T08:01')), 'I paid Acme', 'app')]
                if evidence == 'unreadable':
                    def found(*a, **kw):
                        raise mc.charges.Lookup('receipt unavailable')
                mc.run_check(self.wd, evidence, self.data, self.root, at('2026-10-24T11:00'), found, said)
                self.assertEqual(mc.load(self.data)['cases'], [])
                self.assertNotIn('case_opened', self.question(qid))
                if evidence == 'wait':
                    self.assertEqual(self.question(qid)['wait_until'], '2026-10-25T20:00:00+04:00')

    def test_declines_moni_young_and_active_waits_are_unchanged(self):
        decline = 'Transaction of EUR 12.34 on your Card 1111 at ACME was declined'
        for label, text, when, wait in (
                ('decline', decline, '2026-10-24T08:00', None),
                ('moni', ALERT.replace('1111', '2792'), '2026-10-24T08:00', None),
                ('young', ALERT, '2026-10-24T09:01', None),
                ('wait', ALERT, '2026-10-24T08:00', '2026-10-25T20:00:00+04:00')):
            with self.subTest(label=label):
                self.data = self.tmp / label
                qid = self.seed_charge(text, when)
                if wait:
                    with mc.Locked(self.data, 'questions') as book:
                        book['questions'][0]['wait_until'] = wait
                self.follow('2026-10-24T11:00' if label != 'young' else '2026-10-24T11:00:59', finder())
                q = self.question(qid)
                self.assertEqual(mc.load(self.data)['cases'], [])
                self.assertNotIn('case_opened', q)
                self.assertEqual((q['status'], q['asks']), ('open', []))

    def test_daily_list_asks_the_linked_charge_once_without_case_prompts(self):
        qid = self.seed_charge()
        self.follow('2026-10-24T10:00', finder())
        event = self.follow('2026-10-25T09:00', finder())
        self.assertIn('1 unasked charges older than 24 h', event)
        cid = self.question(qid)['case_opened']
        self.assertNotIn(cid, event)
        self.assertEqual([r['id'] for r in mc.unasked_candidates(self.data, at('2026-10-25T09:00'))], [qid])
        text = mc.unasked(self.data, at('2026-10-25T09:00'), finder(), nobody)
        self.assertEqual(text.count(qid + ':'), 1)
        self.assertEqual(mc.unasked(self.data, at('2026-10-25T09:15'), finder(), nobody),
                         'No charges ready to ask about.')
        self.assertEqual(len(self.question(qid)['asks']), 1)
        self.assertEqual(len(mc.find(mc.load(self.data), cid)['asks']), 1)
        self.assertEqual(self.follow('2026-10-27T09:00', finder()), '')
        mc.answered(self.data, qid, 'not my order', now=at('2026-10-27T10:00'))
        self.assertEqual(self.question(qid)['status'], 'closed')
        self.assertTrue(mc.find(mc.load(self.data), cid)['history'][-1]['owner'])

    def test_reply_before_daily_ask_updates_the_parent_and_keeps_follow_up_live(self):
        # question state       reply must reach the same parent, with no first ask
        for status in ('open', 'case', 'awaiting_answer'):
            with self.subTest(status=status):
                self.data, self.wd = self.tmp / status, self.tmp / ('wd-' + status)
                self.wd.mkdir()
                qid = self.seed_charge()
                self.follow('2026-10-24T10:00', finder())
                cid = self.question(qid)['case_opened']
                with mc.Locked(self.data, 'questions') as book:
                    mc.find_question(book, qid)['status'] = status
                mc.answered(self.data, qid, 'not my order', now=at('2026-10-24T10:05'))
                parent = mc.find(mc.load(self.data), cid)
                self.assertEqual(parent.get('answered_cycle'), parent['cycle'])
                self.assertTrue(parent['history'][-1].get('owner'))
                self.assertIn('owner reply ' + qid, parent['history'][-1]['text'])
                self.assertEqual((self.question(qid)['status'], parent['status']), ('closed', 'open'))
                self.assertEqual(parent['asks'], [])
                self.assertEqual(mc.unasked_candidates(self.data, at('2026-10-27T09:00')), [])
                event = self.follow('2026-10-27T09:00', finder())
                self.assertIn(cid, event)
                self.assertIn('OVERDUE', event)

    def test_late_receipt_settles_descriptor_variants_sharing_one_alert_case(self):
        first = self.seed_charge()
        variant = ALERT.replace('ACME * EATS PENDING', 'ACME GROCERY')
        second = mc.screen(variant, 'alerts@emiratesnbd.com', at('2026-10-24T08:00'), at('2026-10-24T08:00'),
                           data=self.data, find=finder(), said=nobody, item='mail:auto')['id']
        self.assertNotEqual(first, second)
        self.follow('2026-10-24T10:00', finder())
        cid = self.question(first)['case_opened']
        self.assertEqual(self.question(second)['case_opened'], cid)
        self.assertEqual(len(mc.load(self.data)['cases']), 1)
        self.follow('2026-10-24T11:00', finder(RECEIPT))
        self.assertEqual([self.question(qid)['status'] for qid in (first, second)], ['closed', 'closed'])
        self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'closed')

    def test_receipt_for_only_one_variant_explains_the_transaction_before_promotion(self):
        # receipt arrival    insertion order       no unmatched case for either descriptor
        for recorded in (False, True):
            for explained_first in (False, True):
                with self.subTest(recorded=recorded, explained_first=explained_first):
                    label = f'{recorded}-{explained_first}'
                    self.data, self.wd = self.tmp / label, self.tmp / ('wd-' + label)
                    self.wd.mkdir()
                    variant = ALERT.replace('ACME * EATS PENDING', 'SECONDVENDOR GROCERY')
                    receipt = dict(RECEIPT, sender='Secondvendor <orders@secondvendor.example>',
                                   subject='Your Secondvendor order', ts=at('2026-10-24T08:30').timestamp())
                    def seed_variant():
                        return mc.screen(variant, 'alerts@emiratesnbd.com', at('2026-10-24T08:00'),
                                         at('2026-10-24T09:00'), data=self.data, said=nobody, item='mail:variant',
                                         find=finder(receipt) if recorded else finder())['id']
                    if explained_first:
                        second, first = seed_variant(), self.seed_charge()
                    else:
                        first, second = self.seed_charge(), seed_variant()
                    self.assertNotEqual(first, second)
                    self.follow('2026-10-24T10:00', finder(receipt))
                    self.assertEqual([self.question(qid)['status'] for qid in (first, second)], ['closed', 'closed'])
                    self.assertEqual(mc.load(self.data)['cases'], [])
                    self.follow('2026-10-24T10:15', finder())
                    self.assertEqual(mc.load(self.data)['cases'], [])
                    self.assertEqual(mc.unasked_candidates(self.data, at('2026-10-25T09:00')), [])

    def test_stored_sibling_evidence_repairs_a_false_case_but_preserves_manual_work(self):
        for worked in (False, True):
            with self.subTest(worked=worked):
                self.data, self.wd = self.tmp / str(worked), self.tmp / ('wd-' + str(worked))
                self.wd.mkdir()
                first = self.seed_charge()
                second = self.seed_charge(ALERT.replace('ACME * EATS PENDING', 'SECONDVENDOR GROCERY'), item='sms:variant')
                result = {'verdict': 'receipt', 'why': 'verified sibling receipt', 'msgs': 2, 'errors': []}
                with mc.Locked(self.data, 'questions') as book:
                    # The old check saved one explanation but promoted its alias independently.
                    mc.explain_question(self.data, mc.find_question(book, second), result, 'triage', at('2026-10-24T09:00'))
                    cid = mc.unmatched_from(self.data, mc.find_question(book, first), at('2026-10-24T10:00'))
                if worked:
                    mc.update(self.data, cid, {}, note='investigating', at=at('2026-10-24T10:05'))
                self.follow('2026-10-24T11:00', finder())
                self.assertEqual(self.question(first)['status'], 'closed')
                self.assertEqual(self.question(first)['explanation']['msgs'], 2)
                self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'open' if worked else 'closed')

    def test_stored_transaction_evidence_is_used_by_each_ask_entry_point(self):
        # evidence kind            consumer       persisted source can be a closed alias
        for verdict in ('receipt', 'owner', 'subscription'):
            for entry in ('screen', 'ask', 'charge', 'daily'):
                with self.subTest(verdict=verdict, entry=entry):
                    label = verdict + entry
                    self.data, self.wd = self.tmp / label, self.tmp / ('wd-' + label)
                    self.wd.mkdir()
                    first = self.seed_charge()
                    second = self.seed_charge(ALERT.replace('ACME * EATS PENDING', 'SECONDVENDOR'), item='sms:alias')
                    evidence = {'verdict': verdict, 'why': 'verified sibling evidence', 'errors': []}
                    with mc.Locked(self.data, 'questions') as book:
                        mc.explain_question(self.data, mc.find_question(book, second), evidence, 'triage', at('2026-10-24T09:00'))
                    if entry == 'screen':
                        result = mc.screen(ALERT, BANK, at('2026-10-24T08:00'), at('2026-10-24T10:00'),
                                           data=self.data, find=finder(), said=nobody, item='imsg:auto')
                        self.assertEqual(result['verdict'], 'explained')
                    elif entry == 'ask':
                        self.assertEqual(mc.ask(self.data, 'Yours?', qid=first, now=at('2026-10-24T10:00'),
                                                find=finder(), said=nobody)[0], mc.DONT_ASK)
                    elif entry == 'daily':
                        mc.unasked(self.data, at('2026-10-25T09:00'), finder(), nobody)
                    else:
                        result = mc.explain_charge(self.data, mc.charge_of(self.question(first)),
                                                   at('2026-10-24T08:00'), at('2026-10-24T10:00'),
                                                   find=finder(), said=nobody, qid=first)
                        self.assertEqual(result['verdict'], verdict)
                    self.follow('2026-10-25T09:15', finder())
                    self.assertEqual(self.question(first)['status'], 'closed')
                    self.assertEqual(self.question(first)['asks'], [])
                    self.assertEqual(mc.load(self.data)['cases'], [])

    def test_shared_purchase_evidence_binds_once_and_never_explains_a_later_charge(self):
        for claimed in (False, True):
            with self.subTest(claimed=claimed):
                self.data, self.wd = self.tmp / str(claimed), self.tmp / ('wd-' + str(claimed))
                self.wd.mkdir()
                first = self.seed_charge()
                alias = self.seed_charge(ALERT.replace('ACME * EATS PENDING', 'ACME GROCERY'), item='sms:alias')
                later = self.seed_charge(when='2026-10-24T08:01', item='sms:later')
                mc.note_purchase(self.data, 'ACME EATS', '12.34', 'EUR', '1111', 'owner', 'thread:purchase',
                                 now=at('2026-10-24T08:00'))
                if claimed:
                    mc.ask(self.data, 'Yours?', qid=first, now=at('2026-10-24T09:00'), find=finder(), said=nobody)
                self.follow('2026-10-24T11:00', finder())
                self.assertEqual([self.question(qid)['status'] for qid in (first, alias)], ['closed', 'closed'])
                self.assertEqual(self.question(later)['status'], 'open')
                self.assertEqual(mc.load(self.data)['purchases'][0]['question'], first)
                self.assertEqual(len(mc.load(self.data)['cases']), 0 if not claimed else 1)

    def test_receipt_competitors_use_alert_identity_across_known_and_new_questions(self):
        charge = mc.charges.parse(ALERT, BANK)
        observed = at('2026-10-24T08:00')
        current = dict(charge, id='q-current', at=mc.stamp(observed))
        # Rival form                     Competes for this receipt?
        forms = (
            ('descriptor', {'merchant': 'ACME GROCERY'}, False),
            ('utc', {'merchant': 'ACME GROCERY', 'at': '2026-10-24T04:00:00Z'}, False),
            ('amount-shape', {'merchant': 'ACME GROCERY', 'amount': '12.3400'}, False),
            ('same-descriptor', {}, True),
            ('other-card', {'card': '2222'}, True),
            ('next-second', {'at': '2026-10-24T08:00:01+04:00'}, True),
            ('next-charge', {'at': '2026-10-24T10:00:00+04:00'}, True),
            ('other-amount', {'amount': '12.35'}, False),
            ('other-currency', {'currency': 'USD'}, False),
            ('decline', {'kind': 'decline'}, False),
        )
        for label, changes, competes in forms:
            for known in (False, True):
                for settled in (False, True):
                    with self.subTest(form=label, known=known, settled=settled):
                        rival = current | dict(id='q-rival', **changes)
                        if settled:
                            rival['explanation'] = {'msgs': RECEIPT['id']}
                        questions = [rival, current] if known else [rival]
                        accepts = mc.receipt_for_question(self.data, charge, 'q-current' if known else None,
                                                         questions, observed)
                        self.assertEqual(accepts(RECEIPT, read(RECEIPT)), not competes)

    def test_shared_alert_receipt_screening_is_consistent_across_entry_points(self):
        variant = ALERT.replace('ACME * EATS PENDING', 'ACME GROCERY')
        for entry in ('screen', 'ask', 'charge', 'daily'):
            with self.subTest(entry=entry):
                self.data, self.wd = self.tmp / entry, self.tmp / ('wd-' + entry)
                self.wd.mkdir()
                first = self.seed_charge()
                if entry != 'screen':
                    self.follow('2026-10-24T10:00', finder())
                receipt = dict(RECEIPT, ts=at('2026-10-24T08:01').timestamp())
                if entry == 'screen':
                    result = mc.screen(variant, 'alerts@emiratesnbd.com', at('2026-10-24T08:00'),
                                       at('2026-10-24T11:00'), data=self.data, find=finder(receipt), said=nobody,
                                       item='mail:variant')
                    self.assertEqual(result['verdict'], 'explained')
                elif entry == 'ask':
                    rc, text = mc.ask(self.data, 'Yours?', text=variant, sender='alerts@emiratesnbd.com',
                                      at=at('2026-10-24T08:00'), now=at('2026-10-24T11:00'),
                                      find=finder(receipt), said=nobody)
                    self.assertEqual(rc, mc.DONT_ASK)
                    self.assertIn('is explained', text)
                elif entry == 'charge':
                    out = io.StringIO()
                    with patch.object(mc, 'DATA', self.data), patch.object(mc.charges, 'search', finder(receipt)), \
                            patch.object(mc.charges, 'owner_texts', nobody), redirect_stdout(out):
                        self.assertEqual(mc.main(['charge', variant, '--sender', 'alerts@emiratesnbd.com',
                                                  '--at', '2026-10-24T08:00+04:00',
                                                  '--now', '2026-10-24T11:00+04:00']), 0)
                    self.assertEqual(json.loads(out.getvalue())['verdict'], 'receipt')
                else:
                    mc.unasked(self.data, at('2026-10-25T09:00'), finder(receipt), nobody)
                    self.assertEqual(self.question(first)['status'], 'closed')
                self.follow('2026-10-25T09:15', finder(receipt))
                self.assertTrue(all(q['status'] == 'closed' and not q['asks']
                                    for q in mc.load_questions(self.data)['questions']))
                self.assertTrue(all(c['status'] == 'closed' for c in mc.load(self.data)['cases']))

    def test_case_write_before_question_write_recovers_without_a_duplicate(self):
        qid = self.seed_charge()
        replace = mc.os.replace
        def interrupted(src, dst):
            replace(src, dst)
            if Path(dst).name == 'cases.json':
                raise mc.CheckTimeout('after saving case')
        with patch.object(mc.os, 'replace', interrupted):
            with self.assertRaises(mc.CheckTimeout):
                mc.follow(self.data, at('2026-10-24T10:00'), self.root, find=finder(), said=nobody)
        self.assertEqual(len(mc.load(self.data)['cases']), 1)
        self.assertNotIn('case_opened', self.question(qid))
        self.follow('2026-10-24T10:15', finder())
        self.assertEqual(len(mc.load(self.data)['cases']), 1)
        self.assertEqual(self.question(qid)['case_opened'], mc.load(self.data)['cases'][0]['id'])

    def test_alert_key_ignores_merchant_and_channel_but_separates_charge_times(self):
        qid = self.seed_charge()
        self.seed_charge(ALERT.replace('ACME * EATS PENDING', 'OTHER'), item='mail:auto')
        self.seed_charge(when='2026-10-24T08:05', item='imsg:second')
        self.follow('2026-10-24T11:00', finder())
        self.assertEqual(len(mc.load(self.data)['cases']), 2)
        qs = mc.load_questions(self.data)['questions']
        self.assertEqual(qs[0]['case_opened'], qs[1]['case_opened'])
        self.assertNotEqual(self.question(qid)['case_opened'], qs[2]['case_opened'])
        candidates = mc.unasked_candidates(self.data, at('2026-10-25T11:00'))
        self.assertEqual(len(candidates), 2)

    def test_alert_key_normalizes_amount_currency_and_time_but_keeps_distinct_charges(self):
        q = dict(card='1111', amount='12.34', currency='EUR', at='2026-10-24T08:00:00+04:00')
        key = mc.unmatched_id(q)
        for changes in (dict(amount='12.3400'), dict(currency='eur'), dict(at='2026-10-24T04:00:00Z'),
                        dict(at='2026-10-24T08:00')):
            with self.subTest(changes=changes):
                self.assertEqual(mc.unmatched_id(q | changes), key)
        for changes in (dict(card='2222'), dict(amount='12.35'), dict(currency='USD'),
                        dict(at='2026-10-24T08:00:01+04:00')):
            with self.subTest(changes=changes):
                self.assertNotEqual(mc.unmatched_id(q | changes), key)

    def test_later_receipt_closes_the_unmatched_case_and_a_reopen_does_not_reuse_its_question(self):
        qid = self.seed_charge()
        self.follow('2026-10-24T10:00', finder())
        cid = self.question(qid)['case_opened']
        self.follow('2026-10-24T11:00', finder(RECEIPT))
        self.assertEqual((self.question(qid)['status'], mc.find(mc.load(self.data), cid)['status']),
                         ('closed', 'closed'))
        mc.reopen(self.data, cid, '2026-11-01', 'check again', at('2026-10-25T09:00'))
        self.follow('2026-10-25T10:00', finder(RECEIPT))
        self.assertEqual(self.question(qid)['case_cycle'], 0)
        self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'open')


class CheckBudget(Base):
    def test_marketplace_limits_are_counted_as_limited(self):
        now = at('2026-11-14T12:00')
        when = now - dt.timedelta(days=3)
        for kind in ('marketplace_hold', 'marketplace_stale'):
            with self.subTest(kind=kind):
                self.data = self.tmp / kind
                self.seed([when])
                with mc.Locked(self.data, 'questions') as book:
                    book['questions'][0].update(merchant='noon', mkey='noon')
                result = {'orders': [], 'complete': True, 'lanes': {
                    name: {'exhaustive': True} for name in mc.charges.order_lookup.LANES}}
                result['lanes']['marketplace'].update(
                    walked_at=(when if kind == 'marketplace_stale' else now).isoformat(),
                    hold_times=[when.isoformat()] if kind == 'marketplace_hold' else [])
                stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
                with patch.object(mc.charges.order_lookup, 'read', return_value=result):
                    mc.follow(self.data, now, self.root, find=finder(), said=nobody, stats=stats)
                self.assertEqual(stats['charge_census']['noon'][kind], 1)
                self.assertEqual(stats['charge_census']['noon']['limited'], 1)
                self.assertEqual(stats['charge_census']['noon']['error'], 0)

    def test_detached_refresh_runs_after_logging_without_affecting_check_duration(self):
        import marketplace
        from state_json import write_json
        self.case()
        with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}), \
                patch.object(marketplace.subprocess, 'Popen') as launch, \
                patch.object(mc, 'record_event') as log:
            self.check('2026-10-24T09:00')
            launch.assert_called_once()
            self.assertTrue(launch.call_args.kwargs['start_new_session'])
            self.assertEqual(launch.call_args.kwargs['stdout'], subprocess.DEVNULL)
            self.assertEqual(launch.call_args.kwargs['stderr'], subprocess.DEVNULL)
            event = next(c for c in log.call_args_list if c.args[0] == 'check.run')
            self.assertEqual(event.kwargs['props']['marketplace_refresh'], 'started')
            launch.reset_mock()
            write_json(self.data / 'marketplace-placements.json', dict(marketplace.empty(),
                walked_at=dt.datetime.now(dt.timezone.utc).isoformat()))
            self.check('2026-10-24T09:00')
            launch.assert_not_called()
            write_json(self.data / 'marketplace-placements.json', marketplace.empty())
            with (self.data / 'marketplace-refresh.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                self.check('2026-10-24T09:00')
            launch.assert_not_called()

    def test_follow_redacts_repeated_text_once_without_batching_cursor_commits(self):
        from collections import Counter
        now = at('2026-10-25T12:00')
        for count in (1, 8, 32):
            with self.subTest(questions=count):
                self.data = self.tmp / str(count)
                self.seed([now - dt.timedelta(days=3, hours=n) for n in range(count)])
                result = {'verdict': 'unverified', 'why': 'fixture unavailable', 'errors': ['fixture unavailable']}
                visited = []

                def source(charge, when, *args, **kwargs):
                    # The cursor must already be durable before the external lookup.
                    saved = mc.load_questions(self.data)
                    visited.append(saved['follow_cursor']['id'])
                    self.assertEqual(mc.parse_time(saved['follow_cursor']['at']), when)
                    return result

                stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
                with patch.object(mc.charges, 'explain', source), \
                        patch.object(mc, 'write_json', wraps=mc.write_json) as write, \
                        patch.object(mc, 'redact', wraps=mc.redact) as redact:
                    with mc.follow_timing(stats):
                        mc.follow(self.data, now, self.root, find=finder(), said=nobody, stats=stats)
                self.assertEqual(len(set(visited)), count)
                writes = Counter(call.args[0].name for call in write.call_args_list)
                # One durable cursor per attempted lookup and one final result commit.
                self.assertEqual(writes, {'questions.json': count + 1})
                self.assertEqual(stats['writes_n'], count + 1)
                calls = Counter(call.args[0] for call in redact.call_args_list)
                self.assertEqual(calls[ALERT], 1)
                self.assertEqual(calls['q-budget0'], 1)

    def test_follow_redaction_cache_matches_uncached_writes_and_expires_on_interrupt(self):
        rows = ['password: fixture123!', 'OTP: 123456', 'received € — 東京', 'ordinary text']
        now = at('2026-10-25T12:00')
        original = self.seed([now - dt.timedelta(days=3, hours=n) for n in range(3)])
        original['questions'][0]['notes'] = [{'text': text} for text in rows]
        changed = json.loads(json.dumps(original))
        changed['questions'][0]['notes'][0]['text'] = 'password: changed456!'
        snapshots = [original, changed, original]
        expected = [(json.dumps(mc.redact_all(book), ensure_ascii=False, indent=1) + '\n').encode()
                    for book in snapshots]
        stats = {}
        with patch.object(mc, 'redact', wraps=mc.redact) as redact:
            with self.assertRaises(mc.CheckTimeout):
                with mc.follow_timing(stats):
                    for snapshot, fresh in zip(snapshots, expected):
                        with mc.Locked(self.data, 'questions') as book:
                            book.update(snapshot)
                        self.assertEqual((self.data / 'questions.json').read_bytes(), fresh)
                    raise mc.CheckTimeout('interrupted')
            self.assertEqual(sum(call.args[0] == 'password: changed456!'
                                 for call in redact.call_args_list), 1)
            def original_calls():
                return sum(call.args[0] == rows[0] for call in redact.call_args_list)
            before = original_calls()
            mc.redact_all(original)
            self.assertEqual(original_calls() - before, 1)
            with mc.follow_timing({}):
                before = original_calls()
                mc.redact_all(original)
                self.assertEqual(original_calls() - before, 1)
        self.assertEqual(original['questions'][0]['notes'][0]['text'], rows[0])

    def test_follow_redaction_cache_has_a_fixed_entry_limit(self):
        with mc.follow_timing({}):
            for n in range(8200):
                text = f'ordinary fixture text {n}'
                self.assertEqual(mc.redact_all(text), mc.redact(text))
            self.assertEqual(mc._REDACTION_CACHE.get().cache_info().currsize, 8192)
        self.assertIsNone(mc._REDACTION_CACHE.get())

    def test_follow_rotates_across_budgeted_runs_even_with_the_same_timestamp(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(days=3, hours=n) for n in range(5)])
        visited, clock = [], [1000.0]

        def slow(charge, when, *a, **kw):
            visited.append(when)
            clock[0] += 3
            return {'verdict': 'unverified', 'why': 'fixture unavailable', 'errors': ['fixture unavailable']}

        with patch.object(mc.time, 'time', lambda: clock[0]), patch.object(mc, 'FOLLOW_EACH', 3), \
                patch.object(mc.charges, 'explain', slow):
            for _ in range(5):
                mc.follow(self.data, now, self.root, clock[0] + 5, finder(), nobody)
        self.assertEqual(len(set(visited)), 5)
        self.assertEqual(len(visited), 5)

    def test_tail_question_gets_a_full_slice_on_the_next_run(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(days=3, hours=n) for n in range(4)])
        visited, clock = [], [1000.0]

        def slow(charge, when, at_now, deadline, *a, **kw):
            self.assertEqual(deadline - clock[0], mc.FOLLOW_EACH)
            visited.append(when)
            clock[0] += 5.5 if when == now - dt.timedelta(days=3) else 5
            return {'verdict': 'unverified', 'why': 'fixture unavailable', 'errors': ['fixture unavailable']}

        with patch.object(mc.time, 'time', lambda: clock[0]), patch.object(mc.charges, 'explain', slow):
            for _ in range(2):
                mc.follow(self.data, now, self.root, clock[0] + 20, finder(), nobody)
        self.assertEqual(len(set(visited)), 4)

    def test_follow_persists_cursor_before_an_interrupted_lookup(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(days=3, hours=n) for n in range(3)])
        visited = []

        def interrupted(charge, when, *a, **kw):
            visited.append(when)
            raise mc.CheckTimeout('whole check interrupted')

        with patch.object(mc.charges, 'explain', interrupted):
            for _ in range(3):
                with self.assertRaises(mc.CheckTimeout):
                    mc.follow(self.data, now, self.root, time.time() + 10, finder(), nobody)
        self.assertEqual(len(set(visited)), 3)

    def test_cursor_save_cannot_shorten_the_question_slice(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(days=3)])
        clock, visited = [1000.0], []
        write = mc.write_json

        def slow_write(*args, **kw):
            write(*args, **kw)
            clock[0] += 1

        def source(charge, when, at_now, deadline, *a, **kw):
            visited.append(when)
            self.assertEqual(deadline - clock[0], mc.FOLLOW_EACH)
            clock[0] += 5.9
            return {'verdict': 'unverified', 'why': 'fixture unavailable', 'errors': ['fixture unavailable']}

        with patch.object(mc.time, 'time', lambda: clock[0]), patch.object(mc, 'write_json', slow_write), \
                patch.object(mc.charges, 'explain', source):
            mc.follow(self.data, now, self.root, 1006.5, finder(), nobody, end=1039)
        self.assertEqual(len(visited), 1)

    def test_cursor_commit_timeout_leaves_full_slice_before_outer_alarm(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(days=3)])
        start = time.time()
        with patch.object(mc, 'FOLLOW_EACH', 0.06), \
                patch.object(mc.fcntl, 'flock', side_effect=lambda *a: time.sleep(0.2)), \
                patch.object(mc.charges, 'explain') as source:
            with self.assertRaisesRegex(mc.CheckTimeout, 'cursor commit'):
                with mc.within(start + 0.2, mc.CheckTimeout('whole check out of time')):
                    mc.follow(self.data, now, self.root, start + 0.1, finder(), nobody, end=start + 0.2)
        self.assertNotIn('follow_cursor', mc.load_questions(self.data))
        source.assert_not_called()

    def test_follow_resumes_after_a_removed_cursor_question(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(days=3, hours=n) for n in range(3)])
        visited = []

        def interrupted(charge, when, *a, **kw):
            visited.append(when)
            raise mc.CheckTimeout('whole check interrupted')

        with patch.object(mc.charges, 'explain', interrupted):
            with self.assertRaises(mc.CheckTimeout):
                mc.follow(self.data, now, self.root, time.time() + 10, finder(), nobody)
            book = mc.load_questions(self.data)
            book['questions'] = [q for q in book['questions'] if q['id'] != book['follow_cursor']['id']]
            mc.write_json(self.data / 'questions.json', book)
            with self.assertRaises(mc.CheckTimeout):
                mc.follow(self.data, now, self.root, time.time() + 10, finder(), nobody)
        self.assertNotEqual(visited[0], visited[1])

    def test_question_alarm_during_receipt_cannot_skip_reserved_orders(self):
        from threading import Event
        now = at('2026-11-14T12:00')
        self.seed([now - dt.timedelta(hours=1)])
        with mc.Locked(self.data, 'questions') as book:
            book['questions'][0].update(merchant='noon', mkey='noon')
        calls = []
        def orders(app, deadline=None, **kwargs):
            calls.append((app, deadline - time.time()))
            return {'orders': [], 'complete': False, 'lanes': {
                lane: {'walked_at': '2026-12-31T00:00:00+00:00', 'covered_from': None, 'stop_reason': 'slice_out'}
                for lane in mc.charges.order_lookup.LANES}}
        def slow(*args, **kwargs):
            Event().wait(1)
            self.fail('receipt escaped its question alarm')
        stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
        with patch.object(mc, 'FOLLOW_EACH', 0.02), \
                patch.object(mc.charges.order_lookup, 'read', orders):
            errors = mc.follow(self.data, now, self.root, time.time() + 10,
                               slow, nobody, stats=stats)
        self.assertEqual([app for app, _ in calls], ['noon'])
        self.assertGreater(calls[0][1], 9)
        self.assertEqual(set(stats['order_coverage']['noon']), set(mc.charges.order_lookup.LANES))
        self.assertIn('out of time', str(errors))
        self.assertTrue(self.questions()[0]['unverified'])
        self.assertFalse(self.questions()[0].get('case_opened'))

    def test_order_evidence_covers_every_question_when_sources_fill_cursor_budget(self):
        now = at('2026-11-14T12:00')
        for matched in (False, True):
            with self.subTest(matched=matched):
                self.data = self.tmp / str(matched)
                self.seed([now - dt.timedelta(hours=1, minutes=n) for n in range(5)])
                with mc.Locked(self.data, 'questions') as book:
                    for q in book['questions']:
                        q.update(merchant='noon', mkey='noon')
                sample = book['questions'][0]
                clock, reads, source_calls = [1000.0], [], []
                def orders(app, **kwargs):
                    reads.append(app)
                    clock[0] += 10
                    return {'orders': ([{'order': 'fixture', 'total': sample['amount'], 'currency': sample['currency'],
                        'placed_at': (now - dt.timedelta(hours=1)).isoformat(), 'status': 'delivered'}]
                        if matched else []), 'complete': False, 'lanes': {
                        lane: {'walked_at': '2026-12-31T00:00:00+00:00', 'covered_from': None if lane == 'marketplace' else
                               (now - dt.timedelta(days=5)).isoformat(), 'exhaustive': False}
                        for lane in mc.charges.order_lookup.LANES}}
                def owner(*args, **kwargs):
                    clock[0] += 3.5
                    return []
                def msgs(*args, **kwargs):
                    source_calls.append(True)
                    clock[0] += 6
                    raise mc.charges.Lookup('fixture slow msgs')
                stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
                with patch.object(mc.time, 'time', lambda: clock[0]), \
                        patch.object(mc.charges.order_lookup, 'read', orders):
                    mc.follow(self.data, now, self.root, 1020, msgs, owner, end=1039, stats=stats)
                self.assertEqual(reads, ['noon'])
                questions = self.questions()
                self.assertTrue(all(q.get('order_evidence') for q in questions))
                self.assertEqual(stats['charge_census']['noon']['not_checked'], 0)
                if matched:
                    self.assertTrue(all(q['status'] == 'closed' for q in questions))
                    self.assertEqual(stats['charge_census']['noon']['matched'], 5)
                else:
                    self.assertTrue(source_calls)
                    self.assertTrue(all(q['order_evidence']['outcome'] == 'limited' for q in questions))
                    self.assertTrue(all(q['status'] == 'open' for q in questions))
                    self.assertFalse(any(q.get('case_opened') or q.get('asks') for q in questions))
                    self.assertEqual(stats['charge_census']['noon']['proven_clean'], 0)

    def test_order_only_pass_preserves_coverage_edges_without_authorizing_asks(self):
        now = at('2026-11-14T12:00')
        when = now - dt.timedelta(days=3)
        edge = when - mc.charges.SAME_TIME
        for offset, outcome in ((-1, 'proven_clean'), (0, 'limited'), (1, 'limited'), (None, 'limited')):
            with self.subTest(offset=offset):
                self.data = self.tmp / str(offset)
                self.seed([when])
                with mc.Locked(self.data, 'questions') as book:
                    book['questions'][0].update(merchant='noon', mkey='noon')
                clock = [1000.0]
                def orders(*args, **kwargs):
                    clock[0] += 11
                    return {'orders': [], 'complete': False, 'lanes': {
                        lane: {'walked_at': '2026-12-31T00:00:00+00:00', 'covered_from': None if offset is None else
                            (edge + dt.timedelta(seconds=offset)).isoformat(), 'exhaustive': False}
                        for lane in mc.charges.order_lookup.LANES}}
                stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
                with patch.object(mc.time, 'time', lambda: clock[0]), \
                        patch.object(mc.charges.order_lookup, 'read', orders):
                    mc.follow(self.data, now, self.root, 1012, finder(), nobody, end=1039, stats=stats)
                q, = self.questions()
                self.assertEqual(q['order_evidence']['outcome'], outcome)
                self.assertFalse(q.get('checked'))
                self.assertEqual(q['status'], 'open')
                self.assertFalse(q.get('case_opened') or q.get('asks'))
                self.assertEqual(stats['charge_census']['noon'], dict(marketplace_hold=0, marketplace_stale=0, open=1, matched=0,
                    proven_clean=0, limited=1, error=0, not_checked=0))

    def test_owner_precedes_reserved_order_reads_with_independent_slices(self):
        now = at('2026-11-14T12:00')
        self.seed([now - dt.timedelta(days=3, hours=n) for n in range(2)])
        with mc.Locked(self.data, 'questions') as book:
            for q, app in zip(book['questions'], ('noon', 'careem')):
                q.update(merchant=app, mkey=app)
        clock, calls = [1000.0], []
        def orders(app, deadline=None, **kwargs):
            calls.append((app, deadline - clock[0]))
            if app == 'noon':
                clock[0] += 9.5
                raise ValueError('fixture reader failed')
            return {'orders': [], 'complete': False}
        def owner(*args, **kwargs):
            calls.append(('owner', 0))
            return []
        with patch.object(mc.time, 'time', lambda: clock[0]), \
                patch.object(mc.charges.order_lookup, 'read', orders):
            mc.follow(self.data, now, self.root, 1030, finder(), owner)
        self.assertEqual(calls[:3], [('owner', 0), ('noon', 10), ('careem', 2)])
        self.assertTrue(all(q['unverified'] for q in self.questions()))

    def test_slow_external_source_leaves_time_for_order_lanes(self):
        from threading import Event
        now = at('2026-11-14T12:00')
        for source in ('owner', 'mail'):
            with self.subTest(source=source):
                self.seed([now - dt.timedelta(hours=1)])
                with mc.Locked(self.data, 'questions') as book:
                    book['questions'][0]['merchant'] = 'noon'
                reads = []
                def slow(*args, **kwargs):
                    Event().wait(5)
                    self.fail('source was not bounded')
                def orders(app, deadline=None, **kwargs):
                    reads.append(deadline - time.time())
                    return {'orders': [], 'complete': False, 'lanes': {
                        lane: {'walked_at': '2026-12-31T00:00:00+00:00', 'covered_from': None, 'stop_reason': 'unproven_paging'}
                        for lane in mc.charges.order_lookup.LANES}}
                stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
                with patch.object(mc.charges, 'OWNER_BUDGET', 0.05), \
                        patch.object(mc.charges, 'MSGS_BUDGET', 0.05), \
                        patch.object(mc.charges.order_lookup, 'read', orders):
                    errors = mc.follow(self.data, now, self.root, time.time() + 10,
                        slow if source == 'mail' else finder(),
                        slow if source == 'owner' else nobody, stats=stats)
                self.assertEqual(len(reads), 1)
                self.assertGreater(reads[0], mc.FOLLOW_EACH - 1)
                self.assertEqual(set(stats['order_coverage']['noon']), set(mc.charges.order_lookup.LANES))
                self.assertEqual(stats['starved_by'], 'owner_threads' if source == 'owner' else 'receipt')
                self.assertTrue(errors)
                self.assertTrue(self.questions()[0]['unverified'])
                self.assertEqual(self.questions()[0]['status'], 'open')
                self.assertFalse(self.questions()[0].get('case_opened'))

    def test_old_owner_windows_share_one_budget(self):
        now = at('2026-11-14T12:00')
        self.seed([now - dt.timedelta(days=3, hours=n) for n in range(3)])
        clock = [1000.0]
        calls = []
        def owner(*args, deadline=None):
            calls.append(deadline - clock[0])
            clock[0] += 2.5
            return []
        stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
        with patch.object(mc.time, 'time', lambda: clock[0]), \
                patch.object(mc.time, 'monotonic', lambda: clock[0]):
            mc.follow(self.data, now, self.root, 1020, finder(), owner, stats=stats)
        self.assertEqual(calls, [mc.charges.OWNER_BUDGET])
        self.assertFalse(self.questions()[0].get('unverified'))
        self.assertEqual(stats['owner_threads_ms'], 2500)

    def test_warm_owner_read_precedes_twenty_second_msgs_lookup(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(hours=1)])
        with ControlServer() as server:
            mc.charges.owner_texts(now - dt.timedelta(hours=2), now,
                                   cache_path=self.data / 'owner-texts.json')
            server.calls.clear()
            clock, sequence = [1000.0], []
            def owner(*args, deadline=None):
                sequence.append('owner')
                self.assertEqual(deadline - clock[0], mc.charges.OWNER_BUDGET)
                return mc.charges.owner_texts(*args, deadline=deadline, stats=stats,
                                              cache_path=self.data / 'owner-texts.json')
            def msgs(*args, **kwargs):
                sequence.append('msgs')
                clock[0] += 20
                raise mc.charges.Lookup('fixture: msgs consumed 20 seconds')
            stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
            with patch.object(mc.time, 'time', lambda: clock[0]):
                mc.follow(self.data, now, self.root, 1040, msgs, owner, stats=stats)
            self.assertEqual(sequence[0], 'owner')
            self.assertIn('msgs', sequence)
            self.assertEqual(stats['owner_result'], 'ok')
            self.assertEqual(stats['owner_threads_fresh'], 1)
            self.assertEqual(stats['owner_threads_fetched'], 0)
            self.assertEqual(stats['owner_queries'], 2)

    def test_owner_prefetch_leaves_budget_for_questions(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(hours=n) for n in range(3)])

        def unavailable(*args, deadline=None):
            self.assertEqual(deadline, 1000 + mc.charges.OWNER_BUDGET)
            raise mc.LookupTimeout('out of time')

        with patch.object(mc.time, 'time', return_value=1000):
            mc.follow(self.data, now, self.root, 1020, finder(), unavailable)
        self.assertTrue(all(q['checked'] and q['unverified'] for q in self.questions()))

    def test_failed_owner_source_is_attempted_once_for_old_questions_per_run(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(days=3, hours=n) for n in range(3)])
        with patch.object(mc.charges, 'owner_texts', side_effect=mc.charges.Lookup('Robob control: request failed or timed out')) as source:
            errors = mc.follow(self.data, now, self.root, time.time() + 10, finder())
        self.assertEqual(source.call_count, 1)
        self.assertTrue(all(q['checked'] and q['unverified'] for q in self.questions()))
        self.assertTrue(errors)

    def test_source_census_accounts_for_matches_clean_limits_errors_and_deferred(self):
        now = at('2026-11-14T12:00')
        self.seed([now - dt.timedelta(days=3, hours=5-n) for n in range(5)])
        with mc.Locked(self.data, 'questions') as book:
            for n, q in enumerate(book['questions']):
                q['merchant'] = 'careem' if n == 4 else 'noon'
        stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
        outcomes = iter([
            {'verdict': 'receipt', 'why': 'fixture match', 'errors': []},
            {'verdict': 'wait', 'why': 'fixture wait', 'until': (now + dt.timedelta(days=1)).isoformat(), 'errors': []},
            {'verdict': 'unverified', 'why': 'fixture limit', 'errors': [],
             'limits': [{'why': 'fixture', 'kinds': ['food_page_1']}]},
            {'verdict': 'unverified', 'why': 'fixture error', 'errors': ['fixture error']},
            {'verdict': 'unverified', 'why': 'fixture limit', 'errors': [],
             'limits': [{'why': 'fixture', 'kinds': ['ORDER_LIST_HOST_BINDING_UNVERIFIED']}]},
        ])
        with patch.object(mc.charges, 'explain', side_effect=lambda *a, **kw: next(outcomes)):
            mc.follow(self.data, now, self.root, find=finder(), said=nobody, stats=stats)
        self.assertEqual(stats['charge_census']['noon'], dict(marketplace_hold=0, marketplace_stale=0, open=4, matched=1,
            proven_clean=1, limited=1, error=1, not_checked=0))
        self.assertEqual(stats['charge_census']['careem'], dict(open=1, matched=0,
            proven_clean=0, limited=1, error=0, not_checked=0))
        # No time to admit another screen: remaining rows are deferred, never clean.
        stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
        mc.follow(self.data, now, self.root, deadline=time.time(), find=finder(), said=nobody, stats=stats)
        for counts in stats['charge_census'].values():
            self.assertEqual(counts['open'], counts['limited'])
            self.assertEqual(counts['open'], counts['not_checked'])
            self.assertEqual(counts['proven_clean'], 0)

    def test_source_census_uses_final_alias_matches(self):
        now = at('2026-11-14T12:00')
        forms = {
            'limited': {'verdict': 'unverified', 'why': 'fixture limit', 'errors': [],
                'limits': [{'why': 'fixture', 'kinds': ['food_page_1']}]},
            'error': {'verdict': 'unverified', 'why': 'fixture error', 'errors': ['fixture']},
            'clean': {'verdict': 'ask', 'why': 'fixture clean', 'errors': []},
            'deferred': None,
        }
        for form, first in forms.items():
            with self.subTest(form=form):
                self.data = self.tmp / form
                self.seed([now - dt.timedelta(days=3)] * 2)
                with mc.Locked(self.data, 'questions') as book:
                    for n, q in enumerate(book['questions']):
                        q['merchant'] = 'noon' if n == 0 else 'noon food'
                stats = {'lookups': 0, 'owner_queries': 0, 'msgs_calls': 0}
                clock = [1000.0]
                receipt = {'verdict': 'receipt', 'why': 'fixture receipt', 'errors': []}
                outcomes = iter([first, receipt])
                def explain(*args, **kw):
                    if form == 'deferred':
                        clock[0] += 2
                        return receipt
                    return next(outcomes)
                with patch.object(mc.time, 'time', side_effect=lambda: clock[0]), \
                        patch.object(mc.charges, 'explain', side_effect=explain):
                    mc.follow(self.data, now, self.root, 1007 if form == 'deferred' else None,
                              finder(), nobody, stats=stats)
                self.assertTrue(all(q['status'] == 'closed' for q in self.questions()))
                self.assertEqual(stats['charge_census']['noon'], dict(marketplace_hold=0, marketplace_stale=0, open=2, matched=2,
                    proven_clean=0, limited=0, error=0, not_checked=0))

    def census_alias_check(self, label, merchants, outcomes, deferred=False):
        now = at('2026-11-14T12:00')
        self.data, self.wd = self.tmp / label, self.tmp / ('wd-' + label)
        self.wd.mkdir()
        self.seed([now - dt.timedelta(days=3)] * len(merchants))
        with mc.Locked(self.data, 'questions') as book:
            for q, merchant in zip(book['questions'], merchants):
                q.update(merchant=merchant, mkey=mc.merchant_key(merchant))
        clock, results = [1000.0], iter(outcomes)
        def explain(*args, **kw):
            if deferred:
                clock[0] += 2
            return next(results)
        with patch.object(mc.charges.order_lookup, 'read', return_value={'orders': [], 'complete': True,
                    'lanes': {lane: {'exhaustive': True, 'walked_at': now.isoformat()}
                              for lane in mc.charges.order_lookup.LANES}}), \
                patch.object(mc.time, 'time', side_effect=lambda: clock[0]), \
                patch.object(mc, 'FOLLOW_BUDGET', 7 if deferred else mc.FOLLOW_BUDGET), \
                patch.object(mc.charges, 'explain', side_effect=explain):
            mc.run_check(self.wd, label, self.data, self.root, now, finder(), nobody)
        rows = [json.loads(line) for path in (self.tmp / 'tool-logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]
        return self.questions(), [r for r in rows if r['name'] == 'check.run'][-1]

    def test_check_census_reconciles_unverified_aliases(self):
        for kind in ('limited', 'error'):
            blocked = {'verdict': 'unverified', 'why': 'fixture blocked',
                'errors': ['fixture source error'] if kind == 'error' else [],
                'limits': [] if kind == 'error' else [{'why': 'fixture source limit',
                                                     'kinds': ['food_page_1']}]}
            for clean in ('ask', 'wait'):
                clear = {'verdict': clean, 'why': 'fixture clean', 'errors': [],
                         'until': at('2026-11-15T12:00').isoformat()}
                for peer in ('noon food', 'careem', 'other vendor'):
                    for reverse in (False, True):
                        label = f'{kind}-{clean}-{peer.replace(" ", "-")}-{reverse}'
                        with self.subTest(label=label):
                            merchants = ['noon', peer]
                            outcomes = [clear, blocked]
                            if reverse:
                                merchants.reverse()
                                outcomes.reverse()
                            questions, row = self.census_alias_check(label, merchants, outcomes)
                            self.assertTrue(all(q['unverified'] for q in questions))
                            self.assertTrue(all(q['status'] == 'open' and not q['asks'] for q in questions))
                            census = row['props']['chargeCensus']
                            for source, count in (('noon', 2 if peer == 'noon food' else 1),
                                                  ('careem', 1 if peer == 'careem' else 0)):
                                self.assertEqual(census[source], dict(
                                    **({'marketplace_hold': 0, 'marketplace_stale': 0} if source == 'noon' else {}),
                                    open=count, matched=0,
                                    proven_clean=0, limited=count if kind == 'limited' else 0,
                                    error=count if kind == 'error' else 0, not_checked=0))
                            self.assertEqual(row['ok'], kind == 'limited')
                            self.assertNotIn('fixture', json.dumps(row))

    def test_check_census_mixed_alias_errors_are_order_independent(self):
        limited = {'verdict': 'unverified', 'why': 'fixture limit', 'errors': [],
                   'limits': [{'why': 'fixture', 'kinds': ['food_page_1']}]}
        failed = {'verdict': 'unverified', 'why': 'fixture error', 'errors': ['fixture']}
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                outcomes = [limited, failed] if not reverse else [failed, limited]
                questions, row = self.census_alias_check('mixed-' + str(reverse),
                    ['noon', 'noon food'], outcomes)
                self.assertTrue(all(q['unverified'] for q in questions))
                self.assertEqual(row['props']['chargeCensus']['noon'], dict(marketplace_hold=0, marketplace_stale=0, open=2, matched=0,
                    proven_clean=0, limited=0, error=2, not_checked=0))
                self.assertFalse(row['ok'])

    def test_check_census_does_not_propagate_through_distinct_same_descriptor_questions(self):
        failed = {'verdict': 'unverified', 'why': 'fixture error', 'errors': ['fixture']}
        limited = {'verdict': 'unverified', 'why': 'fixture limit', 'errors': [],
                   'limits': [{'why': 'fixture', 'kinds': ['food_page_1']}]}
        clear = {'verdict': 'ask', 'why': 'fixture clean', 'errors': []}
        questions, row = self.census_alias_check('non-transitive',
            ['noon', 'noon food', 'noon'], [failed, limited, clear])
        self.assertTrue(all(q['unverified'] for q in questions))
        self.assertEqual(row['props']['chargeCensus']['noon'], dict(marketplace_hold=0, marketplace_stale=0, open=3, matched=0,
            proven_clean=0, limited=1, error=2, not_checked=0))

    def test_check_census_deferred_alias_has_only_order_evidence(self):
        clear = {'verdict': 'ask', 'why': 'fixture clean', 'errors': []}
        questions, row = self.census_alias_check('deferred-clean', ['noon', 'noon food'],
                                               [clear], deferred=True)
        self.assertTrue(questions[0]['unverified'])
        self.assertFalse(questions[1].get('checked'))
        self.assertEqual(row['props']['chargeCensus']['noon'], dict(marketplace_hold=0, marketplace_stale=0, open=2, matched=0,
            proven_clean=0, limited=2, error=0, not_checked=0))
        self.assertFalse(row['ok'])

    def test_check_census_does_not_combine_identical_descriptors(self):
        clear = {'verdict': 'ask', 'why': 'fixture clean', 'errors': []}
        for kind in ('limited', 'error'):
            blocked = {'verdict': 'unverified', 'why': 'fixture blocked',
                'errors': ['fixture'] if kind == 'error' else [],
                'limits': [] if kind == 'error' else [{'why': 'fixture', 'kinds': ['food_page_1']}]}
            with self.subTest(kind=kind):
                questions, row = self.census_alias_check('distinct-' + kind,
                                                       ['noon', 'noon'], [clear, blocked])
                self.assertEqual(row['props']['chargeCensus']['noon'], dict(marketplace_hold=0, marketplace_stale=0, open=2, matched=0,
                    proven_clean=1, limited=1 if kind == 'limited' else 0,
                    error=1 if kind == 'error' else 0, not_checked=0))
                self.assertFalse(questions[0]['unverified'])
                self.assertTrue(questions[1]['unverified'])

    def questions(self):
        return mc.load_questions(self.data)["questions"]

    def seed(self, times):
        book = {'version': 1, 'questions': []}
        charge = mc.charges.parse(ALERT, BANK)
        for n, when in enumerate(times):
            q = mc.new_question(book, charge, ALERT, when, when, 'sms')
            q['id'] = f'q-budget{n}'
        mc.write_json(self.data / 'questions.json', book)
        return book

    def test_limit_only_check_saves_limits_and_never_asks(self):
        now = at('2026-11-10T12:00')
        book = self.seed([now - dt.timedelta(days=3)])
        book['questions'][0]['merchant'] = 'careem'
        mc.write_json(self.data / 'questions.json', book)
        limit = mc.charges.order_lookup.SourceLimit('ORDER_LIST_HOST_BINDING_UNVERIFIED')
        # Use the native source-limit path, with all other evidence readable and empty.
        with patch.object(mc.charges, 'receipt', return_value=None), \
                patch.object(mc.charges.order_lookup, 'read', side_effect=limit), \
                patch.object(mc.charges, 'card_owner', return_value='abdullah'):
            event = mc.run_check(self.wd, 'limited', self.data, self.root, now, finder(), nobody)
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertFalse(state.get('question_errors'))
        self.assertEqual(len(state['question_limits']['limits']), 1)
        q = self.questions()[0]
        self.assertTrue(q['unverified'])
        self.assertEqual(q['asks'], [])
        self.assertFalse(q.get('case_opened'))
        self.assertEqual(event, '')
        logs = list((self.tmp / 'tool-logs' / 'orders').glob('*.ndjson'))
        rows = [json.loads(line) for path in logs for line in path.read_text().splitlines()]
        run = next(r for r in rows if r['name'] == 'check.run')
        self.assertTrue(run['ok'])
        self.assertEqual(run['props']['sourceLimits'], 1)
        self.assertEqual(run['props']['limitKinds'], ['ORDER_LIST_HOST_BINDING_UNVERIFIED'])

    def test_slow_lookups_leave_time_for_due_case_event(self):
        self.case()
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(hours=n) for n in range(10)])

        def slow(*args, **kw):
            time.sleep(3)
            return []

        started = time.monotonic()
        with patch.object(mc, 'CHECK_BUDGET', 6):
            event = mc.run_check(self.wd, 'r', self.data, self.root, now, slow, slow)
        self.assertLess(time.monotonic() - started, 8)
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertIn('OVERDUE', event)
        self.assertIn('out of time', str(state['question_errors']))
        self.assertIn('timing', state)

    def test_slow_receipt_cannot_swallow_question_deadline(self):
        now = at('2026-10-25T12:00')
        self.seed([now])
        def slow(*args, **kw):
            time.sleep(3)
            return []
        started = time.monotonic()
        with patch.object(mc, 'FOLLOW_EACH', 0.15):
            errors = mc.follow(self.data, now, self.root, time.time() + 5, slow, nobody)
        self.assertLess(time.monotonic() - started, 1)
        self.assertIn('out of time', str(errors))

    def test_receipt_timeout_still_uses_cached_owner_evidence(self):
        now = at('2026-10-25T12:00')
        when = now - dt.timedelta(days=1)
        book = self.seed([when])
        book['questions'][0]['asks'] = [{'at': mc.stamp(when)}, {'at': mc.stamp(when + dt.timedelta(hours=1))}]
        mc.write_json(self.data / 'questions.json', book)
        def owner(*args, **kw):
            return [(mc.charges.iso(when), 'I paid Acme', 'app')]
        def slow(*args, **kw):
            time.sleep(3)
            return []
        with patch.object(mc, 'FOLLOW_EACH', 0.05):
            mc.follow(self.data, now, self.root, time.time() + 5, slow, owner)
        q = self.questions()[0]
        self.assertEqual(q['status'], 'closed')
        self.assertIn('I paid Acme', q['outcome'])
        self.assertEqual(mc.load(self.data)['cases'], [])

    def test_interrupted_case_and_question_pair_recovers_on_retry(self):
        for action in ('promote', 'close'):
            with self.subTest(action=action):
                self.data = self.tmp / action
                now = at('2026-10-25T12:00')
                when = now - dt.timedelta(days=8)
                self.seed([when])
                def owner(*args, **kw):
                    return [(mc.charges.iso(when), 'I paid Acme', 'app')]
                if action == 'close':
                    with mc.Locked(self.data, 'questions') as book:
                        mc.case_from(self.data, book['questions'][0], now, 'check', self.root)
                replace = mc.os.replace
                def interrupted_replace(src, dst):
                    replace(src, dst)
                    if Path(dst).name == 'cases.json':
                        with mc.within(time.time() + 0.05, mc.CheckTimeout('out of time')):
                            mc.signal.raise_signal(mc.signal.SIGALRM)
                with patch.object(mc.os, 'replace', interrupted_replace):
                    with self.assertRaises(mc.CheckTimeout):
                        if action == 'close':
                            mc.follow(self.data, now, self.root, time.time() + 10, finder(), owner)
                        else:
                            with mc.Locked(self.data, 'questions') as book:
                                mc.case_from(self.data, book['questions'][0], now, 'check', self.root)
                self.assertEqual(self.questions()[0]['status'], 'case' if action == 'close' else 'open')
                self.assertEqual(len(mc.load(self.data)['cases']), 1)
                mc.follow(self.data, now, self.root, time.time() + 10, finder(), owner)
                q = self.questions()[0]
                self.assertEqual(q['status'], 'closed')
                self.assertTrue(q['case_closed'])
                self.assertEqual(q['was_case'], mc.load(self.data)['cases'][0]['id'])
                self.assertEqual(mc.load(self.data)['cases'][0]['status'], 'closed')

    def test_every_settlement_path_recovers_an_interrupted_promotion(self):
        # Entry point       Result                              Case handling
        # answered          closed, was_case                    answer noted, stays open
        # ask               case, DONT_ASK                      follows existing case
        # screen / readonly case verdict                       follows existing case
        # triaged           case, never closed as an unraised q follows existing case
        for entry in ('answered', 'ask', 'screen', 'readonly', 'triaged'):
            with self.subTest(entry=entry):
                self.data = self.tmp / entry
                now = at('2026-10-25T12:00')
                when = now - dt.timedelta(days=8)
                qid = self.seed([when])['questions'][0]['id']
                replace = mc.os.replace
                def interrupted_replace(src, dst):
                    replace(src, dst)
                    if Path(dst).name == 'cases.json':
                        with mc.within(time.time() + 0.05, mc.CheckTimeout('out of time')):
                            mc.signal.raise_signal(mc.signal.SIGALRM)
                with patch.object(mc.os, 'replace', interrupted_replace):
                    with self.assertRaises(mc.CheckTimeout):
                        with mc.Locked(self.data, 'questions') as book:
                            mc.case_from(self.data, book['questions'][0], now, 'check', self.root)
                cid = mc.load(self.data)['cases'][0]['id']
                self.assertEqual(self.questions()[0]['status'], 'open')
                if entry == 'answered':
                    mc.answered(self.data, qid, 'not mine', now)
                    q = self.questions()[0]
                    self.assertEqual((q['status'], q['was_case']), ('closed', cid))
                    self.assertIn('not mine', mc.load(self.data)['cases'][0]['history'][-1]['text'])
                elif entry == 'ask':
                    code, message = mc.ask(self.data, 'Is this yours?', qid=qid, now=now, find=finder(), said=nobody)
                    self.assertEqual(code, mc.DONT_ASK)
                    self.assertIn(cid, message)
                elif entry in ('screen', 'readonly'):
                    result = mc.screen(ALERT, BANK, when, now, data=self.data, find=finder(), said=nobody,
                                       record=entry == 'screen')
                    self.assertEqual(result['verdict'], 'case')
                    self.assertIn(cid, result['why'])
                else:
                    mc.triaged(self.data, [(qid, 'imsg:test', False)], now)
                q = self.questions()[0]
                if entry not in ('answered', 'readonly'):
                    self.assertEqual((q['status'], q['case']), ('case', cid))
                self.assertEqual(mc.load(self.data)['cases'][0]['status'], 'open')
                mc.follow(self.data, now, self.root, time.time() + 10, finder(), nobody)
                self.assertEqual(len(mc.load(self.data)['cases']), 1)

    def test_slow_run_logs_phase_times_and_counts(self):
        self.case()
        clock = [1000.0]
        attention = mc.attention
        def slow(*args, **kw):
            clock[0] += 22
            return attention(*args, **kw)
        stderr = io.StringIO()
        with patch.object(mc.time, 'time', lambda: clock[0]), patch.object(mc, 'attention', slow), \
                redirect_stderr(stderr):
            mc.run_check(self.wd, 'r', self.data, self.root, at('2026-10-25T12:00'), finder(), nobody)
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        self.assertEqual(timing['total_s'], 22)
        self.assertEqual(timing['attention_s'], 22)
        self.assertEqual(timing['slowest'], 'attention')
        self.assertIn('money-cases timing:', stderr.getvalue())
        self.assertEqual((timing['owner_queries'], timing['msgs_calls']), (0, 0))

    def test_work_timeout_keeps_runner_owned_outbox(self):
        self.case()
        now = at('2026-10-25T12:00')
        event = mc.run_check(self.wd, 'original', self.data, self.root, now, finder(), nobody)
        before = json.loads((self.wd / 'pings.json').read_text())
        mc.write_json(self.wd / 'state.json', {'fires': 0, 'pending': {'event': event}})
        def slow(*args, **kw):
            time.sleep(3)
            return []
        with patch.object(mc, 'CHECK_BUDGET', 1.2), patch.object(mc, 'follow', slow):
            self.assertEqual(mc.run_check(self.wd, 'r', self.data, self.root, now), '')
        after = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(after['outbox'], before['outbox'])
        self.assertEqual(after['sent'], before['sent'])

    def test_slow_write_preparation_keeps_prior_file(self):
        for step in ('dumps', 'write', 'fsync'):
            with self.subTest(step=step):
                path = self.tmp / 'atomic.json'
                mc.write_json(path, {'prior': True})
                before = path.stat()
                target = mc.json if step == 'dumps' else mc.os
                original = getattr(target, step)
                def slow(*args, **kw):
                    time.sleep(3)
                    return original(*args, **kw)
                started = time.monotonic()
                with patch.object(target, step, slow):
                    with self.assertRaises(mc.CheckTimeout):
                        with mc.within(time.time() + 0.1, mc.CheckTimeout('out of time')):
                            mc.write_json(path, {'complete': True})
                self.assertLess(time.monotonic() - started, 0.6)
                self.assertEqual(json.loads(path.read_text()), {'prior': True})
                self.assertEqual(path.stat().st_ino, before.st_ino)
                self.assertEqual(list(self.tmp.glob('.atomic.json.*')), [])

    def test_timeout_never_retries_a_slow_buffer_flush_on_close(self):
        self.case()
        pings = self.wd / 'pings.json'
        mc.write_json(pings, {'sent': {}, 'marker': 'prior'})
        before = pings.read_bytes()
        calls = []
        class SlowRaw(io.FileIO):
            def write(self, data):
                calls.append('write')
                time.sleep(3)
                return super().write(data)
        def buffered(fd, *_args, **_kw):
            return io.TextIOWrapper(io.BufferedWriter(SlowRaw(fd, 'w')))
        write = mc.os.write
        mkstemp = mc.tempfile.mkstemp
        pings_inode = []
        def pings_temp(*args, **kw):
            fd, name = mkstemp(*args, **kw)
            if kw.get('prefix') == '.pings.json.':
                stat = mc.os.fstat(fd)
                pings_inode.append((stat.st_dev, stat.st_ino))
            return fd, name
        def slow_raw(fd, data):
            stat = mc.os.fstat(fd)
            if (stat.st_dev, stat.st_ino) in pings_inode:
                calls.append('write')
                time.sleep(3)
            return write(fd, data)
        started = time.monotonic()
        with patch.object(mc, 'CHECK_BUDGET', 0.3), patch.object(mc.os, 'fdopen', buffered), \
                patch.object(mc.tempfile, 'mkstemp', pings_temp), \
                patch.object(mc.os, 'write', slow_raw), redirect_stderr(io.StringIO()):
            event = mc.run_check(self.wd, 'r', self.data, self.root, at('2026-10-25T12:00'), finder(), nobody)
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(event, '')
        self.assertEqual(calls, ['write'])
        self.assertEqual(pings.read_bytes(), before)
        self.assertEqual(list(self.wd.glob('.pings.json.*')), [])

    def test_raw_writes_handle_short_writes_and_unicode(self):
        path = self.tmp / 'raw.json'
        write = mc.os.write
        def short(fd, data):
            return write(fd, data[:7])
        with patch.object(mc.os, 'write', short):
            mc.write_json(path, {'text': 'received € — 東京'}, timing=lambda: {'total_s': 1})
        self.assertEqual(json.loads(path.read_text()), {'text': 'received € — 東京', 'timing': {'total_s': 1}})

    def test_final_pings_write_is_bounded_and_keeps_outbox_on_timeout(self):
        for sync in (1, 2):
            with self.subTest(sync=sync):
                self.case() if not (self.data / 'cases.json').exists() else None
                now = at('2026-10-25T12:00')
                event = mc.run_check(self.wd, 'old', self.data, self.root, now, finder(), nobody)
                pings = self.wd / 'pings.json'
                before = pings.read_bytes()
                inode = pings.stat().st_ino
                mc.write_json(self.wd / 'state.json', {'fires': 0, 'pending': {'event': event}})
                calls = []
                fsync = mc.os.fsync
                def slow(fd):
                    calls.append(fd)
                    if len(calls) == sync:
                        time.sleep(3)
                    return fsync(fd)
                stderr = io.StringIO()
                started = time.monotonic()
                with patch.object(mc, 'CHECK_BUDGET', 0.3), patch.object(mc.os, 'fsync', slow), redirect_stderr(stderr):
                    result = mc.run_check(self.wd, 'new', self.data, self.root, now, finder(), nobody)
                self.assertLess(time.monotonic() - started, 0.8)
                self.assertEqual(result, '')
                self.assertEqual(pings.read_bytes(), before)
                self.assertEqual(pings.stat().st_ino, inode)
                self.assertEqual(list(self.wd.glob('.pings.json.*')), [])
                timing = json.loads(stderr.getvalue().split('money-cases timing: ')[1])
                self.assertFalse(timing['pings_saved'])
                self.assertGreaterEqual(timing['total_s'], 0.29)
                self.assertEqual(timing['slowest'], 'build_write')

    def test_successful_pings_timing_includes_data_fsync(self):
        self.case()
        fsync, write = mc.os.fsync, mc.write_json
        def slow(fd):
            time.sleep(0.1)
            return fsync(fd)
        def write_pings(path, obj, timing=None):
            if path.name == 'pings.json':
                with patch.object(mc.os, 'fsync', slow):
                    return write(path, obj, timing=timing)
            return write(path, obj, timing=timing)
        with patch.object(mc, 'write_json', write_pings):
            mc.run_check(self.wd, 'r', self.data, self.root, at('2026-10-25T12:00'), finder(), nobody)
        timing = json.loads((self.wd / 'pings.json').read_text())['timing']
        self.assertGreaterEqual(timing['total_s'], 0.1)
        self.assertGreaterEqual(timing['build_write_s'], 0.1)
        self.assertEqual(timing['slowest'], 'build_write')

    def test_slow_attention_stops_and_saves_without_new_outbox(self):
        self.case()
        def slow(*args, **kw):
            time.sleep(3)
            return []
        started = time.monotonic()
        with patch.object(mc, 'CHECK_BUDGET', 1.5), patch.object(mc, 'attention', slow):
            event = mc.run_check(self.wd, 'r', self.data, self.root, at('2026-10-25T12:00'), finder(), nobody)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(event, '')
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertNotIn('outbox', state)
        self.assertEqual(state['timing']['slowest'], 'attention')

    def test_held_case_lock_exits_cleanly_and_keeps_pings(self):
        self.case('charge-budget0')
        now = at('2026-10-25T12:00')
        book = self.seed([now - dt.timedelta(days=8)])
        book['questions'][0].update(status='case', case='charge-budget0', asks=[{'at': mc.stamp(now)}])
        mc.write_json(self.data / 'questions.json', book)
        mc.write_json(self.wd / 'pings.json', {'sent': {'kept': mc.stamp(now)}})
        script = ('import fcntl, sys; f = open(sys.argv[1], "a"); '
                  'fcntl.flock(f, fcntl.LOCK_EX); print("locked", flush=True); sys.stdin.read()')
        holder = subprocess.Popen(['/usr/bin/python3', '-B', '-c', script, str(self.data / 'cases.lock')],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), 'locked')
            started = time.monotonic()
            with patch.object(mc, 'CHECK_BUDGET', 11):
                event = mc.run_check(self.wd, 'r', self.data, self.root, now, finder(), nobody)
            self.assertLess(time.monotonic() - started, 11)
            self.assertEqual(event, '')
            state = json.loads((self.wd / 'pings.json').read_text())
            self.assertIn('kept', state['sent'])
            self.assertIn('cases.lock', str(state['question_errors']))
            self.assertNotIn('outbox', state)
            self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'case')
        finally:
            holder.communicate(timeout=2)

    def test_one_owner_query_filters_each_questions_window(self):
        now = at('2026-10-25T12:00')
        times = [now - dt.timedelta(hours=2*n) for n in range(5)]
        self.seed(times)
        rows = [summary(f'I paid Acme, item {n}', createdAt=mc.charges.iso(when)) for n, when in enumerate(times)]
        with ControlServer(rows), patch.object(mc.charges, 'owner_texts', wraps=mc.charges.owner_texts) as query:
            mc.run_check(self.wd, 'r', self.data, self.root, now, finder())
        self.assertEqual(query.call_count, 1)
        self.assertTrue((self.data / 'owner-texts.json').exists())
        for n, q in enumerate(self.questions()):
            self.assertEqual(q['status'], 'closed')
            self.assertIn(f'item {n}', q['outcome'])
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(state['timing']['owner_queries'], 3)

    def test_stalled_control_lookup_keeps_check_in_budget_and_questions_unverified(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(minutes=n) for n in range(5)])
        with ControlServer(stall='/messages') as server, patch.object(mc, 'CHECK_BUDGET', 11):
            started = time.time()
            mc.run_check(self.wd, 'r', self.data, self.root, now, finder())
            self.assertGreater(time.time() - started, 1)
            self.assertLess(time.time() - started, mc.CHECK_BUDGET + 2)
            self.assertTrue(any(path.endswith('/messages') for path, _, _ in server.calls))
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertIn('Robob control:', str(state['question_errors']))
        self.assertTrue(all(q['status'] != 'closed' for q in self.questions()))

    def test_union_lookup_failure_is_recorded_once(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(hours=n) for n in range(5)])
        with patch.object(mc.charges, 'owner_texts', side_effect=mc.charges.Lookup('test source failed')) as query:
            mc.run_check(self.wd, 'r', self.data, self.root, now, finder())
        self.assertEqual(query.call_count, 1)
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(str(state['question_errors']).count('test source failed'), 1)
        self.assertTrue(all(q['status'] == 'open' for q in self.questions()))

    def test_long_union_uses_one_owner_read_and_the_checks_data_dir(self):
        now = at('2026-10-25T12:00')
        self.seed([now, now - dt.timedelta(days=3)])
        with patch.object(mc.charges, 'owner_texts', return_value=[]) as query:
            mc.run_check(self.wd, 'r', self.data, self.root, now, finder())
        self.assertEqual(query.call_count, 1)
        self.assertEqual(query.call_args.args[:2], (now - dt.timedelta(days=3) - mc.charges.OWNER_AROUND, now))
        self.assertEqual(query.call_args.kwargs['cache_path'], self.data / 'owner-texts.json')

    def test_msgs_cache_is_shared_by_ambiguous_questions_and_reset_each_run(self):
        now = at('2026-10-25T12:00')
        times = [now, now - dt.timedelta(seconds=1)]
        self.seed(times)
        row = {'id': 1, 'ts': now.timestamp(), 'sender': 'Acme', 'subject': 'Acme receipt'}
        calls = []
        def msgs(argv, **kw):
            calls.append(tuple(argv))
            body = json.dumps(row) if argv[1] == 'search' else 'Acme receipt EUR 12.34'
            return subprocess.CompletedProcess(argv, 0, body, '')
        with patch.object(mc.charges.subprocess, 'run', msgs):
            mc.run_check(self.wd, 'r', self.data, self.root, now, said=nobody)
            self.assertEqual([a[1] for a in calls], ['search', 'show', 'search'])
            self.seed(times)
            mc.run_check(self.wd, 'r2', self.data, self.root, now, said=nobody)
        self.assertEqual([a[1] for a in calls], ['search', 'show', 'search'] * 2)
        self.assertTrue(all(q['status'] == 'open' for q in self.questions()))


class DeadCards(Base):
    def test_cards_are_private_and_keep_the_original_since_on_repeat(self):
        self.assertEqual(mc.dead_cards(self.data), {})
        mc.card_dead(self.data, '5542', 'cancelled', at=at('2026-10-30T12:00'))
        mc.card_dead(self.data, '5542', 'replaced by 2342', at=at('2026-11-01T12:00'))
        self.assertEqual(mc.dead_cards(self.data), {'5542': {'since': '2026-10-30T12:00:00+04:00',
                                                           'note': 'replaced by 2342'}})
        self.assertEqual((self.data / 'cards.json').stat().st_mode & 0o777, 0o600)

    def test_invalid_cards_and_secret_notes_are_refused(self):
        for last4 in ('123', '12345', 'abcd', '１２３４', '4242424242424242'):
            with self.subTest(last4=last4), self.assertRaises(mc.CaseError) as err:
                mc.card_dead(self.data, last4, 'cancelled')
            self.assertNotIn(last4, str(err.exception))
        with self.assertRaises(mc.CaseError):
            mc.card_dead(self.data, '5542', 'password: secret123')
        self.assertFalse((self.data / 'cards.json').exists())


class Renewals(Base):
    text = 'Your ElevenLabs Pro plan will renew on 11 Nov 2026 for USD 118.80 using card ending in 5542'

    def test_wording_currency_date_and_card_forms(self):
        rows = [
            ('will renew on', 'USD 118.80', '11 Nov 2026', 'ending in 5542', 'USD'),
            ('renews on', '$118.80', '2026-11-11', 'ending 5542', 'USD'),
            ('auto-renew on', 'AED 118.80', '11/11/2026', '•••• 5542', 'AED'),
            ('auto-renewal on', 'AED 118.80', '11 November 2026', '••••5542', 'AED'),
            ('next billing date:', '118.80 EUR', 'November 11, 2026', '****5542', 'EUR'),
            ('will be charged GBP 118.80 on', 'GBP 118.80', '11th November 2026', 'ending in 5542', 'GBP'),
            ('subscription renewal on', 'USD 118.80', '11-11-2026', 'ending 5542', 'USD'),
        ]
        for wording, money, date, card, currency in rows:
            with self.subTest(wording=wording, money=money, date=date, card=card):
                notice = mc.renewal(f'Your ElevenLabs Pro plan {wording} {date} for {money} using card {card}')
                self.assertEqual(notice, {'merchant': 'ElevenLabs', 'amount': '118.80', 'currency': currency,
                                          'date': '2026-11-11', 'last4': '5542'})

    def test_subject_and_sender_merchant_forms(self):
        for text, sender, expected in ((f'Subscription renewal {self.text}', '', 'ElevenLabs'),
                             ('Your subscription will renew on 11 Nov 2026 for USD 118.80; card ending 5542',
                              'ElevenLabs <billing@elevenlabs.io>', 'elevenlabs.io'),
                             ('Next billing date: 11 Nov 2026. USD 118.80; card ending 5542', 'billing@elevenlabs.io', 'elevenlabs.io')):
            with self.subTest(text=text):
                self.assertEqual(mc.renewal(text, sender)['merchant'], expected)

    def test_generic_merchant_labels_use_sender_and_keep_different_merchants_separate(self):
        rows = [
            ('Subscription renewal', 'Your subscription will renew', 'ElevenLabs <billing@elevenlabs.io>', 'elevenlabs.io'),
            ('Subscription renewal', 'Your subscription will renew', 'Acme <billing@acme.example>', 'acme.example'),
            ('Your subscription', 'Your plan will renew', 'ElevenLabs <billing@elevenlabs.io>', 'elevenlabs.io'),
            ('Membership renewal', 'Your membership will renew', 'ElevenLabs <billing@elevenlabs.io>', 'elevenlabs.io'),
            ('Subscription renewal', 'Your subscription will renew', 'billing@elevenlabs.io', 'elevenlabs.io'),
        ]
        mc.card_dead(self.data, '5542', 'cancelled')
        for subject, prefix, sender, merchant in rows:
            with self.subTest(subject=subject, prefix=prefix, sender=sender):
                text = prefix + ' on 11 Nov 2026 for USD 118.80 using card ending in 5542'
                notice = mc.renewal(text, sender, subject=subject)
                self.assertEqual(notice['merchant'], merchant)
                mc.renewal_case(self.data, notice, 'mail:merchant')
        self.assertEqual({c['id'] for c in mc.load(self.data)['cases']},
                         {'renewal-acme-example-2026-11-11', 'renewal-elevenlabs-io-2026-11-11'})

    def test_billing_labels_and_sender_subdomains_keep_vendor_identities_separate(self):
        mc.card_dead(self.data, '5542', 'cancelled')
        labels = ('monthly', 'annual', 'yearly', 'quarterly', 'weekly', 'daily', 'trial', 'current',
                  'existing', 'active', 'paid', 'next', 'new', 'personal', 'unlimited', 'Pro')
        senders = ('billing@notifications.elevenlabs.io', 'billing@notifications.acme.example')
        for label in labels:
            for sender in senders:
                with self.subTest(label=label, sender=sender):
                    notice = mc.renewal(f'Your {label} subscription will renew on 11 Nov 2026 '
                                        'for USD 118.80 using card ending in 5542', sender)
                    self.assertEqual(notice['merchant'], sender.split('@')[1])
                    mc.renewal_case(self.data, notice, 'mail:label')
        self.assertEqual(len(mc.load(self.data)['cases']), 2)
        for vendor in ('elevenlabs', 'acme'):
            domain = 'notifications.this-is-a-very-long-shared-prefix.' + vendor + '.example'
            notice = mc.renewal(self.text.replace('ElevenLabs Pro', 'Pro'), 'billing@' + domain)
            self.assertEqual(notice['merchant'], domain)
            case = mc.renewal_case(self.data, notice, 'mail:long')
            self.assertTrue(mc.ID.fullmatch(case['id']))
        self.assertEqual(len(mc.load(self.data)['cases']), 4)

    def test_trailing_cancellation_and_one_off_charge_context_are_not_renewals(self):
        for date in ('11 Nov 2026', '2026-11-11', 'November 11, 2026'):
            for ending in ('has been cancelled', 'was canceled', 'is cancelled', 'has been disabled', 'was turned off'):
                with self.subTest(ending=ending, date=date):
                    text = (f'Your subscription renewal on {date} for USD 1,118.80 '
                            f'using card ending in 5542 {ending}.')
                    self.assertIsNone(mc.renewal(text, 'ElevenLabs'))
        for purpose in ('hotel reservation', 'flight booking', 'one-off purchase', 'payment plan', 'installment'):
            with self.subTest(purpose=purpose):
                self.assertIsNone(mc.renewal('You will be charged USD 118.80 on 11 Nov 2026 '
                                            f'for your {purpose} using card ending in 5542.', 'Acme'))
        for purpose in ('subscription', 'membership', 'recurring service', 'Pro plan'):
            with self.subTest(purpose=purpose):
                self.assertIsNotNone(mc.renewal('You will be charged USD 118.80 on 11 Nov 2026 '
                                               f'for your {purpose} using card ending in 5542.', 'Acme'))

    def test_tier_only_plan_labels_use_the_sender_instead_of_merging_merchants(self):
        mc.card_dead(self.data, '5542', 'cancelled')
        for tier in ('Pro', 'Plus', 'Premium', 'Basic', 'Business', 'Starter', 'Standard',
                     'Enterprise', 'Free', 'Team', 'Individual', 'Family', 'Pro Plus'):
            for merchant in ('ElevenLabs', 'Acme'):
                with self.subTest(tier=tier, merchant=merchant):
                    text = f'Your {tier} plan will renew on 11 Nov 2026 for USD 118.80 using card ending in 5542'
                    notice = mc.renewal(text, f'{merchant} <billing@{merchant.lower()}.example>')
                    self.assertEqual(notice['merchant'], merchant.lower() + '.example')
                    mc.renewal_case(self.data, notice, 'mail:tier')
        self.assertEqual({c['id'] for c in mc.load(self.data)['cases']},
                         {'renewal-elevenlabs-example-2026-11-11', 'renewal-acme-example-2026-11-11'})

    def test_generic_sender_display_names_and_subdomain_body_labels_never_merge_vendors(self):
        mc.card_dead(self.data, '5542', 'cancelled')
        for label in ('Notifications', 'Billing', 'Account updates', 'Support', 'No reply'):
            for vendor in ('elevenlabs', 'acme'):
                with self.subTest(label=label, vendor=vendor):
                    domain = f'notifications.{vendor}.example'
                    sender = f'{label} <billing@{domain}>'
                    for prefix in ('Your subscription', 'Your Notifications plan'):
                        text = prefix + ' will renew on 11 Nov 2026 for USD 118.80 using card ending in 5542'
                        notice = mc.renewal(text, sender)
                        self.assertEqual(notice['merchant'], domain)
                        case = mc.renewal_case(self.data, notice, 'mail:display')
                        if case:
                            mc.close(self.data, case['id'], 'cancelled')
        self.assertEqual(len(mc.load(self.data)['cases']), 2)

    def test_negative_contractions_are_rejected_even_with_a_dated_billing_subject(self):
        for wording in ("doesn't auto-renew", 'doesn’t auto-renew', "don't auto-renew", 'don’t auto-renew',
                        "isn't going to be auto-renewed", "won't be renewed", "can't automatically renew",
                        "wouldn't auto-renew", "shouldn't auto-renew", "hasn't been auto-renewed",
                        "doesn't normally auto-renew", "won't automatically be renewed",
                        "isn't presently going to automatically be renewed"):
            with self.subTest(wording=wording):
                self.assertIsNone(mc.renewal(self.text.replace('will renew', wording), 'ElevenLabs',
                                             subject='Next billing date: 11 Nov 2026'))

    def test_mailbox_identity_ignores_special_characters_in_display_names(self):
        mc.card_dead(self.data, '5542', 'cancelled')
        displays = ('"Notifications@Work"', '"Acme@Billing"', '"Billing <Status>"',
                    r'"Support \"Team\""', '"Account, Billing"', 'Notifications')
        for display in displays:
            for vendor in ('elevenlabs', 'acme'):
                with self.subTest(display=display, vendor=vendor):
                    domain = f'notifications.{vendor}.example'
                    notice = mc.renewal(self.text.replace('ElevenLabs Pro plan', 'subscription'),
                                        f'{display} <billing@{domain}>')
                    self.assertEqual(notice['identity'], domain)
                    self.assertEqual(notice['merchant'], domain)
                    mc.renewal_case(self.data, notice, 'mail:display')
        self.assertEqual(len(mc.load(self.data)['cases']), 2)

    def test_email_and_sms_replays_are_idempotent_in_both_arrival_orders(self):
        generic = self.text.replace('ElevenLabs Pro plan', 'subscription')
        n = 0
        for domain in ('elevenlabs.io', 'notifications.elevenlabs.io', 'notifications.elevenlabs.co.uk'):
            for email_first in (False, True):
                for closed in (False, True):
                    with self.subTest(domain=domain, email_first=email_first, closed=closed):
                        n += 1
                        data = self.tmp / f'order-{n}'
                        mc.card_dead(data, '5542', 'cancelled')
                        email = mc.renewal(generic, f'billing@{domain}')
                        sms = mc.renewal(self.text, 'ElevenLabs')
                        notices = (email, sms) if email_first else (sms, email)
                        case = mc.renewal_case(data, notices[0], 'mail:first')
                        if closed:
                            mc.close(data, case['id'], 'cancelled')
                        self.assertIsNone(mc.renewal_case(data, notices[1], 'sms:copy'))
                        tracked = mc.renewal_case(data, notices[1], 'sms:copy', include_existing=True)
                        self.assertEqual(tracked['id'], case['id'])
                        self.assertEqual(tracked['status'], 'closed' if closed else 'open')
                        self.assertEqual(len(mc.load(data)['cases']), 1)

    def test_off_states_allow_status_modifiers_but_do_not_consume_discounts(self):
        for state in ('off', 'is off', 'is currently off', 'is presently off', 'is still off', 'is now off',
                      'is temporarily off', 'has already been set to off', ': OFF', '= off'):
            with self.subTest(state=state):
                text = self.text + '. Auto-renewal ' + state
                self.assertIsNone(mc.renewal(text, subject='Next billing date: 11 Nov 2026'))
        self.assertIsNotNone(mc.renewal(self.text + '. Auto-renewal gives 20% off'))

    def test_renewal_status_requires_an_actual_state_instead_of_instructions_or_card_context(self):
        rows = [
            ('Auto-renew can be disabled in Settings', True),
            ('Auto-renewal may be deactivated in Settings', True),
            ('You can turn off auto-renewal in Settings', True),
            ('To cancel, ensure auto-renewal is disabled in Settings', True),
            ('Please ensure auto-renewal is disabled in Settings to cancel', True),
            ('Please make sure your subscription is cancelled to stop billing', True),
            ('Please keep auto-renewal off if you want to cancel', True),
            ('Please ensure your subscription is cancelled and auto-renewal is disabled in Settings to stop billing', True),
            ('Please make sure your subscription is cancelled and auto-renewal is disabled', True),
            ('Please ensure your subscription is cancelled, and auto-renewal is disabled in Settings', True),
            ('You can ensure your subscription is cancelled and auto-renewal is off', True),
            ('If the renewal payment fails, your subscription will be cancelled', True),
            ('Your subscription will be cancelled if the renewal payment fails', True),
            ('Your subscription is disabled if the renewal payment fails', True),
            ('If the renewal payment fails, your subscription is disabled', True),
            ('Your subscription is disabled, if the renewal payment fails', True),
            ('Your subscription is disabled automatically, if the renewal payment fails', True),
            ('Your subscription is disabled immediately, unless payment succeeds', True),
            ('Your subscription is disabled temporarily, if payment fails', True),
            ('Unless payment succeeds, your membership will be canceled', True),
            ('Your card is cancelled; update your payment method before renewal', True),
            ('Your card has been deactivated; update it before your subscription renews', True),
            ('Your card was switched off; auto-renewal is still enabled', True),
            ('Your subscription is active, your card is cancelled', True),
            ('Your subscription is active but your card is cancelled', True),
            ('Your subscription is active and your card has been disabled', True),
            ('Your subscription is not cancelled', True),
            ('Your subscription has not been disabled', True),
            ('Is auto-renewal disabled?', True),
            ('Your subscription is cancelled', False),
            ('Your subscription has already been cancelled', False),
            ('Your membership was canceled', False),
            ('Auto-renewal has been disabled', False),
            ('Auto-renewal is currently off', False),
            ('Auto-renewal has been switched off', False),
            ('You cancelled your subscription', False),
            ('You have disabled auto-renewal', False),
            ('Your subscription is cancelled, but you can start it again', False),
            ('Your subscription has been cancelled, contact support if this was a mistake', False),
            ('Your subscription has been cancelled, and contact support if this was a mistake', False),
            ('Your subscription has been cancelled, please contact support if this was a mistake', False),
            ('Your subscription has been cancelled; contact support if this was a mistake', False),
            ('Your subscription has been cancelled, email us if you need help', False),
            ('Your subscription has been cancelled, reach out if this was a mistake', False),
            ('Please note: your subscription is cancelled', False),
            ('Please note your subscription has been cancelled', False),
            ('Please be advised: auto-renewal is disabled', False),
            ('Please be informed: auto-renewal is currently off', False),
            ('We have cancelled your subscription', False),
            ('We canceled your subscription', False),
            ('They have deactivated your membership', False),
            ('ElevenLabs disabled your subscription', False),
            ('We have not cancelled your subscription', True),
            ('We may have cancelled your subscription', True),
            ('If payment fails, we will cancel your subscription', True),
            ('You will not be charged', False),
            ('You will never be billed', False),
            ('You will not be charged if payment fails', True),
            ('Your card is cancelled, and your subscription has been cancelled', False),
            ('Your card is cancelled and your subscription is disabled', False),
            ('Your card is cancelled; your subscription has been cancelled', False),
            ('Your card is cancelled, and your subscription is active', True),
            ('You can contact support because your subscription has been cancelled', False),
            ('You may visit Settings because auto-renewal is disabled', False),
            ('Your subscription has been cancelled, and you can contact support', False),
            ('If you need help, you can contact support because your subscription has been cancelled', False),
            ('Unless you can log in, contact support because auto-renewal has been disabled', False),
            ('Contact support if you need help because your membership has been cancelled', False),
        ]
        for suffix, active in rows:
            with self.subTest(suffix=suffix):
                notice = mc.renewal(self.text + '. ' + suffix, 'ElevenLabs')
                if active:
                    self.assertEqual(notice['date'], '2026-11-11')
                    self.assertEqual(notice['last4'], '5542')
                else:
                    self.assertIsNone(notice)

    def test_ambiguous_sms_domain_alias_does_not_choose_a_closed_vendor(self):
        mc.card_dead(self.data, '5542', 'cancelled')
        for domain in ('elevenlabs.io', 'alerts.elevenlabs.example'):
            notice = mc.renewal(self.text.replace('ElevenLabs Pro plan', 'subscription'), 'billing@' + domain)
            case = mc.renewal_case(self.data, notice, 'mail:vendor')
            mc.close(self.data, case['id'], 'cancelled')
        with patch.object(mc, 'write_json', wraps=mc.write_json) as write:
            self.assertIsNone(mc.renewal_case(self.data, mc.renewal(self.text, 'ElevenLabs'),
                                             'sms:ambiguous', include_existing=True))
        write.assert_not_called()
        self.assertEqual(len(mc.load(self.data)['cases']), 2)

    def test_sms_first_binds_only_one_email_identity_and_does_not_hide_the_next_domain(self):
        mc.card_dead(self.data, '5542', 'cancelled')
        sms = mc.renewal(self.text, 'ElevenLabs')
        first = mc.renewal_case(self.data, sms, 'sms:first')
        mc.close(self.data, first['id'], 'cancelled')
        generic = self.text.replace('ElevenLabs Pro plan', 'subscription')
        first_email = mc.renewal(generic, 'billing@elevenlabs.io')
        tracked = mc.renewal_case(self.data, first_email, 'mail:first', include_existing=True)
        self.assertEqual(tracked['id'], first['id'])
        self.assertEqual(tracked['status'], 'closed')
        self.assertEqual(tracked['renewal_identity'], 'elevenlabs.io')
        self.assertEqual(tracked['history'][-1]['source'], 'mail:first')
        for domain in ('alerts.elevenlabs.example', 'elevenlabs.example'):
            with self.subTest(domain=domain):
                notice = mc.renewal(generic, 'billing@' + domain)
                case = mc.renewal_case(self.data, notice, 'mail:other')
                self.assertEqual(case['status'], 'open')
                self.assertEqual(case['renewal_identity'], domain)
                self.assertNotEqual(case['id'], first['id'])
        with patch.object(mc, 'write_json', wraps=mc.write_json) as write:
            self.assertIsNone(mc.renewal_case(self.data, first_email, 'mail:repeat'))
        write.assert_not_called()

    def test_readable_name_matches_bind_identity_and_preserve_closed_replays(self):
        for n, merchant in enumerate(('Boat.dev', 'Acme.io', 'Vendor-Service', 'Vendor_Service', 'Vendor Service')):
            with self.subTest(merchant=merchant):
                data = self.tmp / f'name-binding-{n}'
                mc.card_dead(data, '5542', 'cancelled')
                notice = dict(mc.renewal(self.text), merchant=merchant)
                case = mc.renewal_case(data, notice, 'sms:first')
                mc.close(data, case['id'], 'cancelled')
                first_email = dict(notice, identity=merchant.lower())
                tracked = mc.renewal_case(data, first_email, 'mail:first', include_existing=True)
                self.assertEqual(tracked['renewal_identity'], merchant.lower())
                self.assertEqual(tracked['history'][-1]['source'], 'mail:first')
                self.assertEqual(tracked['status'], 'closed')
                other = dict(notice, merchant=merchant.replace('.', '') + '.com',
                             identity=merchant.lower().replace('.', '') + '.com')
                second = mc.renewal_case(data, other, 'mail:other')
                self.assertEqual(second['status'], 'open')
                self.assertNotEqual(second['id'], case['id'])
                self.assertIsNone(mc.renewal_case(data, first_email, 'mail:repeat'))
                self.assertEqual(len(mc.load(data)['cases']), 2)

    def test_explicit_negative_billing_verbs_do_not_create_renewals_from_a_subject_date(self):
        for wording in ('will not be charged', "won't be charged", 'won’t be charged', 'will never be charged',
                        'will not be billed', 'will not be debited', 'is not going to be charged',
                        "isn't currently going to be billed", 'will no longer be charged', 'is not charged'):
            with self.subTest(wording=wording):
                text = f'Your ElevenLabs Pro subscription {wording} USD 118.80 on 11 Nov 2026 using card ending in 5542'
                self.assertIsNone(mc.renewal(text, 'ElevenLabs', subject='Next billing date: 11 Nov 2026'))

    def test_timed_no_charge_statements_preserve_the_stated_renewal(self):
        rows = [
            ('You will not be charged until your renewal date', True),
            ('You will not be charged before this date', True),
            ('You will not be billed again until then', True),
            ("You won't be charged until then", True),
            ('You won’t be charged before your renewal date', True),
            ('You will not be debited again before this date', True),
            ('You will not be billed at all until then', True),
            ('You will not be charged anything before this date', True),
            ('You will not be charged USD 118.80 before your renewal date', True),
            ('You will not be charged until 11 Nov 2026', True),
            ('You will not be billed again, until then', True),
            ('You will not be billed prior to your renewal date', True),
            ('Until then, you will not be charged', True),
            ('Before this date you will not be billed again', True),
            ('Until your renewal date, you will not be charged', True),
            ('Before 11 Nov 2026, you will not be billed', True),
            ('Before contacting support, please note that you will not be charged again', False),
            ('Before updating your card, please note that you will not be billed again', False),
            ('Until you contact support, please note that you will not be charged again', False),
            ('Before the renewal date, contact support, please note that you will not be charged again', False),
            ('You will not be charged again, before contacting support please read our help page', False),
            ('You will not be billed again, before updating your card read our instructions', False),
            ('You will not be debited, until you contact support please read the FAQ', False),
            ('You will not be charged before contacting support please read the FAQ', False),
            ('You will not be charged again, before tomorrow please read our help page', False),
            ('You will not be billed again, until next month please contact support', False),
            ('You will not be debited, before your renewal date update your card', False),
            ('You will not be charged again, before tomorrow', True),
            ('You will not be billed again, until next month', True),
            ('You will not be charged until your renewal date, please read our help page', True),
            ('You will not be charged until your next billing cycle', True),
            ('You will not be billed before the next renewal date', True),
            ('You will not be billed before tomorrow', True),
            ('You will not be billed again until next month', True),
            ('You will not be charged', False),
            ('You will not be billed again', False),
            ('You will not be debited', False),
            ('Your subscription is cancelled before this date', False),
            ('Auto-renewal is disabled until then', False),
            ('You will not be charged and your subscription is cancelled before this date', False),
            ('You will not be billed; contact support before this date', False),
        ]
        for suffix, active in rows:
            with self.subTest(suffix=suffix):
                notice = mc.renewal(self.text + '. ' + suffix, 'ElevenLabs')
                self.assertEqual(notice is not None, active)
                if notice:
                    self.assertEqual(notice['date'], '2026-11-11')
                    self.assertEqual(notice['last4'], '5542')

    def test_long_senderless_slug_collisions_keep_distinct_exact_names(self):
        mc.card_dead(self.data, '5542', 'cancelled')
        ids = []
        for merchant in ('Notifications.Very.Long.Vendor.Service', 'Notifications-Very-Long-Vendor-Service',
                         'Notifications_Very_Long_Vendor_Service', 'Notifications Very Long Vendor Service'):
            with self.subTest(merchant=merchant):
                notice = dict(mc.renewal(self.text), merchant=merchant)
                case = mc.renewal_case(self.data, notice, 'mail:long')
                ids.append(case['id'])
                self.assertTrue(mc.ID.fullmatch(case['id']))
                self.assertIsNone(mc.renewal_case(self.data, notice, 'mail:copy'))
                mc.close(self.data, case['id'], 'cancelled')
                self.assertIsNone(mc.renewal_case(self.data, notice, 'mail:closed-copy'))
        self.assertEqual(len(set(ids)), 4)

    def test_sender_identity_is_stable_across_wording_and_preserves_domain_punctuation(self):
        mc.card_dead(self.data, '5542', 'cancelled')
        sender = 'ElevenLabs <billing@elevenlabs.io>'
        named, generic = mc.renewal(self.text, sender), mc.renewal(self.text.replace('ElevenLabs Pro plan', 'subscription'), sender)
        self.assertEqual(named['identity'], generic['identity'])
        first = mc.renewal_case(self.data, named, 'mail:named')
        self.assertEqual(first['id'], 'renewal-elevenlabs-2026-11-11')
        mc.update(self.data, first['id'], {'deadline': '2026-11-12'}, source='mail:changed-date')
        self.assertIsNone(mc.renewal_case(self.data, generic, 'mail:generic'))
        mc.close(self.data, first['id'], 'cancelled')
        with patch.object(mc, 'write_json', wraps=mc.write_json) as write:
            self.assertIsNone(mc.renewal_case(self.data, generic, 'mail:generic'))
            tracked = mc.renewal_case(self.data, generic, 'mail:generic', include_existing=True)
        write.assert_not_called()
        self.assertEqual(tracked['id'], first['id'])
        self.assertEqual(tracked['status'], 'closed')
        self.assertIsNone(mc.renewal_case(self.data, mc.renewal(self.text, 'ElevenLabs'), 'sms:copy'))
        ids = []
        for domain in ('notifications.elevenlabs.io', 'notifications-elevenlabs.io',
                       'notifications.elevenlabs-io.example', 'notifications-elevenlabs.io.example'):
            with self.subTest(domain=domain):
                notice = mc.renewal(self.text.replace('ElevenLabs Pro plan', 'subscription'), 'billing@' + domain)
                case = mc.renewal_case(self.data, notice, 'mail:domain')
                ids.append(case['id'])
                mc.close(self.data, case['id'], 'cancelled')
                self.assertIsNone(mc.renewal_case(self.data, notice, 'mail:domain-copy'))
        self.assertEqual(len(set(ids)), 4)
        self.assertEqual(len(mc.load(self.data)['cases']), 5)
        for merchant in ('Vendor.Name', 'Vendor-Name'):
            notice = dict(mc.renewal(self.text), merchant=merchant)
            case = mc.renewal_case(self.data, notice, 'mail:no-sender')
            self.assertIsNone(mc.renewal_case(self.data, notice, 'mail:copy'))
            mc.close(self.data, case['id'], 'cancelled')
            self.assertIsNone(mc.renewal_case(self.data, notice, 'mail:closed-copy'))
        self.assertEqual(len(mc.load(self.data)['cases']), 7)

    def test_one_off_charge_guard_applies_to_all_subject_markers(self):
        for subject in ('', 'Next billing date', 'Next billing date: 11 Nov 2026', 'Billing information'):
            for purpose in ('hotel reservation', 'flight booking', 'payment plan', 'installment', 'one-off purchase'):
                with self.subTest(subject=subject, purpose=purpose):
                    text = f'You will be charged USD 118.80 on 11 Nov 2026 for your {purpose} using card ending in 5542'
                    self.assertIsNone(mc.renewal(text, 'Acme', subject=subject))

    def test_negative_auto_renew_wording_is_not_an_upcoming_renewal(self):
        for wording in ('will not auto-renew', "won't auto-renew", 'won’t auto-renew',
                        'will no longer auto-renew', 'does not auto-renew', 'does no longer auto-renew',
                        'will never auto-renew', 'never auto-renew',
                        'will not be automatically renewed', "won't be auto-renewed", 'is not set to auto-renew',
                        'will not auto renew', 'will not autorenew', 'will not automatically renew'):
            with self.subTest(wording=wording):
                self.assertIsNone(mc.renewal(self.text.replace('will renew', wording)))

    def test_negative_nominal_renewal_labels_and_off_states(self):
        for wording in ('has no auto-renewal', 'is without auto-renewal', 'has auto-renewal switched off',
                        'has auto-renewal deactivated'):
            with self.subTest(wording=wording):
                self.assertIsNone(mc.renewal(self.text.replace('will renew', wording), 'ElevenLabs',
                                             subject='Next billing date: 11 Nov 2026'))

    def test_date_must_belong_to_the_renewal_clause(self):
        rows = [
            ('will renew on 11 Nov 2026', 'This notice was sent on 8 Nov 2026.', '2026-11-11'),
            ('next billing date: 11 Nov 2026', 'Last billed on 8 Nov 2026.', '2026-11-11'),
            ('subscription renewal is scheduled for 11 Nov 2026', '', '2026-11-11'),
            ('will be charged USD 118.80 on 11 Nov 2026', 'This notice was sent on 8 Nov 2026.', '2026-11-11'),
            ('will renew for $118.80 on 11 Nov 2026', '', '2026-11-11'),
            ('will renew soon', 'This notice was sent on 8 Nov 2026.', None),
            ('will renew soon', 'Offer expires on 8 Nov 2026.', None),
            ('will renew soon', 'Your card expires on 8 Nov 2026.', None),
            ('will renew soon', 'Last billed on 8 Nov 2026.', None),
            ('will renew soon', 'Previous subscription renewal on 8 Nov 2026.', None),
            ('will be charged soon', 'This notice was sent on 8 Nov 2026.', None),
        ]
        for wording, unrelated, expected in rows:
            with self.subTest(wording=wording, unrelated=unrelated):
                notice = mc.renewal(f'Your ElevenLabs Pro plan {wording} for USD 118.80 '
                                    f'using card ending in 5542. {unrelated}')
                self.assertEqual(notice['date'] if notice else None, expected)

    def test_incomplete_ambiguous_and_cancelled_notices_do_not_match(self):
        rows = [
            'renew now and save 20%', self.text.replace('using card ending in 5542', ''),
            self.text.replace('USD 118.80', '118.80'), self.text.replace('11 Nov 2026', 'soon'),
            self.text.replace('USD 118.80', 'USD 4242424242424242'),
            self.text.replace('USD 118.80', 'USD 9999999999999999'),
            self.text.replace('11 Nov 2026', '31 Nov 2026'),
            self.text + ' or USD 100.00', self.text + ' or card ending in 2342',
            self.text + ' or on 12 Nov 2026', self.text + '. Your subscription is cancelled',
            self.text.replace('will renew', 'will not renew'), self.text + '. Auto-renew is disabled',
            self.text.replace('will renew', 'auto-renewal was turned off; originally scheduled'),
            self.text.replace('will renew', 'subscription renewal was canceled; originally scheduled'),
            self.text.replace('will renew', 'subscription renewal has been cancelled; originally scheduled'),
        ]
        for text in rows:
            with self.subTest(text=text):
                self.assertIsNone(mc.renewal(text))

    def test_dead_card_creates_one_case_even_after_closure_and_live_cards_do_nothing(self):
        notice = mc.renewal(self.text)
        self.assertIsNone(mc.renewal_case(self.data, notice, 'mail:abc', at('2026-11-08T12:00')))
        mc.card_dead(self.data, '5542', 'cancelled')
        case = mc.renewal_case(self.data, notice, 'mail:abc', at('2026-11-08T12:00'))
        self.assertEqual(case['id'], 'renewal-elevenlabs-2026-11-11')
        self.assertEqual((case['merchant'], case['amount'], case['currency'], case['deadline'], case['who']),
                         ('ElevenLabs', '118.80', 'USD', '2026-11-11', 'Abdullah'))
        self.assertEqual(case['state'], 'renews 2026-11-11 on dead card 5542')
        self.assertEqual(case['next'], 'move the subscription to a live card or cancel it')
        self.assertEqual(case['history'][0]['source'], 'mail:abc')
        self.assertIn('source: mail:abc', case['history'][0]['text'])
        with patch.object(mc, 'write_json', wraps=mc.write_json) as write:
            self.assertIsNone(mc.renewal_case(self.data, notice, 'sms:copy'))
            self.assertEqual(mc.renewal_case(self.data, notice, 'sms:copy', include_existing=True)['id'], case['id'])
        write.assert_not_called()
        mc.close(self.data, case['id'], 'moved to live card')
        self.assertIsNone(mc.renewal_case(self.data, notice, 'mail:abc'))
        self.assertIsNone(mc.renewal_case(self.data, mc.renewal(self.text.replace('5542', '2342')), 'mail:live'))
        self.assertEqual(len(mc.load(self.data)['cases']), 1)
        self.assertEqual(mc.load(self.data)['cases'][0]['status'], 'closed')


class CardSwap(Base):
    def test_card_swap_rewrites_next_on_open_cases_naming_the_old_card(self):
        self.case('stale', merchant='Shop 1', next_action='switch to 7572 once it clears')
        self.case('acme', merchant='Shop 2', next_action='dispute on card 5542')
        self.case('done', merchant='Shop 3', next_action='card 5542 charge')
        mc.close(self.data, 'done', outcome='refunded')
        changes = mc.card_swap(self.data, '5542', '2342', also=('7572',), at=at('2026-10-30T18:00'),
                               cases=('stale', 'acme'))
        self.assertEqual(sorted(c['id'] for c in changes), ['acme', 'stale'])
        book = mc.load(self.data)
        by_id = {c['id']: c for c in book['cases']}
        self.assertEqual(by_id['stale']['next'], 'switch to 2342 once it clears')
        self.assertEqual(by_id['acme']['next'], 'dispute on card 2342')
        self.assertIn('card swap 5542->2342: next updated', by_id['acme']['history'][-1]['text'])
        self.assertEqual(by_id['done']['next'], 'card 5542 charge')
        self.assertEqual(by_id['done']['status'], 'closed')
        self.assertEqual(by_id['done']['history'][-1]['text'], 'closed: refunded')
        self.assertEqual(set(mc.dead_cards(self.data)), {'5542', '7572'})

    def test_dry_run_writes_nothing(self):
        self.case('acme', merchant='Shop 4', next_action='dispute on card 5542')
        before = mc.load(self.data)
        changes = mc.card_swap(self.data, '5542', '2342', dry_run=True)
        self.assertEqual(changes[0]['after'], 'dispute on card 2342')
        self.assertEqual(mc.load(self.data), before)
        self.assertEqual(mc.dead_cards(self.data), {})

    def test_case_naming_old_card_only_in_state_is_listed_with_after_none(self):
        self.case('acme', merchant='Shop 5', state='card 5542 declined', next_action='dispute on the card')
        changes = mc.card_swap(self.data, '5542', '2342', cases=())
        self.assertEqual(changes, [{'id': 'acme', 'before': 'dispute on the card', 'after': None}])
        self.assertEqual(mc.find(mc.load(self.data), 'acme')['next'], 'dispute on the card')

    def test_four_digit_token_inside_a_longer_number_is_not_replaced(self):
        self.case('acme', merchant='Shop 6', reference='ORD-155420', next_action='dispute on card 5542')
        self.case('other', merchant='Shop 7', reference='ORD-155420', next_action='wait for refund')
        changes = mc.card_swap(self.data, '5542', '2342', cases=('acme',))
        self.assertEqual([c['id'] for c in changes], ['acme'])
        self.assertEqual(mc.find(mc.load(self.data), 'acme')['next'], 'dispute on card 2342')
        self.assertEqual(mc.find(mc.load(self.data), 'acme')['reference'], 'ORD-155420')

    def test_bad_last4_is_refused(self):
        self.case('acme', merchant='Shop 8', next_action='dispute on card 5542')
        with self.assertRaisesRegex(mc.CaseError, 'exactly the last 4 digits'):
            mc.card_swap(self.data, '5542', '23421')
        with self.assertRaisesRegex(mc.CaseError, 'exactly the last 4 digits'):
            mc.card_swap(self.data, '5542', '2342', also=('75',))

    def test_rejected_last4_never_echoes_the_value(self):
        full = '4242424242424242'
        cases_argv = {
            '--old': ['card-swap', '--old', full, '--new', '2342'],
            '--new': ['card-swap', '--old', '5542', '--new', full],
            '--also': ['card-swap', '--old', '5542', '--new', '2342', '--also', full],
        }
        for flag, argv in cases_argv.items():
            out, err = io.StringIO(), io.StringIO()
            with patch.object(mc, 'DATA', self.data), redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(mc.main(argv), 2)
            self.assertNotIn(full, err.getvalue() + out.getvalue(), flag)
            self.assertIn('exactly the last 4 digits', err.getvalue())
        with self.assertRaises(mc.CaseError) as ctx:
            mc.card_swap(self.data, full, '2342')
        self.assertNotIn(full, str(ctx.exception))

    def test_card_swap_output_redacts_full_card_numbers_in_dry_run_and_write(self):
        full = '4242 4242 4242 4242'
        self.case('acme', next_action='dispute on card 5542')
        self.case('ref', merchant='Other Shop', next_action='dispute on card 5542')
        # A hand-edited book can hold a card number in next, which add() would refuse.
        path = self.data / 'cases.json'
        book = json.loads(path.read_text())
        for case in book['cases']:
            if case['id'] == 'acme':
                case['next'] = f'dispute {full} on card 5542'
            else:
                case['id'] = f'ref-{full.replace(" ", "")}'
                case['state'] = 'card 5542 flagged'
        path.write_text(json.dumps(book))
        for dry in (True, False):
            out = io.StringIO()
            with patch.object(mc.charges, 'search', return_value=[]), patch.object(mc, 'DATA', self.data), redirect_stdout(out):
                mc.main(['card-swap', '--old', '5542', '--new', '2342'] + (['--dry-run'] if dry else []))
            text = out.getvalue()
            self.assertNotIn('4242', text.replace('[card number removed]', ''), f'dry={dry}')
            self.assertNotIn(full.replace(' ', ''), text, f'dry={dry}')
            self.assertIn('[card number removed]', text, f'dry={dry}')
            self.assertIn('2342', text, f'dry={dry}')

    def test_grouped_full_number_containing_the_old_last4_is_masked_after_the_swap(self):
        # 4242 5542 4242 0004 is Luhn-valid and has a group equal to the old last-4: the swap alone would make
        # it fail the Luhn check, so the display text must be redacted before the rewrite.
        full = '4242 5542 4242 0004'
        self.case('acme', next_action='dispute on card 5542')
        path = self.data / 'cases.json'
        book = json.loads(path.read_text())
        book['cases'][0]['next'] = f'pay {full} then 5542'
        path.write_text(json.dumps(book))
        for dry in (True, False):
            out = io.StringIO()
            with patch.object(mc.charges, 'search', return_value=[]), patch.object(mc, 'DATA', self.data), redirect_stdout(out):
                mc.main(['card-swap', '--old', '5542', '--new', '2342'] + (['--dry-run'] if dry else []))
            text = out.getvalue()
            for leaked in ('4242554242420004', '4242 5542 4242 0004', '4242 2342 4242 0004', '4242 2342'):
                self.assertNotIn(leaked, text, f'dry={dry}')
            self.assertIn("'pay [card number removed] then 5542' holds a card number or code", text, f'dry={dry}')

    def test_a_next_line_holding_a_full_number_is_left_as_stored_and_later_reads_stay_masked(self):
        # Rewriting a group of 4242 5542 4242 0004 would store a number that fails the Luhn check, so show,
        # list --json and the watcher would print it. The row is left as is; the other open case still moves.
        full = '4242 5542 4242 0004'
        self.case('acme', next_action='dispute on card 5542')
        self.case('other', merchant='Shop 2', next_action='retry on 5542')
        path = self.data / 'cases.json'
        book = json.loads(path.read_text())
        book['cases'][0]['next'] = f'pay {full} then 5542'
        path.write_text(json.dumps(book))
        out = io.StringIO()
        with patch.object(mc.charges, 'search', return_value=[]), patch.object(mc, 'DATA', self.data), redirect_stdout(out):
            mc.main(['card-swap', '--old', '5542', '--new', '2342', '--case', 'other'])
        self.assertIn('1 case(s) updated', out.getvalue())
        stored = mc.load(self.data)
        self.assertEqual(mc.find(stored, 'acme')['next'], f'pay {full} then 5542')
        self.assertEqual([h['text'] for h in mc.find(stored, 'acme')['history'] if 'card swap' in h['text']], [])
        self.assertEqual(mc.find(stored, 'other')['next'], 'retry on 2342')
        for args in (['show', 'acme'], ['list', '--json']):
            out = io.StringIO()
            with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
                mc.main(args)
            for leaked in ('4242 5542 4242 0004', '4242 2342 4242 0004', '4242554242420004', '4242234242420004'):
                self.assertNotIn(leaked, out.getvalue(), args)

    def test_cli_card_swap_prints_moves_and_dry_run_says_would_update(self):
        self.case('acme', merchant='Shop 9', next_action='dispute on card 5542')
        out, err = io.StringIO(), io.StringIO()
        with patch.object(mc, 'DATA', self.data), redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(mc.main(['card-swap', '--old', '5542', '--new', '2342', '--case', 'acme', '--dry-run']), 0)
        self.assertIn("acme: next 'dispute on card 5542' -> 'dispute on card 2342'", out.getvalue())
        self.assertIn('1 case(s) would update', out.getvalue())
        self.assertEqual(mc.find(mc.load(self.data), 'acme')['next'], 'dispute on card 5542')

    def run_card_swap(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(mc.charges, 'search', return_value=[]), patch.object(mc, 'DATA', self.data), redirect_stdout(out), redirect_stderr(err):
            code = mc.main(['card-swap', '--old', '5542', '--new', '2342', *args])
        return code, out.getvalue(), err.getvalue()

    def test_without_case_nothing_is_written(self):
        self.case('a', merchant='Shop A', next_action='retry on 5542')
        self.case('b', merchant='Shop B', next_action='retry on 5542')
        path = self.data / 'cases.json'
        before, st = path.read_bytes(), path.stat()
        with patch.object(mc, 'write_json', wraps=mc.write_json) as write:
            code, out, _ = self.run_card_swap()
        self.assertEqual(code, 0)
        self.assertEqual([c.args[0].name for c in write.call_args_list], ['cards.json'])
        self.assertIn('5542', mc.dead_cards(self.data))
        after = path.stat()
        self.assertEqual((path.read_bytes(), after.st_ino, after.st_mtime_ns), (before, st.st_ino, st.st_mtime_ns))
        self.assertIn("a: next 'retry on 5542' -> 'retry on 2342'", out)
        self.assertIn("b: next 'retry on 5542' -> 'retry on 2342'", out)
        self.assertIn('2 case(s) would change; cases unchanged', out)

    def test_case_writes_only_the_picked_cases(self):
        self.case('a', merchant='Shop A', next_action='retry on 5542')
        self.case('b', merchant='Shop B', next_action='retry on 5542')
        code, out, _ = self.run_card_swap('--case', 'a')
        self.assertEqual(code, 0)
        book = mc.load(self.data)
        self.assertEqual(mc.find(book, 'a')['next'], 'retry on 2342')
        self.assertIn('card swap 5542->2342: next updated', mc.find(book, 'a')['history'][-1]['text'])
        self.assertEqual(mc.find(book, 'b')['next'], 'retry on 5542')
        self.assertEqual([h for h in mc.find(book, 'b')['history'] if 'card swap' in h['text']], [])
        self.assertIn("b: next 'retry on 5542' -> 'retry on 2342' (not picked)", out)
        self.assertIn('1 case(s) updated', out)

    def test_a_case_with_nothing_to_swap_is_refused_and_nothing_is_written(self):
        self.case('a', merchant='Shop A', next_action='retry on 5542')
        self.case('c', merchant='Shop C', next_action='retry on 5542')
        self.case('d', merchant='Shop D', state='card 5542 declined', next_action='retry later')
        mc.close(self.data, 'c', outcome='refunded')
        before = (self.data / 'cases.json').read_bytes()
        for pick in ('c', 'd', 'nope'):
            code, _, err = self.run_card_swap('--case', pick, '--case', 'a')
            self.assertEqual(code, 2, pick)
            self.assertIn('has nothing to swap', err, pick)
            self.assertEqual((self.data / 'cases.json').read_bytes(), before, pick)
            self.assertEqual(mc.dead_cards(self.data), {})

    def test_dry_run_with_case_writes_nothing(self):
        self.case('a', merchant='Shop A', next_action='retry on 5542')
        before = (self.data / 'cases.json').read_bytes()
        with patch.object(mc, 'write_json', wraps=mc.write_json) as write:
            code, out, _ = self.run_card_swap('--case', 'a', '--dry-run')
        self.assertEqual(code, 0)
        write.assert_not_called()
        self.assertEqual((self.data / 'cases.json').read_bytes(), before)
        self.assertIn('1 case(s) would update', out)


class Cli(Base):
    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(mc.charges, 'search', return_value=[]), patch.object(mc, 'DATA', self.data), patch.object(mc, 'WATCH_ROOT', self.root), \
                redirect_stdout(out), redirect_stderr(err), patch.object(mc.faulthandler, 'enable'), \
                patch.object(mc.faulthandler, 'dump_traceback_later'), \
                patch.object(mc.faulthandler, 'cancel_dump_traceback_later'):
            code = mc.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def test_deadline_change_cli_requires_evidence_and_accepts_source(self):
        self.case()
        before = (self.data / 'cases.json').read_bytes()
        code, out, err = self.run_cli('update', 'acme', '--deadline', '2026-10-28', '--because', 'x')
        self.assertEqual(code, 2)
        self.assertEqual(out, '')
        self.assertEqual(err.strip(), 'money-cases: deadline changes need --source (mail:, sms:, imessage: or statement:) '
                         'or --reply (his reply id); nothing was changed')
        self.assertEqual((self.data / 'cases.json').read_bytes(), before)
        self.assertEqual(self.run_cli('update', 'acme', '--deadline', '2026-10-28', '--source', 'mail:abc')[0], 0)
        self.assertEqual(mc.find(mc.load(self.data), 'acme')['history'][-1]['source'], 'mail:abc')

    def test_add_and_update_due_cli(self):
        code, out, err = self.run_cli('add', 'acme', '--merchant', 'Acme', '--amount', '120.50', '--currency', 'AED',
                                    '--state', 'refund asked', '--next', 'follow up', '--deadline', '2026-11-02',
                                    '--who', 'Abdullah', '--due', '2026-11-01')
        self.assertEqual((code, err), (0, ''))
        self.assertIn('due Sun 1 Nov, follow-up Mon 2 Nov', out)
        path = self.data / 'cases.json'
        before = path.read_bytes()
        code, out, err = self.run_cli('update', 'acme', '--due', '2026-11-03', '--state', 'changed')
        self.assertEqual((code, out), (2, ''))
        self.assertIn('--because or --reply', err)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.run_cli('update', 'acme', '--due', '2026-11-03', '--because', 'merchant corrected it')[0], 0)
        self.assertIn('due Tue 3 Nov, follow-up Mon 2 Nov', self.run_cli('list')[1])
        self.assertEqual(json.loads(self.run_cli('show', 'acme')[1])['due'], '2026-11-03')
        self.assertEqual(self.run_cli('update', 'acme', '--due', '2026-11-04', '--reply', 'msg-1')[0], 0)
        self.assertEqual(json.loads(self.run_cli('list', '--json')[1])[0]['due'], '2026-11-04')

    def test_card_dead_cards_and_swap_cli(self):
        code, _, _ = self.run_cli('card-dead', '5542', '--note', 'cancelled 30 Oct, replaced by 2342')
        self.assertEqual(code, 0)
        code, out, _ = self.run_cli('cards')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)['5542']['note'], 'cancelled 30 Oct, replaced by 2342')
        for last4 in ('123', 'not-a-card', '4242424242424242'):
            with self.subTest(last4=last4):
                code, out, err = self.run_cli('card-dead', last4, '--note', 'x')
                self.assertEqual(code, 2)
                self.assertNotIn(last4, out + err)
        code, out, _ = self.run_cli('card-swap', '--old', '7572', '--new', '2342')
        self.assertEqual(code, 0)
        self.assertIn('marked dead: 7572', out)
        self.assertEqual(set(mc.dead_cards(self.data)), {'5542', '7572'})

    def test_add_list_show_and_errors(self):
        self.watcher('globex-refund-chase', 'active')
        code, out, _ = self.run_cli('add', 'globex', '--merchant', 'Globex', '--amount', '300', '--currency', 'USD',
                                    '--state', 'asked AR + sales to cancel', '--next', 'card dispute if no reply',
                                    '--deadline', '2026-10-27', '--who', 'agent', '--reference', 'case 05177237',
                                    '--watcher', 'globex-refund-chase')
        self.assertEqual(code, 0)
        self.assertIn('globex: Globex USD 300, by Tue 27 Oct (agent)', out)
        code, out, _ = self.run_cli('list', '--json')
        self.assertEqual(json.loads(out)[0]['watchers'], ['globex-refund-chase'])
        code, _, err = self.run_cli('show', 'nope')
        self.assertEqual((code, err.strip()), (2, "money-cases: no case 'nope'"))
        code, _, err = self.run_cli('update', 'globex', '--deadline', 'tomorrow')
        self.assertEqual(code, 2)
        self.assertIn('is not a date', err)
        self.assertTrue(self.run_cli('brief')[1].startswith('Money: 1 open;'))
        self.assertEqual(self.run_cli('close', 'globex', '--outcome', 'refunded')[0], 0)
        self.assertIn('closed but watcher running: globex (globex-refund-chase)', self.run_cli('brief')[1])
        self.watcher('globex-refund-chase', 'done')
        self.assertEqual(self.run_cli('brief')[1], '')

    def test_charge_ask_answered_and_questions(self):
        with patch.object(mc.charges, 'search', finder()), patch.object(mc.charges, 'owner_texts', nobody):
            code, out, _ = self.run_cli('charge', ALERT, '--sender', BANK, '--at', '2026-10-23T23:47:00+04:00')
            self.assertEqual((code, json.loads(out)['verdict']), (0, 'ask'))
            self.assertEqual(mc.load_questions(self.data)['questions'], [])
            code, out, _ = self.run_cli('ask', ALERT, '--sender', BANK, '--at', '2026-10-23T23:47:00+04:00',
                                        '--said', 'Is the Acme charge yours?')
            self.assertEqual(code, 0)
            qid = out.split(':')[0]
            code, _, err = self.run_cli('ask', ALERT, '--sender', BANK, '--said', 'q?')
            self.assertEqual(code, 2)
            self.assertIn('give --at', err)
            code, _, err = self.run_cli('ask', 'hello there', '--said', 'q?')
            self.assertEqual(code, 2)
            self.assertIn('not a card charge', err)
            self.assertEqual(self.run_cli('ask', '--said', 'q?')[0], 2)
            code, out, _ = self.run_cli('questions')
            self.assertIn(qid, out)
            self.assertEqual(self.run_cli('answered', qid, '--note', 'his order')[0], 0)
            self.assertEqual(self.run_cli('questions')[1].strip(), 'No charge questions.')
            self.assertIn(qid, self.run_cli('questions', '--all')[1])
            self.assertEqual(self.run_cli('ask', '--id', qid, '--said', 'q?')[0], mc.DONT_ASK)


    def test_a_scratch_check_never_writes_the_real_books(self):
        self.case('acme', deadline='2026-10-30')
        before = (self.data / 'cases.json').read_text()
        scratch = self.tmp / 'scratch-wd'
        scratch.mkdir()
        with patch.dict(os.environ, {'WATCH_DIR': str(scratch), 'WATCH_RUN': 'x'}), \
                patch.object(mc, 'now_dubai', return_value=at('2026-10-30T07:30')):
            code, out, _ = self.run_cli('check')
        self.assertEqual(code, 0)
        self.assertEqual((self.data / 'cases.json').read_text(), before)
        self.assertFalse((self.data / 'questions.json').exists())
        self.assertTrue((scratch / 'scratch-books' / 'cases.json').exists())




class PaymentDeadlines(Base):
    def notice(self, text='Your autopay of AED 3,532.73 failed; repay before midnight',
               when='2026-11-07T21:05', source='mail:wio:1', sender='Wio'):
        n = mc.payments.parse(text, sender, at(when))
        self.assertIsNotNone(n)
        cid = mc.record_payment(self.data, n, source, at(when))
        return cid

    def test_wio_replay_and_mail_sms_copy_are_one_case(self):
        cid = self.notice()
        self.assertEqual(self.notice(), cid)
        self.assertEqual(self.notice(source='imsg:2'), cid)
        case = mc.load(self.data)['cases'][0]
        self.assertEqual(case['deadline'], '2026-11-07T23:59:00+04:00')
        self.assertEqual(case['sources'], ['mail:wio:1', 'imsg:2'])
        self.assertEqual(len(mc.load(self.data)['cases']), 1)

    def test_hour_and_deadline_are_acknowledged_once_and_standalone(self):
        cid = self.notice('Your payment of AED 3,532.73 failed; pay by 21:00', when='2026-11-07T18:00')
        self.case(deadline='2026-11-07', when=at('2026-11-07T18:00'))
        self.assertIn(cid, self.check('2026-11-07T18:01', 'initial'))
        self.assertNotIn(cid, self.check('2026-11-07T19:44', 'early'))
        event = self.check('2026-11-07T20:00', 'hour')
        self.assertIn('Wio AED 3,532.73', event)
        self.assertIn('21:00', event)
        self.assertNotIn('acme', event)
        self.assertNotIn(cid, self.check('2026-11-07T20:15', 'repeat'))
        self.assertIn(cid, self.check('2026-11-07T21:00', 'due'))
        self.assertNotIn(cid, self.check('2026-11-08T09:00', 'tomorrow'))

    def test_midnight_reminder_survives_cadence_and_quiet_hours(self):
        cid = self.notice()
        self.assertIn(cid, self.check('2026-11-07T22:45', 'hour'))
        self.assertEqual('', self.check('2026-11-07T23:00', 'quiet'))
        self.assertIn(cid, self.check('2026-11-08T08:00', 'due'))
        self.assertEqual('', self.check('2026-11-08T08:15', 'again'))

    def test_hour_at_exact_minus_sixty_and_closed_case_never_fires(self):
        cid = self.notice()
        self.assertIn(cid, self.check('2026-11-07T22:59', 'hour'))
        mc.close(self.data, cid, 'paid', at('2026-11-07T23:01'))
        self.assertEqual('', self.check('2026-11-08T08:00', 'after'))
        self.assertEqual(self.notice(), cid)
        self.assertEqual('', self.check('2026-11-08T08:15', 'replay'))

    def test_unacknowledged_event_is_rebuilt_without_closed_case(self):
        cid = self.notice()
        self.assertIn(cid, self.check('2026-11-07T22:59', 'lost', ack=False))
        mc.close(self.data, cid, 'done', at('2026-11-07T23:00'))
        self.assertEqual('', self.check('2026-11-08T08:00', 'closed'))

    def test_success_closes_expected_and_deadline_and_replay_stays_closed(self):
        parent = self.notice('Autopay of AED 3,532.73 is due tonight at 21:00', '2026-11-07T09:09', 'scheduled')
        child = self.notice()
        self.notice('Autopay successful: AED 3,532.73', '2026-11-07T22:30', 'success')
        self.assertEqual({c['status'] for c in mc.load(self.data)['cases']}, {'closed'})
        self.assertEqual(self.notice(), child)
        self.assertEqual('', self.check('2026-11-08T08:00'))
        self.assertEqual({c['id'] for c in mc.load(self.data)['cases']}, {parent, child})

    def test_owner_closes_both_rows(self):
        parent = self.notice('Autopay of AED 3,532.73 is due tonight at 18:00', '2026-11-07T09:09', 'scheduled')
        with patch.object(mc.charges, 'search', return_value=[]) as search:
            self.check('2026-11-07T19:00', find=search)
        child = next(c for c in mc.load(self.data)['cases'] if c['kind'] == 'payment_deadline')
        mc.close(self.data, child['id'], 'paid', at('2026-11-07T19:30'))
        self.assertEqual({c['status'] for c in mc.load(self.data)['cases']}, {'closed'})
        with patch.object(mc.charges, 'search') as search:
            self.assertEqual('', self.check('2026-11-08T09:00', find=search))
            search.assert_not_called()
        self.assertEqual(mc.find(mc.load(self.data), parent)['status'], 'closed')

    def test_expected_missing_confirmation_escalates_at_due_plus_one(self):
        self.notice('Autopay of AED 3,532.73 is scheduled today at 18:00', '2026-11-07T09:09', 'scheduled')
        with patch.object(mc.charges, 'search', return_value=[]) as search:
            self.assertEqual('', self.check('2026-11-07T18:59', find=search))
            self.assertTrue(all(call.args[0].endswith(' refund OR credited') for call in search.call_args_list))
            self.assertIn('Wio', self.check('2026-11-07T19:00', find=search))
            payment_calls = [call for call in search.call_args_list if not call.args[0].endswith(' refund OR credited')]
            self.assertEqual(len(payment_calls), 1)
            self.assertIsNotNone(payment_calls[0].kwargs['deadline'])
            event = self.check('2026-11-07T20:00', find=search)
        self.assertIn('Wio', event)
        cases = mc.load(self.data)['cases']
        self.assertEqual(len(cases), 2)
        self.assertEqual(cases[1]['deadline'], '2026-11-07T21:00:00+04:00')

    def test_expected_uses_stated_repayment_deadline(self):
        self.notice('Autopay of AED 3,532.73 is scheduled today at 18:00; repay before midnight if it fails',
                    '2026-11-07T09:09', 'scheduled')
        with patch.object(mc.charges, 'search', return_value=[]) as search:
            self.check('2026-11-07T19:00', find=search)
        self.assertEqual(mc.load(self.data)['cases'][1]['deadline'], '2026-11-07T23:59:00+04:00')

    def test_search_success_requires_bank_amount_currency_and_time(self):
        for row_changes, closes in (({}, True), ({'sender': 'Shop'}, False), ({'body': 'Payment received AED 1.00'}, False),
                                    ({'body': 'Payment received USD 3,532.73'}, False),
                                    ({'ts': at('2026-11-06T21:00').timestamp()}, False),
                                    ({'source': 'whatsapp'}, False), ({'from_me': 1}, False)):
            with self.subTest(row_changes=row_changes), tempfile.TemporaryDirectory() as tmp:
                data = Path(tmp)
                n = mc.payments.parse('Autopay of AED 3,532.73 due today at 18:00', 'Wio', at('2026-11-07T09:00'))
                mc.record_payment(data, n, 'scheduled', at('2026-11-07T09:00'))
                row = {'id': 'receipt', 'source': 'email', 'sender': 'Wio', 'body': 'Payment received AED 3,532.73',
                       'ts': at('2026-11-07T18:05').timestamp(), **row_changes}
                mc.follow_payments(data, at('2026-11-07T19:00'), time.time() + 3, find=lambda *a, **kw: [row])
                self.assertEqual(mc.load(data)['cases'][0]['status'] == 'closed', closes)

    def test_archive_timeout_still_tracks_an_unconfirmed_payment(self):
        self.notice('Autopay of AED 3,532.73 due today at 18:00', '2026-11-07T09:00', 'scheduled')
        with patch.object(mc.charges, 'search', side_effect=mc.charges.Lookup('archive unavailable')) as search:
            self.check('2026-11-07T20:00', find=search)
            search.assert_called()
        cases = mc.load(self.data)['cases']
        self.assertEqual(len(cases), 2)
        self.assertIn('confirmation', cases[1]['state'])

    def test_brief_puts_payment_deadline_first(self):
        self.case(deadline='2026-11-06')
        self.notice()
        line = mc.brief(mc.load(self.data)['cases'], at('2026-11-07T22:00'))
        self.assertLess(line.index('Wio'), line.index('Acme'))
        self.assertIn('23:59', line)

    def test_owner_paid_closes_cycle_across_message_dates(self):
        for schedule_day, failure_time, due_clause in (
                ('2026-11-07T09:00', '2026-11-08T18:05', 'on 8 November 2026 at 18:00'),
                ('2026-11-07T09:00', '2026-11-08T00:05', 'on 7 November 2026 at 23:00')):
            with self.subTest(failure_time=failure_time), tempfile.TemporaryDirectory() as tmp:
                data = Path(tmp)
                parent = mc.payments.parse('Autopay of AED 100.00 scheduled ' + due_clause, 'Wio', at(schedule_day))
                mc.record_payment(data, parent, 'scheduled', at(schedule_day))
                failure = mc.payments.parse('Autopay of AED 100.00 failed; repay before midnight', 'Wio', at(failure_time))
                child = mc.record_payment(data, failure, 'failed', at(failure_time))
                mc.close(data, child, 'paid', at(failure_time) + dt.timedelta(minutes=1))
                self.assertEqual({c['status'] for c in mc.load(data)['cases']}, {'closed'})
                with patch.object(mc.charges, 'search') as search:
                    mc.follow_payments(data, at(failure_time) + dt.timedelta(hours=2), time.time() + 3)
                    search.assert_not_called()

    def test_conditional_success_does_not_close_unpaid_case(self):
        cid = self.notice('Autopay of AED 100.00 failed; repay before midnight')
        text = 'Autopay of AED 100.00 is scheduled today at 21:00. We will notify you if payment is successful.'
        self.notice(text, source='conditional')
        self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'open')
        self.notice('Payment of AED 100.00 has been successfully received.', source='confirmed')
        self.assertEqual({c['status'] for c in mc.load(self.data)['cases']}, {'closed'})

    def test_slow_lookups_do_not_abort_reminder_generation(self):
        self.notice('Autopay of AED 100.00 scheduled today at 18:00', '2026-11-07T09:00', 'scheduled-1')
        self.notice('Autopay of AED 200.00 scheduled today at 18:00', '2026-11-07T09:00', 'scheduled-2')
        clock = [time.time()]
        def slow_archive(*args, **kwargs):
            clock[0] = kwargs['deadline'] + .01
            raise mc.charges.Lookup('lookup budget exhausted')
        with patch.object(mc.time, 'time', side_effect=lambda: clock[0]), \
                patch.object(mc.charges, 'search', side_effect=slow_archive) as search:
            event = self.check('2026-11-07T20:00', find=search)
            search.assert_called()
        self.assertIn('Wio', event)
        self.assertEqual(sum(c['kind'] == 'payment_deadline' for c in mc.load(self.data)['cases']), 2)

    def test_bank_deadline_supersedes_fallback(self):
        self.notice('Autopay of AED 100.00 scheduled today at 18:00', '2026-11-07T09:00', 'scheduled')
        with patch.object(mc.charges, 'search', return_value=[]) as search:
            self.check('2026-11-07T19:00', 'missing', find=search)
        fallback = next(c for c in mc.load(self.data)['cases'] if c['kind'] == 'payment_deadline')
        bank = self.notice('Autopay of AED 100.00 failed; repay before midnight', '2026-11-07T20:00', 'bank')
        self.assertEqual(mc.find(mc.load(self.data), fallback['id'])['status'], 'closed')
        with patch.object(mc.charges, 'search', return_value=[]) as search:
            event = self.check('2026-11-07T21:00', 'bank-alert', find=search)
        self.assertIn(bank, event)
        self.assertNotIn(fallback['id'], event)
        self.assertNotIn('21:00', event)
        parent = next(c for c in mc.load(self.data)['cases'] if c['kind'] == 'autopay_expected')
        self.assertEqual(parent['payment_case'], bank)


class ReceiptVariantCompetition(unittest.TestCase):
    def test_aed_usd_charges_compete_for_the_same_receipt(self):
        observed = at('2026-11-12T12:00')
        for merchant, brand in [('BOAT.DEV', 'Boat'), ('BROWSER USE INC', 'Browser Use')]:
            row = dict(id=7, ts=(observed + dt.timedelta(minutes=45)).timestamp(),
                       sender=f'{brand} <receipts@stripe.example>', subject='Receipt')
            text = f'{brand} receipt\nAmount paid $50.00'
            for currency, amount, rival_currency, rival_amount in [
                    ('AED', '190.47', 'USD', '50.00'), ('USD', '50.00', 'AED', '190.47')]:
                current = dict(id='q-current', kind='charge', currency=currency, card='1111',
                               merchant=merchant, amount=amount, pending=False, at=mc.stamp(observed))
                for bound in [False, True]:
                    rival = dict(current, id='q-rival', currency=rival_currency, amount=rival_amount,
                                 at=mc.stamp(observed + dt.timedelta(minutes=1)))
                    if bound:
                        # A recorded binding vetoes reuse even outside the matching window.
                        rival.update(at=mc.stamp(observed - dt.timedelta(days=7)), status='closed',
                                     explanation={'msgs': row['id']})
                    for known in [False, True]:
                        with self.subTest(merchant=merchant, currency=currency, bound=bound, known=known):
                            questions = [current, rival] if known else [rival]
                            accepts = mc.receipt_for_question(None, current, 'q-current' if known else None,
                                                             questions, observed)
                            self.assertFalse(accepts(row, text))

    def test_unbound_fx_competitors_need_matching_evidence(self):
        observed = at('2026-11-12T12:00')
        row = dict(id=7, ts=(observed + dt.timedelta(minutes=45)).timestamp(),
                   sender='Boat <receipts@stripe.example>', subject='Receipt')
        for currency, amount, rival_currency, rival_amount, wrong_amount in [
                ('AED', '190.47', 'USD', '50.00', '25.00'),
                ('USD', '50.00', 'AED', '190.47', '100.00')]:
            current = dict(id='q-current', kind='charge', currency=currency, card='1111',
                           merchant='BOAT.DEV', amount=amount, pending=False, at=mc.stamp(observed))
            rival = dict(current, id='q-rival', currency=rival_currency, amount=rival_amount)
            for label, changes in [('merchant', {'merchant': 'Other'}),
                                   ('amount', {'amount': wrong_amount}), ('currency', {'currency': 'EUR'}),
                                   ('time', {'at': mc.stamp(observed - dt.timedelta(days=7))})]:
                with self.subTest(currency=currency, form=label):
                    accepts = mc.receipt_for_question(None, current, 'q-current',
                                                     [current, dict(rival, **changes)], observed)
                    self.assertTrue(accepts(row, 'Boat receipt\nAmount paid $50.00'))

    def test_different_amounts_cannot_share_a_variant_receipt(self):
        observed = at('2026-11-12T12:00')
        forms = [
            ('UBER * PENDING', '201.03', True, '200.94', False,
             'Uber <receipts@uber.com>', 'Uber receipt\nTotal AED 200.94', False),
            ('UBER * PENDING', '201.03', True, '201.00', True,
             'Uber <receipts@uber.com>', 'Uber receipt\nTotal AED 200.94', False),
            ('BOAT.DEV', '190.47', False, '190.90', False,
             'Boat <receipts@stripe.example>', 'Boat receipt\nAmount paid $50.00', False),
            ('UBER * PENDING', '201.03', True, '200.94', True,
             'Uber <receipts@uber.com>', 'Uber receipt\nTotal AED 200.94', True),
        ]
        for merchant, amount, pending, rival_amount, rival_pending, sender, text, bound in forms:
            current = dict(id='q-current', kind='charge', currency='AED', card='1111',
                           merchant=merchant, amount=amount, pending=pending, at=mc.stamp(observed))
            rival = dict(current, id='q-rival', amount=rival_amount, pending=rival_pending,
                         at=mc.stamp(observed + dt.timedelta(minutes=1)))
            if bound:
                rival.update(status='closed', explanation={'msgs': 7})
            row = dict(id=7, ts=(observed + dt.timedelta(minutes=45)).timestamp(),
                       sender=sender, subject='Receipt')
            for known in [False, True]:
                with self.subTest(merchant=merchant, rival=rival_amount, known=known):
                    questions = [current, rival] if known else [rival]
                    accepts = mc.receipt_for_question(None, current, 'q-current' if known else None,
                                                     questions, observed)
                    self.assertFalse(accepts(row, text))
                    unrelated = dict(rival, merchant='Other', amount='999.00', pending=False)
                    unrelated.pop('explanation', None)
                    accepts = mc.receipt_for_question(None, current, 'q-current' if known else None,
                                                     [unrelated], observed)
                    self.assertTrue(accepts(row, text))


if __name__ == '__main__':
    unittest.main()
