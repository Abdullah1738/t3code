"""Known command exits survive SQLite failures before a finish transaction starts."""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path.insert(0, str(SCRIPTS))
from offbox_lib import api, cli, common, identity, lease, misc, pool, reap, runs
if __package__:
    from .client_fixtures import Isolated, background_queue_tests
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from client_fixtures import Isolated, background_queue_tests


class FinishDatabaseRecovery(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(identity, 'whoami', return_value=self.me))
        self.stack.enter_context(patch.object(api, '_request', side_effect=AssertionError('unexpected API')))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
        self.stack.enter_context(patch.object(misc, '_catch_up_finished'))

    def test_cleanup_database_and_warning_failures_preserve_result_or_exception(self):
        root = Path(self.tmp.name)
        signals = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
        handlers = {sig: signal.getsignal(sig) for sig in signals}
        for phase in ('connect', 'SELECT'):
            for bad_log in (False, True):
                for code in (0, 17, None):
                    with self.subTest(phase=phase, bad_log=bad_log, code=code):
                        rid = common.new_id('cleanup')
                        if code is not None:
                            runs.save_run_state(rid, status='done' if code == 0 else 'failed', exit_code=code)
                        original = RuntimeError('original run failure')

                        def complete(*args):
                            if phase == 'connect':
                                common.DB_PATH = root
                            else:
                                self.con.execute('ALTER TABLE runs RENAME TO hidden_runs')
                            if code is None:
                                raise original
                            return code

                        with patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: rid}), \
                                patch.object(common, 'DB_PATH', common.DB_PATH), \
                                patch.object(common, 'LOG_PATH', root if bad_log else root / 'log'), \
                                patch.object(runs, '_background_context', None), \
                                patch.object(cli, '_run_with_retries', side_effect=complete), \
                                contextlib.redirect_stderr(io.StringIO()) as stderr:
                            try:
                                if code is None:
                                    with self.assertRaises(RuntimeError) as caught:
                                        runs.background_client(None, self.me)
                                    self.assertIs(caught.exception, original)
                                else:
                                    self.assertEqual(runs.background_client(None, self.me), code)
                            finally:
                                if phase == 'SELECT':
                                    self.con.execute('ALTER TABLE hidden_runs RENAME TO runs')
                        self.assertIn('local bookkeeping failed', stderr.getvalue())
                        self.assertEqual({sig: signal.getsignal(sig) for sig in signals}, handlers)

    def test_exec_child_keeps_known_exit_when_database_cannot_be_opened(self):
        root = Path(self.tmp.name)
        for code in (0, 17):
            with self.subTest(code=code):
                proc = subprocess.Popen([sys.executable, '-I', str(Path(__file__).resolve()),
                                         '--fixture', str(root), str(code)],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                self.addCleanup(background_queue_tests.BackgroundQueueTests.stop, self, proc)
                out, err = proc.communicate(timeout=25)
                self.assertEqual(proc.returncode, 0, err.decode())
                rid = out.decode().strip()
                row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                self.assertIsNotNone(row)
                self.addCleanup(background_queue_tests.BackgroundQueueTests.stop_child, self, row['client_pid'], proc.pid)
                done = root / f'child-result-{code}'
                background_queue_tests.BackgroundQueueTests.until(self, done.exists)
                diagnostic = (runs.LOGS_DIR / f'{rid}.client.log').read_text()
                self.assertEqual(done.read_text(), str(code), diagnostic)
                self.assertEqual((root / f'command-result-{code}').read_text(), str(code))
                saved = common.read_json(runs.LOGS_DIR / f'{rid}.state.json', {})
                self.assertEqual(saved['exit_code'], code)
                self.assertIn('local bookkeeping failed', diagnostic)
                self.assertNotIn('nothing ran', diagnostic)
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(cli.main(['wait', rid]), code)
                self.assertEqual(self.con.execute('SELECT exit_code FROM runs WHERE run_id=?',
                                                 (rid,)).fetchone()[0], code)

    def test_cli_known_exits_survive_preliminary_open_and_read_failures(self):
        connect = common.db
        for flag in ('--no-fallback', '--remote'):
            for phase in ('connect', 'SELECT', 'BEGIN IMMEDIATE'):
                for message in ('database is locked', 'disk I/O error'):
                    for code in (0, 17):
                        with self.subTest(flag=flag, phase=phase, message=message, code=code):
                            rid = common.new_id('finish')
                            self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,docker) "
                                             "VALUES (?,'box','running','fg',0)", (rid,))
                            returned, faults = [], []

                            def fail():
                                faults.append(phase)
                                error = sqlite3.OperationalError(message)
                                error.add_note('local state SQL: ' + phase)
                                raise error

                            def db():
                                if returned and phase == 'connect':
                                    fail()
                                con = connect()
                                execute = con.execute
                                def query(sql, *args):
                                    if returned and (sql.startswith(phase) if phase != 'SELECT' else
                                                     sql.startswith('SELECT * FROM runs WHERE run_id=')):
                                        fail()
                                    return execute(sql, *args)
                                con.execute = query
                                return con

                            def start(runner):
                                runner.run_id, runner.box, runner.pid = rid, 'box', 7
                                runner.registered = runner.started = True
                                runner.log_path = runs.LOGS_DIR / (rid + '.log')
                                runner.log_path.touch()

                            def stream(runner):
                                returned.append(True)
                                return code

                            stderr = io.StringIO()
                            with patch.object(runs, 'db', side_effect=db), \
                                    patch.object(runs.Runner, 'start', start), \
                                    patch.object(runs.Runner, 'stream', stream), \
                                    contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                                result = cli.main(['run', flag, '--', 'echo done'])
                            self.assertEqual(result, code, stderr.getvalue())
                            self.assertEqual(len(faults), 3)
                            self.assertIn('warning:', stderr.getvalue())
                            self.assertIn(rid + ': remote exit ' + str(code), stderr.getvalue())
                            self.assertIn(phase, stderr.getvalue())
                            self.assertNotIn('nothing ran', stderr.getvalue())
                            saved = common.read_json(runs.LOGS_DIR / (rid + '.state.json'), {})
                            self.assertEqual(saved['exit_code'], code)
                            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                                self.assertEqual(cli.main(['wait', rid]), code)
                            self.assertEqual(tuple(self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?',
                                                                    (rid,)).fetchone()),
                                             ('done' if code == 0 else 'failed', code))

    def test_other_completion_callers_save_known_results_when_new_connections_fail(self):
        self.box('box', member=True, used=common.now())
        for entry in ('wait', 'pool', 'reap', 'lost', 'background'):
            for code in (0, 17):
                with self.subTest(entry=entry, code=code):
                    rid = common.new_id('completion')
                    self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,docker,process_id,command_id,log_path) "
                                     "VALUES (?,'box',?,'bg',0,7,'command',?)",
                                     (rid,'lost' if entry == 'lost' else 'running',str(runs.LOGS_DIR / (rid + '.log'))))
                    row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rid,)).fetchone()
                    path = runs.LOGS_DIR / (rid + '.log')
                    path.write_text('command finished\n')
                    finished, faults = [], []
                    def ended(*args, **kwargs):
                        finished.append(True)
                        return {'status':'exited','running':False,'exitCode':code}
                    def db():
                        if finished:
                            faults.append(True)
                            error = sqlite3.OperationalError('database is locked')
                            error.add_note('local state SQL: connect')
                            raise error
                        return common.db()
                    def start(runner):
                        runner.run_id, runner.box, runner.pid = rid, 'box', 7
                        runner.registered = runner.started = True
                        runner.remote_code = runner.recovered_code = code
                        finished.append(True)
                    stderr = io.StringIO()
                    with patch.object(runs,'db',side_effect=db), patch.object(misc,'db',side_effect=db), \
                            patch.object(api,'cmd_status',side_effect=ended), \
                            patch.object(api,'get',return_value={'state':'running'}), \
                            patch.object(runs,'confirmed_lost',side_effect=ended), \
                            contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
                        if entry == 'wait':
                            finished.append(True)
                            self.assertEqual(misc._finalize(row,code,path),code)
                        elif entry == 'pool':
                            pool._refresh_background(self.con,'repo')
                        elif entry == 'reap':
                            reap._check_unlocked(self.con,'box','running',False,[])
                        elif entry == 'lost':
                            runs.reconcile_lost(self.con,'box')
                        else:
                            args = cli.build_parser().parse_args(['run','--bg','--no-fallback','--','echo done'])
                            args.steps = []
                            self.con.execute("UPDATE runs SET status='starting',box_id=NULL,process_id=NULL,"
                                             "client_pid=?,owner=?,repo_root=?,local_cwd=? WHERE run_id=?",
                                             (os.getpid(),self.me['owner'],self.me['repo_root'],os.getcwd(),rid))
                            payload = dict(args=vars(args),me=self.me,backend=common.backend(),
                                           ready_fd=None,accept_fd=None,signal_mask=[])
                            # Parent mocks cannot cross #101's re-exec; exercise the adopted child entry.
                            signals = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
                            handlers = {sig: signal.getsignal(sig) for sig in signals}
                            with patch.dict(os.environ), patch.object(runs, '_background_context', None), \
                                    patch.object(runs.Runner,'start',start):
                                self.assertEqual(runs.background_queue(rid,payload),code)
                            self.assertEqual({sig: signal.getsignal(sig) for sig in signals}, handlers)
                    self.assertGreaterEqual(len(faults),3)
                    self.assertIn(rid,stderr.getvalue())
                    self.assertNotIn('nothing ran',stderr.getvalue())
                    saved=common.read_json(runs.LOGS_DIR / (rid + '.state.json'),{})
                    self.assertEqual(saved['exit_code'],code)
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(cli.main(['wait',rid]),code)
                    self.assertEqual(self.con.execute('SELECT exit_code FROM runs WHERE run_id=?',(rid,)).fetchone()[0],code)


if __name__ == '__main__' and len(sys.argv) > 1:
    import faulthandler
    from offbox_lib import start_check
    if sys.argv[1] == '--fixture':
        root, code = Path(sys.argv[2]), int(sys.argv[3])
        _, me = background_queue_tests.configure_fixture(root, 'boat')
        runs.BG_ENTRY = Path(__file__).resolve()
        os.environ['OFFBOX_TEST_COMPLETION_CODE'] = str(code)
        args = cli.build_parser().parse_args(['run', '--bg', '--no-sync', '--', 'sh', '-c', f'exit {code}'])
        args.steps = []
        sys.exit(cli.cmd_run(args, me))
    elif sys.argv[1] == '_bg-queue':
        faulthandler.enable(file=sys.stderr, all_threads=True)
        payload = json.load(sys.stdin)
        os.environ.clear()
        os.environ.update(payload['env'])
        root = Path(os.environ['OFFBOX_TEST_ROOT'])
        code = int(os.environ['OFFBOX_TEST_COMPLETION_CODE'])
        background_queue_tests.configure_fixture(root, payload['backend'])
        start_check.GRACE_S = 0

        def start(*args, **kwargs):
            result = subprocess.run(payload['args']['cmd'], check=False)
            (root / f'command-result-{code}').write_text(str(result.returncode))
            raise api.NetworkError('fixture lost start reply')

        def receipt(*args, **kwargs):
            result = int((root / f'command-result-{code}').read_text())
            # Real sqlite connect failure after a known result; no mocked DB or completion code.
            common.DB_PATH = root
            return start_check.Result('started', result)

        api.cmd_start = start
        start_check.check = receipt
        try:
            result = runs.background_queue(sys.argv[2], payload)
        except sqlite3.Error as error:
            (root / f'child-result-{code}').write_text(type(error).__name__)
            raise
        (root / f'child-result-{code}').write_text(str(result))
        sys.exit(result)
