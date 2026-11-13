"""Silent home API failures stop preparation early without changing Boat or person policy."""
import contextlib
import http.server
import io
import os
from pathlib import Path
import sys
import threading
import time
import urllib.error
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'skill' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / 'tests'))
from offbox_lib import allocation, api, common, home, lease, pool
from test_capacity import Isolated
from test_resume_stuck import Clock


class HomeNetworkReadiness(Isolated):
    def setUp(self):
        super().setUp()
        self.clock = Clock()
        self.stack.enter_context(patch.object(api, 'time', self.clock))
        self.stack.enter_context(patch.object(lease, 'time', self.clock))
        self.stack.enter_context(patch.object(allocation, 'time', self.clock))
        self.stack.enter_context(patch.object(lease, 'now', self.clock.time))
        self.stack.enter_context(patch.object(home, 'may_fail_over', return_value=True))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'setup'))
        self.stack.enter_context(patch.object(lease.ssh_sync, 'wait_ssh'))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.box('cold', 'stopped')

    def silent(self, req, timeout):
        self.clock.sleep(timeout)
        raise TimeoutError('API never answered')

    def test_real_socket_timeouts_during_bringup_stop_after_two(self):
        start = self.clock.t
        with patch.object(api, '_key', return_value='fixture'), patch.object(api, '_open', side_effect=self.silent) as opened:
            with self.assertRaisesRegex(lease.ResumeUnresolved, 'nothing ran') as caught:
                lease._bring_up_resumed(self.con, 'cold', None, False)
        self.assertEqual(opened.call_count, api.HOME_NETWORK_FAILURES)
        self.assertLess(self.clock.t - start, 11)
        self.assertEqual(caught.exception.code, common.EXIT_INFRA)
        self.assertFalse(caught.exception.started)
        self.assertTrue(caught.exception.outage)

    def test_unanswered_resume_is_bounded_and_releases_allocation_guard(self):
        start = self.clock.t
        with patch.object(api, '_key', return_value='fixture'), patch.object(api, '_open', side_effect=self.silent) as opened:
            with allocation.scope('repo'):
                with self.assertRaisesRegex(lease.ResumeUnresolved, 'nothing ran') as caught:
                    lease._resume_confirmed(self.con, 'cold', 600, None)
                self.assertFalse(allocation._HELD.get())
                with allocation.guard('cold', reconcile=True):
                    pass
        self.assertEqual(opened.call_count, 3)  # one resume, two independent status reads
        self.assertLess(self.clock.t - start, 18)
        self.assertTrue(caught.exception.outage)
        self.assertIsNotNone(self.con.execute("SELECT 1 FROM kv WHERE k='resume_unanswered:cold'").fetchone())
        self.assertEqual(self.con.execute("SELECT v FROM kv WHERE k='resume_sender:cold'").fetchone()[0], '')

    def test_provisioning_confirmation_also_stops_on_two_timeouts(self):
        start = self.clock.t
        with patch.object(api, '_key', return_value='fixture'), patch.object(api, '_open', side_effect=self.silent):
            with self.assertRaisesRegex(lease.ResumeUnresolved, 'nothing ran'):
                lease._wait_unanswered_resume(self.con, 'cold')
        self.assertLess(self.clock.t - start, 13)

    def test_answer_resets_consecutive_network_errors(self):
        error = api.NetworkError('read timed out')
        script = [error, {'state': 'resuming'}, error, {'state': 'running'}]
        with patch.object(api, 'get', side_effect=script) as get:
            self.assertEqual(api.wait_state('cold', api.LIVE_STATES)['state'], 'running')
        self.assertEqual(get.call_count, 4)

    def test_http_responses_are_not_counted_as_network_failures(self):
        for status in (400, 401, 403, 408, 429, 500, 502, 503, 504):
            with self.subTest(status=status), patch.object(api, 'get', side_effect=api.ApiError(status, 'refused', 'body')) as get:
                with self.assertRaises(api.ApiError):
                    api.wait_state('cold', api.LIVE_STATES)
                self.assertEqual(get.call_count, 1)

    def test_slow_answering_box_keeps_existing_readiness_window(self):
        start = self.clock.t
        def answering(*args, **kwargs):
            return {'state': 'resuming' if self.clock.t - start < 270 else 'running'}
        with patch.object(api, 'get', side_effect=answering):
            self.assertEqual(lease._bring_up('cold')['state'], 'running')
        self.assertGreaterEqual(self.clock.t - start, 270)

    def test_boat_pinned_and_person_keep_original_requests(self):
        with patch.object(home, 'may_fail_over', return_value=False), patch.object(api, 'get', return_value={'state': 'running'}) as get:
            api.wait_state('cold', api.LIVE_STATES)
            get.assert_called_once_with('cold')
            with patch.object(api, 'call', return_value={}) as call:
                api.resume('cold', 600)
                call.assert_called_once_with('POST', '/sandboxes/cold/resume', {'ttlSeconds': 600}, retries=0)

    def test_direct_allocation_wait_is_bounded_without_changing_busy_exit(self):
        @contextlib.contextmanager
        def busy(name, timeout):
            self.clock.sleep(timeout + .01)
            raise common.OffboxError('timed out waiting for lock')
            yield
        start = self.clock.t
        with patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS': '86400'}), \
                patch.object(allocation, 'file_lock', busy):
            with allocation.scope('repo'):
                with self.assertRaises(pool.PoolBusyError) as caught:
                    lease._resume_confirmed(self.con, 'cold', 600, None)
        self.assertLess(self.clock.t - start, lease.HOME_RESUME_LOCK_WAIT_S + 1)
        self.assertEqual(caught.exception.code, common.EXIT_BUSY)

    def test_authenticated_probe_requires_success_and_is_bounded_on_each_backend(self):
        for backend in ('server', 'boat'):
            with self.subTest(backend=backend), patch.object(api, 'BACKEND', 'server'), \
                    patch.object(api, '_key', return_value='fixture'), \
                    patch.object(api.subprocess, 'run', return_value=type('Key', (), {'returncode': 0, 'stdout': 'fixture'})()), \
                    patch.object(api, '_open', side_effect=self.silent) as opened:
                start = self.clock.t
                self.assertIsNotNone(api.probe_backend(backend, 3))
                self.assertLessEqual(self.clock.t - start, 3)
                self.assertEqual(opened.call_count, 1)
            for status in (401, 500, 503):
                error = urllib.error.HTTPError('http://fixture', status, 'refused', {}, io.BytesIO(b'{}'))
                with self.subTest(backend=backend, status=status), patch.object(api, 'BACKEND', 'server'), \
                        patch.object(api, '_key', return_value='fixture'), \
                        patch.object(api.subprocess, 'run', return_value=type('Key', (), {'returncode': 0, 'stdout': 'fixture'})()), \
                        patch.object(api, '_open', side_effect=error):
                    self.assertIsNotNone(api.probe_backend(backend, 3))


class TrickleHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.server.received.set()
        try:
            if self.server.phase == 'headers':
                self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Slow: ')
            else:
                self.wfile.write(b'HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n')
            while not self.server.release.wait(.02):
                self.wfile.write(b'x')
                self.wfile.flush()
            if self.server.phase == 'headers':
                self.wfile.write(b'\r\nContent-Length: 2\r\n\r\n{}')
        except OSError:
            pass

    do_POST = do_GET

    def log_message(self, *_):
        pass


class HomeWireDeadline(Isolated):
    def test_headers_and_body_are_bounded_for_status_and_resume(self):
        for operation in ('status', 'resume'):
            for phase in ('headers', 'body'):
                with self.subTest(operation=operation, phase=phase):
                    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), TrickleHandler)
                    server.phase = phase
                    server.received = threading.Event()
                    server.release = threading.Event()
                    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
                    thread.start()
                    # A broken client still finishes the test; passing must beat this fixture watchdog.
                    watchdog = threading.Timer(.8, server.release.set)
                    watchdog.start()
                    try:
                        with patch.object(api, 'API', f'http://127.0.0.1:{server.server_port}'), \
                                patch.object(api, '_key', return_value='fixture'), \
                                patch.object(home, 'may_fail_over', return_value=True), \
                                patch.dict(os.environ, {'OFFBOX_RESUME_CONFIRM_SECONDS': '0'}), \
                                patch.object(api, 'HOME_START_TIMEOUT_S', .15):
                            start = time.monotonic()
                            with self.assertRaises(api.NetworkError) as caught:
                                if operation == 'status':
                                    api.readiness_get('cold')
                                else:
                                    self.box('cold', 'stopped')
                                    try:
                                        lease._resume_confirmed(self.con, 'cold', 600, None)
                                    except lease.ResumeUnresolved as error:
                                        self.assertIsNotNone(self.con.execute(
                                            "SELECT 1 FROM kv WHERE k='resume_unanswered:cold'").fetchone())
                                        self.assertEqual(error.code, common.EXIT_INFRA)
                                        self.assertFalse(allocation._HELD.get())
                                        self.assertEqual(self.con.execute(
                                            "SELECT outcome FROM start_requests WHERE operation='resume' ORDER BY id DESC LIMIT 1").fetchone()[0],
                                            'uncertain')
                                        raise error.__cause__
                            self.assertTrue(server.received.is_set())
                            self.assertFalse(caught.exception.started)
                            self.assertTrue(caught.exception.outage)
                            self.assertLess(time.monotonic() - start, .6)
                    finally:
                        watchdog.cancel()
                        server.release.set()
                        server.shutdown()
                        server.server_close()
                        thread.join(1)
                        self.con.execute("DELETE FROM leases WHERE box_id='cold'")
                        self.con.execute("DELETE FROM kv WHERE k LIKE 'resume_%:cold'")
                        self.con.commit()
