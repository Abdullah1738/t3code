import contextlib
import datetime as dt
from email.message import EmailMessage
import io
import json
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import order_tracker as tracker
import order_receipts as receipt


class OrderProof(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for target, value in [('ROOT', self.root / 'tracker'), ('WATCHERS', self.root / 'watchers')]:
            p = patch.object(tracker, target, value)
            p.start()
            self.addCleanup(p.stop)
        self.now = dt.datetime(2026, 11, 13, 12, tzinfo=dt.timezone.utc).timestamp()
        self.cfg = {'app': 'acme', 'merchant': 'Acme', 'order': 'ORD-123', 'watcher': 'order-acme-ord-123',
                    'mode': 'email_receipt', 'for': 'moni', 'chat': 'moni', 'active': True,
                    'placed_at': tracker.stamp(self.now - 3600), 'registered_at': tracker.stamp(self.now - 3600),
                    'placed_items': [{'name': 'Black sesame', 'price': '7.50'}, {'name': 'Fresh mint', 'price': '1.00'}]}

    def mail(self, subject='Order confirmation ORD-123', body='Your order is confirmed.', sender='sales@acme.test'):
        msg = EmailMessage()
        msg['From'], msg['Subject'] = sender, subject
        msg['Date'] = dt.datetime.fromtimestamp(self.now - 30, dt.timezone.utc)
        msg.set_content(body)
        return msg.as_bytes()

    def test_receipt_projection_has_only_stated_eta_and_tracking(self):
        raw = self.mail(body='ORD-123\nEstimated delivery: 14–15 November\nTracking: https://acme.test/track/123')
        parsed = receipt.parse(raw, self.cfg, self.now)
        self.assertEqual(parsed['eta_text'], '14–15 November')
        self.assertEqual(parsed['tracking_links'], ['https://acme.test/track/123'])
        self.assertIsNone(receipt.parse(self.mail(), self.cfg, self.now)['eta_text'])
        self.assertIsNone(receipt.parse(self.mail(sender='Acme <attacker@unrelated.test>'), self.cfg, self.now))
        self.assertIsNone(receipt.parse(self.mail(subject='Order confirmation ORD-1234'), self.cfg, self.now))

    def test_subject_does_not_read_progress_timeline_as_delivered(self):
        event = receipt.parse(self.mail(body='ORD-123\nConfirmed\nShipped\nDelivered'), self.cfg, self.now)
        self.assertEqual(event['status'], 'placed')

    def test_order_id_boundaries(self):
        for value, matches in [('ORD-123', True), ('#ORD-123.', True), ('ORD-1234', False),
                               ('ORD-123-4', False), ('ORD-123_4', False), ('XORD-123', False),
                               ('X-ORD-123', False), ('X_ORD-123', False)]:
            with self.subTest(value=value):
                parsed = receipt.parse(self.mail(subject='Your order ' + value + ' delivered'), self.cfg, self.now)
                self.assertEqual(parsed is not None, matches)

    def test_partial_and_negative_terminal_subjects(self):
        subjects = ['One item from your order ORD-123 delivered', 'Shipment for order ORD-123 delivered',
                    'Your order ORD-123 partially delivered', 'Your order ORD-123 could not be cancelled',
                    'Two items from your order ORD-123 delivered', 'Packages from order ORD-123 delivered',
                    "Your order ORD-123 can't be cancelled", "Your order ORD-123 won't be delivered",
                    "Your order ORD-123 hasn't been delivered", 'Cancellation requested: ORD-123',
                    'Unable to cancel your order ORD-123', 'Your order ORD-123 will be cancelled',
                    'Your order ORD-123 is due to be delivered tomorrow',
                    'Has your order ORD-123 been delivered?', 'Was your order ORD-123 cancelled?',
                    'Did your order ORD-123 get delivered', 'Your order ORD-123 may be delivered tomorrow', 'Your order almost delivered',
                    'Your order soon delivered']
        for subject in subjects:
            with self.subTest(subject=subject):
                result = receipt.parse(self.mail(subject, body='ORD-123'), self.cfg, self.now)
                self.assertNotIn(result['status'], tracker.TERMINAL)

    def test_html_tracking_link_encoding_class(self):
        for encoding in ('7bit', 'quoted-printable', 'base64'):
            with self.subTest(encoding=encoding):
                msg = EmailMessage()
                msg['From'], msg['Subject'] = 'sales@acme.test', 'Your order ORD-123 shipped'
                msg['Date'] = dt.datetime.fromtimestamp(self.now - 30, dt.timezone.utc)
                msg.set_content('<p>ORD-123</p><a href="https://acme.test/track?id=123&amp;part=1">Track your order</a>',
                                subtype='html', cte=encoding)
                self.assertEqual(receipt.parse(msg.as_bytes(), self.cfg, self.now)['tracking_links'],
                                 ['https://acme.test/track?id=123&part=1'])

    def test_delivered_subject_input_class(self):
        for subject, expected in [('Your order ORD-123 delivered', 'delivered'),
                                  ('Your order ORD-123 has been delivered', 'delivered'),
                                  ('Your order has been delivered!', 'delivered'),
                                  ('Delivered: your order ORD-123', 'delivered'),
                                  ('Your order ORD-123 was cancelled', 'cancelled'),
                                  ('Your order ORD-123 will be delivered tomorrow', 'unknown'),
                                  ('Your order ORD-123 is not delivered', 'unknown'),
                                  ('Your order ORD-123 expected to be delivered', 'unknown')]:
            with self.subTest(subject=subject):
                self.assertEqual(receipt.parse(self.mail(subject, body='ORD-123'), self.cfg, self.now)['status'], expected)

    def test_fixture_scan_reads_archive_and_delivered_subject(self):
        messages = {1: self.mail(), 2: self.mail('Your order ORD-123 shipped', 'Tracking: https://acme.test/track/123'),
                    3: self.mail('Your order ORD-123 delivered')}
        calls = []
        def run(cmd, **kw):
            calls.append(cmd)
            output = (b'\n'.join(json.dumps({'id': i, 'source': 'email'}).encode() for i in messages)
                      if cmd[1] == 'search' else messages[int(cmd[2])])
            return type('Done', (), {'stdout': output, 'returncode': 0})()
        with patch.object(receipt.subprocess, 'run', run):
            result = tracker.fetch(self.cfg, {}, self.now)
        self.assertEqual(result['status'], 'delivered')
        self.assertNotIn('eta_text', result)
        self.assertIn('--raw', calls[1])
        self.assertEqual(result['tracking_links'], ['https://acme.test/track/123'])

    def test_item_drops_once_per_item_even_on_prime_and_restart(self):
        cfg = dict(self.cfg, app='noon')
        state = {}
        result = {'status': 'placed', 'items_complete': True,
                  'items': [{'name': 'Black sesame', 'price': 0}]}
        events = tracker.transition(dict(result), state, cfg, self.now)
        self.assertEqual([e['kind'] for e in events], ['item_dropped', 'item_dropped'])
        self.assertEqual({e['chat'] for e in events}, {'moni'})
        self.assertIn('AED 7.50', events[0]['message'])
        self.assertEqual(len({e['notice_key'] for e in events}), 2)
        state = json.loads(json.dumps(state))
        again = tracker.transition(dict(result), state, cfg, self.now + 300)
        self.assertEqual([e for e in again if e['kind'] == 'item_dropped'], [])

    def test_registration_prime_holds_drops_for_first_real_wake(self):
        folder = self.root / 'check'
        folder.mkdir()
        result = {'status': 'placed', 'items_complete': True, 'items': []}
        with patch.dict('os.environ', {'WATCH_DIR': str(folder), 'WATCH_RUN': 'prime-fixture'}), \
                patch.object(tracker, 'fetch', return_value=dict(result)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            tracker.check(self.cfg)
            self.assertEqual(output.getvalue(), '')
        with patch.dict('os.environ', {'WATCH_DIR': str(folder), 'WATCH_RUN': 'real-fixture'}), \
                patch.object(tracker, 'fetch', return_value=dict(result)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            tracker.check(self.cfg)
            events = json.loads(output.getvalue())['events']
            self.assertEqual(len([event for event in events if event['kind'] == 'item_dropped']), 2)
        with patch.dict('os.environ', {'WATCH_DIR': str(folder), 'WATCH_RUN': 'real-next'}), \
                patch.object(tracker, 'fetch', return_value=dict(result)), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            tracker.check(self.cfg)
            self.assertEqual(output.getvalue(), '')

    def test_delivered_prime_replays_drops_before_retiring(self):
        folder = self.root / 'check'
        folder.mkdir()
        cfg = dict(self.cfg, total='AED 600.00')
        result = {'status': 'delivered', 'items_complete': True, 'items': []}
        with patch.dict('os.environ', {'WATCH_DIR': str(folder), 'WATCH_RUN': 'prime-fixture'}), \
                patch.object(tracker, 'fetch', return_value=dict(result)), \
                contextlib.redirect_stdout(io.StringIO()):
            tracker.check(cfg)
        # Large-order pending callbacks have no ordinary wake destination.
        # They must leave item drops for the normal check and keep it alive.
        with patch.dict('os.environ', {'WATCH_DIR': str(folder), 'WATCH_RUN': 'pending-fixture'}), \
                patch.object(tracker, 'fetch') as fetch, patch.object(tracker, 'retire_terminal') as retire, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            tracker._check(cfg, pending_only=True)
            self.assertEqual(output.getvalue(), '')
            self.assertEqual(len(tracker.read(folder / 'order-tracker-state.json')['pending_item_drops']), 2)
            fetch.assert_not_called()
            retire.assert_not_called()
        with patch.dict('os.environ', {'WATCH_DIR': str(folder), 'WATCH_RUN': 'real-fixture'}), \
                patch.object(tracker, 'fetch') as fetch, patch.object(tracker, 'retire_terminal') as retire, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            tracker.check(cfg)
            self.assertEqual(len(json.loads(output.getvalue())['events']), 2)
            fetch.assert_not_called()
            retire.assert_not_called()

    def test_partial_snapshot_cannot_drop_missing_items_or_free_gifts(self):
        result = {'status': 'placed', 'items': []}
        self.assertEqual(tracker.transition(result, {}, self.cfg, self.now), [])
        cfg = dict(self.cfg, placed_items=[{'name': 'Gift', 'price': 0}])
        result = {'status': 'placed', 'items': [{'name': 'Gift', 'price': 0}]}
        self.assertEqual(tracker.transition(result, {}, cfg, self.now), [])

    def test_marketplace_manifest_fallback_cannot_join_name_only_card_basket(self):
        cfg = dict(self.cfg, app='noon', order='N123', mode=None,
                   card_meta={'items': self.cfg['placed_items']})
        cfg.pop('placed_items')
        native = {'status': 'placed', 'coverage': 'exact_native_marketplace_manifest',
                  'whole_order_complete': False, 'manifest_complete': True,
                  'manifest_items': [{'item_id': 'N123-1', 'quantity': 1, 'status': 'placed'},
                                     {'item_id': 'N123-2', 'quantity': 1, 'status': 'placed'}]}
        def unavailable(*args, **kwargs):
            raise RuntimeError('fixture details unavailable')
        with patch.dict(sys.modules, {
                'native_orders': SimpleNamespace(track=lambda *a, **kw: native, OrderError=RuntimeError),
                'noon_order_details': SimpleNamespace(details=unavailable)}):
            result = tracker.fetch(cfg, {}, self.now)
        self.assertTrue(result['item_details_unavailable'])
        self.assertTrue(result['manifest_complete'])
        state = {'primed': True, 'status': 'placed'}
        self.assertEqual(tracker.transition(result, state, cfg, self.now), [])
        self.assertEqual(state['dropped_items_seen'], [])
        # A later joinable snapshot can still report a real removal once.
        result = {'status': 'placed', 'items_complete': True,
                  'items': [{'name': 'Black sesame', 'price': '7.50'}]}
        state = json.loads(json.dumps(state))
        events = tracker.transition(result, state, cfg, self.now + 60)
        self.assertEqual([event['item'] for event in events], ['Fresh mint'])
        self.assertEqual(tracker.transition(result, state, cfg, self.now + 120), [])

    def test_removal_identity_projection_class(self):
        # A complete snapshot proves absence only in an identifier namespace
        # shared with the placed basket; anonymous rows may hide the item.
        cases = [
            ('names', {'name': 'Mint'}, [{'name': 'Sesame'}], True, True),
            ('name to ids', {'name': 'Mint'}, [{'item_id': 'one'}], True, False),
            ('mixed rows', {'name': 'Mint'}, [{'name': 'Sesame'}, {'item_id': 'two'}], True, False),
            ('item ids', {'item_id': 'one'}, [{'item_id': 'two'}], True, True),
            ('sku ids', {'sku': 'one'}, [{'sku': 'two'}], True, True),
            ('different namespaces', {'item_id': 'one'}, [{'sku': 'two'}], True, False),
            ('ids to names', {'item_id': 'one'}, [{'name': 'Sesame'}], True, False),
            ('shared name fallback', {'item_id': 'one', 'name': 'Mint'}, [{'name': 'Sesame'}], True, True),
            ('empty complete', {'name': 'Mint'}, [], True, True),
            ('empty partial', {'name': 'Mint'}, [], False, False),
            ('unresolved name', {'name': 'Mint'}, [{'name': 'Item details pending', 'unresolved': True}], True, False),
        ]
        for label, original, rows, complete, removed in cases:
            with self.subTest(projection=label):
                cfg = dict(self.cfg, placed_items=[dict(original, price='1.00')])
                result = {'status': 'placed', 'items': rows, 'items_complete': complete}
                events = tracker.transition(result, {}, cfg, self.now)
                self.assertEqual(bool(events), removed)

    def test_email_explicit_drops_share_the_common_dedupe(self):
        raw = self.mail(body='ORD-123\nBlack sesame: removed\nFresh mint: AED 0.00')
        result = receipt.parse(raw, self.cfg, self.now)
        state = {'primed': True}
        events = tracker.transition(result, state, self.cfg, self.now)
        self.assertEqual(len([e for e in events if e['kind'] == 'item_dropped']), 2)
        self.assertFalse(any(e['kind'] == 'item_dropped' for e in tracker.transition(result, state, self.cfg, self.now)))

    def test_gate_requires_registration_and_running_watcher(self):
        self.assertFalse(receipt.can_report('ORD-123')['ok'])
        path = tracker.ROOT / 'orders' / (self.cfg['watcher'] + '.json')
        tracker.write(path, self.cfg)
        self.assertFalse(receipt.can_report('ORD-123')['ok'])
        definition = tracker.WATCHERS / self.cfg['watcher'] / 'watcher.json'
        tracker.write(definition, {'id': self.cfg['watcher'], 'check': 'check command', 'paused': False})
        self.assertEqual(receipt.can_report('ORD-123')['eta'], 'no ETA given')
        self.assertTrue(receipt.can_report('ORD-123')['ok'])
        for values in ({'paused': True}, {'expires_at': tracker.stamp(time.time()-1)}):
            tracker.write(definition, {'id': self.cfg['watcher'], 'check': 'check command', **values})
            self.assertFalse(receipt.can_report('ORD-123')['ok'])
        tracker.write(definition, {'id': self.cfg['watcher'], 'check': 'check command'})
        for state in ({'failure_paused_at': tracker.stamp()}, {'status': 'done'}, {'status': 'expired'}):
            tracker.write(definition.parent / 'state.json', state)
            self.assertFalse(receipt.can_report('ORD-123')['ok'])
        tracker.write(path, dict(self.cfg, untrackable=True))
        self.assertTrue(receipt.can_report('ORD-123')['ok'])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tracker.main(['can-report', 'ORD-123']), 0)
            self.assertEqual(tracker.main(['can-report', 'missing']), 1)

    def test_untrackable_registration_never_polls_until_manual_delivery(self):
        argv = ['add', '--merchant', 'Acme', '--order-id', 'ORD-123', '--untrackable',
                '--amount', '81.15', '--card', '2342', '--requester', 'moni']
        with patch.object(tracker, 'run') as run, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tracker.main(argv), 0)
            self.assertEqual(tracker.main(argv), 0)
            self.assertTrue(receipt.can_report('ORD-123')['untrackable'])
            cfg = tracker.read(tracker.ROOT / 'orders' / (self.cfg['watcher'] + '.json'))
            self.assertTrue(cfg['active'])
            tracker.main(['delivered', '--merchant', 'Acme', '--order-id', 'ORD-123'])
            self.assertFalse(receipt.can_report('ORD-123')['ok'])
        run.assert_not_called()

    def test_email_registration_creates_a_running_watcher_and_requires_readback(self):
        calls = []
        def register(command, timeout):
            calls.append(command)
            wid = command[command.index('--id') + 1]
            tracker.write(tracker.WATCHERS / wid / 'watcher.json',
                          {'id': wid, 'check': command[command.index('--check') + 1]})
            return '{}'
        argv = ['add', '--merchant', 'Acme', '--order-id', 'ORD-123', '--email-receipt',
                '--amount', '81.15', '--card', '2342', '--requester', 'moni']
        with patch.object(tracker, 'run', register), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tracker.main(argv), 0)
            self.assertEqual(tracker.main(argv), 0)
        self.assertEqual(len(calls), 1)
        self.assertIn('--merchant Acme --order-id ORD-123', calls[0][calls[0].index('--check') + 1])

    def test_native_problem_check_configuration_preserves_receipt_watchers(self):
        for mode in ('email_receipt', 'untrackable'):
            cfg = dict(self.cfg, mode=mode, watcher='order-acme-' + mode)
            tracker.write(tracker.ROOT / 'orders' / (cfg['watcher'] + '.json'), cfg)
            tracker.write(tracker.WATCHERS / cfg['watcher'] / 'watcher.json',
                          {'id': cfg['watcher'], 'check': 'receipt check'})
        native = dict(self.cfg, app='noon', mode=None, order='N123', watcher='order-noon-n123')
        tracker.write(tracker.ROOT / 'orders' / (native['watcher'] + '.json'), native)
        tracker.write(tracker.WATCHERS / native['watcher'] / 'watcher.json',
                      {'id': native['watcher'], 'check': 'native check'})
        self.assertEqual(tracker.main(['configure-problem-checks']), 0)
        for mode in ('email_receipt', 'untrackable'):
            definition = tracker.read(tracker.WATCHERS / ('order-acme-' + mode) / 'watcher.json')
            self.assertNotIn('pending_check', definition)
        definition = tracker.read(tracker.WATCHERS / native['watcher'] / 'watcher.json')
        self.assertIn('check-pending --app noon --order N123', definition['pending_check'])

    def test_amazon_cancelled_item_uses_requester_drop_path(self):
        import amazon_email_orders as amazon
        event = {'event_id': 'cancel-1', 'order_id': 'ORD-123', 'stage': 'cancelled', 'scope': 'item',
                 'observed_at': tracker.stamp(self.now), 'evidence_at': tracker.stamp(self.now-30),
                 'items_parse_valid': True,
                 'items': [{'item_key': amazon.digest('black sesame'), 'quantity': 1}]}
        mail = {'status': 'cancelled', 'evidence': [event], 'errors': []}
        cfg = dict(self.cfg, app='amazon', mode=None)
        with patch.object(amazon, 'track', return_value=mail), patch.object(tracker.store, 'evidence', return_value=([], [])):
            result = tracker.fetch(cfg, {}, self.now)
        state = {'primed': True}
        events = tracker.transition(result, state, cfg, self.now)
        dropped = [event for event in events if event['kind'] == 'item_dropped']
        self.assertEqual([(event['item'], event['chat']) for event in dropped], [('Black sesame', 'moni')])
        self.assertFalse(any(event['kind'] == 'item_dropped' for event in tracker.transition(result, state, cfg, self.now+60)))


if __name__ == '__main__':
    unittest.main()
