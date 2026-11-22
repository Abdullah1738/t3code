import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import cpu
import ssd_probe as ssd
import toollog

NOW = dt.datetime(2026, 11, 17, 3, 5, tzinfo=dt.timezone.utc)


class SSDProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state_root = self.root/'state'
        self.path = self.root/'probe.bin'
        ssd.init_probe(self.path)
        env = patch.dict(os.environ, TOOLLOG_DIR=str(self.root/'logs'), BUN_INSPECT='private')
        env.start()
        self.addCleanup(env.stop)
        self.real_threads = ssd.sandboxd_threads
        self.real_capture = ssd.capture_prompt
        threads_patch = patch.object(ssd, 'sandboxd_threads', return_value=5)
        self.threads = threads_patch.start()
        self.addCleanup(threads_patch.stop)
        capture_patch = patch.object(ssd, 'capture_prompt', return_value=None)
        self.capture = capture_patch.start()
        self.addCleanup(capture_patch.stop)
        self.sent = []
        self.children = []
        self.popen = subprocess.Popen
        def spawn(*args, **kwargs):
            child = self.popen(*args, **kwargs)
            self.children.append(child)
            return child
        p = patch.object(ssd.subprocess, 'Popen', side_effect=spawn)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self.reap_children)

    def reap_children(self):
        # Only captured test children, never a PID discovered by name.
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=2)

    def send(self, text, key):
        self.sent.append((text, key))
        return True

    def sample(self, minute=0, **kwargs):
        return ssd.sample(root=self.state_root, path=self.path,
                          now=NOW+dt.timedelta(minutes=minute), send=self.send, **kwargs)

    def state(self):
        return json.loads((self.state_root/'ssd-read-probe.json').read_text())

    def event(self):
        lines = list((self.root/'logs').glob('*.ndjson'))[0].read_text().splitlines()
        return [json.loads(line) for line in lines]

    def test_ok_read_and_one_complete_event(self):
        with patch.object(ssd, 'process_type', return_value='Standard'), patch.object(ssd.os, 'nice', return_value=7):
            result = self.sample()
        self.assertEqual(result['outcome'], 'ok')
        self.assertEqual(result['sandboxdThreads'], 5)
        self.assertFalse((self.state_root/'ssd-launchd-read-blocked').exists())
        self.assertGreaterEqual(result['statMs'], 0)
        self.assertGreaterEqual(result['readMs'], 0)
        self.assertIsNone(result['errno'])
        self.assertFalse(result['stuckPrior'])
        self.assertNotIn('child', self.state())
        self.assertEqual(len(self.event()), 1)
        event = self.event()[0]
        self.assertEqual(event['name'], 'disk.ssd_read_probe')
        self.assertEqual(event['props'], result)
        self.assertEqual(event['props']['nice'], 7)
        self.assertEqual(self.sent, [])

    def test_slow_read(self):
        reader = [sys.executable, '-c', ssd.READER.replace('with open(sys.argv[1]', 'time.sleep(.55)\n            with open(sys.argv[1]'), str(self.path)]
        result = self.sample(reader=reader)
        self.assertEqual(result['outcome'], 'slow')
        self.assertGreater(result['readMs'], 500)
        self.assertFalse((self.state_root/'ssd-launchd-read-blocked').exists())

    def stuck(self, minute=0, timeout=3):
        reader = [sys.executable, '-c', ssd.READER.replace('with open(sys.argv[1]', 'time.sleep(60)\n            with open(sys.argv[1]'), str(self.path)]
        return self.sample(minute, timeout=timeout, reader=reader)

    def test_stuck_returns_within_deadline_retains_pid_and_next_run_suppresses_child(self):
        started = time.monotonic()
        result = self.stuck()
        self.assertLess(time.monotonic()-started, 4)
        self.assertEqual(result['outcome'], 'timeout')
        self.assertIsNone(result['readMs'])
        self.assertIsNotNone(result['statMs'])
        prior = self.state()['child']
        self.assertTrue(ssd.alive(prior['pid']))
        self.assertTrue(prior['start'])
        n = len([c for c in self.children if '-c' in c.args])
        result = self.sample(1)
        self.assertTrue(result['stuckPrior'])
        self.assertEqual(len([c for c in self.children if '-c' in c.args]), n)
        self.assertEqual(self.state()['child'], prior)
        self.assertEqual(len(self.event()), 2)

    def test_stale_prior_dead_or_reused_start_is_cleared(self):
        for kind in ('dead', 'different_start'):
            with self.subTest(kind=kind):
                self.state_root.mkdir(exist_ok=True)
                child = self.popen([sys.executable, '-c', 'pass'])
                child.wait(timeout=2)
                prior = dict(pid=child.pid if kind == 'dead' else os.getpid(), start='different lstart')
                ssd.atomic_json(self.state_root/'ssd-read-probe.json', dict(child=prior))
                self.assertEqual(self.sample()['outcome'], 'ok')
                self.assertNotIn('child', self.state())

    def test_errors_use_symbolic_errno_and_short_reads_fail(self):
        for kind, expected in (('missing', 'ENOENT'), ('short', 'EIO')):
            with self.subTest(kind=kind):
                if kind == 'missing':
                    self.path.unlink()
                else:
                    self.path.write_bytes(b'x')
                result = self.sample()
                self.assertEqual(result['outcome'], 'error')
                self.assertEqual(result['errno'], expected)

    def test_permission_error_class_is_not_a_successful_read(self):
        for name in ('EPERM', 'EACCES', 'EINTR'):
            with self.subTest(errno=name):
                self.state_root.mkdir(exist_ok=True)
                state = self.state_root/'ssd-read-probe.json'
                if state.exists():
                    state.unlink()
                marker = self.state_root/'ssd-launchd-read-blocked'
                marker.unlink(missing_ok=True)
                self.sent.clear()
                reader = [sys.executable, '-c', ssd.READER.replace(
                    'with open(sys.argv[1]', 'raise OSError(errno.%s, "denied")\n            with open(sys.argv[1]' % name), str(self.path)]
                first = self.sample(reader=reader)
                self.assertEqual(first['outcome'], 'error')
                self.assertEqual(first['errno'], name)
                self.assertIsNone(first['readMs'])
                self.assertFalse(marker.exists())
                self.sample(1, reader=reader)
                self.assertTrue(marker.exists())
                self.assertEqual(len(self.sent), 1)
                self.assertEqual(self.sample(2)['outcome'], 'ok')
                self.assertFalse(marker.exists())
                self.assertEqual(len(self.sent), 2)

    def test_two_failures_alert_once_and_recovery_once_no_stdout(self):
        self.path.unlink()
        marker = self.state_root/'ssd-launchd-read-blocked'
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.sample()
            self.assertFalse(marker.exists())
            self.assertEqual(self.sent, [])
            self.sample(1)
            self.assertEqual(json.loads(marker.read_text()), dict(
                since='2026-11-17T03:05:00.000000Z', lastOutcome='error', errno='ENOENT',
                sandboxdThreads=5, promptingPath=None))
            self.assertEqual(len(self.sent), 1)
            self.assertEqual(self.sent[0][0], "Background jobs can't read the ExternalSSD (since 03:05Z). Don't restart Robob or other apps until this clears; a fresh start can hang. Mac Upkeep is on it.")
            self.assertIn('ssd-read-probe', self.sent[0][1])
            self.sample(2)
            self.assertEqual(len(self.sent), 1)
            ssd.init_probe(self.path)
            self.sample(3)
            self.assertFalse(marker.exists())
            self.assertEqual(len(self.sent), 2)
            self.assertEqual(self.sent[1][0], 'Background SSD reads and sandbox approval thread count are healthy again.')
            self.sample(4)
            self.assertEqual(len(self.sent), 2)
            self.assertEqual(output.getvalue(), '')
        self.assertEqual(len(self.event()), 5)

    def test_timeout_then_stuck_prior_counts_as_two_failures(self):
        self.stuck(timeout=.2)
        result = self.sample(1)
        self.assertTrue(result['stuckPrior'])
        self.assertTrue((self.state_root/'ssd-launchd-read-blocked').exists())
        self.assertEqual(len(self.sent), 1)

    def test_slow_breaks_streak_but_does_not_recover_existing_outage(self):
        state = {}
        self.state_root.mkdir()
        marker = self.state_root/'ssd-launchd-read-blocked'
        bad = dict(outcome='timeout', errno='ETIMEDOUT', stuckPrior=False)
        slow = dict(outcome='slow', errno=None, stuckPrior=False)
        def advance(result):
            ssd.alert_state(result, self.state_root, state, lambda: None, NOW, self.send)
        advance(bad)
        advance(slow)
        advance(bad)
        self.assertFalse(marker.exists())
        advance(bad)
        advance(slow)
        self.assertTrue(marker.exists())
        self.assertEqual(len(self.sent), 1)

    def test_notification_failure_retries_same_key_and_text_before_recovery(self):
        self.path.unlink()
        self.sample()
        attempts = []
        def fail(text, key):
            attempts.append((text, key))
            return False
        with patch.object(self, 'send', side_effect=fail):
            self.sample(1)
            self.sample(2)
        self.assertEqual(attempts[0], attempts[1])
        ssd.init_probe(self.path)
        self.sample(3)
        self.assertEqual(self.sent[0], attempts[0])
        self.assertEqual(len(self.sent), 2)

    def test_spawn_error_also_advances_failure_streak(self):
        with patch.object(ssd.subprocess, 'Popen', side_effect=PermissionError(13, 'private')):
            first = self.sample()
            second = self.sample(1)
        self.assertEqual(first['errno'], 'EACCES')
        self.assertEqual(second['outcome'], 'error')
        self.assertTrue((self.state_root/'ssd-launchd-read-blocked').exists())
        self.assertEqual(len(self.sent), 1)

    def test_unknown_prior_identity_never_starts_reader(self):
        self.state_root.mkdir()
        ssd.atomic_json(self.state_root/'ssd-read-probe.json', dict(child=dict(pid=os.getpid(), start='known')))
        with patch.object(ssd, 'identity', return_value=None):
            result = self.sample()
        self.assertTrue(result['stuckPrior'])
        self.assertEqual(self.children, [])

    def test_stuck_identity_helper_prevents_all_new_children(self):
        self.state_root.mkdir()
        ssd.atomic_json(self.state_root/'ssd-read-probe.json', dict(identityChild=dict(pid=os.getpid(), birth=ssd.birth_identity(os.getpid()))))
        result = self.sample()
        self.assertTrue(result['stuckPrior'])
        self.assertEqual(self.children, [])

    def test_stale_identity_helper_pid_is_cleared_on_birth_change(self):
        self.state_root.mkdir()
        ssd.atomic_json(self.state_root/'ssd-read-probe.json', dict(
            identityChild=dict(pid=os.getpid(), birth=['old birth'])))
        with patch.object(ssd, 'birth_identity', return_value=['new birth']):
            result = self.sample()
        self.assertEqual(result['outcome'], 'ok')
        self.assertNotIn('identityChild', self.state())

    def test_unknown_metadata_never_opens_read_gate(self):
        for start, expected in ((None, 'timeout'), ('', 'error')):
            with self.subTest(start=start):
                touched = self.root/'must-not-read'
                code = 'import pathlib,sys; gate=sys.stdin.buffer.read(1); pathlib.Path(sys.argv[1]).touch() if gate == b"1" else None'
                reader = [sys.executable, '-c', code, str(touched)]
                with patch.object(ssd, 'identity', return_value=start):
                    result = self.sample(reader=reader)
                self.assertEqual(result['outcome'], expected)
                self.assertIsNone(self.state()['child']['start'])
                for child in self.children:
                    child.wait(timeout=2)
                self.assertFalse(touched.exists())

    def test_metadata_output_class(self):
        # Success, padding, empty success, failed exit, malformed, multiline,
        # and timeout exhaust the helper result forms the read gate accepts.
        cases = [
            (0, 'Tue Nov 17 03:05:00 2026\n', True, 'Tue Nov 17 03:05:00 2026'),
            (0, '  Tue Nov  7 03:05:00 2026  \n', True, 'Tue Nov  7 03:05:00 2026'),
            (0, '', True, ''),
            (1, 'Tue Nov 17 03:05:00 2026\n', True, ''),
            (0, 'unparseable', True, ''),
            (0, 'Tue Nov 17 03:05:00 2026\nextra', True, ''),
            (None, '', False, None),
        ]
        self.state_root.mkdir()
        for rc, output, finished, expected in cases:
            with self.subTest(rc=rc, output=output, finished=finished):
                state = {}
                class FakePS:
                    pid = os.getpid()
                    returncode = rc
                def spawn(argv, **kwargs):
                    kwargs['stdout'].write(output.encode())
                    return FakePS()
                with patch.object(ssd.subprocess, 'Popen', side_effect=spawn), patch.object(ssd, 'poll_until', return_value=finished):
                    actual = ssd.identity(123, self.state_root, state, lambda: None, time.monotonic()+3)
                self.assertEqual(actual, expected)
                self.assertEqual('identityChild' in state, not finished)

    def test_kernel_birth_identity_reports_native_fields(self):
        class FakeFunction:
            def __call__(self, pid, flavor, zero, pointer, size):
                pointer._obj.pid = pid
                pointer._obj.startS = 123
                pointer._obj.startUs = 456
                return size
        class FakeLib:
            proc_pidinfo = FakeFunction()
        with patch.object(ssd.sys, 'platform', 'darwin'), patch.object(ssd.c, 'CDLL', return_value=FakeLib()):
            self.assertEqual(ssd.birth_identity(321), [123, 456])

    def test_notify_uses_collector_path_but_abandons_stuck_launcher_without_pileup(self):
        self.state_root.mkdir()
        state = {}
        cmd = [sys.executable, '-c', 'import time; time.sleep(60)']
        def fake_notify(text, key, run):
            return run(cmd, env={k: v for k, v in os.environ.items() if k != 'BUN_INSPECT'}, timeout=20).returncode == 0
        def save():
            ssd.atomic_json(self.state_root/'ssd-read-probe.json', state)
        with patch.object(ssd, 'notify', side_effect=fake_notify):
            started = time.monotonic()
            self.assertFalse(ssd.send_notice('text', 'key', self.state_root, state, save))
            self.assertLess(time.monotonic()-started, 4)
            prior = state['noticeChild'].copy()
            self.assertTrue(prior['start'])
            self.assertTrue(ssd.alive(prior['pid']))
            before = sum(c.args == cmd for c in self.children)
            self.assertFalse(ssd.send_notice('text', 'key', self.state_root, state, save))
            self.assertEqual(sum(c.args == cmd for c in self.children), before)
            self.assertEqual(state['noticeChild'], prior)

    def test_sampler_lock_excludes_overlapping_manual_run(self):
        import fcntl
        self.state_root.mkdir()
        with (self.state_root/'ssd-read-probe.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertIsNone(self.sample())
        self.assertEqual(self.children, [])
        self.assertFalse((self.root/'logs').exists())

    def test_probe_initializer_keeps_existing_payload_and_rejects_wrong_size(self):
        self.path.write_bytes(b'x'*4096)
        ssd.init_probe(self.path)
        self.assertEqual(self.path.read_bytes(), b'x'*4096)
        self.path.write_bytes(b'x')
        with self.assertRaises(ValueError):
            ssd.init_probe(self.path)

    def test_independent_launchd_context_and_installer_wiring(self):
        plist = plistlib.loads((HERE/'launchd/com.abdullah.mac-ssd-read-probe.plist').read_bytes())
        self.assertEqual(plist['ProgramArguments'], ['/bin/zsh', '-fc', 'exec /usr/bin/python3 "$@"', '--', '__HOME__/.local/lib/mac-logging/ssd_probe.py', 'sample'])
        self.assertEqual(plist['ProcessType'], 'Standard')
        self.assertEqual(plist['StartInterval'], 60)
        self.assertTrue(plist['AbandonProcessGroup'])
        cpu_plist = plistlib.loads((HERE/'launchd/com.abdullah.mac-cpu.plist').read_bytes())
        self.assertEqual(cpu_plist['ProgramArguments'][:2], ['/bin/zsh', '-c'])
        self.assertNotIn('ssd_probe.py', cpu_plist['ProgramArguments'][-1])
        text = (HERE/'install.zsh').read_text()
        self.assertIn('com.abdullah.mac-ssd-read-probe', text)
        self.assertIn('ssd_probe.py', text)
        self.assertIn('probe.bin', text)

    def test_second_probe_alert_survives_cpu_inventory_that_never_returns(self):
        import select
        # A real CPU entrypoint reaches inventory and never returns. The old
        # combined job would still be active here and miss its next minute.
        # Keep auxiliary CPU checks out of the probe's log and alert fixture.
        script = ("import sys,time; sys.path.insert(0, sys.argv[1]); "
                  "import cpu,u_sample,disk_low; u_sample.sample=lambda:None; "
                  "disk_low.check=lambda:None; "
                  "cpu.sample=lambda:(print('inventory-blocked',flush=True),time.sleep(60)); "
                  "cpu.main()")
        inventory = self.popen([sys.executable, '-c', script, str(HERE)], stdout=subprocess.PIPE)
        self.children.append(inventory)
        self.addCleanup(inventory.stdout.close)
        ready, _, _ = select.select([inventory.stdout], [], [], 3)
        self.assertTrue(ready)
        self.assertEqual(inventory.stdout.readline().strip(), b'inventory-blocked')
        self.assertIsNone(inventory.poll())
        real_sample = ssd.sample
        slow_reader = [sys.executable, '-c', ssd.READER.replace('with open(sys.argv[1]', 'time.sleep(60)\n            with open(sys.argv[1]'), str(self.path)]
        def tick():
            return real_sample(root=self.state_root, path=self.path, now=NOW,
                               send=self.send, timeout=.2, reader=slow_reader)
        with patch.object(ssd, 'sample', side_effect=tick):
            ssd.main(['sample'])
            self.assertFalse((self.state_root/'ssd-launchd-read-blocked').exists())
            ssd.main(['sample'])
        self.assertIsNone(inventory.poll())
        self.assertEqual(len(self.event()), 2)
        self.assertTrue(self.event()[-1]['props']['stuckPrior'])
        self.assertTrue((self.state_root/'ssd-launchd-read-blocked').exists())
        self.assertEqual(len(self.sent), 1)

    def test_jam_threshold_latches_once_despite_read_ok_and_captures_only_on_latch(self):
        marker = self.state_root/'ssd-launchd-read-blocked'
        self.threads.return_value = 20
        self.capture.return_value = '/opt/homebrew/Cellar/node/26.13.0_2/bin/node'
        first = self.sample()
        self.assertEqual(first['outcome'], 'ok')
        self.assertFalse(self.event()[0]['ok'])
        self.assertFalse(marker.exists())
        self.capture.assert_not_called()
        self.sample(1)
        self.assertEqual(json.loads(marker.read_text()), dict(since='2026-11-17T03:05:00.000000Z',
            lastOutcome='jam', errno=None, sandboxdThreads=20, promptingPath=self.capture.return_value))
        self.capture.assert_called_once()
        self.assertEqual(len(self.sent), 1)
        self.assertIn('jam', self.sent[0][0])
        self.assertIn('20 threads', self.sent[0][0])
        self.sample(2)
        self.capture.assert_called_once()
        self.assertEqual(len(self.sent), 1)
        self.threads.return_value = None
        self.sample(3)
        self.assertTrue(marker.exists())
        self.assertEqual(len(self.sent), 1)
        self.threads.return_value = 5
        self.sample(4)
        self.assertFalse(marker.exists())
        self.assertEqual(len(self.sent), 2)
        self.sample(5)
        self.assertEqual(len(self.sent), 2)

    def test_thread_count_boundaries_and_missing_inventory(self):
        for threads, cause in ((None, None), (0, None), (5, None), (19, None), (20, 'jam'), (32, 'jam'), (83, 'jam')):
            with self.subTest(threads=threads):
                self.assertEqual(ssd.failure_cause(dict(outcome='ok', stuckPrior=False, sandboxdThreads=threads)), cause)
        self.assertEqual(ssd.failure_cause(dict(outcome='error', stuckPrior=False, sandboxdThreads=83)), 'error')

    def test_abandoned_prompt_capture_is_once_and_does_not_delay_future_ticks(self):
        self.threads.return_value = 32
        command = [sys.executable, '-c', 'import time; time.sleep(60)']
        real_bounded_capture = ssd.bounded_capture
        def capture(argv, key, root, state, save, deadline):
            self.assertEqual(argv, command)
            self.assertLessEqual(deadline, time.monotonic()+15)
            return real_bounded_capture(argv, key, root, state, save, time.monotonic()+.1)
        with patch.object(ssd, 'PROMPT_COMMAND', command), \
             patch.object(ssd, 'bounded_capture', side_effect=capture) as bounded, \
             patch.object(ssd, 'capture_prompt', side_effect=self.real_capture) as prompt:
            self.sample()
            self.sample(1)
            prior = self.state()['boundedChildren']['tccd-prompt']
            self.assertTrue(ssd.alive(prior['pid']))
            self.assertIsNone(json.loads((self.state_root/'ssd-launchd-read-blocked').read_text())['promptingPath'])
            self.assertEqual(len(self.sent), 1)
            self.sample(2)
            self.assertEqual(len(self.sent), 1)
            bounded.assert_called_once()
            prompt.assert_called_once()

    def test_real_thread_inventory_command_output_and_stuck_ps_suppression(self):
        self.state_root.mkdir()
        state = {}
        calls = []
        def capture(argv, key, root, state, save, deadline):
            calls.append(argv)
            return '174\n' if key == 'sandboxd-pid' else 'HEADER\n'+'thread\n'*5
        with patch.object(ssd, 'bounded_capture', side_effect=capture):
            self.assertEqual(self.real_threads(self.state_root, state, lambda: None), 5)
        self.assertEqual(calls, [['/usr/bin/pgrep', '-x', 'sandboxd'], ['/bin/ps', '-M', '-p', '174']])
        state = {}
        cmd = [sys.executable, '-c', 'import time; time.sleep(60)']
        before = len(self.children)
        started = time.monotonic()
        self.assertIsNone(ssd.bounded_capture(cmd, 'sandboxd-threads', self.state_root, state, lambda: None,
                                             time.monotonic()+.1))
        self.assertLess(time.monotonic()-started, 1.1)
        prior = state['boundedChildren']['sandboxd-threads'].copy()
        self.assertTrue(ssd.alive(prior['pid']))
        with patch.object(ssd, 'bounded_capture') as child:
            self.assertIsNone(self.real_threads(self.state_root, state, lambda: None))
            child.assert_not_called()
        self.assertEqual(len(self.children), before+1)

    def test_unavailable_sandboxd_inventory_forms(self):
        self.state_root.mkdir()
        for output in (None, '', '1\n2', 'not a pid'):
            with self.subTest(output=output), patch.object(ssd, 'bounded_capture', return_value=output):
                self.assertIsNone(self.real_threads(self.state_root, {}, lambda: None))
        for output in (None, '', 'HEADER\n'):
            with self.subTest(rows=output), patch.object(ssd, 'bounded_capture', side_effect=['174', output]):
                self.assertIsNone(self.real_threads(self.state_root, {}, lambda: None))

    def test_prompt_capture_command_deadline_and_last_path(self):
        messages = [
            dict(eventMessage='AUTHREQ_PROMPTING subject=Sub:{/old/path}Resp:{pid=1}'),
            dict(eventMessage='other responsible_path=/ignore'),
            dict(eventMessage='AUTHREQ_PROMPTING responsible_path=/path with spaces/bin/node, pid=2'),
        ]
        output = 'torn first line\n'+''.join(json.dumps(row)+'\n' for row in messages)
        started = time.monotonic()
        with patch.object(ssd, 'bounded_capture', return_value=output) as capture:
            self.assertEqual(self.real_capture(self.state_root, {}, lambda: None), '/path with spaces/bin/node')
        args = capture.call_args.args
        self.assertEqual(args[0], ssd.PROMPT_COMMAND)
        self.assertEqual(args[1], 'tccd-prompt')
        self.assertGreater(args[-1], started)
        self.assertLessEqual(args[-1], time.monotonic()+15)
        self.assertIsNone(ssd.prompting_path('not-json\n{}\n'+json.dumps(dict(eventMessage='AUTHREQ_PROMPTING'))))

    def test_generic_capture_suppresses_live_identity_and_clears_reused_pid(self):
        self.state_root.mkdir()
        state = dict(boundedChildren={'tccd-prompt': dict(pid=os.getpid(), birth=ssd.birth_identity(os.getpid()))})
        command = [sys.executable, '-c', 'print("done")']
        self.assertIsNone(ssd.bounded_capture(command, 'tccd-prompt', self.state_root, state, lambda: None, time.monotonic()+1))
        self.assertEqual(self.children, [])
        state['boundedChildren']['tccd-prompt']['birth'] = ['different']
        self.assertEqual(ssd.bounded_capture(command, 'tccd-prompt', self.state_root, state, lambda: None, time.monotonic()+1), 'done\n')

    def test_event_sanitizer_preserves_nulls_and_drops_unknown_fields(self):
        props = dict(statMs=None, readMs=None, loadavg1=1, nice=0, processType='Standard',
                     outcome='timeout', errno='ETIMEDOUT', stuckPrior=True, sandboxdThreads=None)
        self.assertEqual(toollog.safe_fields(dict(props, password='private'), 'disk.ssd_read_probe'), props)


if __name__ == '__main__':
    unittest.main()
