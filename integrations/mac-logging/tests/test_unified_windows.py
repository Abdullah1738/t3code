from collections import Counter
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import jobs
from logwindow import row_timestamp


def records(*times):
    return [dict(timestamp=dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat(),
                 eventMessage='watchdog unresponsive') for at in times]


class UnifiedWindowTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.logs = Path(tmp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=tmp.name)
        env.start()
        self.addCleanup(env.stop)
        jobs.save_state('crashes', dict(unified=100, rollupDay='1969-12-31'))

    def rows(self, name):
        return [row for p in self.logs.glob('*.ndjson') for row in map(json.loads, p.read_text().splitlines())
                if row['name'] == name]

    def collect(self, run, boots=(150,), now=200):
        with patch.object(collector, 'boot_times', return_value=boots), \
             patch.object(collector.unified, '__defaults__', (run, 60)):
            return collector.collect(now, [])

    def test_window_filter_counts_dropped_rows_without_changing_observations(self):
        result = SimpleNamespace(returncode=0, stdout=json.dumps(records(99, 100, 110, 200, 201)), stderr='')
        counts = collector.unified(100, 200, lambda *a,**kw: result)
        self.assertEqual(counts, Counter({('hang', 'system'): 2}))
        self.assertEqual(counts.stats, dict(outsideRows=3, outsideFirst=99, outsideLast=201))
        self.assertTrue(self.collect(lambda *a,**kw: result, boots=()))
        source = self.rows('crash.source')[-1]['props']
        self.assertGreater(source['outsideRows'], 0)
        self.assertEqual(source['outsideLast'], 201)
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 2)

    def test_fake_hangs_only_across_boot_so_both_sides_finish_without_gaps(self):
        calls = []
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            end = float(row_timestamp(command[command.index('--end')+1]))
            self.assertEqual(kwargs['env']['TZ'], 'UTC')
            calls.append((start, end))
            if start < 150 < end:
                raise subprocess.TimeoutExpired(command, 60)
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(100, 149, 150, 151, 200)), stderr='')
        self.assertTrue(self.collect(run))
        self.assertEqual(calls, [(100, 150), (150, 151), (151, 200)])
        self.assertEqual(jobs.read_state('crashes')['unified'], 200)
        self.assertNotIn('unifiedBootPending', jobs.read_state('crashes'))
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 4)

    def test_partial_prefix_does_not_advance_or_count_and_later_boot_piece_is_independent(self):
        fail = [True]
        calls = []
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            end = float(row_timestamp(command[command.index('--end')+1]))
            calls.append((start, end))
            if start == 100 and fail[0]:
                output = json.dumps(records(110, 999))[:-1]+', {"timestamp":'
                raise subprocess.TimeoutExpired(command, 60, output=output.encode())
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(110, 150, 170, 200)), stderr='')
        self.assertFalse(self.collect(run))
        state = jobs.read_state('crashes')
        self.assertEqual(state['unified'], 200)
        self.assertEqual(state['unifiedBootPending'], [[100, 150]])
        self.assertEqual(calls, [(100,150), (150,151), (151,200)])
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 2)
        source = self.rows('crash.source')[-1]['props']
        self.assertTrue(source['partial'])
        self.assertEqual(source['partialRows'], 2)
        fail[0] = False
        self.assertTrue(self.collect(run))
        self.assertEqual(calls[-1], (100,150))
        self.assertNotIn('unifiedBootPending', jobs.read_state('crashes'))
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 4)

    def test_unresolved_boot_minute_does_not_block_later_reads(self):
        from logwindow import BootTimes
        calls = []
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            end = float(row_timestamp(command[command.index('--end')+1]))
            self.assertFalse(start < 180 and end > 120)
            calls.append((start,end))
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(110,200)), stderr='')
        self.assertFalse(self.collect(run, boots=BootTimes([], [(120,180)])))
        self.assertEqual(calls, [(100,120), (180,200)])
        state = jobs.read_state('crashes')
        self.assertEqual(state['unified'], 200)
        self.assertNotIn('unifiedRetry', state)
        skipped = [r['props'] for r in self.rows('crash.source') if r['props'].get('reason') == 'bootUnresolved']
        self.assertEqual(sum(r['skippedS'] for r in skipped), 60)
        self.assertTrue(self.rows('crash.source')[-1]['props']['partial'])
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 2)

    def test_failed_boot_second_stays_pending_while_post_boot_read_finishes(self):
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            end = float(row_timestamp(command[command.index('--end')+1]))
            if start == 150:
                self.assertEqual(end, 151)
                raise subprocess.TimeoutExpired(command, 60, output=json.dumps(records(999))[:-1])
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(149,150,151,200)), stderr='')
        self.assertFalse(self.collect(run))
        state = jobs.read_state('crashes')
        self.assertEqual(state['unified'], 200)
        self.assertEqual(state['unifiedBootPending'], [[150,151]])
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 3)
        self.assertGreaterEqual(self.rows('crash.source')[-1]['props']['lagS'], 50)

    def test_boot_second_pending_twice_then_explicitly_skipped_on_third_failure(self):
        calls = []
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            if start == 150:
                calls.append(kwargs['timeout'])
                self.assertLessEqual(kwargs['timeout'], 10)
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(149,150,170,200)), stderr='')
        for attempt in (1,2,3):
            self.assertFalse(self.collect(run))
            state = jobs.read_state('crashes')
            if attempt < 3:
                self.assertEqual(state['unifiedBootPending'], [[150,151]])
                self.assertEqual(state['unifiedBootAttempts']['150'], attempt)
            else:
                self.assertNotIn('unifiedBootPending', state)
                skips = [r['props'] for r in self.rows('crash.source')
                         if r['props'].get('reason') == 'bootSecondUnreadable']
                self.assertEqual(sum(r['skippedS'] for r in skips), 1)
            self.assertEqual(state['unified'], 200)
            self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 4)
        self.assertTrue(self.collect(run))
        self.assertEqual(len(calls), 3)

    def test_frozen_retry_before_new_boot_does_not_block_fresh_coverage(self):
        jobs.save_state('crashes', dict(unified=100, rollupDay='1969-12-31',
                        unifiedRetry=dict(windowStart=100,windowEnd=120,skippedS=0)))
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            if start == 100:
                raise subprocess.TimeoutExpired(command, 60)
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(170,200)), stderr='')
        self.assertFalse(self.collect(run))
        state = jobs.read_state('crashes')
        self.assertEqual(state['unified'], 200)
        self.assertEqual(state['unifiedBootPending'], [[100,120]])
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 2)

    def test_frozen_and_fresh_windows_have_separate_row_counters(self):
        jobs.save_state('crashes', dict(unified=100, rollupDay='1969-12-31',
                        unifiedRetry=dict(windowStart=100,windowEnd=120,skippedS=0)))
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            rows = records(110,999) if start == 100 else []
            return SimpleNamespace(returncode=0, stdout=json.dumps(rows), stderr='')
        self.assertTrue(self.collect(run, boots=()))
        sources = [row['props'] for row in self.rows('crash.source')]
        self.assertEqual(len(sources), 2)
        self.assertEqual(sources[0]['outsideRows'], 1)
        for key in ('outsideRows','outsideFirst','outsideLast','unparsedRows','partialRows'):
            self.assertNotIn(key, sources[1])

    def test_deadline_during_chunk_start_does_not_consume_a_boot_attempt(self):
        for pending in (False, True):
            with self.subTest(pending=pending):
                clock = [0]
                state = dict(unified=150, rollupDay='1969-12-31', unifiedBootAttempts={'150':2})
                if pending:
                    state.update(unified=200, unifiedBootPending=[[150,151]])
                jobs.save_state('crashes', state)
                events = []
                def emit(*args, **kwargs):
                    events.append(kwargs.get('props', {}))
                    if args[2] == 'crash.unified.chunk' and kwargs['props']['outcome'] == 'start':
                        clock[0] = 200
                    return True
                real_deadline_call = collector.deadline_call
                def expire(deadline, operation, *args, **kwargs):
                    # Hole reads have no chunk-start event; model the same race
                    # between the budget check and entering the bounded reader.
                    if pending:
                        clock[0] = 200
                    return real_deadline_call(deadline, operation, *args, **kwargs)
                def run(*args, **kwargs):
                    self.fail('deadline-exhausted command was started')
                with patch.object(collector.time, 'monotonic', side_effect=lambda:clock[0]), \
                        patch.object(collector, 'emit', side_effect=emit), \
                        patch.object(collector, 'deadline_call', side_effect=expire):
                    self.assertFalse(self.collect(run))
                state = jobs.read_state('crashes')
                self.assertEqual(state['unifiedBootAttempts']['150'], 2)
                self.assertIn([150,151], state['unifiedBootPending'])
                self.assertFalse(any(p.get('reason') == 'bootSecondUnreadable' for p in events))

    def test_fractional_boot_fragments_share_the_terminal_attempt_count(self):
        for fraction in (0.000001, 0.25, 0.5, 0.75, 0.999999):
            with self.subTest(fraction=fraction):
                split = 150+fraction
                jobs.save_state('crashes', dict(unified=151, rollupDay='1969-12-31',
                    unifiedBootPending=[[150, split], [split, 151]], unifiedBootAttempts={'150': 2}))
                before = len(self.rows('crash.source'))
                observations = sum(r['props']['count'] for r in self.rows('crash.observed'))
                calls = []
                def run(command, **kwargs):
                    start = float(row_timestamp(command[command.index('--start')+1]))
                    if start == 150:
                        self.assertEqual(command[command.index('--end')+1], '1970-01-01 00:02:31+0000')
                        calls.append(kwargs['timeout'])
                        raise subprocess.TimeoutExpired(command, kwargs['timeout'])
                    return SimpleNamespace(returncode=0, stdout=json.dumps(records(200)), stderr='')
                self.assertFalse(self.collect(run))
                state = jobs.read_state('crashes')
                self.assertEqual(len(calls), 1)
                self.assertNotIn('unifiedBootPending', state)
                self.assertEqual(state['unifiedBootAttempts']['150'], 3)
                self.assertEqual(state['unified'], 200)
                skips = [r['props']['skippedS'] for r in self.rows('crash.source')[before:]
                         if r['props'].get('reason') == 'bootSecondUnreadable']
                self.assertAlmostEqual(sum(skips), 1)
                self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed'))-observations, 1)
                self.assertTrue(self.collect(run))
                self.assertEqual(len(calls), 1)

    def test_hole_budget_reserves_a_full_call_for_fresh_coverage(self):
        clock = [0]
        jobs.save_state('crashes', dict(unified=180, rollupDay='1969-12-31',
                                      unifiedBootPending=[[100,120],[130,140]]))
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            if start < 180:
                clock[0] += kwargs['timeout']
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            self.assertGreaterEqual(kwargs['timeout'], 20)
            clock[0] += 20
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(200)), stderr='')
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]):
            self.assertFalse(self.collect(run))
        self.assertEqual(jobs.read_state('crashes')['unified'], 200)
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 1)

    def test_clipped_hole_is_persisted_before_retry_io(self):
        jobs.save_state('crashes', dict(unified=200, rollupDay='1969-12-31',
                                      unifiedBootPending=[[100,150]]))
        def reader(a,b):
            self.assertEqual(jobs.read_state('crashes')['unifiedBootPending'], [[125,150]])
            raise SystemExit('interrupted during retry I/O')
        with patch.object(collector, 'UNIFIED_WINDOW_S', 100):
            with self.assertRaises(SystemExit):
                collector.collect(225, [], reader)
        skips = self.rows('crash.unified.skip')
        self.assertEqual(sum(r['props']['skippedS'] for r in skips), 25)
        with patch.object(collector, 'UNIFIED_WINDOW_S', 100):
            collector.collect(225, [], lambda a,b: Counter())
        self.assertEqual(sum(r['props']['skippedS'] for r in self.rows('crash.unified.skip')), 25)

    def test_observation_replay_after_append_before_checkpoint_is_idempotent(self):
        jobs.save_state('crashes', dict(unified=200, rollupDay='1969-12-31',
                                      unifiedBootPending=[[100,150]]))
        real_emit = collector.emit
        def interrupt(*args, **kwargs):
            result = real_emit(*args, **kwargs)
            if args[2] == 'crash.observed':
                raise SystemExit('interrupted after append')
            return result
        with patch.object(collector, 'emit', side_effect=interrupt):
            with self.assertRaises(SystemExit):
                collector.collect(200, [], lambda a,b: Counter({('hang','system'):1}))
        self.assertIn('unifiedOutbox', jobs.read_state('crashes'))
        self.assertTrue(collector.collect(200, [], lambda a,b: self.fail('completed hole was queried twice')))
        self.assertNotIn('unifiedOutbox', jobs.read_state('crashes'))
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 1)

    def test_deferred_skip_replay_after_append_is_idempotent(self):
        jobs.save_state('crashes', dict(unified=200, rollupDay='1969-12-31',
                                      unifiedBootPending=[[100,150]]))
        real_emit = collector.emit
        def interrupt(*args, **kwargs):
            result = real_emit(*args, **kwargs)
            if args[2] == 'crash.unified.skip':
                raise SystemExit('interrupted after skip append')
            return result
        with patch.object(collector, 'UNIFIED_WINDOW_S', 100), patch.object(collector, 'emit', side_effect=interrupt):
            with self.assertRaises(SystemExit):
                collector.collect(225, [], lambda a,b: Counter())
        with patch.object(collector, 'UNIFIED_WINDOW_S', 100):
            collector.collect(225, [], lambda a,b: Counter())
        self.assertEqual(sum(r['props']['skippedS'] for r in self.rows('crash.unified.skip')), 25)

    def test_unresolved_gap_checkpoint_preserves_reason_and_partial_summary(self):
        from logwindow import BootTimes
        real_save = collector.save_state
        def interrupt(name, state):
            real_save(name, state)
            if state.get('unified') == 180:
                raise SystemExit('after unresolved minute checkpoint')
        def run(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(110,200)), stderr='')
        with patch.object(collector, 'save_state', side_effect=interrupt):
            with self.assertRaises(SystemExit):
                self.collect(run, boots=BootTimes([], [(120,180)]))
        self.assertEqual(jobs.read_state('crashes')['unifiedRetry']['bootUnresolvedS'], 60)
        # Completing the suffix remains a partial source because its checkpoint
        # still carries the unreported reason, even though it skips no new time.
        self.collect(run, boots=BootTimes([], [(120,180)]))
        source = self.rows('crash.source')[-1]['props']
        self.assertTrue(source['partial'])
        self.assertEqual(source['skipReason'], 'bootUnresolved')
        self.assertEqual(source['bootUnresolvedS'], 60)
        self.assertEqual(source['skippedS'], 60)

    def test_deadline_exhaustion_still_checkpoints_failed_boot_piece_as_hole(self):
        jobs.save_state('crashes', dict(unified=150, rollupDay='1969-12-31'))
        clock = [0]
        def run(command, **kwargs):
            start = float(row_timestamp(command[command.index('--start')+1]))
            if start == 150:
                clock[0] = 135
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            return SimpleNamespace(returncode=0, stdout=json.dumps(records(200)), stderr='')
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]):
            self.assertFalse(self.collect(run))
        state = jobs.read_state('crashes')
        self.assertEqual(state['unified'], 151)
        self.assertEqual(state['unifiedBootPending'], [[150,151]])

    def test_timeout_without_boot_keeps_cursor_and_exposes_partial_rows(self):
        def run(command, **kwargs):
            raise subprocess.TimeoutExpired(command, 60, output=json.dumps(records(110,999))[:-1])
        self.assertFalse(self.collect(run, boots=()))
        state = jobs.read_state('crashes')
        self.assertEqual(state['unified'], 100)
        source = self.rows('crash.source')[-1]['props']
        self.assertEqual(source['partialRows'], 2)
        self.assertEqual(source['outsideRows'], 1)
        self.assertEqual(source['outsideLast'], 999)
        self.assertEqual(self.rows('crash.observed'), [])
