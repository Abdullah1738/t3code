"""Case book, deadline pings, ended reply watchers, outbox replay and the brief line."""
import datetime as dt
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sqlite3
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('money_cases', Path(__file__).with_name('cases.py'))
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)

TZ = mc.TZ


def at(text):
    return dt.datetime.fromisoformat(text).replace(tzinfo=TZ)


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.data, self.root, self.wd = self.tmp / 'data', self.tmp / 'watch', self.tmp / 'wd'
        self.wd.mkdir()

    def case(self, case_id='acme', deadline='2026-10-25', when=at('2026-10-24T09:00'), **extra):
        fields = dict(merchant='Acme', amount='120.50', currency='aed', state='refund asked',
                      next_action='dispute on the card', deadline=deadline, who='Abdullah')
        fields.update(extra)
        return mc.add(self.data, case_id, at=when, root=self.root, **fields)

    def check(self, now, run='r1', ack=True, delivered_at=None):
        """One runner tick: build the event, ack the run, then deliver it.

        The runner delivers at `delivered_at` (default: the same moment), so a test can delay delivery. A
        delivered event raises `fires` and sets `last_fire_at` in state.json, which is what the check reads.
        With ack=False nothing is delivered (the runner never took the event)."""
        event = mc.run_check(self.wd, run, self.data, self.root, at(now))
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
                  note='support answered', because='Acme asked for a week', at=at('2026-10-24T12:00'),
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
                self.assertEqual(self.sent()['acme|r0|soon'], '2026-11-05T20:58:51+04:00')
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
        mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, because='owner said Wed', at=at('2026-10-24T11:00'))
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

    def test_an_old_outbox_without_its_event_text_is_rebuilt(self):
        # An outbox written before the event text was kept can't be matched to the runner's pending event.
        self.case(deadline='2026-10-25')
        (self.wd / 'state.json').write_text(json.dumps({'fires': 3}))
        (self.wd / 'pings.json').write_text(json.dumps({'sent': {}, 'outbox': {
            'run': 'old', 'keys': ['acme|r0|soon'], 'at': '2026-10-24T09:30:00+04:00', 'fires': 3, 'clock': {}}}))
        self.assertIn('acme', self.check('2026-10-24T10:00', 'r1'))
        self.assertEqual(self.check('2026-10-24T10:30', 'r2'), '')
        self.assertIn('acme|r0|soon', self.sent())

    def test_unrecorded_output_is_rebuilt_before_new_work(self):
        self.case(deadline='2026-10-25')
        first = self.check('2026-10-24T10:00', 'r1', ack=False)
        self.assertTrue(first)
        # The runner never took it (no state.pending), so the r2 check rebuilds the event rather than holding it.
        rebuilt = self.check('2026-10-24T10:15', 'r2', ack=False)
        self.assertEqual(rebuilt, first)
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['outbox']['run'], 'r2')
        self.assertEqual(self.sent(), {})
        # Once the runner takes it and delivers, the reminder is recorded as sent at its delivery time.
        (self.wd / '.run-ok').write_text('r2')
        self.deliver('2026-10-24T10:20')
        self.assertEqual(self.check('2026-10-24T10:30', 'r3'), '')
        self.assertIn('acme|r0|soon', self.sent())

    def test_unrecorded_output_respects_quiet_hours_and_current_cases(self):
        self.case(deadline='2026-10-25T10:00:00+04:00')
        self.case('bolt', merchant='Bolt Law', deadline='2026-10-25T10:00:00+04:00')
        self.assertIn('bolt', self.check('2026-10-24T22:59', 'r1', ack=False))
        self.assertEqual(self.check('2026-10-24T23:15', 'r2', ack=False), '')
        mc.close(self.data, 'bolt', 'refunded')
        mc.update(self.data, 'acme', {'deadline': '2026-10-30'}, because='owner said Fri', at=at('2026-10-25T07:00'))
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
        mc.update(self.data, 'acme', {'deadline': '2026-10-26'}, because='owner: Mon', at=at('2026-10-24T10:30'))
        self.assertTrue(self.check('2026-10-25T10:00', 'r2'))
        mc.update(self.data, 'acme', {'deadline': '2026-10-25'}, because='owner: back to Sun', at=at('2026-10-24T10:30'))
        # Moving the deadline re-arms the ping, but the day's one reminder already went out at 10:00.
        self.assertEqual(self.check('2026-10-25T11:00', 'r3'), '')
        self.assertIn('OVERDUE', self.check('2026-10-26T09:00', 'r4'))
        mc.close(self.data, 'acme', 'refunded')
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
        self.assertIn('Acme AED 120.50 (no valid deadline)', mc.brief(cases, at('2026-10-20T10:00')))
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
        mc.close(self.data, 'acme', 'refunded', at=at('2027-05-01T11:00'))
        self.check('2027-07-15T10:00', 'r5')
        self.assertFalse(any(k.startswith('acme|') for k in self.sent()))

    def test_busy_lock_exits_75_without_output(self):
        env = dict(os.environ, WATCH_DIR=str(self.wd), MONEY_CASES_DIR=str(self.data))
        with (self.wd / 'check.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            r = subprocess.run(['/usr/bin/python3', '-B', str(Path(__file__).with_name('cases.py')), 'check'],
                               env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual((r.returncode, r.stdout), (75, ''))


class Rules(Base):
    """The 2026-10-25 fixes: deadline guard, one reminder a day, one yes/no, mail+SMS dedupe, released, unmatched."""

    def test_deadline_change_without_a_reason_is_refused_and_changes_nothing(self):
        self.case(deadline='2026-10-25')
        before = mc.load(self.data)['cases'][0]
        with self.assertRaises(mc.CaseError) as err:
            mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, at=at('2026-10-24T10:00'))
        self.assertIn('--because', str(err.exception))
        after = mc.load(self.data)['cases'][0]
        self.assertEqual((after['deadline'], after['rev'], after['history']),
                         (before['deadline'], before['rev'], before['history']))

    def test_deadline_change_with_because_is_recorded_in_history(self):
        self.case(deadline='2026-10-25')
        c = mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, because='Acme agreed to Wed',
                      at=at('2026-10-24T10:00'))
        self.assertEqual(c['deadline'], '2026-10-28')
        self.assertIn('because: Acme agreed to Wed', c['history'][-1]['text'])
        self.assertIn('deadline: 2026-10-28', c['history'][-1]['text'])

    def test_deadline_change_with_his_reply_id_is_accepted_and_recorded(self):
        self.case(deadline='2026-10-25')
        c = mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, reply='msg-4471', at=at('2026-10-24T10:00'))
        self.assertIn('owner reply msg-4471', c['history'][-1]['text'])

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

    def test_output_lost_before_the_runner_accepted_it_is_rebuilt_not_stuck(self):
        # The check printed and wrote its outbox, then died before the runner saved state.pending: the
        # runner never took it, state.json has no pending and fires never rose.
        self.case(deadline='2026-10-25')
        self.assertTrue(self.check('2026-10-24T10:00', 'r1', ack=False))
        self.assertFalse((self.wd / 'state.json').exists())
        # A later check must not stay silent forever: it drops the lost output and shows the reminder again.
        event = self.check('2026-10-24T10:30', 'r2', ack=False)
        self.assertIn('acme', event)
        # Nothing is recorded as sent until a delivery is confirmed.
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text()).get('sent', {}), {})
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['outbox']['run'], 'r2')

    def test_a_pending_event_the_runner_owns_is_waited_for_not_rebuilt(self):
        # The runner saved the event as its pending event, so it will deliver it: the check does not rebuild.
        self.case(deadline='2026-10-25')
        event = self.check('2026-10-24T10:00', 'r1', ack=False)
        self.assertTrue(event)
        (self.wd / 'state.json').write_text(json.dumps({'fires': 0, 'pending': {'event': event, 'key': 'k'}}))
        self.assertEqual(self.check('2026-10-24T10:15', 'r2', ack=False), '')
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['outbox']['run'], 'r1')

    def test_a_reminder_delivered_two_days_late_counts_from_delivery(self):
        # Built 24 Oct 10:00, but the runner only delivers it on 26 Oct at 10:00 (a retry after an outage).
        self.case(deadline='2026-10-25', when=at('2026-10-24T09:00'))
        self.assertTrue(self.check('2026-10-24T10:00', 'r1', ack=False))
        (self.wd / '.run-ok').write_text('r1')
        self.deliver('2026-10-26T10:00')
        # Delivery day 26 Oct: that is the one reminder for the day, so no second reminder today.
        self.assertEqual(self.check('2026-10-26T11:00', 'r2'), '')
        # The clock starts at delivery (26 Oct), so no yes/no on 27 Oct; it is due 28 Oct, two full days later.
        self.assertNotIn('Yes or no', self.check('2026-10-27T10:00', 'r3'))
        self.assertIn('Yes or no', self.check('2026-10-28T10:00', 'r4'))
        pings = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(pings['clock']['acme']['at'], '2026-10-26T10:00:00+04:00')

    def test_a_future_case_is_not_asked_before_its_first_reminder(self):
        self.case(deadline='2026-11-30', when=at('2026-10-24T09:00'))
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
        mc.update(self.data, 'acme', {'deadline': '2026-12-15'}, because='merchant requested more time',
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


class Brief(Base):
    def test_lists_due_and_changed_only(self):
        self.assertEqual(mc.brief([], at('2026-10-24T08:00')), '')
        self.case('acme', deadline='2026-10-25', when=at('2026-10-20T09:00'))
        self.case('bolt', merchant='Bolt Law', amount='1234.56', currency='GBP', deadline='2026-10-31',
                  when=at('2026-10-23T20:00'))
        self.case('zeta', merchant='Zeta', amount='9000', deadline='2026-11-05', when=at('2026-10-20T09:00'))
        self.case('old', merchant='Old', amount='5', deadline='2026-10-20', when=at('2026-10-10T09:00'))
        mc.close(self.data, 'old', 'done', at=at('2026-10-21T09:00'))
        line = mc.brief(mc.load(self.data)['cases'], at('2026-10-24T08:00'))
        self.assertEqual(line, 'Money: 3 open. due: Acme AED 120.50 (Sun 25 Oct). changed: Bolt Law GBP 1,234.56.')
        early = [c for c in mc.load(self.data)['cases'] if c['id'] in ('acme', 'zeta')]
        self.assertEqual(mc.brief(early, at('2026-10-22T10:00')), 'Money: 2 open. nothing due in 48h.')
        late = mc.brief(mc.load(self.data)['cases'], at('2026-10-26T08:00'))
        self.assertIn('Acme AED 120.50 (overdue since Sun 25 Oct)', late)


ALERT = 'Purchase of EUR 12.34 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl Cr. Limit is AED 1'
BANK = 'EmiratesNBD'
HISTORY = {'id': 1, 'ts': at('2026-09-01T12:00').timestamp(), 'sender': BANK, 'source': 'imessage', 'from_me': 0,
           'body': 'Purchase of EUR 9.99 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl Cr. Limit'}
RECEIPT = {'id': 2, 'ts': at('2026-10-24T10:47').timestamp(), 'sender': 'Acme <noreply@acme.example>',
           'subject': 'Your Acme order', 'body': 'Thanks for ordering. Total €12.34', 'source': 'email', 'from_me': 0}


def read(row, deadline=None, **_):
    return f"{row.get('subject', '')}\n{row.get('body', '')}"


def finder(*rows):
    """A fake msgs search; charges.py itself keeps rows by time, sender and source."""
    def find(query, since, until=None, source=None, n=20, deadline=None):
        return [r for r in rows if source is None or r['source'] == source]
    return find


def nobody(since, until, deadline=None):
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
        self.assertEqual(self.ask('2026-10-25T18:00', known)[0], 0)
        code, msg = self.ask('2026-10-26T09:00', known)
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('never a third ask', msg)
        q = self.questions()[0]
        self.assertEqual((q['status'], len(q['asks'])), ('case', 2))
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

    def test_the_check_turns_a_question_asked_twice_into_a_case_and_says_so_once(self):
        self.assertEqual(self.ask('2026-10-24T00:37', finder())[0], 0)
        self.assertEqual(self.ask('2026-10-24T08:00', finder())[0], 0)
        self.assertEqual(self.follow('2026-10-24T12:00', finder()), '')
        event = self.follow('2026-10-24T20:30', finder())
        self.assertIn("he didn't answer, so it is now money case charge-", event)
        self.assertEqual(len(mc.load(self.data)['cases']), 1)
        later = self.follow('2026-10-24T21:00', finder(), 'r2')
        self.assertNotIn("he didn't answer", later)

    def test_a_wait_with_no_receipt_is_raised_once(self):
        r = mc.screen(ALERT, BANK, at('2026-10-23T23:47'), at('2026-10-24T00:37'), data=self.data,
                      find=finder(HISTORY), said=nobody, item='imsg:1')
        self.assertEqual(r['verdict'], 'wait')
        self.assertEqual(self.follow('2026-10-25T09:00', finder(HISTORY)), '')
        event = self.follow('2026-10-25T12:00', finder(HISTORY))
        self.assertIn('no receipt came while we waited', event)
        self.assertIn(f"money-cases ask --id {self.questions()[0]['id']}", event)
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

    def test_an_alert_triage_left_out_is_closed_as_answered_and_one_nobody_raised_becomes_a_case(self):
        a = self.screen(ALERT, BANK, '2026-10-23T23:47', '2026-10-24T00:37', 'imsg:1')
        mc.triaged(self.data, [(a['id'], 'imsg:1', False)], at('2026-10-24T00:37'))
        self.assertEqual((self.questions()[0]['status'], self.questions()[0]['outcome']),
                         ('closed', 'already answered in a chat'))
        # Held for a receipt and never raised: after a week it is a money case he hears about.
        held = self.screen(ALERT.replace('12.34', '5.55'), BANK, '2026-10-23T23:47', '2026-10-23T23:48', 'imsg:2')
        event = self.follow('2026-10-31T09:00', finder())
        self.assertEqual(mc.find_question(mc.load_questions(self.data), held['id'])['status'], 'case')
        self.assertIn("he didn't answer, so it is now money case", event)

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

        def find(query, since, until=None, source=None, n=20, deadline=None):
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
        self.assertEqual(self.ask('2026-10-24T08:00', finder())[0], 0)
        self.assertEqual(self.ask('2026-10-24T20:00', finder())[0], mc.DONT_ASK)
        q = self.questions()[0]
        self.assertEqual(q['status'], 'case')
        event = self.follow('2026-10-25T09:00', finder(dict(RECEIPT, ts=at('2026-10-25T08:00').timestamp())))
        self.assertIn(f"money case {q['case']} closed", event)
        self.assertEqual(mc.find(mc.load(self.data), q['case'])['status'], 'closed')
        self.assertEqual(self.questions()[0]['status'], 'closed')

    def test_his_answer_to_a_case_question_is_noted_on_the_case(self):
        for now in ('2026-10-24T00:37', '2026-10-24T08:00', '2026-10-24T20:00'):
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


class CheckBudget(Base):
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
                    mc.follow(self.data, now, self.root, time.time() + 5, finder(), nobody)
                # Delay inside the protected atomic write, after the case has been committed.
                dump = mc.json.dump
                def slow_dump(value, stream, **kw):
                    result = dump(value, stream, **kw)
                    if 'cases' in value:
                        time.sleep(0.1)
                    return result
                with patch.object(mc.json, 'dump', slow_dump):
                    with self.assertRaises(mc.CheckTimeout):
                        with mc.within(time.time() + 0.05, mc.CheckTimeout('out of time')):
                            mc.follow(self.data, now, self.root, time.time() + 5, finder(),
                                      owner if action == 'close' else nobody)
                self.assertEqual(self.questions()[0]['status'], 'case' if action == 'close' else 'open')
                self.assertEqual(len(mc.load(self.data)['cases']), 1)
                mc.follow(self.data, now, self.root, time.time() + 5, finder(), owner)
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
                dump = mc.json.dump
                def slow_dump(value, stream, **kw):
                    result = dump(value, stream, **kw)
                    if 'cases' in value:
                        time.sleep(0.1)
                    return result
                with patch.object(mc.json, 'dump', slow_dump):
                    with self.assertRaises(mc.CheckTimeout):
                        with mc.within(time.time() + 0.05, mc.CheckTimeout('out of time')):
                            mc.follow(self.data, now, self.root, time.time() + 5, finder(), nobody)
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
                mc.follow(self.data, now, self.root, time.time() + 5, finder(), nobody)
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

    def test_timeout_waits_for_atomic_book_write_to_finish(self):
        dump = mc.json.dump
        def slow(*args, **kw):
            time.sleep(0.1)
            return dump(*args, **kw)
        path = self.tmp / 'atomic.json'
        with patch.object(mc.json, 'dump', slow):
            with self.assertRaises(mc.CheckTimeout):
                with mc.within(time.time() + 0.05, mc.CheckTimeout('out of time')):
                    mc.write_json(path, {'complete': True})
        self.assertEqual(json.loads(path.read_text()), {'complete': True})

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
        self.case()
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(days=8)])
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
            self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'open')
        finally:
            holder.communicate(timeout=2)

    def test_one_owner_query_filters_each_questions_window(self):
        now = at('2026-10-25T12:00')
        times = [now - dt.timedelta(hours=2*n) for n in range(5)]
        self.seed(times)
        path = self.tmp / 'owner.sqlite'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE orchestration_v2_projection_threads (thread_id, title, updated_at)')
            db.execute('CREATE TABLE orchestration_v2_projection_messages (thread_id, role, created_at, payload_json)')
            db.execute('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)',
                       ('t', 'app', mc.charges.iso(now)))
            for n, when in enumerate(times):
                payload = {'createdBy': 'user', 'creationSource': 'web', 'text': f'I paid Acme, item {n}'}
                db.execute('INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, ?)',
                           ('t', 'user', mc.charges.iso(when), json.dumps(payload)))
        with patch.object(mc.charges, 'STATE_DB', path), \
                patch.object(mc.charges, 'owner_texts', wraps=mc.charges.owner_texts) as query:
            mc.run_check(self.wd, 'r', self.data, self.root, now, finder())
        self.assertEqual(query.call_count, 1)
        for n, q in enumerate(self.questions()):
            self.assertEqual(q['status'], 'closed')
            self.assertIn(f'item {n}', q['outcome'])
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(state['timing']['owner_queries'], 1)

    def test_union_lookup_failure_is_recorded_once(self):
        now = at('2026-10-25T12:00')
        self.seed([now - dt.timedelta(hours=n) for n in range(5)])
        with patch.object(mc.charges, 'owner_texts', side_effect=mc.charges.Lookup('test source failed')) as query:
            mc.run_check(self.wd, 'r', self.data, self.root, now, finder())
        self.assertEqual(query.call_count, 1)
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(str(state['question_errors']).count('test source failed'), 1)
        self.assertTrue(all(q['status'] == 'open' for q in self.questions()))

    def test_long_union_falls_back_to_each_question(self):
        now = at('2026-10-25T12:00')
        self.seed([now, now - dt.timedelta(days=3)])
        with patch.object(mc.charges, 'owner_texts', return_value=[]) as query:
            mc.run_check(self.wd, 'r', self.data, self.root, now, finder())
        self.assertEqual(query.call_count, 2)
        self.assertTrue(all(call.args[1] - call.args[0] <= dt.timedelta(hours=1)
                            for call in query.call_args_list))

    def test_msgs_cache_is_shared_by_questions_and_reset_each_run(self):
        now = at('2026-10-25T12:00')
        self.seed([now, now])
        row = {'id': 1, 'ts': now.timestamp(), 'sender': 'Acme', 'subject': 'Acme receipt'}
        calls = []
        def msgs(argv, **kw):
            calls.append(tuple(argv))
            body = json.dumps(row) if argv[1] == 'search' else 'Acme receipt EUR 12.34'
            return subprocess.CompletedProcess(argv, 0, body, '')
        with patch.object(mc.charges.subprocess, 'run', msgs):
            mc.run_check(self.wd, 'r', self.data, self.root, now, said=nobody)
            self.assertEqual([a[1] for a in calls], ['search', 'show'])
            self.seed([now, now])
            mc.run_check(self.wd, 'r2', self.data, self.root, now, said=nobody)
        self.assertEqual([a[1] for a in calls], ['search', 'show', 'search', 'show'])
        self.assertTrue(all(q['status'] == 'closed' for q in self.questions()))


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

    def test_dry_run_writes_nothing(self):
        self.case('acme', merchant='Shop 4', next_action='dispute on card 5542')
        before = mc.load(self.data)
        changes = mc.card_swap(self.data, '5542', '2342', dry_run=True)
        self.assertEqual(changes[0]['after'], 'dispute on card 2342')
        self.assertEqual(mc.load(self.data), before)

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
            with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
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
            with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
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
        with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
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
        with patch.object(mc, 'DATA', self.data), redirect_stdout(out), redirect_stderr(err):
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
        write.assert_not_called()
        after = path.stat()
        self.assertEqual((path.read_bytes(), after.st_ino, after.st_mtime_ns), (before, st.st_ino, st.st_mtime_ns))
        self.assertIn("a: next 'retry on 5542' -> 'retry on 2342'", out)
        self.assertIn("b: next 'retry on 5542' -> 'retry on 2342'", out)
        self.assertIn('2 case(s) would change; nothing written', out)

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
        with patch.object(mc, 'DATA', self.data), patch.object(mc, 'WATCH_ROOT', self.root), \
                redirect_stdout(out), redirect_stderr(err):
            code = mc.main(list(args))
        return code, out.getvalue(), err.getvalue()

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
        self.assertTrue(self.run_cli('brief')[1].startswith('Money: 1 open.'))
        self.assertEqual(self.run_cli('close', 'globex', '--outcome', 'refunded')[0], 0)
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


if __name__ == '__main__':
    unittest.main()
