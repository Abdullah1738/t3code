"""Queued background clients use a real session/process boundary; all box operations are fake."""
import contextlib
import io
import json
import faulthandler
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.environ.get('OFFBOX_TEST_SCRIPTS', str(Path(__file__).resolve().parents[1])))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, cli, common, fallback, home, lease, misc, outage, pool, reap, runs
from test_capacity import Isolated


def _publish(path, text):
    pending = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    pending.write_text(text)
    os.replace(pending, path)


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
                        template=None, base=None, fresh=False, git=False, no_fallback=True, remote=True)
    if os.environ.get('OFFBOX_TEST_ENTRY'):
        a.cmd = ['proof' + 'x' * 300000]
    pool.release_guard = lambda row: None
    lease.ensure_ttl = lambda *args: _publish(root / 'ttl', 'extended')
    api.get = lambda *args: {'state': 'running'}
    lease.touch = lease.idle_ttl = lambda *args: None
    if os.environ.get('OFFBOX_TEST_REQUESTED_SIZE'):
        a.size = os.environ['OFFBOX_TEST_REQUESTED_SIZE']
        a.cmd = ['true']
        if sys.argv[1:2] == ['_bg-queue']:
            lease.auto_size = lambda *args: (_ for _ in ()).throw(AssertionError('child recomputed size'))
    else:
        lease.auto_size = lambda *args: ('large', '')
    runs.Runner._log_pool = lambda *args: None
    runs.Runner._prepare_box = lambda *args: None
    if os.environ.get('OFFBOX_TEST_PREPARE_HOLD'):
        def prepare(*args):
            _publish(root / 'preparing', str(os.getpid()))
            with common.file_lock('fixture-prepare', timeout=15):
                pass
        runs.Runner._prepare_box = prepare
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
        if os.environ.get('OFFBOX_TEST_REQUESTED_SIZE'):
            _publish(root / 'acquired-size', kwargs['size'])
        _publish(root / 'waiting', str(os.getpid()))
        with common.file_lock('fixture-slot', timeout=15):
            outcome = os.environ.get('OFFBOX_TEST_QUEUE_OUTCOME')
            if outcome == 'exception':
                raise ValueError('fixture queue exception')
            if outcome == 'limit':
                raise pool.PoolBusyError('fixture queue limit; nothing ran', queue_expired=True)
            if outcome == 'caller':
                runs.identity.require_proven(dict(proven=False, driver='codex', resolution='unavailable',
                                                 lookupError='fixture endpoint down'), 'run')
            if outcome == 'settled':
                with contextlib.closing(common.db()) as con:
                    con.execute("UPDATE runs SET status='killed',exit_code=130 WHERE run_id=?", (kwargs['run_id'],))
            return dict(box_id='box-fake', size=kwargs.get('size') or 'large', remote_dir='repo')

    def start(box, command, *, meta, **kwargs):
        with (root / 'starts').open('a') as stream:
            stream.write(meta['run_id'] + '\n')
        return dict(processId=42, commandId='cmd-fake')

    def attach(box, pid, out, err, **kwargs):
        output = 'background output\n'
        rid = os.environ[runs.BACKGROUND_RUN_ENV]
        with contextlib.closing(common.db()) as con:
            row = con.execute('SELECT protocol_nonce FROM runs WHERE run_id=?', (rid,)).fetchone()
        marker = f'{runs.COMMAND_STARTED_MARKER} {rid} [n={row[0]}]\n'
        if err < len(marker):
            yield dict(type='stderr', data=marker[err:], nextOffset=len(marker))
        if out < len(output):
            yield dict(type='stdout', data=output[out:], nextOffset=len(output))
        _publish(root / 'following', str(os.getpid()))
        if os.environ.get('OFFBOX_TEST_FINITE'):
            yield dict(type='exit', exitCode=0)
            return
        while True:
            signal.pause()

    pool.acquire = acquire
    api.cmd_start = start
    api.cmd_attach = attach
    if os.environ.get('OFFBOX_TEST_FINITE'):
        api.history_logs = lambda box, command, which, offset=0, **kw: dict(data='', nextOffset=offset, done=True, size=offset)
        api.history_get = lambda *args: dict(status='exited', exitCode=0)
    if os.environ.get('OFFBOX_TEST_HTTP_URL'):
        api.API = os.environ['OFFBOX_TEST_HTTP_URL']
        api._key = lambda: 'fixture'
        api._own_box = lambda *args: None
        api.cmd_attach = lambda box, pid, out, err, **kw: api.stream(
            f'/sandboxes/{box}/commands/{pid}/stream?stdoutOffset={out}&stderrOffset={err}', **kw)
    runs._ttl_keeper = lambda *args: None
    return a, me


def fixture(root, bg, backend):
    a, me = configure_fixture(root, backend)
    a.bg = bg
    if os.environ.get('OFFBOX_TEST_THREADED_CALLER'):
        threading.Thread(target=threading.Event().wait, daemon=True).start()
    masked = bool(os.environ.get('OFFBOX_TEST_MASKED_MAIN'))
    if masked:
        interruptions = 0
        def interrupted(signum, frame):
            nonlocal interruptions
            interruptions += 1
            _publish(root / 'caller-interrupted', str(interruptions))
        signal.signal(signal.SIGINT, interrupted)
        signal.pthread_sigmask(signal.SIG_BLOCK, (signal.SIGINT,))
    if os.environ.get('OFFBOX_TEST_READY_TIMEOUT'):
        runs.BG_READY_TIMEOUT_S = float(os.environ['OFFBOX_TEST_READY_TIMEOUT'])
    code = runs.run_remote(a, me)
    if masked:
        _publish(root / 'mask-restored', str(signal.SIGINT in signal.pthread_sigmask(signal.SIG_BLOCK, ())))
    _publish(root / 'returned', str(code))
    if os.environ.get('OFFBOX_TEST_RETURN'):
        return
    while True:
        if masked:
            time.sleep(.01)
        else:
            signal.pause()


class BackgroundQueueTests(Isolated):
    def launch(self, *, bg=True, backend='boat', old_registration=False, cleanup=None):
        cleanup = self.addCleanup if cleanup is None else cleanup
        last_row = self.con.execute('SELECT COALESCE(MAX(rowid), 0) FROM runs').fetchone()[0]
        proc = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()), '--fixture',
                                 self.tmp.name, str(int(bg)), backend], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True,
                                env=dict(os.environ, OFFBOX_TEST_OLD_REGISTRATION='1' if old_registration else ''))
        cleanup(self.stop_fixture, proc, last_row)
        self.until(lambda: (Path(self.tmp.name) / ('returned' if bg else 'waiting')).exists(), proc)
        row = self.con.execute('SELECT * FROM runs ORDER BY start_at DESC LIMIT 1').fetchone()
        self.assertIsNotNone(row)
        if bg:
            self.assertEqual((Path(self.tmp.name) / 'returned').read_text(), '0')
        return proc, dict(row)

    def stop_fixture(self, proc, last_row):
        try:
            self.stop(proc)
        finally:
            # launch() can fail before reading the row; stop the caller before looking up its detached child.
            rows = self.con.execute('SELECT client_pid FROM runs WHERE rowid > ?', (last_row,)).fetchall()
            for row in rows:
                self.stop_child(row['client_pid'], proc.pid)

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
                if sig == signal.SIGTERM:
                    # New background clients accept pre-start cancellation only from offbox kill.
                    with contextlib.closing(common.db()) as con:
                        row = con.execute('SELECT * FROM runs WHERE client_pid=? ORDER BY rowid DESC LIMIT 1',
                                          (pid,)).fetchone()
                    if row and row['status'] in ('starting', 'running') and not row['process_id']:
                        from offbox_lib import bg_cancel
                        bg_cancel.request(row)
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
                             for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM, signal.SIGKILL)):
            with self.subTest(backend=backend, signal=sig), contextlib.ExitStack() as cleanup:
                root = Path(self.tmp.name)
                for name in ('returned', 'waiting', 'starts', 'ttl', 'following'):
                    (root / name).unlink(missing_ok=True)
                with common.file_lock('fixture-slot'):
                    proc, row = self.launch(backend=backend, cleanup=cleanup.callback)
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
                    self.assertIn(f"Hand off `offbox wait {row['run_id']}` using the remote-compute skill’s Waiting for a run route, "
                                  "then end your turn; completion wakes you.", err.decode())
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

    def test_detached_client_keeps_writing_after_returning_the_run_id(self):
        for backend in ('boat', 'server'):
            with self.subTest(backend=backend), contextlib.ExitStack() as cleanup:
                root = Path(self.tmp.name)
                for name in ('returned', 'waiting', 'starts', 'ttl', 'following'):
                    (root / name).unlink(missing_ok=True)
                proc, row = self.launch(backend=backend, cleanup=cleanup.callback)
                os.killpg(proc.pid, signal.SIGKILL)
                proc.communicate(timeout=5)
                self.until(lambda: (root / 'following').exists())
                self.assertEqual(int((root / 'following').read_text()), row['client_pid'])
                path = root / 'LOGS_DIR' / f"{row['run_id']}.log"
                marker = f"{runs.COMMAND_STARTED_MARKER} {row['run_id']} [n={row['protocol_nonce']}]\n"
                self.assertEqual(path.read_text(), marker + 'background output\n')
                self.assertEqual(common.checkpoint(path), dict(stdoutOffset=18, stderrOffset=len(marker), logBytes=18 + len(marker)))
                self.assertTrue(misc._client_alive(row['client_pid'], row['start_at']))
                current = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
                self.assertEqual(tuple(current), ('running', None))

    def test_detached_queue_admission_recovers_silent_http_and_resumes_both_backends(self):
        for backend in ('boat', 'server'):
            for first in ('stdout', 'stderr'):
                with self.subTest(backend=backend, first=first), contextlib.ExitStack() as cleanup:
                    root = Path(self.tmp.name)
                    for name in ('returned', 'waiting', 'starts', 'ttl', 'following'):
                        (root / name).unlink(missing_ok=True)
                    attached, produced, resumed, close = threading.Event(), threading.Event(), threading.Event(), threading.Event()
                    release_history = threading.Event()
                    cleanup.callback(close.set)
                    cleanup.callback(release_history.set)
                    queue, live, resume = 'queued\n', 'admitted output\n', 'resumed output\n'
                    requests = []
                    class Handler(BaseHTTPRequestHandler):
                        def log_message(self, *args):
                            pass
                        def do_GET(self):
                            parsed = urlparse(self.path)
                            query = parse_qs(parsed.query)
                            requests.append((parsed.path, query))
                            try:
                                if '/command-history/' in parsed.path and query['stream'][0] != first:
                                    if not release_history.wait(10):
                                        return
                                self.send_response(200)
                                self.send_header('Content-Type', 'application/json')
                                self.end_headers()
                                if parsed.path.endswith('/stream'):
                                    out, err = int(query['stdoutOffset'][0]), int(query['stderrOffset'][0])
                                    frames = [dict(type='hello')]
                                    if not err:
                                        frames.append(dict(type='stderr', data=queue, nextOffset=len(queue)))
                                    if attached.is_set():
                                        resumed.set()
                                        # Admission may return on stderr before the stdout history page is consumed.
                                        data = (live + resume)[out:]
                                        frames.append(dict(type='stdout', data=data, nextOffset=len(live + resume)))
                                    for frame in frames:
                                        self.wfile.write((json.dumps(frame) + '\n').encode())
                                        self.wfile.flush()
                                    attached.set()
                                    close.wait(15)
                                    return
                                if '/command-history/' in parsed.path:
                                    stream, offset = query['stream'][0], int(query['offset'][0])
                                    marker = f"{runs.COMMAND_STARTED_MARKER} {row['run_id']} [n={row['protocol_nonce']}]\n" if produced.is_set() else ''
                                    data = ((live + resume if resumed.is_set() else live) if produced.is_set() else '') if stream == 'stdout' else queue + marker
                                    page = dict(data=data[offset:], nextOffset=len(data), size=len(data), done=False)
                                else:
                                    page = dict(status='running', running=True)
                                self.wfile.write(json.dumps(page).encode())
                            except (BrokenPipeError, ConnectionResetError):
                                pass
                    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
                    cleanup.callback(server.server_close)
                    cleanup.callback(server.shutdown)
                    serving = threading.Thread(target=server.serve_forever, daemon=True)
                    serving.start()
                    with patch.dict(os.environ, OFFBOX_TEST_HTTP_URL=f'http://127.0.0.1:{server.server_port}'):
                        with common.file_lock('fixture-slot'):
                            proc, row = self.launch(backend=backend, cleanup=cleanup.callback)
                            os.killpg(proc.pid, signal.SIGKILL)
                            proc.communicate(timeout=5)
                        self.assertTrue(attached.wait(5))
                        began = time.monotonic()
                        produced.set()
                        path = root / 'LOGS_DIR' / f"{row['run_id']}.log"
                        marker = f"{runs.COMMAND_STARTED_MARKER} {row['run_id']} [n={row['protocol_nonce']}]\n"
                        prefix = (queue + (live if first == 'stdout' else marker)).encode()
                        self.until(lambda: path.exists() and path.read_bytes().startswith(prefix))
                        release_history.set()
                        expected = (queue + live + marker + resume if first == 'stdout' else queue + marker + live + resume).encode()
                        committed = dict(stdoutOffset=len(live + resume), stderrOffset=len(queue + marker), logBytes=len(expected))
                        # Log flush precedes checkpoint commit; synchronize on the durable record.
                        self.until(lambda: common.checkpoint(path) == committed)
                        self.assertEqual(path.read_bytes(), expected)
                        elapsed = time.monotonic() - began
                        self.assertLess(elapsed, 10)
                        self.assertEqual(common.checkpoint(path), committed)
                        self.assertTrue(misc._client_alive(row['client_pid'], row['start_at']))
                        streams = [q for p, q in requests if p.endswith('/stream')]
                        self.assertEqual((int(streams[-1]['stdoutOffset'][0]), int(streams[-1]['stderrOffset'][0])),
                                         (len(live) if first == 'stdout' else 0, len(queue + marker)))
                        histories = [q for p, q in requests if '/command-history/' in p]
                        self.assertTrue(histories)
                        self.assertTrue(all(('limitBytes' in query) == (backend == 'server') for query in histories))
                        events = (root / 'LOGS_DIR' / f"{row['run_id']}.client.log").read_text()
                        self.assertIn('"event":"stream_silent"', events)
                        print(f'live HTTP recovery backend={backend} first={first} seconds={elapsed:.3f} bytes={len(expected)}', flush=True)

    def test_kill_queued_run_stops_detached_client(self):
        with common.file_lock('fixture-slot'):
            proc, row = self.launch()
            self.until(lambda: (Path(self.tmp.name) / 'waiting').exists(), proc)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(misc.kill_run(row['run_id']), 0)
            current = self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
            self.assertEqual(tuple(current), ('killed', 130))
        self.assertFalse((Path(self.tmp.name) / 'starts').exists())

    def test_unrequested_signals_preserve_queue_identity_and_start_once(self):
        for backend in ('boat', 'server'):
            with self.subTest(backend=backend), contextlib.ExitStack() as cleanup:
                root = Path(self.tmp.name)
                for name in ('returned', 'waiting', 'starts', 'ttl'):
                    (root / name).unlink(missing_ok=True)
                with common.file_lock('fixture-slot'):
                    proc, row = self.launch(backend=backend, cleanup=cleanup.callback)
                    self.until(lambda: (root / 'waiting').exists(), proc)
                    # End the stand-in caller, then signal its retained child by PID, like Dock's coalition sweep.
                    self.stop(proc)
                    path = root / 'LOGS_DIR' / f"{row['run_id']}.client.log"
                    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                        os.kill(row['client_pid'], sig)
                        self.until(lambda: f'"reason":"{signal.Signals(sig).name}"' in path.read_text())
                        self.assertIn('"disposition":"ignored"', path.read_text())
                        current = dict(self.con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone())
                        self.assertEqual((current['client_pid'], current['start_at'], current['status'], current['box_id']),
                                         (row['client_pid'], row['start_at'], 'starting', None))
                        self.assertTrue(misc._client_alive(row['client_pid'], row['start_at']))
                    self.assertFalse((root / 'starts').exists())
                self.until(lambda: (root / 'ttl').exists())
                self.assertEqual((root / 'starts').read_text().splitlines(), [row['run_id']])

    def test_full_observed_coalition_sweep_then_wait_exits_zero(self):
        for backend in ('boat', 'server'):
            with self.subTest(backend=backend), contextlib.ExitStack() as cleanup, \
                    patch.dict(os.environ, OFFBOX_TEST_FINITE='1'):
                root = Path(self.tmp.name)
                for name in ('returned', 'waiting', 'starts', 'ttl', 'following'):
                    (root / name).unlink(missing_ok=True)
                with common.file_lock('fixture-slot'):
                    proc, row = self.launch(backend=backend, cleanup=cleanup.callback)
                    self.until(lambda: (root / 'waiting').exists(), proc)
                    # Dock enumerates once and TERM-signals each retained coalition member.
                    # Its KILL fallback targets the main application only, not these members.
                    self.stop(proc)
                    self.assertEqual(os.getsid(row['client_pid']), row['client_pid'])
                    os.kill(row['client_pid'], signal.SIGTERM)
                    path = root / 'LOGS_DIR' / f"{row['run_id']}.client.log"
                    self.until(lambda: '"disposition":"ignored"' in path.read_text())
                    self.assertTrue(misc._client_alive(row['client_pid'], row['start_at']))
                    self.assertFalse((root / 'starts').exists())
                self.until(lambda: self.con.execute('SELECT status FROM runs WHERE run_id=?',
                                                   (row['run_id'],)).fetchone()[0] == 'done')
                self.assertEqual((root / 'starts').read_text().splitlines(), [row['run_id']])
                with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()), \
                        patch.object(api, 'history_logs', side_effect=lambda box, cmd, which, offset=0, **kw:
                                     dict(data='', nextOffset=offset, done=True, size=offset)), \
                        patch.object(api, 'history_get', return_value=dict(status='exited', exitCode=0)):
                    self.assertEqual(misc.wait(row['run_id'], 1, summary=True), 0)
                self.assertIn('background output', out.getvalue())

    def test_unrequested_term_after_box_selection_does_not_cancel_preparation(self):
        root = Path(self.tmp.name)
        with patch.dict(os.environ, OFFBOX_TEST_PREPARE_HOLD='1'), common.file_lock('fixture-prepare'):
            proc, row = self.launch()
            self.until(lambda: (root / 'preparing').exists(), proc)
            current = self.con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
            self.assertEqual((current['box_id'], current['process_id']), ('box-fake', None))
            os.kill(row['client_pid'], signal.SIGTERM)
            path = root / 'LOGS_DIR' / f"{row['run_id']}.client.log"
            self.until(lambda: '"disposition":"ignored"' in path.read_text())
            self.assertFalse((root / 'starts').exists())
        self.until(lambda: (root / 'ttl').exists())
        self.assertEqual((root / 'starts').read_text().splitlines(), [row['run_id']])

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
    def infra_row(self, *, error, exit_code=None, steps=0, **fields):
        row = dict(run_id='run-refused', mode='bg', status='infra', error=error,
                   exit_code=exit_code, step_count=steps)
        row.update(fields)
        self.con.execute('DELETE FROM runs')
        self.con.execute(f"INSERT INTO runs({','.join(row)}) VALUES ({','.join('?' for _ in row)})", tuple(row.values()))
        return self.con.execute('SELECT * FROM runs').fetchone()

    def assert_refusal(self, code, reason, *, safe=True, log_exists=True):
        path = misc.LOGS_DIR / 'run-refused.log'
        if log_exists:
            path.touch()
        else:
            path.unlink(missing_ok=True)
        for command in (lambda: misc.logs('run-refused', False), lambda: misc.logs('run-refused', True),
                        lambda: misc.wait('run-refused', 1)):
            with self.subTest(command=command), contextlib.redirect_stdout(io.StringIO()) as out, \
                    contextlib.redirect_stderr(io.StringIO()) as err, \
                    patch.object(misc, '_catch_up_log', side_effect=AssertionError('nothing to fetch')):
                self.assertEqual(command(), code)
                text = err.getvalue()
                self.assertIn('never started: ' + reason, text)
                self.assertEqual('nothing ran, safe to rerun' in text, safe)
                for forbidden in ('server history is unavailable', 'steps incomplete', 'remote exit unknown'):
                    self.assertNotIn(forbidden, text)
                self.assertEqual(out.getvalue(), '')
                if log_exists:
                    self.assertEqual(path.read_bytes(), b'')
                else:
                    self.assertFalse(path.exists())
        return text

    def test_infra_refusals_keep_reason_exit_and_client_tail(self):
        failover = ('home offbox server not reachable (offbox server API 503 server_not_ready: reconciling); '
                    'this run goes to Boat instead')
        (misc.LOGS_DIR / 'run-refused.client.log').write_text(f'{failover}\nqueue ended with exit 92\n')
        reasons = [
            ('repository pool busy/full; remote queue timed out. Nothing ran (exit 92)', 92, 92),
            ('bx_b5j336sn was resumed but did not become ready; nothing ran: deadline passed', None, 90),
            ('bx_h9e63dqs has an unanswered resume; nothing ran', None, 90),
            ('repository pool busy/full; remote queue timed out. Nothing ran (exit 92): retry, or wait', None, 92),
            ('Nothing ran (exit 92), stored exit takes precedence', 7, 7),
            ('Nothing ran (exit 92), stored exit takes precedence', 0, 0),
            ('box bx_test734f went to error: incus config device set timed out', 90, 90),
        ]
        for error, stored, expected in reasons:
            for steps in (0, 4):
                with self.subTest(error=error, steps=steps):
                    self.infra_row(error=error, exit_code=stored, steps=steps)
                    self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES ('start_claim:run-refused','1')")
                    text = self.assert_refusal(expected, error)
                    self.assertIn(failover, text)
                    self.assertIn('queue ended with exit 92', text)
                    self.assertNotIn('may be incomplete; retry', text)

    def test_foreground_readiness_refusal_with_missing_or_empty_log(self):
        error = ('bx_dy7k32aj was resumed but did not become ready; nothing ran: '
                 'client deadline passed before GET /sandboxes/bx_dy7k32aj')
        for steps in (0, 2):
            for log_exists in (False, True):
                with self.subTest(steps=steps, log_exists=log_exists):
                    self.infra_row(error=error, mode='fg', steps=steps)
                    self.con.execute("INSERT OR REPLACE INTO kv(k,v) VALUES ('start_claim:run-refused','1')")
                    text = self.assert_refusal(90, error, log_exists=log_exists)
                    self.assertNotIn('retry', text.lower())

    def test_exit_two_pool_refusals_keep_their_own_remedy_verbatim(self):
        for backend in ('boat', 'server'):
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, OFFBOX_BACKEND=backend))
                stack.enter_context(patch.object(common, '_BACKEND', backend))
                stack.enter_context(patch.object(common, 'DB_PATH', common.db_path_for(backend)))
                con = stack.enter_context(contextlib.closing(common.db()))
                stack.enter_context(patch.object(self, 'con', con))
                self.assertEqual(Path(con.execute('PRAGMA database_list').fetchone()['file']), common.DB_PATH.resolve())
                for source, count in (('template:generic', '8/8'), ('base:recall-backup', '12/8')):
                    error = (f'pool is full ({count} boxes, none from {source}), so waiting cannot help; '
                             'nothing ran. Run without --base/--template or choose a matching source.')
                    for steps in (0, 2):
                        with self.subTest(backend=backend, source=source, steps=steps):
                            self.infra_row(error=error, exit_code=2, steps=steps)
                            text = self.assert_refusal(2, error, safe=False)
                            self.assertEqual(text.splitlines()[0], f'offbox: run-refused: never started: {error}')
                            self.assertIn('client log ends with no end record', text)
                            self.assertNotIn('retry', text.lower())
                            self.assertNotIn('safe to rerun', text)

    def test_infra_reason_is_one_line_and_at_most_300_characters(self):
        error = 'NOTHING RAN\n' + 'reason ' * 70
        self.infra_row(error=error, exit_code=7)
        reason = ' '.join(error.split())[:300]
        text = self.assert_refusal(7, reason)
        self.assertEqual(text.splitlines()[0], f'offbox: run-refused: never started: {reason}; nothing ran, safe to rerun')
        self.assertIn('client log ends with no end record', text)

    def test_started_local_and_recovery_marked_infra_are_not_never_started(self):
        for error in ('nothing ran', 'box bx_test734f went to error: timed out'):
            for fields, mark in ((dict(command_id='cmd-known'), None), (dict(process_id=42), None),
                                 (dict(mode='local'), None), ({}, 'start_unattached'), ({}, 'start_unknown')):
                with self.subTest(error=error, fields=fields, mark=mark):
                    self.con.execute('DELETE FROM kv')
                    row = self.infra_row(error=error, **fields)
                    if mark:
                        self.con.execute('INSERT INTO kv(k,v) VALUES (?,?)', (mark + ':run-refused', '1'))
                    self.assertFalse(misc._never_started(row))
        self.con.execute('DELETE FROM kv')
        self.assertFalse(misc._never_started(self.infra_row(error='unexplained infrastructure error')))
        self.assertFalse(misc._never_started(self.infra_row(error='box bx_734f went to error: timeout', box_id='bx_734f')))
        self.assertTrue(misc._never_started(self.infra_row(error='nothing ran', box_id='bx_ready_failed')))

    def test_forwarded_logs_and_wait_name_last_move_before_child(self):
        reason = 'offbox server API 503 server_not_ready: reconciling (after start)'
        line = f'home offbox server not reachable ({reason}); this run goes to Boat instead\n'
        path = misc.LOGS_DIR / 'run-refused.client.log'
        variants = [
            ('boat', line, reason),
            ('boat', line + 'unrelated\n' + line.replace(reason, 'last reason'), 'last reason'),
            ('boat', 'offbox: home offbox server is low on disk (100 MiB free); this run is going to Boat\n',
             'low on disk (100 MiB free)'),
            ('boat', 'offbox: home server out of disk; this run is going to Boat\n', 'out of disk'),
            ('boat', 'no routing line\n', '(reason not in the client log)'),
            ('boat', line + 'x' * (64 * 1024), '(reason not in the client log)'),
            ('boat', None, '(reason not in the client log)'),
            ('server', line + 'offbox: home offbox server is back; this run leaves the Boat queue '
             '(waited 12 s, #1 of 2) and goes back to home\n', 'home offbox server is back'),
            ('server', line, '(reason not in the client log)'),
        ]
        for backend, content, expected in variants:
            if content is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(content)
            self.infra_row(error=backend, status='forwarded')
            for command in ('logs', 'follow', 'wait'):
                with self.subTest(backend=backend, content=expected, command=command), \
                        contextlib.redirect_stderr(io.StringIO()) as err, \
                        patch.dict(os.environ, {'OFFBOX_BACKGROUND_RUN': 'old'}):
                    def child(args, *, env):
                        source = 'Boat' if backend == 'server' else 'the home offbox server'
                        self.assertEqual(err.getvalue(), f'offbox: run-refused moved from {source} to {backend}: {expected}\n')
                        self.assertEqual(args[:4], [sys.executable, str(Path(misc.__file__).resolve().parents[1] / 'offbox.py'),
                                                   'wait' if command == 'wait' else 'logs', 'run-refused'])
                        self.assertEqual(env['OFFBOX_BACKEND'], backend)
                        self.assertNotIn('OFFBOX_BACKGROUND_RUN', env)
                        self.assertEqual('--follow' in args, command == 'follow')
                        self.assertEqual('--timeout' in args, command == 'wait')
                        return 92
                    with patch.object(misc.subprocess, 'call', side_effect=child) as forwarded:
                        code = misc.wait('run-refused', 3) if command == 'wait' else misc.logs('run-refused', command == 'follow')
                    self.assertEqual(code, 92)
                    forwarded.assert_called_once()

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
                        self.assertEqual(len(err.getvalue().splitlines()), 2)
                        self.assertIn('client log ends with no end record', err.getvalue())
                        self.assertEqual(out.getvalue(), '')
                        self.assertNotIn('incomplete', err.getvalue())
                        self.assertNotIn('history', err.getvalue())
                        self.assertEqual(path.stat().st_size, 0)

    def test_wait_reap_and_kill_ignore_stale_parent_pid_snapshots(self):
        for entry in ('wait', 'reap', 'kill'):
            self.con.execute('DELETE FROM runs')
            self.con.execute("INSERT INTO runs(run_id,mode,status,start_at,client_pid) "
                             "VALUES ('run-race','bg','starting',100,111)")
            def alive(pid, began, **diagnostics):
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
    def test_prebox_queue_timeout_preserves_exit_in_background_and_foreground(self):
        for bg, steps in ((False, []), (True, []), (False, ['proof', 'proof2']), (True, ['proof', 'proof2'])):
            for code, message, stored in ((92, 'pool busy. Nothing ran (exit 92)', 92),
                                          (90, 'readiness failed; nothing ran', 90),
                                          (90, 'unknown infrastructure failure', None),
                                          (2, "pool is full (12/8 boxes, none from base:recall-backup), "
                                           "so waiting can't help. Nothing ran. Run without --base/--template.", 2),
                                          (2, 'invalid argument', None)):
                self.con.execute('DELETE FROM runs')
                a = cli.build_parser().parse_args(['run', '--no-sync', '--no-fallback', *(['--bg'] if bg else []), '--', 'proof'])
                a.steps = steps
                with self.subTest(bg=bg, steps=steps, code=code, message=message), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: 'run-timeout'} if bg else {}))
                    stack.enter_context(patch.object(runs.Runner, '_log_pool'))
                    stack.enter_context(patch.object(lease, 'auto_size', return_value=('large', '')))
                    stack.enter_context(patch.object(runs, 'remote_script', return_value='proof'))
                    stack.enter_context(patch.object(runs.node_version, 'want', return_value=None))
                    stack.enter_context(patch.object(runs.pnpm_version, 'want', return_value=None))
                    stack.enter_context(patch.object(pool, 'acquire', side_effect=common.OffboxError(message, code=code)))
                    stack.enter_context(patch.object(api, 'cmd_start', side_effect=AssertionError('must not start')))
                    stack.enter_context(patch.object(fallback, 'note_infra_failure'))
                    stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    if bg:
                        self.assertEqual(runs.background_client(a, self.me), code)
                    else:
                        with self.assertRaises(common.OffboxError) as caught:
                            runs._run_attempt(a, self.me)
                        self.assertEqual(caught.exception.code, code)
                row = self.con.execute('SELECT * FROM runs').fetchone()
                self.assertIsNone(row['box_id'])
                self.assertIsNone(row['command_id'])
                self.assertIsNone(row['process_id'])
                self.assertEqual(row['exit_code'], code if bg else stored)
                self.assertEqual(row['status'], 'busy' if not bg and code == 92 else 'infra')
                if stored in (2, 92):
                    for command in (lambda: misc.wait(row['run_id'], 1), lambda: misc.logs(row['run_id'], False)):
                        with contextlib.redirect_stderr(io.StringIO()) as err, \
                                patch.object(misc, '_catch_up_log', side_effect=AssertionError('nothing to fetch')):
                            self.assertEqual(command(), code)
                            self.assertIn('never started: ' + message, err.getvalue())
                            self.assertNotIn('steps incomplete', err.getvalue())
                            if code == 2:
                                self.assertNotIn('safe to rerun', err.getvalue())
                                self.assertNotIn('retry', err.getvalue())

    def test_busy_settlement_with_identity_or_recovery_still_validates_missing_steps(self):
        for field, marker in (('command_id', None), ('process_id', None), ('box_id', None),
                              (None, 'start_unknown'), (None, 'start_unattached')):
            with self.subTest(field=field, marker=marker):
                self.con.execute('DELETE FROM runs')
                self.con.execute('DELETE FROM kv')
                self.con.execute("INSERT INTO runs(run_id,mode,status,step_count,error) "
                                 "VALUES ('run-uncertain','bg','starting',2,'nothing ran')")
                if field:
                    self.con.execute(f'UPDATE runs SET {field}=?', (42 if field == 'process_id' else 'known',))
                if marker:
                    self.con.execute('INSERT INTO kv(k,v) VALUES (?,?)', (marker + ':run-uncertain', '1'))
                with contextlib.redirect_stderr(io.StringIO()), patch.object(misc, '_catch_up_log', return_value='n/a'):
                    self.assertIsNone(runs.finish('run-uncertain', 92, 'busy', catch_up=False, bookkeeping=False))
                row = self.con.execute('SELECT * FROM runs').fetchone()
                self.assertIsNone(row['exit_code'])
                self.assertFalse(misc._never_started(row))

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
                    patch.object(runs.Runner, 'stream', side_effect=lambda **kw: signal.raise_signal(signal.SIGTERM)), \
                    patch.object(lease, 'ensure_ttl'), contextlib.redirect_stdout(io.StringIO()), \
                    patch.object(runs,'follow',return_value=runs._COMMAND_RUNNING), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(runs.background_client(a, self.me), common.EXIT_DETACHED)
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
                patch.object(runs.Runner, 'stream', side_effect=lambda **kw: signal.raise_signal(signal.SIGTERM)), \
                patch.object(runs,'follow',return_value=runs._COMMAND_RUNNING), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(runs.background_client(a, self.me), common.EXIT_DETACHED)
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
            _publish(root / 'handoff', str(os.getpid()))
            with common.file_lock('fixture-handoff', timeout=15):
                pass
        sys.exit(runs.background_queue(sys.argv[2], payload))
