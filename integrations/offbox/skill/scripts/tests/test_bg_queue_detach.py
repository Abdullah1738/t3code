"""Queued background clients use a real session/process boundary; all box operations are fake."""
import contextlib
import io
import json
import faulthandler
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.environ.get('OFFBOX_TEST_SCRIPTS', str(Path(__file__).resolve().parents[1])))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, home, lease, misc, outage, pool, reap, runs
from test_capacity import Isolated


def configure_fixture(root, backend):
    common.STATE = root / 'STATE'
    common.DB_PATH = root / 'db.sqlite'
    common.LOG_PATH = root / 'log'
    common.LOCKS_DIR = root / 'LOCKS_DIR'
    common.LOGS_DIR = runs.LOGS_DIR = misc.LOGS_DIR = root / 'LOGS_DIR'
    api.BACKEND = backend
    common._BACKEND = backend
    api._key = lambda: (_ for _ in ()).throw(AssertionError('no live API'))
    runs.BG_ENTRY = Path(os.environ.get('OFFBOX_TEST_ENTRY', __file__)).resolve()
    os.environ['OFFBOX_TEST_ROOT'] = str(root)
    me = dict(owner='worker', repo_key='repo', repo_root=str(root), session='s', thread='t')
    a = SimpleNamespace(bg=True, no_sync=True, cmd=['proof'], steps=[], pull=[], env=[], size=None,
                        template=None, base=None, fresh=False, git=False)
    if os.environ.get('OFFBOX_TEST_ENTRY'):
        a.cmd = ['proof' + 'x' * 300000]
    pool.release_guard = lambda row: None
    lease.ensure_ttl = lambda *args: (root / 'ttl').write_text('extended')
    api.get = lambda *args: {'state': 'running'}
    lease.touch = lease.idle_ttl = lambda *args: None
    lease.auto_size = lambda *args: ('large', '')
    runs.Runner._log_pool = lambda *args: None
    runs.Runner._prepare_box = lambda *args: None
    runs._keep_ttl = lambda *args: contextlib.nullcontext()
    runs.node_version.want = runs.pnpm_version.want = lambda *args: None
    runs.new_checkout_hint = lambda *args: None
    runs.remote_script = lambda *args, **kwargs: 'proof'
    # A detached worker must exercise the shared startup loop without consulting the Mac's home configuration.
    home.may_fail_over = lambda *args: False
    home.on_standby = home.active = lambda: False
    if os.environ.get('OFFBOX_TEST_OLD_REGISTRATION'):
        register = runs.Runner.register_pending
        def aged(self):
            register(self)
            if not os.environ.get(runs.BACKGROUND_RUN_ENV):
                self.record(start_at=common.now() - 10)
        runs.Runner.register_pending = aged

    def acquire(*args, **kwargs):
        (root / 'waiting').write_text(str(os.getpid()))
        with common.file_lock('fixture-slot', timeout=15):
            return dict(box_id='box-fake', size='large', remote_dir='repo')

    def start(box, command, *, meta, **kwargs):
        with (root / 'starts').open('a') as stream:
            stream.write(meta['run_id'] + '\n')
        return dict(processId=42, commandId='cmd-fake')

    pool.acquire = acquire
    api.cmd_start = start
    return a, me


def fixture(root, bg, backend):
    a, me = configure_fixture(root, backend)
    a.bg = bg
    def publish(name, value):
        pending = root / (name + '.tmp')
        pending.write_text(value)
        pending.replace(root / name)
    if os.environ.get('OFFBOX_TEST_THREADED_CALLER'):
        threading.Thread(target=threading.Event().wait, daemon=True).start()
    masked = bool(os.environ.get('OFFBOX_TEST_MASKED_MAIN'))
    if masked:
        interruptions = 0
        def interrupted(signum, frame):
            nonlocal interruptions
            interruptions += 1
            publish('caller-interrupted', str(interruptions))
        signal.signal(signal.SIGINT, interrupted)
        signal.pthread_sigmask(signal.SIG_BLOCK, (signal.SIGINT,))
    if os.environ.get('OFFBOX_TEST_READY_TIMEOUT'):
        runs.BG_READY_TIMEOUT_S = float(os.environ['OFFBOX_TEST_READY_TIMEOUT'])
    code = runs.run_remote(a, me)
    if masked:
        publish('mask-restored', str(signal.SIGINT in signal.pthread_sigmask(signal.SIG_BLOCK, ())))
    publish('returned', str(code))
    while True:
        if masked:
            time.sleep(.01)
        else:
            signal.pause()


class BackgroundQueueTests(Isolated):
    def launch(self, *, bg=True, backend='boat', old_registration=False):
        proc = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()), '--fixture',
                                 self.tmp.name, str(int(bg)), backend], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True,
                                env=dict(os.environ, OFFBOX_TEST_OLD_REGISTRATION='1' if old_registration else ''))
        self.addCleanup(self.stop, proc)
        self.until(lambda: (Path(self.tmp.name) / ('returned' if bg else 'waiting')).exists(), proc)
        row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
        self.assertIsNotNone(row)
        self.addCleanup(self.stop_child, row['client_pid'], proc.pid)
        if bg:
            self.assertEqual((Path(self.tmp.name) / 'returned').read_text(), '0')
        return proc, dict(row)

    def stop(self, proc):
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate(timeout=5)

    def stop_child(self, pid, caller):
        if not pid or pid == caller:
            return
        # The child settles its run on SIGTERM; wait for it so it isn't still writing when the tempdir is removed.
        for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                return
            end = time.monotonic() + wait
            while time.monotonic() < end:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    return
                time.sleep(.02)

    def until(self, predicate, proc=None):
        end = time.monotonic() + 8
        while not predicate():
            if proc is not None and proc.poll() is not None:
                self.fail(f'caller exited early: {proc.communicate()}')
            if time.monotonic() >= end:
                self.fail('fixture milestone did not arrive')
            time.sleep(.01)

    def test_full_pool_survives_caller_group_signals_on_both_backends(self):
        for backend, sig in ((backend, sig) for backend in ('boat', 'server')
                             for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGKILL)):
            with self.subTest(backend=backend, signal=sig):
                root = Path(self.tmp.name)
                for name in ('returned', 'waiting', 'starts', 'ttl'):
                    (root / name).unlink(missing_ok=True)
                with common.file_lock('fixture-slot'):
                    proc, row = self.launch(backend=backend)
                    self.until(lambda: (root / 'waiting').exists(), proc)
                    self.assertNotEqual(row['client_pid'], proc.pid)
                    self.assertEqual(os.getsid(row['client_pid']), row['client_pid'])
                    self.assertEqual(row['status'], 'starting')
                    self.assertIsNone(row['box_id'])
                    self.assertFalse((root / 'starts').exists())
                    os.killpg(proc.pid, sig)
                    out, err = proc.communicate(timeout=5)
                    self.assertEqual(out.decode().strip(), row['run_id'])
                    self.assertIn('queued in background', err.decode())
                    self.assertIn('Follow:', err.decode())
                    self.assertTrue(misc._client_alive(row['client_pid'], row['start_at']))
                self.until(lambda: (root / 'ttl').exists())
                self.assertEqual((root / 'starts').read_text().splitlines(), [row['run_id']])
                current = self.con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
                self.assertEqual((current['status'], current['process_id']), ('running', 42))
                client_log = root / 'LOGS_DIR' / f"{row['run_id']}.client.log"
                self.until(lambda: 'started in background' in client_log.read_text())

    def test_free_slot_starts_once_and_returns_id(self):
        proc, row = self.launch()
        root = Path(self.tmp.name)
        self.until(lambda: (root / 'ttl').exists())
        os.killpg(proc.pid, signal.SIGKILL)
        out, err = proc.communicate(timeout=5)
        self.assertEqual(out.decode().strip(), row['run_id'])
        self.assertIn(f'offbox wait {row["run_id"]}', err.decode())
        self.assertEqual((root / 'starts').read_text().splitlines(), [row['run_id']])

    def test_kill_queued_run_stops_detached_client(self):
        with common.file_lock('fixture-slot'):
            proc, row = self.launch()
            self.until(lambda: (Path(self.tmp.name) / 'waiting').exists(), proc)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(misc.kill_run(row['run_id']), 0)
            current = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
            self.assertEqual(tuple(current), ('killed', 130))
        self.assertFalse((Path(self.tmp.name) / 'starts').exists())

    def test_old_parent_registration_does_not_make_child_look_like_reused_pid(self):
        with common.file_lock('fixture-slot'):
            proc, row = self.launch(old_registration=True)
            self.until(lambda: (Path(self.tmp.name) / 'waiting').exists(), proc)
            self.assertTrue(misc._client_alive(row['client_pid'], row['start_at']))
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(common.OffboxError) as caught:
                misc.wait(row['run_id'], .05)
            self.assertEqual(caught.exception.code, common.EXIT_WAIT_TIMEOUT)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(misc.kill_run(row['run_id']), 0)

    def test_caller_dies_before_readiness_acknowledgement(self):
        root = Path(self.tmp.name)
        with common.file_lock('fixture-handoff'):
            proc = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()), '--fixture',
                                     self.tmp.name, '1', 'boat'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True, env=dict(os.environ, OFFBOX_TEST_HANDOFF='1'))
            self.addCleanup(self.stop, proc)
            self.until(lambda: (root / 'handoff').exists(), proc)
            child = int((root / 'handoff').read_text())
            self.addCleanup(self.stop_child, child, proc.pid)
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate(timeout=5)
            with patch.object(api, 'list_boxes', return_value=[]):
                reap.reap()
            row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
            self.assertEqual(row['status'], 'starting')
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(common.OffboxError) as caught:
                misc.wait(row['run_id'], .05)
            self.assertEqual(caught.exception.code, common.EXIT_WAIT_TIMEOUT)
        self.until(lambda: (root / 'ttl').exists())
        self.assertEqual(len((root / 'starts').read_text().splitlines()), 1)

    def test_removed_cwd_before_adoption_settles_source_gone(self):
        root = Path(self.tmp.name)
        source_cwd = root / 'work'
        source_cwd.mkdir()
        with common.file_lock('fixture-handoff'):
            proc = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()), '--fixture',
                                     self.tmp.name, '1', 'boat'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True, cwd=source_cwd,
                                    env=dict(os.environ, OFFBOX_TEST_HANDOFF='1'))
            self.addCleanup(self.stop, proc)
            self.until(lambda: (root / 'handoff').exists(), proc)
            child = int((root / 'handoff').read_text())
            self.addCleanup(self.stop_child, child, proc.pid)
            source_cwd.rmdir()
        self.until(lambda: (root / 'returned').exists(), proc)
        row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
        self.until(lambda: self.con.execute('SELECT status FROM runs WHERE run_id=?',
                                            (row['run_id'],)).fetchone()[0] == 'source_gone', proc)
        row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
        self.assertEqual(row['exit_code'], 2)
        self.assertIn(str(source_cwd), row['error'])
        self.assertIsNone(row['box_id'])
        self.assertGreater(Path(row['log_path']).stat().st_size, 0)
        self.assertFalse((root / 'starts').exists())
        self.assertFalse((root / 'waiting').exists())
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.wait(row['run_id'], 1), 2)

    def test_foreground_term_in_pool_wait_still_settles_killed(self):
        with common.file_lock('fixture-slot'):
            proc, row = self.launch(bg=False)
            self.assertEqual(row['client_pid'], proc.pid)
            os.killpg(proc.pid, signal.SIGTERM)
            proc.communicate(timeout=5)
            current = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
            self.assertEqual(tuple(current), ('killed', 130))
        self.assertFalse((Path(self.tmp.name) / 'starts').exists())

    def test_caller_sigint_during_readiness_does_not_cancel_the_child(self):
        self.readiness_sigint(threaded=False)

    def test_threaded_caller_sigint_during_readiness_does_not_cancel_the_child(self):
        self.readiness_sigint(threaded=True)

    def test_threaded_caller_sigint_does_not_waive_readiness_timeout(self):
        self.readiness_sigint(threaded=True, timeout=True)

    def test_masked_main_replays_sigint_through_an_unmasked_thread(self):
        self.readiness_sigint(threaded=True, masked=True)

    def readiness_sigint(self, *, threaded, timeout=False, masked=False):
        root = Path(self.tmp.name)
        with common.file_lock('fixture-handoff'):
            proc = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()), '--fixture',
                                     self.tmp.name, '1', 'boat'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True, env=dict(os.environ, OFFBOX_TEST_HANDOFF='1',
                                                                   OFFBOX_TEST_THREADED_CALLER='1' if threaded else '',
                                                                   OFFBOX_TEST_MASKED_MAIN='1' if masked else '',
                                                                   OFFBOX_TEST_READY_TIMEOUT='1' if timeout else ''))
            self.addCleanup(self.stop, proc)
            self.until(lambda: (root / 'handoff').exists(), proc)
            child = int((root / 'handoff').read_text())
            self.addCleanup(self.stop_child, child, proc.pid)
            os.killpg(proc.pid, signal.SIGINT)
            if timeout:
                # Keep readiness blocked until the original deadline fences the transferred worker.
                proc.communicate(timeout=5)
                row = self.con.execute('SELECT status,exit_code FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
                self.assertEqual(tuple(row), ('local_error', common.EXIT_LOCAL))
                self.assertFalse(misc._client_alive(child, None))
                self.assertFalse((root / 'starts').exists())
                return
        if masked:
            self.until(lambda: (root / 'returned').exists(), proc)
            self.until(lambda: (root / 'caller-interrupted').exists(), proc)
            self.assertEqual((root / 'caller-interrupted').read_text(), '1')
            self.assertEqual((root / 'mask-restored').read_text(), 'True')
            self.assertEqual((root / 'returned').read_text(), '0')
        else:
            proc.communicate(timeout=5)
            self.assertNotEqual(proc.returncode, 0)
        row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
        self.assertNotEqual(row['status'], 'local_error')
        self.until(lambda: (root / 'ttl').exists())
        self.assertEqual((root / 'starts').read_text().splitlines(), [row['run_id']])

    def test_partial_payload_then_caller_sigkill_has_a_proven_dead_client(self):
        root = Path(self.tmp.name)
        entry = root / 'bootstrap.py'
        entry.write_text('import json,sys,time\nfrom pathlib import Path\n'
                         'data=sys.stdin.buffer.read(16)\n'
                         f'Path({str(root / "partial")!r}).touch()\n'
                         f'while not Path({str(root / "release-partial")!r}).exists(): time.sleep(.01)\n'
                         'json.loads(data+sys.stdin.buffer.read())\n')
        proc = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()), '--fixture',
                                 self.tmp.name, '1', 'boat'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True, env=dict(os.environ, OFFBOX_TEST_ENTRY=str(entry)))
        self.addCleanup(self.stop, proc)
        self.until(lambda: (root / 'partial').exists(), proc)
        row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
        self.assertIsNotNone(row['client_pid'])
        self.assertNotEqual(row['client_pid'], proc.pid)
        self.addCleanup(self.stop_child, row['client_pid'], proc.pid)
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate(timeout=5)
        (root / 'release-partial').touch()
        self.until(lambda: not misc._client_alive(row['client_pid'], row['start_at']))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(misc.wait(row['run_id'], 1), common.EXIT_NOT_STARTED)
        self.assertFalse((root / 'starts').exists())


class NeverStartedTests(Isolated):
    def test_empty_client_log_does_not_guess_caller_interruption(self):
        self.con.execute("INSERT INTO runs(run_id,mode,status) VALUES ('run-empty-client','bg','lost')")
        (misc.LOGS_DIR / 'run-empty-client.client.log').touch()
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(misc.wait('run-empty-client', 1), common.EXIT_NOT_STARTED)
        self.assertNotIn('caller interrupted?', err.getvalue())

    def test_client_diagnostics_tail_precedes_any_step_history_recovery(self):
        self.con.execute("INSERT INTO runs(run_id,mode,status,error,step_count) VALUES "
                         "('run-crash','bg','lost','client ended before it got a box',2)")
        (misc.LOGS_DIR / 'run-crash.client.log').write_text(''.join(f'crash line {i}\n' for i in range(30)))
        for command in (lambda: misc.wait('run-crash', 1), lambda: misc.logs('run-crash', False),
                        lambda: misc.logs('run-crash', True)):
            with contextlib.redirect_stderr(io.StringIO()) as err, \
                    patch.object(misc, '_catch_up_log', side_effect=AssertionError('never started')):
                self.assertEqual(command(), common.EXIT_NOT_STARTED)
                self.assertIn('nothing ran, safe to rerun', err.getvalue())
                self.assertNotIn('caller interrupted?', err.getvalue())
                self.assertNotIn('crash line 9\n', err.getvalue())
                self.assertIn('crash line 10\n', err.getvalue())
                self.assertIn('crash line 29\n', err.getvalue())
                self.assertNotIn('incomplete', err.getvalue())

    def test_wait_and_logs_killed_while_queued_keep_exit_130(self):
        for mode in ('fg', 'bg'):
            for steps in (0, 2):
                self.con.execute('DELETE FROM runs')
                self.con.execute("INSERT INTO runs(run_id,mode,status,exit_code,step_count) "
                                 "VALUES ('run-killed',?,'killed',130,?)", (mode, steps))
                path = misc.LOGS_DIR / 'run-killed.log'
                path.touch()
                for command in (lambda: misc.wait('run-killed', 1), lambda: misc.logs('run-killed', False),
                                lambda: misc.logs('run-killed', True)):
                    with self.subTest(mode=mode, steps=steps, command=command), \
                            contextlib.redirect_stdout(io.StringIO()) as out, \
                            contextlib.redirect_stderr(io.StringIO()) as err, \
                            patch.object(misc, '_catch_up_log', side_effect=AssertionError('nothing ran')):
                        self.assertEqual(command(), 130)
                        self.assertIn('killed while queued; never started; nothing ran, safe to rerun', err.getvalue())
                        self.assertEqual(len(err.getvalue().splitlines()), 1)
                        self.assertEqual(out.getvalue(), '')
                        self.assertNotIn('incomplete', err.getvalue())
                        self.assertNotIn('history', err.getvalue())
                        self.assertEqual(path.stat().st_size, 0)

    def test_wait_reap_and_kill_ignore_stale_parent_pid_snapshots(self):
        for entry in ('wait', 'reap', 'kill'):
            self.con.execute('DELETE FROM runs')
            self.con.execute("INSERT INTO runs(run_id,mode,status,start_at,client_pid) "
                             "VALUES ('run-race','bg','starting',100,111)")
            def alive(pid, began):
                if pid == 111:
                    self.con.execute("UPDATE runs SET client_pid=222,start_at=200 WHERE run_id='run-race'")
                    return False
                return True
            def kill(pid, signum):
                self.assertEqual(pid, 222)
                self.con.execute("UPDATE runs SET status='killed',exit_code=130 WHERE run_id='run-race'")
            with self.subTest(entry=entry), patch.object(misc, '_client_alive', side_effect=alive), \
                    patch.object(misc, '_pid_started_at', return_value=200), patch.object(misc.os, 'kill', side_effect=kill), \
                    patch.object(api, 'list_boxes', return_value=[]), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                if entry == 'wait':
                    with self.assertRaises(common.OffboxError) as caught:
                        misc.wait('run-race', 0)
                    self.assertEqual(caught.exception.code, common.EXIT_WAIT_TIMEOUT)
                elif entry == 'reap':
                    reap.reap()
                else:
                    self.assertEqual(misc.kill_run('run-race'), 0)
                status = self.con.execute("SELECT status FROM runs WHERE run_id='run-race'").fetchone()[0]
                self.assertEqual(status, 'killed' if entry == 'kill' else 'starting')

    def test_reaper_leaves_live_queued_clients_past_two_hours(self):
        self.con.execute("INSERT INTO runs(run_id,mode,status,start_at,client_pid) "
                         "VALUES ('run-live','bg','starting',?,?)", (common.now() - 3 * 3600, os.getpid()))
        with patch.object(api, 'list_boxes', return_value=[]), patch.object(misc, '_client_alive', return_value=True):
            reap.reap()
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-live'").fetchone()[0], 'starting')

    def test_reaper_still_settles_recent_truly_orphaned_nobox_rows(self):
        self.con.execute("INSERT INTO runs(run_id,mode,status,start_at,client_pid) "
                         "VALUES ('run-orphan','bg','starting',?,999999999)", (common.now(),))
        with patch.object(api, 'list_boxes', return_value=[]), \
                patch.object(misc, '_client_alive', return_value=False), \
                contextlib.redirect_stderr(io.StringIO()):
            reap.reap()
        row = self.con.execute("SELECT status,error FROM runs WHERE run_id='run-orphan'").fetchone()
        self.assertEqual(tuple(row), ('lost', 'client ended before it got a box'))

    def test_wait_and_logs_lost_nobox_matrix(self):
        for mode in ('fg', 'bg'):
            for error in (None, 'client ended before it got a box'):
                for steps in (0, 2):
                    self.con.execute('DELETE FROM runs')
                    self.con.execute("INSERT INTO runs(run_id,mode,status,error,step_count) VALUES ('run-x',?,'lost',?,?)",
                                     (mode, error, steps))
                    for command in (lambda: misc.wait('run-x', 1), lambda: misc.logs('run-x', False),
                                    lambda: misc.logs('run-x', True)):
                        with self.subTest(mode=mode, error=error, steps=steps, command=command), \
                                contextlib.redirect_stdout(io.StringIO()) as out, \
                                contextlib.redirect_stderr(io.StringIO()) as err, \
                                patch.object(misc, '_catch_up_log', side_effect=AssertionError('nothing to fetch')):
                            self.assertEqual(command(), common.EXIT_NOT_STARTED)
                            self.assertIn('never started: the offbox client that queued it ended before it got a box', err.getvalue())
                            self.assertIn('nothing ran, safe to rerun', err.getvalue())
                            self.assertNotIn('exit=None', out.getvalue())
                            self.assertNotIn('incomplete', err.getvalue())

    def test_started_and_local_losses_are_not_classified_as_nobox(self):
        row = dict(mode='bg', status='lost', exit_code=None, error=None, box_id='box', process_id=42)
        self.assertFalse(misc._never_started(row))
        self.assertFalse(misc._never_started(dict(row, mode='local', box_id=None, process_id=None)))
        self.assertFalse(misc._never_started(dict(row, box_id=None, process_id=None, exit_code=7)))
        for box, pid in (('box', 42), ('box', None), (None, 42)):
            self.assertFalse(misc._never_started(dict(row, status='killed', box_id=box, process_id=pid, exit_code=130)))
        self.assertFalse(misc._never_started(dict(row, mode='local', status='killed', box_id=None, process_id=None)))


class BackgroundRetryTests(Isolated):
    def test_accepted_start_is_never_retried(self):
        a = cli.build_parser().parse_args(['run', '--bg', '--', 'proof'])
        a.steps = []
        def start(runner):
            runner.register_pending()
            runner.started, runner.box = True, 'box'
            runner.record(box_id='box')
            raise common.OffboxError('start outcome unknown', outage=True, started=True)
        with patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: 'run-accepted'}), \
                patch.object(runs.Runner, 'start', start), patch.object(home, 'may_fail_over', return_value=False), \
                patch.object(home, 'active', return_value=False), patch.object(home, 'on_standby', return_value=False), \
                patch.object(outage, 'wait_until_up') as retry, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(runs.background_client(a, self.me), common.EXIT_INFRA)
        retry.assert_not_called()
        row = self.con.execute("SELECT status,box_id FROM runs WHERE run_id='run-accepted'").fetchone()
        self.assertEqual(tuple(row), ('starting', 'box'))

    def test_signal_during_startup_retry_wait_still_cancels(self):
        a = cli.build_parser().parse_args(['run', '--bg', '--', 'proof'])
        a.steps = []
        def start(runner):
            runner.register_pending()
            raise common.OffboxError('origin unavailable', outage=True)
        with patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: 'run-retry-kill'}), \
                patch.object(runs.Runner, 'start', start), patch.object(home, 'may_fail_over', return_value=False), \
                patch.object(home, 'active', return_value=False), patch.object(home, 'on_standby', return_value=False), \
                patch.object(outage, 'wait_until_up', side_effect=lambda *args: os.kill(os.getpid(), signal.SIGTERM)), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(runs.background_client(a, self.me), 130)
        row = self.con.execute("SELECT status FROM runs WHERE run_id='run-retry-kill'").fetchone()
        self.assertEqual(row[0], 'killed')

    def test_outage_and_capacity_retries_keep_the_published_id(self):
        for failure in (common.OffboxError('origin unavailable', outage=True), api.BoatAtCapacity()):
            self.con.execute('DELETE FROM runs')
            self.con.execute('DELETE FROM kv')
            attempts = []
            a = cli.build_parser().parse_args(['run', '--bg', '--', 'proof'])
            a.steps = []
            def start(runner):
                runner.register_pending()
                attempts.append(runner.run_id)
                if len(attempts) == 1:
                    raise failure
                runner.box, runner.pid, runner.started = 'box', 42, True
                runner.record(box_id='box', process_id=42, status='running')
            def waiting(*args):
                row = self.con.execute("SELECT * FROM runs WHERE run_id='run-retry'").fetchone()
                self.assertEqual((row['status'], row['box_id']), ('starting', None))
                return True
            with self.subTest(failure=type(failure).__name__), \
                    patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: 'run-retry'}), \
                    patch.object(runs.Runner, 'start', start), patch.object(home, 'may_fail_over', return_value=False), \
                    patch.object(home, 'active', return_value=False), patch.object(home, 'on_standby', return_value=False), \
                    patch.object(outage, 'wait_until_up', side_effect=waiting) as retry, \
                    patch.object(outage, 'wait_for_capacity', side_effect=lambda *a: (waiting(), None)) as capacity_retry, \
                    patch.object(outage, 'CAPACITY_RETRY_S', 0), patch.object(api, 'get', return_value={'state': 'running'}), \
                    patch.object(lease, 'ensure_ttl'), contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(runs.background_client(a, self.me), 0)
            self.assertEqual(attempts, ['run-retry', 'run-retry'])
            self.assertEqual(retry.call_count + capacity_retry.call_count, 1)

    def test_forwarded_id_stays_selectable_and_existing_readers_follow_it(self):
        boat_path = Path(self.tmp.name) / 'boat.sqlite'
        self.con.execute("INSERT INTO runs(run_id,owner,mode,status,start_at,client_pid) "
                         "VALUES ('run-forward','worker','bg','starting',?,?)", (common.now(), os.getpid()))
        with patch.object(common, 'db_path_for', return_value=boat_path):
            home._forward_background('run-forward')
            self.assertTrue(common._known('boat', 'run-forward', suffix=False))
            self.assertFalse(common._known('boat', 'forward', suffix=False))
            self.assertTrue(common._known('boat', 'forward', suffix=True))
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='run-forward'").fetchone()[0], 'forwarded')
        with patch.object(common, 'db_path_for', return_value=common.DB_PATH):
            self.assertFalse(common._known('server', 'run-forward', suffix=False))
            self.assertFalse(common._known('server', 'forward', suffix=True))
        with patch.object(misc.subprocess, 'call', return_value=7) as forward, \
                patch.object(runs, 'restore_run_state', side_effect=AssertionError('receipt belongs to Boat')):
            self.assertEqual(misc.wait('run-forward', 3), 7)
            self.assertIn('--timeout', forward.call_args.args[0])
            self.assertEqual(forward.call_args.kwargs['env']['OFFBOX_BACKEND'], 'boat')
            self.assertEqual(misc.logs('run-forward', True), 7)
            self.assertIn('--follow', forward.call_args.args[0])
            row = misc._run_row('run-forward')
            self.assertEqual(misc._settled(row, echo=True), 7)
            self.assertEqual(forward.call_args.args[0][-3:], ['logs', 'run-forward', '--follow'])
            self.assertEqual(misc.kill_run('run-forward'), 7)
            self.assertEqual(forward.call_args.args[0][-2:], ['kill', 'run-forward'])


class BackgroundFailoverTests(Isolated):
    guard_home_failover = False

    def test_both_backends_down_keeps_detached_run_pending_on_home_with_same_id(self):
        a = cli.build_parser().parse_args(['run', '--bg', '--', 'proof'])
        a.steps = []
        a.argv = ['run', '--bg', '--', 'proof']
        attempts = []
        def start(runner):
            runner.register_pending()
            attempts.append(runner.run_id)
            if len(attempts) == 1:
                raise api.ApiError(503, 'server_not_ready', 'waiting for home')
            runner.box, runner.pid, runner.started = 'home-box', 42, True
            runner.record(box_id='home-box', process_id=42, status='running')
        def waiting(*args):
            row = self.con.execute("SELECT * FROM runs WHERE run_id='run-stays-home'").fetchone()
            self.assertEqual((row['status'], row['box_id'], row['process_id']), ('starting', None, None))
            self.assertEqual(os.environ[runs.BACKGROUND_RUN_ENV], 'run-stays-home')
            self.assertEqual(common.backend(), 'server')
            forward.assert_not_called()
            execute.assert_not_called()
            return True
        def probe(name, timeout):
            return 'no answer' if name == 'boat' else None
        with patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: 'run-stays-home'}), \
                patch.object(common, '_BACKEND', 'server'), patch.object(api, 'BACKEND', 'server'), \
                patch.object(home, 'may_fail_over', return_value=True), patch.object(home, 'active', return_value=True), \
                patch.object(common, 'person', return_value=None), patch.object(home, 'probe', return_value=None), \
                patch.object(api, 'probe_backend', side_effect=probe) as probes, \
                patch.object(home, '_forward_background') as forward, patch.object(os, 'execve') as execute, \
                patch.object(runs.Runner, 'start', start), patch.object(outage, 'wait_until_up', side_effect=waiting) as wait, \
                patch.object(api, 'get', return_value={'state': 'running'}), patch.object(lease, 'ensure_ttl'), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(runs.background_client(a, self.me), 0)
        self.assertEqual(attempts, ['run-stays-home', 'run-stays-home'])
        self.assertEqual([call.args[0] for call in probes.call_args_list], ['server', 'boat'])
        wait.assert_called_once()
        forward.assert_not_called()
        execute.assert_not_called()
        self.assertIn("Boat's API is unavailable too; keeping this run on home", err.getvalue())
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM runs').fetchone()[0], 1)

    def test_forwarding_happens_only_after_boat_answers(self):
        class Moved(Exception):
            pass
        for index, answer in enumerate((None, 'no answer', 'HTTP 503')):
            rid = f'run-probe-{index}'
            self.con.execute("INSERT INTO runs(run_id,owner,mode,status,start_at,client_pid) "
                             "VALUES (?,'worker','bg','starting',?,?)", (rid, common.now(), os.getpid()))
            moved = []
            def forward(run):
                self.assertEqual(probe.call_count, 1)
                moved.append(('forward', run))
            def execute(*args):
                self.assertEqual(moved, [('forward', rid)])
                raise Moved()
            with self.subTest(answer=answer), patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: rid}), \
                    patch.object(api, 'probe_backend', return_value=answer) as probe, \
                    patch.object(home, 'record_failure') as record, \
                    patch.object(home, '_forward_background', side_effect=forward) as forwarded, \
                    patch.object(runs, 'forward_background', side_effect=execute) as executed, \
                    patch.object(os, 'execve', side_effect=AssertionError('background argv must stay private')), \
                    contextlib.redirect_stderr(io.StringIO()):
                if answer is None:
                    with self.assertRaises(Moved):
                        home.fail_over('home unavailable', ['run', '--bg', '--', 'proof'], rid)
                    forwarded.assert_called_once_with(rid)
                    executed.assert_called_once()
                else:
                    self.assertFalse(home.fail_over('home unavailable', ['run', '--bg', '--', 'proof'], rid))
                    forwarded.assert_not_called()
                    executed.assert_not_called()
                    row = self.con.execute('SELECT status FROM runs WHERE run_id=?', (rid,)).fetchone()
                    self.assertEqual(row[0], 'starting')
                probe.assert_called_once_with('boat', home.PROBE_TIMEOUT_S)
                record.assert_called_once_with('home unavailable', rid, base=None, base_kept=False)

    def test_exact_and_suffix_lookup_both_filter_forwarded_rows(self):
        for status in ('starting', 'forwarded', None):
            self.con.execute('DELETE FROM runs')
            self.con.execute("INSERT INTO runs(run_id,mode,status) VALUES ('run-routing','bg',?)", (status,))
            for ident, suffix, match in (('run-routing', False, True), ('run-routing', True, True),
                                         ('routing', False, False), ('routing', True, True),
                                         ('missing', False, False), ('missing', True, False)):
                with self.subTest(status=status, ident=ident, suffix=suffix), \
                        patch.object(common, 'db_path_for', return_value=common.DB_PATH):
                    self.assertEqual(common._known('server', ident, suffix=suffix), match and status != 'forwarded')


if __name__ == '__main__' and len(sys.argv) > 1:
    if sys.argv[1] == '--fixture':
        fixture(Path(sys.argv[2]), bool(int(sys.argv[3])), sys.argv[4])
    elif sys.argv[1] == '_bg-queue':
        faulthandler.enable(file=sys.stderr, all_threads=True)
        payload = json.load(sys.stdin)
        os.environ.clear()
        os.environ.update(payload['env'])
        root = Path(os.environ['OFFBOX_TEST_ROOT'])
        configure_fixture(root, payload['backend'])
        if os.environ.get('OFFBOX_TEST_HANDOFF'):
            (root / 'handoff').write_text(str(os.getpid()))
            with common.file_lock('fixture-handoff', timeout=15):
                pass
        sys.exit(runs.background_queue(sys.argv[2], payload))
