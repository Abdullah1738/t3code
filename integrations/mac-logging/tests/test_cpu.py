import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import cpu
import cpu_labels
import status
import toollog

START = 'Sat Nov 14 10:20:30 2026'
OTHER = 'Sun Nov 15 10:20:30 2026'


def line(pid=1, cpu_time='0:01.23', start=START, etime='02:00', command='/usr/bin/node', state='R+', rss=2048):
    return f'{pid} 0 {cpu_time} {rss} {state} {start} {etime} {command}\n'


class CpuTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root), BUN_INSPECT='private')
        env.start()
        self.addCleanup(env.stop)
        self.calls = []

    def runner(self, text=None, args=None, failure=None):
        def run(argv, **kwargs):
            self.calls.append(argv)
            self.assertEqual(kwargs['env']['LC_ALL'], 'C')
            self.assertNotIn('BUN_INSPECT', kwargs['env'])
            if argv == cpu.PS:
                self.assertEqual(kwargs['timeout'], 30)
                if failure == 'timeout':
                    raise subprocess.TimeoutExpired(argv, 30, output='private')
                if failure == 'unavailable':
                    raise OSError('private')
                return SimpleNamespace(returncode=int(failure == 'exit'), stdout=text or line())
            self.assertEqual(kwargs['timeout'], 5)
            self.assertEqual(argv[:3], ['/bin/ps', '-ww', '-p'])
            return SimpleNamespace(returncode=0, stdout=args or f'1 {START} /usr/bin/node /Users/ardud/.local/share/9router/src/server.js --token=private\n')
        return run

    def events(self):
        return [json.loads(line) for p in self.root.glob('*.ndjson') for line in p.read_text().splitlines()]

    def test_cpu_time_forms(self):
        for value, expected in [('0:01.23', 1.23), ('12:34.56', 754.56),
                                ('1:02:03', 3723), ('2-03:04:05', 183845)]:
            with self.subTest(value=value):
                row = cpu.parse_ps(line(cpu_time=value))[0]
                self.assertAlmostEqual(row['cpuS'], expected)
                self.assertEqual(row['rssMb'], 2)
                self.assertEqual(row['start'], START)
        for value in ('NaN', 'inf', '-1:00', '1:60', '1:00:99', '1', '1:2', '1:02.3x'):
            with self.subTest(value=value), self.assertRaises(cpu.ProbeError):
                cpu.parse_ps(line(cpu_time=value))

    def test_ps_names_elapsed_forms_and_malformed_rows(self):
        for age in ('00:01', '12:34:56', '2-03:04:05'):
            row = cpu.parse_ps(line(etime=age, command='/Applications/Robob.app/Contents/MacOS/Robob Helper (Renderer)'))[0]
            self.assertEqual(row['etime'], age)
        for text in ('', 'private', line()+line(), line().replace('2048', '-1'), line(start='bad')):
            with self.subTest(text=text), self.assertRaises(cpu.ProbeError):
                cpu.parse_ps(text)

    def test_exiting_state_and_bracketed_comm_matrix(self):
        for state in ('?', '?E', '?s', '?N'):
            for comm, expected in (('(Python)', 'python'), ('(claude)', 'claude'),
                                   ('(sleep)', 'sleep'), ('((Python))', '(Python)')):
                with self.subTest(state=state, comm=comm):
                    rows = cpu.parse_ps(line(state=state, command=comm, cpu_time='0:00.00', rss=0))
                    self.assertEqual(rows[0]['family'], expected)
                    props, _ = cpu.deltas(rows, {}, 100)
                    self.assertEqual(props['exiting'], 1)
                    self.assertEqual(props['cpuS'], None)

    def test_bad_line_class_skips_individually_at_ten_percent(self):
        good = ''.join(line(pid=i) for i in range(1, 10))
        cases = [('fields', '10 0 missing\n'),
                 ('pid', line(pid='bad')), ('ppid', line(pid=10).replace('10 0 ', '10 bad ')),
                 ('rss', line(pid=10).replace('2048', '-1')),
                 ('cpu', line(pid=10, cpu_time='NaN')), ('etime', line(pid=10, etime='1:60')),
                 ('start', line(pid=10, start='bad')), ('state', line(pid=10, state='!')),
                 ('duplicate', line(pid=1))]
        for form, bad in cases:
            with self.subTest(form=form):
                diagnostics = {}
                parsed = cpu.parse_ps(good+bad, diagnostics)
                self.assertEqual(len(parsed), 9)
                self.assertEqual(diagnostics, dict(skippedLines=1))
                props = cpu.sample(self.runner(text=good+bad))
                self.assertEqual(props['skippedLines'], 1)
                self.assertTrue(self.events()[-1]['ok'])
                self.assertEqual(self.events()[-1]['props']['skippedLines'], 1)

    def test_bad_line_error_threshold_diagnostics_and_state_unchanged(self):
        cpu.sample(self.runner())
        before = (self.root/'state/cpu.json').read_bytes()
        bad = line(pid=321, command='/Users/ardud/private/server.py --token=private', state='!')
        for good_count, bad_count in ((8, 1), (9, 2), (0, 1), (0, 5)):
            with self.subTest(good=good_count, bad=bad_count):
                props = cpu.sample(self.runner(text=''.join(line(pid=i) for i in range(1, good_count+1))+bad*bad_count))
                self.assertEqual(props['failure'], 'parse')
                self.assertEqual(props['badLines'], bad_count)
                self.assertEqual(props['lines'], good_count+bad_count)
                self.assertEqual((self.root/'state/cpu.json').read_bytes(), before)
                event = self.events()[-1]
                self.assertFalse(event['ok'])
                self.assertNotIn('/Users/', json.dumps(event))
                self.assertNotIn('private', json.dumps(event))
                self.assertNotIn('321', event['props']['badLine'] or '')
        diagnostics = {}
        with self.assertRaises(cpu.ProbeError):
            cpu.parse_ps(line(pid=321, state='!', command='/bin/sleep'), diagnostics)
        self.assertTrue(diagnostics['badLine'].startswith('PID PPID '))
        self.assertIn('/bin/sleep', diagnostics['badLine'])
        self.assertLessEqual(len(diagnostics['badLine']), 200)

    def test_exiting_pid_cpu_reset_never_produces_negative_or_rebound_delta(self):
        _, old = cpu.deltas(cpu.parse_ps(line(cpu_time='0:20.00')), {}, 100)
        rows = cpu.parse_ps(line(state='?E', command='(Python)', cpu_time='0:00.00', rss=0))
        props, state = cpu.deltas(rows, old, 160)
        self.assertEqual(props['cpuS'], 0)
        self.assertEqual(props['top'][0]['cpuS'], 0)
        self.assertEqual(props['exiting'], 1)
        self.assertEqual(state['processes'], {})
        recovered, _ = cpu.deltas(cpu.parse_ps(line(cpu_time='0:21.00')), state, 220)
        self.assertEqual(recovered['cpuS'], 0)
        cpu.hints(props['top'], rows, self.runner())
        self.assertEqual(self.calls, [])

    def test_parse_diagnostics_share_redactor_and_remain_under_cpu_cap(self):
        with patch('cpu_labels.janitor_redact', return_value='PID PPID bad [REDACTED]') as redact:
            diagnostics = {}
            with self.assertRaises(cpu.ProbeError):
                cpu.parse_ps(line(pid=321, state='!', command='x'*1000), diagnostics)
            redact.assert_called_once()
            self.assertEqual(diagnostics['badLine'], 'PID PPID bad [REDACTED]')
        with patch('cpu_labels.janitor_redact', side_effect=ImportError):
            diagnostics = {}
            with self.assertRaises(cpu.ProbeError):
                cpu.parse_ps(line(state='!'), diagnostics)
            self.assertIsNone(diagnostics['badLine'])
        props = dict(badLine='PID PPID '+'界'*1000, badLines=5, lines=10, skippedLines=5, exiting=4)
        event = toollog.record('cpu', 'error', 'cpu.sample', dt.datetime.now(dt.timezone.utc), props=props)
        self.assertEqual(len(event['props']['badLine']), 200)
        self.assertEqual(event['props']['exiting'], 4)
        self.assertLessEqual(len(json.dumps(event).encode()), 8192)

    def test_delta_same_identity_even_same_etime(self):
        _, old = cpu.deltas(cpu.parse_ps(line(cpu_time='0:10.00')), {}, 100)
        props, new = cpu.deltas(cpu.parse_ps(line(cpu_time='0:40.00')), old, 160)
        self.assertFalse(props['baseline'])
        self.assertEqual(props['windowS'], 60)
        self.assertEqual(props['cpuS'], 30)
        self.assertEqual(props['totalCpuPct'], 50)
        self.assertEqual(props['top'][0]['cpuPct'], 50)
        self.assertEqual(new['processes']['1']['cpuS'], 40)

    def test_reuse_decreasing_or_increasing_cpu_and_gone_process(self):
        _, old = cpu.deltas(cpu.parse_ps(line()+line(pid=2)), {}, 100)
        for cpu_time in ('0:00.01', '9:00.00'):
            props, new = cpu.deltas(cpu.parse_ps(line(start=OTHER, etime='00:01', cpu_time=cpu_time)), old, 160)
            self.assertEqual(props['totalCpuPct'], 0)
            self.assertEqual(set(new['processes']), {'1'})
        props, _ = cpu.deltas(cpu.parse_ps(line(cpu_time='0:00.01')), old, 160)
        self.assertEqual(props['top'][0]['cpuS'], 0)

    def test_baseline_clock_reset_stale_or_corrupt_state(self):
        rows = cpu.parse_ps(line())
        for old, now in [({}, 100), ({'at': 200}, 100), ({'at': 100}, 100),
                         ({'at': 100}, 4000), ({'at': 'private'}, 100)]:
            props, _ = cpu.deltas(rows, old, now)
            self.assertTrue(props['baseline'])
            self.assertIsNone(props['totalCpuPct'])
            self.assertEqual(props['top'], [])

    def test_aggregation_counts_states_and_one_core_percent(self):
        before = cpu.parse_ps(line(cpu_time='0:00')+line(pid=2, cpu_time='0:00'))
        _, old = cpu.deltas(before, {}, 100)
        rows = cpu.parse_ps(line(cpu_time='2:00')+line(pid=2, cpu_time='1:00', state='U'))
        props, _ = cpu.deltas(rows, old, 160)
        self.assertEqual(props['totalCpuPct'], 300)
        self.assertEqual(props['families'], [dict(family='node', count=2, cpuPct=300, rssMb=4)])
        self.assertEqual((props['runnable'], props['uninterruptible']), (1, 1))

    def test_family_matrix(self):
        cases = [('/Applications/Robob.app/Contents/MacOS/Robob', 'Robob'),
                 ('/Applications/Robob.app/Contents/Frameworks/Robob Helper (Renderer).app/Contents/MacOS/Robob Helper (Renderer)', 'Robob Helper (Renderer)'),
                 ('/Applications/Dia.app/Contents/MacOS/Dia', 'Dia'),
                 ('/Applications/Dia.app/Contents/Frameworks/Browser Helper.app/Contents/MacOS/Browser Helper', 'Browser Helper'),
                 ('/opt/python3.13', 'python'), ('/opt/Python', 'python'), ('/sbin/mds_stores', 'mds*')]
        cases += [('/bin/'+name, name) for name in ('claude', 'codex', 'opencode', 'node', 'bun',
                  'cua-driver', 'WindowServer', 'fseventsd', 'kernel_task', 'git', 'rg', 'tsc',
                  'esbuild', 'vitest', 'cargo', 'go', 'unknown')]
        for command, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(cpu_labels.family(command), expected)

    def test_hint_matrix_uses_shared_redactor_before_shortening(self):
        cases = [
            ('node /Volumes/ExternalSSD/9router/src/server.js --token=private', '9router/…/server.js'),
            ('python3 -u /Users/ardud/.local/share/memory-system/recall_refresh.py', 'memory-system/recall_refresh.py'),
            ('python3 /Users/ardud/private/work.py', 'work.py'),
            ('bun ./node_modules/vitest/vitest.mjs', 'vitest.mjs'),
            ('python3 -m http.server 8000', 'http.server'),
            ('node --require boot.js /work/server.js', 'server.js'),
            ('node --token=private /work/server.js', 'server.js'),
            ('node --token private /work/server.js', None),
            ('node -e "private code"', None), ('python -c "private code"', None),
            ('node --eval=private', None), ('node "unfinished', None),
            ('node /tmp/sk-private-key/server.js', None), ('node https://user:private@host/file.js', None),
            ('node '+('a1'*30), None), ('node', None),
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                result = cpu_labels.script_hint(args)
                self.assertEqual(result, expected)
                self.assertNotIn('/Users/', result or '')
                self.assertNotIn('private', result or '')
        with patch('leftover_processes.redact', return_value='node [REDACTED]') as helper:
            self.assertIsNone(cpu_labels.script_hint('node anything.js'))
            helper.assert_called_once()

    def test_sample_first_baseline_then_cpu_line_and_private_state(self):
        with patch.object(cpu.time, 'time', return_value=1_800_000_000):
            cpu.sample(self.runner(), clock=lambda: 100)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.events()[0]['ok'])
        self.assertEqual(self.events()[0]['props']['top'], [])
        with patch.object(cpu.time, 'time', return_value=1_800_000_060):
            cpu.sample(self.runner(text=line(cpu_time='0:31.23')), clock=lambda: 160)
        event = self.events()[-1]
        self.assertEqual(event['props']['top'][0]['hint'], '9router/…/server.js')
        self.assertEqual(event['props']['totalCpuPct'], 50)
        self.assertEqual(event['component'], 'cpu')
        self.assertEqual(len(self.calls), 3)
        state = self.root/'state/cpu.json'
        self.assertEqual(state.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('/Users/', state.read_text())
        self.assertNotIn('private', json.dumps(self.events()))

    def test_sample_window_survives_per_process_duration_clock_resets(self):
        # Separate launchd invocations both start their duration clock near zero.
        with patch.object(cpu.time, 'time', side_effect=[1_800_000_000, 1_800_000_060]):
            first_clock = iter((.01, .20, .40))
            first = cpu.sample(self.runner(), clock=lambda: next(first_clock))
            second_clock = iter((.01, .21, .40))
            second = cpu.sample(self.runner(text=line(cpu_time='0:31.23')),
                                clock=lambda: next(second_clock))
        self.assertTrue(first['baseline'])
        self.assertFalse(second['baseline'])
        self.assertEqual(second['windowS'], 60)
        self.assertEqual(second['totalCpuPct'], 50)
        self.assertLess(self.events()[-1]['durationMs'], 1000)

    def test_legacy_tiny_timestamp_establishes_exactly_one_baseline(self):
        _, old = cpu.deltas(cpu.parse_ps(line()), {}, .167)
        cpu.save_state('cpu', old)
        with patch.object(cpu.time, 'time', return_value=1_800_000_000):
            migrated = cpu.sample(self.runner(text=line(cpu_time='0:31.23')), clock=lambda: .20)
        self.assertTrue(migrated['baseline'])
        self.assertIsNone(migrated['windowS'])
        self.assertIsNone(migrated['totalCpuPct'])
        self.assertEqual(migrated['top'], [])
        self.assertEqual(cpu.read_state('cpu')['at'], 1_800_000_000)
        with patch.object(cpu.time, 'time', return_value=1_800_000_060):
            measured = cpu.sample(self.runner(text=line(cpu_time='1:01.23')), clock=lambda: .18)
        self.assertFalse(measured['baseline'])
        self.assertEqual(measured['windowS'], 60)
        self.assertEqual(measured['totalCpuPct'], 50)

    def test_timeout_exit_parse_unavailable_do_not_advance_state(self):
        cpu.sample(self.runner(), clock=lambda: 100)
        saved = (self.root/'state/cpu.json').read_bytes()
        for failure in ('timeout', 'exit', 'unavailable', 'parse'):
            ticks = iter((160, 190))
            result = cpu.sample(self.runner(text='invalid' if failure == 'parse' else None,
                                           failure=failure), clock=lambda: next(ticks))
            self.assertEqual(result['failure'], failure)
            event = self.events()[-1]
            self.assertEqual(event['kind'], 'error')
            self.assertFalse(event['ok'])
            self.assertEqual(event['durationMs'], 30000)
            self.assertEqual((self.root/'state/cpu.json').read_bytes(), saved)

    def test_hint_timeout_and_reused_pid_do_not_spoil_cpu(self):
        top = [dict(pid=1, family='node', hint=None)]
        rows = cpu.parse_ps(line())
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], 5)
        self.assertEqual(cpu.hints(top, rows, timeout), 'timeout')
        self.assertIsNone(top[0]['hint'])
        cpu.hints(top, rows, self.runner(args=f'1 {OTHER} node /work/wrong.js\n'))
        self.assertIsNone(top[0]['hint'])

    def test_hints_only_query_runtime_pids_in_top_twenty(self):
        rows = cpu.parse_ps(''.join(line(pid=i, cpu_time='0:00', command='/bin/node' if i%2 else '/bin/git') for i in range(1, 40)))
        _, old = cpu.deltas(rows, {}, 100)
        props, _ = cpu.deltas(rows, old, 160)
        cpu.hints(props['top'], rows, self.runner(args=f'1 {START} node /work/server.js\n'))
        ids = set(map(int, self.calls[-1][3].split(',')))
        self.assertEqual(ids, set(range(1, 21, 2)))

    def test_schema_redaction_bounds_volume_and_scope(self):
        proc = dict(pid=1, ppid=0, family='界'*200, hint='界'*200,
                    cpuS=1e14, cpuPct=1e14, rssMb=1e14, etime='999-01:02:03', args='private')
        props = dict(top=[proc]*100, families=[dict(proc, count=100)]*100,
                     arbitrary='private', totalCpuPct=100, load=[1, 2, 3])
        row = toollog.record('cpu', 'event', 'cpu.sample', dt.datetime.now(dt.timezone.utc), props=props)
        size = len((json.dumps(row, separators=(',', ':'))+'\n').encode())
        self.assertLessEqual(size, 8192)
        self.assertLess(size*1440, 15_000_000)
        self.assertEqual(row['props']['totalCpuPct'], 100)
        self.assertNotIn('args', json.dumps(row))
        self.assertNotIn('private', json.dumps(row))
        self.assertEqual(toollog.safe_fields(props, 'unrelated'), {})
        for hint in ('/Users/ardud/a.py', 'password=private', 'sk-private-key'):
            row = toollog.cpu_fields(dict(top=[dict(proc, hint=hint)]))
            self.assertNotIn('private', json.dumps(row))
            self.assertNotIn('/Users/', json.dumps(row))

    def test_missing_redactor_is_closed_and_does_not_lose_numeric_sample(self):
        with patch('cpu_labels.janitor_redact', side_effect=ImportError):
            row = toollog.cpu_fields(dict(top=[dict(pid=1, cpuPct=50, family='node', hint='/private/work.py')]))
        self.assertEqual(row['top'][0]['cpuPct'], 50)
        self.assertIsNone(row['top'][0]['hint'])

    def test_schedule_install_and_three_minute_silence(self):
        data = plistlib.loads((HERE/'launchd/com.abdullah.mac-cpu.plist').read_bytes())
        self.assertEqual(data['StartInterval'], 60)
        self.assertEqual(data['ProcessType'], 'Standard')
        self.assertNotIn('Nice', data)
        self.assertNotIn('LowPriorityIO', data)
        self.assertEqual(data['ProgramArguments'][:2], ['/bin/zsh', '-c'])
        self.assertEqual(status.CADENCES['cpu.sample']['gapHours']*60, 3)
        setup = (HERE/'install.zsh').read_text()
        for text in ('cpu.py', 'cpu_labels.py', 'com.abdullah.mac-cpu'):
            self.assertIn(text, setup)


if __name__ == '__main__':
    unittest.main()
