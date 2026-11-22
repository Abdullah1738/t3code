import ctypes
import datetime as dt
import errno
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cpu
import cpu_labels
import guard_reclaim as r
import host_native
import mac_guard as m
import toollog
from test_mac_guard import FakeHost, immediate_submit, proc, NOW
from test_guard_reclaim import Native, latest, nproc, stamp


class CommandOutcomeTests(unittest.TestCase):
    def test_missing_redactor_cannot_break_probe_recovery_or_error_schemas(self):
        for failure in (ImportError('missing'), OSError('unavailable')):
            with self.subTest(failure=type(failure).__name__), \
                 patch.object(cpu_labels, 'janitor_redact', side_effect=failure):
                with self.assertRaises(cpu.ProbeError) as caught:
                    raise cpu.ProbeError('parse')
                self.assertEqual(str(caught.exception), 'parse')
                exc = cpu.ProbeError('exit', argv=['/usr/bin/renice'], rc=1, stderr='private data')
                self.assertEqual(exc.stderr, '[redacted]')
                details = cpu.failure_details(exc, 'renice')
                self.assertEqual(details['reason'], '[redacted]')
                self.assertNotIn('private data', json.dumps(details))
                props = dict(stages=dict(renice=details), reason='private data',
                             problems=['private data'], phaseMs={'sessions':1})
                for name in ('macguard.action', 'guard.reclaim'):
                    clean = toollog.safe_fields(props, name)
                    self.assertEqual(clean['reason'], '[redacted]')
                    self.assertNotIn('private data', json.dumps(clean))

    def test_probe_error_keeps_legacy_label_and_bounded_command_details(self):
        cases = [
            (subprocess.CompletedProcess([], 7, '', 'failure\n'+'x'*400), 'exit', 7, None),
            (subprocess.TimeoutExpired([], 2, stderr=b'timed out'), 'timeout', None, None),
            (OSError(errno.ESRCH, 'No such process'), 'unavailable', None, errno.ESRCH),
        ]
        for response, label, rc, number in cases:
            def run(*a, **kw):
                if isinstance(response, Exception):
                    raise response
                return response
            with self.subTest(label=label), self.assertRaises(cpu.ProbeError) as caught:
                cpu.command(['/usr/bin/renice', '20', '-p', '20'], run)
            exc = caught.exception
            self.assertEqual((str(exc), exc.command, exc.rc, exc.errno), (label, 'renice', rc, number))
            self.assertLessEqual(len(exc.stderr), 200)
            details = cpu.failure_details(exc, 'fallback')
            self.assertIn('renice rc=', details['reason'])
            self.assertNotIn('\n', details['reason'])
            self.assertLessEqual(len(details['reason']), 200)

    def test_command_stage_matrix_and_guard_action_rows(self):
        cases = [
            ('success', 0, '', True, 0, '', 'sent', None, None),
            ('taskpolicy-error', 0, '', True, 1, 'Operation not permitted', 'partial', None, None),
            ('renice-gone', 1, 'renice: No such process', False, 0, '', 'gone', errno.ESRCH, 'renice-failed'),
            ('unproven-gone', 1, 'renice: No such process', True, 0, '', 'error', None, 'renice-failed'),
            ('identity-changed', 0, '', False, 0, '', 'sent', None, 'identity-changed'),
            ('long-stderr', 9, 'x'*400, True, 0, '', 'error', None, 'renice-failed'),
        ]
        for name, rc, stderr, same, taskrc, taskerr, expected, number, skipped in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                commands = []
                def run(argv, **kw):
                    commands.append(Path(argv[0]).name)
                    return subprocess.CompletedProcess(argv, rc if commands[-1] == 'renice' else taskrc,
                                                       '', stderr if commands[-1] == 'renice' else taskerr)
                real = m.Host(run)
                with patch.object(real, 'identity_recheck', return_value=dict(same=same)):
                    outcome = real.soften(proc(20))
                self.assertEqual(outcome['result'], expected)
                self.assertEqual(outcome['errno'], number)
                self.assertEqual(outcome['stages']['renice']['rc'], rc)
                self.assertEqual(outcome['stages']['identityRecheck']['same'], same)
                if skipped:
                    self.assertEqual(outcome['stages']['taskpolicy'], dict(result='skipped', reason=skipped))
                    self.assertEqual(commands, ['renice'])
                else:
                    self.assertEqual(commands, ['renice', 'taskpolicy'])
                    self.assertEqual(outcome['stages']['taskpolicy']['rc'], taskrc)
                if expected in ('error', 'partial', 'gone'):
                    self.assertTrue(outcome['reason'])
                    self.assertLessEqual(len(outcome['reason']), 200)
                host = FakeHost()
                p = proc(20)
                host.live[20] = p
                host.soften = lambda p:outcome
                guard = m.Guard(host, Path(tmp)/'state', Path(tmp)/'evidence', dry=False,
                                clock=lambda:NOW, logger=lambda *a,**kw:None, worker_submit=immediate_submit)
                guard.rows, guard.strain, guard.now = {20:p}, True, NOW
                performed = guard.action(p, 'B', 'renice')
                self.assertEqual(performed, rc == 0)
                row = guard.actions[-1]
                self.assertEqual(row['result'], expected)
                self.assertEqual(row['stages'], outcome['stages'])
                self.assertEqual(toollog.safe_fields(row, 'macguard.action'), row)

    def test_identity_probe_retains_failure_and_esrch_skips_taskpolicy(self):
        for number in (errno.EPERM, errno.ESRCH):
            def run(argv, **kw):
                raise OSError(number, os.strerror(number))
            host = m.Host(run)
            identity = host.identity_recheck(proc(20))
            self.assertFalse(identity['same'])
            self.assertEqual(identity['errno'], number)
            with patch.object(host, 'identity_recheck', return_value=dict(same=False)):
                outcome = host.soften(proc(20))
            self.assertEqual(outcome['result'], 'gone' if number == errno.ESRCH else 'error')
            self.assertEqual(outcome['stages']['taskpolicy']['reason'], 'renice-failed')

    def test_probe_error_without_errno_has_action_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            host, p = FakeHost(), proc(20)
            host.live[20] = p
            guard = m.Guard(host, Path(tmp)/'state', Path(tmp)/'evidence', dry=False,
                            clock=lambda:NOW, logger=lambda *a,**kw:None, worker_submit=immediate_submit)
            guard.rows, guard.strain, guard.now = {20:p}, True, NOW
            with patch.object(host, 'soften', side_effect=m.ProbeError('exit')):
                self.assertFalse(guard.action(p, 'B', 'renice'))
            row = guard.actions[-1]
            self.assertEqual(row['result'], 'error')
            self.assertIsNone(row['errno'])
            self.assertEqual(row['reason'], 'renice rc=None: exit')


class NativeOutcomeTests(unittest.TestCase):
    def test_errno_at_every_native_stage_reaches_ladder_log(self):
        for stage in ('identityRead', 'getpriority', 'setpriority', 'readBack'):
            for number in (errno.EPERM, errno.ESRCH):
                with self.subTest(stage=stage, errno=number), tempfile.TemporaryDirectory() as tmp:
                    native = object.__new__(r.Darwin)
                    p = nproc()
                    failure = OSError(number, os.strerror(number)+'x'*300)
                    native.census = lambda:({20:p}, dict(partial=False))
                    native.rss = lambda rows:{pid:3000 for pid in rows}
                    calls = []
                    def row(pid):
                        if stage == 'identityRead':
                            raise failure
                        return dict(p)
                    def getpriority(*a):
                        calls.append('getpriority')
                        if stage == 'getpriority' or stage == 'readBack' and len(calls) == 2:
                            raise failure
                        return 0
                    native.row = row
                    events = []
                    guard = m.Guard(FakeHost(), Path(tmp)/'state', Path(tmp)/'evidence', dry=False,
                        clock=lambda:NOW, logger=lambda c,k,n,**kw:events.append((n,kw['props'])), worker_submit=immediate_submit)
                    with patch.object(os, 'getpriority', side_effect=getpriority), \
                         patch.object(os, 'setpriority', side_effect=failure if stage == 'setpriority' else None) as setter:
                        r.Reclaimer(guard, Path(tmp)/'logs', native=native,
                                    janitor=lambda:dict(result='completed')).tick(NOW, latest(NOW))
                    action = next(p for n,p in events if n == 'guard.reclaim' and p.get('pid') == 20 and p.get('step') == 'renice')
                    self.assertEqual((action['stage'], action['errno']), (stage, number))
                    self.assertEqual(action['result'], 'gone' if number == errno.ESRCH else 'error')
                    self.assertLessEqual(len(action['strerror']), 200)
                    self.assertTrue(action['reason'])
                    self.assertEqual(action['stages'][stage]['errno'], number)
                    self.assertEqual(toollog.safe_fields(action, 'guard.reclaim'), action)
                    self.assertEqual(setter.call_count, int(stage in ('setpriority', 'readBack')))

    def test_native_identity_syscalls_preserve_errno(self):
        for number in (errno.EPERM, errno.ESRCH):
            def fail(*a):
                ctypes.set_errno(number)
                return 0
            native = object.__new__(host_native.Native)
            native.proc = SimpleNamespace(proc_pidinfo=fail)
            with self.subTest(operation='pidinfo', errno=number), self.assertRaises(OSError) as caught:
                native.info(20, 3, host_native.BsdInfo)
            self.assertEqual(caught.exception.errno, number)
            darwin = object.__new__(r.Darwin)
            darwin.native = SimpleNamespace(info=lambda *a:host_native.BsdInfo(pid=20),
                                           proc=SimpleNamespace(proc_pidpath=fail))
            with self.subTest(operation='pidpath', errno=number), self.assertRaises(OSError) as caught:
                darwin.row(20)
            self.assertEqual(caught.exception.errno, number)


class JanitorEvidenceTests(unittest.TestCase):
    def run_report(self, root, report, *, rc=0, timeout=False, started=100):
        log = root/'janitor'
        log.mkdir(exist_ok=True)
        def run(*a, **kw):
            if report is not None:
                (log/'last.json').write_text(report if isinstance(report, str) else json.dumps(report))
            if timeout:
                raise subprocess.TimeoutExpired(a[0], 120)
            return subprocess.CompletedProcess(a[0], rc)
        with patch.dict(os.environ, {'DEV_JANITOR_LOG_DIR':str(log), 'DEV_JANITOR_WATCH_STATE':str(root/'lock')}):
            return r.run_janitor(run, home=root, clock=lambda:started)

    def test_report_precision_respects_fractional_rung_start(self):
        for started, observed, expected in ((100,100,'fresh'), (100.7,100.8,'fresh'),
                                           (100.7,100.7,'fresh'), (100.7,100.6,'stale'),
                                           (100.7,100,'stale')):
            with self.subTest(started=started, observed=observed), tempfile.TemporaryDirectory() as tmp:
                report = dict(ts=observed, phase_ms={'sessions':1},
                              processes=dict(problems=['process_inventory_unavailable: TimeoutExpired']))
                result = self.run_report(Path(tmp), report, started=started)
                self.assertEqual(result['report'], expected)
                self.assertEqual(result['result'], 'inventory-unavailable' if expected == 'fresh' else 'completed')
                if expected == 'fresh':
                    self.assertEqual(result['phaseMs'], {'sessions':1})
                    self.assertEqual(result['problems'], report['processes']['problems'])

    def test_janitor_report_freshness_shapes_and_problem_bounds(self):
        cases = [
            ('missing', None, 'missing'), ('invalid', '{', 'missing'),
            ('oversize', ' '*1048577, 'missing'), ('not-object', '[]', 'missing'),
            ('stale', dict(ts=99.9), 'stale'), ('bad-ts', dict(ts=True), 'stale'),
            ('nan-ts', dict(ts=float('nan')), 'stale'), ('fresh', dict(ts=100), 'fresh'),
        ]
        for name, report, expected in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                outcome = self.run_report(Path(tmp), report)
                self.assertEqual((outcome['result'], outcome['report']), ('completed', expected))
        for rc, problems in ((0, ['process_inventory_unavailable: TimeoutExpired']),
                             (7, ['x'*300]*7), (0, [])):
            with self.subTest(rc=rc, problems=problems), tempfile.TemporaryDirectory() as tmp:
                report = dict(ts=101, phase_ms={'sessions':1, 'leftover_processes':2000},
                    processes=dict(problems=problems, mcp_summary=dict(reason='process_inventory_unavailable')))
                outcome = self.run_report(Path(tmp), report, rc=rc)
                self.assertEqual(outcome['result'], 'inventory-unavailable')
                self.assertEqual(outcome['report'], 'fresh')
                self.assertEqual(outcome['phaseMs']['sessions'], 1)
                self.assertLessEqual(len(outcome['problems']), 5)
                self.assertTrue(all(len(p) <= 200 for p in outcome['problems']))
                self.assertEqual(self.run_report(Path(tmp), report, timeout=True)['result'], 'timeout')

    def test_census_preserves_inventory_failure_and_per_rung_swap_observations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, events = Path(tmp), []
            report = dict(ts=101, phase_ms={'sessions':1},
                processes=dict(problems=['process_inventory_unavailable: TimeoutExpired']))
            self.now = NOW
            guard = m.Guard(FakeHost(), root/'state', root/'evidence', dry=False,
                clock=lambda:self.now, logger=lambda c,k,n,**kw:events.append((n,kw['props'])), worker_submit=immediate_submit)
            reclaimer = r.Reclaimer(guard, root/'logs', Native(), lambda:self.run_report(root, report))
            readings = iter([(0,1554.5), (5,11144), (5,11144), (6,9927), (6,9927), (7,8835.88)])
            def read(*a):
                offset, swap = next(readings)
                self.now = NOW+offset
                return {'host.vitals':dict(ts=stamp(self.now), props=dict(pressureLevel=1, swapUsedBytes=swap*1048576))}
            with patch.object(r, 'latest_rows', side_effect=read):
                reclaimer.tick(NOW, latest(NOW))
            census = json.loads(next(guard.evidence.glob('*/census.json')).read_text())
            janitor = census['steps']['janitor']
            self.assertEqual(janitor['result'], 'inventory-unavailable')
            self.assertEqual(janitor['problems'], report['processes']['problems'])
            self.assertEqual(janitor['phaseMs'], {'sessions':1})
            for step, before, after in (('janitor',1554.5,11144), ('gui',11144,9927), ('renice',9927,8835.88)):
                row = next(p for n,p in events if n == 'guard.reclaim' and p.get('step') == step and 'freedRssMb' in p)
                self.assertEqual(row['before']['swapUsedBytes'], before*1048576)
                self.assertEqual(row['after']['swapUsedBytes'], after*1048576)
                self.assertEqual(row['after']['pressureLevel'], 1)
                self.assertEqual(row['freedRssMb'], 0)
                self.assertEqual(row['after']['observedAt'], census['steps'][step]['after']['observedAt'])
            self.assertTrue(events[-1][1]['workerDelivered'])

    def test_new_evidence_fields_survive_schema_and_day_cap(self):
        props = dict(stages=dict(renice=dict(rc=1, result='gone', errno=errno.ESRCH, stderr='detail '*80)),
                     reason='reason '*80, problems=['problem '*80]*7, phaseMs={'sessions':1})
        clean = toollog.safe_fields(props, 'guard.reclaim')
        self.assertLessEqual(len(clean['reason']), 200)
        self.assertLessEqual(len(clean['stages']['renice']['stderr']), 200)
        self.assertEqual(len(clean['problems']), 5)
        self.assertLessEqual(len(clean['problems'][0]), 200)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'TOOLLOG_DIR':tmp}), patch.object(toollog, 'CAP_BYTES', 0):
            for name in ('macguard.action', 'guard.reclaim'):
                self.assertTrue(toollog.emit('mac-guard', 'event', name, props=props,
                                            now=dt.datetime.fromtimestamp(NOW, dt.timezone.utc)))
            rows = [json.loads(line) for p in Path(tmp).glob('*.ndjson') for line in p.read_text().splitlines()]
        for name in ('macguard.action', 'guard.reclaim'):
            row = next(row for row in rows if row['name'] == name)
            self.assertEqual(row['props']['stages']['renice']['rc'], 1)
            self.assertLessEqual(len(row['props']['stages']['renice']['stderr']), 200)
