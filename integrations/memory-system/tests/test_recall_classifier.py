import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import recall_classifier as classifier


class ClassifierTest(unittest.TestCase):
    def test_obvious_calls_never_call_jev(self):
        from eval_recall_classifier import CASES
        with patch("urllib.request.urlopen", side_effect=AssertionError("network")):
            for tool, arguments, expected in CASES:
                fixed = classifier.deterministic(tool, arguments)
                if fixed is False:
                    self.assertEqual(classifier.classify(tool, arguments)["check"], expected, (tool, arguments))

    def test_ambiguous_calls_use_pinned_probability_and_cost(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): return json.dumps({"answers": {"action": {"noul": 0.8}}, "usage": {"cost": 0.0001}}).encode()
        with patch.object(Path, "read_text", return_value="fixture-key"), patch("urllib.request.urlopen", return_value=Response()) as request:
            result = classifier.classify("execute", {"code": "run()"}, rule_triggers=["recipient Moni"])
        self.assertTrue(result["check"])
        self.assertEqual(result["cost"], 0.0001)
        payload = json.loads(request.call_args.args[0].data)
        self.assertEqual(payload["model"], "typesafe/jev-1.13")
        self.assertIn("recipient Moni", payload["state"]["action"]["owner_rule_triggers"])

    def test_jev_failure_checks_unknown_effects_but_not_local_git(self):
        with patch.object(Path, "read_text", side_effect=OSError("no key")):
            self.assertFalse(classifier.classify("execute", {"code": "unknown()"})["check"])
            self.assertFalse(classifier.classify("shell", {"command": "git status"})["check"])

    def test_release_scripts_are_not_proven_local(self):
        for command in ("bun scripts/release.ts", "make release", "npm exec ship"):
            self.assertIsNot(classifier.deterministic("Bash", {"command":command}), False)
        self.assertFalse(classifier.deterministic("Bash", {"command":"go test ./pkg"}))

    def test_outward_gate_runs_jev_and_preserves_explicit_matches(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): return json.dumps({"answers":{"action":{"noul":0.01}}}).encode()
        with patch.object(Path, "read_text", return_value="fixture"), patch("urllib.request.urlopen", return_value=Response()) as request:
            self.assertFalse(classifier.classify("send", {"recipient":"Moni"})["check"])
            self.assertTrue(classifier.classify("send", {"recipient":"Moni"}, rule_triggers=["brief messages"])["check"])
            self.assertEqual(request.call_count, 2)
