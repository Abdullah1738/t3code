"""A split checkout must never disappear behind the first registered order."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import amazon_checkout as checkout
import amazon_email_orders as mail
import delivery_cards
import order_receipts
import order_tracker as tracker
from test_amazon_email_orders import OID, OTHER, OBSERVED, confirmation, parse


def split_confirmation():
    # Same Order # / edit-link / product / quantity / price / Total sections
    # as Amazon's combined confirmation, with synthetic identities and products.
    first = confirmation(items=(('Fixture Tea', 1),)).decode()
    second = confirmation(items=(('Fixture Root', 1),), oid=OTHER).decode()
    from email import message_from_string
    from email.message import EmailMessage
    body = message_from_string(first).get_payload(decode=True).decode()
    body += 'Order #' + message_from_string(second).get_payload(decode=True).decode().split('Order #', 1)[1]
    result = EmailMessage()
    result['From'] = 'Amazon <auto-confirm@amazon.ae>'
    result['Subject'] = 'Ordered: Fixture Tea and 1 more item'
    result['Date'] = 'Tue, 06 Oct 2026 08:39:37 +0400'
    result.set_content(body)
    return result.as_bytes()


class SplitCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.events = parse(split_confirmation())
        self.mail = {**mail.aggregate_order(OID, self.events), 'errors': []}
        self.group = self.mail['checkout']
        for obj, name, value in [(tracker, 'ROOT', self.root / 'state'),
                                 (tracker, 'WATCHERS', self.root / 'watchers'),
                                 (delivery_cards, 'ROOT', self.root / 'state'),
                                 (delivery_cards, 'APPS', self.root / 'apps')]:
            p = patch.object(obj, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.dict(os.environ, {'TOOLLOG_ROOT': str(self.root / 'logs'),
                                    'ROBOB_TOOL_LOG_DIR': str(self.root / 'logs'), 'ORDER_WATCH_CHAT': ''})
        p.start()
        self.addCleanup(p.stop)
        for p in [patch.object(mail, 'track', return_value=self.mail),
                  patch.object(tracker, 'run', side_effect=self.fake_run),
                  patch.object(tracker, 'cwd_chat', return_value=None),
                  patch.object(tracker, 'known_chat', return_value=True),
                  patch.object(tracker.store, 'reconcile', return_value={})]:
            p.start()
            self.addCleanup(p.stop)
        self.cards = []

    def fake_run(self, args, timeout=12):
        self.assertEqual(args[:2], ['robob-watch', 'add'])
        wid = args[args.index('--id') + 1]
        folder = tracker.WATCHERS / wid
        tracker.write(folder / 'watcher.json', {'id': wid, 'check': 'fixture', 'interval_s': 300})
        tracker.write(folder / 'state.json', {'status': 'active'})
        tracker.write(folder / 'order-tracker-state.json', {
            'status': 'placed', 'last_result': {'status': 'placed', 'whole_order_complete': False}})
        return 'registered'

    def add(self, *ids, chat_args=()):
        args = ['add', '--app', 'amazon', '--for', 'moni', '--card', '2342',
                '--placed-at', '2026-10-06T08:39:00+04:00', *chat_args]
        for oid in ids:
            args += ['--order', oid]
        def sync(cfg, data, **kwargs):
            if cfg['order'] != cfg['checkout_leader']:
                return delivery_cards.sync(cfg, data, **kwargs)
            view, combined = checkout.card_view(cfg, data)
            self.cards.append((view, combined))
            return {'status': 'sent', 'rendered': True}
        with patch.object(delivery_cards, 'safe_sync', side_effect=sync), contextlib.redirect_stdout(io.StringIO()):
            return tracker.main(args)

    def cfg(self, oid):
        return tracker.read(checkout.config_path(tracker, oid))

    def test_confirmation_preserves_every_order_and_its_own_details(self):
        self.assertEqual({e['order_id'] for e in self.events}, {OID, OTHER})
        self.assertTrue(self.group['complete'])
        rows = {r['order']: r for r in self.group['orders']}
        self.assertEqual(rows[OID]['items'][0]['name'], 'Fixture Tea')
        self.assertEqual(rows[OTHER]['items'][0]['name'], 'Fixture Root')
        self.assertEqual(rows[OID]['amount'], '10.00')

    def test_explicit_and_single_id_registration_enroll_whole_checkout_once(self):
        self.assertEqual(self.add(OID, OTHER), 0)
        self.assertEqual(len(self.cards), 1)
        self.assertEqual(self.cards[0][0]['amount'], '20.00')
        for oid in (OID, OTHER):
            cfg = self.cfg(oid)
            self.assertEqual(cfg['siblings'], sorted([OID, OTHER]))
            self.assertEqual(cfg['amount'], '10.00')
            self.assertEqual(len(cfg['card_meta']['items']), 1)
            self.assertEqual(cfg['card_last4'], '2342')
        self.assertTrue(order_receipts.can_report(OID)['ok'])

    def test_first_id_alone_cannot_drop_its_sibling(self):
        self.add(OTHER)
        self.assertTrue(self.cfg(OID))
        self.assertTrue(self.cfg(OTHER))
        self.assertEqual(len(self.cards), 1)

    def test_registration_resolves_every_chat_input_once_for_all_members(self):
        cases = [
            ('default', (), '', None, True, 'moni'),
            ('explicit', ('--chat', 'group-explicit'), 'group-env', 'group-cwd', True, 'group-explicit'),
            ('alias', ('--card-chat=group-explicit',), 'group-env', 'group-cwd', True, 'group-explicit'),
            ('environment', (), 'group-env', 'group-cwd', True, 'group-env'),
            ('directory', (), '', 'group-cwd', True, 'group-cwd'),
            ('unknown explicit', ('--chat', 'group-unknown'), 'group-env', 'group-cwd', False, 'moni'),
            ('unknown environment', (), 'group-unknown', 'group-cwd', False, 'moni'),
            ('unknown directory', (), '', 'group-unknown', False, 'moni'),
        ]
        for label, flags, env_chat, cwd_chat, known, expected in cases:
            with self.subTest(source=label), \
                    patch.dict(os.environ, {'ORDER_WATCH_CHAT': env_chat}), \
                    patch.object(tracker, 'cwd_chat', return_value=cwd_chat), \
                    patch.object(tracker, 'known_chat', return_value=known):
                self.assertEqual(self.add(OID, chat_args=flags), 0)
                self.assertEqual([self.cfg(oid)['chat'] for oid in (OID, OTHER)], [expected, expected])
            for oid in (OID, OTHER):
                checkout.config_path(tracker, oid).unlink()

    def test_retry_preserves_existing_chat_against_ambient_environment_and_directory(self):
        self.add(OID)
        for env_chat, cwd_chat in [('group-env', None), ('', 'group-cwd')]:
            with self.subTest(environment=env_chat, directory=cwd_chat):
                checkout.config_path(tracker, OTHER).unlink()
                with patch.dict(os.environ, {'ORDER_WATCH_CHAT': env_chat}), \
                        patch.object(tracker, 'cwd_chat', return_value=cwd_chat):
                    self.assertEqual(self.add(OID), 0)
                self.assertEqual([self.cfg(oid)['chat'] for oid in (OID, OTHER)], ['moni', 'moni'])
                self.assertTrue(order_receipts.can_report(OID)['ok'])

    def test_chat_conflicts_and_unavailable_existing_chat_refuse_before_registration(self):
        self.add(OID)
        for label, original_chat, sibling_chat, flags, known in [
            ('explicit conflict', 'moni', None, ('--chat', 'group-other'), True),
            ('stored conflict', 'moni', 'group-other', (), True),
            ('unavailable existing', 'group-old', None, (), False),
        ]:
            with self.subTest(case=label):
                original = self.cfg(OID)
                original['chat'] = original_chat
                tracker.write(checkout.config_path(tracker, OID), original)
                if sibling_chat:
                    sibling = {**original, 'order': OTHER, 'chat': sibling_chat}
                    tracker.write(checkout.config_path(tracker, OTHER), sibling)
                elif checkout.config_path(tracker, OTHER).exists():
                    checkout.config_path(tracker, OTHER).unlink()
                with patch.object(tracker, 'known_chat', return_value=known), \
                        patch.object(tracker, 'run', side_effect=AssertionError('no partial registration')), \
                        self.assertRaisesRegex(ValueError, 'conflict|unavailable'):
                    self.add(OID, chat_args=flags)
                self.assertEqual(self.cfg(OID), original)

    def test_success_gate_names_missing_sibling_without_auto_add(self):
        self.add(OID)
        checkout.config_path(tracker, OTHER).unlink()
        result = order_receipts.can_report(OID)
        self.assertFalse(result['ok'])
        self.assertEqual(result['missing_orders'], [OTHER])
        self.assertIn(OTHER, result['reason'])
        self.assertFalse(checkout.config_path(tracker, OTHER).exists())

    def test_completion_requires_every_member_and_preserves_order_proof(self):
        self.add(OID)
        cfg = self.cfg(OID)
        delivered = {'status': 'delivered', 'whole_order_complete': True}
        self.assertFalse(checkout.summary(tracker, cfg, delivered)[1]['checkout_terminal'])
        folder = tracker.WATCHERS / self.cfg(OTHER)['watcher']
        tracker.write(folder / 'order-tracker-state.json', {'status': 'delivered', 'last_result': delivered})
        view, result = checkout.card_view(cfg, delivered)
        self.assertTrue(result['whole_order_complete'])
        self.assertEqual(result['status'], 'delivered')
        self.assertEqual(cfg['amount'], '10.00')

    def test_auto_add_and_link_send_nothing(self):
        self.add(OID)
        checkout.config_path(tracker, OTHER).unlink()
        cfg = self.cfg(OID)
        with patch.dict(os.environ, {'WATCH_DIR': str(tracker.WATCHERS / cfg['watcher'])}), \
                patch.object(delivery_cards, 'safe_sync', return_value={'status': 'skipped'}) as sync, \
                patch.object(tracker, 'notify_placement', side_effect=AssertionError('no text')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            checkout.discover(tracker, cfg, self.mail)
        self.assertEqual(output.getvalue(), '')
        self.assertTrue(self.cfg(OTHER)['delivery_card']['skip_send'])
        for call in sync.call_args_list:
            self.assertTrue(call.args[0]['delivery_card']['skip_send'])
        self.assertEqual(len(self.cards), 1)

    def test_archived_terminal_sibling_still_completes_and_passes_gate(self):
        self.add(OID)
        sibling = self.cfg(OTHER)
        folder = tracker.WATCHERS / sibling['watcher']
        delivered = {'status': 'delivered', 'whole_order_complete': True}
        tracker.write(folder / 'order-tracker-state.json', {'status': 'delivered', 'last_result': delivered})
        archive = tracker.WATCHERS.parent / 'archive'
        target = archive / (sibling['watcher'] + '-123456')
        target.parent.mkdir(parents=True, exist_ok=True)
        folder.rename(target)
        tracker.write(archive / 'retired' / (sibling['watcher'] + '.json'), {'archived': str(target)})
        sibling['active'] = False
        tracker.write(checkout.config_path(tracker, OTHER), sibling)
        self.assertTrue(checkout.summary(tracker, self.cfg(OID), delivered)[1]['checkout_terminal'])
        self.assertTrue(order_receipts.can_report(OID)['ok'])

    def test_checkout_summary_has_no_shared_writes_to_race(self):
        self.add(OID)
        from concurrent.futures import ThreadPoolExecutor
        with patch.object(tracker, 'write', side_effect=AssertionError('summary is derived, never written')):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda oid: checkout.summary(tracker, self.cfg(oid)), [OID, OTHER]))
        self.assertFalse(any(result[1]['checkout_terminal'] for result in results))

    def test_link_preserves_a_removal_and_new_notice_committed_after_discovery_read(self):
        self.add(OID)
        old = self.cfg(OID)
        latest = {**old, 'active': False, 'chat': 'group-test', 'placed_notice': {'status': 'sent', 'at': 'new'},
                  'delivery_card': {'skip_send': True}}
        tracker.write(checkout.config_path(tracker, OID), latest)
        linked = checkout.link_order(tracker, old['order'], self.group)
        self.assertFalse(linked['active'])
        self.assertEqual(linked['chat'], latest['chat'])
        self.assertEqual(linked['placed_notice'], latest['placed_notice'])
        self.assertEqual(linked['delivery_card'], latest['delivery_card'])
        self.assertEqual(linked['siblings'], self.group['order_ids'])

    def test_scratch_discovery_has_no_registration_side_effects(self):
        self.add(OID)
        checkout.config_path(tracker, OTHER).unlink()
        with patch.dict(os.environ, {'WATCH_DIR': str(self.root / 'scratch')}), \
                patch.object(tracker, 'main', side_effect=AssertionError('scratch may not register')):
            checkout.discover(tracker, self.cfg(OID), self.mail)
        self.assertFalse(self.cfg(OTHER))

    def test_incomplete_confirmation_fails_closed(self):
        self.add(OID)
        self.mail['checkout']['complete'] = False
        self.assertFalse(order_receipts.can_report(OID)['ok'])

    def test_registration_and_discovery_log_links_auto_add_and_mismatch(self):
        with patch.object(checkout.toollog, 'emit') as emit:
            self.add(OID)
            cfg = self.cfg(OID)
            checkout.config_path(tracker, OTHER).unlink()
            with patch.dict(os.environ, {'WATCH_DIR': str(tracker.WATCHERS / cfg['watcher'])}), \
                    patch.object(delivery_cards, 'safe_sync', return_value={'status': 'skipped'}), \
                    contextlib.redirect_stdout(io.StringIO()):
                checkout.discover(tracker, cfg, self.mail)
            checkout.config_path(tracker, OTHER).unlink()
            order_receipts.can_report(OID)
        names = [call.args[1] for call in emit.call_args_list]
        self.assertIn('track.add', names)
        self.assertIn('track.checkout_link', names)
        self.assertIn('track.checkout_auto_add', names)
        self.assertIn('track.checkout_mismatch', names)


if __name__ == '__main__':
    unittest.main()
