"""Window proofs, source limits and sanitized persistent detail caching."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import datetime as dt
import fcntl
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import marketplace
import charges
import order_lookup as lookup

AT = dt.datetime(2026, 11, 10, 12, tzinfo=dt.timezone.utc)
CHARGE = dict(kind='charge', merchant='noon', amount='12.34', currency='AED', card='1111', pending=False)


def row(oid, minutes=0, status='delivered'):
    return dict(order=oid, placed_at=(AT + dt.timedelta(minutes=minutes)).isoformat(),
                status=status, raw_status=status)


def proof():
    return {'orders': [], 'complete': False, 'lanes': {
        name: dict(walked_at=(AT + dt.timedelta(days=1)).isoformat(), exhaustive=False, covered_from=(AT - dt.timedelta(days=1)).isoformat(), limit=None)
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
                whole_order_complete=row.get('whole_order_complete',False),status=row.get('detail_status','unknown'),
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
        self.assertTrue(all(l['stop_reason'] == 'reader_error' for name, l in result['lanes'].items()
                            if name != 'marketplace'))
        self.assertEqual(result['lanes']['marketplace']['stop_reason'], 'snapshot_incomplete')
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

    def refresh(self, **fixture):
        self.fixture(paging=['marketplace'], **fixture)
        return marketplace.refresh(self.root, self.root)

    def test_refresh_stores_holds_walks_cancellations_and_only_delivered_rows_match(self):
        delivered = dict(row('N4'), whole_order_complete=True, detail_status='delivered')
        result = self.refresh(marketplace={'1': [row('N1', status='cancelled'), row('N2', status='preparing')],
                                          '2': [row('N3', status='unknown'), delivered]})
        self.assertEqual(result['result'], 'end_of_history')
        snapshot, reason = marketplace.load(self.root)
        self.assertIsNone(reason)
        self.assertTrue(snapshot['complete'])
        self.assertEqual(result['known'], 4)
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(set(snapshot), {'version', 'walked_at', 'complete', 'orders'})
        self.assertTrue(all(set(v) == {'createdAt', 'delivered'} for v in snapshot['orders'].values()))
        with patch.object(self.modules['native_orders'], 'orders', side_effect=AssertionError('network')):
            result = lookup.native('noon', str(self.root), cache=lookup.load_cache(self.cache),
                                   snapshot=snapshot, services=('marketplace',))
        self.assertEqual([r['order'] for r in result['orders']], ['N4'])
        self.assertEqual(result['lanes']['marketplace']['hold_count'], 1)
        self.assertTrue(result['complete'])
        self.assertIsNone(result['lanes']['marketplace']['covered_from'])

    def test_refresh_roundtrip_delivery_monotonicity_and_prune(self):
        self.refresh(marketplace={'1': [row('N1'), row('OLD')]})
        self.refresh(marketplace={'1': [dict(row('N1'), whole_order_complete=True, detail_status='delivered')]})
        snapshot, _ = marketplace.load(self.root)
        self.assertEqual(set(snapshot['orders']), {'N1'})
        self.assertTrue(snapshot['orders']['N1']['delivered'])
        calls = (self.root / 'details.log').read_text()
        self.refresh(marketplace={'1': [row('N1', status='cancelled')]})
        self.assertTrue(marketplace.load(self.root)[0]['orders']['N1']['delivered'])
        self.assertEqual((self.root / 'details.log').read_text(), calls)

    def test_incomplete_walk_does_not_advance_proof(self):
        self.refresh(marketplace={'1': [row('N1')]})
        before, _ = marketplace.load(self.root)
        for form in ('budget', 'cursor', 'list'):
            with self.subTest(form=form):
                self.fixture(marketplace={'1': [row('N1')], '2': [row('N2')], '3': [row('N3')]}, paging=['marketplace'])
                original = self.modules['native_orders'].orders
                def fail(*args, **kw):
                    if form == 'budget' and kw['page'] == 2:
                        raise TimeoutError()
                    result = original(*args, **kw)
                    if form == 'cursor':
                        result['coverage']['marketplace']['next_cursor'] = 'same'
                    if form == 'list' and kw['page'] == 2:
                        result['ok'] = False
                    return result
                with patch.object(self.modules['native_orders'], 'orders', side_effect=fail):
                    result = marketplace.refresh(self.root, self.root)
                self.assertEqual(result['result'], {'budget': 'budget', 'cursor': 'invalid_paging', 'list': 'list_error'}[form])
                snapshot, _ = marketplace.load(self.root)
                self.assertEqual(snapshot['walked_at'], before['walked_at'])
                self.assertEqual(snapshot['complete'], before['complete'])

    def test_unknown_detail_and_zone_fail_closed(self):
        for kwargs in ({'fail': ['N1']}, {'marketplace': {'1': [dict(row('N1'), detail_time='2026-11-10T12:00:00')]}}):
            fixture = {'marketplace': {'1': [row('N1')]}, **kwargs}
            result = self.refresh(**fixture)
            self.assertEqual(result['result'], 'placement_unknown')
            self.assertFalse(marketplace.load(self.root)[0]['complete'])

    def test_refresh_scoped_page_progress_controls_proof_and_pruning(self):
        first = dict(row('N1'), item_id='I1', shipment_id='S1')
        forms = (
            ('same card', [first], [first], False),
            ('changed status', [first], [dict(first, status='cancelled')], False),
            ('shipment card replay', [dict(row('N1'), shipment_id='S1')],
             [dict(row('N1'), shipment_id='S1', status='failed')], False),
            ('order card replay', [row('N1')], [row('N1', status='unknown')], False),
            ('new item', [first], [dict(first, item_id='I2')], True),
            ('new shipment', [first], [dict(first, shipment_id='S2')], True),
            ('new shipment without item', [dict(row('N1'), shipment_id='S1')],
             [dict(row('N1'), shipment_id='S2')], True),
            ('overlap plus new card', [first], [first, dict(first, item_id='I2')], True),
            ('empty terminal page', [first], [], True),
        )
        for label, before, after, complete in forms:
            with self.subTest(label=label):
                self.refresh(marketplace={'1': [row('OLD')]})
                saved, _ = marketplace.load(self.root)
                result = self.refresh(marketplace={'1': before, '2': after})
                snapshot, _ = marketplace.load(self.root)
                self.assertEqual(result['result'], 'end_of_history' if complete else 'invalid_paging')
                self.assertEqual('OLD' not in snapshot['orders'], complete)
                if not complete:
                    self.assertEqual(snapshot['walked_at'], saved['walked_at'])
                    self.assertIn(saved['orders']['OLD']['createdAt'], marketplace.lane(snapshot, [])[1]['hold_times'])

    def test_detail_failures_preserve_snapshot_and_save_successful_receipts(self):
        forms = ('exception', 'timeout', 'unzoned', 'wrong_order', 'unverified', 'not_ok', 'bad_receipt')
        good = dict(row('GOOD', -60), whole_order_complete=True, detail_status='delivered')
        bad = row('BAD', 120)
        for previous in ('cold', 'known', 'unknown'):
            for form in forms:
                with self.subTest(previous=previous, form=form):
                    before = marketplace.empty()
                    if previous != 'cold':
                        before.update(complete=True, walked_at=(AT + dt.timedelta(days=1)).isoformat(),
                                      orders={'OLD': {'createdAt': bad['placed_at'], 'delivered': False}})
                        if previous == 'known':
                            before['orders']['BAD'] = {'createdAt': bad['placed_at'], 'delivered': False}
                    (self.root / 'marketplace-placements.json').write_text(json.dumps(before))
                    self.cache.write_text('[]')
                    self.fixture(marketplace={'1': [good, bad]}, paging=['marketplace'])
                    original = self.modules['noon_order_details'].details
                    def fail(oid, *args, **kwargs):
                        if oid != 'BAD':
                            return original(oid, *args, **kwargs)
                        if form in ('exception', 'timeout'):
                            raise TimeoutError() if form == 'timeout' else ValueError('private detail')
                        detail = original(oid, *args, **kwargs)
                        detail.update({'unzoned': {'placed_at': '2026-11-10T12:00:00'},
                                       'wrong_order': {'order': 'OTHER'},
                                       'unverified': {'account_verified': False},
                                       'not_ok': {'ok': False},
                                       'bad_receipt': {'whole_order_complete': True, 'status': 'delivered',
                                                       'total': 'invalid'}}[form])
                        return detail
                    with patch.object(self.modules['noon_order_details'], 'details', side_effect=fail):
                        result = marketplace.refresh(self.root, self.root)
                    self.assertEqual(result['result'], 'budget' if form == 'timeout' else 'placement_unknown')
                    snapshot, reason = marketplace.load(self.root)
                    self.assertIsNone(reason)
                    self.assertEqual(snapshot['walked_at'], before['walked_at'])
                    self.assertEqual(snapshot['complete'], before['complete'])
                    self.assertEqual(snapshot, before)
                    self.assertIn('GOOD', {r['order'] for r in lookup.load_cache(self.cache)})
                    rows, lane = marketplace.lane(snapshot, lookup.load_cache(self.cache))
                    self.assertEqual(lane['exhaustive'], previous != 'cold')
                    if previous != 'cold':
                        result = proof()
                        result['orders'], result['lanes']['marketplace'] = rows, lane
                        self.assertIsNone(charges.order_receipt(CHARGE, AT, AT, lookup=lambda *a, **kw: result))
                    with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '0'}):
                        self.assertEqual(marketplace.refresh_status(self.root), 'started')

    def test_busy_refresh_and_corrupt_snapshot(self):
        with (self.root / 'marketplace-refresh.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(marketplace.refresh(self.root, self.root)['result'], 'busy')
        (self.root / 'marketplace-placements.json').write_text('PRIVATE broken')
        snapshot, reason = marketplace.load(self.root)
        self.assertEqual(snapshot, marketplace.empty())
        self.assertEqual(reason, 'snapshot_corrupt')
        self.refresh(marketplace={'1': [row('N1')]})
        self.assertTrue(marketplace.load(self.root)[0]['complete'])

    def test_snapshot_stop_reasons_and_missing_delivered_cache(self):
        for reason in ('snapshot_missing', 'snapshot_corrupt', None):
            rows, lane = marketplace.lane(marketplace.empty(), [], reason)
            self.assertEqual(lane['stop_reason'], reason or 'snapshot_incomplete')
            self.assertFalse(lane['exhaustive'])
        snapshot = dict(marketplace.empty(), complete=True, walked_at=AT.isoformat(),
                        orders={'N1': {'createdAt': AT.isoformat(), 'delivered': True}})
        self.assertEqual(marketplace.lane(snapshot, [])[1]['stop_reason'], 'placement_unknown')

    def test_refresh_cli_prints_counts_only(self):
        self.fixture(marketplace={'1': [row('PRIVATE')]}, paging=['marketplace'])
        result = subprocess.run([sys.executable, '-I', '-B', lookup.__file__, 'refresh-marketplace',
            '--data', str(self.root), '--root', str(self.root)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertEqual(set(json.loads(result.stdout)), {'orders_total', 'known', 'delivered', 'fetched', 'pages', 'ms', 'result'})
        self.assertNotIn('PRIVATE', result.stdout + result.stderr)

    def test_refresh_respects_native_deadline_contract_and_restores_missing_cache(self):
        import signal
        delivered = dict(row('N1'), whole_order_complete=True, detail_status='delivered')
        self.fixture(marketplace={'1': [delivered]}, paging=['marketplace'])
        original = self.modules['native_orders'].orders
        def native(*args, **kwargs):
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL)[0], 0)
            self.assertGreater(kwargs['timeout'], 0)
            self.assertLessEqual(kwargs['timeout'], 60)
            return original(*args, **kwargs)
        with patch.object(self.modules['native_orders'], 'orders', side_effect=native):
            self.assertEqual(marketplace.refresh(self.root, self.root, 180)['result'], 'end_of_history')
        self.cache.write_text('[]')
        self.assertEqual(marketplace.refresh(self.root, self.root)['fetched'], 1)
        self.assertEqual(len(lookup.load_cache(self.cache)), 1)

    def test_refresh_storage_lock_is_bounded_by_total_budget(self):
        self.fixture(marketplace={'1': [row('N1')]}, paging=['marketplace'])
        with (self.root / 'order-details.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            start = time.monotonic()
            result = marketplace.refresh(self.root, self.root, 0.1)
        self.assertEqual(result['result'], 'cache_busy')
        self.assertLess(time.monotonic() - start, 0.5)

    def test_cache_lock_timeout_persists_latest_refresh_result(self):
        previous_at = '2026-11-16T20:25:19+00:00'
        snapshot = json.dumps(dict(marketplace.empty(), complete=True, walked_at=previous_at))
        path = self.root / 'marketplace-placements.json'
        path.write_text(snapshot)
        (self.root / 'marketplace-refresh.json').write_text(json.dumps({
            'last_result': 'end_of_history', 'last_at': previous_at}))
        self.fixture(marketplace={'1': [row('N1')]}, paging=['marketplace'])
        attempted_at = dt.datetime.now(dt.timezone.utc)
        clock = [time.time()]
        flock = fcntl.flock
        def cache_busy(lock, operation):
            if Path(lock.name).name == 'order-details.lock':
                # Exhaust the parent deadline without racing SIGALRM delivery.
                clock[0] += 2
                raise TimeoutError()
            return flock(lock, operation)
        with patch.object(time, 'time', side_effect=lambda: clock[0]), \
                patch.object(fcntl, 'flock', side_effect=cache_busy):
            result = marketplace.refresh(self.root, self.root, 1)
        self.assertEqual(result['result'], 'cache_busy')
        details = marketplace.refresh_details(self.root, 'skipped')
        self.assertEqual(details['last_result'], 'cache_busy')
        self.assertGreaterEqual(dt.datetime.fromisoformat(details['last_at']), attempted_at)
        self.assertEqual(path.read_text(), snapshot)

        # cases selects watcher helpers on import; isolate that from CLI readers.
        with patch.object(sys, 'path', sys.path[:]), patch.dict(sys.modules):
            import cases
            import run_history
            wd = self.root / 'watcher'
            wd.mkdir()
            with patch.dict(os.environ, {'MONEY_CASES_REFRESH_DISABLED': '1'}), \
                    patch.object(cases, '_run_check', return_value='fixture_event'), \
                    patch.object(cases, 'record_event') as emit:
                cases.run_check(wd, 'fixture', self.root)
            event = next(call for call in emit.call_args_list if call.args[0] == 'check.run')
            reported = event.kwargs['props']['marketplace_refresh']
            self.assertEqual(reported['last_result'], 'cache_busy')
            self.assertEqual(reported['last_at'], details['last_at'])
            summary = run_history.summary(wd)
            self.assertEqual(summary['marketplace_refresh'], reported)
            self.assertIn('last refresh: cache_busy', run_history.format_summary(summary))

    def test_refresh_result_storage_has_its_own_bounded_budget(self):
        self.fixture(marketplace={'1': [row('N1')]}, paging=['marketplace'])
        state_path = self.root / 'marketplace-refresh.json'
        state_path.write_text('{"last_result": "list_error"}')
        replace = os.replace
        def stalled(source, target):
            if target == state_path:
                time.sleep(2)
            return replace(source, target)
        started = time.monotonic()
        with patch.object(os, 'replace', side_effect=stalled):
            result = marketplace.refresh(self.root, self.root, 5)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(result['result'], 'end_of_history')
        self.assertEqual(json.loads(state_path.read_text()), {'last_result': 'list_error'})

    def test_cache_cap_drops_oldest(self):
        cached = [dict(row('F'+str(i), -i), service='food', total=1, currency='AED', cached_at=AT.isoformat())
                  for i in range(1002)]
        self.cache.write_text(json.dumps(cached))
        self.fixture()
        lookup.read('noon', cache_path=self.cache)
        saved = json.loads(self.cache.read_text())
        self.assertEqual(len(saved), 1000)
        self.assertNotIn('F1001', {r['order'] for r in saved})

    def test_cache_cap_preserves_receipts_referenced_by_snapshot(self):
        cached = [dict(row('M'+str(i), i), service='minutes', total=1, currency='AED', cached_at=AT.isoformat())
                  for i in range(1000)]
        delivered = dict(row('OLD', -2000), service='marketplace', total=1, currency='AED',
                         whole_order_complete=True, cached_at=AT.isoformat())
        self.cache.write_text(json.dumps([delivered, *cached]))
        snapshot = dict(marketplace.empty(), complete=True, walked_at=AT.isoformat(), orders={
            'OLD': {'createdAt': delivered['placed_at'], 'delivered': True}})
        (self.root / 'marketplace-placements.json').write_text(json.dumps(snapshot))
        self.fixture()
        for _ in range(2):
            result = lookup.read('noon', cache_path=self.cache)
            self.assertTrue(result['lanes']['marketplace']['exhaustive'])
            self.assertEqual(result['lanes']['marketplace']['cached'], 1)
            self.assertEqual(len(lookup.load_cache(self.cache)), 1001)
            self.assertEqual([r['order'] for r in result['orders']], ['OLD'])


if __name__ == '__main__':
    unittest.main()
