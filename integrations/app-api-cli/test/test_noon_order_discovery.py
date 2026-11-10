import unittest
import contextlib
import io
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import noon_order_discovery as discovery
from noon_order_discovery import scan_lane


class DiscoveryTests(unittest.TestCase):
    def test_overlapping_prime_is_quiet_and_does_not_read_history(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory), \
                patch.object(discovery.fcntl, 'flock', side_effect=BlockingIOError), \
                patch.object(discovery.core, 'orders') as read:
            discovery.main()
            read.assert_not_called()
            self.assertFalse((Path(directory)/'noon-discovery.json').exists())

    def test_failed_reader_still_emits_pending_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'noon-discovery.json'
            path.write_text(json.dumps({'food': {'seen': ['F1'], 'pending': {'F1': 0}}}))
            out = io.StringIO()
            with patch.dict('os.environ', WATCH_DIR=directory), \
                    patch.object(discovery.core, 'orders', side_effect=discovery.core.NoonError('OFFLINE')), \
                    patch.object(discovery.verticals, 'food_orders', side_effect=discovery.core.NoonError('OFFLINE')), \
                    patch.object(discovery.verticals, 'nownow_orders', side_effect=discovery.core.NoonError('OFFLINE')), \
                    patch.object(discovery, 'registered', return_value=False), contextlib.redirect_stdout(out):
                discovery.main()
            self.assertIn('F1', out.getvalue())
            self.assertEqual(json.loads(path.read_text())['food']['seen'], ['F1'])

    def test_baseline_retry_and_registration(self):
        state = {}
        old = [{'order': 'FOLD'}]
        self.assertEqual(scan_lane(state, 'food', old, 1000, lambda _: False), [])
        rows = old + [{'order': 'FNEW'}, {'order': 'FNEW'}]
        self.assertEqual(scan_lane(state, 'food', rows, 1001, lambda _: False),
                         [{'order': 'FNEW', 'service': 'food'}])
        self.assertEqual(scan_lane(state, 'food', rows, 1100, lambda _: False), [])
        self.assertEqual(len(scan_lane(state, 'food', rows, 1601, lambda _: False)), 1)
        self.assertEqual(scan_lane(state, 'food', rows, 2201, lambda _: True), [])
        self.assertEqual(state['food']['pending'], {})

    def test_missing_pending_order_is_retried_and_lanes_are_independent(self):
        state = {'food': {'seen': ['F1'], 'pending': {'F1': 0}}}
        self.assertEqual(len(scan_lane(state, 'food', [], 1000, lambda _: False)), 1)
        self.assertEqual(scan_lane(state, 'minutes', [{'order': 'I1'}], 1000, lambda _: False), [])

    def test_unplaced_rows_are_seen_without_registration_events(self):
        cases = [('food', 'failed'), ('nownow', 'canceled')]
        for lane, raw in cases:
            with self.subTest(lane=lane, raw=raw):
                state = {lane: {'seen': [], 'pending': {}}}
                rows = [{'order': 'F1', 'raw_status': raw}]
                for now in (1000, 1600, 10000):
                    self.assertEqual(scan_lane(state, lane, rows, now, lambda _: False), [])
                self.assertEqual(state[lane]['seen'], ['F1'])
                self.assertEqual(state[lane]['pending'], {})

    def test_pending_unplaced_rows_are_dropped_even_when_retry_is_due(self):
        for pending in (0.0, {'last_fire': 1000, 'fires': 6}):
            with self.subTest(pending=pending):
                state = {'food': {'seen': ['FGB8NNRIXD0OMEA'],
                                  'pending': {'FGB8NNRIXD0OMEA': pending}}}
                rows = [{'order': 'FGB8NNRIXD0OMEA', 'raw_status': 'failed'}]
                self.assertEqual(scan_lane(state, 'food', rows, 1600, lambda _: False), [])
                self.assertEqual(state['food']['pending'], {})
                self.assertEqual(state['food']['gave_up'], [])
                self.assertEqual(scan_lane(state, 'food', [], 2200, lambda _: False), [])

    def test_other_statuses_still_emit_new_orders(self):
        cases = [('food', 'preparing'), ('food', 'delivered'), ('food', None),
                 ('food', 'unknown'), ('nownow', 'delivered'), ('nownow', 'unknown'),
                 ('minutes', 'confirmed'), ('minutes', 'unknown'),
                 ('marketplace', 'confirmed'), ('marketplace', 'delivered'),
                 ('marketplace', 'cancelled'), ('marketplace', ' Cancelled '),
                 ('marketplace', None)]
        for lane, raw in cases:
            with self.subTest(lane=lane, raw=raw):
                state = {lane: {'seen': [], 'pending': {}}}
                self.assertEqual(scan_lane(state, lane, [{'order': 'O1', 'raw_status': raw}],
                                           1000, lambda _: False),
                                 [{'order': 'O1', 'service': lane}])

    def test_marketplace_cancelled_shipment_does_not_hide_other_rows(self):
        for raw in ('confirmed', None):
            with self.subTest(raw=raw):
                state = {'marketplace': {'seen': [], 'pending': {}}}
                rows = [{'order': 'N1', 'raw_status': 'cancelled', 'scope': 'shipment'},
                        {'order': 'N1', 'raw_status': raw, 'scope': 'shipment'}]
                self.assertEqual(scan_lane(state, 'marketplace', rows, 1000, lambda _: False),
                                 [{'order': 'N1', 'service': 'marketplace'}])

    def test_marketplace_cancelled_row_cannot_hide_a_later_active_shipment(self):
        for scope in ('shipment', 'item'):
            for raw in ('confirmed', None):
                with self.subTest(scope=scope, raw=raw):
                    state = {'marketplace': {'seen': [], 'pending': {}}}
                    cancelled = [{'order': 'N1', 'raw_status': 'cancelled', 'scope': scope}]
                    self.assertEqual(scan_lane(state, 'marketplace', cancelled, 1000, lambda _: False),
                                     [{'order': 'N1', 'service': 'marketplace'}])
                    state = json.loads(json.dumps(state))
                    active = [{'order': 'N1', 'raw_status': raw, 'scope': 'shipment'}]
                    self.assertEqual(scan_lane(state, 'marketplace', active, 1600, lambda _: False),
                                     [{'order': 'N1', 'service': 'marketplace'}])

    def test_matching_tracker_with_live_or_archived_watcher_is_resolved(self):
        order = 'FGB8NNRIXD0OMEA'
        name = 'order-noon-' + order.lower()
        for archived in (False, True):
            with self.subTest(archived=archived), tempfile.TemporaryDirectory() as directory, \
                    patch.dict('os.environ', HOME=directory):
                home = Path(directory)
                cfg = home/'.local/state/order-tracker/orders'/(name+'.json')
                cfg.parent.mkdir(parents=True)
                cfg.write_text(json.dumps({'order': order, 'watcher': name}))
                watch_root = home/'.local/share/robob-watch'
                watcher = watch_root/'watchers'/name/'watcher.json'
                watcher.parent.mkdir(parents=True)
                if archived:
                    (watcher.parent/'order-tracker-state.json').write_text('{}')
                    (watch_root/'archive'/(name+'-1794157931523')).mkdir(parents=True)
                else:
                    watcher.write_text('{}')
                self.assertTrue(discovery.registered(order))
                state = {'food': {'seen': [order], 'pending': {order: 0.0}}}
                self.assertEqual(scan_lane(state, 'food', [], 1000, discovery.registered), [])
                self.assertEqual(state['food']['pending'], {})

    def test_archive_requires_matching_tracker_and_watcher_directory(self):
        order = 'F1'
        name = 'order-noon-f1'
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', HOME=directory):
            home = Path(directory)
            archive = home/'.local/share/robob-watch/archive'
            archive.mkdir(parents=True)
            archived = archive/(name+'-123')
            archived.mkdir()
            self.assertFalse(discovery.registered(order))
            cfg = home/'.local/state/order-tracker/orders'/(name+'.json')
            cfg.parent.mkdir(parents=True)
            for value in ({'order': 'F2', 'watcher': name},
                          {'order': order, 'watcher': 'order-noon-f2'}):
                cfg.write_text(json.dumps(value))
                self.assertFalse(discovery.registered(order))
            cfg.write_text(json.dumps({'order': order, 'watcher': name}))
            archived.rmdir()
            archived.write_text('{}')
            self.assertFalse(discovery.registered(order))
            (archive/'order-noon-f10-123').mkdir()
            self.assertFalse(discovery.registered(order))

    def test_six_fires_then_one_persistent_event_then_silence_across_reload(self):
        state = {'food': {'seen': [], 'pending': {}}}
        rows = [{'order': 'F1'}]
        for fire in range(1, 7):
            now = 1000 + (fire - 1) * 600
            self.assertEqual(scan_lane(state, 'food', rows, now, lambda _: False),
                             [{'order': 'F1', 'service': 'food'}])
            self.assertEqual(state['food']['pending']['F1']['fires'], fire)
            self.assertEqual(scan_lane(state, 'food', rows, now + 599, lambda _: False), [])
            state = json.loads(json.dumps(state))
        self.assertEqual(scan_lane(state, 'food', rows, 4600, lambda _: False),
                         [{'order': 'F1', 'service': 'food', 'persistent': True}])
        self.assertEqual(state['food']['pending'], {})
        self.assertEqual(state['food']['gave_up'], ['F1'])
        state = json.loads(json.dumps(state))
        for now in (5200, 5800, 100000):
            self.assertEqual(scan_lane(state, 'food', rows, now, lambda _: False), [])
        self.assertEqual(state['food']['gave_up'], ['F1'])

    def test_legacy_float_pending_retains_deadline_and_gets_bounded_retries(self):
        state = json.loads('{"food": {"seen": ["F1"], "pending": {"F1": 1000.5}}}')
        self.assertEqual(scan_lane(state, 'food', [], 1600, lambda _: False), [])
        self.assertEqual(state['food']['pending']['F1'], {'last_fire': 1000.5, 'fires': 0})
        for fire in range(6):
            self.assertEqual(scan_lane(state, 'food', [], 1600.5 + fire * 600, lambda _: False),
                             [{'order': 'F1', 'service': 'food'}])
        self.assertEqual(scan_lane(state, 'food', [], 5200.5, lambda _: False),
                         [{'order': 'F1', 'service': 'food', 'persistent': True}])
        self.assertEqual(scan_lane(state, 'food', [], 5800.5, lambda _: False), [])

    def test_registration_after_six_fires_suppresses_persistent_event(self):
        state = {'food': {'seen': ['F1'],
                          'pending': {'F1': {'last_fire': 1000, 'fires': 6}}}}
        self.assertEqual(scan_lane(state, 'food', [], 1600, lambda _: True), [])
        self.assertEqual(state['food']['pending'], {})
        self.assertEqual(state['food']['gave_up'], [])


if __name__ == '__main__':
    unittest.main()
