"""Receipt slices and archive diagnostics use only simulated archive responses."""
import os

# Before any helper loads: the send guards refuse live sends under this marker, and conftest.py sets it for pytest only.
os.environ.setdefault("ROBOB_TEST", "1")
import contextlib
import io
import json
import subprocess
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

from test_cases import Base, at, finder, nobody, mc

ch = mc.charges


class ReceiptTiming(Base):
    def test_fast_reads_can_finish_the_receipt_before_the_question_budget(self):
        charge = dict(kind='charge', merchant='Acme', amount='12.34', currency='EUR', card='1111')
        now = at('2026-11-15T12:00')
        clock, calls = [1000.0], []
        rows = [dict(id=n, ts=now.timestamp(), sender='Acme') for n in range(1, 12)]
        def archive(argv, **kwargs):
            calls.append(kwargs['timeout'])
            clock[0] += 0.12
            text = '\n'.join(json.dumps(row) for row in rows) if argv[1] == 'search' else \
                ('Acme invoice EUR 12.34' if argv[2] == '11' else 'Usage notice ' + argv[2])
            return subprocess.CompletedProcess(argv, 0, text, '')
        stats = {'msgs_calls': 0}
        with patch.object(ch.time, 'time', lambda: clock[0]), \
                patch.object(ch.time, 'monotonic', lambda: clock[0]), \
                patch.object(ch.subprocess, 'run', archive):
            result = ch.found(charge, now, now, deadline=1006, said=nobody, memo={}, stats=stats)
        self.assertEqual((result['verdict'], result['msgs']), ('receipt', 11))
        self.assertEqual(result['errors'], [])
        self.assertLess(clock[0], 1004)
        self.assertTrue(all(timeout <= ch.MSGS_BUDGET for timeout in calls))
        self.assertEqual(ch.receipt_timing(stats)['receipt_result']['found'], 1)
        self.assertEqual(ch.receipt_timing(stats)['msgs_by_kind']['receipt']['count'], 12)

    def test_receipt_preserves_two_seconds_for_orders_and_the_enclosing_deadline(self):
        charge = dict(kind='charge', merchant='Acme', amount='12.34', currency='EUR', card='1111')
        for remaining in (6, 3, 1):
            with self.subTest(remaining=remaining):
                seen = []
                def receipt(*args, **kwargs):
                    seen.append(args[4])
                    return None
                with patch.object(ch.time, 'time', return_value=1000), \
                        patch.object(ch, 'receipt', receipt), patch.object(ch, 'order_receipt', return_value=None):
                    ch.found(charge, at('2026-11-15T12:00'), at('2026-11-15T12:00'),
                             deadline=1000+remaining, said=nobody)
                self.assertEqual(seen, [1000+min(remaining, 4)])

    def test_msgs_stats_include_timeouts_kinds_and_memo_skips_without_private_text(self):
        stats, clock = {'msgs_calls': 0}, [1000.0]
        def archive(argv, **kwargs):
            clock[0] += 0.1
            if argv[-1] == 'timeout':
                raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
            return subprocess.CompletedProcess(argv, 0, '', '')
        memo = {}
        with patch.object(ch.time, 'monotonic', lambda: clock[0]), patch.object(ch.subprocess, 'run', archive):
            for kind in ('receipt', 'lookups', 'other'):
                with ch.step_timing(stats, kind):
                    argv = ['private-query', kind]
                    ch.msgs(argv, None, 2, memo, stats)
                    ch.msgs(argv, None, 2, memo, stats)
            with self.assertRaises(ch.Lookup), ch.step_timing(stats, 'receipt'):
                ch.msgs(['private-query', 'timeout'], None, 2, memo, stats)
        timing = ch.receipt_timing(stats)
        self.assertEqual((stats['msgs_calls'], timing['msgs_timeouts'], timing['msgs_p50_ms']), (4, 1, 100))
        self.assertEqual(timing['msgs_by_kind'], dict(receipt=dict(count=2, ms=200),
            order=dict(count=1, ms=100), refund=dict(count=0, ms=0), history=dict(count=0, ms=0),
            other=dict(count=1, ms=100)))
        self.assertNotIn('private-query', json.dumps(timing))

    def test_cpu_and_concurrency_diagnostics_are_numeric_and_sources_are_fixed(self):
        stats = {'msgs_calls': 0}
        def usage(*args):
            usage.cpu += 0.05
            return SimpleNamespace(ru_utime=usage.cpu, ru_stime=0)
        usage.cpu = 0
        def archive(argv, **kwargs):
            if argv[-1] == 'outer':
                ch.msgs(['PRIVATE', 'nested'], None, 2, stats=stats)
            return subprocess.CompletedProcess(argv, 0, '', '')
        with patch.object(ch.resource, 'getrusage', usage), patch.object(ch.subprocess, 'run', archive):
            for kind in ('refunds', 'history'):
                with ch.step_timing(stats, kind):
                    ch.msgs(['PRIVATE', 'outer'], None, 2, stats=stats)
        result = ch.receipt_timing(stats)
        self.assertEqual(result['msgs_cpu_ms'], 400)
        self.assertEqual(result['msgs_concurrent_max'], 2)
        for kind in ('refund', 'history'):
            self.assertEqual(result['msgs_by_kind'][kind]['count'], 2)
        self.assertEqual([row['concurrent'] for row in stats['_msgs_calls']], [1, 0, 1, 0])
        self.assertFalse(ch._MSGS_ACTIVE)
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_stale_or_foreign_timing_frames_do_not_classify_new_calls(self):
        stats = {'msgs_calls': 0}
        frames = [dict(name='receipt', stats=stats, active=False, deadline=None),
                  dict(name='receipt', stats=stats, active=True, deadline=time.time()-1),
                  dict(name='receipt', stats={}, active=True, deadline=None)]
        token = ch._TIMING_STACK.set(tuple(frames))
        try:
            with patch.object(ch.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
                ch.msgs(['fake', 'search'], None, 2, stats=stats)
            self.assertEqual(ch.receipt_timing(stats)['msgs_by_kind']['other']['count'], 1)
            self.assertEqual(ch.receipt_timing(stats)['msgs_by_kind']['receipt']['count'], 0)
        finally:
            ch._TIMING_STACK.reset(token)

    def test_receipt_results_classify_each_outcome(self):
        charge = dict(kind='charge', merchant='Acme', amount='12.34', currency='EUR', card='1111')
        now = at('2026-11-15T12:00')
        for outcome, response in [('found', {'ts': now.timestamp()}), ('none', None),
                                  ('out_of_time', ch.Lookup('out of time')),
                                  ('error', ch.Lookup('private unreadable output'))]:
            with self.subTest(outcome=outcome):
                stats = {}
                with patch.object(ch, 'receipt', side_effect=response if isinstance(response, Exception) else None,
                                  return_value=response), patch.object(ch, 'order_receipt', return_value=None):
                    ch.found(charge, now, now, said=nobody, stats=stats)
                self.assertEqual(ch.receipt_timing(stats)['receipt_result'],
                    {key: int(key == outcome) for key in ('found', 'none', 'out_of_time', 'error')})
                self.assertEqual(stats.get('budget_stop_reason'),
                                 'receipt_deadline' if outcome == 'out_of_time' else None)

    def test_outer_timeout_is_counted_and_propagated(self):
        charge = dict(kind='charge', merchant='Acme', amount='12.34', currency='EUR', card='1111')
        clock, stats = [1000.0], {}
        def interrupted(*args, **kwargs):
            clock[0] += 6
            raise mc.CheckTimeout('whole check out of time')
        with patch.object(ch.time, 'time', lambda: clock[0]), patch.object(ch, 'receipt', interrupted), \
                self.assertRaises(mc.CheckTimeout):
            ch.found(charge, at('2026-11-15T12:00'), at('2026-11-15T12:00'), stats=stats)
        self.assertEqual(ch.receipt_timing(stats)['receipt_result']['out_of_time'], 1)

    def test_earlier_enclosing_alarm_counts_both_receipt_and_msgs_timeout(self):
        charge = dict(kind='charge', merchant='Acme', amount='12.34', currency='EUR', card='1111')
        stats = {'msgs_calls': 0}
        before = ch._TIMING_STACK.get()
        def stalled(*args, **kwargs):
            threading.Event().wait(1)
            self.fail('archive escaped the enclosing alarm')
        with patch.object(ch.subprocess, 'run', stalled), self.assertRaises(mc.CheckTimeout), \
                mc.within(time.time() + 0.03, mc.CheckTimeout('earlier check deadline')):
            ch.found(charge, at('2026-11-15T12:00'), at('2026-11-15T12:00'),
                     deadline=time.time()+6, memo={}, stats=stats)
        self.assertEqual(ch._TIMING_STACK.get(), before)
        self.assertEqual(ch.receipt_timing(stats)['receipt_result']['out_of_time'], 1)
        self.assertEqual(ch.receipt_timing(stats)['msgs_timeouts'], 1)

    def test_interrupted_timing_setup_or_final_sample_cannot_leak_source_context(self):
        before = ch._TIMING_STACK.get()
        for stage in ('setup', 'final sample'):
            with self.subTest(stage=stage):
                clock = patch.object(ch.time, 'monotonic', side_effect=[1000, mc.CheckTimeout('sample')]) \
                    if stage == 'final sample' else contextlib.nullcontext()
                setup = patch.object(ch.signal, 'getitimer', side_effect=mc.CheckTimeout('setup')) \
                    if stage == 'setup' else contextlib.nullcontext()
                with self.assertRaises(mc.CheckTimeout), clock, setup, ch.step_timing({}, 'receipt'):
                    pass
                self.assertEqual(ch._TIMING_STACK.get(), before)

    def test_alarm_during_receipt_deadline_capture_is_counted_as_timeout(self):
        charge = dict(kind='charge', merchant='Acme', amount='12.34', currency='EUR', card='1111')
        stats, calls = {}, [0]
        wall = time.time
        def capture():
            calls[0] += 1
            if calls[0] == 3:
                threading.Event().wait(1)
                self.fail('deadline capture escaped the enclosing alarm')
            return wall()
        question_end = wall() + 6
        with self.assertRaises(mc.CheckTimeout), mc.within(wall()+0.03, mc.CheckTimeout('outer')):
            with patch.object(ch.time, 'time', capture):
                ch.found(charge, at('2026-11-15T12:00'), at('2026-11-15T12:00'),
                         deadline=question_end, stats=stats)
        self.assertEqual(ch.receipt_timing(stats)['receipt_result']['out_of_time'], 1)

    def test_logger_drops_private_and_invalid_metric_values(self):
        safe = mc.toollog._fields({'msgs_by_kind': {'receipt': {'count': 2, 'ms': 100,
            'query': 'PRIVATE'}, 'PRIVATE': {'count': 1}, 'other': {'count': True, 'ms': 'PRIVATE'}},
            'receipt_result': {'none': 1, 'error': -1, 'found': 'PRIVATE', 'PRIVATE': 1}})
        self.assertEqual(safe, {'msgs_by_kind': {'receipt': {'count': 2, 'ms': 100}, 'other': {}},
                                'receipt_result': {'none': 1}})

    def test_pings_and_check_log_include_safe_receipt_statistics(self):
        def follow(*args, stats, **kwargs):
            stats.update(_msgs_samples_ms=[100, 200, 300], msgs_timeouts=1,
                         msgs_by_kind={'receipt': {'count': 3, 'ms': 600}},
                         msgs_cpu_ms=123, msgs_concurrent_max=1, receipt_result={'none': 1})
            return []
        with patch.object(mc, 'follow', follow), contextlib.redirect_stderr(io.StringIO()):
            mc.run_check(self.wd, 'receipt-stats', self.data, self.root, at('2026-11-15T12:00'), finder(), nobody)
        pings = json.loads((self.wd / 'pings.json').read_text())['timing']
        rows = [json.loads(line) for path in (self.tmp / 'tool-logs/orders').glob('*.ndjson')
                for line in path.read_text().splitlines()]
        logged, = [row['props'] for row in rows if row['name'] == 'check.run']
        for target in (pings, logged):
            self.assertEqual((target['msgs_timeouts'], target['msgs_p50_ms']), (1, 200))
            self.assertEqual(target['msgs_by_kind']['receipt'], {'count': 3, 'ms': 600})
            self.assertEqual(target['receipt_result']['none'], 1)
            self.assertEqual(target['msgs_cpu_ms'], 123)
            self.assertEqual(target['msgs_concurrent_max'], 1)
            self.assertNotIn('_msgs_calls', target)
            self.assertNotIn('_msgs_samples_ms', target)
