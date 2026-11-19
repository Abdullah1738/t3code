"""Slow daemon writes must remain retryable, including an add which committed late."""
import contextlib
import json
import subprocess
import threading
from unittest.mock import Mock, patch

if __package__:
    from .test_boatd import Base, boatd
else:
    from test_boatd import Base, boatd


class IncusSlowTests(Base):
    def setUp(self):
        self.real_probe = boatd.command_probe
        super().setUp()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(boatd, '_INCUS_SLOW_UNTIL', 0))
        self.stack.enter_context(patch.dict(boatd._INCUS_ACTIVE, {}, clear=True))
        boatd.CFG['ssh_host'] = '100.75.104.72'

    def drive_proxy(self, *, device='ssh', exists=True, fail_always=False, late_commit=0,
                    provision=False, cleanup_fails=False, recover=False, duplicate=False, recovery_failure=None):
        bid = self.box(state='provisioning', running=False)
        devices = {device: {'type': 'proxy', 'listen': 'tcp:old:1'}} if exists else {}
        calls, records, writes = [], [], []
        broken = [fail_always]
        cleanup_blocked = [cleanup_fails]

        def run(argv, **kw):
            args = argv[1:]
            calls.append((args, kw['timeout']))
            out = b''
            if args[:1] == ['query']:
                out = json.dumps({'status': 'Running' if bid in self.f.running else 'Stopped', 'config': {'user.offbox.provision': bid},
                                  'devices': devices}).encode()
            elif args[:3] in (['config', 'device', 'set'], ['config', 'device', 'add']):
                props = dict(x.split('=', 1) for x in args[5:] if '=' in x)
                if args[4] != device:
                    devices[args[4]] = {'type': 'proxy', **props}
                    return subprocess.CompletedProcess(argv, 0, b'', b'')
                writes.append(args)
                attempt = len(writes)
                if attempt == late_commit or (attempt > 1 and not broken[0]):
                    devices[args[4]] = {'type': 'proxy', **props}
                if attempt == 1 or broken[0] or attempt == late_commit:
                    raise subprocess.TimeoutExpired(argv, kw['timeout'])
                if duplicate and attempt == 2:
                    return subprocess.CompletedProcess(argv, 1, b'', b'Device already exists')
            elif args[:3] == ['config', 'device', 'remove']:
                if cleanup_blocked[0]:
                    raise subprocess.TimeoutExpired(argv, kw['timeout'])
                devices.pop(args[4], None)
            elif args[0] == 'start':
                self.f.running.add(bid)
            elif args[0] == 'stop':
                self.f.running.discard(bid)
            return subprocess.CompletedProcess(argv, 0, out, b'')

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(boatd, 'incus', self.saved['incus']))
            stack.enter_context(patch.object(boatd.subprocess, 'run', side_effect=run))
            stack.enter_context(patch.object(boatd.toollog, 'emit', side_effect=lambda *a, **k: records.append((a, k))))
            if fail_always or provision:
                stack.enter_context(patch.object(boatd, 'apply_size'))
                identity = stack.enter_context(patch.object(boatd, '_fresh_identity'))
                self.saved['provision'](bid, ('image', 'offbox-base'), 'default')
                row = self.state(bid)
                if not fail_always:
                    self.assertEqual(row['state'], 'ready')
                    self.assertIsNone(row['start_error'])
                    identity.assert_called_once_with(bid)
                else:
                    self.assertEqual(row['state'], 'stopping' if cleanup_fails else 'archived')
                    self.assertIn('incus_slow', row['error'])
                    self.assertEqual(boatd.box_json(self.con, row)['health'], 'unhealthy')
                    self.assertEqual(json.loads(row['start_error'])['provision'], True)
                    if cleanup_fails:
                        self.assertEqual(row['ssh_port'], 22000)
                        self.assertIsNone(row['stopped_at'])
                        with self.assertRaises(boatd.Fail) as cm:
                            boatd.resume_box(self.con, bid, {})
                        self.assertEqual(cm.exception.code, 'incus_slow')
                        cleanup_blocked[0] = False
                        boatd.reap_once(self.con)
                        row = self.state(bid)
                        self.assertEqual(row['state'], 'archived')
                    self.assertIsNone(row['ssh_port'])
                    self.assertIsNone(row['mgmt_ssh_port'])
                    self.assertEqual(boatd.running_box_count(self.con), 0)
                    self.assertFalse(devices)
                    failures = [k for a, k in records if a[1] == 'box_start_failed']
                    self.assertEqual(len(failures), 1)
                    self.assertEqual(failures[0]['props']['class'], 'incus_slow')
                    if recover:
                        broken[0] = False
                        if recovery_failure == 'identity':
                            identity.side_effect = boatd.Fail(500, 'incus_failed', 'identity refresh failed')
                        if recovery_failure == 'boot':
                            stack.enter_context(patch.object(boatd, '_wait_boot',
                                                side_effect=boatd.Fail(500, 'boot_timeout', 'boot failed')))
                        workers = []
                        with patch.object(boatd.threading, 'Thread',
                                          side_effect=lambda target, **kw: Mock(start=lambda: workers.append(target))):
                            boatd.resume_box(self.con, bid, {})
                        workers.pop(0)()
                        row = self.state(bid)
                        if recovery_failure:
                            self.assertEqual(row['state'], 'archived')
                            self.assertNotIn(bid, self.f.running)
                            self.assertIsNone(row['ssh_port'])
                            self.assertIsNone(row['mgmt_ssh_port'])
                            boatd.stop_box(self.con, bid, 'client release')
                            self.assertNotIn(bid, self.f.running)
                        else:
                            self.assertEqual(row['state'], 'ready')
                            self.assertIsNone(row['start_error'])
                        if recovery_failure != 'boot':
                            identity.assert_called_once_with(bid)
                        boatd.scratch().create.assert_called_once_with(bid, 'ardud')
            elif device == 'ssh':
                boatd._ensure_proxy(bid, 22000)
            else:
                self.con.execute('UPDATE boxes SET mgmt_ssh_port=22000 WHERE id=?', (bid,))
                boatd._ensure_mgmt_proxy(self.con, bid)
        latency = [k for a, k in records if a[1] == 'incus_call']
        self.assertTrue(latency)
        self.assertTrue(any(k['props']['outcome'] == 'timeout' for k in latency))
        self.assertTrue(all('duration_ms' in k for k in latency))
        initial = [(args, timeout) for args, timeout in calls
                   if args[:3] in (['config', 'device', 'set'], ['config', 'device', 'add'])]
        self.assertEqual(initial[0][1], 30)
        self.assertLessEqual(sum(timeout for args, timeout in initial[:2]), 150)
        if not provision and not recover:
            self.assertEqual(len(writes), 1 if late_commit == 1 else 2)

    def test_set_retries_and_records_latency(self):
        self.drive_proxy()

    def test_add_retries_and_records_latency(self):
        self.drive_proxy(exists=False)

    def test_management_set_retries(self):
        self.drive_proxy(device='offbox-mgmt-ssh')

    def test_management_add_retries(self):
        self.drive_proxy(device='offbox-mgmt-ssh', exists=False)

    def test_host_probe_records_every_outcome_without_changing_its_result(self):
        cases = ((0, (0, 'ready'), 'ok'), (1, (1, 'ready'), 'error'),
                 (subprocess.TimeoutExpired('incus', 10), (127, ''), 'timeout'),
                 (OSError('cannot spawn'), (127, ''), 'error'))
        for outcome, expected, label in cases:
            with self.subTest(outcome=label), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(boatd, 'incus', self.saved['incus']))
                run = stack.enter_context(patch.object(boatd.subprocess, 'run'))
                if isinstance(outcome, Exception):
                    run.side_effect = outcome
                else:
                    run.return_value = subprocess.CompletedProcess(['incus'], outcome, b' ready\n', b'')
                emit = stack.enter_context(patch.object(boatd.toollog, 'emit'))
                self.assertEqual(self.saved['_sh'](['incus', 'query', '/1.0'], timeout=10), expected)
                events = [c.kwargs for c in emit.call_args_list if c.args[1] == 'incus_call']
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]['props']['commandKind'], 'query')
                self.assertEqual(events[0]['props']['outcome'], label)
                self.assertGreaterEqual(events[0]['duration_ms'], 0)

    def test_command_launcher_records_success_nonzero_and_spawn_failure(self):
        bid = self.box()
        for pid, outcome in enumerate((0, 7, OSError('cannot spawn')), start=1001):
            with self.subTest(outcome=outcome), contextlib.ExitStack() as stack:
                self.cmd(bid, pid=pid, status='queued')
                self.con.execute('UPDATE commands SET sync=1,command=? WHERE pid=?', ('private command', pid))
                stack.enter_context(patch.object(boatd, 'load_cfg'))
                stack.enter_context(patch.object(boatd, 'incus', self.saved['incus']))
                stack.enter_context(patch.object(boatd, 'guest_command', return_value={'state': 'absent'}))
                stack.enter_context(patch.object(boatd, 'disk_preflight', return_value=False))
                follow = stack.enter_context(patch.object(boatd, 'follow_guest'))
                def run(argv, **kwargs):
                    if argv[-1].startswith('nohup /usr/local/sbin/boatd-wrap '):
                        if isinstance(outcome, Exception):
                            raise outcome
                        return subprocess.CompletedProcess(argv, outcome, b'', b'')
                    return subprocess.CompletedProcess(argv, 0, b'', b'')
                process = stack.enter_context(patch.object(boatd.subprocess, 'run', side_effect=run))
                emit = stack.enter_context(patch.object(boatd.toollog, 'emit'))
                self.assertEqual(boatd.run_cmd(bid, pid), 0)
                follow.assert_called_once()
                self.assertIs(follow.call_args.kwargs['launching'], True)
                self.assertEqual(len(process.call_args_list), 3)
                self.assertTrue(process.call_args.args[0][-1].startswith('nohup /usr/local/sbin/boatd-wrap '))
                events = [c.kwargs for c in emit.call_args_list if c.args[1] == 'incus_call']
                self.assertEqual(len(events), 3)
                props = events[-1]['props']
                self.assertEqual(props['commandKind'], 'exec')
                self.assertEqual(props['exitCode'], None if isinstance(outcome, Exception) else outcome)
                self.assertEqual(props['outcome'], 'ok' if outcome == 0 else 'error')
                self.assertGreaterEqual(events[-1]['duration_ms'], 0)
                self.assertNotIn('private command', repr(events))

    def test_late_add_commit_is_read_back_without_duplicate_add(self):
        self.drive_proxy(exists=False, late_commit=1)

    def test_second_timeout_commit_is_read_back(self):
        self.drive_proxy(exists=False, late_commit=2)

    def test_add_commits_between_retry_read_and_add_for_both_proxies(self):
        for device in ('ssh', 'offbox-mgmt-ssh'):
            with self.subTest(device=device):
                self.con.execute('DELETE FROM boxes')
                self.drive_proxy(exists=False, device=device, duplicate=True)

    def test_retry_finishes_provision_ready(self):
        self.drive_proxy(provision=True)

    def test_exhausted_set_timeout_archives_and_frees_ports(self):
        self.drive_proxy(fail_always=True)

    def test_exhausted_add_timeout_archives_and_frees_ports(self):
        self.drive_proxy(exists=False, fail_always=True)

    def test_exhausted_management_set_timeout_archives_and_frees_ports(self):
        self.drive_proxy(device='offbox-mgmt-ssh', fail_always=True)

    def test_exhausted_management_add_timeout_archives_and_frees_ports(self):
        self.drive_proxy(device='offbox-mgmt-ssh', exists=False, fail_always=True)

    def test_uncertain_cleanup_reserves_ports_until_reaper_confirms_removal(self):
        self.drive_proxy(fail_always=True, cleanup_fails=True)

    def test_failed_copy_retries_identity_on_normal_resume(self):
        self.drive_proxy(fail_always=True, recover=True)

    def test_boot_failure_after_proxy_recovery_stops_container_and_frees_ports(self):
        self.drive_proxy(fail_always=True, recover=True, recovery_failure='boot')

    def test_identity_failure_after_proxy_recovery_stops_container_and_frees_ports(self):
        self.drive_proxy(fail_always=True, recover=True, recovery_failure='identity')

    def test_maintenance_yields_to_pending_starts(self):
        self.box(state='resuming', running=False)
        with patch.object(boatd, 'incus', self.saved['incus']), patch.object(boatd.subprocess, 'run') as run:
            for args in [('snapshot', 'create', 'bx-bbbbbbbb', 'auto'),
                         ('snapshot', 'delete', 'bx-bbbbbbbb', 'old'), ('delete', 'bx-bbbbbbbb', '--force')]:
                with self.subTest(args=args):
                    self.assertEqual(boatd.incus(*args, check=False).returncode, 75)
            run.assert_not_called()

    def test_existing_delete_does_not_hold_up_new_start_and_other_deletes_defer(self):
        entered, release = threading.Event(), threading.Event()
        errors = []
        def run(argv, **kw):
            if argv[1] == 'delete':
                entered.set()
                if not release.wait(5):
                    raise AssertionError('start was blocked by delete')
            return subprocess.CompletedProcess(argv, 0, b'', b'')
        def delete():
            try:
                boatd.incus('delete', 'sv-old')
            except Exception as error:
                errors.append(error)
        with patch.object(boatd, 'incus', self.saved['incus']), patch.object(boatd.subprocess, 'run', side_effect=run):
            worker = threading.Thread(target=delete)
            worker.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(boatd.incus('delete', 'sv-next', check=False).returncode, 75)
                self.assertEqual(boatd.incus('config', 'device', 'set', 'bx-aaaaaaaa', 'ssh', 'listen=tcp:host:22').returncode, 0)
            finally:
                release.set()
                worker.join(5)
            self.assertFalse(worker.is_alive())
            self.assertFalse(errors)

    def test_slow_write_paces_separate_timer_process_and_rollup_is_queryable(self):
        with patch.object(boatd, 'incus', self.saved['incus']), patch.object(boatd.subprocess, 'run',
                side_effect=subprocess.TimeoutExpired(['incus', 'config', 'set'], 30)):
            with self.assertRaises(subprocess.TimeoutExpired) as cm:
                boatd.incus('config', 'set', 'bx-aaaaaaaa', 'limits.memory=4GiB', timeout=30)
        self.assertEqual(cm.exception.incus_details['command_kind'], 'config.set')
        # A separate timer has none of the daemon's in-memory cooldown.
        boatd._INCUS_SLOW_UNTIL = 0
        self.assertEqual(boatd.maintenance_hold(), 'incus_slow')
        rows = [json.loads(line) for path in (self.tmp / 'shared-logs').glob('*.ndjson')
                for line in path.read_text().splitlines()]
        row = next(row for row in rows if row['name'] == 'incus_call')
        self.assertEqual(row['props']['commandKind'], 'config.set')
        self.assertEqual(row['props']['outcome'], 'timeout')
        rollup = boatd.toollog.rollup()
        self.assertEqual(rollup['countsByName']['incus_call'], 1)
        self.assertGreaterEqual(rollup['durationMs']['incus_call']['p95'], 0)

    def test_cleanup_refuses_foreign_instance_before_stop(self):
        bid = self.box(state='provisioning', running=False)
        def incus(*args, **kw):
            self.assertEqual(args[0], 'query', 'foreign instance must never be stopped')
            return subprocess.CompletedProcess(args, 0, b'{"config":{}}', b'')
        with patch.object(boatd, 'incus', side_effect=incus):
            boatd.failed_start(self.con, bid, boatd.Fail(503, 'incus_slow', 'copy timed out'), provision=True)
        row = self.state(bid)
        self.assertEqual(row['state'], 'stopping')
        self.assertEqual(row['ssh_port'], 22000)

    def test_stale_cleanup_pass_does_not_stop_a_resumed_box(self):
        for index, state in enumerate(('resuming', 'ready', 'running', 'deleted', 'stopping')):
            with self.subTest(state=state):
                bid = self.box(f'bx_{index:08d}', state=state)
                if state != 'stopping':
                    boatd.set_box(self.con, bid, start_error=json.dumps({'class': 'incus_slow'}),
                                  deleted_at=boatd.now() if state == 'deleted' else None)
                with patch.object(boatd, 'incus') as incus:
                    boatd.continue_failed_start(self.con, bid)
                incus.assert_not_called()
                self.assertEqual(self.state(bid)['state'], state)

    def test_proxies_share_a_budget_even_when_both_devices_are_slow(self):
        bid = self.box(state='resuming', running=False)
        clock, timeouts = [0.0], []
        def incus(*args, timeout=600, **kw):
            if args[0] == 'query':
                return subprocess.CompletedProcess(args, 0, b'{"devices":{}}', b'')
            timeouts.append(timeout)
            clock[0] += timeout
            # The stock proxy takes its entire first and second allowance, then succeeds.
            if args[4] == 'ssh' and len(timeouts) == 2:
                return subprocess.CompletedProcess(args, 0, b'', b'')
            raise boatd.Fail(503, 'incus_slow', 'timeout', {'command_kind': 'config.device.add'})
        with patch.object(boatd.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(boatd, 'incus', side_effect=incus):
            with self.assertRaises(boatd.Fail) as cm:
                boatd._prepare_proxies(self.con, bid)
        self.assertEqual(cm.exception.code, 'incus_slow')
        self.assertLessEqual(sum(timeouts), 180.001)
        self.assertFalse(hasattr(boatd._PROXY_BUDGET, 'end'))

    def test_query_timeout_during_recovery_does_not_abort_healthy_sibling(self):
        first = self.box()
        second = self.box('bx_bbbbbbbb')
        self.cmd(first)
        self.cmd(second)
        def run(argv, **kw):
            if 'bx-aaaaaaaa' in argv[2]:
                raise subprocess.TimeoutExpired(argv, kw['timeout'])
            return subprocess.CompletedProcess(argv, 0, b'{"status":"Stopped"}', b'')
        with patch.object(boatd, 'incus', self.saved['incus']), \
                patch.object(boatd.subprocess, 'run', side_effect=run):
            views = [self.real_probe(self.status(bid, 1001)) for bid in (first, second)]
        self.assertEqual(views[0]['reason'], 'box_unreadable')
        self.assertTrue(views[1]['readable'])

    def test_non_proxy_timeouts_keep_existing_cleanup_contract(self):
        for args in [('init', 'base', 'bx-aaaaaaaa'),
                     ('config', 'device', 'add', 'bx-aaaaaaaa', 'offbox-tmp', 'disk')]:
            with self.subTest(args=args), patch.object(boatd, 'incus', self.saved['incus']), \
                    patch.object(boatd.subprocess, 'run', side_effect=subprocess.TimeoutExpired(args, 30)):
                with self.assertRaises(subprocess.TimeoutExpired):
                    boatd.incus(*args, timeout=30)

    def test_startup_restore_fences_timer_before_proxy_preparation(self):
        bid = self.box(state='ready', running=False)
        def prepare(con, box):
            self.assertEqual(boatd.maintenance_hold(), 'bring_up')
            self.assertEqual(self.state(box)['state'], 'resuming')
        with patch.object(boatd, '_prepare_proxies', side_effect=prepare):
            self.assertIsNone(boatd.start_container(bid))
        self.assertEqual(self.state(bid)['state'], 'ready')

    def test_saved_copy_deletes_are_durable_paced_and_protect_referenced_copies(self):
        bid = self.box(state='resuming')
        self.con.execute("INSERT INTO saved(owner,name,instance,status) VALUES('ardud','base','sv-live','ready')")
        boatd.queue_saved_delete(self.con, 'sv-live')
        boatd.queue_saved_delete(self.con, 'sv-old')
        with patch.object(boatd, 'incus', self.saved['incus']), patch.object(boatd.subprocess, 'run') as run:
            boatd.drain_saved_deletes(self.con)
            run.assert_not_called()
        self.assertEqual(self.con.execute('SELECT count(*) FROM incus_deletes').fetchone()[0], 2)
        boatd.set_box(self.con, bid, state='ready')
        with patch.object(boatd, 'incus', self.saved['incus']), patch.object(boatd.subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 0, b'', b'')) as run:
            boatd.drain_saved_deletes(self.con)
        self.assertEqual(run.call_args.args[0], ['incus', 'delete', 'sv-old', '--force'])
        self.assertEqual([r[0] for r in self.con.execute('SELECT instance FROM incus_deletes')], ['sv-live'])

    def test_resume_is_single_flight_and_late_failure_cannot_stop_ready_box(self):
        bid = self.box(state='archived', running=False)
        workers = []
        def thread(target, **kw):
            return Mock(start=lambda: workers.append(target))
        with patch.object(boatd.threading, 'Thread', side_effect=thread):
            boatd.resume_box(self.con, bid, {})
            boatd.resume_box(self.con, bid, {})
        self.assertEqual(len(workers), 1)
        def late_failure(con, box):
            boatd.set_box(con, box, state='ready')
            self.cmd(box)
            raise boatd.Fail(503, 'incus_slow', 'older worker exhausted')
        with patch.object(boatd, '_prepare_proxies', side_effect=late_failure):
            workers[0]()
        self.assertEqual(self.state(bid)['state'], 'ready')
        self.assertIsNone(self.state(bid)['start_error'])
        self.assertFalse(any(call[0] == 'stop' for call in self.f.calls))
        self.assertEqual(self.status(bid, 1001)['status'], 'running')

    def test_box_lock_contention_preserves_failure_for_reaper(self):
        bid = self.box(state='resuming', running=False)
        entered, release = threading.Event(), threading.Event()
        def hold():
            with boatd.boatd_tmp.lock(bid):
                entered.set()
                release.wait(5)
        worker = threading.Thread(target=hold)
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            boatd.failed_start(self.con, bid, boatd.Fail(503, 'incus_slow', 'proxy timeout'))
            self.assertEqual(self.state(bid)['state'], 'stopping')
            self.assertIsNotNone(self.state(bid)['start_error'])
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        def incus(*args, **kw):
            return subprocess.CompletedProcess(args, 0, b'{"status":"Stopped","devices":{}}', b'')
        with patch.object(boatd, 'incus', side_effect=incus):
            boatd.reap_once(self.con)
        self.assertEqual(self.state(bid)['state'], 'archived')
        self.assertIsNone(self.state(bid)['ssh_port'])

    def test_full_reconcile_fences_saved_backlog_before_restore_threads(self):
        self.box(state='ready', running=False)
        boatd.queue_saved_delete(self.con, 'sv-obsolete')
        with patch.object(boatd, 'incus', self.saved['incus']), \
                patch.object(boatd.subprocess, 'run') as run, \
                patch.object(boatd, 'start_container', return_value=None), \
                patch.object(boatd, 'sync_snaps', return_value=(0, 0)):
            boatd.reconcile(self.con)
        run.assert_not_called()
        self.assertEqual(self.con.execute('SELECT count(*) FROM incus_deletes').fetchone()[0], 1)

    def test_saved_delete_yields_to_storage_pressure_and_persistent_gap(self):
        boatd.CFG['state_dataset'] = 'offbox/state'
        samples = [{'freeing_bytes': boatd.disk.FREEING_LIMIT, 'io_full_avg10': 0},
                   {'freeing_bytes': 0, 'io_full_avg10': boatd.disk.IO_FULL_LIMIT}]
        with patch.object(boatd, 'incus', self.saved['incus']), patch.object(boatd.subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 0, b'', b'')) as run:
            for sample in samples:
                with self.subTest(sample=sample), patch.object(boatd.disk, 'cleanup_pressure', return_value=sample):
                    self.assertEqual(boatd.incus('delete', 'sv-old', check=False).returncode, 75)
            run.assert_not_called()
            with patch.object(boatd.disk, 'cleanup_pressure', return_value={'freeing_bytes': 0, 'io_full_avg10': 0}):
                self.assertEqual(boatd.incus('delete', 'sv-old', check=False).returncode, 0)
                # This hold survives processes and covers a fast CLI with asynchronous freeing.
                boatd._INCUS_SLOW_UNTIL = 0
                self.assertEqual(boatd.incus('delete', 'sv-next', check=False).returncode, 75)
                run.assert_called_once()

    def test_ordinary_stop_cannot_bypass_pending_proxy_cleanup(self):
        bid = self.box(state='stopping', running=False)
        self.con.execute('UPDATE boxes SET start_error=? WHERE id=?',
                         (json.dumps({'class': 'incus_slow', 'cleanup': 'unknown'}), bid))
        with patch.object(boatd, '_failed_start') as cleanup:
            boatd.stop_box(self.con, bid, 'client release')
        cleanup.assert_called_once_with(self.con, bid)
        self.assertEqual(self.state(bid)['state'], 'stopping')
        self.assertEqual(self.state(bid)['ssh_port'], 22000)

    def test_start_arriving_during_pressure_sample_fences_delete_dispatch(self):
        bid = self.box(state='ready')
        boatd.CFG['state_dataset'] = 'offbox/state'
        def pressure(pool):
            boatd.set_box(self.con, bid, state='resuming')
            return {'freeing_bytes': 0, 'io_full_avg10': 0}
        with patch.object(boatd, 'incus', self.saved['incus']), patch.object(boatd.subprocess, 'run') as run, \
                patch.object(boatd.disk, 'cleanup_pressure', side_effect=pressure):
            self.assertEqual(boatd.incus('delete', 'sv-obsolete', check=False).returncode, 75)
        run.assert_not_called()

    def test_deferred_completion_snapshot_survives_until_bringup_finishes(self):
        bid = self.box(state='ready')
        other = self.box('bx_bbbbbbbb', state='resuming')
        with patch.object(boatd, 'incus', self.saved['incus']), patch.object(boatd.subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 0, b'', b'')) as run:
            self.assertIsNone(boatd.snapshot(self.con, bid, 'auto'))
            run.assert_not_called()
            self.assertEqual(self.con.execute('SELECT count(*) FROM snapshot_pending').fetchone()[0], 1)
            boatd.set_box(self.con, other, state='ready')
            boatd.drain_pending_snapshots(self.con)
        self.assertEqual(self.con.execute('SELECT count(*) FROM snapshot_pending').fetchone()[0], 0)
        self.assertEqual([r['kind'] for r in self.con.execute('SELECT kind FROM snaps')], ['auto'])

    def test_snapshot_replay_completion_preserves_newer_requests_of_every_kind(self):
        for index, kind in enumerate(boatd.RUN_KINDS + boatd.TIMER_KINDS):
            with self.subTest(kind=kind):
                bid = self.box(f'bx_snapshot{index}')
                boatd.queue_snapshot(self.con, bid, kind)
                prior = self.con.execute('SELECT generation FROM snapshot_pending WHERE box_id=?', (bid,)).fetchone()[0]
                calls = []
                def run(argv, **kw):
                    self.assertEqual(argv[1:3], ['snapshot', 'create'])
                    calls.append(argv)
                    if len(calls) == 1:
                        # The replay's snapshot point precedes these final writes.
                        if kind == 'auto':
                            pid = self.cmd(bid)
                            boatd.write_json(boatd.result_path(bid, pid), {
                                'attempt': 1, 'status': 'exited', 'exit_code': 0,
                                'started_at': 100, 'ended_at': 160, 'boot_id': 'boot-2'})
                            self.assertEqual(boatd.settle_cmd(self.con, self.status(bid, pid)), 'finalized')
                            self.assertEqual(self.status(bid, pid)['status'], 'exited')
                        else:
                            self.assertIsNone(boatd.snapshot(self.con, bid, kind))
                    return subprocess.CompletedProcess(argv, 0, b'', b'')
                with patch.object(boatd, 'incus', self.saved['incus']), \
                        patch.object(boatd.subprocess, 'run', side_effect=run):
                    boatd.drain_pending_snapshots(self.con)
                    pending = self.con.execute('SELECT generation FROM snapshot_pending WHERE box_id=?', (bid,)).fetchone()
                    self.assertIsNotNone(pending)
                    self.assertNotEqual(pending[0], prior)
                    self.assertEqual(len(calls), 1)
                    boatd.drain_pending_snapshots(self.con)
                self.assertEqual(len(calls), 2)
                self.assertFalse(self.con.execute('SELECT 1 FROM snapshot_pending WHERE box_id=?', (bid,)).fetchone())

    def test_pending_snapshot_generation_migrates_without_losing_requests(self):
        bid = self.box()
        self.con.execute('DROP TABLE snapshot_pending')
        self.con.execute('CREATE TABLE snapshot_pending(box_id TEXT,kind TEXT,PRIMARY KEY(box_id,kind))')
        self.con.execute("INSERT INTO snapshot_pending VALUES (?,'auto')", (bid,))
        boatd.init_db()
        boatd.init_db()
        self.assertEqual(self.con.execute('SELECT generation FROM snapshot_pending').fetchone()[0], '')
        boatd.queue_snapshot(self.con, bid, 'auto')
        first = self.con.execute('SELECT rowid,generation FROM snapshot_pending').fetchone()
        boatd.queue_snapshot(self.con, bid, 'auto')
        second = self.con.execute('SELECT rowid,generation FROM snapshot_pending').fetchone()
        self.assertEqual(first['rowid'], second['rowid'])
        self.assertNotEqual(first['generation'], second['generation'])
        self.assertEqual(self.con.execute('SELECT count(*) FROM snapshot_pending').fetchone()[0], 1)

    def test_pending_snapshot_timeout_does_not_starve_cleanup_or_queued_command(self):
        snap = self.box(state='ready')
        stopping = self.box('bx_bbbbbbbb', state='stopping', running=False)
        queued = self.box('bx_cccccccc', state='ready')
        pid = self.cmd(queued, status='queued')
        self.con.execute("INSERT INTO snapshot_pending(box_id,kind) VALUES (?,'hourly')", (snap,))
        self.con.execute('UPDATE boxes SET start_error=? WHERE id=?',
                         (json.dumps({'class': 'incus_slow', 'cleanup': 'unknown', 'provision': False}), stopping))
        def incus(*args, **kw):
            if args[:2] == ('snapshot', 'create'):
                raise subprocess.TimeoutExpired(args, kw['timeout'])
            if args[0] == 'query':
                return subprocess.CompletedProcess(args, 0, b'{"status":"Stopped","devices":{}}', b'')
            return self.f.incus(*args, **kw)
        with patch.object(boatd, 'incus', side_effect=incus):
            boatd.reap_once(self.con)
            boatd.reap_once(self.con)
        self.assertEqual(self.state(stopping)['state'], 'archived')
        self.assertIsNone(self.state(stopping)['ssh_port'])
        self.assertIn((queued, pid, 1), self.f.spawned)
        self.assertEqual(self.con.execute('SELECT count(*) FROM snapshot_pending').fetchone()[0], 1)

    def test_api_stop_during_recovery_prevents_ready_and_waits_for_worker_before_cleanup(self):
        real_thread = threading.Thread
        for index, (phase, blocked) in enumerate((('proxies', False), ('boot', False), ('boot', True))):
            with self.subTest(phase=phase, stop_timeout=blocked):
                bid = self.box(f'bx_recover{index}', state='archived', running=False)
                self.con.execute('UPDATE boxes SET start_error=? WHERE id=?',
                                 (json.dumps({'class': 'incus_slow', 'cleanup': 'stopped', 'provision': False}), bid))
                entered, release = threading.Event(), threading.Event()
                workers = []
                cleanup_blocked = [blocked]
                def thread(*args, **kw):
                    worker = real_thread(*args, **kw)
                    workers.append(worker)
                    return worker
                def pause(*args, **kw):
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError('stop request blocked behind recovery')
                def incus(*args, **kw):
                    if args[0] == 'stop' and cleanup_blocked[0]:
                        raise subprocess.TimeoutExpired(args, kw['timeout'])
                    if args[0] == 'query':
                        return subprocess.CompletedProcess(args, 0, b'{"status":"Stopped","devices":{}}', b'')
                    return self.f.incus(*args, **kw)
                handler = object.__new__(boatd.Handler)
                handler.headers = {}
                with patch.object(boatd.threading, 'Thread', side_effect=thread), \
                        patch.object(boatd, 'incus', side_effect=incus), \
                        patch.object(boatd, '_prepare_proxies', side_effect=pause if phase == 'proxies' else None), \
                        patch.object(boatd, '_wait_boot', side_effect=pause if phase == 'boot' else None):
                    boatd.resume_box(self.con, bid, {})
                    try:
                        self.assertTrue(entered.wait(5))
                        response = handler._dispatch(self.con, 'POST', f'/sandboxes/{bid}/stop', {}, 'ardud')
                        self.assertTrue(response['ok'])
                        self.assertEqual(self.state(bid)['state'], 'stopping')
                    finally:
                        release.set()
                        for worker in workers:
                            worker.join(5)
                    self.assertTrue(all(not worker.is_alive() for worker in workers))
                    if blocked:
                        self.assertEqual(self.state(bid)['state'], 'stopping')
                        self.assertEqual(self.state(bid)['ssh_port'], 22000)
                        self.assertEqual(json.loads(self.state(bid)['start_error'])['cleanup'], 'unknown')
                        cleanup_blocked[0] = False
                        boatd.reap_once(self.con)
                self.assertEqual(self.state(bid)['state'], 'archived')
                self.assertNotIn(bid, self.f.running)
                self.assertIsNone(self.state(bid)['ssh_port'])
                self.assertIsNone(self.state(bid)['mgmt_ssh_port'])

    def test_cancelled_initial_proxy_preparation_retains_identity_until_resume(self):
        real_thread = threading.Thread
        for index, exhausted in enumerate((False, True)):
            with self.subTest(exhausted=exhausted):
                bid = self.box(f'bx_initial{index}', state='provisioning', running=False)
                entered, release = threading.Event(), threading.Event()
                workers, records = [], []
                def thread(*args, **kw):
                    worker = real_thread(*args, **kw)
                    workers.append(worker)
                    return worker
                def prepare(*args):
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError('Stop blocked behind initial provisioning')
                    if exhausted:
                        raise boatd.Fail(503, 'incus_slow', 'proxy exhausted', {'command_kind': 'config.device.add'})
                def incus(*args, **kw):
                    if args[0] == 'query':
                        value = {'status': 'Stopped', 'devices': {}, 'config': {'user.offbox.provision': bid}}
                        return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
                    return self.f.incus(*args, **kw)
                handler = object.__new__(boatd.Handler)
                handler.headers = {}
                with patch.object(boatd.threading, 'Thread', side_effect=thread), \
                        patch.object(boatd, '_prepare_proxies', side_effect=prepare), \
                        patch.object(boatd, 'apply_size'), patch.object(boatd, 'incus', side_effect=incus), \
                        patch.object(boatd, '_fresh_identity') as identity, \
                        patch.object(boatd.toollog, 'emit', side_effect=lambda *a, **k: records.append((a, k))):
                    worker = thread(target=self.saved['provision'], args=(bid, ('image', 'base'), 'default'))
                    worker.start()
                    try:
                        self.assertTrue(entered.wait(5))
                        self.assertTrue(handler._dispatch(self.con, 'POST', f'/sandboxes/{bid}/stop', {}, 'ardud')['ok'])
                        self.assertEqual(self.state(bid)['state'], 'stopping')
                    finally:
                        release.set()
                        for worker in workers:
                            worker.join(5)
                    self.assertTrue(all(not worker.is_alive() for worker in workers))
                    self.assertEqual(self.state(bid)['state'], 'archived')
                    self.assertEqual(self.state(bid)['identity_pending'], 1)
                    identity.assert_not_called()
                    self.assertEqual(len([a for a, k in records if a[1] == 'box_start_failed']), int(exhausted))
                    resumed = []
                    with patch.object(boatd, '_prepare_proxies'), \
                            patch.object(boatd.threading, 'Thread',
                                         side_effect=lambda target, **kw: Mock(start=lambda: resumed.append(target))):
                        boatd.resume_box(self.con, bid, {})
                        resumed.pop(0)()
                    self.assertEqual(self.state(bid)['state'], 'ready')
                    self.assertEqual(self.state(bid)['identity_pending'], 0)
                    identity.assert_called_once_with(bid)

    def test_identity_pending_without_a_slow_error_is_preserved_on_recovery_failure(self):
        for index, startup in enumerate((False, True)):
            with self.subTest(startup=startup):
                bid = self.box(f'bx_pending{index}', state='archived', running=False)
                boatd.set_box(self.con, bid, identity_pending=1)
                def incus(*args, **kw):
                    if args[0] == 'query':
                        value = {'status': 'Stopped', 'devices': {}, 'config': {'user.offbox.provision': bid}}
                        return subprocess.CompletedProcess(args, 0, json.dumps(value).encode(), b'')
                    return self.f.incus(*args, **kw)
                workers = []
                with patch.object(boatd, '_prepare_proxies'), patch.object(boatd, 'apply_size'), \
                        patch.object(boatd, 'incus', side_effect=incus), \
                        patch.object(boatd, '_wait_boot', side_effect=boatd.Fail(500, 'boot_timeout', 'not booted')), \
                        patch.object(boatd.threading, 'Thread',
                                     side_effect=lambda target, **kw: Mock(start=lambda: workers.append(target))):
                    if startup:
                        boatd.start_container(bid)
                    else:
                        boatd.resume_box(self.con, bid, {})
                        workers.pop(0)()
                self.assertEqual(self.state(bid)['state'], 'archived')
                self.assertNotIn(bid, self.f.running)
                self.assertIsNone(self.state(bid)['ssh_port'])
                self.assertEqual(self.state(bid)['identity_pending'], 1)

    def test_pending_identity_generic_failure_keeps_its_class_during_uncertain_cleanup(self):
        for index, code in enumerate(('boot_timeout', 'incus_failed')):
            with self.subTest(code=code), contextlib.ExitStack() as stack:
                bid = self.box(f'bx_generic{index}', state='archived', running=False)
                boatd.set_box(self.con, bid, identity_pending=1)
                def incus(*args, **kw):
                    if args[0] == 'stop':
                        raise subprocess.TimeoutExpired(args, kw['timeout'])
                    return self.f.incus(*args, **kw)
                stack.enter_context(patch.object(boatd, 'incus', side_effect=incus))
                stack.enter_context(patch.object(boatd, '_prepare_proxies'))
                stack.enter_context(patch.object(boatd, 'apply_size'))
                stack.enter_context(patch.object(boatd, '_wait_boot', side_effect=boatd.Fail(500, code, 'boot failed')))
                workers = []
                stack.enter_context(patch.object(boatd.threading, 'Thread',
                    side_effect=lambda target, **kw: Mock(start=lambda: workers.append(target))))
                emit = stack.enter_context(patch.object(boatd.toollog, 'emit'))
                boatd.resume_box(self.con, bid, {})
                workers.pop(0)()
                row = self.state(bid)
                self.assertEqual(row['state'], 'stopping')
                self.assertEqual(json.loads(row['start_error'])['class'], code)
                self.assertEqual(row['identity_pending'], 1)
                self.assertEqual(row['ssh_port'], 22000)
                self.assertIn(f'500 {code}: boot failed', boatd.box_json(self.con, row)['error'])
                with self.assertRaises(boatd.Fail) as cm:
                    boatd.resume_box(self.con, bid, {})
                self.assertEqual(cm.exception.code, code)
                self.assertFalse(any(c.args[1] == 'box_start_failed' for c in emit.call_args_list))

    def test_persistent_snapshot_failure_does_not_starve_later_requests(self):
        bad = self.box(state='ready')
        good = self.box('bx_bbbbbbbb', state='ready')
        self.con.executemany("INSERT INTO snapshot_pending(box_id,kind) VALUES (?,'hourly')", [(bad,), (good,)])
        calls = []
        def incus(*args, **kw):
            claim = kw.pop('before_dispatch', None)
            if claim and not claim():
                return subprocess.CompletedProcess(args, 75, b'', b'claim deferred')
            if args[:2] == ('snapshot', 'create'):
                calls.append(args[2])
                if args[2] == boatd.ct(bad):
                    raise subprocess.TimeoutExpired(args, kw['timeout'])
            return self.f.incus(*args, **kw)
        with patch.object(boatd, 'incus', side_effect=incus):
            for _ in range(3):
                boatd.drain_pending_snapshots(self.con)
        self.assertEqual(calls, [boatd.ct(bad), boatd.ct(good), boatd.ct(bad)])
        self.assertEqual([r['box_id'] for r in self.con.execute('SELECT box_id FROM snaps')], [good])
        self.assertEqual([r['box_id'] for r in self.con.execute('SELECT box_id FROM snapshot_pending')], [bad])

    def test_ordinary_resume_failure_preserves_accepted_stop(self):
        for index, phase in enumerate(('boot', 'verify')):
            with self.subTest(phase=phase):
                bid = self.box(f'bx_stop{index}', state='archived', running=False)
                workers = []
                handler = object.__new__(boatd.Handler)
                handler.headers = {}
                def stop_then_fail(*args, **kw):
                    self.assertIn(bid, self.f.running)
                    response = handler._dispatch(self.con, 'POST', f'/sandboxes/{bid}/stop', {}, 'ardud')
                    self.assertTrue(response['ok'])
                    raise RuntimeError(f'{phase} failed after Stop')
                with patch.object(boatd.threading, 'Thread',
                                  side_effect=lambda target, **kw: Mock(start=lambda: workers.append(target))), \
                        patch.object(boatd, 'apply_size'), patch.object(boatd, '_prepare_proxies'), \
                        patch.object(boatd, '_wait_boot', side_effect=stop_then_fail if phase == 'boot' else None), \
                        patch.object(boatd.scratch(), 'verify', side_effect=stop_then_fail if phase == 'verify' else None):
                    boatd.resume_box(self.con, bid, {})
                    workers.pop(0)()
                    self.assertEqual(self.state(bid)['state'], 'stopping')
                    self.assertEqual(len(workers), 1)
                    workers.pop(0)()
                self.assertNotIn(bid, self.f.running)
                self.assertEqual(self.state(bid)['state'], 'archived')

    def test_failed_saved_delete_does_not_starve_healthy_backlog(self):
        for mode in ('timeout', 'nonzero'):
            with self.subTest(mode=mode):
                self.con.execute('DELETE FROM incus_deletes')
                boatd.queue_saved_delete(self.con, 'sv-busy')
                boatd.queue_saved_delete(self.con, 'sv-healthy')
                calls = []
                def incus(*args, **kw):
                    if kw.get('before_dispatch') and not kw['before_dispatch']():
                        return subprocess.CompletedProcess(args, 75, b'', b'claim deferred')
                    calls.append(args[1])
                    if args[1] == 'sv-busy':
                        if mode == 'timeout':
                            raise subprocess.TimeoutExpired(args, kw['timeout'])
                        return subprocess.CompletedProcess(args, 1, b'', b'instance busy')
                    return subprocess.CompletedProcess(args, 0, b'', b'')
                with patch.object(boatd, 'incus', side_effect=incus):
                    for _ in range(3):
                        boatd.drain_saved_deletes(self.con)
                self.assertEqual(calls, ['sv-busy', 'sv-healthy', 'sv-busy'])
                self.assertEqual([r['instance'] for r in self.con.execute('SELECT instance FROM incus_deletes')], ['sv-busy'])

    def test_cooldown_preserves_healthy_request_turn_in_both_replay_queues(self):
        bad = self.box(state='archived', running=False)
        good = self.box('bx_bbbbbbbb', state='archived', running=False)
        for queue in ('snapshots', 'deletes'):
            with self.subTest(queue=queue):
                clock, calls = [100000.0], []
                boatd._INCUS_SLOW_UNTIL = 0
                (boatd.VAR / 'incus-slow.json').unlink(missing_ok=True)
                if queue == 'snapshots':
                    self.con.executemany("INSERT INTO snapshot_pending(box_id,kind) VALUES (?,'hourly')", [(bad,), (good,)])
                    drain = boatd.drain_pending_snapshots
                    bad_target, good_target = boatd.ct(bad), boatd.ct(good)
                else:
                    boatd.queue_saved_delete(self.con, 'sv-busy')
                    boatd.queue_saved_delete(self.con, 'sv-healthy')
                    drain = boatd.drain_saved_deletes
                    bad_target, good_target = 'sv-busy', 'sv-healthy'
                def run(argv, **kw):
                    target = argv[3] if argv[1] == 'snapshot' else argv[2]
                    calls.append(target)
                    if target == bad_target:
                        clock[0] += kw['timeout']
                        raise subprocess.TimeoutExpired(argv, kw['timeout'])
                    return subprocess.CompletedProcess(argv, 0, b'', b'')
                with patch.object(boatd, 'incus', self.saved['incus']), \
                        patch.object(boatd.subprocess, 'run', side_effect=run), \
                        patch.object(boatd, 'now', side_effect=lambda: clock[0]), \
                        patch.object(boatd.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.dict(boatd.CFG, state_dataset=''):
                    drain(self.con)  # failed dispatch starts cooldown
                    clock[0] += 15
                    drain(self.con)  # healthy turn deferred, not rotated
                    self.assertEqual(calls, [bad_target])
                    clock[0] += 15
                    drain(self.con)  # healthy dispatch at cooldown expiry
                    self.assertEqual(calls, [bad_target, good_target])
                    clock[0] += 15
                    drain(self.con)  # failed request can retry on its next turn
                self.assertEqual(calls, [bad_target, good_target, bad_target])
                if queue == 'snapshots':
                    self.assertEqual([r['box_id'] for r in self.con.execute('SELECT box_id FROM snapshot_pending')], [bad])
                    self.con.execute('DELETE FROM snapshot_pending')
                else:
                    self.assertEqual([r['instance'] for r in self.con.execute('SELECT instance FROM incus_deletes')], ['sv-busy'])

    def test_reaper_alternates_queues_across_failure_cooldown(self):
        box = self.box(state='archived', running=False)
        for failing in ('snapshots', 'deletes'):
            with self.subTest(failing=failing):
                self.con.execute('DELETE FROM snapshot_pending')
                self.con.execute('DELETE FROM incus_deletes')
                self.con.execute("INSERT OR REPLACE INTO meta VALUES ('incus_replay_next',?)", (failing,))
                self.con.execute("INSERT INTO snapshot_pending(box_id,kind) VALUES (?,'hourly')", (box,))
                boatd.queue_saved_delete(self.con, 'sv-obsolete')
                clock, calls = [100000.0], []
                boatd._INCUS_SLOW_UNTIL = 0
                (boatd.VAR / 'incus-slow.json').unlink(missing_ok=True)
                def run(argv, **kw):
                    queue = 'snapshots' if argv[1] == 'snapshot' else 'deletes'
                    calls.append(queue)
                    if queue == failing:
                        clock[0] += kw['timeout']
                        raise subprocess.TimeoutExpired(argv, kw['timeout'])
                    return subprocess.CompletedProcess(argv, 0, b'', b'')
                with patch.object(boatd, 'incus', self.saved['incus']), \
                        patch.object(boatd.subprocess, 'run', side_effect=run), \
                        patch.object(boatd, 'now', side_effect=lambda: clock[0]), \
                        patch.object(boatd.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.dict(boatd.CFG, state_dataset=''):
                    boatd.reap_once(self.con)
                    self.assertEqual(calls, [failing])
                    clock[0] += 15
                    boatd.reap_once(self.con)
                    self.assertEqual(calls, [failing])
                    clock[0] += 15
                    boatd.reap_once(self.con)
                healthy = 'deletes' if failing == 'snapshots' else 'snapshots'
                self.assertEqual(calls, [failing, healthy, failing])
                table = 'incus_deletes' if healthy == 'deletes' else 'snapshot_pending'
                self.assertEqual(self.con.execute(f'SELECT count(*) FROM {table}').fetchone()[0], 0)

    def test_reaper_cached_cleanup_cannot_cancel_a_freshly_accepted_resume(self):
        bid = self.box(state='stopping', running=False)
        boatd.set_box(self.con, bid, start_error=json.dumps({'class': 'incus_slow', 'provision': False, 'cleanup': 'unknown'}))
        workers = []
        continue_cleanup = boatd.continue_failed_start
        def incus(*args, **kw):
            if args[0] == 'query':
                return subprocess.CompletedProcess(args, 0, b'{"status":"Stopped","devices":{}}', b'')
            return self.f.incus(*args, **kw)
        def stale_pass(con, box):
            # Reaper selected the old stopping row before this cleanup finished.
            continue_cleanup(con, box)
            self.assertEqual(self.state(box)['state'], 'archived')
            boatd.resume_box(con, box, {})
            self.assertEqual(self.state(box)['state'], 'resuming')
            stops = len([c for c in self.f.calls if c[0] == 'stop'])
            continue_cleanup(con, box)
            self.assertEqual(self.state(box)['state'], 'resuming')
            self.assertEqual(len([c for c in self.f.calls if c[0] == 'stop']), stops)
        with patch.object(boatd, 'incus', side_effect=incus), \
                patch.object(boatd, 'continue_failed_start', side_effect=stale_pass), \
                patch.object(boatd.threading, 'Thread',
                                  side_effect=lambda target, **kw: Mock(start=lambda: workers.append(target))):
            boatd.reap_once(self.con)
        self.assertEqual(self.state(bid)['state'], 'resuming')
        self.assertEqual(len(workers), 1)
        with patch.object(boatd, '_prepare_proxies'), patch.object(boatd, 'apply_size'):
            workers[0]()
        self.assertEqual(self.state(bid)['state'], 'ready')
        self.assertIsNone(self.state(bid)['start_error'])

    def test_delayed_api_stop_cannot_cancel_a_new_resume_or_its_command(self):
        for index, phase in enumerate(('resuming', 'ready', 'running')):
            with self.subTest(phase=phase), contextlib.ExitStack() as stack:
                bid = self.box(f'bx_delayed{index}', state='stopping', running=False)
                boatd.set_box(self.con, bid, start_error=json.dumps(
                    {'class': 'incus_slow', 'provision': False, 'cleanup': 'unknown'}))
                workers = []
                stack.enter_context(patch.object(boatd.threading, 'Thread',
                    side_effect=lambda target, **kw: Mock(start=lambda: workers.append(target))))
                def incus(*args, **kw):
                    if args[0] == 'query':
                        return subprocess.CompletedProcess(args, 0, b'{"status":"Stopped","devices":{}}', b'')
                    return self.f.incus(*args, **kw)
                stack.enter_context(patch.object(boatd, 'incus', side_effect=incus))
                stack.enter_context(patch.object(boatd, '_prepare_proxies'))
                stack.enter_context(patch.object(boatd, 'apply_size'))
                handler = object.__new__(boatd.Handler)
                handler.headers = {}
                self.assertTrue(handler._dispatch(self.con, 'POST', f'/sandboxes/{bid}/stop', {}, 'ardud')['ok'])
                delayed_stop = workers.pop(0)
                boatd.continue_failed_start(self.con, bid)
                self.assertEqual(self.state(bid)['state'], 'archived')
                boatd.resume_box(self.con, bid, {})
                resume = workers.pop(0)
                if phase != 'resuming':
                    resume()
                if phase == 'running':
                    self.cmd(bid)
                    boatd.set_box(self.con, bid, state='running')
                calls = list(self.f.calls)
                delayed_stop()
                self.assertEqual(self.state(bid)['state'], phase)
                self.assertEqual(self.f.calls, calls)
                if phase == 'resuming':
                    resume()
                    self.assertEqual(self.state(bid)['state'], 'ready')
                if phase == 'running':
                    self.assertEqual(self.status(bid, 1001)['status'], 'running')
                self.assertIsNone(self.state(bid)['start_error'])
