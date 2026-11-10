"""Offline SQLite contention regressions; no boat calls or live state."""
import contextlib
import io
import multiprocessing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path[:0] = [str(SCRIPTS), str(SCRIPTS / 'tests')]
from offbox_lib import api, capacity, cli, common, identity, lease, misc, pool, reap, runs
from test_capacity import Isolated


def startup(path, barrier, queue, n):
    common.DB_PATH = Path(path)
    common.ensure_dirs = lambda: None
    try:
        barrier.wait(timeout=15)
        con = common.db()
        capacity.schema(con)
        con.execute("INSERT INTO runs(run_id,status) VALUES (?,'starting')", (f'parallel-{n}',))
        con.commit()
        con.close()
        queue.put(None)
    except Exception as error:
        queue.put(str(error))


def network_holder(path, entered, release, queue):
    common.DB_PATH = Path(path)
    common.ensure_dirs = lambda: None
    con = common.db()
    try:
        con.execute("INSERT INTO runs(run_id,status) VALUES ('network-holder','starting')")
        def boat_call():
            queue.put(con.in_transaction)
            entered.set()
            if not release.wait(timeout=15):
                raise TimeoutError('test holder was not released')
            return {}
        with patch.object(api, 'limits', side_effect=boat_call):
            api.limits()
        con.commit()
    finally:
        con.close()


class DatabaseContention(Isolated):
    def test_parallel_cold_start_registrations(self):
        ctx = multiprocessing.get_context('spawn')
        path = str(Path(self.tmp.name) / 'cold.sqlite')
        barrier, queue = ctx.Barrier(12), ctx.Queue()
        processes = [ctx.Process(target=startup, args=(path, barrier, queue, n)) for n in range(12)]
        for process in processes:
            process.start()
        errors = [queue.get(timeout=30) for _ in processes]
        for process in processes:
            process.join(timeout=10)
            self.assertEqual(process.exitcode, 0)
        self.assertEqual([e for e in errors if e], [])
        con = sqlite3.connect(path)
        self.assertEqual(con.execute('SELECT count(*) FROM runs').fetchone()[0], 12)
        con.close()

    def test_read_only_startup_under_writer_lock(self):
        self.con.execute('BEGIN IMMEDIATE')
        other = None
        real_connect = sqlite3.connect
        def short_connect(*args, **kwargs):
            kwargs['timeout'] = .05
            return real_connect(*args, **kwargs)
        try:
            with patch.object(common.sqlite3, 'connect', side_effect=short_connect):
                other = common.db()
                capacity.schema(other)
                self.assertEqual(other.execute('SELECT count(*) FROM runs').fetchone()[0], 0)
        finally:
            self.con.rollback()
            if other:
                other.close()

    def test_write_does_not_span_simulated_boat_call(self):
        # A standalone write must release its lock before the next external call.
        self.con.execute("INSERT INTO runs(run_id,status) VALUES ('holder','starting')")
        def boat_call():
            other = sqlite3.connect(common.DB_PATH, timeout=.05)
            try:
                other.execute("INSERT INTO runs(run_id,status) VALUES ('contender','starting')")
                other.commit()
            finally:
                other.close()
            return {}
        with patch.object(api, 'limits', side_effect=boat_call):
            api.limits()
        self.assertFalse(self.con.in_transaction)

    def test_other_process_can_write_during_simulated_boat_wait(self):
        ctx = multiprocessing.get_context('spawn')
        entered, release, queue = ctx.Event(), ctx.Event(), ctx.Queue()
        process = ctx.Process(target=network_holder, args=(str(common.DB_PATH), entered, release, queue))
        process.start()
        try:
            self.assertTrue(entered.wait(timeout=15))
            other = sqlite3.connect(common.DB_PATH, timeout=.1)
            try:
                other.execute("INSERT INTO runs(run_id,status) VALUES ('concurrent','starting')")
                other.commit()
            finally:
                other.close()
            self.assertFalse(queue.get(timeout=5))
        finally:
            release.set()
            process.join(timeout=15)
        self.assertEqual(process.exitcode, 0)

    def args(self, *extra):
        return cli.build_parser().parse_args(['run', *extra, '--', 'echo', 'ok'])

    def test_prestart_lock_foreground_and_background_never_fallback(self):
        from offbox_lib import fallback, localfirst
        for extra in ([], ['--bg'], ['--remote']):
            with self.subTest(extra=extra), patch.object(runs.Runner, 'start',
                    side_effect=sqlite3.OperationalError('database is locked')), \
                    patch.object(localfirst, 'decide', return_value='remote'), \
                    patch.object(fallback, 'run_local') as local, \
                    patch.object(fallback, 'note_infra_failure') as infra, \
                    contextlib.redirect_stderr(io.StringIO()) as stderr:
                self.assertEqual(cli.cmd_run(self.args(*extra), self.me), 93)
                self.assertIn('nothing ran, safe to retry', stderr.getvalue())
                self.assertNotIn('remote run error', stderr.getvalue())
                local.assert_not_called()
                infra.assert_not_called()

    def test_registered_prestart_failure_names_run_id(self):
        def failed(runner):
            runner.registered = True
            raise sqlite3.OperationalError('database is locked')
        with patch.object(runs.Runner, 'start', failed), self.assertRaises(common.OffboxError) as error:
            runs.run_remote(self.args('--bg'), self.me)
        self.assertIn('run-', str(error.exception))
        self.assertEqual(error.exception.code, 93)

    def test_poststart_lock_says_command_may_have_run_and_wait(self):
        def failed(a, runner):
            runner.registered = runner.started = True
            raise sqlite3.OperationalError('database is locked')
        with patch.object(runs, '_run_remote', failed), self.assertRaises(common.OffboxError) as error:
            runs.run_remote(self.args(), self.me)
        self.assertEqual(error.exception.code, 93)
        self.assertTrue(error.exception.started)
        self.assertIn('offbox wait run-', str(error.exception))
        self.assertNotIn('nothing ran', str(error.exception))

    def test_known_exit_survives_finish_write_lock_after_recovery_and_pull(self):
        self.con.execute("INSERT INTO runs(run_id,status,box_id,process_id,docker) VALUES ('completed','running','box',7,0)")
        self.con.execute('BEGIN IMMEDIATE')
        def start(runner):
            runner.run_id = 'completed'
            runner.box, runner.pid = 'box', 7
            runner.registered = runner.started = True
        for code in (0, 17):
            with self.subTest(code=code), patch.object(common, 'DB_TIMEOUT', .01), \
                    patch.object(runs.Runner, 'start', start), patch.object(runs.Runner, 'stream', return_value=None), \
                    patch.object(runs, 'recover_lost_exit', return_value=(code, "the box's exit file")), \
                    patch.object(runs, 'do_pulls') as pull, patch.object(runs, 'go_std_glitch'), \
                    contextlib.redirect_stderr(io.StringIO()) as stderr:
                args = self.args('--pull', 'artifact')
                self.assertEqual(runs.run_remote(args, self.me), code)
                pull.assert_called_once()
                self.assertIn(f'completed: remote exit {code}', stderr.getvalue())
                self.assertIn('warning:', stderr.getvalue())
                self.assertIn('BEGIN IMMEDIATE', stderr.getvalue())
                self.assertIn('offbox wait completed', stderr.getvalue())
        self.con.rollback()
        with patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'):
            self.assertEqual(misc.wait('completed', None), 17)
        self.assertEqual(self.con.execute("SELECT exit_code FROM runs WHERE run_id='completed'").fetchone()[0], 17)

    def test_finish_retries_then_persists_real_status(self):
        self.con.execute("INSERT INTO runs(run_id,status) VALUES ('retry','running')")
        connections, attempts = [], []
        def flaky_db():
            con = common.db()
            execute = con.execute
            def flaky(sql, *args):
                if sql.startswith('UPDATE runs SET status='):
                    attempts.append(sql)
                    if len(attempts) < 3:
                        raise sqlite3.OperationalError('database is locked')
                return execute(sql, *args)
            con.execute = flaky
            connections.append(con)
            return con
        with patch.object(runs, 'db', side_effect=flaky_db):
            runs.finish('retry', 7)
        self.assertEqual(len(attempts), 3)
        row = self.con.execute("SELECT status,exit_code FROM runs WHERE run_id='retry'").fetchone()
        self.assertEqual(tuple(row), ('failed', 7))

    def test_reaper_recovers_real_exit_instead_of_254(self):
        self.box('box')
        self.con.execute("INSERT INTO runs(run_id,box_id,status,process_id,docker) VALUES ('reaped','box','running',7,0)")
        with patch.object(api, 'cmd_status', return_value={'status':'exited', 'exitCode':254}), \
                patch.object(runs, 'recover_lost_exit', return_value=(0, "exit file")), \
                patch.object(lease, 'idle_ttl'):
            reap._check_unlocked(self.con, 'box', 'running', False, [])
        self.assertEqual(tuple(self.con.execute("SELECT status,exit_code FROM runs WHERE run_id='reaped'").fetchone()),
                         ('done', 0))

    def test_identity_cache_lock_does_not_break_list_or_status(self):
        resolved = {'resolution':'resolved', 'robobThreadId':'thread'}
        self.con.execute('BEGIN IMMEDIATE')
        for command in ('list', 'status'):
            with self.subTest(command=command), patch.object(identity, '_resolve_identity', return_value=(200, {'identity':resolved})), \
                    patch.object(identity, 'whoami', side_effect=lambda: {
                        **self.me, 'identity':identity.identity_for('native', 'codex')}), \
                    patch.object(api, 'list_boxes', return_value=[]), patch.object(api, 'limits', return_value={}), patch.object(misc, 'outage') as outage, \
                    contextlib.redirect_stdout(io.StringIO()):
                outage.current.return_value = None
                self.assertEqual(cli.main([command]), 0)
        self.con.rollback()

    def test_fresh_unchanged_identity_does_not_write(self):
        value = {'resolution':'resolved','driver':'codex','nativeId':'native'}
        common.kv_set(self.con, 'identity:codex:native', value)
        self.con.execute('BEGIN IMMEDIATE')
        with patch.object(identity, 'kv_set') as cache, patch.object(identity, '_resolve_identity') as resolve:
            self.assertEqual(identity.identity_for('native', 'codex'), value)
            cache.assert_not_called()
            resolve.assert_not_called()
        self.con.rollback()

    def test_migrations_are_atomic_and_read_connections_do_not_run_ddl(self):
        self.assertEqual(self.con.execute('PRAGMA user_version').fetchone()[0], common.SCHEMA_VERSION)
        traced = []
        self.con.set_trace_callback(traced.append)
        capacity.schema(self.con)
        self.assertFalse(any(sql.startswith(('CREATE','ALTER','INSERT')) for sql in traced), traced)

    def test_busy_cache_pending_proof_does_not_revive_stale_resolved_identity(self):
        import json
        old = {'resolution':'resolved','driver':'codex','nativeId':'native'}
        self.con.execute("INSERT INTO kv VALUES (?,?,?)", ('identity:codex:native',json.dumps(old),
                                                         common.now()-identity.RESOLVED_TTL-10))
        self.con.execute('BEGIN IMMEDIATE')
        def pending(path, invalidate):
            answer = {'resolution':'pending'}
            invalidate(answer)
            return 200, {'identity':answer}
        with patch.object(identity, '_resolve_identity', side_effect=pending):
            self.assertEqual(identity.identity_for('native','codex')['resolution'], 'pending')
        with patch.object(identity, '_resolve_identity', return_value=(0, {'error':'unreachable'})):
            self.assertEqual(identity.identity_for('native','codex')['resolution'], 'unavailable')
        self.con.rollback()

    def test_local_failure_is_never_eligible_for_small_command_fallback(self):
        from offbox_lib import fallback
        self.assertFalse(fallback.allowed(['echo','ok'], common.OffboxError('DB busy',code=93), '/repo'))

    def test_authoritative_identity_updates_survive_busy_cache_and_outage(self):
        import json
        # Every authoritative non-resolved form revokes the older owner; a new owner replaces it too.
        cases = [('ambiguous', None), ('none', None), ('unavailable', None), ('unknown', None),
                 ('pending', None), ('resolved', 'new-owner')]
        for resolution, owner in cases:
            with self.subTest(resolution=resolution):
                native = 'revocation-' + resolution
                old = {'resolution':'resolved','robobThreadId':'old-owner','driver':'codex','nativeId':native}
                self.con.execute('INSERT INTO kv VALUES (?,?,?)', (f'identity:codex:{native}', json.dumps(old),
                                                                  common.now()-identity.RESOLVED_TTL-10))
                self.con.execute('BEGIN IMMEDIATE')
                answer = {'resolution':resolution,'robobThreadId':owner}
                try:
                    with patch.object(identity, '_resolve_identity', return_value=(200, {'identity':answer})):
                        self.assertEqual(identity.identity_for(native, 'codex')['resolution'], resolution)
                    with patch.object(identity, '_resolve_identity', return_value=(0, {'error':'offline'})):
                        result = identity.identity_for(native, 'codex')
                        self.assertNotEqual(result.get('robobThreadId'), 'old-owner')
                        self.assertEqual(result.get('robobThreadId'), owner)
                finally:
                    self.con.rollback()

    def test_background_refresh_preserves_saved_and_box_results(self):
        self.box('box', member=True)
        cases = [(source, code, remote) for source in ('saved','box') for code in (0,17)
                 for remote in ('exited','lost')]
        for n, (source, code, remote) in enumerate(cases):
            with self.subTest(source=source, code=code, remote=remote):
                rid = f'background-{n}'
                self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,process_id,docker) "
                                 "VALUES (?,'box','running','bg',7,0)", (rid,))
                if source == 'saved':
                    runs.save_run_state(rid, status='done' if code == 0 else 'failed',exit_code=code)
                with patch.object(api, 'cmd_status', return_value={'status':remote,'exitCode':254}) as status, \
                        patch.object(runs, 'recover_lost_exit', return_value=(code, 'exit file')), \
                        patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'):
                    pool._refresh_background(self.con, 'repo')
                    if source == 'saved':
                        status.assert_not_called()
                self.assertEqual(self.con.execute('SELECT exit_code FROM runs WHERE run_id=?', (rid,)).fetchone()[0], code)

    def test_wait_keeps_known_result_when_diagnostic_write_is_locked(self):
        self.box('box')
        for code in (0,17):
            with self.subTest(code=code):
                rid = f'wait-diagnostic-{code}'
                self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,process_id,docker) "
                                 "VALUES (?,'box','running','fg',7,0)", (rid,))
                (runs.LOGS_DIR / f'{rid}.log').write_text('package unsafe is not in std (/usr/local/go/src/unsafe)')
                self.con.execute('BEGIN IMMEDIATE')
                try:
                    with patch.object(identity, 'whoami', return_value=self.me), \
                            patch.object(common, 'DB_TIMEOUT', .005), patch.object(runs, 'follow', return_value=code), \
                            contextlib.redirect_stderr(io.StringIO()) as stderr, contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(cli.main(['wait', rid]), code)
                        self.assertNotIn('nothing ran, safe to retry', stderr.getvalue())
                finally:
                    self.con.rollback()

    def test_local_fallback_keeps_executed_result_when_bookkeeping_locks(self):
        from offbox_lib import fallback, localfirst
        from types import SimpleNamespace
        for stage in ('connect','update','event'):
            for code in (0,17):
                with self.subTest(stage=stage, code=code), contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(identity, 'whoami', return_value=self.me))
                    stack.enter_context(patch.object(localfirst, 'decide', return_value='remote'))
                    stack.enter_context(patch.object(runs, 'run_remote', side_effect=capacity.CapacityError('limit')))
                    stack.enter_context(patch.object(fallback, 'Semaphore'))
                    command = stack.enter_context(patch.object(fallback.subprocess, 'run', return_value=SimpleNamespace(returncode=code)))
                    if stage == 'connect':
                        stack.enter_context(patch.object(fallback, 'db', side_effect=sqlite3.OperationalError('database is locked')))
                    elif stage == 'event':
                        stack.enter_context(patch.object(fallback, 'event', side_effect=sqlite3.OperationalError('database is locked')))
                    else:
                        def failed_db():
                            con = common.db()
                            execute = con.execute
                            def failed(sql, *args):
                                if sql.startswith('UPDATE runs'):
                                    raise sqlite3.OperationalError('database is locked')
                                return execute(sql, *args)
                            con.execute = failed
                            return con
                        stack.enter_context(patch.object(fallback, 'db', side_effect=failed_db))
                    stderr = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    self.assertEqual(cli.main(['run','--','echo','ok']), code)
                    command.assert_called_once()
                    self.assertIn(f'local exit {code}', stderr.getvalue())
                    self.assertIn('Do not rerun', stderr.getvalue())
                    self.assertNotIn('nothing ran, safe to retry', stderr.getvalue())

    def test_background_refresh_reads_sidecar_only_handle(self):
        self.box('box', member=True)
        for status in ('starting','running'):
            for code in (0,17):
                with self.subTest(status=status, code=code):
                    rid = f'handle-only-{status}-{code}'
                    self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,docker) VALUES (?,'box',?,'bg',0)", (rid,status))
                    runs.save_run_state(rid, box_id='box', process_id=7, command_id='command')
                    with patch.object(api, 'cmd_status', return_value={'status':'exited','exitCode':code}) as probe, \
                            patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'):
                        pool._refresh_background(self.con, 'repo')
                        probe.assert_called_once_with('box', 7)
                    self.assertEqual(self.con.execute('SELECT exit_code FROM runs WHERE run_id=?', (rid,)).fetchone()[0],code)

    def test_every_terminal_sidecar_repairs_database_and_releases_pool_slot(self):
        self.box('box', member=True)
        for status, code in [('done',0),('failed',17),('local_error',93),('killed',130),('infra',90),('busy',92)]:
            for reader in ('wait','pool','reap'):
                with self.subTest(status=status, reader=reader):
                    rid = f'terminal-{status}-{reader}'
                    self.con.execute("INSERT INTO runs(run_id,box_id,status,mode,process_id,docker) "
                                     "VALUES (?,'box','starting','bg',7,0)", (rid,))
                    self.con.execute('BEGIN IMMEDIATE')
                    try:
                        with patch.object(common, 'DB_TIMEOUT', .005), contextlib.redirect_stderr(io.StringIO()):
                            runs.finish(rid, code, status)
                    finally:
                        self.con.rollback()
                    with patch.object(lease, 'touch'), patch.object(lease, 'idle_ttl'), \
                            contextlib.redirect_stdout(io.StringIO()):
                        if reader == 'wait':
                            self.assertEqual(misc.wait(rid, None), code)
                        elif reader == 'pool':
                            pool._refresh_background(self.con, 'repo')
                        else:
                            reap._check_unlocked(self.con, 'box', 'running', False, [])
                    self.assertEqual(tuple(self.con.execute('SELECT status,exit_code FROM runs WHERE run_id=?', (rid,)).fetchone()),
                                     (status,code))
                    self.assertEqual(lease.active_runs(self.con,'box'), 0)
