"""Type-30 protocol and unlock safety against loopback fixtures; never use Keychain or ioreg."""
import contextlib
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import plistlib
import socket
import struct
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "bin/vnc-hold"
loader = importlib.machinery.SourceFileLoader("vnc_hold_fixture", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
vnc = importlib.util.module_from_spec(spec)
loader.exec_module(vnc)
TEST_PASSWORD = b'Az09!@#$%^&*()_+{}|:"<>?~[];=,./`-'


class Clock:
    def __init__(self):
        self.value = 10000.0
        self.sleeps = []

    def time(self):
        return self.value

    monotonic = time

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.value += seconds


class RFB:
    def __init__(self, reject=None, rejection_suffix=None):
        self.rejection_suffix = rejection_suffix
        self.reject, self.events, self.updates = reject, [], []
        self.credentials = None
        self.shared = None
        self.error = None
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.listener.listen(1)
        self.listener.settimeout(10)
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.thread.join(10)
        self.listener.close()
        if self.thread.is_alive():
            raise AssertionError("fake server did not finish")
        if self.error:
            raise self.error

    def connect(self, secret):
        return vnc.connect(secret, port=self.port)

    def serve(self):
        try:
            with self.listener.accept()[0] as s:
                s.settimeout(10)
                s.sendall(b"RFB 003.008\n")
                assert vnc.recvn(s, 12) == b"RFB 003.008\n"
                s.sendall(b"\x02\x01\x1e")
                assert vnc.recvn(s, 1) == b"\x1e"
                # Independent server side: fixed DH exponent, then decrypt the client's block.
                p, gen, private, size = 2**127 - 1, 3, 7123, 16
                s.sendall(struct.pack(">HH", gen, size) + p.to_bytes(size, "big")
                          + pow(gen, private, p).to_bytes(size, "big"))
                encrypted = vnc.recvn(s, 128)
                public = int.from_bytes(vnc.recvn(s, size), "big")
                key = hashlib.md5(pow(public, private, p).to_bytes(size, "big")).digest()
                clear = subprocess.run(["/usr/bin/openssl", "enc", "-d", "-aes-128-ecb", "-nopad",
                                        "-K", key.hex()], input=encrypted, capture_output=True,
                                       check=True, timeout=5).stdout
                self.credentials = (clear[:64].split(b"\0")[0], clear[64:].split(b"\0")[0])
                if self.reject is not None or self.rejection_suffix is not None:
                    reason = (self.reject or "").encode()
                    suffix = (self.rejection_suffix if self.rejection_suffix is not None
                              else struct.pack(">I", len(reason)) + reason)
                    s.sendall(struct.pack(">I", 1) + suffix)
                    return
                s.sendall(struct.pack(">I", 0))
                self.shared = vnc.recvn(s, 1)
                s.sendall(struct.pack(">HH", 100, 80) + bytes(16) + struct.pack(">I", 4) + b"test")
                while True:
                    kind = s.recv(1)
                    if not kind:
                        break
                    if kind == b"\x04":
                        down, sym = struct.unpack(">BxxI", vnc.recvn(s, 7))
                        self.events.append((sym, bool(down)))
                    elif kind == b"\x03":
                        self.updates.append(vnc.recvn(s, 9))
                    else:
                        raise AssertionError("unexpected RFB message")
        except BaseException as error:
            self.error = error


class HoldTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.clock = Clock()
        self.state = vnc.State(self.directory, self.clock)
        self.log = io.StringIO()
        self.logger = logging.Logger("fixture")
        self.logger.addHandler(logging.StreamHandler(self.log))
        self.reads = 0
        self.current_password = TEST_PASSWORD

    def password(self):
        self.reads += 1
        return bytearray(self.current_password)

    def hold(self, lock=lambda: True, **kw):
        return vnc.Hold(self.state, password_source=self.password, lock_reader=lock,
                        clock=self.clock, log=self.logger, **kw)

    def sequence(self, secret=TEST_PASSWORD):
        return [(sym, down) for sym in [0xffe1, *secret, 0xff0d] for down in (True, False)]

    def test_handshake_decrypts_credentials_and_is_shared(self):
        with RFB() as server:
            s, width, height = server.connect(bytearray(TEST_PASSWORD))
            s.close()
        self.assertEqual((width, height), (100, 80))
        self.assertEqual(server.credentials, (b"ardud", TEST_PASSWORD))
        self.assertEqual(server.shared, b"\x01")
        self.assertEqual(server.events, [])

    def test_failed_attempt_pauses_past_timer_and_restart_then_rotation_allows(self):
        hold = self.hold()
        hold.refresh_password()
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            hold.maybe_unlock(s)
            self.assertEqual(self.clock.sleeps.count(1), 9)  # double-read delay plus eight readbacks
            self.assertEqual(self.reads, 1)  # typing uses the session's cached password
            self.assertEqual(self.state.data["last_unlock_result"], "still_locked")
            self.assertEqual(self.state.data["attempt_failed"]["password_sha256"],
                             hashlib.sha256(TEST_PASSWORD).hexdigest())
            self.clock.sleep(121)
            hold.maybe_unlock(s)
            self.assertEqual(self.state.data["last_unlock_result"], "skipped_paused")
            self.clock.sleep(3600)
            self.state = vnc.State(self.directory, self.clock)
            hold = self.hold()
            hold.refresh_password()
            hold.maybe_unlock(s)
            self.assertTrue(self.state.data["typing_paused"])
            s.close()
        self.assertEqual(server.events, self.sequence())
        self.current_password = b"Changed99!"
        self.clock.sleep(121)
        with RFB() as server:
            s, _, _ = server.connect(bytearray(self.current_password))
            hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, self.sequence(self.current_password))
        self.assertIn("UNLOCK_FAILED, typing paused until the Keychain password changes", self.log.getvalue())
        self.assertNotIn(TEST_PASSWORD.decode(), self.log.getvalue())
        self.assertNotIn(TEST_PASSWORD.decode(), self.state.path.read_text())

    def test_unlock_success_and_eight_second_readback(self):
        values = iter([True, True, True, False])
        hold = self.hold(lambda: next(values))
        hold.refresh_password()
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, self.sequence())
        self.assertEqual(self.state.data["last_unlock_result"], "unlocked")
        self.assertFalse(self.state.data["typing_paused"])
        self.assertIsNone(self.state.data["attempt_failed"])

    def test_stale_lock_read_sends_no_keys(self):
        values = iter([True, False])
        hold = self.hold(lambda: next(values))
        hold.refresh_password()
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, [])
        self.assertEqual(self.clock.sleeps, [1])

    def test_non_ascii_and_controls_send_no_keys(self):
        for secret in ("Azé!".encode(), b"Az\t!", b"Az\x7f!"):
            with self.subTest(secret=secret):
                self.state = vnc.State(self.directory / str(len(secret)), self.clock)
                self.current_password = secret
                hold = self.hold()
                hold.refresh_password()
                with RFB() as server:
                    s, _, _ = server.connect(hold.secret)
                    hold.maybe_unlock(s)
                    s.close()
                self.assertEqual(server.events, [])
                self.assertEqual(self.state.data["last_unlock_result"], "non_ascii_password")
                self.assertTrue(self.state.data["typing_paused"])

    def test_auth_backoff_capped_persisted_and_reason_redacted(self):
        delays = []
        for _ in range(6):
            with RFB(reject="denied " + TEST_PASSWORD.decode()) as server:
                hold = self.hold(connector=server.connect)
                delays.append(hold.run_connection())
            self.assertEqual(server.events, [])
            self.state = vnc.State(self.directory, self.clock)
        self.assertEqual(delays, [15, 60, 300, 900, 900, 900])
        self.assertEqual(self.state.data["auth_failures_in_row"], 6)
        self.assertIn("auth_failed: denied [redacted]", self.state.data["last_error"])
        self.assertFalse(self.state.data["connected"])
        self.assertNotIn(TEST_PASSWORD.decode(), self.log.getvalue())
        self.assertNotIn(TEST_PASSWORD.decode(), self.state.path.read_text())

    def test_rejection_reason_eof_matrix_preserves_auth_backoff(self):
        cases = {
            "missing_length": b"",
            "length_1_byte": b"\x00",
            "length_2_bytes": b"\x00\x00",
            "length_3_bytes": b"\x00\x00\x00",
            "missing_body": struct.pack(">I", 6),
            "truncated_body": struct.pack(">I", 6) + b"den",
            "oversized_truncated_body": struct.pack(">I", 8192) + b"den",
        }
        for name, suffix in cases.items():
            with self.subTest(reason=name):
                self.state = vnc.State(self.directory / name, self.clock)
                delays = []
                for count in range(1, 6):
                    with RFB(rejection_suffix=suffix) as server:
                        hold = self.hold(connector=server.connect)
                        delays.append(hold.run_connection())
                    self.assertEqual(server.events, [])
                    self.assertIsNone(server.shared)
                    self.assertEqual(self.state.data["auth_failures_in_row"], count)
                    self.assertEqual(self.state.data["last_error"],
                                     "auth_failed: rejection reason unavailable")
                    self.assertFalse(self.state.data["connected"])
                    self.state = vnc.State(self.state.directory, self.clock)
                self.assertEqual(delays, [15, 60, 300, 900, 900])
                self.assertNotIn(TEST_PASSWORD.decode(), self.state.path.read_text())
        self.assertNotIn(TEST_PASSWORD.decode(), self.log.getvalue())

    def test_rejection_reason_network_error_matrix_preserves_auth_backoff(self):
        real_recvn = vnc.recvn
        # Server payload has been authenticated when SecurityResult (offset55) arrives.
        # Inject transport faults only after that result, at length/body read boundaries.
        for stage, boundary in (("length", 55), ("body", 59)):
            for error_type in (socket.timeout, ConnectionResetError):
                with self.subTest(stage=stage, error=error_type.__name__):
                    self.state = vnc.State(self.directory / (stage + error_type.__name__), self.clock)
                    delays = []
                    for _ in range(5):
                        received = 0
                        client_thread = threading.current_thread()
                        def interrupted_reason(s, n):
                            nonlocal received
                            if threading.current_thread() is not client_thread:
                                return real_recvn(s, n)
                            if received >= boundary:
                                raise error_type(TEST_PASSWORD.decode())
                            data = real_recvn(s, n)
                            received += len(data)
                            return data
                        with RFB(reject="denied") as server:
                            hold = self.hold(connector=server.connect)
                            with patch.object(vnc, "recvn", side_effect=interrupted_reason):
                                delays.append(hold.run_connection())
                        self.assertEqual(server.events, [])
                        self.assertEqual(self.state.data["last_error"],
                                         "auth_failed: rejection reason unavailable")
                    self.assertEqual(delays, [15, 60, 300, 900, 900])
                    self.assertEqual(self.state.data["auth_failures_in_row"], 5)
        self.assertNotIn(TEST_PASSWORD.decode(), self.log.getvalue())
        self.assertNotIn(TEST_PASSWORD.decode(), self.state.path.read_text())

    def test_empty_and_oversized_complete_reasons_remain_auth_failures(self):
        for name, suffix in (("empty", struct.pack(">I", 0)),
                             ("oversized", struct.pack(">I", 8192) + b"x" * 8192)):
            with self.subTest(reason=name):
                self.state = vnc.State(self.directory / name, self.clock)
                with RFB(rejection_suffix=suffix) as server:
                    hold = self.hold(connector=server.connect)
                    self.assertEqual(hold.run_connection(), 15)
                self.assertEqual(self.state.data["auth_failures_in_row"], 1)
                self.assertTrue(self.state.data["last_error"].startswith("auth_failed:"))
                self.assertEqual(server.events, [])

    def test_retry_heartbeats_preserve_auth_deadline_without_connections_or_password_reads(self):
        self.state.update(connected=False, auth_failures_in_row=4,
                          last_error="auth_failed: denied", last_keepalive_at=9990)
        hold = self.hold(connector=lambda secret: self.fail("connected during backoff"))
        with patch.object(vnc, "atomic_json", wraps=vnc.atomic_json) as write:
            hold.wait_retry(900)
            self.assertEqual(write.call_count, 15)
        self.assertEqual(self.clock.sleeps, [60] * 15)
        self.assertEqual(self.clock.value, 10900)
        self.assertEqual(self.reads, 0)
        self.assertEqual(self.state.data["last_keepalive_at"], 9990)
        self.assertEqual(self.state.data["auth_failures_in_row"], 4)
        self.assertFalse(self.state.data["connected"])
        self.clock.sleeps.clear()
        hold.wait_retry(15)
        self.assertEqual(self.clock.sleeps, [15])

    def test_connection_errors_keep_short_retry_without_secret_in_exception(self):
        def fail(secret):
            raise OSError(TEST_PASSWORD.decode())
        hold = self.hold(connector=fail)
        self.assertEqual(hold.run_connection(), 15)
        self.assertEqual(self.state.data["last_error"], "OSError")
        self.assertEqual(hold.secret, bytearray(len(TEST_PASSWORD)))
        self.assertNotIn(TEST_PASSWORD.decode(), self.log.getvalue())

    def test_keychain_failure_is_only_an_exit_code(self):
        hold = self.hold()
        hold.password_source = lambda: (_ for _ in ()).throw(vnc.KeychainError(36))
        self.assertEqual(hold.run_connection(), 15)
        self.assertEqual(self.state.data["last_error"], "keychain_read_failed exit=36")
        self.assertEqual(self.state.data["last_unlock_result"], "keychain_read_failed")

    def test_paused_keychain_failure_does_not_retry_cached_password(self):
        hold = self.hold()
        hold.refresh_password()
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            hold.maybe_unlock(s)
            self.clock.sleep(121)
            hold.password_source = lambda: (_ for _ in ()).throw(vnc.KeychainError(36))
            hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, self.sequence())
        self.assertTrue(self.state.data["typing_paused"])
        self.assertEqual(self.state.data["last_unlock_result"], "keychain_read_failed")

    def test_reset_request_consumed_once_and_allows_next_attempt(self):
        hold = self.hold()
        hold.refresh_password()
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            hold.maybe_unlock(s)
            with patch.dict(os.environ, VNC_HOLD_STATE_DIR=str(self.directory)), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(vnc.main(["reset-attempts"]), 0)
            self.clock.sleep(121)
            hold.maybe_unlock(s)
            self.clock.sleep(121)
            hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, self.sequence() * 2)
        self.assertTrue(self.state.data["typing_paused"])

    def test_reset_reads_corrected_keychain_instead_of_stale_cache(self):
        hold = self.hold()
        hold.refresh_password()
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            hold.maybe_unlock(s)
            self.current_password = b"Corrected123!"
            vnc.atomic_json(self.directory / "reset.json", {"token": "correction"})
            self.clock.sleep(121)
            hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, self.sequence() + self.sequence(self.current_password))

    def test_reset_keychain_failure_sends_no_keys_until_read_recovers(self):
        hold = self.hold()
        hold.refresh_password()
        vnc.atomic_json(self.directory / "reset.json", {"token": "reset"})
        hold.password_source = lambda: (_ for _ in ()).throw(vnc.KeychainError(36))
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            hold.maybe_unlock(s)
            self.assertEqual(self.state.data["last_unlock_result"], "keychain_read_failed")
            self.assertTrue(self.state.data["typing_paused"])
            # No retry from the cached password on the next five-second daemon tick.
            self.clock.sleep(5)
            hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, [])
        hold.password_source = self.password
        self.clock.sleep(121)
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, self.sequence())

    def test_failed_state_write_does_not_change_in_memory_state(self):
        self.state.update(locked=False)
        with patch.object(vnc, "atomic_json", side_effect=OSError()):
            with self.assertRaises(OSError):
                self.state.update(locked=True)
        self.assertFalse(self.state.data["locked"])
        self.assertFalse(json.loads(self.state.path.read_text())["locked"])

    def test_session_sends_tiny_keepalive_and_caches_password_until_reconnect(self):
        # An event wakes the fake clock at its first five-second wait; no polling or real sleep.
        class StopSession(Exception):
            pass
        def stop_after_tick(seconds):
            self.clock.value += seconds
            if seconds == 5:
                raise StopSession()
        self.clock.sleep = stop_after_tick
        hold = self.hold(lambda: False)
        with RFB() as server:
            hold.connector = server.connect
            hold.run_connection()
        self.assertEqual(self.reads, 1)
        self.assertEqual(server.events, [])
        self.assertEqual(server.updates, [struct.pack(">BHHHH", 1, 0, 0, 1, 1)])
        self.assertEqual(self.state.data["last_keepalive_at"], 10000)
        self.assertFalse(self.state.data["connected"])
        with RFB() as server:
            hold.connector = server.connect
            hold.run_connection()
        self.assertEqual(self.reads, 2)

    def test_deleting_consumed_reset_request_cannot_clear_a_later_pause(self):
        vnc.atomic_json(self.directory / "reset.json", {"token": "used-reset"})
        self.assertTrue(self.state.reset_if_requested())
        self.state.update(typing_paused=True, typing_paused_reason="failed again")
        (self.directory / "reset.json").unlink()
        self.assertFalse(self.state.reset_if_requested())
        self.assertTrue(self.state.data["typing_paused"])

    def test_keychain_timeout_is_reported_without_captured_output(self):
        error = subprocess.TimeoutExpired(["security"], 15, output=TEST_PASSWORD)
        with patch.object(vnc.subprocess, "run", side_effect=error):
            with self.assertRaises(vnc.KeychainError) as caught:
                vnc.password()
        self.assertEqual(caught.exception.code, "timeout")

    def test_failed_write_and_interrupted_typing_cannot_allow_retry(self):
        hold = self.hold()
        hold.refresh_password()
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            with patch.object(vnc, "atomic_json", side_effect=OSError()):
                with self.assertRaises(OSError):
                    hold.maybe_unlock(s)
            s.close()
        self.assertEqual(server.events, [])
        self.state = vnc.State(self.directory / "interrupted", self.clock)
        hold = self.hold()
        hold.refresh_password()
        with RFB() as server:
            s, _, _ = server.connect(hold.secret)
            with patch.object(hold, "key", side_effect=EOFError()):
                with self.assertRaises(EOFError):
                    hold.maybe_unlock(s)
            s.close()
        restarted = vnc.State(self.state.directory, self.clock)
        self.assertTrue(restarted.data["typing_paused"])
        self.assertEqual(restarted.data["typing_paused_reason"], "unlock attempt pending")

    def test_state_schema_atomic_heartbeat_and_private_mode(self):
        self.state.update(connected=True, last_keepalive_at=self.clock.time())
        expected = {"pid", "connected", "connected_since", "last_keepalive_at", "locked",
                    "last_unlock_attempt_at", "last_unlock_result", "typing_paused", "typing_paused_reason",
                    "last_error", "auth_failures_in_row", "version"}
        self.assertTrue(expected <= json.loads(self.state.path.read_text()).keys())
        self.assertEqual(self.state.path.stat().st_mode & 0o777, 0o600)
        with patch.object(vnc, "atomic_json", wraps=vnc.atomic_json) as write:
            self.clock.sleep(60)
            self.state.update()
            self.assertEqual(write.call_count, 1)
        self.assertEqual(list(self.directory.glob(".state-*")), [])
        self.state.path.write_text("corrupt")
        with self.assertRaises(ValueError):
            vnc.State(self.directory)

    def test_status_health_matrix_and_no_launchctl_env_output(self):
        self.state.update(connected=True, last_keepalive_at=self.clock.time())
        def launch(*a, **kw):
            return subprocess.CompletedProcess(a, 0, f"state = running\npid = {os.getpid()}\nSECRET_ENV = hidden", "")
        for fields, lock, age, expected in [({}, False, 0, 0), ({}, True, 0, 1),
                  ({"connected": False}, False, 0, 1), ({"typing_paused": True}, False, 0, 1),
                  ({"auth_failures_in_row": 1}, False, 0, 1), ({}, False, 121, 1),
                  ({"pid": 99999}, False, 0, 1)]:
            with self.subTest(fields=fields, lock=lock, age=age):
                data = dict(self.state.data, **fields)
                vnc.atomic_json(self.state.path, data)
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    rc = vnc.status(self.directory, lambda: lock, launch, lambda: self.clock.time() + age)
                self.assertEqual(rc, expected)
                self.assertNotIn("SECRET_ENV", out.getvalue())

    def test_lock_reader_accepts_ioreg_shapes_and_fails_closed(self):
        for root in ({"IOConsoleUsers": [{"CGSSessionScreenIsLocked": True}]},
                     [{"IOConsoleUsers": [{"CGSSessionScreenIsLocked": False}]}]):
            with patch.object(vnc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, plistlib.dumps(root))):
                self.assertIs(vnc.locked(), isinstance(root, dict))
        for raw in (b"bad", plistlib.dumps({}), plistlib.dumps({"IOConsoleUsers": []})):
            with patch.object(vnc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, raw)):
                with self.assertRaises(vnc.LockReadError):
                    vnc.locked()


if __name__ == "__main__":
    unittest.main()
