import unittest
import contextlib
import datetime as dt
import io
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import noon_order_discovery as discovery
from noon_order_discovery import scan_lane


class DiscoveryTests(unittest.TestCase):
    @contextlib.contextmanager
    def readers(self, results=None):
        results = results or {}

        def read(lane):
            result = results.get(lane, {'ok': True, 'orders': []})
            if isinstance(result, Exception):
                raise result
            return result

        with patch.object(discovery.core, 'orders', side_effect=lambda lane, **_: read(lane)), \
                patch.object(discovery.verticals, 'food_orders', side_effect=lambda **_: read('food')), \
                patch.object(discovery.verticals, 'nownow_orders', side_effect=lambda **_: read('nownow')), \
                patch.object(discovery, 'registered', return_value=False):
            yield

    def test_transient_lane_failure_is_quiet_and_keeps_baseline_and_pending(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory), \
                patch.object(discovery.time, 'time', return_value=1000):
            path = Path(directory)/'noon-discovery.json'
            baseline = {'seen': ['F1'], 'pending': {'F1': {'last_fire': 1000, 'fires': 1}},
                        'gave_up': []}
            path.write_text(json.dumps({'food': baseline}))
            out = io.StringIO()
            with self.readers({'food': discovery.core.NoonError('NATIVE_READ_TIMEOUT')}), \
                    contextlib.redirect_stdout(out):
                discovery.main()
            state = json.loads(path.read_text())
            self.assertEqual(out.getvalue(), '')
            self.assertEqual(state['food'], baseline)
            self.assertEqual(state['lanes']['food']['fail_count'], 1)
            self.assertEqual(state['errors'], {'food': 'NATIVE_READ_TIMEOUT'})

    def test_all_lanes_fail_quietly_but_persist_health_and_run_log(self):
        failures = {lane: discovery.core.NoonError('OFFLINE')
                    for lane in ('minutes', 'marketplace', 'food', 'nownow')}
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory), \
                self.readers(failures), contextlib.redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as raised:
                discovery.main()
            self.assertIsInstance(raised.exception.code, str)
            self.assertTrue(raised.exception.code.startswith('Noon discovery incomplete: '))
            self.assertIn('failing_since', raised.exception.code)
            self.assertEqual(out.getvalue(), '')
            state = json.loads((Path(directory)/'noon-discovery.json').read_text())
            self.assertTrue(state['checked_at'])
            self.assertEqual(set(state['errors']), set(failures))
            for lane in failures:
                self.assertNotIn(lane, state)  # No baseline until a successful read.
                self.assertEqual(state['lanes'][lane]['fail_count'], 1)
                self.assertEqual(state['lanes'][lane]['last_error'], 'OFFLINE')
                self.assertIsNone(state['lanes'][lane]['ok_at'])
                self.assertIn(state['lanes'][lane]['failing_since'], raised.exception.code)
            runs = (Path(directory)/'noon-discovery-runs.jsonl').read_text().splitlines()
            self.assertEqual(len(runs), 1)
            run = json.loads(runs[0])
            self.assertEqual(run['exit'], 1)
            self.assertEqual(run['events'], 0)
            for lane in failures:
                self.assertFalse(run['lanes'][lane]['ok'])
                self.assertEqual(run['lanes'][lane]['error'], 'OFFLINE')

    def test_failed_lane_age_controls_exit_at_two_hours(self):
        now = dt.datetime.now(dt.timezone.utc)
        for age, should_fail in ((7199, False), (7200, True), (7201, True)):
            with self.subTest(age=age), tempfile.TemporaryDirectory() as directory, \
                    patch.dict('os.environ', WATCH_DIR=directory), \
                    self.readers({'food': discovery.core.NoonError('NATIVE_READ_TIMEOUT')}), \
                    patch.object(discovery.dt, 'datetime', wraps=dt.datetime) as clock, \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                clock.now.return_value = now
                path = Path(directory)/'noon-discovery.json'
                since = (now - dt.timedelta(seconds=age)).isoformat()
                ok_at = (now - dt.timedelta(hours=3)).isoformat()
                path.write_text(json.dumps({'lanes': {'food': {
                    'ok_at': ok_at, 'fail_count': 3, 'failing_since': since,
                    'last_error': 'OFFLINE', 'last_ms': 1, 'rows': 0}}}))
                if should_fail:
                    with self.assertRaises(SystemExit) as raised:
                        discovery.main()
                    self.assertIn(since, raised.exception.code)
                else:
                    discovery.main()
                health = json.loads(path.read_text())['lanes']['food']
                self.assertEqual(health['fail_count'], 4)
                self.assertEqual(health['failing_since'], since)
                self.assertEqual(health['ok_at'], ok_at)
                self.assertEqual(out.getvalue(), '')
                log = json.loads((Path(directory)/'noon-discovery-runs.jsonl').read_text())
                self.assertEqual(log['exit'], int(should_fail))

    def test_recovery_resets_failure_streak_and_starts_a_fresh_baseline(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            path = Path(directory)/'noon-discovery.json'
            since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).isoformat()
            path.write_text(json.dumps({'lanes': {'food': {
                'ok_at': None, 'fail_count': 8, 'failing_since': since,
                'last_error': 'OFFLINE', 'last_ms': 20000, 'rows': 0}}}))
            with self.readers({'food': {'ok': True, 'orders': [{'order': 'F1'}]}}):
                discovery.main()
            state = json.loads(path.read_text())
            health = state['lanes']['food']
            self.assertEqual(health['fail_count'], 0)
            self.assertIsNone(health['failing_since'])
            self.assertIsNone(health['last_error'])
            self.assertTrue(health['ok_at'])
            self.assertEqual(health['rows'], 1)
            self.assertGreaterEqual(health['last_ms'], 0)
            self.assertEqual(state['errors'], {})
            self.assertEqual(state['food']['seen'], ['F1'])
            self.assertEqual(state['food']['pending'], {})
            with self.readers({'food': discovery.core.NoonError('OFFLINE')}):
                discovery.main()
            health = json.loads(path.read_text())['lanes']['food']
            self.assertEqual(health['fail_count'], 1)
            self.assertNotEqual(health['failing_since'], since)
            self.assertEqual(out.getvalue(), '')

    def test_new_order_on_healthy_lane_prints_event_despite_other_lane_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory):
            path = Path(directory)/'noon-discovery.json'
            path.write_text(json.dumps({'food': {'seen': ['FOLD'], 'pending': {}}}))
            results = {'minutes': discovery.core.NoonError('OFFLINE'),
                       'food': {'ok': True, 'orders': [{'order': 'FOLD'}, {'order': 'FNEW'}]}}
            with self.readers(results), contextlib.redirect_stdout(io.StringIO()) as out:
                discovery.main()
            self.assertEqual(out.getvalue(), 'New noon account orders (read-only discovery): '
                             + json.dumps([{'order': 'FNEW', 'service': 'food'}]) + '\n')
            run = json.loads((Path(directory)/'noon-discovery-runs.jsonl').read_text())
            self.assertEqual(run['exit'], 0)
            self.assertEqual(run['events'], 1)
            self.assertEqual(run['lanes']['food']['rows'], 2)
            self.assertFalse(run['lanes']['minutes']['ok'])

    def test_incomplete_reads_fail_only_their_lane_without_advancing_baseline(self):
        cases = [(lane, result) for lane in ('minutes', 'marketplace', 'food', 'nownow')
                 for result in ({'ok': True, 'partial': True}, {'ok': False})]
        for lane, result in cases:
            with self.subTest(lane=lane, result=result), tempfile.TemporaryDirectory() as directory, \
                    patch.dict('os.environ', WATCH_DIR=directory), self.readers({lane: result}), \
                    contextlib.redirect_stdout(io.StringIO()) as out:
                path = Path(directory)/'noon-discovery.json'
                baseline = {'seen': ['O1'], 'pending': {}, 'gave_up': []}
                path.write_text(json.dumps({lane: baseline}))
                discovery.main()
                state = json.loads(path.read_text())
                self.assertEqual(state[lane], baseline)
                self.assertEqual(state['errors'], {lane: 'PARTIAL_HISTORY_READ'})
                self.assertEqual(state['lanes'][lane]['fail_count'], 1)
                self.assertEqual(out.getvalue(), '')

    def test_persistent_failure_is_not_masked_by_healthy_lane_event(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory):
            path = Path(directory)/'noon-discovery.json'
            since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).isoformat()
            path.write_text(json.dumps({'food': {'seen': [], 'pending': {}},
                'lanes': {'minutes': {'ok_at': None, 'fail_count': 5, 'failing_since': since}}}))
            results = {'minutes': discovery.core.NoonError('OFFLINE'),
                       'food': {'ok': True, 'orders': [{'order': 'FNEW'}]}}
            with self.readers(results), contextlib.redirect_stdout(io.StringIO()) as out:
                with self.assertRaises(SystemExit):
                    discovery.main()
            self.assertIn('FNEW', out.getvalue())
            run = json.loads((Path(directory)/'noon-discovery-runs.jsonl').read_text())
            self.assertEqual(run['exit'], 1)
            self.assertEqual(run['events'], 1)

    def test_all_readers_get_twenty_second_budgets(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory), \
                patch.object(discovery.core, 'orders', return_value={'ok': True, 'orders': []}) as core, \
                patch.object(discovery.verticals, 'food_orders', return_value={'ok': True, 'orders': []}) as food, \
                patch.object(discovery.verticals, 'nownow_orders', return_value={'ok': True, 'orders': []}) as nownow, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            discovery.main()
            self.assertEqual(core.call_args_list, [unittest.mock.call('minutes', timeout=20),
                                                   unittest.mock.call('marketplace', timeout=20)])
            food.assert_called_once_with(timeout=20)
            nownow.assert_called_once_with(timeout=20)
            self.assertEqual(out.getvalue(), '')

    def test_run_log_appends_once_per_run_and_trims_only_past_cap(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory), \
                self.readers(), contextlib.redirect_stdout(io.StringIO()) as out:
            path = Path(directory)/'noon-discovery-runs.jsonl'
            records = [{'sequence': i} for i in range(2499)]
            path.write_text(''.join(json.dumps(row) + '\n' for row in records))
            discovery.main()
            first = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(len(first), 2500)
            self.assertEqual(first[:-1], records)
            discovery.main()
            second = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual(len(second), 2000)
            self.assertEqual(second[:-1], first[-1999:])
            for run in second[-2:]:
                self.assertEqual(set(run), {'at', 'total_ms', 'lanes', 'events', 'exit'})
                self.assertGreaterEqual(run['total_ms'], 0)
                self.assertEqual(run['events'], 0)
                self.assertEqual(run['exit'], 0)
                self.assertEqual(set(run['lanes']), {'minutes', 'marketplace', 'food', 'nownow'})
                for lane in run['lanes'].values():
                    self.assertEqual(set(lane), {'ok', 'ms', 'rows', 'error'})
                    self.assertTrue(lane['ok'])
                    self.assertIsNone(lane['error'])
                    self.assertEqual(lane['rows'], 0)
                    self.assertGreaterEqual(lane['ms'], 0)
            self.assertEqual(out.getvalue(), '')

    def test_watcher_backs_off_without_hard_pausing(self):
        path = Path(discovery.__file__).with_name('noon-discovery-watcher.json')
        watcher = json.loads(path.read_text())
        self.assertEqual(watcher['max_consecutive_failures'], 0)
        self.assertEqual(watcher['failure_notice_after'], 3)
        self.assertEqual(watcher['interval_s'], 120)
        self.assertGreaterEqual(watcher['timeout_s'], 4 * 20 + 10)
        self.assertEqual(watcher['mode'], 'wake')

    def test_overlapping_prime_is_quiet_and_does_not_read_history(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', WATCH_DIR=directory), \
                patch.object(discovery.fcntl, 'flock', side_effect=BlockingIOError), \
                patch.object(discovery.core, 'orders') as read:
            discovery.main()
            read.assert_not_called()
            self.assertFalse((Path(directory)/'noon-discovery.json').exists())
            self.assertFalse((Path(directory)/'noon-discovery-runs.jsonl').exists())

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
                with self.assertRaises(SystemExit):
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
