"""Expired startup waits remain terminal through acquisition and SSH recovery."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, cli, common, home, lease, pool, runs, ssh_sync
from test_capacity import Isolated
from test_home_start_wait import Clock, STARTING


class MovedToBoat(BaseException):
    pass


class AcquisitionStartupTests(Isolated):
    guard_home_failover = False

    def setUp(self):
        super().setUp()
        self.clock = Clock()
        self.clock.now = 1000
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch.object(common, '_BACKEND', 'server'))
        self.stack.enter_context(patch.object(api, 'BACKEND', 'server'))
        self.stack.enter_context(patch.object(api, '_own_box'))
        self.stack.enter_context(patch.object(api, '_key', return_value='fixture'))
        self.stack.enter_context(patch.object(api.time, 'time', self.clock.time))
        self.stack.enter_context(patch.object(api.time, 'monotonic', self.clock.time))
        self.stack.enter_context(patch.object(api.time, 'sleep', self.clock.sleep))
        self.stack.enter_context(patch.object(lease, 'cap_check'))
        self.stack.enter_context(patch.object(pool, '_refresh_background'))
        self.stack.enter_context(patch.object(home, 'may_fail_over', return_value=True))
        self.stack.enter_context(patch.object(home, 'before_run'))
        self.stack.enter_context(patch.object(home, '_health', return_value=STARTING))
        self.stack.enter_context(patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S='10', OFFBOX_POOL_WAIT_SECONDS='30'))
        self.stack.enter_context(patch.object(api, 'probe_backend', return_value=None))
        self.exec = self.stack.enter_context(patch.object(os, 'execve', side_effect=MovedToBoat))
        self.stack.enter_context(patch.object(runs, '_keep_ttl', return_value=contextlib.nullcontext(None)))
        self.stack.enter_context(patch.object(runs, '_ttl_keeper'))
        self.sync = self.stack.enter_context(patch.object(runs.Runner, '_sync_box'))
        self.command = self.stack.enter_context(patch.object(api, 'cmd_start'))
        self.stack.enter_context(patch.object(lease, 'bootstrap_fresh'))
        self.args = cli.build_parser().parse_args(['run', '--remote', '--', 'true'])
        self.args.argv = ['run', '--remote', '--', 'true']
        self.wire = []

    def refuse(self, request):
        raise urllib.error.HTTPError(request.full_url, 503, 'starting', {}, io.BytesIO(json.dumps({
            'code': 'server_not_ready', 'message': 'waiting for incus'}).encode()))

    def assert_failed_over(self, box):
        self.assertEqual(self.clock.now, 1010)
        self.exec.assert_called_once()
        self.assertEqual(self.exec.call_args.args[2]['OFFBOX_BACKEND'], 'boat')
        self.sync.assert_not_called()
        self.command.assert_not_called()
        self.assertEqual(lease.active_runs(self.con, box), 0)
        with common.file_lock('box-' + box, timeout=0):
            pass
        failures = [json.loads(line) for line in common.HOME_FAILURES.read_text().splitlines()]
        self.assertEqual(len(failures), 1)
        self.assertTrue(failures[0]['run'])
        self.assertIn('home still starting after 10 s', failures[0]['reason'])
        self.assertIsNone(self.con.execute("SELECT 1 FROM events WHERE box_id=? AND kind='lease_ready'", (box,)).fetchone())
        self.assertIsNone(self.con.execute('SELECT ssh_ready_at FROM leases WHERE box_id=?', (box,)).fetchone()[0])
        self.assertEqual(self.con.execute('SELECT COUNT(*) FROM pool_pending').fetchone()[0], 0)

    def test_new_box_rename_bound_fails_over_before_sync(self):
        def response(request, **kwargs):
            self.wire.append((request.method, request.full_url))
            return self.refuse(request)
        with patch.object(lease, '_new_box', return_value=({'id': 'new-box'}, 'fresh', None, 'large')) as create, \
                patch.object(api, 'wait_state', return_value={'state': 'ready'}), \
                patch.object(ssh_sync, 'setup'), patch.object(ssh_sync, 'wait_ssh'), \
                patch.object(api, '_open', side_effect=response):
            with self.assertRaises(MovedToBoat):
                cli._run_with_retries(self.args, self.me)
        create.assert_called_once()
        self.assertEqual(len(self.wire), 1)
        self.assertEqual(self.wire[0][0], 'PATCH')
        self.assert_failed_over('new-box')

    def test_ssh_authorization_bound_does_not_retry_or_choose_another_box(self):
        self.box('own', member=True)
        self.box('peer', member=True)
        self.con.execute("UPDATE leases SET owner=?,repo_root=? WHERE box_id='own'", (self.me['owner'], self.me['repo_root']))
        self.con.commit()
        def response(request, **kwargs):
            self.wire.append((request.method, request.full_url))
            if request.method == 'POST' and request.full_url.endswith('/sshkey'):
                return self.refuse(request)
            return io.BytesIO(b'{"sandbox":{"state":"ready","type":"large"}}')
        with patch.object(api, '_open', side_effect=response), patch.object(ssh_sync, 'pubkey', return_value='fixture'), \
                patch.object(ssh_sync, 'wait_ssh') as ready, patch.object(lease, '_new_box') as create:
            with self.assertRaises(MovedToBoat):
                cli._run_with_retries(self.args, self.me)
        authorizations = [path for method, path in self.wire if path.endswith('/sshkey')]
        self.assertEqual(len(authorizations), 1)
        self.assertTrue(authorizations[0].endswith('/own/sshkey'))
        self.assertFalse(any('/peer' in path for method, path in self.wire))
        ready.assert_not_called()
        create.assert_not_called()
        self.assert_failed_over('own')

    def test_terminal_ssh_timeout_survives_all_bring_up_wrappers(self):
        self.box('box', member=True)
        row = self.con.execute("SELECT * FROM leases WHERE box_id='box'").fetchone()
        for operation in ('new', 'resumed', 'running-reuse'):
            for checkpoint in ('setup', 'wait_ssh'):
                with self.subTest(operation=operation, checkpoint=checkpoint), contextlib.ExitStack() as stack:
                    error = home.StartWaitFailed('home still starting after 10 s (waiting for incus)', box='box')
                    stack.enter_context(patch.object(api, 'wait_state', return_value={'state': 'ready'}))
                    stack.enter_context(patch.object(api, 'get', return_value={'state': 'ready', 'type': 'large'}))
                    stack.enter_context(patch.object(ssh_sync, 'setup'))
                    stack.enter_context(patch.object(ssh_sync, 'wait_ssh'))
                    stack.enter_context(patch.object(ssh_sync, checkpoint, side_effect=error))
                    with self.assertRaises(home.StartWaitFailed) as raised:
                        if operation == 'new':
                            lease._bring_up('box')
                        elif operation == 'resumed':
                            lease._bring_up_resumed(self.con, 'box', {'state': 'ready'}, False)
                        else:
                            lease._reuse(self.con, row, 'large')
                    self.assertIs(raised.exception, error)

    def test_recipe_rename_timeout_never_reports_ready_or_restarts_cleanup_wait(self):
        error = home.StartWaitFailed('home still starting after 10 s (waiting for incus)', box='recipe')
        with patch.object(lease, '_bring_up'), patch.object(api, 'rename', side_effect=error), \
                patch.object(lease, '_retire_recipe_box') as retire:
            with self.assertRaises(home.StartWaitFailed) as raised:
                lease._create_row(self.con, self.me, 'recipe', 'recipe:generic', None, 'large', 1000)
        self.assertIs(raised.exception, error)
        retire.assert_not_called()
        row = self.con.execute("SELECT state,ssh_ready_at FROM leases WHERE box_id='recipe'").fetchone()
        self.assertEqual(tuple(row), ('bringing_up', None))
        self.assertIsNone(self.con.execute("SELECT 1 FROM events WHERE box_id='recipe' AND kind='lease_ready'").fetchone())

    def test_ssh_refresh_and_upload_do_not_swallow_terminal_wait(self):
        error = home.StartWaitFailed('home still starting after 10 s (waiting for incus)', box='box')
        with patch.object(ssh_sync, 'close_master'), patch.object(ssh_sync, 'setup', side_effect=error):
            with self.assertRaises(home.StartWaitFailed) as raised:
                ssh_sync._refresh_master('box')
            self.assertIs(raised.exception, error)
            errors = []
            with self.assertRaises(home.StartWaitFailed):
                runs._safe(errors, ssh_sync.setup, 'box')
        self.assertEqual(errors, [])
