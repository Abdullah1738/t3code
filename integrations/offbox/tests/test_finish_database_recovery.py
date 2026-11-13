"""Known command exits survive SQLite failures before a finish transaction starts."""
import contextlib
import io
from pathlib import Path
import sqlite3
import sys
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path.insert(0, str(SCRIPTS))
from offbox_lib import api, cli, common, identity, lease, misc, pool, reap, runs
if __package__:
    from .client_fixtures import Isolated
else:
    from client_fixtures import Isolated


class FinishDatabaseRecovery(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(identity, 'whoami', return_value=self.me))
        self.stack.enter_context(patch.object(api, '_request', side_effect=AssertionError('unexpected API')))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
        self.stack.enter_context(patch.object(misc, '_catch_up_finished'))

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
                            with patch.object(runs.Runner,'start',start):
                                self.assertEqual(cli.main(['run','--bg','--no-fallback','--','echo done']),code)
                    self.assertGreaterEqual(len(faults),3)
                    self.assertIn(rid,stderr.getvalue())
                    self.assertNotIn('nothing ran',stderr.getvalue())
                    saved=common.read_json(runs.LOGS_DIR / (rid + '.state.json'),{})
                    self.assertEqual(saved['exit_code'],code)
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(cli.main(['wait',rid]),code)
                    self.assertEqual(self.con.execute('SELECT exit_code FROM runs WHERE run_id=?',(rid,)).fetchone()[0],code)
