"""Real interpreter/CF/urllib boundary; only the remote box transport is replaced."""
import contextlib
import faulthandler
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.environ.get('OFFBOX_TEST_SCRIPTS', str(SCRIPTS)))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, common, home, misc, pool, runs, ssh_sync
import test_bg_queue_detach as queue_tests
from test_bg_queue_detach import configure_fixture
from test_capacity import Isolated


def setup(root, backend='boat'):
    a, me = configure_fixture(root, backend)
    runs.BG_ENTRY = Path(__file__).resolve()
    a.cmd = ['echo command-private-marker']
    a.env = ['ROUNDTRIP=' + 'env-private-marker' * 20000]
    a.git = os.environ.get('OFFBOX_TEST_GIT') == '1'
    a.no_sync = not a.git
    if os.environ.get('OFFBOX_TEST_FAILOVER'):
        common.db_path_for = lambda name: root / ('db.sqlite' if name == 'server' else 'boat.sqlite')
        common.DB_PATH = common.db_path_for(backend)
        acquire = pool.acquire
        def failover_acquire(*args, **kwargs):
            if backend == 'server':
                home.fail_over('fixture home unavailable', ['run', '--bg', '--env', 'PRIVATE=env-private-marker'])
            return acquire(*args, **kwargs)
        pool.acquire = failover_acquire
        home.record_failure = lambda *args, **kwargs: None
        api.probe_backend = lambda *args: None
    destination = root / 'synced'
    # Exercise the real snapshot and sync orchestration through an isolated local transport.
    def files(box, source, remote, with_git, *args, dirty=None):
        destination.mkdir(exist_ok=True)
        shutil.copy2(source / 'tracked.txt', destination / 'tracked.txt')
        return dict(files=1, sent=1)
    def git(box, gitdir, remote, *args, **kwargs):
        shutil.copytree(gitdir, destination / '.git')
        return dict(files=1, sent=1)
    ssh_sync._push_files, ssh_sync._push_git = files, git
    def ssh(box, command, input=None, timeout=120, check=False):
        assert command.startswith('cd -- ')
        return subprocess.run(['sh', '-c', command.split(' && ', 1)[1]], cwd=destination,
                              input=input, capture_output=True, timeout=timeout, check=check)
    ssh_sync.ssh = ssh
    ssh_sync.put_file = lambda *args, **kwargs: None
    def prepare(self, con, args, rdir, env_file, body):
        self._sync_box(con, args, rdir, env_file, body)
        if args.git:
            source_ref = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD']).decode().strip()
            synced_ref = subprocess.check_output(['git', '-C', str(destination), 'rev-parse', 'HEAD']).decode().strip()
            assert source_ref == synced_ref
            assert (destination / 'tracked.txt').read_text() == 'sync proof\n'
            (root / 'git-ref').write_text(synced_ref)
        # No urllib mocking: this reaches _scproxy on macOS.
        urllib.request.getproxies()
        urllib.request.proxy_bypass('localhost')
        with urllib.request.urlopen(os.environ['OFFBOX_TEST_URL'], timeout=5) as response:
            assert response.read() == b'http proof'
        assert self.a.cmd == ['echo command-private-marker']
        assert self.a.env == ['ROUNDTRIP=' + 'env-private-marker' * 20000]
        assert os.environ['OFFBOX_TEST_SECRET'] == 'process-env-private-marker'
        assert self.me['repo_root'] == str(root)
        assert faulthandler.is_enabled()
        (root / 'http-ok').write_text(str(os.getpid()))
        with common.file_lock('hold-real-child', timeout=20):
            pass
    runs.Runner._prepare_box = prepare
    return a, me


def fixture_main():
    root = Path(sys.argv[2])
    a, me = setup(root, 'server' if os.environ.get('OFFBOX_TEST_FAILOVER') else 'boat')
    if os.environ.get('OFFBOX_TEST_CF'):
        threading.Thread(target=lambda: threading.Event().wait(60), daemon=True).start()
        urllib.request.getproxies()
        urllib.request.proxy_bypass('localhost')
    runs._background(a, me)
    (root / 'returned').write_text('0')


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'http proof')
    def log_message(self, *args):
        pass


class ExecBoundaryTests(Isolated):
    stop = queue_tests.BackgroundQueueTests.stop
    stop_child = queue_tests.BackgroundQueueTests.stop_child
    until = queue_tests.BackgroundQueueTests.until

    def probe(self, git=False, cf=False, failover=False):
        root = Path(self.tmp.name)
        if git:
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'tracked.txt').write_text('sync proof\n')
            subprocess.run(['git', '-C', str(root), 'add', 'tracked.txt'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
                            'commit', '-qm', 'fixture'], check=True)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        env = {k: v for k, v in os.environ.items() if not k.lower().endswith('_proxy')}
        env.update(OFFBOX_TEST_ROOT=str(root), OFFBOX_TEST_CF='1' if cf else '',
                   OFFBOX_TEST_GIT='1' if git else '', OFFBOX_TEST_SECRET='process-env-private-marker',
                   OFFBOX_TEST_FAILOVER='1' if failover else '',
                   OFFBOX_TEST_URL=f'http://127.0.0.1:{server.server_port}/')
        with common.file_lock('hold-real-child'):
            proc = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()), '--fixture', str(root)],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env=env)
            self.addCleanup(self.stop, proc)
            out, err = proc.communicate(timeout=25)
            self.assertEqual(proc.returncode, 0, err.decode())
            rid = out.decode().strip()
            self.assertIn(f"Hand off `offbox wait {rid}` using the remote-compute skill’s Waiting for a run route, "
                          "then end your turn; completion wakes you.", err.decode())
            self.assertNotIn('logs ' + rid + ' --follow', err.decode())
            row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
            self.assertIsNotNone(row)
            self.addCleanup(self.stop_child, row['client_pid'], proc.pid)
            try:
                self.until(lambda: (root / 'http-ok').exists())
            except AssertionError:
                log = root / 'LOGS_DIR' / f'{rid}.client.log'
                self.fail(f'child never reached real HTTP; client_pid={row["client_pid"]}; log={log.read_text()}')
            if failover:
                self.assertEqual(self.con.execute('SELECT status FROM runs WHERE run_id=?', (rid,)).fetchone()[0], 'forwarded')
                with contextlib.closing(sqlite3.connect(root / 'boat.sqlite')) as target:
                    target.row_factory = sqlite3.Row
                    row = target.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                self.addCleanup(self.stop_child, row['client_pid'], proc.pid)
            time.sleep(5)  # Required survival check after real HTTP, and after git sync in the --git case.
            self.assertTrue(misc._client_alive(row['client_pid'], row['start_at']))
            argv = subprocess.check_output(['ps', '-p', str(row['client_pid']), '-o', 'command=']).decode()
            self.assertIn('_bg-queue', argv)
            for marker in ('command-private-marker', 'env-private-marker', 'process-env-private-marker'):
                self.assertNotIn(marker, argv)
                for path in root.rglob('*'):
                    # The existing runs.cmd database column is not a payload file.
                    if path.is_file() and path.name not in ('db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm',
                                                           'boat.sqlite', 'boat.sqlite-wal', 'boat.sqlite-shm'):
                        self.assertNotIn(marker.encode(), path.read_bytes(), str(path))
            if git:
                self.assertEqual((root / 'git-ref').read_text(), subprocess.check_output(
                    ['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip())
        self.until(lambda: (root / 'ttl').exists())

    def test_real_http_and_private_stdin_round_trip(self):
        self.probe()

    def test_real_git_sync_then_http(self):
        self.probe(git=True)

    def test_failover_keeps_public_id_and_private_stdin_transport(self):
        self.probe(git=True, failover=True)

    @unittest.skipUnless(sys.platform == 'darwin', 'CoreFoundation fork regression is macOS-specific')
    def test_threaded_cf_parent_real_proxy_and_http(self):
        self.probe(cf=True)

    @unittest.skipUnless(sys.platform == 'darwin', 'CoreFoundation fork regression is macOS-specific')
    def test_threaded_cf_parent_git_sync_real_proxy_and_http(self):
        self.probe(git=True, cf=True)

    def test_readiness_failure_is_local_error_and_no_late_worker(self):
        from offbox_lib import cli
        a = cli.build_parser().parse_args(['run', '--bg', '--', 'proof'])
        a.steps = []
        me = dict(self.me, repo_root=self.tmp.name)
        with patch.object(runs, 'BG_ENTRY', Path(self.tmp.name) / 'missing.py'), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(common.OffboxError) as caught:
            runs._background(a, me)
        self.assertEqual(caught.exception.code, common.EXIT_LOCAL)
        row = self.con.execute('SELECT status,exit_code FROM runs').fetchone()
        self.assertEqual(tuple(row), ('local_error', common.EXIT_LOCAL))

    def test_stalled_bootstrap_deadline_kills_only_the_spawned_child(self):
        from offbox_lib import cli
        a = cli.build_parser().parse_args(['run', '--bg', '--', 'proof'])
        a.steps = []
        spawned = []
        popen = subprocess.Popen
        def spawn(*args, **kwargs):
            child = popen(*args, **kwargs)
            spawned.append(child)
            return child
        with patch.object(runs, 'BG_ENTRY', Path(__file__).resolve()), \
                patch.object(runs, 'BG_READY_TIMEOUT_S', .2), \
                patch.object(runs.subprocess, 'Popen', side_effect=spawn), \
                patch.dict(os.environ, OFFBOX_TEST_STALL_BOOT='1'), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(common.OffboxError) as caught:
            runs._background(a, dict(self.me, repo_root=self.tmp.name))
        self.assertEqual(caught.exception.code, common.EXIT_LOCAL)
        self.assertEqual(len(spawned), 1)
        self.assertIsNotNone(spawned[0].poll())
        self.assertEqual(tuple(self.con.execute('SELECT status,exit_code FROM runs').fetchone()),
                         ('local_error', common.EXIT_LOCAL))

    def test_ready_child_cannot_start_after_parent_timeout(self):
        from offbox_lib import cli
        root = Path(self.tmp.name)
        a = cli.build_parser().parse_args(['run', '--bg', '--no-sync', '--', 'proof'])
        a.steps = []
        def late(*args):
            time.sleep(.6)  # The child publishes readiness while the parent misses its deadline.
            return [], [], []
        with patch.object(runs, 'BG_ENTRY', Path(queue_tests.__file__).resolve()), \
                patch.dict(os.environ, OFFBOX_TEST_ROOT=str(root)), \
                patch.object(runs.select, 'select', side_effect=late), \
                contextlib.redirect_stderr(io.StringIO()), self.assertRaises(common.OffboxError) as caught:
            runs._background(a, dict(self.me, repo_root=str(root)))
        self.assertEqual(caught.exception.code, common.EXIT_LOCAL)
        row = self.con.execute('SELECT status,exit_code,box_id,process_id FROM runs').fetchone()
        self.assertEqual(tuple(row), ('local_error', common.EXIT_LOCAL, None, None))
        self.assertFalse((root / 'starts').exists())


if __name__ == '__main__' and len(sys.argv) > 1:
    if sys.argv[1] == '--fixture':
        fixture_main()
    elif sys.argv[1] == '_bg-queue':
        faulthandler.enable(file=sys.stderr, all_threads=True)
        payload = json.load(sys.stdin)
        os.environ.clear()
        os.environ.update(payload['env'])
        if os.environ.get('OFFBOX_TEST_STALL_BOOT'):
            time.sleep(60)
        setup(Path(os.environ['OFFBOX_TEST_ROOT']), payload['backend'])
        sys.exit(runs.background_queue(sys.argv[2], payload))
