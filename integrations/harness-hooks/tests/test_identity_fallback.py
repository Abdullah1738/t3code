if __package__:
    from . import test_environment
else:
    import test_environment

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import engine


class IdentityFallbackTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.now = 100000.0
        self.enterContext(patch.dict(os.environ, {
            "HARNESS_HOOKS_STATE_DIR": str(self.root / "state"),
            "OFFBOX_STATE_DIR": str(self.root / "offbox"),
            "TOOLLOG_ROOT": str(self.root / "logs"),
            "HARNESS_HOOKS_PROVIDER_INSTANCE": "codex",
        }))
        self.enterContext(patch.object(engine, "_control", return_value=("http://fixture/api/ardud/control", None)))
        self.enterContext(patch.object(engine.time, "time", side_effect=lambda: self.now))
        self.event = {"hook_event_name": "PreToolUse", "session_id": "native-parent",
                      "agent_id": "native-child", "tool_name": "Bash", "cwd": str(self.root),
                      "tool_input": {"command": "echo private-fixture"}, "tool_use_id": "call-1"}

    def seed(self, harness="codex", age=3600):
        native, agent, driver = engine._native(self.event, harness)
        identity = {"resolution": "resolved", "robobThreadId": "child", "nativeSessionId": native,
                    "nativeAgentId": agent, "driver": driver,
                    "providerInstanceId": os.environ["HARNESS_HOOKS_PROVIDER_INSTANCE"],
                    "model": {"model": "gpt-6.1-sol"}}
        with patch.object(engine, "_get", return_value={"identity": identity}):
            self.assertEqual(engine.resolve_identity(self.event, harness, fresh=True)["resolution"], "resolved")
        self.now += age

    def markers(self):
        return list((self.root / "state/identity").glob("*.unavailable"))

    def test_each_native_harness_reuses_resolved_binding_on_transport_errors_once(self):
        errors = [TimeoutError("stalled"), ConnectionRefusedError("offline"),
                  engine.urllib.error.URLError("offline"),
                  engine.urllib.error.HTTPError("http://fixture", 503, "unavailable", {}, None)]
        self.addCleanup(errors[-1].close)
        for harness in ("claude", "codex", "codex-cu"):
            with patch.dict(os.environ, {"HARNESS_HOOKS_PROVIDER_INSTANCE": harness}):
                self.seed(harness)
                for error in errors:
                    with self.subTest(harness=harness, error=type(error).__name__), \
                         patch.object(engine, "_get", side_effect=error) as get:
                        identity = engine.resolve_identity(self.event, harness, fresh=True)
                        self.assertEqual(identity["resolution"], "resolved")
                        self.assertEqual(identity["robobThreadId"], "child")
                        self.assertEqual(identity["identity_source"], "cache")
                        self.assertNotIn("model", identity)
                        get.assert_called_once()
                        self.assertEqual(self.markers(), [])

    def test_negative_cache_skips_network_for_30_seconds_even_when_fresh(self):
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")) as get:
            self.assertEqual(engine.resolve_identity(self.event, "codex"), {"resolution": "unavailable"})
            self.assertGreater(get.call_count, 0)
            marker, = self.markers()
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(marker.read_text()), {"at": self.now})
            get.reset_mock()
            self.now += 29.999
            self.assertEqual(engine.resolve_identity(self.event, "codex", fresh=True),
                             {"resolution": "unavailable", "identity_source": "negative-cache"})
            get.assert_not_called()
            self.now += 0.001
            self.assertEqual(engine.resolve_identity(self.event, "codex"), {"resolution": "unavailable"})
            self.assertGreater(get.call_count, 0)

    def test_codex_shell_calls_in_both_homes_use_binding_without_control_wait(self):
        for home in ("codex", "codex-cu"):
            with self.subTest(home=home), patch.dict(os.environ, {
                "CODEX_HOME": str(self.root / home), "HARNESS_HOOKS_PROVIDER_INSTANCE": home,
            }):
                self.seed(age=120)
                with patch.object(engine, "_get", side_effect=TimeoutError("stalled")) as get, \
                     patch.object(engine, "_classify_offbox", return_value={"heavy": False}), \
                     patch.object(engine, "_offbox_mode", return_value="enforce"):
                    result = engine.decide(self.event, "codex")
                get.assert_not_called()
                self.assertEqual(result["decision"], "allow")
                self.assertIn("updatedInput", result["context"])
                row = json.loads((self.root / "state/decisions.jsonl").read_text().splitlines()[-1])
                self.assertEqual(row["identity_source"], "cache")

    def test_recovery_removes_marker_and_authoritative_misses_never_cache(self):
        for resolution in ("resolved", "ambiguous", "pending", "none", "unavailable"):
            with self.subTest(resolution=resolution):
                with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
                    engine.resolve_identity(self.event, "codex", fresh=True)
                self.now += 30
                response = {"resolution": resolution}
                if resolution == "resolved":
                    response["robobThreadId"] = "recovered"
                with patch.object(engine, "_get", return_value={"identity": response}) as get:
                    identity = engine.resolve_identity(self.event, "codex", fresh=True)
                    self.assertEqual(identity["resolution"], resolution)
                    self.assertEqual(identity["identity_source"], "control")
                    get.assert_called_once()
                    self.assertEqual(self.markers(), [])
                    if resolution != "resolved":
                        engine.resolve_identity(self.event, "codex")
                        self.assertEqual(get.call_count, 2)
                        self.assertEqual(list((self.root / "state/identity").glob("*.json")), [])

    def test_non_transport_errors_never_fall_back_or_create_negative_cache(self):
        self.seed()
        errors = (ValueError("identity-ambiguous"), ValueError("identity-pending"),
                      ValueError("identity-response"), PermissionError("credential"),
                      engine.urllib.error.HTTPError("http://fixture", 404, "not found", {}, None),
                      engine.urllib.error.HTTPError("http://fixture", 403, "forbidden", {}, None))
        for error in errors:
            if isinstance(error, engine.urllib.error.HTTPError):
                self.addCleanup(error.close)
            with self.subTest(error=str(error)), patch.object(engine, "_get", side_effect=error) as get:
                for _ in range(2):
                    self.assertEqual(engine.resolve_identity(self.event, "codex", fresh=True), {"resolution": "unavailable"})
                self.assertEqual(get.call_count, 2)
                self.assertEqual(self.markers(), [])

    def test_authoritative_miss_invalidates_old_binding(self):
        for resolution in ("ambiguous", "pending", "none", "unavailable"):
            with self.subTest(resolution=resolution):
                self.seed()
                with patch.object(engine, "_get", return_value={"identity": {"resolution": resolution}}) as get:
                    self.assertEqual(engine.resolve_identity(self.event, "codex")["resolution"], resolution)
                    engine.resolve_identity(self.event, "codex")
                    self.assertEqual(get.call_count, 2)
                self.assertEqual(self.markers(), [])
                self.assertEqual(list((self.root / "state/identity").glob("*.json")), [])

    def test_fallback_ttl_and_binding_validation(self):
        cases = [("age", engine._IDENTITY_FALLBACK_TTL), ("age", -1),
                 ("resolution", "pending"), ("nativeSessionId", "sibling"),
                 ("nativeAgentId", "sibling"), ("driver", "claudeAgent"),
                 ("providerInstanceId", "codex-cu"), ("robobThreadId", "")]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.now += 31
                self.seed(age=value if field == "age" else 3600)
                if field != "age":
                    path, = (self.root / "state/identity").glob("*.json")
                    entry = json.loads(path.read_text())
                    entry["identity"][field] = value
                    path.write_text(json.dumps(entry))
                with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
                    self.assertEqual(engine.resolve_identity(self.event, "codex", fresh=True)["resolution"], "unavailable")

    def test_negative_cache_separates_native_instance_and_control_endpoint(self):
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            engine.resolve_identity(self.event, "codex")
        variants = [(patch.dict(self.event, {"agent_id": "sibling"})),
                    patch.dict(os.environ, {"HARNESS_HOOKS_PROVIDER_INSTANCE": "codex-cu"}),
                    patch.object(engine, "_control", return_value=("http://other", None))]
        for context in variants:
            with context, patch.object(engine, "_get", return_value={"identity": {"resolution": "pending"}}) as get:
                self.assertEqual(engine.resolve_identity(self.event, "codex")["resolution"], "pending")
                get.assert_called_once()

    def test_invalid_marker_and_expired_or_future_timestamp_do_not_skip_control(self):
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            engine.resolve_identity(self.event, "codex")
        marker, = self.markers()
        for value in ("broken json", '[]', '{"at":true}', '{"at":"100000"}',
                      json.dumps({"at": self.now + 1}), json.dumps({"at": self.now - 30})):
            with self.subTest(value=value):
                marker.write_text(value)
                with patch.object(engine, "_get", return_value={"identity": {"resolution": "pending"}}) as get:
                    self.assertEqual(engine.resolve_identity(self.event, "codex")["identity_source"], "control")
                    get.assert_called_once()

    def test_negative_cache_cannot_grant_exemption_or_desktop_lease_and_is_logged(self):
        with patch.object(engine, "_get", side_effect=TimeoutError("stalled")):
            engine.resolve_identity(self.event, "codex")
        with patch.object(engine, "_get", side_effect=AssertionError("negative cache must skip network")):
            identity = engine.resolve_identity(self.event, "codex", fresh=True)
        offbox = self.root / "offbox"
        offbox.mkdir()
        (offbox / "exemptions.json").write_text(json.dumps([
            {"session_id": "native-child", "thread_id": "child", "expires_at": self.now + 120}]))
        with self.assertRaisesRegex(ValueError, "identity-unresolved"):
            engine._exempt(identity)
        with patch.object(engine, "_classify_offbox", return_value={"heavy": False}), \
             patch.object(engine, "_offbox_mode", return_value="enforce"):
            engine.decide(self.event, "codex")
        row = json.loads((self.root / "state/decisions.jsonl").read_text().splitlines()[-1])
        self.assertEqual(row["identity_source"], "negative-cache")
        records = [json.loads(line) for path in (self.root / "logs/agent-tools").glob("*.ndjson")
                   for line in path.read_text().splitlines()]
        self.assertEqual(records[-1]["props"]["identity_source"], "negative-cache")
        self.assertNotIn("private-fixture", json.dumps(records))
        desktop = {**self.event, "tool_name": "mcp__cua_driver__click"}
        with patch.object(engine.desktop_lease, "post", side_effect=TimeoutError("stalled")):
            decision = engine.decide(desktop, "codex")
        self.assertEqual(decision["decision"], "deny")
        self.assertEqual(decision["reason"], engine.desktop_lease.UNAVAILABLE)


if __name__ == "__main__":
    unittest.main()
