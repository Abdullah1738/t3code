import datetime as dt
from decimal import Decimal
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import logwindow as window


class WindowTests(unittest.TestCase):
    def test_timestamp_input_class(self):
        for text in ('2026-11-16T08:22:07Z', '2026-11-16 08:22:07+0000',
                     '2026-11-16T08:22:07+00:00', '2026-11-16 12:22:07+0400',
                     '2026-11-16 08:22:07'):
            with self.subTest(text=text):
                self.assertEqual(window.row_timestamp(text), 1794817327)

    def test_split_deduplicates_and_excludes_external_boundaries(self):
        self.assertEqual(window.split_window(100, 400, [0, 100, 200, 200, 300, 400, 500]),
                         [(100, 101), (101, 200), (200, 201), (201, 300), (300, 301), (301, 400)])

    def test_last_candidates_are_refined_to_seconds_with_bounded_reads(self):
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == '/usr/sbin/sysctl':
                out = '{ sec = 1795255948, usec = 443847 }'
            elif args[0] == '/usr/bin/last':
                out = ('reboot time    Sat Nov 21 2026 10:12\n'
                       'shutdown time  Tue Nov 17 2026 12:30\n'
                       'reboot time    Mon Nov 16 2026 08:22\n')
            else:
                out = json.dumps([1794817327, 1795255948])
            return SimpleNamespace(returncode=0, stdout=out)
        with patch.object(window.sys, 'platform', 'darwin'):
            self.assertEqual(window.boot_times(1794817320, 1794817440, run), [1794817327])
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(kw['timeout'] == 2 and kw['env']['TZ'] == 'UTC' for _, kw in calls))
        self.assertIn('-I', calls[-1][0])

    def test_same_minute_occurrences_and_fractional_start_class(self):
        minute = 1794817320
        for history, refined, expected_skip in (
                (2, [minute+47], True),
                (2, [minute+7, minute+47], False),
                (1, [minute+7], False)):
            def run(args, **kwargs):
                if args[0] == '/usr/sbin/sysctl':
                    out = '{ sec = 1795255948 }'
                elif args[0] == '/usr/bin/last':
                    out = 'reboot time Mon Nov 16 2026 08:22\n'*history
                else:
                    out = json.dumps(refined)
                return SimpleNamespace(returncode=0, stdout=out)
            with self.subTest(history=history, refined=refined), patch.object(window.sys, 'platform', 'darwin'):
                result = window.boot_times(minute+7.5, minute+120, run)
                self.assertEqual(bool(result.unresolved), expected_skip)
                if minute+7 in refined:
                    self.assertIn(minute+8, window.boot_boundaries(result))

    def test_ambiguous_or_unreadable_boot_seconds_skip_the_minute(self):
        for result in (SimpleNamespace(returncode=0, stdout='[]'),
                       SimpleNamespace(returncode=1, stdout=''),
                       subprocess.TimeoutExpired('wtmp', 2)):
            def run(args, **kwargs):
                if args[0] == '/usr/sbin/sysctl':
                    return SimpleNamespace(returncode=0, stdout='{ sec = 1795255948 }')
                if args[0] == '/usr/bin/last':
                    return SimpleNamespace(returncode=0, stdout='reboot time Mon Nov 16 2026 08:22')
                if isinstance(result, Exception):
                    raise result
                return result
            with self.subTest(result=result), patch.object(window.sys, 'platform', 'darwin'):
                result = window.boot_times(1794817320, 1794817440, run)
                self.assertEqual(result, [])
                self.assertEqual(result.unresolved, [(1794817320, 1794817380)])


class ReaderBootTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.out = self.root/'rows.ndjson'
        self.fake = self.root/'log'
        self.fake.write_text('#!'+sys.executable+'''\nimport json,os,sys,time
start = sys.argv[sys.argv.index('--start')+1]
end = sys.argv[sys.argv.index('--end')+1]
assert start.endswith('+0000') and end.endswith('+0000')
assert os.environ['TZ'] == 'UTC'
if start < '1970-01-01 00:02:30+0000' < end: time.sleep(60)
for at in (99,100,149,150,151,170,200,201):
 import datetime as dt
 print(json.dumps({'timestamp':dt.datetime.fromtimestamp(at,dt.timezone.utc).isoformat()}))
print('{"count":8,"finished":1}')
''')
        self.fake.chmod(0o700)

    def run_reader(self, boots=(150,), extra=(), reader=None):
        args = ['--start', '1970-01-01T00:01:40Z', '--end', '1970-01-01T00:03:20Z',
                '--deadline', '12', '--out', str(self.out), *extra]
        with patch.dict(os.environ, MAC_LOG_WINDOW_LOG_BIN=str(self.fake)), \
                patch.object(window, 'boot_times', return_value=boots):
            if reader is None:
                code = window.main(args)
            else:
                with patch.object(window, 'read_slice', side_effect=reader):
                    code = window.main(args)
        return code, json.loads(Path(str(self.out)+'.summary.json').read_text())

    def test_boot_cuts_with_and_without_slicing_keep_each_boundary_once(self):
        for extra in ((), ('--slice', '30s'), ('--slice', '100s')):
            with self.subTest(extra=extra):
                code, summary = self.run_reader(extra=extra)
                self.assertEqual(code, 0)
                self.assertEqual(summary['boots'], ['1970-01-01T00:02:30+00:00'])
                self.assertTrue(any(p.get('bootSplit') for p in summary['slices']))
                for part in summary['slices']:
                    self.assertFalse(window.row_timestamp(part['start']) < 150 < window.row_timestamp(part['end']))
                rows = [window.row_timestamp(json.loads(line)['timestamp']) for line in self.out.read_bytes().splitlines()]
                self.assertEqual(rows, list(map(Decimal, (100,149,150,151,170,200))))
                self.assertEqual(summary['unparsed'], 0)
                self.assertGreater(summary['rowsOutside'], 0)

    def test_unresolved_minute_is_partial_without_query_and_later_rows_survive(self):
        code, summary = self.run_reader(window.BootTimes([], [(120,180)]))
        self.assertEqual((code, summary['status'], summary['reason']), (2, 'partial', 'bootUnresolved'))
        self.assertEqual(summary['boots'], [])
        self.assertEqual([p['status'] for p in summary['slices']], ['complete','partial','complete'])
        self.assertEqual(summary['slices'][1]['reason'], 'bootUnresolved')
        rows = [window.row_timestamp(json.loads(line)['timestamp']) for line in self.out.read_bytes().splitlines()]
        self.assertEqual(rows, [100,200])

    def test_failed_boot_second_is_bounded_partial_and_next_piece_is_read(self):
        real = window.read_slice
        def reader(command, left, right, include_end, stop, out, outside):
            if left == 150:
                self.assertEqual(right, 151)
                self.assertLessEqual(stop-time.monotonic(), 6)
                return dict(start=window.stamp(left), end=window.stamp(right), status='partial',
                            reason='deadline', exitCode=-9, elapsedMs=1, **window.counters())
            return real(command, left, right, include_end, stop, out, outside)
        code, summary = self.run_reader(reader=reader)
        self.assertEqual((code, summary['status']), (2, 'partial'))
        self.assertEqual([p['status'] for p in summary['slices']], ['complete','partial','complete'])
        rows = [window.row_timestamp(json.loads(line)['timestamp']) for line in self.out.read_bytes().splitlines()]
        self.assertEqual(rows, [100,149,151,170,200])

    def test_boot_second_deadline_kills_the_process_and_keeps_safe_later_rows(self):
        self.fake.write_text('#!'+sys.executable+'''\nimport json,sys,time
start = sys.argv[sys.argv.index('--start')+1]
if start == '1970-01-01 00:02:30+0000':
 print('{"timestamp":"1970-01-01T00:02:30.5Z"}', flush=True)
 print('{"timestamp":"1970-01-01T01:00:00Z"}', flush=True)
 time.sleep(60)
print(json.dumps({'timestamp':start}), flush=True)
''')
        code, summary = self.run_reader()
        self.assertEqual((code, summary['status']), (2, 'partial'))
        self.assertEqual([p['status'] for p in summary['slices']], ['complete','partial','complete'])
        self.assertLessEqual(summary['slices'][1]['elapsedMs'], 10000)
        self.assertIsNotNone(summary['slices'][1]['exitCode'])
        self.assertEqual(summary['rowsOutside'], 1)
        rows = [window.row_timestamp(json.loads(line)['timestamp']) for line in self.out.read_bytes().splitlines()]
        self.assertEqual(rows, [100, Decimal('150.5'), 151])

    def test_fractional_start_inside_boot_second_keeps_its_safe_end(self):
        code, summary = self.run_reader(extra=('--start','1970-01-01T00:02:30.5Z'))
        self.assertEqual(code, 0)
        self.assertEqual(summary['slices'][0]['end'], '1970-01-01T00:02:31+00:00')
        self.assertTrue(summary['slices'][0]['bootSplit'])

    def test_tiny_slices_plan_only_until_the_deadline(self):
        clock = [0]
        calls = []
        def reader(command, left, right, include_end, stop, out, outside):
            calls.append((left,right))
            clock[0] = 12
            return dict(start=window.stamp(left), end=window.stamp(right), status='partial',
                        reason='deadline', exitCode=-9, elapsedMs=1, **window.counters())
        with patch.object(window.time, 'monotonic', side_effect=lambda:clock[0]):
            code, summary = self.run_reader(boots=(), reader=reader,
                extra=('--end','1970-01-01T01:01:40Z','--slice','0.000001s'))
        self.assertEqual((code,summary['status']), (2,'partial'))
        self.assertEqual(calls, [(Decimal(100),Decimal('100.000001'))])
        self.assertEqual(len(summary['slices']), 1)
        pieces = window.reader_slices(Decimal(120), Decimal(180), Decimal('.000001'),
                                     window.BootTimes([],[(120,180)]))
        self.assertEqual(list(pieces), [(Decimal(120),Decimal(180),True)])

    def test_delayed_row_write_failure_still_kills_and_reaps_the_group(self):
        from unittest.mock import Mock
        child = Mock(pid=123, returncode=-9)
        selector = Mock()
        key = SimpleNamespace(fd=5, fileobj=child.stdout)
        selector.select.side_effect = [[(key,1)], OSError('read interrupted')]
        out = Mock()
        out.write.side_effect = OSError('ENOSPC')
        with patch.object(window.subprocess, 'Popen', return_value=child), \
                patch.object(window.selectors, 'DefaultSelector') as factory, \
                patch.object(window.os, 'set_blocking'), patch.object(window.os, 'killpg') as kill, \
                patch.object(window.os, 'read', return_value=b'{"timestamp":"1970-01-01T00:02:30Z"}\n'):
            factory.return_value.__enter__.return_value = selector
            result = window.read_slice(['log'],Decimal(100),Decimal(200),True,
                                       time.monotonic()+60,out,None)
        self.assertEqual(result['status'], 'error')
        self.assertIn('ENOSPC', result['reason'])
        kill.assert_called_once_with(123, window.signal.SIGKILL)
        child.wait.assert_called_once_with(timeout=1)
        child.stdout.close.assert_called_once()

    def test_boot_discovery_shares_the_overall_deadline(self):
        real = window.boot_times
        for deadline, expected_calls in ((.1,1),(.5,2),(1,3)):
            with self.subTest(deadline=deadline):
                clock, calls = [0], []
                def run(args, **kwargs):
                    calls.append(kwargs['timeout'])
                    elapsed = min(.4, kwargs['timeout'])
                    clock[0] += elapsed
                    if elapsed < .4:
                        raise subprocess.TimeoutExpired(args,kwargs['timeout'])
                    out = ('{ sec = 999 }' if len(calls) == 1 else
                           'reboot time Thu Jan 1 1970 00:02\n')
                    return SimpleNamespace(returncode=0,stdout=out)
                def discover(start,end,deadline):
                    return real(start,end,run=run,deadline=deadline)
                with patch.object(window.sys,'platform','darwin'), \
                        patch.object(window.time,'monotonic',side_effect=lambda:clock[0]), \
                        patch.object(window,'boot_times',side_effect=discover), \
                        patch.object(window.subprocess,'Popen') as spawn:
                    code = window.main(['--start','1970-01-01T00:01:40Z',
                        '--end','1970-01-01T00:03:20Z','--deadline',str(deadline),'--out',str(self.out)])
                summary = json.loads(Path(str(self.out)+'.summary.json').read_text())
                self.assertEqual((code,summary['status']), (2,'partial'))
                self.assertEqual(len(calls), expected_calls)
                self.assertAlmostEqual(clock[0], deadline)
                self.assertTrue(all(0 < timeout <= deadline for timeout in calls))
                spawn.assert_not_called()

    def test_discovery_timeout_initializes_new_and_reused_output_artifacts(self):
        for reuse in (False,True):
            for keep_outside in (False,True):
                with self.subTest(reuse=reuse,keep_outside=keep_outside):
                    out = self.root/('evidence-%s-%s.ndjson' % (reuse,keep_outside))
                    outside = Path(str(out)+'.outside.ndjson')
                    if reuse:
                        out.write_bytes(b'{"timestamp":"1970-01-01T01:00:00Z"}\n')
                        if keep_outside:
                            outside.write_bytes(out.read_bytes())
                    with patch.object(window,'boot_times',side_effect=subprocess.TimeoutExpired('sysctl',1)), \
                            patch.object(window.subprocess,'Popen') as spawn:
                        code = window.main(['--start','1970-01-01T00:01:40Z',
                            '--end','1970-01-01T00:03:20Z','--deadline','1','--out',str(out)]+
                            (['--keep-outside'] if keep_outside else []))
                    self.assertEqual(code, 2)
                    self.assertEqual(out.read_bytes(), b'')
                    if keep_outside:
                        self.assertEqual(outside.read_bytes(), b'')
                    summary = json.loads(Path(str(out)+'.summary.json').read_text())
                    self.assertEqual((summary['status'],summary['rowsIn']), ('partial',0))
                    spawn.assert_not_called()

    def test_coalesced_gap_does_not_steal_safe_read_budget(self):
        calls = []
        def reader(command,left,right,include_end,stop,out,outside):
            calls.append((left,right,stop))
            return dict(start=window.stamp(left),end=window.stamp(right),status='complete',
                        reason=None,exitCode=0,elapsedMs=0,**window.counters())
        with patch.object(window.time,'monotonic',return_value=0):
            code, summary = self.run_reader(window.BootTimes([],[(120,180)]),reader=reader,
                extra=('--start','1970-01-01T00:01:59.999999Z',
                       '--end','1970-01-01T00:03:00.000001Z','--slice','0.000001s'))
        self.assertEqual((code,summary['status']), (2,'partial'))
        self.assertEqual(calls, [(Decimal('119.999999'),Decimal(120),4),
                                 (Decimal(180),Decimal('180.000001'),12)])
        self.assertEqual(len(summary['slices']), 3)
        cases = [
            ('119.999999','180.000001','.000001',[],[(120,180)]),
            ('100','200','30',[],[(120,180)]),
            ('100','200','20',[],[(120,180)]),
            ('100','200','30',[140,147],[(120,180)]),
            ('100','200','20',[],[(0,120)]),
            ('100','260','30',[],[(120,180),(180,240)]),
            ('100','200','30',[150],[]),
        ]
        for start,end,seconds,boots,gaps in cases:
            with self.subTest(start=start,end=end,seconds=seconds,boots=boots,gaps=gaps):
                start,end,seconds = map(Decimal,(start,end,seconds))
                info = window.BootTimes(boots,gaps)
                pieces = list(window.reader_slices(start,end,seconds,info))
                for index,(left,right,_) in enumerate(pieces):
                    self.assertEqual(window.remaining_slices(start,end,seconds,info,left),len(pieces)-index)

    def test_trailer_is_ignored_only_as_the_final_record(self):
        trailer = b'{"count":1,"finished":1}'
        valid = b'{"timestamp":"1970-01-01T00:02:50Z"}\n'
        for suffix in (b'', b'\n', b'\r\n'):
            for final in (True, False):
                with self.subTest(suffix=suffix, final=final):
                    data = valid+trailer+suffix if final else trailer+b'\n'+valid
                    self.fake.write_text('#!'+sys.executable+'\nimport sys\nsys.stdout.buffer.write('+repr(data)+')\n')
                    code, summary = self.run_reader(boots=())
                    self.assertEqual(code, 0)
                    self.assertEqual(summary['unparsed'], 0 if final else 1)
                    self.assertEqual(summary['rowsIn'], 1)
                    self.assertEqual(self.out.read_bytes(), valid)
        stats = window.counters()
        window.keep_row(b'{"count":1,"finished":1,"message":"other"}', Decimal(100), Decimal(200),
                        True, io.BytesIO(), None, stats, final=True)
        self.assertEqual(stats['unparsed'], 1)
