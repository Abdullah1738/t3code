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


class UnifiedChunkTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.logs = Path(temp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        self.clock = 0
        self.calls = []
        self.cost = 12
        self.boots = (7300, 8200, 9100, 10000)
        jobs.save_state('crashes', {'unified': 6400, 'rollupDay': '1969-12-31'})

    def rows(self, name):
        return [r for p in self.logs.glob('*.ndjson')
                for r in map(json.loads, p.read_text().splitlines()) if r['name'] == name]

    def log_command(self, cmd, **kwargs):
        def value(flag):
            return dt.datetime.fromisoformat(cmd[cmd.index(flag)+1]).replace(tzinfo=dt.timezone.utc).timestamp()
        start, end = value('--start'), value('--end')-1
        self.calls.append((start, end, kwargs['timeout']))
        # Large windows reproduce the original timeout; small windows complete.
        cost = self.cost*((end-start)/900)**2
        self.clock += min(cost, kwargs['timeout'])
        if cost > kwargs['timeout']:
            raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
        rows = [dict(timestamp=dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat(),
                     eventMessage='=== system boot') for at in self.boots]
        # Real log windows overlap due to second rounding and end padding.
        # Include boundary rows and a repeated marker to exercise deduplication.
        return SimpleNamespace(returncode=0, stdout=json.dumps(rows+rows[:1]), stderr='')

    def collect(self, now=10000, **kwargs):
        unified = collector.unified
        with patch.object(collector.time, 'monotonic', side_effect=lambda: self.clock), \
             patch.object(unified, '__defaults__', (self.log_command,)+unified.__defaults__[1:]):
            return collector.collect(now, [], **kwargs)

    def test_window_scaled_log_finishes_and_records_each_boot_time_once(self):
        self.assertTrue(self.collect())
        self.assertEqual([(a,b) for a,b,_ in self.calls],
                         [(6400,7300),(7300,8200),(8200,9100),(9100,10000)])
        self.assertEqual(self.clock, 48)
        self.assertEqual(jobs.read_state('crashes')['unified'], 10000)
        self.assertNotIn('unifiedRetry', jobs.read_state('crashes'))
        observed = self.rows('crash.observed')
        self.assertEqual([r['props']['observedAt'] for r in observed], list(self.boots))
        self.assertEqual(sum(r['props']['count'] for r in observed), 4)
        props = self.rows('crash.source')[-1]['props']
        self.assertEqual((props['chunks'], props['chunksDone'], props['windowS']), (4,4,3600))

    def test_budget_preserves_completed_chunks_and_retries_only_unfinished_suffix(self):
        self.cost = 42
        self.assertFalse(self.collect())
        state = jobs.read_state('crashes')
        self.assertEqual(self.clock, 135)
        self.assertEqual(state['unified'], 9100)
        self.assertEqual((state['unifiedRetry']['windowStart'], state['unifiedRetry']['windowEnd']), (9100,10000))
        self.assertEqual(self.rows('crash.source')[-1]['props']['chunksDone'], 3)
        self.cost = 12
        self.assertTrue(self.collect(17200))
        self.assertEqual(self.calls[-1][:2], (9100,10000))
        self.assertEqual(jobs.read_state('crashes')['unified'], 10000)
        observed = self.rows('crash.observed')
        self.assertEqual([r['props']['observedAt'] for r in observed], list(self.boots))
        self.assertEqual(sum(r['props']['count'] for r in observed), 4)
        self.assertTrue(self.collect(20800))
        self.assertEqual(self.rows('crash.source')[-1]['props']['skippedS'], 7200)

    def test_completed_chunk_is_checkpointed_before_next_command(self):
        run = self.log_command
        def checkpoint(cmd, **kwargs):
            if self.calls:
                self.assertEqual(jobs.read_state('crashes')['unified'], self.calls[-1][1])
            return run(cmd, **kwargs)
        self.log_command = checkpoint
        self.assertTrue(self.collect())

    def test_interrupted_chunk_checkpoints_preserve_unreported_coverage_gap(self):
        for completed_chunks in (1,2,3,4):
            with self.subTest(completed_chunks=completed_chunks), \
                 patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/str(completed_chunks))):
                self.clock, self.calls = 0, []
                jobs.save_state('crashes', {'unified':10000-86400, 'rollupDay':'1969-12-31'})
                save = collector.save_state
                cursor = 6400+completed_chunks*900
                def interrupt(name, state):
                    save(name, state)
                    if state.get('unifiedRetry') and state['unified'] == cursor:
                        raise SystemExit('interrupted after durable chunk checkpoint')
                with patch.object(collector, 'save_state', side_effect=interrupt), \
                     self.assertRaises(SystemExit):
                    self.collect()
                state = jobs.read_state('crashes')
                self.assertEqual(state['unified'], cursor)
                self.assertEqual(state['unifiedRetry']['skippedS'], 82800)
                self.assertTrue(self.collect(17200))
                self.assertEqual(jobs.read_state('crashes')['unified'], 10000)
                self.assertNotIn('unifiedRetry', jobs.read_state('crashes'))
                rows = [r for p in (self.logs/str(completed_chunks)).glob('*.ndjson')
                        for r in map(json.loads, p.read_text().splitlines())]
                sources = [r for r in rows if r['name'] == 'crash.source']
                summaries = [r for r in rows if r['name'] == 'crash.collect']
                self.assertEqual(len(sources), 1)
                self.assertEqual(sources[0]['props']['skippedS'], 82800)
                self.assertEqual(summaries[0]['props']['skippedS'], 82800)
                observed = [r['props']['observedAt'] for r in rows if r['name'] == 'crash.observed']
                self.assertEqual(observed, list(self.boots))
                self.assertEqual([(a,b) for a,b,_ in self.calls],
                                 [(6400,7300),(7300,8200),(8200,9100),(9100,10000)])

    def test_reported_coverage_gap_is_cleared_before_normal_suffix_retry(self):
        jobs.save_state('crashes', {'unified':10000-86400, 'rollupDay':'1969-12-31'})
        self.cost = 42
        self.assertFalse(self.collect())
        self.assertEqual(self.rows('crash.source')[-1]['props']['skippedS'], 82800)
        self.assertEqual(self.rows('crash.collect')[-1]['props']['skippedS'], 82800)
        self.assertEqual(jobs.read_state('crashes')['unifiedRetry']['skippedS'], 0)
        self.cost = 12
        self.assertTrue(self.collect(17200))
        self.assertEqual(self.rows('crash.source')[-1]['props']['skippedS'], 0)

    def test_absolute_deadline_shortens_shared_budget_and_keeps_suffix(self):
        self.cost = 28
        self.assertFalse(self.collect(deadline=43))
        self.assertEqual(self.clock, 43)
        self.assertEqual(self.calls[-1], (7300,8200,15))
        self.assertEqual(jobs.read_state('crashes')['unifiedRetry']['windowStart'], 7300)

    def test_fractional_boundaries_and_partial_final_chunk(self):
        self.boots = (7300.25, 8200.25, 10000.125)
        jobs.save_state('crashes', {'unified':6400.25, 'rollupDay':'1969-12-31'})
        self.assertTrue(self.collect(10000.125))
        self.assertEqual([r['props']['observedAt'] for r in self.rows('crash.observed')], list(self.boots))
        self.assertEqual(jobs.read_state('crashes')['unified'], 10000.125)

    def test_unusable_timestamp_forms_fail_without_advancing_cursor(self):
        for timestamp in (None, '', 'invalid', 123, [], {}):
            with self.subTest(timestamp=timestamp):
                def run(*args, **kwargs):
                    return SimpleNamespace(returncode=0, stdout=json.dumps([
                        dict(timestamp=timestamp, eventMessage='=== system boot')]), stderr='')
                with patch.object(collector.unified, '__defaults__',
                                  (run,)+collector.unified.__defaults__[1:]):
                    self.assertFalse(collector.collect(10000, []))
                self.assertEqual(jobs.read_state('crashes')['unified'], 6400)
                self.assertEqual(self.rows('crash.source')[-1]['props']['failure'], 'parse')

    def test_failed_second_chunk_keeps_prefix_for_all_failure_forms(self):
        failures = [subprocess.TimeoutExpired('log', 60),
                    SimpleNamespace(returncode=65, stdout='', stderr='log failed'),
                    SimpleNamespace(returncode=1, stdout='', stderr='Operation not permitted'),
                    SimpleNamespace(returncode=0, stdout='invalid', stderr='')]
        for failure in failures:
            with self.subTest(failure=failure):
                jobs.save_state('crashes', {'unified':6400, 'rollupDay':'1969-12-31'})
                self.calls = []
                run = UnifiedChunkTests.log_command.__get__(self)
                def fail(cmd, **kwargs):
                    if self.calls:
                        if isinstance(failure, Exception):
                            raise failure
                        return failure
                    return run(cmd, **kwargs)
                self.log_command = fail
                self.assertFalse(self.collect())
                state = jobs.read_state('crashes')
                self.assertEqual(state['unified'], 7300)
                self.assertEqual(state['unifiedRetry']['windowStart'], 7300)
                self.assertEqual(self.rows('crash.collect')[-1]['props']['count'], 1)
