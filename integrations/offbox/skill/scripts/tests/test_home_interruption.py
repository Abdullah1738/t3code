"""Home interruption evidence survives follow, settlement and later reads without releasing live runs."""
import contextlib
import io
import json
import threading
from unittest.mock import patch

from test_capacity import Isolated
from offbox_lib import allocation, api, common, lease, misc, reap, runs


class HomeInterruptionTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, 'BACKEND', 'server'))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(runs, 'settle_docker'))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'running'}))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.stack.enter_context(patch.object(api, 'history_logs', side_effect=lambda b, c, s, o, **kw:
                                             dict(data='', nextOffset=o, size=o, done=True)))
        self.box('bx_home')
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,owner,start_at) "
                         "VALUES ('run-home','bx_home','cmd_42',42,'running','bg','worker',?)", (common.now(),))
        self.con.commit()
        self.path = runs.LOGS_DIR / 'run-home.log'
        self.info = dict(cause='incus_exec_dropped', phase='running', attempt=1, retry=False,
                         leftover_killed=2, cleanup='stopped', box_rc=None,
                         message='Incus exec disconnected', reason='exec_disconnected', stream_state='unknown')

    def saved(self):
        return json.loads((runs.LOGS_DIR / 'run-home.state.json').read_text())

    def follow(self):
        stop = threading.Event()
        stop.wait = lambda timeout=None: stop.is_set()
        return runs.follow('bx_home', 42, self.path, echo=False, run_id='run-home', stop_evt=stop)

    def test_exit_frame_keeps_interruption_and_partial_output(self):
        frames = [dict(type='stdout', data='half done\n'),
                  dict(type='exit', status='interrupted', exitCode=None, interruption=self.info)]
        with patch.object(api, 'cmd_attach', return_value=iter(frames)), self.assertRaises(runs.Interrupted) as cm:
            self.follow()
        self.assertEqual((cm.exception.code, cm.exception.started), (94, True))
        self.assertEqual(self.saved()['interruption'], self.info)
        self.assertEqual(self.path.read_text(), 'half done\n')
        self.assertIn('incus_exec_dropped', str(cm.exception))
        self.assertIn('ran partly', str(cm.exception))
        self.assertIn('cleanup: 2 stopped', str(cm.exception))
        self.assertNotIn('server restarted', str(cm.exception))

    def test_dropped_stream_status_reads_metrics_interruption(self):
        self.info.update(cleanup='unknown', leftover_killed=None, reason='box_unreadable')
        status = dict(status='interrupted', running=False, exitCode=None, metrics={'interruption': self.info})
        with patch.object(api, 'cmd_attach', side_effect=OSError('stream reset')), \
                patch.object(api, 'cmd_status', return_value=status), self.assertRaises(runs.Interrupted) as cm:
            self.follow()
        self.assertEqual(self.saved()['interruption'], self.info)
        self.assertIn('cleanup: unknown', str(cm.exception))
        self.assertEqual(cm.exception.code, 94)

    def test_reconnect_probe_maps_terminal_interruption_to_94(self):
        self.info.update(cleanup='clean', leftover_killed=0)
        status = dict(status='interrupted', running=False, exitCode=None, interruption=self.info)
        with patch.object(api, 'cmd_attach', return_value=iter([dict(type='reconnect')])), \
                patch.object(api, 'cmd_status', return_value=status), self.assertRaises(runs.Interrupted) as cm:
            self.follow()
        self.assertIn('cleanup: clean', str(cm.exception))
        self.assertEqual(self.saved()['interruption'], self.info)
        self.assertEqual(runs._status_code(status), 94)

    def test_wait_retains_evidence_and_later_wait_and_logs_explain_it(self):
        frames = [dict(type='stdout', data='partial output\n'),
                  dict(type='exit', status='interrupted', exitCode=None, metrics={'interruption': self.info})]
        with patch.object(api, 'cmd_attach', return_value=iter(frames)), self.assertRaises(runs.Interrupted):
            misc.wait('run-home', None)
        row = misc._run_row('run-home')
        self.assertEqual((row['status'], row['exit_code']), ('interrupted', 94))
        self.assertEqual(row['interruption'], self.info)
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait('run-home', None), 94)
            self.assertEqual(misc.logs('run-home', False), 0)
        self.assertEqual(self.saved()['interruption'], self.info)
        self.assertEqual(err.getvalue().count('incus_exec_dropped'), 2)
        self.assertEqual(err.getvalue().count('cleanup: 2 stopped'), 2)

    def test_reattached_running_status_keeps_following_to_the_real_exit(self):
        self.info.update(stream_state='reattached', cleanup='unknown', leftover_killed=None)
        status = dict(status='running', running=True, exitCode=None, interruption=self.info)
        attaches = 0
        def attach(*args, **kwargs):
            nonlocal attaches
            attaches += 1
            self.assertEqual(lease.active_runs(self.con, 'bx_home'), 1)
            if attaches == 1:
                yield dict(type='hello', **status)
                raise OSError('stream reset')
            self.assertEqual(self.saved()['interruption'], self.info)
            yield dict(type='stdout', data='finished\n')
            yield dict(type='exit', status='exited', exitCode=7)
        with patch.object(api, 'cmd_attach', side_effect=attach), patch.object(api, 'cmd_status', return_value=status):
            self.assertEqual(self.follow(), 7)
        self.assertEqual(attaches, 2)
        self.assertEqual(self.path.read_text(), 'finished\n')
        self.assertEqual(lease.active_runs(self.con, 'bx_home'), 1, 'follow leaves settlement to its caller')

    def test_terminal_frame_without_details_does_not_erase_prior_evidence(self):
        runs.remember_interruption('run-home', {'metrics': {'interruption': self.info}})
        frames = [dict(type='exit', status='interrupted', exitCode=None)]
        with patch.object(api, 'cmd_attach', return_value=iter(frames)), self.assertRaises(runs.Interrupted):
            misc.wait('run-home', None)
        self.assertEqual(self.saved()['interruption'], self.info)
        self.assertEqual(misc._run_row('run-home')['exit_code'], 94)

    def test_reattached_running_status_is_held_even_with_a_stale_stopped_box(self):
        self.info.update(stream_state='reattached', cleanup='unknown', leftover_killed=None)
        status = dict(status='running', running=True, exitCode=None, metrics={'interruption': self.info})
        for state in ('running', 'archived'):
            with self.subTest(state=state), patch.object(api, 'cmd_status', return_value=status):
                reap._check_stale_runs(self.con, 'bx_home', state, False, [])
                self.assertEqual(lease.active_runs(self.con, 'bx_home'), 1)
                self.assertEqual(self.saved()['interruption'], self.info)
                self.assertIsNone(runs._ended('bx_home', 42, None, 'run-home'))

    def test_reaper_retains_terminal_interruption_on_running_and_stopped_boxes(self):
        status = dict(status='interrupted', running=False, exitCode=None, interruption=self.info)
        for state in ('running', 'archived'):
            self.con.execute("UPDATE runs SET status='running',exit_code=NULL,end_at=NULL")
            self.con.commit()
            with self.subTest(state=state), patch.object(api, 'cmd_status', return_value=status):
                reap._check_stale_runs(self.con, 'bx_home', state, False, [])
                row = misc._run_row('run-home')
                self.assertEqual((row['status'], row['exit_code']), ('interrupted', 94))
                self.assertEqual(row['interruption'], self.info)

    def test_history_catchup_keeps_metrics_interruption_for_later_reads(self):
        self.con.execute("UPDATE runs SET status='interrupted',exit_code=94")
        self.con.commit()
        def page(b, c, stream, offset, **kwargs):
            data = 'partial\n' if stream == 'stdout' and not offset else ''
            return dict(data=data, nextOffset=offset+len(data), size=offset+len(data), done=True,
                        metrics={'interruption': self.info})
        err = io.StringIO()
        with patch.object(api, 'history_logs', side_effect=page), contextlib.redirect_stderr(err), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.wait('run-home', None), 94)
        self.assertEqual(self.saved()['interruption'], self.info)
        self.assertIn('incus_exec_dropped', err.getvalue())
        self.assertIn('cleanup: 2 stopped', err.getvalue())

    def test_later_cleanup_is_reported_without_overwriting_interruption_evidence(self):
        self.info.update(cleanup='unknown', leftover_killed=None)
        runs.remember_interruption('run-home', {'interruption': self.info})
        self.con.execute("UPDATE runs SET status='interrupted',exit_code=94")
        self.con.commit()
        cleanup = dict(cleanup='stopped', leftover_killed=3, remaining=0)
        err = io.StringIO()
        with patch.object(api, 'cmd_kill', return_value={'cleanup': cleanup}), contextlib.redirect_stderr(err), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(misc.kill_run('run-home'), 0)
            self.assertEqual(misc.wait('run-home', None), 94)
        self.assertEqual(self.saved()['interruption'], self.info)
        self.assertEqual(self.saved()['cleanup'], cleanup)
        self.assertIn('cleanup: 3 stopped', err.getvalue())
        self.assertNotIn('cleanup: unknown', err.getvalue())

    def test_server_hold_fences_cached_pool_reuse_even_after_local_settlement(self):
        self.con.execute("UPDATE runs SET status='failed',exit_code=1")
        self.con.commit()
        row=self.con.execute("SELECT * FROM leases WHERE box_id='bx_home'").fetchone()
        with patch.object(api,'get',return_value=dict(state='running',heldRuns=['run-home'])):
            with self.assertRaises(allocation.Busy):
                lease._reuse(self.con,row,None)
