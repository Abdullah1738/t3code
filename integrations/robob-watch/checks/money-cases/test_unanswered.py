"""Durable unanswered questions, bill priority, merge severity and delegated purchases."""
import io
import json
from contextlib import redirect_stdout
from unittest.mock import patch

from test_cases import Base, ALERT, BANK, RECEIPT, at, finder, nobody, mc


class Unanswered(Base):
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

    def test_never_asked_25_hours_queues_exactly_once_and_only_one_question(self):
        first = self.seed()
        second = self.seed('23.45')
        self.assertEqual(self.fire('2026-11-11T09:00'), '')  # strictly older than 24h
        event = self.fire()
        self.assertIn('money-cases ask --id ' + first, event)
        self.assertNotIn(second, event)
        self.assertEqual(self.fire(n=1), '')  # no runner acknowledgement needed
        self.assertEqual(self.fire(n=2), '')
        self.assertEqual(mc.load_questions(self.data)['questions'][0]['asks'], [])
        # Answering frees the queue for the next oldest question.
        mc.answered(self.data, first, 'mine', now=at('2026-11-11T10:01'))
        self.assertIn(second, self.fire(n=3))

    def test_direct_ask_obeys_the_same_pending_question_queue(self):
        first, second = self.seed(), self.seed('23.45')
        self.assertEqual(mc.ask(self.data, 'Yours?', qid=first, now=at('2026-11-11T10:00'),
                                find=finder(), said=nobody)[0], 0)
        code, reason = mc.ask(self.data, 'Yours?', qid=second, now=at('2026-11-11T10:01'),
                              find=finder(), said=nobody)
        self.assertEqual(code, mc.DONT_ASK)
        self.assertIn('kept in the queue', reason)
        self.assertEqual(mc.find_question(mc.load_questions(self.data), second)['asks'], [])

    def test_explicit_never_asked_charge_case_queues_once(self):
        self.case('charge', when=at('2026-11-10T09:00'), deadline='2026-12-01')
        self.assertIn('unasked charge', self.fire())
        self.assertEqual(self.fire(n=1), '')

    def test_unasked_age_class_always_uses_first_question_queue(self):
        # age in days | expected: one first ask, never a conversion/third-question message
        for age in (2, 8, 70):
            with self.subTest(age=age):
                self.data = self.tmp / f'age-{age}'
                self.wd = self.tmp / f'wd-{age}'
                self.wd.mkdir()
                when = at('2026-11-11T10:00') - mc.dt.timedelta(days=age)
                qid = self.seed(when=when.isoformat())
                event = self.fire()
                self.assertIn('money-cases ask --id ' + qid, event)
                self.assertNotIn("he didn't answer", event)
                self.assertEqual(mc.load(self.data)['cases'], [])
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
        # A retry reads other sources and queues the unexplained second charge.
        self.assertIn(second, self.fire(n=1))

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

    def test_direct_ask_cannot_jump_a_watchers_queue_reservation(self):
        first, second = self.seed(), self.seed('23.45')
        self.assertIn(first, self.fire())
        self.assertEqual(mc.ask(self.data, 'Yours?', qid=second, now=at('2026-11-11T10:01'),
                                find=finder(), said=nobody)[0], mc.DONT_ASK)
        self.assertEqual(mc.ask(self.data, 'Yours?', qid=first, now=at('2026-11-11T10:02'),
                                find=finder(), said=nobody)[0], 0)
        mc.answered(self.data, first, 'mine', now=at('2026-11-11T10:03'))
        self.assertIn(second, self.fire(n=1))

    def test_sourced_question_close_cascades_to_parent_and_releases_queue(self):
        first, second = self.seed(), self.seed('23.45')
        with mc.Locked(self.data, 'questions') as book:
            q = mc.find_question(book, first)
            q['asks'] = [{'at': '2026-11-10T10:00+04:00', 'question': 'Yours?'}]
            mc.case_from(self.data, q, at('2026-11-10T11:00'), 'check', self.root)
            cid = q['case']
        mc.close(self.data, first, 'explained by invoice', source='mail:invoice', at=at('2026-11-11T09:00'))
        self.assertEqual(mc.find(mc.load(self.data), cid)['status'], 'closed')
        self.assertIn(second, self.fire())

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
        self.case('old-charge', when=at('2026-11-09T09:00'), deadline='2026-12-01')
        qid = self.seed()
        self.assertIn('old-charge', self.fire())
        self.deliver('2026-11-11T10:00')
        self.fire('2026-11-11T10:15', 1)
        mc.update(self.data, 'old-charge', {}, reply='owner:answer', at=at('2026-11-11T11:00'))
        self.assertIn(qid, self.fire('2026-11-11T11:15', 2))
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
                self.assertIn(second, self.fire())

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
                self.case('old-charge', when=at('2026-11-09T09:00'), deadline='2026-12-01')
                qid = self.seed()
                self.assertIn('old-charge', self.fire())
                self.deliver('2026-11-11T' + delivery_at)
                mc.update(self.data, 'old-charge', {}, reply='owner:answer', at=at('2026-11-11T' + reply_at))
                self.assertIn(qid, self.fire('2026-11-11T10:15', 1))
                self.assertEqual(mc.find(mc.load(self.data), 'old-charge')['status'], 'open')

    def test_answered_case_key_does_not_block_a_future_bill_reminder(self):
        self.case('old-charge', when=at('2026-11-09T09:00'), deadline='2026-12-01')
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
                self.assertIn(second, self.fire())
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
        self.assertNotIn(qid, self.cli('list', '--json'))

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
