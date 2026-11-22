import datetime as dt
from decimal import Decimal
import io
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
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collector
import jobs
from logwindow import row_timestamp, signal_group, read_slice

BASE = Path(__file__).resolve().parents[1]
START = '2026-11-16T08:22:00Z'
END = '2026-11-16T08:24:00Z'


class TimestampTests(unittest.TestCase):
    def test_timestamp_class(self):
        forms = [
            ('2026-11-16T08:22:07Z', 0),
            ('2026-11-16 08:22:07+0000', 0),
            ('2026-11-16T08:22:07+00:00', 0),
            ('2026-11-16 08:22:07.123456+0000', 123456),
            ('2026-11-16T08:22:07.123456Z', 123456),
            ('2026-11-16T08:22:07.1+00:00', 100000),
            ('2026-11-16T08:22:07.12Z', 120000),
            ('2026-11-16T08:22:07.123Z', 123000),
            ('2026-11-16T08:22:07.1234Z', 123400),
            ('2026-11-16T08:22:07.12345Z', 123450),
            ('2026-11-16T08:22:07,123456Z', 123456),
            ('2026-11-16 04:22:07.123456-0400', 123456),
            ('2026-11-16 08:22:07', 0),
        ]
        for value, micros in forms:
            with self.subTest(value=value):
                self.assertEqual(row_timestamp(value), Decimal('1794817327')+Decimal(micros)/1000000)
        for value in (None, '', 'private', 123, {}, '2026-13-16T08:22:07Z'):
            with self.subTest(value=value):
                self.assertIsNone(row_timestamp(value))

    def test_nanosecond_precision_and_unsupported_precision(self):
        self.assertEqual(row_timestamp('2026-11-16T08:22:07.123456789Z'), Decimal('1794817327.123456789'))
        self.assertIsNone(row_timestamp('2026-11-16T08:22:07.1234567891Z'))

    def test_darwin_zombie_group_eperm_is_not_a_cleanup_failure(self):
        for reaped in (0, -15, None):
            with self.subTest(reaped=reaped), patch('logwindow.os.killpg', side_effect=PermissionError('EPERM')):
                child = Mock(pid=123)
                child.poll.return_value = reaped
                if reaped is None:
                    with self.assertRaises(PermissionError):
                        signal_group(child, 9)
                else:
                    signal_group(child, 9)

    def test_live_cleanup_failure_remains_error_when_reap_times_out(self):
        child = Mock(pid=123)
        child.poll.return_value = None
        child.wait.side_effect = subprocess.TimeoutExpired('log', 1)
        with patch('logwindow.subprocess.Popen', return_value=child), \
                patch('logwindow.selectors.DefaultSelector', side_effect=OSError('read failed')), \
                patch('logwindow.os.killpg', side_effect=PermissionError('EPERM')):
            result = read_slice(['log'], row_timestamp(START), row_timestamp(END), True,
                                time.monotonic()+1, io.BytesIO(), None)
        self.assertEqual(result['status'], 'error')
        self.assertIn('process-group cleanup failed', result['reason'])
        self.assertIn('EPERM', result['reason'])
        child.stdout.close.assert_called_once()

    def test_deadline_kill_is_not_repeated_before_reaping(self):
        child = Mock(pid=123, returncode=None)
        child.poll.return_value = None
        signals = []

        def kill_group(pid, sig):
            signals.append(sig)
            if signals.count(signal.SIGKILL) > 1:
                raise PermissionError('Darwin exiting group')

        def reap(timeout):
            child.returncode = -signal.SIGKILL
            return child.returncode

        child.wait.side_effect = reap
        selector = Mock()
        selector.select.return_value = []
        with patch('logwindow.subprocess.Popen', return_value=child), \
                patch('logwindow.selectors.DefaultSelector') as factory, \
                patch('logwindow.os.set_blocking'), \
                patch('logwindow.os.killpg', side_effect=kill_group), \
                patch('logwindow.time.monotonic', side_effect=[0, 0, 3, 3]):
            factory.return_value.__enter__.return_value = selector
            result = read_slice(['log'], row_timestamp(START), row_timestamp(END), True,
                                0, io.BytesIO(), None)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['reason'], 'deadline')
        self.assertEqual(result['exitCode'], -signal.SIGKILL)
        self.assertEqual(signals, [signal.SIGTERM, signal.SIGKILL])
        child.wait.assert_called_once_with(timeout=1)
        child.stdout.close.assert_called_once()

    def test_deadline_cleanup_eperm_waits_for_reap(self):
        for reaps in (True, False):
            with self.subTest(reaps=reaps):
                child = Mock(pid=123, returncode=None)
                child.poll.return_value = None

                def kill_group(pid, sig):
                    if sig == signal.SIGKILL:
                        raise PermissionError('EPERM while exiting')

                def reap(timeout):
                    if not reaps:
                        raise subprocess.TimeoutExpired('log', timeout)
                    child.returncode = -signal.SIGKILL
                    return child.returncode

                child.wait.side_effect = reap
                selector = Mock()
                selector.select.return_value = []
                with patch('logwindow.subprocess.Popen', return_value=child), \
                        patch('logwindow.selectors.DefaultSelector') as factory, \
                        patch('logwindow.os.set_blocking'), \
                        patch('logwindow.os.killpg', side_effect=kill_group), \
                        patch('logwindow.time.monotonic', side_effect=[0, 0, 3, 3]):
                    factory.return_value.__enter__.return_value = selector
                    result = read_slice(['log'], row_timestamp(START), row_timestamp(END), True,
                                        0, io.BytesIO(), None)
                if reaps:
                    self.assertEqual(result['status'], 'partial')
                    self.assertEqual(result['reason'], 'deadline')
                    self.assertEqual(result['exitCode'], -signal.SIGKILL)
                else:
                    self.assertEqual(result['status'], 'error')
                    self.assertIn('process-group cleanup failed', result['reason'])
                    self.assertIn('EPERM', result['reason'])
                child.wait.assert_called_once_with(timeout=1)
                child.stdout.close.assert_called_once()


class WindowTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.out = self.root/'rows.ndjson'
        self.fake = self.root/'log'
        self.env = dict(os.environ, MAC_LOG_WINDOW_LOG_BIN=str(self.fake))

    def script(self, source):
        self.fake.write_text('#!'+sys.executable+'\n'+source)
        self.fake.chmod(0o700)

    def run_window(self, *extra, deadline=10, ready=None):
        command = [sys.executable, '-I', str(BASE/'mac-log-window'),
            '--start', START, '--end', END, '--predicate', 'fixture',
            '--deadline', str(deadline), '--out', str(self.out), *extra]
        if ready is None:
            return subprocess.run(command, env=self.env, capture_output=True, timeout=deadline+5)
        with subprocess.Popen(command, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as helper:
            until = time.monotonic()+deadline
            while not ready.exists() and helper.poll() is None and time.monotonic() < until:
                time.sleep(.01)
            self.assertTrue(ready.exists(), 'fixture did not publish its PID before the deadline')
            stdout, stderr = helper.communicate(timeout=deadline+5)
            return subprocess.CompletedProcess(command, helper.returncode, stdout, stderr)

    def summary(self):
        return json.loads(Path(str(self.out)+'.summary.json').read_text())

    def test_mixed_rows_are_filtered_byte_for_byte(self):
        lines = [
            b'{"timestamp":"2026-11-16T09:00:00Z"}\n',
            b' {"timestamp": "2026-11-16 08:22:00+0000", "message":"start"} \r\n',
            b'{"timestamp":"2026-11-16T08:23:07.123456+00:00"}\n',
            b'{"timestamp":"2026-11-16T08:21:59Z"}\n',
            b'{"timestamp":"bad"}\n', b'{}\n', b'not json\n', b'[]\n',
            b'{"timestamp":"2026-11-16T08:24:00Z"}',
        ]
        self.script('import sys\nsys.stdout.buffer.write('+repr(b''.join(lines))+')\n')
        result = self.run_window('--keep-outside', '--info', '--debug')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.out.read_bytes(), lines[1]+lines[2]+lines[8])
        self.assertEqual(Path(str(self.out)+'.outside.ndjson').read_bytes(), lines[0]+lines[3])
        summary = self.summary()
        self.assertEqual((summary['rowsIn'], summary['rowsOutside'], summary['unparsed']), (3, 2, 4))
        self.assertEqual(summary['outsideFirst'], '2026-11-16T08:21:59+00:00')
        self.assertEqual(summary['outsideLast'], '2026-11-16T09:00:00+00:00')
        self.assertEqual(summary['lastInWindowTs'], '2026-11-16T08:24:00+00:00')
        self.assertEqual(len(result.stderr.splitlines()), 1)
        self.assertEqual(summary['status'], 'complete')
        self.assertEqual(summary['slices'][0]['exitCode'], 0)

    def test_subsecond_boundary_class(self):
        cases = [
            ('2026-11-16T08:21:59.999999999Z', False),
            ('2026-11-16T08:22:00.000000000Z', True),
            ('2026-11-16T08:22:00.000000001Z', True),
            ('2026-11-16T08:23:59.999999999Z', True),
            ('2026-11-16T08:24:00.000000000Z', True),
            ('2026-11-16T08:24:00.000000001Z', False),
            ('2026-11-16T08:24:00.000000999Z', False),
            ('2026-11-16T12:24:00.000000001+0400', False),
        ]
        rows = [json.dumps({'timestamp': text}).encode()+b'\n' for text, _ in cases]
        self.script('import sys\nsys.stdout.buffer.write('+repr(b''.join(rows))+')\n')
        result = self.run_window('--keep-outside')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.out.read_bytes(), b''.join(row for row, (_, keep) in zip(rows, cases) if keep))
        self.assertEqual(self.summary()['outsideLast'], '2026-11-16T08:24:00.000000999+00:00')

    def test_utc_args_and_environment(self):
        self.script('''import os,sys
assert sys.argv[1:6] == ['show', '--style', 'ndjson', '--timezone', 'UTC']
assert sys.argv[sys.argv.index('--start')+1] == '2026-11-16 08:22:00+0000'
assert sys.argv[sys.argv.index('--end')+1] == '2026-11-16 08:24:00+0000'
assert sys.argv[-2:] == ['--predicate', 'fixture']
assert '--info' in sys.argv and '--debug' in sys.argv
assert os.environ['TZ'] == 'UTC'
''')
        self.assertEqual(self.run_window('--info', '--debug').returncode, 0)

    def test_deadline_kills_term_ignoring_child_and_preserves_rows(self):
        pidfile = self.root/'pid'
        self.script('''import os,signal,time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(%r).write_text(str(os.getpid()))
print('{"timestamp":"2026-11-16T08:23:00Z"}', flush=True)
while True: time.sleep(60)
''' % str(pidfile))
        before = time.monotonic()
        result = self.run_window(deadline=2)
        self.assertLess(time.monotonic()-before, 7)
        self.assertEqual(result.returncode, 2, result.stderr)
        summary = self.summary()
        self.assertEqual((summary['status'], summary['rowsIn']), ('partial', 1))
        self.assertEqual(len(self.out.read_bytes().splitlines()), 1)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)

    def test_descendant_with_inherited_stdout_is_terminated(self):
        pidfile = self.root/'descendant'
        self.script('''import os,signal,subprocess,sys,time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
def stop(*args):
    child.wait(timeout=2)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
Path(%r).write_text(str(child.pid))
while True: time.sleep(60)
''' % str(pidfile))
        result = self.run_window(deadline=5, ready=pidfile)
        self.assertEqual(result.returncode, 2, result.stderr)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)

    def test_closed_stdout_does_not_defeat_deadline(self):
        self.script('import os,time\nos.close(1)\ntime.sleep(60)\n')
        self.assertEqual(self.run_window(deadline=.2).returncode, 2)
        self.assertEqual(self.summary()['status'], 'partial')

    def test_slow_slice_is_partial_and_later_slices_run(self):
        self.script('''import json,sys,time
start = sys.argv[sys.argv.index('--start')+1]
print(json.dumps({'timestamp': start}), flush=True)
if '08:22:00+' in start: time.sleep(60)
print(json.dumps({'timestamp': sys.argv[sys.argv.index('--end')+1]}), flush=True)
''')
        result = self.run_window('--slice', '30s', deadline=8)
        self.assertEqual(result.returncode, 2, result.stderr)
        summary = self.summary()
        self.assertEqual([p['status'] for p in summary['slices']], ['partial', 'complete', 'complete', 'complete'])
        self.assertEqual(summary['status'], 'partial')
        stamps = [row_timestamp(json.loads(line)['timestamp']) for line in self.out.read_bytes().splitlines()]
        self.assertEqual(len(stamps), len(set(stamps)))
        self.assertEqual(stamps[-1], row_timestamp(END))

    def test_zero_window_and_fractional_slice_edges(self):
        self.script('''import json,sys
for flag in ('--start', '--end'):
 print(json.dumps({'timestamp':sys.argv[sys.argv.index(flag)+1]}))
''')
        result = self.run_window('--start', START, '--end', '2026-11-16T08:22:00.75Z', '--slice', '0.5s')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.summary()['slices']), 2)
        result = self.run_window('--end', START)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.summary()['slices']), 1)

    def test_nonzero_and_spawn_error_are_errors(self):
        self.script('import sys\nprint(\'{"timestamp":"2026-11-16T08:23:00Z"}\')\nsys.exit(7)\n')
        self.assertEqual(self.run_window().returncode, 1)
        self.assertEqual(self.summary()['status'], 'error')
        self.assertEqual(self.summary()['slices'][0]['exitCode'], 7)
        self.fake.unlink()
        self.assertEqual(self.run_window().returncode, 1)
        self.assertEqual(self.summary()['status'], 'error')

    def test_bad_args_still_write_summary(self):
        for args in [('--deadline', '601'), ('--deadline', 'nan'), ('--deadline', '0'),
                     ('--slice', '0s'), ('--slice', 'bad'), ('--start', '2026-11-16 08:22:00'),
                     ('--start', '2026-11-16T08:22:00+04:00'), ('--end', '2026-11-15T00:00:00Z'),
                     ('--unexpected',)]:
            with self.subTest(args=args):
                result = self.run_window(*args)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(self.summary()['status'], 'error')


class CollectorWindowTests(unittest.TestCase):
    def test_source_counts_and_clean_record_size(self):
        for dirty in (True, False):
            with self.subTest(dirty=dirty), tempfile.TemporaryDirectory() as temp, \
                    patch.dict(os.environ, TOOLLOG_DIR=temp):
                jobs.save_state('crashes', {'unified': 100, 'rollupDay': '1969-12-31'})
                def run(command, **kwargs):
                    def bound(flag):
                        return float(row_timestamp(command[command.index(flag)+1]))
                    midpoint = (bound('--start')+bound('--end')-1)/2
                    rows = [dict(timestamp=dt.datetime.fromtimestamp(midpoint, dt.timezone.utc).isoformat(),
                                 eventMessage='=== system boot')]
                    if dirty:
                        rows += [dict(timestamp='1970-01-01T00:00:00Z'),
                                 dict(timestamp='1970-01-01T01:00:00Z'),
                                 dict(timestamp='private'), {}]
                    return SimpleNamespace(returncode=0, stdout=json.dumps(rows))
                reader = lambda a,b: collector.unified(a,b,run)
                self.assertTrue(collector.collect(200, [], reader))
                events = [json.loads(line) for p in Path(temp).glob('*.ndjson') for line in p.read_text().splitlines()]
                source = [r['props'] for r in events if r['name'] == 'crash.source'][-1]
                chunks = [r['props'] for r in events if r['name'] == 'crash.unified.chunk' and r['props']['outcome'] == 'done']
                if dirty:
                    self.assertEqual(source['outsideRows'], 2*len(chunks))
                    self.assertEqual(source['unparsedRows'], 2*len(chunks))
                    self.assertEqual((source['outsideFirst'], source['outsideLast']), (0, 3600))
                    self.assertTrue(all(c['outsideRows'] == 2 for c in chunks))
                    self.assertNotIn('private', json.dumps(events))
                else:
                    for key in ('outsideRows', 'outsideFirst', 'outsideLast', 'unparsedRows'):
                        self.assertNotIn(key, source)
                        self.assertTrue(all(key not in c for c in chunks))


if __name__ == '__main__':
    unittest.main()
