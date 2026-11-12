"""Offline keepalive after client loss, plus durable live-log snapshots."""
import contextlib
import io
import types
from unittest.mock import patch

from test_capacity import Isolated
from offbox_lib import api, bases, common, lease, misc, reap, runs


class OrphanTTLTests(Isolated):
    def setUp(self):
        super().setUp()
        self.clock = 100000
        self.box('bx', used=self.clock - 60, member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,start_at,pulls) "
                         "VALUES ('run-t','bx','cmd',7,'running','bg',?,'[]')", (self.clock - 3600,))
        self.con.commit()
        self.remote = dict(id='bx', state='running')
        self.stack.enter_context(patch.object(reap, 'now', return_value=self.clock))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: no API calls')))
        self.stack.enter_context(patch.object(api, 'list_boxes', side_effect=lambda: [self.remote]))
        self.get = self.stack.enter_context(patch.object(api, 'get', side_effect=lambda *a, **kw: self.remote))
        self.stack.enter_context(patch.object(lease, 'release_if_confirmed', return_value=True))
        self.stack.enter_context(patch.object(api, 'history_get', return_value=None))
        self.status = self.stack.enter_context(patch.object(api, 'cmd_status', return_value=dict(running=True)))
        self.alive = self.stack.enter_context(patch.object(runs, 'remote_alive', return_value='alive'))
        self.stack.enter_context(patch.object(runs, 'recorded_exit', return_value=None))
        self.stack.enter_context(patch.object(bases, 'upkeep'))
        self.stack.enter_context(patch.object(misc, '_catch_up_finished'))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.keep = self.stack.enter_context(patch.object(lease, 'ensure_ttl', return_value=True))
        self.stop = self.stack.enter_context(patch.object(lease, 'stop_box'))

    def test_foreground_and_background_survive_missing_client(self):
        for mode in ('fg', 'bg'):
            with self.subTest(mode=mode):
                self.con.execute('UPDATE runs SET mode=?,client_pid=NULL', (mode,))
                self.con.commit()
                self.keep.reset_mock()
                reap._reap(self.con, False, [])
                self.keep.assert_called_once_with('bx', common.RUN_TTL_S, self.remote)
                self.stop.assert_not_called()

    def test_refresh_does_not_need_clients_box_lock(self):
        with common.file_lock('box-bx', timeout=0):
            reap._reap(self.con, False, [])
        self.keep.assert_called_once_with('bx', common.RUN_TTL_S, self.remote)

    def test_lost_tracker_uses_wrapper_liveness(self):
        self.status.return_value = dict(status='lost', running=False)
        reap._reap(self.con, False, [])
        self.keep.assert_called_once_with('bx', common.RUN_TTL_S, self.remote)

    def test_gone_process_settles_without_run_extension(self):
        self.status.return_value = dict(status='lost', running=False)
        self.alive.return_value = 'gone'
        reap._reap(self.con, False, [])
        self.assertEqual(self.con.execute('SELECT status FROM runs').fetchone()[0], 'lost')
        self.assertFalse(any(c.args[1] == common.RUN_TTL_S for c in self.keep.call_args_list))

    def test_unknown_liveness_does_not_extend(self):
        self.status.return_value = None
        self.alive.return_value = None
        reap._reap(self.con, False, [])
        self.keep.assert_not_called()
        self.assertEqual(lease.active_runs(self.con, 'bx'), 1)

    def test_age_cap_and_unknown_start_are_bounded_and_logged_once(self):
        for start in (self.clock - common.ORPHAN_RUN_MAX_S, self.clock - common.ORPHAN_RUN_MAX_S - 1, None):
            with self.subTest(start=start):
                self.con.execute('UPDATE runs SET start_at=?', (start,))
                self.con.commit()
                reap._reap(self.con, False, [])
        self.keep.assert_not_called()
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM events WHERE kind='run_orphan_cap'").fetchone()[0], 1)
        self.assertEqual(lease.active_runs(self.con, 'bx'), 1)

    def test_just_inside_cap_extends(self):
        self.con.execute('UPDATE runs SET start_at=?', (self.clock - common.ORPHAN_RUN_MAX_S + 1,))
        self.con.commit()
        reap._reap(self.con, False, [])
        self.keep.assert_called_once_with('bx', common.RUN_TTL_S, self.remote)

    def test_stopped_box_and_dry_run_do_not_extend(self):
        reap._reap(self.con, True, [])
        self.remote['state'] = api.STOPPED_STATES[0]
        reap._reap(self.con, False, [])
        self.keep.assert_not_called()
        self.stop.assert_not_called()

    def test_idle_box_keeps_existing_idle_window(self):
        self.con.execute('DELETE FROM runs')
        self.con.commit()
        with patch.object(lease, 'docker_recent', return_value=False), \
                patch.object(reap.capacity, 'idle_seconds', return_value=600):
            reap._reap(self.con, False, [])
        self.keep.assert_called_once_with('bx', 540, self.remote)
        self.stop.assert_not_called()

    def test_longer_background_deadline_is_preserved(self):
        self.remote['archiveAfter'] = common.iso(common.now() + 5 * 3600)
        with patch.object(api, 'set_ttl') as set_ttl:
            self.keep.side_effect = ENSURE_TTL
            reap._reap(self.con, False, [])
        set_ttl.assert_not_called()

    def test_deadline_snapshot_matrix_under_follower_lock(self):
        # Earlier list deadline, current deadline/state, expected PATCH: cover changes in either direction.
        cases = (
            (300, 21600, 'running', False),
            (21600, 300, 'running', True),
            (300, 21600, 'ready', False),
            (300, 300, 'idle', True),
            (300, 300, api.STOPPED_STATES[0], False),
            (300, None, None, False),
        )
        for listed, current_ttl, state, patch_ttl in cases:
            with self.subTest(listed=listed, current=current_ttl, state=state):
                self.remote['archiveAfter'] = common.iso(common.now() + listed)
                current = dict(state=state, archiveAfter=common.iso(common.now() + current_ttl)) if state else None
                self.get.side_effect = None
                self.get.return_value = current
                self.keep.side_effect = ENSURE_TTL
                with common.file_lock('box-bx', timeout=0), patch.object(api, 'set_ttl') as set_ttl:
                    reap._reap(self.con, False, [])
                if patch_ttl:
                    set_ttl.assert_called_once_with('bx', common.RUN_TTL_S)
                else:
                    set_ttl.assert_not_called()

    def test_current_box_read_failure_does_not_use_old_deadline(self):
        self.get.side_effect = common.OffboxError('deadline read failed')
        with common.file_lock('box-bx', timeout=0):
            reap._reap(self.con, False, [])
        self.keep.assert_not_called()


ENSURE_TTL = lease.ensure_ttl


class RenewalFairnessTests(Isolated):
    def setUp(self):
        super().setUp()
        self.clock = 100000.0
        self.boxes = {}
        self.slow = set()
        self.seen = []
        self.renewed = []
        self.failure_at = 'status'
        self.stack.enter_context(patch.object(api, 'time', types.SimpleNamespace(time=lambda: self.clock)))
        self.stack.enter_context(patch.object(reap, 'now', side_effect=lambda: self.clock))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: no API calls')))
        self.stack.enter_context(patch.object(api, 'list_boxes', side_effect=lambda: list(self.boxes.values())))
        self.stack.enter_context(patch.object(api, 'cmd_status', side_effect=self.status))
        self.stack.enter_context(patch.object(api, 'get', side_effect=self.get_box))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl', side_effect=self.renew))
        self.stack.enter_context(patch.object(bases, 'upkeep'))
        self.stop = self.stack.enter_context(patch.object(lease, 'stop_box'))

    def add_run(self, bid, mode='bg', slow=False):
        self.box(bid, used=self.clock - 60, member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,process_id,status,mode,start_at,pulls) "
                         "VALUES (?,?,7,'running',?,?,'[]')", ('run-' + bid, bid, mode, self.clock - 60))
        self.con.commit()
        self.boxes[bid] = dict(id=bid, state='running')
        if slow:
            self.slow.add(bid)

    def call(self, bid, method):
        left = api.left()
        if left is not None and left <= 0:
            raise common.OffboxError('pass budget exhausted')
        self.seen.append((bid, method))
        if bid in self.slow and method == self.failure_at:
            # Honor the real nested API budget: default cmd_status would otherwise take 60 seconds.
            self.clock += min(60, left) if left is not None else 60
            raise common.OffboxError('timed out')

    def status(self, bid, pid, **kwargs):
        self.call(bid, 'status')
        return dict(running=True)

    def get_box(self, bid, **kwargs):
        self.call(bid, 'box')
        return self.boxes[bid]

    def renew(self, bid, ttl, box):
        self.call(bid, 'patch')
        self.renewed.append((bid, self.clock, ttl))
        return True

    def pass_once(self):
        started = self.clock
        with api.budget(reap.REAP_BUDGET_S):
            reap._reap(self.con, False, [])
        self.assertLessEqual(self.clock - started, reap.REAP_BUDGET_S)

    def test_seven_passes_with_two_timeouts_before_detached_live_run(self):
        # Failure stage x run mode: each healthy run must be reached and renewed in every five-minute pass.
        for failure_at in ('status', 'box', 'patch'):
            for mode in ('fg', 'bg'):
                with self.subTest(failure_at=failure_at, mode=mode):
                    self.con.execute('DELETE FROM runs')
                    self.con.execute('DELETE FROM leases')
                    self.con.execute('DELETE FROM pool_members')
                    self.con.execute("DELETE FROM kv WHERE k='reap:renew_cursor'")
                    self.con.commit()
                    self.boxes.clear()
                    self.slow.clear()
                    self.failure_at = failure_at
                    self.add_run('a', slow=True)
                    self.add_run('b', slow=True)
                    self.add_run('c', mode=mode)
                    start = self.clock
                    for i in range(7):
                        self.clock = start + i * 300
                        self.seen.clear()
                        self.renewed.clear()
                        self.pass_once()
                        self.assertIn(('c', 'status'), self.seen)
                        self.assertEqual([(bid, ttl) for bid, _, ttl in self.renewed], [('c', common.RUN_TTL_S)])
        self.stop.assert_not_called()

    def test_cursor_survives_exhausted_passes_and_rotates_past_slow_prefix(self):
        for i in range(30):
            self.add_run(f'a{i:02}', slow=True)
        self.add_run('z-live')
        start = self.clock
        deadline = start + common.RUN_TTL_S
        cursors = set()
        healthy_passes = 0
        for i in range(7):
            self.clock = start + i * 300
            self.assertLess(self.clock, deadline, 'healthy detached box would have auto-stopped')
            self.renewed.clear()
            self.pass_once()
            for bid, refreshed_at, ttl in self.renewed:
                if bid == 'z-live':
                    deadline = refreshed_at + ttl
                    healthy_passes += 1
            # Read through a new connection, as the next monitor invocation does.
            with contextlib.closing(common.db()) as con:
                cursors.add(con.execute("SELECT v FROM kv WHERE k='reap:renew_cursor'").fetchone()[0])
        self.assertGreaterEqual(healthy_passes, 2)
        self.assertGreater(len(cursors), 1)
        self.stop.assert_not_called()

    def test_dry_run_neither_renews_nor_advances_cursor(self):
        self.add_run('live')
        with patch.object(reap, '_check_stale_runs'):
            reap._reap(self.con, True, [])
        self.assertEqual(self.seen, [])
        self.assertIsNone(self.con.execute("SELECT v FROM kv WHERE k='reap:renew_cursor'").fetchone())


class LiveLogsTests(Isolated):
    def setUp(self):
        super().setUp()
        self.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,start_at,pulls) "
                         "VALUES ('run-t','bx','cmd',7,'running','bg',?,'[]')", (common.now() - 60,))
        self.con.commit()
        self.path = common.LOGS_DIR / 'run-t.log'
        self.path.write_bytes(b'old\n')
        common.atomic_write_json(common.offsets_path(self.path), dict(stdoutOffset=4, stderrOffset=0, logBytes=4))
        self.streams = dict(stdout=b'old\nnew\n', stderr=b'err\n')
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: no API calls')))
        self.box_get = self.stack.enter_context(patch.object(api, 'get', return_value=dict(state='running')))
        self.keep = self.stack.enter_context(patch.object(lease, 'ensure_ttl', return_value=True))
        self.history = self.stack.enter_context(patch.object(api, 'history_logs', side_effect=self.page))

    def page(self, bid, cmd, which, offset, **kwargs):
        data = self.streams[which][offset:offset + 3]
        return dict(data=data.decode(), nextOffset=offset + len(data), size=len(self.streams[which]), done=False)

    def logs(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = misc.logs('run-t', False)
        return code, out.getvalue(), err.getvalue()

    def test_live_logs_save_both_streams_and_survive_box_stop(self):
        self.assertEqual(self.logs()[:2], (0, 'old\nnew\nerr\n'))
        self.keep.assert_called_once_with('bx', common.RUN_TTL_S, dict(state='running'))
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=8, stderrOffset=4, logBytes=12))
        self.assertEqual(self.logs()[:2], (0, 'old\nnew\nerr\n'))
        self.con.execute("UPDATE runs SET status='failed',exit_code=143")
        self.con.commit()
        self.box_get.return_value = dict(state='stopped')
        self.history.side_effect = common.OffboxError('stopped')
        self.assertEqual(self.logs()[:2], (0, 'old\nnew\nerr\n'))
        self.assertEqual(self.path.read_bytes(), b'old\nnew\nerr\n')

    def test_background_with_no_local_log_starts_at_zero(self):
        self.path.unlink()
        common.offsets_path(self.path).unlink()
        self.logs()
        self.assertEqual(self.path.read_bytes(), b'old\nnew\nerr\n')

    def test_later_fetch_failure_keeps_already_fetched_page(self):
        page = self.page
        def fail(*args, **kwargs):
            if args[3] > 4 or args[2] == 'stderr':
                raise common.OffboxError('history unavailable')
            return page(*args, **kwargs)
        self.history.side_effect = fail
        self.assertEqual(self.logs()[:2], (0, 'old\nnew'))
        self.assertEqual(common.checkpoint(self.path), dict(stdoutOffset=7, stderrOffset=0, logBytes=7))
        self.history.side_effect = common.OffboxError('stopped')
        self.assertEqual(self.logs()[:2], (0, 'old\nnew'))

    def test_held_follower_lock_does_not_fetch_or_overwrite(self):
        with common.file_lock('box-bx', timeout=0):
            self.assertEqual(self.logs()[:2], (0, 'old\n'))
        self.history.assert_not_called()
        self.assertEqual(self.path.read_bytes(), b'old\n')

    def test_snapshot_stops_even_if_remote_stream_keeps_growing(self):
        page = self.page
        def growing(*args, **kwargs):
            result = page(*args, **kwargs)
            self.streams[args[2]] += b'xxxxx'
            return result
        self.history.side_effect = growing
        self.logs()
        self.assertLess(self.history.call_count, 10)
        self.assertGreater(self.path.stat().st_size, 4)

    def test_wait_and_follow_logs_refresh_before_lock_wait(self):
        for echo in (False, True):
            with self.subTest(echo=echo), patch.object(misc, '_replay_takeover', return_value=0), \
                    patch.object(runs, 'reconcile_lost'), contextlib.redirect_stdout(io.StringIO()):
                self.keep.reset_mock()
                if echo:
                    misc.logs('run-t', True)
                else:
                    misc.wait('run-t', 30)
                self.keep.assert_called_once_with('bx', common.RUN_TTL_S, dict(state='running'))

    def test_stopped_box_does_not_get_ttl_patch(self):
        self.box_get.return_value = dict(state='stopped')
        self.history.side_effect = common.OffboxError('stopped')
        self.assertEqual(self.logs()[:2], (0, 'old\n'))
        self.keep.assert_not_called()
