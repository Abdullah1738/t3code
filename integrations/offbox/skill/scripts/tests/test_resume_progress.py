"""Home resumes yield to healthy pool boxes after bounded time without progress."""
import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_capacity import Isolated
from test_exit_and_queue import FakeClock
from offbox_lib import api, cli, common, home, lease, pool, prepare, runs


class ResumeProgressTests(Isolated):
    guard_home_failover = False

    def setUp(self):
        super().setUp()
        self.clock = FakeClock()
        self.clock.time.time = lambda: self.clock.t
        for mod in (api, lease, pool, prepare):
            self.stack.enter_context(patch.object(mod, 'time', self.clock.time))
        self.stack.enter_context(patch.object(lease, 'now', lambda: self.clock.t))
        self.stack.enter_context(patch.object(home, 'active', return_value=True))
        self.stack.enter_context(patch.object(home, 'may_fail_over', return_value=True))
        self.stack.enter_context(patch.object(pool, '_refresh_background'))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'cfg_path', lambda bid: Path('/nonexistent') / bid))
        for name in ('setup', 'wait_ssh'):
            self.stack.enter_context(patch.object(lease.ssh_sync, name))
        self.stack.enter_context(patch.object(lease, 'ensure_ttl'))
        self.starts = []
        self.stack.enter_context(patch.object(api, 'resume', side_effect=lambda bid, *a, **kw: self.starts.append(bid)))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def events(self, box, kind):
        return [json.loads(row[0]) for row in self.con.execute(
            'SELECT detail FROM events WHERE box_id=? AND kind=? ORDER BY rowid', (box, kind))]

    def acquire_stuck(self, state):
        self.box('stuck', 'stopped', used=200, member=True)
        self.box('peer', 'stopped', used=100, member=True)
        def get(bid, **kw):
            status = state if bid == 'stuck' and bid in self.starts else 'archived'
            if bid == 'peer' and bid in self.starts:
                status = 'running'
            return {'id': bid, 'state': status, 'type': 'large', 'error': None}
        with patch.object(api, 'get', side_effect=get), patch.object(lease, 'acquire_private') as create:
            got = pool.acquire(self.me)
        pool.release_guard(got)
        create.assert_not_called()
        return got

    def test_unacknowledged_and_acknowledged_resumes_have_bounded_watchdogs(self):
        for state, limit in (('archived', 90), ('resuming', 300)):
            with self.subTest(state=state):
                got = self.acquire_stuck(state)
                self.assertEqual(got['box_id'], 'peer')
                self.assertGreaterEqual(self.clock.t - 1000, limit)
                self.assertLessEqual(self.clock.t - 1000, limit + 1)
                self.assertEqual(self.starts, ['stuck', 'peer'])
                diag, = self.events('stuck', 'resume_stuck')
                self.assertEqual(diag['last_response']['state'], state)
                self.assertFalse(diag['resend_sent'])
                self.assertEqual(diag['disposition'], 'set_aside_for_checking')
                self.assertEqual(len(self.events('stuck', 'resume_state')), 1)
                self.assertNotIn('stuck', [row['box_id'] for row in pool.candidates(self.con, 'repo', None, None)[0]])
                line = next(line for line in reversed(common.LOG_PATH.read_text().splitlines()) if 'resume_stuck stuck {' in line)
                self.assertEqual(json.loads(line.split('resume_stuck stuck ', 1)[1]), diag)
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM pool_members')
                self.con.execute('DELETE FROM events')
                self.con.execute('DELETE FROM pool_callers')
                self.con.commit()
                self.clock.t = 1000
                self.starts.clear()

    def test_response_changes_logged_once_and_progress_extends_wait(self):
        self.box('cold', 'stopped', member=True)
        def get(bid, **kw):
            age = self.clock.t - 1000
            state = 'archived' if age < 30 else 'resuming' if age < 100 else 'running'
            return {'id': bid, 'state': state, 'error': None, 'updatedAt': str(self.clock.t), 'type': 'large'}
        with patch.object(api, 'get', side_effect=get):
            got = pool.acquire(self.me)
        pool.release_guard(got)
        self.assertEqual([row['state'] for row in self.events('cold', 'resume_state')],
                         ['archived', 'resuming', 'running'])
        self.assertFalse(self.events('cold', 'resume_stuck'))
        self.assertEqual(self.starts, ['cold'])

    def test_acknowledged_proxy_retry_can_reuse_the_box_after_90_seconds(self):
        self.box('cold', 'stopped', member=True)
        def get(bid, **kw):
            state = 'archived' if not self.starts else 'resuming' if self.clock.t < 1110 else 'ready'
            return dict(id=bid, state=state, type='large')
        with patch.object(api, 'get', side_effect=get), patch.object(api, 'stop') as stop, \
                patch.object(lease, 'acquire_private') as create:
            got = pool.acquire(self.me)
        pool.release_guard(got)
        self.assertEqual(got['box_id'], 'cold')
        self.assertEqual(self.starts, ['cold'])
        self.assertGreaterEqual(self.clock.t, 1110)
        self.assertFalse(self.events('cold', 'resume_stuck'))
        stop.assert_not_called()
        create.assert_not_called()

    def test_resume_watchdog_keeps_peer_recovery_at_the_preparation_deadline(self):
        self.box('cold', 'stopped')
        for failover in (False, True):
            for expire_preparation in (False, True):
                for delay in (0, 1):
                    with self.subTest(failover=failover, expire_preparation=expire_preparation, delay=delay), \
                            patch.object(home, 'may_fail_over', return_value=failover):
                        with self.assertRaises(lease.ResumeNoProgress), prepare.guard('cold') as budget:
                            self.clock.sleep(delay)
                            watch = lease._ResumeWatch(self.con, 'cold')
                            watch.observe({'state': 'resuming'})
                            self.assertEqual(watch.remaining(), 300-delay)
                            self.clock.sleep(300-delay)
                            if expire_preparation:
                                budget.check()
                            else:
                                watch.check()
                        self.assertIsNone(prepare._ACTIVE.get())
                        self.assertEqual(self.con.execute(
                            "SELECT state FROM leases WHERE box_id='cold'").fetchone()[0], 'resume_stalled')

    def test_proxy_exhaustion_after_150_seconds_preserves_run_failure_evidence(self):
        for background in (False, True):
            for terminal in ('archived', 'stopping'):
                with self.subTest(background=background, terminal=terminal), contextlib.ExitStack() as stack:
                    self.clock.t = 1000
                    self.con.execute('DELETE FROM events')
                    self.con.commit()
                    stack.enter_context(patch.dict(os.environ, OFFBOX_BACKEND='server'))
                    stack.enter_context(patch.object(home, 'may_fail_over', return_value=False))
                    if background:
                        stack.enter_context(patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: common.new_id('run')}))
                    reason = '503 incus_slow: config.device.set exceeded 120s'
                    def get(bid, **kw):
                        if self.clock.t < 1150:
                            return dict(id=bid, state='resuming')
                        return dict(id=bid, state=terminal, error=reason,
                                    startError={'class': 'incus_slow', 'cleanup': 'unknown'},
                                    updatedAt=dt.datetime.fromtimestamp(self.clock.t, dt.timezone.utc).isoformat())
                    stack.enter_context(patch.object(api, 'get', side_effect=get))
                    ids = []
                    def start(runner):
                        ids.append(runner.run_id)
                        lease._bring_up_resumed(self.con, 'cold', None, False, since=1000)
                    stack.enter_context(patch.object(runs.Runner, 'start', start))
                    args = cli.build_parser().parse_args(['run', '--remote', '--', 'true'])
                    self.assertEqual(cli.cmd_run(args, self.me), common.EXIT_INFRA)
                    state = runs.read_json(runs.LOGS_DIR / f'{ids[0]}.state.json', {})
                    self.assertIs(state['infra_failure'], True)
                    self.assertEqual(state['infra_reason'], 'box_error')
                    self.assertEqual(state['box_error'], {'box_id': 'cold', 'error': reason})
                    self.assertFalse(self.events('cold', 'resume_stuck'))
                    records = [json.loads(line) for line in common.HOME_FAILURES.read_text().splitlines()]
                    self.assertEqual(records[-1]['class'], 'incus_slow')
                    self.assertEqual(records[-1]['run'], ids[0])

    def test_observed_start_failure_at_preparation_expiry_retains_run_evidence(self):
        for background in (False, True):
            for terminal in ('archived', 'stopping'):
                for code in ('incus_slow', 'boot_timeout', 'incus_failed'):
                    for elapsed in (300, 301):
                        with self.subTest(background=background, terminal=terminal, code=code, elapsed=elapsed), \
                                contextlib.ExitStack() as stack:
                            self.clock.t = 1000
                            stack.enter_context(patch.dict(os.environ, OFFBOX_BACKEND='server'))
                            stack.enter_context(patch.object(home, 'may_fail_over', return_value=False))
                            if background:
                                stack.enter_context(patch.dict(os.environ, {runs.BACKGROUND_RUN_ENV: common.new_id('run')}))
                            reason = f'503 {code}: start failed; cleanup pending'
                            def get(*args, **kwargs):
                                self.clock.sleep(elapsed)
                                return dict(id='cold', state=terminal, error=reason,
                                            startError={'class': code, 'cleanup': 'unknown'},
                                            updatedAt=dt.datetime.fromtimestamp(self.clock.t, dt.timezone.utc).isoformat())
                            stack.enter_context(patch.object(api, 'readiness_get', side_effect=get))
                            ids, classes = [], []
                            def start(runner):
                                ids.append(runner.run_id)
                                try:
                                    with prepare.guard('cold'):
                                        watch = lease._ResumeWatch(self.con, 'cold')
                                        watch.observe({'state': 'resuming'})
                                        api.wait_state('cold', api.LIVE_STATES, since=1000, observe_state=watch.observe)
                                except api.BoxBootFailed as error:
                                    classes.append(error.api_code)
                                    raise
                            stack.enter_context(patch.object(runs.Runner, 'start', start))
                            args = cli.build_parser().parse_args(['run', '--remote', '--', 'true'])
                            self.assertEqual(cli.cmd_run(args, self.me), common.EXIT_INFRA)
                            self.assertEqual(classes, [code])
                            self.assertIsNone(prepare._ACTIVE.get())
                            state = runs.read_json(runs.LOGS_DIR / f'{ids[0]}.state.json', {})
                            self.assertIs(state['infra_failure'], True)
                            self.assertEqual(state['infra_reason'], 'box_error')
                            self.assertEqual(state['box_error'], {'box_id': 'cold', 'error': reason})
                            if code == 'incus_slow':
                                records = [json.loads(line) for line in common.HOME_FAILURES.read_text().splitlines()]
                                self.assertEqual(records[-1]['class'], code)
                                self.assertEqual(records[-1]['run'], ids[0])

    def test_return_to_archived_with_error_does_not_restart_progress_timer(self):
        self.box('cold', 'stopped', member=True)
        def get(bid, **kw):
            age = self.clock.t - 1000
            state = 'archived' if not self.starts or age >= 40 else 'resuming'
            return {'id': bid, 'state': state, 'error': 'Incus proxy timeout' if age >= 40 else None}
        with patch.object(api, 'get', side_effect=get), \
                patch.object(lease, 'acquire_private', side_effect=common.OffboxError('recipe failed')):
            with self.assertRaisesRegex(common.OffboxError, 'stuck resume of cold.*Replacement allocation failed: recipe failed'):
                pool.acquire(self.me)
        diag, = self.events('cold', 'resume_stuck')
        self.assertLessEqual(diag['elapsed_s'], 91)
        self.assertEqual(diag['last_response']['error'], 'Incus proxy timeout')
        self.assertEqual([row['state'] for row in diag['states']], ['resuming', 'archived'])

    def test_preparation_wait_records_background_refresh_duration(self):
        with patch.object(pool, '_refresh_background', side_effect=lambda *a: self.clock.sleep(60)):
            self.acquire_stuck('resuming')
        wait, = self.events('stuck', 'pre_bring_up')
        self.assertEqual(wait['stages_s']['background_refresh'], 60)
        self.assertGreaterEqual(wait['duration_s'], 60)

    def test_startup_pause_preserves_elapsed_stall_without_counting_startup(self):
        self.box('cold', 'stopped')
        with prepare.guard('cold') as budget:
            watch = lease._ResumeWatch(self.con, 'cold')
            watch.observe({'state': 'archived'})
            self.clock.sleep(50)
            end = budget.end
            with prepare.pause_for_home_start():
                self.clock.sleep(120)
                watch.check()
                self.assertEqual(watch.remaining(), 40)
            self.assertEqual(budget.end, end + 120)
            watch.observe({'state': 'archived'})
            self.clock.sleep(39)
            watch.check()
            self.clock.sleep(1)
            with self.assertRaises(lease.ResumeNoProgress):
                watch.check()
        diag, = self.events('cold', 'resume_stuck')
        self.assertEqual(diag['elapsed_s'], 210)
        self.assertEqual(diag['no_progress_s'], 90)

    def test_exhausted_home_start_wait_passes_through_without_quarantine(self):
        for provisioning in (False, True):
            with self.subTest(provisioning=provisioning):
                self.box('cold', 'stopped')
                with prepare.guard('cold'):
                    watch = lease._ResumeWatch(self.con, 'cold')
                    def starting(bid, **kwargs):
                        with prepare.pause_for_home_start():
                            self.clock.sleep(120)
                        raise home.StartWaitFailed('home still starting')
                    with patch.object(api, 'readiness_get', side_effect=starting):
                        with self.assertRaises(home.StartWaitFailed):
                            if provisioning:
                                lease._wait_unanswered_resume(self.con, 'cold', watch)
                            else:
                                lease._resume_confirmed(self.con, 'cold', 600, None, pending=True, watch=watch)
                self.assertFalse(self.events('cold', 'resume_stuck'))
                self.con.execute('DELETE FROM leases')
                self.con.execute('DELETE FROM kv')
                self.con.commit()

    def test_boot_failure_at_watchdog_boundary_keeps_boot_quarantine(self):
        self.box('cold', 'stopped')
        def get(bid, **kwargs):
            self.clock.sleep(90)
            return dict(state='archived', error='500 boot_timeout: sshd did not finish booting',
                        updatedAt=dt.datetime.fromtimestamp(self.clock.t, dt.timezone.utc).isoformat())
        with patch.object(api, 'get', side_effect=get):
            with self.assertRaises(api.BoxBootFailed):
                lease._bring_up_resumed(self.con, 'cold', None, False, since=1000)
        self.assertFalse(self.events('cold', 'resume_stuck'))

    def test_failover_names_both_causes_without_unreachable_claim(self):
        reason = 'stuck resume of cold after 90s. Replacement allocation failed: ECR rate limit'
        output = io.StringIO()
        with patch.object(home, 'record_failure'), patch.object(api, 'probe_backend', return_value=None), \
                patch.object(home.os, 'execve', side_effect=RuntimeError('exec')), \
                contextlib.redirect_stderr(output):
            with self.assertRaisesRegex(RuntimeError, 'exec'):
                home.fail_over(reason, ['run', '--', 'true'])
        self.assertIn(reason, output.getvalue())
        self.assertNotIn('not reachable', output.getvalue())

    def test_confirmation_budget_matrix_quarantines_only_at_watchdog_deadline(self):
        for provisioning in (False, True):
            for seconds in (3, 90):
                with self.subTest(provisioning=provisioning, seconds=seconds):
                    self.clock.t = 1000
                    self.con.execute('DELETE FROM leases')
                    self.con.execute('DELETE FROM kv')
                    self.con.execute('DELETE FROM events')
                    self.box('cold', 'stopped')
                    watch = lease._ResumeWatch(self.con, 'cold')
                    def expires(bid, *, deadline):
                        self.clock.sleep(deadline - self.clock.t)
                        raise api.BudgetExpired('GET spent its client budget')
                    expected = lease.ResumeNoProgress if seconds == 90 else api.BudgetExpired
                    with patch.object(api, 'readiness_get', side_effect=expires), api.budget(seconds):
                        with self.assertRaises(expected):
                            if provisioning:
                                lease._wait_unanswered_resume(self.con, 'cold', watch)
                            else:
                                lease._resume_confirmed(self.con, 'cold', 600, None, pending=True, watch=watch)
                    self.assertEqual(len(self.events('cold', 'resume_stuck')), int(seconds == 90))
                    row = self.con.execute("SELECT state FROM leases WHERE box_id='cold'").fetchone()
                    self.assertEqual(row[0], 'resume_stalled' if seconds == 90 else 'stopped')

    def test_boat_supply_refusal_precedes_retry_for_first_and_second_attempts(self):
        self.box('cold', 'stopped')
        for retried in (False, True):
            with self.subTest(retried=retried):
                self.clock.t = 1000
                def get(bid, **kw):
                    self.clock.sleep(91)
                    return dict(state='archived', error='supply for size xlarge is over',
                                updatedAt=dt.datetime.fromtimestamp(self.clock.t, dt.timezone.utc).isoformat())
                with patch.object(home, 'active', return_value=False), patch.object(api, 'get', side_effect=get), \
                        patch.object(api.capacity, 'supply_out'), patch.object(api, 'resume') as resend:
                    with self.assertRaises(api.SupplyOut):
                        lease._bring_up_resumed(self.con, 'cold', None, retried,
                                               request_resume=resend, since=1000)
                resend.assert_not_called()

    def test_two_abandoned_resumes_do_not_hide_ready_peer_after_first_stalls(self):
        for bid in ('pending-one', 'pending-two'):
            self.box(bid, 'stopped', member=True)
            self.con.execute('INSERT INTO kv VALUES (?,?,?)', (f'resume_unanswered:{bid}', '', 0))
        self.box('ready', 'running', member=True)
        self.con.commit()
        reads = []
        def get(bid, **kw):
            reads.append(bid)
            return {'id': bid, 'state': 'running' if bid == 'ready' else 'resuming', 'type': 'large'}
        with patch.object(api, 'get', side_effect=get), \
                patch.object(lease, 'acquire_private', side_effect=AssertionError('use ready peer')):
            got = pool.acquire(self.me)
        pool.release_guard(got)
        self.assertEqual(got['box_id'], 'ready')
        self.assertNotIn('pending-two', reads)
        self.assertEqual(self.starts, [])
        self.assertLessEqual(self.clock.t - 1000, 302)
        self.assertEqual(len(self.events('pending-one', 'resume_stuck')), 1)

    def test_held_peer_does_not_starve_next_pending_resume(self):
        self.acquire_after_held_peer(wait_seconds='0')

    def test_held_peer_with_queue_does_not_starve_next_pending_resume(self):
        self.acquire_after_held_peer(wait_seconds='400')

    def test_preparation_started_before_watch_still_reuses_healthy_pending_peer(self):
        self.acquire_after_held_peer(wait_seconds='0', watch_delay=1)
        self.assertIsNone(prepare._ACTIVE.get())

    def acquire_after_held_peer(self, wait_seconds, watch_delay=0):
        for bid in ('pending-one', 'pending-two'):
            self.box(bid, 'stopped', member=True)
            self.con.execute('INSERT INTO kv VALUES (?,?,?)', (f'resume_unanswered:{bid}', '', 0))
        self.box('held-peer', 'running', member=True)
        self.con.commit()
        reads = []
        def get(bid, **kw):
            reads.append(bid)
            return dict(id=bid, state='resuming' if bid == 'pending-one' else 'running', type='large',
                        heldRuns=['run-alive'] if bid == 'held-peer' else [])
        watch_type = lease._ResumeWatch
        def watch(*args, **kwargs):
            self.clock.sleep(watch_delay)
            return watch_type(*args, **kwargs)
        with patch.dict(os.environ, OFFBOX_POOL_WAIT_SECONDS=wait_seconds), \
                patch.object(lease, '_ResumeWatch', side_effect=watch), \
                patch.object(api, 'get', side_effect=get), \
                patch.object(lease, 'acquire_private', side_effect=AssertionError('use recovered pending peer')):
            got = pool.acquire(self.me)
        pool.release_guard(got)
        self.assertEqual(got['box_id'], 'pending-two')
        self.assertEqual(reads.count('held-peer'), 1)
        self.assertLessEqual(self.clock.t - 1000, 302)
        self.assertEqual(self.starts, [])

    def test_size_refusal_then_second_resume_is_recorded_as_resent(self):
        self.box('cold', 'stopped', member=True, size='xlarge')
        def resume(bid, *args, **kw):
            self.starts.append(bid)
            if len(self.starts) == 1:
                raise api.ApiError(409, 'shrink_refused', 'cannot shrink disk')
        with patch.object(api, 'resume', side_effect=resume), \
                patch.object(api, 'get', return_value={'id': 'cold', 'state': 'archived', 'type': 'xlarge'}), \
                patch.object(lease, 'acquire_private', side_effect=common.OffboxError('replacement failed')):
            with self.assertRaisesRegex(common.OffboxError, 'stuck resume of cold'):
                pool.acquire(self.me)
        self.assertEqual(self.starts, ['cold', 'cold'])
        diag, = self.events('cold', 'resume_stuck')
        self.assertTrue(diag['resend_sent'])

    def test_retained_send_retry_preserves_timeline_and_watchdog_before_bringup(self):
        self.box('cold', 'stopped')
        watch = lease._ResumeWatch(self.con, 'cold')
        reads = 0
        def get(bid, **kw):
            nonlocal reads
            reads += 1
            if reads == 1:
                self.clock.sleep(1)
            return {'state': 'archived', 'error': 'retry' if self.starts else 'old'}
        def resend(bid, *a, **kw):
            self.starts.append(bid)
            os.environ['OFFBOX_RESUME_CONFIRM_SECONDS'] = '120'
            raise api.NetworkError('unanswered retry')
        with patch.dict(os.environ, {'OFFBOX_RESUME_CONFIRM_SECONDS': '4'}), \
                patch.object(api, 'get', side_effect=get), patch.object(api, 'resume', side_effect=resend), \
                patch.object(lease, '_bring_up', side_effect=AssertionError('stall is before bring-up')):
            with self.assertRaises(lease.ResumeNoProgress):
                lease._resume_confirmed(self.con, 'cold', 600, None, pending=True, watch=watch)
        diag, = self.events('cold', 'resume_stuck')
        self.assertTrue(diag['resend_sent'])
        elapsed = [change['elapsed_s'] for change in diag['states']]
        self.assertEqual(elapsed, sorted(elapsed))
        self.assertEqual([change['error'] for change in diag['states']], ['old', 'retry'])
        self.assertLessEqual(diag['elapsed_s'], 91)
        self.assertLessEqual(self.clock.t - 1000, 91)
