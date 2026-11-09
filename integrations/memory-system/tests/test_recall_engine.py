import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from recall_engine import CheckEngine
from test_recall_rules import RulesFixture


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fixture = RulesFixture(self.root)
        self.index = self.fixture.index()
        self.engine = CheckEngine(self.index.path)
        self.log = patch.dict(os.environ, RECALL_DECISION_LOG=str(self.root / "decisions.jsonl"))
        self.log.start()

    def tearDown(self):
        self.log.stop()
        self.temp.cleanup()

    def check(self, command, **kwargs):
        return self.engine.check(dict(trigger="tool", tool="shell", arguments={"command": command}, cwd=self.fixture.cwd, **kwargs))

    def test_existing_corpus_denies_main_allows_main_dev_and_skips_status(self):
        with patch("recall_admission.cheap_note", side_effect=AssertionError("history not needed")):
            denied = self.check("git push origin HEAD:main")
            self.assertEqual(denied["decision"], "deny")
            self.assertIn("main-dev", denied["reason"])
            self.assertTrue(denied["sources"])
            self.assertEqual(self.check("git push origin HEAD:main-dev")["decision"], "allow")
            status = self.check("git status")
            self.assertEqual(status["decision"], "allow")
            self.assertFalse(status["recall_ran"])

    def test_preflight_deny_survives_optional_lane_saturation_and_mcp_shell_names(self):
        for tool in ("shell", "mcp__example__shell_command", "mcp__example__exec_command"):
            rules, error, denied = self.engine.preflight(dict(trigger="tool", tool=tool,
                arguments={"command": "git push origin HEAD:main"}, cwd=self.fixture.cwd))
            self.assertEqual(denied["decision"], "deny", tool)
            self.assertIn("main-dev", denied["reason"])
            self.assertTrue(denied["sources"])

    def test_clear_recipient_phrase_conflict_blocks_before_message(self):
        self.index.remember("When messaging Moni, never say 'as requested'.", actions=["message"], recipient="Moni", source_session="owner")
        result = self.engine.check(dict(trigger="tool", tool="mcp__wa__send", arguments={"recipient": "Moni", "text": "Done as requested"}, cwd="/work"))
        self.assertEqual(result["decision"], "deny")
        self.assertIn("as requested", result["reason"])
        self.assertTrue(result["sources"])
        other = self.engine.check(dict(trigger="tool", tool="mcp__wa__send", arguments={"recipient": "David", "text": "Moni said as requested"}, cwd="/work"))
        self.assertEqual(other["decision"], "allow")

    def test_rule_recipient_bypasses_classifier_and_compaction_restores_rules(self):
        self.index.remember("When messaging Moni, never say 'as requested'.", actions=["message"], recipient="Moni", source_session="owner")
        with patch.object(self.engine, "classifier", return_value={"check": True}) as gate:
            result = self.engine.check(dict(trigger="tool", tool="unknown_action", arguments={"recipient": "Moni", "text": "hello"}, cwd="/work"))
        gate.assert_not_called()
        self.assertIn("never say", result["note"])
        compaction = self.engine.check(dict(trigger="compaction", cwd="/work", prompt="messaging Moni"))
        self.assertIn("Moni", compaction["note"])

    def test_trigger_fixture_latencies_and_log_schema(self):
        timings = {trigger: [] for trigger in ("first_prompt", "compaction", "tool")}
        for trigger in timings:
            for _ in range(20):
                start = time.monotonic()
                self.engine.check(dict(trigger=trigger, cwd=self.fixture.cwd, tool="shell" if trigger == "tool" else "",
                                       arguments={"command": "git push origin HEAD:main"} if trigger == "tool" else {}))
                timings[trigger].append((time.monotonic() - start) * 1000)
        metrics = {k: dict(p50_ms=statistics.median(v), p95_ms=sorted(v)[18]) for k, v in timings.items()}
        print("TRIGGER_FIXTURE_METRICS " + json.dumps(metrics))
        records = [json.loads(line) for line in (self.root / "decisions.jsonl").read_text().splitlines()]
        self.assertEqual(len(records), 60)
        self.assertTrue(all(set(("trigger", "tool", "p", "cost", "latency_ms", "recall_ran", "note", "decision")) <= row.keys() for row in records))

    def test_cache_invalidated_when_new_rule_is_saved(self):
        body = dict(trigger="tool", request_id="call", tool="shell", arguments={"command": "git push origin HEAD:main"}, cwd="/work/other")
        first = self.engine.cached_check(body)
        self.assertEqual(first["decision"], "allow")
        self.index.remember("Always push to main-dev, never main.", scope="/work/other", actions=["git.push"], source_session="owner")
        self.assertEqual(self.engine.cached_check(body)["decision"], "deny")


class PreflightAdmissionTest(unittest.IsolatedAsyncioTestCase):
    async def test_http_denies_before_saturated_optional_admission(self):
        try:
            import recall_server as server
            from starlette.requests import Request
        except ImportError:
            self.skipTest("server dependencies unavailable")
        from unittest.mock import AsyncMock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = RulesFixture(root)
            engine = CheckEngine(fixture.index().path)
            data = json.dumps(dict(trigger="tool", tool="mcp__x__exec_command", cwd=fixture.cwd,
                                   arguments={"command": "git push origin HEAD:main"})).encode()
            async def receive():
                return {"type": "http.request", "body": data, "more_body": False}
            request = Request({"type": "http", "method": "POST", "path": "/api/check", "scheme": "http",
                               "server": ("127.0.0.1", 18765), "headers": [(b"host", b"127.0.0.1:18765")]}, receive)
            with patch.object(server, "_engine", engine), \
                 patch.object(server._check_lane, "run", AsyncMock(side_effect=AssertionError("must not use saturated lane"))), \
                 patch.dict(os.environ, RECALL_DECISION_LOG=str(root / "decisions.jsonl")):
                response = await server.api_check(request)
            body = json.loads(response.body)
            self.assertEqual(body["decision"], "deny")
            self.assertIn("main-dev", body["reason"])
            self.assertTrue(body["sources"])
