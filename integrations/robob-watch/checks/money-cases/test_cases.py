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
        state['last_fire_at'] = at(when).isoformat(timespec='seconds')
        path.write_text(json.dumps(state))

    def watcher(self, watcher_id, status, fires=1):
        folder = self.root / 'watchers' / watcher_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / 'watcher.json').write_text(json.dumps({'id': watcher_id}))
        (folder / 'state.json').write_text(json.dumps({'status': status, 'fires': fires,
                                                       'last_fire_at': '2026-10-23T10:44:18Z',
                                                       'last_run_at': '2026-10-23T11:00:00Z'}))


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

    def test_unrecorded_output_is_rebuilt_before_new_work(self):
        self.case(deadline='2026-10-25')
        first = self.check('2026-10-24T10:00', 'r1', ack=False)
        self.assertTrue(first)
        # While that event is undelivered it is held: the next tick builds nothing new over it.
        self.assertEqual(self.check('2026-10-24T10:15', 'r2', ack=False), '')
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['outbox']['run'], 'r1')
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


if __name__ == '__main__':
    unittest.main()
