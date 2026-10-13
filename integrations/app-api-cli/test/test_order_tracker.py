import sys
from pathlib import Path
import time
import unittest
import json
import io
from contextlib import redirect_stdout
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import order_tracker as t


class TrackerTest(unittest.TestCase):
    def cfg(self):
        return {'app': 'talabat', 'order': '12345', 'placed_at': t.stamp(time.time()-3600),
                'registered_at': t.stamp(), 'eta': t.stamp(time.time()-600)}

    def result(self, status='unknown'):
        return {'status': status, 'errors': []}

    def test_delivery_promises_are_not_delivery(self):
        for text in ['Your order will be delivered today', 'Your order is not delivered',
                     'Free delivery when you order', 'Your rider has arrived at the restaurant']:
            self.assertNotEqual(t.classify(text), 'delivered')
        self.assertEqual(t.classify('Your order has been delivered'), 'delivered')

    def test_notification_identity_and_age(self):
        cfg = self.cfg()
        def dump(text, timestamp=None):
            return f'NotificationRecord(x: pkg=com.talabat id=1)\nwhen={int((timestamp or time.time())*1000)}\nandroid.text=String ({text})'
        self.assertEqual(t.notifications(dump('Your rider is around the corner'), cfg), [])
        self.assertEqual(t.notifications(dump('Your rider is around the corner'), cfg, True)[0]['confidence'], 'single_active_app_unconfirmed')
        self.assertEqual(t.notifications(dump('Order 12345 has been delivered'), cfg)[0]['stage'], 'delivered')
        self.assertEqual(t.notifications(dump('Order 912345 has been delivered'), cfg), [])
        self.assertEqual(t.notifications(dump('Order 12345 has been delivered', time.time()-7200), cfg), [])

    def test_baseline_delay_once_and_terminal(self):
        state, cfg = {}, self.cfg()
        self.assertEqual(t.transition(self.result('preparing'), state, cfg, time.time()), [])
        self.assertEqual(t.transition(self.result(), state, cfg, time.time())[0]['kind'], 'eta_elapsed')
        self.assertEqual(t.transition(self.result(), state, cfg, time.time()), [])
        self.assertEqual(t.transition(self.result('delivered'), state, cfg, time.time())[0]['status'], 'delivered')
        self.assertEqual(t.transition(self.result('preparing'), state, cfg, time.time()), [])
        self.assertEqual(state['status'], 'delivered')

    def test_candidate_dedupe_does_not_confirm_delivery(self):
        state = {'primed': True, 'delay_sent': True}
        result = self.result()
        result['candidate'] = {'stage': 'delivered', 'evidence': 'App says delivered'}
        self.assertEqual(t.transition(result, state, self.cfg(), time.time())[0]['kind'], 'candidate')
        self.assertEqual(t.transition(result, state, self.cfg(), time.time()), [])
        self.assertNotEqual(state.get('status'), 'delivered')

    def problem_cfg(self, at):
        return dict(self.cfg(), app='noon', order='N123', eta=None, registered_at=t.stamp(at - 3600))

    def problems(self, result, state, cfg, at):
        return [e for e in t.transition(result, state, cfg, at) if e['kind'] == 'tracking_problem']

    def test_same_tracking_problem_alerts_once_per_day(self):
        at = time.time()
        cfg, state = self.problem_cfg(at), {}
        result = lambda: {'status': 'unknown', 'errors': ['native_status_unknown']}
        self.assertEqual(t.transition(result(), state, cfg, at), [])  # priming tick stays quiet
        self.assertEqual(self.problems(result(), state, cfg, at + 60),
                         [{'kind': 'tracking_problem', 'errors': ['native_status_unknown']}])
        fired = [h for h in range(1, 49) if self.problems(result(), state, cfg, at + 60 + h * 3600)]
        self.assertEqual(fired, [24, 48])

    def test_changed_tracking_problem_alerts_immediately(self):
        at = time.time()
        cfg, state = self.problem_cfg(at), {'primed': True, 'status': 'placed'}
        first = {'status': 'unknown', 'errors': ['native_status_unknown', 'email_read_unavailable']}
        self.assertEqual(len(self.problems(first, state, cfg, at)), 1)
        reordered = dict(first, errors=['email_read_unavailable', 'native_status_unknown'])
        self.assertEqual(self.problems(reordered, state, cfg, at + 60), [])
        # A clearing or flapping error is not a new problem.
        self.assertEqual(self.problems(dict(first, errors=['native_status_unknown']), state, cfg, at + 120), [])
        self.assertEqual(self.problems(first, state, cfg, at + 180), [])
        changed = dict(first, errors=['native_auth_expired', 'native_status_unknown'])
        self.assertEqual(self.problems(changed, state, cfg, at + 240)[0]['errors'], changed['errors'])
        # A new confirmed stage with the same errors is a new signature.
        moved = {'status': 'out for delivery', 'errors': ['native_status_unknown']}
        self.assertEqual(len(self.problems(moved, state, cfg, at + 300)), 1)
        self.assertEqual(self.problems(moved, state, cfg, at + 3900), [])
        state['status'] = 'delivered'
        self.assertEqual(self.problems(changed, state, cfg, at + 4000), [])

    def test_legacy_hourly_alert_state_does_not_refire(self):
        at = time.time()
        cfg = self.problem_cfg(at)
        state = {'primed': True, 'status': 'out for delivery', 'coverage_alert': True,
                 'coverage_alert_at': at - 3700}
        result = lambda: {'status': 'unknown', 'errors': ['native_status_unknown']}
        self.assertEqual(self.problems(result(), state, cfg, at), [])
        self.assertNotIn('coverage_alert_at', state)
        self.assertEqual(self.problems(result(), state, cfg, at - 3700 + 86401)[0]['kind'], 'tracking_problem')
        # A stale legacy alert belonged to an earlier, resolved problem.
        stale = {'primed': True, 'status': 'placed', 'coverage_alert': True, 'coverage_alert_at': at - 5 * 3600}
        self.assertEqual(len(self.problems(result(), stale, cfg, at)), 1)

    def test_native_partial_delivery_is_preserved_not_whole_completion(self):
        cfg = dict(self.cfg(), app='noon', order='N123')
        native = {'status': 'unknown', 'coverage': 'bounded', 'whole_order_complete': False,
                  'shipments': [{'status': 'delivered', 'scope': 'item', 'item_id': 'N123-1',
                                 'shipment_id': 'N123-S1'}], 'items': [], 'truncated': False}
        with mock.patch('native_orders.track', return_value=native), \
             mock.patch.object(t, 'mail_evidence', return_value=([], [])), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            result = t.fetch(cfg, {}, time.time())
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        self.assertEqual(result['partial_evidence'][0]['item_id'], 'N123-1')
        state = {'primed': True, 'delay_sent': True}
        events = t.transition(result, state, cfg, time.time())
        self.assertEqual(events[0]['kind'], 'shipment_delivered')
        self.assertNotEqual(state.get('status'), 'delivered')
        self.assertEqual(t.transition(result, state, cfg, time.time()), [])

    def test_native_eta_provenance_survives_tracker(self):
        native = {'status': 'nearby', 'coverage': 'native_minutes', 'eta': '2026-10-08T18:13:00+04:00',
                  'eta_source': 'native_minutes_list_window', 'eta_window': {'start': 'a', 'end': 'b'}}
        with mock.patch('native_orders.track', return_value=native):
            result = t.fetch(dict(self.cfg(), app='noon'), {}, time.time())
        self.assertEqual(result['eta_source'], 'native_minutes_list_window')
        self.assertEqual(result['eta_window'], native['eta_window'])

    def test_marketplace_outage_cannot_upgrade_package_mail(self):
        import native_orders
        cfg = dict(self.cfg(), app='noon', order='N123')
        package_mail = {'stage': 'delivered', 'scope': 'order', 'confidence': 'exact_order',
                        'source': 'order_email', 'observed_at': t.stamp(), 'evidence': 'Delivered N123'}
        with mock.patch('native_orders.track', side_effect=native_orders.OrderError('AUTH_EXPIRED')), \
             mock.patch.object(t, 'mail_evidence', return_value=([package_mail], [])), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            result = t.fetch(cfg, {}, time.time())
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])

    def test_active_native_stage_keeps_delivered_sibling(self):
        native = {'status': 'out for delivery', 'coverage': 'bounded', 'whole_order_complete': False,
                  'shipments': [{'status': 'delivered', 'scope': 'item', 'item_id': 'N123-1',
                                 'shipment_id': 'N123-S1'}]}
        with mock.patch('native_orders.track', return_value=native):
            result = t.fetch(dict(self.cfg(), app='noon', order='N123'), {}, time.time())
        self.assertEqual(result['status'], 'out for delivery')
        self.assertEqual(result['partial_evidence'][0]['item_id'], 'N123-1')

    def test_shipment_to_item_arrival_is_not_duplicate(self):
        state = {'primed': True, 'delay_sent': True}
        cfg = self.cfg()
        result = self.result()
        proof = {'stage': 'delivered', 'scope': 'shipment', 'shipment_id': 'N123-S1',
                 'evidence_key': 'native:shipment:N123-S1', 'source': 'native_order_api'}
        result['partial_evidence'] = [proof]
        self.assertEqual(len(t.transition(result, state, cfg, time.time())), 1)
        result['partial_evidence'] = [{**proof, 'scope': 'item', 'item_id': 'N123-1',
                                       'evidence_key': 'native:item:N123-1'}]
        self.assertEqual(t.transition(result, state, cfg, time.time()), [])

    def receipt_cfg(self):
        return {'app': 'talabat', 'order': '3943292030', 'for': 'moni',
                'placed_at': '2026-10-08T11:48:46+04:00', 'registered_at': '2026-10-08T07:50:07+00:00',
                 'eta': '2026-10-08T12:49:00+04:00'}

    def amazon(self, whole=False):
        return {'order_id': '408-1234567-1234567', 'status': 'delivered' if whole else 'partially_delivered',
                'whole_order_delivered': whole, 'manifest': {'complete': whole},
                'shipments': [{'shipment_key': 'hash123', 'status': 'delivered',
                               'evidence_at': t.stamp(), 'items': [], 'contents_consistent': True}],
                'evidence': [], 'coverage': {'complete': True}, 'errors': []}

    def test_amazon_manifest_completion_closes_only_whole_order(self):
        cfg = dict(self.cfg(), app='amazon', order='408-1234567-1234567')
        for whole in (False, True):
            with mock.patch('amazon_email_orders.track', return_value=self.amazon(whole)), \
                 mock.patch.object(t.store, 'evidence', return_value=([], [])), \
                 mock.patch.object(t, 'mail_evidence', side_effect=AssertionError('legacy mail bypass')):
                result = t.fetch(cfg, {}, time.time())
            self.assertEqual(result['status'], 'delivered' if whole else 'unknown')
            self.assertEqual(result['whole_order_complete'], whole)
            state = {'primed': True, 'delay_sent': True}
            events = t.transition(result, state, cfg, time.time())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]['kind'], 'stage_change' if whole else 'shipment_delivered')
            self.assertEqual(state.get('status') == 'delivered', whole)
            self.assertEqual(t.transition(result, state, cfg, time.time()), [])

    def test_amazon_cache_bounds_reads_and_outage_never_uses_legacy_delivery(self):
        cfg = dict(self.cfg(), app='amazon', order='408-1234567-1234567')
        state = {'mail_cache': [{'stage': 'delivered', 'confidence': 'exact_order'}]}
        now = time.time()
        with mock.patch('amazon_email_orders.track', return_value=self.amazon()) as scan, \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            t.fetch(cfg, state, now)
            t.fetch(cfg, state, now + 60)
            self.assertEqual(scan.call_count, 1)
            self.assertEqual(scan.call_args.kwargs['timeout'], 35)
        with mock.patch('amazon_email_orders.track', side_effect=RuntimeError('private data')), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])):
            result = t.fetch(cfg, state, now + 301)
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        self.assertNotIn('private data', json.dumps(result))

    def mailsearch(self, hits, ok=True):
        out = json.dumps({'status': {'gmail': {'ok': ok}}, 'hits': hits})
        return mock.patch.object(t.subprocess, 'run', return_value=mock.Mock(stdout=out, returncode=0))

    # Real 8 Oct 2026 receipt (order ID only inside the PDF attachment).
    REAL = {'account': 'gmail', 'folder': '[Gmail]/All Mail', 'uid': 265136, 'date': '2026-10-08 12:36',
            'from': 'Talabat <noreply@talabat.com>', 'subject': 'Your service charges Receipt'}

    def test_talabat_receipt_email_is_delivered(self):
        with self.mailsearch([self.REAL]) as run:
            proof, errors = t.talabat_receipt(self.receipt_cfg())
        query = run.call_args[0][0][-1]
        self.assertIn('"3943292030"', query)
        self.assertIn('subject:receipt', query)
        self.assertEqual((proof['stage'], proof['confidence'], errors), ('delivered', 'exact_order', []))
        self.assertTrue(proof['email_date'].startswith('2026-10-08T12:36'))

    def test_receipt_rejects_other_senders_subjects_and_older_mail(self):
        for hit in [dict(self.REAL, **{'from': 'Talabat <noreply@talabat.com.evil.io>'}),
                    dict(self.REAL, subject='Your PostPaid order was approved'),
                    dict(self.REAL, date='2026-10-07 13:28')]:
            with self.mailsearch([hit]):
                self.assertIsNone(t.talabat_receipt(self.receipt_cfg())[0])
        with self.mailsearch([], ok=False):
            self.assertEqual(t.talabat_receipt(self.receipt_cfg()), (None, ['receipt_email_unavailable:gmail']))

    def test_replay_8_oct_receipt_fires_delivered_before_eta(self):
        cfg = self.receipt_cfg()
        state = {'primed': True}
        at = t.epoch('2026-10-08T12:37:00+04:00')
        native = mock.patch('native_orders.track', side_effect=__import__('native_orders').OrderError('ACCOUNT_CAPTURE_REQUIRED_GUEST_CATALOG_ONLY'))
        with native, self.mailsearch([self.REAL]), \
             mock.patch.object(t, 'mail_evidence', return_value=([], [])), \
             mock.patch.object(t.store, 'evidence', return_value=([], [])), \
             mock.patch.object(t, 'single_allowed', return_value=False):
            result = t.fetch(cfg, state, at)
            events = t.transition(result, state, cfg, at)
            self.assertEqual(result['status'], 'delivered')
            self.assertEqual(events, [{'kind': 'stage_change', 'status': 'delivered'}])
            # Cached receipt: no re-query, no duplicate event, no later eta_elapsed.
            later = at + 1800
            result = t.fetch(cfg, state, later)
            self.assertEqual(t.transition(result, state, cfg, later), [])


class AmazonGlueTest(unittest.TestCase):
    """Parser -> reducer -> watcher regressions; no mail, phone, or disk state."""

    def setUp(self):
        import amazon_email_orders
        from test import test_amazon_email_orders
        self.a, self.f = amazon_email_orders, test_amazon_email_orders
        self.now = t.epoch('2026-10-08T15:00:00+00:00')
        self.cfg = {'app': 'amazon', 'order': self.f.OID, 'for': 'owner',
                    'placed_at': '2026-10-05T10:00:00+00:00',
                    'registered_at': t.stamp(self.now - 60), 'eta': None,
                    'watcher': 'order-amazon-fixture'}
        for target, kwargs in [
            ('order_tracker.store.evidence', {'return_value': ([], [])}),
            ('order_tracker.single_allowed', {'return_value': False}),
            ('order_tracker.subprocess.run', {'side_effect': AssertionError('no live I/O')}),
        ]:
            patcher = mock.patch(target, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)

    def projection(self, *raws, start_uid=99):
        events = [e for uid, raw in enumerate(raws, start_uid) for e in self.f.parse(raw, uid=uid)]
        result = self.a.aggregate_order(self.f.OID, events)
        result['coverage'] = {'complete': True, 'order': result['coverage']}
        return dict(result, checked_at=self.f.OBSERVED, errors=[])

    def fetch(self, mail, state=None, now=None):
        with mock.patch('amazon_email_orders.track', return_value=mail):
            return t.fetch(self.cfg, {} if state is None else state,
                           self.now if now is None else now)

    def unbound(self):
        return self.f.mail('Delivered: Fixture',
                           f'Your package was delivered.\nOrder #\n{self.f.OID}\n')

    def test_unbound_delivery_survives_and_dedupes_by_event(self):
        mail = self.projection(self.unbound())
        self.assertEqual(mail['shipments'], [])
        state = {'primed': True}
        result = self.fetch(mail, state)
        self.assertFalse(result['whole_order_complete'])
        self.assertEqual(len(result['partial_evidence']), 1)
        proof = result['partial_evidence'][0]
        self.assertEqual(proof['evidence_key'], 'amazon:event:' + mail['evidence'][0]['event_id'])
        self.assertEqual(proof['scope'], 'shipment')
        self.assertIsNone(proof.get('shipment_id'))
        self.assertEqual(proof['observed_at'], mail['evidence'][0]['observed_at'])
        self.assertEqual(proof['email_date'], mail['evidence'][0]['evidence_at'])
        self.assertEqual([e['kind'] for e in t.transition(result, state, self.cfg, self.now)],
                         ['shipment_delivered'])
        self.assertEqual(t.transition(self.fetch(mail, state, self.now + 60), state,
                                      self.cfg, self.now + 60), [])
        self.assertNotEqual(state.get('status'), 'delivered')

    def test_unbound_missing_time_is_not_arrival_proof(self):
        raw = self.f.mail('Delivered: Fixture', f'Order #\n{self.f.OID}\n', date=None)
        result = self.fetch(self.projection(raw))
        self.assertEqual(result['partial_evidence'], [])
        self.assertFalse(result['whole_order_complete'])

    def test_unparsed_inventory_to_bound_shipment_is_not_second_arrival(self):
        first = self.projection(self.f.shipment(items=()))
        later = self.projection(self.f.shipment())
        state = {'primed': True}
        result = self.fetch(first, state)
        self.assertEqual(len(result['partial_evidence']), 1)
        self.assertEqual(len(t.transition(result, state, self.cfg, self.now)), 1)
        result = self.fetch(later, state, self.now + 301)
        self.assertEqual(t.transition(result, state, self.cfg, self.now + 301), [])

    def test_bound_proof_uses_matching_event_times_even_on_cache_hit(self):
        mail = self.projection(self.f.shipment('Shipped: Fixture'), self.f.shipment())
        delivered = next(e for e in mail['evidence'] if e['stage'] == 'delivered')
        delivered['observed_at'] = '2026-10-08T10:00:05+00:00'
        state = {}
        with mock.patch('amazon_email_orders.track', return_value=mail) as scan:
            first = t.fetch(self.cfg, state, self.now)
            second = t.fetch(self.cfg, state, self.now + 60)
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(len(first['partial_evidence']), 1)
        for result in (first, second):
            proof = result['partial_evidence'][0]
            self.assertEqual(proof['observed_at'], delivered['observed_at'])
            self.assertEqual(proof['email_date'], delivered['evidence_at'])

    def test_legacy_mail_keys_migrate_for_bound_and_unbound_delivery(self):
        for raw in (self.f.shipment(), self.unbound()):
            for seen_field in ('shipments_seen', 'parts_delivered_seen'):
                with self.subTest(bound=raw != self.unbound(), seen_field=seen_field):
                    mail = self.projection(raw)
                    event = mail['evidence'][0]
                    key = f'{event["account"]}:{event["folder"]}:{event["uid"]}'
                    state = {'primed': True, seen_field: [key]}
                    result = self.fetch(mail, state)
                    self.assertEqual(t.transition(result, state, self.cfg, self.now), [])
                    self.assertIn(result['partial_evidence'][0]['evidence_key'],
                                  state['parts_delivered_seen'])
                    # No broad suppression: a different package must still notify.
                    new = self.projection(self.f.shipment(sid='OTHER-SHIPMENT'), start_uid=1000)
                    result = self.fetch(new, state, self.now + 301)
                    self.assertEqual([e['kind'] for e in t.transition(result, state, self.cfg,
                                                                    self.now + 301)],
                                     ['shipment_delivered'])

    def test_aftercare_is_scoped_deduped_and_not_a_historical_arrival(self):
        for subject, stage in [('Your return of Fixture', 'return_requested'),
                               ('Return received: Fixture', 'returned'),
                               ('Refund issued: Fixture', 'refunded'),
                               ('Cancelled: Fixture', 'cancelled')]:
            with self.subTest(stage=stage):
                mail = self.projection(self.f.shipment(), self.f.shipment(
                    subject, date='Wed, 07 Oct 2026 10:00:00 +0000'))
                state = {'primed': True}
                result = self.fetch(mail, state)
                self.assertFalse(result['whole_order_complete'])
                self.assertEqual(result['aftercare_evidence'][0]['stage'], stage)
                self.assertEqual(result['aftercare_evidence'][0]['scope'], 'item')
                self.assertTrue(result['partial_evidence'][0]['historical'])
                events = t.transition(result, state, self.cfg, self.now)
                self.assertEqual([e['kind'] for e in events], ['aftercare'])
                self.assertEqual(events[0]['status'], stage)
                self.assertNotIn(state.get('status'), t.TERMINAL)
                self.assertEqual(t.transition(result, state, self.cfg, self.now + 60), [])
                # Recovery must not replay either arrival or aftercare.
                with mock.patch('amazon_email_orders.track', side_effect=RuntimeError('offline')):
                    outage = t.fetch(self.cfg, state, self.now + 301)
                self.assertFalse(outage['whole_order_complete'])
                recovered = self.fetch(mail, state, self.now + 602)
                self.assertEqual(t.transition(recovered, state, self.cfg, self.now + 602), [])

    def test_legacy_second_account_alias_survives_reduce_fetch_transition(self):
        for raw in (self.f.shipment(), self.unbound()):
            for seen_field in ('shipments_seen', 'parts_delivered_seen'):
                with self.subTest(bound=raw != self.unbound(), seen_field=seen_field):
                    gmail = self.a.parse_message(raw, account='gmail', folder='[Gmail]/All Mail',
                                                uid=99, observed_at=self.f.OBSERVED)[0]
                    outlook = self.a.parse_message(raw, account='outlook', folder='Archive',
                                                  uid=123, observed_at='2026-10-08T10:01:00+00:00')[0]
                    self.assertEqual(gmail['event_id'], outlook['event_id'])
                    reduced = self.a.aggregate_order(self.f.OID, [gmail, outlook])
                    self.assertEqual(len(reduced['evidence']), 1)
                    self.assertEqual(reduced['evidence'][0]['account'], 'gmail')
                    mail = dict(reduced, checked_at=self.f.OBSERVED, errors=[])
                    state = {'primed': True, seen_field: ['outlook:Archive:123']}
                    result = self.fetch(mail, state)
                    self.assertEqual(t.transition(result, state, self.cfg, self.now), [])
                    proof = result['partial_evidence'][0]
                    self.assertEqual(set(proof['mail_keys']),
                                     {'gmail:[Gmail]/All Mail:99', 'outlook:Archive:123'})
                    self.assertEqual(proof['observed_at'], gmail['observed_at'])
                    self.assertEqual(proof['email_date'], gmail['evidence_at'])
                    self.assertIn(proof['evidence_key'], state['parts_delivered_seen'])
                    self.assertIn('amazon:event:' + gmail['event_id'], state['parts_delivered_seen'])
                    self.assertFalse(result['whole_order_complete'])
                    # An unchanged cached scan must not replay the migrated arrival.
                    self.assertEqual(t.transition(self.fetch(mail, state, self.now + 60),
                                                  state, self.cfg, self.now + 60), [])
                    # Alias migration does not suppress a genuinely different package.
                    other = self.projection(self.f.shipment(sid='DIFFERENT-SHIPMENT'), start_uid=1000)
                    result = self.fetch(other, state, self.now + 301)
                    self.assertEqual([e['kind'] for e in t.transition(result, state, self.cfg,
                                                                    self.now + 301)],
                                     ['shipment_delivered'])

    def test_later_sibling_arrival_survives_aftercare(self):
        mail = self.projection(self.f.shipment(), self.f.shipment(
            'Your return of Fixture', date='Wed, 07 Oct 2026 10:00:00 +0000'),
            self.f.shipment(sid='LATER-SHIPMENT', date='Thu, 08 Oct 2026 09:00:00 +0000'))
        result = self.fetch(mail)
        events = t.transition(result, {'primed': True}, self.cfg, self.now)
        self.assertEqual(sorted(e['kind'] for e in events), ['aftercare', 'shipment_delivered'])
        self.assertEqual(sum(not p.get('historical', False) for p in result['partial_evidence']), 1)

    def test_problem_evidence_survives_glue(self):
        mail = self.projection(self.f.shipment('Delivery failed: Fixture'))
        result = self.fetch(mail)
        self.assertEqual(result['problem']['stage'], 'problem')
        self.assertEqual(result['problem']['scope'], 'shipment')
        events = t.transition(result, {'primed': True}, self.cfg, self.now)
        self.assertEqual([e['kind'] for e in events], ['problem'])

    def test_later_unbound_problem_does_not_announce_prior_arrival(self):
        problem = self.f.mail('Delivery failed: Fixture', f'Order #\n{self.f.OID}\n',
                              date='Wed, 07 Oct 2026 10:00:00 +0000')
        result = self.fetch(self.projection(self.f.shipment(), problem))
        events = t.transition(result, {'primed': True}, self.cfg, self.now)
        self.assertEqual([e['kind'] for e in events], ['problem'])
        self.assertTrue(result['partial_evidence'][0]['historical'])

    def test_whole_closure_still_requires_complete_manifest(self):
        complete = self.projection(self.f.confirmation(), self.f.shipment())
        partial = self.projection(self.f.shipment())
        state = {'primed': True}
        result = self.fetch(partial, state)
        self.assertFalse(result['whole_order_complete'])
        t.transition(result, state, self.cfg, self.now)
        result = self.fetch(complete, state, self.now + 301)
        self.assertTrue(result['whole_order_complete'])
        self.assertEqual(t.transition(result, state, self.cfg, self.now + 301),
                         [{'kind': 'stage_change', 'status': 'delivered'}])
        self.assertEqual(result['evidence'][0]['email_date'],
                         complete['shipments'][0]['evidence_at'])

    def test_aftercare_after_whole_delivery_is_not_suppressed(self):
        mail = self.projection(self.f.confirmation(), self.f.shipment())
        state = {'primed': True}
        first = self.fetch(mail, state)
        t.transition(first, state, self.cfg, self.now)
        later = self.projection(self.f.confirmation(), self.f.shipment(), self.f.shipment(
            'Your return of Fixture', date='Wed, 07 Oct 2026 10:00:00 +0000'))
        result = self.fetch(later, state, self.now + 301)
        events = t.transition(result, state, self.cfg, self.now + 301)
        self.assertEqual([e['kind'] for e in events], ['aftercare'])
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['whole_order_complete'])
        # Historical delivery is retained, not presented as current completion.
        self.assertEqual(result['last_confirmed_status'], 'delivered')

    def test_partial_outage_recovery_preserves_dedupe_and_push_is_candidate(self):
        mail = self.projection(self.f.shipment())
        state = {'primed': True}
        t.transition(self.fetch(mail, state), state, self.cfg, self.now)
        push = {'stage': 'delivered', 'observed_at': t.stamp(self.now),
                'source': 'android_notification_journal', 'confidence': 'exact_order'}
        with mock.patch('amazon_email_orders.track', side_effect=RuntimeError('offline')), \
             mock.patch.object(t.store, 'evidence', return_value=([push], [])):
            outage = t.fetch(self.cfg, state, self.now + 301)
        self.assertEqual(outage['status'], 'unknown')
        self.assertFalse(outage['whole_order_complete'])
        self.assertEqual(outage['candidate']['confidence'], 'amazon_notification_unconfirmed')
        t.transition(outage, state, self.cfg, self.now + 301)
        recovered = self.fetch(mail, state, self.now + 602)
        events = t.transition(recovered, state, self.cfg, self.now + 602)
        self.assertFalse(any(e['kind'] in ('shipment_delivered', 'stage_change') for e in events))
        self.assertFalse(recovered['whole_order_complete'])

    def test_check_whole_arrival_reconciles_observation_separately_from_email_date(self):
        mail = self.projection(self.f.confirmation(), self.f.shipment())
        folder = Path.home() / '.local/share/robob-watch/watchers' / self.cfg['watcher']
        with mock.patch.dict(t.os.environ, WATCH_DIR=str(folder)), \
             mock.patch.object(Path, 'open', mock.mock_open()), \
             mock.patch.object(t.fcntl, 'flock'), \
             mock.patch.object(t, 'read', return_value={'primed': True}), \
             mock.patch.object(t, 'write'), \
             mock.patch.object(t.time, 'time', return_value=self.now), \
             mock.patch('amazon_email_orders.track', return_value=mail), \
             mock.patch.object(t.store, 'reconcile') as reconcile, \
             redirect_stdout(io.StringIO()):
            t.check(self.cfg)
        reconcile.assert_called_once_with(self.cfg, detected=t.stamp(self.now),
                                          source='amazon_email',
                                          evidence_time=mail['shipments'][0]['evidence_at'])

    def test_check_wake_carries_aftercare_and_never_removes_or_reconciles_arrival(self):
        mail = self.projection(self.f.shipment(), self.f.shipment(
            'Your return of Fixture', date='Wed, 07 Oct 2026 10:00:00 +0000'))
        folder = Path.home() / '.local/share/robob-watch/watchers' / self.cfg['watcher']
        output = io.StringIO()
        with mock.patch.dict(t.os.environ, WATCH_DIR=str(folder)), \
             mock.patch.object(Path, 'open', mock.mock_open()), \
             mock.patch.object(t.fcntl, 'flock'), \
             mock.patch.object(t, 'read', return_value={'primed': True}), \
             mock.patch.object(t, 'write'), \
             mock.patch.object(t.time, 'time', return_value=self.now), \
             mock.patch('amazon_email_orders.track', return_value=mail), \
             mock.patch.object(t.store, 'reconcile') as reconcile, \
             mock.patch.object(t, 'run', side_effect=AssertionError('no mutations')), \
             redirect_stdout(output):
            t.check(self.cfg)
        wake = json.loads(output.getvalue())
        self.assertEqual(wake['email_status'], 'return_requested')
        self.assertEqual(wake['aftercare_evidence'][0]['stage'], 'return_requested')
        self.assertEqual([e['kind'] for e in wake['events']], ['aftercare'])
        self.assertFalse(wake['whole_order_complete'])
        reconcile.assert_not_called()


if __name__ == '__main__':
    unittest.main()
