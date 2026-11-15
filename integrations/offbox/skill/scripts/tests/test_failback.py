"""Queue-only return from the Boat standby; all elapsed time and home answers are injected."""
import contextlib
import io
import os
from pathlib import Path
import sqlite3
import inspect
import json
import threading
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import allocation, api, cli, common, home, lease, misc, outage, pool, runs
from test_capacity import Isolated


class Clock:
    def __init__(self):
        self.t = 1000.
        self.time = types.SimpleNamespace(monotonic=lambda: self.t, sleep=self.sleep)

    def sleep(self, seconds):
        self.t += seconds


class FailbackTests(Isolated):
    guard_home_failover = False
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.dict(os.environ, {home.FAILOVER_ENV: 'home unreachable',
                                                       'OFFBOX_POOL_WAIT_SECONDS': '600'}))
        self.stack.enter_context(patch.object(home, 'active', return_value=False))
        self.stack.enter_context(patch.object(home, "BOAT_SELECTED", home.contextvars.ContextVar("selected", default=False)))
        self.clock = Clock()
        self.stack.enter_context(patch.object(pool, 'time', self.clock.time))
        self.stack.enter_context(patch.object(home, 'PROBE_FACTS', home.contextvars.ContextVar('test_probe', default={})))
        self.output = io.StringIO()
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        self.events = self.stack.enter_context(patch('toollog.emit'))

    def acquire_through_cli(self):
        args = cli.build_parser().parse_args(['run', '--', 'true'])
        with patch.object(cli, '_remote_once', side_effect=lambda *a: pool.acquire(self.me, run_id='mine')):
            return cli._run_with_retries(args, self.me)

    def full_pool(self):
        for bid in ('one', 'two'):
            self.box(bid, member=True)
            self.busy(bid)

    def pending(self, run='mine'):
        self.con.execute("INSERT INTO runs(run_id,status,mode,client_pid) VALUES (?,'starting','bg',?)",
                         (run, os.getpid()))
        self.con.commit()

    def home_paths(self):
        home_path = Path(self.tmp.name) / 'home.sqlite'
        self.stack.enter_context(patch.object(common, 'db_path_for', side_effect=lambda b:
                                             common.DB_PATH if b == 'boat' else home_path))
        return home_path

    def test_ready_at_60_unwinds_and_execs_home_with_same_id(self):
        self.full_pool()
        self.pending()
        home_path = self.home_paths()
        self.stack.enter_context(patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: ''}))
        checks = []
        def probe(**kwargs):
            checks.append((self.clock.t, kwargs))
            return None if self.clock.t >= 1060 else 'no answer'
        with patch.object(home, 'probe', side_effect=probe), patch.object(os, 'execve', side_effect=SystemExit) as execute, \
                patch.object(lease, 'acquire_private') as acquire, patch.object(sys, 'argv', ['offbox.py', 'run', '--', 'true']):
            with self.assertRaises(SystemExit):
                self.acquire_through_cli()
        self.assertEqual([t for t, _ in checks], [1030, 1060])
        self.assertTrue(all(k == dict(timeout=3., wait=False) for _, k in checks))
        self.assertEqual(execute.call_args.args[1][2:], ['run', '--', 'true'])
        env = execute.call_args.args[2]
        self.assertEqual(env['OFFBOX_BACKEND'], 'server')
        self.assertEqual(env[home.RETURNED_HOME_ENV], 'home unreachable')
        self.assertNotIn(home.FAILOVER_ENV, env)
        self.assertEqual(env[home.RUN_ID_ENV], 'mine')
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 0)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_pending').fetchone()[0], 0)
        self.assertEqual(self.con.execute("SELECT status,error FROM runs WHERE run_id='mine'").fetchone()[:],
                         ('forwarded', 'server'))
        with contextlib.closing(sqlite3.connect(home_path)) as con, con:
            self.assertEqual(con.execute("SELECT run_id,status FROM runs").fetchone(), ('mine', 'starting'))
        acquire.assert_not_called()
        text = self.output.getvalue()
        self.assertEqual(text.count('goes back to home'), 1)
        self.assertEqual(text.count('no time limit'), 1)
        self.assertNotIn('600s', text)
        self.assertIn('goes back to home', (common.LOGS_DIR / 'mine.client.log').read_text())
        back = [c for c in self.events.call_args_list if c.args[:2] == ('backend', 'backend.failback')]
        self.assertEqual(len(back), 1)
        self.assertEqual(back[0].kwargs['duration_ms'], 60000)

    def test_home_down_for_three_hours_then_boat_box(self):
        self.full_pool()
        def sleep(seconds):
            self.clock.t += 30
            if self.clock.t >= 11800:
                self.con.execute("UPDATE runs SET status='done' WHERE box_id='one'")
                self.con.commit()
        self.clock.time.sleep = sleep
        with patch.object(home, 'probe', return_value='down') as probe, \
                patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)), \
                patch.object(home, 'fail_back') as back:
            row = pool.acquire(self.me, run_id='mine')
        try:
            self.assertEqual(row['box_id'], 'one')
            self.assertGreaterEqual(self.clock.t - 1000, 10800)
            self.assertGreater(probe.call_count, 300)
            back.assert_not_called()
            done = [c for c in self.events.call_args_list if c.args[:2] == ('backend', 'backend.failover_queue_done')]
            self.assertEqual(len(done), 1)
            self.assertEqual(done[0].kwargs['props']['outcome'], 'boat_box')
        finally:
            pool.release_guard(row)

    def test_home_down_for_two_hours_then_ready(self):
        self.full_pool()
        self.clock.time.sleep = lambda seconds: setattr(self.clock, 't', self.clock.t + 30)
        with patch.object(home, 'probe', side_effect=lambda **kw: None if self.clock.t >= 8200 else 'down'), \
                patch.object(home, 'fail_back', side_effect=SystemExit) as back:
            with self.assertRaises(SystemExit):
                self.acquire_through_cli()
        self.assertEqual(back.call_args.args[0].waited, 7200)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 0)

    def test_pinned_boat_has_600s_limit_and_no_home_checks(self):
        self.full_pool()
        with patch.dict(os.environ, {home.FAILOVER_ENV: ''}), patch.object(home, 'probe') as probe:
            with self.assertRaises(pool.PoolBusyError) as error:
                pool.acquire(self.me)
        self.assertEqual(error.exception.code, 92)
        self.assertEqual(self.clock.t, 1600)
        probe.assert_not_called()

    def test_boat_granted_before_home_recovers_never_checks_back(self):
        self.box('one', member=True)
        with patch.object(home, 'probe') as probe, patch.object(home, 'fail_back') as back, \
                patch.object(lease, '_reuse', side_effect=lambda c, r, s, **kw: dict(r)):
            row = pool.acquire(self.me)
        pool.release_guard(row)
        probe.assert_not_called()
        back.assert_not_called()

    def test_home_check_after_selection_is_disabled_even_if_preparation_is_slow(self):
        self.box('one', member=True)
        def reuse(c, r, s, **kw):
            with pool._lease_work():
                self.clock.t += 120
                return dict(r)
        with patch.object(home, 'probe') as probe, patch.object(lease, '_reuse', side_effect=reuse):
            row = pool.acquire(self.me)
        pool.release_guard(row)
        probe.assert_not_called()

    def test_no_later_pool_acquisition_can_return_after_a_boat_box_was_selected(self):
        self.full_pool()
        home.BOAT_SELECTED.set(True)
        self.clock.time.sleep = lambda seconds: (_ for _ in ()).throw(KeyboardInterrupt())
        with patch.object(home, 'probe') as probe:
            self.clock.t += 120
            with self.assertRaises(KeyboardInterrupt):
                pool.acquire(self.me)
        probe.assert_not_called()

    def test_person_run_is_never_failback_eligible(self):
        with patch.object(common, 'person', return_value='moni'):
            self.assertFalse(home.failed_over())
            with allocation.queue() as queue:
                self.assertEqual(queue['wait'], 600)

    def test_probe_cadence_override_and_starting_not_ready(self):
        self.full_pool()
        checks = []
        def probe(**kw):
            checks.append(self.clock.t)
            if self.clock.t >= 1045:
                raise KeyboardInterrupt
            return 'server says it cannot take runs (starting)'
        with patch.dict(os.environ, {'OFFBOX_FAILBACK_PROBE_S': '15'}), patch.object(home, 'probe', side_effect=probe):
            with self.assertRaises(KeyboardInterrupt):
                pool.acquire(self.me)
        self.assertTrue(all(b-a >= 15 for a, b in zip(checks, checks[1:])))
        self.assertIn('checking home every 15 s', self.output.getvalue())

    def test_long_waiter_is_preserved_by_sweep_and_interrupt_cleans_it(self):
        self.con.execute("INSERT INTO pool_waiters(pool_key,token,pid,queued_at) VALUES ('repo','old',?,?)",
                         (os.getpid(), common.now()-10800))
        self.assertEqual(len(pool._waiters(self.con, 'repo')), 1)
        self.full_pool()
        def stop(seconds):
            raise KeyboardInterrupt
        self.clock.time.sleep = stop
        with self.assertRaises(KeyboardInterrupt):
            pool.acquire(self.me, run_id='mine')
        self.assertEqual([r[0] for r in self.con.execute('SELECT token FROM pool_waiters')], ['old'])

    def test_full_pool_lock_keeps_waiting_and_can_return_home(self):
        real_lock = pool.file_lock
        @contextlib.contextmanager
        def lock(name, timeout=0):
            if name.startswith('pool-'):
                self.clock.t += timeout
                raise common.OffboxError('lock busy')
            with real_lock(name, timeout=timeout):
                yield
        with patch.object(pool, 'file_lock', side_effect=lock), patch.object(home, 'probe', return_value=None), \
                patch.object(home, 'fail_back', side_effect=SystemExit):
            with self.assertRaises(SystemExit):
                self.acquire_through_cli()
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 0)

    def test_no_outage_budget_clamps_failover_queue(self):
        with patch.object(outage, 'allocation_left', return_value=5), allocation.queue() as queue:
            self.assertEqual(queue['end'], float('inf'))

    def test_background_roundtrip_replaces_only_its_forwarded_home_row(self):
        self.pending()
        home_path = self.home_paths()
        home._forward_background('mine', 'boat', 'server')
        with contextlib.closing(sqlite3.connect(home_path)) as con, con:
            con.execute("UPDATE runs SET status='forwarded',error='boat'")
        self.con.execute("UPDATE runs SET status='starting',error=NULL WHERE run_id='mine'")
        home._forward_background('mine', 'boat', 'server')
        with contextlib.closing(sqlite3.connect(home_path)) as con, con:
            self.assertEqual(con.execute('SELECT status FROM runs').fetchone()[0], 'starting')
        for field in ('box_id', 'process_id'):
            with self.subTest(field=field):
                self.con.execute(f"UPDATE runs SET status='starting',{field}='possible' WHERE run_id='mine'")
                with self.assertRaisesRegex(common.OffboxError, 'possible start'):
                    home._forward_background('mine', 'boat', 'server')
                self.con.execute(f"UPDATE runs SET {field}=NULL WHERE run_id='mine'")

    def test_returned_foreground_runner_reuses_the_forwarded_starting_row(self):
        self.pending()
        self.con.execute("UPDATE runs SET mode='fg' WHERE run_id='mine'")
        args = cli.build_parser().parse_args(['run', '--', 'true'])
        with patch.dict(os.environ, {home.RETURNED_HOME_ENV: 'outage', home.RUN_ID_ENV: 'mine'}):
            runner = runs.Runner(args, self.me)
            runner.register_pending()
        self.assertEqual(runner.run_id, 'mine')
        self.assertTrue(runner.registered)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM runs').fetchone()[0], 1)

    def test_destination_must_be_the_matching_unstarted_forwarding_row(self):
        self.pending()
        home_path = self.home_paths()
        for status, error, box, pid in [('starting', None, None, None),
                                        ('forwarded', 'other', None, None),
                                        ('forwarded', 'boat', 'box', None),
                                        ('forwarded', 'boat', None, 12)]:
            with (self.subTest(status=status, error=error, box=box, pid=pid),
                  contextlib.closing(sqlite3.connect(home_path)) as con, con):
                common.ensure_schema(con)
                con.execute('DELETE FROM runs')
                con.execute('INSERT INTO runs(run_id,status,error,box_id,process_id) VALUES (?,?,?,?,?)',
                            ('mine', status, error, box, pid))
            with self.assertRaisesRegex(common.OffboxError, 'possible start'):
                home._forward_background('mine', 'boat', 'server')
            self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='mine'").fetchone()[0], 'starting')

    def test_background_return_passes_backend_and_same_id(self):
        self.pending()
        self.home_paths()
        with patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: 'mine'}), \
                patch.object(runs, 'forward_background', side_effect=SystemExit) as forward:
            with self.assertRaises(SystemExit):
                home.fail_back(home.FailbackReady('mine', 60, dict(place=1, waiting=2)), ['run'])
        self.assertEqual(forward.call_args.kwargs, {'backend': 'server'})
        self.assertEqual(forward.call_args.args[0][runs.BACKGROUND_RUN_ENV], 'mine')

    def test_return_marker_prevents_ping_pong_and_waits_on_home(self):
        args = cli.build_parser().parse_args(['run', '--', 'true'])
        failure = common.OffboxError('home down again', outage=True)
        with patch.dict(os.environ, {home.RETURNED_HOME_ENV: 'previous outage'}), \
                patch.object(home, 'active', return_value=True), patch.object(common, 'backend_pinned', return_value=None), \
                patch.object(home, 'preflight_reason') as preflight, \
                patch.object(home, 'fail_over', wraps=home.fail_over) as failover, \
                patch.object(cli, '_remote_once', side_effect=[failure, 0]), patch.object(cli.time, 'sleep') as sleep:
            self.assertFalse(home.may_fail_over())
            self.assertFalse(home.fail_over('down', ['run']))
            self.assertEqual(cli._run_with_retries(args, self.me), 0)
            preflight.assert_not_called()
            failover.assert_called_once()  # direct guard call above only
            sleep.assert_called_once_with(30)

    def test_wait_and_status_use_durable_failover_queue_marker(self):
        self.pending()
        self.con.execute("INSERT INTO kv(k,v) VALUES ('failover_queue:mine','1')")
        row = self.con.execute("SELECT * FROM runs WHERE run_id='mine'").fetchone()
        self.assertIn('queued on Boat, waiting for a box or home', misc._not_started(row))

    def test_real_failover_logs_both_preflight_and_post_time_routing(self):
        self.home_paths()
        for run_id in ('probe-id', 'post-id'):
            with self.subTest(run_id=run_id), patch.dict(os.environ, {home.ROUTING_ENV: '[]'}), \
                    patch.object(api, 'probe_backend', return_value=None), \
                    patch.object(os, 'execve', side_effect=SystemExit):
                if run_id == 'post-id':
                    self.pending(run_id)
                with self.assertRaises(SystemExit):
                    home.fail_over('server says it cannot take runs (not ready)', ['run', '--', 'true'], run_id)
                first = (common.LOGS_DIR / f'{run_id}.client.log').read_text().splitlines()[0]
                self.assertIn('server says it cannot take runs', first)
                self.assertIn('this run goes to Boat instead', first)

    def test_returned_foreground_outage_keeps_the_same_row_pending(self):
        self.pending()
        self.con.execute("UPDATE runs SET mode='fg' WHERE run_id='mine'")
        args = cli.build_parser().parse_args(['run', '--', 'true'])
        seen = []
        def start(runner):
            runner.register_pending()
            runner.require_pending(self.con)
            seen.append(runner.run_id)
            if len(seen) == 1:
                raise common.OffboxError('home down', outage=True, run_id=runner.run_id)
            raise SystemExit('pending again')
        with patch.dict(os.environ, {home.RETURNED_HOME_ENV: 'outage', home.RUN_ID_ENV: 'mine'}), \
                patch.object(home, 'active', return_value=True), patch.object(runs.Runner, 'start', start), \
                patch.object(cli.time, 'sleep'):
            with self.assertRaisesRegex(SystemExit, 'pending again'):
                cli._run_with_retries(args, self.me)
        self.assertEqual(seen, ['mine', 'mine'])
        row = self.con.execute("SELECT * FROM runs WHERE run_id='mine'").fetchone()
        self.assertEqual(row['status'], 'starting')
        self.assertEqual(runs.restore_run_state(row)['status'], 'starting')

    def test_background_handoff_unwinds_old_runner_before_acknowledging_child(self):
        self.full_pool()
        self.pending()
        args = cli.build_parser().parse_args(['run', '--bg', '--', 'true'])
        def start(runner):
            runner.register_pending()
            pool.acquire(self.me, run_id=runner.run_id)
        def handoff(*args):
            self.assertFalse({'_run_attempt', '_run_remote'} & {f.function for f in inspect.stack()})
            self.con.execute("UPDATE runs SET client_pid=? WHERE run_id='mine'", (os.getpid()+1000,))
            raise KeyboardInterrupt  # pending signal delivered after the child accepts the handoff
        with patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: 'mine'}), \
                patch.object(runs.Runner, 'start', start), patch.object(home, 'probe', return_value=None), \
                patch.object(home, 'fail_back', side_effect=handoff):
            self.assertEqual(runs.background_client(args, self.me), 130)
        self.assertEqual(self.con.execute("SELECT status FROM runs WHERE run_id='mine'").fetchone()[0], 'starting')

    def test_pinned_box_observation_does_not_disable_return(self):
        with allocation.queue(), patch.object(lease, '_resume_confirmed', return_value=(None, None)):
            pool._reconcile_pinned(self.con, {'box_id': 'unrelated'})
        self.assertFalse(home.BOAT_SELECTED.get())
        self.full_pool()
        with patch.object(home, 'probe', return_value=None), patch.object(home, 'fail_back', side_effect=SystemExit):
            with self.assertRaises(SystemExit):
                self.acquire_through_cli()
        failures = [c for c in self.events.call_args_list if c.args[:2] == ('pool', 'run.lease')
                    and (c.kwargs.get('ok') is False or c.kwargs.get('tag'))]
        self.assertEqual(failures, [])

    def test_opposite_handoffs_serialize_before_taking_database_writers(self):
        self.pending('down')
        boat_path = common.DB_PATH
        home_path = Path(self.tmp.name) / 'opposite-home.sqlite'
        with contextlib.closing(sqlite3.connect(home_path)) as con, con:
            common.ensure_schema(con)
            con.execute("INSERT INTO runs(run_id,status) VALUES ('up','starting')")
        entered, attempted, release = threading.Event(), threading.Event(), threading.Event()
        forward, lock = home._forward_queued, common.file_lock
        errors = []
        def transfer(*args):
            try:
                home._forward_background(*args)
            except BaseException as error:
                errors.append(error)
        def queued(*args):
            if args[0] == 'up':
                entered.set()
                if not release.wait(5):
                    raise AssertionError('test did not release first handoff')
            forward(*args)
        @contextlib.contextmanager
        def locking(name, **kwargs):
            if threading.current_thread().name == 'down':
                attempted.set()
            with lock(name, **kwargs):
                yield
        with patch.object(common, 'DB_PATH', home_path), \
                patch.object(common, 'db_path_for', side_effect=lambda b: home_path if b == 'server' else boat_path), \
                patch.object(home, '_forward_queued', side_effect=queued), patch.object(common, 'file_lock', locking):
            up = threading.Thread(target=transfer, args=('up', 'server', 'boat'))
            down = threading.Thread(name='down', target=transfer, args=('down', 'boat', 'server'))
            up.start()
            try:
                self.assertTrue(entered.wait(5))
                down.start()
                self.assertTrue(attempted.wait(5))
            finally:
                release.set()
                up.join(5)
                if down.ident:
                    down.join(5)
            self.assertFalse(up.is_alive() or down.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.con.execute("SELECT status,error FROM runs WHERE run_id='down'").fetchone()[:],
                         ('forwarded', 'server'))
        with contextlib.closing(sqlite3.connect(home_path)) as con:
            self.assertEqual(con.execute("SELECT status,error FROM runs WHERE run_id='up'").fetchone(),
                             ('forwarded', 'boat'))
            self.assertEqual(con.execute("SELECT status FROM runs WHERE run_id='down'").fetchone()[0], 'starting')

    def test_routing_is_first_line_for_preflight_and_post_time_ids(self):
        for run_id in ('preflight', 'post'):
            with self.subTest(run_id=run_id), patch.dict(os.environ, {home.ROUTING_ENV: '[]'}):
                line = 'home offbox server not reachable (server says it cannot take runs); this run goes to Boat instead'
                home.routing_line(line, run_id)
                # A registered fg attempt currently gets a new Boat id (#176); carry its decision over too.
                home.flush_routing(run_id+'-boat')
                for target in (run_id, run_id+'-boat'):
                    self.assertEqual((common.LOGS_DIR / f'{target}.client.log').read_text().splitlines(), ['offbox: '+line])


class BoundedProbeTests(unittest.TestCase):
    def test_starting_slow_and_ready_reuse_live_probe_without_wait_or_retry(self):
        for data, ready in [({'ok': False, 'starting': True, 'phase': 'reconciling'}, False),
                            ('no answer (TimeoutError)', False), ({'ok': True}, True)]:
            with self.subTest(data=data), patch.object(home, '_health', return_value=data) as read, \
                    patch.object(home, 'begin_transient'), patch.object(home, 'note_home_answer'), \
                    patch.object(home, 'wait_while_starting') as wait, patch.object(home, 'tcp_connects') as tcp:
                self.assertEqual(home.probe(timeout=3, wait=False) is None, ready)
                read.assert_called_once_with(3, bounded=True)
                wait.assert_not_called()
                tcp.assert_not_called()

    def test_body_read_is_bounded_by_an_overall_deadline(self):
        wall = [1000.]
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self):
                wall[0] += 4  # a drip-fed body can outlast the per-socket timeout
                return b'{"ok": true}'
        with patch.object(home, 'health_url', return_value='http://fixture/health'), \
                patch.object(api, '_open', return_value=Response()), patch.object(api, '_shut_at'), \
                patch.object(api.time, 'time', side_effect=lambda: wall[0]):
            self.assertIn('TimeoutError', home._health(3, bounded=True))

    def test_failback_analytics_fields_survive_serialization(self):
        import toollog
        record = toollog._props({'reason': 'home unreachable', 'ok': False, 'waited_s': 7200,
                                 'outcome': 'boat_box'}, name='backend.failback')
        self.assertEqual(record, {'reason': 'home unreachable', 'ok': False, 'waited_s': 7200,
                                  'outcome': 'boat_box'})
        self.assertNotIn('reason', toollog._props({'reason': 'home unreachable'}, name='run.request'))


if __name__ == '__main__':
    unittest.main()
