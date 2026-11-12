"""Regression coverage for duplicate pings, ownership and incomplete evidence."""
import io
import json
import os
from contextlib import redirect_stdout
from unittest.mock import patch

from test_cases import Base, ALERT, BANK, RECEIPT, at, finder, nobody, read, mc


class Accuracy(Base):
    def setUp(self):
        super().setUp()
        p = patch.object(mc.charges, 'show', read)
        p.start()
        self.addCleanup(p.stop)

    def seed(self, card='1111', merchant=None):
        text = ALERT.replace('1111', card)
        if merchant:
            text = text.replace('ACME * EATS PENDING', merchant)
        r = mc.screen(text, BANK, at('2026-10-23T23:47'), at('2026-10-24T00:37'),
                      data=self.data, find=finder(), said=nobody, item='sms:1')
        return mc.find_question(mc.load_questions(self.data), r['id'])

    def fire(self, n):
        return mc.run_check(self.wd, f'r{n}', self.data, self.root, at(f'2026-10-25T10:{n:02}'), finder(), nobody)

    def test_unacked_closed_and_case_transitions_emit_once_across_three_fires(self):
        q = self.seed()
        with mc.Locked(self.data, 'questions') as book:
            closed = mc.find_question(book, q['id'])
            closed['passed'] = True
            mc.settle(closed, 'receipt matched', 'check', at('2026-10-25T09:00'))
            second = mc.new_question(book, dict(mc.charge_of(q), amount='19.99'), '',
                                     at('2026-10-24T09:00'), at('2026-10-24T09:00'))
            mc.case_from(self.data, second, at('2026-10-25T09:00'), 'check', self.root)
        events = [self.fire(n) for n in range(3)]
        self.assertEqual(sum('explained now' in e for e in events), 1)
        self.assertEqual(sum("he didn't answer" in e for e in events), 1)
        state = json.loads((self.wd / 'pings.json').read_text())
        self.assertEqual(state['sent'], {})
        self.assertIn(f'q|{q["id"]}|closed', state['built'])
        self.assertIn(f'q|{second["id"]}|case', state['built'])
        self.assertEqual(events[1:], ['', ''])

    def test_closed_case_cascades_and_repairs_old_questions(self):
        q = self.seed()
        with mc.Locked(self.data, 'questions') as book:
            mc.case_from(self.data, mc.find_question(book, q['id']), at('2026-10-24T09:00'), 'check', self.root)
        cid = mc.load_questions(self.data)['questions'][0]['case']
        mc.close(self.data, cid, 'settled', at('2026-10-24T10:00'))
        self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'closed')
        # Repair the pre-fix shape too: case is closed but question still says case.
        with mc.Locked(self.data, 'questions') as book:
            book['questions'][0].update(status='case', by='check')
        for n in range(3):
            self.assertEqual(self.fire(n), '')
        self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'closed')
        rc, msg = mc.ask(self.data, 'yours?', qid=q['id'], now=at('2026-10-25T11:00'))
        self.assertEqual(rc, mc.DONT_ASK)
        self.assertIn('settled', msg)

    def test_question_and_due_charge_case_are_one_line(self):
        q = self.seed()
        with mc.Locked(self.data, 'questions') as book:
            mc.case_from(self.data, mc.find_question(book, q['id']), at('2026-10-23T09:00'), 'check', self.root)
        event = self.fire(0)
        self.assertEqual(len([line for line in event.splitlines() if line.startswith('- ')]), 1)
        self.assertIn('charge-' + q['id'][2:], event)
        self.assertEqual(self.fire(1), '')
        self.assertEqual(self.fire(2), '')

    def test_ask_cli_fails_closed_and_does_not_count_ask(self):
        def broken(*a, **k):
            raise mc.charges.Lookup('unreadable')
        out = io.StringIO()
        with patch.object(mc, 'DATA', self.data), patch.object(mc.charges, 'search', broken), \
                patch.object(mc.charges, 'owner_texts', broken), redirect_stdout(out):
            rc = mc.main(['ask', ALERT, '--sender', BANK, '--at', '2026-10-23T23:47+04:00', '--said', 'Yours?'])
        self.assertEqual(rc, 4)
        self.assertIn('UNVERIFIED: source receipt unreadable', out.getvalue())
        self.assertIn('UNVERIFIED: source his threads unreadable', out.getvalue())
        self.assertNotIn('ask him now', out.getvalue())
        self.assertEqual(mc.load_questions(self.data)['questions'][0]['asks'], [])

    def test_moni_card_is_held_and_never_listed_or_promoted_for_owner(self):
        q = self.seed(card='2792')
        self.assertEqual(q['owner'], 'moni')
        rc, msg = mc.ask(self.data, 'yours?', qid=q['id'], now=at('2026-10-24T10:00'), find=finder(), said=nobody)
        self.assertEqual(rc, mc.DONT_ASK)
        self.assertIn('held for Moni', msg)
        mc.follow(self.data, at('2026-11-02T10:00'), self.root, find=finder(), said=nobody)
        self.assertEqual(mc.load(self.data)['cases'], [])
        self.assertEqual(self.fire(0), '')
        for command in ('questions', 'list'):
            out = io.StringIO()
            with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
                mc.main([command, '--json'])
            self.assertEqual(json.loads(out.getvalue()), [])
        mc.follow(self.data, at('2026-10-25T10:00'), self.root, find=finder(RECEIPT), said=nobody)
        self.assertEqual(mc.load_questions(self.data)['questions'][0]['status'], 'closed')
        self.assertEqual(self.fire(1), '')

    def test_repeat_bill_reopens_card_change_case_once(self):
        # Whole input class: order and spelling of card-change closure phrases.
        outcomes = ['card changed', 'card dead', 'changed card', 'dead card', 'card cancelled',
                    'cancelled card', 'card canceled', 'canceled card', 'card replaced', 'replaced card']
        for i, outcome in enumerate(outcomes):
            with self.subTest(outcome=outcome):
                self.data = self.tmp / f'repeat-{i}'
                self.case(case_id='old', merchant='Acme Eats')
                mc.close(self.data, 'old', outcome, at('2026-10-23T10:00'))
                q = self.seed()
                case = mc.find(mc.load(self.data), 'old')
                self.assertEqual((case['status'], case['cycle']), ('open', 1))
                self.assertEqual(q['case'], 'old')
                self.seed()
                self.assertEqual(mc.find(mc.load(self.data), 'old')['cycle'], 1)

    def test_noon_matching_order_explains_before_ask_and_failure_blocks(self):
        text = ALERT.replace('ACME * EATS PENDING', 'NOON')
        row = {'order': 'NEXAMPLE1', 'total': '12.34', 'currency': 'EUR',
               'placed_at': '2026-10-23T23:45:00+04:00', 'status': 'delivered'}
        with patch.object(mc.charges.order_lookup, 'read', return_value=[row]) as lookup:
            rc, msg = mc.ask(self.data, 'yours?', text, BANK, at('2026-10-23T23:47'),
                             now=at('2026-10-24T10:00'), find=finder(), said=nobody)
        self.assertEqual(rc, mc.DONT_ASK)
        self.assertIn('noon order NEXAMPLE1', msg)
        lookup.assert_called_once()
        for name in ('NOON', 'CAREEM'):
            with self.subTest(merchant=name), patch.object(mc.charges.order_lookup, 'read', side_effect=ValueError()):
                rc, msg = mc.ask(self.tmp / name, 'yours?', text.replace('NOON', name), BANK,
                                 at('2026-10-23T23:47'), now=at('2026-10-24T10:00'), find=finder(), said=nobody)
                self.assertEqual(rc, 4)
                self.assertIn('UNVERIFIED: source orders unreadable', msg)

    def test_order_evidence_requires_exact_money_time_and_unique_order(self):
        charge = dict(mc.charges.parse(ALERT), merchant='NOON')
        row = {'order': 'N1', 'total': '12.34', 'currency': 'EUR', 'placed_at': '2026-10-23T23:45:00+04:00'}
        forms = [({'total': '12.35'}, False), ({'currency': 'AED'}, False),
                 ({'placed_at': '2026-10-22T23:45:00+04:00'}, False),
                 ({'status': 'cancelled'}, False), ({}, True)]
        for changes, expected in forms:
            with self.subTest(changes=changes):
                result = mc.charges.order_receipt(charge, at('2026-10-23T23:47'), at('2026-10-24T10:00'),
                                                 lookup=lambda *a, **k: [row | changes])
                self.assertEqual(bool(result), expected)
        for rows in ([row | {'placed_at': None}], [row, row | {'order': 'N2'}]):
            with self.assertRaises(mc.charges.Lookup):
                mc.charges.order_receipt(charge, at('2026-10-23T23:47'), at('2026-10-24T10:00'),
                                        lookup=lambda *a, **k: rows)

    def test_same_question_fourteen_minutes_later_is_not_counted(self):
        for now, expected in [('2026-10-24T10:00', 0), ('2026-10-24T10:14', mc.DONT_ASK),
                              ('2026-10-25T09:59', mc.DONT_ASK), ('2026-10-25T10:00', 0)]:
            rc, _ = mc.ask(self.data, 'yours?', ALERT, BANK, at('2026-10-23T23:47'), now=at(now),
                           find=finder(), said=nobody)
            self.assertEqual(rc, expected)
        self.assertEqual(len(mc.load_questions(self.data)['questions'][0]['asks']), 2)

    def test_old_moni_charge_case_is_absent_from_attention_and_brief(self):
        case = self.case(reference='card ending 2792', deadline='2026-10-25')
        self.assertEqual(mc.attention([case], at('2026-10-25T10:00'), {}), [])
        self.assertEqual(mc.brief([case], at('2026-10-25T10:00')), '')
        out = io.StringIO()
        with patch.object(mc, 'DATA', self.data), redirect_stdout(out):
            mc.main(['list', '--json'])
        self.assertEqual(json.loads(out.getvalue()), [])

    def test_follow_cannot_promote_or_prompt_from_unreadable_evidence(self):
        q = self.seed()
        def broken(*a, **k):
            raise mc.charges.Lookup('unreadable')
        with mc.Locked(self.data, 'questions') as book:
            book['questions'][0]['wait_until'] = '2026-10-24T09:00:00+04:00'
        errors = mc.follow(self.data, at('2026-11-02T10:00'), self.root, find=broken, said=broken)
        self.assertTrue(errors)
        self.assertEqual(mc.load(self.data)['cases'], [])
        q = mc.load_questions(self.data)['questions'][0]
        self.assertTrue(q['unverified'])
        self.assertEqual(mc.question_entries([q], at('2026-11-02T10:00'), {}), [])

    def test_malformed_archive_output_is_an_unreadable_source(self):
        import subprocess
        with patch.object(mc.charges, 'msgs', return_value=subprocess.CompletedProcess([], 0, 'not json', '')):
            with self.assertRaises(mc.charges.Lookup):
                mc.charges.search('noon', '2026-10-23')

    def test_native_order_reader_joins_exact_details_to_order_times(self):
        import sys
        from types import SimpleNamespace
        listing = {'ok': True, 'orders': [{'order': 'N1', 'placed_at': '2026-10-23T23:45:00',
                                           'status': 'delivered'}]}
        def orders(app, service, timeout):
            self.assertEqual(app, 'noon')
            return listing if service == 'minutes' else {'ok': True, 'orders': []}
        detail = {'ok': True, 'account_verified': True, 'order': 'N1', 'total': 12.34, 'currency': 'EUR'}
        modules = {'native_orders': SimpleNamespace(orders=orders),
                   'noon_order_details': SimpleNamespace(details=lambda *a, **k: detail)}
        with patch.dict(sys.modules, modules):
            rows = mc.charges.order_lookup.native('noon', '/unused-test-path')
        self.assertEqual(len(rows['orders']), 1)
        self.assertFalse(rows['complete'])
        self.assertEqual(rows['orders'][0]['placed_at'], '2026-10-23T23:45:00+04:00')
        charge = dict(mc.charges.parse(ALERT), merchant='NOON')
        hit = mc.charges.order_receipt(charge, at('2026-10-23T23:47'), at('2026-10-24T10:00'),
                                       lookup=lambda *a, **k: rows)
        self.assertIn('noon order N1', hit['why'])

    def test_order_subprocess_errors_and_timeout_are_unreadable(self):
        import subprocess
        lookup = mc.charges.order_lookup
        results = [subprocess.CompletedProcess([], 1, '', ''), subprocess.CompletedProcess([], 0, '{}', ''),
                   subprocess.CompletedProcess([], 0, 'not json', ''), subprocess.TimeoutExpired('orders', 1)]
        for result in results:
            with self.subTest(result=type(result).__name__), patch.object(lookup.subprocess, 'run') as run:
                if isinstance(result, Exception):
                    run.side_effect = result
                else:
                    run.return_value = result
                with self.assertRaises(ValueError):
                    lookup.read('noon')

    def test_live_screen_default_data_persists_both_owners_without_crashing(self):
        with patch.object(mc, 'DATA', self.data):
            for card, verdict in [('2342', 'ask'), ('2792', 'held')]:
                result = mc.screen(ALERT.replace('1111', card), BANK, at('2026-10-23T23:47'),
                                   at('2026-10-24T10:00'), find=finder(), said=nobody)
                self.assertEqual(result['verdict'], verdict)
        questions = mc.load_questions(self.data)['questions']
        self.assertEqual({q['owner'] for q in questions}, {'abdullah', 'moni'})

    def test_repeat_bills_never_cross_owners_and_keep_new_charge_money(self):
        for cid, card, who in [('owner', '2342', 'Abdullah'), ('moni', '2792', 'Moni')]:
            self.case(case_id=cid, merchant='Acme Eats', reference=f'card ending {card}', who=who, distinct=True)
            mc.close(self.data, cid, 'card changed', at('2026-10-23T10:00'))
        for card, cid, other in [('2342', 'owner', 'moni'), ('2792', 'moni', 'owner')]:
            result = mc.screen(ALERT.replace('1111', card), BANK, at('2026-10-23T23:47'),
                               at('2026-10-24T10:00'), data=self.data, find=finder(), said=nobody)
            q = mc.find_question(mc.load_questions(self.data), result['id'])
            self.assertEqual(q['case'], cid)
            case = mc.find(mc.load(self.data), cid)
            self.assertEqual((case['amount'], case['currency']), ('12.34', 'EUR'))
            self.assertIn(card, case['reference'])
            if card == '2342':
                self.assertEqual(mc.find(mc.load(self.data), other)['status'], 'closed')

    def test_native_pagination_shapes_cannot_authorize_an_ask_without_a_match(self):
        import sys
        from types import SimpleNamespace
        # Service       Native coverage form                  Completeness
        forms = [('minutes', {'minutes': {'page': 1, 'total_pages': 2}}),
                 ('minutes', {'minutes': {'page': 1, 'total_pages': None}}),
                 ('marketplace', {'marketplace': {'active_fetched': True, 'history_fetched': True}}),
                 ('food', {'food': {'default_page_only': True, 'exhaustive': False, 'reported_pages': 2}}),
                 ('nownow', {'nownow': {'default_page_only': True, 'exhaustive': False}})]
        for service, coverage in forms:
            with self.subTest(service=service, coverage=coverage):
                def orders(app, service, timeout):
                    return {'ok': True, 'orders': [], 'coverage': coverage}
                modules = {'native_orders': SimpleNamespace(orders=orders),
                           'noon_order_details': SimpleNamespace(details=lambda *a, **k: None)}
                with patch.dict(sys.modules, modules):
                    result = mc.charges.order_lookup.native('noon', '/unused-test-path')
                self.assertFalse(result['complete'])
                with patch.object(mc.charges.order_lookup, 'read', return_value=result):
                    rc, msg = mc.ask(self.tmp / service, 'yours?', ALERT.replace('ACME * EATS PENDING', 'NOON'),
                                     BANK, at('2026-10-23T23:47'), now=at('2026-10-24T10:00'),
                                     find=finder(), said=nobody)
                self.assertEqual(rc, 4)
                self.assertIn('UNVERIFIED: source orders unreadable', msg)


    def test_receipt_timeout_can_only_use_cached_words_for_abdullah_cards(self):
        # Card ending    Owner       Can owner words settle a receipt timeout?
        forms = [('2342', 'closed'), ('9546', 'closed'), ('7572', 'closed'),
                 ('2974', 'closed'), ('2792', 'open')]
        for card, expected in forms:
            with self.subTest(card=card):
                self.data = self.tmp / f'timeout-{card}'
                self.seed(card=card)
                def owner(*args, **kwargs):
                    return [('2026-10-23T19:50:00.000Z', 'I paid Acme', 'app')]
                with patch.object(mc.charges, 'receipt', side_effect=mc.LookupTimeout('receipt timeout')):
                    mc.follow(self.data, at('2026-10-24T10:00'), self.root, find=finder(), said=owner)
                q = mc.load_questions(self.data)['questions'][0]
                self.assertEqual(q['status'], expected)
                if card == '2792':
                    self.assertEqual(q['owner'], 'moni')
                    self.assertIsNone(q['outcome'])
