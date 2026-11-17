import contextlib
import datetime as dt
import fcntl
from email.message import EmailMessage
import hashlib
import io
import json
import shlex
import subprocess
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
import delivery_cards
import order_items


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

    def test_noon_item_code_survives_registration_and_matches_native_emoji_name(self):
        baseline = delivery_cards.items([{'name': 'Chicken Tawook Wrap HP', 'item_code': 'I162175398A',
                                         'qty': 1, 'price': 48}])
        cfg = dict(self.cfg, app='noon', merchant='noon', card_meta={'items': baseline})
        cfg.pop('placed_items')
        result = {'status': 'preparing', 'items_complete': True,
                  'items': [{'item_code': 'I162175398A', 'name': 'Chicken Tawook Wrap HP \U0001f4aa',
                             'qty': 1, 'price': 48}]}
        state = {'primed': True, 'status': 'preparing'}
        self.assertEqual(tracker.transition(result, state, cfg, self.now), [])
        self.assertEqual(state['dropped_items_seen'], [])

    def test_name_only_basket_matches_spacing_punctuation_and_emoji(self):
        for observed in ('Chicken  Tawook Wrap HP \U0001f4aa', 'Chicken Tawook Wrap HP \u2764\ufe0f',
                         'Chicken-Tawook Wrap, HP', '\uff23hicken Tawook Wrap HP'):
            with self.subTest(observed=observed):
                cfg = dict(self.cfg, placed_items=[{'name': 'Chicken Tawook Wrap HP', 'price': 48}])
                result = {'status': 'placed', 'items_complete': True, 'items': [{'name': observed, 'price': 48}]}
                self.assertTrue(order_items.same_item(cfg['placed_items'][0], result['items'][0]))
                self.assertEqual(tracker.transition(result, {}, cfg, self.now), [])

    def test_real_item_code_drop_keeps_original_message_and_requester(self):
        cfg = dict(self.cfg, app='noon', merchant='noon', placed_items=[
            {'name': 'Chicken Tawook Wrap HP', 'item_code': 'wrap', 'price': 48},
            {'name': 'Fresh mint', 'item_code': 'mint', 'price': 1}])
        result = {'status': 'placed', 'items_complete': True,
                  'items': [{'name': 'Chicken Tawook Wrap HP \U0001f4aa', 'item_code': 'wrap', 'price': 48}]}
        events = tracker.transition(result, {}, cfg, self.now)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['kind'], 'item_dropped')
        self.assertEqual(events[0]['item'], 'Fresh mint')
        self.assertEqual(events[0]['chat'], 'moni')
        self.assertEqual(events[0]['message'], 'noon removed Fresh mint (AED 1.00); want me to get it elsewhere?')

    def test_identifier_forms_match_card_storage_with_an_overlapping_sibling(self):
        forms = [
            ('over cap', 'x' * 81), ('padded whitespace', '  item   code  '), ('numeric', 12345),
            ('exact cap', 'x' * 80), ('space before cap', 'x' * 78 + ' yz'),
            ('space at cap', 'x' * 79 + ' y'), ('space after cap', 'x' * 80 + ' y'),
            ('tab at cap', 'x' * 79 + '\t y'), ('nbsp at cap', 'x' * 79 + '\u00a0y'),
            ('repeated whitespace at cap', 'x' * 79 + '   y'),
        ]
        for field in ('item_id', 'item_code', 'sku', 'sku_config'):
            for label, raw in forms:
                with self.subTest(field=field, form=label):
                    original = {'name': 'Wrap', field: raw, 'price': 48}
                    sibling = {'name': 'Mint', field: 'sibling', 'price': 1}
                    cfg = dict(self.cfg, placed_items=delivery_cards.items([original, sibling]))
                    result = {'status': 'placed', 'items_complete': True, 'items': [original, sibling]}
                    self.assertEqual(tracker.transition(result, {}, cfg, self.now), [])
                    self.assertEqual(order_items.identity(original), order_items.identity(cfg['placed_items'][0]))
                    canonical = order_items.match_fields(original)[field]
                    self.assertEqual(order_items.match_fields({field: canonical})[field], canonical)
                    cfg['placed_items'] = delivery_cards.items(cfg['placed_items'])
                    self.assertEqual(tracker.transition(result, {}, cfg, self.now), [])

    def test_matched_item_explicit_removal_or_zero_price_still_fires(self):
        for change in ({'status': 'removed'}, {'status': 'cancelled'}, {'status': 'canceled'},
                       {'status': 'unavailable'}, {'price': 0}):
            with self.subTest(change=change):
                original = {'name': 'Wrap', 'item_code': 'wrap', 'price': 48}
                cfg = dict(self.cfg, placed_items=[original])
                result = {'status': 'placed', 'items': [dict(original, **change)]}
                events = tracker.transition(result, {}, cfg, self.now)
                self.assertEqual([e['item'] for e in events], ['Wrap'])

    def test_disjoint_manifest_suppresses_absence_but_not_merchant_drops(self):
        cfg = dict(self.cfg, app='noon', placed_items=[{'name': 'Wrap', 'item_code': 'wrap', 'price': 48}])
        result = {'status': 'placed', 'items_complete': True,
                  'items': [{'name': 'Salad', 'item_code': 'salad', 'price': 20}]}
        self.assertEqual(tracker.transition(result, {}, cfg, self.now), [])
        result['dropped_items'] = [{'item_code': 'wrap', 'name': 'Wrap'}]
        events = tracker.transition(result, {}, cfg, self.now)
        self.assertEqual([e['item'] for e in events], ['Wrap'])

    def test_legacy_drop_keys_do_not_replay_after_normalization_or_item_code_retention(self):
        for extra in ({}, {'item_code': 'wrap'}, {'item_code': 'wrap', 'sku': 'old-sku'},
                      {'item_code': 'wrap', 'sku_config': 'old-config'}, {'item_id': 'old-id'}):
            for display in ('Chicken Wrap \U0001f4aa', 'Chicken-Wrap', 'Fresh mint'):
                with self.subTest(extra=extra, display=display):
                    original = dict(name=display, price=48, **extra)
                    old_key = str(extra.get('item_id') or extra.get('sku') or extra.get('sku_config')
                                  or order_items.name(original).casefold())
                    cfg = dict(self.cfg, placed_items=[original])
                    state = {'primed': True, 'dropped_items_seen': [old_key]}
                    result = {'status': 'placed', 'items_complete': True, 'items': []}
                    self.assertEqual(tracker.transition(result, state, cfg, self.now), [])

    def test_new_drop_key_dedupes_across_restart(self):
        cfg = dict(self.cfg, placed_items=[{'name': 'Chicken Wrap \U0001f4aa', 'item_code': 'wrap', 'price': 48}])
        result = {'status': 'placed', 'items_complete': True, 'items': []}
        state = {}
        self.assertEqual(len(tracker.transition(result, state, cfg, self.now)), 1)
        self.assertEqual(state['dropped_items_seen'], ['wrap'])
        self.assertEqual(tracker.transition(result, json.loads(json.dumps(state)), cfg, self.now + 60), [])

    def test_name_normalization_preserves_scripts_digits_and_emoji_only_fallback(self):
        for original, observed, matches in (
            ('\u0634\u0627\u0648\u0631\u0645\u0627 \u062f\u062c\u0627\u062c', '\u0634\u0627\u0648\u0631\u0645\u0627 \u0644\u062d\u0645', False),
            ('\u0634\u0627\u0648\u0631\u0645\u0627 \u062f\u062c\u0627\u062c', '\u0634\u0627\u0648\u0631\u0645\u0627 \u062f\u062c\u0627\u062c \U0001f4aa', True),
            ('\u9e21\u8089\u5377 12', '\u9e21\u8089\u5377 \uff11\uff12 \u2764\ufe0f', True),
            ('Wrap 12', 'Wrap 13', False), ('\U0001f4aa', '\u2764\ufe0f', False),
            ('Wrap', 'Wrap\U0001f4aa\U0001f3fd\u200d\u2764\ufe0f\ue000\ud800\u02c2', True),
        ):
            with self.subTest(original=original, observed=observed):
                self.assertEqual(order_items.same_item({'name': original}, {'name': observed}), matches)

    def test_identifier_precedence_and_name_fallback(self):
        fields = ('item_id', 'item_code', 'sku', 'sku_config', 'name')
        for n, preferred in enumerate(fields):
            with self.subTest(preferred=preferred):
                original = {field: 'same' for field in fields[n:]}
                current = {field: 'different' for field in fields[n:]}
                current[preferred] = 'same'
                self.assertEqual(order_items.matched_field(original, current), preferred)
                self.assertEqual(order_items.identity(original), 'same')
                current[preferred] = 'mismatch'
                current['name'] = 'same'
                if preferred != 'name':
                    self.assertFalse(order_items.same_item(original, current))

    def test_item_drop_checks_reach_structured_log_once_per_call(self):
        logroot = self.root / 'logs'
        cfg = dict(self.cfg, app='noon', placed_items=[{'name': 'Wrap', 'item_code': 'wrap', 'price': 48}])
        disjoint = {'items_complete': True, 'items': [{'name': 'Salad', 'item_code': 'salad'}]}
        with patch.dict('os.environ', {'ROBOB_TOOL_LOG_DIR': str(logroot)}):
            self.assertEqual(order_items.dropped(disjoint, {}, cfg), [])
            for field in ('item_id', 'item_code', 'sku', 'sku_config', 'name'):
                original = {field: 'wrap', 'price': 48}
                order_items.dropped({'items': [original]}, {}, dict(cfg, placed_items=[original]))
            order_items.dropped({'items_complete': True, 'items': []}, {}, cfg)
            order_items.dropped({}, {}, dict(cfg, placed_items=[]))
            order_items.dropped({}, {}, {'app': 'noon'})
        logs = [json.loads(line) for path in (logroot / 'orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]
        self.assertEqual(len(logs), 9)
        self.assertEqual({row['name'] for row in logs}, {'order_watch.item_drop_check'})
        first = logs[0]
        self.assertEqual(first['component'], 'order-watch')
        self.assertNotEqual(first['ids']['watcher'], cfg['watcher'])
        self.assertEqual(first['props'], {
            'app': 'noon', 'baseline_count': 1, 'row_count': 1, 'complete': True,
            'matched_by': dict.fromkeys(('item_id', 'item_code', 'sku', 'sku_config', 'name'), 0),
            'absent_count': 1, 'emitted_count': 0, 'suppressed_reason': 'no_overlap'})
        for row, field in zip(logs[1:6], ('item_id', 'item_code', 'sku', 'sku_config', 'name')):
            self.assertEqual(row['props']['matched_by'][field], 1)
            self.assertIsNone(row['props']['suppressed_reason'])
        self.assertEqual(logs[6]['props']['emitted_count'], 1)
        self.assertEqual(logs[7]['props']['baseline_count'], 0)
        self.assertNotIn('ids', logs[8])
        self.assertNotIn('Wrap', json.dumps(logs))
        self.assertNotIn('price', json.dumps(logs))

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
                # A shared line establishes overlap before checking this missing line's namespace.
                anchor = {'item_id': 'anchor', 'sku': 'anchor', 'name': 'Shared line'}
                cfg = dict(self.cfg, placed_items=[anchor, dict(original, price='1.00')])
                result = {'status': 'placed', 'items': rows + [anchor] if rows else rows, 'items_complete': complete}
                events = tracker.transition(result, {}, cfg, self.now)
                self.assertEqual(any(e['item'] != 'Shared line' for e in events), removed)

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

    def assert_logged_can_report(self, argv, refusal):
        expected = (receipt.can_report(argv[1]) if len(argv) == 2 else
                    {'ok': False, 'error': 'usage: order-watch can-report ORDER_ID'})
        folder = self.root / 'logs'
        def rows():
            return [json.loads(line) for path in (folder / 'orders').glob('*.ndjson')
                    for line in path.read_text().splitlines()]
        before = len(rows())
        output = io.StringIO()
        with patch.dict('os.environ', {'ROBOB_TOOL_LOG_DIR': str(folder), 'TOOLLOG_ROOT': str(folder)}), \
                contextlib.redirect_stdout(output):
            self.assertEqual(tracker.main(argv), 0 if expected['ok'] else 1)
        self.assertEqual(output.getvalue(), json.dumps(expected) + '\n')
        row, = rows()[before:]
        self.assertEqual(row['name'], 'order_watch.can_report')
        self.assertEqual(row['component'], 'order-watch')
        self.assertEqual(row['kind'], 'event')
        self.assertEqual(row['ok'], expected['ok'])
        self.assertEqual(row['props'], {
            'outcome': 'success' if expected['ok'] else 'refused', 'refusal': refusal,
            'untrackable': bool(expected.get('untrackable')),
            'eta_given': expected.get('eta') not in (None, 'no ETA given')})
        identity = expected.get('tracker')
        self.assertEqual(row.get('ids', {}), {'watcher': hashlib.sha256(identity.encode()).hexdigest()[:16]}
                         if identity else {})
        self.assertEqual(set(row) - {'ids'}, {'ts', 'tool', 'component', 'kind', 'name', 'ok', 'props'})
        return row

    def test_can_report_logs_each_refusal_once_without_changing_output(self):
        cases = [
            ('unregistered', ['can-report', 'missing'], [], None, 'not_registered'),
            ('ambiguous', ['can-report', 'ORD-123'], [self.cfg, self.cfg], None, 'not_registered'),
            ('invalid-id', ['can-report', 'private@example.test'], [], None, 'invalid_id'),
            ('invalid-registration', ['can-report', 'ORD-123'], [dict(self.cfg, watcher='../private')],
             None, 'invalid_registration'),
            ('not-running', ['can-report', 'ORD-123'], [self.cfg], None, 'not_running_or_held'),
            ('held', ['can-report', 'ORD-123'], [dict(self.cfg, delivery_card={'held': True})],
             {'id': self.cfg['watcher'], 'check': 'check command'}, 'not_running_or_held'),
            ('missing-id', ['can-report'], [], None, 'usage'),
            ('extra-id', ['can-report', 'ORD-123', 'extra'], [], None, 'usage'),
        ]
        for label, argv, configs, definition, refusal in cases:
            with self.subTest(label=label), patch.object(tracker, 'ROOT', self.root / label), \
                    patch.object(tracker, 'WATCHERS', self.root / label / 'watchers'):
                for index, cfg in enumerate(configs):
                    tracker.write(tracker.ROOT / 'orders' / (str(index) + '.json'), cfg)
                if definition:
                    tracker.write(tracker.WATCHERS / self.cfg['watcher'] / 'watcher.json', definition)
                self.assert_logged_can_report(argv, refusal)

    def test_can_report_logs_success_eta_and_untrackable_without_private_text(self):
        tracker.write(tracker.WATCHERS / self.cfg['watcher'] / 'watcher.json',
                      {'id': self.cfg['watcher'], 'check': 'check command'})
        for untrackable in (False, True):
            for eta in (None, 'no ETA given', '14–15 November, leave at Apartment 987 Example Street'):
                with self.subTest(untrackable=untrackable, eta=eta):
                    tracker.write(tracker.ROOT / 'orders' / (self.cfg['watcher'] + '.json'),
                                  dict(self.cfg, untrackable=untrackable, eta=eta))
                    row = self.assert_logged_can_report(['can-report', 'ORD-123'], 'none')
                    self.assertNotIn('ORD-123', json.dumps(row))
                    if eta:
                        self.assertNotIn(eta, json.dumps(row))

    def test_can_report_survives_emit_and_disk_write_failures(self):
        folder = self.root / 'logs'
        tracker.write(tracker.ROOT / 'orders' / (self.cfg['watcher'] + '.json'),
                      dict(self.cfg, untrackable=True))
        for order in ('ORD-123', 'missing'):
            expected = receipt.can_report(order)
            for target in ('emit', 'os.open'):
                with self.subTest(order=order, target=target), \
                        patch.dict('os.environ', {'ROBOB_TOOL_LOG_DIR': str(folder), 'TOOLLOG_ROOT': str(folder)}), \
                        patch('toollog.' + target, side_effect=OSError('disk full')), \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(tracker.main(['can-report', order]), 0 if expected['ok'] else 1)
                self.assertEqual(output.getvalue(), json.dumps(expected) + '\n')
        self.assertFalse(list(folder.glob('orders/*.ndjson')))

    def test_untrackable_registration_never_polls_until_manual_delivery(self):
        argv = ['add', '--merchant', 'Acme', '--order-id', 'ORD-123', '--untrackable',
                '--amount', '81.15', '--card', '2342', '--requester', 'moni']
        with patch.object(tracker, 'run') as run, patch.object(tracker, 'fetch') as fetch, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tracker.main(argv), 0)
            self.assertEqual(tracker.main(argv), 0)
            self.assertTrue(receipt.can_report('ORD-123')['untrackable'])
            cfg = tracker.read(tracker.ROOT / 'orders' / (self.cfg['watcher'] + '.json'))
            self.assertTrue(cfg['active'])
            tracker.main(['check', '--merchant', 'Acme', '--order-id', 'ORD-123'])
            tracker.main(['check-pending', '--merchant', 'Acme', '--order-id', 'ORD-123'])
            tracker.main(['delivered', '--merchant', 'Acme', '--order-id', 'ORD-123'])
            self.assertFalse(receipt.can_report('ORD-123')['ok'])
        run.assert_not_called()
        fetch.assert_not_called()

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

    def test_problem_check_configuration_routes_receipts_and_skips_untrackable(self):
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
        definition = tracker.read(tracker.WATCHERS / 'order-acme-email_receipt' / 'watcher.json')
        self.assertIn('check-pending --merchant Acme --order-id ORD-123', definition['pending_check'])
        self.assertNotIn('--app', definition['pending_check'])
        definition = tracker.read(tracker.WATCHERS / 'order-acme-untrackable' / 'watcher.json')
        self.assertNotIn('pending_check', definition)
        definition = tracker.read(tracker.WATCHERS / native['watcher'] / 'watcher.json')
        self.assertIn('check-pending --app noon --order N123', definition['pending_check'])

    def test_receipt_registration_prime_problem_retry_delivery_and_retirement(self):
        wid = self.cfg['watcher']
        folder = tracker.WATCHERS / wid
        config_path = tracker.ROOT / 'orders' / (wid + '.json')
        state_path = folder / 'order-tracker-state.json'
        result = {'status': 'unknown', 'errors': []}
        attempts, removed = [], []

        def invoke(command, run_id, main_checked=False):
            with patch.dict('os.environ', {'WATCH_DIR': str(folder), 'WATCH_RUN': run_id,
                                          'WATCH_MAIN_CHECKED': '1' if main_checked else '0'}), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                tracker.main(shlex.split(command)[2:])
            return output.getvalue()

        def watch(command, timeout=12):
            if command[:2] == ['robob-watch', 'add']:
                definition = {'id': wid, 'check': command[command.index('--check') + 1]}
                tracker.write(folder / 'watcher.json', definition)
                tracker.write(folder / 'state.json', {'status': 'active', 'fires': 0})
                invoke(definition['check'], 'prime-fixture')
            elif command == ['robob-watch', 'remove', wid]:
                removed.append(wid)
                (folder / 'watcher.json').unlink()
            else:
                self.fail(f'Unexpected watcher command: {command}')
            return '{}'

        def send(command, **kwargs):
            self.assertEqual(command[:3], [tracker.BUN, tracker.PROBLEM_CLI, 'notify'])
            attempts.append(command)
            if len(attempts) == 1:
                return subprocess.CompletedProcess(command, 1, '', 'fixture unavailable')
            return subprocess.CompletedProcess(command, 0, json.dumps({'id': 'notice:fixture', 'created': True}), '')

        real_flock = fcntl.flock
        def nonblocking_flock(fd, operation):
            # A registration prime must not wait on its parent's registration lock.
            return real_flock(fd, operation | fcntl.LOCK_NB)

        argv = ['add', '--merchant', 'Acme', '--email-receipt', '--order-id', 'ORD-123',
                '--amount', '600', '--card', '2342', '--requester', 'moni']
        with patch.object(tracker, 'run', watch), patch.object(receipt, 'fetch', side_effect=lambda *a: dict(result)), \
                patch.object(tracker.delivery_cards, 'safe_sync', return_value={}), \
                patch.object(tracker.order_bank_charge, 'load_charges') as native_bank, \
                patch.object(tracker.subprocess, 'run', send), patch.object(fcntl, 'flock', nonblocking_flock), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(tracker.main(argv), 0)
            definition = tracker.read(folder / 'watcher.json')
            self.assertIn('pending_check', definition)
            self.assertEqual(attempts, [])
            notices = tracker.read(state_path)['problem_notices']
            self.assertEqual(len(notices), 1)
            self.assertEqual(next(iter(notices.values()))['status'], 'pending')

            invoke(definition['check'], 'poll-unknown')
            invoke(definition['pending_check'], 'pending-retry', main_checked=True)
            self.assertEqual(len(attempts), 1)
            self.assertEqual(next(iter(tracker.read(state_path)['problem_notices'].values()))['status'], 'pending')

            result.update(status='delivered', whole_order_complete=True)
            output = json.loads(invoke(definition['check'], 'poll-delivered'))
            self.assertEqual(output['for'], 'moni')
            self.assertIn({'kind': 'stage_change', 'status': 'delivered'}, output['events'])
            tracker.write(folder / 'state.json', {'status': 'active', 'pending': {'run_id': 'poll-delivered'}})
            invoke(definition['pending_check'], 'pending-after-delivery')
            self.assertEqual(len(attempts), 2)
            self.assertEqual([call[call.index('--key') + 1] for call in attempts], list(notices) * 2)
            self.assertEqual(next(iter(tracker.read(state_path)['problem_notices'].values()))['status'], 'sent')
            self.assertEqual(removed, [])
            tracker.write(folder / 'state.json', {'status': 'active'})
            invoke(definition['check'], 'poll-retire')
            self.assertEqual(len(attempts), 2)
            self.assertEqual(removed, [wid])
            self.assertFalse(tracker.read(config_path)['active'])
            native_bank.assert_not_called()

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
