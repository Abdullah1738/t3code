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

    def assert_arrival_notice(self, cfg, result):
        self.assertFalse(tracker.terminal_order(cfg, result))
        self.assertFalse(result['whole_order_complete'])
        self.assertNotIn(result['status'], tracker.TERMINAL)
        self.assertTrue(any(p['stage'] == 'delivered' for p in result['partial_evidence']))

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
                self.assertEqual(result['partial_evidence'], [])

    def test_reference_label_and_separator_class(self):
        references = ['Order #2606', 'Order#2606', 'Order 2606', 'Order: 2606',
                      'Order: #2606', 'Order number 2606', 'Order number: 2606',
                      'Order no. 2606', 'Order no: #2606', 'Order ID: 2606',
                      'Order-ID 2606', 'Order reference: 2606', 'Order confirmation #2606']
        for reference in references:
            with self.subTest(reference=reference):
                cfg, result = self.fetch('2606', 'Your order has been delivered', reference)
                self.assert_arrival_notice(cfg, result)
        for order in ('A_b-1', 'RC-1042', 'ABC'):
            cfg, result = self.fetch(order, 'Your order has been delivered', 'Order ID: ' + order)
            self.assert_arrival_notice(cfg, result)

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

    def test_numbered_affirmative_delivery_forms_notify_once_without_closing(self):
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
                    self.assert_arrival_notice(cfg, result)
                    state = {'primed': True, 'status': 'ordered'}
                    self.assertEqual([e['kind'] for e in tracker.transition(result, state, cfg, self.f.now)],
                                     ['shipment_delivered'])
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
                      {'status': 'ordered', 'web_proof_version': tracker.WEB_PROOF_VERSION, 'web_mail_last_at': self.f.now - 60,
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
                self.assert_arrival_notice(cfg, result)

    def test_absence_of_remaining_items_also_fails_closed(self):
        for statement in ('No remaining items.', 'There are no remaining shipments.',
                          '0 remaining packages', 'Zero remaining parcels', 'Remaining items: 0'):
            with self.subTest(statement=statement):
                cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606\n' + statement)
                self.assertFalse(tracker.terminal_order(cfg, result))
        for statement in ('2 remaining items', 'Remaining packages: 2', 'Remaining shipment arrives tomorrow'):
            cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606\n' + statement)
            self.assertFalse(tracker.terminal_order(cfg, result))

    def test_full_order_and_newer_package_mail_both_remain_scoped(self):
        hits = [self.f.hit(subject='Order #2606 delivered', uid=1, date=tracker.stamp(self.f.now - 600))]
        for uid in (2, 3, 4):
            hits.append(self.f.hit(subject='Your package has been delivered - Order #2606', uid=uid))
        with self.f.mail(hits), mock.patch.object(tracker, 'run', return_value='Order #2606'):
            result = tracker.fetch(self.f.cfg, {}, self.f.now)
        self.assert_arrival_notice(self.f.cfg, result)
        self.assertEqual(len(result['partial_evidence']), 4)

    def test_keyword_fragments_inside_order_ids_are_not_status_words(self):
        for order in ('MAY-2606', 'WHEN_2606', 'IF-2606', 'CAN-2606', 'WILL-2606',
                      'SHIPMENT-2606', 'PACKAGE-2606', 'ITEM-2606', 'MAY'):
            with self.subTest(order=order):
                cfg, result = self.fetch(order, f'Order #{order} delivered')
                self.assert_arrival_notice(cfg, result)
                cfg, result = self.fetch(order, f'Order #{order} may be successfully delivered')
                self.assertFalse(tracker.terminal_order(cfg, result))

    def test_complete_plural_inventory_counts_and_singular_indexes(self):
        for label in ('Items', 'Packages', 'Parcels', 'Shipments'):
            for separator in (': ', ' #', ' - ', ' '):
                with self.subTest(label=label, separator=separator):
                    cfg, result = self.fetch('2606', 'Order #2606 delivered - all 2 items',
                                             f'Order #2606\n{label}{separator}2 of 2')
                    self.assert_arrival_notice(cfg, result)
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

    def test_explicit_partial_delivery_statements_in_body_keep_order_open(self):
        partials = ['This is a partial delivery; the rest will follow.',
                    'Your delivery is partial.', 'The order remains partial.',
                    'Your order has been partially delivered.', 'The order was partially delivered.',
                    'Partial delivery: more to follow.', 'Partially delivered; the rest will follow.',
                    'The rest will follow.', 'The remainder is still in transit.']
        for statement in partials:
            with self.subTest(statement=statement):
                cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606. ' + statement)
                self.assertFalse(tracker.terminal_order(cfg, result))
                self.assertFalse(result['whole_order_complete'])
        for statement in ('This is not a partial delivery.', 'Your delivery is not partial.',
                          'Your entire order has been delivered.', 'No remaining items.'):
            with self.subTest(statement=statement):
                cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606. ' + statement)
                self.assert_arrival_notice(cfg, result)

    def test_worded_and_mixed_partial_counts_in_body(self):
        for unit in ('items', 'packages', 'parcels', 'shipments'):
            for count in ('one of two', 'one of 2', '1 of two', 'one out of two', 'one / two', '1 of 2'):
                with self.subTest(unit=unit, count=count):
                    cfg, result = self.fetch('2606', 'Order #2606 delivered', f'Order #2606. {count} {unit} has been delivered.')
                    self.assertFalse(tracker.terminal_order(cfg, result))
            cfg, result = self.fetch('2606', 'Order #2606 delivered', f'Order #2606. {unit}: two of two delivered.')
            self.assert_arrival_notice(cfg, result)

    def test_other_parts_still_in_transit_keep_order_open(self):
        for unit in ('item', 'package', 'parcel', 'shipment'):
            for predicate in ('is still on the way', 'will ship separately', 'is on its way', 'remains pending',
                              'has not arrived yet', 'is still not delivered', "hasn't been delivered",
                              "aren't delivered", 'weren’t delivered'):
                statement = f'Other {unit} {predicate}.'
                with self.subTest(unit=unit, predicate=predicate):
                    cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606. ' + statement)
                    self.assertFalse(tracker.terminal_order(cfg, result))
            for predicate in ('are still on the way', 'will ship separately', 'are in transit'):
                cfg, result = self.fetch('2606', 'Order #2606 delivered', f'Order #2606. Other {unit}s {predicate}.')
                self.assertFalse(tracker.terminal_order(cfg, result))
        for statement in ('No other shipments are still on the way.', 'Other shipments have been delivered.',
                          'Other shipments are not pending.', 'All other items have already arrived.'):
            cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606. ' + statement)
            self.assert_arrival_notice(cfg, result)

    def test_newer_scoped_nonterminal_progress_advances_confirmation(self):
        for unit in ('package', 'parcel', 'shipment', 'item'):
            for predicate, stage in (('has shipped', 'shipped'), ('is out for delivery', 'out for delivery')):
                hits = [self.f.hit(subject='Order #2606 confirmed', uid=1, date=tracker.stamp(self.f.now - 600)),
                        self.f.hit(subject=f'Your {unit} {predicate} - Order #2606', uid=2)]
                with self.subTest(unit=unit, stage=stage), self.f.mail(hits), mock.patch.object(tracker, 'run', return_value='Order #2606'):
                    result = tracker.fetch(self.f.cfg, {}, self.f.now)
                self.assertEqual(result['status'], stage)
                self.assertFalse(tracker.terminal_order(self.f.cfg, result))
                state = {'primed': True, 'status': 'ordered'}
                self.assertEqual(tracker.transition(result, state, self.f.cfg, self.f.now),
                                 [{'kind': 'stage_change', 'status': stage}])
                view = tracker.delivery_cards.view(self.f.cfg, result, {})
                self.assertEqual(view['stage'], 'Shipped' if stage == 'shipped' else 'Out for delivery')

    def test_old_whole_scope_cache_and_terminal_flag_are_reverified(self):
        cfg = self.f.cfg
        folder = tracker.WATCHERS / cfg['watcher']
        path = tracker.ROOT / 'orders' / (cfg['watcher'] + '.json')
        tracker.write(path, dict(cfg, active=True))
        tracker.write(folder / 'watcher.json', {})
        tracker.write(folder / 'order-tracker-state.json',
                      {'primed': True, 'status': 'delivered', 'web_proof_version': 2,
                       'last_result': {'status': 'delivered', 'whole_order_complete': True},
                       'mail_checked': self.f.now, 'mail_cache': [],
                       'mail_bodies_verified': {'icloud:Inbox:1': {'version': 2, 'matched': True, 'scope': 'order'}}})
        with self.f.mail([self.f.hit(subject='Order #2606 delivered')]), \
                mock.patch.object(tracker, 'run', return_value='Order #2606. This is a partial delivery.') as read, \
                mock.patch.object(tracker.delivery_cards, 'safe_sync', return_value={'status': 'skipped'}), \
                mock.patch.dict(os.environ, {'WATCH_DIR': str(folder), 'WATCH_RUN': 'scheduled-fixture'}), \
                redirect_stdout(io.StringIO()):
            tracker._check(cfg)
            tracker._check(cfg)
        self.assertTrue(tracker.read(path)['active'])
        self.assertTrue(any(call.args[0][:2] == ['mailsearch', 'read'] for call in read.call_args_list))

    def test_status_never_restores_a_web_terminal_label(self):
        cfg = self.f.cfg
        tracker.write(tracker.ROOT / 'orders' / (cfg['watcher'] + '.json'), cfg)
        for version, expected in ((2, 'unknown'), (3, 'unknown'), (4, 'unknown'), (tracker.WEB_PROOF_VERSION, 'unknown')):
            tracker.write(tracker.WATCHERS / cfg['watcher'] / 'order-tracker-state.json',
                          {'status': 'delivered', 'web_proof_version': version,
                           'last_result': {'status': 'delivered', 'whole_order_complete': True,
                                           'web_proof_version': version}})
            with self.subTest(version=version), self.f.mail([]), redirect_stdout(io.StringIO()) as output:
                tracker.main(['status', '--app', 'web', '--order', '2606', '--merchant-domain', 'fabrique.ae'])
            self.assertEqual(json.loads(output.getvalue())['last_confirmed_status'], expected)

    def test_hypothetical_support_controls_still_allow_arrival_notices(self):
        for condition in ('If', 'When', 'Once', 'Unless'):
            for phrase in ('your order is partially delivered', 'this is a partial delivery',
                           'other shipments are pending', 'one of two shipments has arrived',
                           'your Order no. 2606 is partially delivered'):
                body = f'Order #2606 delivered in full.\n{condition} {phrase}, contact support.'
                with self.subTest(condition=condition, phrase=phrase):
                    cfg, result = self.fetch('2606', 'Order #2606 delivered', body)
                    self.assert_arrival_notice(cfg, result)
        for body in ('If you need help, contact support. This is a partial delivery.',
                     'This is a partial delivery. If you need help, contact support.',
                     'Product WHEN-ITEM: this is a partial delivery.',
                     'If you need help, contact support; other shipments are still on the way.'):
            cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606. ' + body)
            self.assertFalse(tracker.terminal_order(cfg, result))

    def test_negated_pending_and_transit_prose_only_allow_scoped_notices(self):
        for unit in ('items', 'packages', 'parcels', 'shipments'):
            for predicate in ('are no longer pending', 'are no longer in transit', 'are no longer on the way',
                              'are no  longer pending', "aren't pending", 'aren’t pending'):
                with self.subTest(unit=unit, predicate=predicate):
                    cfg, result = self.fetch('2606', 'Order #2606 delivered',
                                             f'Order #2606 delivered in full. The other {unit} {predicate}.')
                    self.assert_arrival_notice(cfg, result)

    def assert_partial_check_stays_active(self, body, initial_state=None):
        cfg = self.f.cfg
        folder = tracker.WATCHERS / cfg['watcher']
        path = tracker.ROOT / 'orders' / (cfg['watcher'] + '.json')
        tracker.write(path, dict(cfg, active=True))
        tracker.write(folder / 'watcher.json', {})
        tracker.write(folder / 'order-tracker-state.json', initial_state or {'primed': True, 'status': 'ordered'})
        with self.f.mail([self.f.hit(subject='Order #2606 delivered')]), \
                mock.patch.object(tracker, 'run', return_value=body) as read, \
                mock.patch.object(tracker.delivery_cards, 'safe_sync', return_value={'status': 'skipped'}), \
                mock.patch.dict(os.environ, {'WATCH_DIR': str(folder), 'WATCH_RUN': 'scheduled-fixture'}), \
                redirect_stdout(io.StringIO()) as output:
            tracker._check(cfg)
            tracker._check(cfg)
        self.assertTrue(tracker.read(path)['active'])
        result = tracker.read(folder / 'order-tracker-state.json')['last_result']
        self.assertFalse(result['whole_order_complete'])
        self.assertFalse(tracker.terminal_order(cfg, result))
        self.assertEqual(read.call_count, 1)
        for line in output.getvalue().splitlines():
            events = json.loads(line).get('events', [])
            self.assertNotIn({'kind': 'stage_change', 'status': 'delivered'}, events)

    def test_fail_closed_signal_matrix_in_subject_body_and_cached_proof(self):
        signals = ['partial', 'partially', 'pending', 'remaining', 'remainder', 'outstanding',
                   'rest of', 'still on its way', 'still on the way', 'separately',
                   'separate shipment', 'separate shipments', 'backorder', 'backordered', 'split',
                   '1 of 2', '1/2', 'one of two', 'items left', 'not yet']
        for signal in signals:
            for source in ('subject', 'body'):
                with self.subTest(signal=signal, source=source):
                    subject = 'Order #2606 delivered' + ('; ' + signal.upper() if source == 'subject' else '')
                    body = 'Order #2606' + ('\n' + signal.upper() if source == 'body' else '')
                    self.assertIn(tracker.web_mail_scope(subject, body, '2606'), {'shipment', 'item'})
                    state = {}
                    with self.f.mail([self.f.hit(subject=subject)]), \
                            mock.patch.object(tracker, 'run', return_value=body) as read:
                        for elapsed in (0, 60, 301):
                            result = tracker.fetch(self.f.cfg, state, self.f.now + elapsed)
                            self.assertFalse(tracker.terminal_order(self.f.cfg, result))
                            self.assertFalse(result['whole_order_complete'])
                    self.assertLessEqual(read.call_count, 1)

    def test_partial_status_fields_keep_tracking_active_including_cache(self):
        fields = ['Delivery status: partially delivered', 'Delivery status: partial delivery',
                  'Pending items: 1', 'PENDING ITEMS = 2', 'Pending items - 12']
        for index, field in enumerate(fields):
            with self.subTest(row=index):
                self.assert_partial_check_stays_active('Order #2606\n' + field)

    def test_v3_completion_cache_is_rechecked_for_partial_status_fields(self):
        for index, field in enumerate(('Delivery status: partially delivered',
                                       'Delivery status: partial delivery', 'Pending items: 1')):
            state = {'primed': True, 'status': 'delivered', 'web_proof_version': 3,
                     'last_result': {'status': 'delivered', 'whole_order_complete': True, 'web_proof_version': 3},
                     'mail_checked': self.f.now,
                     'mail_cache': [{'stage': 'delivered', 'scope': 'order', 'observed_at': tracker.stamp(self.f.now)}],
                     'mail_bodies_verified': {'icloud:Inbox:1': {'version': 3, 'matched': True, 'scope': 'order'}}}
            with self.subTest(row=index):
                self.assert_partial_check_stays_active('Order #2606\n' + field, state)

    def test_factual_conditional_clauses_keep_doubt_signals(self):
        for index, statement in enumerate(('We will notify you when the remaining items arrive.',
                                            'We will notify you once the outstanding items arrive.',
                                            'There should be a separate shipment.',
                                            'We will notify you when pending items arrive.',
                                            'We will notify you once the rest of the order arrives.',
                                            'We will notify you when remaining items arrive, contact support.',
                                            'We will notify you once outstanding items arrive, contact us.',
                                            'We will notify you when your order is partially delivered, contact support.',
                                            'We contact support if other shipments are pending.')):
            with self.subTest(row=index):
                self.assert_partial_check_stays_active('Order #2606\n' + statement)

    def test_support_exemption_does_not_consume_neighboring_factual_clauses(self):
        for separator in (', ', '; ', '. ', '! ', '? ', '\n', ' but ', ' however ',
                          ' and ', ' or ', ' while ', ' although ', ' whereas ', ' — ', ' – ', ' yet '):
            for instruction in ('Contact support if this is a partial delivery',
                                'If this is a partial delivery, contact support'):
                with self.subTest(separator=repr(separator), instruction=instruction):
                    self.assert_partial_check_stays_active('Order #2606. ' + instruction + separator + 'Pending items: 1')
        for statement in ('If you need help, Pending items: 1, contact support.',
                          'Contact support if Pending items: 1.',
                          'If you need help but remaining items are outstanding, contact support.'):
            self.assert_partial_check_stays_active('Order #2606. ' + statement)

    def test_absence_signals_fail_closed_and_signal_word_boundaries(self):
        for body in ('No items pending.', 'Nothing remaining.', 'Pending items: 0', 'Pending items = zero',
                     'Delivery status: delivered in full.', 'Outstandingly good service.',
                     'An impartially selected gift.', '2 of 2', '2/2'):
            with self.subTest(control=body):
                cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606\n' + body)
                self.assert_arrival_notice(cfg, result)
        for body in ('No items pending; backordered.', 'Nothing remaining. Separate shipment.',
                     'Pending items: 0; 1/2', 'Other shipments are not pending; items left.'):
            cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606\n' + body)
            self.assertFalse(tracker.terminal_order(cfg, result))

    def test_unresolved_partial_delivery_reports_stall_once_after_48_hours(self):
        state = {'primed': True, 'status': 'ordered'}
        with self.f.mail([self.f.hit(subject='Order #2606 delivered')]), \
                mock.patch.object(tracker, 'run', return_value='Order #2606\nPending items: 1'):
            first = tracker.fetch(self.f.cfg, state, self.f.now)
            events = tracker.transition(first, state, self.f.cfg, self.f.now)
            self.assertNotIn({'kind': 'stage_change', 'status': 'delivered'}, events)
            for elapsed, expected in ((47 * 3600, 0), (49 * 3600, 1), (72 * 3600, 0)):
                result = tracker.fetch(self.f.cfg, state, self.f.now + elapsed)
                events = tracker.transition(result, state, self.f.cfg, self.f.now + elapsed)
                self.assertEqual(sum(e['kind'] == 'tracking_problem' for e in events), expected)
                self.assertFalse(tracker.terminal_order(self.f.cfg, result))

    def test_negative_answers_cannot_hide_positive_status_fields(self):
        for prefix in ('No.', 'No', 'None.', 'Nothing remaining.', 'No items pending.', 'Pending items: 0'):
            for separator in ('\n', ' ', '; ', ' — '):
                with self.subTest(prefix=prefix, separator=repr(separator)):
                    self.assert_partial_check_stays_active('Order #2606\n' + prefix + separator + 'Pending items: 1')

    def test_support_clause_keeps_following_partial_sentence_boundary(self):
        for separator in ('. ', '! ', '? ', '; ', '\n'):
            with self.subTest(separator=repr(separator)):
                self.assert_partial_check_stays_active('Order #2606. Please contact support if you need help'
                                                       + separator + 'Partial delivery.')

    def test_pending_negation_does_not_hide_independent_transit_clause(self):
        for separator in ('; ', '; however, ', ' but '):
            with self.subTest(separator=separator):
                self.assert_partial_check_stays_active('Order #2606. Other shipments are no longer pending'
                                                       + separator + 'they are still in transit.')
        for body in ('Other shipments are not pending; they are not in transit.',
                     'Other shipments are no longer pending; they have been delivered.'):
            cfg, result = self.fetch('2606', 'Order #2606 delivered', 'Order #2606. ' + body)
            self.assertFalse(tracker.terminal_order(cfg, result))

    def test_partial_and_later_full_delivery_only_notify_and_keep_tracking(self):
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
            self.assertTrue(tracker.read(path)['active'])
        self.assertNotIn('Your package', json.dumps(tracker.read(folder / 'order-tracker-state.json')))


if __name__ == '__main__':
    main()
