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

    def check(self, now, run='r1', ack=True):
        event = mc.run_check(self.wd, run, self.data, self.root, at(now))
        if ack and event:
            (self.wd / '.run-ok').write_text(run)
        return event

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
                  note='support answered', at=at('2026-10-24T12:00'), root=self.root)
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
        self.assertEqual(self.check('2026-10-25T10:00', 'r2'), '')
        late = self.check('2026-10-25T18:30', 'r3')
        self.assertIn('OVERDUE since Sun 25 Oct 18:00', late)
        self.assertEqual(self.check('2026-10-25T21:00', 'r4'), '')
        self.assertIn('OVERDUE', self.check('2026-10-26T09:00', 'r5'))

    def test_new_deadline_rearms_and_closed_cases_stay_quiet(self):
        self.case(deadline='2026-10-25')
        self.assertTrue(self.check('2026-10-24T10:00'))
        mc.update(self.data, 'acme', {'deadline': '2026-10-28'}, at=at('2026-10-24T11:00'))
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
        self.assertIn('live-reply expired after 0 fire(s)', self.check('2026-10-24T12:00', 'r3'))
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
        self.assertEqual(self.check('2026-10-24T10:15', 'r2', ack=False), first)
        self.assertEqual(json.loads((self.wd / 'pings.json').read_text())['outbox']['run'], 'r2')
        (self.wd / '.run-ok').write_text('r2')
        self.assertEqual(self.check('2026-10-24T10:30', 'r3'), '')
        self.assertIn('acme|r0|soon', self.sent())

    def test_unrecorded_output_respects_quiet_hours_and_current_cases(self):
        self.case(deadline='2026-10-25T10:00:00+04:00')
        self.case('bolt', merchant='Bolt Law', deadline='2026-10-25T10:00:00+04:00')
        self.assertIn('bolt', self.check('2026-10-24T22:59', 'r1', ack=False))
        self.assertEqual(self.check('2026-10-24T23:15', 'r2', ack=False), '')
        mc.close(self.data, 'bolt', 'refunded')
        mc.update(self.data, 'acme', {'deadline': '2026-10-30'}, at=at('2026-10-25T07:00'))
        self.assertEqual(self.check('2026-10-25T08:05', 'r3', ack=False), '')
        self.assertEqual(self.sent(), {})

    def test_event_taken_by_a_runner_that_crashed_before_its_ack_is_not_repeated(self):
        self.case(deadline='2026-10-25')
        (self.wd / 'state.json').write_text(json.dumps({'fires': 4}))
        self.assertTrue(self.check('2026-10-24T10:00', 'r1', ack=False))
        # The runner saved its pending event, died before .run-ok, then delivered it after restart.
        (self.wd / 'state.json').write_text(json.dumps({'fires': 5}))
        self.assertEqual(self.check('2026-10-24T10:15', 'r2', ack=False), '')
        self.assertIn('acme|r0|soon', self.sent())

    def test_big_batches_stay_under_the_runner_limit_and_the_rest_follow(self):
        for n in range(80):
            self.case(f'case-{n:02d}', merchant=f'Merchant {n:02d} ' + 'x' * 40, deadline='2026-10-25')
        first = self.check('2026-10-24T10:00')
        self.assertLess(len(first), 6000)
        self.assertIn('more need attention; they follow in the next check', first)
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
        names = [f'reply-{n:02d}-' + 'w' * 30 for n in range(35)]
        for w in names:
            self.watcher(w, 'active')
        self.case(deadline='2026-11-01', watchers=names, merchant='Acme ' + 'é' * 70)
        for w in names:
            self.watcher(w, 'done', fires=2)
        mentioned, events = set(), []
        for n in range(10):
            event = self.check(f'2026-10-24T1{n}:00', f'r{n}')
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
            self.case(f'case-{n:02d}', merchant='💸' * 40, deadline='2026-10-25')
        event = self.check('2026-10-24T10:00')
        self.assertLessEqual(mc.units(event), mc.EVENT_LIMIT)
        self.assertGreater(mc.units(event), len(event))

    def test_going_back_to_an_earlier_deadline_or_reopening_pings_again(self):
        self.case(deadline='2026-10-25')
        self.assertTrue(self.check('2026-10-24T10:00', 'r1'))
        mc.update(self.data, 'acme', {'deadline': '2026-10-26'}, at=at('2026-10-24T10:30'))
        self.assertTrue(self.check('2026-10-25T10:00', 'r2'))
        mc.update(self.data, 'acme', {'deadline': '2026-10-25'}, at=at('2026-10-24T10:30'))
        self.assertIn('OVERDUE', self.check('2026-10-25T11:00', 'r3'))
        mc.close(self.data, 'acme', 'refunded')
        mc.reopen(self.data, 'acme', '2026-10-25', 'refund bounced')
        self.assertIn('OVERDUE', self.check('2026-10-25T12:00', 'r4'))

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
        self.case('later', deadline='2027-06-01')
        book = json.loads((self.data / 'cases.json').read_text())
        book['cases'][1]['deadline'] = 'soon'
        (self.data / 'cases.json').write_text(json.dumps(book))
        self.assertIn('later', self.check('2026-12-24T13:00', 'r2'))
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


def read(row, deadline=None):
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
        event = mc.run_check(self.wd, run, self.data, self.root, at(now), find, nobody)
        if event:
            (self.wd / '.run-ok').write_text(run)
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
        # The receipt is the oldest mail in the window; 21 newer usage notices fill the first page of hits.
        receipt = {**RECEIPT, 'ts': at('2026-10-23T23:50').timestamp(), 'body': 'Thanks for ordering. Total AED 12.34'}
        notices = [{'id': 100 + i, 'ts': at('2026-10-23T23:55').timestamp() + i, 'sender': 'Acme <usage@acme.example>',
                    'subject': 'Usage notice', 'body': 'Usage of AED 12.34 on card 1111', 'source': 'email', 'from_me': 0}
                   for i in range(21)]
        seen = []

        def find(query, since, until=None, source=None, n=20, deadline=None):
            seen.append(n)
            # Newest first, as msgs search returns them, cut at the requested hit count.
            rows = sorted([receipt] + notices, key=lambda r: -r['ts'])
            return rows[:n]
        aed = 'Purchase of AED 12.34 with Credit Card ending 1111 at ACME * EATS PENDING, Amsterdam. Avl Cr. Limit is AED 1'
        r = mc.charges.receipt(mc.charges.parse(aed, BANK), at('2026-10-24T00:37'), at('2026-10-24T00:45'),
                               find=find, read=read)
        self.assertIsNotNone(r)
        self.assertEqual(r['id'], receipt['id'])
        self.assertTrue(all(n > 20 for n in seen))

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
