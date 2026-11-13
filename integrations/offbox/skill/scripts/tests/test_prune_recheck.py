"""Offline coverage for recovering warm boxes before pool allocation (#1056)."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import api, common, lease, misc, pool, prune, reap
from test_capacity import Isolated


class RecheckTests(Isolated):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('network forbidden')))
        self.home = Path(self.tmp.name) / 'remote'
        (self.home / '.offbox/done').mkdir(parents=True)
        self.bin = Path(self.tmp.name) / 'bin'
        self.bin.mkdir()
        self.processes('')
        self.box('warm', used=common.now(), member=True, size='xlarge', source='base:repo:default')
        self.hold()
        self.ssh = self.stack.enter_context(patch.object(prune.ssh_sync, 'ssh', side_effect=self.remote))

    def processes(self, table, rc=0):
        ps = self.bin / 'ps'
        ps.write_text('#!/bin/sh\ntable=$(cat <<\'TABLE\'\n' + table + '\nTABLE\n)\n'
                      'case " $* " in *" -eww "*) printf "%s\\n" "$table";; '
                      '*) printf "%s\\n" "$table" | cut -c 1-80;; esac\nexit ' + str(rc) + '\n')
        ps.chmod(0o755)

    def hold(self, bid='warm', rid='legacy', age=600):
        self.con.execute('INSERT OR REPLACE INTO prune_holds VALUES (?,?,?)', (bid, rid, common.now() - age))
        self.con.commit()

    def held(self, bid='warm'):
        return self.con.execute('SELECT run_id FROM prune_holds WHERE box_id=?', (bid,)).fetchone() is not None

    def remote(self, bid, command, input=None, timeout=5):
        if input is not None:
            self.assertEqual(command, 'bash -s')
        self.assertGreater(timeout, 0)
        self.assertLessEqual(timeout, 5)
        # A deterministic process-group table, while the generated remote script runs in a real shell.
        prefix = 'kill() { case "$*" in "-0 -- -777") return 0;; *) return 1;; esac; };\n'
        body = input if input is not None else command.encode()
        return subprocess.run(['bash', '-s'], input=prefix.encode() + body, capture_output=True,
                              env={'HOME': str(self.home), 'PATH': str(self.bin) + ':/usr/bin:/bin'}, timeout=timeout)

    def test_done_releases_exact_hold_and_candidates_can_use_warm_box(self):
        (self.home / '.offbox/done/legacy').write_text('ok')
        self.assertEqual(pool.candidates(self.con, 'repo', 'large', 'base:repo:default')[0], [])
        self.assertTrue(prune.recheck(self.con, 'warm', 'legacy', 2))
        self.assertEqual(pool.candidates(self.con, 'repo', 'large', 'base:repo:default')[0][0]['box_id'], 'warm')
        self.assertIn('prune warm hold released: done', common.LOG_PATH.read_text())

    def test_busy_groups_and_invalid_records(self):
        for groups, release in [('666\n888\n', True), ('666\n777\n', False), ('', False),
                                ('oops\n', False), ('0\n', False), ('-42\n', False), (' \n\t', False), ('*', False)]:
            with self.subTest(groups=groups):
                self.hold()
                (self.home / '.offbox/done/legacy.busy').write_text(groups)
                self.assertEqual(prune.recheck(self.con, 'warm', 'legacy', 5), release)
                self.assertEqual(self.held(), not release)
                self.assertEqual(prune.worker_gone('warm', 'legacy', 600, timeout_s=5) is True, release)

    def test_legacy_process_table(self):
        for table, release in [('', True), ('123 1 mv /home/user/w/old /home/user/.offbox/trash/legacy/0', False),
                               ('123 1 bash -c probe /home/user/.offbox/trash/legacy', False),
                               ('123 1 mv ' + 'x' * 100 + ' /home/user/.offbox/trash/legacy/0', False),
                               ('123 1 bash -s', False), ('123 1 mv unrelated /tmp/elsewhere', True)]:
            with self.subTest(table=table):
                self.hold()
                self.processes(table)
                self.assertEqual(prune.recheck(self.con, 'warm', 'legacy', 5), release)

    def test_failed_process_table_is_unknown(self):
        self.processes('', rc=1)
        self.assertFalse(prune.recheck(self.con, 'warm', 'legacy', 5))
        self.assertTrue(self.held())

    def test_v2_started_marker_and_start_grace_remain_protected(self):
        rid = prune.WORKER_ID_PREFIX + 'worker'
        started = self.home / '.offbox/started' / rid
        started.parent.mkdir()
        for age, pid, release in [(30, None, False), (600, '777', False), (600, '666', True),
                                  (600, 'bad', False), (600, None, True)]:
            with self.subTest(age=age, pid=pid):
                started.unlink(missing_ok=True)
                if pid is not None:
                    started.write_text(pid)
                # Positive PID test uses a separate fake from the group table.
                self.hold(rid=rid, age=age)
                with patch.object(prune.ssh_sync, 'ssh', side_effect=lambda bid, cmd, input, timeout:
                                  self.remote(bid, cmd, input.replace(b'kill -0 "$pid"', b'kill -0 -- -"$pid"'), timeout)):
                    self.assertEqual(prune.recheck(self.con, 'warm', rid, 5), release)

    def test_ssh_errors_and_nonzero_or_missing_output_keep_hold(self):
        for failure in [OSError('ssh down'), subprocess.TimeoutExpired('ssh', 5), RuntimeError('unknown')]:
            with self.subTest(failure=failure), patch.object(prune.ssh_sync, 'ssh', side_effect=failure):
                self.assertFalse(prune.recheck(self.con, 'warm', 'legacy', 5))
                self.assertTrue(self.held())
        for rc, out in [(255, b'done'), (0, b''), (0, b'held'), (1, b'quiet')]:
            with self.subTest(rc=rc, out=out), patch.object(prune.ssh_sync, 'ssh', return_value=subprocess.CompletedProcess('ssh', rc, out)):
                self.assertFalse(prune.recheck(self.con, 'warm', 'legacy', 5))
                self.assertTrue(self.held())

    def test_contended_box_lock_never_ssh_or_waits(self):
        with common.file_lock('box-warm', timeout=0):
            before = time.monotonic()
            self.assertFalse(prune.recheck(self.con, 'warm', 'legacy', 5))
            self.assertLess(time.monotonic() - before, 0.2)
        self.ssh.assert_not_called()
        self.assertTrue(self.held())

    def test_active_runs_protected_boxes_stopped_and_other_generation_skipped(self):
        self.busy('warm')
        self.assertFalse(prune.recheck(self.con, 'warm', 'legacy', 5))
        self.con.execute("DELETE FROM runs")
        self.con.execute("UPDATE leases SET state='stopped'")
        self.con.commit()
        self.assertFalse(prune.recheck(self.con, 'warm', 'legacy', 5))
        self.con.execute("UPDATE leases SET state='running'")
        self.con.commit()
        self.assertFalse(prune.recheck(self.con, 'warm', 'other', 5))
        with patch.object(prune, '_protected', return_value=True):
            self.assertFalse(prune.recheck(self.con, 'warm', 'legacy', 5))
        self.ssh.assert_not_called()
        self.assertTrue(self.held())

    def test_generation_replaced_during_probe_is_kept(self):
        def replaced(*a, **kw):
            self.hold(rid='new')
            return subprocess.CompletedProcess('ssh', 0, b'done')
        with patch.object(prune.ssh_sync, 'ssh', side_effect=replaced):
            self.assertFalse(prune.recheck(self.con, 'warm', 'legacy', 5))
        self.assertTrue(self.held())

    def test_pool_recovers_before_create_even_with_free_cap_large_or_xlarge(self):
        for size in ('large', 'xlarge'):
            with self.subTest(size=size):
                self.hold()
                self.con.execute('DELETE FROM kv WHERE k LIKE \'prunecheck:%\'')
                self.con.commit()
                with patch.object(lease, '_reuse', side_effect=lambda con, row, size, **kw: dict(row)), \
                        patch.object(lease, 'acquire_private', side_effect=AssertionError('created a cold box')) as create, \
                        contextlib.redirect_stderr(io.StringIO()):
                    row = pool.acquire(self.me, size=size, base='default')
                    pool.release_guard(row)
                self.assertEqual(row['box_id'], 'warm')
                create.assert_not_called()
                self.assertFalse(self.held())

    def test_pool_rechecks_at_most_two_newest_idle_running_boxes_outside_pool_lock(self):
        for bid, used, state in [('newest', common.now() + 1, 'running'), ('busy', common.now() + 2, 'running'),
                                 ('stopped', common.now() + 3, 'stopped'), ('older', 1, 'running')]:
            self.box(bid, state=state, used=used, member=True)
            self.hold(bid, bid)
        self.busy('busy')
        calls = []
        def probe(con, bid, rid, budget):
            with common.file_lock(pool.lock_name('repo'), timeout=0):
                calls.append(bid)
            return False
        with patch.object(prune, 'recheck', side_effect=probe):
            self.assertFalse(pool._recheck_prune_holds(self.con, 'repo'))
        self.assertEqual(calls, ['newest', 'warm'])

    def test_reap_sweep_only_old_idle_running_holds_and_dry_run_does_not_probe(self):
        self.hold(age=301)
        with patch.object(api, 'list_boxes', return_value=[{'id': 'warm', 'state': 'running'}]), \
                patch.object(reap, 'thread_get', return_value=('ok', None)), patch.object(lease, 'ensure_ttl'):
            reap._reap(self.con, True, [])
            self.ssh.assert_not_called()
            actions = reap._reap(self.con, False, [])
        self.assertFalse(self.held())
        self.assertIn('prune hold released warm', actions)
        self.ssh.reset_mock()
        for age, state, active in [(299, 'running', False), (600, 'stopped', False), (600, 'running', True)]:
            self.hold(age=age)
            self.con.execute('UPDATE leases SET state=?', (state,))
            if active:
                self.busy('warm')
            self.con.commit()
            reap._recheck_prune_holds(self.con, [])
            self.ssh.assert_not_called()

    def test_status_names_hold_without_mutating_it(self):
        with patch.object(api, 'limits', return_value={}), \
                patch.object(api, 'list_boxes', return_value=[{'id': 'warm', 'state': 'idle', 'type': 'xlarge'}]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            misc.status(self.me)
        self.assertIn('prune-held since ', output.getvalue())
        self.assertTrue(self.held())
        self.ssh.assert_not_called()

    def test_reap_budget_is_ten_seconds_and_unreachable_holds_do_not_starve_others(self):
        for bid in ('second', 'third'):
            self.box(bid, used=common.now(), member=True)
            self.hold(bid, bid)
        clock = [0.0]
        calls = []
        def probe(con, bid, rid, budget):
            calls.append(bid)
            clock[0] += min(5, budget)
            return False
        with patch.object(reap.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(prune, 'recheck', side_effect=probe):
            reap._recheck_prune_holds(self.con, [])
            self.assertEqual(len(calls), 2)
            self.assertEqual(clock[0], 10)
            reap._recheck_prune_holds(self.con, [])
        self.assertEqual(calls[2], 'third')
