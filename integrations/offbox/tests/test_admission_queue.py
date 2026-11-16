"""Host FIFO liveness, capacity explanations and dispatch interlocks."""
import contextlib
import io
import json
from unittest.mock import patch, Mock
from types import SimpleNamespace

if __package__:
    from .test_boatd import Base, boatd
    from .client_fixtures import Isolated
else:
    from test_boatd import Base, boatd
    from client_fixtures import Isolated


class AdmissionQueue(Base):
    def setup_queue(self, *, attempt=1, box_id="bx_test"):
        b = self.box(box_id)
        h = self.cmd(b, pid=1001, status='queued', age=200, attempt=attempt)
        p = self.cmd(b, pid=1002, status='queued', age=100)
        boatd.mem_available = lambda: 100 * 2**30
        return b, h, p

    def events(self, name):
        return [json.loads(line) for path in (self.tmp / 'shared-logs').glob('*.ndjson')
                for line in path.read_text().splitlines() if json.loads(line)['name'] == name and json.loads(line)['kind'] == 'event']

    def test_dead_heads_are_settled_once_before_the_next_waiter_starts(self):
        for cause in ('killed', 'kill_file', 'inactive', 'failed', 'unknown'):
            with self.subTest(cause=cause):
                b, h, p = self.setup_queue(attempt=2, box_id='bx_dead_' + cause)
                if cause == 'killed':
                    self.con.execute('UPDATE commands SET killed=1 WHERE pid=?', (h,))
                if cause == 'kill_file':
                    (boatd.cmd_dir(b) / f'{h}.kill').touch()
                with patch.object(boatd, '_sh', return_value=(3, cause)) as probe, \
                        patch.object(boatd.time, 'sleep', side_effect=AssertionError('dead head blocked')):
                    boatd.admit(self.con, b, p, 'k', io.BytesIO())
                    self.assertIsNone(boatd.queue_head(self.con, b, p))
                if cause not in ('killed', 'kill_file'):
                    self.assertEqual(probe.call_args.args[0][-1], boatd.unit_name(b, h, 2))
                self.assertEqual(self.status(b, h)['status'], 'lost')
                self.assertEqual(self.status(b, p)['status'], 'running')
                result = boatd.read_result(b, h, 2)
                self.assertEqual(result['status'], 'lost')
                events = self.events('run.queue.dead_head')
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]['props']['pid'], h)
                self.assertIn('reason', events[0]['props'])
                self.assertIn('created_at', events[0]['props'])
                self.con.execute('DELETE FROM commands')
                self.con.execute('DELETE FROM boxes')
                (boatd.cmd_dir(b) / f'{h}.kill').unlink(missing_ok=True)
                for path in (self.tmp / 'shared-logs').glob('*.ndjson'):
                    path.write_text('')

    def test_live_or_unknown_units_block_even_an_old_head(self):
        b, h, p = self.setup_queue()
        for answer in ((0, 'active'), (0, 'activating'), (0, 'deactivating'), (127, ''), (1, 'bus unavailable')):
            with self.subTest(answer=answer), patch.object(boatd, '_sh', return_value=answer), \
                    patch.object(boatd.time, 'sleep', side_effect=RuntimeError('blocked')):
                with self.assertRaisesRegex(RuntimeError, 'blocked'):
                    boatd.admit(self.con, b, p, 'k', io.BytesIO())
                self.assertEqual(self.status(b, h)['status'], 'queued')
                self.assertEqual(self.status(b, p)['status'], 'queued')
        self.assertEqual(self.events('run.queue.dead_head'), [])

    def test_pending_dispatch_is_not_mistaken_for_a_dead_unit(self):
        b, h, p = self.setup_queue()
        with boatd.runner_dispatch(), patch.object(boatd, '_sh', return_value=(3, 'inactive')) as probe:
            self.assertEqual(boatd.queue_head(self.con, b, p)['pid'], h)
        probe.assert_not_called()
        self.assertEqual(self.status(b, h)['status'], 'queued')

    def test_start_publication_is_guarded_until_its_unit_exists(self):
        b = self.box()
        def spawning(box, pid, attempt):
            later = self.cmd(b, pid=pid + 1, status='queued', age=-1)
            with patch.object(boatd, '_sh', return_value=(3, 'inactive')) as probe:
                self.assertEqual(boatd.queue_head(self.con, b, later)['pid'], pid)
            probe.assert_not_called()
        with patch.object(boatd, 'disk_admit'), patch.object(boatd, 'spawn_runner', side_effect=spawning):
            boatd.start_cmd(self.con, b, {'command': 'true', 'detached': True})

    def test_memory_explanation_names_the_head_and_changes_when_it_leaves(self):
        b, h, p = self.setup_queue()
        self.con.execute("UPDATE commands SET kind='large' WHERE pid=?", (h,))
        self.cmd(b, pid=1003, status="running")
        self.con.execute("UPDATE commands SET started_at=1 WHERE pid=1003")
        clock = [10000.0]
        err = io.BytesIO()
        def tick(_):
            clock[0] += 2
            if self.status(b, h)['status'] == 'queued':
                self.con.execute("UPDATE commands SET status='exited' WHERE pid=?", (h,))
            else:
                raise RuntimeError('stop after changed reason')
        with patch.object(boatd, 'predicted_peak', side_effect=lambda con, kind: (20 if kind == 'large' else 15) * 2**30), \
                patch.object(boatd, 'mem_available', return_value=22 * 2**30), \
                patch.object(boatd, 'now', side_effect=lambda: clock[0]), patch.object(boatd.time, 'sleep', side_effect=tick):
            with self.assertRaises(RuntimeError):
                boatd.admit(self.con, b, p, 'k', err)
        lines = err.getvalue().decode().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn('position 2 of 2', lines[0])
        self.assertIn(f'behind {b}/{h}', lines[0])
        self.assertIn('needs 20.00 GiB, 10.00 GiB free', lines[0])
        self.assertIn('position 1 of 1', lines[1])
        self.assertIn('needs 15.00 GiB, 10.00 GiB free', lines[1])
        self.assertNotIn('cap', err.getvalue().decode())
        self.assertEqual([(r['props']['reason'], r['props']['position']) for r in self.events('run.queue')],
                         [('memory', 2), ('memory', 1)])

    def test_fifo_to_memory_reason_and_sixty_second_refresh(self):
        b, h, p = self.setup_queue()
        self.cmd(b, pid=1003, status='running')
        self.con.execute('UPDATE commands SET started_at=1 WHERE pid=1003')
        clock = [10000.0]
        memory = [100 * 2**30]
        ticks = [0]
        err = io.BytesIO()
        def tick(_):
            ticks[0] += 1
            clock[0] += 2 if ticks[0] < 3 else 60
            if ticks[0] == 1:
                self.con.execute("UPDATE commands SET status='exited' WHERE pid=?", (h,))
                memory[0] = 0
            if ticks[0] == 4:
                raise RuntimeError('done')
        with patch.object(boatd, 'mem_available', side_effect=lambda: memory[0]), \
                patch.object(boatd, 'now', side_effect=lambda: clock[0]), patch.object(boatd.time, 'sleep', side_effect=tick):
            with self.assertRaises(RuntimeError):
                boatd.admit(self.con, b, p, 'k', err)
        events = self.events('run.queue')
        self.assertEqual([r['props']['reason'] for r in events], ['fifo', 'memory', 'memory'])
        self.assertEqual(len(err.getvalue().splitlines()), 3)

    def test_cap_is_named_and_tied_timestamps_use_the_fifo_tiebreakers(self):
        b, h, p = self.setup_queue()
        self.con.execute("UPDATE commands SET status='running' WHERE pid=?", (h,))
        boatd.CFG['max_running'] = 1
        err = io.BytesIO()
        with patch.object(boatd.time, 'sleep', side_effect=RuntimeError('blocked')):
            with self.assertRaises(RuntimeError):
                boatd.admit(self.con, b, p, 'k', err)
        self.assertIn(b'max_running cap 1/1', err.getvalue())
        self.assertEqual(self.events('run.queue')[0]['props']['reason'], 'cap')
        boatd.CFG['max_running'] = 0
        self.con.execute("UPDATE commands SET status='queued',created_at=1")
        err = io.BytesIO()
        with patch.object(boatd.time, 'sleep', side_effect=RuntimeError('blocked')):
            with self.assertRaises(RuntimeError):
                boatd.admit(self.con, b, p, 'k', err)
        self.assertIn(b'position 2 of 2', err.getvalue())
        self.assertNotIn(b'cap', err.getvalue())

    def test_admission_reads_a_legacy_schema_without_sync_or_killed(self):
        b, h, p = self.setup_queue()
        self.con.execute('DROP INDEX commands_cpu_start')
        self.con.execute('ALTER TABLE commands DROP COLUMN sync')
        self.con.execute('ALTER TABLE commands DROP COLUMN killed')
        with patch.object(boatd, '_sh', return_value=(3, 'inactive')), \
                patch.object(boatd.time, 'sleep', side_effect=AssertionError('legacy blocked')):
            boatd.admit(self.con, b, p, 'k', io.BytesIO())
        self.assertEqual(self.status(b, h)['status'], 'lost')
        self.assertEqual(self.status(b, p)['status'], 'running')

    def test_oversized_live_head_is_admitted_alone_then_its_waiter_follows(self):
        b, h, p = self.setup_queue()
        self.con.execute("UPDATE commands SET kind='huge' WHERE pid=?", (h,))
        err = io.BytesIO()
        with patch.object(boatd, 'predicted_peak', side_effect=lambda con, kind: (200 if kind == 'huge' else 4) * 2**30), \
                patch.object(boatd, 'mem_available', return_value=20 * 2**30), \
                patch.object(boatd, '_sh', return_value=(0, 'active')), \
                patch.object(boatd.time, 'sleep', side_effect=RuntimeError('FIFO holds')):
            with self.assertRaisesRegex(RuntimeError, 'FIFO holds'):
                boatd.admit(self.con, b, p, 'k', io.BytesIO())
            boatd.admit(self.con, b, h, 'huge', err)
            self.assertEqual(self.status(b, h)['status'], 'running')
            self.assertEqual(self.status(b, p)['status'], 'queued')
            with self.assertRaisesRegex(RuntimeError, 'FIFO holds'):
                boatd.admit(self.con, b, p, 'k', io.BytesIO())
            self.con.execute("UPDATE commands SET status='exited' WHERE pid=?", (h,))
            boatd.admit(self.con, b, p, 'k', io.BytesIO())
        self.assertEqual(self.status(b, p)['status'], 'running')
        self.assertIn(b'admitted alone: needs 200.00 GiB, 8.00 GiB free', err.getvalue())
        alone = [r for r in self.events('run.queue') if r['props']['reason'] == 'admitted_alone']
        self.assertEqual(len(alone), 1)
        self.assertEqual(alone[0]['props']['position'], 1)

    def test_empty_host_bypasses_cpu_checks_but_busy_host_keeps_them(self):
        b = self.box()
        head = self.cmd(b, status='queued')
        boatd.CFG['cpu_pressure_limit'] = 50
        with patch.object(boatd, 'mem_available', return_value=100 * 2**30), \
                patch.object(boatd, 'psi', return_value=90), \
                patch.object(boatd.time, 'sleep', side_effect=RuntimeError('CPU holds')):
            boatd.admit(self.con, b, head, 'k', io.BytesIO())
            later = self.cmd(b, pid=1002, status='queued', age=0)
            with self.assertRaisesRegex(RuntimeError, 'CPU holds'):
                boatd.admit(self.con, b, later, 'k', io.BytesIO())
        self.assertEqual(self.status(b, head)['status'], 'running')
        self.assertEqual(self.status(b, later)['status'], 'queued')

    def test_killed_head_reaped_before_runner_wakes_never_becomes_a_running_hold(self):
        b, h, p = self.setup_queue()
        (boatd.cmd_dir(b) / f'{h}.err').write_text(
            boatd.offbox_disk_space.MARKER + json.dumps(dict(phase='attempt', attempt=1)) +
            '\noffbox-server: waiting; position 1 of 2; memory; waited 60 s\n')
        boatd.stage_kill(self.con, b, h, False)
        self.assertTrue(json.loads(self.status(b, h)['metrics'])['kill_request']['before_spawn'])
        boatd.admit(self.con, b, p, 'k', io.BytesIO())
        self.assertEqual(self.status(b, h)['status'], 'lost')
        with patch.object(boatd, 'load_cfg'), patch.object(boatd, 'ct_exec') as guest:
            boatd.run_cmd(b, h)
        guest.assert_not_called()
        with patch.object(boatd, 'cleanup_run', side_effect=AssertionError('never dispatched')):
            boatd.restore_kill_result(self.con, self.status(b, h), boatd.read_result(b, h, 1))
        self.assertEqual(self.status(b, h)['status'], 'lost')
        self.assertEqual(boatd.held_runs(self.con, b), [])

    def test_dead_head_recovers_current_attempt_receipts_instead_of_overwriting_them(self):
        for outcome in ('success', 'failure', 'interrupted', 'retry', 'unknown_cleanup', 'stale_attempt', 'legacy'):
            with self.subTest(outcome=outcome):
                b = self.box('bx_receipt_' + outcome)
                h = self.cmd(b, pid=1001, status='queued', age=200)
                p = self.cmd(b, pid=1002, status='queued', age=100)
                receipt = dict(attempt=1, status='exited', exit_code=0 if outcome == 'success' else 7,
                               started_at=100, ended_at=110)
                if outcome in ('interrupted', 'retry', 'unknown_cleanup'):
                    info = dict(cause='boatd_restart', phase='running', cleanup='clean', retry=outcome == 'retry')
                    receipt.update(status='interrupted', exit_code=None, interruption=info)
                    if outcome == 'retry':
                        self.con.execute('UPDATE commands SET retry_interrupted=1 WHERE box_id=?', (b,))
                if outcome == 'unknown_cleanup':
                    receipt.update(status='running', ended_at=None)
                    receipt['interruption']['cleanup'] = 'unknown'
                if outcome == 'stale_attempt':
                    receipt['attempt'] = 2
                boatd.write_json(boatd.result_path(b, h), receipt)
                if outcome == 'legacy':
                    self.con.execute('DROP INDEX commands_cpu_start')
                    self.con.execute('ALTER TABLE commands DROP COLUMN sync')
                    self.con.execute('ALTER TABLE commands DROP COLUMN killed')
                cleanup = dict(cleanup='unknown' if outcome == 'unknown_cleanup' else 'clean', leftover_killed=0, remaining=0)
                with patch.object(boatd, '_sh', return_value=(3, 'inactive')), \
                        patch.object(boatd, 'command_probe', return_value=dict(readable=False, pids=None)), \
                        patch.object(boatd, 'cleanup_run', return_value=cleanup):
                    boatd.queue_head(self.con, b, p)
                row = self.status(b, h)
                if outcome == 'stale_attempt':
                    self.assertEqual(row['status'], 'lost')
                elif outcome == 'retry':
                    self.assertEqual((row['status'], row['attempt']), ('queued', 2))
                    self.assertIn((b, h, 2), self.f.spawned)
                elif outcome == 'unknown_cleanup':
                    self.assertEqual(row['status'], 'running')
                    self.assertEqual(boatd.read_result(b, h, 1)['interruption']['cleanup'], 'unknown')
                else:
                    self.assertEqual((row['status'], row['exit_code']), (receipt['status'], receipt['exit_code']))
                    self.assertEqual(boatd.read_result(b, h, 1), receipt)
                events = [e for e in self.events('run.queue.dead_head') if e['ids'].get('box') == b]
                self.assertEqual(len(events), 1 if outcome == 'stale_attempt' else 0)

    def test_legacy_kill_file_with_current_receipt_recovers_without_killed_column(self):
        self.con.execute('DROP INDEX commands_cpu_start')
        self.con.execute('ALTER TABLE commands DROP COLUMN sync')
        self.con.execute('ALTER TABLE commands DROP COLUMN killed')
        for outcome in ('success', 'failure', 'interrupted', 'lost', 'pending_cleanup'):
            with self.subTest(outcome=outcome):
                b, h, p = self.setup_queue(box_id='bx_legacy_kill_' + outcome)
                saved = dict(attempt=1, status='exited', exit_code=0 if outcome == 'success' else 7,
                             started_at=100, ended_at=110)
                if outcome == 'interrupted':
                    saved.update(status='interrupted', exit_code=None,
                                 interruption=dict(cleanup='clean', phase='running', retry=False))
                if outcome == 'lost':
                    saved.update(status='lost', exit_code=None)
                receipt = saved
                if outcome == 'pending_cleanup':
                    receipt = dict(attempt=1, status='running', started_at=100, kill_pending=True, held_result=saved)
                boatd.write_json(boatd.result_path(b, h), receipt)
                (boatd.cmd_dir(b) / f'{h}.kill').write_text('kill')
                cleanup = dict(cleanup='unknown' if outcome == 'pending_cleanup' else 'clean',
                               leftover_killed=0, remaining=0)
                with patch.object(boatd, 'cleanup_run', return_value=cleanup) as probe:
                    self.assertEqual(boatd.queue_head(self.con, b, p)['pid'], p)
                probe.assert_called_once()
                row = self.status(b, h)
                if outcome == 'pending_cleanup':
                    self.assertEqual(row['status'], 'running')
                    self.assertEqual(boatd.read_result(b, h, 1)['held_result'], saved)
                else:
                    self.assertEqual((row['status'], row['exit_code']), (saved['status'], saved['exit_code']))
                self.assertFalse(any(e['ids'].get('box') == b for e in self.events('run.queue.dead_head')))

    def stream_frames(self, b, p, on_frame=None):
        frames = []
        class Sink:
            def write(self, data):
                if data == b'0\r\n\r\n':
                    return
                frame = json.loads(data.split(b'\r\n', 1)[1][:-2])
                frames.append(frame)
                if on_frame:
                    on_frame(frame, frames)
            def flush(self):
                pass
        handler = SimpleNamespace(wfile=Sink(), send_response=Mock(), send_header=Mock(), end_headers=Mock())
        boatd.Handler._stream(handler, self.con, b, p, 0, 0)
        return frames

    def test_dead_head_exposes_never_admitted_loss_in_status_history_and_stream(self):
        b, h, p = self.setup_queue()
        with patch.object(boatd, '_sh', return_value=(3, 'inactive')):
            boatd.admit(self.con, b, p, 'k', io.BytesIO())
        status = boatd.cmd_status_json(self.con, b, h)
        exit_frame = self.stream_frames(b, h)[-1]
        for result in (status, exit_frame):
            self.assertEqual(result['status'], 'lost')
            self.assertIsNone(result['startedAt'])
            self.assertTrue(result['notAdmitted'])
            self.assertEqual(result['queueLostReason'], 'unit_inactive')
        self.assertTrue(boatd.cmd_status_json(self.con, b, p)['running'])
        self.assertFalse(boatd.cmd_status_json(self.con, b, p)['notAdmitted'])

    def test_replayed_queue_loss_receipt_settles_client_without_guest_markers(self):
        from offbox_lib import api, common, lease, misc, runs
        for route in ('settle', 'head', 'prior', 'kill_file'):
            with self.subTest(route=route):
                b, h, p = self.setup_queue(box_id='bx_replay_' + route)
                receipt = dict(attempt=1, status='lost', exit_code=None, started_at=None,
                               ended_at=10000, queue_lost_reason='unit_inactive')
                boatd.write_json(boatd.result_path(b, h), receipt)
                if route == 'kill_file':
                    (boatd.cmd_dir(b) / f'{h}.kill').touch()
                with patch.object(boatd, '_sh', return_value=(3, 'inactive')), \
                        patch.object(boatd, 'cleanup_run', side_effect=AssertionError('receipt proves no dispatch')):
                    if route == 'head':
                        boatd.admit(self.con, b, p, 'k', io.BytesIO())
                    elif route == 'prior':
                        boatd.record_command_result(self.con, self.status(b, h), dict(status='running'), {}, 'following')
                    else:
                        boatd.settle_cmd(self.con, self.status(b, h))
                status = boatd.cmd_status_json(self.con, b, h)
                frame = self.stream_frames(b, h)[-1]
                self.assertTrue(status['notAdmitted'])
                self.assertTrue(frame['notAdmitted'])
                self.assertEqual(status['queueLostReason'], 'unit_inactive')
                client = Isolated()
                client.setUp()
                try:
                    client.con.execute("INSERT INTO runs(run_id,box_id,command_id,process_id,status,mode,pulls) "
                                       "VALUES ('run-replay',?,'cmd-replay',?,'running','bg','[]')", (b, h))
                    client.con.commit()
                    with contextlib.ExitStack() as stack:
                        stack.enter_context(patch.object(api, 'BACKEND', 'server'))
                        stack.enter_context(patch.object(common, '_BACKEND', 'server'))
                        stack.enter_context(patch.dict('os.environ', {'OFFBOX_BACKEND': 'server'}))
                        stack.enter_context(patch.object(api, 'get', return_value=dict(state='running')))
                        stack.enter_context(patch.object(api, 'cmd_status', return_value=status))
                        stack.enter_context(patch.object(api, 'history_get', return_value=dict(command=status)))
                        stack.enter_context(patch.object(api, 'cmd_attach', return_value=iter([frame])))
                        for module, name in ((runs, '_ttl_keeper'), (runs, 'settle_docker'), (lease, 'idle_ttl'),
                                             (misc, '_refresh_running_ttl'), (misc, '_catch_up_finished')):
                            stack.enter_context(patch.object(module, name))
                        stack.enter_context(patch.object(misc, '_catch_up_log', return_value='complete'))
                        recorded = stack.enter_context(patch.object(runs, 'recorded_exit', side_effect=AssertionError('no .rc')))
                        alive = stack.enter_context(patch.object(runs, 'remote_alive', side_effect=AssertionError('no .pid')))
                        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                        self.assertEqual(misc.wait('run-replay', 45), common.EXIT_INFRA)
                        self.assertEqual(lease.active_runs(client.con, b), 0)
                        self.assertEqual(client.con.execute("SELECT status FROM runs WHERE run_id='run-replay'").fetchone()[0], 'lost')
                        recorded.assert_not_called()
                        alive.assert_not_called()
                finally:
                    self.assertTrue(client.doCleanups())
                self.con.execute('DELETE FROM commands')
                self.con.execute('DELETE FROM boxes')

    def test_stream_output_cannot_starve_running_or_retry_queue_status(self):
        b = self.box()
        p = self.cmd(b, status='queued')
        (boatd.cmd_dir(b) / f'{p}.out').write_bytes(b'x' * (4 * 256 * 1024))
        clock = [10000]
        def progress(frame, frames):
            if frame['type'] == 'hello':
                self.assertEqual(frame['status'], 'queued')
                self.con.execute("UPDATE commands SET status='running',started_at=? WHERE box_id=? AND pid=?", (clock[0], b, p))
                clock[0] += 20
            elif frame['type'] == 'heartbeat':
                if frame['status'] == 'running':
                    self.con.execute("UPDATE commands SET status='queued',attempt=2,started_at=NULL WHERE box_id=? AND pid=?", (b, p))
                    clock[0] += 20
                else:
                    self.assertEqual(frame['status'], 'queued')
                    raise BrokenPipeError('client has seen both statuses during output')
            elif frame['type'] == 'stdout':
                clock[0] += 20
                if sum(f['type'] == 'stdout' for f in frames) >= 3:
                    self.fail('continuous output starved status frames')
        with patch.object(boatd, 'now', side_effect=lambda: clock[0]), \
                patch.object(boatd.time, 'sleep', side_effect=AssertionError('output is still flowing')):
            frames = self.stream_frames(b, p, progress)
        self.assertTrue(any(f['type'] == 'heartbeat' and f['status'] == 'running' for f in frames))
        self.assertTrue(any(f['type'] == 'attempt' and f['status'] == 'queued' and f['attempt'] == 2 for f in frames))
        self.assertEqual(frames[-1]['status'], 'queued')

    def test_terminal_stream_keeps_output_chunks_bounded_before_exit(self):
        b = self.box()
        p = self.cmd(b, status='exited')
        self.con.execute('UPDATE commands SET exit_code=7 WHERE box_id=? AND pid=?', (b, p))
        data = b'x' * (3 * 256 * 1024 + 17)
        (boatd.cmd_dir(b) / f'{p}.out').write_bytes(data)
        frames = self.stream_frames(b, p)
        chunks = [f['data'].encode() for f in frames if f['type'] == 'stdout']
        self.assertEqual(b''.join(chunks), data)
        self.assertLessEqual(max(map(len, chunks)), 256 * 1024)
        self.assertEqual((frames[-1]['type'], frames[-1]['exitCode']), ('exit', 7))
