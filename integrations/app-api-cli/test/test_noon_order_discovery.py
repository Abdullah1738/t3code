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


if __name__ == '__main__':
    unittest.main()
