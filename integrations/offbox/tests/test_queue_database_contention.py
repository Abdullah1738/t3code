"""Queue polling retries local SQLite locks without allocating or rerunning work."""
import contextlib
import io
import os
import sqlite3
from pathlib import Path
import sys
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill/scripts'
sys.path[:0] = [str(SCRIPTS), str(SCRIPTS / 'tests')]
from offbox_lib import cli, common, fallback, lease, pool, runs
from test_capacity import Isolated


def pool_lock_free():
    with common.file_lock(pool.lock_name('repo'), timeout=0):
        return True


class QueueDatabaseContention(Isolated):
    def setUp(self):
        super().setUp()
        self.box('busy', member=True, source='base:repo:base')
        self.busy('busy')
        # Room polling prunes this dead creation slot before deciding the pool is full.
        self.con.execute('INSERT INTO pool_pending VALUES (?,?,?,?,?)',
                         ('stale', 'repo', -1, common.now() - pool.PENDING_MAX_S - 1, 'base:repo:base'))
        self.clock = 0

    def lock_first_poll(self, *args):
        if self.clock == 0:
            self.con.execute('BEGIN IMMEDIATE')

    def test_writer_lock_across_one_poll_keeps_waiter_queued(self):
        sleeps = []
        def pause(seconds):
            sleeps.append(seconds)
            self.assertTrue(self.con.in_transaction)
            self.assertTrue(pool_lock_free())
            self.assertEqual(self.con.execute("SELECT count(*) FROM runs WHERE status='running'").fetchone()[0], 1)
            self.con.rollback()
            self.con.execute("UPDATE runs SET status='done' WHERE run_id='run-busy'")
            self.clock += seconds
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'10','OFFBOX_POOL_SIZE':'1'}), \
                patch.object(common, 'DB_TIMEOUT', .01), patch.object(pool, 'POLL_BUSY_MS', 10), \
                patch.object(pool, '_refresh_background', side_effect=self.lock_first_poll), \
                patch.object(pool.time, 'monotonic', side_effect=lambda: self.clock), \
                patch.object(pool.time, 'sleep', side_effect=pause), \
                patch.object(lease, '_reuse', side_effect=lambda con,row,size,**kw: dict(row)) as reuse, \
                patch.object(lease, 'acquire_private') as create, contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me, base='repo:base')
            pool.release_guard(row)
        self.assertTrue(sleeps, 'a lock must keep the waiter queued until the next poll')
        reuse.assert_called_once()
        create.assert_not_called()
        self.assertEqual(row['box_id'], 'busy')
        self.assertFalse(self.con.execute("SELECT 1 FROM pool_pending WHERE token='stale'").fetchone())

    def test_persistent_queue_lock_returns_93_cleans_rows_and_logs_traceback(self):
        self.con.execute('INSERT INTO pool_pending VALUES (?,?,?,?,?)',
                         ('mine', 'repo', os.getpid(), common.now(), 'base:repo:base'))
        self.con.execute('INSERT INTO pool_callers VALUES (?,?,?,?)',
                         (self.me['owner'],self.me['repo_root'],'busy','w/previous'))
        polls = []
        def pause(seconds):
            polls.append(seconds)
            self.clock += seconds
            # Held for every poll in the queue window; free the writer for exit cleanup.
            if self.clock >= 4:
                self.con.rollback()
        args = cli.build_parser().parse_args(['run','--no-fallback','--base','repo:base','--','echo','ok'])
        def start(runner):
            runner.registered = True
            pool.acquire(self.me, base='repo:base', run_id=runner.run_id)
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'4','OFFBOX_POOL_SIZE':'1'}), \
                patch.object(common, 'DB_TIMEOUT', .01), patch.object(pool, 'POLL_BUSY_MS', 10), \
                patch.object(pool, '_refresh_background', side_effect=self.lock_first_poll), \
                patch.object(pool.time, 'monotonic', side_effect=lambda: self.clock), \
                patch.object(pool.time, 'sleep', side_effect=pause), \
                patch.object(runs.Runner, 'start', start), patch.object(lease, '_reuse') as reuse, \
                patch.object(lease, 'acquire_private') as create, patch.object(fallback, 'run_local') as local, \
                patch.object(fallback, 'note_infra_failure') as infra, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(cli.cmd_run(args,self.me),93)
        self.con.rollback()
        self.assertEqual(len(polls), 2)
        self.assertIn('nothing ran, safe to retry', err.getvalue())
        self.assertFalse(self.con.execute('SELECT 1 FROM pool_pending WHERE pid=?',(os.getpid(),)).fetchone())
        self.assertFalse(self.con.execute('SELECT 1 FROM pool_callers WHERE owner=? AND repo_root=?',
                                         (self.me['owner'],self.me['repo_root'])).fetchone())
        diagnostic = common.LOG_PATH.read_text()
        self.assertIn('Traceback (most recent call last)', diagnostic)
        self.assertIn('BEGIN IMMEDIATE', diagnostic)
        reuse.assert_not_called()
        create.assert_not_called()
        local.assert_not_called()
        infra.assert_not_called()

    def test_busy_active_run_read_releases_box_guard_before_retry(self):
        self.con.execute("UPDATE runs SET status='done' WHERE run_id='run-busy'")
        real_active = lease.active_runs
        reads = []
        def active(con, box):
            reads.append(box)
            if len(reads) == 1:
                raise sqlite3.OperationalError('database is locked')
            return real_active(con, box)
        def pause(seconds):
            self.assertTrue(pool_lock_free())
            with common.file_lock('box-busy', timeout=0):
                pass
            self.clock += seconds
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'10','OFFBOX_POOL_SIZE':'1'}), \
                patch.object(pool.time, 'monotonic', side_effect=lambda: self.clock), \
                patch.object(pool.time, 'sleep', side_effect=pause), \
                patch.object(lease, 'active_runs', side_effect=active), \
                patch.object(lease, '_reuse', side_effect=lambda con,row,size,**kw: dict(row)) as reuse, \
                contextlib.redirect_stderr(io.StringIO()):
            row = pool.acquire(self.me, base='repo:base')
            pool.release_guard(row)
        self.assertEqual(reads, ['busy', 'busy'])
        reuse.assert_called_once()
