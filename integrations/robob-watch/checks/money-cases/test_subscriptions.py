"""Subscription expectations never suppress a different or duplicate charge."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import datetime as dt
import io
import json
from pathlib import Path
import sys
from contextlib import redirect_stdout
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_cases import Base, at, mc


class Subscriptions(Base):
    def seed(self, sid='acme', **changes):
        values = dict(merchant='Acme', last4='2342', amount='100', currency='USD', cadence='monthly',
                      next_renewal='2026-11-15')
        values.update(changes)
        return mc.sub_change(self.data, sid, values, 'add')

    def charge(self, **changes):
        c = dict(kind='charge', merchant='Acme', card='2342', amount='100', currency='USD', pending=False)
        return {**c, **changes}

    def rows(self):
        return mc.load_subscriptions(self.data)['subscriptions']

    def test_crud_and_unknown_fields(self):
        self.seed()
        self.seed('unknown', merchant='Other', amount='', currency='', cadence='', next_renewal='', last4='')
        self.assertEqual(len(self.rows()), 2)
        mc.sub_change(self.data, 'acme', {'status': 'needs card update', 'account': 'me@example.test'})
        self.assertEqual(self.rows()[0]['account'], 'me@example.test')
        self.assertEqual(len(mc.subscriptions_due(self.data, at('2026-11-12T12:00'), 3)), 1)
        mc.sub_change(self.data, 'acme', {}, 'remove')
        self.assertEqual([r['id'] for r in self.rows()], ['unknown'])
        self.assertEqual(os.stat(self.data / 'subscriptions.json').st_mode & 0o777, 0o600)

    def test_cli_crud(self):
        commands = [
            ['add', 'acme', '--merchant', 'Acme', '--amount', '', '--cadence', 'monthly'],
            ['edit', 'acme', '--last4', '3517', '--next-renewal', '2026-11-15'],
            ['list'], ['due', '--days', '3'], ['remove', 'acme']]
        with patch.object(mc, 'DATA', self.data), patch.object(mc, 'now_dubai', return_value=at('2026-11-12T12:00')):
            for command in commands:
                with redirect_stdout(io.StringIO()) as out:
                    self.assertEqual(mc.main(['subs', *command]), 0)
                json.loads(out.getvalue())
        self.assertEqual(self.rows(), [])

    def test_validation_and_secrets_never_persist(self):
        for changes in ({'merchant': 'password: secret123'}, {'account': 'OTP 123456'},
                        {'last4': '4242424242424242'}, {'amount': 'NaN'}, {'currency': 'dollars'},
                        {'cadence': 'weekly'}, {'next_renewal': '2026-02-30'}, {'status': 'whatever'}):
            with self.subTest(changes=changes), self.assertRaises(mc.CaseError):
                self.seed(**changes)
        self.assertFalse((self.data / 'subscriptions.json').exists())

    def test_live_and_dead_renewal_notices_learn_idempotently(self):
        notice = mc.renewal('Your Acme subscription will renew on 15 Nov 2026 for USD 100 using card ending in 2342. Billed monthly.', 'billing@acme.test')
        self.assertEqual(notice['cadence'], 'monthly')
        self.assertIsNone(mc.renewal_case(self.data, notice, 'mail:1'))
        row = self.rows()[0]
        self.assertEqual((row['last4'], row['amount'], row['next_renewal']), ('2342', '100', '2026-11-15'))
        path = self.data / 'subscriptions.json'
        inode = path.stat().st_ino
        mc.renewal_case(self.data, notice, 'mail:1')
        self.assertEqual(path.stat().st_ino, inode)
        mc.card_dead(self.data, '2342', 'cancelled')
        self.assertIsNotNone(mc.renewal_case(self.data, notice, 'mail:1'))
        self.assertEqual(len(self.rows()), 1)

    def test_old_notice_does_not_undo_charge_roll_or_cancelled_status(self):
        self.seed()
        mc.subscription_match(self.data, self.charge(), at('2026-11-15T12:00'), record=True)
        notice = dict(merchant='Acme', amount='100', currency='USD', last4='2342', date='2026-11-15')
        mc.learn_subscription(self.data, notice)
        self.assertEqual(self.rows()[0]['next_renewal'], '2026-12-15')
        mc.sub_change(self.data, 'acme', {'status': 'cancelled'})
        mc.learn_subscription(self.data, {**notice, 'date': '2026-12-15'})
        self.assertEqual(self.rows()[0]['status'], 'cancelled')

    def test_notice_fills_unknown_card_and_preserves_seed_account(self):
        self.seed(last4='', amount='', currency='', next_renewal='', account='me@example.test')
        notice = dict(merchant='Acme', amount='100', currency='USD', last4='2342', date='2026-11-15')
        mc.learn_subscription(self.data, notice)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.rows()[0]['last4'], '2342')
        self.assertEqual(self.rows()[0]['account'], 'me@example.test')

    def test_match_boundary_matrix_and_read_only(self):
        self.seed()
        for amount, day, expected in [('95', 12, True), ('105', 18, True), ('94.99', 15, False),
                                      ('105.01', 15, False), ('100', 11, False), ('100', 19, False)]:
            with self.subTest(amount=amount, day=day):
                found = mc.subscription_match(self.data, self.charge(amount=amount), at(f'2026-11-{day}T12:00'))
                self.assertEqual(bool(found), expected)
        self.assertEqual(self.rows()[0]['next_renewal'], '2026-11-15')

    def test_unexpected_input_matrix_stays_unexplained(self):
        self.seed()
        for changes in ({'merchant': 'Acme Pro'}, {'card': '3517'}, {'currency': 'GBP'},
                        {'kind': 'decline'}, {'pending': True}, {'amount': '200'}):
            with self.subTest(changes=changes):
                self.assertIsNone(mc.subscription_match(self.data, self.charge(**changes), at('2026-11-15T12:00'), record=True))
        self.assertEqual(self.rows()[0]['next_renewal'], '2026-11-15')

    def test_missing_fields_cancelled_and_ambiguous_never_match(self):
        for field in ('amount', 'currency', 'last4', 'cadence', 'next_renewal'):
            with self.subTest(field=field):
                self.seed(**{field: ''})
                self.assertIsNone(mc.subscription_match(self.data, self.charge(), at('2026-11-15T12:00')))
                mc.sub_change(self.data, 'acme', {}, 'remove')
        self.seed(status='cancelled')
        self.assertIsNone(mc.subscription_match(self.data, self.charge(), at('2026-11-15T12:00')))
        mc.sub_change(self.data, 'acme', {'status': 'active'})
        self.seed('second', account='other@example.test')
        self.assertIsNone(mc.subscription_match(self.data, self.charge(), at('2026-11-15T12:00'), record=True))

    def test_calendar_roll_preserves_month_end_and_leap_day(self):
        self.seed(next_renewal='2028-01-31')
        for date, expected in [('2028-01-31', '2028-02-29'), ('2028-02-29', '2028-03-31')]:
            mc.subscription_match(self.data, self.charge(), at(date + 'T12:00'), record=True)
            self.assertEqual(self.rows()[0]['next_renewal'], expected)
            mc.sub_change(self.data, 'acme', {'account': 'me@example.test'})
        mc.sub_change(self.data, 'acme', {'next_renewal': '2028-02-29', 'cadence': 'yearly'})
        mc.subscription_match(self.data, self.charge(), at('2028-02-29T12:00'), record=True)
        self.assertEqual(self.rows()[0]['next_renewal'], '2029-02-28')

    def test_screen_explains_once_and_duplicate_charge_still_flags(self):
        self.seed()
        text = 'Purchase of USD 100 with your Credit Card ending 2342 at Acme.'
        now = at('2026-11-15T12:00')
        with patch.object(mc.charges, 'explain', return_value={'verdict': 'ask', 'why': 'unexpected', 'errors': []}) as explain:
            self.assertEqual(mc.screen(text, at=now, now=now, data=self.data, item='sms:1')['verdict'], 'explained')
            self.assertEqual(mc.screen(text, at=now, now=now, data=self.data, item='sms:1')['verdict'], 'explained')
            explain.assert_not_called()
            later = now + dt.timedelta(hours=1)
            self.assertEqual(mc.screen(text, at=later, now=later, data=self.data, item='sms:2')['verdict'], 'ask')
        self.assertEqual(self.rows()[0]['next_renewal'], '2026-12-15')

    def test_ask_gate_and_charge_cli(self):
        self.seed()
        now = at('2026-11-15T12:00')
        text = 'Purchase of USD 100 with your Credit Card ending 2342 at Acme.'
        with patch.object(mc.charges, 'explain', side_effect=AssertionError('no remote lookup')):
            with patch.object(mc, 'DATA', self.data), redirect_stdout(io.StringIO()):
                self.assertEqual(mc.main(['charge', text, '--at', now.isoformat()]), 0)
            self.assertEqual(self.rows()[0]['next_renewal'], '2026-11-15')
            rc, _ = mc.ask(self.data, 'yours?', text, at=now, now=now)
        self.assertEqual(rc, mc.DONT_ASK)
        self.assertEqual(self.rows()[0]['next_renewal'], '2026-12-15')

    def test_distinct_same_timestamp_charge_gets_its_own_question(self):
        self.seed()
        now = at('2026-11-15T12:00')
        text = 'Purchase of USD 100 with your Credit Card ending 2342 at Acme.'
        fallback = {'verdict': 'ask', 'why': 'extra charge', 'errors': []}
        with patch.object(mc.charges, 'explain', return_value=fallback):
            first = mc.screen(text, at=now, now=now, data=self.data, item='sms:one')
            second = mc.screen(text, at=now, now=now, data=self.data, item='sms:two')
            self.assertEqual((first['verdict'], second['verdict']), ('explained', 'ask'))
            self.assertNotEqual(first['id'], second['id'])
            rc, _ = mc.ask(self.data, 'extra charge yours?', qid=second['id'], now=now)
            self.assertEqual(rc, 0)

    def test_undated_alert_keeps_checks_in_screen_and_charge_cli(self):
        self.seed()
        now = at('2026-11-15T12:00')
        text = 'Purchase of USD 100 with your Credit Card ending 2342 at Acme.'
        fallback = {'verdict': 'ask', 'why': 'date unknown', 'errors': []}
        for record in (False, True):
            with self.subTest(record=record), patch.object(mc.charges, 'explain', return_value=fallback):
                result = mc.screen(text, data=self.data, now=now, record=record)
                self.assertEqual(result['verdict'], 'ask')
        with patch.object(mc, 'DATA', self.data), patch.object(mc.charges, 'explain', return_value=fallback), redirect_stdout(io.StringIO()) as out:
            self.assertEqual(mc.main(['charge', text, '--now', now.isoformat()]), 0)
        self.assertEqual(json.loads(out.getvalue())['verdict'], 'ask')
        with mc.Locked(self.data, 'questions') as book:
            # Older rows did not record whether the timestamp came from the alert.
            book['questions'][0].pop('subscription_dated')
        with patch.object(mc.charges, 'found', return_value=None), patch.object(mc.charges, 'explain', return_value=fallback):
            mc.follow(self.data, now + dt.timedelta(hours=1), said=lambda *a, **kw: [])
            question = mc.load_questions(self.data)['questions'][0]
            self.assertEqual(question['status'], 'open')
            rc, _ = mc.ask(self.data, 'yours?', qid=question['id'], now=now)
            self.assertEqual(rc, 0)
        self.assertEqual(self.rows()[0]['next_renewal'], '2026-11-15')

    def alert(self, merchant, day, amount='100', card='2342', **changes):
        return dict(text=f'Purchase of USD {amount} with your Credit Card ending {card} at {merchant}.',
                    ts=at(day + 'T12:00').timestamp(), sender='EmiratesNBD', **changes)

    def test_sweep_repeats_registered_singletons_and_deduplication(self):
        self.seed()
        self.seed('unknown', merchant='Unknown', amount='', currency='', next_renewal='')
        mc.card_dead(self.data, '2342', 'cancelled')
        alerts = [self.alert('Repeat', '2026-10-15'), self.alert('Repeat', '2026-11-15'),
                  self.alert('Acme', '2026-11-15'), self.alert('Once', '2026-11-15'),
                  self.alert('Once', '2026-11-15'), self.alert('Old', '2026-08-01'),
                  self.alert('Old', '2026-08-15'), self.alert('OtherCard', '2026-10-15', card='3517')]
        for _ in range(2):
            mc.sweep_dead_card(self.data, '2342', at('2026-11-16T12:00'), alerts=alerts)
        self.assertEqual({r['merchant'] for r in self.rows()}, {'Acme', 'Repeat', 'Unknown'})
        self.assertTrue(all(r['status'] == 'needs card update' for r in self.rows()))
        cases = mc.load(self.data)['cases']
        self.assertEqual(len(cases), 3)
        self.assertEqual({c['merchant'] for c in cases}, {'Acme', 'Repeat', 'Unknown'})
        self.assertIn('amount unknown', mc.table(cases))
        self.assertEqual(next(r for r in self.rows() if r['merchant'] == 'Repeat')['cadence'], '')

    def test_sweep_parses_selected_message_without_msgs_show_neighbors(self):
        purchase = self.alert('Acme', '2026-11-15')['text']
        neighbors = {
            'other_card': self.alert('Other', '2026-11-15', card='3517')['text'],
            'other_merchant': self.alert('Other', '2026-11-15')['text'],
            'card_payment': 'Payment of USD 100 towards your Credit Card ending 2342.',
            'refund': 'USD 100 has been refunded to your Credit Card ending 2342.',
            'decline': 'Transaction of USD 100 on your Card ending 2342 at Other was declined.',
        }
        context_cases = [(name, purchase, neighbor) for name, neighbor in neighbors.items()]
        context_cases += [(name + '_multiline', purchase.replace(' with ', '\nwith '), neighbor)
                          for name, neighbor in neighbors.items()]
        for name, purchase, neighbor in context_cases:
            for position in ('before', 'after'):
                with self.subTest(neighbor=name, position=position), \
                     patch.object(self, 'data', self.tmp / f'{name}-{position}'):
                    mc.card_dead(self.data, '2342', 'cancelled')
                    hits, shown = [], {}
                    for i, day in enumerate(('2026-10-15', '2026-11-15'), start=10):
                        hit = {**self.alert('Acme', day), 'id': f'imessage:{i}', 'source': 'imessage'}
                        # A clipped search preview cannot replace reading the selected full message.
                        hit['text'] = hit['text'][:40]
                        hits.append(hit)
                        selected = f'> {i:8d} {day} 12:00 EmiratesNBD: {purchase}'
                        neighbor_id, clock = (i - 1, '11:59') if position == 'before' else (i + 1, '12:01')
                        other = f'  {neighbor_id:8d} {day} {clock} EmiratesNBD: {neighbor}'
                        lines = [other, selected] if position == 'before' else [selected, other]
                        shown[hit['id']] = 'imessage: EmiratesNBD\n\n' + '\n'.join(lines)
                    with patch.object(mc.charges, 'search', return_value=hits), \
                         patch.object(mc.charges, 'show', side_effect=lambda hit, end: shown[hit['id']]):
                        for _ in range(2):
                            mc.sweep_dead_card(self.data, '2342', at('2026-11-16T12:00'))
                    self.assertEqual([(s['merchant'], s['last4'], s['amount']) for s in self.rows()],
                                     [('Acme', '2342', '100.00')])
                    cases = mc.load(self.data)['cases']
                    self.assertEqual([c['merchant'] for c in cases], ['Acme'])

    def test_sweep_does_not_infer_purchases_from_neighbors_of_noncharges(self):
        selected_messages = {
            'card_payment': 'Payment of USD 100 towards your Credit Card ending 2342.',
            'refund': 'USD 100 has been refunded to your Credit Card ending 2342.',
            'decline': 'Transaction of USD 100 on your Card ending 2342 at Acme was declined.',
            'other_card': self.alert('Acme', '2026-11-15', card='3517')['text'],
        }
        for name, selected in selected_messages.items():
            with self.subTest(selected=name), patch.object(self, 'data', self.tmp / name):
                mc.card_dead(self.data, '2342', 'cancelled')
                hits = [{**self.alert('Acme', day), 'id': f'imessage:{i}', 'source': 'imessage'}
                        for i, day in enumerate(('2026-10-15', '2026-11-15'), start=10)]
                def shown(hit, end):
                    i = int(hit['id'].split(':')[1])
                    day = mc.charges.day(dt.datetime.fromtimestamp(hit['ts'], mc.TZ))
                    neighbor = self.alert('Acme', day)['text']
                    return ('imessage: EmiratesNBD\n\n'
                            f'  {i - 1:8d} {day} 11:59 EmiratesNBD: {neighbor}\n'
                            f'> {i:8d} {day} 12:00 EmiratesNBD: {selected}\n'
                            f'  {i + 1:8d} {day} 12:01 EmiratesNBD: {neighbor}')
                with patch.object(mc.charges, 'search', return_value=hits), \
                     patch.object(mc.charges, 'show', side_effect=shown):
                    mc.sweep_dead_card(self.data, '2342', at('2026-11-16T12:00'))
                self.assertEqual(self.rows(), [])
                self.assertEqual(mc.load(self.data)['cases'], [])

    def test_dead_card_cli_and_swap_use_archive_and_dry_run_skips(self):
        hit = self.alert('Repeat', '2026-11-15')
        with patch.object(mc, 'DATA', self.data), patch.object(mc, 'now_dubai', return_value=at('2026-11-16T12:00')), \
             patch.object(mc.charges, 'search', return_value=[hit]) as search, \
             patch.object(mc.charges, 'show', return_value=hit['text']), redirect_stdout(io.StringIO()):
            self.seed()
            self.assertEqual(mc.main(['card-swap', '--old', '2342', '--new', '3517', '--dry-run']), 0)
            search.assert_not_called()
            self.assertEqual(mc.main(['card-dead', '2342', '--note', 'cancelled']), 0)
            search.assert_called_once()
            self.assertEqual(self.rows()[0]['status'], 'needs card update')
            self.assertEqual(mc.main(['card-swap', '--old', '2342', '--new', '3517']), 0)
            self.assertEqual(search.call_count, 2)

    def test_sweep_groups_accounts_dates_and_aliases_into_one_merchant_case(self):
        for n, (merchant, date) in enumerate((('Acme', '2026-11-16'), ('ACME', '2026-11-15'), ('Acme', ''))):
            with self.subTest(merchant=merchant, date=date), patch.object(self, 'data', self.tmp / f'accounts-{n}'):
                self.seed(account='one@example.test')
                self.seed('second', merchant=merchant, next_renewal=date, account='two@example.test')
                mc.card_dead(self.data, '2342', 'cancelled')
                for _ in range(2):
                    mc.sweep_dead_card(self.data, '2342', at('2026-11-12T12:00'), alerts=[])
                self.assertEqual(len(mc.load(self.data)['cases']), 1)
                self.assertTrue(all(r['status'] == 'needs card update' for r in self.rows()))
                mc.sub_change(self.data, 'acme', {}, 'remove')
                mc.sweep_dead_card(self.data, '2342', at('2026-11-12T12:00'), alerts=[])
                self.assertEqual(len(mc.load(self.data)['cases']), 1)

    def test_incomplete_sweep_cases_do_not_break_charge_creation_or_promotion(self):
        for n, missing in enumerate(({'amount': ''}, {'currency': ''}, {'amount': '', 'currency': ''})):
            with self.subTest(missing=missing), patch.object(self, 'data', self.tmp / f'incomplete-{n}'):
                self.seed(next_renewal='', **missing)
                mc.card_dead(self.data, '2342', 'cancelled')
                mc.sweep_dead_card(self.data, '2342', at('2026-11-15T12:00'), alerts=[])
                self.case('ordinary', merchant='Unrelated')
                now = at('2026-11-15T12:00')
                text = 'Purchase of USD 100 with your Credit Card ending 2342 at Unexpected.'
                with patch.object(mc.charges, 'explain', return_value={'verdict': 'ask', 'why': 'unknown', 'errors': []}), \
                     patch.object(mc.charges, 'found', return_value=None):
                    result = mc.screen(text, at=now, now=now, data=self.data, item='sms:unexpected')
                    self.assertEqual(result['verdict'], 'ask')
                    self.assertEqual(mc.follow(self.data, now + dt.timedelta(days=8), said=lambda *a, **kw: []), [])
                questions = mc.load_questions(self.data)['questions']
                self.assertEqual(questions[0]['status'], 'open')
                self.assertEqual(len(mc.load(self.data)['cases']), 2)
                with mc.Locked(self.data, 'questions') as book:
                    mc.case_from(self.data, book['questions'][0], now + dt.timedelta(days=8), 'check')
                questions = mc.load_questions(self.data)['questions']
                self.assertEqual(questions[0]['status'], 'case')
                self.assertEqual(len(mc.load(self.data)['cases']), 3)

    def test_three_day_ping_once_per_renewal_and_quiet_hours(self):
        self.seed(status='needs card update')
        self.assertEqual(self.check('2026-11-11T12:00'), '')
        self.assertEqual(self.check('2026-11-12T00:00'), '')
        self.assertIn('renews 2026-11-15', self.check('2026-11-12T12:00'))
        self.assertEqual(self.check('2026-11-13T12:00', run='r2'), '')
        self.assertIn('subs:acme:2026-11-15', mc.read_json(self.wd / 'pings.json', {})['sent'])
        mc.sub_change(self.data, 'acme', {'next_renewal': '2026-12-15'})
        self.assertIn('renews 2026-12-15', self.check('2026-12-12T12:00', run='r3'))

    def test_dead_card_ping_and_cancelled_or_healthy_skip(self):
        self.seed()
        self.assertEqual(mc.subscription_entries(self.data, at('2026-11-12T12:00'), {}), [])
        mc.card_dead(self.data, '2342', 'cancelled')
        self.assertEqual(len(mc.subscription_entries(self.data, at('2026-11-12T12:00'), {})), 1)
        mc.sub_change(self.data, 'acme', {'status': 'cancelled'})
        self.assertEqual(mc.subscription_entries(self.data, at('2026-11-12T12:00'), {}), [])

    def test_payment_initial_hour_and_deadline_reminders_leave_subscriptions_queued(self):
        for stage, clock in (('initial', '18:01'), ('hour', '20:00'), ('deadline', '21:00')):
            with self.subTest(stage=stage), patch.object(self, 'data', self.tmp / stage), \
                 patch.object(mc, 'follow_payments', return_value=[]):
                self.seed(status='needs card update')
                notice = mc.payments.parse('Your payment of AED 100 failed; pay by 21:00', 'Wio', at('2026-11-12T18:00'))
                mc.record_payment(self.data, notice, 'mail:payment', at('2026-11-12T18:00'))
                wd = self.tmp / (stage + '-watcher')
                wd.mkdir()
                now = at('2026-11-12T' + clock)
                first = mc.run_check(wd, 'payment', self.data, self.root, now)
                self.assertIn('Send this payment reminder alone', first)
                self.assertNotIn('renews 2026-11-15', first)
                state = mc.read_json(wd / 'pings.json', {})
                self.assertFalse(any(k.startswith('subs:') for k in state['built']))
                mc.write_json(wd / 'state.json', {'fires': 1, 'last_fire_at': mc.stamp(now)})
                second = mc.run_check(wd, 'subscription', self.data, self.root, now + dt.timedelta(minutes=1))
                self.assertIn('renews 2026-11-15', second)
                self.assertNotIn('Send this payment reminder alone', second)
