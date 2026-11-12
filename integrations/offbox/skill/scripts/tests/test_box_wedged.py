"""Offline pre-command wedge handling, bounded relocation and detached settlement."""
import contextlib
import io
from pathlib import Path
import sys
from unittest.mock import ANY, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, bases, cli, common, lease, misc, pool, reap, runs
from test_capacity import Isolated

EVIDENCE = ('offbox-box-wedged: kept image restore did not finish in 1s and docker does not answer; '
            'D-state: 2 (sync, umount)')


class BoxWedgedTests(Isolated):
    def setUp(self):
        super().setUp()
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline test reached boat')))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'close_master'))
        self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'stopped'}))
        self.stop = self.stack.enter_context(patch.object(api, 'stop', return_value={}))
        self.stop_box = self.stack.enter_context(patch.object(lease, 'stop_box', wraps=lease.stop_box))
        self.keep = self.stack.enter_context(patch.object(lease, 'keep_images'))
        self.delete = self.stack.enter_context(patch.object(lease, 'delete_box'))
        self.me['repo_root'] = self.tmp.name

    def row(self, box):
        return self.con.execute('SELECT * FROM leases WHERE box_id=?', (box,)).fetchone()

    def prepare_run(self, outcomes, bg=False):
        for box in ('bxA', 'bxB'):
            self.box(box, member=True)
        rows = [dict(self.row(box), remote_dir='w/r') for box in ('bxA', 'bxB')]
        acquire = self.stack.enter_context(patch.object(pool, 'acquire', side_effect=rows))
        self.stack.enter_context(patch.object(runs.Runner, '_prepare_box', return_value=None))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(patch.object(runs.node_version, 'want', return_value=None))
        start = self.stack.enter_context(patch.object(api, 'cmd_start', return_value={'processId': 7, 'commandId': 'c'}))
        outcomes = iter(outcomes)
        self.stderr = ''
        self.stack.enter_context(patch.object(api, 'history_logs',
            side_effect=lambda *args: {'data': self.stderr, 'done': True}))

        def stream(rn):
            code, text = next(outcomes)
            self.stderr = text
            rn.log_path.write_text(text)
            return code
        self.stack.enter_context(patch.object(runs.Runner, 'stream', stream))
        self.a = cli.build_parser().parse_args(['run', *(['--bg'] if bg else []), '--', 'make check'])
        self.a.cmd = ['make check']
        self.a.steps = []
        return acquire, start

    def assert_set_aside(self, box):
        self.assertTrue(self.row(box)['note'].startswith('box-wedged: ' + EVIDENCE))
        self.assertEqual(self.row(box)['state'], 'stopped')
        self.assertEqual(self.con.execute("SELECT detail FROM events WHERE kind='box_wedged' AND box_id=?",
                                          (box,)).fetchone()[0], EVIDENCE)
        call = next(c for c in self.stop_box.call_args_list if c.args[1] == box)
        self.assertIs(call.kwargs['images'], False)
        self.assertIs(call.kwargs['locked'], True)
        self.keep.assert_not_called()
        self.delete.assert_not_called()

    def test_first_wedged_moves_once_and_returns_second_commands_exit(self):
        acquire, start = self.prepare_run([(97, EVIDENCE), (8, 'offbox-command-started: r\ncommand failed\n')])
        released = []
        with patch.object(pool, 'release_guard', side_effect=lambda r: released.append(r['box_id'])):
            self.assertEqual(runs.run_remote(self.a, self.me), 8)
        self.assertEqual(acquire.call_count, 2)
        self.assertEqual(start.call_count, 2)
        self.assertEqual(released, ['bxA', 'bxB'])
        self.assert_set_aside('bxA')
        self.assertIsNone(self.row('bxB')['note'])
        statuses = self.con.execute('SELECT box_id,status,exit_code,error FROM runs ORDER BY start_at').fetchall()
        self.assertEqual(tuple(statuses[0]), ('bxA', 'infra', None, 'box wedged before the command'))
        self.assertEqual(tuple(statuses[1])[:3], ('bxB', 'failed', 8))
        self.assertIn('Nothing ran there; running on another box', self.err.getvalue())

    def test_two_wedged_return_infra_and_do_not_try_a_third(self):
        acquire, start = self.prepare_run([(97, EVIDENCE), (97, EVIDENCE)])
        with self.assertRaises(common.OffboxError) as cm:
            runs.run_remote(self.a, self.me)
        self.assertEqual(cm.exception.code, common.EXIT_INFRA)
        self.assertFalse(cm.exception.started)
        self.assertIn('bxA and bxB were both wedged before the command; both set aside. Nothing ran: retry',
                      str(cm.exception))
        self.assertEqual(acquire.call_count, 2)
        self.assertEqual(start.call_count, 2)
        self.assert_set_aside('bxA')
        self.assert_set_aside('bxB')

    def test_marker_and_exit_input_matrix_never_retries_user_commands(self):
        cases = [(7, EVIDENCE, 7), (97, 'user exit', 97),
                 (97, 'prefix ' + EVIDENCE, 97),
                 (97, 'offbox-command-started: r\n' + EVIDENCE, 97),
                 (97, EVIDENCE + '\noffbox-command-started: r\n', 97)]
        for code, text, expected in cases:
            with self.subTest(code=code, text=text):
                # Keep each fixture isolated, including its two-box rows.
                case = BoxWedgedTests('runTest')
                case.setUp()
                try:
                    acquire, _ = case.prepare_run([(code, text)])
                    self.assertEqual(runs.run_remote(case.a, case.me), expected)
                    acquire.assert_called_once()
                    case.stop_box.assert_not_called()
                finally:
                    case.doCleanups()

    def test_user_exit97_with_local_start_fence_does_not_need_history(self):
        acquire, start = self.prepare_run([(97, 'offbox-command-started: r\nuser exit 97\n')])
        with patch.object(api, 'history_logs', side_effect=common.OffboxError('history unavailable')) as history:
            self.assertEqual(runs.run_remote(self.a, self.me), 97)
        history.assert_not_called()
        acquire.assert_called_once()
        start.assert_called_once()
        row = self.con.execute('SELECT * FROM runs').fetchone()
        self.assertEqual((row['status'], row['exit_code']), ('failed', 97))
        self.assertEqual(lease.active_runs(self.con, 'bxA'), 0)
        self.assertIsNone(self.row('bxA')['note'])
        self.stop_box.assert_not_called()

    def test_detached_user_exit97_with_local_start_fence_does_not_need_history(self):
        for entry in ('wait', 'pool', 'reaper'):
            with self.subTest(entry=entry):
                case = BoxWedgedTests('runTest')
                case.setUp()
                try:
                    row = case.detached_row()
                    path = Path(row['log_path'])
                    path.write_text('offbox-command-started: r\n' + EVIDENCE)
                    with patch.object(api, 'cmd_status', return_value={'status':'exited','running':False,'exitCode':97}), \
                         patch.object(api, 'history_logs', side_effect=common.OffboxError('history unavailable')) as history:
                        if entry == 'wait':
                            self.assertEqual(misc._finalize(row, 97, path), 97)
                        elif entry == 'pool':
                            pool._refresh_background(case.con, 'repo')
                        else:
                            reap._check_stale_runs(case.con, 'bxA', api.LIVE_STATES[0], False, [])
                    history.assert_not_called()
                    current = case.con.execute('SELECT * FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()
                    self.assertEqual((current['status'], current['exit_code']), ('failed', 97))
                    self.assertEqual(lease.active_runs(case.con, 'bxA'), 0)
                    self.assertIsNone(case.row('bxA')['note'])
                    case.stop_box.assert_not_called()
                finally:
                    case.doCleanups()

    def test_mixed_stream_chunk_matrix_never_authorizes_replay(self):
        # A display log can glue either marker to stdout, or split a stderr marker around stdout chunks.
        cases = [
            [('stdout', 'partial stdout'), ('stderr', 'offbox-command-started: r\n'), ('stderr', EVIDENCE)],
            [('stderr', 'offbox-command-'), ('stdout', 'stdout\n'), ('stderr', 'started: r\n' + EVIDENCE)],
            [('stderr', 'offbox-command-started: r\n'), ('stdout', 'partial'), ('stderr', EVIDENCE)],
            [('stderr', 'partial stderr'), ('stderr', 'offbox-command-started: r\n' + EVIDENCE)],
        ]
        for chunks in cases:
            with self.subTest(chunks=chunks):
                case = BoxWedgedTests('runTest')
                case.setUp()
                try:
                    acquire, start = case.prepare_run([])
                    frames = [{'type': stream, 'data': data} for stream, data in chunks] + [{'type':'exit','exitCode':97}]
                    stderr = ''.join(data for stream, data in chunks if stream == 'stderr')
                    def real_stream(rn):
                        return runs.follow(rn.box, rn.pid, rn.log_path, echo=False, run_id=rn.run_id)
                    with patch.object(runs.Runner, 'stream', real_stream), \
                         patch.object(runs, '_ttl_keeper'), patch.object(api, 'cmd_attach', return_value=iter(frames)), \
                         patch.object(api, 'history_logs', return_value={'data':stderr,'done':True}):
                        self.assertEqual(runs.run_remote(case.a, case.me), 97)
                    acquire.assert_called_once()
                    start.assert_called_once()
                    case.stop_box.assert_not_called()
                finally:
                    case.doCleanups()

    def test_ambiguous_second_start_is_not_retried_or_locally_replayed(self):
        acquire, start = self.prepare_run([(97, EVIDENCE)])
        start.side_effect = [{'processId': 7, 'commandId': 'c'}, common.OffboxError('network')]
        with self.assertRaises(common.OffboxError) as cm:
            runs.run_remote(self.a, self.me)
        self.assertTrue(cm.exception.started)
        self.assertEqual(acquire.call_count, 2)

    def test_stop_failure_stays_set_aside_and_does_not_claim_stopped(self):
        self.prepare_run([(97, EVIDENCE), (0, 'offbox-command-started: r')])
        self.stop.side_effect = common.OffboxError('stop refused')
        self.assertEqual(runs.run_remote(self.a, self.me), 0)
        self.assertTrue(self.row('bxA')['note'].startswith('box-wedged:'))
        self.assertEqual(self.row('bxA')['state'], 'running')
        self.assertIn('stop could not be confirmed', self.err.getvalue())

    def test_wedged_box_not_picked_even_with_retained_resume(self):
        self.box('wedged', state='stopped', member=True)
        self.box('healthy', member=True)
        self.con.execute("UPDATE leases SET note='box-wedged: bad docker' WHERE box_id='wedged'")
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:wedged','',0)")
        self.con.execute("INSERT INTO start_requests(ts,box_id,operation,outcome) VALUES (?,'wedged','resume','uncertain')",
                         (common.now(),))
        self.con.commit()
        with patch.object(lease, '_reuse', side_effect=lambda c,r,*a,**kw: dict(r)) as reuse:
            row = pool.acquire(self.me)
            pool.release_guard(row)
        self.assertEqual(row['box_id'], 'healthy')
        self.assertTrue(all(c.args[1]['box_id'] == 'healthy' for c in reuse.call_args_list))
        self.assertNotIn('wedged', [r['box_id'] for r in pool.members(self.con, 'repo')])
        self.assertIsNone(lease._reuse(self.con, self.row('wedged'), None))
        with patch.object(api, 'resume') as resume:
            lease.refresh_box(self.con, 'wedged')
        resume.assert_not_called()

    def test_stale_candidate_cannot_resume_box_marked_while_waiting_for_guard(self):
        self.box('wedged', state='stopped', member=True)
        stale = dict(self.row('wedged'))
        self.con.execute("UPDATE leases SET note='box-wedged: docker dead' WHERE box_id='wedged'")
        self.con.commit()
        with patch.object(api, 'resume') as resume:
            self.assertIsNone(lease._reuse(self.con, stale, None))
        resume.assert_not_called()

    def detached_row(self):
        self.prepare_run([], bg=True)
        rn = runs.Runner(self.a, self.me)
        rn.start()
        return self.con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()

    def test_wait_settles_and_reports_infra_without_pulls(self):
        row = self.detached_row()
        path = Path(row['log_path'])
        path.write_text(EVIDENCE)
        with patch.object(runs, 'do_pulls') as pulls, \
             patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}):
            self.assertEqual(misc._finalize(row, 97, path), 90)
        pulls.assert_not_called()
        self.assert_set_aside('bxA')
        self.assertIn('Nothing ran: retry', self.err.getvalue())

    def test_pool_and_reaper_settle_detached_marker_from_history(self):
        for entry in ('pool', 'reaper'):
            with self.subTest(entry=entry):
                case = BoxWedgedTests('runTest')
                case.setUp()
                try:
                    row = case.detached_row()
                    with patch.object(api, 'cmd_status', return_value={'status':'exited','running':False,'exitCode':97}), \
                         patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}), \
                         patch.object(runs, 'do_pulls') as pulls:
                        if entry == 'pool':
                            pool._refresh_background(case.con, 'repo')
                        else:
                            reap._check_stale_runs(case.con, 'bxA', api.LIVE_STATES[0], False, [])
                    case.assert_set_aside('bxA')
                    pulls.assert_not_called()
                finally:
                    case.doCleanups()

    def test_reaper_quarantines_detached_wedge_after_box_stopped(self):
        for state in (*api.STOPPED_STATES, 'error', 'cancelled'):
            with self.subTest(state=state):
                case = BoxWedgedTests('runTest')
                case.setUp()
                try:
                    row = case.detached_row()
                    with patch.object(api, 'cmd_status', return_value={'status':'exited','running':False,'exitCode':97}), \
                         patch.object(api, 'history_get', return_value={'exitCode':97}), \
                         patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}):
                        reap._check_stale_runs(case.con, 'bxA', state, False, [])
                    case.assert_set_aside('bxA')
                    self.assertNotIn('bxA', [r['box_id'] for r in pool.members(case.con, 'repo')])
                finally:
                    case.doCleanups()

    def test_stopped_process_status_missing_uses_retained_history(self):
        row = self.detached_row()
        with patch.object(api, 'cmd_status', return_value=None), \
             patch.object(api, 'history_get', return_value={'exitCode':97}) as history, \
             patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}):
            reap._check_stale_runs(self.con, 'bxA', api.STOPPED_STATES[0], False, [])
        history.assert_called_once_with('bxA', row['command_id'])
        self.assert_set_aside('bxA')

    def test_stopped_history_failure_is_not_overwritten_as_lost_by_reap_release(self):
        row = self.detached_row()
        with patch.object(api, 'list_boxes', return_value=[{'id':'bxA','state':api.STOPPED_STATES[0]}]), \
             patch.object(api, 'cmd_status', return_value=None), \
             patch.object(api, 'history_get', side_effect=common.OffboxError('network')), \
             patch.object(bases, 'upkeep'):
            reap.reap(False)
        current = self.con.execute('SELECT status FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()[0]
        self.assertEqual(current, 'running')
        self.assertIsNone(self.row('bxA')['note'])

    def test_stopped_plain_exit97_with_command_fence_is_not_quarantined(self):
        row = self.detached_row()
        with patch.object(api, 'cmd_status', return_value=None), \
             patch.object(api, 'history_get', return_value={'exitCode':97}), \
             patch.object(api, 'history_logs', return_value={'data':'offbox-command-started: r\n'+EVIDENCE, 'done':True}):
            reap._check_stale_runs(self.con, 'bxA', api.STOPPED_STATES[0], False, [])
        self.assertIsNone(self.row('bxA')['note'])
        self.stop_box.assert_not_called()

    def test_quarantine_is_durable_before_terminal_run_side_effects(self):
        for side_effect in ('idle_ttl', 'stop_box'):
            with self.subTest(side_effect=side_effect):
                case = BoxWedgedTests('runTest')
                case.setUp()
                try:
                    row = case.detached_row()
                    with patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}), \
                         patch.object(lease, side_effect, side_effect=KeyboardInterrupt):
                        try:
                            runs.settle_box_wedged(case.con, row, 97)
                        except KeyboardInterrupt:
                            pass
                    current = case.con.execute('SELECT status FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()[0]
                    self.assertEqual(current, 'infra')
                    self.assertTrue((case.row('bxA')['note'] or '').startswith('box-wedged:'))
                    self.assertNotIn('bxA', [r['box_id'] for r in pool.candidates(case.con, 'repo', None, None)[0]])
                    self.assertIsNotNone(case.con.execute("SELECT 1 FROM events WHERE box_id='bxA' AND kind='box_wedged'").fetchone())
                finally:
                    case.doCleanups()

    def test_live_lost_or_ended_process_reconciles_retained_wedge(self):
        for status in ('lost', 'exited'):
            with self.subTest(status=status):
                case = BoxWedgedTests('runTest')
                case.setUp()
                try:
                    row = case.detached_row()
                    with patch.object(api, 'cmd_status', return_value={'running':False,'status':status,'exitCode':None}), \
                         patch.object(api, 'history_get', return_value={'exitCode':97}), \
                         patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}):
                        reap._check_stale_runs(case.con, 'bxA', api.LIVE_STATES[0], False, [])
                    case.assert_set_aside('bxA')
                finally:
                    case.doCleanups()

    def test_live_lost_history_failure_keeps_active_row(self):
        row = self.detached_row()
        with patch.object(api, 'cmd_status', return_value={'running':False,'status':'lost','exitCode':None}), \
             patch.object(api, 'history_get', side_effect=common.OffboxError('network')):
            reap._check_stale_runs(self.con, 'bxA', api.LIVE_STATES[0], False, [])
        current = self.con.execute('SELECT status FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()[0]
        self.assertEqual(current, 'running')

    def test_pool_refresh_lost_process_reconciles_history_before_freeing_slot(self):
        row = self.detached_row()
        with patch.object(api, 'cmd_status', return_value={'running':False,'status':'lost','exitCode':None}), \
             patch.object(api, 'history_get', return_value={'exitCode':97}), \
             patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}):
            pool._refresh_background(self.con, 'repo')
        self.assert_set_aside('bxA')

    def test_foreground_lost_process_missing_exit_file_uses_history_and_moves_once(self):
        acquire, start = self.prepare_run([])
        frames = [iter([{'type':'stderr','data':EVIDENCE+'\n'}, {'type':'error','error':'lost stream'}]),
                  iter([{'type':'stdout','data':'command ran on bxB\n'}, {'type':'exit','exitCode':0}])]
        def real_stream(rn):
            return runs.follow(rn.box, rn.pid, rn.log_path, echo=False, run_id=rn.run_id)
        with patch.object(runs.Runner, 'stream', real_stream), patch.object(runs, '_ttl_keeper'), \
             patch.object(api, 'cmd_attach', side_effect=frames), \
             patch.object(api, 'cmd_status', return_value={'running':False,'status':'lost','exitCode':None}), \
             patch.object(runs, 'recorded_exit', return_value=None), \
             patch.object(api, 'history_get', return_value={'exitCode':97}) as history, \
             patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}):
            self.assertEqual(runs.run_remote(self.a, self.me), 0)
        history.assert_called_once_with('bxA', 'c')
        self.assertEqual(acquire.call_count, 2)
        self.assertEqual(start.call_count, 2)
        self.assert_set_aside('bxA')

    def test_foreground_unknown_history_error_retains_active_row_without_replay(self):
        acquire, start = self.prepare_run([(None, EVIDENCE)])
        with patch.object(runs, 'recorded_exit', return_value=None), \
             patch.object(api, 'history_get', side_effect=common.OffboxError('network')):
            with self.assertRaises(common.OffboxError) as cm:
                runs.run_remote(self.a, self.me)
        self.assertTrue(cm.exception.started)
        self.assertEqual(self.con.execute('SELECT status FROM runs').fetchone()[0], 'running')
        acquire.assert_called_once()
        start.assert_called_once()
        self.stop_box.assert_not_called()

    def test_wait_unknown_exit_file_recovers_wedge_from_retained_history(self):
        row = self.detached_row()
        with patch.object(runs, 'follow', return_value=None), patch.object(runs, 'recorded_exit', return_value=None), \
             patch.object(api, 'history_get', return_value={'exitCode':97}), \
             patch.object(api, 'history_logs', return_value={'data':EVIDENCE,'done':True}):
            self.assertEqual(misc._wait_run(row, False), 90)
        self.assert_set_aside('bxA')

    def test_reaper_rechecks_quarantine_and_stale_decisions_under_lock(self):
        cases = [('unused', False), ('unused', True), ('archived', True), ('refresh', True), ('stop', True)]
        for kind, wedged in cases:
            with self.subTest(kind=kind, wedged=wedged):
                case = BoxWedgedTests('runTest')
                case.setUp()
                try:
                    case.box('bxA', used=common.now() - common.UNUSED_DELETE_S - 1)
                    if kind == 'archived':
                        case.con.execute("UPDATE leases SET thread_id='t', thread_gone_since=? WHERE box_id='bxA'",
                                         (common.now() - common.ARCHIVED_DELETE_S - 1,))
                    if kind == 'refresh':
                        case.con.execute("UPDATE leases SET last_used_at=?, pinned_until=? WHERE box_id='bxA'",
                                         (common.now(), common.now() + 1000))
                    if kind == 'stop':
                        case.con.execute("UPDATE leases SET last_used_at=? WHERE box_id='bxA'", (common.now()-3600,))
                    case.con.commit()
                    real_lock = reap.file_lock
                    @contextlib.contextmanager
                    def racing_lock(name, *args, **kwargs):
                        if name == 'box-bxA':
                            case.con.execute("UPDATE leases SET note=?, last_used_at=? WHERE box_id='bxA'",
                                             ('box-wedged: bad Docker' if wedged else None, common.now()))
                            case.con.commit()
                        with real_lock(name, *args, **kwargs):
                            yield
                    state = api.STOPPED_STATES[0] if kind == 'refresh' else api.LIVE_STATES[0]
                    with patch.object(api, 'list_boxes', return_value=[{'id':'bxA', 'state':state,
                                                                        'stoppedAt':'2026-10-01T00:00:00Z'}]), \
                         patch.object(reap, 'file_lock', racing_lock), patch.object(bases, 'upkeep'), \
                         patch.object(reap, 'thread_get', return_value=('gone', None)), \
                         patch.object(lease, 'refresh_box') as refresh:
                        actions = reap.reap(False)
                    case.delete.assert_not_called()
                    refresh.assert_not_called()
                    if wedged:
                        self.assertTrue(any('set aside' in a and 'skipped' in a for a in actions), actions)
                        self.assertTrue(all(c.kwargs.get('images') is False for c in case.stop_box.call_args_list))
                finally:
                    case.doCleanups()

    def test_history_page_containing_start_fence_prevents_set_aside(self):
        row = self.detached_row()
        with patch.object(api, 'history_logs', side_effect=[
            {'data': 'offbox-command-started: r\n', 'nextOffset': 30},
            {'data': EVIDENCE, 'done': True}]), patch.object(runs, 'do_pulls'):
            self.assertIsNone(runs.settle_box_wedged(self.con, row, 97))
        self.stop_box.assert_not_called()

    def test_history_failure_keeps_detached_run_for_later_wedge_settlement(self):
        row = self.detached_row()
        with patch.object(api, 'cmd_status', return_value={'status':'exited','running':False,'exitCode':97}), \
             patch.object(api, 'history_logs', side_effect=common.OffboxError('network')):
            pool._refresh_background(self.con, 'repo')
        current = self.con.execute('SELECT status FROM runs WHERE run_id=?', (row['run_id'],)).fetchone()[0]
        self.assertEqual(current, 'running')
        self.stop_box.assert_not_called()

    def test_list_reason_and_explicit_delete_still_work(self):
        self.prepare_run([(97, EVIDENCE), (0, 'offbox-command-started: r')])
        self.assertEqual(runs.run_remote(self.a, self.me), 0)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            misc.list_leases(self.me, True, False)
            misc.release(self.me, 'bxA', False, True)
        self.assertIn('[box-wedged: ' + EVIDENCE + ']', out.getvalue())
        self.delete.assert_called_once_with(ANY, 'bxA', 'release --delete')

    def test_reaper_retries_stop_without_images_never_refreshes_or_deletes_set_aside(self):
        self.box('wedged', member=True, used=1)
        self.con.execute("UPDATE leases SET note='box-wedged: docker dead', pinned_until=? WHERE box_id='wedged'",
                         (common.now() + 1000,))
        self.con.commit()
        for state in (api.LIVE_STATES[0], api.STOPPED_STATES[0]):
            with self.subTest(state=state), \
                 patch.object(api, 'list_boxes', return_value=[{'id':'wedged', 'state':state,
                                                                'stoppedAt':'2026-10-01T00:00:00Z'}]), \
                 patch.object(lease, 'refresh_box') as refresh, patch.object(bases, 'upkeep'):
                reap.reap(False)
                refresh.assert_not_called()
                self.delete.assert_not_called()
        self.assertTrue(all(c.kwargs.get('images') is False for c in self.stop_box.call_args_list))
