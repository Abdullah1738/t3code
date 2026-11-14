"""Deleted checkout simulations use real queue/lease cleanup and an isolated local DB."""
import contextlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import allocation, api, cli, common, fallback, home, lease, misc, pool, runs, ssh_sync
from test_capacity import Isolated
from test_pool_affinity import Clock


class SourceGoneTests(Isolated):
    def setUp(self):
        super().setUp()
        self.root = Path(self.tmp.name).resolve() / 'repo'
        self.root.mkdir(exist_ok=True)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'file').write_text('proof')
        self.cwd = self.root / 'subdir'
        self.cwd.mkdir()
        self.me['repo_root'] = str(self.root)
        self.clock = Clock()
        self.stack.enter_context(patch.object(pool, 'time', self.clock.module))
        self.stack.enter_context(patch.object(runs, 'time', self.clock.module))
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '120'}))
        self.stack.enter_context(patch.object(lease, 'auto_size', return_value=('large', '')))
        self.stack.enter_context(patch.object(lease, 'idle_ttl'))
        self.stack.enter_context(patch.object(lease, 'touch'))
        self.stack.enter_context(patch.object(runs.Runner, '_log_pool'))
        self.stack.enter_context(patch.object(runs, '_keep_ttl', return_value=contextlib.nullcontext()))
        self.stack.enter_context(patch.object(ssh_sync, 'put_file'))
        self.starts = self.stack.enter_context(patch.object(api, 'cmd_start'))
        self.infra = self.stack.enter_context(patch.object(fallback, 'note_infra_failure'))
        self.failures = self.stack.enter_context(patch.object(home, 'record_failure'))
        self.quarantine = self.stack.enter_context(patch.object(lease, 'quarantine'))
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))

    def simulate(self, checkpoint, *, subdir=False, bg=False, steps=False, rsync_race=False):
        self.box('A', member=True)
        self.box('B', member=True)
        removed = self.cwd if subdir else self.root
        if checkpoint == 'queued':
            self.busy('A')
            self.busy('B')
            def delete_on_tick():
                self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 1)
                shutil.rmtree(removed)
                self.clock.on_sleep = lambda: None
            self.clock.on_sleep = delete_on_tick

        def reuse(con, row, *args, **kwargs):
            if checkpoint == 'slot':
                shutil.rmtree(removed)
            return dict(row)

        def checked(*args):
            if checkpoint == 'push' and not rsync_race:
                shutil.rmtree(removed)

        def transfer(*args, **kwargs):
            shutil.rmtree(removed)
            result = subprocess.CompletedProcess([], 3, '', 'rsync: [Receiver] getcwd(): No such file or directory (2)')
            with patch.object(ssh_sync, '_watch_rsync', return_value=result), \
                    patch.object(ssh_sync, '_progress_args', return_value=[]):
                return ssh_sync._rsync('A', 'w/repo', ['rsync'], 10, source=self.root)

        a = cli.parse_args(['run', '--', 'true'])
        a.steps = ['true', 'true'] if steps else []
        a.bg = bg
        # This is the detached child's execution path, rather than the parent that spawns it.
        bg_env = {runs.BACKGROUND_RUN_ENV: 'run-source-gone'} if bg else {}
        with patch.dict(os.environ, bg_env), contextlib.chdir(self.cwd), \
                patch.object(lease, '_reuse', side_effect=reuse) as reused, \
                patch.object(lease, 'acquire_private') as created, \
                patch.object(runs.Runner, '_check_box', side_effect=checked) as check_box, \
                patch.object(ssh_sync, 'push', side_effect=transfer if rsync_race else None) as push:
            code = runs.background_client(a, self.me) if bg else cli._run_with_retries(a, self.me)
        self.assertEqual(code, 2, self.err.getvalue())
        row = self.con.execute("SELECT * FROM runs WHERE cmd IS NOT NULL ORDER BY start_at DESC LIMIT 1").fetchone()
        self.assertEqual((row['status'], row['exit_code']), ('source_gone', 2))
        self.assertIsNotNone(row['end_at'])
        self.assertIn(str(removed), row['error'])
        self.assertIn('was removed while the run was queued; nothing ran on the box', row['error'])
        self.assertIn('queued ', row['error'])
        self.assertIn('box none' if checkpoint == 'queued' else 'box A', row['error'])
        log = Path(row['log_path']).read_text()
        self.assertIn(row['error'], log)
        self.assertIsNone(row['process_id'])
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 0)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_pending').fetchone()[0], 0)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM prune_holds').fetchone()[0], 0)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_cap_callers c WHERE NOT EXISTS '
                                         "(SELECT 1 FROM runs r WHERE r.run_id=c.run_id AND r.status IN ('starting','running'))").fetchone()[0], 0)
        detail = self.con.execute("SELECT detail FROM events WHERE kind='run_source_gone'").fetchone()[0]
        self.assertIn(f'checkpoint={checkpoint}', detail)
        self.starts.assert_not_called()
        if rsync_race:
            push.assert_called_once()
        else:
            push.assert_not_called()
        self.infra.assert_not_called()
        self.failures.assert_not_called()
        self.quarantine.assert_not_called()
        created.assert_not_called()
        if checkpoint == 'queued':
            reused.assert_not_called()
            self.assertIsNone(row['box_id'])
            self.assertLessEqual(self.clock.t, 1002)
        if checkpoint != 'push':
            check_box.assert_not_called()
        for bid in ('A', 'B'):
            with common.file_lock('box-' + bid, timeout=0):
                pass
        with patch.object(misc, '_require_my_run'), patch.object(misc, '_catch_up_log') as catchup:
            for read in (lambda: misc.logs(row['run_id'], False), lambda: misc.logs(row['run_id'], True),
                         lambda: misc.wait(row['run_id'], None)):
                self.err.truncate(0)
                self.err.seek(0)
                self.assertEqual(read(), 2)
                self.assertIn(row['error'], self.err.getvalue())
                self.assertNotIn('retry', self.err.getvalue())
                self.assertNotIn("hasn't started", self.err.getvalue())
            catchup.assert_not_called()
        return row

    def test_deleted_while_queued_never_takes_a_box(self):
        self.simulate('queued')

    def test_detached_client_deleted_while_queued(self):
        self.simulate('queued', bg=True)

    def test_home_backend_source_error_is_not_an_outage(self):
        with patch.object(api, 'BACKEND', 'server'), patch.object(common, '_BACKEND', 'server'), \
                patch.object(home, 'active', return_value=True), \
                patch.object(home, 'may_fail_over', return_value=False), \
                patch.object(home, 'on_standby', return_value=False):
            self.simulate('queued', bg=True)

    def test_deleted_subdir_while_queued(self):
        self.simulate('queued', subdir=True)
        self.assertTrue(self.root.is_dir())

    def test_deleted_after_slot_releases_guard_before_probe(self):
        self.simulate('slot')

    def test_detached_client_deleted_after_slot(self):
        self.simulate('slot', bg=True)

    def test_deleted_before_push_keeps_step_exit_2(self):
        self.simulate('push', steps=True)

    def test_rsync_source_race_settles_without_infra_bookkeeping(self):
        self.simulate('push', bg=True, rsync_race=True)

    def test_source_removed_while_waiting_for_pool_lock(self):
        @contextlib.contextmanager
        def locked(*args, **kwargs):
            shutil.rmtree(self.root)
            raise common.OffboxError('timed out waiting for lock')
            yield

        with allocation.queue() as queue:
            queue['check_source'] = lambda: runs._source_present(self.root, self.cwd)
            with patch.object(pool, 'file_lock', side_effect=locked):
                with self.assertRaises(common.SourceGone):
                    with pool._pool_lock('repo', self.clock.t + 120, 120):
                        self.fail('removed source must not enter pool selection')

    def test_source_removed_during_replacement_allocation_keeps_type(self):
        self.box('old', state='stopped', member=True)
        with patch.object(lease, '_reuse', side_effect=lease.ResumeProvisionStalled('old stuck')), \
                patch.object(lease, 'acquire_private', side_effect=common.SourceGone(self.root)):
            with self.assertRaises(common.SourceGone):
                pool.acquire(self.me)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 0)
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_pending').fetchone()[0], 0)

    def test_deleted_source_before_background_adoption(self):
        for subdir in (False, True):
            with self.subTest(subdir=subdir):
                self.root.mkdir(exist_ok=True)
                self.cwd.mkdir(exist_ok=True)
                a = cli.parse_args(['run', '--bg', '--', 'true'])
                with contextlib.chdir(self.cwd):
                    rn = runs.Runner(a, self.me)
                    rn.register_pending()
                removed = self.cwd if subdir else self.root
                shutil.rmtree(removed)
                ready_r, ready_w = os.pipe()
                accept_r, accept_w = os.pipe()
                try:
                    os.write(accept_w, b'1')
                    payload = dict(args=vars(a), me=self.me, backend=common.backend(),
                                   ready_fd=ready_w, accept_fd=accept_r, signal_mask=[])
                    with patch.dict(os.environ, {}, clear=False), patch.object(pool, 'acquire') as acquire:
                        self.assertEqual(runs.background_queue(rn.run_id, payload), 2)
                    self.assertEqual(os.read(ready_r, 1), b'1')
                    acquire.assert_not_called()
                finally:
                    for fd in (ready_r, ready_w, accept_r, accept_w):
                        with contextlib.suppress(OSError):
                            os.close(fd)
                row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
                self.assertEqual((row['status'], row['exit_code']), ('source_gone', 2))
                self.assertIn(str(removed), row['error'])
                self.assertGreater(Path(row['log_path']).stat().st_size, 0)
                self.assertIsNone(row['box_id'])
                self.infra.assert_not_called()
                self.failures.assert_not_called()

    def test_deleted_cwd_between_ready_and_accept(self):
        a = cli.parse_args(['run', '--bg', '--', 'true'])
        with contextlib.chdir(self.cwd):
            rn = runs.Runner(a, self.me)
            rn.register_pending()
        ready_r, ready_w = os.pipe()
        accept_r, accept_w = os.pipe()
        original_read = os.read
        def accept(fd, count):
            if fd == accept_r:
                shutil.rmtree(self.cwd)
            return original_read(fd, count)
        try:
            os.write(accept_w, b'1')
            payload = dict(args=vars(a), me=self.me, backend=common.backend(),
                           ready_fd=ready_w, accept_fd=accept_r, signal_mask=[])
            with patch.dict(os.environ, {}, clear=False), contextlib.chdir(self.root), \
                    patch.object(runs.os, 'read', side_effect=accept), patch.object(pool, 'acquire') as acquire:
                self.assertEqual(runs.background_queue(rn.run_id, payload), 2)
            acquire.assert_not_called()
        finally:
            for fd in (ready_r, ready_w, accept_r, accept_w):
                with contextlib.suppress(OSError):
                    os.close(fd)
        row = self.con.execute('SELECT * FROM runs WHERE run_id=?', (rn.run_id,)).fetchone()
        self.assertEqual((row['status'], row['exit_code']), ('source_gone', 2))
        self.assertIn(str(self.cwd), row['error'])
        self.assertGreater(Path(row['log_path']).stat().st_size, 0)
        self.infra.assert_not_called()

    def test_archived_resume_retry_source_error_is_not_wrapped(self):
        self.box('old', state='stopped', member=True)
        def bring_up(box, *, on_state, **kwargs):
            self.clock.t += lease.RESUME_STUCK_S + 1
            shutil.rmtree(self.root)
            on_state({'state': 'archived'})
        def reuse(con, row, *args, **kwargs):
            return lease._bring_up_resumed(con, 'old', None, False,
                                          request_resume=lambda **kw: allocation.check_source())
        a = cli.parse_args(['run', '--', 'true'])
        a.steps = []
        with contextlib.chdir(self.cwd), patch.object(lease, 'now', self.clock.module.time), \
                patch.object(lease, '_bring_up', side_effect=bring_up), patch.object(lease, '_reuse', side_effect=reuse):
            self.assertEqual(cli._run_with_retries(a, self.me), 2)
        row = self.con.execute("SELECT * FROM runs WHERE cmd IS NOT NULL").fetchone()
        self.assertEqual((row['status'], row['exit_code']), ('source_gone', 2))
        self.assertGreater(Path(row['log_path']).stat().st_size, 0)
        self.assertIn('checkpoint=queued', self.con.execute("SELECT detail FROM events WHERE kind='run_source_gone'").fetchone()[0])
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_waiters').fetchone()[0], 0)
        with common.file_lock('box-old', timeout=0):
            pass
        self.infra.assert_not_called()
        self.failures.assert_not_called()

    def test_deleted_process_cwd_even_if_path_was_recreated(self):
        with contextlib.chdir(self.cwd):
            self.cwd.rmdir()
            self.cwd.mkdir()
            with self.assertRaises(common.SourceGone) as caught:
                runs._source_present(self.root, self.cwd)
            self.assertEqual(caught.exception.path, self.cwd)

    def test_rsync_rc3_requires_missing_source_and_local_enoent(self):
        for message, gone, source_error in (
            ('rsync: [Receiver] getcwd(): No such file or directory (2)', True, True),
            ('rsync: [sender] change_dir "/source" failed: No such file or directory (2)', True, True),
            ('rsync: [Receiver] getcwd(): No such file or directory (2)', False, False),
            ('rsync: remote mount is broken', True, False),
        ):
            with self.subTest(message=message, gone=gone):
                self.root.mkdir(exist_ok=True)
                def attempt(*args, **kwargs):
                    self.assertEqual(kwargs['cwd'], str(self.root))
                    if gone:
                        shutil.rmtree(self.root)
                    return subprocess.CompletedProcess([], 3, '', message)
                with patch.object(ssh_sync, '_watch_rsync', side_effect=attempt), \
                        patch.object(ssh_sync, '_progress_args', return_value=[]):
                    if source_error:
                        with self.assertRaises(common.SourceGone) as caught:
                            ssh_sync._rsync('A', 'w/repo', ['rsync'], 10, source=self.root)
                        self.assertEqual(caught.exception.code, 2)
                    else:
                        with self.assertRaises(common.OffboxError) as caught:
                            ssh_sync._rsync('A', 'w/repo', ['rsync'], 10, source=self.root)
                        self.assertEqual(caught.exception.code, common.EXIT_INFRA)

    def test_rsync_spawn_race_is_source_error(self):
        shutil.rmtree(self.root)
        with patch.object(ssh_sync, '_progress_args', return_value=[]):
            with self.assertRaises(common.SourceGone):
                ssh_sync._rsync('A', 'w/repo', ['rsync'], 10, source=self.root)

    def test_rsync_uses_source_cwd_after_caller_cwd_is_deleted(self):
        with contextlib.chdir(self.cwd):
            self.cwd.rmdir()
            result = ssh_sync._watch_rsync([sys.executable, '-c', 'import os; print(os.getcwd())'],
                                           10, cwd=str(self.root))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), str(self.root))


if __name__ == '__main__':
    import unittest
    unittest.main()
