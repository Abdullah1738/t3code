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
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import engine


class HookEvents(unittest.TestCase):
    def setUp(self):
        sampling = patch.object(engine.toollog.random, 'random', return_value=0)
        sampling.start()
        self.addCleanup(sampling.stop)

    def test_success_denial_rewrite_and_codex_cu(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs', 'HARNESS_HOOKS_STATE_DIR':temp+'/state', 'CODEX_HOME':temp+'/codex-cu'}):
            for cwd, expected in [('/Users/ardud/crpko-devops', 'allow'), ('/unrelated', 'deny')]:
                result = engine.decide({'hook_event_name':'PreToolUse', 'tool_name':'mcp__betterstack__query', 'cwd':cwd}, 'codex')
                self.assertEqual(result['decision'], expected)
            engine._log(harness='claude', rule='no-policy', rewritten=True, robobThreadId='thread-fixture', command='curl --password fixture-secret')
            rows = [json.loads(line) for path in Path(temp+'/logs/agent-tools').glob('*.ndjson') for line in path.read_text().splitlines()]
            self.assertEqual([r['name'] for r in rows], ['hook.decision']*3)
            self.assertEqual([r['props']['decision'] for r in rows], ['allowed', 'denied', 'rewritten'])
            self.assertEqual(rows[0]['props']['harness'], 'codex-cu')
            self.assertEqual(rows[-1]['ids'], {'threadId':'thread-fixture'})
            for row in rows: print('TOOLLOG_SAMPLE ' + json.dumps(row, separators=(',', ':')), file=sys.__stdout__)
            self.assertNotIn('fixture-secret', json.dumps(rows))

    def test_guard_class_and_overhead(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs', 'HARNESS_HOOKS_STATE_DIR':temp+'/state'}):
            result = engine.decide({'hook_event_name':'PreToolUse', 'tool_name':'Bash', 'cwd':temp,
                                    'tool_input':{'command':'sqlite3 ~/.robob/userdata/statev2.sqlite SELECT-fixture-secret'}}, 'claude')
            self.assertEqual(result['decision'], 'deny')
            row = json.loads(next(Path(temp+'/logs/agent-tools').glob('*.ndjson')).read_text().splitlines()[0])
            self.assertEqual(row['props']['guard'], 'statev2')
            self.assertNotIn('SELECT-fixture-secret', json.dumps(row))
