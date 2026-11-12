"""Offline regressions for silent setup hangs, before any user command is sent."""
import contextlib
import io
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_capacity import Isolated
from test_exit_and_queue import FakeClock
from offbox_lib import api, cli, common, lease, pool, prepare, runs


class PrepareTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_PREPARE_DEADLINE_SECONDS': '1'}))
        self.stack.enter_context(patch.object(lease, 'cap_check'))
        self.stack.enter_context(patch.object(pool, '_refresh_background'))

    def create_and_claim(self, lock_seconds, replacement=False):
        clock = FakeClock()
        created = []
        starts = []
        awaiting_claim = False
        if replacement:
            self.box('old', 'stopped', member=True)

        def create(*args):
            nonlocal awaiting_claim
            bid = f'new-{len(created) + 1}'
            starts.append(clock.t)
            created.append(bid)
            self.box(bid)
            prepare.identify(bid)
            hold = common.file_lock('box-' + bid, timeout=0)
            hold.__enter__()
            row = dict(self.con.execute('SELECT * FROM leases WHERE box_id=?', (bid,)).fetchone())
            clock.sleep(.7)
            awaiting_claim = True
            return dict(row, _guard=hold)

        @contextlib.contextmanager
        def lock(name, timeout=600):
            nonlocal awaiting_claim
            if name == pool.lock_name('repo') and awaiting_claim:
                awaiting_claim = False
                clock.sleep(lock_seconds)
            with common.file_lock(name, timeout=timeout):
                yield

        with patch.object(pool, 'time', clock.time), patch.object(prepare, 'time', clock.time), \
                patch.object(pool, 'file_lock', side_effect=lock), \
                patch.object(lease, 'acquire_private', side_effect=create), \
                patch.object(lease, '_reuse', side_effect=lease.ResumeProvisionStalled('old provisioning stalled')), \
                contextlib.redirect_stderr(io.StringIO()):
            if lock_seconds > .3:
                with self.assertRaises(common.OffboxError) as caught:
                    pool.acquire(self.me)
                self.assertEqual(caught.exception.code, 90)
                self.assertIn(f'lock_wait on {created[-1]}', str(caught.exception))
                self.assertEqual(len(created), 1 if replacement else 2)
                for bid in created:
                    self.assertIn(f'resume_stuck {bid} lock_wait', common.LOG_PATH.read_text())
                    self.assertEqual(self.con.execute('SELECT state FROM leases WHERE box_id=?', (bid,)).fetchone()[0],
                                     'resume_stalled')
            else:
                got = pool.acquire(self.me)
                pool.release_guard(got)
                self.assertEqual(len(created), 1)
                self.assertEqual(got['_prepare_end'], starts[0] + 1)
                self.assertLess(clock.t, got['_prepare_end'])
        self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0], 0)
        for bid in created:
            with common.file_lock('box-' + bid, timeout=0):
                pass

    def test_creation_and_claim_lock_expire_with_one_shared_deadline(self):
        self.create_and_claim(.7)

    def test_replacement_creation_and_claim_lock_expire_with_one_shared_deadline(self):
        self.create_and_claim(.7, replacement=True)

    def test_creation_and_claim_lock_can_finish_within_shared_deadline(self):
        self.create_and_claim(.2)

    def test_replacement_creation_and_claim_lock_can_finish_within_shared_deadline(self):
        self.create_and_claim(.2, replacement=True)

    def test_slow_selection_does_not_strand_a_creation_slot(self):
        clock = FakeClock()
        first_lock = True

        @contextlib.contextmanager
        def lock(name, timeout=600):
            nonlocal first_lock
            if name == pool.lock_name('repo') and first_lock:
                first_lock = False
                clock.sleep(.7)
            with common.file_lock(name, timeout=timeout):
                yield

        def reservation_id(prefix):
            clock.sleep(.7)
            return 'create-reservation'

        def create(*args):
            self.box('new')
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id='new'").fetchone())

        with patch.object(pool, 'time', clock.time), patch.object(prepare, 'time', clock.time), \
                patch.object(pool, 'file_lock', side_effect=lock), patch.object(pool, 'new_id', side_effect=reservation_id), \
                patch.object(lease, 'acquire_private', side_effect=create), \
                patch.dict(os.environ, {'OFFBOX_POOL_SIZE': '1'}), contextlib.redirect_stderr(io.StringIO()):
            got = None
            try:
                got = pool.acquire(self.me)
            finally:
                pool.release_guard(got)
                self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0], 0)
        self.assertEqual(got['box_id'], 'new')

    def acquire_after_stall(self, resume, state):
        self.box('old', 'stopped', member=True)
        err = io.StringIO()

        def create(*args):
            self.box('new', member=True)
            return dict(self.con.execute("SELECT * FROM leases WHERE box_id='new'").fetchone())

        with patch.object(api, 'get', return_value=state), patch.object(api, 'resume', side_effect=resume), \
                patch.object(lease, 'acquire_private', side_effect=create) as creator, \
                contextlib.redirect_stderr(err):
            got = pool.acquire(self.me)
        pool.release_guard(got)
        self.assertEqual(got['box_id'], 'new')
        creator.assert_called_once()
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='old'").fetchone()[0], 'resume_stalled')
        self.assertIn('resume_stuck old', common.LOG_PATH.read_text())
        with common.file_lock('box-old', timeout=0):
            pass
        return common.LOG_PATH.read_text()

    def test_resume_post_that_never_returns_moves_once(self):
        # SIGALRM interrupts an actual blocking system call, rather than a fake timeout exception.
        log = self.acquire_after_stall(lambda *args: signal.pause(), {'state': 'archived', 'type': 'large'})
        self.assertIn('resume_stuck old resume_request', log)

    def test_acknowledged_resume_staying_stopped_is_bounded(self):
        log = self.acquire_after_stall(lambda *args: {}, {'state': 'archived', 'type': 'large'})
        self.assertIn('resume_stuck old bring_up', log)

    def test_unanswered_resume_confirmation_is_bounded(self):
        def unanswered(*args):
            raise api.NetworkError('no answer')
        log = self.acquire_after_stall(unanswered, {'state': 'archived', 'type': 'large'})
        self.assertIn('resume_stuck old resume_confirm', log)

    def test_second_stalled_box_exits_infra_without_third_allocation(self):
        self.box('old', 'stopped', member=True)
        with patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}), \
                patch.object(api, 'resume', side_effect=lambda *a: signal.pause()), \
                patch.object(lease, 'acquire_private', side_effect=lambda *a: signal.pause()) as create, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(common.OffboxError) as caught:
                pool.acquire(self.me)
        self.assertEqual(caught.exception.code, 90)
        self.assertIn('stuck in', str(caught.exception))
        self.assertIn('nothing ran', str(caught.exception))
        create.assert_called_once()
        self.assertEqual(self.con.execute('SELECT count(*) FROM pool_pending').fetchone()[0], 0)

    def test_lock_wait_times_out_and_interrupt_closes_descriptor(self):
        # A separate open file description holds the lock; the waiter must unwind on both timeout and SIGINT.
        with common.file_lock('held', timeout=0):
            with self.assertRaises(prepare.Stalled) as caught, prepare.guard('old'):
                with common.file_lock('held'):
                    self.fail('lock was not acquired')
            self.assertIn('lock_wait', str(caught.exception))
            with patch.object(common.time, 'sleep', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt), prepare.guard('old'):
                    with common.file_lock('held'):
                        self.fail('lock was not acquired')
        with common.file_lock('held', timeout=0):
            pass

    def test_sigint_during_resume_allows_next_caller_to_confirm_and_reuse(self):
        self.box('old', 'stopped', member=True)
        with patch.object(api, 'get', return_value={'state': 'archived', 'type': 'large'}), \
                patch.object(api, 'resume', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                pool.acquire(self.me)
        with common.file_lock('box-old', timeout=0):
            pass
        with patch.object(api, 'get', return_value={'state': 'running', 'type': 'large'}), \
                patch.object(lease, '_bring_up', return_value={'state': 'running', 'type': 'large'}), \
                patch.object(api, 'resume') as resume, patch.object(lease, 'acquire_private') as create:
            got = pool.acquire(self.me)
        pool.release_guard(got)
        self.assertEqual(got['box_id'], 'old')
        resume.assert_not_called()
        create.assert_not_called()

    def test_another_pid_holding_pool_lock_is_reported_and_bounded(self):
        common.ensure_dirs()
        lock = common.LOCKS_DIR / (pool.lock_name('repo') + '.lock')
        code = ('import fcntl,sys; f=open(sys.argv[1],"a+"); '
                'fcntl.flock(f,fcntl.LOCK_EX); print("held",flush=True); sys.stdin.read()')
        child = subprocess.Popen([sys.executable, '-c', code, str(lock)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(child.stdout.readline(), b'held\n')
            with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '10'}), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(common.OffboxError) as caught:
                    pool.acquire(self.me)
            self.assertEqual(caught.exception.code, 90)
            self.assertIn('lock_wait', str(caught.exception))
            self.assertIn('resume_stuck repository pool lock_wait', common.LOG_PATH.read_text())
        finally:
            child.communicate(timeout=5)
            child.stdout.close()
        with common.file_lock(pool.lock_name('repo'), timeout=0):
            pass

    def test_phase_progress_reports_wait_without_extending_deadline(self):
        with patch.object(prepare.time, 'monotonic', return_value=0):
            budget = prepare.Budget('old', end=300)
        budget.phase = 'resume_request'
        err = io.StringIO()
        with patch.object(prepare.time, 'monotonic', return_value=31), \
                patch.object(signal, 'setitimer'), contextlib.redirect_stderr(err):
            budget.tick()
            budget.tick()
        self.assertEqual(err.getvalue().count('still resume_request on old (31s)'), 1)
        self.assertEqual(budget.end, 300)

    def test_bringup_and_health_checks_use_same_deadline(self):
        with prepare.guard('old') as budget:
            end = budget.end
        with self.assertRaises(prepare.Stalled), prepare.guard('old', end):
            with prepare.phase('bring_up'):
                signal.pause()
        self.assertIn('resume_stuck old bring_up', common.LOG_PATH.read_text())

    def test_alarm_and_api_budget_are_restored_after_interrupt(self):
        handler, left = signal.getsignal(signal.SIGALRM), api.left()
        with self.assertRaises(KeyboardInterrupt), prepare.guard('old'):
            raise KeyboardInterrupt
        self.assertIs(signal.getsignal(signal.SIGALRM), handler)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0, 0))
        self.assertEqual(api.left(), left)

    def test_dead_mount_after_prepare_replacement_is_quarantined_without_third_box(self):
        self.box('second', member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='second'").fetchone())
        runner = runs.Runner(cli.build_parser().parse_args(['run', '--', 'true']), self.me)
        with prepare.attempts(), patch.object(pool, 'acquire', return_value=row) as acquire, \
                patch.object(lease, 'auto_size', return_value=('large', '')), \
                patch.object(runs, 'needs_image_wait', return_value=False), \
                patch.object(runner, '_prepare_box', side_effect=lease.DeadMount('second', 'dead disk')), \
                patch.object(lease, 'set_aside_dead_mount') as quarantine, \
                contextlib.redirect_stderr(io.StringIO()):
            prepare.move_once(prepare.Stalled('first', 'resume_request', 1))
            with self.assertRaises(common.OffboxError):
                runner.start()
        acquire.assert_called_once()
        quarantine.assert_called_once()
        self.assertIsNone(self.con.execute('SELECT box_id FROM runs WHERE run_id=?', (runner.run_id,)).fetchone()[0])

    def test_expired_recipe_is_retired_and_follower_stops(self):
        stopped = threading.Event()

        def follow(*args, stop_evt, **kwargs):
            stop_evt.wait(5)
            if stop_evt.is_set():
                stopped.set()
            return 0

        with patch.object(runs, 'follow', side_effect=follow):
            with self.assertRaises(prepare.Stalled), prepare.guard('old'):
                lease._follow_bounded('old', 7, None, 10)
        self.assertTrue(stopped.wait(1), 'recipe follower still refreshes the expired box')

        with patch('offbox_lib.bases.recipe', return_value=('true', 'sha')), \
                patch('offbox_lib.bases.template_uploads'), patch.object(lease.ssh_sync, 'put_file'), \
                patch.object(api, 'cmd_start', return_value={'processId': 7}), \
                patch.object(lease, '_follow_bounded', side_effect=prepare._Expired), \
                patch.object(lease, '_retire_recipe_box') as retire:
            with self.assertRaises(prepare.Stalled), prepare.guard('old'):
                lease.run_recipe('old', 'generic', box_held=True)
        self.assertEqual(retire.call_args.args[:2], ('old', 7))

    def test_cold_handoff_uses_shared_move_allowance(self):
        from test_cold_home import ColdHomeTests
        fixture = ColdHomeTests()
        fixture.setUp()
        try:
            fixture.box('b', member=True)
            with prepare.attempts():
                runner, row = fixture.start()
                self.assertEqual(row['box_id'], 'b')
                self.assertTrue(runner.cold_moved)
                self.assertFalse(prepare.can_move())
                with self.assertRaises(common.OffboxError):
                    prepare.move_once(prepare.Stalled('b', 'bring_up', 1))
        finally:
            fixture.doCleanups()

    def test_recipe_retirement_itself_cannot_hang_past_deadline(self):
        code = '''
import signal
from unittest.mock import patch
from offbox_lib import prepare, lease, api, bases
with patch.object(bases, 'recipe', return_value=('true', 'sha')), \\
     patch.object(bases, 'template_uploads'), patch.object(lease.ssh_sync, 'put_file'), \\
     patch.object(api, 'cmd_start', return_value={'processId': 7}), \\
     patch.object(lease, 'event'), patch.object(lease, 'db'), patch.object(prepare, 'log'), \\
     patch.object(lease, '_follow_bounded', side_effect=lambda *a: signal.pause()), \\
     patch.object(lease, '_retire_recipe_box', side_effect=lambda *a: signal.pause()):
    try:
        with prepare.guard('old'):
            lease.run_recipe('old', 'generic', box_held=True)
    except prepare.Stalled:
        print('bounded cleanup')
'''
        result = subprocess.run([sys.executable, '-c', code], cwd=Path(__file__).resolve().parents[1],
                                env=dict(os.environ, OFFBOX_PREPARE_DEADLINE_SECONDS='1'),
                                capture_output=True, text=True, timeout=4)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('bounded cleanup', result.stdout)

    def test_identity_visible_and_persisted_before_acquisition(self):
        for bg in (False, True):
            out, err = io.StringIO(), io.StringIO()
            args = cli.build_parser().parse_args(['run', *(['--bg'] if bg else []), '--', 'true'])
            runner = runs.Runner(args, self.me)

            def acquire(*a, **kw):
                row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (runner.run_id,)).fetchone()
                self.assertEqual(row['status'], 'starting')
                self.assertIn(runner.run_id, err.getvalue())
                self.assertIn(runner.run_id, common.LOG_PATH.read_text())
                raise KeyboardInterrupt

            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                    patch.object(lease, 'auto_size', return_value=('large', '')), \
                    patch.object(runs, 'needs_image_wait', return_value=False), \
                    patch.object(pool, 'acquire', side_effect=acquire):
                with self.assertRaises(KeyboardInterrupt):
                    runner.start()
