"""Offline problem alerts: the only send entry point is always mocked."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import order_tracker as t


class ProblemNoticeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cfg = {'app': 'noon', 'order': 'N123', 'for': 'owner', 'watcher': 'order-noon-n123',
                    'registered_at': t.stamp(10000), 'total': 'AED 12,799.00', 'eta': t.stamp(50000)}
        self.folder = self.root / self.cfg['watcher']
        self.folder.mkdir()
        self.path = self.folder / 'order-tracker-state.json'
        self.state = {'primed': True, 'status': 'placed'}
        self.result = {'status': 'unknown', 'errors': ['native_status_unknown']}
        self.clock = 10060
        self.sends = []
        self.acks = []
        patches = [mock.patch.object(t, 'WATCHERS', self.root),
                   mock.patch.dict(os.environ, WATCH_DIR=str(self.folder)),
                   mock.patch.object(t, 'fetch', side_effect=lambda *_: dict(self.result)),
                   mock.patch.object(t.time, 'time', side_effect=lambda: self.clock),
                   mock.patch.object(t.delivery_cards, 'safe_sync', return_value={}),
                   mock.patch.object(t.subprocess, 'run', side_effect=self.send)]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    def send(self, args, **kwargs):
        self.sends.append(args)
        if self.acks:
            ack = self.acks.pop(0)
            if isinstance(ack, Exception):
                raise ack
            return ack
        return subprocess.CompletedProcess(args, 0, json.dumps({'id': 'send:fixture', 'created': True}), '')

    def check(self, pending_only=False):
        t.write(self.path, self.state)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            t._check(self.cfg, pending_only=True) if pending_only else t.check(self.cfg)
        if not pending_only:
            with mock.patch.dict(os.environ, WATCH_MAIN_CHECKED='1'):
                t._check(self.cfg, pending_only=True)
        self.state = t.read(self.path)
        self.clock += 60
        return output.getvalue()

    def test_large_order_bypasses_grace_eta_quiet_and_daily_cap_once(self):
        self.cfg['eta'] = t.stamp(self.clock + 10 * 86400)
        self.state.update(tracking_problem_last_at=self.clock, parts_delivered_seen=['shipment:1'])
        for _ in range(3):
            self.assertEqual(self.check(), '')
        self.assertEqual(len(self.sends), 1)
        self.clock += 3 * 86400
        self.assertEqual(self.check(), '')
        self.assertEqual(len(self.sends), 1)
        self.assertEqual(self.sends[0][:7], [t.BUN, t.PROBLEM_CLI, 'notify', '--source', 'order-watch', '--severity', 'attention'])
        self.assertNotIn('--session', self.sends[0])
        self.assertIn('AED 12,799.00', self.sends[0][-1])
        self.assertEqual(next(iter(self.state['problem_notices'].values()))['status'], 'sent')

    def test_threshold_and_total_input_forms(self):
        cases = [('AED 500', True), ('500.00 AED', True), ('aed 1,000.50', True),
                 ('500', True), (500, True), ('499.99', False), ('AED 0', False),
                 ('USD 500', False), ('AED 5,00', False), ('NaN', False), ('', False), (True, False)]
        for total, should_ping in cases:
            with self.subTest(total=total):
                state = {'primed': True}
                t.queue_problem_notices(dict(self.cfg, total=total), self.result, state, [])
                self.assertEqual(bool(state.get('problem_notices')), should_ping)
        for cfg, result in [(dict(self.cfg, total=None, card_meta={'total': '500', 'currency': 'AED'}), self.result),
                            (dict(self.cfg, total=None), dict(self.result, total=500)),
                            (dict(self.cfg, total=None, card_meta={'total': '900', 'currency': 'USD'}), self.result)]:
            state = {'primed': True}
            t.queue_problem_notices(cfg, result, state, [])
            self.assertEqual(bool(state.get('problem_notices')), cfg.get('card_meta', {}).get('currency') != 'USD')

    def test_known_total_survives_later_source_outages(self):
        self.cfg.pop('total')
        self.result = {'status': 'preparing', 'errors': [], 'total': 500}
        self.check()
        self.result = {'status': 'unknown', 'errors': ['native_status_unknown']}
        self.check()
        self.assertEqual(len(self.sends), 1)

    def test_amount_only_registration_input_class(self):
        cases = [('600.00', 'AED', True), ('500.00', 'AED', True),
                 ('499.99', 'AED', False), ('600.00', 'USD', False),
                 ('NaN', 'AED', False), ('-600', 'AED', False),
                 ('5,00', 'AED', False), (True, 'AED', False)]
        for amount, currency, should_ping in cases:
            with self.subTest(amount=amount, currency=currency):
                cfg = dict(self.cfg, total=None, amount=amount, currency=currency)
                state = {'primed': True}
                t.queue_problem_notices(cfg, self.result, state, [])
                self.assertEqual(bool(state.get('problem_notices')), should_ping)
        cfg = dict(self.cfg, total='AED 400', amount='600.00', currency='AED')
        self.assertEqual(t.order_total_aed(cfg, {}, {}), 400)

    def test_amount_only_pending_check_sends_large_order_problem_once(self):
        self.cfg.pop('total')
        self.cfg.update(amount='600.00', currency='AED', card_last4='2342')
        self.assertEqual(self.check(pending_only=True), '')
        self.assertEqual(self.check(pending_only=True), '')
        self.assertEqual(len(self.sends), 1)
        self.assertIn('AED 600.00', self.sends[0][-1])

    def test_first_scheduled_problem_survives_missing_or_unprimed_state_then_recovery(self):
        self.cfg['total'] = 'AED 500'
        for initial in [None, {'primed': False}]:
            with self.subTest(initial=initial):
                self.path.unlink(missing_ok=True)
                if initial is not None:
                    t.write(self.path, initial)
                self.sends.clear()
                self.result = {'status': 'unknown', 'errors': ['native_auth_expired']}
                with contextlib.redirect_stdout(io.StringIO()):
                    t.check(self.cfg)
                saved = t.read(self.path)
                self.assertEqual(len(saved.get('problem_notices', {})), 1)
                key = next(iter(saved['problem_notices']))
                self.assertEqual(saved['problem_notices'][key]['status'], 'pending')
                self.assertEqual(self.sends, [])
                self.state = saved
                self.result = {'status': 'preparing', 'errors': []}
                self.check()
                self.check()
                self.assertEqual(len(self.sends), 1)
                self.assertEqual(self.sends[0][self.sends[0].index('--key') + 1], key)

    def test_prime_retains_problem_without_sending_before_healthy_poll(self):
        cases = [('source', {'status': 'unknown', 'errors': ['native_auth_expired']}),
                 ('quiet_source', {'status': 'unknown', 'errors': ['native_status_unknown']}),
                 ('problem', {'status': 'preparing', 'errors': [], 'problem': {'stage': 'delivery_failed'}}),
                 ('problem_status', {'status': 'failed', 'errors': []}),
                 ('overdue', {'status': 'preparing', 'errors': []}),
                 ('card_link', {'status': 'preparing', 'errors': []})]
        for total in ['AED 500', 'AED 499.99']:
            for name, result in cases:
                with self.subTest(total=total, problem=name):
                    self.cfg['total'] = total
                    self.cfg['eta'] = t.stamp(self.clock - 600 if name == 'overdue' else self.clock + 3600)
                    self.state, self.result = {}, result
                    self.sends.clear()
                    card = {'link_health': 'needs_repair'} if name == 'card_link' else {}
                    with mock.patch.dict(os.environ, WATCH_RUN='prime-fixture'), \
                            mock.patch.object(t.delivery_cards, 'safe_sync', return_value=card):
                        self.check()
                    self.assertEqual(self.sends, [])
                    queued = self.state.get('problem_notices', {})
                    expected = int(total == 'AED 500')
                    self.assertEqual(len(queued), expected)
                    retained = json.loads(json.dumps(queued))
                    self.result = {'status': 'preparing', 'errors': []}
                    self.check()
                    self.check()
                    self.assertEqual(len(self.sends), expected)
                    for key, notice in retained.items():
                        self.assertEqual(self.state['problem_notices'][key]['text'], notice['text'])
                        self.assertEqual(self.state['problem_notices'][key]['status'], 'sent')

    def test_first_scheduled_overdue_problem_survives_baseline_then_delivery(self):
        self.cfg.update(total='AED 500', eta=t.stamp(self.clock - 600))
        self.state = {}
        self.result = {'status': 'preparing', 'errors': []}
        with contextlib.redirect_stdout(io.StringIO()):
            t.check(self.cfg)
        self.state = t.read(self.path)
        self.assertEqual(len(self.state.get('problem_notices', {})), 1)
        self.assertEqual(self.sends, [])
        self.result = {'status': 'delivered', 'errors': [], 'whole_order_complete': True}
        self.check()
        self.assertEqual(len(self.sends), 1)
        self.assertIn('ETA passed', self.sends[0][-1])

    def test_problem_only_poll_retains_problem_before_baseline(self):
        self.state = {'primed': False}
        self.result = {'status': 'unknown', 'errors': ['native_auth_expired']}
        self.assertEqual(self.check(pending_only=True), '')
        self.assertFalse(self.state['primed'])
        self.assertEqual(len(self.sends), 1)
        self.result = {'status': 'preparing', 'errors': []}
        self.check()
        self.assertEqual(len(self.sends), 1)

    def test_error_families_ignore_accounts_order_and_recovery(self):
        self.result['errors'] = ['email_account_unavailable:gmail', 'native_status_unknown']
        self.check()
        self.check()
        self.result = {'status': 'preparing', 'errors': []}
        self.check()
        self.result = {'status': 'unknown', 'errors': ['native_status_unknown', 'email_account_unavailable:outlook']}
        self.check()
        self.assertEqual(len(self.sends), 2)
        self.assertEqual(len({args[args.index('--key') + 1] for args in self.sends}), 2)
        self.result['errors'] = ['native_auth_expired']
        self.check()
        self.assertEqual(len(self.sends), 3)

    def test_problem_stages_and_card_link_use_the_same_durable_path(self):
        self.state['status'] = 'preparing'
        self.result = {'status': 'preparing', 'errors': [], 'problem': {'stage': 'delivery_failed'}}
        self.assertEqual(self.check(), '')
        self.check()
        self.assertEqual(len(self.sends), 1)
        self.result = {'status': 'failed', 'errors': []}
        self.check()
        self.check()
        self.assertEqual(len(self.sends), 2)
        with mock.patch.object(t.delivery_cards, 'safe_sync', return_value={'link_health': 'needs_repair'}):
            self.check()
            self.check()
        self.assertEqual(len(self.sends), 3)

    def test_retry_keeps_key_and_text_even_after_recovery(self):
        for outcome in [subprocess.TimeoutExpired('send', 20), OSError('unavailable'),
                        subprocess.CompletedProcess([], 1, '', ''),
                        subprocess.CompletedProcess([], 0, '{}', '')]:
            with self.subTest(outcome=outcome):
                self.state = {'primed': True, 'status': 'placed'}
                self.result = {'status': 'unknown', 'errors': ['native_status_unknown']}
                self.sends.clear()
                self.acks = [outcome]
                self.check()
                self.result = {'status': 'preparing', 'errors': []}
                self.check()
                self.check()
                self.assertEqual(len(self.sends), 2)
                self.assertEqual(self.sends[0], self.sends[1])

    def test_small_orders_keep_suppression_and_existing_wake(self):
        self.cfg['total'] = 'AED 499.99'
        self.assertEqual(self.check(), '')
        self.result['errors'] = ['native_auth_expired']
        self.clock = 140000
        self.assertIn('tracking_problem', self.check())
        self.assertEqual(self.sends, [])

    def test_no_prime_or_scratch_sends_and_moni_problems_go_only_to_owner(self):
        self.state = {}
        with mock.patch.dict(os.environ, WATCH_RUN='prime-fixture'):
            self.assertEqual(self.check(), '')
        self.assertEqual(self.sends, [])
        self.cfg.update({'for': 'moni', 'chat': 'group-fixture'})
        with mock.patch.object(t, 'WATCHERS', self.root / 'elsewhere'):
            self.check()
        self.assertEqual(self.sends, [])
        with mock.patch.dict(os.environ, WATCH_RUN='prime-fixture'):
            self.check()
        self.assertEqual(self.sends, [])
        self.check()
        self.assertEqual(len(self.sends), 1)
        self.assertEqual(self.sends[0][1], t.PROBLEM_CLI)

    def test_terminal_order_retries_pending_notice_before_retirement(self):
        self.acks = [OSError('unavailable'), OSError('unavailable')]
        self.check()
        self.state.update(status='delivered', last_result={'status': 'delivered', 'errors': []})
        with mock.patch.object(t, 'retire_terminal') as retire:
            self.check()
            retire.assert_not_called()
            self.check()
            retire.assert_not_called()
            self.check()
            retire.assert_called_once()

    def test_owner_chat_rotation_does_not_block_the_alert_queue(self):
        with mock.patch.object(t, 'bridge_route', return_value=None):
            self.check()
        self.assertEqual(len(self.sends), 1)
        self.check()
        self.assertEqual(len(self.sends), 1)

    def test_overdue_arrival_only_orders_alert_the_owner_once(self):
        for chat in ['owner', 'moni', 'group-fixture']:
            with self.subTest(chat=chat):
                self.state = {'primed': True, 'status': 'preparing'}
                self.sends.clear()
                self.cfg.update(chat=chat, eta=t.stamp(self.clock - 600))
                self.result = {'status': 'preparing', 'errors': []}
                self.check()
                self.check()
                self.assertEqual(len(self.sends), 1)
                self.assertEqual(self.sends[0][1], t.PROBLEM_CLI)

    def test_pending_check_alerts_without_consuming_ordinary_stages(self):
        self.state['last_result'] = {'status': 'placed'}
        self.result = {'status': 'preparing', 'errors': ['native_status_unknown']}
        self.assertEqual(self.check(pending_only=True), '')
        self.assertEqual(len(self.sends), 1)
        self.assertEqual(self.state['status'], 'placed')
        self.assertEqual(self.state['last_result'], {'status': 'placed'})
        self.assertIn('stage_change', self.check())
        self.assertEqual(len(self.sends), 1)

    def test_regular_check_records_ordinary_output_without_waiting_for_problem_send(self):
        self.result = {'status': 'preparing', 'errors': ['native_auth_expired']}
        t.write(self.path, self.state)
        output = io.StringIO()
        with mock.patch.object(t.subprocess, 'run', side_effect=KeyboardInterrupt), contextlib.redirect_stdout(output):
            t.check(self.cfg)
        self.assertIn('stage_change', output.getvalue())
        saved = t.read(self.path)
        self.assertEqual(saved['status'], 'preparing')
        self.assertEqual(next(iter(saved['problem_notices'].values()))['status'], 'pending')
        with mock.patch.dict(os.environ, WATCH_MAIN_CHECKED='1'):
            t._check(self.cfg, pending_only=True)
        self.assertEqual(len(self.sends), 1)

    def test_small_orders_never_poll_from_pending_check(self):
        self.cfg['total'] = 'AED 499.99'
        with mock.patch.object(t, 'fetch') as fetch:
            self.assertEqual(self.check(pending_only=True), '')
            fetch.assert_not_called()
        self.assertEqual(self.sends, [])

    def test_pending_check_preserves_partial_delivery_and_skips_resolved_eta(self):
        for app, complete, expected in [('noon', False, 1), ('noon', True, 0), ('noon', None, 0),
                                         ('amazon', False, 1), ('amazon', True, 0), ('amazon', None, 1)]:
            with self.subTest(app=app, whole_order_complete=complete):
                self.cfg['app'] = app
                self.state = {'primed': True, 'status': 'placed', 'delay_sent': True}
                self.sends.clear()
                self.result = {'status': 'delivered', 'errors': []}
                if complete is not None:
                    self.result['whole_order_complete'] = complete
                self.check(pending_only=True)
                self.assertEqual(len(self.sends), expected)
                self.assertEqual(self.state['status'], 'placed')

    def test_installer_configures_existing_watchers_without_changing_quiet_or_pending(self):
        watchpath = self.folder / 'watcher.json'
        definition = {'id': self.cfg['watcher'], 'quiet': {'start': 23, 'end': 8, 'time_zone': 'Asia/Dubai'}}
        t.write(watchpath, definition)
        orders = self.root / 'orders'
        t.write(orders / (self.cfg['watcher'] + '.json'), {**self.cfg, 'active': True})
        with mock.patch.object(t, 'ROOT', self.root):
            self.assertEqual(t.main(['configure-problem-checks']), 0)
        saved = t.read(watchpath)
        self.assertEqual(saved['quiet'], definition['quiet'])
        self.assertIn('check-pending --app noon --order N123', saved['pending_check'])
        self.assertEqual(self.sends, [])


if __name__ == '__main__':
    unittest.main()
