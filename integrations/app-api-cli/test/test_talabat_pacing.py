"""Shared transport/deadline regressions, with no live catalog access."""
import concurrent.futures as cf
import multiprocessing as mp
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from talabat_transport import SharedState
from native import NativeError
import talabat_native as t
import optimizer


def take_slot(path, out):
    state = SharedState(path)
    with state.slot(True, time.monotonic()+5):
        out.put(time.monotonic())


class SharedTests(unittest.TestCase):
    def test_product_tokens_are_shared_between_processes(self):
        with tempfile.TemporaryDirectory() as root:
            path = str(Path(root)/'state.sqlite3')
            SharedState(path)
            ctx = mp.get_context('spawn')
            out = ctx.Queue()
            processes = [ctx.Process(target=take_slot,args=(path,out)) for _ in range(3)]
            for p in processes:
                p.start()
            stamps = sorted(out.get(timeout=10) for _ in processes)
            for p in processes:
                p.join(5)
                self.assertEqual(p.exitcode, 0)
            self.assertGreaterEqual(stamps[-1]-stamps[0], .75)

    def test_retry_after_survives_process_and_exceeds_current_deadline(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'state.sqlite3'
            first = SharedState(path)
            self.assertEqual(first.backoff('255'), 255)
            second = SharedState(path)
            start = time.monotonic()
            with self.assertRaises(NativeError):
                with second.slot(False, start+.05):
                    self.fail('request escaped shared backoff')
            self.assertLess(time.monotonic()-start, .2)

    def test_cache_expiry_and_singleflight(self):
        with tempfile.TemporaryDirectory() as root:
            state = SharedState(Path(root)/'state.sqlite3')
            calls = []
            def fetch():
                calls.append(1)
                time.sleep(.03)
                return {'status':'open'}
            def one(_):
                return state.cached('status', 30, fetch, time.monotonic()+2)
            with cf.ThreadPoolExecutor(4) as pool:
                self.assertEqual(list(pool.map(one,range(4))), [{'status':'open'}]*4)
            self.assertEqual(len(calls),1)
            state.put('status', {'status':'closed'}, -1)
            self.assertIsNone(state.get('status'))

    def test_batch_discovers_once_preserves_partial_and_does_not_trust_web(self):
        tb = unittest.mock.Mock()
        tb.fallbacks = []
        tb.store_listing.return_value = [{'id':1,'name':'Shop'}, {'id':2,'name':'Unknown'}]
        tb.live_status.return_value = {t.MART_BRANCH:{'status':'open'}, 1:{'status':'open'}, 2:None}
        def products(branch,term,limit):
            if branch == 1 and term == 'eggs':
                raise NativeError('SEARCH_DEADLINE','x')
            return {}, {'items':[{'name':term,'price':2}]}
        tb.products.side_effect = products
        d = t.batch_products(['milk','eggs'], stores=3, open_only=True, tb=tb)
        tb.store_listing.assert_called_once_with('groceries',pages=1)
        self.assertEqual(tb.products.call_count,4)
        self.assertEqual(len(d['milk']['stores']),2)
        self.assertEqual(len(d['eggs']['stores']),1)
        self.assertFalse(d['milk']['coverage']['complete'])
        self.assertEqual(d['milk']['coverage']['product_searches_completed'],3)
        results = [('talabat','groceries',term,data,None) for term,data in d.items()]
        _, errors, _ = optimizer.collect(results,['milk','eggs'],True)
        self.assertEqual(len(errors),2)  # status failure is not repeated per term


if __name__ == '__main__':
    unittest.main()
