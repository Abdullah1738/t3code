"""Package startup and local preflight must not depend on live source leftovers."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SRC = Path(__file__).resolve().parents[1] / "src"


class RecallPackageTest(unittest.TestCase):
    def test_engine_and_native_hook_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {k: v for k, v in os.environ.items() if not k.startswith("RECALL_")}
            env.update(RECALL_DATA=str(root), RECALL_DECISION_LOG=str(root / "decisions.jsonl"), RECALL_RULE_PREFLIGHT="1")
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", """
import json
from pathlib import Path
import sys
from unittest.mock import patch

src, root = map(Path, sys.argv[1:])
sys.path.insert(0, str(src))
import recall_engine
import recall_hook_state
import recall_local
import recall_messages
import recall_note
from recall_rules import RuleIndex

for module in (recall_engine, recall_hook_state, recall_local, recall_messages, recall_note):
    assert Path(module.__file__).parent == src

def forbidden(*args, **kwargs):
    raise AssertionError('local preflight attempted network or corpus access')

index = RuleIndex(root / 'rules.db')
saved = index.remember("When messaging Fixture, never say 'blocked wording'.",
                       actions=['message'], recipient='Fixture', source_session='fixture-owner')
engine = recall_engine.CheckEngine(rules_path=index.path, classifier=forbidden)
body = {'trigger': 'tool', 'tool': 'send_message', 'cwd': str(root),
        'arguments': {'recipient': 'Fixture', 'text': 'blocked wording'}}
with patch('urllib.request.urlopen', forbidden), \
     patch('recall_core.mem', forbidden), patch('recall_core.cold', forbidden):
    rules, error, result = engine.preflight(body)
    assert error is None, error
    assert result['decision'] == 'deny', result
    assert saved['citation'] in result['sources'], result
    assert 'blocked wording' in result['reason'], result
    body['arguments']['text'] = 'hello'
    rules, error, result = engine.preflight(body)
    assert error is None, error
    assert result is None or result['decision'] == 'allow', result
    assert recall_messages.outgoing('send_message', body['arguments']) == ['hello']

store = recall_hook_state.Store(str(root / 'hook.db'))
try:
    generation = store.claim_first('fixture', 'local task', True)
    store.remember('fixture', generation, 'fixture note')
    assert store.get('fixture')['notes'] == ['fixture note']
finally:
    store.db.close()
print(json.dumps({'imported': 5, 'denied_conflict': True, 'allowed_nonconflict': True, 'hook_state': True}))
""", str(SRC), str(root)],
                cwd=root, env=env, text=True, capture_output=True, timeout=5,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('"denied_conflict": true', result.stdout)


if __name__ == "__main__":
    unittest.main()
