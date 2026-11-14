from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jobs


class InventoryStatusTests(unittest.TestCase):
    def test_denials_and_partial_children_preserve_partial_flag(self):
        cases = [
            ('explicit-denial', [dict(deniedCount=2)], 2, 0, True),
            ('denial-with-complete-flag', [dict(deniedCount=2, partial=False)], 2, 0, True),
            ('numeric-float', [dict(deniedCount=2.5, partial=False)], 2.5, 0, True),
            ('partial-true', [dict(partial=True)], 0, 1, True),
            ('partial-missing', [{}], 0, 1, True),
            ('partial-null', [dict(partial=None)], 0, 1, True),
            ('partial-false', [dict(partial=False)], 0, 0, False),
            ('zero-partial-true', [dict(deniedCount=0, partial=True)], 0, 0, True),
            ('zero-partial-missing', [dict(deniedCount=0)], 0, 0, True),
            ('zero-partial-false', [dict(deniedCount=0, partial=False)], 0, 0, False),
            ('null-denial', [dict(deniedCount=None)], 0, 1, True),
            ('string-denial', [dict(deniedCount='2')], 0, 1, True),
            ('boolean-denial', [dict(deniedCount=True)], 0, 1, True),
            ('negative-denial', [dict(deniedCount=-2)], 0, 1, True),
            ('nan-denial', [dict(deniedCount=float('nan'))], 0, 1, True),
            ('infinite-denial', [dict(deniedCount=float('inf'))], 0, 1, True),
            ('oversized-denial', [dict(deniedCount=10**400)], 0, 1, True),
            ('invalid-denial-complete', [dict(deniedCount='2', partial=False)], 0, 0, False),
            ('empty', [], 0, 0, False),
            ('mixed', [dict(deniedCount=2), dict(partial=True), {}, dict(partial=False),
                       dict(deniedCount=0, partial=True), dict(deniedCount=3, partial=False)], 5, 2, True),
        ]
        now = 1000000
        for name, values, denied, partial_children, partial in cases:
            with self.subTest(name=name):
                cache = {str(i): dict(bytes=1024, at=now, **value) for i, value in enumerate(values)}
                entries = [SimpleNamespace(path=key) for key in cache]
                total, status, children = jobs.inventory_status(cache, entries, True, now)
                self.assertEqual(status['deniedCount'], denied)
                self.assertEqual(status['partialChildCount'], partial_children)
                self.assertIs(status['partial'], partial)
                self.assertEqual(total, 1024*len(values))
                self.assertEqual(len(children), len(values))

    def test_other_partial_reasons_without_denials(self):
        now = 1000000
        cases = [
            ('unlisted', dict(bytes=1024, at=now, partial=False), False, 0, 0),
            ('failure', dict(bytes=1024, at=now, partial=False), True, 1, 0),
            ('limited', dict(bytes=1024, at=now, partial=False, limited=True), True, 0, 0),
            ('stale', dict(bytes=1024, at=now-jobs.INVENTORY_FRESH_S, partial=False), True, 0, 0),
            ('unmeasured', dict(partial=True), True, 0, 1),
        ]
        for name, value, listed, failures, partial_children in cases:
            with self.subTest(name=name):
                _, status, _ = jobs.inventory_status({'child': value}, [SimpleNamespace(path='child')],
                                                      listed, now, failures=failures)
                self.assertEqual(status['deniedCount'], 0)
                self.assertEqual(status['partialChildCount'], partial_children)
                self.assertIs(status['partial'], True)
