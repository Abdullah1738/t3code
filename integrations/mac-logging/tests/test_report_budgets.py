import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import jobs


class ReportBudgetTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs = self.root/'logs'
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.logs))
        env.start()
        self.addCleanup(env.stop)

    def rows(self, name):
        return [r for p in self.logs.glob('*.ndjson')
                for r in map(json.loads, p.read_text().splitlines()) if r['name'] == name]

    def test_crashes_precede_disk_work_and_inventory_uses_remaining_budget(self):
        clock, budgets, order = [0], [], []
        roots = [self.root/str(i) for i in range(3)]
        def probe():
            order.append('probe')
            clock[0] += 80
        def inventory(**kw):
            order.append('inventory')
            self.assertEqual(kw['deadline'], 290)
            clock[0] += min(145, kw['deadline']-clock[0])
        def reports(*args, **kw):
            clock[0] += 6
            return {}
        def run(cmd, **kw):
            order.append('unified')
            budgets.append(kw['timeout'])
            clock[0] += kw['timeout']
            raise subprocess.TimeoutExpired(cmd, kw['timeout'])
        unified = collector.unified
        collect = collector.collect
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(collector, 'disk_wait'), \
             patch.object(collector, 'disk_tooling_probe', side_effect=probe), \
             patch.object(collector, 'directory_inventory', side_effect=inventory), \
             patch.object(collector, 'reports', side_effect=reports), \
             patch.object(unified, '__defaults__', (run,)+unified.__defaults__[1:]), \
             patch.object(collector, 'collect', side_effect=lambda **kw: collect(10000, roots, **kw)):
            collector.main()
        self.assertLessEqual(clock[0], 290)
        self.assertEqual(budgets, [60])
        self.assertEqual(order, ['unified', 'probe', 'inventory'])
        self.assertEqual(clock[0], 290)
        self.assertEqual(self.rows('crash.source')[-1]['props']['failure'], 'timeout')
        self.assertNotIn('unified', jobs.read_state('crashes'))

    def test_expired_absolute_deadline_starts_no_reports_or_log_query(self):
        with patch.object(collector.time, 'monotonic', return_value=10), \
             patch.object(collector, 'reports') as reports, \
             patch.object(collector, 'unified') as unified:
            self.assertFalse(collector.collect(10000, [self.root], deadline=10))
        reports.assert_not_called()
        unified.assert_not_called()
        self.assertEqual(len([r for r in self.rows('crash.source') if not r['ok']]), 2)

    def test_repeated_timeouts_resume_counts_and_frozen_window_without_duplicates(self):
        first, second = self.root/'First.crash', self.root/'Second.crash'
        for path in (first, second):
            path.write_text('private report contents')
            os.utime(path, (9990,9990))
        clock, reads = [0], []
        stat = Path.stat
        def slow_stat(path, *args, **kwargs):
            if path in (first,second):
                reads.append(path.name)
                clock[0] += 6
            return stat(path,*args,**kwargs)
        order = Path.iterdir
        def iterdir(path):
            return iter((first,second)) if path == self.root else order(path)
        with patch.object(collector.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(Path, 'stat', slow_stat), patch.object(Path, 'iterdir', iterdir):
            self.assertFalse(collector.collect(10000, [self.root], lambda a,b: {}, deadline=65))
            state = jobs.read_state('crashes')
            self.assertNotIn('reports0',state)
            self.assertEqual(state['reports0Pending']['done'], [first.name])
            self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')), 1)
            clock[0] = 0
            self.assertTrue(collector.collect(10001, [self.root], lambda a,b: {}, deadline=65))
            state = jobs.read_state('crashes')
            self.assertEqual(state['reports0'],10000)
            self.assertNotIn('reports0Pending',state)
            self.assertEqual(reads.count(first.name),1)
            self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')),2)
        self.assertTrue(collector.collect(10002, [self.root], lambda a,b: {}))
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')),2)
        self.assertNotIn('private', json.dumps(self.rows('crash.source')+self.rows('crash.observed')))

    def test_report_timeout_stages_keep_prefix_and_recover(self):
        for stage in ('stat', 'header', 'enumeration'):
            with self.subTest(stage=stage):
                jobs.save_state('crashes', {})
                root = self.root/stage
                root.mkdir()
                first = root/'First.crash'
                second = root/'Second.ips'
                first.write_text('private first report')
                second.write_text('{"app_name":"Second","bug_type":"309"}\nprivate stack')
                for path in (first,second):
                    os.utime(path,(9990,9990))
                stat, header, iterdir = Path.stat, collector.report_header, Path.iterdir
                def alarm():
                    signal.raise_signal(signal.SIGALRM)
                def fail_stat(path, *args, **kwargs):
                    if stage == 'stat' and path == second:
                        alarm()
                    return stat(path,*args,**kwargs)
                def fail_header(path):
                    if stage == 'header' and path == second:
                        alarm()
                    return header(path)
                def listing(path):
                    if path != root:
                        return iterdir(path)
                    def entries():
                        yield first
                        if stage == 'enumeration':
                            alarm()
                        yield second
                    return entries()
                before = sum(r['props']['count'] for r in self.rows('crash.observed'))
                with patch.object(Path,'stat',fail_stat), \
                     patch.object(Path,'iterdir',listing), \
                     patch.object(collector,'report_header',side_effect=fail_header):
                    self.assertFalse(collector.collect(10000,[root],lambda a,b: {}))
                self.assertEqual(jobs.read_state('crashes')['reports0Pending']['done'],[first.name])
                self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed'))-before,1)
                self.assertTrue(collector.collect(10001,[root],lambda a,b: {}))
                self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed'))-before,2)
                self.assertNotIn('reports0Pending',jobs.read_state('crashes'))
                self.assertNotIn('private',json.dumps(self.rows('crash.observed')))

    def test_new_report_after_frozen_window_is_collected_in_next_window(self):
        first, second = self.root/'First.crash', self.root/'Second.crash'
        first.write_text('private')
        second.write_text('private')
        for path in (first,second):
            os.utime(path,(9990,9990))
        # Trigger the timeout inside bounded file I/O, not a counter update.
        stat = Path.stat
        def fail_stat(path,*args,**kw):
            if path == second:
                signal.raise_signal(signal.SIGALRM)
            return stat(path,*args,**kw)
        iterdir = Path.iterdir
        def ordered(path):
            return iter((first,second)) if path == self.root else iterdir(path)
        with patch.object(Path,'iterdir',ordered), patch.object(Path,'stat',fail_stat):
            self.assertFalse(collector.collect(10000,[self.root],lambda a,b: {}))
        later = self.root/'Later.crash'
        later.write_text('private')
        os.utime(later,(10000.5,10000.5))
        self.assertTrue(collector.collect(10001,[self.root],lambda a,b: {}))
        self.assertEqual(jobs.read_state('crashes')['reports0'],10000)
        self.assertTrue(collector.collect(10002,[self.root],lambda a,b: {}))
        self.assertEqual(sum(r['props']['count'] for r in self.rows('crash.observed')),3)

    def test_bounded_io_interrupts_and_restores_alarm_handler(self):
        before = signal.getsignal(signal.SIGALRM)
        with self.assertRaises(jobs.SourceFailure) as raised:
            collector.deadline_call(collector.time.monotonic()+10,
                                    lambda: signal.raise_signal(signal.SIGALRM))
        self.assertEqual(raised.exception.failure, 'timeout')
        self.assertEqual(signal.getsignal(signal.SIGALRM),before)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL),(0,0))
