import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, capacity, common, home_run_observation as observation, misc


class HomeRunObservation(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name, value in (("LOGS_DIR", self.root / "logs"), ("BACKEND_STATE", self.root / "backend-state.json"),
                            ("STATE", self.root), ("DB_PATH", self.root / "offbox-home.db"), ("_BACKEND", "server")):
            self.stack.enter_context(patch.object(common, name, value))
        self.stack.enter_context(patch.object(misc, "LOGS_DIR", common.LOGS_DIR))
        self.stack.enter_context(patch.object(misc, "CAP_PATH", self.root / "cap.json"))
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        self.stack.enter_context(patch.object(common, "home_config", return_value={"url": "http://home/api/v1"}))
        self.stack.enter_context(patch.object(common, "now", return_value=1794728890))
        self.row = dict(run_id="run-test", status="running", mode="bg", owner="owner", repo_root="/repo",
                        box_id="bx_home", process_id=1, exit_code=None)

    def state(self, name):
        common.BACKEND_STATE.write_text(json.dumps(dict(state=name, last_ok=1794728800)))

    def test_wait_and_follow_logs_show_last_successful_read_before_waiting(self):
        observation.observe("run-test", "stream heartbeat")
        for state in ("home_down", "home_slow"):
            self.state(state)
            for read in (lambda: misc.wait("run-test", 1), lambda: misc.logs("run-test", True)):
                with self.subTest(state=state, read=read), patch.object(misc, "_run_row", return_value=self.row), \
                        patch.object(misc, "_require_my_run"), patch.object(misc, "_wait_locked", return_value=124), \
                        contextlib.redirect_stderr(io.StringIO()) as output:
                    self.assertEqual(read(), 124)
                text = output.getvalue()
                self.assertIn("run-test is still on home", text)
                self.assertIn("last good run read: stream heartbeat at " + observation.stamp(1794728890), text)
                self.assertIn("Do not kill it because of this health-check flap", text)

    def test_status_shows_home_run_when_monitor_routes_status_to_boat(self):
        self.state("home_down")
        observation.observe("run-test", "queued")
        with contextlib.closing(common.db()) as con:
            con.execute("INSERT INTO runs(run_id,status,mode,owner,repo_root) VALUES (?,?,?,?,?)",
                        ("run-test", "running", "bg", "owner", "/repo"))
            con.commit()
        with patch.object(api, "BACKEND", "boat"), patch.object(api, "limits", side_effect=common.OffboxError("offline")), \
                patch.object(api, "list_boxes", side_effect=common.OffboxError("offline")), \
                patch.object(capacity, "snapshot", return_value={"counts": [], "blocked": False}), \
                patch.object(capacity, "supply_status", return_value={}), \
                patch.object(misc.outage, "current", return_value=None), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            misc.status({"owner": "owner", "repo_root": "/repo"})
        self.assertIn("run-test is still on home", output.getvalue())
        self.assertIn("last good run read: queued at " + observation.stamp(1794728890), output.getvalue())

    def test_no_record_uses_dated_health_without_claiming_a_run_read(self):
        self.state("home_slow")
        output = []
        observation.notice(self.row, emit=output.append)
        self.assertIn("last good run read: not recorded; last good health read: " + observation.stamp(1794728800), output[0])

    def test_boat_and_terminal_runs_do_not_get_home_flap_notice(self):
        self.state("home_down")
        output = []
        observation.notice(self.row, backend="boat", emit=output.append)
        observation.notice(dict(self.row, status="done"), emit=output.append)
        self.assertEqual(output, [])


    def test_stream_records_real_remote_reply_even_when_health_is_down(self):
        from offbox_lib import runs
        self.state("home_down")
        frames = [{"type": "hello", "attempt": 1}, {"type": "exit", "status": "exited", "exitCode": 0}]
        with patch.object(api, "cmd_attach", return_value=iter(frames)), patch.object(runs, "_ttl_keeper"):
            self.assertEqual(runs.follow("bx_home", 1, None, echo=False, run_id="run-test"), 0)
        read = json.loads((common.LOGS_DIR / "run-test.home-read.json").read_text())
        self.assertEqual((read["kind"], read["at"]), ("exited", 1794728890))


    def test_legacy_run_without_sidecar_uses_its_accepted_command_receipt(self):
        self.state("home_down")
        output = []
        observation.notice(dict(self.row, command_at=1794728890), emit=output.append)
        self.assertIn("last good run read: command accepted at " + observation.stamp(1794728890), output[0])

    def test_host_queue_down_notice_is_once_across_logs_wait_and_status(self):
        common.BACKEND_STATE.write_text(json.dumps(dict(state='home_down', since=1794728800)))
        observation.observe('run-test', 'queued')
        output = []
        with patch.object(observation.toollog, 'emit') as event:
            observation.notice(self.row, emit=output.append)
            observation.notice(self.row, emit=output.append)
            # Each command reaches the same persistent deduplication, including a status routed to Boat.
            with patch.object(misc, '_run_row', return_value=self.row), patch.object(misc, '_require_my_run'), \
                    patch.object(misc, '_wait_locked', return_value=124), contextlib.redirect_stderr(io.StringIO()) as stderr:
                misc.wait('run-test', 1)
                misc.logs('run-test', True)
            with contextlib.closing(common.db()) as con:
                con.execute('INSERT INTO runs(run_id,status,mode,owner,repo_root,box_id,process_id) VALUES (?,?,?,?,?,?,?)',
                            ('run-test', 'running', 'bg', 'owner', '/repo', 'bx_home', 1))
                con.commit()
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                misc._home_run_notices(dict(owner='owner', repo_root='/repo'))
        self.assertEqual(len(output), 1)
        self.assertIn('home_down since 07:46Z', output[0])
        self.assertIn('accepted on bx_home and stays queued there; it will not move to Boat', output[0])
        self.assertEqual(stderr.getvalue(), '')
        self.assertEqual(stdout.getvalue(), '')
        event.assert_called_once()
        self.assertEqual(event.call_args.args[1], 'run.queue.home_down_notice')

    def test_first_notice_from_each_client_entry_point(self):
        self.state('home_down')
        observation.observe('run-test', 'stream heartbeat', status='queued')
        with contextlib.closing(common.db()) as con:
            con.execute('INSERT INTO runs(run_id,status,mode,owner,repo_root,box_id,process_id) VALUES (?,?,?,?,?,?,?)',
                        ('run-test', 'running', 'bg', 'owner', '/repo', 'bx_home', 1))
            con.commit()
        for action in ('wait', 'logs', 'status'):
            with self.subTest(action=action):
                (common.LOGS_DIR / 'run-test.home-queue-notice').unlink(missing_ok=True)
                with patch.object(misc, '_run_row', return_value=self.row), patch.object(misc, '_require_my_run'), \
                        patch.object(misc, '_wait_locked', return_value=124), contextlib.redirect_stderr(io.StringIO()) as stderr, \
                        contextlib.redirect_stdout(io.StringIO()) as stdout:
                    if action == 'status':
                        misc._home_run_notices(dict(owner='owner', repo_root='/repo'))
                    else:
                        getattr(misc, action)('run-test', True if action == 'logs' else 1)
                self.assertIn('it will not move to Boat', stdout.getvalue() + stderr.getvalue())

    def test_first_wait_or_follow_logs_notices_fresh_queue_evidence_once(self):
        from offbox_lib import runs
        self.state('home_down')
        common.LOGS_DIR.mkdir(exist_ok=True)
        with contextlib.closing(common.db()) as con:
            con.execute('INSERT INTO runs(run_id,status,mode,box_id,process_id) VALUES (?,?,?,?,?)',
                        ('run-test', 'running', 'bg', 'bx_home', 1))
            con.commit()
        log = common.LOGS_DIR / 'run-test.log'
        for action in ('wait', 'logs'):
            for legacy in (False, True):
                with self.subTest(action=action, legacy=legacy), contextlib.ExitStack() as stack:
                    (common.LOGS_DIR / 'run-test.home-queue-notice').unlink(missing_ok=True)
                    (common.LOGS_DIR / 'run-test.home-read.json').unlink(missing_ok=True)
                    log.write_text('')
                    observation.observe('run-test', 'accepted')
                    output = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    event = stack.enter_context(patch.object(observation.toollog, 'emit'))
                    def frames():
                        yield dict(type='hello', attempt=1, **({} if legacy else dict(status='queued')))
                        if legacy:
                            yield dict(type='stderr', data='offbox-server: waiting for earlier runs in the queue\n')
                        self.assertEqual(event.call_count, 1)
                        yield dict(type='heartbeat', status='queued')
                        yield dict(type='exit', status='exited', exitCode=0)
                    stack.enter_context(patch.object(api, 'cmd_attach', side_effect=lambda *a, **kw: frames()))
                    stack.enter_context(patch.object(runs, '_ttl_keeper'))
                    stack.enter_context(patch.object(misc, '_run_row', return_value=self.row))
                    stack.enter_context(patch.object(misc, '_require_my_run'))
                    stack.enter_context(patch.object(misc, '_wait_locked', side_effect=lambda *a, **kw:
                                                    runs.follow('bx_home', 1, log, echo=False, run_id='run-test')))
                    self.assertEqual(getattr(misc, action)('run-test', 45 if action == 'wait' else True), 0)
                    self.assertEqual(output.getvalue().count('it will not move to Boat'), 1)
                    event.assert_called_once()
                    self.assertEqual(event.call_args.args[1], 'run.queue.home_down_notice')

    def test_host_queued_evidence_matrix(self):
        cases = [
            ('queued', '', True),
            ('running', 'offbox-server: waiting for earlier runs in the queue', False),
            (None, 'offbox-server: waiting for earlier runs in the queue', True),
            (None, 'offbox-server: waiting; position 2 of 2; memory', True),
            (None, 'offbox-server: waiting\noffbox-command-started: yes', False),
            (None, 'offbox-server: waiting\noffbox-space: {"phase": "start"}', False),
            (None, '', False),
        ]
        common.LOGS_DIR.mkdir(exist_ok=True)
        for remote, text, expected in cases:
            with self.subTest(remote=remote, text=text):
                (common.LOGS_DIR / 'run-test.log').write_text(text)
                self.assertEqual(observation.queued_on_home(self.row, dict(status=remote)), expected)
        self.assertFalse(observation.queued_on_home(dict(self.row, box_id=None), dict(status='queued')))

    def test_queue_notice_only_for_accepted_home_run_during_home_down(self):
        observation.observe('run-test', 'queued')
        for backend, status, state in [('boat', 'running', 'home_down'), ('server', 'done', 'home_down'),
                                       ('server', 'running', 'home_up'), ('server', 'running', 'home_slow')]:
            with self.subTest(backend=backend, status=status, state=state):
                self.state(state)
                output = []
                observation.notice(dict(self.row, status=status), backend=backend, emit=output.append)
                self.assertFalse(any('it will not move to Boat' in x for x in output))

    def test_stream_status_survives_output_observations_then_updates_to_running(self):
        observation.observe('run-test', 'stream connected', status='queued')
        observation.observe('run-test', 'output received')
        path = common.LOGS_DIR / 'run-test.home-read.json'
        self.assertEqual(json.loads(path.read_text())['status'], 'queued')
        observation.observe('run-test', 'stream heartbeat', status='running')
        self.assertEqual(json.loads(path.read_text())['status'], 'running')

    def test_status_frames_are_persisted_despite_continuous_output_throttling(self):
        from offbox_lib import runs
        self.state('home_down')
        log = common.LOGS_DIR / 'run-test.log'
        common.LOGS_DIR.mkdir(exist_ok=True)
        def frames():
            yield dict(type='hello', attempt=1, status='queued')
            yield dict(type='stdout', data='offbox-command-started: yes\n' + 'x' * 70000)
            yield dict(type='heartbeat', status='running')
            read = json.loads((common.LOGS_DIR / 'run-test.home-read.json').read_text())
            self.assertEqual(read['status'], 'running')
            self.assertFalse(observation.queued_on_home(self.row, read))
            yield dict(type='attempt', attempt=2, status='queued')
            read = json.loads((common.LOGS_DIR / 'run-test.home-read.json').read_text())
            self.assertEqual((read['attempt'], read['status']), (2, 'queued'))
            self.assertTrue(observation.queued_on_home(self.row, read))
            yield dict(type='exit', status='exited', exitCode=0)
        with patch.object(api, 'cmd_attach', side_effect=lambda *a, **kw: frames()), \
                patch.object(runs, '_ttl_keeper'), patch.object(runs, 'now', return_value=10000):
            self.assertEqual(runs.follow('bx_home', 1, log, echo=False, run_id='run-test'), 0)

    def test_current_attempt_status_and_legacy_log_evidence_matrix(self):
        old = 'offbox-space: {"phase": "attempt", "attempt": 1}\noffbox-command-started: yes\n'
        new = 'offbox-space: {"phase": "attempt", "attempt": 2}\n'
        queue = 'offbox-server: waiting; position 1 of 1; memory\n'
        retry = 'offbox-server: the server restarted; it is queued again as attempt 2\n'
        cases = [
            ('explicit_queued_old_start', dict(status='queued', attempt=2), old, True),
            ('explicit_running_old_queue', dict(status='running', attempt=2), old + new + queue, False),
            ('legacy_new_attempt_queued', dict(attempt=2), old + new + queue, True),
            ('legacy_new_attempt_running', dict(attempt=2), old + new + queue + 'offbox-command-started: yes', False),
            ('legacy_retry_boundary', dict(attempt=2), old + retry + queue, True),
            ('legacy_stale_attempt', dict(attempt=2), old + queue, False),
            ('legacy_first_attempt_running', {}, queue + 'offbox-command-started: yes', False),
        ]
        common.LOGS_DIR.mkdir(exist_ok=True)
        for name, read, log, expected in cases:
            with self.subTest(name=name):
                (common.LOGS_DIR / 'run-test.log').write_text(log)
                self.assertEqual(observation.queued_on_home(self.row, read), expected)
        observation.observe('run-test', 'stream connected', status='running', attempt=1)
        observation.observe('run-test', 'stream connected', attempt=2)
        read = json.loads((common.LOGS_DIR / 'run-test.home-read.json').read_text())
        self.assertEqual(read['attempt'], 2)
        self.assertIsNone(read['status'])


if __name__ == "__main__":
    unittest.main()
