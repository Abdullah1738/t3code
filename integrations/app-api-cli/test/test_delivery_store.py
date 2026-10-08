import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import delivery_store as s
import order_tracker as t


class DeliveryTests(unittest.TestCase):
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
            self.assertEqual(sum(c.args[0][1] == 'message' for c in body.call_args_list), 1)
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
