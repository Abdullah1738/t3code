import datetime as dt
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import jobs


class UnifiedCatchupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.logs = Path(temp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)
        self.clock = 0
        self.calls = []
        self.cost = lambda seconds: 1+seconds/40
        self.boots = list(range(9000, 40000, 30))
        jobs.save_state('crashes', {'unified': 10000-11626,
            'unifiedRetry': dict(windowStart=10000-11626, windowEnd=10000-11336, skippedS=0),
            'rollupDay': '1969-12-31'})

    def rows(self, name):
        return [r for p in self.logs.glob('*.ndjson')
                for r in map(json.loads, p.read_text().splitlines()) if r['name'] == name]

    def command(self, cmd, **kwargs):
        def stamp(flag):
            return dt.datetime.fromisoformat(cmd[cmd.index(flag)+1]).replace(tzinfo=dt.timezone.utc).timestamp()
        start, end = stamp('--start'), stamp('--end')-1
        cost = self.cost(end-start)
        self.calls.append((start, end, kwargs['timeout'], cost <= kwargs['timeout']))
        self.clock += min(cost, kwargs['timeout'])
        if cost > kwargs['timeout']:
            raise subprocess.TimeoutExpired(cmd, kwargs['timeout'])
        return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps([
            dict(timestamp=dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat(),
                 eventMessage='=== system boot') for at in self.boots]))

    def collect(self, now=10000, **kwargs):
        self.clock = 0
        with patch.object(collector.time, 'monotonic', side_effect=lambda: self.clock), \
             patch.object(collector.unified, '__defaults__', (self.command, 60)):
            return collector.collect(now, [], **kwargs)

    def test_proportional_cost_catchup_from_11626_seconds_with_hourly_arrivals(self):
        lag = [11626]
        previous = 10000-11626
        for i in range(4):
            before = len(self.calls)
            before_done = len([r for r in self.rows('crash.unified.chunk') if r['props']['outcome'] == 'done'])
            self.collect(10000+3870*i, deadline=290)
            summary = self.rows('crash.collect')[-1]['props']
            successful = [c for c in self.calls[before:] if c[3]]
            self.assertTrue(successful)
            self.assertLessEqual(self.calls[before][1]-self.calls[before][0], 60)
            self.assertLessEqual(self.clock, 135)
            missing = 0
            done = [r['props'] for r in self.rows('crash.unified.chunk') if r['props']['outcome'] == 'done'][before_done:]
            for chunk in done:
                self.assertGreaterEqual(chunk['windowStart'], previous)
                missing += chunk['windowStart']-previous
                previous = chunk['windowEnd']
            self.assertAlmostEqual(missing, summary['skippedS'])
            self.assertEqual(jobs.read_state('crashes')['unified'], previous)
            lag.append(round(summary['lagS'], 3))
        self.assertLess(lag[1], lag[0])
        self.assertLess(lag[2], 600)
        self.assertLess(lag[-1], 600)
        skips = self.rows('crash.unified.skip')
        self.assertEqual(sum(r['props']['skippedS'] for r in skips), 6226)
        self.assertTrue(all(r['props']['reason'] == 'lag_ceiling' for r in skips))
        observed = [r['props']['observedAt'] for r in self.rows('crash.observed')]
        self.assertEqual(observed, [at for at in self.boots if 4600 < at <= 10000+3*3870])
        self.assertEqual(len(observed), len(set(observed)))
        print('unified catch-up lagS:', lag)

    def test_fixed_overhead_costs_keep_up_without_skipping(self):
        for cost in (15, 30):
            with self.subTest(cost=cost), patch.dict(os.environ, TOOLLOG_DIR=str(self.logs/str(cost))), \
                 patch.object(self, 'logs', self.logs/str(cost)):
                jobs.save_state('crashes', {'unified': 9100, 'rollupDay': '1969-12-31',
                    'unifiedRetry': dict(windowStart=9100, windowEnd=10000, skippedS=0)})
                self.cost = lambda seconds: cost
                for i in range(12):
                    before = len(self.calls)
                    now = 13600+3870*i
                    self.assertTrue(self.collect(now))
                    self.assertEqual(jobs.read_state('crashes')['unified'], now)
                    self.assertLessEqual(self.clock, 135)
                    summary = self.rows('crash.collect')[-1]['props']
                    self.assertEqual(summary['skippedS'], 0)
                    self.assertEqual(summary['chunks'], summary['chunksDone'])
                    self.assertLessEqual(self.calls[before][1]-self.calls[before][0], 60)
                observed = [r['props']['observedAt'] for r in self.rows('crash.observed')]
                self.assertEqual(observed, [at for at in self.boots if 9100 < at <= now])
                self.assertEqual(len(observed), len(set(observed)))

    def test_nonlinear_window_costs_keep_the_nominal_chunk_cap(self):
        jobs.save_state('crashes', {'unified': 4600, 'rollupDay': '1969-12-31'})
        self.cost = lambda seconds: 12*(seconds/900)**2
        self.assertTrue(self.collect())
        self.assertTrue(all(c[3] for c in self.calls))
        self.assertTrue(all(end-start <= 901 for start,end,_,_ in self.calls))
        self.assertEqual(jobs.read_state('crashes')['unified'], 10000)

    def test_large_first_query_would_timeout_but_small_adaptive_chunks_finish(self):
        jobs.save_state('crashes', {'unified': 4600, 'rollupDay': '1969-12-31'})
        # A 900 s query costs 120 s; at most 450 s costs 10 s.
        self.cost = lambda seconds: seconds/45 if seconds <= 450 else 120
        self.assertTrue(self.collect())
        self.assertTrue(all(c[3] for c in self.calls))
        self.assertLess(self.rows('crash.collect')[-1]['props']['lagS'], 135)
        self.assertEqual(jobs.read_state('crashes')['unified'], 10000)

    def test_very_old_retry_is_skipped_and_checkpointed_before_a_hanging_read(self):
        for pending_skip in (0, 9000):
            with self.subTest(pending_skip=pending_skip):
                jobs.save_state('crashes', {'unified': -90000, 'unifiedRetry':
                    dict(windowStart=-90000, windowEnd=-89900, skippedS=pending_skip),
                    'rollupDay': '1969-12-31'})
                before = len(self.calls)
                self.cost = lambda seconds: 1000
                self.assertFalse(self.collect())
                self.assertEqual(self.calls[before][:2], (4600, 4660))
                self.assertEqual(jobs.read_state('crashes')['unified'], 4600)
                self.assertEqual(jobs.read_state('crashes')['unifiedRetry']['windowStart'], 4600)
                skip = self.rows('crash.unified.skip')[-1]['props']
                self.assertEqual((skip['windowStart'], skip['windowEnd'], skip['skippedS']),
                                 (-90000, 4600, 94600))
                summary = self.rows('crash.collect')[-1]['props']
                self.assertEqual(summary['skippedS'], 94600+pending_skip)
                self.assertEqual(summary['skipReason'], 'lag_ceiling')
                self.assertEqual(summary['stopReason'], 'timeout')
                self.assertLessEqual(self.clock, 90)

    def test_chunk_diagnostics_and_deadline_keep_completed_prefix(self):
        jobs.save_state('crashes', {'unified': 6400, 'rollupDay': '1969-12-31'})
        self.assertFalse(self.collect(deadline=10))
        events = self.rows('crash.unified.chunk')
        starts = [r['props'] for r in events if r['props']['outcome'] == 'start']
        ends = [r['props'] for r in events if r['props']['outcome'] != 'start']
        self.assertEqual(len(starts), len(ends))
        for start, end in zip(starts, ends):
            self.assertEqual((start['windowStart'], start['windowEnd'], start['windowS']),
                             (end['windowStart'], end['windowEnd'], end['windowS']))
            self.assertGreaterEqual(end['elapsedMs'], 0)
        last_done = [r for r in ends if r['outcome'] == 'done'][-1]
        self.assertEqual(jobs.read_state('crashes')['unified'], last_done['windowEnd'])
        self.assertEqual(self.rows('crash.collect')[-1]['props']['stopReason'], 'deadline')
        self.assertTrue(self.collect())
        props = self.rows('crash.collect')[-1]['props']
        self.assertEqual(props['stopReason'], 'done')
        self.assertEqual(props['chunks'], props['chunksDone'])

    def test_fractional_retry_tail_does_not_make_fresh_queries_tiny(self):
        jobs.save_state('crashes', {'unified': 9999.875, 'rollupDay': '1969-12-31',
            'unifiedRetry': dict(windowStart=9999.875, windowEnd=10000, skippedS=0)})
        self.assertTrue(self.collect(13600))
        starts = [r['props'] for r in self.rows('crash.unified.chunk') if r['props']['outcome'] == 'start']
        self.assertEqual(starts[0]['windowS'], .125)
        self.assertEqual(starts[1]['windowS'], 60)
        self.assertEqual(jobs.read_state('crashes')['unified'], 13600)

    def test_cleanup_reserve_on_shortened_call_still_reports_deadline(self):
        jobs.save_state('crashes', {'unified': 6400, 'rollupDay': '1969-12-31'})
        def early_timeout(command, **kwargs):
            self.clock += kwargs['timeout']-.5
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        with patch.object(self, 'command', side_effect=early_timeout):
            self.assertFalse(self.collect(deadline=10))
        self.assertLess(self.clock, 10)
        self.assertEqual(self.rows('crash.collect')[-1]['props']['stopReason'], 'deadline')
        self.assertEqual(jobs.read_state('crashes')['unified'], 6400)

    def test_unlogged_checkpoint_loss_cannot_follow_skip_interruption(self):
        save = collector.save_state
        def interrupt(name, state):
            if state.get('unified') == 4600:
                raise SystemExit('after skip log, before state write')
            save(name, state)
        with patch.object(collector, 'save_state', side_effect=interrupt), self.assertRaises(SystemExit):
            self.collect()
        self.assertEqual(jobs.read_state('crashes')['unified'], -1626)
        self.assertEqual(self.rows('crash.unified.skip')[-1]['props']['skippedS'], 6226)
        self.cost = lambda seconds: seconds/40
        self.assertTrue(self.collect())
        self.assertEqual(jobs.read_state('crashes')['unified'], 10000)


class UnifiedProcessTests(unittest.TestCase):
    def test_hanging_process_group_is_killed_and_collector_returns_with_suffix(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, TOOLLOG_DIR=tmp):
            pidfile = Path(tmp)/'child'
            script = ('import subprocess,sys,time; '
                      'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"]); '
                      'open(sys.argv[1],"w").write(str(child.pid)); time.sleep(30)')
            children = []
            real_popen = subprocess.Popen
            def spawn(command, **kwargs):
                child = real_popen([sys.executable, '-c', script, str(pidfile)], **kwargs)
                children.append(child)
                return child
            jobs.save_state('crashes', {'unified': 6400, 'rollupDay': '1969-12-31'})
            started = time.monotonic()
            with patch.object(collector.subprocess, 'Popen', side_effect=spawn), \
                 patch.object(collector, 'UNIFIED_CALL_S', .4):
                self.assertFalse(collector.collect(10000, [], deadline=started+1))
            self.assertLess(time.monotonic()-started, 1)
            self.assertEqual(children[0].wait(timeout=.2), -signal.SIGKILL)
            self.assertEqual(jobs.read_state('crashes')['unified'], 6400)
            self.assertEqual(jobs.read_state('crashes')['unifiedRetry']['windowStart'], 6400)
            descendant = int(pidfile.read_text())
            # A killed grandchild can remain a zombie until init reaps it.
            if Path('/proc/%d/stat' % descendant).exists():
                self.assertEqual(Path('/proc/%d/stat' % descendant).read_text().split()[2], 'Z')
            else:
                with self.assertRaises(ProcessLookupError):
                    os.kill(descendant, 0)

    def test_unkillable_child_reap_is_bounded_within_call_cap(self):
        clock = [0]
        child = SimpleNamespace(pid=12345, stdout=SimpleNamespace(close=lambda: None),
                                stderr=SimpleNamespace(close=lambda: None))
        def communicate(timeout):
            clock[0] += timeout
            raise subprocess.TimeoutExpired('fixture', timeout)
        def wait(timeout):
            clock[0] += timeout
            raise subprocess.TimeoutExpired('fixture', timeout)
        child.communicate, child.wait = communicate, wait
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(collector.subprocess, 'Popen', return_value=child), \
             patch.object(collector.os, 'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                collector.unified_command(['fixture'], timeout=1000)
        self.assertLessEqual(clock[0], 60)
        kill.assert_called_once_with(12345, signal.SIGKILL)

    def test_alarm_exception_also_kills_group_and_reaps(self):
        child = SimpleNamespace(pid=12345, stdout=SimpleNamespace(close=lambda: None),
                                stderr=SimpleNamespace(close=lambda: None),
                                communicate=lambda **kw: (_ for _ in ()).throw(jobs.SourceFailure('timeout', 'alarm')))
        with patch.object(collector.subprocess, 'Popen', return_value=child), \
             patch.object(collector.os, 'killpg') as kill, \
             patch.object(child, 'wait', create=True) as wait:
            with self.assertRaises(jobs.SourceFailure):
                collector.unified_command(['fixture'], timeout=.5)
        kill.assert_called_once_with(12345, signal.SIGKILL)
        self.assertLessEqual(wait.call_args.kwargs['timeout'], .5)
