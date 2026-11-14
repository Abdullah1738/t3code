"""Saved bases resolve before allocation and remain discoverable on either backend. No network."""
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from offbox_lib import allocation, api, base_catalog, bases, cli, common, fallback, home, identity, lease, outage, pool


class BaseRouting(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {k: v for k, v in os.environ.items()
                                                       if not k.startswith('OFFBOX_')}, clear=True))
        for name, value in [('STATE', self.root), ('SERVER_CFG', self.root / 'server.json'),
                            ('LOCKS_DIR', self.root / 'locks'), ('LOG_PATH', self.root / 'offbox.log'),
                            ('HOME_FAILURES', self.root / 'home-failures.jsonl'),
                            ('BACKEND_STATE', self.root / 'backend-state.json'),
                            ('BACKEND_PATH', self.root / 'backend'), ('DB_PATH', self.root / 'offbox-home.db'), ('_BACKEND', None), ('_BACKEND_REASON', None)]:
            self.stack.enter_context(patch.object(common, name, value))
        common.SERVER_CFG.write_text('{"url":"http://home.invalid/api/v1"}')
        common.BACKEND_STATE.write_text('{"state":"home_up"}')
        self.cons = {}
        for backend in ('server', 'boat'):
            con = sqlite3.connect(common.db_path_for(backend))
            con.row_factory = sqlite3.Row
            common.ensure_schema(con)
            self.cons[backend] = con
            self.addCleanup(con.close)
        self.me = dict(owner='thread:test', repo_root='/repo', repo_key='torssh')
        self.stack.enter_context(patch.object(identity, 'whoami', return_value=self.me))
        self.stack.enter_context(patch.object(identity, 'repo_root', return_value=Path('/repo')))
        self.stack.enter_context(patch.object(identity, 'repo_key', return_value='torssh'))
        self.real_acquire = pool.acquire
        for module, name in [(api, '_key'), (api, 'get'), (api, 'create'), (api, 'fork'), (pool, 'acquire')]:
            self.stack.enter_context(patch.object(module, name, side_effect=AssertionError('allocation/network forbidden')))
        self.stack.enter_context(patch.object(home, 'probe', return_value=None))
        self.stack.enter_context(patch.object(api, 'probe_backend', return_value=None))
        self.stack.enter_context(patch.object(home, 'person_gate'))
        self.logs = []
        self.stack.enter_context(patch.object(cli, 'log', side_effect=self.logs.append))
        self.real_emit = cli.toollog.emit
        self.events = self.stack.enter_context(patch.object(cli.toollog, 'emit'))

    class Exec(BaseException):
        pass

    def run_outage(self, *args):
        argv = ['run', *args, '--', 'true']
        common.select_backend(common.entry_backend(argv))
        error = api.ApiError(503, 'server_not_ready', 'fixture home down')
        error.run_id = 'run-fixture'
        err = io.StringIO()
        with contextlib.redirect_stderr(err), patch.object(home, 'probe', return_value=None), \
                patch.object(api, 'probe_backend', return_value=None), \
                patch.object(cli, '_remote_once', side_effect=error) as remote, \
                patch.object(outage, 'wait_until_up', return_value=False) as wait, \
                patch.object(os, 'execve', side_effect=self.Exec) as execute:
            try:
                code = cli.main(argv)
            except self.Exec:
                code = 'exec'
        return code, err.getvalue(), remote, wait, execute

    def decisions(self):
        return [c.kwargs for c in self.events.call_args_list
                if c.args[:2] == ('home', 'home.failover_decision')]

    def test_named_base_startup_and_outage_share_one_wait_bound(self):
        from test_home_start_wait import Clock, STARTING, READY
        self.add('server', 'warm')
        # Both orders, plus refusals during allocation and while holding a pool queue place.
        for checkpoint in ('preflight', 'allocation', 'queue', 'outage-probe', 'startup-then-outage'):
            with self.subTest(checkpoint=checkpoint), contextlib.ExitStack() as stack:
                clock = Clock()
                clock.now = 1000
                for name, replacement in (('monotonic', clock.time), ('time', clock.time), ('sleep', clock.sleep)):
                    stack.enter_context(patch.object(home.time, name, replacement))
                stack.enter_context(patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S='10', OFFBOX_OUTAGE_WAIT_SECONDS='60'))
                stack.enter_context(patch.object(api, 'BACKEND', 'server'))
                stack.enter_context(patch.object(outage, 'PROBE_EVERY_S', 3))
                stack.enter_context(patch.object(api, '_key', return_value='fixture'))
                health = [STARTING, READY] if checkpoint == 'startup-then-outage' else []
                def read(timeout):
                    return health.pop(0) if health else STARTING
                stack.enter_context(patch.object(home, '_health', side_effect=read))
                if checkpoint in ('preflight', 'startup-then-outage'):
                    stack.enter_context(patch.object(home, 'probe', side_effect=home._probe))
                def refuse(request, **kwargs):
                    raise urllib.error.HTTPError(request.full_url, 503, 'starting', {}, io.BytesIO(json.dumps({
                        'code': 'server_not_ready', 'starting': True, 'phase': 'waiting for incus',
                        'message': 'waiting for incus'}).encode()))
                send = stack.enter_context(patch.object(api, '_open', side_effect=refuse))
                if checkpoint == 'queue':
                    self.cons['server'].execute("DELETE FROM bases WHERE name='torssh:warm'")
                    self.cons['server'].commit()
                    self.full_home_pool()
                    stack.enter_context(patch.object(pool, 'acquire', side_effect=self.real_acquire))
                    stack.enter_context(patch.dict(os.environ, OFFBOX_POOL_SIZE='1', OFFBOX_POOL_WAIT_SECONDS='120'))
                    stack.enter_context(patch.object(pool, '_refresh_background'))
                    stack.enter_context(patch.object(pool, '_recheck_prune_holds'))
                    probes = [0]
                    def probe():
                        probes[0] += 1
                        return None if probes[0] == 1 else home._probe()
                    stack.enter_context(patch.object(home, 'probe', side_effect=probe))
                def remote(a, me):
                    if checkpoint == 'queue':
                        return pool.acquire(me, base=a.base)
                    if checkpoint == 'allocation':
                        with home.pre_start('run-fixture'):
                            return api.call('GET', '/limits', retries=0)
                    raise api.NetworkError('home stopped answering')
                attempt = stack.enter_context(patch.object(cli, '_remote_once', side_effect=remote))
                execute = stack.enter_context(patch.object(os, 'execve'))
                local = stack.enter_context(patch.object(fallback, 'run_local'))
                output = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                self.assertEqual(cli.main(['run', '--base', 'warm', '--', 'true']), 93, output.getvalue())
                if checkpoint == 'queue':
                    self.assertGreaterEqual(clock.now - 1000, 10)
                    self.assertLessEqual(clock.now - 1000, 10 + 2 * outage.PROBE_EVERY_S)
                else:
                    self.assertEqual(clock.now - 1000, 10)
                self.assertIn('home still starting after 10 s', output.getvalue())
                self.assertEqual(send.call_count, 1 if checkpoint in ('allocation', 'outage-probe', 'startup-then-outage') else 0)
                self.assertEqual(attempt.call_count, 0 if checkpoint == 'preflight' else 1)
                execute.assert_not_called()
                local.assert_not_called()
                self.assertIsNone(home.WAIT_BUDGET.get())
                for table in ('pool_waiters', 'pool_pending', 'pool_cap_callers'):
                    self.assertEqual(self.cons['server'].execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0], 0)

    def test_explicit_home_base_waits_then_exits_93_without_boat_or_local(self):
        self.add('server', 'warm')
        for args in (['--base', 'warm'], ['--base=torssh:warm'], ['--bas', 'warm'],
                     ['--base', 'ignored', '--base', 'warm'], ['--base', 'warm', '--bg', '--no-fallback']):
            with self.subTest(args=args):
                self.events.reset_mock()
                code, err, remote, wait, execute = self.run_outage(*args)
                self.assertEqual(code, 93, err)
                self.assertIn("saved base 'torssh:warm'", err)
                self.assertIn('Nothing ran and nothing was sent to Boat', err)
                self.assertNotIn('goes to Boat instead', err)
                wait.assert_called_once()
                execute.assert_not_called()
                remote.assert_called_once()
                decision, = self.decisions()
                self.assertEqual(decision['props']['decision'], 'wait_explicit_base')
                self.assertEqual(decision['props']['base'], 'torssh:warm')
                self.assertEqual(decision['ids']['run'], 'run-fixture')
        self.assert_no_allocations()

    def test_monitor_down_still_routes_explicit_home_base_to_home(self):
        self.add('server', 'warm')
        common.BACKEND_STATE.write_text('{"state":"home_down"}')
        self.assertEqual(common.entry_backend(['run', '--base', 'warm', '--', 'true']), 'server')
        self.assertEqual(self.run_outage('--base', 'warm')[0], 93)

    def test_implicit_default_still_fails_over_and_uses_recipe(self):
        self.add('server', 'warm', default=True)
        code, err, _, wait, execute = self.run_outage()
        self.assertEqual(code, 'exec', err)
        self.assertIn('this run goes to Boat instead', err)
        wait.assert_not_called()
        self.assertEqual(self.decisions()[0]['props']['decision'], 'boat')
        self.assertIsNone(self.decisions()[0]['props']['base'])
        with patch.dict(os.environ, execute.call_args.args[2]):
            common.select_backend('boat')
            output = io.StringIO()
            with contextlib.redirect_stderr(output), patch.object(lease, '_fit_new', return_value='default'), \
                    patch.object(lease, 'pick_template', return_value=('crpko-node', 'package.json')), \
                    patch.object(lease, 'report_template'), patch.object(api, 'create', return_value={'id': 'new'}):
                result = lease._new_box(self.cons['boat'], self.me, None, None, None, False)
            self.assertEqual(result[1], 'recipe:crpko-node')
            self.assertIn('using the repo template or recipe for this run', output.getvalue())

    def test_explicit_base_on_both_backends_is_preserved_on_boat(self):
        self.add('server', 'warm')
        self.add('boat', 'warm')
        code, err, _, wait, execute = self.run_outage('--base', 'warm')
        self.assertEqual(code, 'exec', err)
        wait.assert_not_called()
        failure = json.loads(common.HOME_FAILURES.read_text().splitlines()[-1])
        self.assertEqual((failure['base'], failure['base_kept']), ('torssh:warm', True))
        with patch.dict(os.environ, execute.call_args.args[2]):
            common.select_backend('boat')
            with patch.object(lease, '_fit_new', return_value='default'), \
                    patch.object(lease, '_start_from', return_value={'id': 'from-base'}) as start, \
                    patch.object(lease, 'report_template'):
                result = lease._new_box(self.cons['boat'], self.me, None, None, 'warm', False)
            self.assertEqual(result[1], 'base:torssh:warm')
            self.assertEqual(start.call_args.args[2]['name'], 'torssh:warm')

    def test_new_box_cannot_drop_an_explicit_home_only_base_on_boat(self):
        self.add('server', 'warm')
        with patch.dict(os.environ, OFFBOX_BACKEND='boat', OFFBOX_FAILOVER='unreachable'):
            common.select_backend('boat')
            with self.assertRaises(common.OffboxError) as caught:
                lease._new_box(self.cons['boat'], self.me, None, None, 'warm', False)
        self.assertEqual(caught.exception.code, 93)
        self.assertIn('torssh:warm', str(caught.exception))
        self.assert_no_allocations()

    def test_explicit_base_wait_retries_home_when_it_returns(self):
        self.add('server', 'warm')
        common.select_backend('server')
        argv = ['run', '--base', 'warm', '--', 'true']
        with patch.object(cli, '_remote_once', side_effect=[api.NetworkError('unreachable'), 7]) as remote, \
                patch.object(outage, 'wait_until_up', return_value=True) as wait, \
                patch.object(os, 'execve', side_effect=AssertionError('must stay home')):
            self.assertEqual(cli.main(argv), 7)
        self.assertEqual(remote.call_count, 2)
        wait.assert_called_once()
        self.assertEqual(wait.call_args.kwargs['service'], 'home offbox server')

    def test_outage_retry_deadlines_keep_the_home_base_restriction(self):
        self.add('server', 'warm')
        common.select_backend('server')
        for shape in ('budget', 'wrapped_budget', 'pool_deadline'):
            for flags in ([], ['--bg'], ['--remote'], ['--no-fallback']):
                with self.subTest(shape=shape, flags=flags):
                    clock = [1000.0]
                    budget = api.BudgetExpired('allocation budget exhausted')
                    error = budget
                    if shape == 'wrapped_budget':
                        error = common.OffboxError('wrapped allocation failure')
                        error.__cause__ = budget
                    elif shape == 'pool_deadline':
                        error = pool.PoolBusyError('allocation wait expired; nothing ran')
                    attempts = []
                    def remote(*args):
                        attempts.append(outage.allocation_left())
                        if len(attempts) == 1:
                            raise api.NetworkError('home is unreachable')
                        clock[0] += 61
                        raise error
                    with patch.object(cli, '_remote_once', side_effect=remote), \
                            patch.object(cli, 'time', types.SimpleNamespace(monotonic=lambda: clock[0])), \
                            patch.object(outage, 'time', types.SimpleNamespace(monotonic=lambda: clock[0])), \
                            patch.object(outage, 'window_seconds', return_value=60), \
                            patch.object(outage, 'wait_until_up', return_value=True) as wait, \
                            patch.object(fallback, 'run_local', return_value=17) as local, \
                            patch.object(os, 'execve') as execute, contextlib.redirect_stderr(io.StringIO()) as err:
                        code = cli.main(['run', '--base', 'warm', *flags, '--', 'true'])
                    self.assertEqual(code, 93, err.getvalue())
                    self.assertIn("saved base 'torssh:warm'", err.getvalue())
                    self.assertEqual(attempts, [None, 60])
                    wait.assert_called_once()
                    local.assert_not_called()
                    execute.assert_not_called()

    def test_a_named_base_never_falls_back_locally_on_prestart_errors(self):
        self.add('server', 'warm')
        common.select_backend('server')
        for boat_copy in (False, True):
            if boat_copy:
                self.add('boat', 'warm')
            for error in (api.BudgetExpired('client budget'), pool.PoolBusyError('full pool'),
                          common.OffboxError('setup failure')):
                with self.subTest(error=type(error).__name__, boat_copy=boat_copy), \
                        patch.object(cli, '_remote_once', side_effect=error), \
                        patch.object(fallback, 'run_local', return_value=17) as local, \
                        patch.object(fallback, 'note_infra_failure'), \
                        contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(cli.main(['run', '--base', 'warm', '--', 'true']), error.code)
                    local.assert_not_called()

    def test_fresh_keeps_local_fallback_when_the_named_base_is_ignored(self):
        self.add('server', 'warm')
        common.select_backend('server')
        with patch.object(cli, '_remote_once', side_effect=api.BudgetExpired('client budget')), \
                patch.object(fallback, 'run_local', return_value=17) as local, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(['run', '--base', 'warm', '--fresh', '--', 'true']), 17)
        local.assert_called_once()

    def full_home_pool(self):
        self.add('server', 'warm')
        common.select_backend('server')
        con = self.cons['server']
        con.execute("INSERT INTO leases(box_id,owner,repo_root,repo_key,remote_dir,state,size,source) "
                    "VALUES ('busy','other','/other','torssh','w/other','running','default','base:torssh:warm')")
        con.execute("INSERT INTO pool_members VALUES ('busy','torssh')")
        con.execute("INSERT INTO runs(run_id,box_id,status,mode) VALUES ('busy-run','busy','running','fg')")
        con.commit()

    def test_home_outage_is_checked_before_entering_a_full_pool(self):
        self.full_home_pool()
        for state, health, auth in (('home_down', 'server says it cannot take runs', None),
                                    ('home_up', 'server says it cannot take runs', None),
                                    ('home_up', None, 'authenticated API did not answer')):
            for flags in ([], ['--bg']):
                with self.subTest(state=state, health=health, flags=flags):
                    common.BACKEND_STATE.write_text(json.dumps({'state': state}))
                    clock = [1000.0]
                    def advance(seconds):
                        clock[0] += seconds
                    def pool_sleep(seconds):
                        clock[0] += pool.HOME_WAIT_S
                    pool_clock = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=pool_sleep)
                    wait_clock = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=advance)
                    with patch.object(home, 'probe', return_value=health) as health_probe, \
                            patch.object(api, 'probe_backend', return_value=auth), \
                            patch.object(api, 'probe', return_value='no answer') as probe, \
                            patch.object(outage, 'window_seconds', return_value=60), \
                            patch.object(cli, 'time', wait_clock), patch.object(outage, 'time', wait_clock), \
                            patch.object(pool, 'time', pool_clock), patch.object(allocation, 'time', pool_clock), \
                            patch.dict(os.environ, OFFBOX_POOL_SIZE='1'), \
                            patch.object(pool, '_refresh_background'), patch.object(pool, '_recheck_prune_holds'), \
                            patch.object(pool, 'acquire', side_effect=self.real_acquire) as acquire, \
                            patch.object(cli, '_remote_once', side_effect=lambda a, me: pool.acquire(me, base=a.base)), \
                            patch.object(fallback, 'run_local', return_value=17) as local, \
                            patch.object(os, 'execve') as execute, contextlib.redirect_stderr(io.StringIO()) as err:
                        code = cli.main(['run', '--base', 'warm', *flags, '--', 'true'])
                    self.assertEqual(code, 93, err.getvalue())
                    self.assertIn("saved base 'torssh:warm'", err.getvalue())
                    self.assertLessEqual(clock[0] - 1000, 60)
                    health_probe.assert_called_once()
                    self.assertGreater(probe.call_count, 0)
                    acquire.assert_not_called()
                    local.assert_not_called()
                    execute.assert_not_called()

    def test_healthy_preflight_then_outage_interrupts_named_base_queue_waits(self):
        self.full_home_pool()
        for contention, queue_wait in (('full_pool', '120'), ('pool_lock', '120'),
                                       ('full_pool', '8'), ('pool_lock', '8')):
            for failure in ('health', 'authenticated_api'):
                for flags in ([], ['--bg']):
                    with self.subTest(contention=contention, wait=queue_wait, failure=failure, flags=flags):
                        clock = [1000.0]
                        def advance(seconds):
                            clock[0] += seconds
                        fake_time = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=advance)
                        real_lock = common.file_lock
                        @contextlib.contextmanager
                        def pool_lock(name, timeout=600):
                            if contention == 'pool_lock' and name == pool.lock_name('torssh'):
                                advance(timeout)
                                raise common.OffboxError('timed out waiting for lock ' + name)
                            with real_lock(name, timeout=timeout):
                                yield
                        def health():
                            # A slow health request must not hold the shared pool lock.
                            with real_lock(pool.lock_name('torssh'), timeout=0):
                                pass
                            return 'server says it cannot take runs' if failure == 'health' and clock[0] > 1000 else None
                        def auth(*args):
                            return 'authenticated API did not answer' if failure == 'authenticated_api' and clock[0] > 1000 else None
                        with contextlib.ExitStack() as stack:
                            health_probe = stack.enter_context(patch.object(home, 'probe', side_effect=health))
                            remote = stack.enter_context(patch.object(cli, '_remote_once',
                                side_effect=lambda a, me: pool.acquire(me, base=a.base)))
                            local = stack.enter_context(patch.object(fallback, 'run_local'))
                            execute = stack.enter_context(patch.object(os, 'execve'))
                            err = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                            for mocked in (
                                patch.object(api, 'probe_backend', side_effect=auth),
                                patch.object(api, 'probe', return_value='no answer'),
                                patch.object(outage, 'window_seconds', return_value=60),
                                patch.object(cli, 'time', fake_time), patch.object(outage, 'time', fake_time),
                                patch.object(pool, 'time', fake_time), patch.object(allocation, 'time', fake_time),
                                patch.dict(os.environ, OFFBOX_POOL_SIZE='1', OFFBOX_POOL_WAIT_SECONDS=queue_wait),
                                patch.object(pool, 'file_lock', pool_lock),
                                patch.object(pool, '_refresh_background'), patch.object(pool, '_recheck_prune_holds'),
                                patch.object(pool, 'acquire', side_effect=self.real_acquire),
                            ):
                                stack.enter_context(mocked)
                            code = cli.main(['run', '--base', 'warm', *flags, '--', 'true'])
                        self.assertEqual(code, 93, err.getvalue())
                        self.assertIn("saved base 'torssh:warm'", err.getvalue())
                        self.assertLessEqual(clock[0] - 1000, 60 + pool.LOCK_WAIT_S)
                        self.assertGreaterEqual(health_probe.call_count, 2)
                        remote.assert_called_once()
                        local.assert_not_called()
                        execute.assert_not_called()
                        for table in ('pool_waiters', 'pool_pending', 'pool_cap_callers'):
                            self.assertEqual(self.cons['server'].execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0], 0)
                        self.assertEqual(self.cons['server'].execute("SELECT status FROM runs WHERE run_id='busy-run'").fetchone()[0], 'running')

    def test_healthy_named_base_keeps_its_queue_place_until_a_slot_frees(self):
        self.full_home_pool()
        con = self.cons['server']
        con.execute('UPDATE bases SET is_default=1')
        con.commit()
        for explicit in (True, False):
            with self.subTest(explicit=explicit):
                con.execute("INSERT OR REPLACE INTO runs(run_id,box_id,status,mode) VALUES ('busy-run','busy','running','fg')")
                con.commit()
                clock = [1000.0]
                seen_waiters = []
                def advance(seconds):
                    clock[0] += seconds
                    if clock[0] >= 1018:
                        con.execute("DELETE FROM runs WHERE run_id='busy-run'")
                        con.commit()
                def health():
                    seen_waiters.append(tuple(row[0] for row in con.execute('SELECT token FROM pool_waiters')))
                    return None
                fake_time = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=advance)
                got = []
                def remote(a, me):
                    row = pool.acquire(me, base=a.base)
                    got.append(row['box_id'])
                    pool.release_guard(row)
                    return 7
                with patch.object(home, 'probe', side_effect=health), \
                        patch.object(cli, 'time', fake_time), patch.object(pool, 'time', fake_time), \
                        patch.object(allocation, 'time', fake_time), \
                        patch.dict(os.environ, OFFBOX_POOL_SIZE='1', OFFBOX_POOL_WAIT_SECONDS='120'), \
                        patch.object(pool, '_refresh_background'), patch.object(pool, '_recheck_prune_holds'), \
                        patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)), \
                        patch.object(pool, 'acquire', side_effect=self.real_acquire), \
                        patch.object(cli, '_remote_once', side_effect=remote), \
                        contextlib.redirect_stderr(io.StringIO()):
                    args = ['--base', 'warm'] if explicit else []
                    self.assertEqual(cli.main(['run', *args, '--', 'true']), 7)
                self.assertEqual(got, ['busy'])
                self.assertEqual(seen_waiters[0], ())
                if explicit:
                    self.assertGreaterEqual(len(seen_waiters), 2)
                    self.assertEqual(len({token for sample in seen_waiters[1:] for token in sample}), 1)
                else:
                    self.assertEqual(len(seen_waiters), 1, 'implicit defaults retain preflight-only probing')

    def test_fresh_ignores_named_base_during_failover(self):
        self.add('server', 'warm')
        code, err, _, wait, _ = self.run_outage('--base', 'warm', '--fresh')
        self.assertEqual(code, 'exec', err)
        wait.assert_not_called()
        self.assertIsNone(self.decisions()[0]['props']['base'])

    def test_an_accepted_run_with_explicit_base_is_never_retried(self):
        self.add('server', 'warm')
        common.select_backend('server')
        error = api.NetworkError('unreachable after accept')
        error.started = True
        with patch.object(cli, '_remote_once', side_effect=error), \
                patch.object(outage, 'wait_until_up') as wait, \
                patch.object(os, 'execve') as execute, patch('offbox_lib.fallback.note_infra_failure'), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(['run', '--base', 'warm', '--', 'true']), 90)
        wait.assert_not_called()
        execute.assert_not_called()
        self.assertEqual(self.decisions(), [])

    def test_failover_decisions_reach_the_tool_log(self):
        self.add('server', 'warm', default=True)
        # Undo the fixture's emit mock: exercise the real event sanitizer and NDJSON sink.
        with patch.object(home.toollog, 'emit', self.real_emit), \
                patch.dict(os.environ, OFFBOX_TOOL_LOG_DIR=str(self.root / 'tool-logs')):
            self.assertEqual(self.run_outage('--base', 'warm')[0], 93)
            self.assertEqual(self.run_outage()[0], 'exec')
        events = [json.loads(line) for path in (self.root / 'tool-logs').glob('*.ndjson')
                  for line in path.read_text().splitlines()]
        decisions = [row for row in events if row['name'] == 'home.failover_decision']
        self.assertEqual([row['props']['decision'] for row in decisions], ['wait_explicit_base', 'boat'])
        self.assertEqual([row['props']['base'] for row in decisions], ['torssh:warm', None])

    def add(self, backend, short, *, repo='torssh', default=False, expired=None, owner='ardud', saved='snapshot'):
        self.cons[backend].execute('''INSERT INTO bases
            (name,repo_key,short,box_id,size,remote_dir,is_default,created_at,saved,expired_at,token_owner)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)''',
            (f'{repo}:{short}', repo, short, 'bx_' + short, 'default', 'w/repo', int(default), 100, saved, expired, owner))
        self.cons[backend].commit()

    def assert_no_allocations(self):
        for backend, con in self.cons.items():
            for table in ('runs', 'leases', 'pool_pending', 'pool_waiters', 'pool_callers'):
                self.assertEqual(con.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0], 0, (backend, table))

    def invoke(self, argv):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), patch.object(cli, 'cmd_run', return_value=0) as run:
            code = cli.main(argv)
        return code, err.getvalue(), run

    def test_boat_only_routes_with_reason_and_stderr_before_allocation(self):
        self.add('boat', 'skeleton')
        argv = ['run', '--base', 'torssh:skeleton', '--', 'true']
        self.assertEqual(common.entry_backend(argv), 'boat')
        self.assertEqual(common._BACKEND_REASON, 'boat-only-base')
        common.select_backend('boat')
        code, err, run = self.invoke(argv)
        self.assertEqual(code, 0)
        run.assert_called_once()
        self.assertIn('running on Boat because base', err)
        self.assertTrue(any('backend=boat reason=boat-only-base' in line for line in self.logs))
        request = next(call for call in self.events.call_args_list if call.args[:2] == ('run', 'run.request'))
        self.assertEqual(request.kwargs['props']['reason'], 'boat_only_base')
        self.assert_no_allocations()

    def test_boat_base_runs_without_claiming_a_home_outage(self):
        self.add('boat', 'skeleton')
        argv = ['run', '--base', 'torssh:skeleton', '--', 'true']
        common.select_backend(common.entry_backend(argv))
        err = io.StringIO()
        with contextlib.redirect_stderr(err), patch.object(cli, '_remote_once', return_value=0) as remote:
            self.assertEqual(cli.main(argv), 0)
        remote.assert_called_once()
        self.assertEqual(len(err.getvalue().splitlines()), 1)
        self.assertIn('running on Boat because base', err.getvalue())
        self.assertNotIn('down', err.getvalue())
        self.assertFalse(any(call.args[:2] == ('backend', 'backend.failover') for call in self.events.call_args_list))
        self.assert_no_allocations()

    def test_home_startup_checks_cannot_block_or_fail_over_a_boat_base_run(self):
        self.add('boat', 'skeleton')
        argv = ['run', '--base', 'torssh:skeleton', '--', 'true']
        common.select_backend(common.entry_backend(argv))
        self.assertEqual(common.backend(), 'boat')
        self.assertEqual(common._BACKEND_REASON, 'boat-only-base')
        self.assertFalse(home.may_fail_over())
        err = io.StringIO()
        # A selected Boat run must not inspect home startup state or make a home request, even if those paths fail.
        with patch.object(home, 'recent_failure', side_effect=AssertionError('read home startup state')), \
                patch.object(home, 'probe', side_effect=AssertionError('probed home health')), \
                patch.object(api, 'probe_backend', side_effect=AssertionError('probed home API')), \
                patch.object(home, 'fail_over', side_effect=AssertionError('failed over a Boat run')), \
                patch.object(cli, '_remote_once', return_value=0) as remote, contextlib.redirect_stderr(err):
            home.before_run(argv)
            self.assertEqual(cli.main(argv), 0)
        remote.assert_called_once()
        self.assertEqual(len(err.getvalue().splitlines()), 1)
        self.assertIn('running on Boat because base', err.getvalue())
        self.assertFalse(any(call.args[:2] == ('backend', 'backend.failover') for call in self.events.call_args_list))
        self.assert_no_allocations()

    def test_forwarded_base_is_validated_before_allocation_safety_net(self):
        self.add('server', 'warm')
        argv = ['run', '--base', 'torssh:warm', '--', 'true']
        with patch.dict(os.environ, OFFBOX_BACKEND='boat', OFFBOX_FAILOVER='unreachable'):
            common.select_backend(common.entry_backend(argv))
            code, err, run = self.invoke(argv)
            self.assertEqual((code, err), (0, ''))
            run.assert_called_once()
            self.assertTrue(home.only_on_home('bases', 'name=?', ('torssh:warm',)))
        self.assert_no_allocations()

    def test_legacy_owner_forms_match_backfill_without_writing(self):
        cases = [(None, None, 'ardud'), ('', None, 'ardud'), ('thread:abc', None, 'ardud'),
                 ('person:moni', None, 'moni'), ('person:moni-alt', None, 'moni-alt'),
                 ('person:moni_2', None, 'moni_2'), ('person:', None, 'ardud'),
                 ('person:../moni', None, 'ardud'), ('person:a b', None, 'ardud'),
                 ('person:moni', 'ardud', 'ardud'), ('thread:abc', 'moni', 'moni')]
        for i, (created_by, recorded, want) in enumerate(cases):
            self.add('server', f'b{i}', owner=recorded)
            self.cons['server'].execute('UPDATE bases SET created_by=? WHERE short=?', (created_by, f'b{i}'))
        self.cons['server'].commit()
        for owner in ('ardud', 'moni', 'moni-alt', 'moni_2'):
            with self.subTest(owner=owner), patch.dict(os.environ, OFFBOX_THREAD='person:' + owner):
                actual = {r['short'] for r in base_catalog.rows('server')}
                self.assertEqual(actual, {f'b{i}' for i, (_, _, want) in enumerate(cases) if want == owner})
        stored = self.cons['server'].execute('SELECT token_owner FROM bases ORDER BY created_at, name').fetchall()
        self.assertEqual(sum(r[0] is None for r in stored), 9)

    def test_fresh_process_binds_api_and_database_after_base_routing(self):
        self.add('boat', 'skeleton')
        program = """
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from offbox_lib import common
common.STATE = Path(sys.argv[2])
common.SERVER_CFG = common.STATE / 'server.json'
common.BACKEND_PATH = common.STATE / 'backend'
common.BACKEND_STATE = common.STATE / 'backend-state.json'
common.select_backend(common.entry_backend(['run', '--base=torssh:skeleton', '--', 'true']))
from offbox_lib import api, capacity
print(json.dumps([common.backend(), api.BACKEND, common.DB_PATH.name]))
"""
        result = subprocess.run([sys.executable, '-I', '-c', program, str(SCRIPTS), str(self.root)],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), ['boat', 'boat', 'offbox.db'])
        self.assert_no_allocations()

    def test_home_only_and_both_keep_home_choice(self):
        self.add('server', 'warm')
        argv = ['run', '--base', 'torssh:warm', '--', 'true']
        self.assertEqual(common.entry_backend(argv), 'server')
        self.add('boat', 'warm')
        self.assertEqual(common.entry_backend(argv), 'server')
        self.assertIsNone(common._BACKEND_REASON)
        common.select_backend('server')
        self.assertEqual(self.invoke(argv)[0:2], (0, ''))
        self.assert_no_allocations()

    def test_argument_forms_match_the_run_parser(self):
        self.add('boat', 'skeleton')
        self.add('server', 'warm')
        # Option values, separator, abbreviation and repeated flags belong to one input class.
        forms = [
            (['--base', 'torssh:skeleton', '--', 'true'], 'boat'),
            (['--base=torssh:skeleton', '--', 'true'], 'boat'),
            (['--bas', 'skeleton', '--', 'true'], 'boat'),
            (['--bas=skeleton', '--', 'true'], 'boat'),
            (['--base', 'skeleton', '--base', 'warm', '--', 'true'], 'server'),
            (['--base', 'warm', '--base=skeleton', '--', 'true'], 'boat'),
            (['--base', 'skeleton', '--fresh', '--', 'true'], 'server'),
            (['--', 'echo', '--base', 'skeleton'], 'server'),
            (['echo', '--base', 'skeleton'], 'server'),
            (['--step', 'echo --base skeleton'], 'server'),
            (['--env', 'X=--base=skeleton', '--', 'true'], 'server'),
        ]
        for args, want in forms:
            with self.subTest(args=args):
                self.assertEqual(common.entry_backend(['run', *args]), want)
        self.assert_no_allocations()

    def test_pins_and_person_work_do_not_route_to_boat(self):
        self.add('boat', 'skeleton')
        argv = ['run', '--base', 'torssh:skeleton', '--', 'true']
        with patch.dict(os.environ, OFFBOX_BACKEND='server'):
            common.select_backend(common.entry_backend(argv))
            code, err, run = self.invoke(argv)
            self.assertEqual(code, 2)
            self.assertIn('exists only on boat standby', err)
            self.assertIn('pinned home backend has no copy', err)
            run.assert_not_called()
        with patch.dict(os.environ, OFFBOX_THREAD='person:moni'):
            self.assertEqual(common.entry_backend(argv), 'server')
            self.assertEqual(base_catalog.rows('boat'), [])
        self.assert_no_allocations()

    def test_unknown_lists_both_backends_and_default_with_no_pending_rows(self):
        self.add('server', 'toolchain-home', default=True)
        self.add('boat', 'skeleton')
        self.add('boat', 'expired', expired=1, saved=None)
        self.add('boat', 'unrelated', repo='other')
        self.add('server', 'private', owner='moni')
        argv = ['run', '--base', 'torssh:missing', '--', 'true']
        common.select_backend(common.entry_backend(argv))
        # Validation must finish before the run/pool code can open a writable DB.
        with patch.object(cli, 'db', side_effect=AssertionError('no writable DB on refusal')):
            code, err, run = self.invoke(argv)
        self.assertEqual(code, 2)
        self.assertIn("no saved base 'torssh:missing'", err)
        self.assertIn('toolchain-home (home, default)', err)
        self.assertIn('skeleton (boat standby)', err)
        for hidden in ('expired', 'unrelated', 'private'):
            self.assertNotIn(hidden, err)
        run.assert_not_called()
        self.assert_no_allocations()

    def test_empty_repo_and_expired_boat_base_are_missing(self):
        self.add('boat', 'expired', expired=0, saved=None)
        for name in ('torssh:expired', 'empty:missing'):
            argv = ['run', '--base', name, '--', 'true']
            common.select_backend(common.entry_backend(argv))
            self.assertEqual(common.backend(), 'server')
            code, err, run = self.invoke(argv)
            self.assertEqual(code, 2)
            self.assertIn('Saved bases for ' + name.split(':')[0] + ': none.', err)
            run.assert_not_called()
        self.assert_no_allocations()

    def test_expiry_forms_preserve_kept_snapshots_and_hide_expired_disks(self):
        cases = [(None, None, True), (None, 'snapshot', True),
                 (100, None, False), (0, None, False), (100, 'snapshot', True)]
        for i, (expired, saved, usable) in enumerate(cases):
            self.add('boat', f'b{i}', expired=expired, saved=saved)
        self.assertEqual({r['short'] for r in base_catalog.rows('boat')},
                         {f'b{i}' for i, (_, _, usable) in enumerate(cases) if usable})
        self.assertEqual(len(base_catalog.rows('boat', include_expired=True)), len(cases))
        argv = ['run', '--base', 'torssh:b4', '--', 'true']
        self.assertEqual(common.entry_backend(argv), 'boat')
        self.add('server', 'b4', expired=100, saved='home-snapshot')
        self.assertEqual(common.entry_backend(argv), 'server')
        self.assert_no_allocations()

    def test_errors_bound_the_list_to_eight_names(self):
        for i in range(10):
            self.add('boat', f'b{i}')
        message = str(base_catalog.missing('torssh:no'))
        self.assertEqual(message.count('(boat standby)'), 8)
        self.assertIn('2 more (offbox bases)', message)

    def test_catalog_is_read_only_and_does_not_create_missing_database(self):
        before = {name: con.total_changes for name, con in self.cons.items()}
        self.assertEqual(base_catalog.all_rows(), [])
        self.assertEqual(before, {name: con.total_changes for name, con in self.cons.items()})
        with patch.object(common, 'STATE', self.root / 'missing'):
            self.assertEqual(base_catalog.all_rows(), [])
            self.assertFalse((self.root / 'missing').exists())

    def test_unreadable_catalog_fails_closed(self):
        with patch.object(base_catalog.sqlite3, 'connect', side_effect=sqlite3.OperationalError('locked')):
            with self.assertRaises(common.OffboxError) as raised:
                common.entry_backend(['run', '--base', 'torssh:skeleton', '--', 'true'])
        self.assertEqual(raised.exception.code, common.EXIT_LOCAL)
        self.assert_no_allocations()

    def test_secondary_listing_failures_preserve_both_backends_from_metadata(self):
        self.add('server', 'warm', default=True)
        self.add('boat', 'skeleton')
        self.add('boat', 'boxonly', saved=None)
        self.add('boat', 'expired', expired=1, saved=None)
        common.select_backend('server')
        failures = [subprocess.TimeoutExpired(['offbox'], 15), OSError('cannot spawn'),
                    subprocess.CompletedProcess([], 2, '', 'down'),
                    subprocess.CompletedProcess([], 0, '{bad json', ''),
                    subprocess.CompletedProcess([], 0, '{}', ''),
                    subprocess.CompletedProcess([], 0, '[{}]', '')]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), patch.object(bases.subprocess, 'run') as child:
                if isinstance(failure, Exception):
                    child.side_effect = failure
                else:
                    child.return_value = failure
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    bases.list_bases(True)
                rows = {r['name']: r for r in json.loads(out.getvalue())}
                self.assertEqual(set(rows), {'torssh:warm', 'torssh:skeleton', 'torssh:boxonly'})
                self.assertEqual(rows['torssh:boxonly']['status'], 'unknown')
                self.assertEqual(rows['torssh:boxonly']['backend'], 'boat standby')
                self.assertIn('showing saved metadata', err.getvalue())
        self.assert_no_allocations()

    def test_partial_child_rows_never_discard_cached_table_output(self):
        self.add('server', 'warm', default=True)
        self.add('boat', 'skeleton')
        common.select_backend('server')
        row = {**base_catalog.rows('boat')[0], 'backend': 'boat standby', 'status': 'saved', 'data_until': None}
        for field in ('name', 'repo_key', 'box_id', 'is_default', 'size', 'size_bytes',
                      'created_at', 'note', 'status', 'data_until', 'backend'):
            with self.subTest(missing=field):
                partial = {k: v for k, v in row.items() if k != field}
                result = subprocess.CompletedProcess([], 0, json.dumps([partial]), '')
                out = io.StringIO()
                with patch.object(bases.subprocess, 'run', return_value=result), \
                        contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                    bases.list_bases(False)
                self.assertIn('torssh:warm', out.getvalue())
                self.assertIn('torssh:skeleton', out.getvalue())
                self.assertIn('boat standby', out.getvalue())

    def test_cached_expiry_status_survives_child_failure_with_all(self):
        self.add('server', 'warm')
        self.add('boat', 'expired', expired=100, saved=None)
        self.add('boat', 'kept', expired=100, saved='snapshot')
        self.add('boat', 'boxonly', saved=None)
        common.select_backend('server')
        out = io.StringIO()
        with patch.object(bases.subprocess, 'run', side_effect=subprocess.TimeoutExpired(['offbox'], 15)), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            bases.list_bases(True, include_expired=True)
        rows = {r['name']: r for r in json.loads(out.getvalue())}
        self.assertEqual(rows['torssh:expired']['status'], 'expired')
        self.assertEqual(rows['torssh:expired']['data_until'], 100)
        self.assertEqual(rows['torssh:kept']['status'], 'saved')
        self.assertEqual(rows['torssh:boxonly']['status'], 'unknown')

    def test_bases_lists_both_backends_and_preserves_json_fields(self):
        self.add('server', 'warm', default=True)
        self.add('boat', 'skeleton')
        self.add('boat', 'expired', expired=1, saved=None)
        common.select_backend('server')
        def child(argv, *, env, **kwargs):
            self.assertEqual(env['OFFBOX_BACKEND'], 'boat')
            self.assertEqual(env['OFFBOX_BASES_CHILD'], '1')
            with patch.object(common, '_BACKEND', 'boat'):
                rows = bases._local_base_rows('--all' in argv)
            return subprocess.CompletedProcess(argv, 0, json.dumps(rows), '')
        for all_flag in (False, True):
            with self.subTest(all=all_flag), patch.object(bases.subprocess, 'run', side_effect=child):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    bases.list_bases(False, include_expired=all_flag)
                text = out.getvalue()
                self.assertIn('torssh:warm', text)
                self.assertIn('*default', text)
                self.assertIn('home', text)
                self.assertIn('boat standby', text)
                self.assertEqual('torssh:expired' in text, all_flag)
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    bases.list_bases(True, include_expired=all_flag)
                rows = json.loads(out.getvalue())
                self.assertEqual({r['backend'] for r in rows}, {'home', 'boat standby'})
                self.assertEqual(len(rows), 3 if all_flag else 2)
                for r in rows:
                    self.assertTrue({'name', 'box_id', 'saved', 'status', 'data_until', 'is_default'} <= r.keys())
        self.assertTrue(cli.build_parser().parse_args(['bases', '--all', '--json']).all)


if __name__ == '__main__':
    unittest.main()
