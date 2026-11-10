"""Offline coverage for machine-capacity refusals and unanswered resumes.

Input matrix: top-level/nested 503 out_of_capacity; 409 resume_failed/deploy_failed
with case-insensitive 'at capacity'; unrelated 409, expired data and disk errors
retain their old handling. Resume no-answer forms: network, 502/504, 520/524;
confirmation forms: stopped, starting/live, missing, failed, late or gapped reads.
Caller matrix: next invocation, another source/candidate, refresh, active run,
retained create key; outage matrix: capacity, API down, mixed, 429, busy, started.
"""
import contextlib
from http.client import HTTPResponse
import io
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from offbox_lib import allocation, api, capacity, cli, common, fallback, lease, outage, pool, reap, runs  # noqa: E402
from test_capacity import Isolated  # noqa: E402
from test_exit_and_queue import FakeClock  # noqa: E402


def http(status, code, message):
    body = json.dumps({"code": code, "message": message}).encode()
    return urllib.error.HTTPError("https://boat.dev", status, "refused", {}, io.BytesIO(body))


class ApiTests(Isolated):
    def test_uncertain_create_survives_local_reservation_refusal(self):
        keys = []
        def lose(req, **kwargs):
            keys.append(req.get_header('Idempotency-key'))
            raise TimeoutError('lost')
        with patch.dict(os.environ, {'OFFBOX_STARTS_PER_MINUTE':'1'}), \
                patch.object(api, '_key', return_value='fake'), patch.object(api.time, 'sleep'), \
                patch.object(api.urllib.request, 'urlopen', side_effect=lose):
            with self.assertRaises(allocation.Unresolved):
                api.create('large', 1200, 'n', 'original')
            self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'create_unanswered:%'").fetchone()[0], 1)
            self.con.execute('UPDATE start_requests SET ts=0')
            self.con.commit()
            with self.assertRaises(allocation.Unresolved):
                api.create('large', 1200, 'n', 'replacement')
        self.assertEqual(keys, ['original', 'original'])

    def test_socket_deadline_bounds_success_and_wrapped_http_error_bodies(self):
        for status in (200, 503):
            with self.subTest(status=status):
                reader, writer = socket.socketpair()
                self.addCleanup(reader.close)
                self.addCleanup(writer.close)
                writer.sendall(f'HTTP/1.1 {status} Test\r\nContent-Length: 100\r\n\r\nx'.encode())
                response = HTTPResponse(reader)
                response.begin()
                self.addCleanup(response.close)
                wrapped = urllib.error.HTTPError('https://boat.dev', status, 'slow', {}, response) \
                    if status >= 400 else response
                rescue = threading.Timer(0.6, writer.close)
                rescue.start()
                started = time.monotonic()
                try:
                    with self.assertRaises(TimeoutError):
                        api._read_response(wrapped, time.time() + 0.1)
                    self.assertLess(time.monotonic() - started, 0.4)
                finally:
                    rescue.cancel()
                    rescue.join()

    def test_http_error_body_is_checked_against_absolute_deadline(self):
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        class SlowBody(io.BytesIO):
            def read(self, *args):
                clock.t += 5
                return super().read(*args)
        err = urllib.error.HTTPError('https://boat.dev', 503, 'slow', {}, SlowBody(b'{}'))
        with patch.object(api, 'time', clock.time), patch.object(api, '_key', return_value='fake'), \
                patch.object(api.urllib.request, 'urlopen', side_effect=err):
            with self.assertRaises(api.NetworkError):
                api.call('GET', '/limits', retries=0, deadline=1001)

    def test_expired_allocation_budget_does_not_affect_command_lifecycle(self):
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        with patch.object(outage, 'time', clock.time), patch.object(api, 'time', clock.time), \
                patch.object(api, '_key', return_value='fake'), \
                patch.object(api.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"sandbox":{"id":"box"}}')):
            with outage.allocation_budget(2):
                clock.t += 10
                self.assertEqual(api.get('box')['id'], 'box')

    def test_machine_capacity_start_refusals_are_not_retried_immediately(self):
        cases = [(503, "out_of_capacity", "No machines", "create"),
                 (409, "deploy_failed", "Server IS currently AT CAPACITY", "create"),
                 (409, "resume_failed", "Server is currently at capacity", "resume"),
                 (503, "out_of_capacity", "No machines", "fork")]
        for status, code, message, operation in cases:
            with self.subTest(status=status, code=code, operation=operation), \
                    patch.object(api, "_key", return_value="fake"), \
                    patch.object(api.urllib.request, "urlopen", side_effect=lambda *a, **k: (_ for _ in ()).throw(
                        http(status, code, message))) as send, patch.object(api.time, "sleep") as sleep:
                start = {"create": lambda: api.create("large", 1200, "n", "idem"),
                         "resume": lambda: api.resume("bx", 1200),
                         "fork": lambda: api.fork("bx", 1200, "idem")}[operation]
                with self.assertRaises(api.BoatAtCapacity):
                    start()
                self.assertEqual(send.call_count, 1)
                sleep.assert_not_called()

    def test_ordinary_409_not_classified_as_machine_capacity(self):
        for code, message in [("resume_failed", "disk needs 40 GiB"),
                              ("snapshot_data_expired", "at capacity"),
                              ("other", "Server is at capacity")]:
            with self.subTest(code=code), patch.object(api, "_key", return_value="fake"), \
                    patch.object(api.urllib.request, "urlopen", side_effect=http(409, code, message)):
                with self.assertRaises(api.ApiError) as cm:
                    api.resume("bx", 1200)
                self.assertEqual(cm.exception.api_code, code)

    def test_nested_capacity_error_is_single_send_even_if_retryable(self):
        body = {"error": {"code": "deploy_failed", "message": "At capacity", "details": {"retryable": True}}}
        def refused(*args, **kwargs):
            raise urllib.error.HTTPError("https://boat.dev", 409, "refused", {},
                                         io.BytesIO(json.dumps(body).encode()))
        with patch.object(api, "_key", return_value="fake"), \
                patch.object(api.urllib.request, "urlopen", side_effect=refused) as send, \
                patch.object(api.time, "sleep") as sleep:
            with self.assertRaises(api.BoatAtCapacity):
                api.create("large", 1200, "n", "idem")
        self.assertEqual(send.call_count, 1)
        sleep.assert_not_called()

    def test_uncertain_create_then_capacity_does_not_become_retryable_outage(self):
        responses = iter([TimeoutError("read timed out"), http(503, "out_of_capacity", "No machines")])
        def send(*a, **kw):
            raise next(responses)
        with patch.object(api, "_key", return_value="fake"), \
                patch.object(api.urllib.request, "urlopen", side_effect=send), patch.object(api.time, "sleep"):
            with self.assertRaises(common.OffboxError) as cm:
                api.create("large", 1200, "n", "idem")
        self.assertNotIsInstance(cm.exception, api.BoatAtCapacity)
        self.assertFalse(cm.exception.outage)
        self.assertIn("previous create/fork was unanswered", str(cm.exception))

    def test_uncertain_create_then_noncapacity_refusal_never_switches_to_new_start(self):
        for status, code, message in [(409, "snapshot_data_expired", "gone"),
                                      (500, "internal", "server failed")]:
            responses = iter([TimeoutError("read timed out"), http(status, code, message)])
            def send(*a, **kw):
                raise next(responses)
            with self.subTest(code=code), patch.object(api, "_key", return_value="fake"), \
                    patch.object(api.urllib.request, "urlopen", side_effect=send), patch.object(api.time, "sleep"):
                with self.assertRaises(common.OffboxError) as cm:
                    api.fork("bx", 1200, "idem")
            self.assertNotIsInstance(cm.exception, api.ApiError)
            self.assertFalse(cm.exception.outage)

    def test_uncertain_create_is_retained_across_callers(self):
        keys = []
        def lose(req, **kw):
            keys.append(req.get_header('Idempotency-key'))
            raise TimeoutError('lost')
        with patch.object(api, "_key", return_value="fake"), \
                patch.object(api.urllib.request, "urlopen", side_effect=lose), \
                patch.object(api.time, "sleep"):
            with self.assertRaises(allocation.Unresolved):
                api.create("large", 1200, "n", "first")
            with self.assertRaises(allocation.Unresolved):
                api.create("large", 1200, "n", "second")
        self.assertEqual(set(keys), {'first'})

    def test_retained_create_can_recover_with_original_key(self):
        sent = []
        def lose(req, **kw):
            sent.append(req.get_header('Idempotency-key'))
            raise TimeoutError('lost')
        with patch.object(api, '_key', return_value='fake'), \
                patch.object(api.urllib.request, 'urlopen', side_effect=lose), patch.object(api.time, 'sleep'):
            with self.assertRaises(allocation.Unresolved):
                api.create('large', 1200, 'original', 'first')
        class Response(io.BytesIO):
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.close()
        def recovered(req, **kw):
            sent.append(req.get_header('Idempotency-key'))
            return Response(b'{"sandbox":{"id":"created"}}')
        with patch.object(api, '_key', return_value='fake'), \
                patch.object(api.urllib.request, 'urlopen', side_effect=recovered):
            got = api.create('large', 1200, 'new name', 'second')
        self.assertEqual(got['id'], 'created')
        self.assertEqual(set(sent), {'first'})
        self.assertEqual(self.con.execute("SELECT count(*) FROM kv WHERE k LIKE 'create_unanswered:%'").fetchone()[0], 0)


class ResumeTests(Isolated):
    def test_interrupted_provision_wait_keeps_marker_and_original_deadline(self):
        self.box('cold', 'stopped', member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        def get(box, **kwargs):
            return {'state':'provisioning' if kwargs else 'archived','type':'large'}
        with patch.object(api, 'get', side_effect=get), patch.object(api, 'resume', side_effect=api.NetworkError('lost')) as resume, \
                patch.object(lease, 'time', clock.time), patch.dict(os.environ, {'OFFBOX_RESUME_PROVISION_SECONDS':'4'}), \
                contextlib.redirect_stderr(io.StringIO()):
            with patch.object(lease, '_wait_unanswered_resume', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    lease._reuse(self.con, row, None)
            self.assertIsNotNone(self.con.execute("SELECT v FROM kv WHERE k='resume_unanswered:cold'").fetchone())
            with self.assertRaises(lease.ResumeProvisionStalled):
                lease._reuse(self.con, row, None)
        self.assertEqual(clock.t, 1004)
        resume.assert_called_once()

    def test_stalled_boxes_remain_listable_and_explicitly_releasable(self):
        from offbox_lib import misc
        self.box('cold', 'stopped', member=True)
        self.con.execute("UPDATE leases SET state='resume_stalled'")
        self.con.commit()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            misc.list_leases(self.me, True, True)
        self.assertEqual(json.loads(out.getvalue())[0]['box_id'], 'cold')
        with patch.object(misc, '_release_one') as release:
            misc.release(self.me, 'cold', False, False)
        release.assert_called_once()
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        with patch.object(lease, 'stop_box', return_value=True) as stop, contextlib.redirect_stdout(io.StringIO()) as text:
            misc._release_one(self.con, row, False)
        stop.assert_called_once_with(self.con, 'cold', 'release')
        self.assertIn('remains set aside', text.getvalue())

    def test_reaper_checks_pending_again_under_action_lock(self):
        self.box('cold', 'stopped', member=True)
        self.con.execute("UPDATE leases SET last_used_at=0,created_at=1")
        self.con.commit()
        real_lock = reap.file_lock
        @contextlib.contextmanager
        def interleave(name, **kwargs):
            with real_lock(name, **kwargs):
                self.con.execute("INSERT OR REPLACE INTO kv VALUES ('resume_unanswered:cold','large',0)")
                self.con.commit()
                yield
        with patch.object(reap.api, 'list_boxes', return_value=[{'id':'cold','state':'archived'}]), \
                patch.object(reap, 'file_lock', side_effect=interleave), patch.object(lease, 'delete_box') as delete, \
                patch.object(reap.bases, 'upkeep'), patch.object(lease, 'release_if_confirmed', return_value=False):
            reap._reap(self.con, False, [])
        delete.assert_not_called()

    def test_other_start_cannot_send_while_resume_is_unanswered(self):
        self.box('cold', 'stopped', member=True)
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:cold','large',0)")
        self.con.commit()
        with allocation.scope('repo'), patch.object(api, '_call') as send:
            with self.assertRaises(allocation.Unresolved):
                api.create('large', 1200, 'name', 'key')
        send.assert_not_called()

    def test_stale_pending_lookup_does_not_claim_active_box(self):
        self.box('cold', 'stopped', member=True)
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:cold','large',0)")
        self.con.commit()
        self.busy('cold')
        with patch.object(lease, '_reuse') as reuse:
            with self.assertRaises(lease.ResumeUnresolved):
                pool.acquire(self.me)
        reuse.assert_not_called()

    def test_other_gateway_timeouts_are_confirmed(self):
        for status in (502, 504):
            self.box(f"cold{status}", "stopped", member=True)
            row = dict(self.con.execute("SELECT * FROM leases WHERE box_id=?", (f"cold{status}",)).fetchone())
            with patch.object(api, "get", side_effect=[{"state": "archived", "type": "large"},
                                                       {"state": "running", "type": "large"}]), \
                    patch.object(api, "resume", side_effect=api.ApiError(status, f"http_{status}", "")) as resume, \
                    patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}), \
                    contextlib.redirect_stderr(io.StringIO()):
                got = lease._reuse(self.con, row, None)
            self.assertEqual(got["box_id"], f"cold{status}")
            resume.assert_called_once()

    def test_failed_recovered_size_check_still_records_actual_size(self):
        self.box("cold", "running", member=True, size="xlarge")
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:cold','large',0)")
        self.con.commit()
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        with patch.object(api, "get", return_value={"state": "running", "type": "large"}), \
                patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}):
            with self.assertRaises(lease.ResumeUnresolved):
                lease._reuse(self.con, row, "xlarge")
        got = self.con.execute("SELECT state,size FROM leases WHERE box_id='cold'").fetchone()
        self.assertEqual(tuple(got), ("running", "large"))

    def test_slow_second_stopped_read_does_not_authorize_resend(self):
        self.box("cold", "stopped", member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        reads = [0]
        def get(*args, **kw):
            if kw:
                reads[0] += 1
                if reads[0] == 2:
                    clock.t += 7
            return {"state": "archived", "type": "large"}
        with patch.dict(os.environ, {"OFFBOX_RESUME_CONFIRM_SECONDS": "4"}), \
                patch.object(lease, "time", clock.time), patch.object(api, "get", side_effect=get), \
                patch.object(api, "resume", side_effect=api.NetworkError("timeout")) as resume, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(lease.ResumeUnresolved):
                lease._reuse(self.con, row, None)
        resume.assert_called_once()

    def test_unanswered_resume_is_confirmed_on_same_pool_box(self):
        self.box("cold", "stopped", member=True)
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        states = [{"state": "archived", "type": "large"},
                  {"state": "archived", "type": "large"},
                  {"state": "running", "type": "large"}]
        with patch.object(api, "get", side_effect=states), \
                patch.object(api, "resume", side_effect=api.NetworkError("timeout")) as resume, \
                patch.object(lease, "time", clock.time), \
                patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}), \
                patch.object(lease, "acquire_private") as create, \
                contextlib.redirect_stderr(io.StringIO()):
            got = pool.acquire(self.me)
            pool.release_guard(got)
        self.assertEqual(got["box_id"], "cold")
        resume.assert_called_once()
        create.assert_not_called()
        self.assertIn("resume_unanswered cold", common.LOG_PATH.read_text())

    def test_still_stopped_retries_resume_only_once_after_confirmation(self):
        self.box("cold", "stopped", member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        with patch.dict(os.environ, {"OFFBOX_RESUME_CONFIRM_SECONDS": "4"}), \
                patch.object(api, "get", return_value={"state": "archived", "type": "large"}), \
                patch.object(api, "resume", side_effect=[api.NetworkError("timeout"), {}]) as resume, \
                patch.object(lease, "time", clock.time), \
                patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}), \
                contextlib.redirect_stderr(io.StringIO()):
            got = lease._reuse(self.con, row, None)
        self.assertEqual(resume.call_count, 2)
        self.assertEqual(got["state"], "running")
        self.assertGreaterEqual(clock.t, 1003.9)

    def test_second_unanswered_resume_gets_checked_before_giving_up(self):
        self.box("cold", "stopped", member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        stopped = {"state": "archived", "type": "large"}
        with patch.dict(os.environ, {"OFFBOX_RESUME_CONFIRM_SECONDS": "4"}), \
                patch.object(api, "get", return_value=stopped) as get, \
                patch.object(api, "resume", side_effect=api.NetworkError("timeout")) as resume, \
                patch.object(lease, "time", clock.time), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(lease.ResumeUnresolved):
                lease._reuse(self.con, row, None)
        self.assertEqual(resume.call_count, 2)
        self.assertAlmostEqual(clock.t, 1007.9)
        self.assertGreaterEqual(get.call_count, 7)

    def test_unreadable_box_after_unanswered_resume_never_creates(self):
        self.box("cold", "stopped", member=True)
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        def get(box, **kw):
            if not kw:
                return {"state": "archived", "type": "large"}
            raise api.NetworkError("unavailable")
        with patch.dict(os.environ, {"OFFBOX_RESUME_CONFIRM_SECONDS": "4"}), \
                patch.object(api, "get", side_effect=get), patch.object(lease, "time", clock.time), \
                patch.object(api, "resume", side_effect=api.NetworkError("timeout")) as resume, \
                patch.object(lease, "acquire_private") as create, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(lease.ResumeUnresolved):
                pool.acquire(self.me)
        self.assertAlmostEqual(clock.t, 1003.95)
        resume.assert_called_once()
        create.assert_not_called()

    def test_real_network_exception_from_resume_reaches_confirmation(self):
        self.box("cold", "stopped", member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        states = [{"state": "archived", "type": "large"}, {"state": "provisioning", "type": "large"},
                  {"state": "running", "type": "large"}]
        with patch.object(api, "_key", return_value="fake"), \
                patch.object(api.urllib.request, "urlopen", side_effect=TimeoutError("read timed out")) as send, \
                patch.object(api, "get", side_effect=states), patch.object(lease, "time", clock.time), \
                patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}), \
                contextlib.redirect_stderr(io.StringIO()):
            got = lease._reuse(self.con, row, None)
        self.assertEqual(got["box_id"], "cold")
        self.assertEqual(send.call_count, 1)
        self.assertEqual(self.con.execute("SELECT outcome FROM start_requests").fetchone()[0], "settled")

    def test_cloudflare_ambiguous_responses_are_checked_like_network_timeout(self):
        for status in (520, 524):
            with self.subTest(status=status):
                self.box(f"cold{status}", "stopped", member=True)
                row = dict(self.con.execute("SELECT * FROM leases WHERE box_id=?", (f"cold{status}",)).fetchone())
                states = [{"state": "archived", "type": "large"}, {"state": "running", "type": "large"}]
                with patch.object(api, "get", side_effect=states), \
                        patch.object(api, "resume", side_effect=api.ApiError(status, f"http_{status}", "")) as resume, \
                        patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}), \
                        contextlib.redirect_stderr(io.StringIO()):
                    got = lease._reuse(self.con, row, None)
                self.assertEqual(got["box_id"], f"cold{status}")
                self.assertEqual(resume.call_count, 1)

    def test_unresolved_resume_survives_new_caller(self):
        self.box("cold", "stopped", member=True)
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        calls = []
        def get(box, **kw):
            if not kw:
                return {"state": "archived", "type": "large"}
            raise api.NetworkError("down")
        with patch.dict(os.environ, {"OFFBOX_RESUME_CONFIRM_SECONDS": "4"}), \
                patch.object(lease, "time", clock.time), patch.object(api, "get", side_effect=get), \
                patch.object(api, "resume", side_effect=lambda *a: (calls.append(clock.t),
                    (_ for _ in ()).throw(api.NetworkError("timeout")))[1]), \
                patch.object(lease, "acquire_private") as create, contextlib.redirect_stderr(io.StringIO()):
            for _ in range(2):
                with self.assertRaises(lease.ResumeUnresolved):
                    pool.acquire(self.me)
        self.assertEqual(len(calls), 1)
        create.assert_not_called()

    def test_unobserved_confirmation_cannot_authorize_a_second_resume(self):
        self.box("cold", "stopped", member=True)
        row = dict(self.con.execute("SELECT * FROM leases WHERE box_id='cold'").fetchone())
        clock = FakeClock()
        clock.time.time = lambda: clock.t
        stopped = {"state": "archived", "type": "large"}
        reads = [stopped, api.NetworkError("down"), api.NetworkError("down"), stopped]
        with patch.dict(os.environ, {"OFFBOX_RESUME_CONFIRM_SECONDS": "4"}), \
                patch.object(lease, "time", clock.time), patch.object(api, "get", side_effect=reads), \
                patch.object(api, "resume", side_effect=api.NetworkError("timeout")) as resume, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(lease.ResumeUnresolved):
                lease._reuse(self.con, row, None)
        resume.assert_called_once()

    def test_pending_box_reconciled_before_different_source_or_usable_box(self):
        self.box("a", "stopped", member=True, used=500)
        self.box("b", "stopped", member=True, used=400)
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:b','large',0)")
        self.con.commit()
        with patch.object(lease, "_reuse", side_effect=lease.ResumeUnresolved("pending")) as reuse, \
                patch.object(lease, "acquire_private") as create, contextlib.redirect_stderr(io.StringIO()):
            for fresh in (False, True):
                with self.assertRaises(lease.ResumeUnresolved):
                    pool.acquire(self.me, fresh=fresh)
        self.assertEqual([c.args[1]["box_id"] for c in reuse.call_args_list], ["b", "b"])
        create.assert_not_called()

    def test_reaper_refresh_skips_unanswered_resume(self):
        self.con.execute("INSERT INTO kv VALUES ('resume_unanswered:cold','large',0)")
        self.con.commit()
        with patch.object(api, "resume") as resume:
            with self.assertRaises(lease.ResumeUnresolved):
                lease.refresh_box(self.con, "cold")
        resume.assert_not_called()

    def test_missing_and_slow_confirmation_do_not_authorize_second_resume(self):
        for scenario in ("missing", "slow"):
            with self.subTest(scenario=scenario):
                self.con.execute("DELETE FROM kv WHERE k LIKE 'resume_unanswered:%'")
                self.con.commit()
                bid = "cold_" + scenario
                self.box(bid, "stopped", member=True)
                row = dict(self.con.execute("SELECT * FROM leases WHERE box_id=?", (bid,)).fetchone())
                clock = FakeClock()
                clock.time.time = lambda: clock.t
                count = [0]
                def get(box, **kwargs):
                    if not kwargs:
                        return {"state": "archived", "type": "large"}
                    count[0] += 1
                    if scenario == "missing" and count[0] == 1:
                        return None
                    if scenario == "slow":
                        clock.t += 4
                    return {"state": "archived", "type": "large"}
                with patch.dict(os.environ, {"OFFBOX_RESUME_CONFIRM_SECONDS": "4"}), \
                        patch.object(lease, "time", clock.time), patch.object(api, "get", side_effect=get), \
                        patch.object(api, "resume", side_effect=api.NetworkError("timeout")) as resume, \
                        contextlib.redirect_stderr(io.StringIO()):
                    if scenario == 'missing':
                        self.assertIsNone(lease._reuse(self.con, row, None))
                    else:
                        with self.assertRaises(lease.ResumeUnresolved):
                            lease._reuse(self.con, row, None)
                resume.assert_called_once()


class IntegratedCapacityTests(Isolated):
    def test_hung_unanswered_resume_caps_once_then_creates_before_sibling_resume(self):
        self.box('one', 'stopped', member=True, used=500)
        self.box('two', 'stopped', member=True, used=400)
        resumed = []
        def get(box, **kwargs):
            return {'state':'provisioning' if box in resumed else 'archived', 'type':'large'}
        def resume(box, *args):
            resumed.append(box)
            raise api.NetworkError('read operation timed out')
        with patch.dict(os.environ, {'OFFBOX_RESUME_PROVISION_SECONDS':'4'}), \
                patch.object(lease, 'time', self.clock.time), patch.object(api, 'get', side_effect=get), \
                patch.object(api, 'resume', side_effect=resume), patch.object(lease, '_bring_up') as up, \
                patch.object(lease, 'acquire_private', return_value={'box_id':'new','size':'large'}) as create, \
                patch.object(api, 'delete') as delete:
            rc, executed, err = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (0, ['new']))
        self.assertEqual(resumed, ['one'])
        self.assertEqual(self.clock.t, 1004)
        self.assertIn('stayed provisioning for 4s', err)
        self.assertFalse(create.call_args.args[4])
        self.assertEqual([r[0] for r in self.con.execute("SELECT state FROM leases ORDER BY box_id")],
                         ['resume_stalled','resume_stalled'])
        up.assert_not_called()
        delete.assert_not_called()

    def test_bare_502_resume_is_confirmed_and_used_without_create(self):
        self.box('cold', 'stopped', member=True)
        states = iter([{'state':'archived','type':'large'}, {'state':'provisioning','type':'large'},
                       {'state':'running','type':'large'}])
        with patch.object(api, '_key', return_value='fake'), \
                patch.object(api.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError(
                    'https://boat.dev', 502, 'Bad Gateway', {}, io.BytesIO(b''))) as send, \
                patch.object(api, 'get', side_effect=lambda *a, **kw: next(states)), \
                patch.object(lease, 'time', self.clock.time), \
                patch.object(lease, '_bring_up', return_value={'state':'running','type':'large'}), \
                patch.object(lease, 'acquire_private') as create:
            rc, executed, _ = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (0, ['cold']))
        self.assertEqual(send.call_count, 1)
        create.assert_not_called()
        self.assertEqual(self.con.execute("SELECT state FROM leases WHERE box_id='cold'").fetchone()[0], 'running')

    def test_supply_blocked_candidate_does_not_hide_shared_cooldown(self):
        self.box('regular', 'stopped', member=True, used=500)
        self.box('supply', 'stopped', member=True, used=400, size='default', source='template:generic')
        original = pool.acquire
        count = [0]
        def acquire(me):
            count[0] += 1
            if count[0] == 1:
                raise api.BoatAtCapacity()
            self.con.execute("INSERT OR REPLACE INTO kv VALUES ('boat_start_cooldown',?,?)",
                             (json.dumps({'until':self.clock.t + 300}), self.clock.t))
            self.con.commit()
            capacity.supply_out('default', 'supply', 'supply for size default is over')
            return original(me)
        with patch.object(capacity, 'now', lambda: self.clock.t), patch.object(pool, 'time', self.clock.time), \
                patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'600','OFFBOX_OUTAGE_WAIT_SECONDS':'90'}):
            rc, executed, err = self.run_cli(acquire)
        self.assertEqual((rc, executed), (90, []))
        self.assertEqual(self.clock.t, 1030)
        self.assertIn('start limit', err)

    def setUp(self):
        super().setUp()
        self.clock = FakeClock()
        self.clock.time.time = lambda: self.clock.t
        self.stack.enter_context(patch.object(cli, "time", self.clock.time))
        self.stack.enter_context(patch.object(outage, "time", self.clock.time))
        self.stack.enter_context(patch.object(outage, "now", lambda: self.clock.t))
        self.stack.enter_context(patch("offbox_lib.localfirst.decide", return_value="test"))
        self.stack.enter_context(patch.object(fallback, "note_infra_failure"))
        self.stack.enter_context(patch.object(lease, "cap_check"))

    def run_cli(self, acquire):
        a = cli.build_parser().parse_args(["run", "--remote", "--", "make", "test"])
        executed = []

        def remote(a, me):
            row = acquire(me)
            pool.release_guard(row)
            executed.append(row["box_id"])
            return 0
        err = io.StringIO()
        with patch.object(runs, "run_remote", side_effect=remote), contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        return rc, executed, err.getvalue()

    def test_create_capacity_twice_then_success(self):
        attempts = []

        def create(*a):
            attempts.append(self.clock.t)
            if len(attempts) < 3:
                raise api.BoatAtCapacity()
            return {"box_id": "new", "size": "large"}
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "90"}), \
                patch.object(lease, "acquire_private", side_effect=create):
            rc, executed, err = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (0, ["new"]))
        self.assertEqual(attempts, [1000, 1030, 1060])
        self.assertIn("boat is out of machine capacity", err)

    def test_pool_boxes_retry_before_create_and_not_marked_broken(self):
        self.box("one", "stopped", member=True, used=500)
        self.box("two", "stopped", member=True, used=400)
        calls = []

        def resume(box, *args):
            calls.append((self.clock.t, box))
            if self.clock.t < 1060:
                raise api.BoatAtCapacity()
            return {}
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "90"}), \
                patch.object(api, "get", return_value={"state": "archived", "type": "large"}), \
                patch.object(api, "resume", side_effect=resume), \
                patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}), \
                patch.object(lease, "acquire_private") as create:
            rc, executed, _ = self.run_cli(pool.acquire)
        self.assertEqual(rc, 0)
        self.assertEqual(executed, ["one"])
        self.assertEqual(calls, [(1000, "one"), (1000, "two"), (1030, "one"), (1030, "two"), (1060, "one")])
        create.assert_not_called()
        self.assertEqual(self.con.execute("SELECT state, note FROM leases WHERE box_id='two'").fetchone()[0], "stopped")

    def test_capacity_exhaustion_is_90_nothing_ran(self):
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "60"}), \
                patch.object(lease, "acquire_private", side_effect=api.BoatAtCapacity()):
            rc, executed, err = self.run_cli(pool.acquire)
        self.assertEqual(rc, 90)
        self.assertEqual(executed, [])
        self.assertIn("boat out of machine capacity; nothing ran. Retry in a few minutes.", err)
        self.assertLessEqual(self.clock.t, 1060)

    def test_all_stopped_boxes_are_tried_before_each_create(self):
        for n in range(3):
            self.box(f"box{n}", "stopped", member=True, used=500-n)
        calls = []
        def resume(box, *args):
            calls.append((self.clock.t, box))
            if self.clock.t < 1060:
                raise api.BoatAtCapacity()
            return {}
        def create(*args):
            calls.append((self.clock.t, "create"))
            raise api.BoatAtCapacity()
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "90", "OFFBOX_POOL_SIZE": "4"}), \
                patch.object(api, "get", return_value={"state": "archived", "type": "large"}), \
                patch.object(api, "resume", side_effect=resume), patch.object(lease, "acquire_private", side_effect=create), \
                patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}):
            rc, executed, _ = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (0, ["box0"]))
        self.assertEqual(calls, [(1000, "box0"), (1000, "box1"), (1000, "box2"), (1000, "create"),
                                 (1030, "box0"), (1030, "box1"), (1030, "box2"), (1030, "create"),
                                 (1060, "box0")])
        self.assertEqual(self.con.execute("SELECT count(*) FROM pool_pending").fetchone()[0], 0)

    def test_small_fallback_is_immediate_and_remote_flags_wait(self):
        for flags, should_wait in [([], False), (["--remote"], True), (["--no-fallback"], True), (["--bg"], True)]:
            self.clock.t = 1000
            a = cli.build_parser().parse_args(["run"] + flags + ["--", "echo", "ok"])
            with self.subTest(flags=flags), patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "30"}), \
                    patch.object(runs, "run_remote", side_effect=api.BoatAtCapacity()) as remote, \
                    patch.object(fallback, "run_local", return_value=0) as local, \
                    contextlib.redirect_stderr(io.StringIO()):
                rc = cli.cmd_run(a, self.me)
            self.assertEqual(rc, 90 if should_wait else 0)
            self.assertEqual(self.clock.t, 1030 if should_wait else 1000)
            self.assertEqual(remote.call_count, 1)
            self.assertEqual(local.call_count, 0 if should_wait else 1)

    def test_capacity_after_command_started_never_waits_or_falls_back(self):
        err = api.BoatAtCapacity()
        err.started = True
        a = cli.build_parser().parse_args(["run", "--", "echo", "ok"])
        with patch.object(runs, "run_remote", side_effect=err), \
                patch.object(fallback, "run_local") as local, contextlib.redirect_stderr(io.StringIO()):
            rc = cli.cmd_run(a, self.me)
        self.assertEqual(rc, 90)
        self.assertEqual(self.clock.t, 1000)
        local.assert_not_called()

    def test_pool_queue_cannot_extend_the_capacity_outage_window(self):
        self.box("cold", "stopped", member=True)
        self.box("busy", "running", member=True)
        self.busy("busy")
        def remote(a, me):
            if self.clock.t == 1000:
                raise api.BoatAtCapacity()
            self.busy("cold")
            return pool.acquire(me)
        a = cli.build_parser().parse_args(["run", "--remote", "--", "make", "test"])
        err = io.StringIO()
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "40", "OFFBOX_POOL_WAIT_SECONDS": "600"}), \
                patch.object(pool, "time", self.clock.time), patch.object(runs, "run_remote", side_effect=remote), \
                contextlib.redirect_stderr(err):
            rc = cli.cmd_run(a, self.me)
        self.assertEqual(rc, 90)
        self.assertEqual(self.clock.t, 1040)
        self.assertIn("boat out of machine capacity; nothing ran", err.getvalue())

    def test_resume_read_timeout_during_capacity_round_is_confirmed_on_same_box(self):
        self.box("cold", "stopped", member=True)
        calls = []
        states = iter([{"state": "archived", "type": "large"},
                       {"state": "archived", "type": "large"},
                       {"state": "archived", "type": "large"},
                       {"state": "running", "type": "large"}])
        def resume(box, *args):
            calls.append(self.clock.t)
            if len(calls) == 1:
                raise api.BoatAtCapacity()
            raise api.NetworkError("read timeout")
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "90", "OFFBOX_POOL_SIZE": "1"}), \
                patch.object(api, "get", side_effect=lambda *a, **kw: next(states)), \
                patch.object(api, "resume", side_effect=resume), patch.object(lease, "time", self.clock.time), \
                patch.object(lease, "_bring_up", return_value={"state": "running", "type": "large"}), \
                patch.object(lease, "acquire_private") as create:
            rc, executed, err = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (0, ["cold"]), err)
        self.assertEqual(calls, [1000, 1030])
        create.assert_not_called()

    def test_slow_refusal_does_not_start_next_box_past_window(self):
        self.box("one", "stopped", member=True, used=500)
        self.box("two", "stopped", member=True, used=400)
        calls = []
        def reuse(con, row, size, **kw):
            calls.append((self.clock.t, row["box_id"]))
            if self.clock.t >= 1030:
                self.clock.t += 10
            raise api.BoatAtCapacity()
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "35", "OFFBOX_POOL_SIZE": "2"}), \
                patch.object(pool, "time", self.clock.time), patch.object(lease, "_reuse", side_effect=reuse):
            rc, executed, _ = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (90, []))
        self.assertEqual(calls, [(1000, "one"), (1000, "two"), (1030, "one")])

    def test_create_capacity_makes_next_round_try_all_stopped(self):
        for n in range(3):
            self.box(f"box{n}", "stopped", member=True, used=500-n)
        calls = []
        def reuse(con, row, size, **kw):
            calls.append((self.clock.t, row["box_id"]))
            if row["box_id"] != "box2":
                raise api.ApiError(409, "resume_failed", "unrelated")
            return dict(row)
        def create(*args):
            calls.append((self.clock.t, "create"))
            raise api.BoatAtCapacity()
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "90", "OFFBOX_POOL_SIZE": "4"}), \
                patch.object(lease, "_reuse", side_effect=reuse), patch.object(lease, "acquire_private", side_effect=create):
            rc, executed, _ = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (0, ["box2"]))
        self.assertEqual(calls, [(1000, "box0"), (1000, "box1"), (1000, "box2")])

    def test_start_limit_after_capacity_is_immediate(self):
        self.box("one", "stopped", member=True, used=500)
        self.box("two", "stopped", member=True, used=400)
        def reuse(con, row, size, **kw):
            if row["box_id"] == "one":
                raise api.BoatAtCapacity()
            raise capacity.CapacityError("boat start limit reached (429)")
        from offbox_lib import capacity
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "90", "OFFBOX_POOL_SIZE": "2"}), \
                patch.object(lease, "_reuse", side_effect=reuse):
            rc, executed, err = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (90, []))
        self.assertEqual(self.clock.t, 1000)
        self.assertIn("start limit", err)

    def test_create_precheck_cooldown_after_resume_capacity_is_immediate(self):
        self.box('cold', 'stopped', member=True)
        checks = [0]
        def check(*args):
            checks[0] += 1
            if checks[0] >= 2:
                raise capacity.CapacityError('shared 429 cooldown')
        with patch.object(capacity, 'check', side_effect=check), \
                patch.object(lease, '_reuse', side_effect=api.BoatAtCapacity()), \
                patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'600'}), patch.object(pool, 'time', self.clock.time):
            rc, executed, err = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (90, []))
        self.assertEqual(self.clock.t, 1000)
        self.assertIn('shared 429 cooldown', err)

    def test_shared_cooldown_between_rounds_does_not_restart_pool_wait(self):
        self.box('cold', 'stopped', member=True)
        original_acquire = pool.acquire
        attempts = []
        def acquire(me):
            attempts.append(self.clock.t)
            if len(attempts) == 1:
                raise api.BoatAtCapacity()
            self.con.execute("INSERT OR REPLACE INTO kv VALUES ('boat_start_cooldown',?,?)",
                             (json.dumps({'until': self.clock.t + 300}), self.clock.t))
            self.con.commit()
            return original_acquire(me)
        with patch.object(capacity, 'now', lambda: self.clock.t), patch.object(pool, 'time', self.clock.time), \
                patch.dict(os.environ, {'OFFBOX_POOL_WAIT_SECONDS':'600','OFFBOX_OUTAGE_WAIT_SECONDS':'90'}):
            rc, executed, err = self.run_cli(acquire)
        self.assertEqual((rc, executed), (90, []))
        self.assertEqual(self.clock.t, 1030)
        self.assertIn('start limit', err)

    def test_creator_start_limit_after_capacity_does_not_wait_again(self):
        from offbox_lib import capacity
        calls = []
        def create(*args):
            calls.append(self.clock.t)
            if len(calls) == 1:
                raise api.BoatAtCapacity()
            raise capacity.CapacityError("boat start limit reached (429)")
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "60"}), \
                patch.object(lease, "acquire_private", side_effect=create):
            rc, executed, err = self.run_cli(pool.acquire)
        self.assertEqual((rc, executed), (90, []))
        self.assertEqual(calls, [1000, 1030])
        self.assertEqual(self.clock.t, 1030)
        self.assertIn("start limit", err)

    def test_mixed_outage_keeps_capacity_retry_floor(self):
        calls = []
        def remote(a, me):
            calls.append(self.clock.t)
            if len(calls) == 1:
                raise api.BoatAtCapacity()
            if len(calls) == 2:
                raise api.NetworkError("down")
            return 0
        a = cli.build_parser().parse_args(["run", "--remote", "--", "make", "test"])
        def probe(reason, budget):
            self.clock.sleep(15)
            return True
        with patch.dict(os.environ, {"OFFBOX_OUTAGE_WAIT_SECONDS": "90"}), \
                patch.object(outage, "wait_until_up", side_effect=probe), \
                patch.object(runs, "run_remote", side_effect=remote), contextlib.redirect_stderr(io.StringIO()):
            rc = cli.cmd_run(a, self.me)
        self.assertEqual(rc, 0)
        self.assertEqual(calls, [1000, 1030, 1060])


if __name__ == "__main__":
    unittest.main()
