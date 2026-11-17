from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import delivery_store as s
from phone_hold_fixture import FakePhTests
import order_tracker as t


class DeliveryTests(unittest.TestCase):
    def test_rows_are_bounded_sorted_and_read_only(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'ROOT', Path(d)):
            self.assertEqual(s.rows('careem', 10, 30), ([], ['notification_collector_stale']))
            self.assertFalse((s.ROOT / 'delivery.sqlite').exists())
            with s.connect() as db:
                db.execute('INSERT INTO health VALUES (?,?,?,?)', ('phone', time.time(), 1, 'ok'))
                for key, app, posted in [('one', 'careem', 30), ('two', 'careem', 10),
                                         ('three', 'careem', 31), ('four', 'noon', 20)]:
                    db.execute('INSERT INTO pushes VALUES (?,?,?,?,?,?)', (key, app, posted, posted+1, key, '[]'))
            with patch.object(s, 'connect', side_effect=AssertionError('read must not initialize journal')):
                rows, errors = s.rows('careem', 10, 30)
            self.assertEqual(errors, [])
            self.assertEqual(rows, [{'posted': 10, 'detected': 11, 'text': 'two'},
                                    {'posted': 30, 'detected': 31, 'text': 'one'}])
            with s.connect() as db:
                db.execute('UPDATE health SET ok=0, detail="priority_hold_stale"')
            self.assertEqual(s.rows('careem', 10, 30)[1], ['notifications_priority_hold_stale'])

    def test_real_talabat_wording_and_journal_survives_clear(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'ROOT', Path(d)):
            now = time.time()
            text = 'Your rider’s just around the corner! Give them a moment to drop off your order'
            dump = f'NotificationRecord(x: pkg=com.talabat id=1)\nwhen={int(now*1000)}\nandroid.text=SpannableString ({text})'
            with s.connect() as db:
                db.executemany('INSERT OR IGNORE INTO pushes VALUES (?,?,?,?,?,?)', s.parse_pushes(dump))
                db.executemany('INSERT OR IGNORE INTO pushes VALUES (?,?,?,?,?,?)', s.parse_pushes(dump))
                self.assertEqual(db.execute('SELECT count(*) FROM pushes').fetchone()[0], 1)
            cfg = {'app': 'talabat', 'order': '3941245276', 'placed_at': t.stamp(now-60)}
            rows, _ = s.evidence(cfg, t.classify, True)
            self.assertEqual(rows[0]['stage'], 'nearby')
            self.assertNotEqual(rows[0]['confidence'], 'exact_order')
            self.assertEqual(s.evidence(cfg, t.classify, False)[0][0]['confidence'], 'app_unassigned_unconfirmed')

    def test_environment_inspector_not_inherited(self):
        with patch.dict(os.environ, {'BUN_INSPECT': 'bad', 'BUN_INSPECT_CONNECT_TO': 'bad'}):
            self.assertFalse(any(k.startswith('BUN_INSPECT') for k in s.clean_env()))

    def test_reconciliation_preserves_first_detection(self):
        with tempfile.TemporaryDirectory() as d, patch.object(s, 'ROOT', Path(d)):
            cfg = {'app': 'talabat', 'order': '123', 'placed_at': '2026-10-07T12:55:00+04:00'}
            s.reconcile(cfg, detected='2026-10-07T13:26:00+04:00', source='push')
            row = s.reconcile(cfg, detected='2026-10-07T14:00:00+04:00', reported='2026-10-07T13:24:00+04:00')
            self.assertEqual(row['gap_seconds'], 120)

    def test_receipts_do_not_exhaust_delivery_read_budget(self):
        import json
        from types import SimpleNamespace
        hits = [{'subject': 'Your receipt', 'from': 'noreply@amazon.ae'},
                {'subject': 'Your return', 'from': 'return@amazon.ae'},
                {'subject': 'Delivered: "Cat Ball"', 'from': 'order-update@amazon.ae',
                 'account': 'gmail', 'folder': 'Inbox', 'uid': 1}]
        def response(args, timeout):
            return '{"envelopes":[]}' if args[1] == 'envelope' else 'Order # 408-5401303-9857106'
        with patch.object(t.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps({'hits': hits}))), patch.object(t, 'run', side_effect=response) as body:
            rows, errors = t.mail_evidence({'app':'amazon', 'order':'408-5401303-9857106', 'placed_at':'2026-10-05T21:15:00+04:00'})
            self.assertEqual(rows[0]['stage'], 'delivered')
            self.assertEqual(sum(c.args[0][1] in ('message', 'read') for c in body.call_args_list), 1)
            self.assertEqual(body.call_args_list[-1].args[0][:3], ['mailsearch', 'read', 'gmail'])
            self.assertEqual(errors, [])
            self.assertIn('after:2026/10/04', t.subprocess.run.call_args.args[0][-1])

    def test_marketing_is_not_delivery(self):
        self.assertEqual(t.classify('Halloween delivered fast Costumes, décor & treats delivered to your door in no time'), 'unknown')

    def test_amazon_second_shipment_wakes_without_closing_order(self):
        cfg = {'app': 'amazon', 'registered_at': t.stamp(), 'eta': None}
        state = {'primed': True}
        result = {'status': 'delivered', 'errors': [], 'evidence': [{'mail_key':'one'}]}
        self.assertEqual(t.transition(result, state, cfg, time.time())[0]['kind'], 'shipment_delivered')
        self.assertNotEqual(state.get('status'), 'delivered')
        self.assertEqual(t.transition(result, state, cfg, time.time()), [])
        result['evidence'][0]['mail_key'] = 'two'
        self.assertEqual(t.transition(result, state, cfg, time.time())[0]['kind'], 'shipment_delivered')


class DeliveryHoldTests(FakePhTests):
    def setUp(self):
        super().setUp()
        self.now = 1800000000
        for p in (patch.object(s, 'ROOT', self.folder / 'store'),
                  patch.object(s.time, 'time', return_value=self.now),
                  patch.dict(os.environ, {'TOOLLOG_ROOT': str(self.folder / 'logs'),
                                          'ROBOB_TOOL_LOG_DIR': str(self.folder / 'logs')})):
            p.start()
            self.addCleanup(p.stop)
        self.adb_result = SimpleNamespace(returncode=0, stdout='Notification list')
        real_run = subprocess.run

        def run(args, **kwargs):
            if args[0] == 'adb':
                return self.adb(*args, **kwargs)
            return real_run(args, **kwargs)

        self.adb = Mock(return_value=self.adb_result)
        p = patch.object(s.subprocess, 'run', side_effect=run)
        p.start()
        self.addCleanup(p.stop)

    def health(self):
        with s.connect() as db:
            return dict(db.execute('SELECT * FROM health WHERE source="phone"').fetchone())

    def logs(self):
        return [json.loads(line) for path in (self.folder / 'logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]

    def test_absent_hold_collects_and_retains_notification(self):
        self.assertIsNone(s.hold_state())
        self.adb_result.stdout = (
            'NotificationRecord(x: pkg=com.amazon.mShop.android.shopping id=1)\n'
            'when={}\nandroid.text=String (Order 408-2932248-9569157 delivered)'.format(self.now * 1000))
        s.collect()
        self.adb.assert_called_once()
        self.assertEqual((self.health()['ok'], self.health()['detail']), (1, 'ok'))
        self.assertEqual(s.rows('amazon', self.now - 60, self.now)[0][0]['posted'], self.now)
        s.health_check()
        self.assertEqual(self.logs(), [])

    def test_absent_hold_adb_failure_still_fails_health(self):
        self.adb_result.returncode = 1
        s.collect()
        with self.assertRaisesRegex(RuntimeError, 'notification collection unavailable: RuntimeError'):
            s.health_check()

    def test_present_hold_defers_silently_and_logs_safe_metadata(self):
        self.respond(present=True, age_s=2400.5, stale_in_s=1200,
                     holder_alive=True, agent_comm='Claude')
        s.collect()
        self.assertEqual(s.hold_state(), {'state': 'live', 'age_s': 2400.5,
                         'stale_in_s': 1200, 'holder_alive': True, 'agent_comm': 'Claude', 'error': None})
        self.assertEqual((self.health()['ok'], self.health()['detail']), (1, 'deferred_priority_hold'))
        output = io.StringIO()
        with redirect_stdout(output):
            s.health_check()
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(s.rows('amazon', 0, self.now)[1], [])
        self.assertEqual([(r['name'], r['props']) for r in self.logs()], [
            ('collector.hold_seen', {'age_s': 2400.5, 'holder_alive': True, 'agent_comm': 'Claude'})])
        self.adb.assert_not_called()

    def test_cleared_transition_logs_once_and_refreshes_health(self):
        self.respond(present=True, age_s=20, holder_alive=True, agent_comm='Codex')
        s.collect()
        with patch.object(s.time, 'time', return_value=self.now + 15):
            s.collect()
        self.assertEqual(self.health()['checked'], self.now + 15)
        self.adb.assert_not_called()
        self.respond(present=False)
        s.collect()
        s.collect()
        self.assertEqual(self.adb.call_count, 2)
        self.assertEqual([r['name'] for r in self.logs()], [
            'collector.hold_seen', 'collector.hold_cleared'])
        self.assertEqual(self.logs()[-1]['props'],
                         {'age_s': None, 'holder_alive': None, 'agent_comm': None})
        self.assertEqual(self.health()['detail'], 'ok')

    def test_status_failure_defers_and_logs_error(self):
        self.configure(exit_code=1)
        s.collect()
        self.assertEqual(self.health()['detail'], 'deferred_priority_hold')
        self.assertEqual(self.health()['ok'], 1)
        self.assertTrue(s.hold_state()['error'])
        output = io.StringIO()
        with redirect_stdout(output):
            s.health_check()
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(self.logs()[0]['props']['error'], 'ph exited 1')
        self.adb.assert_not_called()

    def test_old_stale_row_with_absent_hold_uses_normal_ok_check(self):
        for ok in (0, 1):
            with self.subTest(ok=ok):
                with s.connect() as db:
                    db.execute('INSERT OR REPLACE INTO health VALUES (?,?,?,?)',
                               ('phone', self.now, ok, 'priority_hold_stale'))
                if ok:
                    s.health_check()
                else:
                    with self.assertRaisesRegex(RuntimeError,
                            '^notification collection unavailable: priority_hold_stale$'):
                        s.health_check()
        self.adb.assert_not_called()

    def test_health_rechecks_deferred_row_after_hold_clears(self):
        self.respond(present=True)
        s.collect()
        self.respond(present=False)
        with s.connect() as db:
            db.execute('UPDATE health SET ok=0')
        with self.assertRaisesRegex(RuntimeError, 'notification collection unavailable: deferred_priority_hold'):
            s.health_check()
        self.adb.assert_not_called()

    def test_old_stale_row_with_present_hold_is_healthy_and_migrates(self):
        self.respond(present=True)
        with s.connect() as db:
            db.execute('INSERT INTO health VALUES (?,?,?,?)',
                       ('phone', self.now, 0, 'priority_hold_stale'))
        s.health_check()
        s.collect()
        self.assertEqual((self.health()['ok'], self.health()['detail']), (1, 'deferred_priority_hold'))
        self.assertEqual([r['name'] for r in self.logs()], ['collector.hold_seen'])
        self.adb.assert_not_called()

    def test_existing_alert_record_is_untouched(self):
        self.respond(present=True)
        s.collect()
        path = s.ROOT / 'hold-alerts.json'
        original = b'["legacy-alert"]'
        path.write_bytes(original)
        s.health_check()
        self.respond(present=False)
        s.collect()
        s.health_check()
        self.assertEqual(path.read_bytes(), original)

    def test_deferred_row_still_expires_if_collector_stops(self):
        self.respond(present=True)
        s.collect()
        with patch.object(s.time, 'time', return_value=self.now + 121):
            with self.assertRaisesRegex(RuntimeError, 'notification collector is stale'):
                s.health_check()
        self.adb.assert_not_called()
