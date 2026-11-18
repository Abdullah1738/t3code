"""Durable unanswered questions, bill priority, merge severity and delegated purchases."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import io
import json
from contextlib import redirect_stdout
from unittest.mock import patch

from test_cases import Base, ALERT, BANK, RECEIPT, at, finder, nobody, mc
from test_charges import Finder


class Unanswered(Base):
    def test_a_newer_same_amount_receipt_cannot_close_an_older_unanswered_charge(self):
        for linked in (False, True):
            with self.subTest(linked=linked):
                self.data, self.wd = self.tmp / str(linked), self.tmp / ('wd-' + str(linked))
                self.wd.mkdir()
                old = self.seed(when='2026-11-01T09:00')
                self.assertEqual(mc.ask(self.data, 'Yours?', qid=old, now=at('2026-11-01T10:00'),
                                        find=finder(), said=nobody)[0], 0)
                if linked:
                    with mc.Locked(self.data, 'questions') as book:
                        cid = mc.case_from(self.data, mc.find_question(book, old), at('2026-11-01T11:00'), 'check')
                self.fire('2026-11-09T10:00')
                self.fire('2026-11-20T10:00', 1)
                receipt = dict(RECEIPT, ts=at('2026-12-06T09:01').timestamp())
                with patch.object(mc.charges, 'show', lambda row, deadline=None, **kw: row['subject'] + '\n' + row['body']):
                    fresh = mc.screen(ALERT, BANK, at('2026-12-06T09:00'), at('2026-12-06T09:02'),
                                      data=self.data, find=finder(receipt), said=nobody, item='sms:december')
                    self.assertEqual(fresh['verdict'], 'explained')
                    mc.run_check(self.wd, 'december', self.data, self.root, at('2026-12-06T10:00'), finder(receipt), nobody)
                q = mc.find_question(mc.load_questions(self.data), old)
                self.assertEqual(q['status'], 'awaiting_answer')
                self.assertIn(old, self.cli('questions', '--json'))
                self.assertIn(cid if linked else old, self.cli('list', '--json'))
                self.assertIn('awaiting answer', self.cli('brief'))
                if linked:
                    self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'awaiting_answer')

    def test_receipt_timestamp_class_is_bound_to_the_charge_even_on_a_late_check(self):
        observed = at('2026-11-01T09:00')
        charge = mc.charges.parse(ALERT, BANK)
        # receipt offset | merchant-only receipt is tied to this charge's 36-hour window
        for hours, seconds, matched in ((-2, -1, False), (-2, 0, True), (11, 0, True),
                                        (36, 0, True), (36, 1, False), (35 * 24, 0, False)):
            with self.subTest(hours=hours, seconds=seconds):
                received = observed + mc.dt.timedelta(hours=hours, seconds=seconds)
                receipt = dict(RECEIPT, ts=received.timestamp())
                with patch.object(mc.charges, 'show', lambda row, deadline=None, **kw: row['subject'] + '\n' + row['body']):
                    result = mc.charges.explain(charge, observed, at('2026-12-06T10:00'),
                                                find=finder(receipt), said=nobody)
                self.assertEqual(result['verdict'] == 'receipt', matched)

    def test_a_historical_receipt_found_later_still_settles_its_original_charge(self):
        old = self.seed(when='2026-11-01T09:00')
        mc.ask(self.data, 'Yours?', qid=old, now=at('2026-11-01T10:00'), find=finder(), said=nobody)
        receipt = dict(RECEIPT, ts=at('2026-11-01T20:00').timestamp())
        with patch.object(mc.charges, 'show', lambda row, deadline=None, **kw: row['subject'] + '\n' + row['body']):
            mc.run_check(self.wd, 'late-archive', self.data, self.root, at('2026-12-06T10:00'), finder(receipt), nobody)
        self.assertEqual(mc.find_question(mc.load_questions(self.data), old)['status'], 'closed')

    def test_receipt_with_multiple_candidate_charges_stays_ambiguous_on_every_entry_point(self):
        # entry point | distinct same-channel alerts one second or two hours apart
        for entry in ('screen', 'ask', 'charge', 'follow'):
            for gap in (mc.dt.timedelta(seconds=1), mc.dt.timedelta(hours=2)):
                with self.subTest(entry=entry, gap=gap):
                    self.data = self.tmp / (entry + str(gap.total_seconds()))
                    observed = at('2026-11-01T09:00')
                    old = mc.screen(ALERT, BANK, observed, observed, data=self.data,
                                    find=finder(), said=nobody, item='sms:old')['id']
                    mc.ask(self.data, 'Yours?', qid=old, now=observed, find=finder(), said=nobody)
                    newer = observed + gap
                    fresh = mc.screen(ALERT, BANK, newer, newer, data=self.data,
                                      find=finder(), said=nobody, item='sms:new')['id']
                    receipt = dict(RECEIPT, ts=(newer + mc.dt.timedelta(minutes=1)).timestamp())
                    with patch.object(mc.charges, 'show', lambda row, deadline=None, **kw: row['subject'] + '\n' + row['body']):
                        if entry == 'follow':
                            mc.follow(self.data, newer + mc.dt.timedelta(minutes=2), self.root, find=finder(receipt), said=nobody)
                        elif entry == 'screen':
                            result = mc.screen(ALERT, BANK, newer, newer + mc.dt.timedelta(minutes=2),
                                               data=self.data, find=finder(receipt), said=nobody, item='sms:new')
                            self.assertNotEqual(result['verdict'], 'explained')
                        elif entry == 'ask':
                            _, text = mc.ask(self.data, 'Yours?', qid=fresh, now=newer + mc.dt.timedelta(minutes=2),
                                             find=finder(receipt), said=nobody)
                            self.assertNotIn('is explained', text)
                        else:
                            with patch.object(mc.charges, 'search', finder(receipt)), patch.object(mc.charges, 'owner_texts', nobody):
                                result = json.loads(self.cli('charge', ALERT, '--sender', BANK, '--at', newer.isoformat(),
                                                             '--now', (newer + mc.dt.timedelta(minutes=2)).isoformat()))
                            self.assertNotEqual(result['verdict'], 'receipt')
                    self.assertEqual(mc.find_question(mc.load_questions(self.data), old)['status'], 'awaiting_answer')
                    self.assertEqual(mc.find_question(mc.load_questions(self.data), fresh)['status'],
                                     'awaiting_answer' if entry == 'ask' else 'open')

    def test_rejected_ambiguous_receipt_does_not_hide_a_separate_original_receipt(self):
        old = self.seed(when='2026-11-01T09:00')
        mc.ask(self.data, 'Yours?', qid=old, now=at('2026-11-01T10:00'), find=finder(), said=nobody)
        self.seed(when='2026-11-02T23:00')
        ambiguous = dict(RECEIPT, id=91, ts=at('2026-11-02T21:00').timestamp())
        original = dict(RECEIPT, id=92, ts=at('2026-11-01T10:00').timestamp())
        with patch.object(mc.charges, 'show', lambda row, deadline=None, **kw: row['subject'] + '\n' + row['body']):
            mc.follow(self.data, at('2026-11-03T10:00'), self.root, find=finder(ambiguous, original), said=nobody)
        question = mc.find_question(mc.load_questions(self.data), old)
        self.assertEqual(question['status'], 'closed')
        self.assertEqual(question['explanation']['msgs'], 92)

    def test_processor_receipt_uses_the_same_minute_allowance_for_competing_charges(self):
        # receipt time | the two card matches both include the boundary allowance
        for received, fresh_status in (('09:15:00', 'open'), ('09:15:45', 'open'),
                                       ('09:16:00', 'open'), ('09:16:00.001', 'closed')):
            with self.subTest(received=received):
                self.data = self.tmp / received.replace(':', '')
                old = mc.screen(ALERT, BANK, at('2026-11-01T09:00:00'), at('2026-11-01T09:00:00'),
                                data=self.data, find=finder(), said=nobody, item='sms:acme')['id']
                mc.ask(self.data, 'Yours?', qid=old, now=at('2026-11-01T09:00:00'), find=finder(), said=nobody)
                text = ALERT.replace('ACME * EATS PENDING', 'INITECH')
                fresh = mc.screen(text, BANK, at('2026-11-01T09:00:30'), at('2026-11-01T09:00:30'),
                                  data=self.data, find=finder(), said=nobody, item='sms:initech')['id']
                receipt = {'id': 91, 'ts': at('2026-11-01T' + received).timestamp(), 'sender': 'Processor',
                           'subject': 'Your payment receipt', 'body': 'Payment received EUR 12.34 on card 1111'}
                with patch.object(mc.charges, 'show', lambda row, deadline=None, **kw: row['subject'] + '\n' + row['body']):
                    mc.follow(self.data, at('2026-11-01T10:00'), self.root, find=Finder([receipt]), said=nobody)
                self.assertEqual(mc.find_question(mc.load_questions(self.data), old)['status'], 'awaiting_answer')
                self.assertEqual(mc.find_question(mc.load_questions(self.data), fresh)['status'], fresh_status)

    def test_later_mail_cannot_fill_the_receipt_search_page_before_date_filtering(self):
        old = self.seed(when='2026-11-01T09:00')
        mc.ask(self.data, 'Yours?', qid=old, now=at('2026-11-01T10:00'), find=finder(), said=nobody)
        receipt = dict(RECEIPT, id=92, ts=at('2026-11-01T10:00').timestamp())
        later = [dict(RECEIPT, id=n + 100, ts=at('2026-12-01T10:00').timestamp() + n) for n in range(60)]
        archive = Finder([receipt, *later])
        with patch.object(mc.charges, 'show', lambda row, deadline=None, **kw: row['subject'] + '\n' + row['body']):
            mc.follow(self.data, at('2026-12-06T10:00'), self.root, find=archive, said=nobody)
        question = mc.find_question(mc.load_questions(self.data), old)
        self.assertEqual(question['status'], 'closed')
        self.assertEqual(question['explanation']['msgs'], 92)
        self.assertTrue(all(call[2] == '2026-11-03' for call in archive.calls))

    def seed(self, amount='12.34', when='2026-11-10T09:00'):
        text = ALERT.replace('12.34', amount)
        result = mc.screen(text, BANK, at(when), at(when), data=self.data, find=finder(), said=nobody)
        return result['id']

    def fire(self, when='2026-11-11T10:00', n=0):
        return mc.run_check(self.wd, f'r{n}', self.data, self.root, at(when), finder(), nobody)

    def cli(self, *args):
        out = io.StringIO()
        with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
            self.assertEqual(mc.main(list(args)), 0)
        return out.getvalue()

    def test_never_asked_25_hours_emit_one_daily_list(self):
        first, second = self.seed(), self.seed('23.45')
        self.assertEqual(self.fire('2026-11-11T09:00'), '')
        self.assertIn('2 unasked charges', self.fire())
        self.assertEqual(self.fire(n=1), '')
        self.assertEqual(self.fire(n=2), '')
        text = mc.unasked(self.data, at('2026-11-11T10:00'), find=finder(), said=nobody)
        self.assertIn(first, text)
        self.assertIn(second, text)
        self.assertNotIn(first, mc.unasked(self.data, at('2026-11-11T10:01'), find=finder(), said=nobody))

    def test_direct_ask_is_not_blocked_by_another_pending_question(self):
        first, second = self.seed(), self.seed('23.45')
        for qid in (first, second):
            self.assertEqual(mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-11T10:00'),
                                    find=finder(), said=nobody)[0], 0)
        self.assertEqual(len(mc.find_question(mc.load_questions(self.data), second)['asks']), 1)

    def test_explicit_never_asked_charge_case_joins_daily_list(self):
        self.case('charge', when=at('2026-11-10T09:00'), deadline='2026-12-01', reference='card ending 1111')
        self.assertIn('unasked charges', self.fire())
        self.assertEqual(self.fire(n=1), '')

    def test_unasked_age_class_always_uses_daily_list(self):
        # age in days | one recorded case, daily first ask, no conversion/third-question message
        for age in (2, 8, 70):
            with self.subTest(age=age):
                self.data = self.tmp / f'age-{age}'
                self.wd = self.tmp / f'wd-{age}'
                self.wd.mkdir()
                when = at('2026-11-11T10:00') - mc.dt.timedelta(days=age)
                qid = self.seed(when=when.isoformat())
                event = self.fire()
                self.assertIn('money-cases unasked --ask', event)
                self.assertNotIn("he didn't answer", event)
                cases = mc.load(self.data)['cases']
                self.assertEqual(len(cases), 1)
                self.assertEqual(cases[0]['merchant'], mc.UNMATCHED)
                q = mc.find_question(mc.load_questions(self.data), qid)
                self.assertEqual(q['case_opened'], cases[0]['id'])
                self.assertEqual(q['asks'], [])
                self.assertEqual(self.fire(n=1), '')

    def test_purchase_note_binds_charge_identity_across_input_channels(self):
        # same channel + new item, even within two minutes: distinct charge
        # different channel + copy: the same question
        for minutes in (0, 1, 5):
            with self.subTest(minutes=minutes):
                self.data = self.tmp / f'purchase-{minutes}'
                mc.note_purchase(self.data, 'ACME EATS', '12.34', 'EUR', '1111', 'owner', 'thread:purchase',
                                 now=at('2026-11-10T09:00'))
                first = mc.screen(ALERT, BANK, at('2026-11-10T09:00'), at('2026-11-10T09:00'),
                                  data=self.data, find=finder(), said=nobody, item='sms:first')
                later = at('2026-11-10T09:00') + mc.dt.timedelta(minutes=minutes)
                second = mc.screen(ALERT, BANK, later, later, data=self.data, find=finder(), said=nobody,
                                   item='sms:second')
                self.assertEqual(first['verdict'], 'explained')
                self.assertNotEqual(second['verdict'], 'explained')
                copy = mc.screen(ALERT, 'alerts@emiratesnbd.com', at('2026-11-10T09:00'), later,
                                 data=self.data, find=finder(), said=nobody, item='mail:first')
                self.assertEqual(copy['verdict'] == 'explained', minutes != 0)

    def test_batch_purchase_claim_conflict_does_not_abort_check(self):
        first = self.seed(when='2026-11-10T09:00')
        second = self.seed(when='2026-11-10T09:05')
        mc.note_purchase(self.data, 'ACME EATS', '12.34', 'EUR', '1111', 'owner', 'thread:purchase',
                         now=at('2026-11-10T09:00'))
        self.fire()
        questions = {q['id']: q for q in mc.load_questions(self.data)['questions']}
        self.assertEqual(questions[first]['status'], 'closed')
        self.assertEqual(questions[second]['status'], 'open')
        self.assertTrue((self.wd / 'pings.json').exists())
        # A retry reads other sources and includes the unexplained second charge in the daily list.
        self.assertIn('1 unasked charges', self.fire(n=1))

    def test_legacy_linked_case_migrates_with_asked_question(self):
        qid = self.seed()
        with mc.Locked(self.data, 'questions') as book:
            q = book['questions'][0]
            mc.case_from(self.data, q, at('2026-11-10T10:00'), 'check', self.root)
            q['asks'] = [{'at': '2026-11-10T09:15+04:00', 'question': 'Yours?'}]
        self.fire()
        q = mc.find_question(mc.load_questions(self.data), qid)
        self.assertEqual(q['status'], 'awaiting_answer')
        case = mc.find(mc.load(self.data), q['case'])
        self.assertEqual(case['status'], 'awaiting_answer')
        self.assertIn('awaiting_answer', self.cli('list', '--json'))
        self.assertIn('awaiting answer', self.cli('brief'))

    def test_direct_ask_and_daily_list_cannot_first_ask_the_same_item(self):
        first, second = self.seed(), self.seed('23.45')
        self.assertIn('2 unasked charges', self.fire())
        self.assertEqual(mc.ask(self.data, 'Yours?', qid=second, now=at('2026-11-11T10:01'),
                                find=finder(), said=nobody)[0], 0)
        text = mc.unasked(self.data, at('2026-11-11T10:02'), find=finder(), said=nobody)
        self.assertIn(first, text)
        self.assertNotIn(second, text)

    def test_sourced_question_close_cascades_to_parent_and_releases_queue(self):
        first, second = self.seed(), self.seed('23.45')
        with mc.Locked(self.data, 'questions') as book:
            q = mc.find_question(book, first)
            q['asks'] = [{'at': '2026-11-10T10:00+04:00', 'question': 'Yours?'}]
            mc.case_from(self.data, q, at('2026-11-10T11:00'), 'check', self.root)
            cid = q['case']
        mc.close(self.data, first, 'explained by invoice', source='mail:invoice', at=at('2026-11-11T09:00'))
        self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'closed')
        self.assertIn('1 unasked charges', self.fire())

    def test_bill_and_yes_no_keys_survive_full_retention_class(self):
        self.bill()
        self.assertIn('balance after credits', self.fire())
        self.deliver('2026-11-11T10:00')
        self.fire('2026-11-11T10:15', 1)
        self.assertIn('Yes or no', self.fire('2026-11-13T10:00', 2))
        self.deliver('2026-11-13T10:00')
        self.fire('2026-11-13T10:15', 3)
        # retention boundary | no second bill ask, no repeated yes/no
        for days in (61, 90, 180):
            with self.subTest(days=days):
                when = at('2026-11-13T10:00') + mc.dt.timedelta(days=days)
                event = self.fire(when.isoformat(), days)
                self.assertNotIn('Ask now', event)
                self.assertNotIn('Yes or no', event)
                self.assertIn('awaiting answer', self.cli('brief'))

    def test_case_answer_releases_reservation_without_reacquiring_consumed_ask(self):
        self.case('old-charge', when=at('2026-11-09T09:00'), deadline='2026-12-01', reference='card ending 1111')
        qid = self.seed()
        self.assertIn('unasked charges', self.fire())
        mc.unasked(self.data, at('2026-11-11T10:00'), find=finder(), said=nobody)
        self.deliver('2026-11-11T10:00')
        self.fire('2026-11-11T10:15', 1)
        mc.update(self.data, 'old-charge', {}, reply='owner:answer', at=at('2026-11-11T11:00'))
        self.assertEqual(self.fire('2026-11-11T11:15', 2), '')
        row = mc.find(mc.load(self.data), 'old-charge')
        self.assertEqual(row['status'], 'open')
        self.assertNotIn('queued', row)
        self.assertEqual(len(row['asks']), 1)

    def test_ask_explanation_class_closes_linked_case_and_releases_queue(self):
        # evidence | initial note state: receipt / unbound purchase / purchase bound to this QID
        for evidence in ('receipt', 'purchase', 'bound-purchase'):
            with self.subTest(evidence=evidence):
                self.data = self.tmp / evidence
                self.wd = self.tmp / ('wd-' + evidence)
                self.wd.mkdir()
                first, second = self.seed(), self.seed('23.45')
                with mc.Locked(self.data, 'questions') as book:
                    q = mc.find_question(book, first)
                    q['asks'] = [{'at': '2026-11-10T10:00+04:00', 'question': 'Yours?'}]
                    mc.case_from(self.data, q, at('2026-11-10T11:00'), 'check', self.root)
                    cid = q['case']
                if evidence != 'receipt':
                    mc.note_purchase(self.data, 'ACME EATS', '12.34', 'EUR', '1111', 'owner', 'thread:purchase',
                                     now=at('2026-11-10T09:00'))
                    if evidence == 'bound-purchase':
                        hit = mc.purchase_match(self.data, mc.charges.parse(ALERT, BANK), at('2026-11-10T09:00'), first)
                        self.assertTrue(mc.bind_purchase(self.data, hit, at('2026-11-10T09:00'), first))
                receipt = dict(RECEIPT, ts=at('2026-11-10T10:00').timestamp())
                with patch.object(mc.charges, 'show', lambda row, deadline=None, **kw: row['subject'] + '\n' + row['body']):
                    rc, reason = mc.ask(self.data, 'Yours?', qid=first, now=at('2026-11-11T10:00'),
                                        find=finder(receipt) if evidence == 'receipt' else finder(), said=nobody)
                self.assertEqual(rc, mc.DONT_ASK)
                self.assertIn('explained', reason)
                self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'closed')
                self.assertIn('1 unasked charges', self.fire())

    def test_screen_explains_passed_question_then_ask_cannot_ask_it_again(self):
        qid = self.seed()
        mc.triaged(self.data, [(qid, 'sms:first', True)], at('2026-11-10T09:00'))
        mc.note_purchase(self.data, 'ACME EATS', '12.34', 'EUR', '1111', 'owner', 'thread:purchase',
                         now=at('2026-11-10T09:00'))
        result = mc.screen(ALERT, BANK, at('2026-11-10T09:00'), at('2026-11-10T09:01'), data=self.data,
                           find=finder(), said=nobody, item='sms:first')
        self.assertEqual(result['verdict'], 'explained')
        self.assertEqual(mc.find_question(mc.load_questions(self.data), qid)['status'], 'closed')
        self.assertEqual(mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-10T09:02'),
                                find=finder(), said=nobody)[0], mc.DONT_ASK)

    def test_owner_reply_timing_class_wins_over_late_delivery_reconciliation(self):
        # reply time versus delivery | newer, same second, before delayed delivery
        for reply_at, delivery_at in (('10:02', '10:00'), ('10:00', '10:00'), ('10:02', '10:10')):
            with self.subTest(reply_at=reply_at, delivery_at=delivery_at):
                suffix = reply_at.replace(':', '') + delivery_at.replace(':', '')
                self.data = self.tmp / ('reply-' + suffix)
                self.wd = self.tmp / ('wd-reply-' + suffix)
                self.wd.mkdir()
                self.case('old-charge', when=at('2026-11-09T09:00'), deadline='2026-12-01', reference='card ending 1111')
                qid = self.seed()
                self.assertIn('unasked charges', self.fire())
                with patch.object(mc, 'unasked_candidates', return_value=[dict(mc.find(mc.load(self.data), 'old-charge'), type='case', card='1111', at='2026-11-09T09:00+04:00')]):
                    mc.unasked(self.data, at('2026-11-11T10:00'), find=finder(), said=nobody)
                self.deliver('2026-11-11T' + delivery_at)
                mc.update(self.data, 'old-charge', {}, reply='owner:answer', at=at('2026-11-11T' + reply_at))
                self.assertEqual(self.fire('2026-11-11T10:15', 1), '')
                self.assertIn(qid, [r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-11T10:15'))])
                self.assertEqual(mc.find(mc.load(self.data), 'old-charge')['status'], 'open')

    def test_answered_case_key_does_not_block_a_future_bill_reminder(self):
        self.case('old-charge', when=at('2026-11-09T09:00'), deadline='2026-12-01', reference='card ending 1111')
        self.fire()
        self.deliver('2026-11-11T10:00')
        self.fire('2026-11-11T10:15', 1)
        mc.update(self.data, 'old-charge', {}, reply='owner:answer', at=at('2026-11-11T11:00'))
        self.bill(due='2026-11-12')
        self.assertIn('wio', self.fire('2026-11-11T11:15', 2))

    def test_delivery_lifecycle_class_ignores_old_cycle_but_creation_is_not_an_answer(self):
        self.case('bill', merchant='Wio bill', deadline='2026-11-10', when=at('2026-11-11T10:00'))
        mc.mark_bill_asked(self.data, ['bill|bill-ask|r0|c0'], at('2026-11-11T10:00'))
        self.assertEqual(mc.find(mc.load(self.data), 'bill')['status'], 'awaiting_answer')
        mc.close(self.data, 'bill', 'paid', source='sms:paid', at=at('2026-11-11T10:01'))
        mc.reopen(self.data, 'bill', '2026-11-12', 'payment reversed', at=at('2026-11-11T10:02'))
        mc.mark_bill_asked(self.data, ['bill|bill-ask|r0|c0'], at('2026-11-11T10:10'))
        self.assertEqual(mc.find(mc.load(self.data), 'bill')['status'], 'open')

    def test_subsecond_owner_reply_wins_for_every_case_ask_key(self):
        # key class | delivery .500, later reply .900 in the same second
        for kind in ('bill', 'payment', 'initial', 'yes-no'):
            with self.subTest(kind=kind):
                self.data = self.tmp / ('precision-' + kind)
                c = self.case('wio', merchant='Wio bill', when=at('2026-11-09T09:00'), deadline='2026-11-10')
                keys = {'bill': 'wio|bill-ask|r0|c0', 'payment': 'wio|r0|c0|payment|deadline',
                        'initial': 'wio|initial-ask|c0', 'yes-no': 'wio|ask|' + mc.answered_at(c).isoformat()}
                mc.update(self.data, 'wio', {}, reply='owner:answer', at=at('2026-11-11T10:00:00.900'))
                mc.mark_bill_asked(self.data, [keys[kind]], at('2026-11-11T10:00:00.500'))
                c = mc.find(mc.load(self.data), 'wio')
                self.assertEqual(c['status'], 'open')
                self.assertEqual(mc.answered_at(c), at('2026-11-11T10:00:00.900'))

    def test_parent_reply_closes_linked_questions_and_repairs_an_interrupted_cascade(self):
        # complete update | interrupted after the case save: both retain the owner's answer
        for cascade in (True, False):
            with self.subTest(cascade=cascade):
                self.data = self.tmp / ('cascade-' + str(cascade))
                self.wd = self.tmp / ('wd-cascade-' + str(cascade))
                self.wd.mkdir()
                first, second = self.seed(), self.seed('23.45')
                with mc.Locked(self.data, 'questions') as book:
                    q = mc.find_question(book, first)
                    q['asks'] = [{'at': '2026-11-10T10:00+04:00', 'question': 'Yours?'}]
                    mc.case_from(self.data, q, at('2026-11-10T11:00'), 'check', self.root)
                    cid = q['case']
                mc.update(self.data, cid, {}, reply='owner:answer', at=at('2026-11-11T09:00'),
                          cascade_questions=cascade)
                if cascade:
                    self.assertEqual(mc.find_question(mc.load_questions(self.data), first)['status'], 'closed')
                self.assertIn('1 unasked charges', self.fire())
                self.assertEqual(mc.find_question(mc.load_questions(self.data), first)['status'], 'closed')
                self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'open')

    def test_reminder_clock_retains_precision_after_an_owner_reply(self):
        self.case('charge', when=at('2026-11-09T09:00'), deadline='2026-11-12')
        mc.update(self.data, 'charge', {}, reply='owner:answer', at=at('2026-11-11T10:00:00.500'))
        self.assertIn('charge', self.fire('2026-11-11T10:00:00.600'))
        self.deliver('2026-11-11T10:00:00.900')
        self.fire('2026-11-11T10:15', 1)
        clock = mc.read_json(self.wd / 'pings.json', {})['clock']['charge']['at']
        self.assertEqual(mc.moment(clock), at('2026-11-11T10:00:00.900'))
        self.assertIn('Yes or no', self.fire('2026-11-13T10:00:01', 2))

    def test_acknowledgement_uses_the_answer_epoch_at_build_for_all_key_classes(self):
        # key class x reply after build (before/after delivery), or reply preceding a fresh build
        for kind in ('bill', 'payment', 'initial', 'yes-no'):
            for order in ('before-delivery', 'after-delivery', 'before-build'):
                with self.subTest(kind=kind, order=order):
                    self.data = self.tmp / ('epoch-' + kind + order)
                    c = self.case('wio', merchant='Wio bill', when=at('2026-11-09T09:00'), deadline='2026-11-10')
                    expected = {'wio': {'answer': mc.answered_at(c).isoformat()}}
                    reply_at = at('2026-11-11T10:00:00.900')
                    delivery_at = at('2026-11-11T10:10') if order == 'before-delivery' else at('2026-11-11T10:00:00.500')
                    mc.update(self.data, 'wio', {}, reply='owner:answer', at=reply_at)
                    if order == 'before-build':
                        c = mc.find(mc.load(self.data), 'wio')
                        expected = {'wio': {'answer': mc.answered_at(c).isoformat()}}
                        delivery_at = at('2026-11-11T10:10')
                    keys = {'bill': 'wio|bill-ask|r0|c0', 'payment': 'wio|r0|c0|payment|deadline',
                            'initial': 'wio|initial-ask|c0', 'yes-no': 'wio|ask|' + expected['wio']['answer']}
                    mc.mark_bill_asked(self.data, [keys[kind]], delivery_at, expected)
                    self.assertEqual(mc.find(mc.load(self.data), 'wio')['status'],
                                     'awaiting_answer' if order == 'before-build' and kind != 'initial' else 'open')

    def test_wait_and_failed_reads_do_not_bypass_receipt_gate(self):
        qid = self.seed()
        with mc.Locked(self.data, 'questions') as book:
            book['questions'][0]['wait_until'] = '2026-11-11T21:00+04:00'
        self.assertEqual(self.fire(), '')
        def broken(*a, **kw):
            raise mc.charges.Lookup('unreadable')
        event = mc.run_check(self.wd, 'failed', self.data, self.root, at('2026-11-11T22:00'), broken, nobody)
        self.assertNotIn('money-cases ask --id ' + qid, event)

    def test_awaiting_answer_survives_checks_age_and_all_listing_entry_points(self):
        qid = self.seed()
        rc, _ = mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-11T10:00'), find=finder(), said=nobody)
        self.assertEqual(rc, 0)
        for i, date in enumerate(('2026-11-11T10:15', '2026-11-20T10:00', '2027-02-01T10:00')):
            self.fire(date, i)
            q = mc.load_questions(self.data)['questions'][0]
            self.assertEqual(q['status'], 'awaiting_answer')
            self.assertIn(qid, self.cli('questions', '--json'))
            self.assertIn(qid, self.cli('list', '--json'))
            self.assertIn('awaiting_answer', self.cli('show', qid))
            self.assertIn('awaiting answer', self.cli('brief'))
        mc.answered(self.data, qid, 'mine', now=at('2027-02-01T11:00'))
        self.assertNotIn(qid, self.cli('questions', '--json'))
        parent = mc.find(mc.load(self.data), q['case_opened'])
        self.assertEqual(parent['status'], 'open')
        self.assertTrue(parent['history'][-1].get('owner'))
        self.assertIn(parent['id'], self.cli('list', '--json'))

    def test_legacy_asked_rows_are_migrated_and_moni_is_not_queued(self):
        qid = self.seed()
        with mc.Locked(self.data, 'questions') as book:
            book['questions'][0]['asks'] = [{'at': '2026-11-10T10:00+04:00', 'question': 'Yours?'}]
            q = dict(book['questions'][0], id='q-moni', card='2792', asks=[])
            book['questions'].append(q)
        self.assertEqual(self.fire(), '')
        self.assertEqual(mc.find_question(mc.load_questions(self.data), qid)['status'], 'awaiting_answer')
        self.assertNotIn('q-moni', self.cli('list', '--json'))

    def bill(self, due='2026-11-08', **kw):
        return self.case('wio', merchant='Wio credit card', amount='3532.73', state='autopay failed',
                         reference='Oct statement, card ending 7896', deadline=due,
                         when=at('2026-11-07T09:00'), **kw)

    def credit(self, cid, amount='3173.90', when='2026-11-08T08:13', card='7896', currency='AED'):
        self.case(cid, merchant=cid, amount=amount, currency=currency, when=at('2026-11-07T10:00'))
        mc.close(self.data, cid, f'Refund {currency} {amount} landed on Wio card {card}; sms:{cid}', at=at(when))

    def test_overdue_bill_jumps_pending_question_with_net_balance(self):
        qid = self.seed()
        mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-10T10:00'), find=finder(), said=nobody)
        self.bill()
        self.credit('digicert')
        self.credit('other-card', amount='100', card='2342')
        self.credit('before-statement', amount='100', when='2026-11-06T10:00')
        self.credit('wrong-currency', amount='100', currency='USD')
        event = self.fire()
        self.assertIn('balance after credits: AED 358.83', event)
        self.assertIn('Ask now even if another question is pending', event)
        self.assertNotIn('money-cases ask --id ' + qid, event)
        self.deliver('2026-11-11T10:00')
        self.fire(n=1)
        self.assertEqual(mc.find(mc.load(self.data), 'wio')['status'], 'awaiting_answer')
        self.assertIn('Wio credit card', self.cli('brief'))
        with self.assertRaisesRegex(mc.CaseError, '--source'):
            mc.close(self.data, 'wio', 'paid')
        mc.close(self.data, 'wio', 'paid', source='sms:paid')
        self.assertNotIn('Wio credit card', self.cli('brief'))

    def test_not_yet_due_bill_waits_behind_pending_question(self):
        qid = self.seed()
        mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-10T10:00'), find=finder(), said=nobody)
        self.bill(due='2026-11-12')
        self.assertEqual(self.fire(), '')
        mc.answered(self.data, qid, 'mine', now=at('2026-11-11T11:00'))
        self.assertIn('wio', self.fire('2026-11-11T11:15', 1))

    def test_latest_statement_and_closed_credit_used_once(self):
        self.bill()
        self.credit('digicert')
        with mc.Locked(self.data) as book:
            bill = mc.find(book, 'wio')
            bill['history'].append({'at': '2026-11-08T09:00+04:00', 'text': 'statement balance: AED 500.00'})
        self.credit('credit-one', amount='10', when='2026-11-09T10:00')
        self.credit('credit-two', amount='10', when='2026-11-09T10:01')
        self.assertEqual(mc.balance_after_credits(mc.find(mc.load(self.data), 'wio'), mc.load(self.data)['cases'],
                                                at('2026-11-11T10:00')), 'AED 480.00')

    def test_unposted_or_negated_refunds_are_not_credits(self):
        self.bill()
        for i, text in enumerate(('refund AED 100 expected on card 7896',
                                  'no refund AED 100 landed on card 7896',
                                  'refund AED 100 not received on card 7896')):
            with mc.Locked(self.data) as book:
                bill = mc.find(book, 'wio')
                bill['history'].append({'at': f'2026-11-09T10:0{i}+04:00', 'text': text})
        self.assertEqual(mc.balance_after_credits(mc.find(mc.load(self.data), 'wio'), mc.load(self.data)['cases'],
                                                at('2026-11-11T10:00')), 'AED 3,532.73')

    def test_credit_evidence_channel_class_counts_one_posting_once(self):
        # evidence channel | one refund case and posting, several observations
        for source in ('sms:credit', 'mail:credit', 'imessage:credit', 'statement:card.txt#1'):
            with self.subTest(source=source):
                self.data = self.tmp / source.split(':')[0]
                self.bill()
                self.credit('refund', amount='100')
                with mc.Locked(self.data) as book:
                    row = mc.find(book, 'refund')
                    duplicate = dict(row['history'][-1], source=source, at='2026-11-09T10:00+04:00')
                    row['history'].append(duplicate)
                result = mc.balance_after_credits(mc.find(mc.load(self.data), 'wio'), mc.load(self.data)['cases'],
                                                 at('2026-11-11T10:00'))
                self.assertEqual(result, 'AED 3,432.73')

    def test_statement_update_class_resets_credit_cutoff(self):
        # amount normalization | latest statement effective at the sourced update
        for amount in ('900', '900.00', '1,200.50'):
            with self.subTest(amount=amount):
                self.data = self.tmp / ('statement-' + amount)
                self.bill()
                self.credit('refund', amount='100')
                mc.update(self.data, 'wio', {'amount': amount}, source='statement:latest.txt#1',
                          at=at('2026-11-09T10:00'))
                c = mc.find(mc.load(self.data), 'wio')
                self.assertEqual(mc.balance_after_credits(c, mc.load(self.data)['cases'], at('2026-11-11T10:00')),
                                 'AED ' + format(mc.Decimal(amount.replace(',', '')), ',.2f'))

    def test_credit_corroboration_after_statement_does_not_move_posting_date(self):
        self.bill()
        self.credit('refund', amount='100')
        mc.update(self.data, 'wio', {'amount': '900'}, source='statement:latest.txt#1',
                  at=at('2026-11-09T10:00'))
        # evidence channel | arrives after the statement, describes the earlier posting
        for source in ('sms:copy', 'mail:copy', 'statement:copy.txt#1'):
            with mc.Locked(self.data) as book:
                credit = mc.find(book, 'refund')
                credit['history'].append(dict(credit['history'][1], at='2026-11-10T10:00+04:00', source=source))
        result = mc.balance_after_credits(mc.find(mc.load(self.data), 'wio'), mc.load(self.data)['cases'],
                                         at('2026-11-11T10:00'))
        self.assertEqual(result, 'AED 900.00')

    def test_due_repeat_merges_overdue_as_its_own_history_line(self):
        self.case('premium', merchant='Sukoon', amount='430.55', currency='USD', state='due 13 Nov',
                  deadline='2026-11-13', when=at('2026-11-11T09:00'))
        mc.add(self.data, 'repeat', 'Sukoon', '430.55', 'USD', 'OVERDUE since 10 Nov', 'pay', '2026-11-10',
               'Abdullah', charged='2026-11-11', repeat='premium', at=at('2026-11-12T10:00'))
        c = mc.find(mc.load(self.data), 'premium')
        self.assertEqual(c['state'], 'OVERDUE since 10 Nov')
        self.assertIn('OVERDUE since 10 Nov', [h['text'] for h in c['history']])
        # A later copy with the softer state must not downgrade it.
        mc.add(self.data, 'repeat', 'Sukoon', '430.55', 'USD', 'due 13 Nov', 'pay', '2026-11-13',
               'Abdullah', charged='2026-11-11', repeat='premium', at=at('2026-11-12T11:00'))
        self.assertEqual(mc.find(mc.load(self.data), 'premium')['state'], 'OVERDUE since 10 Nov')

    def test_chatgpt_purchase_matches_bank_descriptors(self):
        mc.note_purchase(self.data, 'ChatGPT', '1920', 'AED', '7572', 'owner', 'thread:purchase',
                         '7KXAGN5B-0004', now=at('2026-11-12T01:40'))
        for merchant in ('CHATGPT', 'OPENAI', 'OPENAI * CHATGPT SUBSCR', 'chatgpt.com'):
            with self.subTest(merchant=merchant):
                charge = {'kind': 'charge', 'merchant': merchant, 'amount': '1920.00',
                          'currency': 'AED', 'card': '7572'}
                self.assertIsNotNone(mc.purchase_match(self.data, charge, at('2026-11-12T01:51')))

    def test_future_payment_deadline_waits_but_overdue_bypasses(self):
        qid = self.seed()
        mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-10T10:00'), find=finder(), said=nobody)
        with mc.Locked(self.data) as book:
            mc.payment_in(book, {'kind': 'payment_deadline', 'institution': 'Wio', 'amount': '3532.73',
                                'currency': 'AED', 'deadline': '2026-11-12T09:00+04:00',
                                'at': '2026-11-10T10:00+04:00'}, 'sms:bill', at('2026-11-10T10:00'))
        self.assertEqual(self.fire(), '')
        self.assertIn('balance after credits: AED 3,532.73', self.fire('2026-11-12T10:00', 1))

    def test_purchase_note_explains_match_without_lookups_and_does_not_explain_mismatches(self):
        self.cli('note-purchase', '--merchant', 'ACME EATS', '--amount', '12.34', '--currency', 'EUR',
                 '--card', '1111', '--asked-by', 'owner', '--thread', 'thread:purchase', '--invoice', 'inv-4')
        # Use the command's real timestamp for the bank alert.
        note = mc.load(self.data)['purchases'][0]
        moment = mc.parse_time(note['at'])
        with patch.object(mc.charges, 'explain', side_effect=AssertionError('must not query external sources')):
            result = mc.screen(ALERT, BANK, moment, moment, data=self.data)
            self.assertEqual(result['verdict'], 'explained')
            self.assertIn('thread:purchase', result['why'])
        charge = mc.charges.parse(ALERT, BANK)
        for field, value in [('amount', '12.35'), ('currency', 'USD'), ('card', '2342'), ('merchant', 'Other')]:
            with self.subTest(field=field):
                self.assertIsNone(mc.purchase_match(self.data, dict(charge, **{field: value}), moment))
        self.assertIsNone(mc.purchase_match(self.data, charge, moment + mc.dt.timedelta(days=1)))
        self.assertIsNone(mc.purchase_match(self.data, charge, moment + mc.dt.timedelta(minutes=5)))
        self.assertIsNone(mc.purchase_match(self.data, dict(charge, kind='decline'), moment))


if __name__ == '__main__':
    import unittest
    unittest.main()
