import datetime as dt
import io
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import delivery_cards as cards
import delivery_store as store
import order_identity as identity
import order_tracker as tracker


class WebTrackerTest(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parents[3] / 'tmp'
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = time.time()
        self.cfg = {'app': 'web', 'order': '2606', 'merchant_domain': 'fabrique.ae',
                    'merchant_name': 'Fabrique', 'for': 'owner',
                    'placed_at': tracker.stamp(self.now - 3600), 'registered_at': tracker.stamp(self.now - 3600),
                    'watcher': identity.tracker_id('web', '2606', 'fabrique.ae'), 'eta': None}
        for obj, key, value in ((tracker, 'ROOT', self.root / 'state'),
                                (tracker, 'WATCHERS', self.root / 'watchers'),
                                (store, 'ROOT', self.root / 'state'),
                                (cards, 'ROOT', self.root / 'state'),
                                (cards, 'APPS', self.root / 'apps')):
            patch = mock.patch.object(obj, key, value)
            patch.start()
            self.addCleanup(patch.stop)

    def hit(self, subject='Order #2606 has been delivered', **overrides):
        return {'account': 'icloud', 'folder': 'Inbox', 'uid': 1,
                'from': 'Fabrique <orders@fabrique.ae>', 'subject': subject,
                'date': tracker.stamp(self.now - 60), **overrides}

    def mail(self, hits):
        return mock.patch.object(tracker.subprocess, 'run', return_value=mock.Mock(
            stdout=json.dumps({'status': {'gmail': {'ok': True}}, 'hits': hits}), returncode=0))

    def cli(self, *args):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return tracker.main(list(args))

    def test_domain_and_order_input_class(self):
        for value in ('fabrique.ae', 'mail.fabrique.ae', 'a-b.shop', 'xn--bcher-kva.de'):
            with self.subTest(domain=value):
                self.assertEqual(identity.merchant_domain(value), value)
        for value in ('', 'fabrique', 'Fabrique.ae', 'https://fabrique.ae', 'fabrique.ae/path',
                      'orders@fabrique.ae', '.fabrique.ae', 'fabrique.ae.', 'fabrique..ae',
                      '-fabrique.ae', 'fabrique-.ae', 'a' * 64 + '.ae', '127.0.0.1', 'fabrique.ae\n'):
            with self.subTest(domain=value), self.assertRaises(ValueError):
                identity.merchant_domain(value)
        for value, expected in (('#2606', '2606'), ('2606', '2606'), ('#A_b-1', 'A_b-1'), ('a' * 40, 'a' * 40)):
            self.assertEqual(identity.order_id('web', value), expected)
        for value in ('#', '##2606', 'a' * 41, '2606/2', ' 2606', '2606\n'):
            with self.subTest(order=value), self.assertRaises(ValueError):
                identity.order_id('web', value)
        self.assertEqual(identity.order_id('noon', 'a' * 80), 'a' * 80)
        with self.assertRaises(ValueError):
            identity.order_id('noon', '#2606')

    def test_registration_stores_domain_name_and_domain_bound_callbacks(self):
        calls = []

        def run(args, timeout=12):
            calls.append(args)
            if args[:2] == ['robob-watch', 'add']:
                wid = args[args.index('--id') + 1]
                tracker.write(tracker.WATCHERS / wid / 'watcher.json', {'check': args[args.index('--check') + 1]})
            return '{}'

        with mock.patch.object(tracker, 'run', side_effect=run), \
                mock.patch.object(cards, 'safe_sync', return_value={'status': 'skipped'}) as sync:
            for domain, name in (('fabrique.ae', 'Fabrique'), ('another.shop', 'Another Shop')):
                self.assertEqual(self.cli('add', '--app', 'web', '--order', '#2606',
                                          '--merchant-domain', domain, '--merchant-name', name,
                                          '--for', 'moni', '--no-card-send'), 0)
                wid = identity.tracker_id('web', '2606', domain)
                cfg = tracker.read(tracker.ROOT / 'orders' / (wid + '.json'))
                self.assertEqual((cfg['order'], cfg['merchant_domain'], cfg['merchant_name'], cfg['vertical']),
                                 ('2606', domain, name, 'web'))
                watcher = tracker.read(tracker.WATCHERS / wid / 'watcher.json')
                for key in ('check', 'pending_check'):
                    command = shlex.split(watcher[key])
                    self.assertEqual(command[command.index('--merchant-domain') + 1], domain)
                # Re-add can enrich metadata without rewriting the trusted identity.
                self.cli('add', '--app', 'web', '--order', '2606', '--merchant-domain', domain, '--no-card-send')
                self.assertEqual(sync.call_args.args[0]['merchant_name'], name)
                self.cli('remove', '--app', 'web', '--order', '#2606', '--merchant-domain', domain)
                self.assertFalse(tracker.read(tracker.ROOT / 'orders' / (wid + '.json'))['active'])
        self.assertEqual(len(list((tracker.ROOT / 'orders').glob('*.json'))), 2)
        with self.assertRaises(SystemExit):
            self.cli('add', '--app', 'web', '--order', '2606', '--merchant-domain', 'third.shop')

    def test_sender_domain_boundary(self):
        for sender, trusted in (('x@fabrique.ae', True), ('Name <x@mail.fabrique.ae>', True),
                                 ('x@FABRIQUE.AE', True), ('x@evil-fabrique.ae', False),
                                 ('x@fabrique.ae.attacker.test', False), ('Fabrique <x@other.shop>', False)):
            with self.subTest(sender=sender), self.mail([self.hit(**{'from': sender})]), \
                    mock.patch.object(tracker, 'run') as read:
                evidence, errors = tracker.mail_evidence(self.cfg)
                self.assertEqual(bool(evidence), trusted)
                read.assert_not_called()

    def test_stale_missing_invalid_future_dates_cannot_close_new_order(self):
        for value in (tracker.stamp(self.now - 7200), None, '', 'bad-date',
                      tracker.stamp(self.now + 3600), '2026-11-13T12:00:00'):
            with self.subTest(date=value), self.mail([self.hit(date=value)]):
                result = tracker.fetch(self.cfg, {}, self.now)
                self.assertEqual(result['status'], 'unknown')
        for value in (tracker.stamp(self.now - 60),
                      dt.datetime.fromtimestamp(self.now - 60).astimezone().strftime('%Y-%m-%d %H:%M'),
                      dt.datetime.fromtimestamp(self.now - 60, dt.timezone.utc).strftime('%a, %d %b %Y %H:%M:%S +0000')):
            with self.subTest(date=value), self.mail([self.hit(date=value)]):
                self.assertEqual(tracker.fetch(self.cfg, {}, self.now)['status'], 'delivered')

    def test_subject_and_body_ids_require_whole_web_order_number(self):
        for other in ('12606', '26060', '2606-2', 'A_2606', '2606_extra'):
            with self.subTest(other=other), self.mail([self.hit(subject='Order ' + other + ' has been delivered')]), \
                    mock.patch.object(tracker, 'run', return_value='Order ' + other):
                self.assertEqual(tracker.mail_evidence(self.cfg)[0], [])

    def test_body_is_verified_cached_and_never_persisted_or_printed(self):
        state = {}
        with self.mail([self.hit(subject='Your order has been delivered')]), \
                mock.patch.object(tracker, 'run', return_value='Private customer detail. Order #2606. secret marker') as read:
            result = tracker.fetch(self.cfg, state, self.now)
            tracker.fetch(self.cfg, state, self.now + 301)
            self.assertEqual(read.call_count, 1)
        self.assertEqual(result['status'], 'delivered')
        serialized = json.dumps([result, state])
        for private in ('Private customer detail', 'secret marker', 'Your order has been delivered'):
            self.assertNotIn(private, serialized)
        self.assertEqual(state['mail_bodies_verified'], {'icloud:Inbox:1': True})

    def test_web_stages_and_promises(self):
        rows = [('Thanks for your order #2606', 'ordered'), ('Order #2606 confirmed', 'ordered'),
                ('Order confirmation #2606', 'ordered'), ('Order shipped #2606', 'shipped'),
                ('Order #2606 shipped', 'shipped'), ('Shipment #2606: shipped', 'shipped'),
                ('Your order #2606 has shipped', 'shipped'), ('Your order has been dispatched #2606', 'shipped'),
                ('Shipped: #2606', 'shipped'), ('Order #2606 is out for delivery', 'out for delivery'),
                ('Order #2606 has been delivered', 'delivered'), ('Order #2606 cancelled', 'cancelled'),
                ('Order #2606 will be delivered tomorrow', 'unknown'), ('Order #2606 will be shipped tomorrow', 'unknown')]
        for subject, expected in rows:
            with self.subTest(subject=subject), self.mail([self.hit(subject=subject)]), \
                    mock.patch('native_orders.track', side_effect=AssertionError('native called')), \
                    mock.patch.object(store, 'evidence', side_effect=AssertionError('pushes called')):
                self.assertEqual(tracker.fetch(self.cfg, {}, self.now)['status'], expected)
        self.assertEqual(tracker.classify('Thanks for your order #2606'), 'placed')
        self.assertEqual(tracker.classify('Order shipped #2606'), 'unknown')

    def test_cancellation_tense_and_negation_class(self):
        rows = [('Order #2606 has been cancelled', 'cancelled'),
                ('Order #2606 was canceled', 'cancelled'), ('Order #2606 cancelled', 'cancelled'),
                ('Order #2606 will be cancelled tomorrow', 'unknown'),
                ('Order #2606 may be canceled', 'unknown'), ('Order #2606 might get cancelled', 'unknown'),
                ('Order #2606 is not cancelled', 'unknown'), ('Order #2606 has not been canceled', 'unknown'),
                ('Order #2606 is not yet cancelled', 'unknown'), ('Avoid your order #2606 being cancelled', 'unknown'),
                ('Order #2606 will not be cancelled', 'unknown'), ('Order #2606 could be cancelled', 'unknown'),
                ('If your order #2606 has been cancelled', 'unknown'), ('Cancelled: order #2606', 'cancelled')]
        rows.extend((f'Order {negation} {stage}: #2606', 'unknown')
                    for negation in ('not', 'never', 'not yet', 'has not been')
                    for stage in ('cancelled', 'canceled', 'shipped', 'dispatched', 'confirmed', 'received', 'placed'))
        for subject, expected in rows:
            with self.subTest(subject=subject), self.mail([self.hit(subject=subject)]):
                self.assertEqual(tracker.fetch(self.cfg, {}, self.now)['status'], expected)

    def test_new_failure_supersedes_old_confirmations(self):
        hits = [self.hit(subject='Thanks for your order #2606', uid=uid,
                         date=tracker.stamp(self.now - 600 - uid)) for uid in range(1, 4)]
        hits.append(self.hit(subject='Order #2606 delivery failed', uid=4))
        with self.mail(hits):
            result = tracker.fetch(self.cfg, {}, self.now)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['problem']['stage'], 'problem')
        state = {'primed': True, 'status': 'ordered'}
        self.assertEqual([e['kind'] for e in tracker.transition(result, state, self.cfg, self.now)], ['problem'])
        self.assertEqual(state['status'], 'ordered')

    def test_short_id_in_headers_is_not_order_proof(self):
        cfg = dict(self.cfg, order='13')
        rows = [('From: orders@fabrique.ae\nDate: Fri, 13 Nov 2026 14:30:00 +0000\nSubject: Your order has been delivered\n\nOrder #9999', False),
                ('From: orders@fabrique.ae\nTo: customer13@example.test\nSubject: Your order has been delivered\n\nOrder #13', True),
                ('From: orders@fabrique.ae\nDate: Fri, 13 Nov 2026', False),
                ('Order #13', True)]
        for body, accepted in rows:
            with self.subTest(accepted=accepted, shape=body.split(':', 1)[0]), \
                    self.mail([self.hit(subject='Your order has been delivered')]), \
                    mock.patch.object(tracker, 'run', return_value=body):
                self.assertEqual(bool(tracker.mail_evidence(cfg)[0]), accepted)

    def test_explicit_partial_delivery_class_cannot_close_the_order(self):
        partials = ['The first package of order #2606 has been delivered',
                    'The second shipment of order #2606 has been delivered',
                    'One item from order #2606 has been delivered',
                    'Some items from order #2606 have been successfully delivered',
                    '2 items from order #2606 have been successfully delivered',
                    'Delivered: package 1 of 2 for order #2606',
                    'Delivered: shipment 1/2 for order #2606',
                    'Part of your order #2606 has been delivered',
                    'Order #2606 has been partially delivered',
                    'Order #2606 has been delivered; remaining items arrive tomorrow',
                    'The first package of order #2606 has been delivered - all 2 items',
                    'Only 1 item from your entire order #2606 has been delivered',
                    'Just one item from your entire order #2606 has been delivered',
                    '1 item from your whole order #2606 has been delivered',
                    'Order #2606 has been delivered - not all 2 items',
                    'Order #2606 has been delivered - not yet all 2 items',
                    'Order #2606 has been delivered - not both items',
                    'Order #2606 has been delivered but not in full',
                    'Order #2606 has been delivered except 1 item',
                    'Order #2606 has been delivered - all but 1 item']
        for subject in partials:
            with self.subTest(subject=subject), self.mail([self.hit(subject=subject)]):
                result = tracker.fetch(self.cfg, {}, self.now)
                self.assertEqual(result['status'], 'unknown')
                self.assertFalse(tracker.terminal_order(self.cfg, result))
        for subject in ('Your order #2606 has been delivered', 'Your first order #2606 has been delivered',
                        'Order #2606 has been delivered in full',
                        'Your order #2606 has been delivered - all 2 items',
                        'Your order #2606 has been delivered - all 1 item',
                        'Your order #2606 has been delivered - all 3 packages',
                        'Your order #2606 has been delivered - both items',
                        'Your entire order #2606 has been delivered'):
            with self.subTest(subject=subject), self.mail([self.hit(subject=subject)]):
                self.assertEqual(tracker.fetch(self.cfg, {}, self.now)['status'], 'delivered')

    def test_email_only_fallback_uses_stored_sender_domain(self):
        cfg = dict(self.cfg, **{'for': 'moni'})
        hit = self.hit()
        envelope = {'id': 2, 'from': [{'email': 'updates@mail.fabrique.ae'}],
                    'subject': hit['subject'], 'date': hit['date']}
        with self.mail([]), mock.patch.object(tracker, 'run', return_value=json.dumps({'envelopes': [envelope]})) as run:
            evidence, _ = tracker.mail_evidence(cfg)
        self.assertEqual(evidence[0]['stage'], 'delivered')
        self.assertIn('from fabrique.ae and after', run.call_args.args[0][-1])

    def test_no_email_for_48_hours_reports_once_and_delivery_closes(self):
        now = self.now + 48 * 3600
        state = {'primed': True, 'status': 'ordered'}
        with self.mail([]):
            early = tracker.fetch(self.cfg, state, self.now + 46 * 3600)
            self.assertEqual(tracker.transition(early, state, self.cfg, self.now + 46 * 3600), [])
            result = tracker.fetch(self.cfg, state, now)
            self.assertEqual([e['kind'] for e in tracker.transition(result, state, self.cfg, now)], ['tracking_problem'])
            for days in (1, 2, 5):
                self.assertEqual(tracker.transition(result, state, self.cfg, now + days * 86400), [])
        state = {'primed': True, 'status': 'ordered'}
        with self.mail([self.hit()]):
            result = tracker.fetch(self.cfg, state, self.now)
            self.assertEqual(tracker.transition(result, state, self.cfg, self.now),
                             [{'kind': 'stage_change', 'status': 'delivered'}])
            self.assertTrue(tracker.terminal_order(self.cfg, result))
            self.assertEqual(tracker.transition(result, state, self.cfg, self.now + 60), [])

    def test_card_and_reconciliation_keep_merchants_separate(self):
        other = dict(self.cfg, merchant_domain='another.shop', merchant_name='Another Shop')
        self.assertNotEqual(cards.card_slug(self.cfg), cards.card_slug(other))
        for status, expected in (('ordered', 'Ordered'), ('shipped', 'Shipped'),
                                  ('out for delivery', 'Out for delivery'), ('delivered', 'Delivered'), ('cancelled', 'Cancelled')):
            view = cards.view(self.cfg, {'status': status}, {})
            self.assertEqual((view['vertical'], view['brand'], view['stage']), ('web', 'Fabrique', expected))
            self.assertIsNone(view['eta'])
        store.reconcile(self.cfg, detected=tracker.stamp(self.now))
        self.assertIsNone(store.reconcile(other)['detected'])
        self.assertIsNotNone(store.reconcile(self.cfg)['detected'])
        self.assertEqual(cards.card_slug({'app': 'noon', 'order': 'N123'}), cards.slug('noon', 'N123'))

    def test_missing_search_result_preserves_last_email_time_and_shipped_progress(self):
        cfg = dict(self.cfg, placed_at=tracker.stamp(self.now - 5 * 86400))
        state = {'primed': True, 'status': 'ordered'}
        with self.mail([self.hit(subject='Thanks for your order #2606')]):
            tracker.fetch(cfg, state, self.now)
        with self.mail([]):
            fresh = tracker.fetch(cfg, state, self.now + 301)
            self.assertEqual(fresh['errors'], [])
            late = tracker.fetch(cfg, state, self.now + 49 * 3600)
            self.assertEqual(late['errors'], ['web_email_stalled'])
            state['status'] = 'shipped'
            self.assertEqual(tracker.fetch(cfg, state, self.now + 50 * 3600)['errors'], [])

    def test_large_web_order_waits_for_evidence_and_problem_keys_include_domain(self):
        keys = []
        for domain in ('fabrique.ae', 'another.shop'):
            cfg = dict(self.cfg, merchant_domain=domain, total='AED 500')
            state = {}
            tracker.queue_problem_notices(cfg, {'status': 'unknown', 'errors': []}, state, [], self.now)
            self.assertEqual(state['problem_notices'], {})
            stalled = {'status': 'unknown', 'errors': ['web_email_stalled']}
            tracker.queue_problem_notices(cfg, stalled, state, [], self.now)
            tracker.queue_problem_notices(cfg, stalled, state, [], self.now + 86400)
            self.assertEqual(len(state['problem_notices']), 1)
            keys.extend(state['problem_notices'])
        self.assertEqual(len(set(keys)), 2)

    def test_card_cli_uses_web_identity_and_forwards_domain_on_status_and_retry(self):
        cfg = dict(self.cfg, delivery_card={'ready': True})
        tracker.write(cards.ROOT / 'orders' / (cfg['watcher'] + '.json'), cfg)
        with mock.patch.object(cards.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout='{"status":"shipped"}')) as run, \
                mock.patch.object(cards, 'build', return_value={'stage': 'Shipped'}) as build, \
                mock.patch.object(cards, 'safe_sync', return_value={'status': 'sent'}) as sync, redirect_stdout(io.StringIO()):
            cards.main(['--app', 'web', '--order', '#2606', '--merchant-domain', 'fabrique.ae', '--send'])
        args = run.call_args.args[0]
        self.assertEqual(args[args.index('--merchant-domain') + 1], 'fabrique.ae')
        self.assertEqual(build.call_args.args[0]['merchant_name'], 'Fabrique')
        self.assertEqual(sync.call_args.args[0]['watcher'], cfg['watcher'])

    def test_check_delivery_event_and_retirement_without_native_reads(self):
        folder = tracker.WATCHERS / self.cfg['watcher']
        cfgpath = tracker.ROOT / 'orders' / (self.cfg['watcher'] + '.json')
        tracker.write(cfgpath, dict(self.cfg, active=True))
        tracker.write(folder / 'watcher.json', {})
        tracker.write(folder / 'order-tracker-state.json', {'primed': True, 'status': 'ordered'})
        output = io.StringIO()
        with self.mail([self.hit(subject='Your order has been delivered')]), \
                mock.patch.object(tracker, 'run', return_value='Order #2606. secret body marker'), \
                mock.patch.object(cards, 'safe_sync', return_value={'status': 'skipped'}), \
                mock.patch.dict(os.environ, {'WATCH_DIR': str(folder), 'WATCH_RUN': 'scheduled-fixture'}), redirect_stdout(output):
            tracker._check(self.cfg)
            with mock.patch.object(tracker, 'fetch', side_effect=AssertionError('terminal order polled')):
                tracker._check(self.cfg)
        notice = json.loads(output.getvalue())
        self.assertEqual(notice['events'], [{'kind': 'stage_change', 'status': 'delivered'}])
        state = (folder / 'order-tracker-state.json').read_text()
        self.assertNotIn('secret body marker', state + output.getvalue())
        self.assertNotIn('Your order has been delivered', state + output.getvalue())
        self.assertFalse(tracker.read(cfgpath)['active'])


if __name__ == '__main__':
    unittest.main()
