"""Offline cold-disk detection and first-push handoff regressions (#529)."""
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, cli, common, lease, pool, prune, runs, ssh_sync
from test_capacity import Isolated


def completed(code=0, out=b'', err=b''):
    return subprocess.CompletedProcess([], code, out, err)


class ColdHomeTests(Isolated):
    def setUp(self):
        super().setUp()
        self.output = io.StringIO()
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.stack.enter_context(contextlib.redirect_stderr(self.output))
        self.stack.enter_context(patch.dict(os.environ, {'OFFBOX_COLD_HOME_SECONDS': '5'}))
        self.stack.enter_context(patch.object(api, 'call', side_effect=AssertionError('offline: boat called')))
        self.ssh = self.stack.enter_context(patch.object(ssh_sync, 'ssh', side_effect=self.fake_ssh))
        self.stack.enter_context(patch.object(ssh_sync, 'put_file'))
        self.push = self.stack.enter_context(patch.object(ssh_sync, 'push', return_value={}))
        self.stack.enter_context(patch.object(ssh_sync, 'tracked_secret_matches', return_value=[]))
        self.stack.enter_context(patch.object(runs, 'new_checkout_hint'))
        self.image_wait = self.stack.enter_context(patch.object(runs, 'needs_image_wait', return_value=False))
        self.ttl = self.stack.enter_context(patch.object(lease, 'ensure_ttl', return_value=True))
        self.peer = self.stack.enter_context(patch.object(api, 'get', return_value={'state': 'ready', 'type': 'large'}))
        self.peer_ssh = completed()
        self.stack.enter_context(patch.object(api, 'cmd_start', return_value={'processId': 7}))
        self.home_s = {'a': 8, 'b': 0.2, 'c': 0.3}
        self.home_failure = self.docker_failure = None
        self.docker_s = 0.1
        self.missing = True
        self.prune_timeout = False
        self.box('a', member=True)
        self.acquire = self.stack.enter_context(patch.object(pool, 'acquire', side_effect=self.initial_box))
        self.guard = MagicMock()
        self.initial_extra = {}

    def initial_box(self, *args, **kwargs):
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='a'").fetchone())
        return dict(row, remote_dir='w/new-abcdef', _guard=self.guard, **self.initial_extra)

    def fake_ssh(self, bid, command, **kwargs):
        if command == 'true':
            if isinstance(self.peer_ssh, Exception):
                raise self.peer_ssh
            return self.peer_ssh
        if command == 'bash -s' and self.prune_timeout:
            raise subprocess.TimeoutExpired('ssh', kwargs['timeout'])
        if command.startswith('for i in $(seq'):
            return completed(1)
        if command.startswith('test -d '):
            if isinstance(self.missing, Exception):
                raise self.missing
            return completed(1 if self.missing else 0)
        if command.startswith('docker info '):
            if isinstance(self.docker_failure, Exception):
                raise self.docker_failure
            return self.docker_failure or completed(out=b'/var/lib/docker\n')
        if 'sudo -n dd ' in command:
            return completed(out=f'OFFBOX_WRITE_SECONDS {self.docker_s}\n'.encode())
        if 'OFFBOX_PROBE_OK' in command:
            if isinstance(self.home_failure, Exception):
                raise self.home_failure
            if self.home_failure:
                return self.home_failure
            timing = f'OFFBOX_WRITE_SECONDS {self.home_s[bid]}\n' if 'count=1' in command else ''
            return completed(out=(timing + 'OFFBOX_PROBE_OK\n').encode())
        raise AssertionError(f'unexpected ssh: {command}')

    def start(self, *args):
        rn = runs.Runner(cli.build_parser().parse_args(['run', *args, '--', 'true']), self.me)
        self.addCleanup(lambda: pool.release_guard(rn.lease_row))
        return rn, rn.start()

    def events(self):
        return self.con.execute("SELECT * FROM events WHERE kind='cold_home' ORDER BY rowid").fetchall()

    def test_slow_home_records_event_and_notice_without_peer(self):
        _, row = self.start()
        self.assertEqual(row['box_id'], 'a')
        self.assertIn('home 8.000s, docker unknown', self.events()[0]['detail'])
        self.assertIn('5-25 min', self.output.getvalue())
        self.assertIn('--bg + offbox wait', self.output.getvalue())
        self.push.assert_called_once()
        self.assertIsNone(self.con.execute("SELECT note FROM leases WHERE box_id='a'").fetchone()[0])

    def test_prune_timeout_alone_is_cold_and_keeps_hold(self):
        self.home_s['a'], self.prune_timeout = 0.1, True
        self.con.execute("INSERT INTO runs(run_id,box_id,remote_dir,start_at,status) VALUES "
                         "('old','a','w/old-123456',?,'done')", (common.now() - 6 * 86400,))
        self.con.commit()
        self.start()
        self.assertIn('prune_timeout=1', self.events()[0]['detail'])
        self.assertIn('disk is still loading', self.output.getvalue())
        self.assertIsNotNone(self.con.execute("SELECT * FROM prune_holds WHERE box_id='a'").fetchone())

    def test_first_push_moves_from_slow_probe_without_prune_timeout(self):
        self.box('b', member=True)
        rn, row = self.start()
        self.assertEqual(row['box_id'], 'b')
        self.assertTrue(rn.cold_moved)
        self.guard.__exit__.assert_called_once()
        self.push.assert_called_once()
        self.assertEqual(self.push.call_args.args[0], 'b')
        self.assertIn('using running box b instead', self.output.getvalue())
        self.assertNotIn('5-25 min', self.output.getvalue())
        self.assertEqual(self.con.execute("SELECT box_id FROM runs WHERE run_id=?", (rn.run_id,)).fetchone()[0], 'b')
        self.assertEqual(self.con.execute("SELECT state,note FROM leases WHERE box_id='a'").fetchone()[:], ('running', None))

    def test_existing_checkout_stays_on_cold_box(self):
        self.box('b', member=True)
        self.missing = False
        rn, row = self.start()
        self.assertEqual(row['box_id'], 'a')
        self.assertFalse(rn.cold_moved)
        self.assertIn('5-25 min', self.output.getvalue())

    def test_prune_timeout_alone_also_moves_first_push(self):
        self.home_s['a'], self.prune_timeout = 0.1, True
        self.box('b', member=True)
        self.con.execute("INSERT INTO runs(run_id,box_id,remote_dir,start_at,status) VALUES "
                         "('old','a','w/old-123456',?,'done')", (common.now() - 6 * 86400,))
        self.con.commit()
        _, row = self.start()
        self.assertEqual(row['box_id'], 'b')
        self.assertIn('prune_timeout=1', self.events()[0]['detail'])

    def test_fast_probe_has_no_notice_or_move(self):
        self.box('b', member=True)
        self.home_s['a'] = 0.1
        _, row = self.start()
        self.assertEqual(row['box_id'], 'a')
        self.assertFalse(self.events())
        self.assertNotIn('disk is still loading', self.output.getvalue())
        self.assertFalse(any(c.args[1].startswith('test -d ') for c in self.ssh.call_args_list))

    def test_failed_home_probe_changes_nothing(self):
        for failure in [completed(255, err=b'connection closed'), completed(1, err=b'permission denied'),
                        subprocess.TimeoutExpired('ssh', 45), OSError('no ssh')]:
            with self.subTest(failure=failure):
                self.home_failure = failure
                _, row = self.start()
                self.assertEqual(row['box_id'], 'a')
                self.assertFalse(self.events())
        self.assertNotIn('disk is still loading', self.output.getvalue())

    def test_second_cold_box_never_moves_again(self):
        self.box('b', member=True)
        self.box('c', member=True)
        self.home_s['b'] = self.home_s['c'] = 9
        rn, row = self.start()
        self.assertNotEqual(row['box_id'], 'a')
        self.assertEqual(len(self.events()), 2)
        self.assertEqual(self.output.getvalue().count('using running box'), 1)
        self.assertEqual(self.output.getvalue().count('5-25 min'), 1)
        self.acquire.assert_called_once()

    def test_recent_cold_candidate_is_skipped(self):
        self.box('b', member=True, used=200)
        self.box('c', member=True, used=100)
        common.event(self.con, 'b', 'cold_home', 'recent cold disk')
        _, row = self.start()
        self.assertEqual(row['box_id'], 'c')

    def test_old_cold_event_does_not_exclude_warm_box_forever(self):
        self.box('b', member=True)
        self.con.execute("INSERT INTO events VALUES (?,'b','cold_home','old')", (common.now() - 901,))
        self.con.commit()
        _, row = self.start()
        self.assertEqual(row['box_id'], 'b')

    def test_recipe_fallback_and_template_peers_match(self):
        self.con.execute("UPDATE leases SET source='recipe:crpko-go' WHERE box_id='a'")
        self.con.commit()
        self.box('b', member=True)
        _, row = self.start()
        self.assertEqual(row['box_id'], 'b')

    def test_warm_peer_ttl_is_extended_under_box_guard_outside_pool_lock(self):
        self.box('b', member=True)
        def refresh(bid, ttl):
            self.assertEqual(bid, 'b')
            self.assertGreaterEqual(ttl, common.RUN_TTL_S)
            with self.assertRaises(common.OffboxError):
                with common.file_lock('box-b', timeout=0):
                    pass
            with common.file_lock(pool.lock_name('repo'), timeout=0):
                pass
            self.assertEqual(self.con.execute("SELECT box_id FROM runs WHERE status='starting'").fetchone()[0], 'a')
            return True
        self.ttl.side_effect = refresh
        _, row = self.start()
        self.assertEqual(row['box_id'], 'b')
        self.ttl.assert_called_once()

    def test_failed_ttl_refresh_stays_on_original_and_releases_peer(self):
        self.box('b', member=True)
        self.ttl.return_value = False
        _, row = self.start()
        self.assertEqual(row['box_id'], 'a')
        with common.file_lock('box-b', timeout=0):
            pass
        self.assertIn('5-25 min', self.output.getvalue())

    def assert_stayed_on_original(self, rn, row):
        self.assertEqual(row['box_id'], 'a')
        self.assertFalse(rn.cold_moved)
        self.assertEqual(self.push.call_args.args[0], 'a')
        self.assertEqual(self.con.execute("SELECT box_id FROM runs WHERE run_id=?", (rn.run_id,)).fetchone()[0], 'a')
        self.assertIsNone(self.con.execute("SELECT 1 FROM pool_callers WHERE owner=? AND repo_root=? AND box_id='b'",
                                           (self.me['owner'], self.me['repo_root'])).fetchone())
        with common.file_lock('box-b', timeout=0):
            pass
        self.assertIn('5-25 min', self.output.getvalue())
        self.assertNotIn('using running box', self.output.getvalue())

    def test_successful_ttl_but_unavailable_ssh_retains_original(self):
        self.box('b', member=True)
        for failure in (completed(255, err=b'stale SSH endpoint'), subprocess.TimeoutExpired('ssh', 10),
                        OSError('SSH unavailable')):
            with self.subTest(failure=failure):
                self.peer_ssh = failure
                rn, row = self.start()
                self.assert_stayed_on_original(rn, row)
        self.assertEqual(self.ttl.call_count, 3)

    def test_non_live_missing_expired_or_wrong_size_peer_retains_original(self):
        self.box('b', member=True)
        states = [None, 'invalid response', ['ready'], {'state': 'ready', 'type': 'large', 'dataExpiredAt': 'expired'},
                  {'state': 'ready', 'type': 'default'}, {'state': 'ready'}]
        states += [dict(state=state, type='large') for state in (*api.STOPPED_STATES, *api.STARTING_STATES,
                                                               'archiving', 'error', 'cancelled')]
        for state in states:
            with self.subTest(state=state):
                self.peer.return_value = state
                rn, row = self.start()
                self.assert_stayed_on_original(rn, row)
        self.assertFalse(any(c.args[1] == 'true' for c in self.ssh.call_args_list))

    def test_peer_state_errors_retain_original(self):
        self.box('b', member=True)
        for error in (common.OffboxError('state unavailable'), OSError('network error'),
                      subprocess.TimeoutExpired('state', 10), json.JSONDecodeError('invalid response', 'x', 0),
                      http.client.IncompleteRead(b'partial response'),
                      UnicodeDecodeError('utf-8', b'\xff', 0, 1, 'invalid response')):
            with self.subTest(error=error):
                self.peer.side_effect = error
                rn, row = self.start()
                self.assert_stayed_on_original(rn, row)

    def test_all_live_states_can_handoff(self):
        self.box('b', member=True)
        for state in api.LIVE_STATES:
            with self.subTest(state=state):
                self.peer.return_value = dict(state=state, type='large')
                rn, row = self.start()
                self.assertEqual(row['box_id'], 'b')
                pool.release_guard(row)
                self.con.execute("UPDATE runs SET status='done' WHERE run_id=?", (rn.run_id,))
                self.con.commit()

    def test_peer_readiness_is_guarded_and_precedes_claim(self):
        self.box('b', member=True)
        def check_guard():
            with self.assertRaises(common.OffboxError):
                with common.file_lock('box-b', timeout=0):
                    pass
            with common.file_lock(pool.lock_name('repo'), timeout=0):
                pass
            self.assertEqual(self.con.execute("SELECT box_id FROM runs WHERE status='starting'").fetchone()[0], 'a')
        def state(bid, *, deadline):
            check_guard()
            self.ttl.assert_called_once_with('b', common.RUN_TTL_S)
            return {'state': 'ready', 'type': 'large'}
        def ssh(bid, command, **kwargs):
            if command == 'true':
                check_guard()
                self.peer.assert_called_once()
                self.assertGreater(kwargs['timeout'], 0)
                self.assertLessEqual(kwargs['timeout'], 10)
            return self.fake_ssh(bid, command, **kwargs)
        self.peer.side_effect = state
        self.ssh.side_effect = ssh
        _, row = self.start()
        self.assertEqual(row['box_id'], 'b')

    def test_exhausted_peer_readiness_budget_retains_original(self):
        self.box('b', member=True)
        with patch.object(api, 'left', return_value=0):
            rn, row = self.start()
        self.assert_stayed_on_original(rn, row)
        self.assertFalse(any(c.args[1] == 'true' for c in self.ssh.call_args_list))

    def test_ttl_refresh_error_stays_on_original_and_releases_peer(self):
        self.box('b', member=True)
        self.ttl.side_effect = common.OffboxError('TTL unavailable')
        _, row = self.start()
        self.assertEqual(row['box_id'], 'a')
        with common.file_lock('box-b', timeout=0):
            pass

    def test_busy_box_lock_is_skipped(self):
        self.box('b', member=True)
        with common.file_lock('box-b', timeout=0):
            _, row = self.start()
        self.assertEqual(row['box_id'], 'a')

    def test_pool_acquisition_honors_same_run_cold_exclusions(self):
        self.box('b', member=True)
        with patch('offbox_lib.identity.require_proven'), \
                patch.object(lease, '_reuse', side_effect=lambda con, row, size, **kw: dict(row)):
            row = pool._acquire(self.con, self.me, 'large', None, None, False, None, exclude={'a'})
        try:
            self.assertEqual(row['box_id'], 'b')
        finally:
            pool.release_guard(row)

    def test_docker_root_slow_home_fast(self):
        self.image_wait.return_value = True
        self.home_s['a'], self.docker_s = 0.1, 12.5
        self.start()
        self.assertIn('home 0.100s, docker 12.500s', self.events()[0]['detail'])
        info = next(c for c in self.ssh.call_args_list if c.args[1].startswith('docker info'))
        self.assertEqual(info.kwargs['timeout'], 10)
        self.assertIn('5-25 min', self.output.getvalue())

    def test_non_image_command_never_probes_docker(self):
        self.start()
        self.assertFalse(any('docker info' in c.args[1] or 'sudo -n dd' in c.args[1]
                             for c in self.ssh.call_args_list))

    def test_archived_and_resized_resume_skip_write_probes(self):
        for source in ('archived', 'resized'):
            with self.subTest(source=source):
                self.initial_extra = {'_cold_resume': source, '_resumed_at': common.now() - 3}
                self.image_wait.return_value = True
                self.start()
                self.assertIn(f'resume={source}', self.events()[-1]['detail'])
        self.assertFalse(any('conv=fsync' in c.args[1] or 'docker info' in c.args[1]
                             for c in self.ssh.call_args_list))

    def test_docker_missing_or_timeout_is_inconclusive(self):
        self.image_wait.return_value = True
        self.home_s['a'] = 0.1
        for failure in [completed(127), completed(out=b''), subprocess.TimeoutExpired('ssh', 10), OSError('offline')]:
            with self.subTest(failure=failure):
                self.docker_failure = failure
                self.start()
                self.assertFalse(self.events())
        self.assertNotIn('disk is still loading', self.output.getvalue())

    def test_docker_write_timeout_is_inconclusive(self):
        self.image_wait.return_value = True
        self.home_s['a'] = 0.1
        original = self.fake_ssh
        def ssh(bid, command, **kwargs):
            if 'sudo -n dd' in command:
                raise subprocess.TimeoutExpired('ssh', kwargs['timeout'])
            return original(bid, command, **kwargs)
        self.ssh.side_effect = ssh
        self.start()
        self.assertFalse(self.events())

    def test_threshold_is_configurable_and_strict(self):
        with patch.dict(os.environ, {'OFFBOX_COLD_HOME_SECONDS': '8'}):
            self.start()
        self.assertFalse(self.events())
        with patch.dict(os.environ, {'OFFBOX_COLD_HOME_SECONDS': '7'}):
            self.start()
        self.assertEqual(len(self.events()), 1)

    def test_no_sync_and_unknown_remote_dir_stay(self):
        self.box('b', member=True)
        _, row = self.start('--no-sync')
        self.assertEqual(row['box_id'], 'a')
        self.push.assert_not_called()
        self.missing = subprocess.TimeoutExpired('ssh', 10)
        _, row = self.start()
        self.assertEqual(row['box_id'], 'a')

    def test_wrong_size_repo_source_busy_and_held_peers_are_skipped(self):
        for bid in ('size', 'repo', 'source', 'busy', 'held'):
            self.box(bid, member=True)
        self.con.execute("UPDATE leases SET size='xlarge' WHERE box_id='size'")
        self.con.execute("UPDATE leases SET repo_key='other' WHERE box_id='repo'")
        self.con.execute("UPDATE leases SET source='fresh' WHERE box_id='source'")
        self.busy('busy')
        self.con.execute("INSERT INTO prune_holds VALUES ('held','old',?)", (common.now(),))
        self.con.commit()
        _, row = self.start()
        self.assertEqual(row['box_id'], 'a')

    def test_cold_boxes_remain_excluded_after_dead_mount_retry(self):
        self.box('b', member=True, used=200)
        self.box('c', member=True)
        second = dict(self.con.execute("SELECT * FROM leases WHERE box_id='c'").fetchone(), remote_dir='w/new-abcdef')
        self.acquire.side_effect = [self.initial_box(), second]
        self.push.side_effect = [common.OffboxError('Transport endpoint is not connected'), {}]
        with patch.object(lease, 'set_aside_dead_mount'):
            _, row = self.start()
        self.assertEqual(row['box_id'], 'c')
        self.assertIn('a', self.acquire.call_args.kwargs['exclude'])
        self.assertEqual(self.output.getvalue().count('using running box'), 1)


class ProbeScriptTests(Isolated):
    def test_docker_probe_writes_in_reported_root_and_cleans_up(self):
        root = Path(self.tmp.name) / "docker root's data"
        root.mkdir()
        bindir = Path(self.tmp.name) / 'bin'
        bindir.mkdir()
        sudo = bindir / 'sudo'
        sudo.write_text('#!/bin/sh\nshift\nexec "$@"\n')
        sudo.chmod(0o755)
        def ssh(bid, command, **kwargs):
            if command.startswith('docker info'):
                return completed(out=(str(root) + '\n').encode())
            return subprocess.run(['bash', '-c', command], capture_output=True,
                                  env=dict(os.environ, PATH=str(bindir) + ':' + os.environ['PATH']))
        with patch.object(ssh_sync, 'ssh', side_effect=ssh):
            self.assertIsNotNone(ssh_sync.probe_docker_root('box'))
        self.assertEqual(list(root.iterdir()), [])

    def test_home_probe_runs_fsync_and_cleans_probe_file(self):
        home = Path(self.tmp.name) / 'home'
        home.mkdir()
        def ssh(bid, command, **kwargs):
            return subprocess.run(['bash', '-c', command], env=dict(os.environ, HOME=str(home)), capture_output=True)
        with patch.object(ssh_sync, 'ssh', side_effect=ssh):
            reason, duration = ssh_sync.probe_home('box', measure_write=True)
        self.assertIsNone(reason)
        self.assertIsNotNone(duration)
        self.assertEqual(list((home / '.offbox').iterdir()), [])

    def test_failed_dd_cannot_report_cold(self):
        result = completed(1, out=b'OFFBOX_WRITE_SECONDS 40.000\n', err=b'permission denied')
        with patch.object(ssh_sync, 'ssh', return_value=result):
            self.assertEqual(ssh_sync.probe_home('box', measure_write=True), (None, None))
            self.assertIsNone(ssh_sync.probe_docker_root('box'))


class ResumeTests(Isolated):
    def test_pending_resume_retains_archived_origin(self):
        self.box('a', state='stopped', member=True)
        common.event(self.con, 'a', 'lease_resume_from', 'archived')
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:a','large',?)", (common.now(),))
        self.con.commit()
        row = self.con.execute("SELECT * FROM leases WHERE box_id='a'").fetchone()
        with patch.object(lease, '_resume_confirmed', return_value=(None, False)), \
                patch.object(lease, '_bring_up_resumed', return_value={'type': 'large'}), \
                patch('offbox_lib.allocation.recover_resumes'):
            row = lease._reuse(self.con, row, 'large')
        self.assertEqual(row['_cold_resume'], 'archived')

    def reuse(self, boat_state='archived'):
        self.box('a', state='stopped', member=True)
        row = self.con.execute("SELECT * FROM leases WHERE box_id='a'").fetchone()
        with patch.object(api, 'get', return_value={'state': boat_state, 'type': 'large'}), \
                patch.object(lease, '_resume_confirmed', return_value=(None, False)), \
                patch.object(lease, '_bring_up_resumed', return_value={'type': 'large'}):
            return lease._reuse(self.con, row, 'large')

    def test_real_archived_resume_sets_signal(self):
        row = self.reuse('archived')
        self.assertEqual(row['_cold_resume'], 'archived')
        self.assertIsNotNone(row['_resumed_at'])

    def test_first_resume_after_resize_is_cold_only_once(self):
        common.event(self.con, 'a', 'lease_resize_stop', 'default -> large')
        row = self.reuse()
        self.assertEqual(row['_cold_resume'], 'archived')
        self.assertIn('resized=1', self.con.execute("SELECT detail FROM events WHERE kind='lease_resume' ORDER BY rowid DESC LIMIT 1").fetchone()[0])
        self.con.execute("DELETE FROM leases WHERE box_id='a'")
        self.con.execute("DELETE FROM pool_members WHERE box_id='a'")
        self.con.commit()
        row = self.reuse()
        self.assertIn('resized=0', self.con.execute("SELECT detail FROM events WHERE kind='lease_resume' ORDER BY rowid DESC LIMIT 1").fetchone()[0])


if __name__ == '__main__':
    unittest.main()
