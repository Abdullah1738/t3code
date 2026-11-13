"""Order references and completion scope from synthetic merchant mail only."""
import io
import json
import os
from contextlib import redirect_stdout
from unittest import TestCase, main, mock

from test import test_order_tracker_web as fixtures

tracker = fixtures.tracker


class WebMailProofTests(TestCase):
    def setUp(self):
        self.f = fixtures.WebTrackerTest()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)

    def fetch(self, order, subject, body='', state=None):
        cfg = dict(self.f.cfg, order=order)
        with self.f.mail([self.f.hit(subject=subject)]), mock.patch.object(tracker, 'run', return_value=body):
            result = tracker.fetch(cfg, {} if state is None else state, self.f.now)
        return cfg, result

    def test_incidental_numbers_and_conflicting_order_references(self):
        rows = [
            ('13', 'Order #9999 has been delivered on November 13', ''),
            ('2606', 'Order #9999 has been delivered', 'Order #9999. Total: AED 2606.00'),
            ('2606', 'Your order has been delivered', 'Total: AED 2606.00'),
            ('13', 'Your order has been delivered', 'Arrived on November 13'),
            ('2606', 'Order #2606 has been delivered; order #9999 also updated', ''),
            ('2606', 'Order #2606 has been delivered', 'Order #9999. Total AED 2606'),
            ('2606', 'Your order has been delivered', 'Order #2606 and Order #9999'),
            ('2606', 'Your order has been delivered', 'Order #2606-2'),
        ]
        for order, subject, body in rows:
            with self.subTest(order=order, subject=subject):
                cfg, result = self.fetch(order, subject, body)
                self.assertFalse(tracker.terminal_order(cfg, result))
                self.assertEqual(result['evidence'], [])

    def test_reference_label_and_separator_class(self):
        references = ['Order #2606', 'Order#2606', 'Order 2606', 'Order: 2606',
                      'Order: #2606', 'Order number 2606', 'Order number: 2606',
                      'Order no. 2606', 'Order no: #2606', 'Order ID: 2606',
                      'Order-ID 2606', 'Order reference: 2606', 'Order confirmation #2606']
        for reference in references:
            with self.subTest(reference=reference):
                cfg, result = self.fetch('2606', 'Your order has been delivered', reference)
                self.assertTrue(tracker.terminal_order(cfg, result))
        for order in ('A_b-1', 'RC-1042', 'ABC'):
            cfg, result = self.fetch(order, 'Your order has been delivered', 'Order ID: ' + order)
            self.assertTrue(tracker.terminal_order(cfg, result))

    def test_package_shipment_item_scope_cannot_retire_the_order(self):
        rows = [('Your package has been delivered - Order #2606', 'shipment'),
                ('Your parcel was delivered - Order #2606', 'shipment'),
                ('Shipment cancelled: order #2606', 'shipment'),
                ('Package canceled: order #2606', 'shipment'),
                ('Item delivered: order #2606', 'item')]
        for subject, scope in rows:
            with self.subTest(subject=subject):
                cfg, result = self.fetch('2606', subject)
                self.assertFalse(tracker.terminal_order(cfg, result))
                self.assertEqual(result['partial_evidence'][0]['scope'], scope)
                self.assertFalse(result['whole_order_complete'])
        cfg, result = self.fetch('2606', 'Order #2606 has been delivered',
                                 'Order #2606. Shipment 1 of 2. Remaining shipment arrives tomorrow.')
        self.assertFalse(tracker.terminal_order(cfg, result))

    def test_negated_delivery_class_precedes_success(self):
        for phrase in ('was not successfully delivered', 'has not been successfully delivered',
                       'was never successfully delivered', 'was not delivered',
                       'has not yet been delivered', 'could not be delivered',
                       'delivery was unsuccessful', 'failed to deliver',
                       'was not fully successfully delivered', "couldn't be successfully delivered",
                       "hasn't been successfully delivered", 'has not actually been delivered',
                       'was not able to be successfully delivered'):
            with self.subTest(phrase=phrase):
                cfg, result = self.fetch('2606', 'Order #2606 ' + phrase)
                self.assertFalse(tracker.terminal_order(cfg, result))
                self.assertNotEqual(result['status'], 'delivered')

    def test_numbered_affirmative_delivery_forms_close_once(self):
        for order in ('2606', 'RC-1042'):
            for reference in ('Order #{id} delivered', 'Order {id} delivered',
                              'Order #{id}: delivered', 'Order #{id} - delivered',
                              'Order #{id} was delivered', 'Order #{id} has been delivered',
                              'Order #{id} successfully delivered', 'Order ID: {id} delivered',
                              'Order number {id} delivered', 'Order no. {id}: delivered',
                              'Order reference: {id} delivered', 'Order-ID {id} delivered'):
                subject = reference.format(id=order)
                with self.subTest(subject=subject):
                    cfg, result = self.fetch(order, subject)
                    self.assertEqual(result['status'], 'delivered')
                    self.assertTrue(tracker.terminal_order(cfg, result))
                    state = {'primed': True, 'status': 'ordered'}
                    self.assertEqual(tracker.transition(result, state, cfg, self.f.now),
                                     [{'kind': 'stage_change', 'status': 'delivered'}])
                    self.assertEqual(tracker.transition(result, state, cfg, self.f.now + 60), [])

    def test_legacy_token_only_cache_cannot_supply_new_proof(self):
        state = {'primed': True, 'status': 'ordered', 'mail_checked': self.f.now,
                 'mail_cache': [{'stage': 'delivered', 'scope': 'order', 'confidence': 'exact_order',
                                 'observed_at': tracker.stamp(self.f.now)}],
                 'mail_bodies_verified': {'icloud:Inbox:1': True}}
        cfg, result = self.fetch('2606', 'Your order has been delivered', 'Total AED 2606', state)
        self.assertFalse(tracker.terminal_order(cfg, result))

    def test_terminal_guard_requires_whole_order_evidence(self):
        for status in ('delivered', 'cancelled'):
            cfg = self.f.cfg
            self.assertFalse(tracker.terminal_order(cfg, {'status': status}))
            self.assertFalse(tracker.terminal_order(cfg, {'status': status, 'whole_order_complete': False}))

    def test_cached_package_scope_does_not_become_whole_order_proof(self):
        state = {}
        with self.f.mail([self.f.hit(subject='Your package has been delivered - Order #2606')]), \
                mock.patch.object(tracker, 'run', return_value='Order #2606') as read:
            first = tracker.fetch(self.f.cfg, state, self.f.now)
            second = tracker.fetch(self.f.cfg, state, self.f.now + 301)
        self.assertEqual(read.call_count, 1)
        for result in (first, second):
            self.assertFalse(tracker.terminal_order(self.f.cfg, result))
            self.assertEqual(result['partial_evidence'][0]['scope'], 'shipment')

    def test_unverified_legacy_terminal_is_repolled_before_retirement(self):
        cfg = self.f.cfg
        folder = tracker.WATCHERS / cfg['watcher']
        path = tracker.ROOT / 'orders' / (cfg['watcher'] + '.json')
        tracker.write(path, dict(cfg, active=True))
        tracker.write(folder / 'watcher.json', {})
        tracker.write(folder / 'order-tracker-state.json',
                      {'primed': True, 'status': 'delivered', 'last_result': {'status': 'delivered'}})
        with self.f.mail([self.f.hit(subject='Your order has been delivered')]), \
                mock.patch.object(tracker, 'run', return_value='Total AED 2606'), \
                mock.patch.object(tracker.delivery_cards, 'safe_sync', return_value={'status': 'skipped'}), \
                mock.patch.dict(os.environ, {'WATCH_DIR': str(folder), 'WATCH_RUN': 'scheduled-fixture'}), \
                redirect_stdout(io.StringIO()) as output:
            tracker._check(cfg)
        self.assertTrue(tracker.read(path)['active'])
        self.assertNotEqual(tracker.read(folder / 'order-tracker-state.json').get('status'), 'delivered')
        self.assertEqual(output.getvalue(), '')

    def test_status_keeps_recent_proof_time_but_reads_fresh_mail(self):
        cfg = dict(self.f.cfg, placed_at=tracker.stamp(self.f.now - 5 * 86400))
        tracker.write(tracker.ROOT / 'orders' / (cfg['watcher'] + '.json'), cfg)
        tracker.write(tracker.WATCHERS / cfg['watcher'] / 'order-tracker-state.json',
                      {'status': 'ordered', 'web_proof_version': 2, 'web_mail_last_at': self.f.now - 60,
                       'mail_cache': [{'stage': 'delivered'}], 'mail_checked': self.f.now})
        with self.f.mail([]) as search, redirect_stdout(io.StringIO()) as output:
            tracker.main(['status', '--app', 'web', '--order', '2606', '--merchant-domain', 'fabrique.ae'])
        result = json.loads(output.getvalue())
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['errors'], [])
        self.assertTrue(search.called)

    def test_conditional_and_future_delivery_class_cannot_complete(self):
        for subject in ("We'll notify you when Order #2606 is delivered",
                        'If Order #2606 has been delivered, confirm receipt',
                        'Once Order ID: 2606 is delivered, rate your purchase',
                        'When Order no. 2606 delivered, contact us',
                        'Order #2606 will be successfully delivered tomorrow',
                        'Order #2606 may be successfully delivered today'):
            with self.subTest(subject=subject):
                cfg, result = self.fetch('2606', subject, 'Order #2606')
                self.assertFalse(tracker.terminal_order(cfg, result))

    def test_body_partial_count_labels_and_separators(self):
        rows = ['Shipment: 1 of 2', 'Shipment 1 of 2', 'Shipment #1/2', 'Shipment - 1 / 2',
                'Package: 1 of 2', 'Parcel: 1/2', 'Item: 1 of 2',
                '1 of 2 items has been delivered', '1 / 2 packages delivered']
        for body in rows:
            with self.subTest(shape=body.split()[0]):
                cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606\n' + body)
                self.assertFalse(tracker.terminal_order(cfg, result))

    def test_confirmation_prose_is_not_a_conflicting_order_id(self):
        for prose in ('Your order confirmation is here', 'Your order confirmation is attached',
                      'Your order confirmation for your purchase', 'Order confirmation details follow'):
            with self.subTest(prose=prose):
                _, result = self.fetch('2606', prose, 'Order #2606')
                self.assertEqual(result['status'], 'ordered')
                cfg, result = self.fetch('2606', 'Your order has been delivered', prose + '\nOrder #2606')
                self.assertTrue(tracker.terminal_order(cfg, result))

    def test_absence_of_remaining_items_is_not_partial_scope(self):
        for statement in ('No remaining items.', 'There are no remaining shipments.',
                          '0 remaining packages', 'Zero remaining parcels', 'Remaining items: 0'):
            with self.subTest(statement=statement):
                cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606\n' + statement)
                self.assertTrue(tracker.terminal_order(cfg, result))
        for statement in ('2 remaining items', 'Remaining packages: 2', 'Remaining shipment arrives tomorrow'):
            cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606\n' + statement)
            self.assertFalse(tracker.terminal_order(cfg, result))

    def test_newer_package_mail_cannot_mask_whole_order_proof(self):
        hits = [self.f.hit(subject='Order #2606 delivered', uid=1, date=tracker.stamp(self.f.now - 600))]
        for uid in (2, 3, 4):
            hits.append(self.f.hit(subject='Your package has been delivered - Order #2606', uid=uid))
        with self.f.mail(hits), mock.patch.object(tracker, 'run', return_value='Order #2606'):
            result = tracker.fetch(self.f.cfg, {}, self.f.now)
        self.assertTrue(tracker.terminal_order(self.f.cfg, result))
        self.assertEqual(len(result['partial_evidence']), 3)

    def test_keyword_fragments_inside_order_ids_are_not_status_words(self):
        for order in ('MAY-2606', 'WHEN_2606', 'IF-2606', 'CAN-2606', 'WILL-2606',
                      'SHIPMENT-2606', 'PACKAGE-2606', 'ITEM-2606', 'MAY'):
            with self.subTest(order=order):
                cfg, result = self.fetch(order, f'Order #{order} delivered')
                self.assertTrue(tracker.terminal_order(cfg, result))
                cfg, result = self.fetch(order, f'Order #{order} may be successfully delivered')
                self.assertFalse(tracker.terminal_order(cfg, result))

    def test_complete_plural_inventory_counts_and_singular_indexes(self):
        for label in ('Items', 'Packages', 'Parcels', 'Shipments'):
            for separator in (': ', ' #', ' - ', ' '):
                with self.subTest(label=label, separator=separator):
                    cfg, result = self.fetch('2606', 'Order #2606 delivered - all 2 items',
                                             f'Order #2606\n{label}{separator}2 of 2')
                    self.assertTrue(tracker.terminal_order(cfg, result))
                    cfg, result = self.fetch('2606', 'Order #2606 delivered',
                                             f'Order #2606\n{label}{separator}1 of 2')
                    self.assertFalse(tracker.terminal_order(cfg, result))
        for label in ('Item', 'Package', 'Parcel', 'Shipment'):
            cfg, result = self.fetch('2606', 'Order #2606 delivered', f'Order #2606\n{label}: 2 of 2')
            self.assertFalse(tracker.terminal_order(cfg, result))

    def test_new_scoped_failure_remains_visible_beside_order_confirmation(self):
        for kind in ('package', 'parcel', 'shipment', 'item'):
            hits = [self.f.hit(subject='Order #2606 confirmed', uid=1, date=tracker.stamp(self.f.now - 600)),
                    self.f.hit(subject=f'Your {kind} delivery failed - Order #2606', uid=2)]
            with self.subTest(kind=kind), self.f.mail(hits), mock.patch.object(tracker, 'run', return_value='Order #2606'):
                result = tracker.fetch(self.f.cfg, {}, self.f.now)
            self.assertEqual(result['problem']['stage'], 'problem')
            state = {'primed': True, 'status': 'ordered'}
            self.assertIn('problem', [e['kind'] for e in tracker.transition(result, state, self.f.cfg, self.f.now)])
            self.assertEqual(tracker.transition(result, state, self.f.cfg, self.f.now + 60), [])

    def test_partial_check_keeps_watcher_and_later_whole_delivery_retires(self):
        cfg = self.f.cfg
        folder = tracker.WATCHERS / cfg['watcher']
        path = tracker.ROOT / 'orders' / (cfg['watcher'] + '.json')
        tracker.write(path, dict(cfg, active=True))
        tracker.write(folder / 'watcher.json', {})
        tracker.write(folder / 'order-tracker-state.json', {'primed': True, 'status': 'ordered'})
        with mock.patch.object(tracker.delivery_cards, 'safe_sync', return_value={'status': 'skipped'}), \
                mock.patch.dict(os.environ, {'WATCH_DIR': str(folder), 'WATCH_RUN': 'scheduled-fixture'}), \
                mock.patch.object(tracker, 'run', return_value='Order #2606') as read, \
                redirect_stdout(io.StringIO()):
            with self.f.mail([self.f.hit(subject='Your package has been delivered - Order #2606')]):
                tracker._check(cfg)
                tracker._check(cfg)
            self.assertTrue(tracker.read(path)['active'])
            state = tracker.read(folder / 'order-tracker-state.json')
            state['mail_checked'] = 0
            tracker.write(folder / 'order-tracker-state.json', state)
            with self.f.mail([self.f.hit(subject='Order #2606 delivered', uid=2)]):
                tracker._check(cfg)
                tracker._check(cfg)
            self.assertFalse(tracker.read(path)['active'])
        self.assertNotIn('Your package', json.dumps(tracker.read(folder / 'order-tracker-state.json')))


if __name__ == '__main__':
    main()
