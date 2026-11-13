"""Pool identity survives git failures; split-off boxes remain visible without moving them."""
import contextlib
from concurrent.futures import ThreadPoolExecutor
import io
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import common, identity, lease, pool, runs
from test_capacity import Isolated
from test_pool_affinity import Clock


class RepoKeyTests(Isolated):
    def setUp(self):
        super().setUp()
        self.root = Path(self.tmp.name) / 'torssh-bridges-prep'
        self.root.mkdir()
        self.cache = identity.repo_key_db()
        self.addCleanup(self.cache.close)

    def good(self, url='ssh://git@jingmi-torssh/abdullah/torssh.git'):
        with patch.object(identity.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, url, '')):
            return identity.repo_key(self.root)

    def test_good_key_is_persisted_without_rewriting_unchanged_values(self):
        with patch.object(identity, 'kv_set', wraps=common.kv_set) as write:
            self.assertEqual(self.good(), 'torssh')
            self.assertEqual(self.good(), 'torssh')
        self.assertEqual(write.call_count, 1)
        self.assertEqual(common.kv_get(self.cache, 'repo_key:' + str(self.root.resolve())), 'torssh')

    def test_failures_reuse_remembered_key_and_log_the_reason(self):
        self.assertEqual(self.good(), 'torssh')
        cases = [
            ('timeout', dict(side_effect=subprocess.TimeoutExpired('git', 5))),
            ('error', dict(side_effect=OSError('git unavailable'))),
            ('error', dict(return_value=subprocess.CompletedProcess([], 128, 'wrong.git', 'bad config'))),
            ('empty', dict(return_value=subprocess.CompletedProcess([], 0, '', ''))),
        ]
        for reason, outcome in cases:
            with self.subTest(reason=reason, outcome=outcome), \
                    patch.object(identity.subprocess, 'run', **outcome), \
                    patch.object(identity, 'log') as log, contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(identity.repo_key(self.root), 'torssh')
                log.assert_any_call(f'repo_key_fallback {self.root.resolve()} reason={reason} used=torssh')
                self.assertEqual(err.getvalue(), '')

    def test_failing_lookup_uses_key_committed_by_an_overlapping_lookup(self):
        cases = [
            ('timeout', subprocess.TimeoutExpired('git', 5)),
            ('error', OSError('git unavailable')),
            ('error', subprocess.CompletedProcess([], 128, 'wrong.git', 'bad config')),
            ('empty', subprocess.CompletedProcess([], 0, '', '')),
        ]
        cache_key = 'repo_key:' + str(self.root.resolve())
        for previous in (None, 'previous-origin'):
            for reason, outcome in cases:
                with self.subTest(previous=previous, reason=reason, outcome=outcome):
                    self.cache.execute('DELETE FROM kv WHERE k=?', (cache_key,))
                    self.cache.commit()
                    if previous is not None:
                        common.kv_set(self.cache, cache_key, previous)
                    in_git, finish_git = threading.Event(), threading.Event()
                    main_thread = threading.current_thread()

                    def git(*args, **kwargs):
                        if threading.current_thread() is main_thread:
                            return subprocess.CompletedProcess([], 0, 'git@example.com:owner/torssh.git', '')
                        in_git.set()
                        if not finish_git.wait(5):
                            raise AssertionError('overlapping lookup did not release git')
                        if isinstance(outcome, Exception):
                            raise outcome
                        return outcome

                    with patch.object(identity.subprocess, 'run', side_effect=git), \
                            patch.object(identity, 'log') as log, \
                            contextlib.redirect_stderr(io.StringIO()) as err, \
                            ThreadPoolExecutor(max_workers=1) as worker:
                        failing = worker.submit(identity.repo_key, self.root)
                        try:
                            self.assertTrue(in_git.wait(5), 'first lookup never reached git')
                            self.assertEqual(identity.repo_key(self.root), 'torssh')
                            self.assertEqual(common.kv_get(self.cache, cache_key), 'torssh')
                        finally:
                            finish_git.set()
                        self.assertEqual(failing.result(timeout=5), 'torssh')
                        log.assert_any_call(f'repo_key_fallback {self.root.resolve()} reason={reason} used=torssh')
                        self.assertEqual(err.getvalue(), '')

    def test_remembered_key_survives_switching_between_home_and_boat(self):
        cases = [
            ('timeout', dict(side_effect=subprocess.TimeoutExpired('git', 5))),
            ('error', dict(side_effect=OSError('git unavailable'))),
            ('error', dict(return_value=subprocess.CompletedProcess([], 128, 'wrong.git', 'bad config'))),
            ('empty', dict(return_value=subprocess.CompletedProcess([], 0, '', ''))),
        ]
        with patch.object(common, 'DB_PATH', common.DB_PATH), patch.object(common, '_BACKEND', common._BACKEND):
            for source, destination in (('server', 'boat'), ('boat', 'server')):
                for i, (reason, outcome) in enumerate(cases):
                    with self.subTest(source=source, destination=destination, reason=reason):
                        root = self.root / f'{source}-{destination}-{i}'
                        root.mkdir()
                        common.select_backend(source)
                        with patch.object(identity.subprocess, 'run',
                                          return_value=subprocess.CompletedProcess([], 0, 'git@example.com:owner/torssh.git', '')):
                            self.assertEqual(identity.repo_key(root), 'torssh')
                        source_db = common.DB_PATH
                        common.select_backend(destination)
                        self.assertNotEqual(source_db, common.DB_PATH)
                        with patch.object(identity.subprocess, 'run', **outcome), \
                                patch.object(identity, 'log') as log, contextlib.redirect_stderr(io.StringIO()) as err:
                            self.assertEqual(identity.repo_key(root), 'torssh')
                            log.assert_any_call(f'repo_key_fallback {root.resolve()} reason={reason} used=torssh')
                            self.assertEqual(err.getvalue(), '')

    def test_first_failure_warns_and_does_not_remember_the_directory_name(self):
        with patch.object(identity.subprocess, 'run', side_effect=subprocess.TimeoutExpired('git', 5)), \
                patch.object(identity, 'log') as log, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(identity.repo_key(self.root), 'torssh-bridges-prep')
        self.assertIn('warning', err.getvalue().lower())
        self.assertIn('torssh-bridges-prep', err.getvalue())
        self.assertEqual(len(err.getvalue().splitlines()), 1)
        log.assert_any_call(f'repo_key_fallback {self.root.resolve()} reason=timeout used=torssh-bridges-prep')
        self.assertIsNone(common.kv_get(self.cache, 'repo_key:' + str(self.root.resolve())))
        self.assertEqual(self.good(), 'torssh')

    def test_resolved_root_shares_cache_but_other_checkouts_do_not(self):
        self.good()
        alias = Path(self.tmp.name) / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        other = Path(self.tmp.name) / 'another-checkout'
        other.mkdir()
        with patch.object(identity.subprocess, 'run', side_effect=OSError('git unavailable')), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(identity.repo_key(alias), 'torssh')
            self.assertEqual(identity.repo_key(other), 'another-checkout')

    def test_cache_write_failure_does_not_break_successful_lookup(self):
        with patch.object(identity, 'kv_set', side_effect=sqlite3.OperationalError('database is locked')):
            self.assertEqual(self.good(), 'torssh')

    def test_unavailable_database_does_not_break_successful_lookup(self):
        with patch.object(identity, 'repo_key_db', side_effect=sqlite3.OperationalError('database is locked')):
            self.assertEqual(self.good(), 'torssh')

    def test_cache_read_failure_closes_connection(self):
        con = identity.repo_key_db()
        with patch.object(identity, 'repo_key_db', return_value=con), \
                patch.object(identity, 'kv_get', side_effect=sqlite3.OperationalError('unavailable')):
            self.assertEqual(self.good(), 'torssh')
        with self.assertRaises(sqlite3.ProgrammingError):
            con.execute('SELECT 1')

    def test_changed_origin_updates_the_remembered_key(self):
        self.good()
        self.assertEqual(self.good('https://example.com/owner/renamed.git'), 'renamed')
        with patch.object(identity.subprocess, 'run', side_effect=OSError('git unavailable')):
            self.assertEqual(identity.repo_key(self.root), 'renamed')

    def test_whoami_and_dependency_seeding_use_the_remembered_key(self):
        self.good()
        self.con.execute("INSERT INTO runs(run_id,box_id,repo_root,remote_dir,start_at) VALUES "
                         "('old','box',?,'w/old-abcdef',1)", (str(self.root.resolve()),))
        self.con.commit()
        with patch.object(identity.subprocess, 'run', side_effect=subprocess.TimeoutExpired('git', 5)), \
                patch.object(identity, 'repo_root', return_value=self.root.resolve()), \
                patch.object(identity, 'caller_native', return_value=(None, None)):
            self.assertEqual(identity.whoami()['repo_key'], 'torssh')
            self.assertEqual(runs._seed_candidates(self.con, 'box', 'w/new-123abc', 'torssh'), ['w/old-abcdef'])

    def test_git_file_checkout_uses_git_config_semantics(self):
        env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        with patch.dict(os.environ, env):
            subprocess.run(['git', 'init', '--quiet', '--separate-git-dir', str(Path(self.tmp.name) / 'metadata'),
                            str(self.root)], check=True, capture_output=True)
            subprocess.run(['git', 'config', 'remote.origin.url', 'git@example.com:owner/torssh.git'],
                           cwd=self.root, check=True, capture_output=True)
            self.assertTrue((self.root / '.git').is_file())
            self.assertEqual(identity.repo_key(self.root), 'torssh')

    def test_non_crpko_node_repo_keeps_the_neutral_node_template(self):
        (self.root / 'package.json').write_text('{}')
        self.assertEqual(lease.pick_template(self.root, self.good()), 'crpko-node')


class SplitPoolTests(Isolated):
    def test_queue_names_same_checkout_fallback_boxes_without_moving_them(self):
        self.me.update(repo_key='torssh', repo_root='/checkout/torssh-bridges-prep')
        self.box('stranded', 'stopped', member=True, source='base:torssh:torssh-skeleton-n01')
        self.con.execute("UPDATE leases SET repo_key='torssh-bridges-prep', owner='pool:torssh-bridges-prep', "
                         "repo_root=? WHERE box_id='stranded'", (self.me['repo_root'],))
        self.con.execute("UPDATE pool_members SET pool_key='torssh-bridges-prep' WHERE box_id='stranded'")
        for bid in ('busy1', 'busy2'):
            self.box(bid, member=True)
            self.con.execute("UPDATE leases SET repo_key='torssh' WHERE box_id=?", (bid,))
            self.con.execute("UPDATE pool_members SET pool_key='torssh' WHERE box_id=?", (bid,))
            self.busy(bid)
        self.con.commit()
        for backend in ('boat', 'server'):
            with self.subTest(backend=backend):
                clock = Clock()
                with patch.object(pool, 'time', clock.module), \
                        patch.object(pool, 'backend', return_value=backend), \
                        patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '130'}), \
                        patch.object(lease, 'acquire_private') as create, \
                        contextlib.redirect_stderr(io.StringIO()) as err:
                    with self.assertRaises(pool.PoolBusyError) as caught:
                        pool.acquire(self.me)
                notice = 'stranded (pool torssh-bridges-prep, stopped)'
                self.assertIn(notice, str(caught.exception))
                queued = [line for line in err.getvalue().splitlines() if 'queued for a torssh pool box' in line]
                self.assertGreaterEqual(len(queued), 2)
                self.assertTrue(all(notice in line for line in queued))
                if backend == 'server':
                    self.assertIn('leave it waiting, do not retry or kill it', queued[0])
                create.assert_not_called()
                self.assertEqual(self.con.execute("SELECT pool_key FROM pool_members WHERE box_id='stranded'").fetchone()[0],
                                 'torssh-bridges-prep')

    def test_notice_ignores_other_roots_and_non_fallback_pools(self):
        self.me.update(repo_key='torssh', repo_root='/checkout/torssh-bridges-prep')
        self.box('other', 'stopped', member=True)
        self.con.execute("UPDATE leases SET repo_key='torssh-bridges-prep'")
        self.con.execute("UPDATE pool_members SET pool_key='torssh-bridges-prep'")
        self.con.commit()
        self.assertEqual(pool.split_pool_notice(self.con, self.me), '')
        self.con.execute('UPDATE leases SET repo_root=?', (self.me['repo_root'],))
        self.con.execute("UPDATE pool_members SET pool_key='unrelated'")
        self.con.commit()
        self.assertEqual(pool.split_pool_notice(self.con, self.me), '')
