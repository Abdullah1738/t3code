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
        load = patch.object(cpu.os, 'getloadavg', return_value=(1, 1, 1))
        load.start()
        self.addCleanup(load.stop)
        cores = patch.object(cpu.os, 'cpu_count', return_value=16)
        cores.start()
        self.addCleanup(cores.stop)

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

    def spike_runner(self, text=None, args=None, thread_failure=False):
        normal = self.runner(text=text)
        def run(argv, **kwargs):
            if argv[:3] == ['/bin/ps', '-ww', '-o']:
                self.calls.append(argv)
                return SimpleNamespace(returncode=0, stdout=args or f'1 {START} /sbin/launchd\n')
            if '-axM' in argv:
                self.calls.append(argv)
                if thread_failure:
                    raise subprocess.TimeoutExpired(argv, 2)
                return SimpleNamespace(returncode=0, stdout='USER PID TT %CPU STAT PRI STIME UTIME COMMAND\nroot 1 ?? 1.0 R 31T 0:00.1 0:00.2 launchd\n 1 0.0 R 31T 0:00.1 0:00.2\n')
            return normal(argv, **kwargs)
        return run

    def test_host_ticks_abi_and_system_delta(self):
        import ctypes
        def host_statistics(host, flavor, ticks, count):
            self.assertEqual((host, flavor), (7, 3))
            self.assertEqual(ctypes.cast(count, ctypes.POINTER(ctypes.c_uint))[0], 4)
            ticks[:] = (160, 120, 300, 20)
            return 0
        ticks = cpu.host_ticks(host_statistics, 7)
        props = dict(baseline=False, totalCpuPct=500)
        result = cpu.system_cpu(ticks, dict(ticks=[100, 100, 200, 0]), props, 16)
        self.assertEqual(result, dict(systemCpuPct=800, userPct=640, sysPct=160, unattributedCpuPct=300))
        self.assertEqual(cpu.system_cpu(ticks, {}, props, 16), {})
        self.assertEqual(cpu.system_cpu(ticks, dict(ticks=ticks), dict(props, baseline=True), 16), {})
        self.assertEqual(cpu.system_cpu(ticks, dict(ticks=[100, 100, 200, 0]), dict(props, totalCpuPct=900), 16)['unattributedCpuPct'], 0)
        with self.assertRaises(cpu.ProbeError):
            cpu.host_ticks(lambda *args: 5, 7)

    def test_tick_wrap_reset_and_bad_saved_ticks(self):
        props = dict(baseline=False, totalCpuPct=0)
        self.assertEqual(cpu.system_cpu([10, 10, 20, 0], dict(ticks=[2**32-10, 0, 0, 0]), props, 16)['systemCpuPct'], 960)
        for old in ([100, 100, 200, 0], [True, 0, 0, 0], [1], 'bad'):
            with self.subTest(old=old):
                self.assertEqual(cpu.system_cpu([0]*4, dict(ticks=old), props, 16)['systemCpuError'], 'baseline')

    def test_system_first_read_failure_and_recovery_keep_sample(self):
        ticks = iter(([100, 100, 200, 0], [160, 120, 300, 20]))
        with patch.object(cpu.time, 'time', side_effect=[1_800_000_000, 1_800_000_060]):
            first = cpu.sample(self.runner(), ticks_read=lambda: next(ticks))
            second = cpu.sample(self.runner(text=line(cpu_time='5:01.23')), ticks_read=lambda: next(ticks))
        self.assertNotIn('systemCpuPct', first)
        self.assertNotIn('systemCpuError', first)
        self.assertEqual(second['systemCpuPct'], 800)
        self.assertEqual(second['unattributedCpuPct'], 300)
        def failed():
            raise cpu.ProbeError('unavailable')
        with patch.object(cpu.time, 'time', return_value=1_800_000_120):
            result = cpu.sample(self.runner(), ticks_read=failed)
        self.assertEqual(result['systemCpuError'], 'unavailable')
        self.assertNotIn('systemCpuPct', result)
        self.assertTrue(self.events()[-1]['ok'])
        self.assertNotIn('ticks', cpu.read_state('cpu'))

    def test_spawn_exit_reuse_and_wrap_without_false_pid_cursor(self):
        cases = [(10, 11, START, (1, 1)), (99999, 1, START, (1, 1)),
                 (10, 10, OTHER, (1, 1)), (10, 10, START, (0, 0))]
        for before, after, start, expected in cases:
            with self.subTest(before=before, after=after, start=start):
                _, old = cpu.deltas(cpu.parse_ps(line(pid=before)), {}, 100)
                rows = cpu.parse_ps(line(pid=after, start=start))
                props, _ = cpu.deltas(rows, old, 160)
                measured = cpu.churn(rows, old, props)
                self.assertEqual((measured['spawned'], measured['exited']), expected)
                self.assertNotIn('pidAdvance', measured)
        # A high survivor hides any allocator advance after a wrap.
        _, old = cpu.deltas(cpu.parse_ps(line(pid=99999)), {}, 100)
        rows = cpu.parse_ps(line(pid=99999)+line(pid=10))
        props, _ = cpu.deltas(rows, old, 160)
        self.assertEqual(cpu.churn(rows, old, props)['spawned'], 1)
        self.assertEqual(cpu.churn(rows, {}, dict(props, baseline=True)), {})

    def test_parent_family_live_launchd_and_gone(self):
        rows = cpu.parse_ps(line(pid=1, command='/sbin/launchd')+line(pid=20, command='/bin/zsh')+line(pid=21)+line(pid=22))
        rows[1]['ppid'], rows[2]['ppid'], rows[3]['ppid'] = 1, 20, 999
        _, old = cpu.deltas(rows, {}, 100)
        props, _ = cpu.deltas(rows, old, 160)
        by_pid = {p['pid']: p for p in props['top']}
        self.assertEqual(by_pid[20]['parentFamily'], 'launchd')
        self.assertEqual(by_pid[21]['parentFamily'], 'zsh')
        self.assertIsNone(by_pid[22]['parentFamily'])

    def test_spawned_families_count_cpu_parent_and_top_eight(self):
        now = 1_800_000_060
        born = __import__('time').strftime('%a %b %d %H:%M:%S %Y', __import__('time').localtime(now-30))
        rows = cpu.parse_ps(line(pid=1, command='/sbin/launchd')+
                            ''.join(line(pid=i+10, start=born, cpu_time='0:30', command='/bin/tool'+str(i%10)) for i in range(20)))
        for p in rows[1:]:
            p['ppid'] = 1
        _, old = cpu.deltas(rows[:1], {}, now-60)
        props, _ = cpu.deltas(rows, old, now)
        measured = cpu.churn(rows, old, props)
        self.assertEqual(measured['spawned'], 20)
        self.assertEqual(len(measured['spawnedFamilies']), 8)
        self.assertEqual(measured['spawnedFamilies'][0], dict(family='tool0', count=2, cpuPct=100, parentFamily='launchd'))

    def test_real_system_daemon_labels_and_home_secret_matrix(self):
        real = '/System/Library/DriverExtensions/com.apple.DriverKit-AppleBCMWLAN.dext/com.apple.DriverKit-AppleBCMWLAN'
        self.assertEqual(cpu_labels.janitor_redact(Path(real).name), '[REDACTED]')
        for root in cpu_labels.SYSTEM_ROOTS:
            label = cpu_labels.family(root+Path(real).name)
            props = toollog.cpu_fields(dict(top=[dict(family=label, parentFamily=label)]))
            self.assertEqual(props['top'][0]['family'], Path(real).name)
            self.assertEqual(props['top'][0]['parentFamily'], Path(real).name)
        for comm in ('/Users/ardud/private/tool', '/home/test/tool',
                     str(Path.home())+'/tool', '/usr/bin/sk-private-key', '/System/secret=private'):
            with self.subTest(comm=comm):
                label = cpu_labels.family(comm)
                self.assertEqual(label, '[redacted]')

    def test_spike_threshold_cap_reset_and_optional_failure(self):
        for load, expected in ((32, 0), (32.001, 1)):
            with self.subTest(load=load), patch.object(cpu.os, 'getloadavg', return_value=(load, 10, 10)):
                before = len([e for e in self.events() if e['name']=='cpu.spike'])
                cpu.sample(self.spike_runner(thread_failure=True), ticks_read=lambda: [1]*4)
                spikes = [e for e in self.events() if e['name']=='cpu.spike']
                self.assertEqual(len(spikes)-before, expected)
                if expected:
                    self.assertEqual(spikes[-1]['props']['threadError'], 'timeout')
                    self.assertNotIn('runnableThreadsByFamily', spikes[-1]['props'])
        now = 1_800_000_000
        day = dt.datetime.fromtimestamp(now, dt.timezone.utc).date().isoformat()
        state = cpu.read_state('cpu')
        state.update(spikeDay=day, spikeCount=239)
        cpu.save_state('cpu', state)
        with patch.object(cpu.time, 'time', return_value=now), patch.object(cpu.os, 'getloadavg', return_value=(40, 10, 10)):
            cpu.sample(self.spike_runner(), ticks_read=lambda: [1]*4)
            self.assertEqual(cpu.read_state('cpu')['spikeCount'], 240)
            self.calls.clear()
            cpu.sample(self.spike_runner(), ticks_read=lambda: [1]*4)
            self.assertEqual(self.calls, [cpu.PS])
            self.assertEqual(cpu.read_state('cpu')['spikeCount'], 240)
        with patch.object(cpu.time, 'time', return_value=now+86400), patch.object(cpu.os, 'getloadavg', return_value=(40, 10, 10)):
            cpu.sample(self.spike_runner(), ticks_read=lambda: [1]*4)
            self.assertEqual(cpu.read_state('cpu')['spikeCount'], 1)

    def test_spike_one_command_batch_redacted_and_byte_bounded(self):
        rows = cpu.parse_ps(''.join(line(pid=i+1, command='/bin/git') for i in range(30)))
        for p in rows:
            p['ppid'] = 30
        _, old = cpu.deltas(rows, {}, 100)
        props, _ = cpu.deltas(rows, old, 160)
        props.update(load=[40, 30, 20], ncpu=16, spawnedFamilies=[])
        args = ''.join(str(i)+f' {START} /usr/bin/git /Users/ardud/private/repo '+('界'*300)+'\n' for i in range(1, 31))
        snapshot = cpu.spike(props, rows, self.spike_runner(args=args))
        batches = [call for call in self.calls if call[:3] == ['/bin/ps', '-ww', '-o']]
        self.assertEqual(len(batches), 1)
        self.assertEqual(set(map(int, batches[0][-1].split(','))), set(range(1, 16))|{30})
        self.assertEqual(len(snapshot['top']), 15)
        for p in snapshot['top']:
            self.assertLessEqual(len(p['cmd']), 160)
            self.assertLessEqual(len(p['parentCmd']), 160)
            for key in ('cmd', 'parentCmd'):
                self.assertNotIn('/Users/', p[key])
                self.assertNotIn('hidden', p[key])
        record = toollog.record('cpu', 'event', 'cpu.spike', dt.datetime.now(dt.timezone.utc), props=snapshot)
        encoded = (json.dumps(record, separators=(',', ':'))+'\n').encode()
        self.assertLessEqual(len(encoded), 8192)
        self.assertLess(len(record['props']['top']), 15)
        self.assertIn('topOmitted', record['props'])

    def test_thread_layout_and_missing_parent_commands(self):
        rows = cpu.parse_ps(line(pid=1, command='/sbin/launchd'))
        text = 'USER PID TT %CPU STAT PRI STIME UTIME COMMAND\nroot 1 ?? 1.0 R 31T 0:00.1 0:00.2 launchd\n 1 0.0 R+ 31T 0:00.1 0:00.2\n 1 0.0 S 31T 0:00.1 0:00.2\nroot 999 ?? 0.0 R 31T 0:00.1 0:00.2 gone\n'
        self.assertEqual(cpu.runnable_threads(text, rows), [dict(family='launchd', count=2), dict(family='unknown', count=1)])
        _, old = cpu.deltas(rows, {}, 100)
        props, _ = cpu.deltas(rows, old, 160)
        props.update(load=[40, 10, 10], ncpu=16)
        snapshot = cpu.spike(props, rows, self.spike_runner(args='999 unrelated\n'))
        self.assertIsNone(snapshot['top'][0]['cmd'])
        self.assertIsNone(snapshot['top'][0]['parentCmd'])

    def test_spike_credentials_matrix_at_logger_boundary(self):
        cases = [
            ('Cookie header', 'curl -H "Cookie: sid=shortvalue; other=secondvalue"'),
            ('Set-Cookie header', 'curl -H "Set-Cookie: sid=shortvalue"'),
            ('cookie argument', 'curl --cookie sid=shortvalue'),
            ('cookie equals', 'curl --cookie=sid=shortvalue'),
            ('short cookie', 'curl -b sid=shortvalue'),
            ('joined cookie', 'curl -bsid=shortvalue'),
            ('user argument', 'curl -u alice:shortvalue'),
            ('joined user', 'curl -ualice:shortvalue'),
            ('bundled user', 'curl -su alice:shortvalue'),
            ('bundled joined user', 'curl -sualice:shortvalue'),
            ('many bundled flags', 'curl -fsSLu alice:shortvalue'),
            ('numeric user bundle', 'curl -4u alice:shortvalue'),
            ('punctuation user bundle', 'curl -#u alice:shortvalue'),
            ('quoted user bundle', 'sh -c "curl \'-4u\' alice:shortvalue"'),
            ('quoted long user', 'sh -c "curl \'--user\' alice:shortvalue"'),
            ('long user', 'curl --user alice:shortvalue'),
            ('user equals', 'curl --user=alice:shortvalue'),
            ('proxy user', 'curl -U alice:shortvalue'),
            ('joined proxy user', 'curl -Ualice:shortvalue'),
            ('bundled proxy user', 'curl -sU alice:shortvalue'),
            ('bundled joined proxy user', 'curl -sUalice:shortvalue'),
            ('numeric proxy bundle', 'curl -6U alice:shortvalue'),
            ('punctuation proxy bundle', 'curl -#U alice:shortvalue'),
            ('quoted proxy bundle', 'sh -c "curl \'-6U\' alice:shortvalue"'),
            ('long proxy user', 'curl --proxy-user alice:shortvalue'),
            ('proxy user equals', 'curl --proxy-user=alice:shortvalue'),
            ('bundled cookie', 'curl -sb sid=shortvalue'),
            ('bundled joined cookie', 'curl -sbsid=shortvalue'),
            ('numeric cookie bundle', 'curl -4b sid=shortvalue'),
            ('punctuation cookie bundle', 'curl -#b sid=shortvalue'),
            ('quoted cookie bundle', 'sh -c "curl \'-4b\' sid=shortvalue"'),
            ('Basic header', 'curl -H "Authorization: Basic shortvalue"'),
            ('Bearer header', 'curl -H "Authorization: Bearer shortvalue"'),
            ('URL userinfo', 'curl https://alice:shortvalue@example.test/'),
            ('password flag', 'tool --password=shortvalue'),
            ('token flag', 'tool --token shortvalue'),
            ('home in inline code', 'python -c "open(\'/Users/ardud/shortvalue\')"'),
        ]
        for form, command in cases:
            with self.subTest(form=form):
                props = dict(top=[dict(cmd=command, parentCmd=command)])
                row = toollog.record('cpu', 'event', 'cpu.spike', dt.datetime.now(dt.timezone.utc), props=props)
                text = json.dumps(row)
                if form != 'home in inline code':
                    self.assertNotIn('shortvalue', text)
                self.assertNotIn('secondvalue', text)
                self.assertNotIn('/Users/', text)
        # Python's unbuffered flag must retain the script identity.
        self.assertEqual(cpu_labels.command_label('python -u work.py'), 'python -u work.py')

    def test_spike_rechecks_child_and_parent_start_in_one_batch(self):
        rows = cpu.parse_ps(line(pid=1, command='/sbin/launchd')+line(pid=2, command='/bin/git'))
        rows[1]['ppid'] = 1
        _, old = cpu.deltas(rows, {}, 100)
        props, _ = cpu.deltas(rows, old, 160)
        props.update(load=[40, 10, 10], ncpu=16)
        for child_start, parent_start in ((START, START), (OTHER, START), (START, OTHER), (OTHER, OTHER)):
            with self.subTest(child=child_start, parent=parent_start):
                args = f'1 {parent_start} /sbin/launchd\n2 {child_start} /bin/git diff\n'
                snapshot = cpu.spike(props, rows, self.spike_runner(args=args))
                child = next(p for p in snapshot['top'] if p['pid'] == 2)
                self.assertEqual(child['cmd'], '/bin/git diff' if child_start == START else None)
                self.assertEqual(child['parentCmd'], '/sbin/launchd' if parent_start == START else None)

    def test_cookie_header_option_separator_and_case_matrix(self):
        for name in ('Cookie', 'cookie', 'COOKIE', 'Set-Cookie', 'set-cookie', 'SET-COOKIE'):
            for option in ('-H{h}:sid=tiny', '-H "{h}: sid=tiny"',
                           '-H"{h}: sid=tiny"', '--header {h}:sid=tiny',
                           '--header={h}:sid=tiny', '--header="{h}: sid=tiny"'):
                command = 'curl '+option.format(h=name)+' https://example.test/'
                with self.subTest(command=command):
                    row = toollog.record('cpu', 'event', 'cpu.spike', dt.datetime.now(dt.timezone.utc),
                                         props=dict(top=[dict(cmd=command, parentCmd=command)]))
                    self.assertNotIn('tiny', json.dumps(row))
                    self.assertEqual(row['props']['top'][0]['cmd'], '[redacted]')
                    self.assertEqual(row['props']['top'][0]['parentCmd'], '[redacted]')

    def test_credential_detection_precedes_opaque_token_redaction(self):
        for length in (0, 1, 31, 32, 33, 160, 512):
            for suffix in ('HCookie:sid=tiny', 'u alice:tiny', 'U alice:tiny', 'b sid=tiny'):
                command = 'curl -'+'v'*length+suffix+' https://example.test/'
                with self.subTest(length=length, suffix=suffix):
                    row = toollog.record('cpu', 'event', 'cpu.spike', dt.datetime.now(dt.timezone.utc),
                                         props=dict(top=[dict(cmd=command, parentCmd=command)]))
                    self.assertNotIn('tiny', json.dumps(row))

    def test_churn_preserves_exiting_identities_without_cpu_baselines(self):
        rows = cpu.parse_ps(line(pid=1)+line(pid=2, cpu_time='0:10'))
        _, old = cpu.deltas(rows, {}, 100)
        for state in ('?E', '?', '?s', '?N'):
            with self.subTest(state=state):
                rows = cpu.parse_ps(line(pid=1)+line(pid=2, cpu_time='0:00', state=state))
                props, saved = cpu.deltas(rows, old, old['at']+60)
                measured = cpu.churn(rows, old, props)
                self.assertEqual((measured['spawned'], measured['exited']), (0, 0))
                self.assertNotIn('2', saved['processes'])
                self.assertEqual(saved['identities']['2'], START)
                old = saved
        rows = cpu.parse_ps(line(pid=1))
        props, saved = cpu.deltas(rows, old, old['at']+60)
        measured = cpu.churn(rows, old, props)
        self.assertEqual((measured['spawned'], measured['exited']), (0, 1))
        self.assertNotIn('2', saved['identities'])

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
