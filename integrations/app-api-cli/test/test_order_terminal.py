"""Silent repair regressions: isolated state, archive and logs; senders forbidden."""
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import amazon_checkout as checkout
import amazon_email_orders as mail
import delivery_cards
import order_receipts
import order_tracker as tracker
import order_terminal
from test_amazon_checkout import split_confirmation
from test_amazon_email_orders import OID, OTHER, parse


class TerminalRepairTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.at = '2026-10-06T20:57:00+04:00'
        self.items = self.base / 'items.json'
        self.items.write_text(json.dumps([{'name': 'Fixture Tea', 'qty': 1, 'price': 39.75}]))
        self.mail = {**mail.aggregate_order(OID, parse(split_confirmation())), 'errors': []}
        for obj, field, value in [(tracker, 'ROOT', self.base / 'tracker'),
                                  (tracker, 'WATCHERS', self.base / 'watch/watchers'),
                                  (delivery_cards, 'ROOT', self.base / 'tracker'),
                                  (delivery_cards, 'APPS', self.base / 'apps')]:
            self.enter(patch.object(obj, field, value))
        self.enter(patch.dict(os.environ, {'TOOLLOG_ROOT': str(self.base / 'logs'),
                    'ROBOB_TOOL_LOG_DIR': str(self.base / 'logs'), 'ORDER_WATCH_CHAT': '',
                    'WATCH_DIR': str(self.base / 'scratch'), 'WATCH_RUN': 'scheduled-fixture'}))
        self.enter(patch.object(tracker, 'cwd_chat', return_value=None))
        self.enter(patch.object(tracker, 'known_chat', return_value=True))
        self.enter(patch.object(mail, 'track', return_value=self.mail))
        self.forbidden = []
        for obj, field in [(tracker, 'run'), (tracker.subprocess, 'run'), (tracker.subprocess, 'Popen'),
                           (tracker, 'fetch'), (tracker, 'notify_placement'), (tracker, 'bridge_route'),
                           (tracker, 'send_problem_notices'), (tracker, 'bank_charge_events'),
                           (delivery_cards, 'safe_sync'), (delivery_cards, 'sync'), (tracker.store, 'reconcile')]:
            self.forbidden.append(self.enter(patch.object(obj, field, side_effect=AssertionError('must stay silent: ' + field))))
        self.addCleanup(self.assert_silent)

    def enter(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def assert_silent(self):
        for sender in self.forbidden:
            sender.assert_not_called()

    def invoke(self, *args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = tracker.main(list(args))
        return code, json.loads(output.getvalue())

    def import_order(self, *extra, order=OID, status='delivered'):
        return self.invoke('import-terminal', '--app', 'amazon', '--order', order, '--for', 'moni',
                           '--status', status, '--at', self.at, '--evidence', 'Fixture delivery email',
                           '--amount', '39.75', '--card', '2342', '--items-file', str(self.items),
                           '--placed-at', '2026-10-06T09:43:00+04:00', *extra)

    def sibling(self, status='delivered', *, archived=False, active=False):
        cfg = {'app': 'amazon', 'order': OTHER, 'for': 'moni', 'chat': 'moni',
               'watcher': 'order-amazon-' + OTHER, 'active': active,
               'placed_at': '2026-10-06T09:43:00+04:00', 'registered_at': '2026-10-06T09:44:00+04:00',
               'amount': '103.17', 'card_last4': '2342', 'bank_msg_id': 12345,
               'placed_notice': {'status': 'sent'}, 'delivery_card': {'ready': True},
               'card_meta': {'items': [{'name': 'Fixture Tea'}, {'name': 'Fixture Root'}]}}
        tracker.write(checkout.config_path(tracker, OTHER), cfg)
        folder = tracker.WATCHERS / cfg['watcher']
        if archived:
            folder = tracker.WATCHERS.parent / 'archive' / (cfg['watcher'] + '-123456')
            tracker.write(tracker.WATCHERS.parent / 'archive/retired' / (cfg['watcher'] + '.json'),
                          {'archived': str(folder)})
        tracker.write(folder / 'order-tracker-state.json', {'status': status,
            'last_result': {'status': status, 'whole_order_complete': status in tracker.TERMINAL},
            'fixture_cursor': 'keep-me'})
        return cfg

    def snapshot(self):
        return {str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob('*')
                if p.is_file() and 'logs' not in p.relative_to(self.base).parts}

    def test_import_links_terminal_sibling_live_and_archived(self):
        for archived in (False, True):
            with self.subTest(archived=archived):
                self.sibling(archived=archived)
                code, receipt = self.import_order('--checkout-order', OTHER)
                self.assertEqual(code, 0, receipt)
                for oid in (OID, OTHER):
                    cfg = tracker.read(checkout.config_path(tracker, oid))
                    state = checkout.order_state(tracker, cfg)
                    self.assertEqual(cfg['siblings'], sorted([OID, OTHER]))
                    self.assertEqual(cfg['checkout'], self.mail['checkout']['id'])
                    self.assertEqual(cfg['checkout_leader'], OTHER)
                    self.assertTrue(state['checkout_terminal'])
                    self.assertTrue(state['last_result']['checkout_result']['checkout_terminal'])
                cfg = tracker.read(checkout.config_path(tracker, OID))
                state = checkout.order_state(tracker, cfg)
                self.assertFalse(cfg['active'])
                self.assertEqual(state['last_result']['evidence_at'], self.at)
                self.assertEqual(state['last_result']['evidence'][0]['evidence'], 'Fixture delivery email')
                self.assertEqual(state['terminal_at'], tracker.epoch(self.at))
                self.assertFalse((tracker.WATCHERS / cfg['watcher']).exists())
                self.assertEqual(checkout.order_state(tracker, tracker.read(checkout.config_path(tracker, OTHER)))['fixture_cursor'], 'keep-me')
                for oid in (OID, OTHER):
                    self.assertTrue(order_receipts.can_report(oid)['ok'])
                    for command in ('status', 'check', 'check-pending'):
                        before = self.snapshot()
                        self.assertEqual(self.invoke(command, '--app', 'amazon', '--order', oid)[1]['status'], 'delivered')
                        self.assertEqual(before, self.snapshot())

    def test_cancelled_import_keeps_active_sibling_incomplete(self):
        self.sibling(status='preparing', active=True)
        self.assertEqual(self.import_order('--checkout-order', OTHER, status='cancelled')[0], 0)
        cfg = tracker.read(checkout.config_path(tracker, OID))
        state = checkout.order_state(tracker, cfg)
        self.assertEqual(state['last_result']['status'], 'cancelled')
        self.assertFalse(state['checkout_terminal'])
        self.assertEqual(state['last_result']['checkout_result']['status'], 'preparing')
        self.assertTrue(tracker.read(checkout.config_path(tracker, OTHER))['active'])

    def test_missing_sibling_is_linked_but_never_invented(self):
        self.assertEqual(self.import_order('--checkout-order', OTHER)[0], 0)
        cfg = tracker.read(checkout.config_path(tracker, OID))
        self.assertFalse(checkout.order_state(tracker, cfg)['checkout_terminal'])
        self.assertFalse(checkout.config_path(tracker, OTHER).exists())
        self.assertFalse(order_receipts.can_report(OID)['ok'])

    def test_dry_runs_write_nothing_and_describe_exact_files(self):
        before = self.snapshot()
        with patch.object(tracker.toollog, 'emit') as emit:
            code, plan = self.import_order('--dry-run', '--checkout-order', OTHER)
        emit.assert_not_called()
        self.assertEqual(code, 0)
        self.assertEqual(before, self.snapshot())
        self.assertTrue(any('/archive/retired/' in p for p in plan['writes']))
        with patch.object(tracker, 'stamp', return_value='2026-10-07T00:00:00+00:00'):
            plan = self.import_order('--dry-run')[1]
            actual = self.import_order()[1]
        self.assertEqual(plan['writes'], actual['writes'])
        for path, data in actual['writes'].items():
            self.assertEqual(tracker.read(Path(path)), data)
        before = self.snapshot()
        with patch.object(tracker.toollog, 'emit') as emit:
            code, plan = self.invoke('set-meta', '--app', 'amazon', '--order', OID, '--amount', '63.42',
                                     '--items-file', str(self.items), '--dry-run')
        emit.assert_not_called()
        self.assertEqual(code, 0)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(plan['writes'][str(checkout.config_path(tracker, OID))]['amount'], '63.42')

    def test_active_and_nonterminal_orders_refuse(self):
        self.sibling(status='preparing', active=True)
        before = tracker.read(checkout.config_path(tracker, OTHER))
        self.assertEqual(self.import_order(order=OTHER)[0], 1)
        self.assertEqual(before, tracker.read(checkout.config_path(tracker, OTHER)))
        self.assertEqual(self.import_order(status='preparing')[0], 1)
        self.assertFalse(checkout.config_path(tracker, OID).exists())

    def test_discovery_can_register_missing_order_while_import_waits_on_sibling(self):
        cfg = self.sibling(status='preparing', active=True)
        state_lock = checkout.order_state_path(tracker, cfg).parent / 'order-tracker.lock'
        registration = checkout.config_path(tracker, OID).with_suffix('.registration.lock')
        waiting, result = threading.Event(), []
        flock = fcntl.flock
        def observed(lock, operation):
            if threading.current_thread().name == 'terminal-import' and Path(lock.name) == state_lock:
                waiting.set()
            return flock(lock, operation)
        def importing():
            result.append(self.import_order('--checkout-order', OTHER))
        # A scheduled check holds this lock while discovery calls add for OID.
        with state_lock.open('a') as held, patch.object(order_terminal.fcntl, 'flock', side_effect=observed):
            flock(held, fcntl.LOCK_EX)
            worker = threading.Thread(target=importing, name='terminal-import', daemon=True)
            worker.start()
            try:
                self.assertTrue(waiting.wait(5), 'import did not reach the sibling state lock')
                with registration.open('a') as missing:
                    flock(missing, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    tracker.write(checkout.config_path(tracker, OID), {
                        **cfg, 'order': OID, 'watcher': 'order-amazon-' + OID})
            finally:
                flock(held, fcntl.LOCK_UN)
                worker.join(5)
        self.assertFalse(worker.is_alive(), 'import did not finish after discovery')
        self.assertEqual(result[0][0], 1)
        self.assertIn('changed', result[0][1]['error'])
        self.assertTrue(tracker.read(checkout.config_path(tracker, OID))['active'])

    def test_reimport_preserves_populated_archived_terminal_result(self):
        self.assertEqual(self.import_order()[0], 0)
        cfg = tracker.read(checkout.config_path(tracker, OID))
        path = checkout.order_state_path(tracker, cfg)
        state = tracker.read(path)
        retained = {'manifest': [{'name': 'Fixture Tea'}], 'shipments': [{'id': 'fixture-shipment'}],
                    'partial_evidence': [{'scope': 'shipment', 'evidence': 'Earlier proof'}],
                    'aftercare_evidence': [{'stage': 'refunded'}], 'future_field': {'keep': True},
                    'source': 'amazon_email', 'evidence_at': '2026-10-06T20:55:00+04:00'}
        state['last_result'].update(retained)
        state['terminal_at'] -= 120
        previous_time = state['terminal_at']
        previous_evidence = state['last_result']['evidence'].copy()
        tracker.write(path, state)
        self.assertEqual(self.import_order('--evidence', 'Additional terminal proof')[0], 0)
        repaired = tracker.read(path)
        for key, value in retained.items():
            self.assertEqual(repaired['last_result'][key], value)
        self.assertEqual(repaired['terminal_at'], previous_time)
        self.assertEqual(repaired['last_result']['evidence'][:-1], previous_evidence)
        self.assertEqual(repaired['last_result']['evidence'][-1]['evidence'], 'Additional terminal proof')
        self.assertEqual(self.import_order('--evidence', 'Additional terminal proof')[0], 0)
        self.assertEqual(tracker.read(path)['last_result'], repaired['last_result'])

    def test_routing_conflict_forms_refuse_before_writes(self):
        cases = [('recipient', {'for': 'owner'}, ()),
                 ('explicit', {}, ('--chat', 'group-other')),
                 ('unavailable', {'chat': 'group-old'}, ()),
                 ('syntax', {}, ('--chat', '../moni'))]
        for name, change, flags in cases:
            with self.subTest(name=name):
                cfg = self.sibling()
                cfg.update(change)
                tracker.write(checkout.config_path(tracker, OTHER), cfg)
                with patch.object(tracker, 'known_chat', side_effect=lambda c: c != 'group-old'):
                    self.assertEqual(self.import_order('--checkout-order', OTHER, *flags)[0], 1)
                self.assertFalse(checkout.config_path(tracker, OID).exists())
                self.assertEqual(cfg, tracker.read(checkout.config_path(tracker, OTHER)))

    def test_set_meta_preserves_registration_bank_claims_and_watchers(self):
        cfg = self.sibling()
        before_watch = {p: p.read_bytes() for p in tracker.WATCHERS.rglob('*') if p.is_file()}
        self.items.write_text(json.dumps({'items': [{'name': 'Fixture Root', 'qty': 1, 'price': 63.42}]}))
        code, result = self.invoke('set-meta', '--app', 'amazon', '--order', OTHER, '--amount', '63.42', '--items-file', str(self.items))
        self.assertEqual(code, 0, result)
        corrected = tracker.read(checkout.config_path(tracker, OTHER))
        self.assertEqual(corrected['amount'], '63.42')
        self.assertEqual(corrected['total'], 'AED 63.42')
        self.assertEqual([r['name'] for r in corrected['card_meta']['items']], ['Fixture Root'])
        self.assertEqual(corrected['placed_items'], corrected['card_meta']['items'])
        for key in ('placed_notice', 'delivery_card', 'active', 'for', 'chat', 'bank_msg_id', 'card_last4'):
            self.assertEqual(corrected[key], cfg[key])
        self.assertEqual(before_watch, {p: p.read_bytes() for p in tracker.WATCHERS.rglob('*') if p.is_file()})
        logs = [json.loads(line) for path in (self.base / 'logs').rglob('*.ndjson') for line in path.read_text().splitlines()]
        event = next(row for row in logs if row.get('name') == 'track.meta_corrected')
        self.assertEqual(event['props']['oldAmountMinor'], 10317)
        self.assertEqual(event['props']['newAmountMinor'], 6342)

    def test_import_logs_success_error_and_link_without_evidence_text(self):
        self.sibling()
        self.assertEqual(self.import_order('--checkout-order', OTHER)[0], 0)
        self.assertEqual(self.import_order(status='unknown')[0], 1)
        text = '\n'.join(p.read_text() for p in (self.base / 'logs').rglob('*.ndjson'))
        names = {json.loads(line)['name'] for line in text.splitlines()}
        self.assertTrue({'track.import_terminal', 'checkout.sibling_link'} <= names)
        self.assertNotIn('Fixture delivery email', text)

    def test_stale_retirement_and_registration_preserve_metadata_corrections(self):
        original = self.sibling(archived=True, active=True)
        # The check already read its config before set-meta commits. Its eventual
        # retirement must still commit active=False without restoring that basket.
        path = checkout.config_path(tracker, OTHER)
        self.items.write_text(json.dumps([{'name': 'Fixture Root', 'qty': 1, 'price': 63.42}]))
        self.assertEqual(self.invoke('set-meta', '--app', 'amazon', '--order', OTHER, '--amount', '63.42',
                                     '--items-file', str(self.items))[0], 0)
        corrected = tracker.read(path)
        tracker.retire(original, path)
        retired = tracker.read(path)
        self.assertFalse(retired['active'])
        for key in ('metadata_revision', 'amount', 'total', 'currency', 'placed_items', 'card_meta'):
            self.assertEqual(retired[key], corrected[key])
        # Also cover an old snapshot that had an earlier correction revision.
        self.assertEqual(self.invoke('set-meta', '--app', 'amazon', '--order', OTHER, '--amount', '63.40',
                                     '--items-file', str(self.items))[0], 0)
        tracker.write_order(path, corrected)
        self.assertEqual(tracker.read(path)['amount'], '63.40')
        # A deliberate new update based on the latest revision remains writable.
        current = tracker.read(path)
        current['amount'] = '63.41'
        tracker.write_order(path, current)
        self.assertEqual(tracker.read(path)['amount'], '63.41')
        stale = tracker.read(path)
        self.assertEqual(self.invoke('set-meta', '--app', 'amazon', '--order', OTHER, '--amount', '63.40',
                                     '--items-file', str(self.items))[0], 0)
        restored = tracker.read(path)
        self.assertNotEqual(restored['metadata_revision'], stale['metadata_revision'])
        tracker.retire(stale, path)
        self.assertFalse(tracker.read(path)['active'])
        for key in ('metadata_revision', 'amount', 'total', 'currency', 'placed_items', 'card_meta'):
            self.assertEqual(tracker.read(path)[key], restored[key])

    def test_invalid_amount_item_and_timestamp_forms_refuse(self):
        for amount in ('NaN', 'Infinity', '-1', '0', '1.001', 'AED 39.75', 'abc'):
            with self.subTest(amount=amount):
                self.assertEqual(self.import_order('--amount', amount)[0], 1)
        for rows in ([], {}, [None], [{'qty': 1}], [{'name': 'Tea', 'qty': 0}],
                     [{'name': 'Tea', 'qty': -1}], [{'name': 'Tea', 'qty': 1.5}]):
            with self.subTest(rows=rows):
                self.items.write_text(json.dumps(rows))
                self.assertEqual(self.import_order()[0], 1)
        for at in ('2026-10-06T20:57:00', 'invalid', '2026-10-05T20:57:00+04:00'):
            with self.subTest(at=at):
                self.assertEqual(self.import_order('--at', at)[0], 1)
        self.assertFalse(checkout.config_path(tracker, OID).exists())


if __name__ == '__main__':
    unittest.main()
