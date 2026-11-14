"""Source classifier vectors from the OpenCode offbox policies."""
if __package__:
    from . import test_environment
else:
    import test_environment

import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
import engine

OFFBOX = SRC.parents[1] / "offbox/skill"


class PolicyParityTests(unittest.TestCase):

    def test_offbox_uses_shared_rules_and_every_embedded_vector(self):
        spec = importlib.util.spec_from_file_location("offbox_parity_classifier", OFFBOX / "scripts/classify.py")
        classifier = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"OFFBOX_RULES": str(OFFBOX / "heavy-rules.json")}):
            spec.loader.exec_module(classifier)
        rules = json.loads((OFFBOX / "heavy-rules.json").read_text())
        fixtures = str(OFFBOX / "scripts/tests/fixtures")
        with patch.dict(os.environ, {"OFFBOX_RULES": str(OFFBOX / "heavy-rules.json")}):
            for vector in rules["vectors"]:
                cwd = vector.get("cwd")
                if cwd:
                    cwd = cwd.replace("$FIXTURES", fixtures)
                with self.subTest(command=vector["cmd"]):
                    verdict = classifier.classify(vector["cmd"], cwd)
                    self.assertEqual(verdict["heavy"], vector["heavy"])
                    if vector.get("heavy") and vector.get("rule"):
                        self.assertEqual(verdict["rule"], vector["rule"])
                    if "rewrite" in vector:
                        self.assertEqual(verdict["rewrite"], vector["rewrite"])
            with patch.dict(os.environ, {"HARNESS_HOOKS_CLASSIFIER": str(OFFBOX / "scripts/classify.py")}):
                for command in ["npm ci", "docker compose up -d", "go test ./...", "pytest tests/a.py::test_one", "offbox run -- npm ci"]:
                    self.assertEqual(engine._classify_offbox(command, fixtures), classifier.classify(command, fixtures))

    def test_betterstack_original_scope_roots_and_boundaries(self):
        for root in engine.CRPKO_ROOTS:
            for path in (root, root + "/src", root + "-lane"):
                self.assertTrue(engine._betterstack_directory(path), path)
            self.assertFalse(engine._betterstack_directory(root + "s"))
        for path in ("", None, "/Users/ardud/Junocash-Tools", "/Volumes/ExternalSSD/t3code-fork"):
            self.assertFalse(engine._betterstack_directory(path))


if __name__ == "__main__":
    unittest.main()
