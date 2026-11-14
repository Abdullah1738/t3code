"""Window proofs, source limits and sanitized persistent detail caching."""
import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import charges
import order_lookup as lookup

AT = dt.datetime(2026, 11, 10, 12, tzinfo=dt.timezone.utc)
CHARGE = dict(kind='charge', merchant='noon', amount='12.34', currency='AED', card='1111', pending=False)


def row(oid, minutes=0, status='delivered'):
    return dict(order=oid, placed_at=(AT + dt.timedelta(minutes=minutes)).isoformat(),
                status=status, raw_status=status)


def proof():
    return {'orders': [], 'complete': False, 'lanes': {
        name: dict(exhaustive=False, covered_from=(AT - dt.timedelta(days=1)).isoformat(), limit=None)
        for name in lookup.LANES}}


class Windows(unittest.TestCase):
    def check(self, result):
        return charges.order_receipt(CHARGE, AT, AT, lookup=lambda *a, **kw: result)

    def test_every_lane_covers_window(self):
        self.assertIsNone(self.check(proof()))

    def test_short_budget_missing_lane_and_invalid_time_are_errors(self):
        for form in ('short', 'missing', 'time', 'unordered'):
            with self.subTest(form=form):
                result = proof()
                lane = result['lanes']['food']
                if form == 'short':
                    lane['covered_from'] = AT.isoformat()
                elif form == 'missing':
                    del result['lanes']['food']
                elif form == 'time':
                    lane['covered_from'] = 'invalid'
                else:
                    lane['covered_from'] = None
                    lane['limit'] = 'page-1 history only'
                with self.assertRaises(charges.Lookup) as exc:
                    self.check(result)
                self.assertNotIsInstance(exc.exception, charges.SourceLimit)

    def test_limit_is_unverified_and_mixed_failure_stays_error(self):
        result = proof()
        result['lanes']['food'].update(covered_from=AT.isoformat(), limit='page-1 history only')
        with patch.object(lookup, 'read', return_value=result), patch.object(charges, 'receipt', return_value=None), \
                patch.object(charges, 'card_owner', return_value='abdullah'):
            verdict = charges.explain(CHARGE, AT, AT + dt.timedelta(days=3), said=lambda *a, **kw: [])
        self.assertEqual(verdict['verdict'], 'unverified')
        self.assertEqual(verdict['errors'], [])
        self.assertEqual(verdict['limits'][0]['kinds'], ['food_page_1'])
        result['lanes']['minutes']['covered_from'] = AT.isoformat()
        with self.assertRaises(charges.Lookup) as exc:
            self.check(result)
        self.assertNotIsInstance(exc.exception, charges.SourceLimit)

    def test_inclusive_match_boundary_needs_strictly_older_coverage(self):
        # Oldest covered relative to charge: outside / exact inclusive edge / inside.
        for minutes, proven in ((-16, True), (-15, False), (-14, False)):
            with self.subTest(minutes=minutes):
                result = proof()
                result['lanes']['minutes']['covered_from'] = row('M1', minutes)['placed_at']
                if proven:
                    self.assertIsNone(self.check(result))
                else:
                    with self.assertRaises(charges.Lookup):
                        self.check(result)

    def test_unique_positive_wins_with_short_coverage(self):
        result = proof()
        result['lanes'] = {}
        result['orders'] = [dict(row('N1'), total='12.34', currency='AED')]
        self.assertEqual(self.check(result)['verdict'], 'receipt')


class Reader(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'native_orders.py').write_text('''import json
import threading
from pathlib import Path
ROOT=Path(__file__).parent
def orders(app, service, timeout, page=1, cursor=None):
    with (ROOT/'pages.log').open('a') as f:f.write(service+':'+str(page)+'\\n')
    data=json.loads((ROOT/'fixture.json').read_text())
    if threading.current_thread() is not threading.main_thread():raise ValueError('main thread required')
    if service in data.get('list_fail',[]):raise TimeoutError('list timeout')
    if page in data.get('page_fail',{}).get(service,[]):raise TimeoutError('page timeout')
    rows=data.get(service,{}).get(str(page),[])
    coverage=({'page':page,'total_pages':len(data.get(service,{'1':[]}))} if service=='minutes'
              else {'exhaustive':service not in data})
    if service in data.get('paging',[]):
        coverage={'page':page,'total_pages':len(data[service]),'paging_verified':True,
                  'ordered_by_placed_at':service!='marketplace',
                  'exhaustive':page==len(data[service]),'next_cursor':'cursor-'+str(page)}
    coverage=data.get('coverage_override',{}).get(service,coverage)
    return dict(ok=True,orders=rows,coverage={service:coverage})
''')
        (self.root / 'noon_order_details.py').write_text('''import json
from pathlib import Path
ROOT=Path(__file__).parent
def details(oid, service, timeout):
    with (ROOT/'details.log').open('a') as f:f.write(service+':'+oid+'\\n')
    data=json.loads((ROOT/'fixture.json').read_text())
    if oid in data.get('fail',[]):raise ValueError('private error must not escape')
    row=next(r for page in data[service].values() for r in page if r['order']==oid)
    return dict(ok=True,account_verified=True,order=oid,total=row.get('total','1.00'),currency='AED',
                placed_at=row.get('detail_time',row.get('placed_at')),address='PRIVATE',card_last4='9999',items=['PRIVATE'])
''')
        self.modules = {}
        for name in ('native_orders', 'noon_order_details'):
            spec = importlib.util.spec_from_file_location(name, self.root / (name + '.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.modules[name] = module
        patcher = patch.dict(sys.modules, self.modules)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = patch.dict(os.environ, {'MONEY_CASES_APP_API': str(self.root),
                                     'MONEY_CASES_ORDER_PYTHON': sys.executable,
                                     'MONEY_CASES_DIR': str(self.root),
                                     'ROBOB_TOOL_LOG_DIR': str(self.root / 'logs')})
        env.start()
        self.addCleanup(env.stop)
        self.cache = self.root / 'order-details.json'

    def fixture(self, **data):
        (self.root / 'fixture.json').write_text(json.dumps(data))

    def native(self, since=None):
        return lookup.native('noon', str(self.root), since=since)

    def test_stop_reasons_distinguish_detail_failure_unknown_time_and_slice(self):
        for form, expected in (('fail', 'detail_error'), ('time', 'unknown_time_row'), ('late', 'slice_out')):
            with self.subTest(form=form):
                order = row('F1')
                if form == 'time':
                    order['detail_time'] = '2026-11-10T12:00:00'
                self.fixture(food={'1': [order]}, fail=['F1'] if form == 'fail' else [])
                if form == 'late':
                    clock = [100.0]
                    original = self.modules['noon_order_details'].details
                    def late(*args, **kw):
                        result = original(*args, **kw)
                        clock[0] += 9
                        return result
                    with patch.object(lookup.time, 'monotonic', side_effect=lambda: clock[0]), \
                            patch.object(self.modules['noon_order_details'], 'details', side_effect=late):
                        result = lookup.native('noon', str(self.root), services=('food',))
                else:
                    result = lookup.native('noon', str(self.root), services=('food',))
                lane = result['lanes']['food']
                self.assertEqual(lane['stop_reason'], expected)
                self.assertEqual(lane['coverage_cleared_rows'], 1)
                self.assertIsNone(lane['covered_from'])
                self.assertFalse(lane['exhaustive'])

    def test_child_error_is_not_reported_as_a_time_slice(self):
        with patch.object(lookup, 'native', side_effect=RuntimeError('private fixture')):
            result = lookup.parallel_lanes(str(self.root), None, None, [])
        self.assertFalse(result['complete'])
        self.assertTrue(all(l['stop_reason'] == 'reader_error' for l in result['lanes'].values()))
        self.assertNotIn('private', json.dumps(result))

    def test_verified_vertical_pages_cross_ties_and_skip_old_details(self):
        for service in ('food', 'nownow'):
            with self.subTest(service=service):
                self.fixture(**{service: {'1': [row('A', -15)], '2': [row('B', -15)],
                                         '3': [row('C', -16)], '4': [row('D', -20)]},
                                'paging': [service]})
                result = lookup.native('noon', str(self.root), since=AT.isoformat(), services=(service,))
                lane = result['lanes'][service]
                self.assertEqual(lane['pages'], 3)
                self.assertEqual(lane['stop_reason'], 'covered')
                self.assertEqual(lane['fetched'], 2)
                self.assertEqual(lane['covered_from'], row('C', -16)['placed_at'])
                self.assertIsNone(lane['limit'])
                self.assertFalse(lane['exhaustive'])

    def test_repeated_page_cannot_claim_exhaustive_history(self):
        for service in ('food', 'nownow', 'marketplace'):
            with self.subTest(service=service):
                self.fixture(**{service: {'1': [row('A')], '2': [row('A')]}, 'paging': [service]})
                result = lookup.native('noon', str(self.root), services=(service,))
                self.assertFalse(result['lanes'][service]['exhaustive'])

    def test_repeated_scoped_status_updates_invalidate_positive_matches(self):
        for status, raw_status in (
            ('cancelled', 'cancelled'), ('cancelled', 'canceled'), ('unknown', 'failed'),
            ('unknown', 'future_status'), ('out for delivery', 'out_for_delivery'),
            ('delivered', 'cancelled'), ('unknown', 'delivered'), ('delivered', 'delivered'),
        ):
            with self.subTest(status=status, raw_status=raw_status):
                first = {**row('A'), 'item_id': 'A-1', 'shipment_id': 'A-S1', 'total': CHARGE['amount']}
                second = {**first, 'status': status, 'raw_status': raw_status}
                other = {**row('B'), 'item_id': 'B-1', 'shipment_id': 'B-S1', 'total': '99.00'}
                self.fixture(marketplace={'1': [first, other], '2': [second, other]}, paging=['marketplace'])
                result = lookup.native('noon', str(self.root), services=('marketplace',))
                self.assertFalse(result['lanes']['marketplace']['exhaustive'])
                self.assertIsNone(result['lanes']['marketplace']['covered_from'])
                if status == raw_status == 'delivered':
                    self.assertEqual(charges.order_receipt(CHARGE, AT, AT,
                        lookup=lambda *a, **kw: result)['verdict'], 'receipt')
                else:
                    with self.assertRaises(charges.Lookup):
                        charges.order_receipt(CHARGE, AT, AT, lookup=lambda *a, **kw: result)
                    self.assertEqual([r['order'] for r in result['orders']], ['B'])

    def test_persistent_cache_invalidation_survives_next_read_page_timeout(self):
        cached = {**row('N1'), 'service': 'marketplace', 'total': CHARGE['amount'],
                  'currency': 'AED', 'whole_order_complete': True}
        unrelated = {**cached, 'order': 'N2', 'total': '98.00'}
        for status, raw_status in (
            ('cancelled', 'cancelled'), ('cancelled', 'canceled'), ('unknown', 'failed'),
            ('unknown', 'future_status'), ('out for delivery', 'out_for_delivery'),
            ('delivered', 'cancelled'), ('unknown', 'delivered'), ('delivered', 'delivered'),
        ):
            for item in ('N1-1', 'N1-2'):
                with self.subTest(status=status, raw_status=raw_status, item=item):
                    self.cache.write_text(json.dumps([cached, unrelated]))
                    first = {**row('N1'), 'item_id': 'N1-1', 'shipment_id': 'N1-S1', 'total': '99.00'}
                    second = {**first, 'item_id': item, 'status': status, 'raw_status': raw_status}
                    self.fixture(marketplace={'1': [first], '2': [second]}, paging=['marketplace'])
                    observed = lookup.read('noon', cache_path=self.cache)
                    after_invalidation = lookup.load_cache(self.cache)
                    self.fixture(marketplace={'1': [first], '2': [first]}, paging=['marketplace'],
                                 page_fail={'marketplace': [2]})
                    result = lookup.read('noon', cache_path=self.cache)
                    if status == raw_status == 'delivered':
                        self.assertEqual(charges.order_receipt(CHARGE, AT, AT,
                            lookup=lambda *a, **kw: result)['verdict'], 'receipt')
                        self.assertEqual(result['lanes']['marketplace']['cached'], 1)
                    else:
                        with self.assertRaises(charges.Lookup):
                            charges.order_receipt(CHARGE, AT, AT, lookup=lambda *a, **kw: result)
                        self.assertEqual(observed['orders'], [])
                        self.assertEqual(observed['invalidated'], [{'service': 'marketplace', 'order': 'N1'}])
                        self.assertEqual([r['order'] for r in after_invalidation], ['N2'])
                        self.assertEqual(result['orders'][0]['total'], '99.00')
                        self.assertEqual(result['lanes']['marketplace']['cached'], 0)
                    self.assertIn('N2', {r['order'] for r in lookup.load_cache(self.cache)})

    def test_first_page_contradiction_evicts_cache_even_when_detail_fails(self):
        cached = {**row('N1'), 'service': 'marketplace', 'total': CHARGE['amount'],
                  'currency': 'AED', 'whole_order_complete': True}
        for status in ('cancelled', 'failed', 'out for delivery', 'unknown'):
            with self.subTest(status=status):
                self.cache.write_text(json.dumps([cached]))
                self.fixture(marketplace={'1': [row('N1', status=status)]}, fail=['N1'])
                result = lookup.read('noon', cache_path=self.cache)
                self.assertEqual(result['invalidated'], [{'service': 'marketplace', 'order': 'N1'}])
                self.assertEqual(lookup.load_cache(self.cache), [])
                self.assertEqual(result['orders'], [])

    def test_cache_invalidation_write_failure_is_not_silent(self):
        self.cache.write_text(json.dumps([{**row('N1'), 'service': 'marketplace',
            'total': CHARGE['amount'], 'currency': 'AED', 'whole_order_complete': True}]))
        self.fixture(marketplace={'1': [row('N1', status='cancelled')]})
        with patch('state_json.write_json', side_effect=OSError('write failed')):
            with self.assertRaisesRegex(ValueError, 'order lookup unavailable'):
                lookup.read('noon', cache_path=self.cache)

    def test_overlapping_cache_readers_cannot_restore_cancelled_receipt(self):
        cached = {**row('N1'), 'service': 'marketplace', 'total': CHARGE['amount'],
                  'currency': 'AED', 'whole_order_complete': True}
        fresh = {**cached, 'total': '99.00', 'whole_order_complete': False}
        self.cache.write_text(json.dumps([cached]))
        a_loading, allow_a, a_done = threading.Event(), threading.Event(), threading.Event()
        results, errors, snapshots, sizes = {}, [], [], [1]
        original_load, original_flock = lookup.load_cache, fcntl.flock

        def load(path):
            name = threading.current_thread().name
            if name == 'reader-a':
                a_loading.set()
                if not allow_a.wait(5):
                    raise AssertionError('reader B did not reach the transaction')
            value = original_load(path)
            if name == 'reader-b':
                snapshots.append(value)
                # Before the fix, B can load before A evicts. With the lock,
                # B instead releases A through the contention hook below.
                allow_a.set()
            return value

        def flock(fd, operation):
            try:
                return original_flock(fd, operation)
            except BlockingIOError:
                if threading.current_thread().name == 'reader-b':
                    allow_a.set()
                raise

        def reader_process(args, **kwargs):
            if threading.current_thread().name == 'reader-a':
                result = {'orders': [], 'complete': False,
                          'invalidated': [{'service': 'marketplace', 'order': 'N1'}]}
            else:
                if not a_done.wait(5):
                    raise AssertionError('cancellation eviction did not complete')
                snapshot = json.loads(kwargs['input'])['cache']
                result = {'orders': snapshot or [fresh], 'complete': False}
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(result), stderr='')

        def run(name):
            try:
                results[name] = lookup.read('noon', cache_path=self.cache)
                sizes.append(len(original_load(self.cache)))
            except Exception as exc:
                errors.append(exc)
            finally:
                if name == 'reader-a':
                    a_done.set()

        a = threading.Thread(target=run, args=('reader-a',), name='reader-a')
        b = threading.Thread(target=run, args=('reader-b',), name='reader-b')
        with patch.object(lookup, 'load_cache', side_effect=load), \
                patch.object(fcntl, 'flock', side_effect=flock), \
                patch.object(lookup.subprocess, 'run', side_effect=reader_process):
            try:
                a.start()
                self.assertTrue(a_loading.wait(5))
                b.start()
                a.join(5)
                b.join(5)
                self.assertFalse(a.is_alive() or b.is_alive())
            finally:
                allow_a.set()
                a_done.set()
                a.join(5)
                if b.ident is not None:
                    b.join(5)
        self.assertEqual(errors, [])
        first = {**row('N1'), 'item_id': 'N1-1', 'shipment_id': 'N1-S1', 'total': '99.00'}
        self.fixture(marketplace={'1': [first], '2': [first]}, paging=['marketplace'],
                     page_fail={'marketplace': [2]})
        result = lookup.read('noon', cache_path=self.cache)
        with self.assertRaises(charges.Lookup):
            charges.order_receipt(CHARGE, AT, AT, lookup=lambda *a, **kw: result)
        with self.assertRaises(charges.Lookup):
            charges.order_receipt(CHARGE, AT, AT, lookup=lambda *a, **kw: results['reader-b'])
        self.assertEqual(sizes, [1, 0, 0])
        self.assertEqual(snapshots, [[]])
        self.assertEqual(self.cache.with_suffix('.lock').read_bytes(), b'')

    def test_cache_lock_contention_exhausts_budget_before_loading(self):
        clock = [100.0]
        def advance(seconds):
            clock[0] += seconds
        with self.cache.with_suffix('.lock').open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(lookup.time, 'time', return_value=100.0), \
                    patch.object(lookup.time, 'monotonic', side_effect=lambda: clock[0]), \
                    patch.object(lookup.time, 'sleep', side_effect=advance), \
                    patch.object(lookup, 'load_cache') as load, \
                    patch.object(lookup.subprocess, 'run') as process:
                with self.assertRaises(ValueError):
                    lookup.read('noon', deadline=102.1, cache_path=self.cache)
                load.assert_not_called()
                process.assert_not_called()
        self.assertGreater(clock[0], 100)
        self.assertLessEqual(clock[0], 102)
        self.assertEqual(self.cache.with_suffix('.lock').read_bytes(), b'')

    def test_cache_lock_wait_reduces_subprocess_timeout(self):
        clock, attempts = [100.0], [0]
        original_flock = fcntl.flock
        def flock(fd, operation):
            attempts[0] += 1
            if attempts[0] == 1:
                raise BlockingIOError('busy')
            return original_flock(fd, operation)
        def advance(_seconds):
            clock[0] += 2.5
        with patch.object(fcntl, 'flock', side_effect=flock), \
                patch.object(lookup.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(lookup.time, 'sleep', side_effect=advance), \
                patch.object(lookup.subprocess, 'run', return_value=subprocess.CompletedProcess(
                    [], 0, stdout=json.dumps({'orders': [], 'complete': False}), stderr='')) as process:
            lookup.read('noon', cache_path=self.cache)
        self.assertAlmostEqual(process.call_args.kwargs['timeout'], 7.5)
        self.assertEqual(self.cache.with_suffix('.lock').read_bytes(), b'')

    def test_cache_transaction_releases_lock_on_subprocess_and_validation_errors(self):
        for outcome in (subprocess.TimeoutExpired('reader', 1),
                        subprocess.CompletedProcess([], 0, stdout='invalid json', stderr=''),
                        subprocess.CompletedProcess([], 0, stdout='{}', stderr='')):
            with self.subTest(outcome=type(outcome).__name__):
                options = {'side_effect': outcome} if isinstance(outcome, Exception) else {'return_value': outcome}
                with patch.object(lookup.subprocess, 'run', **options), self.assertRaises(ValueError):
                    lookup.read('noon', cache_path=self.cache)
                with self.cache.with_suffix('.lock').open('a') as check:
                    fcntl.flock(check, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(self.cache.with_suffix('.lock').read_bytes(), b'')

    def test_unverified_reader_retains_page_one_limit(self):
        self.fixture(food={'1': [row('A')], '2': [row('B', -60)]},
                     coverage_override={'food': {'paging_verified': True, 'default_page_only': True}})
        result = lookup.native('noon', str(self.root), services=('food',))
        self.assertEqual(result['lanes']['food']['pages'], 1)
        self.assertEqual(result['lanes']['food']['limit'], 'page-1 history only')

    def test_marketplace_history_exhaustion_without_creation_order_assumption(self):
        self.fixture(marketplace={'1': [row('A', -60)], '2': [row('B')]}, paging=['marketplace'])
        result = lookup.native('noon', str(self.root), services=('marketplace',))
        lane = result['lanes']['marketplace']
        self.assertTrue(lane['exhaustive'])
        self.assertEqual(lane['pages'], 2)
        self.assertEqual(lane['stop_reason'], 'end_of_history')
        self.assertIsNone(lane['covered_from'])

    def test_later_cancelled_shipment_stays_unread_even_for_seen_order(self):
        for status in ('cancelled', 'canceled', 'failed', 'unknown', 'out for delivery'):
            with self.subTest(status=status):
                first = {**row('A'), 'item_id': 'A-1'}
                second = {**row('A', status=status), 'item_id': 'A-2'}
                self.fixture(marketplace={'1': [first], '2': [second]}, paging=['marketplace'])
                result = lookup.native('noon', str(self.root), services=('marketplace',))
                self.assertEqual(result['orders'], [])
                self.assertFalse(result['lanes']['marketplace']['exhaustive'])
                self.assertIsNone(result['lanes']['marketplace']['covered_from'])

    def test_marketplace_cache_requires_whole_order_delivery(self):
        base = {**row('N1'), 'service': 'marketplace', 'total': 12.34, 'currency': 'AED'}
        for status, complete, expected in (('delivered', True, 1), ('delivered', False, 0),
                                            ('cancelled', True, 0), ('failed', True, 0)):
            with self.subTest(status=status, complete=complete):
                self.cache.write_text(json.dumps([{**base, 'status': status, 'whole_order_complete': complete}]))
                self.assertEqual(len(lookup.load_cache(self.cache)), expected)

    def test_failed_lane_cannot_starve_other_main_thread_readers(self):
        self.fixture(minutes={'1': []}, food={'1': [row('F1')]}, list_fail=['minutes'])
        result = self.native()
        self.assertEqual([r['order'] for r in result['orders']], ['F1'])
        self.assertEqual(result['lanes']['food']['covered_from'], row('F1')['placed_at'])
        self.assertIsNone(result['lanes']['minutes']['covered_from'])
        self.assertEqual(result['lanes']['minutes']['stop_reason'], 'list_error')
        self.assertFalse(result['complete'])

    def test_detail_gap_cuts_coverage_and_preserves_later_positive(self):
        self.fixture(food={'1': [row('F1', 2), row('F2', 1), row('F3')]}, fail=['F2'])
        result = self.native()
        lane = result['lanes']['food']
        self.assertEqual(lane['covered_from'], row('F1', 2)['placed_at'])
        self.assertIsNone(lane['limit'])
        self.assertFalse(lane['exhaustive'])
        self.assertEqual([r['order'] for r in result['orders']], ['F1', 'F3'])

    def test_out_of_order_rows_erase_proof(self):
        self.fixture(nownow={'1': [row('NN1'), row('NN2', 1)]})
        lane = self.native()['lanes']['nownow']
        self.assertIsNone(lane['covered_from'])
        self.assertFalse(lane['exhaustive'])

    def test_unzoned_details_are_errors_and_never_history_limits(self):
        order = row('F1')
        order['placed_at'] = '2026-11-10T12:00:00'
        self.fixture(food={'1': [order]})
        result = self.native()
        lane = result['lanes']['food']
        self.assertIsNone(lane['covered_from'])
        self.assertIsNone(lane['limit'])
        self.assertEqual(result['orders'], [])

    def test_minutes_pages_stop_at_window_and_older_rows_need_no_detail(self):
        self.fixture(minutes={'1': [row('M1', 3)], '2': [row('M2', -30)], '3': [row('M3', -90)]})
        result = self.native(since=AT)
        self.assertEqual(result['lanes']['minutes']['pages'], 2)
        self.assertEqual(result['lanes']['minutes']['covered_from'], row('M2', -30)['placed_at'])
        self.assertNotIn('M2', (self.root / 'details.log').read_text())
        self.assertNotIn('minutes:3', (self.root / 'pages.log').read_text())
        self.assertFalse(result['complete'])

    def test_invalid_page_metadata_cannot_extend_negative_proof(self):
        forms = [('wrong page', {'page': 2, 'total_pages': 2}),
                 ('missing count', {'page': 1}), ('invalid count', {'page': 1, 'total_pages': 0})]
        for label, coverage in forms:
            with self.subTest(label=label):
                self.fixture(minutes={'1': [row('M1', -60)]}, coverage_override={'minutes': coverage})
                result = self.native()
                self.assertEqual(len(result['orders']), 1)
                self.assertIsNone(result['lanes']['minutes']['covered_from'])
                self.assertFalse(result['lanes']['minutes']['exhaustive'])

    def test_minutes_reads_tied_boundary_orders_on_the_next_page(self):
        self.fixture(minutes={'1': [row('M1', -15)],
                              '2': [dict(row('M2', -15), total='12.34')],
                              '3': [row('M3', -30)]})
        result = self.native(since=AT - dt.timedelta(minutes=15))
        self.assertEqual(result['lanes']['minutes']['pages'], 3)
        self.assertEqual(charges.order_receipt(CHARGE, AT, AT, lookup=lambda *a, **kw: result)['verdict'], 'receipt')

    def test_unknown_time_gap_erases_negative_coverage(self):
        orders = []
        for oid, minutes in (('N1', -60), ('N2', 0)):
            item = row(oid, minutes)
            item['detail_time'] = item.pop('placed_at')
            orders.append(item)
        self.fixture(marketplace={'1': orders}, fail=['N2'])
        result = self.native()
        self.assertIsNone(result['lanes']['marketplace']['covered_from'])
        self.assertEqual([r['order'] for r in result['orders']], ['N1'])
        complete = proof()
        complete['lanes']['marketplace'] = result['lanes']['marketplace']
        with self.assertRaises(charges.Lookup):
            charges.order_receipt(CHARGE, AT, AT, lookup=lambda *a, **kw: complete)

    def test_marketplace_shipment_statuses_never_freeze_order_totals(self):
        forms = [('single terminal', ['delivered']), ('mixed', ['delivered', 'preparing']),
                 ('all terminal', ['delivered', 'delivered']), ('cancelled', ['cancelled'])]
        for label, statuses in forms:
            with self.subTest(label=label):
                self.fixture(marketplace={'1': [dict(row('N1', status=status), total='1.00') for status in statuses]})
                lookup.read('noon', cache_path=self.cache)
                self.fixture(marketplace={'1': [dict(row('N1', status=status), total='2.00') for status in statuses]})
                result = lookup.read('noon', cache_path=self.cache)
                if 'cancelled' in statuses:
                    self.assertEqual(result['orders'], [])
                else:
                    self.assertEqual(result['orders'][0]['total'], '2.00')
                self.assertFalse(any(r['service']=='marketplace' for r in json.loads(self.cache.read_text())))

    def test_shipment_cancellations_never_authorize_no_order_or_ask(self):
        forms = [('cancelled first', ['cancelled', 'preparing']),
                 ('cancelled second', ['preparing', 'cancelled']),
                 ('all cancelled', ['cancelled', 'cancelled']),
                 ('failed shipment', ['failed', 'preparing']),
                 ('single cancelled', ['cancelled'])]
        for label, statuses in forms:
            with self.subTest(label=label):
                self.fixture(marketplace={'1': [dict(row('N1', status=status), total='12.34')
                                                 for status in statuses]})
                result = self.native()
                self.assertIsNone(result['lanes']['marketplace']['covered_from'])
                self.assertFalse(result['complete'])
                with patch.object(lookup, 'read', return_value=result), \
                        patch.object(charges, 'receipt', return_value=None), \
                        patch.object(charges, 'card_owner', return_value='abdullah'):
                    verdict = charges.explain(CHARGE, AT, AT + dt.timedelta(days=3), said=lambda *a, **kw: [])
                self.assertEqual(verdict['verdict'], 'unverified')
                self.assertTrue(verdict['errors'])

    def test_terminal_cache_reuse_nonterminal_refetch_corrupt_empty_and_projection(self):
        self.fixture(food={'1': [row('F1'), row('F2', -1, 'preparing')]})
        lookup.read('noon', cache_path=self.cache)
        lookup.read('noon', cache_path=self.cache)
        calls = (self.root / 'details.log').read_text().splitlines()
        self.assertEqual(calls.count('food:F1'), 1)
        self.assertEqual(calls.count('food:F2'), 2)
        cached = json.loads(self.cache.read_text())
        self.assertEqual(len(cached), 1)
        self.assertEqual(set(cached[0]), set(lookup.CACHE_FIELDS))
        self.assertNotIn('PRIVATE', self.cache.read_text())
        self.assertNotIn('9999', self.cache.read_text())
        self.cache.write_text('broken json')
        lookup.read('noon', cache_path=self.cache)
        self.assertEqual((self.root / 'details.log').read_text().count('food:F1'), 2)

    def test_careem_only_allowlisted_failure_is_limit(self):
        for code in (lookup.BINDING_LIMIT, 'OTHER_PRIVATE_FAILURE'):
            with self.subTest(code=code):
                (self.root / 'careem_http_orders.py').write_text(
                    "def orders():raise ValueError(" + repr(code) + ")\n")
                with patch.object(fcntl, 'flock') as lock, self.assertRaises(ValueError) as exc:
                    lookup.read('careem', cache_path=self.cache)
                lock.assert_not_called()
                self.assertFalse(self.cache.with_suffix('.lock').exists())
                if code == lookup.BINDING_LIMIT:
                    self.assertIsInstance(exc.exception, lookup.SourceLimit)
                    self.assertEqual(exc.exception.code, code)
                    with patch.object(lookup, 'read', side_effect=exc.exception):
                        with self.assertRaises(charges.SourceLimit):
                            charges.order_receipt(dict(CHARGE, merchant='careem'), AT, AT)
                else:
                    self.assertNotIsInstance(exc.exception, lookup.SourceLimit)
                    self.assertEqual(str(exc.exception), 'order lookup unavailable')

    def test_cache_cap_drops_oldest(self):
        cached = [dict(row('F'+str(i), -i), service='food', total=1, currency='AED', cached_at=AT.isoformat())
                  for i in range(1002)]
        self.cache.write_text(json.dumps(cached))
        self.fixture()
        lookup.read('noon', cache_path=self.cache)
        saved = json.loads(self.cache.read_text())
        self.assertEqual(len(saved), 1000)
        self.assertNotIn('F1001', {r['order'] for r in saved})


if __name__ == '__main__':
    unittest.main()
