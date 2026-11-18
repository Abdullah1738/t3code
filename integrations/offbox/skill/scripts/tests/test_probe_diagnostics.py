"""Authenticated preflight retains transport class, safe detail and elapsed time."""
import http.client
from pathlib import Path
import subprocess
import sys
import urllib.error
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from offbox_lib import api, common, home
from test_home_backend import HomeFiles
from test_wait_lock import Clock


class ProbeDiagnostics(HomeFiles):
    def setUp(self):
        super().setUp()
        self.configure()
        common.select_backend("server")
        self.stack.enter_context(patch.object(api, "BACKEND", "server"))
        self.stack.enter_context(patch.object(api, "_key", return_value="fixture-key"))

    def test_failure_class_matrix_has_safe_detail_and_elapsed_ms(self):
        cases = [
            (TimeoutError(), "timeout", "timeout"),
            (urllib.error.URLError(TimeoutError()), "timeout", "timeout"),
            (api.NetworkError("GET /limits timed out"), "timeout", "timeout"),
            (api.BudgetExpired("deadline passed"), "timeout", "timeout"),
            (ConnectionRefusedError(), "refused", "connect refused"),
            (urllib.error.URLError(ConnectionRefusedError()), "refused", "connect refused"),
            (api.NetworkError("connect: connection refused"), "refused", "connect refused"),
            (api.ApiError(500, "internal", "timed out secret"), "http", "HTTP 500"),
            (api.ApiError(401, "unauthorized", "secret"), "http", "HTTP 401 unauthorized"),
            (urllib.error.HTTPError("http://secret", 503, "timed out secret", {}, None), "http", "HTTP 503"),
            (ValueError("secret response"), "invalid_response", "invalid response"),
            (http.client.BadStatusLine("secret"), "invalid_response", "invalid response"),
            (ConnectionResetError(), "unreachable", "transport error"),
        ]
        for error, classification, detail in cases:
            with self.subTest(error=type(error).__name__, detail=detail), \
                    patch.object(api, "call", side_effect=error), patch.object(api.time, "monotonic", side_effect=[10, 10.025]):
                result = api.probe_backend("server")
            self.assertIsInstance(result, api.ProbeFailure)
            self.assertEqual((result.classification, result.detail, result.ms), (classification, detail, 25))
            self.assertIn(f"class={classification} ms=25", result)
            self.assertIn(detail, result)
            self.assertNotIn("secret", result)
            home.record_failure(result, "run-fixture")
            self.assertTrue(home.recent_failure())

    def test_keychain_failure_is_distinct_from_request_timeout(self):
        for error in (common.OffboxError("API key missing from Keychain (secret)"),
                      subprocess.TimeoutExpired("secret keychain command", 3)):
            with self.subTest(error=type(error).__name__), patch.object(api, "_key", side_effect=error), \
                    patch.object(api, "call", side_effect=AssertionError("no API call without key")):
                result = api.probe_backend("server")
            self.assertEqual(result.classification, "keychain")
            self.assertIn("Keychain", result)
            self.assertNotIn("secret", result)

    def test_cross_backend_key_missing_is_classified(self):
        with patch.object(api, "BACKEND", "boat"), \
                patch.object(api.subprocess, "run", return_value=subprocess.CompletedProcess([], 44, stdout="")):
            result = api.probe_backend("server")
        self.assertEqual((result.classification, result.detail), ("keychain", "Keychain missing"))

    def test_startwait_preserves_prefix_for_existing_bound_handling(self):
        reason = "home still starting after 600 s (reconcile)"
        with patch.object(api, "call", side_effect=home.StartWaitFailed(reason)):
            result = api.probe_backend("server")
        self.assertTrue(result.startswith(reason))
        self.assertEqual((result.classification, result.detail), ("starting", "StartWaitFailed"))
        self.assertIn("ms=", result)

    def test_old_failure_record_does_not_skip_health_and_slow_limits_waits(self):
        home.record_failure("authenticated API did not answer successfully", "run-old")
        clock = Clock()
        with patch.object(home, "probe", return_value=None) as health, \
                patch.object(home, "tcp_connects", return_value=True), patch.object(home, "say"), \
                patch.object(home.time, "monotonic", clock.now), patch.object(home.time, "sleep", clock.sleep), \
                patch.object(api, "call", side_effect=[TimeoutError(), TimeoutError(), {}]) as request:
            self.assertIsNone(home.preflight_reason())
        health.assert_called_once()
        self.assertEqual([call.kwargs["timeout"] for call in request.call_args_list], [3, 15, 15])
        self.assertGreater(clock.t, 1000)


if __name__ == "__main__":
    unittest.main()
