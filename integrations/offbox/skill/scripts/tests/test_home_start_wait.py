"""Explicit startup refusals wait in place; no unknown command is resent."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, cli, common, home, identity, lease
from offbox_lib.startup_health import starting_phase, wait_seconds
from test_home_backend import HomeFiles
from test_capacity import Isolated

STARTING = {"ok": False, "starting": True, "phase": "reconcile"}
LEGACY = {"ok": False, "reasons": ["reconciling runs and boxes after start"]}
READY = {"ok": True}


class Clock:
    def __init__(self):
        self.now = 0
    def time(self):
        return self.now
    def sleep(self, n):
        self.now += n


class TimerClock(Clock):
    def __init__(self):
        super().__init__()
        self.timers = []

    def timer(self, seconds, callback):
        clock = self

        class Timer:
            def start(self):
                self.end = clock.now + seconds
                self.cancelled = False
                clock.timers.append(self)

            def cancel(self):
                self.cancelled = True

        timer = Timer()
        timer.callback = callback
        return timer

    def sleep(self, seconds):
        super().sleep(seconds)
        for timer in self.timers:
            if not timer.cancelled and timer.end <= self.now:
                timer.cancel()
                timer.callback()


class StartupTests(HomeFiles):
    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(common, 'STATE', self.dir))
        self.stack.enter_context(patch.object(common, 'DB_PATH', self.dir / 'offbox-home.db'))
        self.configure()
        common.select_backend("server")
        self.clock = Clock()
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        self.stack.enter_context(patch.object(api, "_own_box"))
        self.stack.enter_context(patch.object(home, "say"))
        self.stack.enter_context(patch.object(home.time, "sleep", self.clock.sleep))
        self.stack.enter_context(patch.object(home.time, "monotonic", self.clock.time))
        self.events = self.stack.enter_context(patch.object(home.toollog, "emit"))

    def wait(self, data, **kw):
        with patch.object(home, "_health", side_effect=data):
            return home.wait_while_starting(STARTING["phase"], "run-1", **kw)

    def test_probe_and_person_legacy_startup_then_ready(self):
        for who in (None, "moni"):
            with self.subTest(who=who), patch.object(common, "person", return_value=who), \
                    patch.object(home, "_health", side_effect=[LEGACY, LEGACY, READY]):
                self.assertIsNone(home.probe())
                self.assertEqual([c for c in self.events.call_args_list if c.args[1] == "backend.start_wait"][-1].kwargs["props"]["checkpoint"], "person" if who else "probe")
        self.assertFalse(common.HOME_FAILURES.exists())

    def test_bound_reason_and_event(self):
        with patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S="12"), patch.object(home, "_health", return_value=STARTING):
            reason = home.wait_while_starting("reconcile", "run-1", checkpoint="post", box="bx_one")
        self.assertEqual(reason, "home still starting after 12 s (reconcile)")
        self.assertEqual(self.clock.now, 12)
        self.assertEqual(self.events.call_args.kwargs["props"],
                         {"phase": "reconcile", "class": "starting", "checkpoint": "post", "outcome": "failover"})
        self.assertEqual(self.events.call_args.kwargs["ids"]["run"], "run-1")

    def test_reconcile_failure_is_never_starting(self):
        reason = "start-up reconcile failed; retrying (see the boatd journal)"
        for data in ({"reasons": [reason]}, {"message": reason}, {"starting": True, "reasons": [reason]}):
            self.assertIsNone(starting_phase(data))
        self.assertIn("reconcile failed", self.wait([{"ok": False, "reasons": [reason]}]))

    def test_no_answer_still_fails_at_once(self):
        with patch.object(home, "_health", return_value="no answer (TimeoutError)"), \
                patch.object(home, "wait_while_starting") as wait:
            self.assertIn("no answer", home.probe())
        wait.assert_not_called()
        self.assertEqual(self.clock.now, 0)

    def test_auto_stop_waits_before_sync_and_retries_same_box_once(self):
        order = []
        error = api.ApiError(503, "server_not_ready", LEGACY["reasons"][0])
        def request(method, path, *args):
            order.append((method, path))
            if len(order) == 1:
                raise error
            return {}
        def health(timeout):
            order.append("health")
            return READY
        with home.pre_start("run-1"), patch.object(api, "_request", side_effect=request), \
                patch.object(home, "_health", side_effect=health):
            self.assertTrue(lease.ensure_ttl("bx_one", 1200))
            order.append("sync")
        self.assertEqual(order, [("PATCH", "/sandboxes/bx_one"), "health", ("PATCH", "/sandboxes/bx_one"), "sync"])
        self.assertEqual(self.events.call_args.kwargs["props"]["checkpoint"], "autostop")

    def test_post_retries_only_explicit_refusal_with_same_payload(self):
        error = api.ApiError(503, "server_starting", "start")
        error.starting, error.phase = True, "reconcile"
        with home.pre_start("run-1"), patch.object(api, "_request", side_effect=[error, {"processId": 123}]) as req, \
                patch.object(home, "_health", side_effect=[STARTING, READY]):
            result = api.cmd_start("bx_one", "true")
        self.assertEqual(result["processId"], 123)
        self.assertEqual(req.call_args_list[0], req.call_args_list[1])
        self.assertEqual(self.events.call_args.kwargs["props"]["checkpoint"], "post")
        self.assertFalse(common.HOME_FAILURES.exists())

    def test_post_timeout_does_not_resend(self):
        error = api.ApiError(503, "server_not_ready", "waiting for incus")
        with home.pre_start("run-1"), patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S="10"), \
                patch.object(api, "_request", side_effect=error) as req, \
                patch.object(home, "_health", return_value=STARTING):
            with self.assertRaises(home.StartWaitFailed) as raised:
                api.cmd_start("bx_one", "true")
        self.assertFalse(raised.exception.started)
        self.assertEqual((raised.exception.run_id, raised.exception.box), ("run-1", "bx_one"))
        self.assertEqual(req.call_count, 1)

    def test_sync_exec_waits_on_flag_then_preserves_timeout_metadata(self):
        payload = {'starting': True, 'phase': 'reconcile', 'code': 'server_starting', 'message': 'starting'}
        timeout = {'code': 'command_timeout', 'message': 'timed out', 'processId': 123,
                   'stdout': 'partial', 'queuedMs': 0, 'runMs': 1000, 'killed': True}
        def wire(request, **kwargs):
            data = payload if self.clock.now == 0 else timeout
            raise urllib.error.HTTPError(request.full_url, 503 if data is payload else 408, 'fixture', {},
                                         io.BytesIO(json.dumps(data).encode()))
        with home.pre_start('run-1'), patch.object(api, '_key', return_value='fixture'), \
                patch.object(api, '_open', side_effect=wire) as send, patch.object(home, '_health', return_value=READY):
            with self.assertRaises(api.ApiError) as raised:
                api.cmd_sync('bx_one', 'true', timeout=1)
        self.assertEqual((raised.exception.code, raised.exception.api_code), (124, 'command_timeout'))
        self.assertEqual(raised.exception.data, timeout)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(self.clock.now, 5)

    def test_person_gate_and_allocation_share_the_invocation_budget(self):
        def allocate(a, me):
            with home.pre_start('run-person'):
                return api.call('GET', '/limits', retries=0)
        error = api.ApiError(503, 'server_starting', 'waiting for incus')
        me = dict(owner='thread:test', repo_root=str(self.dir), repo_key='repo')
        with patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S='10'), \
                patch.object(common, 'person', return_value='moni'), \
                patch.object(identity, 'whoami', return_value=me), \
                patch.object(home, '_health', side_effect=[STARTING, READY, STARTING, STARTING]), \
                patch.object(api, '_request', side_effect=error) as send, \
                patch.object(cli, '_remote_once', side_effect=allocate), \
                patch.object(home, 'fail_over') as failover, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(['run', '--remote', '--', 'true']), 93)
        self.assertEqual(self.clock.now, 10)
        send.assert_called_once()
        failover.assert_not_called()
        self.assertIsNone(home.WAIT_BUDGET.get())

    def test_http_error_retains_starting_flag_and_phase_without_generic_retries(self):
        for envelope in ({"code": "server_not_ready", "message": "warming storage"},
                         {"error": {"code": "server_starting", "message": "warming storage"}}):
            data = dict(envelope, starting=True, phase="pool")
            error = urllib.error.HTTPError("http://test", 503, "starting", {},
                                           io.BytesIO(json.dumps(data).encode()))
            with patch.object(api, "_key", return_value="fixture"), \
                    patch.object(api, "_open", side_effect=error) as send:
                with self.assertRaises(api.ApiError) as raised:
                    api._request("POST", "/sandboxes/bx_one/commands", {"command": "true"})
            self.assertEqual(home.error_phase(raised.exception), "pool")
            self.assertEqual(send.call_count, 1)

    def test_after_start_or_unknown_network_error_never_retries(self):
        errors = [api.NetworkError("timed out"), api.ApiError(503, "server_not_ready", "start-up reconcile failed; retrying")]
        for error in errors:
            with home.pre_start("run-1"), patch.object(api, "_request", side_effect=error) as req, \
                    patch.object(home, "wait_while_starting") as wait:
                with self.assertRaises(type(error)):
                    api.cmd_start("bx_one", "true")
                self.assertEqual(req.call_count, 1)
                wait.assert_not_called()
        with patch.object(api, "_request", side_effect=api.ApiError(503, "server_not_ready", "starting")), \
                patch.object(home, "wait_while_starting") as wait:
            with self.assertRaises(api.ApiError):
                api.cmd_start("bx_one", "true")
            wait.assert_not_called()

    def test_default_override_and_invalid_bounds(self):
        self.assertEqual(wait_seconds(), 600)
        for value in ("nan", "inf", "-1", "bad"):
            with patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S=value):
                self.assertEqual(wait_seconds(), 600)
        with patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S="7.5"):
            self.assertEqual(wait_seconds(), 7.5)

    def test_startup_wait_pauses_the_box_prepare_deadline(self):
        from offbox_lib import prepare
        with prepare.guard("bx_one", seconds=300) as budget:
            end = budget.end
            with patch.object(home, "_health", return_value=READY):
                home.wait_while_starting("reconcile", "run-1")
            self.assertEqual(budget.end, end + 5)
            prepare.check()

    def test_nested_api_budgets_exclude_startup_wait(self):
        error = api.ApiError(503, "server_not_ready", "waiting for incus")
        with patch.object(api.time, "time", self.clock.time), home.pre_start("run-1"), \
                patch.object(api, "_request", side_effect=[error, {"processId": 7}]), \
                patch.object(home, "_health", return_value=READY):
            with api.budget(100):
                with api.budget(10):
                    api.cmd_start("bx_one", "true")
                    self.assertEqual(api.left(), 10)
                self.assertEqual(api.left(), 100)

    def test_monitor_starting_state_keeps_home_selected(self):
        self.monitor_says("home_starting", reason="waiting for incus")
        self.assertEqual(common.home_state()["state"], "home_starting")
        self.assertEqual(common.default_backend(), "server")

    def test_person_box_api_refusal_uses_person_checkpoint(self):
        error = api.ApiError(503, "server_not_ready", "waiting for incus")
        with home.pre_start("run-1"), patch.object(api, "person", return_value="moni"), \
                patch.object(api, "_request", side_effect=[error, {}]), \
                patch.object(home, "_health", return_value=READY):
            api.cmd_start("bx_one", "true")
        self.assertEqual(self.events.call_args.kwargs["props"]["checkpoint"], "person")

    def test_phase_input_matrix(self):
        for message, expected in [
            ("starting", True), ("waiting for incus", True),
            ("reconciling runs and boxes after start", True),
            ("state dataset offbox/boatd not found (pool offbox is MISSING)", True),
            ("state dataset offbox/boatd is not mounted", True),
            ("state dataset offbox/boatd not found (pool offbox is FAULTED)", False),
            ("state dataset offbox/boatd is mounted at /wrong, expected /right", False),
            ("start-up reconcile failed; retrying (see the boatd journal)", False),
            ("incus is not answering", False), ("arbitrary failure", False)]:
            for field in ("message", "reasons"):
                with self.subTest(message=message, field=field):
                    data = {field: [message] if field == "reasons" else message}
                    self.assertEqual(starting_phase(data) is not None, expected)
        self.assertIsNone(starting_phase({"ok": True, "starting": True, "phase": "reconcile"}))


    def test_real_request_scope_survives_startup_at_each_bounded_entry(self):
        for entry in ('preflight', 'resume', 'readiness'):
            with self.subTest(entry=entry), contextlib.ExitStack() as stack:
                clock = TimerClock()
                stack.enter_context(patch.object(api.time, 'time', clock.time))
                stack.enter_context(patch.object(api.time, 'monotonic', clock.time))
                stack.enter_context(patch.object(api.time, 'sleep', clock.sleep))
                stack.enter_context(patch.object(api.threading, 'Timer', clock.timer))
                stack.enter_context(patch.object(api, '_key', return_value='fixture'))
                stack.enter_context(patch.object(home, 'may_fail_over', return_value=True))
                error = urllib.error.HTTPError('http://fixture', 503, 'starting', {}, io.BytesIO(json.dumps({
                    'code': 'server_not_ready', 'message': 'waiting for incus'}).encode()))
                send = stack.enter_context(patch.object(api, '_open', side_effect=[
                    error, io.BytesIO(b'{"sandbox":{"state":"ready","id":"bx_one"}}')]))
                health_scopes = []
                def health(timeout):
                    health_scopes.append(api._REQUEST_SCOPE.get())
                    self.assertTrue(all(timer.cancelled for timer in clock.timers))
                    return READY
                stack.enter_context(patch.object(home, '_health', side_effect=health))
                parent = api.RequestScope(30)
                with parent.active(), home.pre_start('run-1'):
                    if entry == 'preflight':
                        self.assertIsNone(api.probe_backend('server', 3))
                    elif entry == 'resume':
                        self.assertEqual(api.resume('bx_one', 1200)['sandbox']['id'], 'bx_one')
                    else:
                        self.assertEqual(api.readiness_get('bx_one')['id'], 'bx_one')
                self.assertEqual(send.call_count, 2)
                self.assertEqual(send.call_args_list[0].args[0].data, send.call_args_list[1].args[0].data)
                self.assertEqual(clock.now, 5)
                self.assertTrue(all(scope.parent is None or scope.parent is parent for scope in health_scopes))
                self.assertEqual(len(clock.timers), 2)
                self.assertTrue(all(timer.cancelled for timer in clock.timers))

    def test_parent_cancellation_during_startup_still_prevents_retry(self):
        clock = TimerClock()
        parent = api.RequestScope(3)
        error = urllib.error.HTTPError('http://fixture', 503, 'starting', {}, io.BytesIO(json.dumps({
            'code': 'server_not_ready', 'message': 'waiting for incus'}).encode()))
        def health(timeout):
            parent.cancel()
            return READY
        with patch.object(api.time, 'time', clock.time), patch.object(api.time, 'monotonic', clock.time), \
                patch.object(api.time, 'sleep', clock.sleep), patch.object(api.threading, 'Timer', clock.timer), \
                patch.object(api, '_key', return_value='fixture'), patch.object(api, '_open', side_effect=error) as send, \
                patch.object(home, '_health', side_effect=health), parent.active(), home.pre_start('run-1'):
            with self.assertRaisesRegex(common.OffboxError, 'worker cancelled'):
                api.call('GET', '/limits', retries=0)
        self.assertEqual(send.call_count, 1)

    def test_flapping_startup_uses_one_bound_and_fresh_request_timers(self):
        clock = TimerClock()
        parent = api.RequestScope(3)
        def refuse(*args, **kwargs):
            raise urllib.error.HTTPError('http://fixture', 503, 'starting', {}, io.BytesIO(json.dumps({
                'code': 'server_not_ready', 'message': 'waiting for incus'}).encode()))
        with patch.object(api.time, 'time', clock.time), patch.object(api.time, 'monotonic', clock.time), \
                patch.object(api.time, 'sleep', clock.sleep), patch.object(api.threading, 'Timer', clock.timer), \
                patch.object(api, '_key', return_value='fixture'), patch.object(api, '_open', side_effect=refuse) as send, \
                patch.object(home, '_health', return_value=READY), patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S='10'), \
                parent.active(), home.pre_start('run-1'):
            with self.assertRaisesRegex(home.StartWaitFailed, 'home still starting after 10 s'):
                api.call('GET', '/limits', retries=0)
        self.assertEqual(clock.now, 10)
        self.assertEqual(send.call_count, 3)
        self.assertTrue(all(timer.cancelled for timer in clock.timers))


class AllocationStartupTests(Isolated):
    guard_home_failover = False

    def setUp(self):
        super().setUp()
        self.stack.enter_context(patch.object(api, 'BACKEND', 'server'))
        self.stack.enter_context(patch.object(api, '_own_box'))
        self.stack.enter_context(patch.object(api, '_key', return_value='fixture'))
        self.stack.enter_context(patch.object(home, 'say'))
        self.stack.enter_context(patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S='0'))

    def test_create_and_fork_refusal_clear_only_a_new_marker_and_keep_outage(self):
        from offbox_lib import allocation
        for path in ('/sandboxes', '/sandboxes/bx_source/fork'):
            for pending in (False, True):
                with self.subTest(path=path, pending=pending), allocation.scope('startup-fixture'):
                    key = 'create_unanswered:startup-fixture'
                    body, headers = {'type': 'large'}, {'Idempotency-Key': 'fixture'}
                    self.con.execute('DELETE FROM kv WHERE k=?', (key,))
                    if pending:
                        self.con.execute('INSERT INTO kv VALUES (?,?,?)', (key, json.dumps({
                            'path': path, 'body': body, 'headers': headers}), 1))
                    self.con.commit()
                    error = urllib.error.HTTPError('http://fixture', 503, 'starting', {}, io.BytesIO(json.dumps({
                        'code': 'server_not_ready', 'message': 'waiting for incus'}).encode()))
                    with home.pre_start('run-1'), patch.object(api, '_open', side_effect=error) as send:
                        expected = allocation.Unresolved if pending else home.StartWaitFailed
                        with self.assertRaises(expected) as raised:
                            api.call('POST', path, body, headers)
                    self.assertEqual(send.call_count, 1)
                    self.assertEqual(home.unreachable(raised.exception), not pending)
                    self.assertEqual(self.con.execute('SELECT 1 FROM kv WHERE k=?', (key,)).fetchone() is not None,
                                     pending)

    def test_startup_answer_after_an_ambiguous_send_keeps_the_fence(self):
        from offbox_lib import allocation
        for path in ('/sandboxes', '/sandboxes/bx_source/fork'):
            with self.subTest(path=path), allocation.scope('startup-ambiguous'):
                self.con.execute("DELETE FROM kv WHERE k='create_unanswered:startup-ambiguous'")
                self.con.commit()
                error = urllib.error.HTTPError('http://fixture', 503, 'starting', {}, io.BytesIO(json.dumps({
                    'code': 'server_not_ready', 'message': 'waiting for incus'}).encode()))
                with home.pre_start('run-1'), patch.object(api.time, 'sleep'), \
                        patch.object(api, '_open', side_effect=[urllib.error.URLError('timed out'), error]) as send:
                    with self.assertRaises(allocation.Unresolved) as raised:
                        api.call('POST', path, {'type': 'large'}, {'Idempotency-Key': 'fixture'})
                self.assertFalse(home.unreachable(raised.exception))
                self.assertEqual(send.call_count, 2)
                self.assertIsNotNone(self.con.execute(
                    "SELECT 1 FROM kv WHERE k='create_unanswered:startup-ambiguous'").fetchone())


class RunnerStartupTests(Isolated):
    guard_home_failover = False

    def setUp(self):
        super().setUp()
        from offbox_lib import cli, pool, runs
        self.runs, self.pool = runs, pool
        self.stack.enter_context(patch.dict(os.environ, OFFBOX_BACKEND="server"))
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        self.stack.enter_context(patch.object(api, "_own_box"))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.box("bx_one", member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='bx_one'").fetchone())
        self.row = dict(row, remote_dir="w/r")
        args = cli.build_parser().parse_args(["run", "--", "true"])
        self.runner = runs.Runner(args, self.me)
        self.stack.enter_context(patch.object(runs, "_keep_ttl", return_value=contextlib.nullcontext(None)))
        self.stack.enter_context(patch.object(runs.node_version, "want", return_value=None))
        self.stack.enter_context(patch.object(runs, "new_checkout_hint"))
        self.stack.enter_context(patch.object(home.time, "sleep"))

    def test_autostop_refusal_keeps_box_and_syncs_once_before_post(self):
        order = []
        def acquire(*args, **kwargs):
            lease.ensure_ttl("bx_one", 1200)
            return self.row
        def request(method, path, *args):
            order.append(method)
            if order == ["PATCH"]:
                raise api.ApiError(503, "server_not_ready", "waiting for incus")
            return {"processId": 7}
        def health(timeout):
            order.append("health")
            return READY
        with patch.object(self.pool, "acquire", side_effect=acquire) as acquire_mock, \
                patch.object(api, "_request", side_effect=request), patch.object(home, "_health", side_effect=health), \
                patch.object(self.runner, "_prepare_box", side_effect=lambda *args: order.append("sync")) as sync, \
                home.pre_start(self.runner.run_id):
            self.runner.start()
        self.assertEqual(order, ["PATCH", "health", "PATCH", "sync", "POST"])
        self.assertEqual(acquire_mock.call_count, 1)
        self.assertEqual(sync.call_count, 1)
        self.assertEqual(self.runner.box, "bx_one")

    def test_post_refusal_retries_same_command_without_reacquiring_or_syncing(self):
        error = api.ApiError(503, "server_not_ready", "reconciling runs and boxes after start")
        with patch.object(self.pool, "acquire", return_value=self.row) as acquire, \
                patch.object(self.runner, "_prepare_box", return_value=None) as sync, \
                patch.object(api, "_request", side_effect=[error, {"processId": 7}]) as request, \
                patch.object(home, "_health", return_value=READY), home.pre_start(self.runner.run_id):
            self.runner.start()
        self.assertEqual(acquire.call_count, 1)
        self.assertEqual(sync.call_count, 1)
        self.assertEqual(request.call_args_list[0], request.call_args_list[1])
        self.assertTrue(self.runner.started)

    def test_bound_failure_releases_guard_hold_and_records_run_id(self):
        error = api.ApiError(503, "server_not_ready", "waiting for incus")
        guard = common.file_lock("box-bx_one", timeout=0)
        guard.__enter__()
        self.row['_guard'] = guard
        self.addCleanup(self.pool.release_guard, self.row)
        self.con.execute("INSERT INTO prune_holds VALUES ('bx_one', ?, 1)", (self.runner.run_id,))
        self.con.execute("INSERT INTO prune_holds VALUES ('bx_other', 'other-run', 1)")
        self.con.commit()
        with patch.object(self.runs, "Runner", return_value=self.runner), \
                patch.object(self.pool, "acquire", return_value=self.row), \
                patch.object(self.runner, "_prepare_box", return_value=None), \
                patch.object(api, "_request", side_effect=error), \
                patch.dict(os.environ, OFFBOX_HOME_START_WAIT_S="0"):
            with self.assertRaises(home.StartWaitFailed) as raised:
                self.runs._run_attempt(self.runner.a, self.me)
        self.assertFalse(raised.exception.started)
        with common.file_lock("box-bx_one", timeout=0):
            pass
        self.assertEqual(lease.active_runs(self.con, "bx_one"), 0)
        with patch.object(api, "probe_backend", return_value=None), \
                patch.object(os, "execve", side_effect=RuntimeError("exec intercepted")):
            with self.assertRaisesRegex(RuntimeError, "exec intercepted"):
                home.fail_over(str(raised.exception), ["run", "--", "true"], self.runner.run_id)
        remaining = self.con.execute("SELECT run_id FROM prune_holds").fetchall()
        self.assertEqual([r[0] for r in remaining], ["other-run"])
        failure = json.loads(common.HOME_FAILURES.read_text().splitlines()[-1])
        self.assertEqual(failure["run"], self.runner.run_id)
        self.assertIn("home still starting after 0 s", failure["reason"])

    def test_failed_reconcile_at_post_is_a_known_refusal(self):
        error = api.ApiError(503, "server_not_ready", "start-up reconcile failed; retrying")
        with patch.object(self.pool, "acquire", return_value=self.row), \
                patch.object(self.runner, "_prepare_box", return_value=None), \
                patch.object(api, "_request", side_effect=error), \
                patch.object(home, "wait_while_starting") as wait, home.pre_start(self.runner.run_id):
            with self.assertRaises(api.ApiError):
                self.runner.start()
        self.assertFalse(self.runner.started)
        wait.assert_not_called()
