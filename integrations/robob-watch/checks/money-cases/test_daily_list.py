"""Daily first asks share the receipt gate and retain durable answer state."""
import io
import json
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch

from test_cases import Base, ALERT, BANK, RECEIPT, at, finder, nobody, mc


class DailyList(Base):
    def seed(self, amount='12.34', when='2026-11-10T09:00', card='1111', merchant='ACME EATS'):
        text = ALERT.replace('12.34', amount).replace('1111', card).replace('ACME * EATS PENDING', merchant)
        return mc.screen(text, BANK, at(when), at(when), data=self.data,
                         find=finder(), said=nobody)['id']

    def fire(self, when='2026-11-11T10:00'):
        return mc.run_check(self.wd, when, self.data, self.root, at(when), finder(), nobody)

    def ask_list(self, when='2026-11-11T10:00', **kw):
        return mc.unasked(self.data, at(when), find=kw.pop('find', finder()), said=nobody, **kw)

    def cli(self, *args):
        out = io.StringIO()
        with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
            self.assertEqual(mc.main(list(args)), 0)
        return out.getvalue()

    def test_daily_event_ignores_three_awaiting_questions_and_only_new_items_follow(self):
        for n in range(3):
            qid = self.seed(str(20+n))
            mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-10T10:00'), find=finder(), said=nobody)
        fresh = [self.seed(str(40+n)) for n in range(5)]
        event = self.fire('2026-11-11T09:01')
        self.assertIn('5 unasked charges older than 24 h', event)
        self.assertNotIn('ask --id', event)
        state = mc.read_json(self.wd / 'pings.json', {})
        self.assertIn('daily-unasked|2026-11-11', state['built'])
        self.assertEqual(self.fire(), '')
        text = self.ask_list()
        self.assertEqual(sum(qid in text for qid in fresh), 5)
        self.seed('99', '2026-11-11T09:00')
        self.deliver('2026-11-11T10:00')
        self.assertEqual(self.fire('2026-11-12T09:00'), '')
        self.assertIn('1 unasked charges', self.fire('2026-11-12T09:01'))
        self.assertEqual(len(mc.unasked_candidates(self.data, at('2026-11-12T10:00'))), 1)

    def test_quiet_hours_and_dubai_day(self):
        self.seed()
        self.assertEqual(self.fire('2026-11-12T07:30'), '')
        self.assertIn('1 unasked charges', self.fire('2026-11-12T08:01'))
        self.assertEqual(self.fire('2026-11-12T08:15'), '')
        self.assertEqual(mc.read_json(self.wd / 'pings.json', {})['built'].keys(), {'daily-unasked|2026-11-12'})

    def test_read_only_cli_and_strict_candidate_boundaries(self):
        qid = self.seed()
        for label, change in [('asked', {'asks': [{'at': '2026-11-10T10:00+04:00'}]}),
                              ('waiting', {'wait_until': '2026-11-12T09:00+04:00'}),
                              ('unreadable', {'unverified': True}), ('closed', {'status': 'closed'}),
                              ('moni', {'card': '2792'}), ('young', {'at': '2026-11-11T09:00+04:00'})]:
            with mc.Locked(self.data, 'questions') as book:
                book['questions'].append(dict(book['questions'][0], id='q-'+label, **change))
        path = self.data / 'questions.json'
        before = path.stat().st_mtime_ns
        with patch.object(mc, 'now_dubai', return_value=at('2026-11-11T10:00')):
            rows = json.loads(self.cli('unasked', '--json'))
            self.assertEqual([r['id'] for r in rows], [qid])
            self.assertIn(qid, self.cli('unasked'))
        self.assertEqual(before, path.stat().st_mtime_ns)

    def test_receipt_purchase_subscription_order_and_owner_settle_before_listing(self):
        receipt_q = self.seed()
        purchase_q = self.seed('23.45')
        sub_q = self.seed('34.56', merchant='Netflix')
        order_q = self.seed('45.67', merchant='noon')
        owner_q = self.seed('56.78', merchant='Other')
        listed = self.seed('67.89')
        moni = self.seed('78.90', card='2792')
        unreadable = self.seed('89.01')
        mc.note_purchase(self.data, 'ACME EATS', '23.45', 'EUR', '1111', 'owner', 'thread:buy', now=at('2026-11-10T09:00'))
        mc.sub_change(self.data, 'netflix', dict(merchant='Netflix', amount='34.56', currency='EUR',
                      last4='1111', cadence='monthly', next_renewal='2026-11-10'), 'add')
        real = mc.explain_charge
        def explain(data, charge, *args, **kw):
            if charge['amount'] == '89.01':
                return dict(verdict='ask', why='unreadable', errors=['mail: unreadable'])
            if charge['amount'] in ('45.67', '56.78'):
                return dict(verdict='receipt' if charge['amount'] == '45.67' else 'owner',
                            why='verified order' if charge['amount'] == '45.67' else 'his words', errors=[])
            return real(data, charge, *args, **kw)
        receipt = dict(RECEIPT, ts=at('2026-11-10T10:00').timestamp())
        with patch.object(mc, 'explain_charge', explain), patch.object(mc.charges, 'show', lambda r, deadline=None, **kw: r['subject']+'\n'+r['body']):
            text = self.ask_list(find=finder(receipt))
        lines = text.splitlines()
        self.assertEqual(len([line for line in lines if line.startswith('q-')]), 1)
        self.assertTrue(lines[0].startswith(listed+':'))
        self.assertIn('••1111, 2026-11-10', lines[0])
        for qid in (receipt_q, purchase_q, sub_q, order_q, owner_q):
            q = mc.find_question(mc.load_questions(self.data), qid)
            self.assertEqual(q['status'], 'closed')
            self.assertIn(qid, lines[-1])
        for qid in (moni, unreadable):
            self.assertNotIn(qid, text)
            self.assertEqual(mc.find_question(mc.load_questions(self.data), qid)['asks'], [])
        q = mc.find_question(mc.load_questions(self.data), listed)
        self.assertEqual(q['status'], 'awaiting_answer')
        self.assertEqual(q['asks'][0]['question'], 'daily list 2026-11-11')
        self.assertIn('awaiting answer', self.cli('brief'))
        for args in [('list', '--json'), ('questions', '--json')]:
            self.assertIn(listed, self.cli(*args))
        self.assertIn(unreadable, [r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-12T10:00'))])
        with patch.object(mc, 'explain_charge', explain):
            self.assertNotIn(listed, self.ask_list())

    def test_charge_case_uses_same_gate_and_reply_cascade(self):
        self.case('charge', when=at('2026-11-10T09:00'), deadline='2026-12-01', reference='card ending 1111')
        self.assertIn('charge:', self.ask_list())
        case = mc.find(mc.load(self.data), 'charge')
        self.assertEqual(case['status'], 'awaiting_answer')
        self.assertEqual(len(case['asks']), 1)
        self.assertNotIn('charge:', self.ask_list())
        q = mc.load_questions(self.data)['questions'][0]
        self.assertEqual(q['status'], 'awaiting_answer')
        mc.update(self.data, 'charge', {}, reply='owner:mine', at=at('2026-11-11T11:00'))
        self.assertEqual(mc.find(mc.load(self.data), 'charge')['status'], 'open')
        self.assertEqual(mc.find_question(mc.load_questions(self.data), q['id'])['status'], 'closed')
        self.assertNotIn('charge:', self.ask_list('2026-11-12T10:00'))

    def test_expired_wait_routes_to_daily_list(self):
        qid = self.seed()
        with mc.Locked(self.data, 'questions') as book:
            book['questions'][0]['wait_until'] = '2026-11-11T11:00+04:00'
        self.assertEqual(self.fire(), '')
        event = self.fire('2026-11-11T11:01')
        self.assertIn('1 unasked charges', event)
        self.assertNotIn('ask --id', event)
        self.assertIn(qid, self.ask_list('2026-11-11T11:01'))

    def test_budget_never_lists_unscreened_items_and_oldest_first(self):
        old = self.seed('11', '2026-11-09T09:00')
        new = self.seed('22')
        self.assertNotIn(old, self.ask_list(budget=0))
        self.assertFalse(any(q['asks'] for q in mc.load_questions(self.data)['questions']))
        text = self.ask_list()
        self.assertLess(text.index(old), text.index(new))
        self.assertNotIn(old, self.ask_list())

    def test_overdue_bill_priority_and_net_balance_are_unchanged(self):
        self.seed()
        self.case('bill', merchant='Wio bill', amount='100', reference='card ending 1111',
                  when=at('2026-11-08T09:00'), deadline='2026-11-09')
        self.case('credit', amount='10', reference='card ending 1111', when=at('2026-11-08T10:00'))
        mc.close(self.data, 'credit', 'Refund AED 10 landed on card 1111', at=at('2026-11-09T10:00'))
        self.case('future-bill', merchant='Other bill', reference='card ending 1111', deadline='2026-12-01')
        event = self.fire()
        self.assertIn('balance after credits: AED 90.00', event)
        self.assertLess(event.index('bill:'), event.index('unasked charges'))
        ids = [r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-11T10:00'))]
        self.assertNotIn('bill', ids)
        self.assertNotIn('future-bill', ids)

    def test_manual_ask_winning_during_screening_is_not_listed_twice(self):
        qid = self.seed()
        real = mc.explain_charge
        entered = False
        def competing(*args, **kw):
            nonlocal entered
            if not entered:
                entered = True
                self.assertEqual(mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-11T10:00'),
                                        find=finder(), said=nobody)[0], 0)
            return real(*args, **kw)
        with patch.object(mc, 'explain_charge', competing):
            self.assertNotIn(qid, self.ask_list())
        self.assertEqual(len(mc.find_question(mc.load_questions(self.data), qid)['asks']), 1)

    def test_case_commit_recovers_when_question_save_is_interrupted(self):
        self.case('charge', reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
        write = mc.write_json
        def interrupted(path, book, *args, **kw):
            if path.name == 'questions.json' and any(q.get('asks') for q in book['questions']):
                raise mc.CheckTimeout('question save interrupted')
            return write(path, book, *args, **kw)
        with patch.object(mc, 'write_json', interrupted):
            text = self.ask_list()
        self.assertIn('charge:', text)
        self.assertNotIn('No charges ready', text)
        self.assertNotIn('charge:', self.ask_list('2026-11-12T10:00'))
        self.assertEqual(mc.find(mc.load(self.data), 'charge')['status'], 'awaiting_answer')
        self.assertEqual(mc.unasked_candidates(self.data, at('2026-11-12T10:00')), [])
        q = mc.load_questions(self.data)['questions'][0]
        self.assertNotEqual(mc.ask(self.data, 'daily list', qid=q['id'], daily=True,
                                   now=at('2026-11-12T10:00'), find=finder(), said=nobody)[0], 0)
        self.assertEqual(len(mc.find(mc.load(self.data), 'charge')['asks']), 1)

    def test_case_subscription_is_settled_and_unreadable_case_never_pings_alone(self):
        self.case('sub-charge', merchant='Netflix', amount='34.56', currency='EUR',
                  reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
        mc.sub_change(self.data, 'netflix', dict(merchant='Netflix', amount='34.56', currency='EUR',
                      last4='1111', cadence='monthly', next_renewal='2026-11-10'), 'add')
        text = self.ask_list()
        self.assertIn('Explained and settled: sub-charge', text)
        self.assertEqual(mc.find(mc.load(self.data), 'sub-charge')['status'], 'closed')
        self.case('unreadable', reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
        with patch.object(mc, 'explain_charge', return_value=dict(verdict='unverified', why='unreadable', errors=['mail: unreadable'])):
            self.assertNotIn('unreadable:', self.ask_list())
        qs = mc.load_questions(self.data)['questions']
        self.assertEqual(mc.question_entries(qs, at('2026-11-11T10:00'), {}), [])
        self.assertIn('unreadable', [r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-12T10:00'))])

    def test_cli_ask_prints_one_message_and_check_does_not_ask_it_again(self):
        first, second = self.seed('11'), self.seed('22')
        with patch.object(mc, 'now_dubai', return_value=at('2026-11-11T10:00')), \
             patch.object(mc.charges, 'search', finder()), patch.object(mc.charges, 'owner_texts', nobody):
            text = self.cli('unasked', '--ask')
        self.assertIn(first, text)
        self.assertIn(second, text)
        self.assertEqual(len(text.splitlines()), 2)
        self.assertEqual(self.fire(), '')
        self.assertEqual(len(mc.find_question(mc.load_questions(self.data), first)['asks']), 1)

    def test_case_card_evidence_class_never_uses_order_numbers_or_years(self):
        # reference | last-four evidence; arbitrary four-digit numbers are not cards
        for reference, card in [('card ending 1111, invoice 2026', '1111'),
                                ('card ending in 1111', '1111'), ('card ••1111', '1111'),
                                ('card ****1111', '1111'), ('invoice 2026 order 1234', ''),
                                ('card ending 1111 or ending 2342', '')]:
            with self.subTest(reference=reference):
                self.data = self.tmp / reference.replace('/', '-')
                self.case('charge', reference=reference, when=at('2026-11-10T09:00'), deadline='2026-12-01')
                rows = mc.unasked_candidates(self.data, at('2026-11-11T10:00'))
                self.assertEqual([r['card'] for r in rows], [card] if card else [])
                text = self.ask_list()
                self.assertEqual('charge:' in text, bool(card))

    def test_late_receipt_closes_daily_case_without_treating_ask_as_manual_work(self):
        self.case('charge', merchant='Acme', amount='120.50', reference='card ending 1111',
                  when=at('2026-11-10T09:00'), deadline='2026-12-01')
        self.ask_list()
        receipt = dict(RECEIPT, ts=at('2026-11-10T10:00').timestamp(),
                       body='Receipt for your Acme order. Paid AED 120.50 on card 1111.')
        with patch.object(mc.charges, 'show', lambda r, deadline=None, **kw: r['subject']+'\n'+r['body']):
            mc.follow(self.data, at('2026-11-12T10:00'), self.root, find=finder(receipt), said=nobody)
        self.assertEqual(mc.find(mc.load(self.data), 'charge')['status'], 'closed')
        self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'closed')

    def test_manual_reask_and_limit_reuse_daily_cases_parent_and_reply_cascade(self):
        self.case('charge', reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
        self.ask_list()
        qid = mc.load_questions(self.data)['questions'][0]['id']
        rc, _ = mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-12T10:00'), find=finder(), said=nobody)
        self.assertEqual(rc, 0)
        self.assertEqual(len(mc.find(mc.load(self.data), 'charge')['asks']), 2)
        rc, text = mc.ask(self.data, 'Yours?', qid=qid, now=at('2026-11-13T10:00'), find=finder(), said=nobody)
        self.assertEqual(rc, mc.DONT_ASK)
        self.assertEqual([c['id'] for c in mc.load(self.data)['cases']], ['charge'])
        self.assertEqual(mc.find_question(mc.load_questions(self.data), qid)['case'], 'charge')
        mc.update(self.data, 'charge', {}, reply='owner:mine', at=at('2026-11-13T11:00'))
        self.assertEqual(mc.find_question(mc.load_questions(self.data), qid)['status'], 'closed')

    def test_previous_cycle_link_shapes_do_not_suppress_reopened_case(self):
        # persisted link | metadata migration | interrupted close cascade
        for shape in ('current', 'legacy', 'interrupted-close'):
            with self.subTest(shape=shape):
                self.data = self.tmp / shape
                self.case('charge', reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
                self.ask_list()
                old = mc.load_questions(self.data)['questions'][0]['id']
                mc.close(self.data, 'charge', 'owner settled', source='sms:close', at=at('2026-11-11T11:00'))
                mc.reopen(self.data, 'charge', '2026-12-01', 'check again', at=at('2026-11-12T09:00'))
                if shape != 'current':
                    with mc.Locked(self.data, 'questions') as book:
                        q = mc.find_question(book, old)
                        q.pop('case_cycle', None)
                        if shape == 'interrupted-close':
                            q['status'] = 'awaiting_answer'
                self.assertEqual([r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-12T10:00'))], ['charge'])
                self.assertIn('charge:', self.ask_list('2026-11-12T10:00'))
                qs = mc.load_questions(self.data)['questions']
                self.assertEqual(len(qs), 2)
                self.assertEqual(mc.find_question({'questions': qs}, old)['status'], 'closed')
                self.assertEqual(qs[-1]['case_cycle'], 1)
                self.assertEqual(qs[-1]['status'], 'awaiting_answer')

    def test_failed_screens_rotate_so_later_items_are_attempted_next_day(self):
        for n in range(8):
            self.case('charge-'+str(n), merchant=('Slow '+str(n)) if n < 7 else 'Fast',
                      reference='card ending 1111', when=at('2026-09-01T09:00'), deadline='2026-12-01', distinct=True)
        clock = [1000.0]
        def screen(data, charge, *args, **kw):
            if charge['merchant'].startswith('Slow'):
                clock[0] += 6
                raise mc.LookupTimeout('unreadable')
            return dict(verdict='ask', why='screened', errors=[])
        with patch.object(mc.time, 'time', side_effect=lambda: clock[0]), patch.object(mc, 'explain_charge', screen):
            first = self.ask_list()
            self.assertNotIn('charge-7:', first)
            # A real check follows another active question, invoking prune_questions.
            waiting = self.seed('99', '2026-11-10T09:00')
            with mc.Locked(self.data, 'questions') as book:
                mc.find_question(book, waiting)['wait_until'] = '2026-12-01T09:00+04:00'
            mc.run_check(self.wd, 'between-days', self.data, self.root, at('2026-11-11T10:15'), finder(), nobody)
            self.assertEqual(len([q for q in mc.load_questions(self.data)['questions'] if q.get('by') == 'daily']), 7)
            second = self.ask_list('2026-11-12T10:00')
            self.assertIn('charge-7:', second)
            self.assertNotIn('charge-0:', second)
        qs = mc.load_questions(self.data)['questions']
        self.assertEqual(sum(bool(q['asks']) for q in qs), 1)
        self.assertTrue(all(q.get('daily_checked') for q in qs if q.get('case')))

    def test_rotation_preserves_oldest_first_output(self):
        old, newer = self.seed('11', '2026-11-09T09:00'), self.seed('22')
        with mc.Locked(self.data, 'questions') as book:
            mc.find_question(book, old)['daily_checked'] = '2026-11-10T10:00+04:00'
        text = self.ask_list()
        self.assertLess(text.index(old), text.index(newer))

    def test_daily_event_fits_before_regular_reminder_overflow(self):
        self.seed()
        for n in range(15):
            self.case('hold-'+str(n), merchant='Held payment '+str(n), state='pending '+('details '*25),
                      next_action='check '+('receipt '*25), kind='hold', when=at('2026-11-10T09:00'), deadline='2026-11-11')
        event = self.fire()
        self.assertIn('money-cases unasked --ask', event)
        self.assertLess(event.index('unasked charges'), event.index('hold-0:'))

    def test_worked_parent_is_not_reported_settled_by_receipt_summary(self):
        self.case('worked', merchant='Acme\nStores', amount='120.50', reference='card ending 1111',
                  when=at('2026-11-10T09:00'), deadline='2026-12-01')
        mc.update(self.data, 'worked', {'state': 'refund requested'}, at=at('2026-11-10T11:00'))
        receipt = dict(RECEIPT, ts=at('2026-11-10T10:00').timestamp(),
                       body='Receipt for your Acme order. Paid AED 120.50 on card 1111.')
        with patch.object(mc.charges, 'show', lambda r, deadline=None, **kw: r['subject']+'\n'+r['body']):
            text = self.ask_list(find=finder(receipt))
        self.assertIn('Charge explained; case still open: worked Acme Stores', text)
        self.assertEqual(len(text.splitlines()), 2)
        self.assertNotIn('Explained and settled', text)
        self.assertEqual(mc.find(mc.load(self.data), 'worked')['status'], 'open')
        self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'closed')

    def test_committed_question_save_timeout_returns_its_line_once(self):
        qid = self.seed()
        write = mc.write_json
        def interrupted(path, book, *args, **kw):
            result = write(path, book, *args, **kw)
            if path.name == 'questions.json' and any(q.get('asks') for q in book['questions']):
                raise mc.CheckTimeout('after question commit')
            return result
        with patch.object(mc, 'write_json', interrupted):
            text = self.ask_list()
        self.assertIn(qid+':', text)
        self.assertNotIn(qid+':', self.ask_list())
        self.assertEqual(len(mc.find_question(mc.load_questions(self.data), qid)['asks']), 1)

    def legacy_fixture(self):
        fixture = json.loads(Path(__file__).with_name('daily_legacy.fixture.json').read_text())
        for kind in ('cases', 'questions'):
            mc.write_json(self.data / (kind + '.json'), {'version': 1, kind: fixture[kind]})
        return fixture

    def test_live_legacy_migration_dry_run_idempotence_and_new_charge(self):
        fixture = self.legacy_fixture()
        paths = [self.data / (kind + '.json') for kind in ('cases', 'questions')]
        before = [p.read_bytes() for p in paths]
        dry = self.cli('migrate-legacy-asks', '--dry-run')
        self.assertIn('Would migrate 4 legacy asks.', dry)
        for case in fixture['cases']:
            self.assertIn(case['id'], dry)
        self.assertEqual(before, [p.read_bytes() for p in paths])
        self.assertIn('Migrated 4 legacy asks.', self.cli('migrate-legacy-asks'))
        migrated = [p.read_bytes() for p in paths]
        self.assertEqual(mc.unasked_candidates(self.data, at('2026-11-14T10:00')), [])
        self.assertIn('Migrated 0 legacy asks.', self.cli('migrate-legacy-asks'))
        self.assertEqual(migrated, [p.read_bytes() for p in paths])
        for case in mc.load(self.data)['cases']:
            self.assertEqual(len(case['asks']), 1)
            self.assertEqual(case['asks'][0]['question'], 'legacy (pre-daily list)')
        # Justlife's linked answer remains answered rather than becoming pending.
        justlife = mc.find(mc.load(self.data), 'charge-26dc3e4c')
        self.assertEqual(justlife['answered_cycle'], justlife['cycle'])
        self.assertEqual(justlife['status'], 'open')
        mc.update(self.data, 'yalla-tph-mandate', {}, reply='owner:keep', at=at('2026-11-14T11:00'))
        self.assertEqual(mc.find(mc.load(self.data), 'yalla-tph-mandate')['status'], 'open')
        self.assertEqual(self.fire('2026-11-14T10:00'), '')
        new = self.seed('19.32', '2026-11-13T10:00')
        self.assertEqual([r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-14T10:01'))], [new])
        self.assertIn(new + ':', self.ask_list('2026-11-14T10:01'))

    def test_migration_scope_cutoff_bills_existing_asks_and_new_cycles(self):
        for name, when, extra in [('old', '2026-11-11T08:24', {}),
                                 ('cutoff', '2026-11-13T08:25', {}),
                                 ('new', '2026-11-13T09:00', {}),
                                 ('bill', '2026-11-10T10:00', {'merchant': 'Card bill'}),
                                 ('closed', '2026-11-10T10:00', {}),
                                 ('asked', '2026-11-10T10:00', {}),
                                 ('reopened', '2026-11-10T10:00', {})]:
            self.case(name, when=at(when), distinct=True, **extra)
        mc.close(self.data, 'closed', 'settled', at=at('2026-11-11T10:00'))
        mc.close(self.data, 'reopened', 'settled', at=at('2026-11-11T10:00'))
        mc.reopen(self.data, 'reopened', '2026-12-01', 'new charge', at=at('2026-11-13T10:00'))
        with mc.Locked(self.data) as book:
            mc.find(book, 'asked')['asks'] = [{'at': '2026-11-11T10:00+04:00', 'question': 'already asked'}]
        self.assertEqual([line.split(' ->')[0] for line in mc.migrate_legacy_asks(self.data)], ['old'])

    def test_linked_answer_or_structured_history_excludes_case_without_migration(self):
        for shape in ('linked-closed', 'linked-asked', 'linked-answered', 'owner-history'):
            with self.subTest(shape=shape):
                self.data = self.tmp / shape
                self.case('charge', reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
                if shape == 'owner-history':
                    with mc.Locked(self.data) as book:
                        book['cases'][0]['history'].append(dict(at='2026-11-10T10:00+04:00', text='his answer', owner=True))
                else:
                    qid = self.seed()
                    with mc.Locked(self.data, 'questions') as book:
                        q = mc.find_question(book, qid)
                        q.update(case='charge', status=shape.split('-')[1])
                        if shape == 'linked-asked':
                            q.update(status='case', asks=[dict(at='2026-11-10T10:00+04:00')])
                self.assertEqual(mc.unasked_candidates(self.data, at('2026-11-11T10:00')), [])
                self.assertNotIn('charge:', self.ask_list())

    def test_static_declines_are_not_counted_and_are_recorded_by_ask(self):
        for shape, ref, charged, reason in [('card', 'invoice 2026', '2026-11-10', 'card last four'),
                                           ('date', 'card ending 1111', '2026-11-09', 'charge date')]:
            with self.subTest(shape=shape):
                self.data = self.tmp / shape
                self.case('declined', reference=ref, charged=charged, when=at('2026-11-10T09:00'), deadline='2026-12-01')
                self.assertEqual(mc.unasked_candidates(self.data, at('2026-11-11T10:00')), [])
                self.assertNotIn('unasked charges', self.fire())
                self.assertNotIn('declined:', self.ask_list())
                c = mc.find(mc.load(self.data), 'declined')
                self.assertIn(reason, c['daily_skip'])
                self.assertTrue(c['daily_checked'])
                self.assertNotIn('unasked charges', self.fire('2026-11-12T10:00'))
                with patch.object(mc, 'now_dubai', return_value=at('2026-11-12T10:00')):
                    self.assertNotIn('declined:', self.cli('unasked'))
                    self.assertIn(reason, self.cli('unasked', '--all'))

    def test_runtime_decline_rearms_on_each_new_charge_or_revision_shape(self):
        # Version field | new value: every supported way to re-arm a declined row.
        for field, value in [('rev', 1), ('cycle', 1), ('amount', '121'), ('charged', '2026-11-11')]:
            with self.subTest(field=field):
                self.data = self.tmp / field
                self.case('declined', reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
                with patch.object(mc, 'daily_question', return_value=None):
                    self.assertNotIn('declined:', self.ask_list())
                self.assertEqual(mc.unasked_candidates(self.data, at('2026-11-12T10:00')), [])
                self.assertNotIn('unasked charges', self.fire('2026-11-12T10:00'))
                with mc.Locked(self.data) as book:
                    book['cases'][0][field] = value
                # A new charge day also needs a matching opening timestamp to be screenable.
                if field == 'charged':
                    with mc.Locked(self.data) as book:
                        book['cases'][0]['opened'] = '2026-11-11T09:00+04:00'
                self.assertEqual([r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-12T10:00'))], ['declined'])

    def test_ask_refusal_stops_counting_questions_and_cases_but_unreadable_retries(self):
        for shape in ('question', 'case'):
            for rc in (mc.DONT_ASK, 4):
                with self.subTest(shape=shape, rc=rc):
                    self.data = self.tmp / (shape + str(rc))
                    if shape == 'question':
                        ident = self.seed()
                    else:
                        ident = 'declined'
                        self.case(ident, reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
                    with patch.object(mc, 'ask', return_value=(rc, 'cannot ask this charge')):
                        self.assertNotIn(ident + ':', self.ask_list())
                    ids = [r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-12T10:00'))]
                    self.assertEqual(ids, [ident] if rc == 4 else [])

    def test_declined_receipt_wait_becomes_candidate_when_wait_expires(self):
        for shape in ('question', 'case'):
            with self.subTest(shape=shape):
                self.data = self.tmp / shape
                if shape == 'question':
                    ident = self.seed()
                else:
                    ident = 'waiting'
                    self.case(ident, reference='card ending 1111', when=at('2026-11-10T09:00'), deadline='2026-12-01')
                with patch.object(mc, 'explain_charge', return_value=dict(verdict='wait', why='wait for receipt', errors=[],
                                                                        until='2026-11-11T11:00+04:00')):
                    self.ask_list()
                self.assertEqual(mc.unasked_candidates(self.data, at('2026-11-11T10:30')), [])
                self.assertEqual([r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-11T11:01'))], [ident])

    def test_skip_recording_timeout_keeps_previously_committed_lines(self):
        first, last = self.seed('11'), self.seed('22')
        clock = [1000.0]
        ask = mc.ask
        def delayed_refusal(data, question, **kw):
            if kw['qid'] == last:
                clock[0] += 41
                return mc.DONT_ASK, 'declined after lookup'
            return ask(data, question, **kw)
        with patch.object(mc.time, 'time', side_effect=lambda: clock[0]), patch.object(mc, 'ask', delayed_refusal):
            text = self.ask_list()
        self.assertIn(first + ':', text)
        self.assertNotIn(last + ':', text)
        self.assertIn(last, [r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-12T10:00'))])

    def test_legacy_seed_keeps_pending_false_and_new_question_can_be_asked(self):
        self.legacy_fixture()
        mc.migrate_legacy_asks(self.data)
        event = self.fire('2026-11-14T10:00')
        self.assertNotIn('awaiting answer', event)
        cases = mc.load(self.data)['cases']
        self.assertTrue(all(c['status'] == 'open' for c in cases))
        self.assertFalse(any(mc.active(c) and c['status'] == 'awaiting_answer' for c in cases))
        self.assertFalse(any(q.get('asks') and mc.active(q) for q in mc.load_questions(self.data)['questions']))
        self.assertNotIn('awaiting answer', mc.brief(mc.visible_cases(self.data), at('2026-11-14T10:00')))
        fresh = self.seed('19.32', '2026-11-13T10:00')
        self.assertIn('1 unasked charges', self.fire('2026-11-14T10:01'))
        self.assertIn(fresh + ':', self.ask_list('2026-11-14T10:01'))

    def test_migration_leaves_non_candidates_untouched(self):
        self.case('dispute', when=at('2026-11-10T09:00'), deadline='2026-12-01')
        self.case('hold', kind='hold', when=at('2026-11-10T09:00'), deadline='2026-12-01', distinct=True)
        self.case('young', when=at('2026-11-13T05:11'), deadline='2026-12-01', distinct=True)
        with mc.Locked(self.data) as book:
            mc.find(book, 'dispute').pop('kind')
        before = (self.data / 'cases.json').read_bytes()
        self.assertEqual(mc.migrate_legacy_asks(self.data), [])
        self.assertEqual(before, (self.data / 'cases.json').read_bytes())

    def test_migration_eligibility_never_ages_into_legacy_on_later_runs(self):
        # Cutoff exclusion | source of time eligibility that must remain frozen.
        for shape in ('young', 'case-wait', 'linked-wait'):
            with self.subTest(shape=shape):
                self.data = self.tmp / shape
                opened = '2026-11-13T05:11' if shape == 'young' else '2026-11-11T09:00'
                self.case('never-asked', reference='card ending 1111', when=at(opened), deadline='2026-12-01')
                if shape == 'case-wait':
                    with mc.Locked(self.data) as book:
                        book['cases'][0]['wait_until'] = '2026-11-13T09:00+04:00'
                if shape == 'linked-wait':
                    qid = self.seed(when='2026-11-11T09:00')
                    with mc.Locked(self.data, 'questions') as book:
                        mc.find_question(book, qid).update(case='never-asked', wait_until='2026-11-13T09:00+04:00')
                for day in ('2026-11-13T16:00', '2026-11-14T10:00', '2026-12-14T10:00'):
                    with patch.object(mc, 'now_dubai', return_value=at(day)):
                        self.assertEqual(mc.migrate_legacy_asks(self.data), [])
                self.assertEqual([r['id'] for r in mc.unasked_candidates(self.data, at('2026-11-14T10:00'))], ['never-asked'])
