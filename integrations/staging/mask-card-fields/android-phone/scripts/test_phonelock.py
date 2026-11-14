"""Phone ownership regressions, with no real adb or u2 calls."""
import ast
import contextlib
import datetime as dt
import importlib.util
import io
import json
import multiprocessing as mp
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ph
import phonelock as lock

HOLD_TOKEN = '#21 full16 / current worker thread'
TREE = '<hierarchy><node text="Copy" bounds="[0,0][20,20]" package="dev.test" /></hierarchy>'


def race(directory, owner, ready, go, results):
    lock.LOCK_DIR = Path(directory)
    lock.HOLD = lock.LOCK_DIR / 'priority-hold'
    lock.LEASE = lock.LOCK_DIR / 'lease.json'
    lock.event_hook = lambda kind: None
    ready.put(True)
    go.wait(10)
    try:
        lock.acquire(owner, 'race')
        results.put(True)
    except lock.Busy:
        results.put(False)


class PhoneLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.device = Mock()
        self.device.dump_hierarchy.return_value = TREE
        for obj, name, value in [(lock, 'LOCK_DIR', self.root), (lock, 'HOLD', self.root/'priority-hold'),
                                  (lock, 'LEASE', self.root/'lease.json'), (ph, 'STATE', self.root/'events'),
                                  (ph, 'd', Mock(return_value=self.device)), (ph, '_d', None),
                                  (lock, 'event_hook', ph.lock_event),
                                  (ph, 'caller_chain', Mock(return_value=[dict(pid=123, comm='zsh', cwd_tail='projects/fixture')]))]:
            p = patch.object(obj, name, value)
            p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {'PH_LOCK_DIR': str(self.root), 'PH_LEASE_OWNER': '', 'PHONE_HOLD_OWNER': ''})
        p.start(); self.addCleanup(p.stop)
        p = patch.object(ph.subprocess, 'run', side_effect=AssertionError('No device or process probes'))
        p.start(); self.addCleanup(p.stop)
        p = patch.object(ph, '_run', side_effect=AssertionError('No adb'))
        p.start(); self.addCleanup(p.stop)
        p = patch.object(ph.time, 'sleep')
        p.start(); self.addCleanup(p.stop)

    def cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ph.run(list(args))
        return code, out.getvalue()

    def events(self):
        path = ph.STATE/'events.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def claim(self, owner='holder', ttl='20m'):
        return lock.acquire(owner, 'qa', ttl)

    def test_exclusive_and_nonowner_release(self):
        self.claim()
        with self.assertRaises(lock.Busy): self.claim('other')
        with self.assertRaises(lock.Busy): lock.release('other')
        self.assertEqual(lock.status()['lease_owner'], 'holder')
        lock.release('holder')
        self.assertFalse(lock.LEASE.exists())

    def test_twenty_multiprocess_races(self):
        ctx = mp.get_context('spawn')
        for _ in range(20):
            ready, results, go = ctx.Queue(), ctx.Queue(), ctx.Event()
            jobs = [ctx.Process(target=race, args=(str(self.root), name, ready, go, results)) for name in ('one', 'two')]
            for job in jobs: job.start()
            for job in jobs: self.assertTrue(ready.get(timeout=15))
            go.set()
            self.assertEqual(sorted(results.get(timeout=15) for _ in jobs), [False, True])
            for job in jobs:
                job.join(15)
                self.assertEqual(job.exitcode, 0)
            lock.release(lock.status()['lease_owner'])

    def test_expired_takeover_is_logged(self):
        self.claim()
        lease = json.loads(lock.LEASE.read_text())
        lease['acquired_at'] = (lock.now()-dt.timedelta(minutes=30)).isoformat()
        lease['expires_at'] = (lock.now()-dt.timedelta(minutes=10)).isoformat()
        lock.LEASE.write_text(json.dumps(lease))
        self.assertTrue(lock.check(True)[0])
        self.claim('new')
        self.assertEqual(lock.status()['lease_owner'], 'new')
        self.assertEqual(self.events()[-1]['event'], 'lease_expired_takeover')

    def test_expired_takeover_race(self):
        self.claim()
        lease = json.loads(lock.LEASE.read_text())
        lease['acquired_at'] = (lock.now()-dt.timedelta(minutes=30)).isoformat()
        lease['expires_at'] = (lock.now()-dt.timedelta(minutes=10)).isoformat()
        lock.LEASE.write_text(json.dumps(lease))
        ctx = mp.get_context('spawn')
        ready, results, go = ctx.Queue(), ctx.Queue(), ctx.Event()
        jobs = [ctx.Process(target=race, args=(str(self.root), name, ready, go, results)) for name in ('one', 'two')]
        for job in jobs: job.start()
        for job in jobs: ready.get(timeout=15)
        go.set()
        self.assertEqual(sorted(results.get(timeout=15) for _ in jobs), [False, True])
        for job in jobs:
            job.join(15); self.assertEqual(job.exitcode, 0)

    def test_hold_blocks_acquire_even_for_holder(self):
        lock.HOLD.write_text(HOLD_TOKEN)
        os.environ['PHONE_HOLD_OWNER'] = HOLD_TOKEN
        with self.assertRaises(lock.Busy): self.claim()

    def test_hold_blocks_actions_and_reads_without_device_or_reset(self):
        lock.HOLD.write_text(HOLD_TOKEN)
        for cmd in [('open', 'dev.example'), ('ui',), ('shot', 'x'), ('cur',), ('wait', 'x'),
                    ('find', 'x'), ('sms',), ('doctor',), ('sh', 'private-command'), ('type', 'secret')]:
            with self.subTest(cmd=cmd):
                with patch.object(ph, 'reset_u2') as reset:
                    code, out = self.cli(*cmd)
                self.assertEqual(code, 5)
                self.assertIn(lock.HOLD_REASON, out)
                self.assertNotIn(HOLD_TOKEN, out)
                reset.assert_not_called()
                ph.d.assert_not_called()
                ph._run.assert_not_called()
                ph.subprocess.run.assert_not_called()
                row = self.events()[-1]
                self.assertEqual((row['event'], row['reason'], row['cmd']), ('busy_refused', 'hold', cmd[0]))
        self.assertNotIn(HOLD_TOKEN, json.dumps(self.events()))
        self.assertNotIn('secret', json.dumps(self.events()))

    def test_exact_free_text_hold_owner_and_priority_over_lease(self):
        self.claim()
        lock.HOLD.write_text(HOLD_TOKEN+'\n')
        for owner, code in [('', 5), ('different', 5), (HOLD_TOKEN, 0)]:
            with patch.dict(os.environ, {'PHONE_HOLD_OWNER': owner}):
                self.assertEqual(self.cli('open', 'dev.example')[0], code)
        self.device.app_start.assert_called_once_with('dev.example')

    def test_hold_disappears_after_start_check(self):
        lock.HOLD.write_text(HOLD_TOKEN)
        os.environ['PHONE_HOLD_OWNER'] = HOLD_TOKEN
        def connect():
            lock.HOLD.unlink()
            return self.device
        ph.d.side_effect = connect
        self.assertEqual(self.cli('open', 'dev.example')[0], 0)
        self.device.app_start.assert_called_once()

    def test_unreadable_and_empty_hold_fail_closed(self):
        lock.HOLD.write_text('')
        self.assertEqual(lock.check(False), (False, lock.HOLD_REASON))
        with patch.object(Path, 'read_text', side_effect=PermissionError):
            self.assertEqual(lock.check(True), (False, lock.HOLD_REASON))
        lock.HOLD.unlink()
        with patch.object(Path, 'read_text', side_effect=PermissionError):
            self.assertEqual(lock.hold_state(), (False, False))

    def test_local_commands_work_under_hold(self):
        lock.HOLD.write_text(HOLD_TOKEN)
        for args in [('help',), ('log',), ('lease', 'status', '--json'),
                     ('note-drop', '--source', 'fixture', '--cmd', 'read', '--exc', 'ConnectionError')]:
            self.assertEqual(self.cli(*args)[0], 0)
        ph.d.assert_not_called(); ph._run.assert_not_called()
        ph.subprocess.run.assert_not_called()

    def test_foreign_lease_blocks_tap_and_type_without_input_in_logs(self):
        self.claim()
        for args in [('tap', '10', '10'), ('type', 'secret')]:
            code, out = self.cli(*args)
            self.assertEqual(code, 5)
            self.assertNotIn('secret', out)
        self.device.click.assert_not_called(); self.device.send_keys.assert_not_called()
        self.assertNotIn('secret', json.dumps(self.events()))
        for row in self.events():
            self.assertEqual((row['event'], row['reason'], row['lease_state']), ('busy_refused', 'lease', 'foreign'))
            self.assertEqual(set(row['caller_chain'][0]), {'pid', 'comm', 'cwd_tail'})
        self.assertFalse((ph.STATE/'drops').exists())

    def test_owner_refresh_and_same_owner_reacquire(self):
        self.claim()
        os.environ['PH_LEASE_OWNER'] = 'holder'
        initial = json.loads(lock.LEASE.read_text())
        future = lock.now()+dt.timedelta(minutes=15)
        with patch.object(lock, 'now', return_value=future):
            self.assertEqual(self.cli('key', 'home')[0], 0)
        refreshed = json.loads(lock.LEASE.read_text())
        self.assertGreater(refreshed['expires_at'], initial['expires_at'])
        self.device.press.assert_called_once_with('home')
        self.claim()
        self.assertEqual(lock.status()['lease_state'], 'own')

    def test_claim_between_start_and_rpc_is_refused(self):
        def connect():
            self.claim()
            return self.device
        ph.d.side_effect = connect
        self.assertEqual(self.cli('tap', '10', '10')[0], 5)
        self.device.click.assert_not_called()
        self.assertEqual([r['event'] for r in self.events()], ['busy_refused'])

    def test_hold_between_start_and_rpc_is_refused(self):
        def connect():
            lock.HOLD.write_text(HOLD_TOKEN)
            return self.device
        ph.d.side_effect = connect
        self.assertEqual(self.cli('open', 'dev.example')[0], 5)
        self.device.app_start.assert_not_called()

    def test_read_under_foreign_lease_succeeds_but_failure_never_resets(self):
        self.claim()
        self.assertEqual(self.cli('ui')[0], 0)
        self.device.dump_hierarchy.side_effect = RuntimeError('failed read')
        with patch.object(ph, 'reset_u2') as reset:
            code, out = self.cli('ui')
        self.assertEqual(code, 5)
        self.assertIn('not resetting u2 while', out)
        reset.assert_not_called(); ph._run.assert_not_called()

    def test_new_hold_during_read_failure_never_resets(self):
        def fail(**kwargs):
            lock.HOLD.write_text(HOLD_TOKEN)
            raise RuntimeError('failed read')
        self.device.dump_hierarchy.side_effect = fail
        with patch.object(ph, 'reset_u2') as reset:
            self.assertEqual(self.cli('ui')[0], 5)
        reset.assert_not_called(); ph._run.assert_not_called()

    def test_reset_guard_and_action_failure_keep_maybe_sent(self):
        self.claim()
        ph.reset_u2()
        ph._run.assert_not_called()
        os.environ['PH_LEASE_OWNER'] = 'holder'
        def fail(*args):
            lock.HOLD.write_text(HOLD_TOKEN)
            raise RuntimeError('lost reply')
        self.device.press.side_effect = fail
        self.assertEqual(self.cli('key', 'home')[0], 4)
        ph._run.assert_not_called()

    def test_unleased_action_and_log_counts(self):
        self.assertEqual(self.cli('key', 'home')[0], 0)
        self.assertEqual([r['event'] for r in self.events()], ['action', 'unleased_action'])
        lock.HOLD.write_text(HOLD_TOKEN)
        self.cli('ui')
        code, out = self.cli('log')
        self.assertEqual(code, 0)
        self.assertIn('by lease_state: none=3', out)
        self.assertIn('busy_refused by reason: hold=1', out)

    def test_owner_and_ttl_input_class(self):
        for owner in ['', 'a'*81, 'has space', 'a/b', 'a\n', '#21']:
            with self.subTest(owner=owner), self.assertRaises(ValueError): self.claim(owner)
        for ttl in ['0', '-1', '121m', 'nan', 'inf', '20x']:
            with self.subTest(ttl=ttl), self.assertRaises(ValueError): self.claim(ttl=ttl)
        self.claim('a._:-Z9', '120m')

    def test_purpose_redaction(self):
        lock.acquire('holder', 'CVV 123; card 4111111111111111')
        raw = lock.LEASE.read_text()
        self.assertNotIn('123', raw); self.assertNotIn('4111111111111111', raw)
        self.assertLessEqual(len(json.loads(raw)['purpose']), 80)

    def test_caller_chain_comm_only_and_bounded(self):
        with patch.object(ph.subprocess, 'run') as run:
            run.side_effect = [subprocess.CompletedProcess([], 0, '42 /bin/zsh\n'),
                               subprocess.CompletedProcess([], 0, '0 /usr/bin/parent\n'),
                               subprocess.CompletedProcess([], 0, 'p42\nn/Users/a/projects/fixture\n')]
            rows = PhoneLockTests.real_chain()
        self.assertEqual([r['comm'] for r in rows], ['zsh', 'parent'])
        self.assertIsNone(rows[0]['cwd_tail'])
        self.assertEqual(rows[-1]['cwd_tail'], 'projects/fixture')
        for call in run.call_args_list:
            self.assertEqual(call.kwargs['timeout'], 1)
            self.assertNotIn('args=', call.args[0])

    def test_jevrun_priority_and_import_from_other_cwd(self):
        source = Path(__file__).with_name('jevrun.py').read_text()
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'priority_check')
        scope = dict(phonelock=lock, sys=sys)
        exec(compile(ast.Module(body=[node], type_ignores=[]), '<guard>', 'exec'), scope)
        self.claim()
        with self.assertRaises(SystemExit) as exc: scope['priority_check']()
        self.assertEqual(exc.exception.code, 5)

    real_chain = staticmethod(ph.caller_chain)


class LeaseRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = {**os.environ, 'PH_LOCK_DIR': str(self.root), 'PH_TMP': str(self.root/'shots'),
                    'PHONE_HOLD_OWNER': '', 'PH_LEASE_OWNER': ''}
        self.script = str(Path(__file__).with_name('ph.py'))

    def command(self, code):
        return [sys.executable, '-I', self.script, 'lease', 'run', '--owner', 'runner', '--purpose', 'qa',
                '--ttl', '2s', '--', sys.executable, '-I', '-c', code]

    def test_child_environment_and_normal_nonzero_release(self):
        for code in [0, 7]:
            result = subprocess.run(self.command(f'import os,sys; print(os.environ["PH_LEASE_OWNER"]); sys.exit({code})'),
                                    env=self.env, cwd=self.root, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, code, result.stdout+result.stderr)
            self.assertEqual(result.stdout.strip(), 'runner')
            self.assertFalse((self.root/'lease.json').exists())

    def test_sigterm_forward_release_and_code(self):
        ready = self.root/'ready'
        result = self.root/'signal'
        code = ('import pathlib,signal,time,sys; '
                f'signal.signal(signal.SIGTERM, lambda *a: (pathlib.Path({str(result)!r}).touch(),sys.exit(9))); '
                f'pathlib.Path({str(ready)!r}).touch(); time.sleep(30)')
        child = subprocess.Popen(self.command(code), env=self.env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic()+10
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(ready.exists())
            child.send_signal(signal.SIGTERM)
            out, err = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 9, (out, err))
            self.assertTrue(result.exists())
            self.assertFalse((self.root/'lease.json').exists())
        finally:
            if child.poll() is None:
                child.kill(); child.wait()

    def test_sigint_releases_with_ignoring_child(self):
        ready = self.root/'ready'
        code = ('import pathlib,signal,time; signal.signal(signal.SIGINT, signal.SIG_IGN); '
                f'pathlib.Path({str(ready)!r}).touch(); time.sleep(30)')
        child = subprocess.Popen(self.command(code), env=self.env, cwd=self.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic()+10
            while not ready.exists() and time.monotonic() < deadline: time.sleep(.01)
            self.assertTrue(ready.exists())
            child.send_signal(signal.SIGINT)
            out, err = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 137, (out, err))
            self.assertFalse((self.root/'lease.json').exists())
        finally:
            if child.poll() is None: child.kill(); child.wait()

    def test_jevrun_subprocess_from_other_cwd(self):
        (self.root/'priority-hold').write_text(HOLD_TOKEN)
        script = str(Path(__file__).with_name('jevrun.py'))
        bootstrap = ('import pathlib,runpy,sys,types; from unittest.mock import patch; '
                     'sys.modules["requests"]=types.SimpleNamespace(); '
                     'sys.modules["uiautomator2"]=types.SimpleNamespace(connect=lambda *a: (_ for _ in ()).throw(AssertionError("device touched"))); '
                     f'sys.argv=[{script!r},"missing-plan"]; '
                     f'patch(pathlib.Path.__module__+".Path.read_text", lambda self: {HOLD_TOKEN!r} if self.name=="priority-hold" else "dummy").start(); '
                     f'runpy.run_path({script!r},run_name="__main__")')
        result = subprocess.run([sys.executable, '-I', '-c', bootstrap], env=self.env, cwd=self.root,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 5, result.stderr)
        self.assertNotIn(HOLD_TOKEN, result.stdout)

    def test_run_refreshes_and_spawn_failure_releases(self):
        code = ('import time,json,os,datetime,pathlib; time.sleep(2.5); '
                'lease=json.loads((pathlib.Path(os.environ["PH_LOCK_DIR"])/"lease.json").read_text()); '
                'assert datetime.datetime.fromisoformat(lease["expires_at"]) > datetime.datetime.now(datetime.timezone.utc)')
        result = subprocess.run(self.command(code), env=self.env, cwd=self.root, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root/'lease.json').exists())
        args = self.command('')[:-4] + ['--', '/no-such-fixture-command']
        result = subprocess.run(args, env=self.env, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.root/'lease.json').exists())


if __name__ == '__main__': unittest.main()
