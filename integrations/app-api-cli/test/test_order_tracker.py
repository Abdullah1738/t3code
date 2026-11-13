import sys
from pathlib import Path
import time
import unittest
import json
import io
import os
import tempfile
from types import SimpleNamespace
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import order_tracker as t


class BankChargeTest(unittest.TestCase):
    BODY = ('Your Mashreq noon Card ending with 9546 was used for a purchase of AED 2,997.59 '
            'at Noon 80038888 AE on 08-NOV-2026 08:50 PM.')

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.root, self.watchers = base / 'tracker', base / 'watchers'
        self.root.mkdir()
        self.now = float(int(time.time()))
        self.cfg = {'app': 'noon', 'order': 'FGB8NN4KUNY0L2A', 'watcher': 'order-noon-bank',
                    'for': 'owner', 'chat': 'owner', 'total': 'AED 3,010.30', 'active': True,
                    'placed_at': t.stamp(self.now - 3600), 'registered_at': t.stamp(self.now - 3600)}
        self.folder = self.watchers / self.cfg['watcher']
        self.folder.mkdir(parents=True)
        self.record = self.root / 'orders' / (self.cfg['watcher'] + '.json')
        t.write(self.record, self.cfg)
        self.state_path = self.folder / 'order-tracker-state.json'
        t.write(self.state_path, {'primed': True, 'status': 'preparing'})
        source = Path(t.__file__).resolve().parents[1] / 'robob-watch/checks/money-cases/charges.py'
        with mock.patch.dict(os.environ, ORDER_WATCH_CHARGES=str(source)):
            parser = t.order_bank_charge.load_charges()
        self.assertIsNotNone(parser)
        self.row = {'id': 515561, 'source': 'email', 'sender': 'MashreqAlerts@mashreq.com',
                    'ts': self.now - 3540}
        self.charges = SimpleNamespace(BANKS=parser.BANKS, Lookup=parser.Lookup, parse=parser.parse,
                                      iso=parser.iso, day=parser.day, alert_text=mock.Mock(side_effect=parser.alert_text),
                                      search=mock.Mock(return_value=[self.row]), show=mock.Mock(return_value=self.BODY))
        self.result = {'status': 'delivered', 'whole_order_complete': True, 'errors': []}
        self.loader = t.order_bank_charge.load_charges
        self.run = mock.Mock(return_value='')
        for patch in (mock.patch.object(t, 'ROOT', self.root), mock.patch.object(t, 'WATCHERS', self.watchers),
                      mock.patch.object(t, 'fetch', return_value=self.result),
                      mock.patch.object(t.store, 'reconcile'), mock.patch.object(t, 'run', self.run),
                      mock.patch.object(t.delivery_cards, 'safe_sync', return_value={'status': 'ready', 'link_health': 'ok'}),
                      mock.patch.object(t.order_bank_charge, 'load_charges', return_value=self.charges)):
            patch.start()
            self.addCleanup(patch.stop)

    def tick(self, cfg=None, folder=None, now=None, pending=False, main_checked=False,
             run_id='scheduled-bank-fixture'):
        output = io.StringIO()
        with mock.patch.dict(os.environ, WATCH_DIR=str(folder or self.folder), WATCH_RUN=run_id,
                             WATCH_MAIN_CHECKED='1' if main_checked else '0'), \
             mock.patch.object(t.time, 'time', return_value=now or self.now), redirect_stdout(output):
            if pending:
                t._check(cfg or self.cfg, pending_only=True)
            else:
                t.check(cfg or self.cfg)
        return json.loads(output.getvalue()) if output.getvalue() else None

    def test_exact_match_stored_without_gap(self):
        self.cfg['total'] = 'AED 2,997.59'
        t.write(self.record, self.cfg)
        wake = self.tick()
        bank = wake['bank_charge']
        self.assertEqual(bank, {'bank_amount': 'AED 2,997.59', 'bank_card_last4': '9546',
                                'bank_msg_id': '515561', 'bank_charged_at': self.charges.iso(
                                    t.dt.datetime.fromtimestamp(self.row['ts'], t.dt.timezone.utc))})
        self.assertEqual([e['kind'] for e in wake['events']], ['stage_change'])
        for path in (self.record, self.state_path):
            self.assertEqual({key: t.read(path)[key] for key in bank}, bank)
        self.assertEqual(self.charges.search.call_args.args, ('noon',))
        kwargs = self.charges.search.call_args.kwargs
        self.assertEqual(kwargs['n'], 20)
        self.assertLessEqual(kwargs['deadline'], self.now + 10)

    def test_hamper_gap_sent_once(self):
        wake = self.tick()
        gap = next(e for e in wake['events'] if e['kind'] == 'bank_amount_gap')
        self.assertEqual((gap['order_total'], gap['bank_amount'], gap['gap'], gap['card']),
                         ('AED 3,010.30', 'AED 2,997.59', 'AED 12.71', '9546'))
        self.assertEqual(gap['message'], 'Bank charged AED 2,997.59 on card 9546; order total was AED 3,010.30 '
                         '(gap AED 12.71). Say both numbers once; this alone is not proof of an overcharge or refund.')
        self.assertIsNone(self.tick(now=self.now + 601))
        self.charges.search.assert_called_once()
        self.assertTrue(t.read(self.state_path)['bank_gap_sent'])

    def assert_late_bank_alert_recovers(self, lookup_error=False):
        if lookup_error:
            self.charges.search.side_effect = self.charges.Lookup('search unavailable')
        else:
            self.charges.search.return_value = []
        wake = self.tick()
        self.assertIsNone(wake['bank_charge'])
        self.assertEqual([e['kind'] for e in wake['events']], ['stage_change'])
        # Exercise real retirement through both callers while bank lookup is throttled.
        for seconds, pending, main_checked in [(60, False, False), (120, True, False), (180, True, True)]:
            with self.subTest(seconds=seconds, pending=pending, main_checked=main_checked):
                self.assertIsNone(self.tick(now=self.now + seconds, pending=pending, main_checked=main_checked))
                self.run.assert_not_called()
                self.assertTrue(t.read(self.record)['active'])
        self.assertIsNone(self.tick(now=self.now + 599))
        self.charges.search.assert_called_once()
        self.run.assert_not_called()
        self.charges.search.side_effect = None
        self.charges.search.return_value = [self.row]
        wake = self.tick(now=self.now + 600)
        self.assertEqual([e['kind'] for e in wake['events']], ['bank_amount_gap'])
        self.assertEqual(t.read(self.record)['bank_msg_id'], '515561')
        self.assertNotIn('bank_lookup_error', t.read(self.state_path))
        self.assertEqual(self.charges.search.call_count, 2)
        self.run.assert_not_called()
        t.fetch.assert_called_once()
        # Once matched, pending-check can retire without consuming another bank event.
        self.assertIsNone(self.tick(now=self.now + 601, pending=True))
        self.run.assert_called_once_with(['robob-watch', 'remove', self.cfg['watcher']])
        self.assertFalse(t.read(self.record)['active'])

    def test_empty_search_keeps_bank_only_retries_scheduled(self):
        self.assert_late_bank_alert_recovers()

    def test_lookup_error_keeps_bank_only_retries_scheduled(self):
        self.assert_late_bank_alert_recovers(lookup_error=True)

    def test_unmatched_bank_retry_retires_at_48_hour_cutoff(self):
        self.charges.search.return_value = []
        self.cfg['placed_at'] = t.stamp(self.now - 48 * 3600 + 600)
        t.write(self.record, self.cfg)
        self.tick()
        for seconds, pending in [(60, False), (120, True), (599, False)]:
            self.assertIsNone(self.tick(now=self.now + seconds, pending=pending))
            self.run.assert_not_called()
            self.assertTrue(t.read(self.record)['active'])
        self.assertIsNone(self.tick(now=self.now + 600, pending=True))
        self.run.assert_called_once_with(['robob-watch', 'remove', self.cfg['watcher']])
        self.assertFalse(t.read(self.record)['active'])
        self.charges.search.assert_called_once()
        t.fetch.assert_called_once()

    def test_unacceptable_bank_alerts(self):
        cases = [('merchant', self.BODY.replace('Noon 80038888', 'Other 80038888'), self.row),
                 ('decline', 'Transaction of AED 2,997.59 on your Card 9546 at Noon was declined', self.row),
                 ('over two percent', self.BODY.replace('2,997.59', '2,900.00'), self.row),
                 ('currency', self.BODY.replace('AED', 'USD'), self.row),
                 ('sender', self.BODY, {**self.row, 'sender': 'noon@example.com'}),
                 ('too early', self.BODY, {**self.row, 'ts': self.now - 4201}),
                 ('too late', self.BODY, {**self.row, 'ts': self.now + 82801})]
        for label, body, row in cases:
            with self.subTest(label=label):
                self.charges.search.return_value = [row]
                self.charges.show.return_value = body
                t.write(self.state_path, {'primed': True, 'status': 'preparing'})
                self.assertIsNone(self.tick()['bank_charge'])
                self.assertNotIn('bank_msg_id', t.read(self.record))

    def test_one_alert_cannot_be_claimed_by_two_orders(self):
        self.tick()
        other = {**self.cfg, 'order': 'other', 'watcher': 'order-noon-other'}
        for key in t.order_bank_charge.FIELDS:
            other.pop(key, None)
        folder = self.watchers / other['watcher']
        folder.mkdir()
        path = self.root / 'orders' / (other['watcher'] + '.json')
        t.write(path, other)
        t.write(folder / 'order-tracker-state.json', {'primed': True, 'status': 'preparing'})
        self.assertIsNone(self.tick(other, folder)['bank_charge'])
        self.assertNotIn('bank_msg_id', t.read(path))
        self.charges.show.assert_called_once()

    def test_scratch_watch_dir_updates_only_its_state(self):
        scratch = Path(self.tmp.name) / 'scratch'
        scratch.mkdir()
        t.write(scratch / 'order-tracker-state.json', {'primed': True, 'status': 'preparing'})
        before = self.record.read_bytes()
        self.assertEqual(self.tick(folder=scratch)['bank_charge']['bank_msg_id'], '515561')
        self.assertEqual(self.record.read_bytes(), before)
        self.assertNotIn('bank_msg_id', self.cfg)
        self.assertFalse((self.root / 'bank-charge.lock').exists())

    def test_lookup_errors_and_missing_module_are_quiet(self):
        for failure in ('missing', 'search', 'show'):
            with self.subTest(failure=failure):
                t.write(self.state_path, {'primed': True, 'status': 'preparing'})
                self.charges.search.side_effect = self.charges.Lookup('search unavailable') if failure == 'search' else None
                self.charges.show.side_effect = self.charges.Lookup('show unavailable') if failure == 'show' else None
                with mock.patch.object(t.order_bank_charge, 'load_charges', return_value=None if failure == 'missing' else self.charges):
                    wake = self.tick()
                self.assertIsNone(wake['bank_charge'])
                self.assertEqual([e['kind'] for e in wake['events']], ['stage_change'])
                if failure != 'missing':
                    self.assertIn('unavailable', t.read(self.state_path)['bank_lookup_error'])
                self.assertNotIn('bank_msg_id', t.read(self.record))

    def test_missing_or_broken_parser_import(self):
        # Exercise the loader itself, rather than the stub used for the polls.
        for contents in (None, 'raise RuntimeError("broken import")'):
            path = Path(self.tmp.name) / ('absent.py' if contents is None else 'broken.py')
            if contents:
                path.write_text(contents)
            before = sys.path[:]
            with mock.patch.dict(os.environ, ORDER_WATCH_CHARGES=str(path)):
                self.assertIsNone(self.loader())
            self.assertEqual(sys.path, before)

    def test_claim_lock_is_nonblocking(self):
        with (self.root / 'bank-charge.lock').open('a') as lock:
            t.fcntl.flock(lock, t.fcntl.LOCK_EX | t.fcntl.LOCK_NB)
            self.assertIsNone(self.tick()['bank_charge'])
        self.charges.search.assert_called_once()
        self.assertNotIn('bank_msg_id', t.read(self.record))

    def test_lookup_not_run_for_old_or_undelivered_order(self):
        for status, age in [('preparing', 3600), ('delivered', 48 * 3600), ('cancelled', 3600)]:
            with self.subTest(status=status, age=age):
                self.cfg['placed_at'] = t.stamp(self.now - age)
                self.result['status'] = status
                t.write(self.state_path, {'primed': True, 'status': 'placed'})
                self.tick()
        self.charges.search.assert_not_called()

    def test_small_gaps_are_recorded_without_an_event(self):
        for total in ('AED 2,997.59', 'AED 2,998.59', 'AED 2,996.59'):
            with self.subTest(total=total):
                self.cfg['total'] = total
                for key in t.order_bank_charge.FIELDS:
                    self.cfg.pop(key, None)
                t.write(self.record, self.cfg)
                t.write(self.state_path, {'primed': True, 'status': 'preparing'})
                wake = self.tick()
                self.assertEqual(wake['bank_charge']['bank_amount'], 'AED 2,997.59')
                self.assertEqual([e['kind'] for e in wake['events']], ['stage_change'])

    def test_closest_amount_then_time_and_ties(self):
        self.cfg['total'] = 'AED 100.00'
        for amounts, times, expected in [(['99.00', '100.00'], [0, 60], '2'),
                                         (['99.00', '99.00'], [60, 0], '2'),
                                         (['99.00', '101.00'], [0, 0], None),
                                         (['98.00', '97.99'], [0, 0], '1')]:
            with self.subTest(amounts=amounts, times=times):
                rows = [{**self.row, 'id': str(i + 1), 'ts': self.now - 3600 + delta}
                        for i, delta in enumerate(times)]
                self.charges.search.return_value = rows
                self.charges.show.side_effect = [self.BODY.replace('2,997.59', amount) for amount in amounts]
                match, error = t.order_bank_charge.find(self.cfg, t.Decimal('100'), set(), self.charges, self.now + 10)
                self.assertIsNone(error)
                self.assertEqual(match['bank_msg_id'] if match else None, expected)

    def test_body_reads_bounded_and_chat_body_selected(self):
        self.charges.search.return_value = [{**self.row, 'id': i + 1, 'source': 'sms'} for i in range(20)]
        self.charges.show.return_value = '> 1 2026-11-08 20:51 Mashreq: ' + self.BODY
        match, error = t.order_bank_charge.find(self.cfg, t.Decimal('3010.30'), set(), self.charges, self.now + 10)
        self.assertIsNone(error)
        self.assertIsNone(match)  # Same amount and time across six different alerts is ambiguous.
        self.assertEqual(self.charges.show.call_count, 6)
        self.assertEqual(self.charges.alert_text.call_count, 6)

    def test_expired_budget_makes_no_lookup(self):
        match, error = t.order_bank_charge.find(self.cfg, t.Decimal('3010.30'), set(), self.charges, self.now - 1)
        self.assertIsNone(match)
        self.assertIn('out of time', error)
        self.charges.search.assert_not_called()

    def test_provider_fetch_leaves_less_bank_budget(self):
        # Fetch already spent 48 seconds of the poll's 60-second allowance.
        with mock.patch.object(t.time, 'time', return_value=self.now + 48):
            events = t.bank_charge_events(self.cfg, self.result, {'status': 'delivered'}, self.folder,
                                         self.now, min(t.time.time() + 10, self.now + 50))
        self.assertTrue(events)
        self.assertEqual(self.charges.search.call_args.kwargs['deadline'], self.now + 50)

    def test_registration_prime_defers_bank_claim_until_scheduled_check(self):
        wake = self.tick(run_id='prime-fixture')
        self.assertIsNone(wake['bank_charge'])
        self.charges.search.assert_not_called()
        self.assertNotIn('bank_msg_id', t.read(self.record))
        wake = self.tick()
        self.assertEqual([e['kind'] for e in wake['events']], ['bank_amount_gap'])

    def test_saved_claim_recovers_gap_after_interrupted_state_save(self):
        self.tick()
        # The order record was saved, but this watcher state predates the claim.
        t.write(self.state_path, {'primed': True, 'status': 'delivered'})
        wake = self.tick(cfg=t.read(self.record))
        self.assertEqual([e['kind'] for e in wake['events']], ['bank_amount_gap'])
        self.assertIsNone(self.tick(cfg=t.read(self.record)))
        self.charges.search.assert_called_once()

    def test_retirement_preserves_claim_from_an_older_config_snapshot(self):
        stale = dict(self.cfg)
        self.tick()
        with mock.patch.object(t, 'run', return_value=''):
            t.retire(stale, self.record)
        saved = t.read(self.record)
        self.assertFalse(saved['active'])
        self.assertEqual(saved['bank_msg_id'], '515561')
        self.assertEqual(saved['bank_amount'], 'AED 2,997.59')

    def test_claim_is_rechecked_after_lookup_before_saving(self):
        def show(*args, **kwargs):
            t.write(self.root / 'orders' / 'another-order.json', {'bank_msg_id': '515561'})
            return self.BODY
        self.charges.show.side_effect = show
        self.assertIsNone(self.tick()['bank_charge'])
        self.assertNotIn('bank_msg_id', t.read(self.record))

    def test_date_search_covers_full_timestamp_window(self):
        # msgs --until is exclusive midnight; the following date must be searched
        # even when the order or the alert straddles Dubai midnight.
        cases = [('2026-11-08T23:55:00+04:00', '2026-11-09T00:01:00+04:00'),
                 ('2026-11-08T12:00:00+04:00', '2026-11-09T11:59:00+04:00'),
                 ('2026-11-08T00:05:00+04:00', '2026-11-07T23:56:00+04:00'),
                 ('2026-11-08T19:55:00Z', '2026-11-08T20:01:00Z')]
        for placed, charged in cases:
            with self.subTest(placed=placed, charged=charged):
                row = {**self.row, 'ts': t.epoch(charged)}
                def search(query, since, until, **kwargs):
                    date = self.charges.day(t.dt.datetime.fromisoformat(charged.replace('Z', '+00:00')))
                    return [row] if since <= date < until else []
                self.charges.search.side_effect = search
                match, error = t.order_bank_charge.find({**self.cfg, 'placed_at': placed}, t.Decimal('3010.30'),
                                                        set(), self.charges, time.time() + 10)
                self.assertIsNone(error)
                self.assertEqual(match['bank_msg_id'], '515561')

    def test_merchant_tokens_and_separators(self):
        cases = [('noon', 'Noon 80038888 AE', True), ('noon', 'NOON.COM AE', True),
                 ('noon', 'NOON*FOOD AE', True), ('noon', 'NOON-FOOD AE', True),
                 ('noon', 'NOON_FOOD AE', True), ('noon', 'AFTERNOON CAFE AE', False),
                 ('noon', 'NOONISH CAFE AE', False), ('noon', 'NOON2 CAFE AE', False),
                 ('careem', 'CAREEM*FOOD AE', True), ('careem', 'MYCAREEM CAFE AE', False),
                 ('amazon', 'AMAZON.AE', True), ('amazon', 'AMAZONIAN BOOKS AE', False),
                 ('talabat', 'TALABAT.COM AE', True), ('talabat', 'TALABATI CAFE AE', False)]
        for app, merchant, accepted in cases:
            with self.subTest(app=app, merchant=merchant):
                self.charges.show.return_value = self.BODY.replace('Noon 80038888 AE', merchant)
                match, error = t.order_bank_charge.find({**self.cfg, 'app': app}, t.Decimal('3010.30'),
                                                        set(), self.charges, time.time() + 10)
                self.assertIsNone(error)
                self.assertEqual(match is not None, accepted)


class TrackerTest(unittest.TestCase):
    def cfg(self):
        return {'app': 'talabat', 'order': '12345', 'placed_at': t.stamp(time.time()-3600),
                'registered_at': t.stamp(), 'eta': t.stamp(time.time()-600)}

    def result(self, status='unknown'):
        return {'status': status, 'errors': []}

    def test_delivery_promises_are_not_delivery(self):
        for text in ['Your order will be delivered today', 'Your order is not delivered',
                     'Free delivery when you order', 'Your rider has arrived at the restaurant']:
            self.assertNotEqual(t.classify(text), 'delivered')
        self.assertEqual(t.classify('Your order has been delivered'), 'delivered')

    def test_poll_interval_backs_off_while_eta_is_far(self):
        now = time.time()
        self.assertEqual(t.poll_interval(t.stamp(now + 7 * 3600), now), 900)
        self.assertEqual(t.poll_interval(t.stamp(now + 2 * 3600), now), 300)
        self.assertEqual(t.poll_interval(t.stamp(now + 1800), now), 60)
        self.assertEqual(t.poll_interval(None, now), 60)

    def test_notification_identity_and_age(self):
        cfg = self.cfg()
        def dump(text, timestamp=None):
            return f'NotificationRecord(x: pkg=com.talabat id=1)\nwhen={int((timestamp or time.time())*1000)}\nandroid.text=String ({text})'
        self.assertEqual(t.notifications(dump('Your rider is around the corner'), cfg), [])
        self.assertEqual(t.notifications(dump('Your rider is around the corner'), cfg, True)[0]['confidence'], 'single_active_app_unconfirmed')
        self.assertEqual(t.notifications(dump('Order 12345 has been delivered'), cfg)[0]['stage'], 'delivered')
        self.assertEqual(t.notifications(dump('Order 912345 has been delivered'), cfg), [])
        self.assertEqual(t.notifications(dump('Order 12345 has been delivered', time.time()-7200), cfg), [])

    def test_baseline_delay_once_and_terminal(self):
        state, cfg = {}, self.cfg()
        self.assertEqual(t.transition(self.result('preparing'), state, cfg, time.time()), [])
        self.assertEqual(t.transition(self.result(), state, cfg, time.time())[0]['kind'], 'eta_elapsed')
        self.assertEqual(t.transition(self.result(), state, cfg, time.time()), [])
        self.assertEqual(t.transition(self.result('delivered'), state, cfg, time.time())[0]['status'], 'delivered')
        self.assertEqual(t.transition(self.result('preparing'), state, cfg, time.time()), [])
        self.assertEqual(state['status'], 'delivered')

    def test_candidate_dedupe_does_not_confirm_delivery(self):
        state = {'primed': True, 'delay_sent': True}
        result = self.result()
        result['candidate'] = {'stage': 'delivered', 'evidence': 'App says delivered'}
        self.assertEqual(t.transition(result, state, self.cfg(), time.time())[0]['kind'], 'candidate')
        self.assertEqual(t.transition(result, state, self.cfg(), time.time()), [])
        self.assertNotEqual(state.get('status'), 'delivered')

    def problem_cfg(self, at):
        return dict(self.cfg(), app='noon', order='N123', eta=None, registered_at=t.stamp(at - 3600))

    def problems(self, result, state, cfg, at):
        return [e for e in t.transition(result, state, cfg, at) if e['kind'] == 'tracking_problem']

    def test_error_families_strip_account_suffixes(self):
        self.assertEqual(t.error_family('email_account_unavailable:juno'), 'email_account_unavailable')
        for error in ('native_status_unknown', 'email_account_unavailable:outlook', 'no_order_status_evidence',
                      'native_account_capture_required_guest_catalog_only', 'amazon_message_read_timeout',
                      'amazon_account_timeout', 'notifications_RuntimeError', 'notifications_priority_hold'):
            self.assertTrue(t.quiet_error(error), error)
        for error in ('native_auth_expired', 'native_schema_changed', 'native_order_mismatch_or_schema_changed'):
            self.assertFalse(t.quiet_error(error), error)

    def test_quiet_errors_need_three_failing_checks(self):
        at = time.time()
        cfg, state = self.problem_cfg(at), {}
        result = lambda: {'status': 'unknown', 'errors': ['native_status_unknown']}
        self.assertEqual(t.transition(result(), state, cfg, at), [])  # priming tick stays quiet
        self.assertEqual(self.problems(result(), state, cfg, at + 60), [])
        self.assertEqual(self.problems(result(), state, cfg, at + 120)[0]['errors'], ['native_status_unknown'])
        # A passing check resets the streak.
        state = {'primed': True}
        self.assertEqual(self.problems(result(), state, cfg, at), [])
        self.assertEqual(self.problems({'status': 'preparing', 'errors': []}, state, cfg, at + 60), [])
        self.assertEqual(self.problems(result(), state, cfg, at + 120), [])
        self.assertEqual(self.problems(result(), state, cfg, at + 180), [])
        self.assertEqual(len(self.problems(result(), state, cfg, at + 240)), 1)

    def test_quiet_errors_wait_for_eta(self):
        at = time.time()
        cfg = dict(self.problem_cfg(at), eta=t.stamp(at + 3600))
        state = {'primed': True, 'status': 'placed'}
        flapping = [['native_status_unknown', 'email_account_unavailable:' + a]
                    for a in ('fund', 'outlook', 'juno', 'gmail')] + [['amazon_message_read_timeout'],
                    ['amazon_account_timeout'], ['notifications_RuntimeError'], ['no_order_status_evidence']]
        fired = [i for i, errors in enumerate(flapping)
                 if self.problems({'status': 'unknown', 'errors': errors}, state, cfg, at + i * 300)]
        self.assertEqual(fired, [])
        self.assertEqual(state['tracking_problem_suppressed'], 'transient_source_errors')
        after = at + 3600 + 301
        self.assertEqual(len(self.problems({'status': 'unknown', 'errors': ['amazon_account_timeout']},
                                           state, cfg, after)), 1)

    def test_real_error_wakes_once_before_eta(self):
        at = time.time()
        cfg = dict(self.problem_cfg(at), eta=t.stamp(at + 3600))
        state = {'primed': True, 'status': 'placed'}
        bad = {'status': 'unknown', 'errors': ['native_auth_expired', 'native_status_unknown']}
        events = self.problems(bad, state, cfg, at)
        self.assertEqual(events[0]['error_families'], ['native_auth_expired', 'native_status_unknown'])
        self.assertEqual(self.problems(bad, state, cfg, at + 60), [])

    def test_one_tracking_problem_per_day_regardless_of_error_mix(self):
        at = time.time()
        cfg, state = self.problem_cfg(at), {'primed': True, 'status': 'placed'}
        mixes = [['native_auth_expired'], ['native_schema_changed'], ['native_http_500', 'email_read_unavailable'],
                 ['native_auth_expired', 'email_account_unavailable:juno']]
        fired = [h for h in range(0, 49)
                 if self.problems({'status': 'unknown', 'errors': mixes[h % 4]}, state, cfg, at + h * 3600)]
        self.assertEqual(fired, [0, 24, 48])
        self.assertEqual(state['tracking_problem_suppressed'], None)
        # A new confirmed stage is a stage_change wake, not a fresh tracking_problem.
        moved = {'status': 'out for delivery', 'errors': ['native_auth_expired']}
        kinds = [e['kind'] for e in t.transition(moved, state, cfg, at + 49 * 3600)]
        self.assertEqual(kinds, ['stage_change'])
        state['status'] = 'delivered'
        self.assertEqual(self.problems({'status': 'unknown', 'errors': ['native_auth_expired']}, state, cfg,
                                       at + 80 * 3600), [])

    def test_partial_delivery_with_open_eta_never_wakes_tracking_problem(self):
        # NAEIA0061290509 on 14 Oct: S1 delivered, S2 due 1 Nov, ~9 wakes for flapping errors.
        at = time.time()
        cfg = dict(self.problem_cfg(at), eta=t.stamp(at + 18 * 86400))
        state = {'primed': True, 'status': 'out for delivery',
                 'parts_delivered_seen': ['native:item:N123-1'],
                 'native_items_delivered_seen': {'N123-1': 'N123-S1'}}
        errors = [['native_status_unknown'], ['native_status_unknown', 'email_account_unavailable:juno'],
                  ['native_auth_expired'], ['native_marketplace_reads_failed']]
        fired = [h for h in range(0, 72)
                 if self.problems({'status': 'unknown', 'errors': errors[h % 4]}, state, cfg, at + h * 3600)]
        self.assertEqual(fired, [])
        self.assertEqual(state['tracking_problem_suppressed'], 'partial_delivery_eta_open')
        # The remaining shipment is still announced as soon as it lands.
        result = {'status': 'unknown', 'errors': ['native_status_unknown'],
                  'partial_evidence': [{'stage': 'delivered', 'scope': 'shipment', 'shipment_id': 'N123-S2',
                                        'evidence_key': 'native:shipment:N123-S2', 'source': 'native_order_api'}]}
        self.assertEqual([e['kind'] for e in t.transition(result, state, cfg, at + 73 * 3600)],
                         ['shipment_delivered'])
        # After the ETA, persistent failures may wake once.
        late = at + 18 * 86400 + 600
        fired = [i for i in range(3)
                 if self.problems({'status': 'unknown', 'errors': ['native_status_unknown']}, state, cfg, late + i)]
        self.assertEqual(fired, [0])

    def test_app_eta_survives_failing_ticks_without_checkout_eta(self):
        at = time.time()
        cfg = self.problem_cfg(at)  # lanes like Talabat/Main register without --eta
        state = {'primed': True, 'status': 'placed'}
        ok = {'status': 'preparing', 'errors': [], 'eta': t.stamp(at + 3600), 'eta_source': 'native_order_api'}
        self.assertEqual(self.problems(ok, state, cfg, at), [])
        fired = [i for i in range(1, 6)
                 if self.problems({'status': 'unknown', 'errors': ['native_status_unknown'], 'eta': None},
                                  state, cfg, at + i * 60)]
        self.assertEqual(fired, [])
        self.assertEqual(len(self.problems({'status': 'unknown', 'errors': ['native_status_unknown']},
                                           state, cfg, at + 3600 + 301)), 1)

    def test_live_naeia_state_stays_quiet(self):
        at = t.epoch('2026-10-14T20:04:27+00:00')
        cfg = {'app': 'noon', 'order': 'NAEIA0061290509', 'for': 'moni', 'eta': '2026-11-01T23:59:00+04:00',
               'placed_at': '2026-10-11T17:39:34+04:00', 'registered_at': '2026-10-11T13:42:48+00:00'}
        state = {'primed': True, 'status': 'out for delivery', 'coverage_alert': True,
                 'parts_delivered_seen': ['native:item:NAEIA0061290509-2', 'native:item:NAEIA0061290509-1'],
                 'tracking_problem_alerts': {'["native_status_unknown", "out for delivery"]': at - 86000,
                                             '["email_account_unavailable:juno", "out for delivery"]': at - 90000}}
        for i, errors in enumerate([['native_status_unknown', 'email_account_unavailable:juno'],
                                    ['native_status_unknown', 'email_account_unavailable:gmail'],
                                    ['native_status_unknown']] * 4):
            self.assertEqual(self.problems({'status': 'unknown', 'errors': errors}, state, cfg, at + i * 300), [])
        self.assertNotIn('tracking_problem_alerts', state)
        self.assertEqual(state['tracking_problem_last_at'], at - 86000)

    def test_legacy_alert_state_migrates_to_daily_cap(self):
        at = time.time()
        cfg = self.problem_cfg(at)
        result = lambda: {'status': 'unknown', 'errors': ['native_auth_expired']}
        state = {'primed': True, 'status': 'out for delivery', 'coverage_alert': True,
                 'coverage_alert_at': at - 3700}
        self.assertEqual(self.problems(result(), state, cfg, at), [])
        self.assertNotIn('coverage_alert_at', state)
        self.assertEqual(self.problems(result(), state, cfg, at - 3700 + 86401)[0]['kind'], 'tracking_problem')
        stale = {'primed': True, 'status': 'placed', 'tracking_problem_alerts': {'x': at - 2 * 86400}}
        self.assertEqual(len(self.problems(result(), stale, cfg, at)), 1)

    def test_verified_mail_bodies_are_not_reread_each_tick(self):
        cfg = dict(self.cfg(), app='noon', order='NAEIA1', **{'for': 'owner'})
        hits = [{'account': 'icloud', 'folder': 'Inbox', 'uid': 1, 'from': 'noon <no-reply@noon.com>',
                 'subject': 'Your noon shipment has been delivered!', 'date': '2026-10-12 10:48'},
                {'account': 'icloud', 'folder': 'Inbox', 'uid': 2, 'from': 'noon <no-reply@noon.com>',
                 'subject': 'Your order is out for delivery', 'date': '2026-10-11 10:48'}]
        search = mock.Mock(stdout=json.dumps({'status': {'gmail': {'ok': True}}, 'hits': hits}), returncode=0)
        verified = {}
        bodies = {'1': 'Order NAEIA1 delivered', '2': 'Order NAEIA9 dispatched'}
        with mock.patch.object(t.subprocess, 'run', return_value=search), \
             mock.patch.object(t, 'run', side_effect=lambda args, timeout: bodies[args[-1]]) as read:
            first, _ = t.mail_evidence(cfg, verified)
            self.assertEqual(read.call_count, 2)
            second, errors = t.mail_evidence(cfg, verified)
            self.assertEqual(read.call_count, 2)
        self.assertEqual(verified, {'icloud:Inbox:1': True, 'icloud:Inbox:2': False})
        self.assertEqual([e['stage'] for e in first], ['delivered'])
        self.assertEqual([(e['stage'], e['mail_key']) for e in second], [('delivered', 'icloud:Inbox:1')])
        self.assertEqual(errors, [])

    def test_native_partial_delivery_is_preserved_not_whole_completion(self):
        cfg = dict(self.cfg(), app='noon', order='N123')
        native = {'status': 'unknown', 'coverage': 'bounded', 'whole_order_complete': False,
                  'shipments': [{'status': 'delivered', 'scope': 'item', 'item_id': 'N123-1',
                                 'shipment_id': 'N123-S1'}], 'items': [], 'truncated': False}
        with mock.patch('native_orders.track', return_value=native), \
             mock.patch.object(t, 'mail_evidence', return_value=([], [])), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            result = t.fetch(cfg, {}, time.time())
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        self.assertEqual(result['partial_evidence'][0]['item_id'], 'N123-1')
        state = {'primed': True, 'delay_sent': True}
        events = t.transition(result, state, cfg, time.time())
        self.assertEqual(events[0]['kind'], 'shipment_delivered')
        self.assertNotEqual(state.get('status'), 'delivered')
        self.assertEqual(t.transition(result, state, cfg, time.time()), [])

    def test_native_eta_provenance_survives_tracker(self):
        native = {'status': 'nearby', 'coverage': 'native_minutes', 'eta': '2026-10-08T18:13:00+04:00',
                  'eta_source': 'native_minutes_list_window', 'eta_window': {'start': 'a', 'end': 'b'}}
        with mock.patch('native_orders.track', return_value=native):
            result = t.fetch(dict(self.cfg(), app='noon'), {}, time.time())
        self.assertEqual(result['eta_source'], 'native_minutes_list_window')
        self.assertEqual(result['eta_window'], native['eta_window'])

    def test_marketplace_outage_cannot_upgrade_package_mail(self):
        import native_orders
        cfg = dict(self.cfg(), app='noon', order='N123')
        package_mail = {'stage': 'delivered', 'scope': 'order', 'confidence': 'exact_order',
                        'source': 'order_email', 'observed_at': t.stamp(), 'evidence': 'Delivered N123'}
        with mock.patch('native_orders.track', side_effect=native_orders.OrderError('AUTH_EXPIRED')), \
             mock.patch.object(t, 'mail_evidence', return_value=([package_mail], [])), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            result = t.fetch(cfg, {}, time.time())
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])

    def test_active_native_stage_keeps_delivered_sibling(self):
        native = {'status': 'out for delivery', 'coverage': 'bounded', 'whole_order_complete': False,
                  'shipments': [{'status': 'delivered', 'scope': 'item', 'item_id': 'N123-1',
                                 'shipment_id': 'N123-S1'}]}
        with mock.patch('native_orders.track', return_value=native):
            result = t.fetch(dict(self.cfg(), app='noon', order='N123'), {}, time.time())
        self.assertEqual(result['status'], 'out for delivery')
        self.assertEqual(result['partial_evidence'][0]['item_id'], 'N123-1')

    def test_moni_gets_no_progress_wakes_but_owner_does(self):
        at = time.time()
        for recipient, expected in (('moni', []), ('owner', [{'kind': 'stage_change', 'status': 'nearby'}])):
            with self.subTest(recipient=recipient):
                cfg = dict(self.cfg(), **{'for': recipient, 'eta': None})
                state = {'primed': True, 'status': 'out for delivery'}
                events = t.transition({'status': 'nearby', 'errors': []}, state, cfg, at)
                self.assertEqual(events, expected)
                self.assertEqual(state['status'], 'nearby')

    def test_moni_arrival_still_wakes_on_delivered(self):
        cfg = dict(self.cfg(), **{'for': 'moni'})
        state = {'primed': True, 'status': 'nearby'}
        self.assertEqual(t.transition({'status': 'delivered', 'errors': []}, state, cfg, time.time()),
                         [{'kind': 'stage_change', 'status': 'delivered'}])

    def test_moni_eta_elapsed_does_not_wake(self):
        cfg = dict(self.cfg(), **{'for': 'moni'})
        state = {'primed': True, 'status': 'preparing'}
        self.assertEqual(t.transition(self.result('preparing'), state, cfg, time.time()), [])
        self.assertTrue(state['delay_sent'])

    def test_group_chat_gets_arrival_only_wakes_like_moni(self):
        at = time.time()
        group = dict(self.cfg(), **{'for': 'owner', 'eta': None, 'chat': 'group-sb_gro'})
        state = {'primed': True, 'status': 'out for delivery'}
        self.assertEqual(t.transition({'status': 'nearby', 'errors': []}, state, group, at), [])
        self.assertEqual(state['status'], 'nearby')
        cand = dict(self.cfg(), **{'for': 'owner', 'chat': 'group-sb_gro'})
        state = {'primed': True, 'delay_sent': True}
        result = self.result()
        result['candidate'] = {'stage': 'nearby', 'evidence': 'App says nearby'}
        self.assertEqual(t.transition(result, state, cand, at), [])
        eta = dict(self.cfg(), **{'for': 'owner', 'chat': 'group-sb_gro', 'eta': '2000-01-01T00:00:00+04:00'})
        state = {'primed': True, 'status': 'preparing'}
        self.assertEqual(t.transition(self.result('preparing'), state, eta, at), [])
        self.assertTrue(state['delay_sent'])
        delivered = dict(self.cfg(), **{'for': 'owner', 'chat': 'group-sb_gro'})
        state = {'primed': True, 'status': 'nearby'}
        self.assertEqual(t.transition({'status': 'delivered', 'errors': []}, state, delivered, time.time()),
                         [{'kind': 'stage_change', 'status': 'delivered'}])

    def test_legacy_card_chat_only_also_counts_as_group(self):
        cfg = dict(self.cfg(), **{'for': 'owner', 'eta': None, 'delivery_card': {'chat': 'group-sb_gro'}})
        state = {'primed': True, 'status': 'out for delivery'}
        self.assertEqual(t.transition({'status': 'nearby', 'errors': []}, state, cfg, time.time()), [])

    def test_owner_chat_keeps_progress_wakes(self):
        cfg = dict(self.cfg(), **{'for': 'owner', 'eta': None, 'chat': 'owner'})
        state = {'primed': True, 'status': 'out for delivery'}
        self.assertEqual(t.transition({'status': 'nearby', 'errors': []}, state, cfg, time.time()),
                         [{'kind': 'stage_change', 'status': 'nearby'}])

    def test_moni_progress_candidate_is_not_a_wake(self):
        cfg = dict(self.cfg(), **{'for': 'moni'})
        state = {'primed': True, 'delay_sent': True}
        result = self.result()
        result['candidate'] = {'stage': 'nearby', 'evidence': 'App says nearby'}
        self.assertEqual(t.transition(result, state, cfg, time.time()), [])

    def test_shipment_to_item_arrival_is_not_duplicate(self):
        state = {'primed': True, 'delay_sent': True}
        cfg = self.cfg()
        result = self.result()
        proof = {'stage': 'delivered', 'scope': 'shipment', 'shipment_id': 'N123-S1',
                 'evidence_key': 'native:shipment:N123-S1', 'source': 'native_order_api'}
        result['partial_evidence'] = [proof]
        self.assertEqual(len(t.transition(result, state, cfg, time.time())), 1)
        result['partial_evidence'] = [{**proof, 'scope': 'item', 'item_id': 'N123-1',
                                       'evidence_key': 'native:item:N123-1'}]
        self.assertEqual(t.transition(result, state, cfg, time.time()), [])

    def receipt_cfg(self):
        return {'app': 'talabat', 'order': '3943292030', 'for': 'moni',
                'placed_at': '2026-10-08T11:48:46+04:00', 'registered_at': '2026-10-08T07:50:07+00:00',
                 'eta': '2026-10-08T12:49:00+04:00'}

    def amazon(self, whole=False):
        return {'order_id': '408-1234567-1234567', 'status': 'delivered' if whole else 'partially_delivered',
                'whole_order_delivered': whole, 'manifest': {'complete': whole},
                'shipments': [{'shipment_key': 'hash123', 'status': 'delivered',
                               'evidence_at': t.stamp(), 'items': [], 'contents_consistent': True}],
                'evidence': [], 'coverage': {'complete': True}, 'errors': []}

    def test_amazon_manifest_completion_closes_only_whole_order(self):
        cfg = dict(self.cfg(), app='amazon', order='408-1234567-1234567')
        for whole in (False, True):
            with mock.patch('amazon_email_orders.track', return_value=self.amazon(whole)), \
                 mock.patch.object(t.store, 'evidence', return_value=([], [])), \
                 mock.patch.object(t, 'mail_evidence', side_effect=AssertionError('legacy mail bypass')):
                result = t.fetch(cfg, {}, time.time())
            self.assertEqual(result['status'], 'delivered' if whole else 'unknown')
            self.assertEqual(result['whole_order_complete'], whole)
            state = {'primed': True, 'delay_sent': True}
            events = t.transition(result, state, cfg, time.time())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]['kind'], 'stage_change' if whole else 'shipment_delivered')
            self.assertEqual(state.get('status') == 'delivered', whole)
            self.assertEqual(t.transition(result, state, cfg, time.time()), [])

    def test_eta_alert_refreshes_recent_fallback_cache_within_one_fetch(self):
        import native_orders
        now = time.time()
        cfg = dict(self.cfg(), app='careem')
        for stage in ('delivered', 'out for delivery', 'unknown'):
            with self.subTest(stage=stage):
                cached = {'stage': 'preparing', 'confidence': 'exact_order', 'observed_at': t.stamp(now - 60)}
                state = {'primed': True, 'status': 'preparing', 'mail_checked': now - 60, 'mail_cache': [cached]}
                latest = [] if stage == 'unknown' else [dict(cached, stage=stage, observed_at=t.stamp(now))]
                with mock.patch('native_orders.track', side_effect=native_orders.OrderError('AUTH_EXPIRED')) as native, \
                     mock.patch.object(t, 'mail_evidence', return_value=(latest, [])) as mail, \
                     mock.patch.object(t.store, 'evidence', return_value=([], [])):
                    result = t.fetch(cfg, state, now)
                native.assert_called_once_with('careem', cfg['order'], timeout=8)
                mail.assert_called_once()
                self.assertEqual(state['mail_cache'], latest)
                self.assertEqual(result['status'], stage)
                kinds = [e['kind'] for e in t.transition(result, state, cfg, now)]
                self.assertEqual('eta_elapsed' in kinds, stage != 'delivered')
                self.assertEqual(state.get('status') == 'delivered', stage == 'delivered')

    def test_eta_alert_uses_one_fresh_native_read_without_mail_fallback(self):
        cfg = dict(self.cfg(), app='noon', order='IAEFIXTURE')
        state = {'primed': True, 'status': 'out for delivery'}
        with mock.patch('native_orders.track', return_value={'status': 'delivered', 'coverage': 'native'}) as native, \
             mock.patch('noon_order_details.details', return_value={}), \
             mock.patch.object(t, 'mail_evidence') as mail:
            result = t.fetch(cfg, state, time.time())
        native.assert_called_once()
        mail.assert_not_called()
        self.assertEqual(t.transition(result, state, cfg, time.time()),
                         [{'kind': 'stage_change', 'status': 'delivered'}])

    def test_eta_alert_refreshes_recent_amazon_cache(self):
        now = time.time()
        cfg = dict(self.cfg(), app='amazon', order='408-1234567-1234567')
        state = {'primed': True, 'status': 'out for delivery', 'amazon_checked': now - 60,
                 'amazon_cache': self.amazon()}
        with mock.patch('amazon_email_orders.track', return_value=self.amazon(whole=True)) as scan, \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            result = t.fetch(cfg, state, now)
        scan.assert_called_once()
        self.assertEqual(scan.call_args.kwargs['timeout'], 35)
        self.assertEqual(t.transition(result, state, cfg, now),
                         [{'kind': 'stage_change', 'status': 'delivered'}])
        self.assertTrue(state['amazon_cache']['whole_order_delivered'])

    def test_amazon_cache_bounds_reads_and_outage_never_uses_legacy_delivery(self):
        cfg = dict(self.cfg(), app='amazon', order='408-1234567-1234567', eta=None)
        state = {'mail_cache': [{'stage': 'delivered', 'confidence': 'exact_order'}]}
        now = time.time()
        with mock.patch('amazon_email_orders.track', return_value=self.amazon()) as scan, \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            t.fetch(cfg, state, now)
            t.fetch(cfg, state, now + 60)
            self.assertEqual(scan.call_count, 1)
            self.assertEqual(scan.call_args.kwargs['timeout'], 35)
        with mock.patch('amazon_email_orders.track', side_effect=RuntimeError('private data')), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            result = t.fetch(cfg, state, now + 301)
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        self.assertNotIn('private data', json.dumps(result))

    def mailsearch(self, hits, ok=True):
        out = json.dumps({'status': {'gmail': {'ok': ok}}, 'hits': hits})
        return mock.patch.object(t.subprocess, 'run', return_value=mock.Mock(stdout=out, returncode=0))

    # Real 8 Oct 2026 receipt (order ID only inside the PDF attachment).
    REAL = {'account': 'gmail', 'folder': '[Gmail]/All Mail', 'uid': 265136, 'date': '2026-10-08 12:36',
            'from': 'Talabat <noreply@talabat.com>', 'subject': 'Your service charges Receipt'}

    def test_talabat_receipt_email_is_delivered(self):
        with self.mailsearch([self.REAL]) as run:
            proof, errors = t.talabat_receipt(self.receipt_cfg())
        query = run.call_args[0][0][-1]
        self.assertIn('"3943292030"', query)
        self.assertIn('subject:receipt', query)
        self.assertEqual((proof['stage'], proof['confidence'], errors), ('delivered', 'exact_order', []))
        self.assertTrue(proof['email_date'].startswith('2026-10-08T12:36'))

    def test_receipt_rejects_other_senders_subjects_and_older_mail(self):
        for hit in [dict(self.REAL, **{'from': 'Talabat <noreply@talabat.com.evil.io>'}),
                    dict(self.REAL, subject='Your PostPaid order was approved'),
                    dict(self.REAL, date='2026-10-07 13:28')]:
            with self.mailsearch([hit]):
                self.assertIsNone(t.talabat_receipt(self.receipt_cfg())[0])
        with self.mailsearch([], ok=False):
            self.assertEqual(t.talabat_receipt(self.receipt_cfg()), (None, ['receipt_email_unavailable:gmail']))

    def test_replay_8_oct_receipt_fires_delivered_before_eta(self):
        cfg = self.receipt_cfg()
        state = {'primed': True}
        at = t.epoch('2026-10-08T12:37:00+04:00')
        native = mock.patch('native_orders.track', side_effect=__import__('native_orders').OrderError('ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY'))
        with native, self.mailsearch([self.REAL]), \
             mock.patch.object(t, 'mail_evidence', return_value=([], [])), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])), \
             mock.patch.object(t, 'single_allowed', return_value=False):
            result = t.fetch(cfg, state, at)
            events = t.transition(result, state, cfg, at)
            self.assertEqual(result['status'], 'delivered')
            self.assertEqual(events, [{'kind': 'stage_change', 'status': 'delivered'}])
            # Cached receipt: no re-query, no duplicate event, no later eta_elapsed.
            later = at + 1800
            result = t.fetch(cfg, state, later)
            self.assertEqual(t.transition(result, state, cfg, later), [])


class AmazonGlueTest(unittest.TestCase):
    """Parser -> reducer -> watcher regressions; no mail, phone, or disk state."""

    def setUp(self):
        import amazon_email_orders
        from test import test_amazon_email_orders
        self.a, self.f = amazon_email_orders, test_amazon_email_orders
        self.now = t.epoch('2026-10-08T15:00:00+00:00')
        self.cfg = {'app': 'amazon', 'order': self.f.OID, 'for': 'owner',
                    'placed_at': '2026-10-05T10:00:00+00:00',
                    'registered_at': t.stamp(self.now - 60), 'eta': None,
                    'watcher': 'order-amazon-fixture'}
        for target, kwargs in [
            ('order_tracker.store.evidence', {'return_value': ([], [])}),
            ('order_tracker.single_allowed', {'return_value': False}),
            ('order_tracker.subprocess.run', {'side_effect': AssertionError('no live I/O')}),
        ]:
            patcher = mock.patch(target, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)

    def projection(self, *raws, start_uid=99):
        events = [e for uid, raw in enumerate(raws, start_uid) for e in self.f.parse(raw, uid=uid)]
        result = self.a.aggregate_order(self.f.OID, events)
        result['coverage'] = {'complete': True, 'order': result['coverage']}
        return dict(result, checked_at=self.f.OBSERVED, errors=[])

    def fetch(self, mail, state=None, now=None):
        with mock.patch('amazon_email_orders.track', return_value=mail):
            return t.fetch(self.cfg, {} if state is None else state,
                           self.now if now is None else now)

    def unbound(self):
        return self.f.mail('Delivered: Fixture',
                           f'Your package was delivered.\nOrder #\n{self.f.OID}\n')

    def test_unbound_delivery_survives_and_dedupes_by_event(self):
        mail = self.projection(self.unbound())
        self.assertEqual(mail['shipments'], [])
        state = {'primed': True}
        result = self.fetch(mail, state)
        self.assertFalse(result['whole_order_complete'])
        self.assertEqual(len(result['partial_evidence']), 1)
        proof = result['partial_evidence'][0]
        self.assertEqual(proof['evidence_key'], 'amazon:event:' + mail['evidence'][0]['event_id'])
        self.assertEqual(proof['scope'], 'shipment')
        self.assertIsNone(proof.get('shipment_id'))
        self.assertEqual(proof['observed_at'], mail['evidence'][0]['observed_at'])
        self.assertEqual(proof['email_date'], mail['evidence'][0]['evidence_at'])
        self.assertEqual([e['kind'] for e in t.transition(result, state, self.cfg, self.now)],
                         ['shipment_delivered'])
        self.assertEqual(t.transition(self.fetch(mail, state, self.now + 60), state,
                                      self.cfg, self.now + 60), [])
        self.assertNotEqual(state.get('status'), 'delivered')

    def test_unbound_missing_time_is_not_arrival_proof(self):
        raw = self.f.mail('Delivered: Fixture', f'Order #\n{self.f.OID}\n', date=None)
        result = self.fetch(self.projection(raw))
        self.assertEqual(result['partial_evidence'], [])
        self.assertFalse(result['whole_order_complete'])

    def test_unparsed_inventory_to_bound_shipment_is_not_second_arrival(self):
        first = self.projection(self.f.shipment(items=()))
        later = self.projection(self.f.shipment())
        state = {'primed': True}
        result = self.fetch(first, state)
        self.assertEqual(len(result['partial_evidence']), 1)
        self.assertEqual(len(t.transition(result, state, self.cfg, self.now)), 1)
        result = self.fetch(later, state, self.now + 301)
        self.assertEqual(t.transition(result, state, self.cfg, self.now + 301), [])

    def test_bound_proof_uses_matching_event_times_even_on_cache_hit(self):
        mail = self.projection(self.f.shipment('Shipped: Fixture'), self.f.shipment())
        delivered = next(e for e in mail['evidence'] if e['stage'] == 'delivered')
        delivered['observed_at'] = '2026-10-08T10:00:05+00:00'
        state = {}
        with mock.patch('amazon_email_orders.track', return_value=mail) as scan:
            first = t.fetch(self.cfg, state, self.now)
            second = t.fetch(self.cfg, state, self.now + 60)
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(len(first['partial_evidence']), 1)
        for result in (first, second):
            proof = result['partial_evidence'][0]
            self.assertEqual(proof['observed_at'], delivered['observed_at'])
            self.assertEqual(proof['email_date'], delivered['evidence_at'])

    def test_legacy_mail_keys_migrate_for_bound_and_unbound_delivery(self):
        for raw in (self.f.shipment(), self.unbound()):
            for seen_field in ('shipments_seen', 'parts_delivered_seen'):
                with self.subTest(bound=raw != self.unbound(), seen_field=seen_field):
                    mail = self.projection(raw)
                    event = mail['evidence'][0]
                    key = f'{event["account"]}:{event["folder"]}:{event["uid"]}'
                    state = {'primed': True, seen_field: [key]}
                    result = self.fetch(mail, state)
                    self.assertEqual(t.transition(result, state, self.cfg, self.now), [])
                    self.assertIn(result['partial_evidence'][0]['evidence_key'],
                                  state['parts_delivered_seen'])
                    # No broad suppression: a different package must still notify.
                    new = self.projection(self.f.shipment(sid='OTHER-SHIPMENT'), start_uid=1000)
                    result = self.fetch(new, state, self.now + 301)
                    self.assertEqual([e['kind'] for e in t.transition(result, state, self.cfg,
                                                                    self.now + 301)],
                                     ['shipment_delivered'])

    def test_aftercare_is_scoped_deduped_and_not_a_historical_arrival(self):
        for subject, stage in [('Your return of Fixture', 'return_requested'),
                               ('Return received: Fixture', 'returned'),
                               ('Refund issued: Fixture', 'refunded'),
                               ('Cancelled: Fixture', 'cancelled')]:
            with self.subTest(stage=stage):
                mail = self.projection(self.f.shipment(), self.f.shipment(
                    subject, date='Wed, 07 Oct 2026 10:00:00 +0000'))
                state = {'primed': True}
                result = self.fetch(mail, state)
                self.assertFalse(result['whole_order_complete'])
                self.assertEqual(result['aftercare_evidence'][0]['stage'], stage)
                self.assertEqual(result['aftercare_evidence'][0]['scope'], 'item')
                self.assertTrue(result['partial_evidence'][0]['historical'])
                events = t.transition(result, state, self.cfg, self.now)
                self.assertEqual([e['kind'] for e in events], ['aftercare'])
                self.assertEqual(events[0]['status'], stage)
                self.assertNotIn(state.get('status'), t.TERMINAL)
                self.assertEqual(t.transition(result, state, self.cfg, self.now + 60), [])
                # Recovery must not replay either arrival or aftercare.
                with mock.patch('amazon_email_orders.track', side_effect=RuntimeError('offline')):
                    outage = t.fetch(self.cfg, state, self.now + 301)
                self.assertFalse(outage['whole_order_complete'])
                recovered = self.fetch(mail, state, self.now + 602)
                self.assertEqual(t.transition(recovered, state, self.cfg, self.now + 602), [])

    def test_legacy_second_account_alias_survives_reduce_fetch_transition(self):
        for raw in (self.f.shipment(), self.unbound()):
            for seen_field in ('shipments_seen', 'parts_delivered_seen'):
                with self.subTest(bound=raw != self.unbound(), seen_field=seen_field):
                    gmail = self.a.parse_message(raw, account='gmail', folder='[Gmail]/All Mail',
                                                uid=99, observed_at=self.f.OBSERVED)[0]
                    outlook = self.a.parse_message(raw, account='outlook', folder='Archive',
                                                  uid=123, observed_at='2026-10-08T10:01:00+00:00')[0]
                    self.assertEqual(gmail['event_id'], outlook['event_id'])
                    reduced = self.a.aggregate_order(self.f.OID, [gmail, outlook])
                    self.assertEqual(len(reduced['evidence']), 1)
                    self.assertEqual(reduced['evidence'][0]['account'], 'gmail')
                    mail = dict(reduced, checked_at=self.f.OBSERVED, errors=[])
                    state = {'primed': True, seen_field: ['outlook:Archive:123']}
                    result = self.fetch(mail, state)
                    self.assertEqual(t.transition(result, state, self.cfg, self.now), [])
                    proof = result['partial_evidence'][0]
                    self.assertEqual(set(proof['mail_keys']),
                                     {'gmail:[Gmail]/All Mail:99', 'outlook:Archive:123'})
                    self.assertEqual(proof['observed_at'], gmail['observed_at'])
                    self.assertEqual(proof['email_date'], gmail['evidence_at'])
                    self.assertIn(proof['evidence_key'], state['parts_delivered_seen'])
                    self.assertIn('amazon:event:' + gmail['event_id'], state['parts_delivered_seen'])
                    self.assertFalse(result['whole_order_complete'])
                    # An unchanged cached scan must not replay the migrated arrival.
                    self.assertEqual(t.transition(self.fetch(mail, state, self.now + 60),
                                                  state, self.cfg, self.now + 60), [])
                    # Alias migration does not suppress a genuinely different package.
                    other = self.projection(self.f.shipment(sid='DIFFERENT-SHIPMENT'), start_uid=1000)
                    result = self.fetch(other, state, self.now + 301)
                    self.assertEqual([e['kind'] for e in t.transition(result, state, self.cfg,
                                                                    self.now + 301)],
                                     ['shipment_delivered'])

    def test_later_sibling_arrival_survives_aftercare(self):
        mail = self.projection(self.f.shipment(), self.f.shipment(
            'Your return of Fixture', date='Wed, 07 Oct 2026 10:00:00 +0000'),
            self.f.shipment(sid='LATER-SHIPMENT', date='Thu, 08 Oct 2026 09:00:00 +0000'))
        result = self.fetch(mail)
        events = t.transition(result, {'primed': True}, self.cfg, self.now)
        self.assertEqual(sorted(e['kind'] for e in events), ['aftercare', 'shipment_delivered'])
        self.assertEqual(sum(not p.get('historical', False) for p in result['partial_evidence']), 1)

    def test_problem_evidence_survives_glue(self):
        mail = self.projection(self.f.shipment('Delivery failed: Fixture'))
        result = self.fetch(mail)
        self.assertEqual(result['problem']['stage'], 'problem')
        self.assertEqual(result['problem']['scope'], 'shipment')
        events = t.transition(result, {'primed': True}, self.cfg, self.now)
        self.assertEqual([e['kind'] for e in events], ['problem'])

    def test_later_unbound_problem_does_not_announce_prior_arrival(self):
        problem = self.f.mail('Delivery failed: Fixture', f'Order #\n{self.f.OID}\n',
                              date='Wed, 07 Oct 2026 10:00:00 +0000')
        result = self.fetch(self.projection(self.f.shipment(), problem))
        events = t.transition(result, {'primed': True}, self.cfg, self.now)
        self.assertEqual([e['kind'] for e in events], ['problem'])
        self.assertTrue(result['partial_evidence'][0]['historical'])

    def test_whole_closure_still_requires_complete_manifest(self):
        complete = self.projection(self.f.confirmation(), self.f.shipment())
        partial = self.projection(self.f.shipment())
        state = {'primed': True}
        result = self.fetch(partial, state)
        self.assertFalse(result['whole_order_complete'])
        t.transition(result, state, self.cfg, self.now)
        result = self.fetch(complete, state, self.now + 301)
        self.assertTrue(result['whole_order_complete'])
        self.assertEqual(t.transition(result, state, self.cfg, self.now + 301),
                         [{'kind': 'stage_change', 'status': 'delivered'}])
        self.assertEqual(result['evidence'][0]['email_date'],
                         complete['shipments'][0]['evidence_at'])

    def test_aftercare_after_whole_delivery_is_not_suppressed(self):
        mail = self.projection(self.f.confirmation(), self.f.shipment())
        state = {'primed': True}
        first = self.fetch(mail, state)
        t.transition(first, state, self.cfg, self.now)
        later = self.projection(self.f.confirmation(), self.f.shipment(), self.f.shipment(
            'Your return of Fixture', date='Wed, 07 Oct 2026 10:00:00 +0000'))
        result = self.fetch(later, state, self.now + 301)
        events = t.transition(result, state, self.cfg, self.now + 301)
        self.assertEqual([e['kind'] for e in events], ['aftercare'])
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        # Historical delivery is retained, not presented as current completion.
        self.assertEqual(result['last_confirmed_status'], 'delivered')

    def test_partial_outage_recovery_preserves_dedupe_and_push_is_candidate(self):
        mail = self.projection(self.f.shipment())
        state = {'primed': True}
        t.transition(self.fetch(mail, state), state, self.cfg, self.now)
        push = {'stage': 'delivered', 'observed_at': t.stamp(self.now),
                'source': 'android_notification_journal', 'confidence': 'exact_order'}
        with mock.patch('amazon_email_orders.track', side_effect=RuntimeError('offline')), \
             mock.patch.object(t.store, 'evidence', return_value=([push], [])):
            outage = t.fetch(self.cfg, state, self.now + 301)
        self.assertEqual(outage['status'], 'unknown')
        self.assertFalse(outage['whole_order_complete'])
        self.assertEqual(outage['candidate']['confidence'], 'amazon_notification_unconfirmed')
        t.transition(outage, state, self.cfg, self.now + 301)
        recovered = self.fetch(mail, state, self.now + 602)
        events = t.transition(recovered, state, self.cfg, self.now + 602)
        self.assertFalse(any(e['kind'] in ('shipment_delivered', 'stage_change') for e in events))
        self.assertFalse(recovered['whole_order_complete'])

    def test_check_whole_arrival_reconciles_observation_separately_from_email_date(self):
        mail = self.projection(self.f.confirmation(), self.f.shipment())
        folder = Path.home() / '.local/share/robob-watch/watchers' / self.cfg['watcher']
        with mock.patch.dict(t.os.environ, WATCH_DIR=str(folder)), \
             mock.patch.object(Path, 'open', mock.mock_open()), \
             mock.patch.object(t.fcntl, 'flock'), \
             mock.patch.object(t, 'read', return_value={'primed': True}), \
             mock.patch.object(t, 'write'), \
             mock.patch.object(t.time, 'time', return_value=self.now), \
             mock.patch('amazon_email_orders.track', return_value=mail), \
             mock.patch.object(t.store, 'reconcile') as reconcile, \
             redirect_stdout(io.StringIO()):
            t.check(self.cfg)
        reconcile.assert_called_once_with(self.cfg, detected=t.stamp(self.now),
                                          source='amazon_email',
                                          evidence_time=mail['shipments'][0]['evidence_at'])

    def test_check_wake_carries_aftercare_and_never_removes_or_reconciles_arrival(self):
        mail = self.projection(self.f.shipment(), self.f.shipment(
            'Your return of Fixture', date='Wed, 07 Oct 2026 10:00:00 +0000'))
        folder = Path.home() / '.local/share/robob-watch/watchers' / self.cfg['watcher']
        output = io.StringIO()
        with mock.patch.dict(t.os.environ, WATCH_DIR=str(folder)), \
             mock.patch.object(Path, 'open', mock.mock_open()), \
             mock.patch.object(t.fcntl, 'flock'), \
             mock.patch.object(t, 'read', return_value={'primed': True}), \
             mock.patch.object(t, 'write'), \
             mock.patch.object(t.time, 'time', return_value=self.now), \
             mock.patch('amazon_email_orders.track', return_value=mail), \
             mock.patch.object(t.store, 'reconcile') as reconcile, \
             mock.patch.object(t, 'run', side_effect=AssertionError('no mutations')), \
             redirect_stdout(output):
            t.check(self.cfg)
        wake = json.loads(output.getvalue())
        self.assertEqual(wake['email_status'], 'return_requested')
        self.assertEqual(wake['aftercare_evidence'][0]['stage'], 'return_requested')
        self.assertEqual([e['kind'] for e in wake['events']], ['aftercare'])
        self.assertFalse(wake['whole_order_complete'])
        reconcile.assert_not_called()


class RetireTest(unittest.TestCase):
    """Keep the terminal wake, then archive without another provider read."""

    def setUp(self):
        self.now = 1_800_000_000.0
        self.cfg = {'app': 'talabat', 'order': '12345', 'for': 'owner', 'chat': 'owner',
                    'watcher': 'order-talabat-12345', 'registered_at': t.stamp(self.now - 7200)}
        self.wid = self.cfg['watcher']
        self.live = Path.home() / '.local/share/robob-watch/watchers' / self.wid

    def check(self, state, result, folder=None, run=None, card=None):
        output = io.StringIO()
        run = run or mock.Mock(return_value='')
        with mock.patch.dict(t.os.environ, WATCH_DIR=str(folder or self.live), WATCH_RUN=getattr(self, 'watch_run', 'scheduled-fixture')), \
             mock.patch.object(Path, 'open', mock.mock_open()), \
             mock.patch.object(Path, 'exists', return_value=True), \
             mock.patch.object(t.fcntl, 'flock'), \
             mock.patch.object(t, 'read', return_value=state), \
             mock.patch.object(t, 'write') as write, \
             mock.patch.object(t.time, 'time', return_value=self.now), \
             mock.patch.object(t, 'fetch', return_value=result) as fetch, \
             mock.patch.object(t.store, 'reconcile') as reconcile, \
             mock.patch.object(t.delivery_cards, 'safe_sync', return_value=card or {'status': 'ready', 'link_health': 'ok', 'rendered': True}) as sync, \
             mock.patch.object(t, 'run', run), \
             redirect_stdout(output):
            t.check(self.cfg)
        self.fetch = fetch
        self.reconcile = reconcile
        self.sync = sync
        return run, write, output.getvalue()

    def test_delivered_tracker_retires_without_polling(self):
        state = {'primed': True, 'status': 'delivered', 'terminal_at': self.now - 1801}
        run, write, out = self.check(state, {'status': 'delivered', 'errors': []})
        run.assert_called_once_with(['robob-watch', 'remove', self.wid])
        self.assertIs(self.cfg.get('active'), False)
        self.assertIs(write.call_args.args[1], self.cfg)
        self.assertEqual(out, '')
        self.fetch.assert_not_called()

    def test_food_terminal_read_emits_once_and_retires_on_the_next_tick(self):
        import noon_vertical_reads as vertical

        for raw, expected in [('canceled', 'cancelled'), ('delivered', 'delivered')]:
            with self.subTest(raw=raw):
                cfg = dict(self.cfg, app='noon', order='FTEST', vertical='food',
                           watcher='order-noon-ftest', active=True)
                state = {'primed': True, 'status': 'preparing', 'tracking_problem_streak': 3}
                response = {'status': 'success', 'data': {'orderNr': cfg['order'], 'status': raw}}
                watchers = Path('/fixture/watchers')
                output = io.StringIO()
                with mock.patch.dict(t.os.environ, WATCH_DIR=str(watchers / cfg['watcher']), WATCH_RUN='scheduled-fixture'), \
                     mock.patch.object(t, 'WATCHERS', watchers), \
                     mock.patch.object(Path, 'open', mock.mock_open()), \
                     mock.patch.object(Path, 'exists', return_value=True), \
                     mock.patch.object(t.fcntl, 'flock'), \
                     mock.patch.object(t, 'read', return_value=state), \
                     mock.patch.object(t, 'write'), \
                     mock.patch.object(t.time, 'time', return_value=self.now) as clock, \
                     mock.patch.object(vertical, '_headers', return_value={}), \
                     mock.patch.object(vertical, '_read', return_value=response), \
                     mock.patch('noon_order_details.details', return_value={}), \
                     mock.patch.object(t.delivery_cards, 'safe_sync', return_value={}), \
                     mock.patch.object(t, 'run', return_value='') as run, \
                     redirect_stdout(output):
                    t.check(cfg)
                    self.assertEqual(json.loads(output.getvalue())['events'],
                                     [{'kind': 'stage_change', 'status': expected}])
                    self.assertEqual(state['terminal_at'], self.now)
                    self.assertEqual(state['last_result']['errors'], [])
                    self.assertEqual(state['tracking_problem_streak'], 0)
                    run.assert_not_called()

                    output.seek(0)
                    output.truncate(0)
                    clock.return_value = self.now + 60
                    t.check(cfg)
                    run.assert_called_once_with(['robob-watch', 'remove', cfg['watcher']])
                    self.assertFalse(cfg['active'])
                    self.assertEqual(output.getvalue(), '')

    def test_delivered_tracker_retires_on_the_next_tick(self):
        state = {'primed': True, 'status': 'delivered', 'terminal_at': self.now - 600}
        run, _, out = self.check(state, {'status': 'delivered', 'errors': []})
        run.assert_called_once_with(['robob-watch', 'remove', self.wid])
        self.fetch.assert_not_called()
        self.assertEqual(out, '')

    def test_terminal_wake_run_never_retires(self):
        state = {'primed': True, 'status': 'placed'}
        run, _, out = self.check(state, {'status': 'delivered', 'errors': []})
        run.assert_not_called()
        self.assertEqual(state['terminal_at'], self.now)
        self.assertEqual([e['kind'] for e in json.loads(out)['events']], ['stage_change'])

    def test_complete_amazon_tracker_retires_without_polling(self):
        self.cfg.update(app='amazon', watcher='order-amazon-12345')
        self.wid = self.cfg['watcher']
        self.live = t.WATCHERS / self.wid
        state = {'primed': True, 'status': 'delivered',
                 'last_result': {'status': 'delivered', 'whole_order_complete': True}}
        run, _, _ = self.check(state, {'status': 'delivered', 'errors': [], 'whole_order_complete': True})
        run.assert_called_once_with(['robob-watch', 'remove', self.wid])
        self.fetch.assert_not_called()

    def test_scratch_watch_dir_never_retires(self):
        import tempfile
        state = {'primed': True, 'status': 'delivered', 'terminal_at': self.now - 7200}
        with tempfile.TemporaryDirectory() as scratch:
            run, _, _ = self.check(state, {'status': 'delivered', 'errors': []}, folder=Path(scratch))
        run.assert_not_called()

    def test_failed_retire_is_kept_for_the_next_tick(self):
        state = {'primed': True, 'status': 'delivered', 'terminal_at': self.now - 7200}
        run = mock.Mock(side_effect=RuntimeError('robob-watch failed'))
        _, write, _ = self.check(state, {'status': 'delivered', 'errors': []}, run=run)
        self.assertEqual(state['retire_error'], 'robob-watch failed')
        self.fetch.assert_not_called()
        write.assert_called()

    def test_overdue_delivered_read_emits_arrival_and_next_tick_does_not_poll(self):
        self.cfg['eta'] = t.stamp(self.now - 600)
        state = {'primed': True, 'status': 'out for delivery'}
        delivered = {'status': 'delivered', 'errors': [], 'whole_order_complete': True}
        run, _, out = self.check(state, delivered)
        self.assertEqual(json.loads(out)['events'], [{'kind': 'stage_change', 'status': 'delivered'}])
        self.assertNotIn('delay_sent', state)
        run.assert_not_called()  # Removing here would discard the runner's terminal event.
        run, _, out = self.check(state, {'status': 'out for delivery', 'errors': []})
        self.fetch.assert_not_called()
        run.assert_called_once_with(['robob-watch', 'remove', self.wid])
        self.assertEqual(out, '')

    def test_genuinely_late_and_unknown_orders_still_emit_eta_elapsed(self):
        self.cfg['eta'] = t.stamp(self.now - 600)
        for status in ('out for delivery', 'unknown', 'preparing', 'nearby'):
            with self.subTest(status=status):
                state = {'primed': True, 'status': 'out for delivery'}
                run, _, out = self.check(state, {'status': status, 'errors': []})
                self.fetch.assert_called_once()
                self.assertIn('eta_elapsed', [e['kind'] for e in json.loads(out)['events']])
                run.assert_not_called()

    def test_partial_marketplace_and_amazon_delivery_do_not_retire(self):
        for app, whole in (('noon', False), ('amazon', False), ('amazon', None)):
            with self.subTest(app=app, whole=whole):
                self.cfg['app'] = app
                state = {'primed': True, 'status': 'out for delivery'}
                result = {'status': 'delivered', 'errors': [], 'whole_order_complete': whole}
                run, _, _ = self.check(state, result)
                self.fetch.assert_called_once()
                run.assert_not_called()
                self.assertNotEqual(state['status'], 'delivered')
                self.reconcile.assert_not_called()

    def test_cancelled_tracker_retires_without_polling(self):
        state = {'primed': True, 'status': 'cancelled'}
        run, _, out = self.check(state, {'status': 'preparing', 'errors': []})
        self.fetch.assert_not_called()
        run.assert_called_once_with(['robob-watch', 'remove', self.wid])
        self.assertEqual(out, '')

    def test_retirement_keeps_order_and_archived_terminal_record(self):
        import tempfile
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            watchers = root / 'watchers'
            folder = watchers / self.wid
            folder.mkdir(parents=True)
            orders = root / 'orders'
            orders.mkdir()
            cfg = dict(self.cfg, active=True)
            record = orders / (self.wid + '.json')
            t.write(record, cfg)
            state = {'primed': True, 'status': 'delivered',
                     'last_result': {'status': 'delivered', 'whole_order_complete': True}}
            t.write(folder / 'order-tracker-state.json', state)
            archive = root / 'archived'
            def remove(args):
                self.assertEqual(args, ['robob-watch', 'remove', self.wid])
                folder.rename(archive)
            with mock.patch.dict(t.os.environ, WATCH_DIR=str(folder), WATCH_RUN='scheduled-fixture'), \
                 mock.patch.object(t, 'ROOT', root), mock.patch.object(t, 'WATCHERS', watchers), \
                 mock.patch.object(t, 'run', side_effect=remove), \
                 mock.patch.object(t, 'fetch') as fetch:
                t.check(cfg)
            fetch.assert_not_called()
            self.assertFalse(folder.exists())
            self.assertEqual(t.read(archive / 'order-tracker-state.json'), state)
            self.assertIs(t.read(record)['active'], False)
            self.assertEqual(t.read(record)['order'], cfg['order'])

    def test_terminal_prime_preserves_watcher_for_registration(self):
        self.watch_run = 'prime-fixture'
        state = {}
        run, _, out = self.check(state, {'status': 'delivered', 'errors': []})
        self.assertEqual(state['status'], 'delivered')
        self.assertEqual(out, '')
        run.assert_not_called()
        # A repeated prime must also keep the already-confirmed record.
        run, _, _ = self.check(state, {'status': 'delivered', 'errors': []})
        self.fetch.assert_not_called()
        run.assert_not_called()

    def test_terminal_registration_in_progress_does_not_retire(self):
        self.cfg['delivery_card'] = {'ready': False}
        state = {'primed': True, 'status': 'delivered'}
        run, _, _ = self.check(state, {'status': 'delivered', 'errors': []})
        self.fetch.assert_not_called()
        run.assert_not_called()

    def test_direct_terminal_check_does_not_archive_wake(self):
        self.watch_run = ''
        state = {'primed': True, 'status': 'delivered'}
        run, _, out = self.check(state, {'status': 'delivered', 'errors': []})
        self.fetch.assert_not_called()
        run.assert_not_called()
        self.assertEqual(out, '')

    def test_pending_terminal_wake_is_kept_without_polling(self):
        import tempfile
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            folder = root / 'watchers' / self.wid
            folder.mkdir(parents=True)
            pending = {'key': 'terminal-fixture', 'event': 'delivered', 'at': t.stamp(self.now)}
            runner_state = {'status': 'active', 'pending': pending}
            t.write(folder / 'state.json', runner_state)
            t.write(folder / 'order-tracker-state.json', {'primed': True, 'status': 'delivered'})
            with mock.patch.dict(t.os.environ, WATCH_DIR=str(folder), WATCH_RUN='scheduled-fixture'), \
                 mock.patch.object(t, 'ROOT', root), mock.patch.object(t, 'WATCHERS', folder.parent), \
                 mock.patch.object(t, 'run') as remove, mock.patch.object(t, 'fetch') as fetch:
                t.check(self.cfg)
            fetch.assert_not_called()
            remove.assert_not_called()
            self.assertEqual(t.read(folder / 'state.json'), runner_state)

    def test_remove_command_still_retires(self):
        cfg = dict(self.cfg, active=True)
        output = io.StringIO()
        with mock.patch.object(Path, 'exists', return_value=True), \
             mock.patch.object(t, 'read', return_value=cfg), \
             mock.patch.object(t, 'write') as write, \
             mock.patch.object(t, 'run', return_value='') as run, \
             redirect_stdout(output):
            t.main(['remove', '--app', 'talabat', '--order', '12345'])
        run.assert_called_once_with(['robob-watch', 'remove', self.wid])
        self.assertIs(cfg['active'], False)
        self.assertIs(write.call_args.args[1], cfg)
        self.assertEqual(output.getvalue().strip(), f'Removed {self.wid}')


class TerminalCardRenderTest(unittest.TestCase):
    def scenario(self, failure, *, fail_render=False):
        import tempfile
        cards = t.delivery_cards
        with tempfile.TemporaryDirectory() as scratch, ExitStack() as stack:
            root = Path(scratch)
            watchers = root / 'watchers'
            cfg = {'app': 'noon', 'order': 'IAEFIXTURE', 'for': 'owner', 'chat': 'owner',
                   'watcher': 'order-noon-fixture', 'registered_at': t.stamp(time.time() - 60),
                   'delivery_card': {'ready': True}, 'card_meta': {'items': [{'name': 'Fixture', 'qty': 1}]},
                   'active': True}
            folder = watchers / cfg['watcher']
            folder.mkdir(parents=True)
            record = root / 'orders' / (cfg['watcher'] + '.json')
            t.write(record, cfg)
            t.write(folder / 'state.json', {'status': 'active'})
            t.write(folder / 'order-tracker-state.json', {'primed': True, 'status': 'preparing'})
            for obj, name, value in ((t, 'ROOT', root), (t, 'WATCHERS', watchers),
                                     (cards, 'ROOT', root), (cards, 'APPS', root / 'apps')):
                stack.enter_context(mock.patch.object(obj, name, value))
            stack.enter_context(mock.patch.object(t.toollog, 'root', return_value=root / 'logs'))
            stack.enter_context(mock.patch.dict(t.os.environ, WATCH_DIR=str(folder), WATCH_RUN='scheduled-fixture'))
            stack.enter_context(mock.patch.object(cards, 'preview', return_value=False))
            stack.enter_context(mock.patch.object(cards, 'route', return_value='fixture-session'))
            def bridge(args, **kwargs):
                if args[0] == 'publish':
                    return {} if failure == 'publish_ack' else {'url': 'https://fixture.example/card/'}
                if args[0] == 'app':
                    if failure == 'send_error':
                        raise cards.BridgeError('fixture transport failure')
                    return {}
                raise AssertionError('unexpected bridge operation')
            transport = stack.enter_context(mock.patch.object(cards, 'bridge', side_effect=bridge))
            preparing = {'status': 'preparing', 'errors': []}
            placed = cards.safe_sync(cfg, preparing, send=True)
            expected = {'publish_ack': 'failed:card_publish_bad_ack', 'send_ack': 'failed:card_send_bad_ack',
                        'send_error': 'failed:bridge_request_failed'}[failure]
            self.assertEqual(placed['status'], expected)
            self.assertIs(placed['rendered'], True)
            card_path = root / 'cards' / (cfg['watcher'] + '.json')
            placement = cards.read(card_path)
            retry_fields = {k: placement[k] for k in ('status', 'send_args', 'open', 'attempted_at') if k in placement}
            transport.reset_mock()
            delivered = {'status': 'delivered', 'errors': [], 'whole_order_complete': True}
            fetch = stack.enter_context(mock.patch.object(t, 'fetch', return_value=delivered))
            archive = root / 'archive'
            def remove(args):
                self.assertEqual(args, ['robob-watch', 'remove', cfg['watcher']])
                folder.rename(archive)
            removal = stack.enter_context(mock.patch.object(t, 'run', side_effect=remove))
            status_path = root / 'apps' / placement['slug'] / 'status.json'
            before_status = status_path.read_bytes()
            real_atomic = cards.atomic
            def atomic(path, data):
                if Path(path) == status_path:
                    raise OSError('fixture render write failed')
                return real_atomic(path, data)
            output, errors = io.StringIO(), io.StringIO()
            with redirect_stdout(output), redirect_stderr(errors):
                if fail_render:
                    with mock.patch.object(cards, 'atomic', side_effect=atomic):
                        t.check(cfg)
                        t.check(cfg)
                    removal.assert_not_called()
                    self.assertEqual(status_path.read_bytes(), before_status)
                else:
                    t.check(cfg)
                    removal.assert_not_called()
                    self.assertEqual(cards.read(status_path)['stage'], 'Delivered')
                t.check(cfg)
            fetch.assert_called_once()
            transport.assert_not_called()
            removal.assert_called_once()
            self.assertEqual(cards.read(status_path)['stage'], 'Delivered')
            self.assertIs(t.read(record)['active'], False)
            self.assertEqual(t.read(archive / 'order-tracker-state.json')['status'], 'delivered')
            retained = cards.read(card_path)
            self.assertEqual({k: retained[k] for k in retry_fields}, retry_fields)

    def test_placement_failures_do_not_block_terminal_retirement_after_real_sync(self):
        for failure in ('publish_ack', 'send_ack', 'send_error'):
            with self.subTest(failure=failure):
                self.scenario(failure)

    def test_terminal_render_failure_retries_before_retiring_despite_placement_failure(self):
        self.scenario('publish_ack', fail_render=True)


class CareemLiveTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for obj, name, value in ((t, 'ROOT', root), (t.store, 'ROOT', root),
                                 (t, 'WATCHERS', root / 'watchers')):
            p = mock.patch.object(obj, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(t, 'mail_evidence', return_value=([], ['email_account_unavailable:fixture']))
        p.start()
        self.addCleanup(p.stop)
        from native_orders import OrderError
        p = mock.patch('native_orders.track', side_effect=OrderError('account_capture_required_guest_catalog_only'))
        p.start()
        self.addCleanup(p.stop)
        self.cfg = {'app': 'careem', 'order': '177487014', 'for': 'owner',
                    'placed_at': '2026-11-11T14:48:48+04:00',
                    'registered_at': '2026-11-11T14:48:48+04:00',
                    'eta': '2026-11-11T15:15:00+04:00',
                    'label': 'Starbucks - JLT Drive Thru: Iced Shaken White Mocha',
                    'vertical': 'food', 'single_active_order': True,
                    'watcher': 'order-careem-177487014', 'active': True}
        self.food = json.loads((Path(__file__).parent / 'fixture_careem_food_pushes.json').read_text())
        self.register(self.cfg)

    def register(self, cfg):
        t.write(t.ROOT / 'orders' / (cfg['watcher'] + '.json'), cfg)
        t.write(t.WATCHERS / cfg['watcher'] / 'watcher.json', {'enabled': True})

    def load(self, rows, healthy=True):
        with t.store.connect() as db:
            db.execute('DELETE FROM pushes')
            for i, row in enumerate(rows):
                db.execute('INSERT INTO pushes VALUES (?,?,?,?,?,?)',
                           (str(i), 'careem', row['posted'], row['detected'], row['text'],
                            json.dumps(row.get('ids', []))))
            db.execute('INSERT OR REPLACE INTO health VALUES (?,?,?,?)',
                       ('phone', time.time() if healthy else time.time() - 600, 1, 'ok'))

    def quik(self):
        cfg = dict(self.cfg, vertical='quik', label='Careem Quik: Groceries',
                   placed_at='2026-10-14T17:06:30+04:00', registered_at='2026-10-14T17:06:30+04:00',
                   eta='2026-10-14T17:20:00+04:00')
        literals = [
            ('17:03:54', "Time for a restock! 🗓️ Your kitchen isn't complete without Apple Cinnamon Protein Porridge. Order on Quik to stay on track! ✅", 'unknown'),
            ('17:06:37', 'Great picks! Your order is confirmed, and our team will have it ready ultra-fast ⚡', 'placed'),
            ('17:06:38', 'Careem Quik 17:15-17:20', 'preparing'),
            ('17:08:42', 'Your order’s on its way! Your captain has picked up your order and is on the way  🚗', 'picked up'),
            ('17:08:42', 'Careem Quik 10 minutes', 'out for delivery'),
            ('17:09:18', 'Careem Quik 6 minutes', 'out for delivery'),
            ('17:11:19', 'Careem Quik 5 minutes', 'out for delivery'),
            ('17:11:59', 'Careem Quik 4 minutes', 'out for delivery'),
            ('17:13:19', 'Careem Quik 3 minutes', 'out for delivery'),
            ('17:13:59', 'Careem Quik 2 minutes', 'out for delivery'),
            ('17:14:39', 'Careem Quik 1 minute', 'nearby'),
            ('17:14:46', "Your order's nearby Get ready to collect it from your Captain 🛍️", 'nearby'),
            ('17:17:18', 'Careem Quik Delivered in 10 minutes', 'delivered'),
            ('17:17:18', "Thank you for your order 💚 We hope you're pleased with it and can't wait to deliver your next order!", 'delivered'),
        ]
        rows = [{'posted': t.epoch('2026-10-14T' + at + '+04:00'),
                 'detected': t.epoch('2026-10-14T' + at + '+04:00') + 1,
                 'text': text, 'stage': stage} for at, text, stage in literals]
        return cfg, rows

    def test_every_live_text(self):
        stages = ['preparing'] + ['out for delivery'] * 6 + ['unknown', 'nearby', 'nearby']
        for row, expected in zip(self.food, stages, strict=True):
            with self.subTest(text=row['text']):
                self.assertEqual(t.careem_live_stage(row['text'], 'Starbucks - JLT Drive Thru')[0], expected)
        _, rows = self.quik()
        for row in rows:
            with self.subTest(text=row['text']):
                self.assertEqual(t.careem_live_stage(row['text'], 'Careem Quik')[0], row['stage'])

    def test_foreign_merchant_and_box_wording_never_count(self):
        for text in ('Burger King 5 minutes', 'Burger King Arrives 15:05-15:15',
                     'Burger King Delivered in 10 minutes', 'Burger King Your order is confirmed',
                     'Burger King Your order is cancelled', "Burger King Your order's nearby",
                     'Careem Quik 5 minutes', 'Package will be delivered in 5 minutes Captain driving to Home',
                     'Order delivered! Delivered at 15:00'):
            with self.subTest(text=text):
                self.assertEqual(t.careem_live_stage(text, 'Starbucks - JLT Drive Thru'), ('unknown', None))

    def test_only_matching_order_updates_can_clear_tracking_failure(self):
        at = t.epoch('2026-11-11T15:05:00+04:00')
        for text in ('Burger King 5 minutes', 'Burger King Your order is cancelled',
                     'Your Plus perks don\'t stop at food', '1 minute',
                     'Arrives 15:05-15:15', 'Delivered in 10 minutes'):
            with self.subTest(text=text):
                self.load([{'posted': at - 10, 'detected': at - 9, 'text': text}])
                result = t.fetch(self.cfg, {}, at)
                self.assertEqual(result['status'], 'unknown')
                self.assertNotIn('live_source_ok', result)
                self.assertEqual(result['evidence'], [])
                self.assertEqual(result['eta_source'], 'checkout_supplied')

    def test_matching_cancellation_and_problem_are_preserved(self):
        for text, expected in [('Starbucks - JLT Drive Thru Your order is cancelled', 'cancelled'),
                               ('Your order is canceled', 'cancelled'),
                               ('Starbucks - JLT Drive Thru Delivery failed', 'problem'),
                               ('Your order is delayed', 'problem')]:
            with self.subTest(text=text):
                self.assertEqual(t.careem_live_stage(text, 'Starbucks - JLT Drive Thru'), (expected, None))

    def test_food_fixture_stages_and_eta(self):
        self.load(self.food)
        for at, stage, eta in [('14:50:00', 'preparing', '15:15:00'),
                               ('14:56:00', 'out for delivery', None),
                               ('15:01:00', 'nearby', None),
                               ('15:05:00', 'nearby', '15:05:50.587000')]:
            with self.subTest(at=at):
                result = t.fetch(self.cfg, {}, t.epoch('2026-11-11T' + at + '+04:00'))
                self.assertEqual(result['status'], stage)
                self.assertTrue(result['live_source_ok'])
                self.assertEqual(result['eta_source'], 'careem_notification')
                self.assertEqual(result['evidence'][0]['confidence'], 'careem_single_active')
                self.assertNotIn('candidate', result)
                if eta:
                    self.assertAlmostEqual(t.epoch(result['eta']), t.epoch('2026-11-11T' + eta + '+04:00'), places=2)

    def test_quik_lifecycle_and_terminal_retirement(self):
        cfg, rows = self.quik()
        self.load(rows)
        at = t.epoch('2026-10-14T17:18:00+04:00')
        result = t.fetch(cfg, {}, at)
        self.assertEqual(result['status'], 'delivered')
        self.assertNotEqual(result['eta_source'], 'careem_notification')
        state = {'primed': True, 'status': 'nearby'}
        events = t.transition(result, state, cfg, at)
        self.assertEqual(state['terminal_at'], at)
        self.assertIn({'kind': 'stage_change', 'status': 'delivered'}, events)
        # Both terminal forms independently close the order.
        for row in rows[-2:]:
            self.load([row])
            self.assertEqual(t.fetch(cfg, {}, at)['status'], 'delivered')

    def test_second_active_careem_order_including_box_uses_candidates(self):
        cfg, rows = self.quik()
        self.load(rows)
        for vertical in ('food', 'quik', 'box'):
            other = dict(cfg, order='other', watcher='order-careem-other', vertical=vertical)
            self.register(other)
            self.assertFalse(t.single_allowed(cfg))
            result = t.fetch(cfg, {}, t.epoch('2026-10-14T17:18:00+04:00'))
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(result['candidate']['confidence'], 'app_unassigned_unconfirmed')
            self.assertNotIn('live_source_ok', result)

    def test_overlapping_push_stays_ambiguous_after_other_tracker_retires(self):
        posted = t.epoch('2026-11-11T14:59:00+04:00')
        retired = t.epoch('2026-11-11T15:30:00+04:00')
        for vertical in ('food', 'quik', 'box'):
            for text in ("Thank you for your order, can't wait to deliver your next order!",
                         'Your order is confirmed', 'Your captain has picked up your order',
                         "Your order's nearby", 'Your order is cancelled', 'Your order is delayed',
                         'Starbucks - JLT Drive Thru Arrives 15:05-15:15',
                         'Starbucks - JLT Drive Thru 5 minutes',
                         'Starbucks - JLT Drive Thru Delivered in 10 minutes'):
                with self.subTest(vertical=vertical, text=text):
                    other = dict(self.cfg, order='other', watcher='order-careem-other', vertical=vertical,
                                 placed_at='2026-11-11T14:50:00+04:00')
                    self.register(other)
                    self.load([{'posted': posted, 'detected': posted + 1, 'text': text}])
                    self.assertFalse(t.single_allowed(self.cfg))
                    self.assertEqual(t.fetch(self.cfg, {}, posted + 60)['status'], 'unknown')
                    with mock.patch.object(t, 'run', return_value=''), \
                            mock.patch.object(t.time, 'time', return_value=retired):
                        t.retire(other, t.ROOT / 'orders' / (other['watcher'] + '.json'))
                    saved = t.read(t.ROOT / 'orders' / (other['watcher'] + '.json'))
                    self.assertEqual(saved['retired_at'], t.stamp(retired))
                    (t.WATCHERS / other['watcher'] / 'watcher.json').unlink()
                    self.assertTrue(t.single_allowed(self.cfg))
                    result = t.fetch(self.cfg, {}, retired + 1)
                    state = {'primed': True, 'status': 'unknown'}
                    events = t.transition(result, state, self.cfg, retired + 1)
                    self.assertEqual(result['status'], 'unknown')
                    self.assertEqual(result['evidence'], [])
                    self.assertNotIn('live_source_ok', result)
                    self.assertNotIn('terminal_at', state)
                    self.assertFalse(any(e['kind'] == 'stage_change' for e in events))

    def test_lifetime_boundaries_and_legacy_retired_trackers(self):
        posted = t.epoch('2026-11-11T14:59:00+04:00')
        at = t.epoch('2026-11-11T15:40:00+04:00')
        cases = [
            ('overlap', {}, False),
            ('placed boundary', {'placed_at': t.stamp(posted)}, False),
            ('retired boundary', {'retired_at': t.stamp(posted)}, False),
            ('retired before push', {'retired_at': t.stamp(posted - 1)}, True),
            ('placed after push', {'placed_at': t.stamp(posted + 1)}, True),
            ('legacy overlap', {'retired_at': None}, False),
            ('legacy retired before push', {'retired_at': None, 'mtime': posted - 1}, True),
            ('orphaned active tracker past ETA', {'active': True, 'retired_at': None,
                                                 'eta': t.stamp(posted - 60)}, False),
            ('unknown placement', {'placed_at': None}, False),
            ('invalid placement', {'placed_at': 'invalid'}, False),
            ('invalid retirement', {'retired_at': 'invalid'}, False),
            ('retirement before placement', {'retired_at': '2026-11-11T14:49:00+04:00'}, False),
            ('other app', {'app': 'noon'}, True),
            ('same order', {'order': self.cfg['order']}, True),
        ]
        for name, overrides, allowed in cases:
            with self.subTest(name=name):
                other = dict(self.cfg, order='other', watcher='order-careem-other', active=False,
                             placed_at='2026-11-11T14:50:00+04:00', retired_at=t.stamp(at))
                other.update(overrides)
                mtime = other.pop('mtime', at)
                self.register(other)
                (t.WATCHERS / other['watcher'] / 'watcher.json').unlink()
                path = t.ROOT / 'orders' / (other['watcher'] + '.json')
                os.utime(path, (mtime, mtime))
                self.load([{'posted': posted, 'detected': posted + 1,
                            'text': "Thank you for your order, can't wait to deliver your next order!"}])
                self.assertTrue(t.single_allowed(self.cfg))
                result = t.fetch(self.cfg, {}, at)
                self.assertEqual(result['status'], 'delivered' if allowed else 'unknown')
                self.assertEqual(bool(result.get('live_source_ok')), allowed)

    def test_new_push_after_retirement_can_advance_without_reusing_old_push(self):
        retired = t.epoch('2026-11-11T15:30:00+04:00')
        other = dict(self.cfg, order='other', watcher='order-careem-other', active=False,
                     placed_at='2026-11-11T14:50:00+04:00', retired_at=t.stamp(retired))
        self.register(other)
        old = {'posted': t.epoch('2026-11-11T14:59:00+04:00'), 'detected': retired,
               'text': "Thank you for your order, can't wait to deliver your next order!"}
        new = {'posted': retired + 60, 'detected': retired + 61,
               'text': 'Starbucks - JLT Drive Thru 1 minute'}
        self.load([old, new])
        result = t.fetch(self.cfg, {}, retired + 62)
        state = {'primed': True, 'status': 'unknown', 'delay_sent': True}
        events = t.transition(result, state, self.cfg, retired + 62)
        self.assertEqual(result['status'], 'nearby')
        self.assertEqual(t.epoch(result['eta']), new['posted'] + 60)
        self.assertEqual(events, [{'kind': 'stage_change', 'status': 'nearby'}])
        self.assertNotIn('terminal_at', state)

    def test_non_single_and_box_keep_existing_evidence_path(self):
        at = t.epoch('2026-11-11T15:05:00+04:00')
        for cfg in (dict(self.cfg, single_active_order=False), dict(self.cfg, vertical='box')):
            with mock.patch.object(t.store, 'evidence', return_value=([], [])) as evidence, \
                    mock.patch.object(t.store, 'rows') as rows:
                result = t.fetch(cfg, {}, at)
                evidence.assert_called_once_with(cfg, t.classify, cfg['single_active_order'])
                rows.assert_not_called()
                self.assertEqual(result['status'], 'unknown')

    def test_rows_outside_order_window_cannot_advance_or_close(self):
        placed = t.epoch(self.cfg['placed_at'])
        for text in ('Starbucks - JLT Drive Thru Delivered in 10 minutes',
                     "Thank you for your order, can't wait to deliver your next order!",
                     'Your order is confirmed', 'Starbucks - JLT Drive Thru 5 minutes',
                     'Your order is cancelled'):
            for posted in (placed - 1, t.epoch(self.cfg['eta']) + 3601):
                with self.subTest(text=text, posted=posted):
                    self.load([{'posted': posted, 'detected': posted + 1, 'text': text}])
                    evidence, eta, errors = t.careem_live_evidence(self.cfg, placed + 5 * 3600)
                    self.assertEqual((evidence, eta, errors), ([], None, []))

    def test_late_preparing_does_not_regress_countdown_stage(self):
        rows = self.food[:2] + [dict(self.food[0], posted=self.food[1]['posted'] + 1)]
        self.load(rows)
        result = t.fetch(self.cfg, {}, t.epoch('2026-11-11T15:05:00+04:00'))
        self.assertEqual(result['status'], 'out for delivery')
        self.assertEqual(t.epoch(result['eta']), t.epoch(self.cfg['eta']))

    def test_eta_only_changes_do_not_wake(self):
        cfg, rows = self.quik()
        state = {'primed': True, 'status': 'out for delivery'}
        etas = []
        for row in rows[4:10]:
            self.load([row])
            at = row['posted'] + 2
            result = t.fetch(cfg, {}, at)
            self.assertEqual(t.transition(result, state, cfg, at), [])
            etas.append(result['eta'])
            self.assertEqual(state['known_eta'], result['eta'])
        self.assertGreater(len(set(etas)), 1)
        self.assertEqual(state['tracking_problem_streak'], 0)

    def test_stale_journal_preserves_evidence_but_not_live_health(self):
        self.load(self.food, healthy=False)
        result = t.fetch(self.cfg, {}, t.epoch('2026-11-11T15:05:00+04:00'))
        self.assertEqual(result['status'], 'nearby')
        self.assertNotIn('live_source_ok', result)
        self.assertIn('notification_collector_stale', result['errors'])


if __name__ == '__main__':
    unittest.main()
