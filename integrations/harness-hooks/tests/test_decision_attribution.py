import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import engine


class DecisionAttribution(unittest.TestCase):
    def setUp(self):
        sampling = patch.object(engine.toollog.random, 'random', return_value=0)
        sampling.start()
        self.addCleanup(sampling.stop)

    def test_adapters_early_denials_and_posttool_emit_once(self):
        with tempfile.TemporaryDirectory() as temp:
            env = {**os.environ, 'TOOLLOG_ROOT': temp + '/logs', 'HARNESS_HOOKS_STATE_DIR': temp + '/state',
                   'ROBOB_THREAD_ID': '', 'ROBOB_CARD_NUMBER': '', 'CODEX_HOME': temp + '/codex'}
            src = Path(__file__).resolve().parents[1] / 'src'
            for harness in ['claude', 'codex']:
                for kind, cmd, response in [('PreToolUse', 'rg private-fixture /', None),
                                             ('PreToolUse', 'sqlite3 ~/.robob/userdata/statev2.sqlite private-fixture', None),
                                             ('PostToolUse', None, {'cvv': '123'})]:
                    event = {'hook_event_name': kind, 'session_id': 'session-' + harness, 'tool_name': 'mcp__shell__shell',
                             'cwd': temp, 'tool_input': {'command': cmd}, 'tool_response': response}
                    proc = subprocess.run([sys.executable, '-I', '-c', "import random,runpy,sys; random.random=lambda:0; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[2],run_name='__main__')", str(src), str(src / (harness + '.py'))], input=json.dumps(event),
                                          text=True, capture_output=True, env=env)
                    self.assertEqual(proc.returncode, 0, proc.stderr)
            rows = [json.loads(line) for path in Path(temp + '/logs/agent-tools').glob('*.ndjson')
                    for line in path.read_text().splitlines()]
            self.assertEqual(len(rows), 6)
            for harness, group in [('claude', rows[:3]), ('codex', rows[3:])]:
                for row in group:
                    self.assertEqual(row['ids']['threadId'], f'native:{harness}:session-{harness}')
                    self.assertEqual(row['ids']['sessionId'], 'session-' + harness)
                    self.assertEqual(row['props']['threadIdSource'], 'native')
                    self.assertEqual(row['props'].get('cwdClass', 'other'), 'other')
                self.assertEqual(group[0]['props']['matchedRoot'], 'filesystem')
                self.assertEqual(group[0]['props']['argv0Class'], 'search')
                self.assertEqual(group[1]['props']['guard'], 'statev2')
                self.assertEqual(group[2]['props']['rule'], 'card-mask')
            encoded = json.dumps(rows)
            for secret in [temp, 'private-fixture', '.robob/userdata']:
                self.assertNotIn(secret, encoded)

    def test_env_identity_card_and_codex_agent_session(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {
            'TOOLLOG_ROOT': temp + '/logs', 'HARNESS_HOOKS_STATE_DIR': temp + '/state',
            'ROBOB_THREAD_ID': 'thread-fixture', 'ROBOB_CARD_NUMBER': '85', 'CODEX_HOME': temp + '/codex-cu'}):
            event = {'hook_event_name': 'PreToolUse', 'tool_name': 'exec_command', 'session_id': 'parent',
                     'agent_id': 'child', 'cwd': temp, 'tool_input': {'cmd': 'rg secret-fixture /'}}
            with patch.object(engine, 'resolve_identity', side_effect=AssertionError('early guard must stay local')):
                engine.decide(event, 'codex')
            row = json.loads(next(Path(temp + '/logs/agent-tools').glob('*.ndjson')).read_text())
            self.assertEqual(row['ids'], {'threadId': 'thread-fixture', 'sessionId': 'child', 'cardNumber': 85})
            self.assertEqual(row['props']['harness'], 'codex-cu')

    def test_claude_children_stay_distinct_and_mask_failure_emits_once(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'TOOLLOG_ROOT':temp+'/logs',
                'HARNESS_HOOKS_STATE_DIR':temp+'/state', 'ROBOB_THREAD_ID':'', 'ROBOB_CARD_NUMBER':''}):
            event = {'hook_event_name':'PreToolUse', 'tool_name':'Bash', 'session_id':'parent-session',
                     'cwd':temp, 'tool_input':{'command':'rg private-fixture /'}}
            for agent in ['child-a', 'child-a', 'child-b']:
                engine.decide({**event, 'agent_id':agent}, 'claude')
            with patch.object(engine.card_mask, 'mask_value', side_effect=ValueError('private-fixture')):
                engine.decide({**event, 'hook_event_name':'PostToolUse'}, 'claude')
            rows = [json.loads(line) for path in Path(temp+'/logs/agent-tools').glob('*.ndjson') for line in path.read_text().splitlines()]
            self.assertEqual(len(rows),4)
            self.assertEqual([r['props'].get('repeatCount', 1) for r in rows], [1,2,1,1])
            self.assertEqual(rows[0]['ids']['threadId'], 'native:claude:parent-session:child-a')
            self.assertEqual(rows[2]['ids']['threadId'], 'native:claude:parent-session:child-b')
            self.assertEqual(rows[3]['error']['tag'], 'ValueError')
